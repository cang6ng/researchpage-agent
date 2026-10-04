/**
 * The public surface of `@every-dagent/client`.
 *
 * An explicit whitelist, never `export *`. The factory, the error class a caller
 * has to be able to recognize, and the types that describe what a caller may
 * read — nothing else. `createClientWith` and its internals are deliberately
 * absent, and so is the reverse seam: the production reverse catalog is empty,
 * the registration contract that fills it is internal, and it exists only so
 * tests can drive the real dispatcher.
 */

export { createClient } from "./client.js";
export type { ToolApprovalHandler } from "./client.js";
export type { ApprovalReplyState } from "./store.js";
export type { Client, ClientOptions } from "./client.js";
export type { DirectoryStep } from "./connection.js";

export { ClientError } from "./errors.js";
export type {
  ClientErrorCode,
  ConnectionLostReason,
  ClientMisuseReason,
  OutcomeClaim,
  ProtocolViolationReason,
} from "./errors.js";

export type { ClientSnapshot, ConnectionStatus, LiveMap, PresentationHost } from "./store.js";
export type { HistoryCoverage, HistoryMap, HistorySegment } from "./fold.js";

/**
 * The directory and coverage facts a shell reads. They are pure derivations
 * over a snapshot: the limits are the client's own implementation profile, the
 * view is what that profile currently holds, and the history facts are the one
 * place that decides when loaded pages may be called the whole conversation.
 */
export { DIRECTORY_CACHE_LIMITS, directoryView } from "./directory.js";
export type { DirectoryPage, DirectoryState, DirectoryView, FocusedSession } from "./directory.js";
export { historyFacts } from "./coverage.js";
export type { HistoryFacts } from "./coverage.js";

export type { ProtocolChannel } from "@every-dagent/protocol";
