/**
 * The research service: everything the product does with real material.
 *
 * Both callers share this one implementation — the Agent's tools, which a model
 * drives, and the application's own API, which the workspace drives — so that
 * "what the agent did" and "what the UI shows" can never be two different
 * stories. The service owns the truth rules: what counts as a source, what
 * counts as evidence, what a cell's coverage is, and what a report may cite.
 *
 * Budgets are enforced here, in the code that spends them, rather than in a
 * prompt: a search past the task's limit is refused with a sentence the model
 * can act on, and the refusal is a result rather than an exception, so a run
 * ends with an honest partial report instead of a loop.
 */

import type {
  CellRef,
  CoverageAssessment,
  CoverageEvidence,
  ClaimType,
  ReportDraftState,
  ReportFrame,
  Evidence,
  ExportArtifact,
  MatrixCell,
  Report,
  ReportClaim,
  ReportSection,
  ReportTask,
  ReadSnapshot,
  ResearchRunRecord,
  Source,
  SourceRole,
  SupportAssessment,
  AssessmentDirectness,
  AssessmentRelationship,
} from "./domain.js";
import { deriveCellCoverage, ID_PREFIX, needsAttention, suggestedFieldStates } from "./domain.js";
import { draftEvidence, pickParagraphs, scopeLabel, tokenize, verifyEvidenceText } from "./evidence.js";
import { hashOf } from "./hash.js";
import type { FrozenRevision } from "./revision.js";
import { buildRevisionBundle } from "./revision.js";
import {
  applyProposal,
  checkProposalFreshness,
  createProposal,
  sectionHash,
  type Proposal,
  type ProposalBase,
  type ProposalSection,
  type ProposalTarget,
} from "./proposal.js";
import { readSource, type ReadOutcome } from "./read.js";
import { newId, type ResearchRepository } from "./repository.js";
import { createGrant, type ActionCapability, type ActionGrant, type GrantInput } from "./semantics.js";
import { searchArxiv, type SearchOutcome } from "./search.js";
import { buildMatrix, createTask, normalizeCard, slugId, STRUCTURE_SECTIONS, type ProposedCard } from "./structure.js";
import { TECHNICAL_COMPARISON_V2, blueprintSections } from "./blueprint.js";
import {
  applyBriefPatch,
  briefBlueprintOf,
  briefFieldHash,
  briefFieldStatesOf,
  briefHashOf,
  briefStructureView,
  briefVersionOf,
  briefWithApplication,
  EDITABLE_BRIEF_FIELDS,
  fieldTakesFreeText,
  GUIDE_DECISION_LIMIT,
  guideQuestionIsStale,
  isStructural,
  lockedFieldStates,
  nextGuideTarget,
  patchFromFreeText,
  readBriefPatch,
  validateBriefDraft,
  type BriefFieldName,
  type BriefFieldStates,
  type BriefPatch,
  type BriefValidation,
  type GuideAnswerRecord,
  type GuideOption,
  type GuideQuestion,
  type GuideTarget,
} from "./brief.js";
import {
  buildCitations,
  gapNotesOf,
  missingCells,
  reportContentHash,
  sealReport,
  validateReport,
  type ReportDraft,
  type ValidationResult,
} from "./report.js";

export interface ResearchServiceOptions {
  readonly repo: ResearchRepository;
  /** The discovery path; the default is the real arXiv client. */
  readonly search?: (query: string, options: { readonly limit: number; readonly signal?: AbortSignal }) => Promise<SearchOutcome>;
  /** The read path; the default is the real HTTP reader. */
  readonly read?: (request: { readonly url: string }, options: { readonly signal?: AbortSignal }) => Promise<ReadOutcome>;
  readonly now?: () => Date;
}

/** One incremental write to the report draft. */
export type ReportPart =
  | {
      readonly kind: "start";
      readonly title?: string;
      readonly summary?: string;
      readonly frame?: ReportFrame;
      readonly claims?: readonly ReportClaim[];
      readonly section?: ReportSection;
    }
  | {
      readonly kind: "write";
      readonly title?: string;
      readonly summary?: string;
      readonly frame?: ReportFrame;
      readonly claims?: readonly ReportClaim[];
      readonly section?: ReportSection;
    }
  | { readonly kind: "finalize" }
  | { readonly kind: "clear" };

export interface Refusal {
  readonly ok: false;
  readonly problems: readonly string[];
  /** What the caller can still do, in one sentence. */
  readonly guidance: string;
  /**
   * Set when the refusal is about the state the record is in rather than about
   * the request's shape — a frozen brief, material a rebuild would strand. An
   * application API answers those with 409, because the same request would be
   * fine on a different draft.
   */
  readonly conflict?: true;
}

export interface SearchResult {
  readonly ok: true;
  readonly sources: readonly {
    readonly sourceId: string;
    readonly title: string;
    readonly authors: readonly string[];
    readonly year: string;
    readonly url: string;
    readonly abstract: string;
    readonly alreadyKnown: boolean;
  }[];
  readonly query: string;
  readonly requestUrl: string;
  readonly total: number | null;
  readonly searchCount: number;
  readonly searchesRemaining: number;
  readonly note: string;
}

export interface ReadResult {
  readonly ok: true;
  readonly sourceId: string;
  readonly title: string;
  readonly readStatus: Source["readStatus"];
  readonly readScope: Source["readScope"];
  readonly readUrl: string;
  /** What this source was judged to be; used by the claim contract. */
  readonly role: SourceRole | null;
  readonly textChars: number;
  readonly paragraphCount: number;
  readonly reuse: boolean;
  readonly evidence: readonly {
    readonly evidenceId: string;
    readonly excerpt: string;
    readonly locator: string;
    readonly scope: string;
    readonly pickedBecause: string;
  }[];
  readonly readsRemaining: number;
  readonly note: string;
}

export interface CellView extends CellRef {
  readonly subjectName: string;
  readonly dimensionName: string;
  readonly status: MatrixCell["status"];
  readonly reason: string;
  readonly gap: string;
  readonly evidenceIds: readonly string[];
  readonly note: string;
}

export interface AssessResult {
  readonly ok: true;
  readonly cells: readonly CellView[];
  readonly gaps: readonly CellView[];
  readonly gapRoundsUsed: number;
  readonly gapRoundsRemaining: number;
  readonly note: string;
}

export interface AcceptProposalResult {
  readonly ok: true;
  /** True when this call found the proposal already applied and changed nothing. */
  readonly alreadyApplied: boolean;
  readonly proposalId: string;
  readonly reportId: string;
  readonly contentHash: string;
}

export interface SaveReportResult {
  readonly ok: true;
  readonly reportId: string;
  readonly citations: number;
  readonly references: number;
  /** Obligations the report met softly, plus the matrix's outstanding gaps. */
  readonly warnings: readonly string[];
  readonly missingCells: number;
}

export interface WorkspaceState {
  readonly task: {
    readonly id: string;
    readonly topic: string;
    readonly purpose: string;
    readonly audience: string;
    readonly focus: readonly string[];
    readonly exclusions: string;
    readonly language: string;
    readonly lengthTarget: string;
    readonly status: ReportTask["status"];
    readonly confirmed: boolean;
  };
  readonly structure: readonly { readonly id: string; readonly title: string; readonly question: string }[];
  readonly subjects: readonly { readonly id: string; readonly name: string }[];
  readonly dimensions: readonly { readonly id: string; readonly name: string; readonly question: string }[];
  readonly cells: readonly CellView[];
  readonly sources: readonly {
    readonly sourceId: string;
    readonly title: string;
    readonly role: SourceRole | null;
    readonly readStatus: Source["readStatus"];
    readonly readScope: Source["readScope"];
    readonly url: string;
  }[];
  readonly evidence: readonly {
    readonly evidenceId: string;
    readonly sourceId: string;
    readonly excerpt: string;
    readonly locator: string;
    readonly scope: string;
  }[];
  readonly usage: ReportTask["usage"];
  readonly budget: ReportTask["budget"];
  /** The Research Brief: the draft, or the record confirmation froze. */
  readonly brief: BriefView;
  readonly currentReportId: string | null;
  /** The current report's own content hash, or null when there is no report. */
  readonly currentReportHash: string | null;
  /** Set when material arrived after the current report was saved. */
  readonly reportNeedsReview: ReportTask["reportNeedsReview"];
  /** A bounded view of the current report, for a reader that means to revise it. */
  readonly currentReport: {
    readonly reportId: string;
    readonly title: string;
    readonly summary: string;
    readonly frame: ReportFrame | null;
    readonly validation: {
      readonly ok: boolean;
      readonly warnings: readonly string[];
      readonly checks: readonly { readonly id: string; readonly result: string; readonly detail: string }[];
    };
    readonly sections: readonly { readonly id: string; readonly title: string }[];
    readonly claims: readonly {
      readonly id: string;
      readonly text: string;
      readonly kind: string;
      readonly claimType: ClaimType;
      readonly synthesis: boolean;
    }[];
  } | null;
}

/** One offered answer, as a client sees it: the reasoning, not the patch. */
export interface GuideOptionView {
  readonly optionId: string;
  readonly label: string;
  readonly description?: string;
  readonly recommended?: boolean;
}

/** The question Guided Mode is currently asking, if any. */
export interface GuideQuestionView {
  readonly questionId: string;
  readonly question: string;
  readonly whyThisMatters: string;
  readonly fieldTargets: readonly BriefFieldName[];
  readonly options: readonly GuideOptionView[];
  readonly allowFreeText: boolean;
  readonly basedOnBriefVersion: number;
  readonly createdAt: string;
}

/** A decision the user already made through Guided Mode. */
export interface GuideDecisionView {
  readonly questionId: string;
  readonly question: string;
  readonly fieldTargets: readonly BriefFieldName[];
  readonly optionIds: readonly string[];
  readonly freeText: string;
  readonly appliedFields: readonly BriefFieldName[];
  readonly resultingBriefVersion: number;
  readonly at: string;
}

/**
 * The Brief as the workspace reads it.
 *
 * It carries the whole draft — including the derived report structure, which is
 * shown but never edited, because it is the blueprint's cognitive contract
 * rather than a heading list — together with what each field's state is and
 * what the draft still owes before research may start. When the task is already
 * confirmed the same view is returned with `readonly` set: an old project stays
 * readable, and nothing about it is re-opened as a draft.
 */
export interface BriefView {
  readonly taskId: string;
  readonly confirmed: boolean;
  readonly readonly: boolean;
  readonly version: number;
  readonly updatedAt: string | null;
  readonly blueprint: {
    readonly id: string;
    readonly name: string;
    readonly purpose: string;
    readonly minimumSubjects: number;
    readonly minimumDimensions: number;
    readonly recommendedSubjects: readonly [number, number];
    readonly recommendedDimensions: readonly [number, number];
  };
  readonly topic: string;
  readonly question: string;
  readonly purpose: string;
  readonly audience: string;
  readonly focus: readonly string[];
  readonly exclusions: string;
  readonly lengthTarget: string;
  readonly subjects: readonly { readonly id: string; readonly name: string; readonly note?: string }[];
  readonly dimensions: readonly { readonly id: string; readonly name: string; readonly question: string }[];
  readonly reportStructure: readonly { readonly id: string; readonly title: string; readonly question: string; readonly required: boolean }[];
  readonly editableFields: readonly BriefFieldName[];
  readonly fieldStates: BriefFieldStates;
  readonly validation: BriefValidation;
  readonly guide: {
    /** True when Guided Mode has nothing further worth asking. */
    readonly complete: boolean;
    /** Why it stopped, in a sentence. */
    readonly reason: string;
    readonly decisions: readonly GuideDecisionView[];
    readonly active: GuideQuestionView | null;
  };
  readonly matrix: { readonly subjects: number; readonly dimensions: number; readonly cells: number };
  readonly contentHash: string;
}

export interface PatchBriefResult {
  readonly ok: true;
  readonly brief: BriefView;
  readonly changedFields: readonly BriefFieldName[];
}

export interface ConfirmResult {
  readonly ok: true;
  readonly task: ReportTask;
  readonly briefVersion: number;
  /** Whether confirming had to reconcile the matrix with the final brief. */
  readonly matrixRebuilt: boolean;
}

export interface GuideAnswerInput {
  readonly questionId: string;
  readonly expectedVersion?: number;
  readonly optionIds?: readonly string[];
  readonly freeText?: string;
}

export interface GuideAnswerResult {
  readonly ok: true;
  readonly brief: BriefView;
  readonly appliedFields: readonly BriefFieldName[];
  readonly complete: boolean;
}

export type ProposeGuideQuestionResult =
  | { readonly ok: true; readonly complete: true; readonly reason: string; readonly question: null }
  | { readonly ok: true; readonly complete: false; readonly reason: string; readonly question: GuideQuestion };

/** What Guided Mode would ask about next, before a question has been written. */
export interface GuideTargetDecision {
  readonly complete: boolean;
  readonly reason: string;
  readonly target: GuideTarget | null;
  readonly answered: number;
}

/** A refusal that also hands back the current brief, so a client can resync. */
export interface BriefConflict {
  readonly ok: false;
  readonly stale: true;
  readonly problems: readonly string[];
  readonly guidance: string;
  readonly brief: BriefView;
}

export interface ResearchService {
  /** The task a session is trusted to: the only way a tool finds its target. */
  taskForSession(sessionId: string): ReportTask | undefined;
  proposeTask(sessionId: string, card: ProposedCard): { readonly ok: true; readonly task: ReportTask; readonly created: boolean } | Refusal;
  /**
   * The user's decision to start research, taken on the current draft.
   *
   * Confirming is where the draft stops being a draft: the brief is validated
   * as a whole, its field states are locked, and the matrix is reconciled with
   * the subjects and dimensions the user finally agreed to. A draft that is
   * still incomplete is refused here rather than silently researched.
   */
  confirmTask(taskId: string, input?: { readonly expectedVersion?: number }): ConfirmResult | Refusal;

  // ------------------------------------------------------------------ brief --
  /** The Research Brief: the editable draft, or the frozen record once confirmed. */
  briefOf(taskId: string): BriefView;
  /**
   * Applies one structured edit to the draft and returns the resulting brief.
   *
   * The patch names the fields it touches; everything else — ids, ordering,
   * normalization, the matrix — is the server's. A patch that would produce a
   * structurally unusable matrix is refused outright, while a patch that merely
   * leaves the draft incomplete is applied and reported as incomplete.
   */
  patchBrief(taskId: string, input: { readonly expectedVersion?: number; readonly patch: unknown }): PatchBriefResult | Refusal | BriefConflict;
  /** The decision Guided Mode would ask about next, or why it has stopped. */
  guideTargetOf(taskId: string): GuideTargetDecision;
  activeGuideQuestion(taskId: string): GuideQuestion | undefined;
  guideQuestionsOf(taskId: string): readonly GuideQuestion[];
  /**
   * Stores the question a guide stage wrote, after checking it against the draft.
   *
   * The model writes the wording and the offered answers; it does not choose
   * the target, and every option it offers must carry a patch that the server
   * can really apply to the field it claims to answer. A question that fails
   * that check is refused rather than stored and guessed at later.
   */
  proposeGuideQuestion(taskId: string, input: unknown): ProposeGuideQuestionResult | Refusal;
  /** Applies one guided answer to the same draft a structured edit writes to. */
  answerGuideQuestion(taskId: string, input: GuideAnswerInput): GuideAnswerResult | Refusal | BriefConflict;

  startResearch(taskId: string): ReportTask;
  failTask(taskId: string, error: string): void;
  getTask(taskId: string): ReportTask | undefined;
  search(taskId: string, input: { readonly query: string; readonly limit?: number; readonly targetSectionId?: string; readonly targetCell?: CellRef; readonly signal?: AbortSignal }): Promise<SearchResult | Refusal>;
  read(taskId: string, input: {
    readonly sourceId: string;
    readonly question: string;
    readonly terms?: readonly string[];
    readonly targetCell?: CellRef;
    readonly maxEvidence?: number;
    readonly paragraphIndex?: number;
    /** What kind of material the agent judges this source to be. */
    readonly role?: SourceRole;
    readonly signal?: AbortSignal;
  }): Promise<ReadResult | Refusal>;
  assess(taskId: string, input: {
    readonly proposals: readonly {
      readonly cell: CellRef;
      readonly evidenceIds?: readonly string[];
      readonly note?: string;
      /** How the cited material bears on this cell; absent means "not judged yet". */
      readonly relationship?: AssessmentRelationship;
      readonly directness?: AssessmentDirectness;
      /** The conditions the support holds under. */
      readonly scope?: string;
      readonly rationale?: string;
    }[];
    readonly gapRound?: boolean;
  }): AssessResult | Refusal;
  saveReport(taskId: string, draft: ReportDraft): SaveReportResult | Refusal;
  /**
   * The incremental path: accumulate the report across calls, then seal it.
   *
   * A full report does not fit in one step's output budget, so a model may
   * write it in parts. Accumulation is stored on the task, and only `finalize`
   * runs the validator — the same one the one-shot path uses.
   */
  saveReportPart(taskId: string, part: ReportPart): SaveReportResult | Refusal;
  reportDraftOf(taskId: string): ReportDraftState | null;
  /**
   * Runs the full validation over the accumulated draft without saving it.
   *
   * The staged runner uses this between the section pass and the synthesis
   * pass, so the model is told what is still wrong with what it has written
   * before it is asked to conclude anything.
   */
  previewDraftValidation(taskId: string): ValidationResult | null;
  state(taskId: string): WorkspaceState;
  cellsOf(taskId: string): readonly CellView[];
  sourcesOf(taskId: string): readonly Source[];
  evidenceOf(taskId: string): readonly Evidence[];
  reportsOf(taskId: string): readonly Report[];
  exportsOf(taskId: string): readonly ExportArtifact[];
  saveExport(artifact: ExportArtifact): void;
  runsOf(taskId: string): readonly ResearchRunRecord[];
  recordRun(record: ResearchRunRecord): void;
  listTasks(): readonly ReportTask[];
  snapshotTextOf(readId: string): string | undefined;

  // ---------------------------------------------------------------- actions --
  /**
   * Mints the permission a run will act under.
   *
   * Only the application calls this, and only when it is about to start a run
   * of its own: the grant is the write boundary, so a model that asks the
   * service for one would be asking to authorize itself.
   */
  issueGrant(input: GrantInput): ActionGrant;
  activeGrant(sessionId: string): ActionGrant | undefined;
  clearGrant(sessionId: string): void;

  // ------------------------------------------------------------ assessments --
  assessmentsOf(taskId: string): readonly SupportAssessment[];
  /** Records a judgement about how material bears on a cell. */
  recordAssessment(
    taskId: string,
    input: {
      readonly target: CellRef;
      readonly evidenceIds?: readonly string[];
      readonly relationship?: AssessmentRelationship;
      readonly directness?: AssessmentDirectness;
      readonly scope?: string;
      readonly rationale?: string;
      readonly assessor?: "agent" | "user";
    },
  ): SupportAssessment | Refusal;

  // --------------------------------------------------------------- proposals --
  /** Stages a scoped change to the current report. Nothing is applied yet. */
  createProposal(
    taskId: string,
    input: {
      readonly actionId: string;
      readonly sections: readonly ProposalSection[];
      readonly claims?: readonly ReportClaim[];
      readonly summary?: string;
      readonly reason: string;
    },
  ): { readonly ok: true; readonly proposal: Proposal } | Refusal;
  proposalById(proposalId: string): Proposal | undefined;
  proposalsOf(taskId: string): readonly Proposal[];
  /** The single proposal a project may keep waiting for a decision. */
  pendingProposalOf(taskId: string): Proposal | undefined;
  acceptProposal(
    proposalId: string,
    input?: { readonly expectedBaseReportId?: string; readonly expectedBaseContentHash?: string },
  ): AcceptProposalResult | Refusal;
  discardProposal(proposalId: string): { readonly ok: true; readonly proposal: Proposal } | Refusal;

  // --------------------------------------------------------------- revisions --
  /** Freezes a report together with the dependencies its export needs. */
  freezeRevision(input: {
    readonly taskId: string;
    readonly reportId?: string;
    readonly expectedContentHash?: string;
    readonly themeId?: string;
  }): { readonly ok: true; readonly revision: FrozenRevision; readonly existing: boolean } | Refusal;
  revisionsOf(taskId: string): readonly FrozenRevision[];
  revisionById(revisionId: string): FrozenRevision | undefined;
  /** The frozen revision of one report, when one has been taken. */
  revisionForReport(reportId: string): FrozenRevision | undefined;
  contentHashOf(taskId: string, reportId?: string): string | null;
}

function sameCell(a: CellRef, b: CellRef): boolean {
  return a.sectionId === b.sectionId && a.subjectId === b.subjectId && a.dimensionId === b.dimensionId;
}

function locatorLabelOf(evidence: Evidence): string {
  const parts = (evidence.locator.headingPath ?? []).filter(
    (part): part is string => typeof part === "string" && part.trim().length > 0,
  );
  return parts.length > 0
    ? `${parts.join(" > ")}（第 ${evidence.locator.paragraphIndex + 1} 段）`
    : `第 ${evidence.locator.paragraphIndex + 1} 段`;
}

export function createResearchService(options: ResearchServiceOptions): ResearchService {
  const repo = options.repo;
  const now = options.now ?? (() => new Date());
  const searchImpl = options.search ?? ((query: string, searchOptions: { readonly limit: number; readonly signal?: AbortSignal }) => searchArxiv(query, searchOptions));
  const readImpl = options.read ?? ((request: { readonly url: string }, readOptions: { readonly signal?: AbortSignal }) => readSource(request, readOptions));

  const isoNow = (): string => now().toISOString();

  function requireTask(taskId: string): ReportTask {
    const task = repo.getTask(taskId);
    if (task === undefined) throw new Error(`没有找到研究任务：${taskId}`);
    return task;
  }

  function updateTask(task: ReportTask, patch: Partial<ReportTask>): ReportTask {
    const next: ReportTask = { ...task, ...patch, updatedAt: isoNow() };
    repo.updateTask(next);
    return next;
  }

  // ------------------------------------------------------------ permissions --

  /**
   * The grants this process has issued, by the session they belong to.
   *
   * They live for the length of an action, not in the database: a grant is
   * permission to write *now*, and a run that did not survive a restart should
   * not leave standing permission behind. What outlives the process is the
   * record of what was done — a proposal names the action that produced it.
   */
  const grants = new Map<string, ActionGrant>();

  const CAPABILITY_TEXT: Readonly<Record<ActionCapability, string>> = Object.freeze({
    card: "建立任务卡",
    brief: "修改研究简报草稿与引导问题",
    research: "检索、读取与保存证据",
    report: "保存报告版本",
    proposal: "生成修改提案",
  });

  /**
   * Refuses a write the current action is not authorized for.
   *
   * This is the product's real permission boundary: not a prompt sentence, and
   * not a field the model filled in. A run without a grant can read, and
   * nothing else; a run whose grant was issued for Ask can read, and nothing
   * else, whatever its tools claim about their intent.
   */
  function requireSessionCapability(sessionId: string, capability: ActionCapability): Refusal | undefined {
    const grant = grants.get(sessionId);
    const what = CAPABILITY_TEXT[capability];
    if (grant === undefined) {
      return {
        ok: false,
        problems: [`当前动作没有授权，${what}被拒绝`],
        guidance: "权限由应用在发起 Ask / Research / Edit 动作时签发，不能由工具参数声明；请等待界面发起新的动作。",
      };
    }
    if (!grant.capabilities.includes(capability)) {
      return {
        ok: false,
        problems: [`本次动作的意图是 ${grant.intent}（${grant.scope}），不允许${what}`],
        guidance:
          capability === "report"
            ? "报告正文只能由「生成报告」阶段保存，或在接受修改提案后更新；Research 只增加材料，Edit 只产生提案。"
            : "请改用允许该写入的动作入口，不要尝试扩大本次授权范围。",
      };
    }
    return undefined;
  }

  function requireTaskCapability(taskId: string, capability: ActionCapability): Refusal | undefined {
    const task = repo.getTask(taskId);
    if (task === undefined) {
      return { ok: false, problems: [`没有找到研究任务：${taskId}`], guidance: "请确认任务 id。" };
    }
    const refusal = requireSessionCapability(task.sessionId, capability);
    if (refusal !== undefined) return refusal;
    const grant = grants.get(task.sessionId);
    if (grant !== undefined && grant.taskId !== null && grant.taskId !== taskId) {
      return {
        ok: false,
        problems: [`当前授权属于任务 ${grant.taskId}，不能写入任务 ${taskId}`],
        guidance: "一次动作只作用于发起它的那个任务。",
      };
    }
    return undefined;
  }

  // -------------------------------------------------------------- derivation --

  function coverageInputs(taskId: string): {
    readonly evidence: readonly CoverageEvidence[];
    readonly assessments: readonly CoverageAssessment[];
  } {
    const evidence = repo.listEvidence(taskId).map((item) => ({
      id: item.id,
      readScope: item.readScope,
      cells: item.cells,
    }));
    const assessments = repo.listAssessments(taskId).map((entry) => ({
      target: entry.target,
      evidenceIds: entry.evidenceIds,
      relationship: entry.relationship,
      directness: entry.directness,
    }));
    return { evidence, assessments };
  }

  /** Recomputes every cell's support state from material and saved judgements. */
  function recomputeMatrix(task: ReportTask): ReportTask {
    const inputs = coverageInputs(task.id);
    const at = isoNow();
    const matrix = task.matrix.map((cell) => {
      const verdict = deriveCellCoverage(
        { sectionId: cell.sectionId, subjectId: cell.subjectId, dimensionId: cell.dimensionId },
        inputs.evidence,
        inputs.assessments,
      );
      return {
        ...cell,
        status: verdict.status,
        reason: verdict.reason,
        gap: verdict.status === "reviewed" ? "" : verdict.gap,
        evidenceIds: verdict.evidenceIds,
        updatedAt: at,
      };
    });
    return updateTask(task, { matrix });
  }

  /**
   * Marks the working report as worth another look after material changed.
   *
   * The flag is deliberately not an edit: the report's text and hash stay put,
   * and a frozen revision is untouched. All this does is stop the product from
   * implying that a report written before yesterday's evidence is still current.
   */
  function markReportForReview(taskId: string, reason: string, evidenceIds: readonly string[]): void {
    const task = repo.getTask(taskId);
    if (task === undefined || task.currentReportId === null) return;
    const previous = task.reportNeedsReview;
    const merged = [...new Set([...(previous?.evidenceIds ?? []), ...evidenceIds])].slice(0, 20);
    updateTask(task, { reportNeedsReview: { at: isoNow(), reason, evidenceIds: merged } });
  }

  /** The report a proposal edits: the task's current one, or none. */
  function currentReportOf(task: ReportTask): Report | undefined {
    if (task.currentReportId === null) return undefined;
    const report = repo.getReport(task.currentReportId);
    return report !== undefined && report.taskId === task.id ? report : undefined;
  }

  function proposalBaseOf(report: Report): ProposalBase {
    return {
      title: report.title,
      summary: report.summary,
      ...(report.frame === undefined ? {} : { frame: report.frame }),
      sections: report.sections,
      claims: report.claims,
    };
  }

  function budgetRefusal(task: ReportTask, what: string, guidance: string): Refusal | undefined {
    const started = task.usage.startedAt;
    if (started !== undefined) {
      const elapsed = now().getTime() - new Date(started).getTime();
      if (elapsed > task.budget.deadlineMs) {
        return {
          ok: false,
          problems: [`研究时间预算已用尽（${Math.round(elapsed / 1000)} 秒 > ${Math.round(task.budget.deadlineMs / 1000)} 秒）`],
          guidance: "请基于现有证据生成报告；对没有依据的项目明确写出缺口，不要继续检索。",
        };
      }
    }
    switch (what) {
      case "search":
        if (task.usage.searches >= task.budget.maxSearches) {
          return {
            ok: false,
            problems: [`搜索次数已达上限（${task.usage.searches}/${task.budget.maxSearches}）`],
            guidance: "请读取已知候选来源，并用 assess_coverage 评估覆盖情况。",
          };
        }
        break;
      case "read":
        if (task.usage.reads >= task.budget.maxReads) {
          return {
            ok: false,
            problems: [`读取次数已达上限（${task.usage.reads}/${task.budget.maxReads}）`],
            guidance: "请停止读取，评估矩阵并用已有证据生成报告；缺少依据的项目如实标注。",
          };
        }
        break;
      case "gap":
        if (task.usage.gapRounds >= task.budget.maxGapRounds) {
          return {
            ok: false,
            problems: [`定向补查轮次已达上限（${task.usage.gapRounds}/${task.budget.maxGapRounds}）`],
            guidance: "补查预算已用完：请在报告中明确写出仍未找到依据的比较项。",
          };
        }
        break;
    }
    return undefined;
  }

  /**
   * The matrix as a reader should see it.
   *
   * The status is derived here rather than read from the stored cell: the row
   * on the task is a cache, and a cache written by an older version of this
   * product can hold a word that no longer means anything — `sufficient`, from
   * when a body passage was taken as an answer. Deriving on read means an
   * existing project shows honest states the moment it is opened, and no
   * migration script gets to decide that yesterday's evidence is today's
   * judgement.
   */
  function cellViews(task: ReportTask): readonly CellView[] {
    const inputs = coverageInputs(task.id);
    const subjectNames = new Map(task.subjects.map((subject) => [subject.id, subject.name]));
    const dimensionNames = new Map(task.dimensions.map((dimension) => [dimension.id, dimension.name]));
    return task.matrix.map((cell) => {
      const verdict = deriveCellCoverage(
        { sectionId: cell.sectionId, subjectId: cell.subjectId, dimensionId: cell.dimensionId },
        inputs.evidence,
        inputs.assessments,
      );
      return {
        sectionId: cell.sectionId,
        subjectId: cell.subjectId,
        dimensionId: cell.dimensionId,
        subjectName: subjectNames.get(cell.subjectId) ?? cell.subjectId,
        dimensionName: dimensionNames.get(cell.dimensionId) ?? cell.dimensionId,
        status: verdict.status,
        reason: verdict.reason,
        gap: verdict.status === "reviewed" ? "" : verdict.gap,
        evidenceIds: verdict.evidenceIds,
        note: cell.note,
      };
    });
  }

  function refusalsOf(validation: ValidationResult): readonly string[] {
    return validation.problems;
  }

  /**
   * Refuses a section the task's structure does not define.
   *
   * A report's sections are the research structure, not free-form headings: an
   * unknown id is either a typo or a section invented on the spot, and both
   * would render a heading that no obligation, no matrix column and no reader
   * outline refers to.
   */
  function unknownSectionRefusal(task: ReportTask, sectionIds: readonly string[]): Refusal | undefined {
    const known = task.structure.sections.map((section) => section.id);
    const unknown = sectionIds.filter((id) => !known.includes(id));
    if (unknown.length === 0) return undefined;
    return {
      ok: false,
      problems: [`章节 id 不在本次报告结构里：${unknown.map((id) => (id === "" ? "（空）" : id)).join("、")}`],
      guidance: `可用章节 id：${known.join(" / ")}。章节的 id 与认知义务由研究结构决定，不能自行新增。`,
    };
  }

  // ------------------------------------------------------------- the brief --

  function requireEditableBrief(task: ReportTask, action: string): Refusal | undefined {
    if (task.confirmedAt === null) return undefined;
    return {
      ok: false,
      conflict: true,
      problems: [`研究简报已确认（${task.confirmedAt}），${action}被拒绝`],
      guidance:
        "确认后的 Brief 是研究框架的一部分，不再作为草稿存在：需要改变方向请新建研究任务；报告层面的修改属于 Edit 语义。",
    };
  }

  /** Whether this task already holds material that a rebuild would strand. */
  function hasResearchData(task: ReportTask): boolean {
    return (
      task.currentReportId !== null ||
      repo.listEvidence(task.id).length > 0 ||
      repo.listAssessments(task.id).length > 0 ||
      repo.listReports(task.id).length > 0 ||
      repo.listSources(task.id).some((source) => source.readStatus === "ok")
    );
  }

  function cellKeyOf(cell: { sectionId: string; subjectId: string; dimensionId: string }): string {
    return `${cell.sectionId}|${cell.subjectId}|${cell.dimensionId}`;
  }

  /**
   * The matrix as the brief's projection.
   *
   * Every cell of the new subject×dimension set is present exactly once and in
   * the brief's order, so a deleted subject takes its row with it instead of
   * leaving a cell nobody can explain. A cell that still exists *and* carries
   * work keeps it; a pristine cell is regenerated, which is what lets a rename
   * reach the wording of its own gap sentence.
   */
  function syncMatrix(task: ReportTask, at: string): { readonly matrix: readonly MatrixCell[]; readonly rebuilt: boolean } {
    const fresh = buildMatrix(task.subjects, task.dimensions, at);
    const rebuilt =
      fresh.length !== task.matrix.length ||
      fresh.some((cell, index) => cellKeyOf(cell) !== cellKeyOf(task.matrix[index] ?? { sectionId: "?", subjectId: "?", dimensionId: "?" }));
    if (!rebuilt) return { matrix: task.matrix, rebuilt: false };
    const previous = new Map(task.matrix.map((cell) => [cellKeyOf(cell), cell]));
    const matrix = fresh.map((cell) => {
      const before = previous.get(cellKeyOf(cell));
      if (before === undefined) return cell;
      if (before.status === "missing" && before.note === "") return cell;
      return before;
    });
    return { matrix, rebuilt: true };
  }

  function versionConflict(task: ReportTask, expected: number | undefined): BriefConflict | undefined {
    if (expected === undefined || expected === briefVersionOf(task)) return undefined;
    return staleConflict(task, `研究简报已更新到版本 ${briefVersionOf(task)}，不是 ${expected}；请按最新草稿重新提交。`);
  }

  function staleConflict(task: ReportTask, message: string): BriefConflict {
    return {
      ok: false,
      stale: true,
      problems: [message],
      guidance: "请重新读取 Brief 与当前引导问题，不要用旧内容覆盖用户刚刚做出的决定。",
      brief: briefViewOf(task),
    };
  }

  type BriefChange = Refusal | { readonly ok: true; readonly task: ReportTask; readonly fields: readonly BriefFieldName[] };

  /**
   * The one path both ways of editing the brief go through.
   *
   * Guided Mode is not a second implementation: an answer becomes a patch, and
   * that patch is normalized, validated and written exactly as a structured
   * edit would be. The only difference is the state the touched fields land in
   * — a person who answered a question decided those fields.
   */
  function applyBriefChange(
    task: ReportTask,
    patch: BriefPatch,
    state: "edited" | "confirmed",
    at: string,
  ): BriefChange {
    const applied = applyBriefPatch(task, patch);
    if (!applied.ok) {
      return {
        ok: false,
        problems: applied.problems.map((entry) => entry.problem),
        guidance: "请检查对象/维度的 id 是否来自当前 Brief；新增项不要带 id。",
      };
    }
    const structural = isStructural(applied.fields);
    if (structural && hasResearchData(task)) {
      return {
        ok: false,
        conflict: true,
        problems: ["该任务已经保存了实际读取的材料或报告，不能再用编辑简报的方式增删对象或维度"],
        guidance:
          "不静默删除已保存的研究材料：请恢复原有的对象与维度，或新建一个研究任务重新开始。",
      };
    }

    const states: Record<string, BriefFieldStates[keyof BriefFieldStates]> = { ...briefFieldStatesOf(task) };
    for (const field of applied.fields) states[field] = state;

    let next: ReportTask = {
      ...briefWithApplication(task, applied.value),
      briefVersion: briefVersionOf(task) + 1,
      briefFieldStates: states as BriefFieldStates,
      briefUpdatedAt: at,
      updatedAt: at,
    };
    if (structural) next = { ...next, matrix: syncMatrix(next, at).matrix };
    repo.updateTask(next);
    return { ok: true, task: next, fields: applied.fields };
  }

  /** Retires any live question whose target the user just changed directly. */
  function supersedeAffectedQuestions(task: ReportTask, fields: readonly BriefFieldName[]): void {
    for (const question of repo.listGuideQuestions(task.id)) {
      if (question.status !== "active") continue;
      if (question.fieldTargets.some((field) => fields.includes(field))) {
        repo.saveGuideQuestion({ ...question, status: "superseded" });
      }
    }
  }

  function answeredGuideDecisions(taskId: string): readonly GuideQuestion[] {
    return repo.listGuideQuestions(taskId).filter((question) => question.status === "answered" && question.answer !== null);
  }

  /** What Guided Mode would ask about next, and why it stopped when it did. */
  function guideTargetDecision(task: ReportTask): GuideTargetDecision {
    if (task.confirmedAt !== null) {
      return { complete: true, reason: "研究简报已确认，引导式规划结束", target: null, answered: 0 };
    }
    const answered = answeredGuideDecisions(task.id).length;
    const closed = task.guideClosed ?? null;
    if (closed !== null) {
      return { complete: true, reason: closed.reason, target: null, answered };
    }
    const target = nextGuideTarget({ task, answered });
    if (target === undefined) {
      return {
        complete: true,
        reason:
          answered >= GUIDE_DECISION_LIMIT
            ? `已完成 ${answered} 个引导决策（上限 ${GUIDE_DECISION_LIMIT}）；其余字段可以随时直接编辑`
            : "所有可引导的字段都已经由用户决定",
        target: null,
        answered,
      };
    }
    return { complete: false, reason: "", target, answered };
  }

  function optionViewOf(option: GuideOption): GuideOptionView {
    return {
      optionId: option.optionId,
      label: option.label,
      ...(option.description === undefined ? {} : { description: option.description }),
      ...(option.recommended === undefined ? {} : { recommended: option.recommended }),
    };
  }

  /** The Brief as the workspace reads it, derived fresh from the task. */
  function briefViewOf(task: ReportTask): BriefView {
    const blueprint = briefBlueprintOf(task);
    const decision = guideTargetDecision(task);
    const active = repo.listGuideQuestions(task.id).find((question) => question.status === "active");
    return {
      taskId: task.id,
      confirmed: task.confirmedAt !== null,
      readonly: task.confirmedAt !== null,
      version: briefVersionOf(task),
      updatedAt: task.briefUpdatedAt ?? null,
      blueprint: {
        id: blueprint.id,
        name: blueprint.name,
        purpose: blueprint.purpose,
        minimumSubjects: blueprint.briefMinimums.subjects,
        minimumDimensions: blueprint.briefMinimums.dimensions,
        recommendedSubjects: blueprint.briefRecommended.subjects,
        recommendedDimensions: blueprint.briefRecommended.dimensions,
      },
      topic: task.topic,
      question: task.purpose,
      purpose: task.purpose,
      audience: task.audience,
      focus: task.focus,
      exclusions: task.exclusions,
      lengthTarget: task.lengthTarget,
      subjects: task.subjects.map((subject) => ({
        id: subject.id,
        name: subject.name,
        ...(subject.note === undefined ? {} : { note: subject.note }),
      })),
      dimensions: task.dimensions.map((dimension) => ({ id: dimension.id, name: dimension.name, question: dimension.question })),
      reportStructure: briefStructureView(task),
      editableFields: EDITABLE_BRIEF_FIELDS,
      fieldStates: briefFieldStatesOf(task),
      validation: validateBriefDraft(task),
      guide: {
        complete: decision.complete,
        reason: decision.reason,
        decisions: answeredGuideDecisions(task.id).map((question) => ({
          questionId: question.id,
          question: question.question,
          fieldTargets: question.fieldTargets,
          optionIds: question.answer?.optionIds ?? [],
          freeText: question.answer?.freeText ?? "",
          appliedFields: question.answer?.appliedFields ?? [],
          resultingBriefVersion: question.answer?.resultingBriefVersion ?? question.basedOnBriefVersion,
          at: question.answer?.at ?? question.createdAt,
        })),
        active:
          active === undefined
            ? null
            : {
                questionId: active.id,
                question: active.question,
                whyThisMatters: active.whyThisMatters,
                fieldTargets: active.fieldTargets,
                options: active.options.map(optionViewOf),
                allowFreeText: active.allowFreeText,
                basedOnBriefVersion: active.basedOnBriefVersion,
                createdAt: active.createdAt,
              },
      },
      matrix: { subjects: task.subjects.length, dimensions: task.dimensions.length, cells: task.matrix.length },
      contentHash: briefHashOf(task),
    };
  }

  type GuideReading =
    | { readonly ok: true; readonly complete: true; readonly reason: string }
    | {
        readonly ok: true;
        readonly complete: false;
        readonly question: string;
        readonly whyThisMatters: string;
        readonly fieldTargets: readonly BriefFieldName[];
        readonly options: readonly GuideOption[];
      }
    | { readonly ok: false; readonly problems: readonly string[] };

  /**
   * Reads the question a guide stage wrote, and checks it against the draft.
   *
   * The checks are the point. The targets must be exactly the field the program
   * chose, so a model cannot drift the conversation onto something else; every
   * option must carry a patch that only touches those targets and that the
   * normalizer really accepts against this draft, so a stored option is an
   * answer the server can apply without asking anyone what it meant.
   */
  function readGuideQuestionInput(value: unknown, target: GuideTarget, task: ReportTask): GuideReading {
    const record = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
    if (record === undefined) return { ok: false, problems: ["参数必须是一个对象"] };

    const complete = record["complete"] === true;
    const reason = typeof record["reason"] === "string" ? record["reason"].trim() : "";
    if (complete) {
      if (reason.length === 0) return { ok: false, problems: ["complete=true 时必须给出 reason，说明为什么没有更值得确认的字段"] };
      return { ok: true, complete: true, reason };
    }

    const problems: string[] = [];
    const question = typeof record["question"] === "string" ? record["question"].trim() : "";
    if (question.length === 0) problems.push("缺少 question");
    if (question.length > 400) problems.push("question 过长（>400 字）");
    const whyThisMatters = typeof record["whyThisMatters"] === "string" ? record["whyThisMatters"].trim() : "";
    if (whyThisMatters.length === 0) problems.push("缺少 whyThisMatters（一句话说明它为什么值得确认）");

    const targets = Array.isArray(record["fieldTargets"])
      ? record["fieldTargets"].filter((entry): entry is string => typeof entry === "string")
      : [];
    const fieldTargets = targets.filter((entry): entry is BriefFieldName => (EDITABLE_BRIEF_FIELDS as readonly string[]).includes(entry));
    if (fieldTargets.length !== 1 || fieldTargets[0] !== target.field) {
      problems.push(
        `fieldTargets 必须正好是本次要确认的字段 ${target.field}（收到：${targets.join("、") || "（空）"}）`,
      );
    }

    const rawOptions = Array.isArray(record["options"]) ? record["options"] : [];
    if (rawOptions.length < 2 || rawOptions.length > 5) {
      problems.push(`options 需要 2–5 个（收到 ${rawOptions.length} 个）`);
    }

    const options: GuideOption[] = [];
    rawOptions.forEach((item, index) => {
      const entry = typeof item === "object" && item !== null && !Array.isArray(item) ? (item as Record<string, unknown>) : undefined;
      if (entry === undefined) {
        problems.push(`options[${index}] 必须是对象`);
        return;
      }
      const label = typeof entry["label"] === "string" ? entry["label"].trim() : "";
      if (label.length === 0) {
        problems.push(`options[${index}].label 不能为空`);
        return;
      }
      const value2 = entry["value"];
      if (typeof value2 !== "object" || value2 === null || Array.isArray(value2)) {
        problems.push(`options[${index}].value 必须是该字段的取值 patch（例如 {"${target.field}": ...}）`);
        return;
      }
      const keys = Object.keys(value2 as Record<string, unknown>);
      const outside = keys.filter((key) => key !== target.field);
      if (outside.length > 0) {
        problems.push(`options[${index}].value 只能包含字段 ${target.field}，却包含：${outside.join("、")}`);
        return;
      }
      // The option has to be an answer this product can really install against
      // *this* draft: it is normalized here, once, so answering never becomes a
      // second guess at what the label meant.
      const applies = applyBriefPatch(task, value2 as BriefPatch);
      if (!applies.ok) {
        problems.push(`options[${index}].value 不是有效取值：${applies.problems.map((entry2) => entry2.problem).join("；")}`);
        return;
      }
      const description = typeof entry["description"] === "string" ? entry["description"].trim() : "";
      options.push({
        optionId: `opt_${index + 1}`,
        label,
        ...(description.length === 0 ? {} : { description }),
        ...(entry["recommended"] === true ? { recommended: true } : {}),
        value: value2 as BriefPatch,
      });
    });

    if (problems.length > 0) return { ok: false, problems };
    return { ok: true, complete: false, question, whyThisMatters, fieldTargets, options };
  }

  return {
    taskForSession: (sessionId) => repo.taskForSession(sessionId),

    proposeTask(sessionId, card) {
      const refusal = requireSessionCapability(sessionId, "card");
      if (refusal !== undefined) return refusal;
      const normalized = normalizeCard(card);
      if (!normalized.ok) {
        return {
          ok: false,
          problems: normalized.problems.map((entry) => entry.problem),
          guidance: "请修正任务卡字段后重新提交（比较对象 2–4 个，研究维度 3–6 个，topic 必填）。",
        };
      }
      const existing = repo.taskForSession(sessionId);
      if (existing !== undefined) {
        // A confirmed card is the user's decision: a later proposal may not
        // silently rewrite the structure the research is already running on.
        if (existing.confirmedAt !== null) {
          return { ok: true, created: false, task: existing };
        }
        const at = isoNow();
        const next: ReportTask = {
          ...existing,
          ...normalized.value,
          structure: { sections: blueprintSections(TECHNICAL_COMPARISON_V2) },
          matrix: buildMatrix(normalized.value.subjects, normalized.value.dimensions, at),
          // A re-proposal is a fresh suggestion: the fields it overwrote are the
          // agent's again, not the user's, and saying otherwise would claim a
          // decision about text the user never saw.
          briefVersion: briefVersionOf(existing) + 1,
          briefFieldStates: suggestedFieldStates(),
          briefUpdatedAt: at,
          guideClosed: null,
          updatedAt: at,
        };
        // A proposal that proposes what the card already says changes nothing.
        // That is not politeness: a model may call propose_task more than once
        // in a stage, and a version bump for each call would invalidate the
        // brief version the workspace is holding for no reason at all.
        if (briefHashOf(next) === briefHashOf(existing) && next.matrix.length === existing.matrix.length) {
          return { ok: true, created: false, task: existing };
        }
        repo.updateTask(next);
        return { ok: true, created: false, task: next };
      }
      const task = createTask({ sessionId, card: normalized.value, now: isoNow() });
      repo.createTask(task);
      repo.bindSession(sessionId, task.id);
      return { ok: true, created: true, task };
    },

    confirmTask(taskId, input) {
      const task = requireTask(taskId);
      if (task.confirmedAt !== null) {
        return { ok: true, task, briefVersion: briefVersionOf(task), matrixRebuilt: false };
      }
      const expected = input?.expectedVersion;
      if (expected !== undefined && expected !== briefVersionOf(task)) {
        return {
          ok: false,
          problems: [`研究简报已更新到版本 ${briefVersionOf(task)}，不是 ${expected}`],
          guidance: "请重新读取 Brief 后确认，避免确认一份你没有看过的草稿。",
        };
      }

      // The draft has to be whole before research starts on it: a missing
      // question or an audience-less brief would be discovered only once the
      // queries were already wrong.
      const validation = validateBriefDraft(task);
      if (!validation.valid) {
        return {
          ok: false,
          problems: validation.problems,
          guidance: "研究简报还不完整：请补齐上面这些问题（可直接编辑字段，或让引导助手逐项确认）后再确认。",
        };
      }

      // The matrix is the brief's projection, so it is reconciled here against
      // the subjects and dimensions the user finally agreed to. What survives
      // is a cell that still exists: a removed subject or dimension takes its
      // row or column with it, and no stale cell is left behind.
      const at = isoNow();
      const synced = syncMatrix(task, at);
      if (synced.rebuilt && hasResearchData(task)) {
        return {
          ok: false,
          conflict: true,
          problems: ["该任务在确认前已经有实际读取的材料或报告，而简报的对象/维度与矩阵不再一致"],
          guidance:
            "不静默删除已保存的研究材料：请恢复原有的对象与维度，或新建一个研究任务重新开始。",
        };
      }

      const next = updateTask(task, {
        status: "confirmed",
        confirmedAt: at,
        matrix: synced.matrix,
        briefFieldStates: lockedFieldStates(),
        briefVersion: briefVersionOf(task) + 1,
        briefUpdatedAt: at,
      });
      return { ok: true, task: next, briefVersion: briefVersionOf(next), matrixRebuilt: synced.rebuilt };
    },

    // ------------------------------------------------------------- the brief --

    briefOf: (taskId) => briefViewOf(requireTask(taskId)),

    patchBrief(taskId, input) {
      const task = requireTask(taskId);
      const frozen = requireEditableBrief(task, "修改研究简报");
      if (frozen !== undefined) return frozen;

      const reading = readBriefPatch(input.patch);
      if (!reading.ok) {
        return {
          ok: false,
          problems: reading.problems.map((entry) => entry.problem),
          guidance: `Brief 只允许修改：${EDITABLE_BRIEF_FIELDS.join(" / ")}。新增比较对象或维度时不要带 id，由服务端生成；修改已有的对象请带上它的 id。`,
        };
      }

      const conflict = versionConflict(task, input.expectedVersion);
      if (conflict !== undefined) return conflict;

      const changed = applyBriefChange(task, reading.patch, "edited", isoNow());
      if (!changed.ok) return changed;
      // A question about a field that just changed is already out of date: it
      // was written against a value that no longer exists.
      supersedeAffectedQuestions(changed.task, changed.fields);
      return { ok: true, brief: briefViewOf(requireTask(taskId)), changedFields: changed.fields };
    },

    guideTargetOf: (taskId) => guideTargetDecision(requireTask(taskId)),
    activeGuideQuestion: (taskId) =>
      repo.listGuideQuestions(taskId).find((question) => question.status === "active"),
    guideQuestionsOf: (taskId) => repo.listGuideQuestions(taskId),

    proposeGuideQuestion(taskId, input) {
      const task = requireTask(taskId);
      const authRefusal = requireTaskCapability(taskId, "brief");
      if (authRefusal !== undefined) return authRefusal;
      const frozen = requireEditableBrief(task, "写入引导问题");
      if (frozen !== undefined) return frozen;

      const decision = guideTargetDecision(task);
      if (decision.complete || decision.target === null) {
        return { ok: true, complete: true, reason: decision.reason, question: null };
      }

      const reading = readGuideQuestionInput(input, decision.target, task);
      if (!reading.ok) {
        return {
          ok: false,
          problems: reading.problems,
          guidance: `本次只处理字段 ${decision.target.field}（${decision.target.ask}）：question 必须围绕它，fieldTargets 必须正好是它，options 的 value 只能包含这个字段。`,
        };
      }
      if (reading.complete) {
        const at = isoNow();
        updateTask(task, { guideClosed: { at, reason: reading.reason }, briefUpdatedAt: at });
        return { ok: true, complete: true, reason: reading.reason, question: null };
      }

      // One question at a time: writing a new one retires the one it replaces,
      // so a client can never answer a question the current draft has moved past.
      for (const question of repo.listGuideQuestions(task.id)) {
        if (question.status === "active") repo.saveGuideQuestion({ ...question, status: "superseded" });
      }

      const at = isoNow();
      const basedOnFields: Record<string, string> = {};
      for (const field of reading.fieldTargets) basedOnFields[field] = briefFieldHash(task, field);
      const record: GuideQuestion = {
        id: newId(ID_PREFIX.guide),
        taskId: task.id,
        question: reading.question,
        whyThisMatters: reading.whyThisMatters,
        fieldTargets: reading.fieldTargets,
        options: reading.options,
        allowFreeText: true,
        basedOnBriefVersion: briefVersionOf(task),
        basedOnFields,
        status: "active",
        createdAt: at,
        answer: null,
      };
      repo.saveGuideQuestion(record);
      return { ok: true, complete: false, reason: "", question: record };
    },

    answerGuideQuestion(taskId, input) {
      const task = requireTask(taskId);
      const frozen = requireEditableBrief(task, "回答引导问题");
      if (frozen !== undefined) return frozen;

      const question = repo.getGuideQuestion(input.questionId);
      if (question === undefined || question.taskId !== task.id) {
        return {
          ok: false,
          problems: [`没有找到该引导问题：${input.questionId}`],
          guidance: "请重新获取当前问题后再回答。",
        };
      }
      if (question.status === "answered") {
        return {
          ok: false,
          problems: ["该引导问题已经回答过（旧答案不会再次应用）"],
          guidance: "请获取下一个问题。",
        };
      }
      if (question.status !== "active") {
        return staleConflict(task, "该引导问题已经失效，请获取新的问题。");
      }

      const expected = input.expectedVersion;
      if (expected !== undefined && expected !== briefVersionOf(task)) {
        // The client is holding an older draft than the one on record. That is
        // not the same as the question being obsolete: the edit that moved the
        // version may not have touched this question's own field, so the
        // question stays answerable once the client re-reads the brief.
        return staleConflict(task, `研究简报已更新到版本 ${briefVersionOf(task)}，不是 ${expected}；请按最新草稿重新提交答案。`);
      }
      if (guideQuestionIsStale(question, task)) {
        repo.saveGuideQuestion({ ...question, status: "superseded" });
        return staleConflict(task, "研究任务已更新，请获取新的问题。");
      }

      const optionIds = input.optionIds ?? [];
      const freeText = (input.freeText ?? "").trim();
      if (optionIds.length === 0 && freeText.length === 0) {
        return {
          ok: false,
          problems: ["需要选择一个选项，或给出自己的回答"],
          guidance: "回答至少要包含 optionIds 或 freeText 之一。",
        };
      }

      // The patch comes from what the option *means*, never from a second guess
      // at what the label meant: an option's value was validated when the
      // question was written, and free text is turned into a patch by this
      // field's own declared rule.
      let patch: BriefPatch = {};
      const chosen: string[] = [];
      for (const optionId of optionIds) {
        const option = question.options.find((candidate) => candidate.optionId === optionId);
        if (option === undefined) {
          return {
            ok: false,
            problems: [`该问题没有这个选项：${optionId}`],
            guidance: "请使用当前问题返回的 optionId。",
          };
        }
        patch = { ...patch, ...option.value };
        chosen.push(optionId);
      }
      if (freeText.length > 0) {
        const field = question.fieldTargets[0];
        if (field === undefined || !fieldTakesFreeText(field)) {
          return {
            ok: false,
            problems: [`该问题不接受自由文本回答（字段 ${field ?? "未知"}）`],
            guidance: "请从给出的选项中选择。",
          };
        }
        patch = { ...patch, ...patchFromFreeText(task, field, freeText) };
      }

      const changed = applyBriefChange(task, patch, "confirmed", isoNow());
      if (!changed.ok) return changed;

      const answer: GuideAnswerRecord = {
        optionIds: chosen,
        freeText,
        appliedFields: changed.fields,
        resultingBriefVersion: briefVersionOf(changed.task),
        at: isoNow(),
      };
      repo.saveGuideQuestion({ ...question, status: "answered", answer });
      const brief = briefViewOf(requireTask(taskId));
      return { ok: true, brief, appliedFields: changed.fields, complete: brief.guide.complete };
    },

    startResearch(taskId) {
      const task = requireTask(taskId);
      return updateTask(task, { status: "researching", usage: { ...task.usage, startedAt: isoNow() } });
    },

    failTask(taskId, error) {
      const task = requireTask(taskId);
      updateTask(task, { status: "failed", error });
    },

    getTask: (taskId) => repo.getTask(taskId),

    async search(taskId, input) {
      const task = requireTask(taskId);
      const refusal = requireTaskCapability(taskId, "research");
      if (refusal !== undefined) return refusal;
      const budgetStop = budgetRefusal(task, "search", "");
      if (budgetStop !== undefined) return budgetStop;

      const limit = Math.max(1, Math.min(task.budget.maxCandidatesPerSearch, input.limit ?? task.budget.maxCandidatesPerSearch));
      const outcome = await searchImpl(input.query, {
        limit,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });

      const known = new Set(repo.listSources(task.id).map((source) => source.url));
      const target: CellRef | null = input.targetCell ?? null;
      const created: SearchResult["sources"][number][] = [];
      for (const candidate of outcome.candidates) {
        const url = candidate.absUrl;
        const alreadyKnown = known.has(url);
        const existing = repo.listSources(task.id).find((source) => source.url === url);
        if (existing !== undefined) {
          created.push({
            sourceId: existing.id,
            title: existing.title,
            authors: existing.authors,
            year: (existing.publishedAt ?? "").slice(0, 4),
            url: existing.url,
            abstract: existing.abstract.slice(0, 400),
            alreadyKnown: true,
          });
          continue;
        }
        const source: Source = {
          id: newId(ID_PREFIX.source),
          taskId: task.id,
          title: candidate.title,
          authors: candidate.authors,
          org: "",
          url,
          pdfUrl: candidate.pdfUrl,
          doi: candidate.doi,
          publishedAt: candidate.publishedAt,
          venue: candidate.primaryCategory.length > 0 ? `arXiv ${candidate.primaryCategory}` : "arXiv",
          abstract: candidate.abstract,
          discovery: {
            provider: outcome.provider,
            query: input.query,
            queriedAt: outcome.fetchedAt,
            target,
          },
          readStatus: "not_read",
          readScope: null,
          readAt: null,
          readUrl: null,
          retrievalNote: "",
          failure: null,
          snapshotId: null,
        };
        repo.addSource(source);
        known.add(url);
        created.push({
          sourceId: source.id,
          title: source.title,
          authors: source.authors.slice(0, 4),
          year: (source.publishedAt ?? "").slice(0, 4),
          url: source.url,
          abstract: source.abstract.slice(0, 400),
          alreadyKnown,
        });
      }

      const searches = task.usage.searches + 1;
      updateTask(task, { usage: { ...task.usage, searches } });

      return {
        ok: true,
        sources: created,
        query: input.query,
        requestUrl: outcome.requestUrl,
        total: outcome.total,
        searchCount: searches,
        searchesRemaining: Math.max(0, task.budget.maxSearches - searches),
        note:
          created.length === 0
            ? "本次检索没有返回候选：请换英文关键词或更基础的术语。搜索结果只是候选，不是依据。"
            : "以上是检索候选（metadata）。只有 read_source 真正读取后才会产生可引用证据。",
      };
    },

    async read(taskId, input) {
      const task = requireTask(taskId);
      const authRefusal = requireTaskCapability(taskId, "research");
      if (authRefusal !== undefined) return authRefusal;
      const source = repo.getSource(input.sourceId);
      if (source === undefined || source.taskId !== task.id) {
        return {
          ok: false,
          problems: [`来源 ${input.sourceId} 不属于当前任务或不存在`],
          guidance: "请使用 search_sources 返回的 sourceId，不要自行编造。",
        };
      }

      const targetCells: readonly CellRef[] = input.targetCell === undefined ? [] : [input.targetCell];
      const terms = [...(input.terms ?? []), ...tokenize(input.question)];

      // What the source *is* is the agent's judgement, recorded here because it
      // is the only moment the model has just read the material and knows
      // whether this is the original method, a survey of it, or an evaluation
      // by someone else. It is used by the claim contract, never as a score.
      if (input.role !== undefined && input.role !== source.role) {
        repo.updateSource({ ...source, role: input.role });
      }

      // A source already read is reused, not re-fetched: the saved snapshot is
      // the thing evidence may quote, and re-reading the network would spend the
      // task's read budget to obtain text it already has.
      let snapshot = source.snapshotId === null ? undefined : repo.getSnapshot(source.snapshotId);
      let reuse = snapshot !== undefined;
      let note = "";

      if (snapshot === undefined) {
        const refusal = budgetRefusal(task, "read", "");
        if (refusal !== undefined) return refusal;

        const outcome = await readImpl({ url: source.url }, input.signal === undefined ? {} : { signal: input.signal });
        const reads = task.usage.reads + 1;
        if (outcome.status === "failed" || outcome.scope === null) {
          repo.updateSource({
            ...source,
            readStatus: "failed",
            readScope: null,
            readAt: outcome.fetchedAt,
            readUrl: outcome.readUrl,
            retrievalNote: outcome.note,
            failure: outcome.failure,
          });
          updateTask(task, { usage: { ...task.usage, reads } });
          return {
            ok: false,
            problems: [`读取失败：${outcome.failure ?? outcome.note}`],
            guidance:
              "该来源的正文没有取到（失败状态已记录，不能作为证据）。请改为读取其他候选，或对该维度如实标注缺口。",
          };
        }

        snapshot = {
          id: newId(ID_PREFIX.read),
          taskId: task.id,
          sourceId: source.id,
          url: outcome.readUrl,
          fetchedAt: outcome.fetchedAt,
          scope: outcome.scope,
          title: outcome.title,
          text: outcome.text,
          paragraphs: outcome.paragraphs,
          note: outcome.note,
        };
        repo.saveSnapshot(snapshot);
        repo.updateSource({
          ...source,
          readStatus: "ok",
          readScope: outcome.scope,
          readAt: outcome.fetchedAt,
          readUrl: outcome.readUrl,
          retrievalNote: outcome.note,
          failure: null,
          snapshotId: snapshot.id,
        });
        updateTask(task, { usage: { ...task.usage, reads } });
        note = outcome.note;
      } else {
        note = `${snapshot.note}（复用已保存读取快照，未重复消耗读取预算）`;
      }

      // Evidence comes from the saved text, and from a range that is verified
      // before it is stored — the model never supplies characters.
      const maxEvidence = Math.max(1, Math.min(5, input.maxEvidence ?? 3));
      const picks =
        input.paragraphIndex === undefined
          ? pickParagraphs(snapshot.paragraphs, terms, maxEvidence)
          : snapshot.paragraphs
              .filter((paragraph) => paragraph.index === input.paragraphIndex)
              .slice(0, 1)
              .map((paragraph) => ({ paragraph, score: 1, because: "按指定段落建立证据" }));

      if (picks.length === 0) {
        return {
          ok: false,
          problems: [`在 ${source.title} 中没有找到可用的段落（段落数 ${snapshot.paragraphs.length}）`],
          guidance: "可以换 read_source 的 question/terms，或读取其他来源。",
        };
      }

      const createdEvidence: Evidence[] = [];
      for (const pick of picks) {
        const evidence = draftEvidence({
          taskId: task.id,
          sourceId: source.id,
          readId: snapshot.id,
          readScope: snapshot.scope,
          draft: { paragraph: pick.paragraph, cells: targetCells, pickedBecause: pick.because },
          now: isoNow(),
        });
        const check = verifyEvidenceText(evidence, snapshot.text);
        if (!check.ok) continue;
        repo.addEvidence(evidence);
        createdEvidence.push(evidence);
      }

      recomputeMatrix(requireTask(task.id));
      if (createdEvidence.length > 0) {
        markReportForReview(
          task.id,
          `补查新增 ${createdEvidence.length} 条证据，当前报告可能需要复核`,
          createdEvidence.map((evidence) => evidence.id),
        );
      }
      const refreshed = requireTask(task.id);

      return {
        ok: true,
        sourceId: source.id,
        title: source.title,
        readStatus: "ok",
        readScope: snapshot.scope,
        readUrl: snapshot.url,
        role: (repo.getSource(source.id)?.role ?? null) as SourceRole | null,
        textChars: snapshot.text.length,
        paragraphCount: snapshot.paragraphs.length,
        reuse,
        evidence: createdEvidence.map((evidence) => ({
          evidenceId: evidence.id,
          excerpt: evidence.excerpt.length > 500 ? `${evidence.excerpt.slice(0, 500)}…` : evidence.excerpt,
          locator: locatorLabelOf(evidence),
          scope: scopeLabel(evidence.readScope),
          pickedBecause: evidence.pickedBecause,
        })),
        readsRemaining: Math.max(0, refreshed.budget.maxReads - refreshed.usage.reads),
        note: `${note}（读取范围：${scopeLabel(snapshot.scope)}；excerpt 均为保存文本中的原样片段）`,
      };
    },

    assess(taskId, input) {
      let task = requireTask(taskId);
      const authRefusal = requireTaskCapability(taskId, "research");
      if (authRefusal !== undefined) return authRefusal;
      if (input.gapRound === true) {
        const refusal = budgetRefusal(task, "gap", "");
        if (refusal !== undefined) return refusal;
        task = updateTask(task, { usage: { ...task.usage, gapRounds: task.usage.gapRounds + 1 } });
      }

      const allEvidence = repo.listEvidence(task.id);
      const byId = new Map(allEvidence.map((evidence) => [evidence.id, evidence]));
      const knownCells = task.matrix;
      const recorded: SupportAssessment[] = [];

      for (const proposal of input.proposals) {
        const cell = knownCells.find(
          (candidate) =>
            candidate.sectionId === proposal.cell.sectionId &&
            candidate.subjectId === proposal.cell.subjectId &&
            candidate.dimensionId === proposal.cell.dimensionId,
        );
        if (cell === undefined) continue;

        // Binding an existing, verified passage to a cell is the model's
        // judgement — the passage and its text stay the program's. The binding
        // says "this passage is about this question"; it is not yet a verdict,
        // so the cell stays unassessed until an assessment is recorded below.
        const cited: string[] = [];
        for (const evidenceId of proposal.evidenceIds ?? []) {
          const evidence = byId.get(evidenceId);
          if (evidence === undefined || evidence.taskId !== task.id) continue;
          cited.push(evidenceId);
          if (evidence.cells.some((ref) => sameCell(ref, proposal.cell))) continue;
          const updated: Evidence = { ...evidence, cells: [...evidence.cells, proposal.cell] };
          byId.set(evidenceId, updated);
          repo.updateEvidence(updated);
        }

        if (proposal.note !== undefined && proposal.note.trim() !== "") {
          const index = task.matrix.findIndex((candidate) => candidate === cell);
          if (index >= 0) {
            const matrix = [...task.matrix];
            matrix[index] = { ...cell, note: proposal.note.trim().slice(0, 300) };
            task = updateTask(task, { matrix });
          }
        }

        // The judgement itself, persisted as its own object: what relation the
        // evidence has to this cell, how directly it bears on it, under which
        // scope, and who decided. A cell with material but no assessment here
        // stays `unassessed` — which is the point of keeping the two apart.
        const assessment = this.recordAssessment(task.id, {
          target: proposal.cell,
          evidenceIds: cited.length > 0 ? cited : (proposal.evidenceIds ?? []).filter((id) => byId.has(id)),
          ...(proposal.relationship === undefined ? {} : { relationship: proposal.relationship }),
          ...(proposal.directness === undefined ? {} : { directness: proposal.directness }),
          ...(proposal.scope === undefined ? {} : { scope: proposal.scope }),
          rationale: proposal.rationale ?? proposal.note ?? "",
          assessor: "agent",
        });
        if (!("ok" in assessment)) recorded.push(assessment);
      }

      task = recomputeMatrix(requireTask(task.id));
      if (recorded.length > 0) {
        markReportForReview(
          task.id,
          `新增 ${recorded.length} 条支持评估，当前报告的相关结论可能需要复核`,
          recorded.flatMap((entry) => entry.evidenceIds),
        );
        task = requireTask(task.id);
      }
      const views = cellViews(task);
      const gaps = views
        .filter((cell) => needsAttention(cell.status))
        .sort((a, b) => (a.status === b.status ? 0 : a.status === "missing" ? -1 : 1));

      return {
        ok: true,
        cells: views,
        gaps,
        gapRoundsUsed: task.usage.gapRounds,
        gapRoundsRemaining: Math.max(0, task.budget.maxGapRounds - task.usage.gapRounds),
        note:
          gaps.length === 0
            ? "所有单元格都已有评估过的正文级支持。若有新增材料，可用 read_source 继续增强。"
            : `仍有 ${gaps.length} 个单元格没有达到「已核对」（missing/unassessed/limited/conflict）。若补查预算允许，可优先处理缺口最大的项目；否则在报告中如实写明缺口。`,
      };
    },

    saveReportPart(taskId, part) {
      let task = requireTask(taskId);
      const current: ReportDraftState =
        task.reportDraft ?? { title: "", summary: "", claims: [], sections: [], updatedAt: isoNow() };

      if (part.kind === "clear") {
        updateTask(task, { reportDraft: null });
        return { ok: true, reportId: "", citations: 0, references: 0, warnings: ["已清空报告草稿"], missingCells: 0 };
      }

      if (part.kind !== "finalize") {
        if (part.section !== undefined) {
          const refusal = unknownSectionRefusal(task, [part.section.id]);
          if (refusal !== undefined) return refusal;
        }
        const claims = part.claims === undefined ? current.claims : mergeClaims(current.claims, part.claims);
        const sections =
          part.section === undefined
            ? current.sections
            : [...current.sections.filter((section) => section.id !== part.section?.id), part.section];
        const frame = part.frame ?? current.frame;
        const draft: ReportDraftState = {
          title: part.title ?? current.title,
          summary: part.summary ?? current.summary,
          ...(frame === undefined ? {} : { frame }),
          claims,
          sections,
          updatedAt: isoNow(),
        };
        task = updateTask(task, { reportDraft: draft });
        return {
          ok: true,
          reportId: "",
          citations: 0,
          references: 0,
          warnings: [
            `草稿已保存：claims ${draft.claims.length} 条，sections ${draft.sections.length} 节（${
              REQUIRED_SECTION_IDS.filter((id) => draft.sections.some((section) => section.id === id)).length
            }/${REQUIRED_SECTION_IDS.length} 个必需章节已提交）`,
          ],
          missingCells: 0,
        };
      }

      if (current.title.trim() === "" || current.summary.trim() === "" || current.sections.length === 0) {
        return {
          ok: false,
          problems: ["报告草稿还不完整：请先用 save_report 提交 title/summary，再逐节提交 sections，然后 finalize"],
          guidance: "可以先 part=\"start\" 提交标题与摘要，再多次 part=\"write\" 提交章节，最后 part=\"finalize\"。",
        };
      }

      // Finalize goes through the same validator as the one-shot path.
      const sealed = this.saveReport(task.id, {
        title: current.title,
        summary: current.summary,
        ...(current.frame === undefined ? {} : { frame: current.frame }),
        sections: current.sections,
        claims: current.claims,
      });
      if (!sealed.ok) return sealed;
      const done = requireTask(task.id);
      updateTask(done, { reportDraft: null });
      return sealed;
    },

    reportDraftOf: (taskId) => requireTask(taskId).reportDraft,

    previewDraftValidation(taskId) {
      const task = requireTask(taskId);
      if (task.reportDraft === null) return null;
      return validateReport({
        draft: {
          title: task.reportDraft.title,
          summary: task.reportDraft.summary,
          ...(task.reportDraft.frame === undefined ? {} : { frame: task.reportDraft.frame }),
          sections: task.reportDraft.sections,
          claims: task.reportDraft.claims,
        },
        task,
        evidence: repo.listEvidence(task.id),
        sources: repo.listSources(task.id),
        assessments: repo.listAssessments(task.id),
        snapshotText: (readId) => repo.getSnapshot(readId)?.text,
        now: isoNow(),
      });
    },

    saveReport(taskId, draft) {
      const task = requireTask(taskId);
      const authRefusal = requireTaskCapability(taskId, "report");
      if (authRefusal !== undefined) return authRefusal;
      const sectionRefusal = unknownSectionRefusal(
        task,
        draft.sections.map((section) => section.id),
      );
      if (sectionRefusal !== undefined) return sectionRefusal;
      const evidence = repo.listEvidence(task.id);
      const validation = validateReport({
        draft,
        task,
        evidence,
        sources: repo.listSources(task.id),
        assessments: repo.listAssessments(task.id),
        snapshotText: (readId) => repo.getSnapshot(readId)?.text,
        now: isoNow(),
      });

      if (!validation.ok) {
        return {
          ok: false,
          problems: refusalsOf(validation),
          guidance:
            "报告未通过校验：请按问题逐条修正——引用只能使用 load_research_state 中存在的 evidence ID；缺失的章节与维度要补写或写成明确缺口；不可比的数字不要排名。",
        };
      }

      const citations = buildCitations({ draft, sources: repo.listSources(task.id), evidence });
      const gaps = missingCells(task);
      const warnings: string[] = [...validation.warnings];
      if (gaps.length > 0) {
        warnings.push(
          `矩阵中仍有 ${gaps.length} 个单元格未达到「已核对」，本次报告的缺口快照会写入报告本身，渲染时附加程序生成的「证据缺口清单」。`,
        );
      }
      const reportId = newId(ID_PREFIX.report);
      // The gap appendix belongs to the document, so it is captured here, once,
      // from the matrix as it stands — not recomputed whenever the report is
      // exported later against a matrix that has moved on.
      const report = sealReport({ id: reportId, taskId: task.id, draft, validation, now: isoNow(), task });
      repo.saveReport(report);
      updateTask(task, { status: "ready", currentReportId: reportId, error: null, reportNeedsReview: null });

      return {
        ok: true,
        reportId,
        citations: citations.evidenceIndex.length,
        references: citations.references.length,
        warnings,
        missingCells: gaps.length,
      };
    },

    state(taskId) {
      const task = requireTask(taskId);
      const sources = repo.listSources(task.id);
      const evidence = repo.listEvidence(task.id);
      const report = currentReportOf(task);
      return {
        task: {
          id: task.id,
          topic: task.topic,
          purpose: task.purpose,
          audience: task.audience,
          focus: task.focus,
          exclusions: task.exclusions,
          language: task.language,
          lengthTarget: task.lengthTarget,
          status: task.status,
          confirmed: task.confirmedAt !== null,
        },
        structure: task.structure.sections.map((section) => ({ id: section.id, title: section.title, question: section.question })),
        subjects: task.subjects.map((subject) => ({ id: subject.id, name: subject.name })),
        dimensions: task.dimensions.map((dimension) => ({ id: dimension.id, name: dimension.name, question: dimension.question })),
        cells: cellViews(task),
        sources: sources.map((source) => ({
          sourceId: source.id,
          title: source.title,
          role: source.role ?? null,
          readStatus: source.readStatus,
          readScope: source.readScope,
          url: source.url,
        })),
        evidence: evidence.map((item) => ({
          evidenceId: item.id,
          sourceId: item.sourceId,
          excerpt: item.excerpt.length > 200 ? `${item.excerpt.slice(0, 200)}…` : item.excerpt,
          locator: locatorLabelOf(item),
          scope: scopeLabel(item.readScope),
        })),
        usage: task.usage,
        budget: task.budget,
        brief: briefViewOf(task),
        currentReportId: task.currentReportId,
        currentReportHash: report === undefined ? null : reportContentHash(report),
        reportNeedsReview: task.reportNeedsReview ?? null,
        currentReport:
          report === undefined
            ? null
            : {
                reportId: report.id,
                title: report.title,
                summary: report.summary,
                frame: report.frame ?? null,
                validation: {
                  ok: report.validation.ok,
                  warnings: (report.validation.warnings ?? []).slice(0, 12),
                  checks: (report.validation.checks ?? []).map((check) => ({
                    id: check.id,
                    result: check.result,
                    detail: check.detail,
                  })),
                },
                sections: report.sections.map((section) => ({ id: section.id, title: section.title })),
                claims: report.claims.map((claim) => ({
                  id: claim.id,
                  text: claim.text,
                  kind: claim.kind,
                  claimType: claim.claimType ?? "fact",
                  synthesis: claim.synthesis === true,
                })),
              },
      };
    },

    cellsOf: (taskId) => cellViews(requireTask(taskId)),
    sourcesOf: (taskId) => repo.listSources(taskId),
    evidenceOf: (taskId) => repo.listEvidence(taskId),
    reportsOf: (taskId) => repo.listReports(taskId),
    exportsOf: (taskId) => repo.listExports(taskId),
    saveExport: (artifact) => repo.saveExport(artifact),
    runsOf: (taskId) => repo.listRuns(taskId),
    recordRun: (record) => repo.recordRun(record),
    listTasks: () => repo.listTasks(),
    snapshotTextOf: (readId) => repo.getSnapshot(readId)?.text,

    // ------------------------------------------------------------- actions --

    issueGrant(input) {
      const grant = createGrant({ ...input, now: input.now ?? isoNow() });
      grants.set(grant.sessionId, grant);
      return grant;
    },
    activeGrant: (sessionId) => grants.get(sessionId),
    clearGrant(sessionId) {
      grants.delete(sessionId);
    },

    // --------------------------------------------------------- assessments --

    assessmentsOf: (taskId) => repo.listAssessments(taskId),

    recordAssessment(taskId, input) {
      const task = requireTask(taskId);
      const assessor = input.assessor ?? "agent";
      // An agent's judgement needs the run to be authorized to research; a
      // person recording their own judgement is the authority itself.
      if (assessor === "agent") {
        const refusal = requireTaskCapability(taskId, "research");
        if (refusal !== undefined) return refusal;
      }
      const cell = task.matrix.find((candidate) => sameCell(candidate, input.target));
      if (cell === undefined) {
        return {
          ok: false,
          problems: [`单元格不属于该任务的矩阵：${input.target.subjectId} × ${input.target.dimensionId}`],
          guidance: "请使用 load_research_state 返回的矩阵单元格坐标。",
        };
      }
      const known = new Set(repo.listEvidence(task.id).map((item) => item.id));
      const evidenceIds = (input.evidenceIds ?? []).filter((id) => known.has(id));
      const assessment: SupportAssessment = {
        id: newId(ID_PREFIX.assessment),
        taskId: task.id,
        target: input.target,
        evidenceIds,
        relationship: input.relationship ?? "supports",
        directness: input.directness ?? "unassessed",
        scope: (input.scope ?? "").slice(0, 300),
        rationale: (input.rationale ?? "").slice(0, 500),
        assessor,
        createdAt: isoNow(),
      };
      repo.addAssessment(assessment);
      return assessment;
    },

    // ----------------------------------------------------------- proposals --

    createProposal(taskId, input) {
      const task = requireTask(taskId);
      const authRefusal = requireTaskCapability(taskId, "proposal");
      if (authRefusal !== undefined) return authRefusal;
      const grant = grants.get(task.sessionId);
      if (grant === undefined) {
        return { ok: false, problems: ["当前动作没有授权，不能生成修改提案"], guidance: "请通过 Edit 入口发起修改。" };
      }

      const base = currentReportOf(task);
      if (base === undefined) {
        return {
          ok: false,
          problems: ["当前任务还没有已保存的报告，无法生成修改提案"],
          guidance: "请先生成一份报告版本，再对它提出修改。",
        };
      }

      const existing = this.pendingProposalOf(task.id);
      if (existing !== undefined) {
        return {
          ok: false,
          problems: [`已有待接受的修改提案（${existing.id}）`],
          guidance: "一个项目同时只保留一个待处理提案：请先接受或放弃它，再生成新的修改建议。",
        };
      }

      if (input.sections.length === 0 && input.summary === undefined) {
        return { ok: false, problems: ["提案没有包含任何目标内容"], guidance: "请给出目标章节的替换内容。" };
      }

      // The grant's target is the boundary: a section-scoped Edit may only
      // submit that section, whatever else the model decided to write.
      if (grant.targetType === "section" && grant.targetId !== null) {
        const unauthorized = input.sections.filter((section) => section.id !== grant.targetId);
        if (unauthorized.length > 0) {
          return {
            ok: false,
            problems: [`本次授权只允许修改 ${grant.targetId}，提案却包含：${unauthorized.map((section) => section.id).join("、")}`],
            guidance: "局部修改不能自行扩大范围；如需改动其他章节，请重新发起针对该目标的 Edit。",
          };
        }
      }

      const baseSections = new Map(base.sections.map((section) => [section.id, section]));
      const targets: ProposalTarget[] = [];
      for (const section of input.sections) {
        const current = baseSections.get(section.id);
        if (current === undefined) {
          return {
            ok: false,
            problems: [`目标章节 ${section.id} 不在基线报告中`],
            guidance: `基线报告的章节为：${[...baseSections.keys()].join("、")}。`,
          };
        }
        targets.push({ targetType: "section", targetId: section.id, baseHash: sectionHash(current) });
      }
      if (input.summary !== undefined) {
        // Touching the summary is allowed, but only as a declared target: a
        // change to one section must never rewrite the report's own claim.
        targets.push({ targetType: "summary", targetId: "summary", baseHash: hashOf(base.summary) });
      }

      // New claims are checked against the same truth boundary a report is:
      // they must cite evidence that exists, belongs here, and still verifies.
      const claimProblems: string[] = [];
      const evidenceById = new Map(repo.listEvidence(task.id).map((item) => [item.id, item]));
      for (const claim of input.claims ?? []) {
        if (claim.text.trim().length === 0) claimProblems.push(`claim ${claim.id} 文本为空`);
        if (claim.evidenceIds.length === 0) {
          claimProblems.push(`claim ${claim.id} 没有任何 evidence（非综合论断不允许无依据）`);
          continue;
        }
        for (const evidenceId of claim.evidenceIds) {
          const evidence = evidenceById.get(evidenceId);
          if (evidence === undefined) {
            claimProblems.push(`claim ${claim.id} 引用了不存在的 evidence：${evidenceId}`);
            continue;
          }
          const text = repo.getSnapshot(evidence.readId)?.text;
          if (text === undefined) {
            claimProblems.push(`evidence ${evidenceId} 的读取快照缺失`);
            continue;
          }
          if (!verifyEvidenceText(evidence, text).ok) {
            claimProblems.push(`evidence ${evidenceId} 的片段与读取文本不一致（不可引用）`);
          }
        }
      }
      if (claimProblems.length > 0) {
        return {
          ok: false,
          problems: claimProblems,
          guidance: "提案中的新 claim 必须引用真实存在的 evidenceId；不能核实的论断请先补查或删除。",
        };
      }

      const evidenceIds = [...new Set([...(input.claims ?? []).flatMap((claim) => claim.evidenceIds)])];
      const proposal = createProposal({
        actionId: input.actionId,
        taskId: task.id,
        baseReportId: base.id,
        base: proposalBaseOf(base),
        targets,
        sections: input.sections,
        claims: input.claims ?? [],
        evidenceIds,
        reason: input.reason,
        summary: input.summary ?? null,
        researchAdded: {
          sources: repo.listSources(task.id).length,
          evidence: evidenceById.size,
          assessments: repo.listAssessments(task.id).length,
        },
        now: isoNow(),
      });
      repo.saveProposal(proposal);
      return { ok: true, proposal };
    },

    proposalById: (proposalId) => repo.getProposal(proposalId),
    proposalsOf: (taskId) => repo.listProposals(taskId),
    pendingProposalOf(taskId) {
      return repo.listProposals(taskId).find((proposal) => proposal.status === "pending");
    },

    acceptProposal(proposalId, input) {
      const proposal = repo.getProposal(proposalId);
      if (proposal === undefined) {
        return { ok: false, problems: [`没有找到修改提案：${proposalId}`], guidance: "请刷新工作台查看当前提案。" };
      }
      // Idempotence: an accepted proposal is already applied, and applying it
      // again would mint a second report with identical content.
      if (proposal.status === "accepted") {
        if (proposal.acceptedReportId === null) {
          return { ok: false, problems: ["提案标记为已接受但没有记录产生的报告"], guidance: "请人工检查该提案记录。" };
        }
        return { ok: true, alreadyApplied: true, proposalId, reportId: proposal.acceptedReportId, contentHash: proposal.baseContentHash };
      }
      if (proposal.status !== "pending") {
        return {
          ok: false,
          problems: [`提案状态为 ${proposal.status}，不能接受`],
          guidance: "只有待处理的提案可以被接受；请重新生成修改建议。",
        };
      }
      if (input?.expectedBaseReportId !== undefined && input.expectedBaseReportId !== proposal.baseReportId) {
        return { ok: false, problems: ["期望的基线与提案记录的基线不一致"], guidance: "请重新加载报告后再决定是否接受。" };
      }
      if (input?.expectedBaseContentHash !== undefined && input.expectedBaseContentHash !== proposal.baseContentHash) {
        return { ok: false, problems: ["期望的基线 hash 与提案记录不一致"], guidance: "请重新加载报告后再决定是否接受。" };
      }

      const task = requireTask(proposal.taskId);
      const base = repo.getReport(proposal.baseReportId);
      const freshness = checkProposalFreshness({
        proposal,
        currentReportId: task.currentReportId,
        base: base === undefined ? null : proposalBaseOf(base),
      });
      if (!freshness.ok) {
        repo.saveProposal({ ...proposal, status: "stale", decidedAt: isoNow() });
        return { ok: false, problems: [freshness.problem], guidance: "基线已变化：请基于当前报告重新生成修改提案，不要直接合并。" };
      }
      if (base === undefined) {
        return { ok: false, problems: ["提案的基线报告不存在"], guidance: "请重新生成修改提案。" };
      }

      const merged = applyProposal(proposalBaseOf(base), proposal);
      const evidence = repo.listEvidence(task.id);
      const validation = validateReport({
        draft: merged,
        task,
        evidence,
        sources: repo.listSources(task.id),
        assessments: repo.listAssessments(task.id),
        snapshotText: (readId) => repo.getSnapshot(readId)?.text,
        now: isoNow(),
      });
      if (!validation.ok) {
        repo.saveProposal({ ...proposal, status: "invalid", decidedAt: isoNow() });
        return {
          ok: false,
          problems: validation.problems,
          guidance: "提案内容未通过报告校验，已标记为无效；请重新生成修改建议。",
        };
      }

      const reportId = newId(ID_PREFIX.report);
      const report = sealReport({
        id: reportId,
        taskId: task.id,
        draft: merged,
        validation,
        now: isoNow(),
        // The gaps the edited report shows are today's: accepting a proposal
        // produces a new version, and a new version gets its own appendix.
        task: repo.getTask(task.id) ?? task,
      });
      const decidedAt = isoNow();
      // One transaction: the report, the task's pointer and the proposal's
      // status land together, so a crash cannot leave a pointer to a report
      // that was never bound to the proposal that produced it.
      repo.transact(() => {
        repo.saveReport(report);
        repo.updateTask({
          ...task,
          status: "ready",
          currentReportId: reportId,
          error: null,
          reportNeedsReview: null,
          updatedAt: decidedAt,
        });
        repo.saveProposal({ ...proposal, status: "accepted", decidedAt, acceptedReportId: reportId });
      });

      return { ok: true, alreadyApplied: false, proposalId, reportId, contentHash: reportContentHash(report) };
    },

    discardProposal(proposalId) {
      const proposal = repo.getProposal(proposalId);
      if (proposal === undefined) {
        return { ok: false, problems: [`没有找到修改提案：${proposalId}`], guidance: "请刷新工作台查看当前提案。" };
      }
      if (proposal.status === "accepted") {
        return {
          ok: false,
          problems: ["已接受的提案不能放弃（它已经产生了报告版本）"],
          guidance: "如果要撤回内容，请对当前报告发起新的 Edit 提案。",
        };
      }
      if (proposal.status === "discarded") return { ok: true, proposal };
      // Discarding closes the proposal and nothing else: sources, evidence and
      // assessments the edit's research obtained are real material and stay.
      const next: Proposal = { ...proposal, status: "discarded", decidedAt: isoNow() };
      repo.saveProposal(next);
      return { ok: true, proposal: next };
    },

    // ----------------------------------------------------------- revisions --

    freezeRevision(input) {
      const task = requireTask(input.taskId);
      const reportId = input.reportId ?? task.currentReportId;
      if (reportId === null) {
        return { ok: false, problems: ["当前任务还没有已保存的报告，无法冻结版本"], guidance: "请先生成报告。" };
      }
      const report = repo.getReport(reportId);
      if (report === undefined || report.taskId !== task.id) {
        return { ok: false, problems: [`报告不属于该任务或不存在：${reportId}`], guidance: "请使用当前任务的报告 id。" };
      }
      const contentHash = reportContentHash(report);
      if (input.expectedContentHash !== undefined && input.expectedContentHash !== contentHash) {
        return {
          ok: false,
          problems: ["报告内容与期望的 hash 不一致（草稿可能已被更新）"],
          guidance: "请重新加载报告后再冻结，避免把未经确认的内容标成已冻结版本。",
        };
      }

      const existing = repo.listRevisions(task.id).find((revision) => revision.reportId === reportId && revision.contentHash === contentHash);
      if (existing !== undefined) return { ok: true, revision: existing, existing: true };

      const revision = buildRevisionBundle({
        task,
        report,
        sources: repo.listSources(task.id),
        evidence: repo.listEvidence(task.id),
        assessments: repo.listAssessments(task.id),
        revision: repo.listRevisions(task.id).length + 1,
        now: isoNow(),
        ...(input.themeId === undefined ? {} : { themeId: input.themeId }),
      });
      repo.saveRevision(revision);
      return { ok: true, revision, existing: false };
    },
    revisionsOf: (taskId) => repo.listRevisions(taskId),
    revisionById: (revisionId) => repo.getRevision(revisionId),
    revisionForReport(reportId) {
      for (const task of repo.listTasks()) {
        const found = repo.listRevisions(task.id).find((revision) => revision.reportId === reportId);
        if (found !== undefined) return found;
      }
      return undefined;
    },
    contentHashOf(taskId, reportId) {
      const task = repo.getTask(taskId);
      if (task === undefined) return null;
      const target = reportId ?? task.currentReportId;
      if (target === null) return null;
      const report = repo.getReport(target);
      return report === undefined ? null : reportContentHash(report);
    },
  };
}

/** The sections a report is not publishable without, per the current blueprint. */
export const REQUIRED_SECTION_IDS: readonly string[] = TECHNICAL_COMPARISON_V2.sections
  .filter((section) => section.required)
  .map((section) => section.id);

/** Replaces claims by id, keeping the order the draft already had. */
function mergeClaims(current: readonly ReportClaim[], incoming: readonly ReportClaim[]): readonly ReportClaim[] {
  const byId = new Map(current.map((claim) => [claim.id, claim]));
  for (const claim of incoming) byId.set(claim.id, claim);
  return [...byId.values()];
}

/** The structure's own section ids, for callers that validate a draft's shape. */
export const SECTION_IDS: readonly string[] = STRUCTURE_SECTIONS.map((section) => section.id);

/** Re-exported so a caller can mint ids for its own artifacts consistently. */
export { ID_PREFIX };
export type { ReportClaim, ReportSection };
export { slugId };
