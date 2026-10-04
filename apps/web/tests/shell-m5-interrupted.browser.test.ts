/**
 * M5: what a previous Host left behind, in the normal Generic App.
 *
 * The crash is a real one — a child process, a real SQLite file, a real
 * SIGKILL at a named boundary — and the host that reads it afterwards is a new
 * process over the same file. What the page must say divides on evidence, not
 * on optimism: a run that was accepted and never marked running can be proved
 * not to have started, and one that was marked running cannot be proved
 * anything about. The first keeps its session usable; the second blocks it.
 *
 * The same acceptance covers what a blocked session still *is*: readable,
 * renameable, deletable — and never resumed.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { findBrowser, launchBrowser, type BrowserSession } from "./helpers/chrome-cdp.js";
import { startShellAcceptance, type ShellAcceptance } from "./helpers/shell-server.js";

const browser = findBrowser();

let bundle: string;
let root: string;
const children = new Set<ChildProcess>();

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "every-dagent-m5-interrupted-"));
  bundle = join(root, "durable-crash-child.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("../../../tests/fixtures/durable-crash-child.ts", import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: bundle,
    logLevel: "silent",
  });
}, 120_000);

afterAll(() => {
  for (const child of children) child.kill("SIGKILL");
  children.clear();
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // A file a dying child still holds is not a test failure.
  }
});

interface Manifest {
  readonly phase: string;
  readonly sessionId: string;
  readonly submissionId: string;
}

/** Runs the child to a boundary, kills it for real, and leaves its file behind. */
async function crashAt(phase: string): Promise<{ readonly databasePath: string; readonly manifest: Manifest }> {
  const databasePath = join(root, `${phase}-${String(Date.now())}.db`);
  const journalPath = `${databasePath}.journal`;
  const child = spawn(process.execPath, [bundle, phase, databasePath, journalPath], { stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);

  let stdout = "";
  let stderr = "";
  const boundary = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the child never reached its boundary; stderr: ${stderr}`)), 60_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.includes(`BOUNDARY ${phase}`)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      if (!stdout.includes(`BOUNDARY ${phase}`)) {
        clearTimeout(timer);
        reject(new Error(`the child exited with ${String(code)}; stderr: ${stderr}`));
      }
    });
  });

  await boundary;
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  children.delete(child);
  const manifest = JSON.parse(readFileSync(`${databasePath}.manifest.json`, "utf8")) as Manifest;
  return { databasePath, manifest };
}

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const resource of open.splice(0)) await resource.close();
});

const textOf = (selector: string): string => `(document.querySelector(${JSON.stringify(selector)})?.textContent ?? "")`;
const disabledOf = (selector: string): string => `String(document.querySelector(${JSON.stringify(selector)}).disabled)`;
const runStatus = 'document.querySelector("[data-testid=run-status]")?.textContent ?? ""';

async function openShell(acceptance: ShellAcceptance): Promise<{ acceptance: ShellAcceptance; session: BrowserSession }> {
  const session = await launchBrowser({ executable: browser ?? "" });
  open.push({
    close: async () => {
      await session.close();
      await acceptance.close();
    },
  });
  await session.navigate(acceptance.pageUrl);
  await session.waitFor(
    'document.querySelector("[data-testid=connection-status]")?.textContent ?? ""',
    (value) => value.includes("已就绪"),
    45000,
    "the shell to become ready",
  );
  return { acceptance, session };
}

describe("what a killed host left behind, in a real browser", () => {
  it.skipIf(browser === undefined)(
    "says an accepted-but-never-started run can be proved not to have run",
    async () => {
      const { databasePath } = await crashAt("accepted");
      const acceptance = await startShellAcceptance({ databasePath });
      const { session } = await openShell(acceptance);

      // The directory the new host rebuilt holds the session, and selecting it
      // reads its history back from the file.
      await session.waitFor(
        'document.querySelector("[data-testid=session-item]") !== null ? "yes" : ""',
        (value) => value === "yes",
        20000,
        "the reconciled session",
      );
      await session.click('[data-testid="session-item"]');
      await session.waitFor(runStatus, (value) => value.includes("已中断"), 20000, "the interrupted run");

      // The evidence class decides the sentence: no running marker was ever
      // committed, so this run provably did not start — and the session is
      // still usable.
      expect(await session.evaluate<string>(textOf('[data-testid="run-strip"]'))).toContain("可以确认它没有被执行");
      expect(await session.evaluate<string>(textOf('[data-testid="run-strip"]'))).toContain("请重新提交");
      expect(await session.evaluate<string>(`document.querySelector('[data-testid="blocked-banner"]') === null ? "none" : "blocked"`)).toBe("none");
      await session.waitFor(disabledOf('[data-testid="composer-input"]'), (value) => value === "false", 10000, "the composer to stay usable");

      expect(session.uncaughtExceptions()).toEqual([]);
    },
    150000,
  );

  it.skipIf(browser === undefined)(
    "says a run with a running marker cannot be known, and blocks the session without resuming it",
    async () => {
      const { databasePath } = await crashAt("running");
      const acceptance = await startShellAcceptance({ databasePath });
      const { session } = await openShell(acceptance);

      await session.waitFor(
        'document.querySelector("[data-testid=session-item]") !== null ? "yes" : ""',
        (value) => value === "yes",
        20000,
        "the reconciled session",
      );
      await session.click('[data-testid="session-item"]');
      await session.waitFor(runStatus, (value) => value.includes("已中断"), 20000, "the interrupted run");

      // The conservative half: the marker says the execution had started, and
      // nothing says whether it produced effects — so nothing claims it did.
      expect(await session.evaluate<string>(textOf('[data-testid="run-strip"]'))).toContain("无法确认是否已经产生副作用");
      expect(await session.evaluate<string>(textOf('[data-testid="blocked-banner"]'))).toContain("被 Host 标记为阻塞");
      expect(await session.evaluate<string>(textOf('[data-testid="blocked-banner"]'))).toContain("不会被自动恢复执行");

      // A blocked session refuses new work — the composer is off — and offers
      // no resume, retry or unblock control anywhere.
      await session.waitFor(disabledOf('[data-testid="composer-input"]'), (value) => value === "true", 10000, "the composer to be off");
      expect(await session.evaluate<string>(`String(document.querySelectorAll('[data-testid="resume-run"], [data-testid="retry-tool"], [data-testid="unblock"]').length)`)).toBe("0");

      // History is still read: the committed prefix is on the page.
      expect(await session.evaluate<string>(textOf('[data-testid="history-truth"]'))).not.toBe("");

      expect(session.uncaughtExceptions()).toEqual([]);
    },
    150000,
  );

  it.skipIf(browser === undefined)(
    "lets a blocked session be renamed and permanently deleted, and never comes back",
    async () => {
      const { databasePath, manifest } = await crashAt("running");
      const acceptance = await startShellAcceptance({ databasePath });
      const { session } = await openShell(acceptance);

      await session.waitFor(
        'document.querySelector("[data-testid=session-item]") !== null ? "yes" : ""',
        (value) => value === "yes",
        20000,
        "the reconciled session",
      );
      await session.click('[data-testid="session-item"]');
      await session.waitFor(runStatus, (value) => value.includes("已中断"), 20000, "the interrupted run");

      // A blocked session is still a session: rename is offered (the pin is
      // confirmed on this connection) and it changes the host's own summary.
      await session.click('[data-testid="rename-start"]');
      await session.type('[data-testid="rename-input"]', "重命名后的阻塞会话");
      await session.click('[data-testid="rename-submit"]');
      await session.waitFor(
        'document.querySelector("[data-testid=session-item][data-selected=true] .session__label")?.textContent ?? ""',
        (value) => value === "重命名后的阻塞会话",
        20000,
        "the renamed session",
      );

      // The deletion is permanent and confirmed in two steps.
      await session.click('[data-testid="delete-start"]');
      await session.waitFor(
        'document.querySelector("[data-testid=delete-warning]") !== null ? "yes" : ""',
        (value) => value === "yes",
        10000,
        "the delete confirmation",
      );
      const warning = await session.evaluate<string>(textOf('[data-testid="delete-warning"]'));
      expect(warning).toContain("永久删除");
      expect(warning).toContain("没有回收站");
      expect(warning).toContain("无法撤销");
      expect(warning).toContain("不会撤销已经发生的外部工具副作用");

      await session.click('[data-testid="delete-confirm"]');
      await session.waitFor(
        'document.querySelector("[data-testid=sessions-empty]") !== null || document.querySelectorAll("[data-testid=session-item]").length === 0 ? "gone" : ""',
        (value) => value === "gone",
        20000,
        "the deleted session to be gone",
      );

      // The file is the truth: the session is not there, and a fresh query for
      // it is answered not-found rather than by a resurrected copy.
      const client = await acceptance.connect();
      await expect(client.sessions.get({ sessionId: manifest.sessionId })).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
      client.disconnect();

      expect(session.uncaughtExceptions()).toEqual([]);
    },
    150000,
  );
});
