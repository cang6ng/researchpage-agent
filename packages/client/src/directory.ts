/**
 * The bounded session directory: what this client has actually *read* of the
 * host's session collection, beyond the live window a cut gives it.
 *
 * A cut carries a window — the newest summaries the host chose to publish — and
 * a window is not a collection. This module is the other half of that honesty:
 * the pages a reader has walked back through, kept as the pages they were read
 * as, so the client can say how much of the directory it is holding and where
 * the held range stops. Nothing here is wire state: the host's snapshot is
 * untouched, and `HostSnapshot.sessions` keeps meaning exactly what it meant.
 *
 * Four rules shape the model.
 *
 * The anchor is the head, and the head is always current. Either the live window
 * a cut installed, or a page this client re-read from the host after the
 * traversal was invalidated; the older pages hang below whichever of the two is
 * newer. Nothing is ever stitched from two anchors.
 *
 * A cursor belongs to a revision. Every page is filed only while the collection
 * revision it was cut from is still the one this client holds; a revision that
 * moves retires the continuation instead of gluing a page from one version of
 * the catalogue onto another. `STALE_CURSOR` is the same fact arriving as a
 * refusal, and the answer to it is a re-anchor, never a retry.
 *
 * The cache is finite and says when it forgot. Older pages are dropped from the
 * deepest end — the end a reader walking backwards has already passed — and the
 * continuation cursor still continues below what is kept, so a dropped page is
 * reloadable rather than lost.
 *
 * Contiguity is a claim, so it is checked. The range is only contiguous with the
 * live window while the boundary the pages were anchored on is still the
 * window's bottom; a session that fell off the window's bottom afterwards is
 * reported as a gap rather than papered over by the merge.
 *
 * Everything here is pure: it reads state and returns the next state, and it
 * never sends anything.
 */

import type { Id, RunSnapshot, RunSummary, SessionSummary, SessionSummaryPage } from "@every-dagent/protocol";

/**
 * The bounds this client keeps the directory within.
 *
 * They are an implementation profile, not protocol law: the host bounds a page,
 * and this bounds what one page-attached reader remembers of the collection.
 * None of them is a cap on the collection itself — every dropped page is still
 * on the host, and reading it again is one request.
 */
export const DIRECTORY_CACHE_LIMITS = Object.freeze({
  /** The page size every directory read asks for. */
  listLimit: 50,
  /** The most older pages kept below the anchor. */
  maxOlderPages: 3,
  /** The most summaries the loaded directory may hold, head included. */
  maxSummaries: 200,
  /** The most encoded bytes of page data the cache may hold. */
  maxBytes: 1024 * 1024,
});

/** One page of the collection as it was read: the unit the cache holds. */
export interface DirectoryPage {
  /** The continuation cursor this page was read with; `null` for a fresh head read. */
  readonly cursor: Id | null;
  /** The cursor that continues below this page, or `null` when it reached the end. */
  readonly nextCursor: Id | null;
  readonly collectionRevision: number;
  readonly hasMore: boolean;
  readonly items: readonly SessionSummary[];
  /** The encoded cost of `items`, so the budget costs nothing to check. */
  readonly bytes: number;
}

/**
 * What this client holds of the collection, beyond the live window.
 *
 * `revision` is the revision the *continuation* belongs to: the newest anchor's,
 * because that is the version the next page would have to be cut from. It is not
 * a claim about the window, which carries its own revision and moves with every
 * directory event.
 */
export interface DirectoryState {
  /** The host instance the loaded pages were read from. */
  readonly hostInstanceId: Id | null;
  /** The storage the loaded pages were read from. */
  readonly storageId: Id | null;
  /** The revision the current continuation cursor was issued under. */
  readonly revision: number | null;
  /** The fresh head page, when this client re-read one; `null` means the live window anchors. */
  readonly head: DirectoryPage | null;
  /** The older pages that are *retained*, newest first: `pages[0]` continues directly below the anchor. */
  readonly pages: readonly DirectoryPage[];
  /**
   * How the traversal continues, carried independently of what is retained.
   *
   * A bounded cache may drop the page it just read — but the *reading* is not
   * dropped with it: this cursor was issued by the deepest page read so far,
   * and it is where the next read starts whether or not that page is still
   * held. Deriving it from the retained tail instead would make the traversal
   * stop advancing the moment the cache filled up, which is a bounded cache
   * pretending to be a bounded *reach*.
   */
  readonly nextCursor: Id | null;
  readonly hasMore: boolean;
  /**
   * The bottom summary of the anchor when the first older page was filed.
   *
   * It is the boundary the loaded range claims to continue from: while the
   * live window still ends at this summary, what is shown above the pages is
   * what was shown when they were read. A window whose bottom has moved on has
   * a range between it and the pages that this client never read.
   */
  readonly anchorBottomId: Id | null;
  /**
   * Whether the retained range has been cut loose from the anchor.
   *
   * A traversal that keeps walking has to forget its *oldest* end — the pages
   * nearest the anchor, which the reader has moved past — and that leaves a
   * range between the window and what is retained that was read and is no
   * longer held. It is reported rather than smoothed over: the view calls it a
   * gap, and a gap is never complete.
   */
  readonly detached: boolean;
  /** Whether older pages were dropped to stay inside the cache profile. */
  readonly evicted: boolean;
  /** Whether a revision move retired the continuation: the traversal must be re-anchored. */
  readonly stale: boolean;
}

export const EMPTY_DIRECTORY: DirectoryState = Object.freeze({
  hostInstanceId: null,
  storageId: null,
  revision: null,
  head: null,
  pages: Object.freeze([]) as readonly DirectoryPage[],
  nextCursor: null,
  hasMore: false,
  anchorBottomId: null,
  detached: false,
  evicted: false,
  stale: false,
});

/** The bytes a string occupies as UTF-8, over-counting nothing. */
function utf8Bytes(text: string): number {
  if (typeof TextEncoder === "function") return new TextEncoder().encode(text).length;
  let bytes = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** One page's encoded size: what it costs the cache to hold. */
function pageBytes(items: readonly SessionSummary[]): number {
  return utf8Bytes(JSON.stringify(items));
}

/** A wire page, read as the cache's own unit. */
export function directoryPageOf(page: SessionSummaryPage, cursor: Id | null): DirectoryPage {
  return Object.freeze({
    cursor,
    nextCursor: page.nextCursor,
    collectionRevision: page.collectionRevision,
    hasMore: page.hasMore,
    items: Object.freeze([...page.items]),
    bytes: pageBytes(page.items),
  });
}

/** The bottom summary of a page: the boundary the next page continues from. */
function bottomIdOf(page: DirectoryPage | null): Id | null {
  if (page === null) return null;
  const last = page.items[page.items.length - 1];
  return last === undefined ? null : last.sessionId;
}

/**
 * Starts a traversal over the window a cut just installed.
 *
 * The cut is a new delivery world: pages read under the previous one belong to
 * another anchor and another revision, and keeping them would be presenting a
 * range this client cannot claim to have read continuously.
 */
export function anchoredDirectory(
  published: SessionSummaryPage,
  context: { readonly hostInstanceId: Id; readonly storageId: Id },
): DirectoryState {
  return Object.freeze({
    hostInstanceId: context.hostInstanceId,
    storageId: context.storageId,
    revision: published.collectionRevision,
    head: null,
    pages: Object.freeze([]) as readonly DirectoryPage[],
    nextCursor: published.nextCursor,
    hasMore: published.hasMore,
    anchorBottomId: bottomIdOf(directoryPageOf(published, null)),
    detached: false,
    evicted: false,
    stale: false,
  });
}

/**
 * Re-anchors the traversal on a freshly read head page.
 *
 * This is what `STALE_CURSOR` and a moved collection revision call for: a new
 * revision can only be continued from a cursor that was cut from it, and the
 * only way to obtain one is to read the head again.
 */
export function reanchoredDirectory(
  head: DirectoryPage,
  context: { readonly hostInstanceId: Id; readonly storageId: Id },
): DirectoryState {
  return Object.freeze({
    hostInstanceId: context.hostInstanceId,
    storageId: context.storageId,
    revision: head.collectionRevision,
    head,
    pages: Object.freeze([]) as readonly DirectoryPage[],
    nextCursor: head.nextCursor,
    hasMore: head.hasMore,
    anchorBottomId: bottomIdOf(head),
    detached: false,
    evicted: false,
    stale: false,
  });
}

/** The continuation below the loaded range: the cursor to read next, and whether there is one. */
export interface DirectoryContinuation {
  readonly cursor: Id | null;
  readonly hasMore: boolean;
}

/**
 * Where the next older page starts.
 *
 * It is the traversal's own position — set by the anchor and advanced by every
 * page that is read — never a value re-derived from the pages that happen to be
 * retained: a cache that forgot a page has not un-read it.
 */
export function directoryContinuation(directory: DirectoryState): DirectoryContinuation {
  return { cursor: directory.nextCursor, hasMore: directory.hasMore };
}

/**
 * Whether a moved collection revision retires this traversal's continuation.
 *
 * A window that covers the whole collection is not invalidated by a later
 * insert — the window is still everything, and the live events keep it that
 * way. What a revision move invalidates is a *continuation*: the cursor was cut
 * from a version of the catalogue that no longer exists.
 */
export function continuationRetired(
  directory: DirectoryState,
  published: SessionSummaryPage | null,
): boolean {
  const continuation = directoryContinuation(directory);
  if (continuation.cursor !== null || continuation.hasMore || directory.pages.length > 0) return true;
  if (directory.head !== null) return false;
  // Nothing has been read below the window yet, and the window's own
  // continuation counts: it may have grown past its bound since the cut — a
  // bounded window that trimmed is a window with something below it — and the
  // cursor that would reach it belongs to the revision the catalogue no longer
  // is.
  if (published === null) return false;
  return published.nextCursor !== null || published.hasMore;
}

/** Marks the traversal invalidated: the continuation is retired, the display facts stay. */
export function invalidateDirectory(directory: DirectoryState): DirectoryState {
  if (directory.stale) return directory;
  return Object.freeze({ ...directory, stale: true });
}

/** Replaces the copy of one session in the loaded pages, if any page holds one. */
export function updateDirectorySession(directory: DirectoryState, session: SessionSummary): DirectoryState {
  const replaceIn = (page: DirectoryPage): DirectoryPage | undefined => {
    const index = page.items.findIndex((item) => item.sessionId === session.sessionId);
    if (index < 0) return undefined;
    const items = [...page.items];
    items[index] = session;
    const next = Object.freeze({ ...page, items: Object.freeze(items), bytes: pageBytes(items) });
    return next;
  };

  let changed = false;
  const head = directory.head === null ? null : (replaceIn(directory.head) ?? directory.head);
  if (head !== directory.head) changed = true;
  const pages = directory.pages.map((page) => {
    const replaced = replaceIn(page);
    if (replaced === undefined) return page;
    changed = true;
    return replaced;
  });
  if (!changed) return directory;
  return Object.freeze({
    ...directory,
    head,
    pages: Object.freeze(pages),
    ...(directory.anchorBottomId === session.sessionId ? { anchorBottomId: bottomIdOf(head) } : {}),
  });
}

/**
 * Removes one session from the loaded pages.
 *
 * Deletion is final, and the copies a page holds are copies: a page that still
 * shows a deleted session would keep presenting something the host has already
 * retired. The boundary is repaired the same way it is for an event: a deleted
 * bottom is not a moved bottom, because nothing was inserted between the two —
 * the summary above it takes its place.
 */
export function forgetDirectorySession(
  directory: DirectoryState,
  sessionId: Id,
  publishedBottomId: Id | null,
): DirectoryState {
  const wasAnchorBottom = directory.anchorBottomId === sessionId;

  const strip = (page: DirectoryPage): DirectoryPage | null => {
    const items = page.items.filter((item) => item.sessionId !== sessionId);
    if (items.length === page.items.length) return page;
    return Object.freeze({ ...page, items: Object.freeze(items), bytes: pageBytes(items) });
  };

  const head = directory.head === null ? null : strip(directory.head);
  const pages: DirectoryPage[] = [];
  let changed = head !== directory.head;
  for (const page of directory.pages) {
    const stripped = strip(page);
    if (stripped !== page) changed = true;
    if (stripped !== null) pages.push(stripped);
  }
  // The boundary follows the deletion even when no page held a copy: the
  // summary above the deleted one is the window's bottom now, and the range
  // below it is exactly what it was — which is the whole contiguity claim.
  if (!changed && !wasAnchorBottom) return directory;

  return Object.freeze({
    ...directory,
    head,
    pages: Object.freeze(pages),
    ...(wasAnchorBottom ? { anchorBottomId: publishedBottomId } : {}),
  });
}

export interface ApplyDirectoryPageOptions {
  /** Every session this connection has seen deleted: a late page may not resurrect one. */
  readonly deleted: ReadonlySet<Id>;
  /** The live window's current bottom summary id, when the window is the anchor. */
  readonly publishedBottomId: Id | null;
  readonly publishedIsAnchor: boolean;
}

/**
 * Files one freshly read older page, inside the cache profile.
 *
 * Two things happen here and only one of them is about the cache.
 *
 * The *traversal* advances: the page just read owns the position, so the
 * continuation becomes its own, and it stays that whether the page is retained
 * or dropped a moment later.
 *
 * The *cache* is then brought back inside its bounds from the end the reader
 * has moved past — the pages nearest the anchor — because a traversal walking
 * backwards is looking at the pages it just read, and forgetting those would
 * bound the *reach* rather than the memory. What that costs is reported: the
 * retained range stops touching the anchor, and the range in between is a gap
 * the view names.
 *
 * The page is held to the ledger throughout — a deletion is final, and a page
 * read before it may not bring the session back.
 */
export function applyDirectoryPage(
  directory: DirectoryState,
  page: DirectoryPage,
  options: ApplyDirectoryPageOptions,
): DirectoryState {
  const items = page.items.filter((item) => !options.deleted.has(item.sessionId));
  const filed: DirectoryPage =
    items.length === page.items.length ? page : Object.freeze({ ...page, items: Object.freeze(items), bytes: pageBytes(items) });

  // The arriving page is deeper than everything loaded (a traversal only ever
  // walks backwards), so it goes at the far end and the chain stays newest
  // first — the order the view renders it in.
  const pages = [...directory.pages, filed];
  const anchorBottomId =
    directory.pages.length === 0 && options.publishedIsAnchor ? options.publishedBottomId : directory.anchorBottomId;

  const trimmed = trimPages(pages, directory.head);
  return Object.freeze({
    ...directory,
    pages: Object.freeze(trimmed.kept),
    // The position belongs to the page that was read, never to the pages that
    // survived the budget.
    nextCursor: filed.nextCursor,
    hasMore: filed.hasMore,
    anchorBottomId,
    detached: directory.detached || trimmed.detached,
    evicted: directory.evicted || trimmed.evicted,
  });
}

/**
 * Brings the loaded pages inside the profile, dropping the ones furthest from
 * where the reader is.
 *
 * The traversal only ever walks backwards, so the pages just read are the ones
 * being looked at and the pages nearest the anchor are the ones the reader has
 * left behind — the same rule the history cache uses, for the same reason. What
 * is dropped is reported (`evicted`) and so is the fact that the retained range
 * no longer touches the anchor (`detached`); the traversal's own position is
 * not touched here at all, because a page that was read is not un-read by
 * forgetting it.
 */
function trimPages(
  pages: readonly DirectoryPage[],
  head: DirectoryPage | null,
): { readonly kept: readonly DirectoryPage[]; readonly evicted: boolean; readonly detached: boolean } {
  const kept = [...pages];
  let evicted = false;
  let detached = false;

  for (;;) {
    const all = head === null ? kept : [head, ...kept];
    let summaries = 0;
    let bytes = 0;
    for (const page of all) {
      summaries += page.items.length;
      bytes += page.bytes;
    }
    if (
      kept.length <= DIRECTORY_CACHE_LIMITS.maxOlderPages &&
      summaries <= DIRECTORY_CACHE_LIMITS.maxSummaries &&
      bytes <= DIRECTORY_CACHE_LIMITS.maxBytes
    ) {
      return { kept, evicted, detached };
    }
    if (kept.length <= 1) return { kept, evicted, detached };
    // The oldest end the reader has left behind goes first: that is where the
    // retained range stops touching the anchor.
    kept.shift();
    evicted = true;
    detached = true;
  }
}

// ---------------------------------------------------------------------------
// The view.
// ---------------------------------------------------------------------------

/**
 * What a reader may see of the directory, as facts rather than as a promise.
 *
 * `complete` is the strict one: everything the collection holds at this
 * revision is loaded, continuously, from the newest summary to the oldest, and
 * the anchor is current. Anything less is a window, and the view says so.
 */
export interface DirectoryView {
  /** The loaded summaries, newest first: the live window, then the pages below it. */
  readonly items: readonly SessionSummary[];
  /** How many of them came from the live window. */
  readonly liveCount: number;
  /** How many older pages are loaded. */
  readonly loadedPages: number;
  /** Whether older pages were dropped for the cache budget. */
  readonly evicted: boolean;
  /** Whether the traversal was invalidated and must be re-anchored before it continues. */
  readonly stale: boolean;
  /** Whether the loaded range has a range it no longer holds between it and the live window. */
  readonly gap: boolean;
  readonly hasMore: boolean;
  readonly nextCursor: Id | null;
  readonly complete: boolean;
}

/**
 * Merges the live window with the loaded pages.
 *
 * The window wins identity: it is the live replica, updated by every directory
 * event, while a page is a copy of what was read. Nothing deleted can be in
 * either half — a `session.deleted` removes the copies the pages hold, and a
 * page that raced the deletion is filtered before it is ever filed.
 */
export function directoryView(directory: DirectoryState, published: SessionSummaryPage | null): DirectoryView {
  const seen = new Set<Id>();
  const items: SessionSummary[] = [];
  const live = published?.items ?? [];
  for (const session of live) {
    seen.add(session.sessionId);
    items.push(session);
  }
  const liveCount = items.length;

  for (const page of [directory.head, ...directory.pages]) {
    if (page === null) continue;
    for (const session of page.items) {
      if (seen.has(session.sessionId)) continue;
      seen.add(session.sessionId);
      items.push(session);
    }
  }

  const continuation = directoryContinuation(directory);
  // A window that carries more below it is a continuation this client has no
  // cursor for: the traversal's own position stands, and the *existence* of
  // more is the window's fact.
  const traversalStarted = directory.pages.length > 0 || directory.head !== null;
  const windowMore =
    !traversalStarted && published !== null && (published.nextCursor !== null || published.hasMore);
  const hasMore = directory.stale ? true : continuation.hasMore || windowMore;
  // The range is contiguous with the live window only while the boundary the
  // pages were anchored on is still the window's bottom — and only while the
  // retained pages still reach that boundary at all. A range cut loose from the
  // anchor has a hole between it and the window that this client read and no
  // longer holds. A fresh head page is an anchor of its own: it cannot drift,
  // so it cannot gap.
  const boundaryMoved =
    directory.pages.length > 0 &&
    directory.head === null &&
    published !== null &&
    directory.anchorBottomId !== (published.items[published.items.length - 1]?.sessionId ?? null);
  const gap = directory.detached || boundaryMoved;
  // Reaching the end of the collection is not enough to call the *loaded* range
  // complete: a range cut loose from the anchor has a hole in it, and a hole is
  // never complete.
  const complete = !directory.stale && !gap && continuation.cursor === null && !hasMore;

  return Object.freeze({
    items: Object.freeze(items),
    liveCount,
    loadedPages: directory.pages.length,
    evicted: directory.evicted,
    stale: directory.stale,
    gap,
    hasMore,
    nextCursor: directory.stale ? null : continuation.cursor,
    complete,
  });
}

// ---------------------------------------------------------------------------
// The focused pin.
// ---------------------------------------------------------------------------

/**
 * The one session the reader is looking at, as the client's own facts.
 *
 * The *choice* belongs to the shell; the facts do not. A pin holds the summary
 * this client stands behind plus the session's most recent run, so a session
 * outside the bounded live windows is still shown from host truth rather than
 * from a component's copy of a page it once read.
 *
 * `confirmed` is the write gate: true only when the summary was read on the
 * current connection from the current host. A pin seeded from an older page, or
 * one that survived a reconnect, displays but does not authorize — the shell
 * may show it, and must not send a write for it until a read confirms it again.
 */
export interface FocusedSession {
  /** The host instance the confirmation belongs to. */
  readonly hostInstanceId: Id;
  readonly storageId: Id | null;
  readonly sessionId: Id;
  /** Bumped by every focus change; an answer carrying an older version is inert. */
  readonly focusVersion: number;
  readonly summary: SessionSummary;
  readonly confirmed: boolean;
  /** The most recent run of this session, as a summary; the choice of run belongs to no one else. */
  readonly recentRun: RunSummary | null;
}

/**
 * One run snapshot, reduced to its durable summary.
 *
 * The timeline is display state that belongs to the live replica; a pin holds
 * facts, and a draft copied into one would be a second, unmaintained timeline.
 */
export function runSummaryOf(run: RunSnapshot): RunSummary {
  const { live, liveTruncated, ...summary } = run as RunSnapshot & { readonly live?: unknown; readonly liveTruncated?: unknown };
  void live;
  void liveTruncated;
  return Object.freeze(summary as RunSummary);
}

/** One run's stage, for comparing two readings of the same run. */
function runStageRank(status: RunSummary["status"]): number {
  if (status === "accepted") return 0;
  if (status === "running") return 1;
  return 2;
}

/**
 * Whether a later reading of a run may replace an earlier one.
 *
 * Runs only move forward: a stage never un-runs, so a reading that is behind
 * what the pin already holds — an answer that raced an event — loses to it. A
 * different run of the same session is newer only if it was accepted later.
 */
export function newerRun(previous: RunSummary | null, candidate: RunSummary): boolean {
  if (previous === null) return true;
  if (previous.runId !== candidate.runId) return candidate.acceptedAt >= previous.acceptedAt;
  return runStageRank(candidate.status) >= runStageRank(previous.status);
}
