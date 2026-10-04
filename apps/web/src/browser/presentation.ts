/**
 * What the shell derives from a client snapshot, as plain functions.
 *
 * Everything in this module is a pure read: it never asks a client for
 * anything, never changes a snapshot, and never assumes a fact the protocol did
 * not publish. The distinction the shell must keep is the one the platform
 * keeps — canonical history is what the host published, live items are what the
 * active run is showing, and a terminal run's draft is gone — so the two are
 * derived separately and never folded into one another here.
 */

import type { ClientSnapshot, DirectoryView, FocusedSession, HistoryCoverage, HistoryFacts, PresentationHost } from "@every-dagent/client";
import { directoryView, historyFacts } from "@every-dagent/client";
import type {
  ActiveRunSnapshot,
  DisplayInput,
  HostDescription,
  PluginFailureSummary,
  PluginSummary,
  ProtocolError,
  RunStatus,
  RunSummary,
  SessionSummary,
} from "@every-dagent/protocol";

import type { SessionSelection } from "./selection.js";
import type { UnknownWrite } from "./controller.js";

/** The host instance that published the current presentation, if there is one. */
export function presentationHostInstance(snapshot: ClientSnapshot): string | null {
  return snapshot.presentation === null ? null : snapshot.presentation.hostInstanceId;
}

/** The host instance this connection described, if it has described one. */
export function describedHostInstance(snapshot: ClientSnapshot): string | null {
  return snapshot.description === null ? null : snapshot.description.hostInstanceId;
}

/**
 * What this client has read of the directory, as the shell renders it.
 *
 * The merged window is the live one plus the older pages this client walked
 * back through; `complete` is only ever true when that range really is the
 * whole collection at the revision it was read from.
 */
export function directoryOf(snapshot: ClientSnapshot): DirectoryView {
  return directoryView(snapshot.directory, snapshot.presentation?.sessions ?? null);
}

/**
 * The session the shell is looking at.
 *
 * The selection is the shell's, and the facts are the client's: a selected
 * session outside the live window is resolved through the focused pin — which
 * is also what says whether those facts were confirmed on this connection. A
 * selection that no pin matches falls back to the loaded window, so a selection
 * made before the confirmation read lands still shows what is already known.
 */
export function selectedSession(
  snapshot: ClientSnapshot,
  selection: SessionSelection | null,
): SessionSummary | null {
  if (selection === null) return null;
  const presentation = snapshot.presentation;
  if (presentation === null || presentation.hostInstanceId !== selection.hostInstanceId) return null;

  const pin = snapshot.focusedSession;
  if (pin !== null && pin.sessionId === selection.sessionId && pin.hostInstanceId === selection.hostInstanceId) {
    return pin.summary;
  }
  return directoryOf(snapshot).items.find((session) => session.sessionId === selection.sessionId) ?? null;
}

/** The focused pin for a selection, when the client is holding one. */
export function focusedPin(
  snapshot: ClientSnapshot,
  selection: SessionSelection | null,
): FocusedSession | null {
  const pin = snapshot.focusedSession;
  if (pin === null || selection === null) return null;
  if (pin.sessionId !== selection.sessionId || pin.hostInstanceId !== selection.hostInstanceId) return null;
  return pin;
}

/**
 * Whether a write aimed at one session may be offered at all.
 *
 * Two facts have to hold together. The connection has to be current — ready,
 * not stale, and presenting this host's own facts — and the client has to have
 * *confirmed* this session on this connection: a summary read from an older
 * directory page, or one that survived a reconnect, is a display fact until a
 * read says otherwise, and the shell will not send a write for it.
 */
export function focusedWritesAllowed(snapshot: ClientSnapshot, sessionId: string | null): boolean {
  if (!writesAllowed(snapshot)) return false;
  if (sessionId === null) return false;
  const pin = snapshot.focusedSession;
  return pin !== null && pin.sessionId === sessionId && pin.confirmed;
}

/**
 * What the shell may say about one session's loaded history.
 *
 * The strict reading is the client's (`historyFacts`); this adds the sentences a
 * reader needs, one per way the reading falls short — and no sentence at all
 * when it does not.
 */
export function historyOf(snapshot: ClientSnapshot, sessionId: string): HistoryCoverage | null {
  return Object.hasOwn(snapshot.history, sessionId) ? snapshot.history[sessionId] ?? null : null;
}

export interface HistoryReading {
  readonly facts: HistoryFacts;
  /** The sentences that describe how this reading falls short of the whole conversation. */
  readonly notes: readonly string[];
}

export function historyReading(
  snapshot: ClientSnapshot,
  session: SessionSummary | null,
  coverage: HistoryCoverage | null,
): HistoryReading {
  const facts = historyFacts(snapshot, session, coverage);
  const notes: string[] = [];
  if (facts.unloaded) return { facts, notes };
  if (facts.stale) {
    notes.push("这段已加载的历史来自另一个连接或另一个会话身份，仅供参考；读取当前历史请点「读取最新记录」。");
  }
  if (!facts.atStart) {
    notes.push("这还不是会话的开头：更早的记录仍在 Host 上（未加载 ≠ 不存在）。");
  }
  if (facts.gap) {
    notes.push("已加载的范围上下都还有未读取的记录：这是一段窗口，不是完整会话。");
  }
  if (!facts.atFence && !facts.gap) {
    notes.push("已加载的范围没有达到本次读取时的末尾位置（fence）：上方仍有未读取的记录。");
  }
  if (facts.fragment) {
    notes.push("已加载范围的边缘落在某一轮中间：这是一段片段，不是完整的轮次。");
  }
  if (facts.behind) {
    notes.push("Host 在读取之后又提交了新的记录：这里不会用实时内容补齐，请读取最新记录。");
  }
  if (facts.complete) {
    notes.push("已加载的记录覆盖了该会话当前的全部已提交历史。");
  }
  return { facts, notes };
}

/**
 * What the host promises about remembering things, in the host's own words.
 *
 * The one fact a reader has to be able to trust is whether a restart takes the
 * conversation with it — and the second half of that fact is what is *not*
 * resumable either way: live output, a pending approval and a prepared
 * execution are memory in every mode.
 */
export interface RetentionView {
  readonly durable: boolean;
  readonly headline: string;
  readonly details: readonly string[];
}

export function retentionView(description: HostDescription | null): RetentionView | null {
  if (description === null) return null;
  const durable = description.storage.retention === "durable";
  return {
    durable,
    headline: durable
      ? "存储：durable —— 已提交的会话与历史保存在持久存储中，Host 重启后可以重新读取。"
      : "存储：ephemeral —— 会话与历史只保留在当前 Host 进程的生命周期内，进程停止后不再存在。",
    details: [
      "实时输出、待审批与已准备好的执行不是可恢复状态：Host 重启后不会恢复执行，也不会保留旧审批。",
      durable
        ? "持久存储里的 Run 事实可以查询；但它只是记录，不是可以继续执行的凭据。"
        : "本模式不是持久模式：不要把这里的历史当作长期保存。",
    ],
  };
}

/**
 * A plugin's three facts, kept apart: what it was asked to be, what it is, and
 * whether a restart would change its configuration.
 */
export function pluginTruthNotes(plugin: PluginSummary): readonly string[] {
  const notes: string[] = [];
  const desired = plugin.desiredEnabled ? "启用" : "停用";
  notes.push(`期望（持久）：${desired}；实际状态：${plugin.status}。`);
  if (plugin.configRevision !== null) {
    const effective = plugin.effectiveConfigRevision ?? "未应用";
    notes.push(`配置修订：期望 ${plugin.configRevision}，本实例实际 ${String(effective)}。`);
  } else {
    notes.push("该插件没有配置契约。");
  }
  if (plugin.restartRequired) {
    notes.push("配置已保存但未生效：需要重启 Host 进程后才会应用。");
  }
  if (plugin.unavailable) {
    notes.push(
      plugin.status === "error"
        ? "该插件不可用：处于错误状态（没有自动重试或重置）。"
        : "该插件不可用：期望启用，但当前实例并未运行它。",
    );
  }
  if (plugin.desiredEnabled && plugin.status !== "enabled" && !plugin.restartRequired) {
    notes.push("期望与实际不一致：这是生命周期事实，不是配置待重启。");
  }
  return notes;
}

/**
 * Whether a settings draft still belongs to the host that is connected now.
 *
 * The draft's authority is the host instance it was read from. A revision is a
 * number *inside* one host's authority, so equal numbers on two hosts are not
 * the same base — comparing them would let one host's draft be written to
 * another. A draft that outlived its host must be re-based by the user, and
 * this is the question the panel asks before it offers to save.
 */
export function settingsAuthorityChanged(
  draftHostInstanceId: string | null,
  currentHostInstanceId: string | null,
): boolean {
  if (draftHostInstanceId === null) return true;
  return draftHostInstanceId !== currentHostInstanceId;
}

/** The host a run belongs to, as far as a pinned run summary can say. */
export function runSummaryView(run: RunSummary): RunView {
  return runView(run);
}

export interface UnknownWriteView {
  readonly title: string;
  readonly detail: string;
  /** Whether the shell can query the host about this write's outcome. */
  readonly checkable: boolean;
}

/** One unconfirmed write, as the panel shows it. */
export function unknownWriteView(write: UnknownWrite): UnknownWriteView {
  switch (write.kind) {
    case "start":
      return {
        title: "提交未确认",
        detail: `「${write.text}」的提交结果未知：Host 可能已经接受并执行。不会自动重发。`,
        checkable: true,
      };
    case "cancel":
      return { title: "取消未确认", detail: `运行 ${shortId(write.runId)} 的取消请求结果未知。`, checkable: true };
    case "create-session":
      return { title: "新建会话未确认", detail: "会话可能已经创建。刷新目录即可看到真实结果。", checkable: true };
    case "plugin":
      return {
        title: "插件操作未确认",
        detail: `插件 ${write.pluginId} 的${write.operation === "enable" ? "启用" : "停用"}结果未知，插件状态可能已经改变。`,
        checkable: true,
      };
    case "rename-session":
      return {
        title: "重命名未确认",
        detail: `会话标题可能已改为「${write.title}」。不会自动重试。`,
        checkable: true,
      };
    case "delete-session":
      return {
        title: "删除未确认",
        detail: "这次删除的结果未知：会话可能已经被永久删除，也可能没有。不会自动重试。",
        checkable: true,
      };
    case "settings-update":
      return {
        title: "设置保存未确认",
        detail: `命名空间 ${write.namespace} 的保存结果未知（${write.summary}）。不会自动重发；请读取当前设置确认。`,
        checkable: true,
      };
  }
}

/**
 * The live timeline of a session's active run, if this client is holding one.
 *
 * The timeline is not part of the directory and not part of history: a cut can
 * only say that a run exists, and the draft is fetched or streamed separately.
 * A session that points at a run whose draft has not arrived resolves to null —
 * the strip then shows the run's durable summary instead of an invented
 * timeline.
 */
export function activeRunOf(snapshot: ClientSnapshot, session: SessionSummary): ActiveRunSnapshot | null {
  if (session.activeRunId === null) return null;
  const run = Object.hasOwn(snapshot.live, session.activeRunId) ? snapshot.live[session.activeRunId] : undefined;
  if (run === undefined || run.sessionId !== session.sessionId) return null;
  return run.status === "accepted" || run.status === "running" ? run : null;
}

/** The most recently accepted run of a session, terminal or not. */
export function latestRunOf(snapshot: ClientSnapshot, sessionId: string): RunSummary | null {
  const runs = snapshot.presentation?.runs.items ?? [];
  let latest: RunSummary | null = null;
  for (const run of runs) {
    if (run.sessionId !== sessionId) continue;
    if (latest === null || run.acceptedAt >= latest.acceptedAt) latest = run;
  }
  return latest;
}

/** How many runs the host is currently executing, across all sessions. */
export function activeRunCount(snapshot: ClientSnapshot): number {
  const sessions = snapshot.presentation?.sessions.items ?? [];
  let count = 0;
  for (const session of sessions) {
    if (session.activeRunId !== null) count += 1;
  }
  return count;
}

/**
 * The gate the shell puts on its own write buttons.
 *
 * It is deliberately stricter than the client's: a write is offered only while
 * the connection is ready, the presentation is not stale, and the presented
 * facts belong to the described host. The host still enforces everything it
 * enforces; this only keeps the UI from making offers it cannot honour.
 */
export function writesAllowed(snapshot: ClientSnapshot): boolean {
  return snapshot.status === "ready" && !snapshot.stale && snapshot.presentationHost === "current";
}

export interface StatusView {
  readonly label: string;
  readonly tone: "neutral" | "active" | "ok" | "warn" | "error";
  readonly detail: string | null;
}

const PRESENTATION_HOST_NOTES: Readonly<Record<PresentationHost, string | null>> = Object.freeze({
  none: null,
  unconfirmed: "展示的内容尚未确认属于当前 Host。",
  current: null,
  previous: "展示的是上一个 Host 的内容，仅供参考。",
});

/** The connection chip and its explanation. */
export function connectionView(snapshot: ClientSnapshot): StatusView {
  const hostNote = PRESENTATION_HOST_NOTES[snapshot.presentationHost];
  const errorNote =
    snapshot.error === null ? null : `${snapshot.error.message}（${snapshot.error.code}）`;
  const hostAndError = [errorNote, hostNote].filter((note) => note !== null).join(" ");

  // Every status that can still display a presentation says what that
  // presentation is. A "正在同步" chip above a panel full of the previous
  // host's sessions — or of the last synchronized ones — would otherwise read
  // as if those facts had just been confirmed against the current host.
  const staleNote = snapshot.stale ? "展示的是最后一次同步的内容。" : null;
  const carried = [hostAndError, staleNote].filter((part) => part !== null && part !== "").join(" ");
  const carriedOrNone = carried === "" ? null : carried;

  switch (snapshot.status) {
    case "disconnected":
      return { label: "未连接", tone: "neutral", detail: carriedOrNone };
    case "connecting":
      return { label: "正在连接", tone: "active", detail: carriedOrNone };
    case "connected":
      return { label: "已连接（未同步）", tone: "active", detail: carriedOrNone };
    case "syncing":
      return { label: "正在同步", tone: "active", detail: carriedOrNone };
    case "ready":
      return snapshot.stale
        ? {
            label: "已就绪（展示已过期）",
            tone: "warn",
            detail:
              hostNote === null
                ? "展示的是最后一次同步的内容；写操作已停用。"
                : `${hostNote} 展示的是最后一次同步的内容；写操作已停用。`,
          }
        : { label: "已就绪", tone: "ok", detail: null };
    case "lost":
      return {
        label: "连接已断开",
        tone: "warn",
        detail: `${hostAndError === "" ? "" : `${hostAndError} `}展示的是最后一次同步的内容；运行不会被自动取消。`,
      };
    case "protocol-error":
      return {
        label: "协议错误（已停止）",
        tone: "error",
        detail: `${hostAndError === "" ? "" : `${hostAndError} `}客户端已关闭该连接，不会自动无限重试。`,
      };
  }
}

const RUN_STATUS_VIEWS: Readonly<Record<RunStatus, { readonly label: string; readonly tone: StatusView["tone"] }>> =
  Object.freeze({
    accepted: { label: "已接受（等待开始）", tone: "active" },
    running: { label: "运行中", tone: "active" },
    completed: { label: "已完成", tone: "ok" },
    limited: { label: "达到步数上限", tone: "warn" },
    cancelled: { label: "已取消", tone: "warn" },
    failed: { label: "失败", tone: "error" },
    interrupted: { label: "已中断（上一次 Host 未完成）", tone: "warn" },
  });

export interface RunView {
  readonly status: RunStatus;
  readonly label: string;
  readonly tone: StatusView["tone"];
  readonly error: ProtocolError | null;
  /** What the terminal state does *not* mean, phrased so it cannot sound like a rollback. */
  readonly note: string | null;
}

export function runView(run: RunSummary): RunView {
  const base = RUN_STATUS_VIEWS[run.status];
  let note: string | null = null;
  if (run.status === "limited") {
    note = "运行因达到最大步数而停止；这不是一次完整回答。";
  } else if (run.status === "cancelled") {
    note = "未记录的部分不会进入历史；已经执行过的工具不会因此回滚。";
  } else if (run.status === "failed") {
    note = "未记录的部分不会进入历史；已经执行过的工具不会因此回滚。";
  } else if (run.status === "interrupted") {
    note =
      run.executionKnowledge === "not-started"
        ? "上一次运行只记录到「已接受」，没有开始标记：可以确认它没有被执行。请重新提交。"
        : "上一次运行有开始标记但没有终态：无法确认是否已经产生副作用。该会话已阻塞，不会自动恢复执行。";
  }
  return {
    status: run.status,
    label: base.label,
    tone: base.tone,
    error: run.status === "failed" ? run.error : null,
    note,
  };
}

export interface DisplayInputView {
  readonly kind: "json" | "unavailable";
  readonly text: string;
}

/** A tool input, as text a page can show without interpreting it. */
export function displayInputView(input: DisplayInput): DisplayInputView {
  if (input.kind === "json") {
    return { kind: "json", text: JSON.stringify(input.value, null, 2) ?? "null" };
  }
  return { kind: "unavailable", text: "该输入无法表示为 JSON（Host 标记为 unavailable）。" };
}

export function formatClock(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** A short, display-only form of an opaque id. */
export function shortId(id: string): string {
  return id.length <= 8 ? id : id.slice(0, 8);
}

/** The failure summary of a plugin, as a single sentence. */
export function pluginFailureView(failure: PluginFailureSummary): string {
  const cleanup =
    failure.cleanupFailureCount > 0 ? `；另有 ${failure.cleanupFailureCount} 项清理失败` : "";
  return `最近一次${failure.operation === "enable" ? "启用" : "停用"}在 ${failure.phase} 阶段失败（${failure.code}）${cleanup}：${failure.message}`;
}
