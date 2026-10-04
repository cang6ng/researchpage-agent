/**
 * What loaded history is allowed to claim.
 *
 * `HistoryCoverage` records reads; whether the reads add up to the conversation
 * is a separate question, and it is answered by one strict derivation. These
 * tests drive real page answers through the client and check each way the
 * reading can fall short — and the one way it may be called complete.
 */

import { describe, expect, it } from "vitest";

import type { CanonicalItem, HistoryPage, SessionSummary } from "@every-dagent/protocol";

import { sessionSummary } from "./helpers/values.js";
import { createScenario, flush, openWith } from "./helpers/scenario.js";
import { historyFacts } from "../src/coverage.js";
import type { ClientSnapshot } from "../src/store.js";

const STORAGE = "fake-storage";

function item(seq: number): CanonicalItem {
  return Object.freeze({ id: `s-1:${seq}`, turnId: "turn-1", seq, kind: "user" as const, text: `item ${String(seq)}` });
}

interface PageParts {
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly fenceSeq: number;
  readonly nextCursor: string | null;
  readonly startsAtTurnBoundary?: boolean;
  readonly endsAtTurnBoundary?: boolean;
  readonly storageId?: string;
}

/**
 * One history page, built the way the protocol defines one: `atStart` is
 * exactly "the range begins at zero and nothing is behind it", and `atFence` is
 * exactly "the range reaches its fence".
 */
function page(parts: PageParts): HistoryPage {
  const items = Array.from({ length: parts.toSeq - parts.fromSeq }, (_, index) => item(parts.fromSeq + index));
  return {
    storageId: parts.storageId ?? STORAGE,
    sessionId: "s-1",
    generation: 1,
    historyRevision: 1,
    fenceSeq: parts.fenceSeq,
    direction: "backward",
    items,
    coverage: { fromSeq: parts.fromSeq, toSeq: parts.toSeq },
    startsAtTurnBoundary: parts.startsAtTurnBoundary ?? true,
    endsAtTurnBoundary: parts.endsAtTurnBoundary ?? true,
    atStart: parts.fromSeq === 0,
    atFence: parts.toSeq === parts.fenceSeq,
    nextCursor: parts.fromSeq === 0 ? null : parts.nextCursor,
  };
}

/** A ready client holding one session, whose history is answered by hand. */
async function readyWithHistory(session: SessionSummary) {
  const scenario = createScenario({ host: { auto: false } });
  await openWith(scenario, {
    sessions: {
      items: [session],
      collectionRevision: 1,
      nextCursor: null,
      hasMore: false,
    },
  });
  return scenario;
}

async function readOnePage(
  scenario: ReturnType<typeof createScenario>,
  body: HistoryPage,
): Promise<void> {
  const reading = scenario.client.sessions.history({ sessionId: body.sessionId });
  await flush();
  scenario.host.respond(scenario.host.requestIdOf("sessions.history") ?? "", "sessions.history", { page: body });
  await reading;
}

describe("the strict reading of loaded history", () => {
  it("calls a coverage that reaches both ends of the current high-water complete", async () => {
    const session = sessionSummary({ sessionId: "s-1", committedSeq: 4, historyRevision: 1 });
    const scenario = await readyWithHistory(session);
    await readOnePage(
      scenario,
      page({ fromSeq: 0, toSeq: 4, fenceSeq: 4, nextCursor: null }),
    );

    const facts = historyFacts(scenario.client.getSnapshot(), session, scenario.client.getSnapshot().history["s-1"] ?? null);
    expect(facts).toMatchObject({
      unloaded: false,
      atStart: true,
      atFence: true,
      behind: false,
      fragment: false,
      gap: false,
      stale: false,
      partial: false,
      complete: true,
    });
  });

  it("never calls a coverage complete on atStart alone", async () => {
    const session = sessionSummary({ sessionId: "s-1", committedSeq: 10, historyRevision: 1 });
    const scenario = await readyWithHistory(session);
    await readOnePage(
      scenario,
      page({ fromSeq: 0, toSeq: 3, fenceSeq: 10, nextCursor: null }),
    );

    const coverage = scenario.client.getSnapshot().history["s-1"] ?? null;
    const facts = historyFacts(scenario.client.getSnapshot(), session, coverage);
    expect(facts.atStart).toBe(true);
    expect(facts.atFence).toBe(false);
    expect(facts.complete).toBe(false);
    expect(facts.partial).toBe(true);
    // Unloaded above only: the range starts at the beginning of the session.
    expect(facts.gap).toBe(false);
  });

  it("reports a gap when unloaded history stands on both sides of the reading", async () => {
    const session = sessionSummary({ sessionId: "s-1", committedSeq: 10, historyRevision: 1 });
    const scenario = await readyWithHistory(session);
    await readOnePage(
      scenario,
      page({ fromSeq: 4, toSeq: 7, fenceSeq: 10, nextCursor: "c1" }),
    );

    const coverage = scenario.client.getSnapshot().history["s-1"] ?? null;
    const facts = historyFacts(scenario.client.getSnapshot(), session, coverage);
    expect(facts.gap).toBe(true);
    expect(facts.complete).toBe(false);
  });

  it("computes behind from the directory's high-water, not from the page", async () => {
    const session = sessionSummary({ sessionId: "s-1", committedSeq: 12, historyRevision: 1 });
    const scenario = await readyWithHistory(session);
    // The page's own fence is behind the session's committed high-water: the
    // traversal is honest about its fence, and the fact is that the session has
    // moved on since.
    await readOnePage(
      scenario,
      page({ fromSeq: 6, toSeq: 12, fenceSeq: 12, nextCursor: "c1" }),
    );

    const coverage = scenario.client.getSnapshot().history["s-1"] ?? null;
    const facts = historyFacts(scenario.client.getSnapshot(), session, coverage);
    expect(facts.atFence).toBe(true);
    expect(facts.complete).toBe(false);
    expect(facts.partial).toBe(true);
  });

  it("keeps a fragment visible: a page that splits a turn is never a finished turn", async () => {
    const session = sessionSummary({ sessionId: "s-1", committedSeq: 6, historyRevision: 1 });
    const scenario = await readyWithHistory(session);
    await readOnePage(
      scenario,
      page({ fromSeq: 4, toSeq: 6, fenceSeq: 6, nextCursor: "c1", startsAtTurnBoundary: false, endsAtTurnBoundary: false }),
    );

    const coverage = scenario.client.getSnapshot().history["s-1"] ?? null;
    expect(coverage?.fragmentOldest).toBe(true);
    expect(coverage?.fragmentNewest).toBe(true);
    const facts = historyFacts(scenario.client.getSnapshot(), session, coverage);
    expect(facts.fragment).toBe(true);
  });

  it("treats a coverage of another generation, storage or host as stale", async () => {
    const session = sessionSummary({ sessionId: "s-1", committedSeq: 4, historyRevision: 1 });
    const scenario = await readyWithHistory(session);
    await readOnePage(
      scenario,
      page({ fromSeq: 0, toSeq: 4, fenceSeq: 4, nextCursor: null }),
    );

    const snapshot = scenario.client.getSnapshot();
    const coverage = snapshot.history["s-1"] ?? null;
    expect(historyFacts(snapshot, session, coverage).complete).toBe(true);

    // The same coverage, read against a session whose identity moved on.
    const later: SessionSummary = Object.freeze({ ...session, generation: 2 });
    expect(historyFacts(snapshot, later, coverage).stale).toBe(true);
    expect(historyFacts(snapshot, later, coverage).complete).toBe(false);

    // And against a presentation that is no longer the current host's.
    const previous: ClientSnapshot = Object.freeze({ ...snapshot, presentationHost: "previous" });
    expect(historyFacts(previous, session, coverage).stale).toBe(true);
    expect(historyFacts(previous, session, coverage).complete).toBe(false);
  });

  it("is unloaded, and nothing more, before anything is read", async () => {
    const session = sessionSummary({ sessionId: "s-1" });
    const scenario = await readyWithHistory(session);
    expect(historyFacts(scenario.client.getSnapshot(), session, null)).toMatchObject({
      unloaded: true,
      complete: false,
      partial: false,
    });
  });
});
