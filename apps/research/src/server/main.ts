/**
 * The runnable entry: start the product, print where it is, stop on a signal.
 *
 * Configuration is explicit and non-secret, and the credential is the one thing
 * that comes from the environment — read here, handed to the composition, and
 * never written to a store, a log line or a page.
 *
 *   node dist/research-server.mjs [--data <dir>] [--port <n>] [--model <provider/model>]
 *
 * `RESEARCHPAGE_MODEL` and `DEEPSEEK_API_KEY` (or the provider's own variable,
 * through `RESEARCHPAGE_CREDENTIAL_ENV`) supply the model and its credential.
 */

import { mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { startResearchApp, type ResearchApp } from "./composition.js";

export interface ResearchCliOptions {
  readonly dataDir: string;
  readonly staticRoot: string;
  readonly port: number | undefined;
  readonly provider: string;
  readonly model: string;
  readonly credentialEnv: string;
}

const DEFAULT_MODEL = "deepseek/deepseek-flash";

export function parseArgs(argv: readonly string[]): ResearchCliOptions | { readonly error: string } {
  let dataDir = resolve(process.cwd(), "researchpage-data");
  let staticRoot: string | undefined;
  let port: number | undefined;
  let credentialEnv = process.env["RESEARCHPAGE_CREDENTIAL_ENV"] ?? "";

  for (let index = 0; index < argv.length; index += 1) {
    switch (argv[index]) {
      case "--data": {
        const value = argv[index + 1];
        if (value === undefined) return { error: "--data needs a directory" };
        dataDir = resolve(process.cwd(), value);
        index += 1;
        break;
      }
      case "--static-root": {
        const value = argv[index + 1];
        if (value === undefined) return { error: "--static-root needs a directory" };
        staticRoot = resolve(process.cwd(), value);
        index += 1;
        break;
      }
      case "--port": {
        const value = Number(argv[index + 1]);
        if (!Number.isInteger(value) || value < 0 || value > 65535) return { error: "--port needs an integer" };
        port = value;
        index += 1;
        break;
      }
      case "--credential-env": {
        const value = argv[index + 1];
        if (value === undefined) return { error: "--credential-env needs a variable name" };
        credentialEnv = value;
        index += 1;
        break;
      }
      default:
        return { error: `unknown argument: ${argv[index] ?? ""}` };
    }
  }

  const profile = process.env["RESEARCHPAGE_MODEL"] ?? DEFAULT_MODEL;
  const [provider, model] = profile.includes("/") ? profile.split("/", 2) : [profile, profile];
  if (provider === undefined || model === undefined || provider === "" || model === "") {
    return { error: `RESEARCHPAGE_MODEL must be provider/model, got "${profile}"` };
  }
  if (credentialEnv === "") {
    credentialEnv = `${provider.toUpperCase()}_API_KEY`;
  }

  return {
    dataDir,
    staticRoot: staticRoot ?? fileURLToPath(new URL("./public/", import.meta.url)),
    port,
    provider,
    model,
    credentialEnv,
  };
}

export function credentialFor(options: ResearchCliOptions, environment: NodeJS.ProcessEnv): string | undefined {
  const value = environment[options.credentialEnv];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function runResearchServer(
  argv: readonly string[],
  io: { out(message: string): void; err(message: string): void },
  stop?: (app: ResearchApp) => Promise<void>,
): Promise<number> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    io.err(parsed.error);
    return 2;
  }
  const credential = credentialFor(parsed, process.env);
  if (credential === undefined) {
    io.err(`${parsed.credentialEnv} is not set: the research server needs a model credential`);
    return 2;
  }

  mkdirSync(parsed.dataDir, { recursive: true });
  const app = await startResearchApp({
    dataDir: parsed.dataDir,
    staticRoot: parsed.staticRoot,
    model: { provider: parsed.provider, model: parsed.model },
    credential,
    ...(parsed.port === undefined ? {} : { port: parsed.port }),
    log: (message: string): void => {
      io.out(message);
    },
  });

  io.out("ResearchPage");
  io.out(`  workspace: ${app.url}`);
  io.out(`  data:      ${parsed.dataDir}`);
  io.out(`  model:     ${parsed.provider}/${parsed.model}`);

  await (stop === undefined ? waitForSignal(io) : stop(app));
  await app.close();
  return 0;
}

function waitForSignal(io: { out(message: string): void }): Promise<void> {
  return new Promise((resolveStop) => {
    let first = true;
    const onSignal = (signal: NodeJS.Signals): void => {
      if (!first) {
        io.out("forced exit");
        process.exit(130);
      }
      first = false;
      io.out(`received ${signal}; shutting down`);
      resolveStop();
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });
}

const entry = process.argv[1] === undefined ? "" : pathToFileURL(resolve(process.argv[1])).href;
if (import.meta.url === entry) {
  void runResearchServer(process.argv.slice(2), {
    out: (message: string): void => {
      console.log(message);
    },
    err: (message: string): void => {
      console.error(message);
    },
  }).then((code) => {
    if (code !== 0) process.exitCode = code;
  });
}
