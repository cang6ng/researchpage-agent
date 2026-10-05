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

/**
 * A cell's support state.
 *
 * The states separate two facts that used to be collapsed into one: material
 * was *obtained*, and somebody *judged* what that material supports. Reading a
 * body passage no longer counts as an answer — it produces `unassessed` until a
 * support assessment says how the passage bears on this cell's question.
 *
 * Only an assessment that is direct, supportive, and about a body-level passage
 * of this cell reaches `reviewed`, and even that says "已核对" rather than
 * "已证实为真". A contradiction stays visible as `conflict` instead of being
 * averaged away.
 */
export type CellStatus = "missing" | "unassessed" | "limited" | "reviewed" | "conflict";

/** Whether a cell's stated evidence requirement is met by an assessment. */
export function isCovered(status: CellStatus): boolean {
  return status === "reviewed";
}

/** Whether a cell still owes work: material, an assessment, or a decision. */
export function needsAttention(status: CellStatus): boolean {
  return status !== "reviewed";
}

/** How a passage bears on the question a cell asks. */
export type AssessmentRelationship = "supports" | "contradicts" | "contextual";

/** How close a passage is to the cell's question; `unassessed` is an option on purpose. */
export type AssessmentDirectness = "direct" | "indirect" | "contextual" | "unassessed";

/**
 * A saved judgement that a passage bears on a cell.
 *
 * The assessment is a record, not a verdict about reality: it names the
 * evidence, the relationship, how direct it is, the scope it holds under, and
 * who made the call. A model's assessment is marked `agent` and can be revised
 * by a person; what the product refuses to do is derive an answer from the mere
 * existence of a passage.
 */
export interface SupportAssessment {
  readonly id: string;
  readonly taskId: string;
  /** The cell, claim or research question this judgement is about. */
  readonly target: CellRef;
  readonly evidenceIds: readonly string[];
  readonly relationship: AssessmentRelationship;
  readonly directness: AssessmentDirectness;
  /** What the support covers, and under which conditions. */
  readonly scope: string;
  readonly rationale: string;
  readonly assessor: "agent" | "user";
  readonly createdAt: string;
}

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
  /**
   * Set when material arrived after the current report was saved.
   *
   * New evidence marks the working report as worth another look; it never edits
   * the report's text, and it never touches a frozen revision. Absent on tasks
   * written before this flag existed.
   */
  readonly reportNeedsReview?: ReportReviewFlag | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly error: string | null;
}

/** Why the working report may no longer reflect the material behind it. */
export interface ReportReviewFlag {
  readonly at: string;
  readonly reason: string;
  readonly evidenceIds: readonly string[];
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
  /**
   * SHA-256 over the report's own content, minted when it is sealed.
   *
   * It is what a proposal pins as its base and what a freeze records, so "the
   * text did not change" is a checkable statement rather than a promise. Absent
   * on reports written before this field existed; those are legacy records and
   * are never described as frozen.
   */
  readonly contentHash?: string;
  /** The matrix's outstanding gaps at the moment this report was saved. */
  readonly gapsAtSave?: readonly ReportGapNote[];
}

/**
 * One gap as it stood when a report was saved.
 *
 * The appendix a reader sees is part of the document, so it has to belong to
 * the report rather than to whatever the matrix says today. Names are copied
 * alongside the ids because a frozen revision may outlive a renamed subject.
 */
export interface ReportGapNote {
  readonly sectionId: string;
  readonly subjectId: string;
  readonly subjectName: string;
  readonly dimensionId: string;
  readonly dimensionName: string;
  readonly status: CellStatus;
  readonly reason: string;
  readonly gap: string;
}

/** The one export kind v1 delivers: a real PDF file of a report snapshot. */
export interface ExportArtifact {
  readonly id: string;
  readonly taskId: string;
  readonly reportId: string;
  /** The frozen revision this file was rendered from, when there was one. */
  readonly revisionId?: string | null;
  readonly themeId?: string | null;
  readonly rendererVersion?: string | null;
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
 * the report is one. `ask` and `edit` are the assistant's own actions, which
 * write nothing to the report. The stage is also what the workspace shows the
 * user, so "what is happening" is a fact about the task rather than about a
 * request. `followup` only survives as the value old records carry.
 */
export type ResearchStage = "card" | "research" | "gap" | "report" | "ask" | "edit" | "followup";

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

/** The minimum a saved judgement has to answer for coverage to be derivable. */
export interface CoverageAssessment {
  readonly target: CellRef;
  readonly evidenceIds: readonly string[];
  readonly relationship: AssessmentRelationship;
  readonly directness: AssessmentDirectness;
}

function sameCell(a: CellRef, b: CellRef): boolean {
  return a.sectionId === b.sectionId && a.subjectId === b.subjectId && a.dimensionId === b.dimensionId;
}

/** Whether a read obtained real prose, as opposed to a search result's metadata. */
function hasBodyText(scope: ReadScope): boolean {
  return scope === "body_excerpt" || scope === "full_text";
}

/**
 * Derives one cell's support state from material *and* judgement.
 *
 * The rule this function exists to keep is that a passage is not an answer.
 * Possession of a body-level excerpt gets a cell to `unassessed` and no
 * further; only a saved assessment that the passage directly supports this
 * cell's question reaches `reviewed`. An assessment that is indirect, merely
 * contextual, or about an abstract-level passage leaves the cell `limited`,
 * with the reason saying which of those applies, and a contradiction is
 * reported as `conflict` rather than outvoted.
 *
 * None of it can be satisfied by search metadata, and none of it reads a
 * model's prose: the inputs are ids, scopes, a relationship and a directness.
 */
export function deriveCellCoverage(
  cell: CellRef,
  evidence: readonly CoverageEvidence[],
  assessments: readonly CoverageAssessment[] = [],
): CoverageVerdict {
  // Metadata is a discovery fact, never evidence — a rule older than this
  // function and still the first thing it enforces.
  const forCell = evidence.filter((entry) => entry.readScope !== "metadata" && entry.cells.some((ref) => sameCell(ref, cell)));
  if (forCell.length === 0) {
    return {
      status: "missing",
      reason: "尚无绑定到该单元格的证据",
      gap: "该单元格还没有任何实际读取的片段",
      evidenceIds: [],
    };
  }

  const bodyIds = new Set(forCell.filter((entry) => hasBodyText(entry.readScope)).map((entry) => entry.id));
  const forCellIds = new Set(forCell.map((entry) => entry.id));
  // An assessment counts for a cell only when it names material that is really
  // bound here: a judgement about some other passage cannot colour this one.
  const relevant = assessments.filter(
    (entry) => sameCell(entry.target, cell) && entry.evidenceIds.some((id) => forCellIds.has(id)),
  );

  if (relevant.length === 0) {
    const bodyCount = bodyIds.size;
    return {
      status: "unassessed",
      reason:
        bodyCount > 0
          ? `已有 ${bodyCount} 条正文级片段，但还没有人核对它是否支持该问题`
          : "目前只有摘要级片段，且尚未评估支持关系",
      gap: "需要给出支持评估（关系、直接性、适用条件）后该单元格才算核对完成",
      evidenceIds: forCell.map((entry) => entry.id),
    };
  }

  const contradicting = relevant.filter((entry) => entry.relationship === "contradicts");
  if (contradicting.length > 0) {
    return {
      status: "conflict",
      reason: `已保存 ${contradicting.length} 条与该单元格相矛盾的评估`,
      gap: "需要区分条件或保留冲突，不能直接取其中一个结论",
      evidenceIds: forCell.map((entry) => entry.id),
    };
  }

  const directSupport = relevant.some(
    (entry) =>
      entry.relationship === "supports" && entry.directness === "direct" && entry.evidenceIds.some((id) => bodyIds.has(id)),
  );
  if (directSupport) {
    return {
      status: "reviewed",
      reason: "已保存直接支持该问题的正文级证据评估（不表示结论已被证明为真）",
      gap: "",
      evidenceIds: forCell.map((entry) => entry.id),
    };
  }

  return {
    status: "limited",
    reason: limitedReason(relevant, bodyIds),
    gap: "需要正文级、直接相关的支持，或收窄该单元格的问题范围",
    evidenceIds: forCell.map((entry) => entry.id),
  };
}

/** Why a cell stopped short of `reviewed`, in the words of the assessment. */
function limitedReason(assessments: readonly CoverageAssessment[], bodyIds: ReadonlySet<string>): string {
  const notes: string[] = [];
  const hasSupport = assessments.some((entry) => entry.relationship === "supports");
  const bodySupport = assessments.some(
    (entry) => entry.relationship === "supports" && entry.evidenceIds.some((id) => bodyIds.has(id)),
  );
  if (!hasSupport) notes.push("现有评估只提供背景或语境");
  else if (!bodySupport) notes.push("支持评估只指向摘要级片段");
  if (assessments.some((entry) => entry.relationship === "supports" && entry.directness === "indirect")) notes.push("支持关系为间接");
  if (assessments.some((entry) => entry.relationship === "supports" && entry.directness === "contextual")) notes.push("仅提供背景说明");
  if (assessments.some((entry) => entry.relationship === "supports" && entry.directness === "unassessed")) notes.push("尚未判断支持范围");
  const text = notes.length === 0 ? "评估未满足该单元格的要求" : notes.slice(0, 2).join("；");
  return `仅有限支持：${text}`;
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
  action: "act",
  proposal: "prop",
  revision: "rev",
  assessment: "asm",
} as const);
