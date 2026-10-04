/**
 * The acceptance host: a real host, the real shell server, the real page.
 *
 * Nothing in the acceptance path is mocked at the application level. The host
 * is `createHost` with two real plugins and the offline model; the shell server
 * is the product composition; the page is the built artifact the command line
 * would serve. The only seam this helper adds is the channel ward: how a
 * binding channel reaches the host is composition, and the acceptance uses
 * that seam exactly the way a deployment would use it for tracing — to drop
 * one answer, or to end a connection, and then watch what the shell does about
 * it.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClient, type Client } from "@every-dagent/client";
import { createHost, type Host, type ComposeInput, type ToolPolicy } from "@every-dagent/host";
import { TEST_BOOTSTRAP, testComposition } from "../../../../tests/helpers/test-composition.js";
import { createCalculatorPlugin } from "@every-dagent/plugin-calculator";
import type { Plugin, PluginContext } from "@every-dagent/plugin-system";
import type { ProtocolChannel } from "@every-dagent/protocol";

import { buildApp } from "../../scripts/build.mjs";
import { startShellServer, type ShellServer } from "../../src/server/shell-server.js";
import { offlineModel, type OfflineModel } from "./offline-model.js";
import { textStatsPlugin, type TextStatsPluginFixture } from "../../../../tests/fixtures/text-stats-plugin.js";

export interface ShellControls {
  /** The next `runs.start` answer dies with its connection instead of arriving. */
  dropNextStartResponse(): void;
  /** How many times a response was dropped this way. */
  readonly drops: number;
  /** Holds the next `sessions.create` answer until `releaseCreateAnswer` is called. */
  holdNextCreateAnswer(): void;
  /** Releases a held create answer, if one is held. */
  releaseCreateAnswer(): void;
  /** Ends every open connection without touching the host or its runs. */
  closeConnections(): void;
  /** Open logical connections, as the binding sees them. */
  connections(): number;
  /**
   * Every `runs.start` request that actually crossed the binding.
   *
   * This is the count "nothing was replayed" has to be stated in: a host's
   * submission dedup would swallow a duplicate request, and a model request
   * count would never see it — only the transport sees what was really sent.
   */
  startRequests(): number;
  /** Every request of one method that crossed the binding, in order. */
  requestsOf(method: string): readonly Record<string, unknown>[];
  /** The next `sessions.rename` answer dies with its connection instead of arriving. */
  dropNextRenameResponse(): void;
  /** The next `sessions.delete` answer dies with its connection instead of arriving. */
  dropNextDeleteResponse(): void;
  /** The next `settings.update` answer dies with its connection instead of arriving. */
  dropNextSettingsResponse(): void;
  /** Holds the next `settings.update` answer until `releaseSettingsAnswer` is called. */
  holdNextSettingsResponse(): void;
  /** Holds the next `sessions.delete` answer until `releaseDeleteAnswer` is called. */
  holdNextDeleteResponse(): void;
  /** Releases a held delete answer, if one is held. */
  releaseDeleteAnswer(): void;
  /** Releases a held settings answer, if one is held. */
  releaseSettingsAnswer(): void;
  /** Whether a `sessions.delete` answer is parked right now. */
  deleteAnswerHeld(): boolean;
  /** How many parked `sessions.delete` answers were really delivered on release. */
  deleteAnswersDelivered(): number;
  /** Whether a `settings.update` answer is parked right now. */
  settingsAnswerHeld(): boolean;
  /** How many parked `settings.update` answers were really delivered on release. */
  settingsAnswersDelivered(): number;
  /**
   * Makes the next `sessions.rename` request carry a revision the host does not
   * have, which is what a reader who looked at yesterday's copy would send.
   */
  breakNextRenameRevision(): void;
  /**
   * Puts another host behind the same binding.
   *
   * The page keeps its address and its state — this is what a host being
   * replaced underneath a page looks like — and the next connection reaches the
   * new instance. It exists so a test can ask what a page does when the host it
   * was editing against is not the host it is talking to any more.
   */
  swapTo(host: Host): void;
}

/**
 * A plugin that cannot activate, carrying a fake secret in its failure.
 *
 * Its cleanup fails too, which is what puts the manager into the `error` state
 * rather than back to `disabled` — the only state in which a plugin genuinely
 * cannot be operated on. The acceptance uses it to check two things at once:
 * that a failed activation becomes a safe, enumerable summary in the page —
 * and that the raw failure text, which here contains something that must never
 * be shown, does not travel with it.
 */
export function failingPlugin(): Plugin {
  return {
    manifest: {
      id: "always-broken",
      name: "Always Broken",
      version: "0.0.1",
      description: "A plugin whose activation always fails.",
    },
    activate(context: PluginContext): void {
      context.onDispose((): void => {
        throw new Error("cleanup failed as well: the other half is hunter2-cleanup-secret");
      });
      throw new Error("activation failed: the vault code is hunter2-should-not-leak");
    },
  };
}

export interface ShellAcceptance {
  readonly host: Host;
  readonly shell: ShellServer;
  readonly model: OfflineModel;
  /** The credential this composition resolved, when a test gave it one. */
  readonly credential: string | null;
  readonly textStats: TextStatsPluginFixture;
  readonly controls: ShellControls;
  readonly pageUrl: string;
  readonly bindingOrigin: string;
  /** Every value the counter tool was handed, in order (the approval acceptance). */
  readonly executions: readonly unknown[];
  /** Every effective model settings value the composition was asked to run with. */
  readonly composed: readonly ComposeInput[];
  /** One more real client on the same host, through the same ward. */
  connect(): Promise<Client>;
  /** Ends the servers and then the host: the host is truly gone afterwards. */
  close(): Promise<void>;
}

export interface ShellAcceptanceOptions {
  /** Fixed ports, for a test that restarts the whole application in place. */
  readonly pagePort?: number;
  readonly bindingPort?: number;
  /**
   * Persist to a real SQLite file instead of memory.
   *
   * The point of the durable acceptance is that a *restart* is a real one: the
   * same file, a new process, a new host instance.
   */
  readonly databasePath?: string;
  /**
   * Refuse to run the counter tool without an approval.
   *
   * When set, the acceptance host also registers a counter tool — the one
   * execution a browser can authorize — and records what it was handed.
   */
  readonly requireApproval?: boolean;
  /** Called with every effective composition input this host was started with. */
  readonly onCompose?: (input: ComposeInput) => void;
  /** Replaces the tool policy entirely, for a policy a test wants to state itself. */
  readonly toolPolicy?: ToolPolicy;
  /**
   * A credential the trusted composition resolves and hands to its model
   * client — the shape a real composition has, with a sentinel a test made up.
   *
   * It exists so the browser acceptance can say where a credential may go (the
   * provider-facing call) and where it may not (a page, a frame, a file, a
   * log). The value is generated at runtime and never written into source.
   */
  readonly credential?: string;
}

const buildDirectory = mkdtempSync(join(tmpdir(), "every-dagent-shell-build-"));
process.once("exit", () => {
  try {
    rmSync(buildDirectory, { recursive: true, force: true });
  } catch {
    // A temp directory the OS will reclaim; the test result does not depend on it.
  }
});

let building: Promise<string> | undefined;

/** The built artifact, once per process. */
export async function ensureShellBuild(): Promise<string> {
  if (building === undefined) {
    building = buildApp({ outDir: join(buildDirectory, "dist") }).then((result) => result.outDir);
  }
  return await building;
}

function safeParse(frame: string): {
  readonly kind?: unknown;
  readonly method?: unknown;
  readonly requestId?: unknown;
  readonly params?: unknown;
} | null {
  try {
    const value = JSON.parse(frame) as unknown;
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

interface Ward {
  readonly wrap: (channel: ProtocolChannel) => ProtocolChannel;
  readonly controls: ShellControls;
  /** The host connections currently reach. */
  currentHost(): Host;
}

function createWard(initialHost: Host): Ward {
  const connections = new Set<ProtocolChannel>();
  const seen: { readonly method: string; readonly params: Record<string, unknown> }[] = [];
  let armed = false;
  let drops = 0;
  let holdCreate = false;
  let holdSettings = false;
  let holdDelete = false;
  let dropRename = false;
  let dropDelete = false;
  let dropSettings = false;
  let startRequestsSeen = 0;
  let breakRename = false;
  /**
   * The answers the ward parked, one slot per write.
   *
   * A hold is a *delivery* deferral, never a decision: the host has already
   * done the work and its answer is real. The slot is filled by the send path
   * that matched the armed flag — a flag nobody reads cannot fill it — and
   * `delivered` counts what was really handed over, so a test can prove both
   * halves: not yet, and exactly once.
   */
  const parked = {
    create: { resume: null as (() => void) | null, delivered: 0 },
    delete: { resume: null as (() => void) | null, delivered: 0 },
    settings: { resume: null as (() => void) | null, delivered: 0 },
  };
  let activeHost = initialHost;

  return {
    wrap: (channel: ProtocolChannel): ProtocolChannel => {
      connections.add(channel);
      /** The request ids this connection carries that belong to `runs.start`. */
      const startRequestIds = new Set<string>();
      /** The request ids this connection carries that belong to `sessions.create`. */
      const createRequests = new Set<string>();
      /** The request ids this connection carries that belong to a session write or a settings write. */
      const renameRequests = new Set<string>();
      const deleteRequests = new Set<string>();
      const settingsRequests = new Set<string>();
      /**
       * Parks one answer for its release.
       *
       * The answer stays bound to the connection that carried it: a release
       * after that connection is gone delivers nothing rather than resurrecting
       * a channel, and a release with no answer parked is a no-op.
       */
      const park = (frame: string, slot: { resume: (() => void) | null; delivered: number }): void => {
        slot.resume = (): void => {
          slot.resume = null;
          if (!connections.has(channel)) return;
          try {
            channel.send(frame);
          } catch {
            // The connection this answer belonged to is gone: releasing a hold
            // cannot bring it back, and a teardown must not throw from here.
            return;
          }
          slot.delivered += 1;
        };
      };
      return {
        send(frame: string): void {
          const parsed = safeParse(frame);
          if (armed) {
            if (
              parsed !== null &&
              parsed.kind === "host-response" &&
              typeof parsed.requestId === "string" &&
              startRequestIds.has(parsed.requestId)
            ) {
              // The answer is lost with the connection that carried it: the
              // client can no longer learn whether the host accepted the run.
              armed = false;
              drops += 1;
              connections.delete(channel);
              channel.close();
              return;
            }
          }
          for (const [armedFlag, set, requests] of [
            [dropRename, () => (dropRename = false), renameRequests],
            [dropDelete, () => (dropDelete = false), deleteRequests],
            [dropSettings, () => (dropSettings = false), settingsRequests],
          ] as const) {
            if (
              armedFlag &&
              parsed !== null &&
              parsed.kind === "host-response" &&
              typeof parsed.requestId === "string" &&
              requests.has(parsed.requestId)
            ) {
              // The answer dies with its connection: the write may have landed,
              // and the page may not claim either way.
              set();
              drops += 1;
              connections.delete(channel);
              channel.close();
              return;
            }
          }
          for (const [held, set, requests, slot] of [
            [holdCreate, () => (holdCreate = false), createRequests, parked.create],
            [holdDelete, () => (holdDelete = false), deleteRequests, parked.delete],
            [holdSettings, () => (holdSettings = false), settingsRequests, parked.settings],
          ] as const) {
            if (
              held &&
              parsed !== null &&
              parsed.kind === "host-response" &&
              typeof parsed.requestId === "string" &&
              requests.has(parsed.requestId)
            ) {
              // Parked, not dropped: the answer exists and will arrive, just not
              // yet — the window a user gets to move on before it lands. Only
              // the requested answer is parked; every other response passes.
              set();
              park(frame, slot);
              return;
            }
          }
          channel.send(frame);
        },
        listen(listener): () => void {
          return channel.listen({
            onFrame(frame: string): void {
              let forwarded = frame;
              const parsed = safeParse(frame);
              if (parsed !== null && parsed.kind === "client-request" && typeof parsed.requestId === "string") {
                const params = parsed.params as Record<string, unknown> | undefined;
                seen.push({ method: String(parsed.method), params: params ?? {} });
                if (parsed.method === "runs.start") {
                  startRequestIds.add(parsed.requestId);
                  startRequestsSeen += 1;
                }
                if (parsed.method === "sessions.create") createRequests.add(parsed.requestId);
                if (parsed.method === "sessions.rename") {
                  renameRequests.add(parsed.requestId);
                  if (breakRename && params !== undefined) {
                    // A reader who looked at an older copy: the same request
                    // with a revision the host has already moved past.
                    breakRename = false;
                    forwarded = JSON.stringify({
                      ...parsed,
                      params: { ...params, expectedRevision: Number(params["expectedRevision"] ?? 0) + 1000 },
                    });
                  }
                }
                if (parsed.method === "sessions.delete") deleteRequests.add(parsed.requestId);
                if (parsed.method === "settings.update") settingsRequests.add(parsed.requestId);
              }
              listener.onFrame(forwarded);
            },
            onClose(): void {
              listener.onClose();
            },
          });
        },
        close(): void {
          connections.delete(channel);
          channel.close();
        },
      };
    },
    controls: {
      dropNextStartResponse(): void {
        armed = true;
      },
      get drops(): number {
        return drops;
      },
      holdNextCreateAnswer(): void {
        holdCreate = true;
      },
      releaseCreateAnswer(): void {
        parked.create.resume?.();
      },
      closeConnections(): void {
        for (const channel of [...connections]) {
          connections.delete(channel);
          channel.close();
        }
      },
      connections(): number {
        return connections.size;
      },
      startRequests(): number {
        return startRequestsSeen;
      },
      requestsOf(method: string): readonly Record<string, unknown>[] {
        return seen.filter((entry) => entry.method === method).map((entry) => entry.params);
      },
      dropNextRenameResponse(): void {
        dropRename = true;
      },
      dropNextDeleteResponse(): void {
        dropDelete = true;
      },
      dropNextSettingsResponse(): void {
        dropSettings = true;
      },
      holdNextSettingsResponse(): void {
        holdSettings = true;
      },
      holdNextDeleteResponse(): void {
        holdDelete = true;
      },
      releaseDeleteAnswer(): void {
        parked.delete.resume?.();
      },
      releaseSettingsAnswer(): void {
        parked.settings.resume?.();
      },
      deleteAnswerHeld(): boolean {
        return parked.delete.resume !== null;
      },
      deleteAnswersDelivered(): number {
        return parked.delete.delivered;
      },
      settingsAnswerHeld(): boolean {
        return parked.settings.resume !== null;
      },
      settingsAnswersDelivered(): number {
        return parked.settings.delivered;
      },
      breakNextRenameRevision(): void {
        breakRename = true;
      },
      swapTo(host: Host): void {
        activeHost = host;
      },
    },
    currentHost(): Host {
      return activeHost;
    },
  };
}

/**
 * Waits for a parked answer, in the test process.
 *
 * A hold that never arms must fail the test rather than let it assert against
 * an unanswered call: the wait is on the fixture's own state, and it never
 * assumes the page is fast enough to be observed mid-flight.
 */
export async function waitForHeld(held: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 15000;
  while (!held()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
}

export interface ApprovalAcceptance {
  readonly host: Host;
  readonly shell: ShellServer;
  /** The page that answers approvals: the harness, not the shell. */
  readonly harnessUrl: string;
  /** Every value the counter tool was handed, in order. */
  readonly executions: readonly unknown[];
  close(): Promise<void>;
}

/**
 * The M4 acceptance host: a tool the trusted policy will not run without an
 * approval, and a browser to answer it.
 *
 * This is a *carrier* acceptance, not a UI one: the host runs a real loop with
 * a real policy, the binding carries the `tool.approval` request to a real
 * browser, and the page answers with the shipped client's typed handler. M5
 * owns the shell's own approval experience, so the page here is deliberately
 * the minimal harness rather than the shell.
 */
export async function startApprovalAcceptance(): Promise<ApprovalAcceptance> {
  const outDir = await ensureShellBuild();
  const model = offlineModel();
  const executions: unknown[] = [];
  const counter: Plugin = {
    manifest: { id: "counter", name: "Counter", version: "1.0.0", description: "Counts one call per approval." },
    activate(context: PluginContext): void {
      context.tools.register({
        name: "counter",
        description: "Counts.",
        inputSchema: { type: "object" },
        execute: async (input: unknown): Promise<string> => {
          executions.push(input);
          return `count:${executions.length}`;
        },
      });
    },
  };

  const host = await createHost({
    bootstrap: TEST_BOOTSTRAP,
    composition: testComposition({
      modelClient: model.client,
      // The trusted side decides: this tool is a side effect, and the Host will
      // not run it without a client's approval.
      toolPolicy: { revision: 1, decide: () => "require-approval" },
    }),
    plugins: [counter],
  });
  const shell = await startShellServer({ host, staticRoot: join(outDir, "public") });

  return {
    host,
    shell,
    harnessUrl: `${new URL(shell.pageUrl).origin}/approval-harness.html?binding=${encodeURIComponent(shell.bindingOrigin)}`,
    executions,
    async close(): Promise<void> {
      await shell.close();
      await host.shutdown();
    },
  };
}


/**
 * A second host with the same composition as an acceptance, for a swap.
 *
 * It is a fresh instance with the same bootstrap defaults — which is exactly
 * the trap the swap case is about: two hosts can sit at the same revision
 * number, and a settings draft belongs to one of them.
 */
export async function buildCompanionHost(): Promise<Host> {
  return await createHost({
    bootstrap: TEST_BOOTSTRAP,
    composition: testComposition({ modelClient: offlineModel().client }),
    plugins: [createCalculatorPlugin()],
  });
}

export async function startShellAcceptance(options: ShellAcceptanceOptions = {}): Promise<ShellAcceptance> {
  const outDir = await ensureShellBuild();
  const model = offlineModel({ credential: options.credential });
  const textStats = textStatsPlugin();
  const executions: unknown[] = [];
  const composed: ComposeInput[] = [];

  const counter = options.requireApproval === true ? counterPlugin(executions) : undefined;
  const host = await createHost({
    bootstrap: TEST_BOOTSTRAP,
    composition: testComposition({
      modelClient: model.client,
      onCompose: (input: ComposeInput): void => {
        composed.push(input);
        options.onCompose?.(input);
      },
      ...(options.toolPolicy === undefined
        ? options.requireApproval === true
          ? { toolPolicy: { revision: 1, decide: () => "require-approval" as const } }
          : {}
        : { toolPolicy: options.toolPolicy }),
    }),
    plugins: [createCalculatorPlugin(), textStats.plugin, failingPlugin(), ...(counter === undefined ? [] : [counter])],
    ...(options.databasePath === undefined ? {} : { persistence: { kind: "sqlite" as const, location: options.databasePath } }),
  });
  const ward = createWard(host);
  // A host-shaped facade: the server attaches whatever the ward currently
  // points at, which is what lets a test replace the host behind a live page.
  const facade: Host = {
    attach: (channel: ProtocolChannel): void => {
      ward.currentHost().attach(channel);
    },
    shutdown: (): Promise<void> => ward.currentHost().shutdown(),
  } as Host;
  const shell = await startShellServer({
    host: facade,
    staticRoot: join(outDir, "public"),
    wrapChannel: ward.wrap,
    ...(options.pagePort === undefined ? {} : { port: options.pagePort }),
    ...(options.bindingPort === undefined ? {} : { bindingPort: options.bindingPort }),
  });

  return {
    host,
    shell,
    model,
    textStats,
    controls: ward.controls,
    executions,
    composed,
    credential: options.credential ?? null,
    pageUrl: shell.pageUrl,
    bindingOrigin: shell.bindingOrigin,
    async connect(): Promise<Client> {
      const client = createClient({ connect: () => Promise.resolve(ward.wrap(loopbackChannel(host))) });
      await client.connect();
      return client;
    },
    async close(): Promise<void> {
      await shell.close();
      const hosts = new Set<Host>([host, ward.currentHost()]);
      for (const target of hosts) {
        try {
          await target.shutdown();
        } catch {
          // The fixture's `always-broken` plugin cannot be released once it is
          // in the error state, and the host says so instead of pretending.
        }
      }
      try {
        await host.shutdown();
      } catch {
        // The fixture's `always-broken` plugin cannot be released once it is in
        // the error state, and the host says so instead of pretending — that
        // honesty is asserted where it matters (in the host's own tests); here
        // it must not turn a passing acceptance into a teardown failure.
      }
    },
  };
}

/** One loopback channel attached to a host, for a client a test drives directly. */
function loopbackChannel(host: Host): ProtocolChannel {
  const state: {
    clientListener?: { onFrame(frame: string): void; onClose(): void };
    hostListener?: { onFrame(frame: string): void; onClose(): void };
    closed: boolean;
  } = { closed: false };

  function closeBoth(): void {
    if (state.closed) return;
    state.closed = true;
    state.clientListener?.onClose();
    state.hostListener?.onClose();
  }

  function side(direction: "client" | "host"): ProtocolChannel {
    const isClient = direction === "client";
    return {
      send(frame: string): void {
        if (state.closed) throw new Error("channel is closed");
        const listener = isClient ? state.hostListener : state.clientListener;
        if (listener === undefined) throw new Error("listener must be installed before traffic");
        listener.onFrame(frame);
      },
      listen(listener): () => void {
        if (state.closed) throw new Error("channel is closed");
        if (isClient) state.clientListener = listener;
        else state.hostListener = listener;
        return (): void => {
          if (isClient) state.clientListener = undefined;
          else state.hostListener = undefined;
        };
      },
      close(): void {
        closeBoth();
      },
    };
  }

  const pair = { hostSide: side("host"), clientSide: side("client") };
  host.attach(pair.hostSide);
  return pair.clientSide;
}

/** The one execution a browser can authorize: counted per call, and refused without an approval. */
function counterPlugin(executions: unknown[]): Plugin {
  return {
    manifest: { id: "counter", name: "Counter", version: "1.0.0", description: "Counts one call per approval." },
    activate(context: PluginContext): void {
      context.tools.register({
        name: "counter",
        description: "Counts.",
        inputSchema: { type: "object" },
        execute: async (input: unknown): Promise<string> => {
          executions.push(input);
          return `count:${String(executions.length)}`;
        },
      });
    },
  };
}
