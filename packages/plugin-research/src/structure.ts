/**
 * The one research structure, and how a topic becomes an executable task card.
 *
 * v1 ships exactly one structure — a technical survey that compares 2–4
 * representative works across shared dimensions — and it is a plain TypeScript
 * value rather than a template system, because the interesting part is not the
 * configuration format: it is that these sections, subjects and dimensions
 * actually drive queries, the evidence matrix and the report. Every id a model
 * later cites comes from here, minted by the program.
 */

import type {
  Dimension,
  MatrixCell,
  ReportTask,
  ResearchSection,
  Subject,
} from "./domain.js";
import { DEFAULT_BUDGET, emptyUsage } from "./domain.js";
import { newId, type ResearchRepository } from "./repository.js";
import { ID_PREFIX } from "./domain.js";

export const STRUCTURE_ID = "technical-comparison-v1";

/**
 * The sections of the structure, each a research question the report must
 * answer. `required` sections are the ones a report is not publishable without;
 * the rest are filled when the material supports them.
 */
export const STRUCTURE_SECTIONS: readonly (ResearchSection & { readonly required: boolean })[] = Object.freeze([
  {
    id: "overview",
    title: "研究任务与关键认识",
    question: "为谁研究、研究什么，主要认识是什么，证据边界在哪里",
    required: true,
  },
  {
    id: "background",
    title: "背景与方法分类",
    question: "问题是什么，代表方法可以按什么维度分类",
    required: false,
  },
  {
    id: "representative",
    title: "代表工作",
    question: "每个研究对象的核心主张与做法是什么",
    required: true,
  },
  {
    id: "comparison",
    title: "共同维度比较",
    question: "在统一维度下，各对象的具体差异是什么",
    required: true,
  },
  {
    id: "conditions",
    title: "实验与适用条件",
    question: "实验设置、数据与资源条件是否可比，结论在什么条件下成立",
    required: false,
  },
  {
    id: "limitations",
    title: "局限与证据缺口",
    question: "材料自身的局限、没有找到依据的项目、不能下的结论是什么",
    required: true,
  },
  {
    id: "reading",
    title: "阅读建议",
    question: "按什么顺序读这些材料最有效率",
    required: false,
  },
]);

/** The dimensions a comparison must cover, unless the card says otherwise. */
export const DEFAULT_DIMENSIONS: readonly Dimension[] = Object.freeze([
  { id: "dim_core_idea", name: "核心思想", question: "该方法要解决什么问题，核心思路是什么" },
  { id: "dim_construction", name: "结构与构建", question: "图/记忆/结构具体如何构建，需要哪些步骤与数据" },
  { id: "dim_retrieval", name: "检索机制", question: "查询时如何检索或整合信息" },
  { id: "dim_evaluation", name: "实验与评测", question: "在什么数据与指标上被验证，设置是否可比" },
  { id: "dim_cost", name: "成本与部署", question: "构建与查询成本、依赖的资源条件是什么" },
  { id: "dim_limits", name: "局限与风险", question: "作者报告或明显的局限是什么" },
]);

export function slugId(prefix: string, name: string, index: number): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24);
  const ascii = /[a-z0-9]/.test(slug) ? slug : `item${index + 1}`;
  return `${prefix}_${ascii}`;
}

export interface ProposedCard {
  readonly topic: string;
  readonly purpose: string;
  readonly audience: string;
  readonly focus: readonly string[];
  readonly exclusions: string;
  readonly lengthTarget: string;
  readonly subjects: readonly { readonly name: string; readonly note?: string }[];
  readonly dimensions: readonly { readonly name: string; readonly question: string }[];
}

export interface CardProblem {
  readonly problem: string;
}

/** A card that passed normalization: the only shape a task is created from. */
export interface NormalizedCard {
  readonly topic: string;
  readonly purpose: string;
  readonly audience: string;
  readonly focus: readonly string[];
  readonly exclusions: string;
  readonly lengthTarget: string;
  readonly subjects: readonly Subject[];
  readonly dimensions: readonly Dimension[];
}

/**
 * Reads a proposed card into the task's own shape, refusing what cannot drive a
 * matrix: too few or too many subjects, no dimensions, an empty topic.
 */
export function normalizeCard(card: ProposedCard): { readonly ok: true; readonly value: NormalizedCard } | { readonly ok: false; readonly problems: readonly CardProblem[] } {
  const problems: CardProblem[] = [];
  const topic = card.topic.trim();
  if (topic.length === 0) problems.push({ problem: "topic 不能为空" });
  if (topic.length > 200) problems.push({ problem: "topic 过长（>200 字）" });

  const subjects: Subject[] = [];
  const names = new Set<string>();
  card.subjects.slice(0, 6).forEach((entry, index) => {
    const name = entry.name.trim();
    if (name.length === 0) return;
    if (names.has(name.toLowerCase())) return;
    names.add(name.toLowerCase());
    subjects.push({
      id: slugId("sub", name, index),
      name,
      ...(entry.note === undefined || entry.note.trim() === "" ? {} : { note: entry.note.trim() }),
    });
  });
  if (subjects.length < 2) problems.push({ problem: "比较对象至少需要 2 个，且不能重复" });
  if (subjects.length > 4) problems.push({ problem: "比较对象最多 4 个，请先收敛" });

  const dimensions: Dimension[] = (card.dimensions.length > 0 ? card.dimensions : DEFAULT_DIMENSIONS).slice(0, 6).map((entry, index) => ({
    id: slugId("dim", entry.name, index),
    name: entry.name.trim(),
    question: entry.question.trim(),
  }));
  if (dimensions.length < 3) problems.push({ problem: "研究维度至少需要 3 个" });

  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    value: {
      topic,
      purpose: card.purpose.trim(),
      audience: card.audience.trim(),
      focus: card.focus.map((item) => item.trim()).filter((item) => item.length > 0).slice(0, 5),
      exclusions: card.exclusions.trim(),
      lengthTarget: card.lengthTarget.trim().length > 0 ? card.lengthTarget.trim() : "约 4–6 页",
      subjects,
      dimensions,
    },
  };
}

/** Every (subject × dimension) cell the comparison must eventually cover. */
export function buildMatrix(subjects: readonly Subject[], dimensions: readonly Dimension[], at: string): readonly MatrixCell[] {
  const cells: MatrixCell[] = [];
  for (const subject of subjects) {
    for (const dimension of dimensions) {
      cells.push({
        sectionId: "comparison",
        subjectId: subject.id,
        dimensionId: dimension.id,
        status: "missing",
        evidenceIds: [],
        reason: "尚未开始检索",
        gap: `${subject.name} × ${dimension.name}：尚无实际读取的片段`,
        note: "",
        updatedAt: at,
      });
    }
  }
  return cells;
}

/** The task as it is created from a validated card. */
export function createTask(input: {
  readonly sessionId: string;
  readonly card: NormalizedCard;
  readonly now: string;
}): ReportTask {
  return {
    id: newId(ID_PREFIX.task),
    sessionId: input.sessionId,
    topic: input.card.topic,
    purpose: input.card.purpose,
    audience: input.card.audience,
    focus: input.card.focus,
    exclusions: input.card.exclusions,
    language: "zh",
    lengthTarget: input.card.lengthTarget,
    status: "draft",
    confirmedAt: null,
    structure: { sections: STRUCTURE_SECTIONS.map(({ required: _required, ...section }) => section) },
    subjects: input.card.subjects,
    dimensions: input.card.dimensions,
    matrix: buildMatrix(input.card.subjects, input.card.dimensions, input.now),
    budget: DEFAULT_BUDGET,
    usage: emptyUsage(),
    currentReportId: null,
    reportDraft: null,
    createdAt: input.now,
    updatedAt: input.now,
    error: null,
  };
}

/** The task bound to a session, if this session has one. */
export function taskOfSession(repo: ResearchRepository, sessionId: string): ReportTask | undefined {
  return repo.taskForSession(sessionId);
}

/** The section titles, for prompts and for a reader-facing outline. */
export function outlineOf(task: ReportTask): readonly { readonly id: string; readonly title: string; readonly required: boolean }[] {
  return task.structure.sections.map((section) => ({
    id: section.id,
    title: section.title,
    required: STRUCTURE_SECTIONS.find((candidate) => candidate.id === section.id)?.required ?? false,
  }));
}
