/**
 * What the client's loaded history *is*, in the one place that decides it.
 *
 * `HistoryCoverage` is a record of reads — the pages this client actually
 * loaded, their fence, and the gaps it has not filled. Whether that adds up to
 * the conversation is a separate question, and it is answered here rather than
 * inside a component, because the answer is a claim about the host's state and
 * a UI may not invent one.
 *
 * The strict reading is the point. `complete` means: the loaded range reaches
 * seq 0, reaches the fence, the fence is the session's current committed
 * high-water, the range is one continuous run of pages, nothing was appended
 * since it was read, and it was read from the host this client is talking to
 * now. Anything short of that is `partial`, and every way it can fall short is
 * named, so a page can say which one it is instead of rounding up.
 */

import type { SessionSummary } from "@every-dagent/protocol";

import type { HistoryCoverage } from "./fold.js";
import type { ClientSnapshot } from "./store.js";

export interface HistoryFacts {
  /** Nothing has been read of this session. */
  readonly unloaded: boolean;
  /** The loaded range reaches seq 0. */
  readonly atStart: boolean;
  /** The loaded range reaches its fence. */
  readonly atFence: boolean;
  /** The committed high-water moved past what is loaded. */
  readonly behind: boolean;
  /** The loaded range begins or ends inside a turn: a fragment, never a whole turn. */
  readonly fragment: boolean;
  /** Unloaded history stands on both sides of the loaded range. */
  readonly gap: boolean;
  /** The coverage describes a host, storage or generation this client no longer holds. */
  readonly stale: boolean;
  /** Loaded, but not the whole conversation by the strict reading. */
  readonly partial: boolean;
  /** The loaded range is the whole conversation. */
  readonly complete: boolean;
}

const UNLOADED: HistoryFacts = Object.freeze({
  unloaded: true,
  atStart: false,
  atFence: false,
  behind: false,
  fragment: false,
  gap: false,
  stale: false,
  partial: false,
  complete: false,
});

/** Whether the loaded segments form one continuous run, in log order. */
function contiguous(coverage: HistoryCoverage): boolean {
  const ordered = [...coverage.segments].sort((left, right) => left.fromSeq - right.fromSeq);
  if (ordered.length === 0) return false;
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (previous === undefined || current === undefined) return false;
    if (current.fromSeq !== previous.toSeq) return false;
  }
  return true;
}

/**
 * Everything the client knows about one session's loaded history.
 *
 * The session is what the "is it current" half is measured against: its
 * generation must be the coverage's, its committed high-water must be the
 * fence, and the presentation it came from must be the one on screen. Without
 * a session — a coverage whose directory entry this client no longer holds —
 * nothing here can be called complete, because the high-water it would have to
 * agree with is not held either.
 */
export function historyFacts(
  snapshot: ClientSnapshot,
  session: SessionSummary | null,
  coverage: HistoryCoverage | null,
): HistoryFacts {
  if (coverage === null) return UNLOADED;

  const description = snapshot.description;
  const storageId = description === null ? null : description.storage.storageId;
  const stale =
    description === null ||
    snapshot.presentationHost !== "current" ||
    snapshot.stale ||
    coverage.storageId !== storageId ||
    (session !== null && session.generation !== coverage.generation);

  const gap = !coverage.atStart && !coverage.atFence;
  const complete =
    !stale &&
    !gap &&
    coverage.atStart &&
    coverage.atFence &&
    !coverage.behind &&
    contiguous(coverage) &&
    session !== null &&
    session.generation === coverage.generation &&
    session.committedSeq === coverage.fenceSeq;

  return Object.freeze({
    unloaded: false,
    atStart: coverage.atStart,
    atFence: coverage.atFence,
    behind: coverage.behind,
    fragment: coverage.fragmentOldest || coverage.fragmentNewest,
    gap,
    stale,
    partial: !complete,
    complete,
  });
}
