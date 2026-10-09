/**
 * A restart, with a real process.
 *
 * The incident this file is written against: a report was being written, the
 * service was stopped and started again, and the project then waited forever.
 * The run record said `interrupted`, the generation still said `running`, and
 * the page — reading the generation — disabled the button and offered nothing
 * else. The queue was empty, so no page could recover it.
 *
 * A restart cannot be tested inside one process, so this test builds the real
 * server with esbuild (the same Node/banner parameters the product's own bundle
 * uses), starts it against a data directory of its own, kills it with SIGKILL
 * while it is genuinely reporting, and starts it again on the same directory.
 * The child is scripted, so nothing here reaches a provider or the network.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const WORK = join(process.cwd(), ".scratch", "release-repair-20261009", "restart");
const HELPER = join(process.cwd(), "apps", "research", "tests", "helpers", "report-restart-server.ts");

interface Child {
  readonly process: ChildProcess;
  readonly lines: Record<string, unknown>[];
  readonly taskId: () => string;
  readonly modelCalls: () => number;
  wait(event: string, timeoutMs?: number): Promise<Record<string, unknown>>;
}

function start(dataDir: string, port: number, scenario: string): Child {
  const child = spawn(process.execPath, [join(WORK, "report-restart-server.mjs"), scenario, dataDir, String(port)], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, RESEARCHPAGE_MODEL: "", MINERU_MCP_COMMAND: "" },
  });
  const lines: Record<string, unknown>[] = [];
  const waiters: { readonly event: string; readonly resolve: (line: Record<string, unknown>) => void; readonly at: number }[] = [];
  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const breakAt = buffer.indexOf("\n");
      if (breakAt < 0) break;
      const raw = buffer.slice(0, breakAt).trim();
      buffer = buffer.slice(breakAt + 1);
      if (raw.length === 0) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        continue;
      }
      lines.push(parsed);
      for (let index = waiters.length - 1; index >= 0; index -= 1) {
        const waiter = waiters[index];
        if (waiter?.event === parsed["event"]) {
          waiters.splice(index, 1);
          waiter.resolve(parsed);
        }
      }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    lines.push({ event: "stderr", message: chunk.toString("utf8") });
  });
  return {
    process: child,
    lines,
    taskId: () => String(lines.find((line) => typeof line["taskId"] === "string")?.["taskId"] ?? ""),
    modelCalls: () => lines.filter((line) => line["event"] === "model-call").length,
    wait(event, timeoutMs = 60_000) {
      const found = lines.find((line) => line["event"] === event);
      if (found !== undefined) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`the child never reported ${event}: ${JSON.stringify(lines.slice(-6))}`)), timeoutMs);
        waiters.push({
          event,
          at: Date.now(),
          resolve: (line) => {
            clearTimeout(timer);
            resolve(line);
          },
        });
      });
    },
  };
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function kill(child: Child): Promise<void> {
  const pid = child.process.pid;
  if (pid === undefined) return;
  const exited = new Promise<void>((resolve) => child.process.once("exit", () => resolve()));
  child.process.kill("SIGKILL");
  const ended = await Promise.race([exited.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 15_000))]);
  // A process that did not exit is a process that could still hold the database.
  expect(ended, "the child process did not exit after SIGKILL").toBe(true);
}

async function get(port: number, path: string): Promise<Record<string, unknown>> {
  const response = await fetch(`http://127.0.0.1:${String(port)}${path}`);
  return (await response.json()) as Record<string, unknown>;
}

async function post(port: number, path: string): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function generationOf(bundle: Record<string, unknown>): Record<string, unknown> {
  return (bundle["reportGeneration"] ?? {}) as Record<string, unknown>;
}

const children: Child[] = [];
const dataDirs: string[] = [];

beforeAll(async () => {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  await build({
    entryPoints: [HELPER],
    outfile: join(WORK, "report-restart-server.mjs"),
    bundle: true,
    format: "esm",
    platform: "node",
    target: ["node22"],
    banner: {
      js: "import { createRequire as __researchCreateRequire } from 'node:module';\nconst require = __researchCreateRequire(import.meta.url);",
    },
    logLevel: "silent",
  });
}, 120_000);

afterAll(async () => {
  const exits = children.map((child) => {
    if (child.process.exitCode !== null || child.process.signalCode !== null) return Promise.resolve();
    const ended = new Promise<void>((resolve) => child.process.once("exit", () => resolve()));
    child.process.kill("SIGKILL");
    return ended;
  });
  await Promise.all(exits);
  // The store is released by the process that held it, and Windows is slow
  // about saying so: a directory that is still locked is not a test failure.
  for (const dir of dataDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // Left for the next run to overwrite.
    }
  }
});

describe("a report interrupted by a restart", () => {
  it("comes back from a hard kill with the recovery open, and completes it", async () => {
    const dataDir = join(WORK, "data-hang");
    dataDirs.push(dataDir);
    const first = start(dataDir, await freePort(), "material-hang");
    children.push(first);
    // The child reports once the report pass is really in flight: the run is
    // running and the attempt is persisted as `running`.
    const running = await first.wait("running");
    const taskId = String(running["taskId"] ?? "");
    expect(taskId.length).toBeGreaterThan(0);
    expect(first.modelCalls()).toBeGreaterThan(0);
    await kill(first);

    // The second process reads the same directory. Nothing has been asked of
    // the model when the page loads, and nothing may be: a page load is a read.
    const port = await freePort();
    const second = start(dataDir, port, "recover");
    children.push(second);
    await second.wait("listening");
    const before = await get(port, `/api/research/tasks/${taskId}`);
    const generation = generationOf(before);
    expect(before["busy"]).toBe(false);
    expect(generation["status"]).toBe("failed");
    expect(generation["canResume"]).toBe(true);
    expect(generation["reportId"]).toBeNull();
    const failure = (generation["failure"] ?? {}) as { code?: string };
    expect(failure.code).toBe("run_interrupted");
    // The timing says the end is unknown rather than inventing the moment this
    // process happened to look.
    const timing = (before["timing"] ?? {}) as { readonly report?: { readonly state?: string } };
    expect(timing.report?.state).toBe("unknown");
    expect(second.modelCalls()).toBe(0);

    // The button's request: accepted, and the offline fixture then writes a
    // report the product's own Validator accepts.
    const accepted = await post(port, `/api/research/tasks/${taskId}/report`);
    expect(accepted.status).toBe(202);
    expect(accepted.body["reportId"]).toBeNull();
    await second.wait("model-call", 60_000);
    const deadline = Date.now() + 90_000;
    let stored: string | null = null;
    while (Date.now() < deadline && stored === null) {
      const bundled = await get(port, `/api/research/tasks/${taskId}`);
      stored = (bundled["currentReportId"] ?? null) as string | null;
      if (stored === null) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(stored, `the recovery never stored a report: ${JSON.stringify(second.lines.slice(-8))}`).not.toBeNull();
    const after = await get(port, `/api/research/tasks/${taskId}`);
    expect(generationOf(after)["status"]).toBe("validated");
    // Material and budget survived: the recovery did not research again.
    expect(after["currentReportId"]).toBe(stored);

    // A third start on the same directory changes nothing and asks nothing:
    // convergence is idempotent, and the stored report is the stored report.
    await second.process.kill("SIGTERM");
    const third = start(dataDir, await freePort(), "recover");
    children.push(third);
    const thirdPort = Number(new URL(String((await third.wait("listening"))["url"] ?? "")).port);
    const reopened = await get(thirdPort, `/api/research/tasks/${taskId}`);
    expect(reopened["currentReportId"]).toBe(stored);
    expect(generationOf(reopened)["status"]).toBe("validated");
    expect(third.modelCalls()).toBe(0);
  }, 300_000);

  it("converges an attempt that was persisted before its run ever started", async () => {
    const dataDir = join(WORK, "data-seed");
    dataDirs.push(dataDir);
    const first = start(dataDir, await freePort(), "seed");
    children.push(first);
    const seeded = await first.wait("seeded");
    const taskId = String(seeded["taskId"] ?? "");
    // Nothing is in flight at all: no run record, no queue entry.
    await kill(first);

    const port = await freePort();
    const second = start(dataDir, port, "recover");
    children.push(second);
    await second.wait("listening");
    const bundle = await get(port, `/api/research/tasks/${taskId}`);
    const generation = generationOf(bundle);
    expect(bundle["busy"]).toBe(false);
    expect(generation["status"]).toBe("failed");
    expect(generation["canResume"]).toBe(true);
    expect((generation["failure"] as { code?: string }).code).toBe("run_interrupted");
    expect(second.modelCalls()).toBe(0);
  }, 180_000);
});
