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
  ActionDelta,
  ActivityLevel,
  CellRef,
  CoverageAssessment,
  CoverageEvidence,
  ClaimType,
  DiscoveryTelemetry,
  EditActionOutcome,
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
  ResearchActivityEvent,
  ResearchActivityKind,
  ResearchAttempt,
  ResearchProgressStage,
  ResearchResolution,
  ResearchRunRecord,
  ResearchUsage,
  RunOutcome,
  Source,
  SourceRole,
  SupportAssessment,
  AssessmentDirectness,
  AssessmentRelationship,
} from "./domain.js";
import { deriveCellCoverage, EMPTY_ACTION_DELTA, ID_PREFIX, needsAttention, suggestedFieldStates } from "./domain.js";
import { blankCellLabel, blankCellsOfTable, tableGapsOf, BLANK_CELL_REMEDY } from "./artifact.js";
import { deriveResearchResolution, proposalFailureCopy, proposalRepairCopy } from "./outcome.js";
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
import { readSource, type ReadOutcome, type ReadRequest } from "./read.js";
import { newId, type ResearchRepository } from "./repository.js";
import { createGrant, EMPTY_ACTION_USAGE, type ActionCapability, type ActionGrant, type ActionUsage, type GrantInput } from "./semantics.js";
import { PROVIDER_NAMES, SearchError, type SearchCandidate, type SearchOutcome } from "./search.js";
import { arxivIdOf, arxivIdOfDoi, candidateKeys, dedupeCandidates } from "./search.js";
import { ProviderCircuitBreaker, searchSources, type DiscoveryOptions } from "./discovery.js";
import type { DiscoveryEvent } from "./search.js";
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
  GUIDE_LEAD_IN_LIMIT,
  GUIDE_MAX_DECISIONS,
  GUIDE_MIN_DECISIONS,
  guideAnswerLabelsOf,
  guideAnswerTextOf,
  guideLeadInOf,
  guideQuestionIsStale,
  guideReadinessDecisions,
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
  /**
   * The discovery path; the default is the real one — providers with bounded
   * retries, a circuit breaker and a fallback.
   */
  readonly search?: (query: string, options: { readonly limit: number; readonly signal?: AbortSignal }) => Promise<SearchOutcome>;
  /**
   * The network seam of the default discovery path.
   *
   * A test supplies a `fetchImpl` and a `sleep` so the *real* provider code —
   * classification, retries, breaker, fallback — runs without the network and
   * without waiting. Nothing else about the product changes: the same code path
   * a demo takes is the one under test.
   */
  readonly discovery?: Omit<DiscoveryOptions, "limit" | "signal" | "onEvent">;
  /** The read path; the default is the real HTTP reader. */
  readonly read?: (request: ReadRequest, options: { readonly signal?: AbortSignal }) => Promise<ReadOutcome>;
  readonly now?: () => Date;
  /** The provider failure memory; the default is one per service instance. */
  readonly breaker?: ProviderCircuitBreaker;
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
  /**
   * A machine-readable reason, when a caller has to tell two refusals apart.
   *
   * `proposal_invalid` means the offered change did not pass the report's own
   * contract and may be submitted once more with the problems fixed;
   * `proposal_not_created` means that chance was already spent and the action
   * ends without a proposal.
   */
  readonly code?: "proposal_invalid" | "proposal_not_created";
  /**
   * What to tell the user, when the reader's sentence differs from the model's.
   *
   * The problems are written for whoever has to fix them — the model, in the
   * tool result. This is the same refusal written for the person who asked for
   * the change, and it never names a check id, a contract term or a hash.
   */
  readonly userMessage?: string;
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
  /** Which budget `searchesRemaining` belongs to. */
  readonly budgetScope: BudgetScope;
  /** Which provider actually answered this search. */
  readonly provider: string;
  /** The providers this call asked, in order. */
  readonly providersTried?: readonly string[];
  /** What the physical requests of this call did, as counts. */
  readonly attempts?: {
    readonly attempted: number;
    readonly succeeded: number;
    readonly failed: number;
  };
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
  /** Which budget `readsRemaining` belongs to. */
  readonly budgetScope: BudgetScope;
  readonly note: string;
}

/** Why a retry was refused, in terms the route can turn into a status code. */
export type RetryRefusalReason = "task_unknown" | "brief_unconfirmed" | "not_recoverable" | "run_in_progress";

export interface RetryRefusal {
  readonly ok: false;
  readonly reason: RetryRefusalReason;
  readonly problems: readonly string[];
  readonly guidance: string;
  /** Retries and unavailable states are conflicts with the task's state. */
  readonly conflict: true;
}

/** What a retry did, and what it left untouched. */
export interface RetryResearchResultOk {
  readonly ok: true;
  readonly task: ReportTask;
  readonly attempt: ResearchAttempt;
  /** The material the retry found in place; it is kept, not rebuilt. */
  readonly preserved: {
    readonly sources: number;
    readonly evidence: number;
    readonly assessments: number;
    readonly reports: number;
    readonly revisions: number;
    readonly reportKept: boolean;
  };
  readonly message: string;
}

export type RetryResearchResult = RetryResearchResultOk | RetryRefusal;

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
  /** Which budget the counts above belong to: the project's, or this action's. */
  readonly budgetScope: BudgetScope;
  readonly note: string;
}

/**
 * Which budget a spend is counted against.
 *
 * `project` is the task's own pipeline budget — the initial pass and the gap
 * rounds the program schedules for itself. `user-action` is the budget of one
 * instruction the person gave, which is why the same tool reports different
 * remaining counts depending on who asked for the run it is serving.
 */
export type BudgetScope = "project" | "user-action";

/**
 * What one action may still spend, as the workspace reads it.
 *
 * It answers「这次补查还能查多少」rather than「这个项目还剩多少」: the numbers
 * belong to the instruction the person gave, and they are what the workspace
 * shows next to the action instead of a project-lifetime remainder.
 */
export interface ActionBudgetView {
  readonly searchesRemaining: number;
  readonly readsRemaining: number;
  readonly gapRoundsRemaining: number;
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
  /** The conversation's transition into this question; empty when there is none. */
  readonly leadIn: string;
  readonly question: string;
  readonly whyThisMatters: string;
  readonly fieldTargets: readonly BriefFieldName[];
  readonly options: readonly GuideOptionView[];
  readonly allowFreeText: boolean;
  readonly basedOnBriefVersion: number;
  readonly createdAt: string;
}

/**
 * A decision the user already made through Guided Mode.
 *
 * It carries both what the conversation needs and what an audit needs: the
 * ids stay, so a stored decision can be checked against the question that
 * produced it, and the text and labels travel with it, so a conversation view
 * never has to re-open an old question to say what the user chose.
 */
export interface GuideDecisionView {
  readonly questionId: string;
  readonly leadIn: string;
  readonly question: string;
  readonly fieldTargets: readonly BriefFieldName[];
  readonly optionIds: readonly string[];
  readonly selectedOptionLabels: readonly string[];
  readonly answerText: string;
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
  /**
   * Whether the user may start research now.
   *
   * Guided planning never gates this: a person who is satisfied after two
   * questions confirms the draft and gets their report. It is the *agent* that
   * may not stop early, not the user.
   */
  readonly canConfirm: boolean;
  readonly guide: {
    /** True when Guided Mode has nothing further worth asking. */
    readonly complete: boolean;
    /** Why it stopped, in a sentence. */
    readonly reason: string;
    /** How many decisions Guided Mode asks for at most, so a page need not guess. */
    readonly limit: number;
    /** The floor: below this many real decisions, guided planning cannot end. */
    readonly minDecisions: number;
    readonly maxDecisions: number;
    /** Decisions a person has really made: guided answers plus their own edits. */
    readonly readiness: number;
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
  /** How many guided questions have been answered. */
  readonly answered: number;
  /** How many decisions a person has really made; the depth contract's subject. */
  readonly readiness: number;
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
  /**
   * Starts a new bounded research attempt on a task that stopped.
   *
   * It is the user's own retry: the task, its brief, its subjects, dimensions,
   * sources, evidence, report and frozen revisions are all kept exactly as they
   * are, the failure that was blocking the project is cleared, and the attempt
   * the pipeline budget governs starts fresh — which is what makes an old
   * `startedAt` unable to reject the retry it just allowed.
   */
  retryResearch(taskId: string): RetryResearchResult;
  /** The activity history a reader can read back after a reload. */
  activityOf(taskId: string, limit?: number): readonly ResearchActivityEvent[];
  /**
   * Appends one line to a project's activity history.
   *
   * The application writes the stage-level lines (a stage started, a stage
   * finished, a stage failed) through this, because the runner is what knows a
   * stage exists; everything a tool does inside the stage is written by the
   * service itself, where those facts are.
   */
  recordActivity(input: {
    readonly taskId: string;
    readonly kind: ResearchActivityKind;
    readonly level?: ActivityLevel;
    readonly message: string;
    readonly stage?: ResearchProgressStage;
    readonly provider?: string;
    readonly attempt?: number;
    readonly nextRetryAt?: string | null;
  }): ResearchActivityEvent;
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
  /**
   * What the session's in-flight *user* action may still spend.
   *
   * Undefined when what is running is the program's own work: a pipeline stage
   * is bounded by the task's budget, and reporting an action remainder for it
   * would answer a question nobody asked.
   */
  actionBudgetOf(sessionId: string): ActionBudgetView | undefined;
  /**
   * What the session's running user action has added, against its own baseline.
   *
   * Zeroes when no user action is running: with no action to attribute material
   * to, the honest answer is that this action added nothing.
   */
  actionDeltaOf(sessionId: string): ActionDelta;
  /**
   * What the session's running user action ended as, once it has settled.
   *
   * Undefined for the program's own stages and for Ask, which resolve nothing.
   * The runner calls this while the grant is still live and writes the result
   * onto the run record, so the answer to「这次动作解决了什么」belongs to the
   * action rather than being recomputed from a project that has moved on.
   */
  actionOutcomeOf(sessionId: string, userText: string): RunOutcome | undefined;
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
  const breaker = options.breaker ?? new ProviderCircuitBreaker({ now });
  const searchImpl =
    options.search ??
    ((query: string, searchOptions: { readonly limit: number; readonly signal?: AbortSignal }) =>
      searchSources(query, { ...options.discovery, ...searchOptions, breaker: options.discovery?.breaker ?? breaker }));
  const readImpl = options.read ?? ((request: ReadRequest, readOptions: { readonly signal?: AbortSignal }) => readSource(request, readOptions));

  const isoNow = (): string => now().toISOString();

  /**
   * One line of the project's activity history.
   *
   * The stage is read from the run the task is currently in, because that is
   * the stage a reader is watching; a call that happens outside any run (the
   * application API answering a direct request) is attributed to the project in
   * `preparing`, which is true: nothing is running.
   */
  function recordActivity(
    taskId: string,
    kind: ResearchActivityKind,
    level: ResearchActivityEvent["level"],
    message: string,
    extra: { readonly stage?: ResearchProgressStage; readonly provider?: string; readonly attempt?: number; readonly nextRetryAt?: string | null } = {},
  ): ResearchActivityEvent {
    const event: ResearchActivityEvent = {
      id: newId(ID_PREFIX.activity),
      taskId,
      at: isoNow(),
      stage: extra.stage ?? currentStageOf(taskId),
      level,
      kind,
      message,
      ...(extra.provider === undefined ? {} : { provider: extra.provider }),
      ...(extra.attempt === undefined ? {} : { attempt: extra.attempt }),
      ...(extra.nextRetryAt === undefined ? {} : { nextRetryAt: extra.nextRetryAt }),
    };
    repo.appendActivity(event);
    return event;
  }

  /** The stage of the run this task is currently in, in a reader's vocabulary. */
  function currentStageOf(taskId: string): ResearchProgressStage {
    const running = repo.listRuns(taskId).find((record) => record.status === "running");
    if (running === undefined) return "preparing";
    switch (running.stage) {
      case "card":
      case "guide":
        return "preparing";
      case "research":
      case "gap":
        return "searching";
      case "report":
        return "reporting";
      case "synthesis":
        return "validating";
      case "ask":
        return "answering";
      case "edit":
        return "editing";
      default:
        return "preparing";
    }
  }

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

  /**
   * What each live grant has spent, keyed by the grant itself.
   *
   * It is process memory on purpose. A grant is permission to write *now*, and
   * it dies with the process; a usage counter that outlived it would be a
   * permission nobody holds. There is deliberately no quota ledger: the
   * project's own ledger (`task.usage`) is what survives, and it is the
   * pipeline's, not a user action's.
   */
  const actionUsage = new Map<string, ActionUsage>();

  /**
   * What a user action started with, and what it produced, keyed by its grant.
   *
   * Two things live here that a project cannot answer about itself. The first
   * is the baseline: the ids of the material the action found in the project,
   * so "this action added two sources" is a difference of two sets rather than
   * the length of the project's source list. The second is the action's own
   * outcome — whether it resolved the question, whether it produced a proposal
   * — which is written at the end and read by whoever records the run.
   *
   * Like the usage counters, it dies with the grant: it is a fact about an
   * action that is still running, and what outlives the process is the run
   * record the runner writes from it.
   */
  interface ActionState {
    readonly startedAt: string;
    readonly baseline: ActionDelta;
    /** How many times this action has been told its proposal failed validation. */
    proposalAttempts: number;
    proposalOutcome: EditActionOutcome | null;
  }

  const actionStates = new Map<string, ActionState>();

  /**
   * The ids a user action will be measured against when it ends.
   *
   * Only a person's action gets one: the program's own passes are bounded by
   * the task's budget rather than by an instruction, and nothing in the product
   * reports what an automatic round "added" — so there is no baseline to keep.
   */
  function baselineOf(taskId: string | null): ActionDelta {
    if (taskId === null) return EMPTY_ACTION_DELTA;
    return {
      newSourceIds: repo.listSources(taskId).map((source) => source.id),
      newEvidenceIds: repo.listEvidence(taskId).map((item) => item.id),
      newAssessmentIds: repo.listAssessments(taskId).map((item) => item.id),
    };
  }

  function idsAddedSince(baseline: readonly string[], current: readonly string[]): readonly string[] {
    const before = new Set(baseline);
    return current.filter((id) => !before.has(id));
  }

  /**
   * What the session's running user action has added so far.
   *
   * A difference of id sets, not a count of the project: an action that read
   * nothing new in a project of forty sources reports zero, because zero is the
   * honest answer to what *this action* found.
   */
  function deltaOfSession(sessionId: string): ActionDelta {
    const grant = grants.get(sessionId);
    const state = grant === undefined ? undefined : actionStates.get(grant.id);
    if (grant === undefined || state === undefined || grant.taskId === null) return EMPTY_ACTION_DELTA;
    return {
      newSourceIds: idsAddedSince(state.baseline.newSourceIds, repo.listSources(grant.taskId).map((source) => source.id)),
      newEvidenceIds: idsAddedSince(state.baseline.newEvidenceIds, repo.listEvidence(grant.taskId).map((item) => item.id)),
      newAssessmentIds: idsAddedSince(state.baseline.newAssessmentIds, repo.listAssessments(grant.taskId).map((item) => item.id)),
    };
  }

  function usageOf(grant: ActionGrant): ActionUsage {
    return actionUsage.get(grant.id) ?? EMPTY_ACTION_USAGE;
  }

  /**
   * Refuses a proposal whose candidate content failed the report's contract.
   *
   * The model gets one repair inside the action that produced the proposal: the
   * problems go back so it can regenerate the section, and the second failure
   * ends the action as `proposal_not_created` instead of looping (§2). What is
   * deliberately *not* here is any softening of the contract to make a proposal
   * succeed (§3): the content satisfies the contract, or there is no proposal.
   */
  function refuseCandidate(grant: ActionGrant, problems: readonly string[]): Refusal {
    const state = actionStates.get(grant.id);
    const attempts = (state?.proposalAttempts ?? 0) + 1;
    if (state !== undefined) state.proposalAttempts = attempts;
    if (attempts <= 1) {
      return {
        ok: false,
        code: "proposal_invalid",
        problems,
        userMessage: proposalRepairCopy(problems),
        guidance:
          "这次改写没有通过报告自身的内容契约，因此还没有保存为提案。请按上面每条问题修正后，用 propose_section_edit 再提交一次——这是本次动作唯一一次修正机会。不要靠删除章节义务或降低依据要求来通过校验。",
      };
    }
    const userMessage = proposalFailureCopy(problems);
    if (state !== undefined) {
      state.proposalOutcome = {
        kind: "edit",
        status: "proposal_not_created",
        userMessage,
        delta: deltaOfSession(grant.sessionId),
      };
    }
    return {
      ok: false,
      code: "proposal_not_created",
      problems,
      userMessage,
      guidance:
        "修正机会已用完，这次动作没有产生提案，报告正文保持不变。请停止提交提案，并用一句话向用户说明没有创建修改建议。",
    };
  }

  function spend(grant: ActionGrant, what: "searches" | "reads" | "gapRounds"): void {
    const usage = usageOf(grant);
    actionUsage.set(grant.id, { ...usage, [what]: usage[what] + 1 });
  }

  /**
   * The usage the pipeline budget is enforced against.
   *
   * On a task that has never retried there is no attempt, and the lifetime
   * usage is the answer — exactly the behaviour this product had before
   * attempts existed. After a retry, the attempt is the answer, and the
   * lifetime totals stay what they are: telemetry about everything that
   * happened, not a budget anybody is still spending from.
   */
  function governingUsage(task: ReportTask): ResearchUsage {
    const attempt = task.attempt;
    if (attempt === undefined) return task.usage;
    return { searches: attempt.searches, reads: attempt.reads, gapRounds: attempt.gapRounds, startedAt: attempt.startedAt };
  }

  /**
   * One spend, written to both ledgers.
   *
   * The lifetime counter always moves (it is what the workspace reports about
   * the project), and the current attempt moves with it when there is one (it
   * is what the next call is refused by). The task is re-read here rather than
   * taken from the caller's copy: a search updates the discovery ledger while
   * it runs, and writing the caller's older payload back would erase it.
   */
  function spendOnTask(taskId: string, what: "searches" | "reads" | "gapRounds", amount = 1): ReportTask {
    const task = requireTask(taskId);
    const usage: ResearchUsage = {
      ...task.usage,
      [what]: task.usage[what] + amount,
    };
    const attempt =
      task.attempt === undefined ? undefined : { ...task.attempt, [what]: task.attempt[what] + amount };
    return updateTask(task, { usage, ...(attempt === undefined ? {} : { attempt }) });
  }

  /** The counts one discovery call adds to the project's request ledger. */
  interface DiscoveryTelemetryUpdate {
    readonly attemptedRequests: number;
    readonly successfulRequests: number;
    readonly failedRequests: number;
    readonly lastProvider: string | null;
    readonly lastElapsedMs: number | null;
    /** `undefined` keeps the previous failure; `null` clears it (a success). */
    readonly lastFailure?: DiscoveryTelemetry["lastFailure"] | undefined;
  }

  /** The discovery ledger, advanced by the physical attempts of one call. */
  function recordDiscovery(taskId: string, outcome: DiscoveryTelemetryUpdate): ReportTask {
    const task = requireTask(taskId);
    const previous = task.discovery;
    const next: DiscoveryTelemetry = {
      attemptedRequests: (previous?.attemptedRequests ?? 0) + outcome.attemptedRequests,
      successfulRequests: (previous?.successfulRequests ?? 0) + outcome.successfulRequests,
      failedRequests: (previous?.failedRequests ?? 0) + outcome.failedRequests,
      lastProvider: outcome.lastProvider ?? previous?.lastProvider ?? null,
      lastElapsedMs: outcome.lastElapsedMs ?? previous?.lastElapsedMs ?? null,
      lastFailure: outcome.lastFailure === undefined ? (previous?.lastFailure ?? null) : outcome.lastFailure,
    };
    return updateTask(task, { discovery: next });
  }

  /**
   * Starts a new bounded attempt on a task.
   *
   * The first research pass and a retry both come through here, which is what
   * keeps「这一次研究」one thing: the deadline is counted from this moment, the
   * search/read/gap counters that govern the pipeline start at zero, and the
   * lifetime usage keeps everything that was ever spent.
   */
  function beginAttempt(task: ReportTask, reason: string): { readonly task: ReportTask; readonly attempt: ResearchAttempt } {
    const attempt: ResearchAttempt = {
      number: (task.attempt?.number ?? 0) + 1,
      startedAt: isoNow(),
      searches: 0,
      reads: 0,
      gapRounds: 0,
      reason,
    };
    const updated = updateTask(task, {
      status: "researching",
      error: null,
      usage: { ...task.usage, startedAt: attempt.startedAt },
      attempt,
    });
    return { task: updated, attempt };
  }

  /**
   * The user's decision to research this project again after it stopped.
   *
   * Retrying is not resetting: the brief, the subjects, the dimensions, every
   * source, every piece of evidence, the report and every frozen revision stay
   * exactly where they are — what changes is that the failure which was
   * blocking the project is cleared and a new, bounded attempt begins. The
   * attempt is why the old `startedAt` cannot reject the retry it just
   * allowed, and why the project's lifetime counters are never wound back: the
   * work that happened is still recorded as having happened.
   */
  function retryResearch(taskId: string): RetryResearchResult {
    const task = repo.getTask(taskId);
    if (task === undefined) {
      return {
        ok: false,
        reason: "task_unknown",
        problems: [`没有找到研究任务：${taskId}`],
        guidance: "请确认任务 id。",
        conflict: true,
      };
    }
    if (task.confirmedAt === null) {
      return {
        ok: false,
        reason: "brief_unconfirmed",
        problems: ["这个项目的研究简报还没有确认，研究从未开始，也就不存在可以重试的运行"],
        guidance: "请先确认研究简报，再开始研究。",
        conflict: true,
      };
    }
    if (task.status !== "failed") {
      return {
        ok: false,
        reason: "not_recoverable",
        problems: [`只有失败的项目可以重新研究，这个项目的状态是「${task.status}」`],
        guidance:
          task.status === "researching"
            ? "项目正在研究中：请等待当前运行结束，或让助手基于已有材料继续。"
            : "项目没有停在失败上；如果需要补充材料，请让助手发起一次补查。",
        conflict: true,
      };
    }
    if (repo.listRuns(taskId).some((record) => record.status === "running")) {
      return {
        ok: false,
        reason: "run_in_progress",
        problems: ["这个项目还有一次运行正在进行中"],
        guidance: "请等待当前运行结束后再重新研究，避免两次运行同时写入同一个项目。",
        conflict: true,
      };
    }
    const begun = beginAttempt(task, "用户请求重新研究（保留原有材料、报告与冻结版本）");
    const preserved = {
      sources: repo.listSources(taskId).length,
      evidence: repo.listEvidence(taskId).length,
      assessments: repo.listAssessments(taskId).length,
      reports: repo.listReports(taskId).length,
      revisions: repo.listRevisions(taskId).length,
      reportKept: begun.task.currentReportId !== null,
    };
    recordActivity(taskId, "retry_started", "info", "重新开始研究：保留已有的来源、证据、报告与冻结版本", {
      stage: "preparing",
    });
    return {
      ok: true,
      task: begun.task,
      attempt: begun.attempt,
      preserved,
      message:
        preserved.sources > 0
          ? `已重新开始研究。原有的 ${preserved.sources} 个来源与 ${preserved.evidence} 条证据保留不变${preserved.reportKept ? "，报告正文也不会被自动改写" : ""}。`
          : "已重新开始研究。这个项目此前没有留下可用的来源或证据，将重新检索。",
    };
  }

  /**
   * A stored source as the candidate it was discovered as.
   *
   * The corpus is deduplicated by the identity of a *work* — DOI, arXiv id,
   * normalized URL — so the stored source has to be expressible in the same
   * terms the providers return. Nothing is invented here: a field the source
   * does not carry stays empty, and an empty key simply does not participate in
   * the comparison.
   */
  function sourceOfCandidate(source: Source): SearchCandidate {
    return {
      provider: (source.discovery.provider === "openalex" ? "openalex" : "arxiv") as SearchCandidate["provider"],
      providerId: source.discovery.providerId ?? "",
      title: source.title,
      authors: source.authors,
      abstract: source.abstract,
      landingUrl: source.url,
      pdfUrl: source.pdfUrl,
      publishedAt: source.publishedAt,
      doi: source.doi,
      venue: source.venue,
      arxivId: arxivIdOf(source.url) ?? arxivIdOfDoi(source.doi) ?? null,
    };
  }

  /** The action budget governing this task's session, when one is a user's. */
  function userActionOf(task: ReportTask): ActionGrant | undefined {
    const grant = grants.get(task.sessionId);
    return grant !== undefined && grant.origin === "user" ? grant : undefined;
  }

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

  /**
   * The refusal a spend earns when the budget that governs it is used up.
   *
   * Two budgets meet here, and they bound different things. The pipeline's is
   * the task's: a wall-clock deadline, a search count, a read count and a gap
   * round count that together stop the agent from researching forever on its own
   * initiative. A user action's is its own grant's: one instruction, bounded so
   * that「再查一下」cannot turn into six searches and ten reads, and *not* bound
   * by how long ago the project started — a finished project from this morning
   * is exactly the thing someone asks to dig further into.
   */
  function budgetRefusal(task: ReportTask, what: string, guidance: string): Refusal | undefined {
    const action = userActionOf(task);
    if (action !== undefined) {
      const usage = usageOf(action);
      switch (what) {
        case "search":
          if (usage.searches >= action.budget.maxSearches) {
            return {
              ok: false,
              problems: [`本次补查的检索次数已用完（${usage.searches}/${action.budget.maxSearches}）`],
              guidance:
                "这次动作只允许这么多次检索：请读取已有候选，并用 assess_coverage 评估覆盖情况；需要继续检索时由用户再发起一次补查。",
            };
          }
          break;
        case "read":
          if (usage.reads >= action.budget.maxReads) {
            return {
              ok: false,
              problems: [`本次补查的读取次数已用完（${usage.reads}/${action.budget.maxReads}）`],
              guidance:
                "这次动作只允许读这么多个来源：请基于已读材料评估矩阵，缺依据的项目如实标注；需要继续读取时由用户再发起一次补查。",
            };
          }
          break;
        case "gap":
          if (usage.gapRounds >= action.budget.maxGapRounds) {
            return {
              ok: false,
              problems: [`本次补查的评估轮次已用完（${usage.gapRounds}/${action.budget.maxGapRounds}）`],
              guidance: "请在本次动作内收尾：把已获得的材料写进评估，缺口如实保留。",
            };
          }
          break;
      }
      return undefined;
    }

    // The pipeline budget is enforced against the current *attempt*, not against
    // the project's lifetime totals: a retry is allowed to research again, and
    // the numbers that bound it are this attempt's own. On a task that never
    // retried, the two are the same object, and nothing about this path changes.
    const usage = governingUsage(task);
    const started = usage.startedAt;
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
        if (usage.searches >= task.budget.maxSearches) {
          return {
            ok: false,
            problems: [`搜索次数已达上限（${usage.searches}/${task.budget.maxSearches}）`],
            guidance: "请读取已知候选来源，并用 assess_coverage 评估覆盖情况。",
          };
        }
        break;
      case "read":
        if (usage.reads >= task.budget.maxReads) {
          return {
            ok: false,
            problems: [`读取次数已达上限（${usage.reads}/${task.budget.maxReads}）`],
            guidance: "请停止读取，评估矩阵并用已有证据生成报告；缺少依据的项目如实标注。",
          };
        }
        break;
      case "gap":
        if (usage.gapRounds >= task.budget.maxGapRounds) {
          return {
            ok: false,
            problems: [`定向补查轮次已达上限（${usage.gapRounds}/${task.budget.maxGapRounds}）`],
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
    const readiness = guideReadinessDecisions(task);
    if (task.confirmedAt !== null) {
      return { complete: true, reason: "研究简报已确认，引导式规划结束", target: null, answered: 0, readiness };
    }
    const answered = answeredGuideDecisions(task.id).length;
    const closed = task.guideClosed ?? null;
    if (closed !== null) {
      return { complete: true, reason: closed.reason, target: null, answered, readiness };
    }
    const target = nextGuideTarget({ task, answered });
    if (target === undefined) {
      return {
        complete: true,
        reason:
          answered >= GUIDE_MAX_DECISIONS
            ? `已完成 ${answered} 个关键决策（上限 ${GUIDE_MAX_DECISIONS}）；其余字段可以随时直接编辑`
            : readiness >= GUIDE_MIN_DECISIONS
              ? `已完成 ${readiness} 个关键决策，其余可引导的字段也已经由用户决定`
              : "所有可引导的字段都已经由用户决定",
        target: null,
        answered,
        readiness,
      };
    }
    return { complete: false, reason: "", target, answered, readiness };
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
    const validation = validateBriefDraft(task);
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
      validation,
      // Guided planning is a conversation, not a gate: a user who is satisfied
      // confirms the draft whenever they like, and the floor only binds the
      // agent's own decision to stop asking.
      canConfirm: task.confirmedAt === null && validation.valid,
      guide: {
        complete: decision.complete,
        reason: decision.reason,
        limit: GUIDE_MAX_DECISIONS,
        minDecisions: GUIDE_MIN_DECISIONS,
        maxDecisions: GUIDE_MAX_DECISIONS,
        readiness: decision.readiness,
        decisions: answeredGuideDecisions(task.id).map((question) => ({
          questionId: question.id,
          leadIn: guideLeadInOf(question),
          question: question.question,
          fieldTargets: question.fieldTargets,
          optionIds: question.answer?.optionIds ?? [],
          selectedOptionLabels: guideAnswerLabelsOf(question),
          answerText: guideAnswerTextOf(question),
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
                leadIn: guideLeadInOf(active),
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
        readonly leadIn: string;
        readonly question: string;
        readonly whyThisMatters: string;
        readonly fieldTargets: readonly BriefFieldName[];
        readonly options: readonly GuideOption[];
      }
    | { readonly ok: false; readonly problems: readonly string[] };

  /** Whether a piece of prose the model wrote has markup in it. */
  function looksLikeHtml(text: string): boolean {
    return /<\/?[a-zA-Z][^>]*>/.test(text);
  }

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
    // The lead-in is conversation, not a decision: it is optional, capped and
    // plain. Markdown prose is fine — the workspace renders it with the same
    // sanitizing renderer every other model text goes through — but markup is
    // refused here rather than rendered and trusted later.
    const leadIn = typeof record["leadIn"] === "string" ? record["leadIn"].trim() : "";
    if (leadIn.length > GUIDE_LEAD_IN_LIMIT) problems.push(`leadIn 过长（>${GUIDE_LEAD_IN_LIMIT} 字）`);
    if (looksLikeHtml(leadIn)) problems.push("leadIn 只能是普通文本或 Markdown，不要包含 HTML 标签");
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
    return { ok: true, complete: false, leadIn, question, whyThisMatters, fieldTargets, options };
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
        // The depth contract: until enough decisions have really been made, the
        // agent has no authority to end the conversation. The refusal is a
        // result rather than an exception, so the run it happens in can answer
        // with a real question instead — and nothing here closes the guide.
        if (decision.readiness < GUIDE_MIN_DECISIONS) {
          return {
            ok: false,
            problems: [
              `当前只完成 ${decision.readiness}/${GUIDE_MIN_DECISIONS} 个关键决策，还不能结束引导式规划（complete 被拒绝）`,
            ],
            guidance:
              `请继续围绕程序指定的字段 ${decision.target.field}（${decision.target.ask}）生成一个真正有区分度的问题，并再次调用 propose_guide_question；` +
              "只有用户自己可以直接开始研究，Agent 不能替他提前结束。",
          };
        }
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
        ...(reading.leadIn.length === 0 ? {} : { leadIn: reading.leadIn }),
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

      // What the person chose is recorded in the words they chose it in: the
      // labels of the options they picked, or what they typed. A conversation
      // view reads the decision back without re-opening the question, and the
      // ids stay for the audit trail.
      const labels = question.options
        .filter((option) => chosen.includes(option.optionId))
        .map((option) => option.label);
      const answer: GuideAnswerRecord = {
        optionIds: chosen,
        freeText,
        selectedOptionLabels: labels,
        answerText: freeText.length > 0 ? freeText : labels.join("、"),
        appliedFields: changed.fields,
        resultingBriefVersion: briefVersionOf(changed.task),
        at: isoNow(),
      };
      repo.saveGuideQuestion({ ...question, status: "answered", answer });
      const brief = briefViewOf(requireTask(taskId));
      return { ok: true, brief, appliedFields: changed.fields, complete: brief.guide.complete };
    },

    startResearch(taskId) {
      return beginAttempt(requireTask(taskId), "用户确认任务后开始研究").task;
    },

    failTask(taskId, error) {
      const task = requireTask(taskId);
      updateTask(task, { status: "failed", error });
      recordActivity(taskId, "stage_failed", "error", error, { stage: "failed" });
    },

    retryResearch(taskId) {
      return retryResearch(taskId);
    },

    activityOf: (taskId, limit) => repo.listActivity(taskId, limit),

    recordActivity(input) {
      return recordActivity(input.taskId, input.kind, input.level ?? "info", input.message, {
        ...(input.stage === undefined ? {} : { stage: input.stage }),
        ...(input.provider === undefined ? {} : { provider: input.provider }),
        ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
        ...(input.nextRetryAt === undefined ? {} : { nextRetryAt: input.nextRetryAt }),
      });
    },

    getTask: (taskId) => repo.getTask(taskId),

    async search(taskId, input) {
      const task = requireTask(taskId);
      const refusal = requireTaskCapability(taskId, "research");
      if (refusal !== undefined) return refusal;
      const budgetStop = budgetRefusal(task, "search", "");
      if (budgetStop !== undefined) return budgetStop;

      const limit = Math.max(1, Math.min(task.budget.maxCandidatesPerSearch, input.limit ?? task.budget.maxCandidatesPerSearch));
      const startedAt = now().getTime();
      recordActivity(task.id, "search_started", "info", `开始检索：${input.query}`, {
        stage: currentStageOf(task.id),
      });

      let outcome: SearchOutcome;
      try {
        outcome =
          options.search === undefined
            ? await searchSources(input.query, {
                ...options.discovery,
                limit,
                breaker: options.discovery?.breaker ?? breaker,
                ...(input.signal === undefined ? {} : { signal: input.signal }),
                // Inside a stage, what discovery does is what the reader is
                // waiting for: every request, refusal, wait and switch becomes
                // a line of this project's own history.
                onEvent: (event: DiscoveryEvent) => {
                  recordActivity(task.id, event.kind, event.level, event.message, {
                    ...(event.attempt === undefined ? {} : { attempt: event.attempt }),
                    provider: event.provider,
                    ...(event.nextRetryAt === undefined ? {} : { nextRetryAt: event.nextRetryAt }),
                  });
                },
              })
            : await searchImpl(input.query, {
                limit,
                ...(input.signal === undefined ? {} : { signal: input.signal }),
              });
      } catch (error) {
        // A search that could not reach any provider is an *answer* the model
        // has to be able to act on — never an exception that leaves a run
        // looking like it did nothing, and never a silent retry loop. The
        // request ledger is advanced first, so「0 次检索」can no longer hide
        // the failed requests that produced it.
        const failure = error instanceof SearchError ? error : undefined;
        const elapsed = now().getTime() - startedAt;
        const attempts = failure?.attempts ?? [];
        recordDiscovery(task.id, {
          attemptedRequests: Math.max(attempts.length, 1),
          successfulRequests: attempts.filter((attempt) => attempt.ok).length,
          failedRequests: Math.max(attempts.filter((attempt) => !attempt.ok).length, 1),
          lastProvider: failure?.provider ?? null,
          lastElapsedMs: elapsed,
          lastFailure: {
            at: isoNow(),
            provider: failure?.provider ?? "unknown",
            kind: failure?.kind ?? "network_error",
            status: failure?.status ?? null,
            userMessage: failure?.userMessage ?? "检索请求失败",
          },
        });
        if (failure?.kind !== "aborted") {
          recordActivity(task.id, "search_failed", "error", failure?.userMessage ?? "检索请求失败", {
            provider: failure?.provider,
            nextRetryAt: failure?.retryAfterMs === null || failure?.retryAfterMs === undefined ? null : new Date(now().getTime() + failure.retryAfterMs).toISOString(),
          });
        }
        return {
          ok: false,
          problems: [
            failure === undefined
              ? `检索失败：${error instanceof Error ? error.message : "未知错误"}`
              : failure.userMessage,
          ],
          guidance:
            failure?.kind === "aborted"
              ? "本次检索已被取消，没有产生候选。"
              : "检索服务当前不可用（不是「主题没有资料」）。不要反复调用 search_sources：请基于已读取的材料继续评估与写作，并把缺少依据的项目如实写成缺口。",
        };
      }

      const attempts = outcome.attempts ?? [];
      recordDiscovery(task.id, {
        attemptedRequests: attempts.length,
        successfulRequests: attempts.filter((attempt) => attempt.ok).length,
        failedRequests: attempts.filter((attempt) => !attempt.ok).length,
        lastProvider: outcome.provider,
        lastElapsedMs: now().getTime() - startedAt,
        lastFailure: null,
      });

      const known = new Set(repo.listSources(task.id).map((source) => source.url));
      // A work is the same work whoever listed it: the corpus is keyed by DOI,
      // arXiv id and normalized URL, so a fallback provider listing a paper
      // arXiv already found adds a hit to the search's provenance rather than a
      // duplicate row the report could cite twice.
      const knownKeys = new Set(repo.listSources(task.id).flatMap((source) => candidateKeys(sourceOfCandidate(source))));
      const target: CellRef | null = input.targetCell ?? null;
      const created: SearchResult["sources"][number][] = [];
      for (const candidate of dedupeCandidates(outcome.candidates)) {
        const url = candidate.landingUrl;
        const keys = candidateKeys(candidate);
        const existing = repo
          .listSources(task.id)
          .find((source) => source.url === url || keys.some((key) => candidateKeys(sourceOfCandidate(source)).includes(key)));
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
          for (const key of keys) knownKeys.add(key);
          continue;
        }
        const alreadyKnown = known.has(url) || keys.some((key) => knownKeys.has(key));
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
          venue: candidate.venue,
          abstract: candidate.abstract,
          discovery: {
            provider: candidate.provider,
            providerId: candidate.providerId,
            query: input.query,
            requestUrl: outcome.requestUrl,
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
        for (const key of keys) knownKeys.add(key);
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

      if (created.length > 0) {
        recordActivity(task.id, "candidates_found", "info", `找到 ${created.length} 个候选来源`, {
          provider: outcome.provider,
        });
      }
      // A degraded search says so: a thin result set is a different fact from a
      // topic without literature, and the provider that refused to answer is
      // part of the answer's provenance.
      const degraded =
        (outcome.providerFailures ?? []).length === 0
          ? ""
          : `；另有 ${(outcome.providerFailures ?? []).map((failure) => failure.userMessage).join("；")}`;

      // The task's counter is cumulative telemetry and always moves; which
      // budget *refuses the next call* is the thing that differs, so the
      // remaining count is reported against whichever one governs this run.
      const spent = spendOnTask(task.id, "searches");
      const searches = spent.usage.searches;
      const action = userActionOf(spent);
      if (action !== undefined) spend(action, "searches");
      const actionUsage = action === undefined ? undefined : usageOf(action);
      const budgetUsage = governingUsage(spent);

      return {
        ok: true,
        sources: created,
        query: input.query,
        requestUrl: outcome.requestUrl,
        total: outcome.total,
        provider: outcome.provider,
        providersTried: outcome.providersTried ?? [outcome.provider],
        attempts: {
          attempted: attempts.length,
          succeeded: attempts.filter((attempt) => attempt.ok).length,
          failed: attempts.filter((attempt) => !attempt.ok).length,
        },
        searchCount: searches,
        searchesRemaining:
          action === undefined || actionUsage === undefined
            ? Math.max(0, spent.budget.maxSearches - budgetUsage.searches)
            : Math.max(0, action.budget.maxSearches - actionUsage.searches),
        budgetScope: action === undefined ? "project" : "user-action",
        note:
          created.length === 0
            ? `本次检索没有返回候选（${PROVIDER_NAMES[outcome.provider]}）${degraded}：请换英文关键词或更基础的术语。搜索结果只是候选，不是依据。`
            : `以上是${PROVIDER_NAMES[outcome.provider]}返回的检索候选（metadata）${degraded}。只有 read_source 真正读取后才会产生可引用证据。`,
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
      //
      // The value is captured, not just written: finishing the read updates the
      // same row from a copy of the source taken before this line, so a role
      // that lived only in that first write would be erased by the read it
      // belongs to — and the workspace would show「未声明」for material the
      // agent had in fact classified.
      const role: SourceRole | null = input.role ?? source.role ?? null;
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

        const grant = userActionOf(task);
        recordActivity(task.id, "read_started", "info", `开始读取：${source.title}`, {
          provider: source.discovery.provider,
        });
        // What discovery already knows about this work travels with the read:
        // when nothing can be fetched, the provider's own abstract is still a
        // real — and partial — read, and the reader says which of the two
        // happened instead of reporting a bare failure.
        const outcome = await readImpl(
          {
            url: source.url,
            metadata: {
              provider: source.discovery.provider === "openalex" ? "openalex" : "arxiv",
              workUrl: source.discovery.requestUrl ?? null,
              title: source.title,
              abstract: source.abstract,
              doi: source.doi,
            },
          },
          input.signal === undefined ? {} : { signal: input.signal },
        );
        if (grant !== undefined) spend(grant, "reads");
        if (outcome.status === "failed" || outcome.scope === null) {
          repo.updateSource({
            ...source,
            role,
            readStatus: "failed",
            readScope: null,
            readAt: outcome.fetchedAt,
            readUrl: outcome.readUrl,
            retrievalNote: outcome.note,
            failure: outcome.failure,
          });
          spendOnTask(task.id, "reads");
          recordActivity(task.id, "read_failed", "warn", `读取失败：${source.title}（${outcome.failure ?? outcome.note}）`, {
            provider: source.discovery.provider,
          });
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
          role,
          readStatus: "ok",
          readScope: outcome.scope,
          readAt: outcome.fetchedAt,
          readUrl: outcome.readUrl,
          retrievalNote: outcome.note,
          failure: null,
          snapshotId: snapshot.id,
        });
        spendOnTask(task.id, "reads");
        note = outcome.note;
        recordActivity(
          task.id,
          "read_completed",
          outcome.scope === "abstract" ? "warn" : "info",
          outcome.scope === "abstract"
            ? `读取完成（摘要级）：${snapshot.title}`
            : `读取完成（${scopeLabel(outcome.scope)}）：${snapshot.title}`,
          { provider: source.discovery.provider },
        );
      } else {
        note = `${snapshot.note}（复用已保存读取快照，未重复消耗读取预算）`;
        recordActivity(task.id, "read_completed", "info", `复用已保存的读取快照：${snapshot.title}`);
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
      const action = userActionOf(refreshed);
      const actionUsage = action === undefined ? undefined : usageOf(action);

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
        readsRemaining:
          action === undefined || actionUsage === undefined
            ? Math.max(0, refreshed.budget.maxReads - governingUsage(refreshed).reads)
            : Math.max(0, action.budget.maxReads - actionUsage.reads),
        budgetScope: action === undefined ? "project" : "user-action",
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
        const action = userActionOf(task);
        if (action === undefined) {
          task = spendOnTask(task.id, "gapRounds");
        } else {
          // `gapRound` counts the pipeline's own rounds: how many times the
          // agent decided on its own to go back for more. A round a person
          // asked for is not one of those, and letting it bump the counter
          // would spend the automatic budget on the user's errand.
          spend(action, "gapRounds");
        }
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
      if (recorded.length > 0) {
        recordActivity(task.id, "assessment_recorded", "info", `记录 ${recorded.length} 条支持评估（仍有 ${gaps.length} 个比较项未达到「已核对」）`);
      }
      const action = userActionOf(task);
      const actionUsage = action === undefined ? undefined : usageOf(action);
      const governing = governingUsage(task);

      return {
        ok: true,
        cells: views,
        gaps,
        gapRoundsUsed: action === undefined || actionUsage === undefined ? governing.gapRounds : actionUsage.gapRounds,
        gapRoundsRemaining:
          action === undefined || actionUsage === undefined
            ? Math.max(0, task.budget.maxGapRounds - governing.gapRounds)
            : Math.max(0, action.budget.maxGapRounds - actionUsage.gapRounds),
        budgetScope: action === undefined ? "project" : "user-action",
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
      const previous = grants.get(grant.sessionId);
      grants.set(grant.sessionId, grant);
      // A new grant starts with nothing spent, and the one it replaces leaves
      // no counter behind: what a finished action used is not a budget anyone
      // can still draw on.
      actionUsage.set(grant.id, EMPTY_ACTION_USAGE);
      if (previous !== undefined && previous.id !== grant.id) {
        actionUsage.delete(previous.id);
        actionStates.delete(previous.id);
      }
      // A user action is measured against the project as it was when the action
      // started. Snapshotting here — where the permission is minted, right
      // before the run begins — is what makes the delta unarguable: it cannot
      // include material that was already there.
      if (grant.origin === "user") {
        actionStates.set(grant.id, {
          startedAt: grant.createdAt,
          baseline: baselineOf(grant.taskId),
          proposalAttempts: 0,
          proposalOutcome: null,
        });
      }
      return grant;
    },
    activeGrant: (sessionId) => grants.get(sessionId),
    actionBudgetOf(sessionId) {
      const grant = grants.get(sessionId);
      if (grant === undefined || grant.origin !== "user") return undefined;
      const usage = usageOf(grant);
      return {
        searchesRemaining: Math.max(0, grant.budget.maxSearches - usage.searches),
        readsRemaining: Math.max(0, grant.budget.maxReads - usage.reads),
        gapRoundsRemaining: Math.max(0, grant.budget.maxGapRounds - usage.gapRounds),
      };
    },
    actionDeltaOf: (sessionId) => deltaOfSession(sessionId),
    actionOutcomeOf(sessionId, userText) {
      const grant = grants.get(sessionId);
      const state = grant === undefined ? undefined : actionStates.get(grant.id);
      if (grant === undefined || state === undefined || grant.taskId === null) return undefined;
      const delta = deltaOfSession(sessionId);
      if (grant.intent === "edit") {
        // An Edit that never reached the proposal tool still has an outcome:
        // the action ended without a proposal, and saying so is the point.
        return (
          state.proposalOutcome ?? {
            kind: "edit",
            status: "proposal_not_created",
            userMessage: "这次没有生成修改建议；报告正文没有改变。可以换一种说法再试一次。",
            delta,
          }
        ) satisfies RunOutcome;
      }
      // Only a research action has something to resolve: Ask writes nothing.
      if (grant.intent !== "research") return undefined;
      const task = repo.getTask(grant.taskId);
      if (task === undefined) return undefined;
      const resolution: ResearchResolution = deriveResearchResolution({
        question: userText,
        delta,
        sources: repo.listSources(task.id),
        evidence: repo.listEvidence(task.id),
        assessments: repo.listAssessments(task.id),
        cells: cellViews(task),
        subjectNames: new Map(task.subjects.map((subject) => [subject.id, subject.name])),
        dimensionNames: new Map(task.dimensions.map((dimension) => [dimension.id, dimension.name])),
        hasReport: task.currentReportId !== null,
      });
      return { kind: "research", resolution, delta } satisfies RunOutcome;
    },
    clearGrant(sessionId) {
      const grant = grants.get(sessionId);
      if (grant !== undefined) {
        actionUsage.delete(grant.id);
        actionStates.delete(grant.id);
      }
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

      // A table the user will be shown has to be complete: a replacement
      // section carrying a table with unwritten cells would render as headings
      // and empty rows — the defect this contract exists to stop — so a
      // proposal that cannot produce a complete table is not created at all.
      const tableGaps = tableGapsOf(input.sections);
      if (tableGaps.length > 0) {
        return refuseCandidate(
          grant,
          tableGaps.map(
            (gap) =>
              `提案中章节「${gap.sectionTitle}」的表格存在空白单元格（${blankCellLabel(gap.blanks)}）：${BLANK_CELL_REMEDY}`,
          ),
        );
      }

      const evidenceIds = [...new Set([...(input.claims ?? []).flatMap((claim) => claim.evidenceIds)])];
      const delta = deltaOfSession(task.sessionId);
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
        // The material this action really added, as a difference of id sets. A
        // project that already holds forty sources reports zero here when the
        // edit found nothing new, because zero is the honest answer to what
        // *this* action brought in.
        researchAdded: {
          sources: delta.newSourceIds.length,
          evidence: delta.newEvidenceIds.length,
          assessments: delta.newAssessmentIds.length,
        },
        now: isoNow(),
      });

      // The preflight. A pending proposal means "if the base has not gone
      // stale, this change satisfies the report's own contract and can be
      // accepted" — so the candidate report is assembled here and run through
      // the same validator the accept path uses. A proposal that would be
      // refused on accept is never offered as one that could be accepted.
      const candidate = applyProposal(proposalBaseOf(base), proposal);
      const validation = validateReport({
        draft: candidate,
        task,
        evidence: repo.listEvidence(task.id),
        sources: repo.listSources(task.id),
        assessments: repo.listAssessments(task.id),
        snapshotText: (readId) => repo.getSnapshot(readId)?.text,
        // The sections this edit does not touch are the report's own history: a
        // fault they already carried is reported, not blamed on this change.
        carriedOverSectionIds: base.sections
          .map((section) => section.id)
          .filter((sectionId) => !targets.some((target) => target.targetId === sectionId)),
        now: isoNow(),
      });
      if (!validation.ok) {
        return refuseCandidate(grant, validation.problems);
      }

      repo.saveProposal(proposal);
      const state = actionStates.get(grant.id);
      if (state !== undefined) {
        state.proposalOutcome = {
          kind: "edit",
          status: "proposal_created",
          userMessage: "已经准备好修改建议，等你决定是否接受；在决定之前报告正文不会改变。",
          delta,
        };
      }
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
        // The same set the proposal's preflight passed: sections this proposal
        // does not target are the report's own history, so accept cannot refuse
        // on a fault the preflight already saw and reported as a warning.
        carriedOverSectionIds: base.sections
          .map((section) => section.id)
          .filter((sectionId) => !proposal.targets.some((target) => target.targetId === sectionId)),
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
