/**
 * The fold: what one validated event means for the client's replica.
 *
 * This module is pure. It reads the previous state and one event, and returns
 * either the next state or a reason the event cannot follow from what the
 * client holds. It never sends anything, never consults the connection, and
 * never repairs a gap by guessing: an event that does not fit its own history is
 * a peer error, not something to paper over.
 *
 * Three replicas are folded separately, and deliberately so.
 *
 * The *directory* is a bounded window of session summaries and run summaries —
 * what a subscriber gets, not a copy of the database. The *live* timelines are
 * the drafts of runs that are still executing; they are not durable facts, they
 * never become history, and they are forgotten the moment a run ends. The
 * *history coverage* is what the client has actually read of each session's
 * committed conversation, page by page, with the gaps it has not read left
 * visible rather than filled in.
 *
 * A single event's schema cannot describe history, so the checks here are about
 * *continuity*: which session a run belongs to, which stage it has reached, and
 * which identities have already been published. A frame that is individually
 * valid and still cannot follow from what was published before it is refused.
 *
 * Immutability is by construction: every node this module creates is frozen,
 * every node it reuses is already frozen, and the arrays it touches are copied
 * rather than edited.
 */

import type {
  ActiveRunSnapshot,
  ApprovalSnapshot,
  CanonicalItem,
  CollectionRevisions,
  EventScope,
  HistoryPage,
  HostEvent,
  HostSnapshot,
  Id,
  LiveItem,
  PluginSummary,
  RunSnapshot,
  RunStatus,
  RunSummary,
  SessionSummary,
  Watermark,
} from "@every-dagent/protocol";

import type { ProtocolViolationReason } from "./errors.js";

/**
 * What this client holds beyond the published windows.
 *
 * The directory window is bounded, and it is not the authority on what a run
 * event means: a session the reader has *focused* — a session this client read
 * and stands behind — and a run this client already holds (a live draft, a
 * summary in the run window, the focused session's latest) are identities it
 * knows, and a fact about one of them is its business even when the session
 * sits outside the window. Everything else is a fact about a conversation this
 * replica is not presenting, and is dropped rather than invented into place.
 */
export interface PlaceabilityContext {
  /** The session this client is focused on, if any. */
  readonly focusedSessionId: Id | null;
  /**
   * The run summaries this client already stands behind, by run id.
   *
   * A live draft, a summary the run window still holds and the focused
   * session's recent run are all facts about a run this replica holds; an event
   * about one of them is checked against its own copy even when the bounded
   * window has since dropped it. The view is derived from the replica's own
   * bounded windows on every frame, so it can never grow past them.
   */
  readonly knownRuns: ReadonlyMap<Id, RunSummary>;
  /**
   * The sessions this client holds as executing a named run, by session id.
   *
   * Inside the window the same fact is read off the session summary's own
   * pointer; outside it this is what stands in for that pointer, so one session
   * still has one active run.
   */
  readonly activeRuns: ReadonlyMap<Id, Id>;
}

export const NO_PLACEABILITY: PlaceabilityContext = Object.freeze({
  focusedSessionId: null,
  knownRuns: new Map<Id, RunSummary>(),
  activeRuns: new Map<Id, Id>(),
});

/** Whether a run-scoped fact names something this client's directory holds or knows. */
export function runIsPlaceable(
  previous: HostSnapshot,
  sessionId: Id,
  runId: Id,
  context: PlaceabilityContext,
): boolean {
  if (context.focusedSessionId === sessionId) return true;
  if (context.knownRuns.has(runId)) return true;
  if (context.activeRuns.get(sessionId) === runId) return true;
  if (indexOfId(previous.sessions.items, sessionId, (item) => item.sessionId) >= 0) return true;
  return indexOfId(previous.runs.items, runId, (item) => item.runId) >= 0;
}

/**
 * Whether this client already holds a *different* active run for the session.
 *
 * This is the window path's one-active-run rule read off the facts the replica
 * holds instead of a session summary the window carries. Window membership
 * decides what is presented, never what a run's state machine allows: a second
 * acceptance for a session that is already running something is the same
 * contradiction inside the window and outside it.
 */
function activeRunConflict(context: PlaceabilityContext, sessionId: Id, runId: Id): boolean {
  const pointed = context.activeRuns.get(sessionId);
  if (pointed !== undefined && pointed !== runId) return true;
  for (const [id, summary] of context.knownRuns) {
    if (id === runId) continue;
    if (summary.sessionId !== sessionId) continue;
    if (summary.status === "accepted" || summary.status === "running") return true;
  }
  return false;
}

/**
 * The identity and stage guards one run publication must pass against what the
 * replica already holds about that run.
 *
 * One rule for every copy the client holds — the run window's, a live draft, or
 * the focused pin's — so an eviction from the bounded run window cannot turn a
 * guarded publication into an unguarded one. A publication that repeats the
 * status the client already holds is not a stage move.
 */
function runPublicationFits(existing: RunSummary, run: RunSummary): ProtocolViolationReason | undefined {
  if (!sameRunIdentity(existing, run)) return "run-identity";
  if (!turnIdFits(existing.turnId, run.turnId)) return "run-identity";
  if (existing.status !== run.status && !runStageAllows(existing.status, run.status)) return "invalid-event";
  return undefined;
}

/**
 * The same guards for a terminal, where the status may not simply repeat.
 *
 * A run that is already terminal cannot be ended again: the second end would
 * announce something the client has already settled. The identity rules are the
 * same ones every publication about a held run passes.
 */
function runTerminalFits(existing: RunSummary, run: RunSummary): ProtocolViolationReason | undefined {
  if (!sameRunIdentity(existing, run)) return "run-identity";
  if (!turnIdFits(existing.turnId, run.turnId)) return "run-identity";
  if (!runStageAllows(existing.status, run.status)) return "invalid-event";
  return undefined;
}

export type FoldOutcome =
  | { readonly ok: true; readonly presentation: HostSnapshot }
  | {
      readonly ok: false;
      readonly reason: ProtocolViolationReason;
      /**
       * The event is about something this client's bounded window does not
       * hold at all.
       *
       * A directory window is a window: the host serves its own newest page and
       * a reader that has scrolled back holds the pages it read, but a run may
       * legitimately be started for a session outside both — the run's own
       * events are then facts about a session this replica is not presenting.
       * Dropping them advances the stream and invents nothing; ending the
       * connection would turn the peer's legitimate behaviour into a fault.
       */
      readonly unplaceable?: true;
    };

/**
 * How much of each bounded window the client keeps in memory.
 *
 * The host's windows are bounded; a client that appended every announcement to
 * them would grow without limit over a long connection, which is the one thing
 * a bounded window exists to prevent. Dropping the oldest entry keeps the window
 * a window, and `hasMore` keeps saying there is more.
 */
const MAX_PRESENTED_SESSIONS = 50;
const MAX_PRESENTED_RUNS = 50;

/** Freezes a value and everything reachable from it. Already-frozen parts are skipped. */
export function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  if (Object.isFrozen(value)) return value;
  for (const field of Object.values(value)) deepFreeze(field);
  return Object.freeze(value);
}

function indexOfId<T>(items: readonly T[], id: string, idOf: (item: T) => string): number {
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item !== undefined && idOf(item) === id) return index;
  }
  return -1;
}

function replaceAt<T>(items: readonly T[], index: number, item: T): readonly T[] {
  const next = [...items];
  next[index] = item;
  return Object.freeze(next);
}

function sameRunIdentity(left: RunSummary, right: RunSummary): boolean {
  return (
    left.runId === right.runId &&
    left.sessionId === right.sessionId &&
    left.submissionId === right.submissionId &&
    left.text === right.text
  );
}

/** A turn id, once bound, is the run's for good — it never changes and never clears. */
function turnIdFits(bound: string | null, incoming: string | null): boolean {
  return bound === null || bound === incoming;
}

/**
 * The one rule about a run's stages.
 *
 * The state machine is `accepted → running → { completed | limited | cancelled
 * | failed | interrupted }`, plus `accepted → failed` for a host fault that
 * lands before the Core ever started. What breaks it is not something a later
 * snapshot may assert: a run that ended without the running publication, or a
 * move out of a terminal stage that would rewrite history already presented.
 */
function runStageAllows(from: RunStatus, to: RunStatus): boolean {
  switch (from) {
    case "accepted":
      // A run may only end straight from acceptance as a host failure; anything
      // else has to have been observed running first, because a reader explains
      // content by that publication.
      return to === "accepted" || to === "running" || to === "failed";
    case "running":
      return to !== "accepted";
    default:
      return false;
  }
}

function withWatermark(base: Omit<HostSnapshot, "watermark">, watermark: Watermark): HostSnapshot {
  return Object.freeze({
    ...base,
    watermark: Object.freeze({ streamId: watermark.streamId, sequence: watermark.sequence }),
  });
}

/** Structural equality for the JSON the protocol carries, used on display inputs and results. */
function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => sameJson(value, right[index]));
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key) =>
      Object.hasOwn(right, key) &&
      sameJson((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
  );
}

function sameDisplayInput(left: LiveItem & { kind: "tool" }, right: LiveItem & { kind: "tool" }): boolean {
  if (left.input.kind !== right.input.kind) return false;
  if (left.input.kind === "json" && right.input.kind === "json") return sameJson(left.input.value, right.input.value);
  return true;
}

/**
 * One live item's published identity, compared across a full replacement.
 *
 * A run.updated carries the whole timeline, so a rewrite of something already
 * shown would silently change history the client has already presented. Text
 * may grow; the identity of an occurrence may not — and once a result has been
 * published it is settled, so its only move is from "not yet" to one outcome.
 */
function sameLiveIdentity(left: LiveItem, right: LiveItem): boolean {
  if (left.kind !== right.kind || left.itemId !== right.itemId) return false;
  if (left.kind !== "tool" || right.kind !== "tool") return true;
  if (
    left.invocationId !== right.invocationId ||
    left.callId !== right.callId ||
    left.name !== right.name ||
    !sameDisplayInput(left, right)
  ) {
    return false;
  }
  if (left.result === null) return true;
  return right.result !== null && left.result.ok === right.result.ok && left.result.content === right.result.content;
}

/** The published timeline may only be extended, never rewritten or reordered. */
function liveContinues(previous: readonly LiveItem[], next: readonly LiveItem[]): boolean {
  if (next.length < previous.length) return false;
  for (let index = 0; index < previous.length; index += 1) {
    const before = previous[index];
    const after = next[index];
    if (before === undefined || after === undefined) return false;
    if (!sameLiveIdentity(before, after)) return false;
  }
  const seen = new Set(next.map((item) => item.itemId));
  return seen.size === next.length;
}

/**
 * Whether one freshly read timeline may replace what the replica already holds.
 *
 * A re-read is placed only when it *extends* the draft: the read may have been
 * asked for before a frame this client dropped, so an answer that is shorter
 * than the draft is older knowledge and loses to it. The rule is the fold's own
 * timeline monotonicity, shared so a read and an event cannot disagree about
 * which of them is newer.
 */
export function liveRefreshExtends(previous: readonly LiveItem[], next: readonly LiveItem[]): boolean {
  return liveContinues(previous, next);
}

function newRevisions(base: CollectionRevisions, incoming: CollectionRevisions): CollectionRevisions {
  return Object.freeze({
    sessions: Math.max(base.sessions, incoming.sessions),
    runs: Math.max(base.runs, incoming.runs),
    plugins: Math.max(base.plugins, incoming.plugins),
  });
}

function summaryOfActive(run: ActiveRunSnapshot): RunSummary {
  const { live, liveTruncated, ...rest } = run;
  void live;
  void liveTruncated;
  return Object.freeze(rest);
}

/**
 * Puts one run summary into the bounded window, newest first.
 *
 * A run the window has never held is inserted only when it is newer than what
 * the window carries; the window is a recent slice, and an old run arriving
 * late belongs to the part of the collection this client is not holding.
 */
function withRun(previous: readonly RunSummary[], run: RunSummary): readonly RunSummary[] | undefined {
  const index = indexOfId(previous, run.runId, (item) => item.runId);
  if (index >= 0) {
    const existing = previous[index];
    if (existing === undefined) return undefined;
    if (runPublicationFits(existing, run) !== undefined) return undefined;
    return replaceAt(previous, index, run);
  }

  if (previous.length === 0) return Object.freeze([run]);
  const oldest = previous[previous.length - 1];
  if (oldest !== undefined && run.acceptedAt < oldest.acceptedAt) return previous;
  const grown = Object.freeze([run, ...previous]);
  return grown.length > MAX_PRESENTED_RUNS ? Object.freeze(grown.slice(0, MAX_PRESENTED_RUNS)) : grown;
}

function withSession(previous: readonly SessionSummary[], session: SessionSummary): readonly SessionSummary[] {
  const index = indexOfId(previous, session.sessionId, (item) => item.sessionId);
  if (index >= 0) return replaceAt(previous, index, session);
  const grown = Object.freeze([session, ...previous]);
  return grown.length > MAX_PRESENTED_SESSIONS ? Object.freeze(grown.slice(0, MAX_PRESENTED_SESSIONS)) : grown;
}

function withoutSession(previous: readonly SessionSummary[], sessionId: string): readonly SessionSummary[] {
  const index = indexOfId(previous, sessionId, (item) => item.sessionId);
  if (index < 0) return previous;
  const next = [...previous];
  next.splice(index, 1);
  return Object.freeze(next);
}

/** Whether the client's window is no longer the newest slice of the collection. */
function windowHasMore(page: { readonly hasMore: boolean; readonly nextCursor: Id | null }, grew: boolean): boolean {
  return page.hasMore || page.nextCursor !== null || grew;
}

/**
 * Applies one event to the bounded directory.
 *
 * `watermark` is the stream position this event occupies; it is written into the
 * result even when the event changed nothing else, because the position itself
 * is state — that is what makes a duplicate detectable later.
 */
export function foldEvent(
  previous: HostSnapshot,
  event: HostEvent,
  watermark: Watermark,
  context: PlaceabilityContext = NO_PLACEABILITY,
): FoldOutcome {
  // The event is a validated, isolated snapshot: freezing it here means every
  // node the fold inserts is immutable from the moment it is published.
  deepFreeze(event);

  switch (event.type) {
    case "session.created":
      return foldSessionCreated(previous, event.payload.session, event.payload.collections, watermark);
    case "session.updated":
      return foldSessionUpdated(previous, event.payload.session, event.payload.collections, watermark);
    case "session.deleted":
      return foldSessionDeleted(previous, event.scope.sessionId, event.payload.collections, watermark);
    case "run.updated":
      return foldRunUpdated(previous, event.payload.run, watermark, context);
    case "run.ended":
      return foldRunEnded(previous, event, watermark, context);
    case "collection.invalidated":
      return foldCollectionInvalidated(previous, event.payload.collections, watermark);
    case "plugin.updated":
      return foldPluginUpdated(previous, event.payload.plugin, watermark);
    case "settings.updated":
      return foldSettingsUpdated(previous, event.payload, watermark);
    case "run.output.delta":
    case "run.tool.call":
    case "run.tool.result":
      // Live content moves the live replica, never the directory: a draft is not
      // a durable fact and must not appear among them.
      return {
        ok: true,
        presentation: withWatermark(directoryOf(previous), watermark),
      };
    case "host.request.cancelled":
      return {
        ok: true,
        presentation: withWatermark(directoryOf(previous), watermark),
      };
    case "approval.updated":
      return foldApprovalUpdated(previous, event.payload.approval, watermark);
  }
}

/**
 * One approval publication, folded into the business snapshot.
 *
 * The Host is the only authority on an approval's state, so this fold only
 * refuses what the Host itself must never say: that a decided approval became
 * pending again. A `null` payload means the Host holds no approval — that is
 * how a client learns the delivery it answered is over.
 */
function foldApprovalUpdated(
  previous: HostSnapshot,
  approval: ApprovalSnapshot | null,
  watermark: Watermark,
): FoldOutcome {
  const current = previous.approval;
  if (approval !== null && current !== null && approval.approvalId === current.approvalId) {
    if (current.status !== "pending" && approval.status === "pending") {
      return { ok: false, reason: "invalid-event" };
    }
    if (approval.executionId !== current.executionId) {
      return { ok: false, reason: "invalid-event" };
    }
  }
  return {
    ok: true,
    presentation: withWatermark({ ...directoryOf(previous), approval }, watermark),
  };
}

function directoryOf(previous: HostSnapshot): Omit<HostSnapshot, "watermark"> {
  return {
    hostInstanceId: previous.hostInstanceId,
    storage: previous.storage,
    collections: previous.collections,
    sessions: previous.sessions,
    runs: previous.runs,
    plugins: previous.plugins,
    settings: previous.settings,
    approval: previous.approval,
  };
}

function foldSessionCreated(
  previous: HostSnapshot,
  session: SessionSummary,
  collections: CollectionRevisions,
  watermark: Watermark,
): FoldOutcome {
  if (indexOfId(previous.sessions.items, session.sessionId, (item) => item.sessionId) >= 0) {
    return { ok: false, reason: "invalid-event" };
  }

  return {
    ok: true,
    presentation: withWatermark(
      {
        ...directoryOf(previous),
        collections: newRevisions(previous.collections, collections),
        sessions: Object.freeze({
          items: withSession(previous.sessions.items, session),
          collectionRevision: collections.sessions,
          nextCursor: previous.sessions.nextCursor,
          hasMore: windowHasMore(previous.sessions, previous.sessions.items.length >= MAX_PRESENTED_SESSIONS),
        }),
      },
      watermark,
    ),
  };
}

function foldSessionUpdated(
  previous: HostSnapshot,
  session: SessionSummary,
  collections: CollectionRevisions,
  watermark: Watermark,
): FoldOutcome {
  const index = indexOfId(previous.sessions.items, session.sessionId, (item) => item.sessionId);
  if (index >= 0) {
    const existing = previous.sessions.items[index];
    if (existing === undefined) return { ok: false, reason: "invalid-event" };
    if (existing.generation !== session.generation) {
      // A different identity under the same id is not an update; it is the id
      // being reused, which this protocol never does.
      return { ok: false, reason: "invalid-event" };
    }
    if (session.metadataRevision <= existing.metadataRevision && session.committedSeq < existing.committedSeq) {
      // Revisions only move forward, and committed history is never shortened.
      return { ok: false, reason: "invalid-event" };
    }
  }

  return {
    ok: true,
    presentation: withWatermark(
      {
        ...directoryOf(previous),
        collections: newRevisions(previous.collections, collections),
        sessions: Object.freeze({
          items: withSession(previous.sessions.items, session),
          collectionRevision: collections.sessions,
          nextCursor: previous.sessions.nextCursor,
          hasMore: previous.sessions.hasMore || previous.sessions.nextCursor !== null,
        }),
      },
      watermark,
    ),
  };
}

function foldSessionDeleted(
  previous: HostSnapshot,
  sessionId: string,
  collections: CollectionRevisions,
  watermark: Watermark,
): FoldOutcome {
  return {
    ok: true,
    presentation: withWatermark(
      {
        ...directoryOf(previous),
        collections: newRevisions(previous.collections, collections),
        sessions: Object.freeze({
          items: withoutSession(previous.sessions.items, sessionId),
          collectionRevision: collections.sessions,
          nextCursor: previous.sessions.nextCursor,
          hasMore: previous.sessions.hasMore || previous.sessions.nextCursor !== null,
        }),
        runs: Object.freeze({
          ...previous.runs,
          items: Object.freeze(previous.runs.items.filter((run) => run.sessionId !== sessionId)),
          collectionRevision: collections.runs,
        }),
      },
      watermark,
    ),
  };
}

function foldRunUpdated(
  previous: HostSnapshot,
  run: ActiveRunSnapshot,
  watermark: Watermark,
  context: PlaceabilityContext,
): FoldOutcome {
  const sessionIndex = indexOfId(previous.sessions.items, run.sessionId, (item) => item.sessionId);
  const summary = summaryOfActive(run);
  if (sessionIndex < 0) {
    if (!runIsPlaceable(previous, run.sessionId, run.runId, context)) {
      // A conversation this replica is not presenting and has never been asked
      // about: it is dropped, because filing it somewhere plausible would be
      // inventing a session summary nobody sent.
      return { ok: false, reason: "invalid-event", unplaceable: true };
    }
    // The session is outside the window, but the run is this client's business:
    // the summary goes where run summaries live — the bounded run window — and
    // no session summary is invented for it. What the replica *holds* is still
    // the authority on what may be said about the run.
    if (activeRunConflict(context, run.sessionId, run.runId)) {
      // One session, one active run: the window path reads that off the
      // session's own pointer, and outside the window the client's held facts
      // are what stand in for it. The rule does not change with the window.
      return { ok: false, reason: "invalid-event" };
    }
    const held = context.knownRuns.get(run.runId);
    if (held !== undefined) {
      // Known but evicted from the run window: identity and stage are checked
      // against the copy this client still stands behind.
      const fit = runPublicationFits(held, summary);
      if (fit !== undefined) return { ok: false, reason: fit };
    }
    const items = withRun(previous.runs.items, summary);
    if (items === undefined) return { ok: false, reason: "invalid-event" };
    return {
      ok: true,
      presentation: withWatermark(
        { ...directoryOf(previous), runs: Object.freeze({ ...previous.runs, items }) },
        watermark,
      ),
    };
  }
  const session = previous.sessions.items[sessionIndex];
  if (session === undefined) return { ok: false, reason: "invalid-event" };
  if (session.activeRunId !== null && session.activeRunId !== run.runId) {
    // One session, one active run: a second one cannot be true at the same time.
    return { ok: false, reason: "invalid-event" };
  }
  // A copy the bounded run window no longer holds — a draft, or the pin's own
  // run — is still what this run's identity and stage are checked against.
  const windowCopy = previous.runs.items.find((item) => item.runId === run.runId);
  const held = windowCopy ?? context.knownRuns.get(run.runId);
  if (held !== undefined && runPublicationFits(held, summary) !== undefined) {
    // The directory fold refuses a publication that cannot follow from the
    // summary it already holds, wherever that summary is held.
    return { ok: false, reason: "invalid-event" };
  }

  const items = withRun(previous.runs.items, summary);
  if (items === undefined) return { ok: false, reason: "invalid-event" };

  // The active-run pointer moves in the same update as the run it points at:
  // a reader never sees the run without the session that owns it.
  const sessions = replaceAt(
    previous.sessions.items,
    sessionIndex,
    Object.freeze({ ...session, activeRunId: run.runId }),
  );

  return {
    ok: true,
    presentation: withWatermark(
      {
        ...directoryOf(previous),
        sessions: Object.freeze({ ...previous.sessions, items: sessions }),
        runs: Object.freeze({ ...previous.runs, items }),
      },
      watermark,
    ),
  };
}

function foldRunEnded(
  previous: HostSnapshot,
  event: Extract<HostEvent, { type: "run.ended" }>,
  watermark: Watermark,
  context: PlaceabilityContext,
): FoldOutcome {
  const run = event.payload.run;
  const session = event.payload.session;
  const collections = event.payload.collections;

  const scope = event.scope;
  if (scope.sessionId !== session.sessionId || scope.sessionId !== run.sessionId) {
    return { ok: false, reason: "invalid-event" };
  }

  const sessionIndex = indexOfId(previous.sessions.items, session.sessionId, (item) => item.sessionId);
  const runIndex = indexOfId(previous.runs.items, run.runId, (item) => item.runId);

  if (sessionIndex < 0) {
    if (!runIsPlaceable(previous, run.sessionId, run.runId, context)) {
      // Same as a run publication: a terminal for a conversation this replica
      // neither presents nor knows is not its fact to file.
      return { ok: false, reason: "invalid-event", unplaceable: true };
    }
    // A terminal for a run this client knows: the run window gets the outcome,
    // and the session that is not held is not invented either. Identity and
    // stage are still checked — a terminal may not rewrite what was published
    // about the run, and a stage never moves backwards — against the copy the
    // client holds, whether or not the bounded run window still carries it.
    const existing = runIndex < 0 ? context.knownRuns.get(run.runId) : previous.runs.items[runIndex];
    if (existing !== undefined) {
      const fit = runTerminalFits(existing, run);
      if (fit !== undefined) return { ok: false, reason: fit };
    } else if (activeRunConflict(context, run.sessionId, run.runId)) {
      // A run this client never saw may be announced terminal only if the
      // session it names was not already running something else — the same rule
      // the window path applies to the session's own pointer.
      return { ok: false, reason: "invalid-event" };
    }
    // The window stays a window: a terminal that belongs inside it is filed
    // under the same rule a publication is, cap included.
    const items = withRun(previous.runs.items, run);
    if (items === undefined) return { ok: false, reason: "invalid-event" };
    return {
      ok: true,
      presentation: withWatermark(
        {
          ...directoryOf(previous),
          collections: newRevisions(previous.collections, collections),
          runs: Object.freeze({
            items,
            collectionRevision: collections.runs,
            nextCursor: previous.runs.nextCursor,
            hasMore: previous.runs.hasMore || previous.runs.nextCursor !== null,
          }),
        },
        watermark,
      ),
    };
  }
  const existingSession = previous.sessions.items[sessionIndex];
  const existingRun = runIndex < 0 ? context.knownRuns.get(run.runId) : previous.runs.items[runIndex];
  if (existingRun !== undefined) {
    const fit = runTerminalFits(existingRun, run);
    if (fit !== undefined) return { ok: false, reason: fit };
  } else if (existingSession !== undefined && existingSession.activeRunId !== run.runId) {
    // A run this client never saw may be announced as terminal only if its
    // session did not claim to be running something else.
    return { ok: false, reason: "invalid-event" };
  }

  // One update carries both halves: the terminal run, the settled session, and
  // the catalogue versions the commit produced. A reader never sees a finished
  // run beside a session that still points at it.
  const items = withRun(previous.runs.items, run);
  if (items === undefined) return { ok: false, reason: "invalid-event" };
  return {
    ok: true,
    presentation: withWatermark(
      {
        ...directoryOf(previous),
        collections: newRevisions(previous.collections, collections),
        sessions: Object.freeze({
          items: replaceAt(previous.sessions.items, sessionIndex, session),
          collectionRevision: collections.sessions,
          nextCursor: previous.sessions.nextCursor,
          hasMore: previous.sessions.hasMore || previous.sessions.nextCursor !== null,
        }),
        runs: Object.freeze({
          items,
          collectionRevision: collections.runs,
          nextCursor: previous.runs.nextCursor,
          hasMore: previous.runs.hasMore || previous.runs.nextCursor !== null,
        }),
      },
      watermark,
    ),
  };
}

function foldCollectionInvalidated(
  previous: HostSnapshot,
  collections: CollectionRevisions,
  watermark: Watermark,
): FoldOutcome {
  return {
    ok: true,
    presentation: withWatermark(
      { ...directoryOf(previous), collections: newRevisions(previous.collections, collections) },
      watermark,
    ),
  };
}

/**
 * One namespace's revisions moved.
 *
 * The directory carries the *summary* of the host's own two namespaces, and
 * this is what keeps it current: the announced revision and restart flag move,
 * and nothing else does. A namespace the cut does not carry — a plugin's, whose
 * state travels as a plugin summary — moves the stream position and no more,
 * and an announcement that is not newer than what the client holds is late
 * rather than wrong: it is read, it advances the position, and it changes
 * nothing.
 */
function foldSettingsUpdated(
  previous: HostSnapshot,
  payload: { readonly namespace: Id; readonly revision: number; readonly restartRequired: boolean },
  watermark: Watermark,
): FoldOutcome {
  const index = previous.settings.findIndex((entry) => entry.namespace === payload.namespace);
  if (index < 0) {
    return { ok: true, presentation: withWatermark(directoryOf(previous), watermark) };
  }

  const existing = previous.settings[index];
  if (existing === undefined || existing.desiredRevision >= payload.revision) {
    return { ok: true, presentation: withWatermark(directoryOf(previous), watermark) };
  }

  const moved = Object.freeze({
    ...existing,
    desiredRevision: payload.revision,
    restartRequired: payload.restartRequired,
  });
  const settings = [...previous.settings];
  settings[index] = moved;
  return {
    ok: true,
    presentation: withWatermark(
      { ...directoryOf(previous), settings: Object.freeze(settings) },
      watermark,
    ),
  };
}

function foldPluginUpdated(previous: HostSnapshot, plugin: PluginSummary, watermark: Watermark): FoldOutcome {
  const index = indexOfId(previous.plugins, plugin.id, (item) => item.id);
  if (index < 0) return { ok: false, reason: "invalid-event" };

  return {
    ok: true,
    presentation: withWatermark(
      { ...directoryOf(previous), plugins: replaceAt(previous.plugins, index, plugin) },
      watermark,
    ),
  };
}

// ---------------------------------------------------------------------------
// The live replica.
// ---------------------------------------------------------------------------

export type LiveMap = Readonly<Record<Id, ActiveRunSnapshot>>;

export type LiveOutcome =
  | { readonly ok: true; readonly live: LiveMap }
  | {
      readonly ok: false;
      readonly reason: ProtocolViolationReason;
      /**
       * The live replica holds nothing about this run at all.
       *
       * A run whose draft this client never placed — its session was outside the
       * window when the run started — can be announced in states a draft-less
       * replica cannot follow. That is not the same as a publication the draft
       * the client *does* hold refuses: one is a fact this replica could not
       * present yet, the other contradicts what the host already published. Only
       * the former is a candidate for toleration, and the marker is the only
       * thing that says which one this is.
       */
      readonly unplaceable?: true;
    };

function withLive(live: LiveMap, runId: string, run: ActiveRunSnapshot): LiveMap {
  return Object.freeze({ ...live, [runId]: run });
}

function withoutLive(live: LiveMap, runId: string): LiveMap {
  if (!Object.hasOwn(live, runId)) return live;
  const next: Record<string, ActiveRunSnapshot> = {};
  for (const [key, value] of Object.entries(live)) {
    if (key === runId) continue;
    next[key] = value;
  }
  return Object.freeze(next);
}

/**
 * Applies one event to the live timelines.
 *
 * Content events are applied only to a run this client has seen published as
 * `running`: a chunk that arrives before that publication is a frame the client
 * cannot place, and inventing the run it belongs to would be inventing state the
 * host never sent.
 */
export function foldLiveEvent(live: LiveMap, event: HostEvent): LiveOutcome {
  switch (event.type) {
    case "run.updated": {
      const run = event.payload.run;
      const existing = live[run.runId];
      if (existing !== undefined) {
        if (!runStageAllows(existing.status, run.status)) return { ok: false, reason: "invalid-event" };
        if (existing.sessionId !== run.sessionId || existing.submissionId !== run.submissionId) {
          return { ok: false, reason: "run-identity" };
        }
        if (!turnIdFits(existing.turnId, run.turnId)) return { ok: false, reason: "run-identity" };
        if (!liveContinues(existing.live, run.live)) return { ok: false, reason: "run-identity" };
      } else if (run.status !== "accepted") {
        // A run this client has never seen can only be announced as accepted.
        // Nothing is contradicted — there is no draft to contradict — so a caller
        // that knows why the draft is missing may still place the summary.
        return { ok: false, reason: "invalid-event", unplaceable: true };
      }
      return { ok: true, live: withLive(live, run.runId, run) };
    }

    case "run.output.delta": {
      const placed = liveRunAt(live, event.scope);
      if (placed === undefined) return { ok: false, reason: "invalid-event" };
      const { run } = placed;
      const payload = event.payload;

      const index = indexOfId(run.live, payload.itemId, (item) => item.itemId);
      let items: readonly LiveItem[];
      if (index < 0) {
        items = Object.freeze([...run.live, Object.freeze({ kind: "text" as const, itemId: payload.itemId, text: payload.text })]);
      } else {
        const item = run.live[index];
        if (item === undefined || item.kind !== "text") return { ok: false, reason: "invalid-event" };
        items = replaceAt(
          run.live,
          index,
          Object.freeze({ kind: "text" as const, itemId: payload.itemId, text: item.text + payload.text }),
        );
      }
      return { ok: true, live: withLive(live, run.runId, Object.freeze({ ...run, live: items })) };
    }

    case "run.tool.call": {
      const placed = liveRunAt(live, event.scope);
      if (placed === undefined) return { ok: false, reason: "invalid-event" };
      const { run } = placed;
      const item = event.payload.item;
      if (indexOfId(run.live, item.itemId, (candidate) => candidate.itemId) >= 0) {
        return { ok: false, reason: "invalid-event" };
      }
      if (run.live.some((candidate) => candidate.kind === "tool" && candidate.invocationId === item.invocationId)) {
        return { ok: false, reason: "invalid-event" };
      }
      return {
        ok: true,
        live: withLive(live, run.runId, Object.freeze({ ...run, live: Object.freeze([...run.live, item]) })),
      };
    }

    case "run.tool.result": {
      const placed = liveRunAt(live, event.scope);
      if (placed === undefined) return { ok: false, reason: "invalid-event" };
      const { run } = placed;
      const index = run.live.findIndex(
        (candidate) =>
          candidate.kind === "tool" &&
          candidate.invocationId === event.payload.invocationId &&
          candidate.result === null,
      );
      if (index < 0) return { ok: false, reason: "invalid-event" };
      const item = run.live[index];
      if (item === undefined || item.kind !== "tool") return { ok: false, reason: "invalid-event" };
      const items = replaceAt(
        run.live,
        index,
        Object.freeze({
          ...item,
          result: Object.freeze({
            ok: event.payload.ok,
            content: event.payload.content,
            disposition: event.payload.disposition,
          }),
        }),
      );
      return { ok: true, live: withLive(live, run.runId, Object.freeze({ ...run, live: items })) };
    }

    case "run.ended":
      // The draft is gone: a terminal run has no timeline, and this client holds
      // the summary the same event published.
      return { ok: true, live: withoutLive(live, event.payload.run.runId) };

    case "session.deleted": {
      let next = live;
      for (const [runId, run] of Object.entries(live)) {
        if (run.sessionId === event.payload.sessionId) next = withoutLive(next, runId);
      }
      return { ok: true, live: next };
    }

    default:
      return { ok: true, live };
  }
}

function liveRunAt(
  live: LiveMap,
  scope: Extract<EventScope, { kind: "run" }>,
): { readonly run: ActiveRunSnapshot } | undefined {
  const run = live[scope.runId];
  if (run === undefined) return undefined;
  if (run.sessionId !== scope.sessionId) return undefined;
  // Content follows the run's running publication, never its acceptance.
  if (run.status !== "running") return undefined;
  if (run.liveTruncated) return undefined;
  return { run };
}

// ---------------------------------------------------------------------------
// History coverage.
// ---------------------------------------------------------------------------

/**
 * What this client has read of one session's committed conversation.
 *
 * `behind` is the honest gap marker: it is set when the session's committed
 * high-water moved past what has been loaded, so a reader can tell "this is the
 * end of the conversation" from "this is the end of what I have read".
 *
 * The loaded conversation is kept as the *pages* it was read as, oldest first,
 * because a bounded client cache has to forget whole pages and no part of one:
 * the flattened fields below are derived from the first and last page, and a
 * page that is evicted moves `fromSeq` up rather than pretending a range was
 * never read. Eviction is a smaller window — never a claim that history does not
 * exist, that it is complete, or that the remaining range is contiguous with
 * what is gone. It takes from the oldest end, so what is kept is the newest
 * range the client read and `nextCursor` still continues below it.
 */
export interface HistoryCoverage {
  readonly storageId: Id;
  readonly sessionId: Id;
  readonly generation: number;
  readonly historyRevision: number;
  readonly fenceSeq: number;
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly atStart: boolean;
  readonly atFence: boolean;
  readonly behind: boolean;
  /** Whether the loaded range begins inside a turn: a fragment, never a finished turn. */
  readonly fragmentOldest: boolean;
  /** Whether the loaded range ends inside a turn. */
  readonly fragmentNewest: boolean;
  readonly nextCursor: Id | null;
  readonly items: readonly CanonicalItem[];
  /** The loaded pages this coverage is made of, oldest first. */
  readonly segments: readonly HistorySegment[];
}

/** One read page as it landed: the unit a bounded cache may forget. */
export interface HistorySegment {
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly atStart: boolean;
  readonly atFence: boolean;
  /**
   * Whether the page's ends fall on turn boundaries.
   *
   * The wire publishes these so a page that splits a turn is recognizable as a
   * fragment rather than as a finished conversation; they are kept at the
   * segment, because after eviction or a later page the edges they describe are
   * still the edges of what was read.
   */
  readonly startsAtTurnBoundary: boolean;
  readonly endsAtTurnBoundary: boolean;
  /** The cursor that continues below this page, or `null` at the start. */
  readonly cursorBelow: Id | null;
  readonly items: readonly CanonicalItem[];
  /** The encoded size of `items`, so the budget costs nothing to check. */
  readonly bytes: number;
}

export type HistoryMap = Readonly<Record<Id, HistoryCoverage>>;

/**
 * How much of other sessions' history this client keeps.
 *
 * A presentation cache, not a store: what it holds is what has been read, and
 * what it forgets can be read again. The bounds are deliberately simple and
 * mostly generous — a reader scrolling through a long conversation keeps
 * hundreds of items, and a client watching several sessions keeps pages for a
 * handful of them — because their job is to make the cache finite, not to be
 * tight. Durable history is untouched by any of this: forgetting is local, and
 * the host still holds every page.
 */
export const HISTORY_CACHE_LIMITS = Object.freeze({
  /** How many sessions may have loaded pages at once. */
  maxSessions: 8,
  /** How many items may be held across all sessions. */
  maxItems: 600,
  /** How many encoded bytes of items may be held across all sessions. */
  maxBytes: 768 * 1024,
});

/** One page's encoded size: what it costs the cache to hold. */
function segmentBytes(items: readonly CanonicalItem[]): number {
  return utf8Bytes(JSON.stringify(items));
}

/**
 * The bytes a string occupies as UTF-8.
 *
 * The client runs in browsers and in Node, so the measurement is the platform's
 * own encoder where there is one; the fallback is the standard three-byte
 * worst case, which over-counts nothing and never under-counts a real string.
 */
function utf8Bytes(text: string): number {
  if (typeof TextEncoder === "function") return new TextEncoder().encode(text).length;
  let bytes = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** The flattened view derived from a run of pages, oldest first. */
function flatten(segments: readonly HistorySegment[], base: Omit<HistoryCoverage, "segments" | "items" | "fromSeq" | "toSeq" | "atStart" | "atFence" | "nextCursor" | "fragmentOldest" | "fragmentNewest">): HistoryCoverage {
  // The extremes are found rather than assumed: the oldest page owns `fromSeq`
  // and the cursor that continues below it, the newest owns `toSeq` and the
  // fence flag, whatever order the pages happen to sit in.
  let oldest: HistorySegment | undefined;
  let newest: HistorySegment | undefined;
  const items: CanonicalItem[] = [];
  for (const segment of segments) {
    if (oldest === undefined || segment.fromSeq < oldest.fromSeq) oldest = segment;
    if (newest === undefined || segment.toSeq > newest.toSeq) newest = segment;
    items.push(...segment.items);
  }
  items.sort((left, right) => left.seq - right.seq);

  return Object.freeze({
    ...base,
    fromSeq: oldest?.fromSeq ?? 0,
    toSeq: newest?.toSeq ?? 0,
    atStart: oldest?.atStart ?? false,
    atFence: newest?.atFence ?? false,
    fragmentOldest: oldest !== undefined && !oldest.startsAtTurnBoundary,
    fragmentNewest: newest !== undefined && !newest.endsAtTurnBoundary,
    nextCursor: oldest?.cursorBelow ?? null,
    items: Object.freeze(items),
    segments: Object.freeze([...segments]),
  });
}

/**
 * Drops the newest loaded pages of one session until it fits the cache budget.
 *
 * Whole pages, and never the only page: a cache that forgot everything the
 * moment a conversation got long would be useless. The end that goes is the one
 * the reader is walking away from — the traversal only ever goes backwards, so
 * the pages just read are the ones being looked at, and the newest pages are
 * the ones a fresh traversal can bring back. What stays is exactly what was
 * read, a contiguous range with its continuation cursor intact; what goes is
 * reported as not loaded, never as not existing.
 */
function trimSegments(segments: readonly HistorySegment[]): readonly HistorySegment[] {
  const kept = [...segments];
  while (kept.length > 1) {
    let items = 0;
    let bytes = 0;
    for (const segment of kept) {
      items += segment.items.length;
      bytes += segment.bytes;
    }
    if (items <= HISTORY_CACHE_LIMITS.maxItems && bytes <= HISTORY_CACHE_LIMITS.maxBytes) break;

    // Forget the *newest* end, not the oldest: a reader is walking backwards,
    // so the pages just read are the ones being looked at, and dropping the
    // other end is what keeps the traversal continuous. `fromSeq` and the
    // continuation cursor are untouched, the newer range simply stops being
    // loaded — and comes back on the next traversal from the fence.
    let newest = 0;
    for (let index = 1; index < kept.length; index += 1) {
      if ((kept[index]?.toSeq ?? 0) > (kept[newest]?.toSeq ?? 0)) newest = index;
    }
    kept.splice(newest, 1);
  }
  return Object.freeze(kept);
}

/** The total items and bytes a map holds, for cross-session eviction. */
function cacheItems(history: HistoryMap): number {
  let items = 0;
  for (const coverage of Object.values(history)) {
    for (const segment of coverage.segments) items += segment.items.length;
  }
  return items;
}

function cacheBytes(history: HistoryMap): number {
  let bytes = 0;
  for (const coverage of Object.values(history)) {
    for (const segment of coverage.segments) bytes += segment.bytes;
  }
  return bytes;
}

/**
 * What the directory says about one session, at the moment a page is applied.
 *
 * A page is a claim about a cut, and the directory is what can still be checked
 * about it: `session` is the summary this client currently holds for the page's
 * session — its generation must be the page's, or the page is another
 * identity's history — and its `committedSeq` is the high-water the loaded
 * coverage is measured against, so "behind" is computed from current truth
 * instead of being inherited from whatever the last page happened to say.
 */
export interface HistoryContext {
  readonly session: SessionSummary | undefined;
}

/**
 * Records one page, merging it with what is already loaded.
 *
 * A page that continues the loaded range — same fence, same session, and meeting
 * the current coverage at its oldest end — extends it. Anything else replaces
 * it: a page from another fence or another revision is a different traversal,
 * and gluing two traversals together would present a conversation nobody read.
 *
 * Two rules here keep the merge monotone, and a third one lives with the
 * connection that asked for the page:
 *
 * - a page that lands entirely below the loaded coverage is dropped: it belongs
 *   to a smaller cut, and adopting it would strand the coverage this client
 *   honestly read above it;
 * - `behind` is recomputed from the directory's committed high-water and the
 *   coverage that results, never inherited — so a replacement cannot make a
 *   known gap look like a complete history;
 * - a page for an identity this connection has seen deleted never gets here at
 *   all (see the client connection's own ledger): deletion is final, and a late
 *   answer may not resurrect the cache it retired.
 *
 * The result is then brought back inside the client's cache budget. Other
 * sessions' entries go first, least recently updated before more recent ones —
 * and the entry being updated is the most recent by definition, so the page that
 * was just read is never the one eviction takes. An entry that is gone entirely
 * reads as "not loaded", which is what it is; the directory still lists the
 * session, and asking again reads it back from the host.
 */
export function applyHistoryPage(
  history: HistoryMap,
  page: HistoryPage,
  context?: HistoryContext,
): HistoryMap {
  const current = history[page.sessionId];
  if (context?.session !== undefined && current !== undefined && context.session.generation !== page.generation) {
    // A different identity under the same id is not an update; the client will
    // not file another generation's history under this one.
    return history;
  }
  if (current !== undefined && page.coverage.toSeq < current.fromSeq) {
    // A page that lands entirely below what is already loaded belongs to a
    // smaller cut: adopting it would strand the coverage this client honestly
    // read above it — a late answer may not move the replica backwards. A page
    // that reaches up to (or past) the loaded range is either its continuation
    // or a re-read the client itself asked for, and both are adoptable.
    return history;
  }

  const continues =
    current !== undefined &&
    current.storageId === page.storageId &&
    current.generation === page.generation &&
    current.fenceSeq === page.fenceSeq &&
    page.coverage.toSeq === current.fromSeq;

  const arriving: HistorySegment = Object.freeze({
    fromSeq: page.coverage.fromSeq,
    toSeq: page.coverage.toSeq,
    atStart: page.atStart,
    atFence: page.atFence,
    startsAtTurnBoundary: page.startsAtTurnBoundary,
    endsAtTurnBoundary: page.endsAtTurnBoundary,
    cursorBelow: page.nextCursor,
    items: Object.freeze([...page.items]),
    bytes: segmentBytes(page.items),
  });

  // The arriving page is older than everything loaded (a traversal only ever
  // walks backwards), so it goes in front and the pages stay oldest-first.
  const segments = trimSegments(
    continues && current !== undefined ? [arriving, ...current.segments] : [arriving],
  );

  const base = {
    storageId: page.storageId,
    sessionId: page.sessionId,
    generation: page.generation,
    historyRevision: page.historyRevision,
    fenceSeq: page.fenceSeq,
    behind: continues && current !== undefined ? current.behind : false,
  };
  const flattened = flatten(segments, base);
  // Honest gap: the high-water the directory holds, measured against what is
  // actually loaded now — never the flag an earlier page left behind.
  const behind =
    flattened.behind ||
    (context?.session !== undefined && context.session.committedSeq > flattened.toSeq);
  const next = behind === flattened.behind ? flattened : Object.freeze({ ...flattened, behind });

  // Re-insert the touched session last, so the map's own order is "least
  // recently read first" and eviction takes from the front.
  const rest: Record<string, HistoryCoverage> = {};
  for (const [key, value] of Object.entries(history)) {
    if (key === page.sessionId) continue;
    rest[key] = value;
  }
  rest[page.sessionId] = next;

  while (
    Object.keys(rest).length > HISTORY_CACHE_LIMITS.maxSessions ||
    cacheItems(rest) > HISTORY_CACHE_LIMITS.maxItems ||
    cacheBytes(rest) > HISTORY_CACHE_LIMITS.maxBytes
  ) {
    const oldest = Object.keys(rest)[0];
    if (oldest === undefined || oldest === page.sessionId) break;
    delete rest[oldest];
  }

  return Object.freeze(rest);
}

/** Applies one event's effect on what the client has read. */
export function foldHistoryEvent(history: HistoryMap, event: HostEvent): HistoryMap {
  switch (event.type) {
    case "session.deleted": {
      if (!Object.hasOwn(history, event.payload.sessionId)) return history;
      const next: Record<string, HistoryCoverage> = {};
      for (const [key, value] of Object.entries(history)) {
        if (key === event.payload.sessionId) continue;
        next[key] = value;
      }
      return Object.freeze(next);
    }
    case "run.ended": {
      const session = event.payload.session;
      const current = history[session.sessionId];
      if (current === undefined) return history;
      const behind = session.committedSeq > current.toSeq;
      if (behind === current.behind) return history;
      return Object.freeze({ ...history, [session.sessionId]: Object.freeze({ ...current, behind }) });
    }
    case "session.updated": {
      const session = event.payload.session;
      const current = history[session.sessionId];
      if (current === undefined) return history;
      const behind = session.committedSeq > current.toSeq;
      if (behind === current.behind) return history;
      return Object.freeze({ ...history, [session.sessionId]: Object.freeze({ ...current, behind }) });
    }
    default:
      return history;
  }
}

/** Drops everything loaded for a session whose identity the client no longer holds. */
export function forgetHistory(history: HistoryMap, sessionId: string): HistoryMap {
  if (!Object.hasOwn(history, sessionId)) return history;
  const next: Record<string, HistoryCoverage> = {};
  for (const [key, value] of Object.entries(history)) {
    if (key === sessionId) continue;
    next[key] = value;
  }
  return Object.freeze(next);
}

export type { RunSnapshot };
