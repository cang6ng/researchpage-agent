/**
 * M5's combined acceptance: the platform's own promises, end to end.
 *
 * F1 is a durable host read by a real client over a real carrier, restarted for
 * real: the directory pages, the history fence, a rename's CAS and the settings
 * a restart applies are all read back from the same SQLite file. F3 is a killed
 * host over that file: what it left behind is interpreted by evidence, no old
 * capability comes back, and an answer the old process never got is a frame
 * that changes nothing when the new one receives it.
 *
 * Nothing here is simulated at the application level: the host, the repository,
 * the client, the carrier and the process kill are the real ones. The only
 * stand-in is the model, which never contacts a provider.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";

import { createClient, directoryView, type Client } from "@every-dagent/client";
import { createHost, type ComposeInput, type Host } from "@every-dagent/host";
import { createCalculatorPlugin } from "@every-dagent/plugin-calculator";
import type { ProtocolChannel } from "@every-dagent/protocol";

import { demoPlugin, scriptedModel, textReply } from "../helpers/demo-fixtures.js";
import { createCarrierPair, type CarrierPair } from "../helpers/protocol-carrier.js";
import { TEST_BOOTSTRAP, testComposition } from "../helpers/test-composition.js";

const root = mkdtempSync(join(tmpdir(), "every-dagent-phase4-acceptance-"));
const children = new Set<ChildProcess>();

afterAll(async () => {
  for (const child of children) child.kill("SIGKILL");
  children.clear();
  await new Promise((resolve) => {
    setTimeout(resolve, 250);
  });
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // A file a dying process still holds is not a test failure.
  }
});

interface DurableHost {
  readonly host: Host;
  readonly connect: () => Promise<ProtocolChannel>;
  readonly composed: ComposeInput[];
  readonly carriers: CarrierPair[];
}

/** One host over a real file, with the composition a test can watch. */
async function durableHost(options: {
  readonly databasePath: string;
  readonly replies?: number;
  readonly toolPolicy?: "allow";
}): Promise<DurableHost> {
  const replies = options.replies ?? 0;
  const scripted = scriptedModel(Array.from({ length: replies }, (_, index) => textReply(`answer ${String(index)}`)));
  const composed: ComposeInput[] = [];
  const counter = demoPlugin("counter", "count", "counted");
  const host = await createHost({
    bootstrap: TEST_BOOTSTRAP,
    composition: testComposition({
      modelClient: scripted.client,
      onCompose: (input) => composed.push(input),
    }),
    plugins: [createCalculatorPlugin(), counter.plugin],
    persistence: { kind: "sqlite", location: options.databasePath },
  });
  const carriers: CarrierPair[] = [];
  return {
    host,
    composed,
    carriers,
    connect: async (): Promise<ProtocolChannel> => {
      const pair = createCarrierPair();
      carriers.push(pair);
      host.attach(pair.hostSide);
      return pair.clientSide;
    },
  };
}

async function connectClient(target: DurableHost, name: string): Promise<Client> {
  const client = createClient({ connect: () => target.connect(), client: { name, version: "1.0.0" } });
  await client.connect();
  return client;
}

describe("F1 — durable state, history and settings across a restart", () => {
  it("reads back a paged directory, a renamed session, a fenced history and the settings a restart applies", async () => {
    const databasePath = join(root, "f1.db");

    // --- First instance: fill, page, rename, converse, configure.
    const first = await durableHost({ databasePath, replies: 6 });
    const client = await connectClient(first, "f1-client");

    // A directory much longer than one page: the window is a window, and the
    // older pages continue it without pretending to be the whole collection.
    const created: string[] = [];
    for (let index = 0; index < 60; index += 1) {
      created.push((await client.sessions.create()).session.sessionId);
    }
    const firstWindow = client.getSnapshot();
    // eslint-disable-next-line no-console
    console.log("F1 STATUS", firstWindow.status, firstWindow.error?.reason ?? "none", firstWindow.error?.message ?? "");
    const window = directoryView(firstWindow.directory, firstWindow.presentation?.sessions ?? null);
    // The cut published the host's own page, and the events that followed grew
    // the window up to its bound — never into a claim about the collection.
    expect(window.items.length).toBeLessThanOrEqual(50);
    expect(firstWindow.directory.stale).toBe(true);
    expect(window.complete).toBe(false);
    // The continuation the window was published with is retired: the catalogue
    // moved under it, and a page cut from the old revision may not be glued to
    // the new one.
    expect(await client.directory.loadOlder()).toEqual({ loaded: false, stale: true });

    // Re-reading the head anchors a fresh traversal, which the older page then
    // continues until the directory really is the whole collection.
    expect(await client.directory.refreshHead()).toEqual({ loaded: true, stale: false });
    const anchored = client.getSnapshot();
    const anchoredView = directoryView(anchored.directory, anchored.presentation?.sessions ?? null);
    expect(anchoredView.items.length).toBe(50);
    expect(anchoredView.complete).toBe(false);
    expect(anchoredView.nextCursor).not.toBeNull();

    const older = await client.directory.loadOlder();
    expect(older).toEqual({ loaded: true, stale: false });
    const loaded = client.getSnapshot();
    const view = directoryView(loaded.directory, loaded.presentation?.sessions ?? null);
    expect(view.items).toHaveLength(60);
    expect(view.complete).toBe(true);

    // An old session — one that only the older page holds — is confirmed
    // against the host before it authorizes anything.
    const oldSession = created[0] as string;
    await client.directory.focus(oldSession);
    const pin = client.getSnapshot().focusedSession;
    expect(pin?.sessionId).toBe(oldSession);
    expect(pin?.confirmed).toBe(true);

    // A rename is a CAS: the revision the reader saw is the one it sends, and
    // an older revision is refused rather than replayed.
    const beforeRename = pin?.summary.title ?? "";
    const renamed = await client.sessions.rename({
      sessionId: oldSession,
      expectedRevision: pin?.summary.metadataRevision ?? 0,
      title: "f1 renamed",
    });
    expect(renamed.session.title).toBe("f1 renamed");
    expect(renamed.session.title).not.toBe(beforeRename);
    await expect(
      client.sessions.rename({ sessionId: oldSession, expectedRevision: 0, title: "stale" }),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });

    // A conversation longer than one page: the newest page is a bounded
    // fragment, reading back to the start is what makes the reading complete,
    // and the fence never moves while the traversal is under way.
    const conversation = created[1] as string;
    for (let turn = 0; turn < 6; turn += 1) {
      const submissionId = `f1-turn-${String(turn)}`;
      await client.runs.start({ sessionId: conversation, submissionId, text: `turn ${String(turn)}` });
      // One run at a time: the next admission waits for this one's terminal.
      await settled(client, submissionId);
    }
    const newest = (await client.sessions.history({ sessionId: conversation })).page;
    expect(newest.atStart).toBe(false);
    expect(newest.fenceSeq).toBe(newest.coverage.toSeq);
    let read = newest;
    for (let page = 0; page < 8 && !read.atStart; page += 1) {
      expect(read.nextCursor).not.toBeNull();
      read = (await client.sessions.history({ sessionId: conversation, cursor: read.nextCursor ?? "" })).page;
    }
    const coverage = client.getSnapshot().history[conversation];
    expect(coverage?.atStart).toBe(true);
    expect(coverage?.fenceSeq).toBe(coverage?.toSeq);
    expect(coverage?.items.filter((item) => item.kind === "user")).toHaveLength(6);

    // The plugin's durable intent is what a restart aims for.
    await client.plugins.enable({ pluginId: "counter" });
    const plugin = (await client.plugins.list()).plugins.find((entry) => entry.id === "counter");
    expect(plugin?.desiredEnabled).toBe(true);
    expect(plugin?.status).toBe("enabled");

    // A settings write moves desired, not effective: this instance is already
    // running, and only a restart composes with the new value.
    const readBack = await client.settings.get({ namespace: "model" });
    expect(readBack.settings.desiredRevision).toBe(readBack.settings.effectiveRevision);
    const saved = await client.settings.update({
      namespace: "model",
      expectedRevision: readBack.settings.desiredRevision,
      value: { provider: "test", model: "next-model" },
    });
    expect(saved.settings.desiredRevision).toBe(readBack.settings.desiredRevision + 1);
    expect(saved.settings.effectiveRevision).toBe(readBack.settings.effectiveRevision);
    expect(saved.settings.restartRequired).toBe(true);
    expect(saved.settings.effectiveValue).toMatchObject({ model: "test-model" });
    expect(saved.settings.desiredValue).toMatchObject({ model: "next-model" });

    const firstInstance = client.getSnapshot().description?.hostInstanceId ?? "";
    const firstStorage = client.getSnapshot().description?.storage.storageId ?? "";
    client.disconnect();
    await first.host.shutdown();

    // --- Second instance: the same file, a new host identity, the composed
    // execution built from the value the first instance only wrote down.
    const second = await durableHost({ databasePath });
    expect(second.composed).toHaveLength(1);
    expect(second.composed[0]?.model).toMatchObject({ model: "next-model" });
    expect(second.composed[0]?.revisions.model).toBe(saved.settings.desiredRevision);
    expect(second.composed[0]?.host).toMatchObject({ loop: TEST_BOOTSTRAP.host.loop });

    const client2 = await connectClient(second, "f1-client-2");
    const description = client2.getSnapshot().description;
    expect(description?.hostInstanceId).not.toBe(firstInstance);
    expect(description?.storage.storageId).toBe(firstStorage);

    // The session, its title and its whole history are read back from the file.
    const survivor = await client2.sessions.get({ sessionId: oldSession });
    expect(survivor.session.sessionId).toBe(oldSession);
    expect(survivor.session.title).toBe("f1 renamed");

    const historyAgain = (await client2.sessions.history({ sessionId: conversation })).page;
    expect(historyAgain.fenceSeq).toBe(newest.fenceSeq);
    expect(historyAgain.coverage.toSeq).toBe(newest.coverage.toSeq);
    expect(historyAgain.items.map((item) => item.id)).toEqual(newest.items.map((item) => item.id));

    // The directory the new instance publishes holds what the old one did.
    const sessions2 = await client2.sessions.list({});
    expect(sessions2.sessions.items.length).toBeGreaterThan(0);
    expect(sessions2.sessions.items.some((entry) => entry.sessionId === oldSession)).toBe(true);

    // The settings the restart applied: desired and effective agree again, and
    // nothing is owed.
    const settingsAfter = await client2.settings.get({ namespace: "model" });
    expect(settingsAfter.settings.desiredRevision).toBe(saved.settings.desiredRevision);
    expect(settingsAfter.settings.effectiveRevision).toBe(saved.settings.desiredRevision);
    expect(settingsAfter.settings.restartRequired).toBe(false);
    expect(settingsAfter.settings.effectiveValue).toMatchObject({ model: "next-model" });

    // The plugin's intent survived, and this instance is actually running it.
    const pluginAfter = (await client2.plugins.list()).plugins.find((entry) => entry.id === "counter");
    expect(pluginAfter?.desiredEnabled).toBe(true);
    expect(pluginAfter?.status).toBe("enabled");
    expect(pluginAfter?.unavailable).toBe(false);

    client2.disconnect();
    await second.host.shutdown();
  }, 120_000);
});

describe("F3 — a killed host, and an answer it never got", () => {
  it("interprets the run by evidence and ignores an old approval reply on the real carrier", async () => {
    bundle ??= await bundleChild();
    const databasePath = join(root, `f3-${String(Date.now())}.db`);
    const journalPath = `${databasePath}.journal`;
    const child = spawn(process.execPath, [bundle, "approval-pending", databasePath, journalPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);

    let stdout = "";
    let stderr = "";
    const boundary = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`the child never reached its boundary; stderr: ${stderr}`)), 60_000);
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        if (/BOUNDARY approval-pending approval-pending/.test(stdout)) {
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
    });
    await boundary;
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    });
    children.delete(child);

    const journal = readFileSync(journalPath, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(journal.some((entry) => entry["kind"] === "approval-pending")).toBe(true);
    expect(journal.some((entry) => entry["kind"] === "tool-execution")).toBe(false);
    const manifest = JSON.parse(readFileSync(`${databasePath}.manifest.json`, "utf8")) as {
      readonly submissionId: string;
      readonly sessionId: string;
    };

    // A new host over the same file: the unfinished run is its own terminal,
    // the session is blocked, and no approval exists anywhere.
    const restarted = await durableHost({ databasePath });
    const client = await connectClient(restarted, "f3-client");
    const run = await client.runs.get({ submissionId: manifest.submissionId });
    expect(run.run.status).toBe("interrupted");
    expect(run.run.endReason).toBe("interrupted");
    expect(run.run.executionKnowledge).toBe("unknown");
    const session = await client.sessions.get({ sessionId: manifest.sessionId });
    expect(session.session.status).toBe("blocked");
    expect(session.session.blockedReason).toBe("unknown-execution");
    expect(session.session.activeRunId).toBeNull();
    expect(client.getSnapshot().presentation?.approval ?? null).toBeNull();
    expect(client.getSnapshot().approvalReply.state).toBe("none");

    // The old reply the dying process never received, sent as a raw frame on
    // the real carrier: the new host has no pending to match it to, and the
    // tool it would have authorized never runs.
    const carrier = restarted.carriers[restarted.carriers.length - 1];
    if (carrier === undefined) throw new Error("no carrier was recorded");
    const oldReply = JSON.stringify({
      kind: "client-response",
      protocolVersion: "2",
      hostInstanceId: client.getSnapshot().description?.hostInstanceId ?? "none",
      streamId: "old-stream",
      requestId: "old-request",
      result: { approvalId: "old-approval", executionId: "old-execution", decision: "approve" },
    });
    carrier.clientSide.send(oldReply);
    await carrier.settled();
    // The connection is untouched by it: the reads still work and the session
    // still blocks, which is what "zero dispatch, no revived capability" looks
    // like from the outside.
    const after = await client.sessions.get({ sessionId: manifest.sessionId });
    expect(after.session.status).toBe("blocked");
    const runsAfter = await client.runs.list({ sessionId: manifest.sessionId });
    expect(runsAfter.runs.items.map((entry) => entry.status)).toEqual(["interrupted"]);
    client.disconnect();
    await restarted.host.shutdown();

    // A second restart reconciles nothing and changes nothing: the outcome is a
    // committed fact, not a state that keeps moving.
    const twice = await durableHost({ databasePath });
    const client2 = await connectClient(twice, "f3-client-2");
    const again = await client2.runs.get({ submissionId: manifest.submissionId });
    expect(again.run.status).toBe("interrupted");
    expect(again.run.executionKnowledge).toBe("unknown");
    const sessionAgain = await client2.sessions.get({ sessionId: manifest.sessionId });
    expect(sessionAgain.session.status).toBe("blocked");
    expect(sessionAgain.session.metadataRevision).toBe(after.session.metadataRevision);
    client2.disconnect();
    await twice.host.shutdown();
  }, 180_000);
});

/** Waits for one submission's run to reach a terminal state. */
async function settled(client: Client, submissionId: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const { run } = await client.runs.get({ submissionId });
    if (run.status !== "accepted" && run.status !== "running") return;
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(`the run for ${submissionId} never settled`);
}

/** The crash child, bundled once per process. */
let bundle: string | undefined;

async function bundleChild(): Promise<string> {
  const outfile = join(root, "durable-crash-child.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("../fixtures/durable-crash-child.ts", import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "silent",
  });
  return outfile;
}
