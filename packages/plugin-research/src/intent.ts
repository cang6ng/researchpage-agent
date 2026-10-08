/**
 * Intent Discovery: how a seed topic becomes a research direction a *person*
 * has confirmed.
 *
 * The rule this module exists to keep is that the model may propose a direction
 * and may never confirm one. A proposal is stored as a proposal — with the
 * session's own turn-by-turn conversation beside it — and only an explicit user
 * confirmation moves it into `confirmedDirection`. Everything downstream reads
 * that confirmed object, so "the research topic was decided by the user" is a
 * fact in the record rather than a sentence in a prompt.
 *
 * The conversation is deliberately not a questionnaire. What is stored is what
 * happened: the user's messages, the questions the assistant asked, the options
 * it offered, and the decisions it understood — each decision quoting the user's
 * own words as its basis, so a wrong understanding can be corrected by reading
 * the record rather than by trusting a summary.
 */

import type { BriefFieldName, BriefFieldState } from "./domain.js";
import { BRIEF_FIELDS } from "./domain.js";
import type { DocumentView } from "./documents.js";

/** How far the conversation has got, and whether anyone has decided. */
export type IntentStatus = "exploring" | "ready_to_confirm" | "confirmed";

export const INTENT_STATUS_LABELS: Readonly<Record<IntentStatus, string>> = Object.freeze({
  exploring: "了解中",
  ready_to_confirm: "方向待确认",
  confirmed: "方向已确认",
});

/** One turn of the conversation, as it happened. */
export interface IntentTurn {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly at: string;
  readonly text: string;
  /** Assistant turns: why this question is worth answering. */
  readonly why?: string;
  /** Assistant turns: ready-made answers the user may pick instead of typing. */
  readonly options?: readonly string[];
  /** Assistant turns that carry a direction proposal. */
  readonly proposesDirection?: boolean;
  /** User turns: the documents attached when the message was sent. */
  readonly documentIds?: readonly string[];
}

/**
 * Something the assistant understood the user to have decided.
 *
 * It is a restatement, and it is stored as one: the value is one sentence the
 * assistant wrote, and `basedOn` is the user's own message it came from. It
 * exists so the conversation can show「我这样理解你的回答」and be corrected —
 * never so that a model's summary can become a brief field. Only a confirmed
 * direction writes anything into the research card.
 */
export interface IntentDecision {
  readonly id: string;
  /** Which brief field this settles, when it settles one of them. */
  readonly field: BriefFieldName | null;
  readonly value: string;
  /** The user's own words this was read from. */
  readonly basedOn: string;
  readonly at: string;
}

export interface DirectionSubject {
  readonly name: string;
  readonly note?: string;
}

export interface DirectionDimension {
  readonly name: string;
  readonly question: string;
}

/**
 * A proposed research direction: the four things the user is asked to confirm.
 *
 * `topic` / `purpose` / `scope` are the direction itself — what is asked, what
 * for, and how far it reaches. Everything after them is a suggestion the model
 * may offer and the user may accept, edit or ignore; the card treats the
 * objects and dimensions here as proposals, not as decisions, because that is
 * exactly what they are.
 */
export interface ResearchDirection {
  readonly topic: string;
  readonly purpose: string;
  /** How far the research reaches, in one paragraph. */
  readonly scope: string;
  readonly audience: string;
  readonly focus: readonly string[];
  readonly exclusions: string;
  readonly lengthTarget: string;
  /** Suggested comparison objects; the card keeps them, marked as suggestions. */
  readonly subjects: readonly DirectionSubject[];
  /** Suggested research dimensions. */
  readonly dimensions: readonly DirectionDimension[];
  /** The assistant's own summary: 「我理解你的研究方向是……」. */
  readonly summary: string;
  readonly at: string;
  /** Who wrote this version: the agent's proposal, or the user's edit of it. */
  readonly source: "agent" | "user";
}

/**
 * The persistent fact of an intent exploration.
 *
 * `sessionId` is the host session it belongs to, and it is the binding the
 * product trusts: a request that carries an intent id still has to match the
 * session, so one conversation cannot be answered from another's page. Absent
 * `taskId` means the card has not been created yet — which is the normal state
 * for a document uploaded before any task exists, and the reason documents are
 * attached to the session rather than to a task.
 */
export interface IntentDraft {
  readonly id: string;
  readonly sessionId: string;
  readonly seedTopic: string;
  readonly status: IntentStatus;
  readonly turns: readonly IntentTurn[];
  readonly decisions: readonly IntentDecision[];
  /** The current proposal; `null` until the assistant offers one. */
  readonly proposal: ResearchDirection | null;
  readonly documentIds: readonly string[];
  readonly confirmedDirection: ResearchDirection | null;
  readonly confirmedAt: string | null;
  /** Bumped by every accepted change; the token a stale writer is refused by. */
  readonly version: number;
  /** The task this exploration produced, once the card exists. */
  readonly taskId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The sentence the product shows next to a proposal, to ask for confirmation. */
export const DIRECTION_CONFIRM_QUESTION = "我理解你的研究方向是上面这些，是否准确？可以确认开始，也可以改题目或调整范围。";

/** How many turns one conversation keeps; enough to read back, bounded. */
export const MAX_INTENT_TURNS = 60;
export const MAX_INTENT_MESSAGE_CHARS = 4_000;
export const MAX_INTENT_QUESTION_CHARS = 800;
export const MAX_INTENT_SUMMARY_CHARS = 1_200;
export const MAX_INTENT_OPTIONS = 5;
export const MAX_INTENT_OPTION_CHARS = 200;
export const MAX_INTENT_DECISIONS = 24;
export const MAX_DIRECTION_SUBJECTS = 4;
export const MAX_DIRECTION_DIMENSIONS = 6;
export const MAX_DIRECTION_FOCUS = 8;

export function createIntentDraft(input: {
  readonly id: string;
  readonly sessionId: string;
  readonly seedTopic: string;
  readonly documentIds?: readonly string[];
  readonly now: string;
}): IntentDraft {
  return {
    id: input.id,
    sessionId: input.sessionId,
    seedTopic: input.seedTopic,
    status: "exploring",
    turns: [],
    decisions: [],
    proposal: null,
    documentIds: input.documentIds ?? [],
    confirmedDirection: null,
    confirmedAt: null,
    version: 1,
    taskId: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function textArray(value: unknown, limit: number, maxChars: number): readonly string[] {
  if (!Array.isArray(value)) return [];
  const items: string[] = [];
  for (const entry of value) {
    const text = asText(entry);
    if (text.length === 0) continue;
    items.push(text.slice(0, maxChars));
    if (items.length >= limit) break;
  }
  return items;
}

export interface DirectionReading {
  readonly ok: boolean;
  readonly direction: ResearchDirection | null;
  readonly problems: readonly string[];
}

/**
 * Reads a proposed direction into the stored shape, refusing what cannot be
 * confirmed.
 *
 * A direction has to be specific enough to research *before* it is offered for
 * confirmation: a topic, a purpose and a scope. Offering the user「确认一个还不
 * 存在的方向」would make the confirmation meaningless, so the three required
 * fields are enforced here rather than at confirmation time.
 */
export function readDirection(input: unknown, options: { readonly at: string; readonly source: "agent" | "user"; readonly previous?: ResearchDirection | null }): DirectionReading {
  const record = asRecord(input);
  const problems: string[] = [];
  if (record === undefined) return { ok: false, direction: null, problems: ["研究方向必须是一个对象"] };

  const previous = options.previous ?? null;
  const text = (key: keyof ResearchDirection, fallback: string): string => {
    const direct = asText(record[key]);
    if (direct.length > 0) return direct;
    return fallback;
  };

  const topic = text("topic", previous?.topic ?? "").slice(0, 200);
  const purpose = text("purpose", previous?.purpose ?? "");
  const scope = text("scope", previous?.scope ?? "");
  const audience = asText(record["audience"]) || (previous?.audience ?? "");
  const exclusions = asText(record["exclusions"]) || (previous?.exclusions ?? "");
  const lengthTarget = asText(record["lengthTarget"]) || (previous?.lengthTarget ?? "");
  const summary = asText(record["summary"]) || (previous?.summary ?? "");

  if (topic.length < 2) problems.push("研究方向必须给出正式题目（topic）");
  if (purpose.length === 0) problems.push("研究方向必须写明研究目的或要回答的问题（purpose）");
  if (scope.length === 0) problems.push("研究方向必须写明大致研究范围（scope）");
  if (summary.length === 0) problems.push("研究方向必须给出一段总结（summary），说明你理解的研究方向");

  const focus = record["focus"] === undefined ? (previous?.focus ?? []) : textArray(record["focus"], MAX_DIRECTION_FOCUS, 120);
  const subjects = readSubjects(record["subjects"], previous);
  const dimensions = readDimensions(record["dimensions"], previous);
  if (subjects.length > MAX_DIRECTION_SUBJECTS) problems.push(`研究对象建议最多 ${MAX_DIRECTION_SUBJECTS} 个`);
  if (dimensions.length > MAX_DIRECTION_DIMENSIONS) problems.push(`研究维度建议最多 ${MAX_DIRECTION_DIMENSIONS} 个`);

  if (problems.length > 0) return { ok: false, direction: null, problems };
  return {
    ok: true,
    problems: [],
    direction: {
      topic,
      purpose: purpose.slice(0, MAX_INTENT_SUMMARY_CHARS),
      scope: scope.slice(0, MAX_INTENT_SUMMARY_CHARS),
      audience: audience.slice(0, 300),
      focus,
      exclusions: exclusions.slice(0, 600),
      lengthTarget: lengthTarget.slice(0, 120),
      subjects,
      dimensions,
      summary: summary.slice(0, MAX_INTENT_SUMMARY_CHARS),
      at: options.at,
      source: options.source,
    },
  };
}

function readSubjects(value: unknown, previous: ResearchDirection | null): readonly DirectionSubject[] {
  if (value === undefined) return previous?.subjects ?? [];
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const subjects: DirectionSubject[] = [];
  for (const entry of value) {
    const name = typeof entry === "string" ? entry.trim() : asText(asRecord(entry)?.["name"]);
    if (name.length === 0 || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const note = typeof entry === "string" ? "" : asText(asRecord(entry)?.["note"]);
    subjects.push(note.length === 0 ? { name } : { name, note });
    if (subjects.length >= MAX_DIRECTION_SUBJECTS) break;
  }
  return subjects;
}

function readDimensions(value: unknown, previous: ResearchDirection | null): readonly DirectionDimension[] {
  if (value === undefined) return previous?.dimensions ?? [];
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const dimensions: DirectionDimension[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const name = typeof entry === "string" ? entry.trim() : asText(record?.["name"]);
    const question = typeof entry === "string" ? "" : asText(record?.["question"]);
    if (name.length === 0 || question.length === 0 || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    dimensions.push({ name, question });
    if (dimensions.length >= MAX_DIRECTION_DIMENSIONS) break;
  }
  return dimensions;
}

/** A shape a person can check: what was proposed, and how far it reaches. */
export function directionSummaryLine(direction: ResearchDirection): string {
  const subjects = direction.subjects.map((subject) => subject.name).join("、");
  const dimensions = direction.dimensions.map((dimension) => dimension.name).join("、");
  return [
    `题目：${direction.topic}`,
    `目的：${direction.purpose}`,
    `范围：${direction.scope}`,
    subjects.length === 0 ? "" : `研究对象建议：${subjects}`,
    dimensions.length === 0 ? "" : `研究维度建议：${dimensions}`,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

/**
 * What a confirmed direction settles, field by field.
 *
 * The confirmation act covers everything the direction actually states: it is
 * the user saying「这就是我要研究的」. A field the direction left empty is *not*
 * settled — the guide still has a real question to ask about it — and the
 * suggested objects and dimensions are not settled either: they were offered as
 * suggestions, the user approved the direction rather than each name, and the
 * card marks them as what they are.
 */
export interface ConfirmedBriefFacts {
  readonly topic: string;
  readonly purpose: string;
  readonly audience: string;
  readonly focus: readonly string[];
  readonly exclusions: string;
  readonly lengthTarget: string;
  readonly fieldStates: Readonly<Partial<Record<BriefFieldName, BriefFieldState>>>;
}

export function confirmedBriefFacts(direction: ResearchDirection): ConfirmedBriefFacts {
  const fieldStates: Partial<Record<BriefFieldName, BriefFieldState>> = {
    topic: "confirmed",
    purpose: "confirmed",
  };
  if (direction.audience.length > 0) fieldStates.audience = "confirmed";
  if (direction.focus.length > 0) fieldStates.focus = "confirmed";
  if (direction.exclusions.length > 0) fieldStates.exclusions = "confirmed";
  if (direction.lengthTarget.length > 0) fieldStates.lengthTarget = "confirmed";
  return {
    topic: direction.topic,
    purpose: direction.purpose,
    audience: direction.audience,
    focus: direction.focus,
    exclusions: direction.exclusions,
    lengthTarget: direction.lengthTarget,
    fieldStates,
  };
}

/** The brief fields a confirmed direction left open, in the brief's own order. */
export function fieldsLeftOpen(direction: ResearchDirection): readonly BriefFieldName[] {
  const facts = confirmedBriefFacts(direction);
  return BRIEF_FIELDS.filter((field) => facts.fieldStates[field] === undefined);
}

/**
 * The user asking for the direction, in their own words.
 *
 * When this is what the last message says, the conversation is over as far as
 * the product is concerned: asking one more question would be the assistant
 * deciding the user has not said enough, and that is the user's call. The
 * markers are deliberately few and readable — a user who wants to keep talking
 * says so, and a refusal that lands wrong costs one sentence while a
 * questionnaire that cannot be stopped costs the product's whole premise.
 */
const DIRECTION_REQUEST_MARKERS: readonly RegExp[] = Object.freeze([
  /给出.{0,8}(方向|方案|主题|题目)/,
  /(方向|方案|主题|题目).{0,8}(给出|定下来|定了)/,
  /确认.{0,4}(方向|方案|主题|题目)/,
  /(别再问|不要再问|不用再问|别问了)/,
  /(可以了|差不多了|就这些|足够了|够了)/,
]);

export function asksForDirection(text: string): boolean {
  const value = text.trim();
  return value.length > 0 && DIRECTION_REQUEST_MARKERS.some((marker) => marker.test(value));
}

/** The last thing the user said, as far as the conversation record knows. */
export function lastUserMessage(intent: IntentDraft): string {
  for (let index = intent.turns.length - 1; index >= 0; index -= 1) {
    const turn = intent.turns[index];
    if (turn !== undefined && turn.role === "user") return turn.text;
  }
  return "";
}

/** Bounds one user message, before it enters the conversation. */
export function readIntentMessage(value: unknown): { readonly ok: boolean; readonly text: string; readonly problem: string } {
  const text = asText(value);
  if (text.length === 0) return { ok: false, text: "", problem: "消息不能为空" };
  if (text.length > MAX_INTENT_MESSAGE_CHARS) {
    return { ok: false, text, problem: `消息过长（上限 ${MAX_INTENT_MESSAGE_CHARS} 字）` };
  }
  return { ok: true, text, problem: "" };
}

/** Bounds one assistant question, before it enters the conversation. */
export function readIntentQuestion(input: unknown): {
  readonly ok: boolean;
  readonly question: string;
  readonly why: string;
  readonly options: readonly string[];
  readonly decisions: readonly { readonly field: BriefFieldName | null; readonly value: string; readonly basedOn: string }[];
  readonly problems: readonly string[];
} {
  const record = asRecord(input);
  const empty = { ok: false, question: "", why: "", options: [], decisions: [], problems: [] as string[] };
  if (record === undefined) return { ...empty, problems: ["question 必须是一个对象"] };
  const question = asText(record["question"]).slice(0, MAX_INTENT_QUESTION_CHARS);
  const why = asText(record["whyThisMatters"]).slice(0, 300);
  if (question.length === 0) return { ...empty, problems: ["question 不能为空"] };
  if (/<[a-z][^>]*>/i.test(question)) return { ...empty, problems: ["question 不能包含 HTML 标签"] };
  const options = textArray(record["options"], MAX_INTENT_OPTIONS, MAX_INTENT_OPTION_CHARS);

  const decisions: { field: BriefFieldName | null; value: string; basedOn: string }[] = [];
  const raw = record["decisions"];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const item = asRecord(entry);
      if (item === undefined) continue;
      const value = asText(item["value"]).slice(0, 400);
      const basedOn = asText(item["basedOn"]).slice(0, 600);
      if (value.length === 0 || basedOn.length === 0) continue;
      const field = typeof item["field"] === "string" && (BRIEF_FIELDS as readonly string[]).includes(item["field"])
        ? (item["field"] as BriefFieldName)
        : null;
      decisions.push({ field, value, basedOn });
      if (decisions.length >= MAX_INTENT_DECISIONS) break;
    }
  }
  return { ok: true, question, why, options, decisions, problems: [] };
}

/** One decision as the model wrote it, with its provenance filled in here. */
export interface IntentDecisionInput {
  readonly field: BriefFieldName | null;
  readonly value: string;
  readonly basedOn: string;
}

/** How many messages a turn-by-turn reading shows by default. */
export const INTENT_VIEW_TURNS = 40;

/**
 * What the workspace reads about one intent exploration.
 *
 * `pending` is the question waiting for an answer, and it is derived rather
 * than stored: it is the last turn when that turn is the assistant's. A page
 * that was refreshed mid-conversation therefore asks the same question it was
 * showing, and a page that asked one while a stage is still writing gets
 * `null` — which is the truth: nobody has asked anything yet.
 */
export interface IntentView {
  readonly intentId: string;
  readonly sessionId: string;
  readonly seedTopic: string;
  readonly status: IntentStatus;
  readonly statusLabel: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly taskId: string | null;
  readonly turns: readonly IntentTurn[];
  readonly decisions: readonly IntentDecision[];
  readonly proposal: ResearchDirection | null;
  readonly proposalSummary: string | null;
  readonly confirmedDirection: ResearchDirection | null;
  readonly confirmedAt: string | null;
  readonly documents: readonly DocumentView[];
  readonly pending: {
    readonly turnId: string;
    readonly text: string;
    readonly why: string;
    readonly options: readonly string[];
    readonly proposesDirection: boolean;
  } | null;
  /** Whether the user can confirm a direction right now. */
  readonly canConfirm: boolean;
  /** What to say when a direction is on the table. */
  readonly confirmQuestion: string;
  /** The brief fields this direction still leaves open, in the brief's order. */
  readonly openFields: readonly BriefFieldName[];
  /** The user's own messages, newest last — the short form of the record. */
  readonly userMessages: readonly string[];
  /**
   * The questions the assistant asked, newest last.
   *
   * A direction proposal is not one of them: it is the assistant answering the
   * question the user asked («给我一个方向»), and counting it as a question
   * would make「模型又问了几轮」unreadable from the record.
   */
  readonly assistantQuestions: readonly string[];
}

export function intentViewOf(
  intent: IntentDraft,
  documents: readonly DocumentView[] = [],
  turnsShown = INTENT_VIEW_TURNS,
): IntentView {
  const shown = intent.turns.slice(-turnsShown);
  const last = shown[shown.length - 1];
  const direction = intent.confirmedDirection ?? intent.proposal;
  return {
    intentId: intent.id,
    sessionId: intent.sessionId,
    seedTopic: intent.seedTopic,
    status: intent.status,
    statusLabel: INTENT_STATUS_LABELS[intent.status],
    version: intent.version,
    createdAt: intent.createdAt,
    updatedAt: intent.updatedAt,
    taskId: intent.taskId,
    turns: shown,
    decisions: intent.decisions,
    proposal: intent.proposal,
    proposalSummary: intent.proposal === null ? null : directionSummaryLine(intent.proposal),
    confirmedDirection: intent.confirmedDirection,
    confirmedAt: intent.confirmedAt,
    documents,
    pending:
      last === undefined || last.role !== "assistant"
        ? null
        : {
            turnId: last.id,
            text: last.text,
            why: last.why ?? "",
            options: last.options ?? [],
            proposesDirection: last.proposesDirection === true,
          },
    canConfirm: intent.confirmedAt === null && intent.proposal !== null,
    confirmQuestion: DIRECTION_CONFIRM_QUESTION,
    openFields: intent.confirmedAt !== null ? [] : direction === null ? [] : fieldsLeftOpen(direction),
    userMessages: intent.turns.filter((turn) => turn.role === "user").map((turn) => turn.text),
    assistantQuestions: intent.turns
      .filter((turn) => turn.role === "assistant" && turn.proposesDirection !== true)
      .map((turn) => turn.text),
  };
}
