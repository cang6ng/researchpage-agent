/**
 * The four shared domain objects and the rules that derive evidence coverage.
 *
 * The rule this file exists to keep is the one the whole product is about:
 * a cell's coverage state is *derived* from evidence that was really read and
 * saved, never from what a model said about its own work. `deriveCellCoverage`
 * is therefore pure and total — no model output reaches it except as a list of
 * evidence ids, and every id is resolved through the caller's lookup first.
 */

/** What a task is doing right now. Completion is never a self-reported label. */
export type TaskStatus = "draft" | "confirmed" | "researching" | "ready" | "failed";

/** Where a source stands: never read, read with real text, or the read failed. */
export type ReadStatus = "not_read" | "ok" | "failed";

/**
 * How much of a source was actually obtained.
 *
 * `metadata` is search-result level (title/URL/year) and never counts as
 * evidence. `abstract` is an abstract obtained by the read layer itself.
 * `body_excerpt` is real body text that was truncated; `full_text` is the whole
 * obtained document.
 */
export type ReadScope = "metadata" | "abstract" | "body_excerpt" | "full_text";

/** The three coverage states a cell can hold, plus "not yet assessed". */
export type CellStatus = "sufficient" | "partial" | "missing" | "evaluating";

export interface ResearchSection {
  readonly id: string;
  readonly title: string;
  /** The question this section must answer; drives queries and evidence needs. */
  readonly question: string;
}

export interface Subject {
  readonly id: string;
  readonly name: string;
  readonly note?: string;
}

export interface Dimension {
  readonly id: string;
  readonly name: string;
  /** What a sufficient answer for this dimension requires. */
  readonly question: string;
}

export interface CellRef {
  readonly sectionId: string;
  readonly subjectId: string;
  readonly dimensionId: string;
}

export interface MatrixCell extends CellRef {
  readonly status: CellStatus;
  readonly evidenceIds: readonly string[];
  /** Why the cell holds this state, in words a reader can check. */
  readonly reason: string;
  /** What is still missing, when anything is. */
  readonly gap: string;
  /** The agent's own note about this cell; never a coverage status. */
  readonly note: string;
  readonly updatedAt: string;
}

export interface ResearchBudget {
  readonly maxSearches: number;
  readonly maxCandidatesPerSearch: number;
  readonly maxReads: number;
  readonly maxGapRounds: number;
  readonly deadlineMs: number;
}

export interface ResearchUsage {
  readonly searches: number;
  readonly reads: number;
  readonly gapRounds: number;
  readonly startedAt?: string;
}

export const DEFAULT_BUDGET: ResearchBudget = Object.freeze({
  maxSearches: 6,
  maxCandidatesPerSearch: 5,
  maxReads: 10,
  maxGapRounds: 2,
  deadlineMs: 8 * 60 * 1000,
});

export interface ReportTask {
  readonly id: string;
  /** The session this task is trusted to; never taken from a model argument. */
  readonly sessionId: string;
  readonly topic: string;
  readonly purpose: string;
  readonly audience: string;
  readonly focus: readonly string[];
  readonly exclusions: string;
  readonly language: "zh";
  readonly lengthTarget: string;
  readonly status: TaskStatus;
  readonly confirmedAt: string | null;
  readonly structure: { readonly sections: readonly ResearchSection[] };
  readonly subjects: readonly Subject[];
  readonly dimensions: readonly Dimension[];
  readonly matrix: readonly MatrixCell[];
  readonly budget: ResearchBudget;
  readonly usage: ResearchUsage;
  readonly currentReportId: string | null;
  /** The report being accumulated, or `null` when none is in progress. */
  readonly reportDraft: ReportDraftState | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly error: string | null;
}

/**
 * A discovery candidate, before and after reading.
 *
 * A source's existence is a search fact. Whether it was read, and how much of it
 * was obtained, is a separate fact that only the read layer may set.
 */
export interface Source {
  readonly id: string;
  readonly taskId: string;
  readonly title: string;
  readonly authors: readonly string[];
  readonly org: string;
  readonly url: string;
  readonly pdfUrl: string | null;
  readonly doi: string | null;
  readonly publishedAt: string | null;
  readonly venue: string;
  /** The discovery abstract, kept as search metadata — not as evidence. */
  readonly abstract: string;
  readonly discovery: {
    readonly provider: string;
    readonly query: string;
    readonly queriedAt: string;
    readonly target: CellRef | null;
  };
  readonly readStatus: ReadStatus;
  readonly readScope: ReadScope | null;
  readonly readAt: string | null;
  readonly readUrl: string | null;
  readonly retrievalNote: string;
  readonly failure: string | null;
  readonly snapshotId: string | null;
}

export interface Paragraph {
  readonly index: number;
  readonly headingPath: readonly string[];
  readonly text: string;
  readonly charStart: number;
  readonly charEnd: number;
}

/** An immutable read: the text a source returned, with locatable paragraphs. */
export interface ReadSnapshot {
  readonly id: string;
  readonly taskId: string;
  readonly sourceId: string;
  readonly url: string;
  readonly fetchedAt: string;
  readonly scope: ReadScope;
  readonly title: string;
  readonly text: string;
  readonly paragraphs: readonly Paragraph[];
  readonly note: string;
}

/**
 * A quotable excerpt of a saved read.
 *
 * The excerpt is an exact substring of the snapshot's text — that is the
 * invariant `verifyEvidenceText` re-checks before a report may cite it — and
 * the locator names where it sits.
 */
export interface Evidence {
  readonly id: string;
  readonly taskId: string;
  readonly sourceId: string;
  readonly readId: string;
  readonly excerpt: string;
  readonly locator: {
    readonly paragraphIndex: number;
    readonly headingPath: readonly string[];
    readonly charStart: number;
    readonly charEnd: number;
  };
  readonly readScope: ReadScope;
  /** The matrix cells this passage was collected for. */
  readonly cells: readonly CellRef[];
  /** How the passage was chosen: a targeted question match or a direct pick. */
  readonly pickedBecause: string;
  readonly createdAt: string;
}

export type ClaimKind = "fact" | "comparison" | "inference";

export interface ReportClaim {
  readonly id: string;
  readonly text: string;
  readonly evidenceIds: readonly string[];
  readonly kind: ClaimKind;
}

export type ReportBlock =
  | { readonly kind: "paragraph"; readonly text: string; readonly claimIds: readonly string[] }
  | { readonly kind: "list"; readonly items: readonly { readonly text: string; readonly claimIds: readonly string[] }[] }
  | {
      readonly kind: "table";
      readonly columns: readonly string[];
      readonly rows: readonly { readonly cells: readonly { readonly text: string; readonly claimIds: readonly string[] }[] }[];
    }
  | { readonly kind: "callout"; readonly tone: "gap" | "note"; readonly text: string };

export interface ReportSection {
  readonly id: string;
  readonly title: string;
  readonly blocks: readonly ReportBlock[];
}

/**
 * The report as it is being written.
 *
 * A full report does not fit in one model step's output budget — the platform's
 * approved reserve is what it is — so the draft is accumulated across calls:
 * a title and summary, then claims, then one section at a time. It lives on the
 * task, which means an interrupted report stage resumes from the parts that
 * were already written instead of starting over.
 */
export interface ReportDraftState {
  readonly title: string;
  readonly summary: string;
  readonly claims: readonly ReportClaim[];
  readonly sections: readonly ReportSection[];
  readonly updatedAt: string;
}

export interface ReportValidation {
  readonly ok: boolean;
  readonly problems: readonly string[];
  readonly checkedAt: string;
}

export interface Report {
  readonly id: string;
  readonly taskId: string;
  readonly title: string;
  readonly summary: string;
  readonly sections: readonly ReportSection[];
  readonly claims: readonly ReportClaim[];
  readonly validation: ReportValidation;
  readonly createdAt: string;
}

/** The one export kind v1 delivers: a real PDF file of a report snapshot. */
export interface ExportArtifact {
  readonly id: string;
  readonly taskId: string;
  readonly reportId: string;
  readonly kind: "pdf";
  readonly status: "not_exported" | "exporting" | "exported" | "failed";
  readonly path: string | null;
  readonly bytes: number;
  readonly failure: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * The stages one research task moves through.
 *
 * Each stage is a separate host run, because a run's step budget is the Core's
 * approved profile and a whole research pass does not fit in one: the card is
 * one run, the first search/read/assess pass is one, each gap round is one, and
 * the report is one. The stage is also what the workspace shows the user, so
 * "what is happening" is a fact about the task rather than about a request.
 */
export type ResearchStage = "card" | "research" | "gap" | "report" | "followup";

/** One stage's execution, as the application recorded it. */
export interface ResearchRunRecord {
  readonly id: string;
  readonly taskId: string;
  readonly stage: ResearchStage;
  /** The host run this stage was executed as, once it started. */
  readonly runId: string | null;
  readonly status: "running" | "completed" | "failed" | "interrupted";
  readonly startedAt: string;
  readonly endedAt: string | null;
  /** What the stage did, in one sentence a reader can check. */
  readonly note: string;
  /** Real tool calls the stage made, newest last. */
  readonly activity: readonly {
    readonly name: string;
    readonly detail: string;
    readonly ok: boolean | null;
    readonly at: string;
  }[];
}

/** What a cell's coverage is, and the sentence that explains it. */
export interface CoverageVerdict {
  readonly status: CellStatus;
  readonly reason: string;
  readonly gap: string;
  readonly evidenceIds: readonly string[];
}

/** The minimum an evidence lookup has to answer for coverage to be derivable. */
export interface CoverageEvidence {
  readonly id: string;
  readonly readScope: ReadScope;
  readonly cells: readonly CellRef[];
}

function sameCell(a: CellRef, b: CellRef): boolean {
  return a.sectionId === b.sectionId && a.subjectId === b.subjectId && a.dimensionId === b.dimensionId;
}

/**
 * Derives one cell's coverage state from the evidence that really exists.
 *
 * The rules are deliberately simple and explainable, and none of them can be
 * satisfied by search metadata: a body passage read for this cell is
 * `sufficient`; only abstract-level material is `partial` with a reason that
 * says so; nothing at all is `missing`. A model's opinion is not an input.
 */
export function deriveCellCoverage(cell: CellRef, evidence: readonly CoverageEvidence[]): CoverageVerdict {
  const forCell = evidence.filter((entry) => entry.cells.some((ref) => sameCell(ref, cell)));
  if (forCell.length === 0) {
    return {
      status: "missing",
      reason: "尚无绑定到该单元格的证据",
      gap: "该单元格还没有任何实际读取的片段",
      evidenceIds: [],
    };
  }

  const bodyIds = forCell.filter((entry) => entry.readScope === "body_excerpt" || entry.readScope === "full_text");
  if (bodyIds.length > 0) {
    return {
      status: "sufficient",
      reason: `已有 ${bodyIds.length} 条来自实际正文的片段`,
      gap: "",
      evidenceIds: forCell.map((entry) => entry.id),
    };
  }

  const abstractIds = forCell.filter((entry) => entry.readScope === "abstract");
  if (abstractIds.length > 0) {
    return {
      status: "partial",
      reason: "目前只有摘要级片段，缺少正文依据",
      gap: "需要读取正文相关段落（如方法/实验/设置章节）",
      evidenceIds: forCell.map((entry) => entry.id),
    };
  }

  return {
    status: "missing",
    reason: "仅有元数据，不能作为证据",
    gap: "需要实际读取来源内容",
    evidenceIds: [],
  };
}

export function emptyUsage(): ResearchUsage {
  return { searches: 0, reads: 0, gapRounds: 0 };
}

export function isCellRef(value: unknown): value is CellRef {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["sectionId"] === "string" &&
    typeof record["subjectId"] === "string" &&
    typeof record["dimensionId"] === "string"
  );
}

/** Whether an id is one this codebase would mint: lowercase hex with a prefix. */
export function isDomainId(value: unknown, prefix: string): value is string {
  return typeof value === "string" && new RegExp(`^${prefix}_[0-9a-f]{12,}$`).test(value);
}

export const ID_PREFIX = Object.freeze({
  task: "task",
  source: "src",
  read: "read",
  evidence: "ev",
  report: "rep",
  export: "exp",
  claim: "clm",
  run: "jrn",
  submission: "sub",
} as const);
