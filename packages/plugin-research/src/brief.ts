/**
 * The Research Brief: the draft a task is before a person has confirmed it.
 *
 * The agent's `propose_task` produces a *complete default* — subjects,
 * dimensions, the question and the audience — and that card is not a take-it-
 * or-leave-it offer: an unconfirmed task is the draft, and both ways of working
 * on it (editing the fields directly, or answering one guided question at a
 * time) write to this one object. There is deliberately no second draft model:
 * two drafts would be two sources of truth, and the product's whole claim is
 * that the structure the user agreed to is the structure the research runs on.
 *
 * What lives here is the part that has to be decided by the program rather than
 * by a model: which fields a patch may touch, how ids stay stable across a
 * rename, what makes a draft complete enough to confirm, and which decision is
 * worth asking about next. The model writes the *question* in Guided Mode — it
 * does not get to choose the answer, the target, or the boundary of the patch.
 */

import type { BriefFieldName, BriefFieldState, BriefFieldStates, Dimension, ReportTask, ResearchSection, Subject } from "./domain.js";
import { BRIEF_FIELDS, lockedFieldStates } from "./domain.js";
import { blueprintById, TECHNICAL_COMPARISON_V2, type BlueprintSpec } from "./blueprint.js";
import { canonicalJson, hashOf } from "./hash.js";
import { slugId } from "./structure.js";

export type { BriefFieldName, BriefFieldState, BriefFieldStates };
export { BRIEF_FIELDS as EDITABLE_BRIEF_FIELDS, lockedFieldStates };

/**
 * The fields whose change reshapes the evidence matrix.
 *
 * Adding or removing a subject adds or removes rows; the same for a dimension
 * and columns. Renaming keeps the id, so a rename is not structural — but
 * reordering, adding and removing are, because the matrix cell set follows the
 * brief and a stale cell is not something this product is allowed to keep.
 */
export const STRUCTURAL_BRIEF_FIELDS: readonly BriefFieldName[] = Object.freeze(["subjects", "dimensions"]);

/** The version a draft with no recorded version is read as. */
export const INITIAL_BRIEF_VERSION = 1;

/** Upper bounds that keep one patch from producing an unusable matrix. */
export const MAX_BRIEF_SUBJECTS = 8;
export const MAX_BRIEF_DIMENSIONS = 12;
export const MAX_BRIEF_FOCUS = 12;

/** How many guided decisions this product will ask for before it stops. */
export const GUIDE_DECISION_LIMIT = 5;

export function briefVersionOf(task: ReportTask): number {
  return task.briefVersion ?? INITIAL_BRIEF_VERSION;
}

/**
 * The field states of a task, including the ones written before this existed.
 *
 * An old task that was already confirmed reads as fully confirmed — that *is*
 * what confirming it meant. An old task that was never confirmed reads as
 * `suggested`: nothing in the record says a person touched these fields, and
 * inventing a decision the user never made is exactly what this product must
 * not do.
 */
export function briefFieldStatesOf(task: ReportTask): BriefFieldStates {
  if (task.briefFieldStates !== undefined) return task.briefFieldStates;
  const fallback: BriefFieldState = task.confirmedAt === null ? "suggested" : "confirmed";
  const states: Record<string, BriefFieldState> = {};
  for (const field of BRIEF_FIELDS) states[field] = fallback;
  return states as BriefFieldStates;
}

/** A task's own blueprint, or the current one when the record predates them. */
export function briefBlueprintOf(task: ReportTask): BlueprintSpec {
  return blueprintById(task.blueprintId) ?? TECHNICAL_COMPARISON_V2;
}

/** The value a field holds, in the shape a patch would set it with. */
export function briefFieldValue(task: ReportTask, field: BriefFieldName): unknown {
  switch (field) {
    case "topic":
      return task.topic;
    case "purpose":
      return task.purpose;
    case "audience":
      return task.audience;
    case "focus":
      return task.focus;
    case "exclusions":
      return task.exclusions;
    case "lengthTarget":
      return task.lengthTarget;
    case "subjects":
      return task.subjects.map((subject) => ({ id: subject.id, name: subject.name, note: subject.note ?? "" }));
    case "dimensions":
      return task.dimensions.map((dimension) => ({ id: dimension.id, name: dimension.name, question: dimension.question }));
  }
}

/** The hash a guided question records, so a later answer can tell if it moved. */
export function briefFieldHash(task: ReportTask, field: BriefFieldName): string {
  return hashOf(briefFieldValue(task, field));
}

/** One line a reader can read, for the question generator and the API. */
export function briefFieldSummary(task: ReportTask, field: BriefFieldName): string {
  switch (field) {
    case "topic":
      return task.topic;
    case "purpose":
      return task.purpose;
    case "audience":
      return task.audience;
    case "focus":
      return task.focus.join("、");
    case "exclusions":
      return task.exclusions;
    case "lengthTarget":
      return task.lengthTarget;
    case "subjects":
      return task.subjects.map((subject) => subject.name).join("、");
    case "dimensions":
      return task.dimensions.map((dimension) => `${dimension.name}：${dimension.question}`).join("；");
  }
}

// ------------------------------------------------------------------- patches --

export interface BriefSubjectInput {
  readonly id?: string;
  readonly name: string;
  readonly note?: string;
}

export interface BriefDimensionInput {
  readonly id?: string;
  readonly name: string;
  readonly question: string;
}

/** A partial edit to the draft. Only the fields named here are touched. */
export interface BriefPatch {
  readonly topic?: string;
  readonly purpose?: string;
  readonly audience?: string;
  readonly focus?: readonly string[];
  readonly exclusions?: string;
  readonly lengthTarget?: string;
  readonly subjects?: readonly BriefSubjectInput[];
  readonly dimensions?: readonly BriefDimensionInput[];
}

export interface BriefPatchProblem {
  readonly problem: string;
}

export type BriefPatchReading =
  | { readonly ok: true; readonly patch: BriefPatch; readonly fields: readonly BriefFieldName[] }
  | { readonly ok: false; readonly problems: readonly BriefPatchProblem[] };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Reads a patch as the closed shape this product accepts, or refuses it.
 *
 * Everything here is a *structural* refusal — an unknown field name, a wrong
 * type, an id that belongs to nobody, a list past its bound — because those are
 * requests the server cannot honour at all. Whether the resulting draft is
 * complete is a different question, answered by `validateBriefDraft`: a draft
 * is allowed to be incomplete for a while, it is just not allowed to be
 * unreadable.
 */
export function readBriefPatch(value: unknown): BriefPatchReading {
  const record = asRecord(value);
  if (record === undefined) return { ok: false, problems: [{ problem: "patch 必须是一个对象" }] };

  const problems: BriefPatchProblem[] = [];
  for (const key of Object.keys(record)) {
    if (!(BRIEF_FIELDS as readonly string[]).includes(key)) {
      problems.push({ problem: `不允许通过 Brief 修改的字段：${key}` });
    }
  }

  const patch: Record<string, unknown> = {};
  const fields: BriefFieldName[] = [];

  for (const field of ["topic", "purpose", "audience", "exclusions", "lengthTarget"] as const) {
    if (!(field in record)) continue;
    const text = asText(record[field]);
    if (text === undefined) {
      problems.push({ problem: `${field} 必须是字符串` });
      continue;
    }
    patch[field] = text;
    fields.push(field);
  }

  if ("focus" in record) {
    const value2 = record["focus"];
    if (!Array.isArray(value2)) {
      problems.push({ problem: "focus 必须是字符串数组" });
    } else if (value2.some((item) => typeof item !== "string")) {
      problems.push({ problem: "focus 只能是字符串" });
    } else if (value2.length > MAX_BRIEF_FOCUS) {
      problems.push({ problem: `focus 最多 ${MAX_BRIEF_FOCUS} 项` });
    } else {
      patch["focus"] = (value2 as string[]).map((item) => item.trim()).filter((item) => item.length > 0);
      fields.push("focus");
    }
  }

  if ("subjects" in record) {
    const value2 = record["subjects"];
    if (!Array.isArray(value2)) {
      problems.push({ problem: "subjects 必须是数组" });
    } else if (value2.length > MAX_BRIEF_SUBJECTS) {
      problems.push({ problem: `比较对象最多 ${MAX_BRIEF_SUBJECTS} 个` });
    } else {
      const seen = new Set<string>();
      const entries: BriefSubjectInput[] = [];
      value2.forEach((item, index) => {
        const entry = asRecord(item);
        const name = entry === undefined ? undefined : asText(entry["name"]);
        if (entry === undefined || name === undefined) {
          problems.push({ problem: `subjects[${index}] 需要 name 字符串` });
          return;
        }
        const id = entry["id"] === undefined ? undefined : asText(entry["id"]);
        if (entry["id"] !== undefined && id === undefined) {
          problems.push({ problem: `subjects[${index}].id 必须是字符串` });
          return;
        }
        if (id !== undefined) {
          if (seen.has(id)) {
            problems.push({ problem: `subjects 中的 id 重复：${id}` });
            return;
          }
          seen.add(id);
        }
        const note = entry["note"] === undefined ? undefined : asText(entry["note"]);
        entries.push({
          ...(id === undefined ? {} : { id }),
          name,
          ...(note === undefined ? {} : { note }),
        });
      });
      if (problems.length === 0) {
        patch["subjects"] = entries;
        fields.push("subjects");
      }
    }
  }

  if ("dimensions" in record) {
    const value2 = record["dimensions"];
    if (!Array.isArray(value2)) {
      problems.push({ problem: "dimensions 必须是数组" });
    } else if (value2.length > MAX_BRIEF_DIMENSIONS) {
      problems.push({ problem: `研究维度最多 ${MAX_BRIEF_DIMENSIONS} 个` });
    } else {
      const seen = new Set<string>();
      const entries: BriefDimensionInput[] = [];
      value2.forEach((item, index) => {
        const entry = asRecord(item);
        const name = entry === undefined ? undefined : asText(entry["name"]);
        if (entry === undefined || name === undefined) {
          problems.push({ problem: `dimensions[${index}] 需要 name 字符串` });
          return;
        }
        const id = entry["id"] === undefined ? undefined : asText(entry["id"]);
        if (entry["id"] !== undefined && id === undefined) {
          problems.push({ problem: `dimensions[${index}].id 必须是字符串` });
          return;
        }
        if (id !== undefined) {
          if (seen.has(id)) {
            problems.push({ problem: `dimensions 中的 id 重复：${id}` });
            return;
          }
          seen.add(id);
        }
        const question = entry["question"] === undefined ? "" : asText(entry["question"]);
        if (question === undefined) {
          problems.push({ problem: `dimensions[${index}].question 必须是字符串` });
          return;
        }
        entries.push({ ...(id === undefined ? {} : { id }), name, question });
      });
      if (problems.length === 0) {
        patch["dimensions"] = entries;
        fields.push("dimensions");
      }
    }
  }

  if (problems.length > 0) return { ok: false, problems };
  if (fields.length === 0) return { ok: false, problems: [{ problem: "patch 没有包含任何字段" }] };
  return { ok: true, patch: patch as BriefPatch, fields };
}

/** The subjects a patch asks for, with existing ids kept and new ones minted. */
function applySubjects(
  current: readonly Subject[],
  entries: readonly BriefSubjectInput[],
  problems: BriefPatchProblem[],
): readonly Subject[] {
  const known = new Set(current.map((subject) => subject.id));
  const taken = new Set<string>();
  const next: Subject[] = [];
  entries.forEach((entry, index) => {
    if (entry.id !== undefined) {
      if (!known.has(entry.id)) {
        problems.push({ problem: `未知的比较对象 id：${entry.id}（新增对象请不要带 id，由服务端生成）` });
        return;
      }
      if (taken.has(entry.id)) {
        problems.push({ problem: `比较对象 id 重复：${entry.id}` });
        return;
      }
      taken.add(entry.id);
      next.push({
        id: entry.id,
        name: entry.name.trim(),
        ...(entry.note === undefined || entry.note.trim() === "" ? {} : { note: entry.note.trim() }),
      });
      return;
    }
    const id = uniqueId("sub", entry.name, index, taken);
    taken.add(id);
    next.push({
      id,
      name: entry.name.trim(),
      ...(entry.note === undefined || entry.note.trim() === "" ? {} : { note: entry.note.trim() }),
    });
  });
  return next;
}

/** The dimensions a patch asks for, with existing ids kept and new ones minted. */
function applyDimensions(
  current: readonly Dimension[],
  entries: readonly BriefDimensionInput[],
  problems: BriefPatchProblem[],
): readonly Dimension[] {
  const known = new Set(current.map((dimension) => dimension.id));
  const taken = new Set<string>();
  const next: Dimension[] = [];
  entries.forEach((entry, index) => {
    if (entry.id !== undefined) {
      if (!known.has(entry.id)) {
        problems.push({ problem: `未知的研究维度 id：${entry.id}（新增维度请不要带 id，由服务端生成）` });
        return;
      }
      if (taken.has(entry.id)) {
        problems.push({ problem: `研究维度 id 重复：${entry.id}` });
        return;
      }
      taken.add(entry.id);
      next.push({ id: entry.id, name: entry.name.trim(), question: entry.question.trim() });
      return;
    }
    const id = uniqueId("dim", entry.name, index, taken);
    taken.add(id);
    next.push({ id, name: entry.name.trim(), question: entry.question.trim() });
  });
  return next;
}

/** A slug id that is not already used, so two new rows never share one. */
function uniqueId(prefix: string, name: string, index: number, taken: ReadonlySet<string>): string {
  const base = slugId(prefix, name, index);
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${base}_${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}_${index + 1}`;
}

export interface BriefApplication {
  readonly topic: string;
  readonly purpose: string;
  readonly audience: string;
  readonly focus: readonly string[];
  readonly exclusions: string;
  readonly lengthTarget: string;
  readonly subjects: readonly Subject[];
  readonly dimensions: readonly Dimension[];
}

export type BriefApplyResult =
  | { readonly ok: true; readonly value: BriefApplication; readonly fields: readonly BriefFieldName[] }
  | { readonly ok: false; readonly problems: readonly BriefPatchProblem[] };

/**
 * Applies a patch to a task's brief fields, without writing anything.
 *
 * The result is the *whole* set of brief fields, so a caller cannot half-apply
 * a patch: either the new list of subjects is the one the task will hold, or
 * the call is refused. Ids come from the existing draft when the patch names
 * one and are minted by the server otherwise, which is what keeps a rename from
 * silently orphaning a matrix row.
 */
export function applyBriefPatch(task: ReportTask, patch: BriefPatch): BriefApplyResult {
  const problems: BriefPatchProblem[] = [];
  const fields: BriefFieldName[] = [];

  const text = (field: "topic" | "purpose" | "audience" | "exclusions" | "lengthTarget", current: string): string => {
    if (patch[field] === undefined) return current;
    fields.push(field);
    return (patch[field] as string).trim();
  };

  const topic = text("topic", task.topic);
  const purpose = text("purpose", task.purpose);
  const audience = text("audience", task.audience);
  const exclusions = text("exclusions", task.exclusions);
  const lengthTarget = text("lengthTarget", task.lengthTarget);

  let focus = task.focus;
  if (patch.focus !== undefined) {
    const seen = new Set<string>();
    const items: string[] = [];
    for (const item of patch.focus) {
      const value = item.trim();
      if (value.length === 0) continue;
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(value);
    }
    focus = items;
    fields.push("focus");
  }

  let subjects = task.subjects;
  if (patch.subjects !== undefined) {
    subjects = applySubjects(task.subjects, patch.subjects, problems);
    fields.push("subjects");
  }

  let dimensions = task.dimensions;
  if (patch.dimensions !== undefined) {
    dimensions = applyDimensions(task.dimensions, patch.dimensions, problems);
    fields.push("dimensions");
  }

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, value: { topic, purpose, audience, focus, exclusions, lengthTarget, subjects, dimensions }, fields };
}

/** The task with an applied patch, ready to be written back. */
export function briefWithApplication(task: ReportTask, value: BriefApplication): ReportTask {
  return { ...task, ...value };
}

// ---------------------------------------------------------------- validation --

export interface BriefValidation {
  readonly valid: boolean;
  readonly problems: readonly string[];
}

/**
 * Whether the draft is complete enough to start research.
 *
 * Two kinds of rule meet here. The structural ones — a research question, an
 * audience, objects with names, dimensions written as questions — come from the
 * Brief's own contract. The blueprint's floor is separate and deliberate: a
 * user may shape the brief, but may not edit away the comparison obligations
 * the report is validated against, or the validator would end up policing a
 * structure that no longer claims anything.
 */
export function validateBriefDraft(task: ReportTask): BriefValidation {
  const problems: string[] = [];
  const blueprint = briefBlueprintOf(task);
  const minimums = blueprint.briefMinimums;

  if (task.topic.trim().length === 0) problems.push("研究主题（topic）不能为空");
  if (task.purpose.trim().length === 0) problems.push("研究问题 / 用途（purpose）不能为空");
  if (task.audience.trim().length === 0) problems.push("读者（audience）不能为空");

  if (task.subjects.length < minimums.subjects) {
    problems.push(`比较对象至少需要 ${minimums.subjects} 个（当前 ${task.subjects.length} 个）`);
  }
  if (task.subjects.some((subject) => subject.name.trim().length === 0)) {
    problems.push("比较对象名称不能为空");
  }
  const subjectNames = new Set<string>();
  for (const subject of task.subjects) {
    const key = subject.name.trim().toLowerCase();
    if (key.length === 0) continue;
    if (subjectNames.has(key)) problems.push(`比较对象名称重复：${subject.name.trim()}`);
    subjectNames.add(key);
  }

  if (task.dimensions.length < minimums.dimensions) {
    problems.push(
      `研究维度至少需要 ${minimums.dimensions} 个（${blueprint.name} 的最低比较义务，当前 ${task.dimensions.length} 个）`,
    );
  }
  if (task.dimensions.some((dimension) => dimension.name.trim().length === 0)) {
    problems.push("研究维度名称不能为空");
  }
  if (task.dimensions.some((dimension) => dimension.question.trim().length === 0)) {
    problems.push("每个研究维度都必须写成要回答的问题（question 不能为空）");
  }
  const dimensionNames = new Set<string>();
  for (const dimension of task.dimensions) {
    const key = dimension.name.trim().toLowerCase();
    if (key.length === 0) continue;
    if (dimensionNames.has(key)) problems.push(`研究维度名称重复：${dimension.name.trim()}`);
    dimensionNames.add(key);
  }

  return { valid: problems.length === 0, problems };
}

/** Whether a field's change would reshape the matrix. */
export function isStructural(fields: readonly BriefFieldName[]): boolean {
  return fields.some((field) => STRUCTURAL_BRIEF_FIELDS.includes(field));
}

// ------------------------------------------------------------ guided planning --

/**
 * One guided decision's target, chosen by the program.
 *
 * The ladder is the product's opinion about what is worth asking, not a
 * checklist: a field the user already decided is skipped, the count is capped,
 * and the generator may report that no further decision is worth asking for —
 * which is what keeps this from turning into an onboarding wizard.
 */
export interface GuideTarget {
  readonly field: BriefFieldName;
  /** What the question is about, in the program's words. */
  readonly ask: string;
  /** Why it is worth a decision, in the program's words. */
  readonly whyItMatters: string;
  /** What the current value is, so the generator writes about *this* draft. */
  readonly currentValue: string;
}

const GUIDE_LADDER: readonly { readonly field: BriefFieldName; readonly ask: string; readonly why: string }[] =
  Object.freeze([
    {
      field: "purpose",
      ask: "这次研究要回答的问题与用途",
      why: "它决定检索方向、比较框架与结论的写法",
    },
    {
      field: "audience",
      ask: "读者与使用场景",
      why: "它决定解释深度、术语密度与需要铺垫的背景",
    },
    {
      field: "subjects",
      ask: "比较对象",
      why: "对象是证据矩阵的行，也决定检索与读取的目标",
    },
    {
      field: "dimensions",
      ask: "比较维度与每个维度要回答的问题",
      why: "维度是矩阵的列，决定比较表与报告必须回答什么",
    },
    {
      field: "focus",
      ask: "本次最需要证据支撑的重点",
      why: "重点决定哪些维度需要更深、更直接的证据",
    },
    {
      field: "exclusions",
      ask: "明确不研究的内容",
      why: "排除项决定检索与报告不去做的事情",
    },
    {
      field: "lengthTarget",
      ask: "输出深度与篇幅目标",
      why: "篇幅是写作预算，决定章节取舍的详略",
    },
  ]);

/**
 * The next decision worth asking about, or nothing when asking is over.
 *
 * `answered` is how many guided decisions this task has already recorded: the
 * cap is the product's promise that guided planning is a short conversation,
 * not a form. A field the user already decided is skipped rather than re-asked,
 * because asking "你是工程师吗" after the user wrote 研究生 would be the exact
 * failure the one-draft rule exists to prevent.
 */
export function nextGuideTarget(input: {
  readonly task: ReportTask;
  readonly answered: number;
}): GuideTarget | undefined {
  if (input.task.confirmedAt !== null) return undefined;
  if (input.answered >= GUIDE_DECISION_LIMIT) return undefined;
  const states = briefFieldStatesOf(input.task);
  for (const step of GUIDE_LADDER) {
    if (states[step.field] !== "suggested") continue;
    return {
      field: step.field,
      ask: step.ask,
      whyItMatters: step.why,
      currentValue: briefFieldSummary(input.task, step.field),
    };
  }
  return undefined;
}

/** One offered answer, carrying the patch it would apply. */
export interface GuideOption {
  readonly optionId: string;
  readonly label: string;
  readonly description?: string;
  readonly recommended?: boolean;
  /**
   * The Brief change this option means, in the same shape a structured patch
   * takes. It is what makes a chosen option a decision rather than a word the
   * server would have to guess the meaning of, and it is validated with the
   * same normalizer a structured patch goes through.
   */
  readonly value: BriefPatch;
}

export type GuideQuestionStatus = "active" | "answered" | "superseded";

/** The answer a person gave, and what it changed. */
export interface GuideAnswerRecord {
  readonly optionIds: readonly string[];
  readonly freeText: string;
  readonly appliedFields: readonly BriefFieldName[];
  readonly resultingBriefVersion: number;
  readonly at: string;
}

/**
 * One guided question, as the record holds it.
 *
 * The record is deliberately the whole conversation: the question, what it was
 * based on, what was answered, and which brief version the answer produced. It
 * is not a chat log — a project keeps a handful of these at most — but it is
 * enough to tell a person, after a refresh, which decisions they already made.
 */
export interface GuideQuestion {
  readonly id: string;
  readonly taskId: string;
  readonly question: string;
  readonly whyThisMatters: string;
  readonly fieldTargets: readonly BriefFieldName[];
  readonly options: readonly GuideOption[];
  readonly allowFreeText: boolean;
  readonly basedOnBriefVersion: number;
  /** The target fields' values when the question was written, by hash. */
  readonly basedOnFields: Readonly<Record<string, string>>;
  readonly status: GuideQuestionStatus;
  readonly createdAt: string;
  readonly answer: GuideAnswerRecord | null;
}

/** The free text this field's answer takes, and how it becomes a patch. */
const FREE_TEXT_FIELDS: readonly BriefFieldName[] = Object.freeze([
  "topic",
  "purpose",
  "audience",
  "focus",
  "exclusions",
  "lengthTarget",
  "subjects",
  "dimensions",
]);

export function fieldTakesFreeText(field: BriefFieldName): boolean {
  return FREE_TEXT_FIELDS.includes(field);
}

/** Splits a free-text list on what people actually type between items. */
function splitItems(text: string, inlineSeparators: boolean): readonly string[] {
  const lines = text
    .split(/\r?\n|；|;/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const parts = inlineSeparators
    ? lines.flatMap((line) =>
        line
          .split(/[，,、]/)
          .map((part) => part.trim())
          .filter((part) => part.length > 0),
      )
    : lines;
  return parts;
}

/** A line of `name | note`, or just a name. */
function splitPair(line: string): readonly [string, string] {
  const separator = /\||｜|：|:/.exec(line);
  if (separator === null) return [line.trim(), ""];
  return [line.slice(0, separator.index).trim(), line.slice(separator.index + separator[0].length).trim()];
}

/**
 * Turns a typed answer into the patch it stands for.
 *
 * The mapping is declared per field rather than guessed by a model, because a
 * server that has to ask "what did they mean by that" is a server that can
 * change the wrong field. For a text field the answer *is* the value; for a
 * list it is one item per line (or comma-separated, for objects); for a
 * dimension it is `名称 | 要回答的问题`, since a dimension without its question
 * is exactly the shape this product refuses.
 */
export function patchFromFreeText(task: ReportTask, field: BriefFieldName, text: string): BriefPatch {
  const value = text.trim();
  switch (field) {
    case "topic":
    case "purpose":
    case "audience":
    case "exclusions":
    case "lengthTarget":
      return { [field]: value } as BriefPatch;
    case "focus":
      return { focus: splitItems(value, true) };
    case "subjects": {
      const subjects = splitItems(value, true).map((item) => {
        const [name, note] = splitPair(item);
        const existing = task.subjects.find((subject) => subject.name.trim().toLowerCase() === name.toLowerCase());
        return {
          ...(existing === undefined ? {} : { id: existing.id }),
          name,
          ...(note.length === 0 ? {} : { note }),
        };
      });
      return { subjects };
    }
    case "dimensions": {
      const dimensions = splitItems(value, false).map((item) => {
        const [name, question] = splitPair(item);
        const existing = task.dimensions.find((dimension) => dimension.name.trim().toLowerCase() === name.toLowerCase());
        return { ...(existing === undefined ? {} : { id: existing.id }), name, question };
      });
      return { dimensions };
    }
  }
}

/** Whether a question's target has moved since the question was written. */
export function guideQuestionIsStale(question: GuideQuestion, task: ReportTask): boolean {
  return question.fieldTargets.some((field) => briefFieldHash(task, field) !== question.basedOnFields[field]);
}

/** The sections a confirmed task's report must cover, for the read-only view. */
export function briefStructureView(
  task: ReportTask,
): readonly { readonly id: string; readonly title: string; readonly question: string; readonly required: boolean }[] {
  const sections: readonly ResearchSection[] = task.structure.sections;
  const blueprint = briefBlueprintOf(task);
  return sections.map((section) => ({
    id: section.id,
    title: section.title,
    question: section.question,
    required: blueprint.sections.find((candidate) => candidate.id === section.id)?.required ?? false,
  }));
}

/** The brief's own content hash, for a caller that wants to pin it. */
export function briefHashOf(task: ReportTask): string {
  return hashOf({
    topic: task.topic,
    purpose: task.purpose,
    audience: task.audience,
    focus: task.focus,
    exclusions: task.exclusions,
    lengthTarget: task.lengthTarget,
    subjects: canonicalJson(task.subjects),
    dimensions: canonicalJson(task.dimensions),
  });
}
