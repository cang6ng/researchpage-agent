/**
 * What the interactive artifact projects, and what it refuses to print.
 *
 * Two jobs, both about the same thing: an interactive report is not a dump of
 * the validator's state. Where it says what is still unknown, it says it as a
 * reader would — aggregated by the question the unknown belongs to, in one
 * sentence per question, with the full cell list one disclosure away. And where
 * it names a comparison object or a research dimension, it names it: an
 * identifier is a database's word for a thing, not a reader's.
 */

import type { CellView, DocumentView, TaskBundle } from "./api.js";

/* ------------------------------------------------------------- boundaries -- */

/** Which coverage states mean "this is not established yet". */
const OPEN_STATES: readonly CellView["status"][] = ["missing", "unassessed", "limited", "conflict"];

export interface BoundaryItem {
  readonly dimensionId: string;
  readonly dimensionName: string;
  /** The question this dimension asks — the heading a reader can act on. */
  readonly question: string;
  readonly cells: readonly CellView[];
  readonly subjects: readonly string[];
  /** One sentence: why this is still open, taken from the cells themselves. */
  readonly sentence: string;
}

/**
 * The research's open questions, one item per dimension.
 *
 * The unit is the dimension rather than the cell because that is the unit a
 * reader thinks in: "成本口径" is a question, and "GraphRAG × 成本口径" is one
 * of the objects that question is still unanswered for. A list of fifteen
 * cells is a validator's view of the same fact.
 */
export function boundariesOf(bundle: TaskBundle): readonly BoundaryItem[] {
  const open = bundle.matrix.filter((cell) => OPEN_STATES.includes(cell.status));
  const byDimension = new Map<string, CellView[]>();
  for (const cell of open) {
    const bucket = byDimension.get(cell.dimensionId);
    if (bucket === undefined) byDimension.set(cell.dimensionId, [cell]);
    else bucket.push(cell);
  }
  const items: BoundaryItem[] = [];
  for (const dimension of bundle.dimensions) {
    const cells = byDimension.get(dimension.id);
    if (cells === undefined || cells.length === 0) continue;
    const sentence =
      cells.map((cell) => cell.gap.trim()).find((text) => text.length > 0) ??
      cells.map((cell) => cell.reason.trim()).find((text) => text.length > 0) ??
      "这一项还没有可引用的材料。";
    items.push({
      dimensionId: dimension.id,
      dimensionName: dimension.name,
      question: dimension.question,
      cells,
      subjects: cells.map((cell) => cell.subjectName),
      sentence,
    });
  }
  // The question with the most still open comes first: it is the one the
  // research is furthest from answering.
  return items.sort((left, right) => right.cells.length - left.cells.length);
}

export const BOUNDARY_STATE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  missing: "待查",
  unassessed: "有材料，待核对",
  limited: "有限支持",
  conflict: "冲突 / 不可比",
});

/** How many objects stand in each state, said the way a reader counts them. */
export function boundaryCounts(item: BoundaryItem): string {
  const counts = new Map<CellView["status"], number>();
  for (const cell of item.cells) counts.set(cell.status, (counts.get(cell.status) ?? 0) + 1);
  const order: CellView["status"][] = ["missing", "unassessed", "limited", "conflict"];
  const parts: string[] = [];
  for (const status of order) {
    const count = counts.get(status);
    if (count === undefined) continue;
    parts.push(`${String(count)} 个对象${BOUNDARY_STATE_LABELS[status] ?? status}`);
  }
  return parts.join(" · ");
}

/** The one line the document's top may carry about its own open questions. */
export function boundarySummary(bundle: TaskBundle): string {
  const count = bundle.matrix.filter((cell) => OPEN_STATES.includes(cell.status)).length;
  return `${String(count)} 项需要进一步核验`;
}

/* -------------------------------------------------------------- identities -- */

/**
 * A name for an id, or nothing.
 *
 * Deliberately not a fallback to the id: `dim_a1b2c3` in a heading is the page
 * telling the reader something about its own database, and an empty label is
 * better than that. What must never happen is the id reaching the page, so the
 * fallback is the caller's business — this returns `undefined` and the caller
 * decides whether it has another name available.
 */
export function nameOf(names: ReadonlyMap<string, string>, id: string | null | undefined): string | undefined {
  if (id === null || id === undefined || id.length === 0) return undefined;
  return names.get(id);
}

/**
 * The names a document needs, from the project rather than from the report.
 *
 * The report understands dimensions as identifiers, and a comparison table has
 * to be readable in the reader's words: the object's name across the top, the
 * question down the side. Both are properties of the project's brief.
 */
export function nameMaps(bundle: TaskBundle): DocumentNames {
  return {
    subjects: new Map(bundle.subjects.map((subject) => [subject.id, subject.name])),
    dimensions: new Map(bundle.dimensions.map((dimension) => [dimension.id, dimension.name])),
    dimensionQuestions: new Map(bundle.dimensions.map((dimension) => [dimension.id, dimension.question])),
  };
}

/** What a document is allowed to call things. */
export interface DocumentNames {
  readonly subjects: ReadonlyMap<string, string>;
  readonly dimensions: ReadonlyMap<string, string>;
  /** The question each dimension asks — the row heading of a comparison. */
  readonly dimensionQuestions: ReadonlyMap<string, string>;
}

/**
 * One of this product's internal identifiers, as it appears in running text.
 *
 * A Chinese sentence has no word breaks, so the identifier runs until the text
 * stops looking like one: up to the next space, the next punctuation mark, or a
 * closing bracket.
 */
const INTERNAL_ID = String.raw`(?:sub|dim|ev|clm|sec|task|rep|rev|prp|gq|asmt|exp)_[^\s，。；、)）(（]{1,60}`;

/** Whether a string carries one of this product's internal identifiers. */
export function looksLikeInternalId(text: string): boolean {
  return new RegExp(INTERNAL_ID).test(text);
}

/**
 * The same sentence, with the database's words taken out of it.
 *
 * Reports are written by a model that was shown the identifiers of the objects
 * it compares, and it sometimes writes them down: `GraphRAG（sub_graphrag）` is
 * a sentence no reader was meant to see. What is removed is only ever a
 * machine-generated identifier, optionally wrapped in parentheses — no prose is
 * rewritten and no name is guessed. An identifier inside a sentence is not
 * information; it is the report thinking out loud about its own storage.
 */
export function withoutInternalIds(text: string): string {
  return text.replace(
    new RegExp(String.raw`[ \t]*(?:[（(]\s*${INTERNAL_ID}\s*[)）]|${INTERNAL_ID})`, "g"),
    "",
  );
}

/**
 * The same, for one paragraph: the words as a reader would say them.
 *
 * Tidying the spacing belongs with prose and not with Markdown source, where
 * leading whitespace is what makes a code block a code block.
 */
export function readerText(text: string): string {
  return withoutInternalIds(text).replace(/ {2,}/g, " ").trim();
}

/* ------------------------------------------------------------------ lists -- */

/** A list item that already numbers itself: the marker would say it twice. */
export function carriesOwnNumber(text: string): boolean {
  return /^\s*(?:\d+|[①-⑳]|[一二三四五六七八九十]+)\s*[)）.、]/.test(text);
}

/* ---------------------------------------------------------------- warnings -- */

/** The question a verification warning is about, if it names one. */
export interface WarningSummary {
  readonly count: number;
  readonly headline: string;
}

/**
 * The report's own quality warnings, said as one sentence.
 *
 * The warnings are real and stay available; what they are not is the first
 * thing a reader sees. Twelve validator sentences at the top of a report is a
 * debug view, and the honest summary of them is a count and where to look.
 */
export function warningSummary(document: DocumentView | null): WarningSummary | null {
  const warnings = document?.validation?.warnings ?? [];
  if (warnings.length === 0) return null;
  return {
    count: warnings.length,
    headline: `需要进一步核验 · ${String(warnings.length)}`,
  };
}

/**
 * One warning as the reader reads it: the sentence, without the check's number.
 *
 * `Q03：…` is how the validator files a finding, and the number is what a
 * developer traces it by — the sentence after it is what is wrong with the
 * report and what to do about it. The number is not thrown away, it is moved
 * behind the detail disclosure, which is where a reader who wants to trace it
 * back to the contract can find it.
 */
export function readerWarning(text: string): string {
  return text.replace(/^\s*Q\d+\s*[:：]\s*/, "").trim();
}
