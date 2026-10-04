/**
 * The shell's own logic, with no React in it.
 *
 * The controller owns the two things the shell is responsible for beyond the
 * client's snapshot: the few pieces of ephemeral UI state a page needs (which
 * host address was typed, which session is selected, which action is in
 * flight) and the "unconfirmed outcome" bookkeeping the platform's honesty
 * rules demand — a write whose answer was lost is shown as *unconfirmed*, and
 * the shell never converts that into either a silent retry or a claim that
 * nothing happened.
 *
 * It holds no host facts of its own: sessions, runs and plugins are read from
 * the client snapshot every time they are rendered, and nothing here writes a
 * response back into that snapshot. What is kept locally is only a description
 * of what the *user* did and what the *call* returned.
 */

import { ClientError, createClient, type Client, type ClientSnapshot } from "@every-dagent/client";
import type {
  ApprovalSnapshot,
  JsonValue,
  ProtocolChannel,
  ProtocolErrorCode,
  SessionSummary,
  ToolApprovalDecision,
  ToolApprovalResponse,
} from "@every-dagent/protocol";

import type { SelectionStorage, SessionSelection } from "./selection.js";
import { describedHostInstance, directoryOf, presentationHostInstance } from "./presentation.js";

export interface Notice {
  readonly id: string;
  readonly tone: "info" | "error";
  readonly text: string;
  /**
   * The one thing this notice is a report about, when it reports the result of
   * an operation a user can repeat on the same subject: a rename of one
   * session, a deletion of one session, a save of one namespace.
   *
   * Two notices that carry the same key are that subject's result arriving
   * again — never two different operations. The newer one takes the older one's
   * place instead of stacking a copy of the same sentence next to it, so
   * repeating an operation is visible as *one* answer to it, which is what the
   * result is. `null` means the notice is not a repeatable subject's result and
   * is simply appended.
   */
  readonly key: string | null;
}

interface UnknownWriteBase {
  readonly id: string;
  /** The host instance the request was aimed at, when one was known. */
  readonly hostInstanceId: string | null;
  readonly createdAt: number;
}

/**
 * One write whose outcome this shell could not learn.
 *
 * The record is deliberately thin: the identities, the revision the write was
 * aimed at, and a bounded human summary of what was asked — never a copy of the
 * conversation, a credential or a configuration dump. What it exists for is the
 * one thing the shell must never do on its own: send the write again.
 */
export type UnknownWrite =
  | (UnknownWriteBase & {
      readonly kind: "start";
      readonly sessionId: string;
      readonly submissionId: string;
      readonly text: string;
    })
  | (UnknownWriteBase & { readonly kind: "cancel"; readonly runId: string })
  | (UnknownWriteBase & { readonly kind: "create-session" })
  | (UnknownWriteBase & {
      readonly kind: "plugin";
      readonly pluginId: string;
      readonly operation: "enable" | "disable";
    })
  | (UnknownWriteBase & {
      readonly kind: "rename-session";
      readonly sessionId: string;
      readonly expectedRevision: number;
      readonly title: string;
    })
  | (UnknownWriteBase & { readonly kind: "delete-session"; readonly sessionId: string; readonly expectedRevision: number })
  | (UnknownWriteBase & {
      readonly kind: "settings-update";
      readonly namespace: string;
      readonly expectedRevision: number;
      /** A bounded description of the value that was sent; never the value itself. */
      readonly summary: string;
    });

export interface ShellUiState {
  /** The host address to connect to; `null` until one is configured. */
  readonly bindingOrigin: string | null;
  readonly selection: SessionSelection | null;
  readonly creatingSession: boolean;
  readonly startingRun: boolean;
  /** The run whose cancel request is in flight, if any. */
  readonly cancellingRunId: string | null;
  readonly pluginPending: Readonly<Record<string, "enable" | "disable">>;
  /** True while a history page for the selected session is being read. */
  readonly historyLoading: boolean;
  /** The session write in flight, if any: a rename or a delete, one at a time. */
  readonly sessionWrite: { readonly kind: "rename" | "delete"; readonly sessionId: string } | null;
  /**
   * The rename draft's *authority*: the session it belongs to and the metadata
   * revision the form was opened at.
   *
   * The text is the panel's; this is what the shell must not lose between
   * opening the form and submitting it. A rename is a compare-and-set against
   * the revision the reader *saw*, so re-reading the revision at submit time
   * would let a concurrent rename be silently overwritten instead of refused.
   */
  readonly renameDraft: { readonly sessionId: string; readonly expectedRevision: number } | null;
  /** The settings namespace whose read or save is in flight, if any. */
  readonly settingsPending: { readonly namespace: string; readonly operation: "read" | "save" } | null;
  /** True while an older directory page is being read. */
  readonly directoryLoading: boolean;
  /** True while the directory head is being re-read. */
  readonly directoryRefreshing: boolean;
  readonly notices: readonly Notice[];
  readonly unknownWrites: readonly UnknownWrite[];
  /**
   * The one ephemeral tool-approval delivery this shell can answer, if any.
   *
   * It is deliberately not the Host's approval: this holds a token, the two
   * identities the answer must name, and whether a decision has been handed to
   * the client. Everything shown about *what* is being approved is read from
   * the client's snapshot, which is the Host's own state.
   */
  readonly approvalWaiter: ApprovalWaiter | null;
}

/** The local half of one approval delivery: the waiter, and nothing about the decision itself. */
export interface ApprovalWaiter {
  readonly token: number;
  readonly approvalId: string;
  readonly executionId: string;
  /** Set once a decision has been handed to the client; never cleared by this shell. */
  readonly decision: ToolApprovalDecision | null;
}

export interface ShellActions {
  connect(): Promise<void>;
  connectTo(origin: string): Promise<void>;
  reconnect(): Promise<void>;
  disconnect(): void;
  createSession(): Promise<void>;
  selectSession(sessionId: string): void;
  /** Reads the next older page of the session directory, if there is one. */
  loadOlderSessions(): Promise<void>;
  /** Re-reads the directory head after the collection revision moved. */
  refreshDirectory(): Promise<void>;
  /** Re-confirms the selected session when the connection is ready again. */
  ensureFocus(): Promise<void>;
  /**
   * Opens a rename draft for one session, capturing the revision it is based on.
   *
   * Refused (with a notice) unless the session is confirmed on this connection:
   * a draft is a promise to write, and the write gate is what makes one.
   */
  beginRename(sessionId: string): void;
  /** Discards the rename draft, if any. */
  cancelRename(): void;
  /**
   * Submits one run.
   *
   * Resolves `true` when the submission left the client — answered, or sent
   * with its answer lost — and `false` when it definitely did not: the caller
   * may clear a draft in the first case and must keep it in the second.
   */
  startRun(sessionId: string, text: string): Promise<boolean>;
  cancelRun(runId: string): Promise<void>;
  /**
   * Renames one session against the revision the reader saw.
   *
   * Resolves `true` when the rename was accepted or its answer was lost (the
   * caller keeps its draft either way and reads the truth back from the host),
   * `false` when the host definitely refused it.
   */
  renameSession(sessionId: string, title: string): Promise<boolean>;
  /**
   * Deletes one session permanently, against the revision the reader saw.
   *
   * `false` means the host refused — a conflict, a busy host, or a session that
   * is already gone — and this shell never turns a refusal into a cancellation.
   */
  deleteSession(sessionId: string): Promise<boolean>;
  setPluginEnabled(pluginId: string, enabled: boolean): Promise<void>;
  /** Reads one settings namespace whole, so the panel can show desired and effective state. */
  readSettings(namespace: string): Promise<void>;
  /**
   * Saves one namespace against the revision it was read at.
   *
   * Resolves `true` when the host answered (saved, or refused with a conflict),
   * `false` when nothing definite is known — the caller must not claim either.
   */
  saveSettings(namespace: string, value: JsonValue, expectedRevision: number): Promise<SettingsSaveOutcome>;
  /**
   * Answers the approval the shell is holding a delivery for.
   *
   * The decision is a statement about one execution: it is refused unless the
   * client can still deliver it and both identities still name the approval on
   * screen. A second click is inert — the waiter is consumed once — and no
   * click ever becomes a decision by itself.
   */
  respondApproval(decision: ToolApprovalDecision): void;
  /** Queries the host for an unconfirmed write's outcome, when it can be queried at all. */
  checkUnknown(unknownId: string): Promise<void>;
  /** Re-sends the *same* start submission, letting host dedup decide, on the user's explicit ask. */
  resubmitUnknownStart(unknownId: string): Promise<void>;
  /** Reads the newest history page of one session, if it is not already loaded. */
  ensureHistory(sessionId: string): Promise<void>;
  /** Reads the next older page inside the loaded fence. */
  loadOlderHistory(sessionId: string): Promise<void>;
  /** Re-reads the newest page, starting a new fence over the current history. */
  reloadHistory(sessionId: string): Promise<void>;
  /** Re-synchronizes the presentation (a fresh snapshot replaces the old one). */
  refresh(): Promise<void>;
  dismissUnknown(unknownId: string): void;
  dismissNotice(noticeId: string): void;
}

/**
 * How a settings save ended, as three different facts.
 *
 * `unknown` is deliberately not `confirmed`: a caller that cleared a draft on
 * it would be treating a lost answer as a saved value.
 */
export type SettingsSaveOutcome =
  | { readonly kind: "confirmed" }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "unknown" };

export interface ShellController extends ShellActions {
  readonly client: Client;
  getState(): ShellUiState;
  subscribe(listener: () => void): () => void;
}

export interface ShellControllerOptions {
  readonly storage: SelectionStorage;
  /** The `?binding=` origin, when the page was opened with one. */
  readonly initialBinding: string | null;
}

export interface ComposedShellControllerOptions extends ShellControllerOptions {
  /** How a host origin becomes a channel; the browser passes `connectHttpChannel`. */
  readonly connector: (origin: string) => Promise<ProtocolChannel>;
  /** The submission-id source. Defaults to `crypto.randomUUID`. */
  readonly newId?: () => string;
  readonly now?: () => number;
}

const MAX_NOTICES = 8;

/**
 * How many unresolved writes this shell keeps before it stops starting more.
 *
 * Every one of them is a request whose outcome the host has not confirmed, and
 * the honest answer to "I cannot tell what happened to my last sixteen writes"
 * is to stop adding to the pile rather than to keep spending identities. The
 * cap is bookkeeping, not a protocol limit: cancelling a run and answering an
 * approval are safety controls and are never held behind it.
 */
const MAX_UNKNOWN_WRITES = 16;

/**
 * A bounded, non-secret description of a settings value, for the unconfirmed
 * record.
 *
 * The record exists so a person can tell which write is unresolved; it is not a
 * place to keep a configuration. What it carries is the *shape* of what was
 * sent — the field names — and never the values: a settings value can be as
 * large as the namespace allows, and an unconfirmed-write ledger that stored
 * one would be a copy of the configuration, not a note about a request.
 */
function settingsSummaryOf(value: JsonValue): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "（非对象值）";
  const keys = Object.keys(value);
  return `字段：${keys.length === 0 ? "（空对象）" : keys.join(", ")}`;
}

/** The host-error codes, as short fixed sentences. The wire message is never parsed; the code is the meaning. */
const REMOTE_HINTS: Readonly<Record<ProtocolErrorCode, string>> = Object.freeze({
  INVALID_REQUEST: "请求不符合契约",
  UNSUPPORTED_PROTOCOL: "Host 不支持该协议代际",
  NOT_INITIALIZED: "连接尚未完成初始化",
  HOST_INSTANCE_MISMATCH: "目标 Host 与当前连接不一致",
  METHOD_NOT_FOUND: "Host 不认识该方法",
  CAPABILITY_NOT_SUPPORTED: "Host 未声明该能力",
  SESSION_NOT_FOUND: "会话不存在",
  SESSION_UNAVAILABLE: "会话当前不可用（可能已阻塞）",
  RUN_NOT_FOUND: "运行不存在",
  PLUGIN_NOT_FOUND: "插件不存在",
  HOST_BUSY: "Host 正忙：同一时间只允许一个运行或一次插件变更",
  PLUGIN_UNAVAILABLE: "插件当前不可操作（可能处于错误状态）",
  PLUGIN_PERMISSION_DENIED: "插件权限被拒绝",
  PLUGIN_OPERATION_FAILED: "插件操作失败",
  SUBMISSION_CONFLICT: "提交标识冲突",
  SUBMISSION_RETIRED: "该提交所属的会话已被删除，不能重用",
  STALE_CURSOR: "分页游标对应的集合版本已经变化，请重新读取",
  REVISION_CONFLICT: "会话在你读取之后已经变化，请刷新后重试",
  LIMIT_EXCEEDED: "超过 Host 的大小或预算限制",
  SETTINGS_INVALID: "设置不符合 Host 接受的 schema",
  STORAGE_UNAVAILABLE: "持久存储不可用：写入未被确认",
  REQUEST_CANCELLED: "请求已被取消",
  INTERNAL_ERROR: "Host 内部错误",
});

const MISUSE_HINTS: Readonly<Record<string, string>> = Object.freeze({
  "not-initialized": "连接尚未完成初始化",
  "capability-unavailable": "Host 不支持该操作",
  "invalid-params": "请求参数不合法",
  "sync-in-flight": "已有一次同步正在进行",
  capacity: "客户端的未完成请求已达上限",
});

/**
 * The in-flight operation a plugin has, if it has one.
 *
 * The read is own-property only. A plugin id may legally be `constructor` (the
 * protocol's id grammar allows it), and an unguarded `pending[id]` read would
 * find `Object.prototype.constructor`, report the plugin as permanently busy,
 * and lock it out of both lifecycle operations.
 */
export function pluginPendingOf(
  pending: Readonly<Record<string, "enable" | "disable">>,
  pluginId: string,
): "enable" | "disable" | undefined {
  return Object.hasOwn(pending, pluginId) ? pending[pluginId] : undefined;
}

/** One client error, as a sentence for a person. */
export function explainError(error: unknown): string {
  if (error instanceof ClientError) {
    switch (error.kind) {
      case "remote":
        return `${REMOTE_HINTS[error.code as ProtocolErrorCode] ?? "Host 拒绝了该操作"}（${error.code}）`;
      case "connection":
        return error.outcome === "not-sent"
          ? `连接已断开，操作未发送（${error.code}）`
          : `连接已断开，操作结果未知（${error.code}）`;
      case "protocol":
        return error.outcome === "unknown"
          ? `协议错误：客户端已关闭连接，已发送操作的结果未知（${error.code}）`
          : `协议错误：客户端已关闭连接（${error.code}）`;
      case "client":
        return `操作未发送：${MISUSE_HINTS[error.reason ?? ""] ?? "客户端拒绝了该调用"}（${error.code}）`;
    }
  }
  return "操作失败：发生了未预期的问题";
}

/** A URL's origin, or nothing when the text is not an http(s) address at all. */
export function normalizedOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username !== "" || url.password !== "") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function defaultNewId(): string {
  const source = globalThis.crypto;
  if (typeof source.randomUUID === "function") return source.randomUUID();
  const bytes = new Uint8Array(16);
  source.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hasContent(text: string): boolean {
  return text.trim() !== "";
}

interface ControllerInternals {
  readonly client: Client;
  readonly storage: SelectionStorage;
  readonly initialBinding: string | null;
  readonly newId: () => string;
  readonly now: () => number;
  /** Called with the origin before a connection attempt reads it. */
  readonly onTarget: (origin: string | null) => void;
}

function createController(internals: ControllerInternals): ShellController {
  const { client, storage, newId, now, onTarget } = internals;

  // The one approval seam this shell registers: registered here, at
  // composition and once, never from a render or an effect. A handler
  // installed per render would be a second answer to the same question.
  installApprovalHandler();

  let state: ShellUiState = Object.freeze({
    bindingOrigin: internals.initialBinding,
    selection: storage.read(),
    creatingSession: false,
    startingRun: false,
    cancellingRunId: null,
    pluginPending: Object.freeze<Record<string, "enable" | "disable">>({}),
    historyLoading: false,
    sessionWrite: null,
    renameDraft: null,
    settingsPending: null,
    directoryLoading: false,
    directoryRefreshing: false,
    notices: Object.freeze([]) as readonly Notice[],
    unknownWrites: Object.freeze([]) as readonly UnknownWrite[],
    approvalWaiter: null,
  });
  const listeners = new Set<() => void>();
  let nextNumber = 0;

  function set(partial: Partial<ShellUiState>): void {
    state = Object.freeze({ ...state, ...partial });
    for (const listener of [...listeners]) listener();
  }

  /**
   * Adds one notice, replacing any earlier notice about the same subject.
   *
   * The key is the *subject* of a repeatable operation's result, not the text:
   * renaming one session eight times is eight answers to the same question, and
   * the eighth is the one that is true now. Two sessions' renames are two
   * subjects and keep their own rows — each result is shown exactly once, and a
   * row is only ever displaced by a newer result about the same thing.
   */
  function addNotice(tone: Notice["tone"], text: string, key: string | null = null): void {
    nextNumber += 1;
    const notice: Notice = Object.freeze({ id: `notice-${nextNumber}`, tone, text, key });
    const notices =
      key === null
        ? [...state.notices, notice]
        : state.notices.some((entry) => entry.key === key)
          ? state.notices.map((entry) => (entry.key === key ? notice : entry))
          : [...state.notices, notice];
    set({ notices: Object.freeze(notices.length > MAX_NOTICES ? notices.slice(notices.length - MAX_NOTICES) : notices) });
  }

  function recordUnknown(write: UnknownWrite): void {
    set({ unknownWrites: Object.freeze([...state.unknownWrites, write]) });
  }

  function unknownOf(id: string): UnknownWrite | undefined {
    return state.unknownWrites.find((write) => write.id === id);
  }

  function resolveUnknown(id: string): void {
    set({ unknownWrites: Object.freeze(state.unknownWrites.filter((write) => write.id !== id)) });
  }

  function newUnknownBase(hostInstanceId: string | null): UnknownWriteBase {
    nextNumber += 1;
    return {
      id: `unknown-${nextNumber}`,
      hostInstanceId,
      createdAt: now(),
    };
  }

  /**
   * Whether another ordinary write may be started.
   *
   * A shell that is already holding sixteen unresolved outcomes is not in a
   * position to be honest about a seventeenth; the user is asked to settle what
   * is open first. Safety controls — cancelling a run, answering an approval —
   * do not go through this gate, because refusing them would be worse than the
   * bookkeeping problem.
   */
  function unknownBudgetAvailable(): boolean {
    if (state.unknownWrites.length < MAX_UNKNOWN_WRITES) return true;
    addNotice(
      "error",
      `未确认的写操作已达上限（${MAX_UNKNOWN_WRITES}）：请先在待确认面板中确认或结束已有记录，再发起新的写操作。`,
    );
    return false;
  }

  /**
   * The open rename drafts, by session.
   *
   * At most one per session, and never more than the one the panel is showing:
   * a draft is a small record of "a rename was opened here, against this
   * revision", and the text lives in the panel.
   */
  const renameDrafts = new Map<string, { readonly expectedRevision: number; readonly hostInstanceId: string | null }>();

  function clearRenameDraft(sessionId: string, expectedRevision: number): void {
    const draft = renameDrafts.get(sessionId);
    if (draft === undefined || draft.expectedRevision !== expectedRevision) return;
    renameDrafts.delete(sessionId);
    set({ renameDraft: null });
  }

  function setSelection(selection: SessionSelection | null): void {
    storage.write(selection);
    set({ selection });
  }

  /**
   * Selects one session and asks the client to confirm it.
   *
   * The choice is the shell's; the read that follows is the client's, and the
   * pin it installs is what a write for this session will be gated on.
   */
  function focusSession(sessionId: string): void {
    const instance = presentationHostInstance(client.getSnapshot());
    if (instance === null) return;
    setSelection({ hostInstanceId: instance, sessionId });
    void client.directory.focus(sessionId).catch((error: unknown) => {
      addNotice("error", explainError(error));
    });
  }

  /**
   * The focus token of one session, as this client currently stands behind it.
   *
   * A write is aimed at the session *and* the connection state it was read in;
   * the pin's version is what says whether the facts the write was built from
   * are still the ones on screen.
   */
  function focusTokenOf(sessionId: string): { readonly version: number; readonly hostInstanceId: string } | null {
    const pin = client.getSnapshot().focusedSession;
    if (pin === null || pin.sessionId !== sessionId) return null;
    return { version: pin.focusVersion, hostInstanceId: pin.hostInstanceId };
  }

  function focusTokenCurrent(token: { readonly version: number; readonly hostInstanceId: string } | null): boolean {
    if (token === null) return false;
    const pin = client.getSnapshot().focusedSession;
    return pin !== null && pin.focusVersion === token.version && pin.hostInstanceId === token.hostInstanceId;
  }

  /** The session summary this client currently holds for one id, if any. */
  function summaryOf(sessionId: string): SessionSummary | null {
    const snapshot = client.getSnapshot();
    const pin = snapshot.focusedSession;
    if (pin !== null && pin.sessionId === sessionId) return pin.summary;
    return directoryOf(snapshot).items.find((session) => session.sessionId === sessionId) ?? null;
  }

  /**
   * The approval delivery this shell is holding, if any.
   *
   * One at a time by construction: a Host runs one execution at a time, and a
   * delivery that has ended is retired before a new one is installed. What is
   * kept is only what an answer needs — the token, the identities, the signal
   * and the resolver. What the Host decided is never kept here at all: it is
   * read from the snapshot, so this shell cannot show a decision it invented.
   */
  interface ApprovalDelivery {
    readonly token: number;
    readonly approvalId: string;
    readonly executionId: string;
    // eslint-disable-next-line no-undef
    readonly abort: AbortSignal;
    readonly resolve: (response: ToolApprovalResponse) => void;
    decided: boolean;
  }
  let approvalDelivery: ApprovalDelivery | null = null;
  let approvalTokens = 0;

  /** Retires the current delivery without deciding anything about it. */
  function retireApprovalDelivery(): void {
    if (approvalDelivery !== null) approvalDelivery.decided = true;
    approvalDelivery = null;
    set({ approvalWaiter: null });
  }

  /**
   * The typed handler: registered once, at composition, and never from a render.
   *
   * The Host's snapshot is the whole question — the tool, the exact input, the
   * deadline — and this promise is the whole answer. A delivery that ends
   * (reconnect, replaced stream, deadline, a new Host) aborts the signal; the
   * waiter is retired, and the *decision* it never made stays unmade: an ended
   * delivery is not a rejection.
   */
  function installApprovalHandler(): void {
    client.registerToolApprovalHandler((snapshot: ApprovalSnapshot, abort: AbortSignal) => {
      // A delivery that arrives while one is still live replaces it: the newer
      // question is the one this shell can answer.
      retireApprovalDelivery();
      approvalTokens += 1;
      const token = approvalTokens;

      return new Promise<ToolApprovalResponse>((resolve) => {
        const delivery: ApprovalDelivery = {
          token,
          approvalId: snapshot.approvalId,
          executionId: snapshot.executionId,
          abort,
          resolve,
          decided: false,
        };
        approvalDelivery = delivery;
        set({
          approvalWaiter: {
            token,
            approvalId: snapshot.approvalId,
            executionId: snapshot.executionId,
            decision: null,
          },
        });

        // The delivery's own end: only *this* token is cleared, so a stale
        // listener cannot retire the delivery that replaced it.
        abort.addEventListener(
          "abort",
          () => {
            if (approvalDelivery !== null && approvalDelivery.token === token) {
              approvalDelivery.decided = true;
              approvalDelivery = null;
              set({ approvalWaiter: null });
            }
          },
          { once: true },
        );
      });
    });
  }

  /** Whether the answer may still be treated as belonging to the host that received the request. */
  function sameHost(instance: string | null): boolean {
    const current = describedHostInstance(client.getSnapshot());
    return current !== null && instance !== null && current === instance;
  }

  async function classifyWriteFailure(error: unknown, record: () => UnknownWrite, unconfirmed: string): Promise<void> {
    if (error instanceof ClientError && error.outcome === "unknown") {
      recordUnknown(record());
      addNotice("error", unconfirmed);
      return;
    }
    addNotice("error", explainError(error));
  }

  /**
   * One history read, with the shell's own bookkeeping around it.
   *
   * The client records the page as loaded where the answer arrives; this only
   * tracks that a read is in flight and reports a refusal in the user's words. A
   * failed read changes nothing about what is loaded, and the gap it was meant
   * to fill stays visible.
   */
  async function loadPage(sessionId: string, params: { readonly cursor?: string }): Promise<void> {
    if (state.historyLoading) return;
    set({ historyLoading: true });
    try {
      await client.sessions.history({
        sessionId,
        ...(params.cursor === undefined ? {} : { cursor: params.cursor }),
      });
    } catch (error) {
      addNotice("error", explainError(error));
    } finally {
      set({ historyLoading: false });
    }
  }

  return {
    client,
    getState: (): ShellUiState => state,
    subscribe(listener: () => void): (() => void) {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },

    async connect(): Promise<void> {
      if (state.bindingOrigin === null) {
        addNotice("error", "尚未配置 Host 地址：请在上方填入后点击连接。");
        return;
      }
      onTarget(state.bindingOrigin);
      try {
        await client.connect();
      } catch (error) {
        addNotice("error", explainError(error));
      }
    },

    async connectTo(origin: string): Promise<void> {
      const normalized = normalizedOrigin(origin);
      if (normalized === null) {
        addNotice("error", `地址不是有效的 http(s) 源：${origin}`);
        return;
      }
      set({ bindingOrigin: normalized });
      onTarget(normalized);
      await this.connect();
    },

    async reconnect(): Promise<void> {
      if (state.bindingOrigin === null) {
        addNotice("error", "尚未配置 Host 地址。");
        return;
      }
      onTarget(state.bindingOrigin);
      try {
        await client.reconnect();
      } catch (error) {
        addNotice("error", explainError(error));
      }
    },

    disconnect(): void {
      client.disconnect();
    },

    async createSession(): Promise<void> {
      if (state.creatingSession) return;
      if (!unknownBudgetAvailable()) return;
      // The instance is captured before the call: an instance observed after a
      // failure is not evidence of where the request went.
      const instance = describedHostInstance(client.getSnapshot());
      // The selection the user had when the create started. A selection made
      // *while* the answer was in flight is theirs — the late answer must not
      // take it back, and with it the composer and the draft it holds.
      const selectionBefore = state.selection;
      set({ creatingSession: true });
      try {
        const { session } = await client.sessions.create();
        if (instance === null) return;
        if (state.selection === selectionBefore) {
          focusSession(session.sessionId);
        } else {
          addNotice("info", "新会话已创建；你已切换到其他会话，未自动切换选择。");
        }
      } catch (error) {
        await classifyWriteFailure(
          error,
          () => ({ ...newUnknownBase(instance), kind: "create-session" }),
          "新建会话的结果未确认：会话可能已经创建。不会自动重试；请刷新后在列表中确认。",
        );
      } finally {
        set({ creatingSession: false });
      }
    },

    selectSession(sessionId: string): void {
      // The client holds the facts; the shell only holds the choice. The read
      // this starts is what confirms the session, and whether it is confirmed
      // is what the write gate reads off the pin.
      focusSession(sessionId);
    },

    async ensureFocus(): Promise<void> {
      const selection = state.selection;
      if (selection === null) return;
      const snapshot = client.getSnapshot();
      if (snapshot.status !== "ready" || snapshot.presentationHost !== "current") return;
      const pin = snapshot.focusedSession;
      const current =
        pin !== null &&
        pin.sessionId === selection.sessionId &&
        pin.hostInstanceId === selection.hostInstanceId &&
        pin.confirmed;
      if (current) return;
      try {
        await client.directory.focus(selection.sessionId);
      } catch (error) {
        // A selection the host no longer has is not an error worth shouting
        // about: the directory simply does not show it, and the shell keeps the
        // rest of the page usable.
        if (!(error instanceof ClientError && error.code === "SESSION_NOT_FOUND")) {
          addNotice("error", explainError(error));
        }
      }
    },

    beginRename(sessionId: string): void {
      const snapshot = client.getSnapshot();
      const pin = snapshot.focusedSession;
      if (pin === null || pin.sessionId !== sessionId || !pin.confirmed) {
        addNotice("error", "该会话尚未在当前连接上确认：请先刷新，再重命名。");
        return;
      }
      const summary = summaryOf(sessionId);
      if (summary === null) {
        addNotice("error", "该会话当前不在已加载的目录中：请先重新读取目录。");
        return;
      }
      renameDrafts.set(sessionId, {
        expectedRevision: summary.metadataRevision,
        hostInstanceId: pin.hostInstanceId,
      });
      set({ renameDraft: { sessionId, expectedRevision: summary.metadataRevision } });
    },

    cancelRename(): void {
      renameDrafts.clear();
      set({ renameDraft: null });
    },

    async loadOlderSessions(): Promise<void> {
      if (state.directoryLoading || state.directoryRefreshing) return;
      set({ directoryLoading: true });
      try {
        const step = await client.directory.loadOlder();
        if (step.stale) {
          addNotice("info", "目录版本已经变化：请点击「重新读取目录」，再从新的头部继续加载更早会话。");
        }
      } catch (error) {
        addNotice("error", explainError(error));
      } finally {
        set({ directoryLoading: false });
      }
    },

    async refreshDirectory(): Promise<void> {
      if (state.directoryLoading || state.directoryRefreshing) return;
      set({ directoryRefreshing: true });
      try {
        await client.directory.refreshHead();
      } catch (error) {
        addNotice("error", explainError(error));
      } finally {
        set({ directoryRefreshing: false });
      }
    },

    async startRun(sessionId: string, text: string): Promise<boolean> {
      if (state.startingRun) return false;
      if (!hasContent(text)) {
        addNotice("error", "输入不能为空。");
        return false;
      }
      if (!unknownBudgetAvailable()) return false;
      const instance = describedHostInstance(client.getSnapshot());
      const submissionId = newId();
      set({ startingRun: true });
      try {
        await client.runs.start({ sessionId, submissionId, text });
        return true;
      } catch (error) {
        if (error instanceof ClientError && error.outcome === "unknown") {
          recordUnknown({ ...newUnknownBase(instance), kind: "start", sessionId, submissionId, text });
          addNotice("error", "提交结果未确认：可能已被接受并执行。不会自动重发；可在待确认面板中查询。");
          return true;
        }
        addNotice("error", explainError(error));
        return false;
      } finally {
        set({ startingRun: false });
      }
    },

    /**
     * Renames one session against the revision its draft was opened at.
     *
     * The draft is the panel's and stays the panel's: this sends what it was
     * given and never patches a title optimistically. The revision it compares
     * against is the one captured when the form was opened — never one read at
     * submit time, which would let a rename that arrived in between be
     * overwritten in silence. A conflict is a definite refusal, and the answer
     * to it is the user's: the draft stays, the host's current title and
     * revision are shown, and a new attempt needs a new draft against the new
     * revision. A lost answer is recorded as unconfirmed, because a rename that
     * may have landed is exactly the kind of fact this shell may not round off.
     */
    async renameSession(sessionId: string, title: string): Promise<boolean> {
      if (state.sessionWrite !== null) return false;
      const trimmed = title.trim();
      if (trimmed === "") {
        addNotice("error", "标题不能为空。");
        return false;
      }
      const draft = renameDrafts.get(sessionId);
      if (draft === undefined) {
        addNotice("error", "重命名草稿已失效：请重新打开重命名（标题将以打开时的会话版本为准）。");
        return false;
      }
      const summary = summaryOf(sessionId);
      if (summary === null) {
        addNotice("error", "该会话当前不在已加载的目录中：请先重新读取目录。");
        return false;
      }
      if (!unknownBudgetAvailable()) return false;
      const instance = describedHostInstance(client.getSnapshot());
      const token = focusTokenOf(sessionId);
      // The captured revision, not the one on screen now: a concurrent change
      // is the host's to refuse, not this shell's to overwrite.
      const expectedRevision = draft.expectedRevision;
      set({ sessionWrite: { kind: "rename", sessionId } });
      try {
        await client.sessions.rename({ sessionId, expectedRevision, title: trimmed });
        clearRenameDraft(sessionId, expectedRevision);
        // The notice names the session it reports on — the fact is about *this*
        // session's title, and a sentence that could belong to any rename is
        // how two of them came to look like one repeated twice.
        if (focusTokenCurrent(token)) {
          addNotice(
            "info",
            `会话「${trimmed}」的标题已保存（Host 已确认）。该会话的其余事实以 Host 为准。`,
            `session:${sessionId}:rename`,
          );
        }
        return true;
      } catch (error) {
        if (error instanceof ClientError && error.code === "REVISION_CONFLICT") {
          const current = summaryOf(sessionId);
          addNotice(
            "error",
            `Host 上的会话版本已经变化（当前订正 ${String(current?.metadataRevision ?? "未知")}，草稿基于 ${String(expectedRevision)}）：草稿保留；请刷新后重新打开重命名，以新版本为准提交。不会自动重试。`,
          );
          return false;
        }
        if (error instanceof ClientError && error.outcome !== "unknown") {
          addNotice("error", explainError(error));
          return false;
        }
        recordUnknown({
          ...newUnknownBase(instance),
          kind: "rename-session",
          sessionId,
          expectedRevision,
          title: trimmed,
        });
        addNotice(
          "error",
          `会话「${trimmed}」的重命名结果未确认：标题可能已经改变。不会自动重试；请在待确认面板中查询。`,
          `session:${sessionId}:rename`,
        );
        return true;
      } finally {
        set({ sessionWrite: null });
      }
    },

    /**
     * Deletes one session permanently, against the revision the reader saw.
     *
     * There is no cancellation and no trash: the confirmation the user answered
     * was about an irreversible act, and a host that refused — a conflict, a
     * busy host, a session that already moved on — is answered as a refusal.
     * This shell never turns "delete was refused" into "cancel the run and try
     * again"; the only thing that changes an active run is the user.
     */
    async deleteSession(sessionId: string): Promise<boolean> {
      if (state.sessionWrite !== null) return false;
      const summary = summaryOf(sessionId);
      if (summary === null) {
        addNotice("error", "该会话当前不在已加载的目录中：请先重新读取目录。");
        return false;
      }
      if (!unknownBudgetAvailable()) return false;
      const instance = describedHostInstance(client.getSnapshot());
      const expectedRevision = summary.metadataRevision;
      set({ sessionWrite: { kind: "delete", sessionId } });
      try {
        await client.sessions.delete({ sessionId, expectedRevision });
        // The deletion is the host's confirmed fact: the selection it described
        // is over, and nothing here re-selects another session in its place.
        if (state.selection !== null && state.selection.sessionId === sessionId) setSelection(null);
        // Only the focus that is still *this* session's is retired: a reader who
        // selected another session while the deletion was in flight keeps it.
        client.directory.clearFocusIf(sessionId);
        addNotice(
          "info",
          `会话已被 Host 永久删除（「${summary.title}」）；这不会撤销已经发生的外部工具副作用。`,
          `session:${sessionId}:delete`,
        );
        return true;
      } catch (error) {
        if (error instanceof ClientError && error.code === "REVISION_CONFLICT") {
          addNotice("error", "Host 上的会话版本已经变化，删除被拒绝：请重新确认会话当前的状态。不会自动重试。");
          return false;
        }
        if (error instanceof ClientError && error.code === "HOST_BUSY") {
          addNotice("error", "Host 正忙（该会话仍有未结束的运行或执行）：不会自动取消运行，也不会在取消后自动删除。");
          return false;
        }
        if (error instanceof ClientError && error.code === "SESSION_NOT_FOUND") {
          addNotice("info", "该会话在 Host 上已经不存在：它可能已经被删除。");
          return false;
        }
        if (error instanceof ClientError && error.outcome !== "unknown") {
          addNotice("error", explainError(error));
          return false;
        }
        recordUnknown({
          ...newUnknownBase(instance),
          kind: "delete-session",
          sessionId,
          expectedRevision,
        });
        addNotice(
          "error",
          `会话「${summary.title}」的删除结果未确认：它可能已经被永久删除，也可能仍然存在。不会自动重试；请在待确认面板中查询。`,
          `session:${sessionId}:delete`,
        );
        return true;
      } finally {
        set({ sessionWrite: null });
      }
    },

    async cancelRun(runId: string): Promise<void> {
      if (state.cancellingRunId !== null) return;
      const instance = describedHostInstance(client.getSnapshot());
      set({ cancellingRunId: runId });
      try {
        await client.runs.cancel({ runId });
      } catch (error) {
        await classifyWriteFailure(
          error,
          () => ({ ...newUnknownBase(instance), kind: "cancel", runId }),
          "取消请求的结果未确认：运行可能仍在继续。可在待确认面板中查询其状态。",
        );
      } finally {
        set({ cancellingRunId: null });
      }
    },

    async setPluginEnabled(pluginId: string, enabled: boolean): Promise<void> {
      if (pluginPendingOf(state.pluginPending, pluginId) !== undefined) return;
      if (!unknownBudgetAvailable()) return;
      const instance = describedHostInstance(client.getSnapshot());
      const operation = enabled ? "enable" : "disable";
      set({ pluginPending: Object.freeze({ ...state.pluginPending, [pluginId]: operation }) });
      try {
        const params = { pluginId };
        if (enabled) {
          await client.plugins.enable(params);
        } else {
          await client.plugins.disable(params);
        }
      } catch (error) {
        await classifyWriteFailure(
          error,
          () => ({ ...newUnknownBase(instance), kind: "plugin", pluginId, operation }),
          "插件操作的结果未确认：插件状态可能已经改变。不会自动重试；请刷新后查看真实状态。",
        );
      } finally {
        const pluginPending = { ...state.pluginPending };
        delete pluginPending[pluginId];
        set({ pluginPending: Object.freeze(pluginPending) });
      }
    },

    respondApproval(decision: ToolApprovalDecision): void {
      const delivery = approvalDelivery;
      if (delivery === null || delivery.decided) return;
      // The click re-checks the whole question: this shell may answer only
      // while the client can still deliver, and only about the approval on
      // screen. Anything else is a stale click, and a stale click decides
      // nothing.
      const snapshot = client.getSnapshot();
      const approval = snapshot.presentation?.approval ?? null;
      if (!snapshot.approvalCanRespond) return;
      if (approval === null) return;
      if (approval.approvalId !== delivery.approvalId || approval.executionId !== delivery.executionId) return;

      // Consumed once: the second click finds this delivery already decided.
      delivery.decided = true;
      set({
        approvalWaiter: {
          token: delivery.token,
          approvalId: delivery.approvalId,
          executionId: delivery.executionId,
          decision,
        },
      });
      delivery.resolve({ approvalId: delivery.approvalId, executionId: delivery.executionId, decision });
    },

    async checkUnknown(unknownId: string): Promise<void> {
      const write = unknownOf(unknownId);
      if (write === undefined) return;

      if (write.kind === "create-session" || write.kind === "plugin") {
        await this.refresh();
        addNotice("info", "已刷新：请按当前状态确认该操作的真实结果，然后关闭提示。");
        return;
      }

      if (!sameHost(write.hostInstanceId)) {
        addNotice("error", "Host 已更换，无法确认该操作；不会在新 Host 上自动重跑。");
        return;
      }

      try {
        switch (write.kind) {
          case "start": {
            const { run } = await client.runs.get({ submissionId: write.submissionId });
            resolveUnknown(write.id);
            addNotice("info", `已确认：这次提交已被 Host 接受（run ${run.runId}，状态 ${run.status}）。`);
            return;
          }
          case "cancel": {
            const { run } = await client.runs.get({ runId: write.runId });
            resolveUnknown(write.id);
            addNotice(
              "info",
              run.cancelRequested
                ? `已确认：取消请求已被记录；运行当前状态为 ${run.status}。`
                : `已确认：运行当前状态为 ${run.status}，取消请求未被记录。`,
            );
            return;
          }
          case "rename-session": {
            const { session } = await client.sessions.get({ sessionId: write.sessionId });
            // The causal question — did *my* rename land? — is answered by the
            // facts: a title the write asked for, at a revision at or beyond
            // the one it was aimed at. Anything else is "not confirmed", and
            // the current host state is shown alongside it without being read
            // as the write's outcome.
            resolveUnknown(write.id);
            addNotice(
              "info",
              session.title === write.title
                ? `已确认：该会话当前标题就是「${write.title}」。`
                : `该会话当前标题为「${session.title}」；原来的重命名请求结果仍未确认。`,
            );
            return;
          }
          case "delete-session": {
            const { session } = await client.sessions.get({ sessionId: write.sessionId });
            resolveUnknown(write.id);
            addNotice(
              "info",
              `该会话仍然存在（标题「${session.title}」）：原来的删除请求结果仍未确认。`,
            );
            return;
          }
          case "settings-update": {
            const { settings } = await client.settings.get({ namespace: write.namespace });
            resolveUnknown(write.id);
            addNotice(
              "info",
              `已读取当前设置：命名空间 ${settings.namespace} 的期望修订为 ${settings.desiredRevision}，本实例生效修订为 ${
                settings.effectiveRevision === null ? "未应用" : String(settings.effectiveRevision)
              }。原来的保存请求结果仍未确认。`,
            );
            return;
          }
        }
      } catch (error) {
        if (error instanceof ClientError && error.code === "SESSION_NOT_FOUND" && write.kind === "delete-session") {
          resolveUnknown(write.id);
          addNotice("info", "该会话在 Host 上已经不存在：删除请求可能已经生效（也可能是其他原因删除）。");
          return;
        }
        if (error instanceof ClientError && error.code === "SESSION_NOT_FOUND" && write.kind === "rename-session") {
          resolveUnknown(write.id);
          addNotice("info", "该会话在 Host 上已经不存在：无法再确认这次重命名。");
          return;
        }
        if (error instanceof ClientError && error.code === "RUN_NOT_FOUND" && write.kind === "start") {
          addNotice("info", "当前未找到这次提交：它可能没有被 Host 接受。结果仍待确认，可稍后再次查询。");
          return;
        }
        addNotice("error", explainError(error));
      }
    },

    async resubmitUnknownStart(unknownId: string): Promise<void> {
      const write = unknownOf(unknownId);
      if (write === undefined || write.kind !== "start") return;
      if (!sameHost(write.hostInstanceId)) {
        addNotice("error", "Host 已更换，不会重发这次提交。");
        return;
      }
      try {
        await client.runs.start({ sessionId: write.sessionId, submissionId: write.submissionId, text: write.text });
        resolveUnknown(write.id);
        addNotice("info", "已重新提交同一次提交：Host 的去重记录让它只会执行一次。");
      } catch (error) {
        if (error instanceof ClientError && error.code === "SUBMISSION_CONFLICT") {
          addNotice("error", "Host 报告该提交标识与不同内容冲突；这次提交的结果仍未确认。");
          return;
        }
        addNotice("error", explainError(error));
      }
    },

    async ensureHistory(sessionId: string): Promise<void> {
      const snapshot = client.getSnapshot();
      const coverage = Object.hasOwn(snapshot.history, sessionId) ? snapshot.history[sessionId] : undefined;
      if (coverage !== undefined && !coverage.behind) return;
      // A coverage that has fallen behind the committed high-water is read
      // again from the newest end: a later page inside the old fence would stop
      // before the new turns, and stitching two fences would present a
      // conversation nobody read.
      if (coverage !== undefined && coverage.behind) {
        await this.reloadHistory(sessionId);
        return;
      }
      await loadPage(sessionId, {});
    },

    /**
     * Reads one settings namespace whole.
     *
     * The panel shows the host's own snapshot — desired and effective revisions
     * with their values — and this is the only way it obtains one: a
     * `settings.updated` event says a revision moved and never carries a value.
     */
    async readSettings(namespace: string): Promise<void> {
      if (state.settingsPending !== null) return;
      set({ settingsPending: { namespace, operation: "read" } });
      try {
        await client.settings.get({ namespace });
      } catch (error) {
        addNotice("error", explainError(error));
      } finally {
        set({ settingsPending: null });
      }
    },

    /**
     * Saves one namespace against the revision it was read at.
     *
     * A full replacement, never a patch: what the panel collected is the whole
     * value. The host answers `REVISION_CONFLICT` when something else moved
     * first — a definite refusal, and the panel says so without replaying the
     * save. An answer that never arrives is an unconfirmed write, and the way
     * to learn what happened is a read.
     */
    async saveSettings(namespace: string, value: JsonValue, expectedRevision: number): Promise<SettingsSaveOutcome> {
      if (state.settingsPending !== null) return Object.freeze({ kind: "refused", reason: "busy" });
      if (!unknownBudgetAvailable()) return Object.freeze({ kind: "refused", reason: "capacity" });
      const instance = describedHostInstance(client.getSnapshot());
      set({ settingsPending: { namespace, operation: "save" } });
      try {
        await client.settings.update({ namespace, expectedRevision, value });
        addNotice(
          "info",
          `命名空间 ${namespace} 的设置已保存（desired）。它不会立即生效：需要重启 Host 进程后再读取确认。`,
          `settings:${namespace}:save`,
        );
        return Object.freeze({ kind: "confirmed" });
      } catch (error) {
        if (error instanceof ClientError && error.code === "REVISION_CONFLICT") {
          addNotice("error", "Host 上的设置版本已经变化：保存被拒绝。请先读取最新设置，再决定是否重新保存。不会自动重试。");
          return Object.freeze({ kind: "refused", reason: "revision-conflict" });
        }
        if (error instanceof ClientError && error.outcome !== "unknown") {
          addNotice("error", explainError(error));
          return Object.freeze({ kind: "refused", reason: String(error.code) });
        }
        recordUnknown({
          ...newUnknownBase(instance),
          kind: "settings-update",
          namespace,
          expectedRevision,
          summary: settingsSummaryOf(value),
        });
        addNotice(
          "error",
          `设置（${namespace}）的保存结果未确认：desired 可能已经改变。不会自动重发；请读取当前设置确认。`,
          `settings:${namespace}:save`,
        );
        return Object.freeze({ kind: "unknown" });
      } finally {
        set({ settingsPending: null });
      }
    },

    async loadOlderHistory(sessionId: string): Promise<void> {
      const snapshot = client.getSnapshot();
      const coverage = Object.hasOwn(snapshot.history, sessionId) ? snapshot.history[sessionId] : undefined;
      if (coverage === undefined || coverage.nextCursor === null) return;
      await loadPage(sessionId, { cursor: coverage.nextCursor });
    },

    async reloadHistory(sessionId: string): Promise<void> {
      await loadPage(sessionId, {});
    },

    async refresh(): Promise<void> {
      try {
        await client.resync();
      } catch (error) {
        addNotice("error", explainError(error));
      }
    },

    dismissUnknown(unknownId: string): void {
      resolveUnknown(unknownId);
    },

    dismissNotice(noticeId: string): void {
      set({ notices: Object.freeze(state.notices.filter((notice) => notice.id !== noticeId)) });
    },
  };
}

/** The real composition: this is `createShellControllerWith` plus a client of its own. */
export function createShellController(options: ComposedShellControllerOptions): ShellController {
  const target: { origin: string | null } = { origin: null };
  const client = createClient({
    connect: async (): Promise<ProtocolChannel> => {
      const origin = target.origin;
      if (origin === null) throw new Error("no host address is configured");
      return options.connector(origin);
    },
  });
  return createController({
    client,
    storage: options.storage,
    initialBinding: options.initialBinding,
    newId: options.newId ?? defaultNewId,
    now: options.now ?? Date.now,
    onTarget: (origin: string | null): void => {
      target.origin = origin;
    },
  });
}

/** The seam a test composes with: the same controller over any client. */
export function createShellControllerWith(
  client: Client,
  options: ShellControllerOptions & { readonly newId?: () => string; readonly now?: () => number },
): ShellController {
  return createController({
    client,
    storage: options.storage,
    initialBinding: options.initialBinding,
    newId: options.newId ?? defaultNewId,
    now: options.now ?? Date.now,
    onTarget: (): void => undefined,
  });
}
