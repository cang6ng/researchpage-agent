/**
 * The application's composition root: one process, one product.
 *
 * Everything the product is made of is decided here and nowhere else — the two
 * SQLite stores (the host's own and the research application's), the research
 * service and plugin, the real model composition with the credential it was
 * handed, the tool policy that permits exactly the six research tools, the
 * in-process client the runner drives runs through, the page server with its
 * business API, and the PDF export path. Nothing is read from ambient state: a
 * caller that does not supply a data directory, a model profile and a
 * credential does not get a product, rather than getting one configured by
 * accident.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { ModelClient } from "@every-dagent/agent-core";
import { createClient, type Client } from "@every-dagent/client";
import { createHost, type Host, type TrustedComposition } from "@every-dagent/host";
import { createPiAiComposition, explicitCredentials } from "@every-dagent/model-pi-ai";
import {
  createResearchPlugin,
  createResearchService,
  openResearchRepository,
  type ResearchServiceOptions,
  RESEARCH_SYSTEM_PROMPT,
  type ResearchRepository,
  type ResearchService,
} from "@every-dagent/plugin-research";
import { startShellServer, type ShellServer } from "@every-dagent/web/shell";

import { createChannelPair } from "./channel.js";
import { createResearchContextBuilder } from "./context-builder.js";
import { exportTaskReportPdf } from "./export.js";
import { createResearchRouter } from "./routes.js";
import { createResearchRunner, type ResearchRunner } from "./runner.js";

export interface ResearchAppOptions {
  /** Where the business database, the host store and exported PDFs live. */
  readonly dataDir: string;
  /** The directory the workspace page is served from. */
  readonly staticRoot: string;
  /** The provider profile the product runs with, e.g. deepseek/deepseek-flash. */
  readonly model?: { readonly provider: string; readonly model: string };
  /** The provider credential, resolved by the caller. Never written anywhere. */
  readonly credential?: string;
  /**
   * A trusted composition of the caller's own, replacing the provider path.
   *
   * It is the host's own seam, used here for offline runs — an acceptance test
   * drives the product with a scripted model instead of spending money on a
   * provider. Nothing else about the product changes: the same plugin, policy,
   * runner and routes are used, so what a test exercises is the real path.
   */
  readonly composition?: TrustedComposition;
  /**
   * The discovery and read paths, when a caller supplies its own.
   *
   * An acceptance test uses this to run the *whole* product — runner, tools,
   * policy, matrix, report, PDF, API — without reaching arXiv, while the real
   * network paths stay covered by the research package's own real-network
   * tests and by the demo runs. There is no other difference between a test
   * run and a product run.
   */
  readonly overrides?: {
    readonly search?: ResearchServiceOptions["search"];
    readonly read?: ResearchServiceOptions["read"];
  };
  readonly address?: string;
  readonly port?: number;
  readonly browserPath?: string;
  readonly log?: (message: string) => void;
}

export interface ResearchApp {
  /** The address a person opens. */
  readonly url: string;
  readonly pageOrigin: string;
  readonly host: Host;
  readonly client: Client;
  readonly service: ResearchService;
  readonly runner: ResearchRunner;
  readonly repository: ResearchRepository;
  close(): Promise<void>;
}

export async function startResearchApp(options: ResearchAppOptions): Promise<ResearchApp> {
  const log = options.log ?? ((message: string): void => console.log(message));
  const storeDir = join(options.dataDir, "store");
  const reportDir = join(options.dataDir, "reports");
  mkdirSync(storeDir, { recursive: true });
  mkdirSync(reportDir, { recursive: true });

  const repository = openResearchRepository({ location: join(storeDir, "research.db") });
  const service = createResearchService({
    repo: repository,
    ...(options.overrides?.search === undefined ? {} : { search: options.overrides.search }),
    ...(options.overrides?.read === undefined ? {} : { read: options.overrides.read }),
  });
  const { plugin, tools } = createResearchPlugin({ service });

  const contextBuilder = createResearchContextBuilder({ service });
  const modelSettings = options.model ?? { provider: "offline", model: "offline" };

  /**
   * Wraps the composed client so the *application's* log says what failed.
   *
   * The host classifies a model failure on the wire by design — a client learns
   * "the run failed", never a provider's words — but the operator running the
   * product still needs the reason, and the adapter's own message is a fixed,
   * non-secret classification. It is logged here and nowhere else.
   */
  const withFailureLog = (client: ModelClient): ModelClient => ({
    limits: client.limits,
    stream: (request, context) => {
      const inner = client.stream(request, context);
      return (async function* () {
        try {
          yield* inner;
        } catch (error) {
          log(`[app] model step failed: ${error instanceof Error ? error.message : String(error)}`);
          throw error;
        }
      })();
    },
  });

  let composition: TrustedComposition;
  if (options.composition !== undefined) {
    const provided = options.composition;
    composition = {
      ...provided,
      compose: async (input) => {
        const composed = await provided.compose(input);
        return { ...composed, modelClient: withFailureLog(composed.modelClient), contextBuilder };
      },
    };
  } else {
    if (options.model === undefined || options.credential === undefined) {
      repository.close();
      throw new Error("the product needs a model profile and a credential, or a composition of its own");
    }
    const models = builtinModels();
    const model = models.getModel(options.model.provider, options.model.model);
    if (model === undefined) {
      repository.close();
      throw new Error(`模型目录中没有 ${options.model.provider}/${options.model.model}`);
    }
    const piAi = createPiAiComposition({
      models: [model],
      streamSource: models,
      credentials: explicitCredentials({ [options.model.provider]: options.credential }),
      maxTokens: 4_096,
    });
    composition = {
      validateModel: (value) => piAi.validateModel(value),
      compose: async (input) => {
        const composed = await piAi.compose(input);
        return { ...composed, modelClient: withFailureLog(composed.modelClient), contextBuilder };
      },
    };
  }

  // The tool policy is the product's decision about the product's own tools,
  // whichever model path is in use: exactly these six research tools are
  // allowed, and everything else stays refused by the host's own default. A
  // caller that brought its own composition still cannot widen this.
  const effectiveComposition: TrustedComposition = {
    ...composition,
    toolPolicy: composition.toolPolicy ?? { revision: 1, tools: tools.tools, decide: () => "allow" },
  };

  const host = await createHost({
    bootstrap: {
      // The system prompt a store with no configuration starts from. The
      // task brief is *not* here — a per-session brief belongs to the context
      // builder, which is the seam that can read one and which the composition
      // below hands the host.
      host: { systemPrompt: RESEARCH_SYSTEM_PROMPT, loop: { maxSteps: 12, maxModelAttempts: 3 } },
      model: { provider: modelSettings.provider, model: modelSettings.model },
    },
    composition: effectiveComposition,
    plugins: [plugin],
    persistence: { kind: "sqlite", location: join(storeDir, "host.db") },
  });

  // The runner's client is a real protocol client over an in-process channel
  // pair: every stage run the product starts goes through the same wire path a
  // remote client would, with the same host guarantees.
  const client = createClient({
    connect: async () => {
      const pair = createChannelPair();
      host.attach(pair.hostSide);
      return pair.clientSide;
    },
  });
  await client.connect();

  // The plugin is registered disabled by default, so the product enables it
  // once; the host commits that intent durably, and every later startup
  // restores it without this call succeeding again.
  const pluginState = await client.plugins.enable({ pluginId: "research" });
  log(`[app] research plugin: ${pluginState.plugin.status}`);

  const runner = createResearchRunner({
    client,
    service,
    exportPdf: async (taskId) => {
      const outcome = await exportTaskReportPdf({
        service,
        reportDir,
        taskId,
        ...(options.browserPath === undefined ? {} : { browserPath: options.browserPath }),
      });
      return { ok: outcome.ok, failure: outcome.failure };
    },
    log,
  });
  runner.reconcileInterrupted();

  const router = createResearchRouter(
    {
      service,
      runner,
      createSession: async () => {
        const created = await client.sessions.create();
        return created.session.sessionId;
      },
      reportDir,
      ...(options.browserPath === undefined ? {} : { browserPath: options.browserPath }),
      log,
    },
    () => runner.busy || runner.queued > 0,
  );

  let shell: ShellServer;
  try {
    shell = await startShellServer({
      host,
      staticRoot: options.staticRoot,
      onRequest: router,
      ...(options.address === undefined ? {} : { address: options.address }),
      ...(options.port === undefined ? {} : { port: options.port }),
    });
  } catch (error) {
    client.disconnect();
    await host.shutdown();
    repository.close();
    throw error;
  }

  let closed = false;
  return {
    url: shell.pageOrigin,
    pageOrigin: shell.pageOrigin,
    host,
    client,
    service,
    runner,
    repository,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await runner.shutdown();
      await shell.close();
      client.disconnect();
      await host.shutdown();
      repository.close();
    },
  };
}
