/**
 * The Brief page's own arithmetic.
 *
 * Editing a brief is mostly a correspondence problem: the server states its
 * objections as sentences, the page has to put each one next to the field it is
 * about; and a list of rows has to be turned into a patch that keeps the ids
 * the server minted.
 *
 * Both are decided here rather than in the component, so that a change of
 * layout cannot change what an edit means — and so that the rules can be
 * checked without a browser.
 */

import type { BriefFieldName, BriefPatch, BriefView } from "./api.js";

/* --------------------------------------------------------------- problems -- */

/** Every field the page edits, in the order it shows them. */
export const BRIEF_FIELD_ORDER: readonly BriefFieldName[] = Object.freeze([
  "topic",
  "purpose",
  "audience",
  "subjects",
  "dimensions",
  "focus",
  "exclusions",
  "lengthTarget",
]);

/**
 * Which field a validation problem is about.
 *
 * The server writes its problems in the reader's language and names the field
 * inside them — `研究问题 / 用途（purpose）不能为空`, `比较对象至少需要 1 个` —
 * so the page matches on declared words rather than on a position or an index.
 * A problem that matches nothing is a problem about the draft as a whole, and
 * is shown as such instead of being attached to an arbitrary field.
 */
const PROBLEM_MATCHES: readonly (readonly [BriefFieldName, readonly string[]])[] = Object.freeze([
  ["topic", Object.freeze(["（topic）", "主题"])],
  ["purpose", Object.freeze(["（purpose）", "研究问题"])],
  ["audience", Object.freeze(["（audience）", "读者"])],
  ["subjects", Object.freeze(["比较对象"])],
  ["dimensions", Object.freeze(["研究维度", "维度"])],
] as const);

export function problemFieldOf(problem: string): BriefFieldName | null {
  for (const [field, needles] of PROBLEM_MATCHES) {
    if (needles.some((needle) => problem.includes(needle))) return field;
  }
  return null;
}

export interface FieldProblems {
  /** The field the problems belong to; `null` means the draft as a whole. */
  readonly field: BriefFieldName | null;
  readonly problems: readonly string[];
}

/** The server's problems, grouped by field, in the order the page shows them. */
export function problemsByField(problems: readonly string[]): readonly FieldProblems[] {
  const buckets = new Map<BriefFieldName | null, string[]>();
  for (const problem of problems) {
    const field = problemFieldOf(problem);
    const bucket = buckets.get(field);
    if (bucket === undefined) buckets.set(field, [problem]);
    else bucket.push(problem);
  }
  const ordered: FieldProblems[] = [];
  for (const field of BRIEF_FIELD_ORDER) {
    const bucket = buckets.get(field);
    if (bucket !== undefined) ordered.push({ field, problems: bucket });
  }
  const draft = buckets.get(null);
  if (draft !== undefined) ordered.push({ field: null, problems: draft });
  return ordered;
}

/** The first field a reader has to fix, so the page can scroll to it. */
export function firstProblemField(problems: readonly string[]): BriefFieldName | null {
  return problemsByField(problems)[0]?.field ?? null;
}

/* ---------------------------------------------------------------- subjects -- */

export interface SubjectRow {
  /** Absent for a row the reader has just added; the server mints its id. */
  readonly id?: string;
  readonly name: string;
  readonly note: string;
}

export interface DimensionRow {
  readonly id?: string;
  readonly name: string;
  readonly question: string;
}

export function subjectRowsOf(brief: BriefView): readonly SubjectRow[] {
  return brief.subjects.map((subject) => ({ id: subject.id, name: subject.name, note: subject.note ?? "" }));
}

export function dimensionRowsOf(brief: BriefView): readonly DimensionRow[] {
  return brief.dimensions.map((dimension) => ({ id: dimension.id, name: dimension.name, question: dimension.question }));
}

/**
 * The patch a subject list makes.
 *
 * A row that already exists carries its id, which is what keeps a rename from
 * becoming a delete-and-add — the matrix cell, the evidence and the assessments
 * recorded against that object stay attached to it. A row the reader added has
 * no id, and the server mints one.
 */
export function subjectsPatch(rows: readonly SubjectRow[]): BriefPatch {
  return {
    subjects: rows.map((row) => ({
      ...(row.id === undefined ? {} : { id: row.id }),
      name: row.name,
      ...(row.note.trim().length === 0 ? {} : { note: row.note }),
    })),
  };
}

export function dimensionsPatch(rows: readonly DimensionRow[]): BriefPatch {
  return {
    dimensions: rows.map((row) => ({
      ...(row.id === undefined ? {} : { id: row.id }),
      name: row.name,
      question: row.question,
    })),
  };
}

/** Whether a row list has nothing left to commit against the brief it came from. */
export function sameSubjects(rows: readonly SubjectRow[], brief: BriefView): boolean {
  const current = subjectRowsOf(brief);
  if (rows.length !== current.length) return false;
  return rows.every((row, index) => {
    const other = current[index];
    return other !== undefined && row.id === other.id && row.name === other.name && row.note.trim() === other.note.trim();
  });
}

export function sameDimensions(rows: readonly DimensionRow[], brief: BriefView): boolean {
  const current = dimensionRowsOf(brief);
  if (rows.length !== current.length) return false;
  return rows.every((row, index) => {
    const other = current[index];
    return other !== undefined && row.id === other.id && row.name === other.name && row.question === other.question;
  });
}

/**
 * Whether a structural list may be sent as it stands.
 *
 * A reader who adds a row and clicks away has not decided anything yet, so a
 * new row without a name is kept local rather than committed as a nameless
 * object. An existing row *may* be emptied: that is a real edit, and the
 * server answers with the problem it creates instead of the page pretending the
 * keystroke did not happen.
 */
export function subjectsCommittable(rows: readonly SubjectRow[]): boolean {
  return rows.every((row) => row.id !== undefined || row.name.trim().length > 0);
}

export function dimensionsCommittable(rows: readonly DimensionRow[]): boolean {
  return rows.every((row) => row.id !== undefined || row.name.trim().length > 0);
}

/** One row moved up or down; the ids travel with the rows, so nothing is lost. */
export function moved<T>(rows: readonly T[], from: number, to: number): readonly T[] {
  if (from === to || from < 0 || to < 0 || from >= rows.length || to >= rows.length) return rows;
  const next = [...rows];
  const [row] = next.splice(from, 1);
  if (row === undefined) return rows;
  next.splice(to, 0, row);
  return next;
}

/* ------------------------------------------------------------------- focus -- */

export function addFocus(focus: readonly string[], value: string): readonly string[] {
  const trimmed = value.trim();
  if (trimmed.length === 0) return focus;
  if (focus.some((item) => item.toLowerCase() === trimmed.toLowerCase())) return focus;
  return [...focus, trimmed];
}

export function removeFocus(focus: readonly string[], value: string): readonly string[] {
  return focus.filter((item) => item !== value);
}

/* ----------------------------------------------------------------- confirm -- */

/**
 * What the reader is about to start, said in one line.
 *
 * It is read from the same draft the confirm posts, so the sentence and the
 * request cannot disagree.
 */
export function confirmSummary(brief: BriefView): string {
  const parts = [`${String(brief.subjects.length)} 个对象`, `${String(brief.dimensions.length)} 个维度`];
  const length = brief.lengthTarget.trim();
  if (length.length > 0) parts.push(length);
  return parts.join(" · ");
}
