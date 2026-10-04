/**
 * The bounded session directory, and the focused pin.
 *
 * The window a cut installs is not a collection, and these tests are about the
 * difference: what a client reads below it, how far back the reads may go, what
 * happens when the catalogue moves under a traversal, and which reads it stands
 * behind when the shell asks it to focus a session.
 */

import { describe, expect, it } from "vitest";

import type { SessionSummary } from "@every-dagent/protocol";

import { sessionSummary, completedRun, runningRun, activeRun, acceptedRun } from "./helpers/values.js";
import { createFakeHost } from "./helpers/fake-host.js";
import { createScenario, flush, openWith } from "./helpers/scenario.js";
import { DIRECTORY_CACHE_LIMITS, directoryContinuation, directoryView } from "../src/directory.js";

/** One page of summaries, quoted exactly as a host would answer with it. */
function page(
  items: readonly SessionSummary[],
  extra: { readonly collectionRevision?: number; readonly nextCursor?: string | null; readonly hasMore?: boolean } = {},
) {
  return {
    items,
    collectionRevision: extra.collectionRevision ?? 1,
    nextCursor: extra.nextCursor ?? null,
    hasMore: extra.hasMore ?? false,
  };
}

/** `count` sessions, newest first, with distinct updatedAt values. */
function summaries(count: number, offset = 0): SessionSummary[] {
  return Array.from({ length: count }, (_, index) => {
    const number = offset + index;
    return sessionSummary({
      sessionId: `s-${String(number)}`,
      title: `Session ${String(number)}`,
      updatedAt: 1_700_000_000_000 - number,
      createdAt: 1_700_000_000_000 - number,
    });
  });
}

async function ready(fields: Parameters<typeof openWith>[1] = {}) {
  // The snapshot a test wants is the one this scenario opens with, so the host
  // answers by hand: an auto-answered open would install the default window.
  const scenario = createScenario({ host: { auto: false } });
  await openWith(scenario, fields);
  return scenario;
}

describe("the bounded session directory", () => {
  it("reads one older page and says the loaded range is the whole collection", async () => {
    const scenario = await ready({
      sessions: page(summaries(2), { nextCursor: "c1", hasMore: true }),
    });

    const before = directoryView(scenario.client.getSnapshot().directory, scenario.client.getSnapshot().presentation?.sessions ?? null);
    expect(before.items.map((item) => item.sessionId)).toEqual(["s-0", "s-1"]);
    expect(before.complete).toBe(false);
    expect(before.hasMore).toBe(true);

    const loading = scenario.client.directory.loadOlder();
    await flush();
    // The read asks for one explicit page size and carries the cursor the
    // window published — never an invented one.
    const request = scenario.host.envelopeOf("sessions.list");
    expect(request?.params).toEqual({ cursor: "c1", limit: DIRECTORY_CACHE_LIMITS.listLimit });

    scenario.host.respond(scenario.host.requestIdOf("sessions.list") ?? "", "sessions.list", {
      sessions: page(summaries(2, 2)),
    });
    const step = await loading;
    expect(step).toEqual({ loaded: true, stale: false });

    const snapshot = scenario.client.getSnapshot();
    const view = directoryView(snapshot.directory, snapshot.presentation?.sessions ?? null);
    expect(view.items.map((item) => item.sessionId)).toEqual(["s-0", "s-1", "s-2", "s-3"]);
    expect(view.loadedPages).toBe(1);
    expect(view.complete).toBe(true);
  });

  it("reports nothing more to read without sending a request", async () => {
    const scenario = await ready({ sessions: page(summaries(2)) });

    const step = await scenario.client.directory.loadOlder();
    expect(step).toEqual({ loaded: false, stale: false });
    expect(scenario.host.requests.filter((request) => request.method === "sessions.list")).toHaveLength(0);
  });

  it("keeps the cache inside its profile, dropping the deepest page and continuing from it", async () => {
    const scenario = await ready({
      sessions: page(summaries(50), { nextCursor: "c1", hasMore: true }),
    });

    // One page more than the profile keeps beside the head, every page at the
    // head's own size: the summary bound is reached exactly when the drop is.
    const loads = DIRECTORY_CACHE_LIMITS.maxOlderPages + 1;
    for (let index = 0; index < loads; index += 1) {
      const loading = scenario.client.directory.loadOlder();
      await flush();
      scenario.host.respond(scenario.host.requestIdOf("sessions.list", index) ?? "", "sessions.list", {
        sessions: page(summaries(50, 50 * (index + 1)), { nextCursor: `c${String(index + 2)}`, hasMore: true }),
      });
      await loading;
    }

    const snapshot = scenario.client.getSnapshot();
    const directory = snapshot.directory;
    expect(directory.pages.length).toBeLessThanOrEqual(DIRECTORY_CACHE_LIMITS.maxOlderPages);
    expect(directory.evicted).toBe(true);

    const view = directoryView(directory, snapshot.presentation?.sessions ?? null);
    expect(view.items.length).toBeLessThanOrEqual(DIRECTORY_CACHE_LIMITS.maxSummaries);
    const bytes = directory.pages.reduce((total, entry) => total + entry.bytes, 0);
    expect(bytes).toBeLessThanOrEqual(DIRECTORY_CACHE_LIMITS.maxBytes);

    // The traversal advanced with the page it read, not with the pages the
    // cache kept: the continuation names the page *after* the last one read,
    // so the four pages already read are never read again.
    expect(view.nextCursor).toBe("c5");
    expect(view.complete).toBe(false);
  });

  it("does not file a page cut from another revision of the catalogue", async () => {
    const scenario = await ready({
      sessions: page(summaries(1), { nextCursor: "c1", hasMore: true }),
    });

    const loading = scenario.client.directory.loadOlder();
    await flush();
    scenario.host.respond(scenario.host.requestIdOf("sessions.list") ?? "", "sessions.list", {
      sessions: page(summaries(1, 1), { collectionRevision: 9 }),
    });
    expect(await loading).toEqual({ loaded: false, stale: true });

    const snapshot = scenario.client.getSnapshot();
    expect(snapshot.directory.pages).toHaveLength(0);
    expect(snapshot.directory.stale).toBe(true);
    // A stale traversal refuses to continue instead of reading the retired
    // cursor again.
    expect(await scenario.client.directory.loadOlder()).toEqual({ loaded: false, stale: true });
  });

  it("retires the continuation when the collection revision moves, and re-anchors on a fresh head", async () => {
    const scenario = await ready({
      sessions: page(summaries(1), { nextCursor: "c1", hasMore: true }),
    });

    const loading = scenario.client.directory.loadOlder();
    await flush();
    scenario.host.respond(scenario.host.requestIdOf("sessions.list") ?? "", "sessions.list", {
      sessions: page(summaries(1, 1), { nextCursor: "c2", hasMore: true }),
    });
    await loading;

    // A new session moves the catalogue's revision: the cursor the pages were
    // cut from no longer exists, and continuing it would glue two versions
    // together.
    const created = sessionSummary({ sessionId: "s-new", updatedAt: 1_700_000_100_000 });
    scenario.host.emit({ type: "session.created", session: created, collections: { sessions: 2, runs: 1, plugins: 1 } });
    await flush();
    expect(scenario.client.getSnapshot().directory.stale).toBe(true);

    const refresh = scenario.client.directory.refreshHead();
    await flush();
    scenario.host.respond(scenario.host.requestIdOf("sessions.list", 1) ?? "", "sessions.list", {
      sessions: page([created, ...summaries(1)], { collectionRevision: 2, nextCursor: "n1", hasMore: true }),
    });
    expect(await refresh).toEqual({ loaded: true, stale: false });

    const snapshot = scenario.client.getSnapshot();
    expect(snapshot.directory.stale).toBe(false);
    expect(snapshot.directory.pages).toHaveLength(0);
    expect(snapshot.directory.head?.collectionRevision).toBe(2);
  });

  it("answers a STALE_CURSOR refusal by retiring the traversal, never by retrying it", async () => {
    const scenario = await ready({
      sessions: page(summaries(1), { nextCursor: "c1", hasMore: true }),
    });

    const loading = scenario.client.directory.loadOlder();
    await flush();
    scenario.host.respondError(scenario.host.requestIdOf("sessions.list") ?? "", "STALE_CURSOR");

    expect(await loading).toEqual({ loaded: false, stale: true });
    const snapshot = scenario.client.getSnapshot();
    expect(snapshot.directory.stale).toBe(true);
    expect(directoryView(snapshot.directory, snapshot.presentation?.sessions ?? null).nextCursor).toBeNull();
    // Exactly one list request crossed the wire: the refusal was not retried.
    expect(scenario.host.requests.filter((request) => request.method === "sessions.list")).toHaveLength(1);
  });

  it("files nothing for a page whose traversal a re-cut already replaced", async () => {
    const scenario = await ready({
      sessions: page(summaries(1), { nextCursor: "c1", hasMore: true }),
    });

    const loading = scenario.client.directory.loadOlder();
    await flush();
    const requestId = scenario.host.requestIdOf("sessions.list") ?? "";

    // A re-cut replaces the window the traversal was anchored on. The answer
    // for the old traversal arrives afterwards: it is answered to its caller
    // and changes nothing.
    const resync = scenario.client.resync();
    await flush();
    scenario.host.serveOpen({ sessions: page(summaries(1), { nextCursor: "n1", hasMore: true }) });
    scenario.host.respond(requestId, "sessions.list", { sessions: page(summaries(1, 1)) });
    expect(await loading).toEqual({ loaded: false, stale: false });
    await resync;

    const snapshot = scenario.client.getSnapshot();
    expect(snapshot.directory.pages).toHaveLength(0);
    expect(snapshot.directory.stale).toBe(false);
  });

  it("cannot resurrect a session the connection saw deleted", async () => {
    const scenario = await ready({
      sessions: page(summaries(1), { nextCursor: "c1", hasMore: true }),
    });

    const loading = scenario.client.directory.loadOlder();
    await flush();
    const requestId = scenario.host.requestIdOf("sessions.list") ?? "";

    // The deletion lands while the page is in flight: the page is filtered
    // against what the client knows is gone.
    scenario.host.emit({ type: "session.deleted", sessionId: "s-1", generation: 1 });
    await flush();
    scenario.host.respond(requestId, "sessions.list", { sessions: page(summaries(1, 1)) });
    await loading;

    const snapshot = scenario.client.getSnapshot();
    const view = directoryView(snapshot.directory, snapshot.presentation?.sessions ?? null);
    expect(view.items.map((item) => item.sessionId)).toEqual(["s-0"]);
  });

  it("replaces the copies the loaded pages hold when a session is updated", async () => {
    const scenario = await ready({
      sessions: page(summaries(1), { nextCursor: "c1", hasMore: true }),
    });

    const loading = scenario.client.directory.loadOlder();
    await flush();
    scenario.host.respond(scenario.host.requestIdOf("sessions.list") ?? "", "sessions.list", {
      sessions: page(summaries(1, 1)),
    });
    await loading;

    const renamed = sessionSummary({ sessionId: "s-1", title: "Renamed", metadataRevision: 2 });
    scenario.host.emit({ type: "session.updated", session: renamed });
    await flush();

    const snapshot = scenario.client.getSnapshot();
    const view = directoryView(snapshot.directory, snapshot.presentation?.sessions ?? null);
    expect(view.items.find((item) => item.sessionId === "s-1")?.title).toBe("Renamed");
  });

  it("reports a gap when the live window's bottom moves out from under the loaded pages", async () => {
    const scenario = await ready({
      sessions: page(summaries(50), { nextCursor: "c1", hasMore: true }),
    });

    const loading = scenario.client.directory.loadOlder();
    await flush();
    scenario.host.respond(scenario.host.requestIdOf("sessions.list") ?? "", "sessions.list", {
      sessions: page(summaries(1, 50)),
    });
    await loading;

    // The window's bottom is deleted: the deletion preserves contiguity, and
    // the boundary follows it instead of reporting a gap.
    scenario.host.emit({ type: "session.deleted", sessionId: "s-49", generation: 1 });
    await flush();
    const afterDelete = scenario.client.getSnapshot();
    expect(directoryView(afterDelete.directory, afterDelete.presentation?.sessions ?? null).gap).toBe(false);

    // Updates for sessions outside the window insert at the head and push the
    // window's bottom up: the range between the window and the pages was never
    // read, and that is what the view says.
    for (const number of [1, 2]) {
      scenario.host.emit({
        type: "session.updated",
        session: sessionSummary({ sessionId: `s-deep-${String(number)}`, updatedAt: 1_699_999_999_000 + number }),
      });
      await flush();
    }

    const after = scenario.client.getSnapshot();
    const view = directoryView(after.directory, after.presentation?.sessions ?? null);
    expect(view.gap).toBe(true);
    expect(view.complete).toBe(false);
    // The pages are still shown: a broken boundary is a smaller claim, not a
    // reason to hide what was read.
    expect(view.items.some((item) => item.sessionId === "s-50")).toBe(true);
  });
});

describe("the focused session pin", () => {
  it("seeds from a live-window summary, confirms it, and reads its latest run", async () => {
    const scenario = await ready({ sessions: page([sessionSummary({ sessionId: "s-1" })]) });

    const focusing = scenario.client.directory.focus("s-1");
    await flush();
    // The summary came over the current cut, so it is already this host's
    // fact; the read is what makes it a *read* — the one the pin's authority
    // is recorded from.
    expect(scenario.client.getSnapshot().focusedSession?.confirmed).toBe(true);
    expect(scenario.host.requests.some((request) => request.method === "sessions.get")).toBe(true);

    const confirmed = sessionSummary({ sessionId: "s-1", metadataRevision: 2, committedSeq: 4, historyRevision: 2 });
    scenario.host.respond(scenario.host.requestIdOf("sessions.get") ?? "", "sessions.get", { session: confirmed });
    await flush();

    const pin = scenario.client.getSnapshot().focusedSession;
    expect(pin?.confirmed).toBe(true);
    expect(pin?.summary.metadataRevision).toBe(2);

    // The session points at no run, so the newest one is read through the
    // listing — one page, one item.
    expect(scenario.host.envelopeOf("runs.list")?.params).toEqual({ sessionId: "s-1", limit: 1 });
    scenario.host.respond(scenario.host.requestIdOf("runs.list") ?? "", "runs.list", {
      runs: { items: [completedRun({ runId: "r-1", sessionId: "s-1", submissionId: "sub-1" })], collectionRevision: 1, nextCursor: null, hasMore: false },
    });
    await focusing;

    expect(scenario.client.getSnapshot().focusedSession?.recentRun?.runId).toBe("r-1");
  });

  it("uses an older page's summary as a display seed that does not authorize", async () => {
    const scenario = await ready({
      sessions: page(summaries(1), { nextCursor: "c1", hasMore: true }),
    });
    const loading = scenario.client.directory.loadOlder();
    await flush();
    scenario.host.respond(scenario.host.requestIdOf("sessions.list") ?? "", "sessions.list", {
      sessions: page(summaries(1, 1)),
    });
    await loading;

    const focusing = scenario.client.directory.focus("s-1");
    await flush();
    const seeded = scenario.client.getSnapshot().focusedSession;
    // The summary came from a page, so it is shown and not stood behind.
    expect(seeded?.summary.sessionId).toBe("s-1");
    expect(seeded?.confirmed).toBe(false);

    scenario.host.respond(scenario.host.requestIdOf("sessions.get") ?? "", "sessions.get", {
      session: sessionSummary({ sessionId: "s-1" }),
    });
    await flush();
    expect(scenario.client.getSnapshot().focusedSession?.confirmed).toBe(true);
    scenario.host.respond(scenario.host.requestIdOf("runs.list") ?? "", "runs.list", {
      runs: { items: [], collectionRevision: 1, nextCursor: null, hasMore: false },
    });
    await focusing;
  });

  it("clears the pin when the host says the session is not there", async () => {
    const scenario = await ready({ sessions: page([sessionSummary({ sessionId: "s-1" })]) });

    const focusing = scenario.client.directory.focus("s-1");
    await flush();
    scenario.host.respondError(scenario.host.requestIdOf("sessions.get") ?? "", "SESSION_NOT_FOUND");

    await expect(focusing).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
    expect(scenario.client.getSnapshot().focusedSession).toBeNull();
  });

  it("keeps a later selection when an earlier focus answer arrives late", async () => {
    const scenario = await ready({
      sessions: page([sessionSummary({ sessionId: "s-1" }), sessionSummary({ sessionId: "s-2", updatedAt: 1_699_999_999_000 })]),
    });

    const first = scenario.client.directory.focus("s-1");
    await flush();
    const firstRequest = scenario.host.requestIdOf("sessions.get") ?? "";

    const second = scenario.client.directory.focus("s-2");
    await flush();
    const secondRequest = scenario.host.requestIdOf("sessions.get", 1) ?? "";

    scenario.host.respond(secondRequest, "sessions.get", { session: sessionSummary({ sessionId: "s-2" }) });
    await flush();
    scenario.host.respond(firstRequest, "sessions.get", { session: sessionSummary({ sessionId: "s-1" }) });
    await flush();

    // The earlier answer belongs to a focus the reader has left: it is inert.
    expect(scenario.client.getSnapshot().focusedSession?.sessionId).toBe("s-2");
    void first;
    void second;
  });

  it("does not walk the pin's facts backwards when a late read answers", async () => {
    const scenario = await ready({ sessions: page([sessionSummary({ sessionId: "s-1" })]) });

    const focusing = scenario.client.directory.focus("s-1");
    await flush();
    const requestId = scenario.host.requestIdOf("sessions.get") ?? "";

    // The session moves while the read is in flight: the answer describes the
    // session as it was, and revisions only move forward.
    scenario.host.emit({
      type: "session.updated",
      session: sessionSummary({ sessionId: "s-1", metadataRevision: 5, committedSeq: 8, historyRevision: 4 }),
    });
    await flush();
    scenario.host.respond(requestId, "sessions.get", {
      session: sessionSummary({ sessionId: "s-1", metadataRevision: 2, committedSeq: 1 }),
    });
    await flush();

    const pin = scenario.client.getSnapshot().focusedSession;
    expect(pin?.confirmed).toBe(true);
    expect(pin?.summary.metadataRevision).toBe(5);
    expect(pin?.summary.committedSeq).toBe(8);
    scenario.host.respond(scenario.host.requestIdOf("runs.list") ?? "", "runs.list", {
      runs: { items: [], collectionRevision: 1, nextCursor: null, hasMore: false },
    });
    await focusing;
  });

  it("reads the active run by identity when the session points at one", async () => {
    const scenario = await ready({
      sessions: page([sessionSummary({ sessionId: "s-1", activeRunId: "r-active" })]),
      // A snapshot that points at an active run carries it: the pointer and the
      // run are one fact.
      runs: {
        items: [runningRun({ runId: "r-active", sessionId: "s-1", submissionId: "sub-active" })],
        collectionRevision: 1,
        nextCursor: null,
        hasMore: false,
      },
    });

    const focusing = scenario.client.directory.focus("s-1");
    await flush();
    scenario.host.respond(scenario.host.requestIdOf("sessions.get") ?? "", "sessions.get", {
      session: sessionSummary({ sessionId: "s-1", activeRunId: "r-active" }),
    });
    await flush();

    expect(scenario.host.envelopeOf("runs.get")?.params).toEqual({ runId: "r-active" });
    // The cut also re-read that run's live timeline, so both reads are answered
    // with the same host fact.
    for (const index of [0, 1]) {
      const requestId = scenario.host.requestIdOf("runs.get", index);
      if (requestId !== undefined) {
        scenario.host.respond(requestId, "runs.get", {
          run: runningRun({ runId: "r-active", sessionId: "s-1", submissionId: "sub-active" }),
        });
      }
    }
    await focusing;

    // The pin holds a summary, never the timeline: the draft belongs to the
    // live replica.
    expect(scenario.client.getSnapshot().focusedSession?.recentRun?.runId).toBe("r-active");
    expect(scenario.client.getSnapshot().focusedSession?.recentRun?.status).toBe("running");
  });

  it("keeps the run's stage when a read answers behind an event", async () => {
    const scenario = await ready({
      sessions: page([sessionSummary({ sessionId: "s-1", activeRunId: "r-active" })]),
      runs: {
        items: [runningRun({ runId: "r-active", sessionId: "s-1", submissionId: "sub-active" })],
        collectionRevision: 1,
        nextCursor: null,
        hasMore: false,
      },
    });

    const focusing = scenario.client.directory.focus("s-1");
    await flush();
    scenario.host.respond(scenario.host.requestIdOf("sessions.get") ?? "", "sessions.get", {
      session: sessionSummary({ sessionId: "s-1", activeRunId: "r-active" }),
    });
    await flush();
    const runRequest = scenario.host.requestIdOf("runs.get", 1) ?? "";

    // The run settles before the read answers: a stage never un-runs, so the
    // older reading loses to the event.
    const ended = completedRun({ runId: "r-active", sessionId: "s-1", submissionId: "sub-active" });
    scenario.host.emit({ type: "run.ended", run: ended, session: sessionSummary({ sessionId: "s-1" }) });
    await flush();
    scenario.host.respond(runRequest, "runs.get", {
      run: runningRun({ runId: "r-active", sessionId: "s-1", submissionId: "sub-active" }),
    });
    await flush();

    expect(scenario.client.getSnapshot().focusedSession?.recentRun?.status).toBe("completed");
    await focusing;
  });

  it("loses its authority across a re-cut and is dropped for another host instance", async () => {
    const scenario = createScenario({
      makeHost: (index) => createFakeHost({ hostInstanceId: index === 0 ? "host-1" : "host-2", auto: false }),
    });
    await openWith(scenario, { sessions: page([sessionSummary({ sessionId: "s-1" })]) });

    const focusing = scenario.client.directory.focus("s-1");
    await flush();
    scenario.host.respond(scenario.host.requestIdOf("sessions.get") ?? "", "sessions.get", { session: sessionSummary({ sessionId: "s-1" }) });
    await flush();
    scenario.host.respond(scenario.host.requestIdOf("runs.list") ?? "", "runs.list", {
      runs: { items: [], collectionRevision: 1, nextCursor: null, hasMore: false },
    });
    await focusing;
    expect(scenario.client.getSnapshot().focusedSession?.confirmed).toBe(true);

    // An ordinary re-cut on the same host keeps the facts and drops the
    // authority: the read that confirmed them belonged to the old stream.
    const resync = scenario.client.resync();
    await flush();
    scenario.host.serveOpen({ sessions: page([sessionSummary({ sessionId: "s-1" })]) });
    await resync;
    expect(scenario.client.getSnapshot().focusedSession?.sessionId).toBe("s-1");
    expect(scenario.client.getSnapshot().focusedSession?.confirmed).toBe(false);

    // Another host instance is another process: nothing this client held about
    // the first one is a fact about it.
    const reconnecting = scenario.client.reconnect();
    await flush();
    scenario.host.serveDescribe();
    await flush();
    scenario.host.serveOpen({ sessions: page([]) });
    await reconnecting;
    expect(scenario.client.getSnapshot().focusedSession).toBeNull();
    expect(scenario.client.getSnapshot().directory.hostInstanceId).toBe("host-2");
  });

  it("keeps the connection for a run whose session the directory does not hold", async () => {
    const scenario = await ready({ sessions: page(summaries(1)) });

    // A run for a session outside this client's bounded window: the host is
    // allowed to publish it, and the directory simply cannot place it.
    scenario.host.emit({
      type: "run.updated",
      run: activeRun({ runId: "r-elsewhere", sessionId: "s-elsewhere", submissionId: "sub-elsewhere" }),
    });
    await flush();

    const snapshot = scenario.client.getSnapshot();
    expect(snapshot.status).toBe("ready");
    expect(snapshot.error).toBeNull();
    expect(snapshot.presentation?.runs.items.some((run) => run.runId === "r-elsewhere")).toBe(false);

    // The position moved with it: the next event on the stream still applies.
    scenario.host.emit({ type: "session.created", session: sessionSummary({ sessionId: "s-later" }) });
    await flush();
    const after = scenario.client.getSnapshot();
    expect(after.status).toBe("ready");
    expect(after.presentation?.sessions.items.some((session) => session.sessionId === "s-later")).toBe(true);
  });

  it("keeps walking past everything the cache can hold, without ever reading a page twice", async () => {
    // Six pages of the collection and a cache that holds three of them beside
    // the window: the traversal has to keep moving after the cache fills up,
    // and the sessions it walks past have to stay reachable.
    const pageSize = DIRECTORY_CACHE_LIMITS.listLimit;
    const total = pageSize * 6;
    const collection = summaries(total);
    const pageOf = (index: number): { readonly items: readonly SessionSummary[]; readonly nextCursor: string | null; readonly hasMore: boolean } => {
      const from = index * pageSize;
      const items = collection.slice(from, from + pageSize);
      const more = from + pageSize < total;
      return { items, nextCursor: more ? `c${String(index + 1)}` : null, hasMore: more };
    };

    const scenario = await ready({
      sessions: {
        items: collection.slice(0, pageSize),
        collectionRevision: 1,
        nextCursor: "c1",
        hasMore: true,
      },
    });

    const requested: (string | undefined)[] = [];
    const seen = new Set<string>();
    let loads = 0;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const before = scenario.client.getSnapshot();
      const view = directoryView(before.directory, before.presentation?.sessions ?? null);
      if (view.complete) break;
      if (view.nextCursor === null) break;

      const loading = scenario.client.directory.loadOlder();
      await flush();
      const envelope = scenario.host.envelopeOf("sessions.list", loads);
      const params = envelope === undefined ? undefined : (envelope.params as { readonly cursor?: string } | null);
      const cursor = params === null || params === undefined ? undefined : params.cursor;
      requested.push(cursor);
      // Every read asks for a page the traversal has not visited: a cursor
      // that comes back a second time is the traversal standing still.
      expect(cursor).toBeDefined();
      expect(seen.has(String(cursor)), "the traversal must never ask for a page it has already read").toBe(false);
      seen.add(String(cursor));

      const index = Number(String(cursor).slice(1));
      const next = pageOf(index);
      scenario.host.respond(scenario.host.requestIdOf("sessions.list", loads) ?? "", "sessions.list", {
        sessions: {
          items: next.items,
          collectionRevision: 1,
          nextCursor: next.nextCursor,
          hasMore: next.hasMore,
        },
      });
      await loading;
      loads += 1;

      // The cache stayed inside its profile at every step.
      const after = scenario.client.getSnapshot();
      expect(after.directory.pages.length).toBeLessThanOrEqual(DIRECTORY_CACHE_LIMITS.maxOlderPages);
      const summariesHeld = after.directory.pages.reduce((count, page) => count + page.items.length, 0);
      expect(summariesHeld).toBeLessThanOrEqual(DIRECTORY_CACHE_LIMITS.maxSummaries);
      const bytesHeld = after.directory.pages.reduce((count, page) => count + page.bytes, 0);
      expect(bytesHeld).toBeLessThanOrEqual(DIRECTORY_CACHE_LIMITS.maxBytes);
    }

    // The traversal reached the end of the collection: six reads, one per page,
    // none of them repeated.
    expect(requested).toEqual(["c1", "c2", "c3", "c4", "c5"]);
    const finished = scenario.client.getSnapshot();
    const view = directoryView(finished.directory, finished.presentation?.sessions ?? null);
    expect(view.nextCursor).toBeNull();
    expect(view.hasMore).toBe(false);
    // …and it is honest about what it dropped: the range between the window and
    // the pages it still holds is a gap, so the loaded range is not complete.
    expect(finished.directory.evicted).toBe(true);
    expect(view.gap).toBe(true);
    expect(view.complete).toBe(false);

    // The older sessions really are reachable: the deepest pages the traversal
    // read are the ones retained, and they are the ones a reader can select.
    expect(
      view.items.some((session) => session.sessionId === `s-${String(total - 1)}`),
      "the traversal must reach the oldest session the collection holds",
    ).toBe(true);
    expect(view.items.some((session) => session.sessionId === `s-${String(total - 2)}`)).toBe(true);
    // And the sessions the cache dropped were older than what it kept, never
    // the ones just read.
    expect(view.items.some((session) => session.sessionId === `s-${String(pageSize)}`)).toBe(false);
  });

  it("continues from the traversal position even when the page that produced it was dropped", async () => {
    // The same shape, checked at the state level: the cursor that follows a
    // page survives that page being evicted a moment later.
    const first = await ready({
      sessions: page(summaries(2), { nextCursor: "c1", hasMore: true }),
    });
    const loading = first.client.directory.loadOlder();
    await flush();
    first.host.respond(first.host.requestIdOf("sessions.list") ?? "", "sessions.list", {
      sessions: page(summaries(50, 2), { nextCursor: "c2", hasMore: true }),
    });
    await loading;

    const state = first.client.getSnapshot().directory;
    // Whatever is retained, the traversal knows where it is.
    expect(directoryContinuation(state)).toEqual({ cursor: "c2", hasMore: true });
    const retained = state.pages[state.pages.length - 1];
    expect(retained?.nextCursor).toBe("c2");
  });
});

describe("run facts beyond the session window", () => {
  it("tracks a run started for a focused session the window does not hold", async () => {
    // The session is reachable only through an older page, so the directory
    // window does not hold it — the pin does. Its run is this client's fact.
    const scenario = await ready({
      sessions: page(summaries(1), { nextCursor: "c1", hasMore: true }),
    });
    const loading = scenario.client.directory.loadOlder();
    await flush();
    scenario.host.respond(scenario.host.requestIdOf("sessions.list") ?? "", "sessions.list", {
      sessions: page(summaries(1, 1)),
    });
    await loading;

    const focusing = scenario.client.directory.focus("s-1");
    await flush();
    scenario.host.respond(scenario.host.requestIdOf("sessions.get") ?? "", "sessions.get", {
      session: sessionSummary({ sessionId: "s-1" }),
    });
    await flush();
    scenario.host.respond(scenario.host.requestIdOf("runs.list") ?? "", "runs.list", {
      runs: { items: [], collectionRevision: 1, nextCursor: null, hasMore: false },
    });
    await focusing;

    // The run's acceptance arrives while the session sits outside the window.
    scenario.host.emit({
      type: "run.updated",
      run: acceptedRun({ runId: "r-old", sessionId: "s-1", submissionId: "sub-old" }),
    });
    await flush();

    const snapshot = scenario.client.getSnapshot();
    // The connection is untouched, the run is filed where run summaries live,
    // the live draft exists, and the pin says the session is executing it.
    expect(snapshot.status).toBe("ready");
    expect(snapshot.presentation?.runs.items.some((run) => run.runId === "r-old")).toBe(true);
    expect(snapshot.live["r-old"]?.status).toBe("accepted");
    expect(snapshot.focusedSession?.summary.activeRunId).toBe("r-old");
    expect(snapshot.focusedSession?.recentRun?.runId).toBe("r-old");

    // It runs, and the timeline it publishes is placed: the run is observable.
    scenario.host.emit({
      type: "run.updated",
      run: runningRun({ runId: "r-old", sessionId: "s-1", submissionId: "sub-old" }),
    });
    scenario.host.emit({ type: "run.output.delta", sessionId: "s-1", runId: "r-old", itemId: "i-1", text: "hi" });
    await flush();
    expect(scenario.client.getSnapshot().live["r-old"]?.live[0]).toMatchObject({ kind: "text", text: "hi" });

    // And it settles: the terminal is applied, the draft is gone, and the pin's
    // pointer is cleared — none of which needed the session to be in a window.
    scenario.host.emit({
      type: "run.ended",
      run: completedRun({ runId: "r-old", sessionId: "s-1", submissionId: "sub-old" }),
      session: sessionSummary({ sessionId: "s-1", committedSeq: 4, historyRevision: 1 }),
    });
    await flush();

    const after = scenario.client.getSnapshot();
    expect(after.status).toBe("ready");
    expect(after.presentation?.runs.items.find((run) => run.runId === "r-old")?.status).toBe("completed");
    expect(after.live["r-old"], "a settled run's draft is gone").toBeUndefined();
    expect(after.focusedSession?.summary.activeRunId).toBeNull();
    expect(after.focusedSession?.recentRun?.status).toBe("completed");
  });

  it("applies the terminal of a known running run after its session leaves the window", async () => {
    // A window at its bound with the running session at its oldest end: one new
    // session pushes it out, and the run it was executing still has to settle.
    const oldest = sessionSummary({ sessionId: "s-running", updatedAt: 1_690_000_000_000, activeRunId: "r-1" });
    const others = summaries(49).map((session, index) =>
      sessionSummary({
        sessionId: session.sessionId,
        updatedAt: 1_699_999_000_000 - index,
      }),
    );
    const scenario = await ready({
      sessions: page([...others, oldest]),
      runs: {
        items: [runningRun({ runId: "r-1", sessionId: "s-running", submissionId: "sub-1" })],
        collectionRevision: 1,
        nextCursor: null,
        hasMore: false,
      },
    });

    // The live timeline is placed for the running run while its session is held
    // (the cut names the active run, and the client reads its timeline).
    await flush();
    scenario.host.respond(scenario.host.requestIdOf("runs.get") ?? "", "runs.get", {
      run: runningRun({ runId: "r-1", sessionId: "s-running", submissionId: "sub-1" }),
    });
    await flush();
    expect(scenario.client.getSnapshot().live["r-1"]).toBeDefined();
    const before = scenario.client.getSnapshot();
    expect(before.presentation?.sessions.items.some((session) => session.sessionId === "s-running")).toBe(true);

    // A newer session arrives and the running one falls out of the window.
    scenario.host.emit({
      type: "session.created",
      session: sessionSummary({ sessionId: "s-newest", updatedAt: 1_700_000_000_000 }),
    });
    await flush();
    const evicted = scenario.client.getSnapshot();
    expect(evicted.presentation?.sessions.items.some((session) => session.sessionId === "s-running")).toBe(false);
    expect(evicted.live["r-1"]).toBeDefined();

    // The terminal still lands: identity and stage are checked, the run window
    // gets the outcome, and the draft goes.
    scenario.host.emit({
      type: "run.ended",
      run: completedRun({ runId: "r-1", sessionId: "s-running", submissionId: "sub-1" }),
      session: sessionSummary({ sessionId: "s-running", committedSeq: 6, historyRevision: 2 }),
    });
    await flush();

    const after = scenario.client.getSnapshot();
    expect(after.status, "a run fact beyond the window is not a protocol fault").toBe("ready");
    const settled = after.presentation?.runs.items.find((run) => run.runId === "r-1");
    expect(settled?.status).toBe("completed");
    expect(after.live["r-1"]).toBeUndefined();

    // A run this client has never heard of, for a session it does not hold, is
    // still dropped rather than invented into place.
    scenario.host.emit({
      type: "run.updated",
      run: acceptedRun({ runId: "r-stranger", sessionId: "s-stranger", submissionId: "sub-stranger" }),
    });
    await flush();
    const stranger = scenario.client.getSnapshot();
    expect(stranger.status).toBe("ready");
    expect(
      stranger.presentation?.runs.items.some((run) => run.runId === "r-stranger"),
      "a run this client has never known is not invented into the directory",
    ).toBe(false);
  });

  /** A client whose only way to `s-1` is the pin: the session is below the window. */
  async function pinnedBeyondWindow() {
    const scenario = await ready({
      sessions: page(summaries(1), { nextCursor: "c1", hasMore: true }),
    });
    const loading = scenario.client.directory.loadOlder();
    await flush();
    scenario.host.respond(scenario.host.requestIdOf("sessions.list") ?? "", "sessions.list", {
      sessions: page(summaries(1, 1)),
    });
    await loading;

    const focusing = scenario.client.directory.focus("s-1");
    await flush();
    scenario.host.respond(scenario.host.requestIdOf("sessions.get") ?? "", "sessions.get", {
      session: sessionSummary({ sessionId: "s-1" }),
    });
    await flush();
    scenario.host.respond(scenario.host.requestIdOf("runs.list") ?? "", "runs.list", {
      runs: { items: [], collectionRevision: 1, nextCursor: null, hasMore: false },
    });
    await focusing;
    return scenario;
  }

  it("refuses a second active run for a session the window does not hold", async () => {
    const scenario = await pinnedBeyondWindow();

    scenario.host.emit({
      type: "run.updated",
      run: acceptedRun({ runId: "r-a", sessionId: "s-1", submissionId: "sub-a" }),
    });
    await flush();
    const one = scenario.client.getSnapshot();
    expect(one.status).toBe("ready");
    expect(one.presentation?.runs.items.some((run) => run.runId === "r-a")).toBe(true);
    expect(one.live["r-a"]?.status).toBe("accepted");

    // A second acceptance for the same session while the first is still active:
    // the one-active-run rule the window path reads off the session's pointer
    // does not stop at the window's edge.
    scenario.host.emit({
      type: "run.updated",
      run: acceptedRun({ runId: "r-b", sessionId: "s-1", submissionId: "sub-b" }),
    });
    await flush();

    const after = scenario.client.getSnapshot();
    expect(after.status, "two active runs for one session are refused").toBe("protocol-error");
    expect(after.error?.reason).toBe("invalid-event");
    // The refusal is whole: the second run entered neither the run window nor
    // the live replica, and the first never left them.
    expect(after.presentation?.runs.items.some((run) => run.runId === "r-b")).toBe(false);
    expect(after.live["r-b"], "the refused run was never made live truth").toBeUndefined();
    expect(after.live["r-a"]?.status).toBe("accepted");
    expect(after.focusedSession?.summary.activeRunId).toBe("r-a");
  });

  /**
   * A client that holds a running run and then loses it from both bounded
   * windows: the session leaves the session window and fifty later runs push
   * the summary out of the run window, while the live draft remains the copy
   * the replica stands behind.
   */
  async function knownRunBeyondBothWindows() {
    const oldest = sessionSummary({ sessionId: "s-running", updatedAt: 1_690_000_000_000, activeRunId: "r-1" });
    const others = summaries(49).map((session, index) =>
      sessionSummary({ sessionId: session.sessionId, updatedAt: 1_699_999_000_000 - index }),
    );
    const scenario = await ready({
      sessions: page([...others, oldest]),
      runs: {
        items: [runningRun({ runId: "r-1", sessionId: "s-running", submissionId: "sub-1" })],
        collectionRevision: 1,
        nextCursor: null,
        hasMore: false,
      },
    });
    await flush();
    scenario.host.respond(scenario.host.requestIdOf("runs.get") ?? "", "runs.get", {
      run: runningRun({ runId: "r-1", sessionId: "s-running", submissionId: "sub-1" }),
    });
    await flush();
    expect(scenario.client.getSnapshot().live["r-1"]).toBeDefined();

    // The draft carries content: what the replica has already been shown is
    // what a later publication cannot take away.
    scenario.host.emit({ type: "run.output.delta", sessionId: "s-running", runId: "r-1", itemId: "t-1", text: "hello" });
    await flush();
    expect(scenario.client.getSnapshot().live["r-1"]?.live).toHaveLength(1);

    // The session leaves the session window...
    scenario.host.emit({
      type: "session.created",
      session: sessionSummary({ sessionId: "s-newest", updatedAt: 1_700_000_000_000 }),
    });
    await flush();
    // ...and fifty later runs push the run summary out of the run window.
    for (const [index, session] of [...others, sessionSummary({ sessionId: "s-newest" })].entries()) {
      scenario.host.emit({
        type: "run.updated",
        run: acceptedRun({
          runId: `r-fill-${String(index)}`,
          sessionId: session.sessionId,
          submissionId: `sub-fill-${String(index)}`,
        }),
      });
    }
    await flush();

    const held = scenario.client.getSnapshot();
    expect(held.status).toBe("ready");
    expect(held.presentation?.sessions.items.some((session) => session.sessionId === "s-running")).toBe(false);
    expect(
      held.presentation?.runs.items.some((run) => run.runId === "r-1"),
      "the run summary left the bounded run window too",
    ).toBe(false);
    expect(held.live["r-1"], "the draft is the copy that remains").toBeDefined();
    return scenario;
  }

  it("refuses a live publication the held draft refuses, inside the window and after both windows dropped it", async () => {
    // The same violation, twice: a run.updated whose timeline *shrinks* below
    // what the replica was already shown. Inside the windows the live fold
    // refuses it at once.
    const inside = await ready({ sessions: page([sessionSummary({ sessionId: "s-1" })]) });
    inside.host.emit({ type: "run.updated", run: acceptedRun({ runId: "r-1", sessionId: "s-1", submissionId: "sub-1" }) });
    inside.host.emit({ type: "run.updated", run: runningRun({ runId: "r-1", sessionId: "s-1", submissionId: "sub-1" }) });
    inside.host.emit({ type: "run.output.delta", sessionId: "s-1", runId: "r-1", itemId: "t-1", text: "hello" });
    await flush();
    expect(inside.client.getSnapshot().live["r-1"]?.live, "the draft carries the content it was shown").toHaveLength(1);

    inside.host.emit({
      type: "run.updated",
      run: runningRun({ runId: "r-1", sessionId: "s-1", submissionId: "sub-1", live: [] }),
    });
    await flush();
    const refusedInside = inside.client.getSnapshot();
    expect(refusedInside.status, "a draft the peer already published cannot shrink").toBe("protocol-error");
    expect(refusedInside.error?.reason).toBe("run-identity");

    // Now the reviewer's counterexample: the very same publication, the same
    // held draft — but the session and the run summary have both left their
    // bounded windows. Window membership is presentation, never authority.
    const outside = await knownRunBeyondBothWindows();
    const before = outside.client.getSnapshot();
    expect(before.live["r-1"]?.live, "the draft still carries its content").toHaveLength(1);
    expect(before.presentation?.runs.items.some((run) => run.runId === "r-1")).toBe(false);
    const watermarkBefore = before.presentation?.watermark;

    outside.host.emit({
      type: "run.updated",
      run: runningRun({ runId: "r-1", sessionId: "s-running", submissionId: "sub-1", live: [] }),
    });
    await flush();

    const after = outside.client.getSnapshot();
    expect(after.status, "an eviction is not a licence to rewrite a run's timeline").toBe("protocol-error");
    expect(after.error?.reason, "the same violation, the same reason").toBe("run-identity");
    // Nothing was applied: no position moved, no summary was filed, and the
    // draft the replica holds is exactly what it held.
    expect(after.presentation?.watermark).toEqual(watermarkBefore);
    expect(after.presentation?.runs.items.map((run) => run.runId)).toEqual(
      before.presentation?.runs.items.map((run) => run.runId),
    );
    expect(
      after.presentation?.runs.items.some((run) => run.runId === "r-1"),
      "the refused run did not re-enter the window",
    ).toBe(false);
    expect(after.live["r-1"]?.live).toHaveLength(1);
    expect(after.live["r-1"]?.liveTruncated).toBe(false);

    // And with the same eviction, a publication the replica *can* follow still
    // lands: the refusal above is about the contradiction, not about the window.
    const settles = await knownRunBeyondBothWindows();
    settles.host.emit({
      type: "run.ended",
      run: completedRun({ runId: "r-1", sessionId: "s-running", submissionId: "sub-1" }),
      session: sessionSummary({ sessionId: "s-running", committedSeq: 6, historyRevision: 2 }),
    });
    await flush();
    const settled = settles.client.getSnapshot();
    expect(settled.status).toBe("ready");
    expect(settled.live["r-1"], "a settled run has no draft").toBeUndefined();
    expect(settled.presentation?.runs.items.find((run) => run.runId === "r-1")?.status).toBe("completed");
  });

  it("still tolerates a publication for a known run the live replica holds no draft for", async () => {
    // The case the tolerance exists for: a run this client knows — the pin read
    // the session, and the run summary is filed — but for which no draft was
    // ever placed, in a session outside the window. Nothing is contradicted, so
    // the frame is filed and no draft is invented; the fix above must not turn
    // this into a fault.
    const scenario = await pinnedBeyondWindow();
    const publication = {
      type: "run.updated" as const,
      run: runningRun({ runId: "r-known", sessionId: "s-1", submissionId: "sub-known" }),
    };

    scenario.host.emit(publication);
    await flush();
    const first = scenario.client.getSnapshot();
    expect(first.status, "a fact with nothing to contradict is not a fault").toBe("ready");
    expect(first.live["r-known"], "no draft is invented for a run nobody published as live").toBeUndefined();
    expect(first.presentation?.runs.items.find((run) => run.runId === "r-known")?.status).toBe("running");

    // The same publication again, now that the run summary is one the replica
    // holds: still no draft to contradict, still placed, still not a fault.
    scenario.host.emit(publication);
    await flush();
    const after = scenario.client.getSnapshot();
    expect(after.status).toBe("ready");
    expect(after.live["r-known"]).toBeUndefined();
    expect(after.focusedSession?.recentRun?.runId).toBe("r-known");
    expect(Object.keys(after.live), "the live replica stays bounded").toEqual([]);
    expect(after.presentation?.runs.items.length).toBeLessThanOrEqual(50);
  });

  it("refuses a terminal whose identity the held run never had, after both windows dropped it", async () => {
    const scenario = await knownRunBeyondBothWindows();

    scenario.host.emit({
      type: "run.ended",
      run: completedRun({ runId: "r-1", sessionId: "s-running", submissionId: "sub-someone-else" }),
      session: sessionSummary({ sessionId: "s-running", committedSeq: 6, historyRevision: 2 }),
    });
    await flush();

    const after = scenario.client.getSnapshot();
    expect(after.status, "an eviction is not a licence to rewrite a run").toBe("protocol-error");
    expect(after.error?.reason).toBe("run-identity");
  });

  it("refuses a run publication that would move the held run's stage backwards", async () => {
    const scenario = await knownRunBeyondBothWindows();

    // Running back to accepted: the one stage move the state machine forbids.
    scenario.host.emit({
      type: "run.updated",
      run: acceptedRun({ runId: "r-1", sessionId: "s-running", submissionId: "sub-1" }),
    });
    await flush();

    const after = scenario.client.getSnapshot();
    expect(after.status, "an eviction is not a licence to un-run a run").toBe("protocol-error");
    expect(after.error?.reason).toBe("invalid-event");
    expect(after.live["r-1"]?.status, "the draft keeps the stage it was given").toBe("running");
  });

  it("settles a known run after both windows dropped it, and retires what it was holding", async () => {
    const scenario = await pinnedBeyondWindow();

    // A run for the pinned session, accepted and running while the session sits
    // below the window.
    scenario.host.emit({
      type: "run.updated",
      run: acceptedRun({ runId: "r-pinned", sessionId: "s-1", submissionId: "sub-pinned" }),
    });
    await flush();
    scenario.host.emit({
      type: "run.updated",
      run: runningRun({ runId: "r-pinned", sessionId: "s-1", submissionId: "sub-pinned" }),
    });
    await flush();
    expect(scenario.client.getSnapshot().focusedSession?.summary.activeRunId).toBe("r-pinned");

    // Fifty finished runs of the session the window does hold push the pinned
    // run's summary out of the bounded run window.
    for (let index = 0; index < 50; index += 1) {
      const runId = `r-fill-${String(index)}`;
      const submissionId = `sub-fill-${String(index)}`;
      scenario.host.emit({ type: "run.updated", run: acceptedRun({ runId, sessionId: "s-0", submissionId }) });
      scenario.host.emit({ type: "run.updated", run: runningRun({ runId, sessionId: "s-0", submissionId }) });
      scenario.host.emit({
        type: "run.ended",
        run: completedRun({ runId, sessionId: "s-0", submissionId }),
        session: sessionSummary({ sessionId: "s-0", committedSeq: index + 1, historyRevision: index + 1 }),
      });
    }
    await flush();
    const before = scenario.client.getSnapshot();
    expect(before.status).toBe("ready");
    expect(
      before.presentation?.runs.items.some((run) => run.runId === "r-pinned"),
      "the pinned run's summary left the run window",
    ).toBe(false);
    expect(before.live["r-pinned"]?.status).toBe("running");

    // The terminal is checked against what the replica holds, settles the run,
    // retires the draft, and moves the pin's own facts — none of which needed
    // either bounded window.
    scenario.host.emit({
      type: "run.ended",
      run: completedRun({ runId: "r-pinned", sessionId: "s-1", submissionId: "sub-pinned" }),
      session: sessionSummary({ sessionId: "s-1", committedSeq: 4, historyRevision: 1 }),
    });
    await flush();

    const after = scenario.client.getSnapshot();
    expect(after.status).toBe("ready");
    expect(after.live["r-pinned"], "a settled run has no draft").toBeUndefined();
    expect(after.focusedSession?.summary.activeRunId, "the pin stops pointing at a settled run").toBeNull();
    expect(after.focusedSession?.recentRun?.status).toBe("completed");
    expect(
      after.presentation?.runs.items.find((run) => run.runId === "r-pinned")?.status,
      "the terminal is filed where run summaries live",
    ).toBe("completed");
    expect(after.presentation?.runs.items.length).toBeLessThanOrEqual(50);
  });

  it("lets no unknown out-of-window run grow the replica, however many arrive", async () => {
    const scenario = await ready({ sessions: page(summaries(1)) });
    const identityOf = (snapshot: ReturnType<typeof scenario.client.getSnapshot>): string =>
      JSON.stringify({
        sessions: snapshot.presentation?.sessions.items.map((session) => session.sessionId) ?? [],
        runs: snapshot.presentation?.runs.items.map((run) => run.runId) ?? [],
        live: Object.keys(snapshot.live).sort(),
      });
    const baseline = identityOf(scenario.client.getSnapshot());

    // A run the client has never been told about, in a session no window holds:
    // a deterministic spread of ids, one event each.
    let seed = 7;
    const next = (bound: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % bound;
    };
    const statuses = ["accepted", "running", "completed"] as const;
    for (let index = 0; index < 200; index += 1) {
      const runId = `r-unknown-${String(index)}`;
      const sessionId = `s-unknown-${String(next(20))}`;
      const submissionId = `sub-unknown-${String(index)}`;
      const status = statuses[next(statuses.length)] ?? "accepted";
      if (status === "completed") {
        scenario.host.emit({
          type: "run.ended",
          run: completedRun({ runId, sessionId, submissionId }),
          session: sessionSummary({ sessionId }),
        });
      } else {
        scenario.host.emit({
          type: "run.updated",
          run:
            status === "accepted"
              ? acceptedRun({ runId, sessionId, submissionId })
              : runningRun({ runId, sessionId, submissionId }),
        });
      }
    }
    await flush();

    const after = scenario.client.getSnapshot();
    expect(after.status, "a stranger's run is dropped, not a fault").toBe("ready");
    expect(identityOf(after), "nothing about an unknown run was kept").toBe(baseline);
    expect(Object.keys(after.live), "no draft is invented for a run nobody announced").toEqual([]);
    expect(after.presentation?.runs.items.length).toBeLessThanOrEqual(50);
    expect(after.presentation?.sessions.items.length).toBeLessThanOrEqual(50);
  });
});

describe("late directory answers", () => {
  it("discards a head read that a collection invalidation overtook", async () => {
    const scenario = await ready({
      sessions: page(summaries(1), { nextCursor: "c1", hasMore: true }),
    });
    const loading = scenario.client.directory.loadOlder();
    await flush();
    scenario.host.respond(scenario.host.requestIdOf("sessions.list") ?? "", "sessions.list", {
      sessions: page(summaries(1, 1), { nextCursor: "c2", hasMore: true }),
    });
    await loading;

    // A head read is asked for, answered, and only *then* does the catalogue
    // move — the ordering the frame path makes possible, with no waiting
    // anywhere: the answer resolves the caller's promise, and the invalidation
    // is folded before the caller's continuation runs.
    const refreshing = scenario.client.directory.refreshHead();
    await flush();
    const requestId = scenario.host.requestIdOf("sessions.list", 1) ?? "";
    scenario.host.respond(requestId, "sessions.list", {
      sessions: page(summaries(2), { collectionRevision: 2, nextCursor: "n1", hasMore: true }),
    });
    scenario.host.emit({
      type: "collection.invalidated",
      collections: { sessions: 3, runs: 1, plugins: 1 },
    });

    expect(await refreshing, "a head read the catalogue overtook is discarded").toEqual({ loaded: false, stale: true });
    const state = scenario.client.getSnapshot();
    // No re-anchor happened: the head of another revision was never installed,
    // and the traversal is still the retired one.
    expect(state.directory.head).toBeNull();
    expect(state.directory.stale).toBe(true);
    const view = directoryView(state.directory, state.presentation?.sessions ?? null);
    expect(view.complete).toBe(false);
    // A stale traversal refuses to continue instead of reviving its old cursor.
    expect(await scenario.client.directory.loadOlder()).toEqual({ loaded: false, stale: true });
  });

  it("cannot resurrect a session a late page brings back after its deletion", async () => {
    const scenario = await ready({
      sessions: page(summaries(1), { nextCursor: "c1", hasMore: true }),
    });

    const loading = scenario.client.directory.loadOlder();
    await flush();
    const requestId = scenario.host.requestIdOf("sessions.list") ?? "";

    // The page was cut before the deletion and answers after it. The deletion
    // is final: the page is filed without the session it names, and the
    // traversal asks for nothing that a deleted identity could come back in.
    scenario.host.respond(requestId, "sessions.list", {
      sessions: page(summaries(2, 1), { nextCursor: "c2", hasMore: true }),
    });
    scenario.host.emit({ type: "session.deleted", sessionId: "s-1", generation: 1 });

    expect(await loading).toEqual({ loaded: true, stale: false });
    const state = scenario.client.getSnapshot();
    const view = directoryView(state.directory, state.presentation?.sessions ?? null);
    expect(
      view.items.some((session) => session.sessionId === "s-1"),
      "a deleted session is not resurrected by a page that was already in flight",
    ).toBe(false);
    // The other summaries of that page are still filed: one deletion is not a
    // reason to forget what else was read.
    expect(view.items.some((session) => session.sessionId === "s-2")).toBe(true);
    expect(state.directory.pages).toHaveLength(1);
  });

  it("discards a late page whose catalogue revision moved underneath it", async () => {
    const scenario = await ready({
      sessions: page(summaries(1), { nextCursor: "c1", hasMore: true }),
    });

    const loading = scenario.client.directory.loadOlder();
    await flush();
    const requestId = scenario.host.requestIdOf("sessions.list") ?? "";
    scenario.host.respond(requestId, "sessions.list", {
      sessions: page(summaries(1, 1), { nextCursor: "c2", hasMore: true }),
    });
    // The catalogue moved past the revision the page belongs to.
    scenario.host.emit({
      type: "session.created",
      session: sessionSummary({ sessionId: "s-new", updatedAt: 1_700_000_100_000 }),
      collections: { sessions: 2, runs: 1, plugins: 1 },
    });

    expect(await loading).toEqual({ loaded: false, stale: true });
    const state = scenario.client.getSnapshot();
    expect(state.directory.pages, "a page from a revision this client has left is not filed").toHaveLength(0);
    expect(state.directory.stale, "the traversal stays retired").toBe(true);
    // Nothing about the old revision is presented as complete.
    const view = directoryView(state.directory, state.presentation?.sessions ?? null);
    expect(view.complete).toBe(false);
    expect(view.nextCursor).toBeNull();
  });
});

describe("focus ownership under deletion", () => {
  it("cannot install a focus read whose session was deleted while it was in flight", async () => {
    const scenario = await ready({ sessions: page([sessionSummary({ sessionId: "s-1" })]) });

    const focusing = scenario.client.directory.focus("s-1");
    await flush();
    const requestId = scenario.host.requestIdOf("sessions.get") ?? "";

    // A deletion lands while the confirmation read is on the wire: this client
    // knows the session is gone before the answer arrives.
    scenario.host.emit({ type: "session.deleted", sessionId: "s-1", generation: 1 });
    await flush();

    // The answer arrives for an identity that no longer exists: it installs
    // nothing, marks nothing confirmed, and authorizes nothing.
    scenario.host.respond(requestId, "sessions.get", { session: sessionSummary({ sessionId: "s-1" }) });
    await flush();

    const snapshot = scenario.client.getSnapshot();
    expect(snapshot.focusedSession, "a deleted session's focus read installs nothing").toBeNull();
    const view = directoryView(snapshot.directory, snapshot.presentation?.sessions ?? null);
    expect(view.items.some((session) => session.sessionId === "s-1")).toBe(false);
    void focusing;
  });

  it("keeps a later focus on another session when an earlier one's answer arrives deleted", async () => {
    const scenario = await ready({
      sessions: page([sessionSummary({ sessionId: "s-1" }), sessionSummary({ sessionId: "s-2", updatedAt: 1_699_999_999_000 })]),
    });

    const first = scenario.client.directory.focus("s-1");
    await flush();
    const firstRequest = scenario.host.requestIdOf("sessions.get") ?? "";

    // A retires it, and B is focused afterwards.
    scenario.host.emit({ type: "session.deleted", sessionId: "s-1", generation: 1 });
    await flush();
    const second = scenario.client.directory.focus("s-2");
    await flush();
    scenario.host.respond(scenario.host.requestIdOf("sessions.get", 1) ?? "", "sessions.get", {
      session: sessionSummary({ sessionId: "s-2" }),
    });
    await flush();
    scenario.host.respond(firstRequest, "sessions.get", { session: sessionSummary({ sessionId: "s-1" }) });
    await flush();

    // B is what the client stands behind; the deleted session's late answer
    // changed nothing about it.
    expect(scenario.client.getSnapshot().focusedSession?.sessionId).toBe("s-2");
    expect(scenario.client.getSnapshot().focusedSession?.confirmed).toBe(true);
    void first;
    void second;
  });
});
