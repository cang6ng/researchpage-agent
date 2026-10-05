/**
 * The research structure, and how a topic becomes an executable task card.
 *
 * The structure a new card is created under is Technical Comparison v2: a plain
 * TypeScript blueprint value rather than a template system, because the
 * interesting part is not the configuration format: it is that these sections,
 * subjects and dimensions actually drive queries, the evidence matrix and the
 * report. Every id a model later cites comes from here, minted by the program.
 */

import type {
  Dimension,
  MatrixCell,
  ReportTask,
  ResearchSection,
  Subject,
} from "./domain.js";
import { DEFAULT_BUDGET, emptyUsage } from "./domain.js";
import { BLUEPRINT_ID_V2, TECHNICAL_COMPARISON_V2, V2_COMPARISON_DIMENSIONS, blueprintSections } from "./blueprint.js";
import { newId, type ResearchRepository } from "./repository.js";
import { ID_PREFIX } from "./domain.js";

export const STRUCTURE_ID = BLUEPRINT_ID_V2;

/**
 * The sections of the structure, each a research question the report must
 * answer. `required` sections are the ones a report is not publishable without;
 * the rest are filled when the material supports them. The list is derived from
 * the blueprint so that what the card shows and what the report is validated
 * against cannot drift apart.
 */
export const STRUCTURE_SECTIONS: readonly (ResearchSection & { readonly required: boolean })[] = Object.freeze(
  TECHNICAL_COMPARISON_V2.sections.map((section) => ({
    id: section.id,
    title: section.title,
    question: section.question,
    required: section.required,
  })),
);

/** The dimensions a comparison must cover, unless the card says otherwise. */
export const DEFAULT_DIMENSIONS: readonly Dimension[] = V2_COMPARISON_DIMENSIONS;

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
    blueprintId: BLUEPRINT_ID_V2,
    structure: { sections: blueprintSections(TECHNICAL_COMPARISON_V2) },
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
