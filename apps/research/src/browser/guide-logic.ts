/**
 * Guided planning, read as the conversation it already is.
 *
 * The guided session is stored as decisions, not as messages: every question
 * the application wrote, what it said before asking it, and what the person
 * answered. A transcript is therefore derived rather than remembered — which is
 * why refreshing the page rebuilds the same conversation, and why the page
 * never keeps a conversation of its own that could drift from the brief.
 *
 * Two things live here rather than in the panel: the derivation itself, so the
 * order and the wording of a turn can be tested without a browser, and the one
 * state the panel has to recover from on its own — the application asking for
 * another question and not getting one. That recovery is bounded by
 * `guideStalled`, which names the exact situation (and the exact brief it was
 * true for) so a retry cannot repeat forever.
 */

import type { BriefFieldName, BriefView, GuideDecisionView, GuideOptionView } from "./api.js";

/** One turn of the guided conversation, whoever said it. */
export interface GuideMessage {
  readonly id: string;
  readonly role: "assistant" | "user";
  /** Assistant: the transition into the question, in the model's own words. */
  readonly leadIn: string;
  /** Assistant: the question, or the closing statement. */
  readonly question: string;
  /** Assistant: the options of the *live* question, answerable right now. */
  readonly options: readonly GuideOptionView[];
  /** User: what they picked, in the words they saw. */
  readonly selectedOptionLabels: readonly string[];
  /** User: what they said, whether by choosing or by writing. */
  readonly answerText: string;
  /** Assistant: which fields the answer written before this one set. */
  readonly appliedFields: readonly BriefFieldName[];
  /** Which fields this turn was about, for the receipt's own label. */
  readonly fieldTargets: readonly BriefFieldName[];
  readonly at: string;
  /** The one turn that can be answered: the application's live question. */
  readonly answerable: boolean;
  /** Assistant: the closing turn, when the plan is as specific as it needs to be. */
  readonly closing: boolean;
}

/**
 * What the reader said, in the words they saw saying it.
 *
 * A choice is recorded as its label and a written answer as its text; an older
 * decision may carry neither, because the wording was not stored then, and is
 * derived from the labels the storage it does have points at.
 */
export function answerTextOf(decision: GuideDecisionView): string {
  if (decision.answerText.length > 0) return decision.answerText;
  if (decision.selectedOptionLabels.length > 0) return decision.selectedOptionLabels.join("、");
  if (decision.freeText.length > 0) return decision.freeText;
  return "（这个决定没有留下文字）";
}

/**
 * The conversation so far: every decision as a pair of turns, then whatever the
 * application is asking now.
 *
 * Order is the record's order, because that is the order the person lived it.
 * The live question is one assistant turn with answerable options; a closed
 * session ends with the application's own sentence instead of a question.
 */
export function guideTranscript(brief: BriefView): readonly GuideMessage[] {
  const messages: GuideMessage[] = [];
  for (const decision of brief.guide.decisions) {
    messages.push({
      id: `${decision.questionId}-a`,
      role: "assistant",
      leadIn: decision.leadIn,
      question: decision.question,
      options: [],
      selectedOptionLabels: [],
      answerText: "",
      appliedFields: [],
      fieldTargets: decision.fieldTargets,
      at: decision.at,
      answerable: false,
      closing: false,
    });
    messages.push({
      id: `${decision.questionId}-u`,
      role: "user",
      leadIn: "",
      question: "",
      options: [],
      selectedOptionLabels: decision.selectedOptionLabels,
      answerText: answerTextOf(decision),
      appliedFields: decision.appliedFields,
      fieldTargets: decision.fieldTargets,
      at: decision.at,
      answerable: false,
      closing: false,
    });
  }
  const active = brief.guide.active;
  if (active !== null) {
    messages.push({
      id: `${active.questionId}-a`,
      role: "assistant",
      leadIn: active.leadIn,
      question: active.question,
      options: active.options,
      selectedOptionLabels: [],
      answerText: "",
      appliedFields: [],
      fieldTargets: active.fieldTargets,
      at: active.createdAt,
      answerable: true,
      closing: false,
    });
  } else if (brief.guide.complete) {
    messages.push({
      id: `${brief.taskId}-closed`,
      role: "assistant",
      leadIn: "",
      question: brief.guide.reason.length > 0 ? brief.guide.reason : "没有更值得追问的决策了。",
      options: [],
      selectedOptionLabels: [],
      answerText: "",
      appliedFields: [],
      fieldTargets: [],
      at: brief.updatedAt ?? "",
      answerable: false,
      closing: true,
    });
  }
  return messages;
}

/**
 * How deep the guided session is, said the way the two bounds actually work.
 *
 * The floor is a promise the agent cannot break and the reader can ignore; the
 * ceiling is where the application stops asking. Below the floor the sentence
 * is about what is still owed; at or above it, about the two ways out.
 */
export function guideProgress(brief: BriefView): {
  readonly readiness: number;
  readonly min: number;
  readonly max: number;
  readonly reached: boolean;
  readonly atCeiling: boolean;
  readonly label: string;
  readonly note: string;
} {
  const { readiness } = brief.guide;
  const min = brief.guide.minDecisions;
  const max = brief.guide.maxDecisions;
  if (readiness < min) {
    return {
      readiness,
      min,
      max,
      reached: false,
      atCeiling: false,
      label: `关键决策 ${String(readiness)} / 至少 ${String(min)}`,
      note: "这些问题由程序选题、助手写题；还没到下限之前，助手不能自作主张结束。",
    };
  }
  return {
    readiness,
    min,
    max,
    reached: true,
    atCeiling: readiness >= max,
    label: `关键决策 ${String(readiness)}`,
    note:
      readiness >= max
        ? "已经问到上限：方案够清楚就确认，剩下的细节可以确认之后再改。"
        : "方案已经足够清楚时可以开始研究，也可以继续完善。",
  };
}

/** A shared opening line for a session the application has not started asking yet. */
export function guideIntro(brief: BriefView): string {
  const subjects = brief.subjects.length;
  const dimensions = brief.dimensions.length;
  return [
    `当前这份简报已经有 ${String(subjects)} 个比较对象、${String(dimensions)} 个研究维度。`,
    "接下来我会一次只问你一个真正有区分度的问题，答案直接写进同一份简报。",
  ].join("");
}

/** The one-line summary of what the plan now says, for the closing turn. */
export function guideSummaryItems(brief: BriefView): readonly string[] {
  const items = [`${String(brief.subjects.length)} 个比较对象`, `${String(brief.dimensions.length)} 个研究维度`];
  if (brief.lengthTarget.length > 0) items.push(`篇幅 ${brief.lengthTarget}`);
  if (brief.audience.length > 0) items.push(`读者：${brief.audience}`);
  return items;
}

/**
 * The state the panel has to recover from by itself.
 *
 * It is not the same as "waiting": it is what the application looks like after
 * a question run ended without leaving a question behind — the model tried to
 * close the session below the floor and was refused, and the run had nothing
 * else to say. Two conditions make it exact rather than a guess. A question run
 * has to have *happened* (`settledGuideRuns > 0`), which is what separates this
 * from the idle session nobody has started, and nothing may be in flight. The
 * key names the exact brief it was true for, so the panel retries this state
 * once and never again for the same one — a retry that fails leaves a state
 * whose key has already been spent.
 */
export function guideStalled(brief: BriefView, busy: boolean, settledGuideRuns: number): string | null {
  if (brief.readonly || brief.guide.complete || brief.guide.active !== null || busy) return null;
  if (settledGuideRuns <= 0) return null;
  return `${brief.taskId}:${String(brief.version)}:${String(brief.guide.readiness)}`;
}

/**
 * The reader's own way out, and why it is closed when it is.
 *
 * The floor bounds the agent, not the person: a valid draft can be started at
 * any depth. An invalid one cannot, and the reason has to be visible rather
 * than only disabling a button.
 */
export function guideConfirmState(brief: BriefView): { readonly enabled: boolean; readonly reason: string } {
  if (brief.readonly) return { enabled: false, reason: "这份简报已经确认过了。" };
  if (brief.canConfirm) return { enabled: true, reason: "" };
  const problems = brief.validation.problems;
  return {
    enabled: false,
    reason: problems.length === 0 ? "简报还有没补齐的地方。" : `还不能开始：${problems.join("；")}`,
  };
}

/** The fields a decision wrote, in the order the application recorded them. */
export function appliedFieldNames(decision: GuideDecisionView): string {
  return decision.appliedFields.join("、");
}
