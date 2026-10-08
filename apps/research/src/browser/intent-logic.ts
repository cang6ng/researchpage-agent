/**
 * What the exploration panel decides, as functions rather than as components.
 *
 * Every sentence here is a statement about the record the server keeps: whether
 * a button may be pressed given the status, the version and what is already
 * running; whether the editor holds an edit worth sending; and what the page
 * says while it waits for a card that does not exist yet. Keeping them out of
 * the component is what makes them answerable in a test — and they are the ones
 * that decide whether a user can accidentally confirm twice, overwrite a newer
 * direction with an older draft, or be told a card failed when it is merely
 * still being built.
 */

import type { DirectionPatch, IntentStatus, IntentView, ResearchDirectionView } from "./api.js";

/* ------------------------------------------------------------------ gate -- */

export interface Gate {
  readonly allowed: boolean;
  /** Why not, in the words the panel shows beside the control. */
  readonly reason: string;
}

const ALLOWED: Gate = Object.freeze({ allowed: true, reason: "" });

function refused(reason: string): Gate {
  return { allowed: false, reason };
}

/**
 * Whether a message may be sent.
 *
 * Two locks and nothing else: the server must not be running a turn for this
 * exploration, and this page must not have an action of its own in flight. A
 * confirmed exploration is refused because the conversation is over — its
 * direction is what the card was built from, and adding turns to it afterwards
 * would describe a project that no longer matches its own record.
 */
export function sendGateOf(input: {
  readonly status: IntentStatus;
  readonly serverBusy: boolean;
  readonly working: boolean;
  readonly text: string;
}): Gate {
  if (input.status === "confirmed") return refused("研究方向已确认，这段对话已经结束。");
  if (input.serverBusy) return refused("正在处理上一条消息，请等待这一轮结束。");
  if (input.working) return refused("上一步操作还没有结束。");
  if (input.text.trim().length === 0) return refused("请先写一句话再发送。");
  return ALLOWED;
}

/** Whether the direction editor's save may be pressed. */
export function saveDirectionGateOf(input: {
  readonly status: IntentStatus;
  readonly serverBusy: boolean;
  readonly working: boolean;
  readonly dirty: boolean;
}): Gate {
  if (input.status === "confirmed") return refused("方向已确认，不能再编辑。");
  if (!input.dirty) return refused("还没有改动。");
  if (input.serverBusy) return refused("正在处理上一轮，请稍后再保存。");
  if (input.working) return refused("上一步操作还没有结束。");
  return ALLOWED;
}

/**
 * Whether the direction may be confirmed.
 *
 * Four things have to hold at once, and each has its own sentence because they
 * have four different fixes: there has to be something to confirm, nothing may
 * be mid-air, the editor's draft has to be saved first (a confirmation whose
 * text is still only on screen would confirm a direction the user cannot see),
 * and no attachment chosen for this confirmation may still be converting.
 */
export function confirmGateOf(input: {
  readonly status: IntentStatus;
  readonly canConfirm: boolean;
  readonly serverBusy: boolean;
  readonly working: boolean;
  readonly dirty: boolean;
  readonly attachmentsBusy: boolean;
}): Gate {
  if (input.status === "confirmed") return refused("方向已经确认过了。");
  if (!input.canConfirm) return refused("助手还没有给出可确认的研究方向。");
  if (input.dirty) return refused("有未保存的改动：先保存方向，再确认。");
  if (input.attachmentsBusy) return refused("还有文件在上传或转换中，等它们入库后再确认。");
  if (input.serverBusy) return refused("正在处理上一轮，请等待结束后再确认。");
  if (input.working) return refused("上一步操作还没有结束。");
  return ALLOWED;
}

/* ---------------------------------------------------------------- editor -- */

/** The four fields the panel edits; everything else the proposal keeps as it is. */
export interface DirectionDraft {
  readonly topic: string;
  readonly purpose: string;
  readonly scope: string;
  readonly audience: string;
}

export const DIRECTION_DRAFT_FIELDS: readonly (keyof DirectionDraft)[] = ["topic", "purpose", "scope", "audience"];

export function directionDraftOf(direction: ResearchDirectionView | null): DirectionDraft {
  return {
    topic: direction?.topic ?? "",
    purpose: direction?.purpose ?? "",
    scope: direction?.scope ?? "",
    audience: direction?.audience ?? "",
  };
}

export function directionDraftChanged(before: DirectionDraft | null, after: DirectionDraft): boolean {
  if (before === null) return false;
  return DIRECTION_DRAFT_FIELDS.some((field) => before[field] !== after[field]);
}

/**
 * The patch an edit amounts to, or null when it amounts to nothing.
 *
 * Only the fields that changed are sent: an unchanged field is not a decision,
 * and sending the whole direction back would make every edit a rewrite of a
 * proposal the assistant wrote — including the parts of it the user never
 * looked at.
 */
export function directionPatchOf(before: DirectionDraft | null, after: DirectionDraft): DirectionPatch | null {
  if (before === null) return null;
  const patch: Record<string, string> = {};
  for (const field of DIRECTION_DRAFT_FIELDS) {
    if (before[field] !== after[field]) patch[field] = after[field];
  }
  if (Object.keys(patch).length === 0) return null;
  const { topic, purpose, scope, audience } = patch as Partial<DirectionDraft>;
  return {
    ...(topic === undefined ? {} : { topic }),
    ...(purpose === undefined ? {} : { purpose }),
    ...(scope === undefined ? {} : { scope }),
    ...(audience === undefined ? {} : { audience }),
  };
}

/* ------------------------------------------------------------- the wait -- */

/**
 * How long the page waits before it says the card has not arrived, in ms.
 *
 * A timeout here is a *page* statement, not a verdict about the server: the
 * card stage can be slow or two model calls can fail and be retried, and the
 * product has no route that reports either. What the page may say is that it
 * has waited this long and is still looking.
 */
export const TASK_WAIT_TIMEOUT_MS = 240_000;

/** After the timeout the page keeps looking, more slowly, until the user leaves. */
export const TASK_WAIT_SLOW_MS = 10_000;

/** The period the confirmation wait uses for its own two reads. */
export const TASK_WAIT_PERIOD_MS = 2_000;

export type TaskWaitPhase = "idle" | "waiting" | "slow" | "timeout";

export function taskWaitPhaseOf(input: { readonly confirmedAt: number | null; readonly now: number }): TaskWaitPhase {
  if (input.confirmedAt === null) return "idle";
  const waited = input.now - input.confirmedAt;
  if (waited >= TASK_WAIT_TIMEOUT_MS * 2) return "timeout";
  if (waited >= TASK_WAIT_TIMEOUT_MS) return "slow";
  return "waiting";
}

/** What the panel says while a confirmed direction has no card yet. */
export const TASK_WAIT_TEXTS: Readonly<Record<TaskWaitPhase, { readonly title: string; readonly body: string }>> =
  Object.freeze({
    idle: { title: "", body: "" },
    waiting: {
      title: "方向已确认，正在等待任务卡",
      body: "服务端正在用你确认的方向建立任务卡。任务卡出现之前不会开始检索。",
    },
    slow: {
      title: "任务卡还没有出现",
      body: "已经等待较长时间。页面仍在低频重试读取；你可以继续等待，也可以把这个方向留在这里稍后再来。",
    },
    timeout: {
      title: "尚未取得任务卡",
      body: "页面上方保存着已确认的方向。可以重新读取一次，或用这个方向新建一次探索——那会新建一段探索，不会删除这一段。",
    },
  });

/* ------------------------------------------------------------------- turn -- */

/**
 * The reference a user turn carries for the documents it was sent with.
 *
 * The message route only accepts ids of documents in this session that are
 * already in the library, so the panel offers exactly those and names them in
 * the turn. A file that is still converting has no id yet and is not offered.
 */
export function attachableDocumentsOf(intent: IntentView, selected: readonly string[]): readonly string[] {
  const ready = new Map(
    intent.documents
      .filter((document) => document.sessionId === intent.sessionId && document.status === "ready")
      .map((document) => [document.documentId, document] as const),
  );
  return selected.filter((id) => ready.has(id));
}

/** The documents a turn was sent with, as the library knows them today. */
export function documentsOfTurn(intent: IntentView, turnId: string): readonly string[] {
  const turn = intent.turns.find((candidate) => candidate.id === turnId);
  return turn?.documentIds ?? [];
}

/**
 * The library documents that arrived after the proposal was written.
 *
 * A PDF conversion can finish after the assistant proposed a direction, and a
 * direction written before a document existed cannot have read it. The page
 * says so instead of pretending otherwise: this is the list it names.
 */
export function documentsNewerThanProposal(intent: IntentView): readonly string[] {
  const proposal = intent.proposal ?? intent.confirmedDirection;
  if (proposal === null) return [];
  const at = Date.parse(proposal.at);
  if (Number.isNaN(at)) return [];
  return intent.documents
    .filter((document) => document.status === "ready" && Date.parse(document.createdAt) > at)
    .map((document) => document.documentId);
}
