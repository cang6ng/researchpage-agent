/**
 * The workspace's view of the application API, and nothing else.
 *
 * The page talks to the same origin it was served from: the application's
 * routes are the only door, and there is no host, protocol or model client in
 * this bundle. Every type here mirrors what the routes really return, so a
 * change on the server side shows up as a compile error in the page rather
 * than as a blank panel.
 */

export interface CellView {
  readonly sectionId: string;
  readonly subjectId: string;
  readonly dimensionId: string;
  readonly subjectName: string;
  readonly dimensionName: string;
  readonly status: "reviewed" | "limited" | "unassessed" | "conflict" | "missing";
  readonly reason: string;
  readonly gap: string;
  readonly evidenceIds: readonly string[];
  readonly note: string;
}

export type SourceRole = "primary" | "official" | "independent-evaluation" | "survey" | "contextual" | "user-provided";

export interface SourceView {
  readonly sourceId: string;
  readonly title: string;
  readonly authors: readonly string[];
  readonly venue: string;
  readonly publishedAt: string | null;
  readonly url: string;
  readonly doi: string | null;
  readonly abstract: string;
  readonly role: SourceRole | null;
  readonly readStatus: "not_read" | "ok" | "failed";
  readonly readScope: "metadata" | "abstract" | "body_excerpt" | "full_text" | null;
  readonly readAt: string | null;
  readonly readUrl: string | null;
  readonly retrievalNote: string;
  readonly failure: string | null;
  readonly discovery: {
    readonly provider: string;
    readonly query: string;
    readonly queriedAt: string;
    readonly target: { readonly sectionId: string; readonly subjectId: string; readonly dimensionId: string } | null;
  };
}

export interface EvidenceView {
  readonly evidenceId: string;
  readonly sourceId: string;
  readonly excerpt: string;
  readonly locator: {
    readonly paragraphIndex: number;
    readonly headingPath: readonly string[];
    readonly charStart: number;
    readonly charEnd: number;
  };
  readonly readScope: "metadata" | "abstract" | "body_excerpt" | "full_text";
  readonly pickedBecause: string;
  readonly cells: readonly { readonly sectionId: string; readonly subjectId: string; readonly dimensionId: string }[];
}

export interface RunStepView {
  readonly name: string;
  readonly detail: string;
  readonly ok: boolean | null;
  readonly at: string;
}

/**
 * What one user action added, measured against the project it started in.
 *
 * A difference of id sets, taken while the action ran — never a length of the
 * project's own lists. That is what makes「本次修改没有新增研究材料」an
 * answerable sentence: it means the ids did not change, not that the numbers
 * happened to look small.
 */
export interface ActionDeltaView {
  readonly newSourceIds: readonly string[];
  readonly newEvidenceIds: readonly string[];
  readonly newAssessmentIds: readonly string[];
}

/** What a user research action resolved, and on what it stands. */
export interface ResearchResolutionView {
  readonly status: "resolved" | "partially_resolved" | "unresolved";
  readonly question: string;
  readonly newSourceIds: readonly string[];
  readonly newEvidenceIds: readonly string[];
  readonly newAssessmentIds: readonly string[];
  readonly supportingEvidenceIds: readonly string[];
  readonly targetCells: readonly { readonly sectionId: string; readonly subjectId: string; readonly dimensionId: string }[];
  readonly remainingGap: readonly {
    readonly subjectName: string;
    readonly dimensionName: string;
    readonly status: string;
    readonly reason: string;
  }[];
  readonly summary: string;
}

/** What a user action ended as: a resolution, or an Edit's own outcome. */
export type RunOutcomeView =
  | { readonly kind: "research"; readonly resolution: ResearchResolutionView; readonly delta: ActionDeltaView }
  | {
      readonly kind: "edit";
      readonly status: "proposal_created" | "proposal_not_created";
      readonly userMessage: string;
      readonly delta: ActionDeltaView;
    };

export interface RunView {
  readonly runId: string | null;
  readonly stage: "intent" | "card" | "guide" | "research" | "gap" | "report" | "synthesis" | "ask" | "edit" | "followup";
  readonly status: "running" | "completed" | "failed" | "interrupted";
  readonly note: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly activity: readonly RunStepView[];
  /**
   * What the reader asked for, when the run is one they started themselves.
   *
   * Empty for the program's own stages — the automatic research, gap and
   * writing passes are work the product decided on, not turns in a
   * conversation — which is exactly what makes this a conversation: the runs
   * that carry a sentence here are the ones a person asked for.
   */
  readonly userText: string;
  /** What the action resolved, for the runs a person asked for. */
  readonly outcome: RunOutcomeView | null;
}

export type BriefFieldName =
  | "topic"
  | "purpose"
  | "audience"
  | "subjects"
  | "dimensions"
  | "focus"
  | "exclusions"
  | "lengthTarget";

/** `suggested` is the agent's default; the other two mean a person decided. */
export type BriefFieldState = "suggested" | "edited" | "confirmed";

export type BriefFieldStates = Readonly<Record<BriefFieldName, BriefFieldState>>;

/** The value a structured edit sets on one or more fields. */
export interface BriefPatch {
  readonly topic?: string;
  readonly purpose?: string;
  readonly audience?: string;
  readonly focus?: readonly string[];
  readonly exclusions?: string;
  readonly lengthTarget?: string;
  /** Existing rows carry their `id`; a new row omits it and the server mints one. */
  readonly subjects?: readonly { readonly id?: string; readonly name: string; readonly note?: string }[];
  readonly dimensions?: readonly { readonly id?: string; readonly name: string; readonly question: string }[];
}

export interface GuideOptionView {
  readonly optionId: string;
  readonly label: string;
  readonly description?: string;
  readonly recommended?: boolean;
}

/**
 * What one user action may still spend.
 *
 * It is the action's own allowance — the answer to「这次补查还能查多少」— not
 * what is left of the project, which has its own budget for the agent's own
 * research.
 */
export interface ActionBudgetView {
  readonly searchesRemaining: number;
  readonly readsRemaining: number;
  readonly gapRoundsRemaining: number;
}

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
 * A decision already made through Guided Mode, for the page's own record.
 *
 * It carries what a conversation shows (`answerText`, `selectedOptionLabels`,
 * `leadIn`) as well as the ids an audit needs, so a page never has to re-open
 * an old question to say what the user chose.
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
 * The Research Brief as the page reads it.
 *
 * It is the same draft the structured editor and the guided answers write to —
 * there is deliberately no second draft model — so this view is what tells the
 * page both what the fields are and which of them a person has already decided.
 * When `readonly` is set the project is confirmed and the brief is frozen.
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
  readonly reportStructure: readonly {
    readonly id: string;
    readonly title: string;
    readonly question: string;
    readonly required: boolean;
  }[];
  readonly editableFields: readonly BriefFieldName[];
  readonly fieldStates: BriefFieldStates;
  readonly validation: { readonly valid: boolean; readonly problems: readonly string[] };
  /**
   * Whether the user may start research now.
   *
   * Guided planning is a conversation, not a gate: below the floor the *agent*
   * may not stop asking, and the user may still confirm a valid draft.
   */
  readonly canConfirm: boolean;
  readonly guide: {
    readonly complete: boolean;
    readonly reason: string;
    /** The most decisions Guided Mode will ask for; the page never assumes one. */
    readonly limit: number;
    /** The floor: below this many real decisions, the agent may not stop. */
    readonly minDecisions: number;
    readonly maxDecisions: number;
    /** Decisions the user has really made: guided answers plus their own edits. */
    readonly readiness: number;
    readonly decisions: readonly GuideDecisionView[];
    readonly active: GuideQuestionView | null;
  };
  readonly matrix: { readonly subjects: number; readonly dimensions: number; readonly cells: number };
  readonly contentHash: string;
}

export interface AssessmentView {
  readonly assessmentId: string;
  readonly target: { readonly sectionId: string; readonly subjectId: string; readonly dimensionId: string };
  readonly evidenceIds: readonly string[];
  readonly relationship: "supports" | "contradicts" | "contextual";
  readonly directness: "direct" | "indirect" | "contextual" | "unassessed";
  readonly scope: string;
  readonly rationale: string;
  readonly assessor: "agent" | "user";
  readonly createdAt: string;
}

export interface ProposalView {
  readonly proposalId: string;
  readonly actionId: string;
  readonly status: "pending" | "accepted" | "discarded" | "stale" | "invalid";
  readonly baseReportId: string;
  readonly baseContentHash: string;
  readonly targets: readonly string[];
  readonly sections: readonly { readonly id: string; readonly title: string }[];
  readonly reason: string;
  readonly evidenceIds: readonly string[];
  readonly researchAdded: { readonly sources: number; readonly evidence: number; readonly assessments: number };
  readonly acceptedReportId: string | null;
  readonly createdAt: string;
  readonly decidedAt: string | null;
}

/** One proposal as the dock reads it, including the content it would install. */
export interface ProposalDetailView {
  readonly proposalId: string;
  readonly actionId: string;
  readonly taskId: string;
  readonly status: "pending" | "accepted" | "discarded" | "stale" | "invalid";
  readonly baseReportId: string;
  readonly baseContentHash: string;
  readonly targets: readonly { readonly targetType: "section" | "summary"; readonly targetId: string; readonly baseHash: string }[];
  readonly sections: readonly { readonly id: string; readonly title: string; readonly blocks: readonly ReportBlock[] }[];
  readonly claims: readonly {
    readonly id: string;
    readonly text: string;
    readonly kind: "fact" | "comparison" | "inference";
    readonly claimType?: string;
    readonly synthesis?: boolean;
    readonly evidenceIds: readonly string[];
  }[];
  readonly reason: string;
  readonly evidenceIds: readonly string[];
  readonly acceptedReportId: string | null;
  readonly createdAt: string;
  readonly decidedAt: string | null;
}

export interface RevisionView {
  readonly revisionId: string;
  readonly reportId: string;
  readonly revision: number;
  readonly contentHash: string;
  readonly themeId: string;
  readonly evidenceCount: number;
  readonly sourceCount: number;
  readonly gapsCaptured: boolean;
  readonly renderer: string;
  readonly createdAt: string;
  readonly isCurrentReport: boolean;
}

export interface ReportView {
  readonly reportId: string;
  readonly title: string;
  readonly summary: string;
  readonly createdAt: string;
  /** The question, audience and scope the report declares; null on old reports. */
  readonly frame: { readonly question: string; readonly audience: string; readonly scope: string } | null;
  readonly validation: {
    readonly ok: boolean;
    readonly problems: readonly string[];
    /** Obligations the report met softly, and the Q-series record behind them. */
    readonly warnings: readonly string[];
    readonly checks: readonly { readonly id: string; readonly result: string; readonly detail: string }[];
    readonly checkedAt: string;
  };
  readonly contentHash: string | null;
  readonly gapsCaptured: boolean;
  readonly isCurrent: boolean;
  readonly sections: readonly { readonly id: string; readonly title: string }[];
  readonly claims: readonly {
    readonly id: string;
    readonly text: string;
    readonly kind: "fact" | "comparison" | "inference";
    readonly claimType: string;
    readonly synthesis: boolean;
    readonly evidenceIds: readonly string[];
  }[];
}

export interface ExportView {
  readonly exportId: string;
  readonly reportId: string;
  readonly revisionId: string | null;
  readonly themeId: string | null;
  readonly status: "not_exported" | "exporting" | "exported" | "failed";
  readonly bytes: number;
  readonly failure: string | null;
  readonly createdAt: string;
  readonly isCurrentReport: boolean;
}

export interface TaskBundle {
  readonly task: {
    readonly id: string;
    readonly sessionId: string;
    readonly topic: string;
    readonly purpose: string;
    readonly audience: string;
    readonly focus: readonly string[];
    readonly exclusions: string;
    readonly lengthTarget: string;
    readonly status: "draft" | "confirmed" | "researching" | "ready" | "failed";
    readonly confirmed: boolean;
    readonly confirmedAt: string | null;
    readonly error: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly reportNeedsReview: {
      readonly at: string;
      readonly reason: string;
      readonly evidenceIds: readonly string[];
    } | null;
  };
  readonly structure: readonly { readonly id: string; readonly title: string; readonly question: string }[];
  readonly subjects: readonly { readonly id: string; readonly name: string; readonly note?: string }[];
  readonly dimensions: readonly { readonly id: string; readonly name: string; readonly question: string }[];
  readonly matrix: readonly CellView[];
  readonly gaps: readonly CellView[];
  readonly assessments: readonly AssessmentView[];
  readonly sources: readonly SourceView[];
  readonly evidence: readonly EvidenceView[];
  readonly reports: readonly ReportView[];
  readonly proposals: readonly ProposalView[];
  readonly revisions: readonly RevisionView[];
  readonly exports: readonly ExportView[];
  readonly runs: readonly RunView[];
  readonly budget: {
    readonly maxSearches: number;
    readonly maxCandidatesPerSearch: number;
    readonly maxReads: number;
    readonly maxGapRounds: number;
    readonly deadlineMs: number;
  };
  readonly usage: { readonly searches: number; readonly reads: number; readonly gapRounds: number; readonly startedAt?: string };
  readonly brief: BriefView;
  /**
   * What the user action now running may still spend, if one is running.
   *
   * A user action's own allowance, live from the application — not the
   * project's remaining research budget, which the agent's own passes draw on
   * and which has nothing to say about what the reader may still ask for.
   */
  readonly actionBudget: ActionBudgetView | null;
  readonly currentReportId: string | null;
  /** The current report's own content hash; null when there is no report. */
  readonly currentReportHash: string | null;
  /** Whether the current report already has a frozen revision. */
  readonly currentReportFrozen: boolean;
  readonly hasReport: boolean;
  /**
   * Where the project stands, as six separate answers.
   *
   * Each field carries its own `displayName` / `userMessage`: material
   * coverage, unresolved research, the report's review flag, its content
   * contract and the source roles are different facts, and the page must not
   * merge them into one word that is true of none of them.
   */
  readonly presentation: PresentationReadout;
  /**
   * The attempt the pipeline budget currently governs, if one has started.
   *
   * Separate from `usage`: `usage` is everything the project ever spent, while
   * an attempt is one bounded research pass — the thing a retry begins anew.
   */
  readonly attempt: {
    readonly number: number;
    readonly startedAt: string;
    readonly searches: number;
    readonly reads: number;
    readonly gapRounds: number;
    readonly reason: string;
  } | null;
  /** What discovery has tried, including the requests that failed. */
  readonly discovery: {
    readonly attemptedRequests: number;
    readonly successfulRequests: number;
    readonly failedRequests: number;
    readonly lastProvider: string | null;
    readonly lastElapsedMs: number | null;
    readonly lastFailure: {
      readonly at: string;
      readonly provider: string;
      readonly kind: string;
      readonly status: number | null;
      readonly userMessage: string;
    } | null;
  } | null;
  /** Where the research really is, and why it is waiting. No percentage. */
  readonly progress: ProgressView;
  /**
   * Where the *report* is, as one of the states a reader can act on.
   *
   * `validated` is the only value that means a report exists. Every other value
   * says what would move it forward, and a failure says it in the safe
   * vocabulary the model layer classified — never in a provider's own words.
   */
  readonly reportGeneration: ReportGenerationView;
  /**
   * How long the research and the report have taken, as two independent facts.
   *
   * The server decides both, because only it knows which runs belong to which
   * piece of work. A page computes nothing here: `state` is what says whether
   * the current time may be read at all (`running`), whether there is a real
   * pair of instants to subtract (`ended`), or whether the honest answer is that
   * the end is unknown (`unknown`) — a project interrupted by a restart, or one
   * whose end was never written.
   */
  readonly timing: TaskTiming;
  /** The reader-facing activity history, oldest first; stored, not in memory. */
  readonly activityLog: readonly ActivityEventView[];
  /**
   * The documents the user attached to this project, as a summary.
   *
   * A summary and not the library: the bundle is polled every two seconds and
   * the full view of a document carries its whole outline. What a document is
   * *for* is changed against the library's own revision, which is why the page
   * reads the full list before it edits one.
   */
  readonly documents: readonly TaskDocumentSummary[];
  /** The direction the user confirmed, once there is one. */
  readonly intent: TaskIntentSummary | null;
  readonly busy: boolean;
}

/** One line of a project's activity history, as the page reads it. */
export interface ActivityEventView {
  readonly id: string;
  readonly taskId: string;
  readonly at: string;
  readonly stage: string;
  readonly level: "info" | "warn" | "error";
  readonly kind: string;
  readonly message: string;
  readonly provider?: string;
  readonly attempt?: number;
  readonly nextRetryAt?: string | null;
}

/**
 * Where the report is, in the four states that used to be one sentence.
 *
 * A request that was accepted is not a report being written; a draft that was
 * written is not a report; only `validated` means a report exists and can be
 * opened. `canResume` is the recovery the page offers by default — it reuses
 * the material that is already there — and `blockedBy` says why it is not on
 * offer when it is not.
 */
export interface ReportGenerationView {
  readonly status: "idle" | "accepted" | "running" | "draft_saved" | "validated" | "failed";
  readonly displayName: string;
  readonly userMessage: string;
  readonly stage: "report" | "synthesis" | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly resumes: number;
  readonly repairs: number;
  readonly failure: {
    readonly category: string;
    readonly code: string;
    readonly problem: string;
    readonly guidance: string;
    /** Whether the model layer established that retrying could work. */
    readonly retryable: boolean;
  } | null;
  readonly draft: { readonly sections: number; readonly claims: number; readonly outstanding: number } | null;
  readonly canResume: boolean;
  readonly reportId: string | null;
  readonly blockedBy: "report_exists" | "brief_unconfirmed" | "busy" | null;
}

/** One piece of work's duration, as the server states it. */
export interface TimingEntryView {
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly state: "idle" | "running" | "ended" | "unknown";
}

export interface TaskTiming {
  readonly research: TimingEntryView;
  readonly report: TimingEntryView;
}

/** The research stages a reader watches, in the product's own words. */
export interface ProgressView {
  readonly currentStage: string;
  readonly displayName: string;
  readonly currentMessage: string;
  readonly completedStages: readonly string[];
  readonly lastActivityAt: string | null;
  readonly searchAttempts: number;
  readonly candidatesFound: number;
  readonly sourcesRead: number;
  readonly currentProvider: string | null;
  readonly retrying: boolean;
  readonly waitingUntil: string | null;
}

/* --------------------------------------------------------------- settings -- */

/** One capability, as the server can be held to it. */
/**
 * What was observed about a service, and when.
 *
 * `not_checked` carries no time: there is no observation to date. An
 * integration that is implemented, configured, or has answered a request is not
 * evidence for either of the other two.
 */
export interface HealthView {
  readonly status: "not_checked" | "reachable" | "unreachable";
  readonly checkedAt: string | null;
}

/** One provider of the retrieval catalogue, as the page reads it. */
export interface ProviderCatalogEntryView {
  readonly id: string;
  readonly name: string;
  readonly implemented: boolean;
  readonly configured: boolean;
  /** Whether the effective order contains it. */
  readonly enabled: boolean;
  /** Its 0-based place in that order, or null when it is not in it. */
  readonly orderIndex: number | null;
  readonly health: HealthView;
}

export interface CapabilityView {
  readonly id: string;
  readonly name: string;
  readonly implemented: boolean;
  readonly configured: boolean;
  readonly status: "integrated" | "reachable" | "unreachable" | "not_configured" | "not_checked" | "not_implemented";
  readonly detail: string;
  readonly checkedAt?: string | null;
  /**
   * Whether this capability is switched on, when it is the kind that can be.
   *
   * `null` for everything that is not a switch: a local upload path has no
   * enablement, and reporting `false` for it would read as "turned off".
   */
  readonly enabled: boolean | null;
  /** Where it sits in the order, when it has one. */
  readonly orderIndex: number | null;
  /** The observation behind `status`, when there is one. */
  readonly health: HealthView | null;
}

/** The product's own settings, with the provenance of every number in force. */
export interface SettingsBundle {
  readonly revision: number;
  readonly research: {
    readonly value: {
      readonly maxSearches: number;
      readonly maxCandidatesPerSearch: number;
      readonly maxReads: number;
      readonly maxGapRounds: number;
      readonly deadlineMs: number;
    };
    readonly source: "product-default" | "saved";
    readonly limits: Readonly<Record<string, { readonly min: number; readonly max: number }>>;
    readonly appliesTo: string;
    readonly note: string;
  };
  readonly retrieval: {
    /**
     * The whole catalogue, not the enabled subset.
     *
     * A page that is only told what is on cannot switch anything back on: the
     * control for the provider that was turned off is the one entry a
     * "currently enabled" list leaves out.
     */
    readonly providers: readonly ProviderCatalogEntryView[];
    /** The active order: which providers are asked, and in what order. */
    readonly order: readonly string[];
    readonly source: "product-default" | "saved";
    readonly fallback: boolean;
    readonly note: string;
  };
  readonly capabilities: readonly CapabilityView[];
  readonly mineru: {
    readonly implemented: boolean;
    readonly mode: "flash" | "token";
    readonly tokenConfigured: boolean;
    readonly tokenEditable: boolean;
    readonly command: string | null;
    readonly package: string | null;
    readonly limits: {
      readonly maxUploadBytes: number;
      readonly maxUploadMiB: number;
      readonly flashMaxPages: number;
      readonly formats: readonly string[];
    };
    readonly note: string;
    readonly readinessCheckedAt: string | null;
    readonly thirdParty: string;
  };
  readonly model: {
    readonly provider: string | null;
    readonly model: string | null;
    readonly source: string;
    readonly editable: boolean;
    readonly note: string;
  };
}

/** What a settings save may change. Absent fields keep what is stored. */
export interface SettingsPatch {
  readonly expectedRevision?: number;
  readonly research?: Partial<{
    readonly maxSearches: number;
    readonly maxCandidatesPerSearch: number;
    readonly maxReads: number;
    readonly maxGapRounds: number;
    readonly deadlineMs: number;
  }>;
  readonly providers?: readonly string[];
}

/* ------------------------------------------------------------- readout -- */

export interface PresentationReadout {
  readonly runState: { readonly state: string; readonly displayName: string; readonly userMessage: string };
  readonly evidenceCoverage: {
    readonly cells: number;
    readonly withMaterial: number;
    readonly reviewed: number;
    readonly displayName: string;
    readonly userMessage: string;
  };
  readonly unresolvedResearch: {
    readonly unresolved: number;
    readonly limited: number;
    readonly incomparable: number;
    readonly resolved: number;
    readonly displayName: string;
    readonly userMessage: string;
  };
  readonly reportReview: { readonly state: "clean" | "needs_review"; readonly reason: string | null; readonly displayName: string; readonly userMessage: string };
  readonly artifactQuality: {
    readonly state: "passed" | "warnings" | "blocking" | "unknown";
    readonly warnings: number;
    readonly blocking: number;
    readonly displayName: string;
    readonly userMessage: string;
  };
  readonly sourceRoles: {
    readonly total: number;
    readonly classified: number;
    readonly unknown: number;
    readonly primary: number;
    readonly byRole: Readonly<Record<string, number>>;
    readonly displayName: string;
    readonly userMessage: string;
  };
}

export type SessionState =
  | { readonly kind: "pending"; readonly sessionId: string; readonly busy: boolean }
  | { readonly kind: "task"; readonly sessionId: string; readonly bundle: TaskBundle };

export interface TaskSummary {
  readonly id: string;
  readonly sessionId: string;
  readonly topic: string;
  readonly status: string;
  readonly subjects: readonly string[];
  readonly updatedAt: string;
  readonly hasReport: boolean;
}

/* ------------------------------------------------------- intent discovery -- */

export type IntentStatus = "exploring" | "ready_to_confirm" | "confirmed";

export interface IntentTurnView {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly at: string;
  readonly text: string;
  /** Assistant turns: why this question is worth answering. */
  readonly why?: string;
  /** Assistant turns: ready-made answers to pick instead of typing. */
  readonly options?: readonly string[];
  /** Assistant turns that carry a direction proposal. */
  readonly proposesDirection?: boolean;
  /** User turns: the documents attached when the message was sent. */
  readonly documentIds?: readonly string[];
}

/** Something the assistant understood, which the user may correct. */
export interface IntentDecisionView {
  readonly id: string;
  readonly field: BriefFieldName | null;
  readonly value: string;
  readonly basedOn: string;
  readonly at: string;
}

/**
 * A proposed research direction — the thing the user confirms.
 *
 * `topic` / `purpose` / `scope` are the direction; the rest is a suggestion the
 * user may keep, edit or ignore. It is a proposal until `/confirm` runs, and
 * `source` says who wrote this version.
 */
export interface ResearchDirectionView {
  readonly topic: string;
  readonly purpose: string;
  readonly scope: string;
  readonly audience: string;
  readonly focus: readonly string[];
  readonly exclusions: string;
  readonly lengthTarget: string;
  readonly subjects: readonly { readonly name: string; readonly note?: string }[];
  readonly dimensions: readonly { readonly name: string; readonly question: string }[];
  readonly summary: string;
  readonly at: string;
  readonly source: "agent" | "user";
}

/**
 * The user's own edit of a direction.
 *
 * Every field is optional: the page sends what the reader changed and the
 * server keeps the rest. `at` and `source` are the server's to write, which is
 * why they are not here.
 */
export interface DirectionPatch {
  readonly topic?: string;
  readonly purpose?: string;
  readonly scope?: string;
  readonly audience?: string;
  readonly focus?: readonly string[];
  readonly exclusions?: string;
  readonly lengthTarget?: string;
  readonly subjects?: readonly { readonly name: string; readonly note?: string }[];
  readonly dimensions?: readonly { readonly name: string; readonly question: string }[];
  readonly summary?: string;
}

export interface IntentView {
  readonly intentId: string;
  readonly sessionId: string;
  readonly seedTopic: string;
  readonly status: IntentStatus;
  readonly statusLabel: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** The task this exploration produced, once the card exists. */
  readonly taskId: string | null;
  readonly turns: readonly IntentTurnView[];
  readonly decisions: readonly IntentDecisionView[];
  readonly proposal: ResearchDirectionView | null;
  readonly proposalSummary: string | null;
  readonly confirmedDirection: ResearchDirectionView | null;
  readonly confirmedAt: string | null;
  readonly documents: readonly LibraryDocumentView[];
  readonly pending: {
    readonly turnId: string;
    readonly text: string;
    readonly why: string;
    readonly options: readonly string[];
    readonly proposesDirection: boolean;
  } | null;
  readonly canConfirm: boolean;
  readonly confirmQuestion: string;
  readonly openFields: readonly BriefFieldName[];
  readonly userMessages: readonly string[];
  readonly assistantQuestions: readonly string[];
}

/* ------------------------------------------------------------- documents -- */

export type DocumentUsage = "intent_context" | "research_source";

export type ConversionTrust = "client_claimed" | "server_verified";

/** Where one page of the original file starts in the converted Markdown. */
export interface DocumentPageSpan {
  readonly page: number;
  readonly charStart: number;
  readonly charEnd: number;
}

export interface LibraryConversion {
  readonly provider: string;
  readonly version: string | null;
  readonly originalFilename: string;
  readonly originalFormat: string;
  readonly status: "succeeded" | "partial";
  readonly convertedAt: string | null;
  readonly pageMap: readonly DocumentPageSpan[];
  readonly sourceRef: string | null;
  readonly trust: ConversionTrust;
}

export interface DocumentOutlineHeading {
  readonly level: number;
  readonly text: string;
  readonly charStart: number;
  readonly charEnd: number;
  readonly titleStart: number;
  readonly titleEnd: number;
}

/**
 * One document in the library, as the workspace reads it.
 *
 * There is no full text here: the Markdown is fetched by its own route when a
 * reader asks for it, and every excerpt they are shown is quoted from the copy
 * the server holds. `usage` is what the document is for, `revision` is what a
 * write has to name, and `linkedSourceId` is the source it became once the user
 * marked it research material.
 */
export interface LibraryDocumentView {
  readonly documentId: string;
  readonly sessionId: string;
  readonly taskId: string | null;
  readonly originalFilename: string;
  readonly title: string;
  readonly sizeBytes: number;
  readonly contentHash: string;
  readonly createdAt: string;
  readonly origin: "direct_upload" | "converted";
  readonly conversionProvider: string | null;
  readonly conversion: LibraryConversion | null;
  readonly status: "ready" | "failed";
  readonly usage: readonly DocumentUsage[];
  readonly outline: readonly DocumentOutlineHeading[];
  readonly outlineTotal: number;
  readonly outlineTruncated: boolean;
  readonly revision: number;
  readonly note: string;
  readonly failure: string | null;
  readonly linkedSourceId: string | null;
  readonly chars: number;
  readonly paragraphs: number;
  readonly truncated: boolean;
}

/** One document as the project bundle summarizes it. */
export interface TaskDocumentSummary {
  readonly documentId: string;
  readonly filename: string;
  readonly title: string;
  readonly sizeBytes: number;
  readonly origin: "direct_upload" | "converted";
  readonly conversionProvider: string | null;
  readonly conversionTrust: ConversionTrust | null;
  readonly usage: readonly DocumentUsage[];
  readonly status: "ready" | "failed";
  readonly linkedSourceId: string | null;
  readonly chars: number;
  readonly outline: readonly string[];
  readonly outlineTotal: number;
  readonly createdAt: string;
}

/** Where a project's direction came from, once the user confirmed one. */
export interface TaskIntentSummary {
  readonly intentId: string;
  readonly seedTopic: string;
  readonly confirmedAt: string;
  readonly direction: ResearchDirectionView;
  readonly status: IntentStatus | null;
}

/** Which exploration or project a document request is about. */
export type DocumentScope =
  | { readonly intentId: string }
  | { readonly taskId: string }
  | { readonly sessionId: string };

export const DOCUMENT_USAGE_LABELS: Readonly<Record<DocumentUsage, string>> = Object.freeze({
  intent_context: "澄清方向时参考",
  research_source: "研究来源",
});

export const DOCUMENT_STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  ready: "已入库",
  failed: "入库失败",
});

export const DOCUMENT_ORIGIN_LABELS: Readonly<Record<string, string>> = Object.freeze({
  direct_upload: "直接上传",
  converted: "转换入库",
});

/** What a conversion record is worth, in the workspace's own words. */
export const CONVERSION_TRUST_LABELS: Readonly<Record<ConversionTrust, string>> = Object.freeze({
  client_claimed: "调用方自报（未经服务端核验）",
  server_verified: "服务端已执行转换",
});

/* ----------------------------------------------------------- conversions -- */

export type ConversionJobStatus = "queued" | "converting" | "importing" | "succeeded" | "failed";

export const CONVERSION_STATUS_LABELS: Readonly<Record<ConversionJobStatus, string>> = Object.freeze({
  queued: "排队中",
  converting: "解析中",
  importing: "入库中",
  succeeded: "转换完成",
  failed: "转换失败",
});

/** The one consent value that lets a file leave this machine. */
export const THIRD_PARTY_UPLOAD_CONSENT = "third_party_upload";

export interface ConversionFailureView {
  readonly code: string;
  readonly problem: string;
  readonly guidance: string;
}

/** One conversion job, exactly as the server publishes it. */
export interface ConversionJobView {
  readonly jobId: string;
  readonly status: ConversionJobStatus;
  readonly filename: string;
  readonly format: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly usage: readonly DocumentUsage[];
  readonly sessionId: string;
  readonly taskId: string | null;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly retryable: boolean;
  readonly document: { readonly documentId: string; readonly filename: string; readonly duplicate: boolean } | null;
  readonly conversion: {
    readonly provider: string;
    readonly version: string | null;
    readonly status: string;
    readonly convertedAt: string;
    readonly sourceRef: string;
    readonly pageMap: null;
    readonly trust: "server_verified";
  } | null;
  readonly toolCall: {
    readonly tool: string;
    readonly durationMs: number;
    readonly status: "success" | "partial_success" | "error" | "unknown";
    readonly contentChars: number | null;
    readonly inlineTruncated: boolean;
    readonly fromFile: boolean;
  } | null;
  readonly failure: ConversionFailureView | null;
  readonly note: string;
  readonly limits: {
    readonly maxBytes: number;
    readonly maxPages: number;
    readonly mode: "flash" | "token";
    readonly transports: readonly string[];
  };
}

/** What the server says about the converter, without repeating its self-report. */
export interface MineruReadinessView {
  readonly ok: boolean;
  readonly mineru: {
    readonly transport: string;
    readonly command: string;
    readonly package: string;
    readonly mode: string;
    readonly parseDocuments: boolean;
    readonly durationMs: number;
  };
  readonly limits: {
    readonly maxBytes: number;
    readonly maxPages: number;
    readonly formats: readonly string[];
    readonly online: boolean;
    readonly dataHandling: string;
  };
  readonly problem: string | null;
}

/** One Ask action's answer, read back from the session's committed history. */
export interface AnswerView {
  readonly runId: string;
  readonly question: string;
  readonly status: string;
  readonly text: string | null;
}

export interface RuntimeView {
  readonly model: { readonly provider: string; readonly model: string } | null;
  readonly pdfRenderer: string | null;
  readonly budget: {
    readonly maxSearches: number;
    readonly maxCandidatesPerSearch: number;
    readonly maxReads: number;
    readonly maxGapRounds: number;
    readonly deadlineMs: number;
  };
  /**
   * What one explicit Research action is allowed to spend.
   *
   * The project budget above is the agent's own; this is the allowance a
   * reader's instruction gets, and each instruction gets a fresh one. It is
   * published here so the composer can say what the next 补查 may cost before
   * anything is spent, without the page keeping its own copy of the number.
   */
  readonly actionAllowance: { readonly searches: number; readonly reads: number };
  readonly dataDir: string;
  readonly busy: boolean;
}

/* ---------------------------------------------------- the report document -- */

export type ReportBlock =
  | { readonly kind: "paragraph"; readonly text: string; readonly claimIds: readonly string[] }
  | { readonly kind: "list"; readonly items: readonly { readonly text: string; readonly claimIds: readonly string[] }[] }
  | {
      readonly kind: "table";
      readonly columns: readonly string[];
      readonly rows: readonly { readonly cells: readonly { readonly text: string; readonly claimIds: readonly string[] }[] }[];
      readonly columnDimensions?: readonly (string | null)[];
      readonly rowSubjects?: readonly (string | null)[];
    }
  | {
      readonly kind: "callout";
      readonly tone: "gap" | "note";
      readonly text: string;
      readonly dimensionIds?: readonly string[];
    }
  | {
      readonly kind: "mechanism";
      readonly title?: string;
      readonly input: string;
      readonly intermediate: string;
      readonly steps: readonly { readonly text: string; readonly claimIds: readonly string[] }[];
      readonly output: string;
      readonly tradeoff: string;
      readonly failure: string;
      readonly claimIds: readonly string[];
    };

export interface DocumentClaim {
  readonly id: string;
  readonly text: string;
  readonly kind: "fact" | "comparison" | "inference";
  readonly claimType: string;
  readonly synthesis: boolean;
  readonly evidenceIds: readonly string[];
  readonly subjects: readonly { readonly id: string; readonly name: string }[];
  readonly dimensions: readonly { readonly id: string; readonly name: string }[];
  readonly conditions: {
    readonly scope?: string;
    readonly task?: string;
    readonly dataset?: string;
    readonly metric?: string;
    readonly baseline?: string;
    readonly setting?: string;
    readonly costStage?: string;
    readonly basis?: string;
    readonly comparability?: string;
  } | null;
  readonly adequacy: { readonly state: string; readonly reasons: readonly string[] };
}

export interface CitationReference {
  readonly number: number;
  readonly sourceId: string;
  readonly title: string;
  readonly authors: readonly string[];
  readonly venue: string;
  readonly publishedAt: string | null;
  readonly url: string;
  readonly doi: string | null;
  readonly readScope: string | null;
}

export interface EvidenceIndexEntry {
  readonly number: number;
  readonly evidenceId: string;
  readonly sourceId: string;
  readonly excerpt: string;
  readonly scope: string;
  readonly headingPath: readonly string[];
  readonly paragraphIndex: number;
}

export interface DocumentView {
  readonly reportId: string;
  /** The frozen revision number when this document is a revision, else null. */
  readonly revision: number | null;
  readonly themeId: string | null;
  readonly contentHash: string | null;
  readonly title: string;
  readonly summary: string;
  readonly frame: { readonly question: string; readonly audience: string; readonly scope: string } | null;
  readonly sections: readonly { readonly id: string; readonly title: string; readonly blocks: readonly ReportBlock[] }[];
  readonly claims: readonly DocumentClaim[];
  readonly citations: {
    readonly references: readonly CitationReference[];
    readonly evidenceIndex: readonly EvidenceIndexEntry[];
    readonly numbersByClaim: Readonly<Record<string, readonly number[]>>;
  };
  readonly validation: {
    readonly ok: boolean;
    readonly problems: readonly string[];
    readonly warnings: readonly string[];
    readonly checks: readonly { readonly id: string; readonly requirement?: string; readonly result: string; readonly detail: string }[];
    readonly checkedAt: string;
  } | null;
}

/**
 * A refusal, with what the application said about it.
 *
 * A stale brief or an incomplete draft is answered with more than a sentence —
 * which fields are wrong, and what the brief looks like now — and a page that
 * only saw `error.message` would have to guess where to put the objection. The
 * message is still exactly the route's own sentence, so a caller that only
 * wants to show something is unaffected.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;

  constructor(message: string, status: number, body: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }

  /** The problems the route listed, one per thing that has to be fixed. */
  get problems(): readonly string[] {
    const listed = this.body["problems"];
    if (Array.isArray(listed)) return listed.filter((item): item is string => typeof item === "string");
    return this.message.length === 0 ? [] : [this.message];
  }

  /** Whether the refusal was about this page's version being out of date. */
  get stale(): boolean {
    return this.body["stale"] === true;
  }

  /** The brief the refusal was taken against, when the route sent it. */
  get brief(): BriefView | undefined {
    const brief = this.body["brief"];
    return typeof brief === "object" && brief !== null ? (brief as BriefView) : undefined;
  }

  /** The machine-readable name of the refusal, when the route has one. */
  get code(): string | undefined {
    const code = this.body["code"];
    return typeof code === "string" ? code : undefined;
  }

  /**
   * The route's own reason, when it has one finer than the status.
   *
   * `run_in_progress` is the case that matters: three different conflicts share
   * HTTP 409 — a turn already running, a stale version, a document whose
   * revision moved — and a page that only saw the number would have to guess
   * which one it is and what to do about it.
   */
  get reason(): string | undefined {
    const reason = this.body["reason"];
    return typeof reason === "string" ? reason : undefined;
  }

  /** What the route says to do next. */
  get guidance(): string | undefined {
    const guidance = this.body["guidance"];
    return typeof guidance === "string" ? guidance : undefined;
  }

  /** Whether the refusal was about a document whose revision moved on. */
  get conflict(): boolean {
    return this.body["conflict"] === true;
  }

  /** The exploration the refusal was taken against, when the route sent it. */
  get intent(): IntentView | undefined {
    const intent = this.body["intent"];
    return typeof intent === "object" && intent !== null ? (intent as IntentView) : undefined;
  }
}

/**
 * One request, over the fetch the page already has.
 *
 * The body is passed through as the caller wrote it: a Markdown file sent as
 * raw bytes and the same file in a JSON envelope are two encodings of one
 * library entry, and a client that re-encoded a file to send it would be
 * deciding the file's bytes for it. So the default content type is applied only
 * when a body is being sent and the caller named none — a GET carries no
 * `content-type` at all, and a conversion sends `application/octet-stream` with
 * the bytes exactly as they were read.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has("content-type") && init?.body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(path, { ...init, headers });
  const text = await response.text();
  const value = text.length === 0 ? {} : (JSON.parse(text) as unknown);
  if (!response.ok) {
    const body = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
    const message = typeof body["error"] === "string" ? body["error"] : `HTTP ${String(response.status)}`;
    throw new ApiError(message, response.status, body);
  }
  return value as T;
}

/** The scope a document request names, as query parameters. */
function scopeQuery(scope: DocumentScope): Record<string, string> {
  if ("intentId" in scope) return { intentId: scope.intentId };
  if ("taskId" in scope) return { taskId: scope.taskId };
  return { sessionId: scope.sessionId };
}

/** What a document upload answers with, whichever scope it was sent under. */
export interface DocumentUploadResult {
  readonly ok: boolean;
  readonly document: LibraryDocumentView;
  /** Whether the library already held these exact bytes under this session. */
  readonly duplicate: boolean;
  readonly sessionId: string;
  readonly taskId: string | null;
  readonly limits: { readonly maxBytes: number; readonly maxPerSession: number };
  readonly note: string;
}

export const api = {
  runtime: (): Promise<RuntimeView> => request("/api/research/runtime"),
  settings: (): Promise<SettingsBundle> => request("/api/research/settings"),
  updateSettings: (patch: SettingsPatch): Promise<SettingsBundle> =>
    request("/api/research/settings", { method: "PATCH", body: JSON.stringify(patch) }),
  listTasks: (options?: { readonly signal?: AbortSignal }): Promise<{ readonly tasks: readonly TaskSummary[] }> =>
    request("/api/research/tasks", options),
  startTask: (topic: string): Promise<{ readonly sessionId: string }> =>
    request("/api/research/tasks", { method: "POST", body: JSON.stringify({ topic }) }),
  sessionState: (sessionId: string): Promise<{ readonly pending: boolean; readonly task: TaskBundle | null }> =>
    request(`/api/research/sessions/${encodeURIComponent(sessionId)}`),
  task: (taskId: string, options?: { readonly signal?: AbortSignal }): Promise<TaskBundle> =>
    request(`/api/research/tasks/${encodeURIComponent(taskId)}`, options),

  /* ----------------------------------------------------------- intents -- */

  /**
   * Starts an exploration: a topic, and whatever Markdown the user attached.
   *
   * The reply is a receipt, not a result — the first turn runs on the server
   * after this returns — so what the page keeps is the ids, and what it shows
   * is read back from `intent`.
   */
  createIntent: (
    body: {
      readonly seedTopic: string;
      readonly documents?: readonly { readonly filename: string; readonly contentBase64: string }[];
    },
  ): Promise<{
    readonly ok: boolean;
    readonly created: boolean;
    readonly intentId: string;
    readonly sessionId: string;
    readonly status: IntentStatus;
    readonly documents: readonly LibraryDocumentView[];
    readonly note: string;
  }> => request("/api/research/intents", { method: "POST", body: JSON.stringify(body) }),
  intent: (
    intentId: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<{ readonly intent: IntentView; readonly busy: boolean }> =>
    request(`/api/research/intents/${encodeURIComponent(intentId)}`, options),
  sessionIntent: (
    sessionId: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<{ readonly intent: IntentView | null; readonly busy: boolean }> =>
    request(`/api/research/sessions/${encodeURIComponent(sessionId)}/intent`, options),
  sendIntentMessage: (
    intentId: string,
    body: {
      readonly text: string;
      readonly documentIds?: readonly string[];
      readonly expectedVersion?: number;
    },
  ): Promise<{ readonly ok: boolean; readonly intent: IntentView; readonly started: boolean; readonly note: string }> =>
    request(`/api/research/intents/${encodeURIComponent(intentId)}/messages`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /**
   * The user's own edit of the direction on the table.
   *
   * The envelope is `{expectedVersion, direction}` and the body is that flat
   * object — the route reads `body.direction` and falls back to the body, so a
   * page that wrapped its edit in another key would send nothing.
   */
  saveIntentDirection: (
    intentId: string,
    body: { readonly expectedVersion: number; readonly direction: DirectionPatch },
  ): Promise<{
    readonly ok: boolean;
    readonly intent: IntentView;
    readonly direction: ResearchDirectionView;
    readonly note: string;
  }> =>
    request(`/api/research/intents/${encodeURIComponent(intentId)}/direction`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /**
   * The user's confirmation — the only way a direction becomes official.
   *
   * HTTP 202 means the card stage was queued, not that a project exists: the
   * reply's `taskId` is null on the normal path, and the page waits for the
   * task to appear rather than navigating to an id it does not have.
   */
  confirmIntent: (
    intentId: string,
    body: { readonly expectedVersion: number; readonly direction?: DirectionPatch },
  ): Promise<{
    readonly ok: boolean;
    readonly intentId: string;
    readonly sessionId: string;
    readonly direction: ResearchDirectionView;
    readonly openFields: readonly BriefFieldName[];
    readonly taskId: string | null;
    readonly started: string;
    readonly confirmQuestion: string;
    readonly note: string;
  }> =>
    request(`/api/research/intents/${encodeURIComponent(intentId)}/confirm`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  /* --------------------------------------------------------- library -- */

  documents: (scope: DocumentScope, options?: { readonly signal?: AbortSignal }): Promise<{ readonly documents: readonly LibraryDocumentView[] }> =>
    request(`/api/research/documents?${new URLSearchParams(scopeQuery(scope)).toString()}`, options),
  uploadDocument: (
    body: {
      readonly filename: string;
      readonly contentBase64: string;
      readonly usage: readonly DocumentUsage[];
      readonly scope: DocumentScope;
    },
  ): Promise<DocumentUploadResult> =>
    request("/api/research/documents", {
      method: "POST",
      body: JSON.stringify({
        ...scopeQuery(body.scope),
        filename: body.filename,
        contentBase64: body.contentBase64,
        usage: body.usage,
      }),
    }),
  /**
   * What one document is for, against the revision the page read.
   *
   * The scope travels in the body as well as the query string: the route
   * collects every place the request named a project and refuses a request that
   * names two, so a page that has a session id must say so rather than leaving
   * the server to infer the caller from the document.
   */
  setDocumentUsage: (
    documentId: string,
    body: { readonly usage: readonly DocumentUsage[]; readonly expectedRevision: number; readonly scope: DocumentScope },
  ): Promise<{ readonly ok: boolean; readonly document: LibraryDocumentView; readonly note: string }> =>
    request(`/api/research/documents/${encodeURIComponent(documentId)}`, {
      method: "PATCH",
      body: JSON.stringify({ ...scopeQuery(body.scope), usage: body.usage, expectedRevision: body.expectedRevision }),
    }),
  promoteDocumentToSource: (
    documentId: string,
    body: { readonly taskId: string; readonly scope: DocumentScope },
  ): Promise<{
    readonly ok: boolean;
    readonly created: boolean;
    readonly source: { readonly sourceId: string; readonly title: string; readonly role: string | null; readonly url: string; readonly readStatus: string };
    readonly note: string;
  }> =>
    request(`/api/research/documents/${encodeURIComponent(documentId)}/source`, {
      method: "POST",
      body: JSON.stringify({ ...scopeQuery(body.scope), taskId: body.taskId }),
    }),
  linkDocumentToTask: (
    documentId: string,
    body: { readonly taskId: string; readonly scope: DocumentScope },
  ): Promise<{ readonly ok: boolean; readonly document: LibraryDocumentView; readonly taskId: string; readonly note: string }> =>
    request(`/api/research/documents/${encodeURIComponent(documentId)}/link`, {
      method: "POST",
      body: JSON.stringify({ ...scopeQuery(body.scope), taskId: body.taskId }),
    }),

  /* ----------------------------------------------------- conversions -- */

  /**
   * Sends one PDF or DOCX to be converted, as bytes.
   *
   * `consent` is the user's own: the route refuses the job without it, and the
   * page only sends this call after an unchecked-by-default box was ticked for
   * this file. The body is the file itself, so the filename, the usage and the
   * consent travel in the query string.
   */
  submitConversion: (
    input: {
      readonly scope: DocumentScope;
      readonly filename: string;
      readonly usage: readonly DocumentUsage[];
      readonly bytes: ArrayBuffer;
      readonly consent: typeof THIRD_PARTY_UPLOAD_CONSENT;
    },
  ): Promise<{ readonly ok: boolean; readonly job: ConversionJobView; readonly note: string }> =>
    request(
      `/api/research/documents/convert?${new URLSearchParams({
        ...scopeQuery(input.scope),
        filename: input.filename,
        usage: input.usage.join(","),
        consent: input.consent,
      }).toString()}`,
      {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: input.bytes,
      },
    ),
  conversionJob: (
    jobId: string,
    sessionId: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<{ readonly ok: boolean; readonly job: ConversionJobView }> =>
    request(
      `/api/research/documents/convert/${encodeURIComponent(jobId)}?${new URLSearchParams({ sessionId }).toString()}`,
      options,
    ),
  retryConversion: (
    jobId: string,
    sessionId: string,
  ): Promise<{ readonly ok: boolean; readonly job: ConversionJobView; readonly note: string }> =>
    request(`/api/research/documents/convert/${encodeURIComponent(jobId)}/retry`, {
      method: "POST",
      body: JSON.stringify({ sessionId }),
    }),
  mineru: (options?: { readonly signal?: AbortSignal }): Promise<MineruReadinessView> =>
    request("/api/research/mineru", options),
  /**
   * Starts a new bounded research attempt on a project that stopped.
   *
   * The project keeps its brief, its material, its report and its frozen
   * revisions; what the route does is clear the failure that was blocking it
   * and begin again. A project that is running, unconfirmed, or not stopped
   * is refused with the reason.
   */
  retryResearch: (
    taskId: string,
  ): Promise<{
    readonly ok: boolean;
    readonly started: string;
    readonly attempt: TaskBundle["attempt"];
    readonly preserved: {
      readonly sources: number;
      readonly evidence: number;
      readonly assessments: number;
      readonly reports: number;
      readonly revisions: number;
      readonly reportKept: boolean;
    };
    readonly message: string;
  }> => request(`/api/research/tasks/${encodeURIComponent(taskId)}/retry-research`, { method: "POST", body: "{}" }),
  answers: (taskId: string, options?: { readonly signal?: AbortSignal }): Promise<{ readonly answers: readonly AnswerView[] }> =>
    request(`/api/research/tasks/${encodeURIComponent(taskId)}/answers`, options),
  document: (reportId: string, options?: { readonly signal?: AbortSignal }): Promise<DocumentView> =>
    request(`/api/research/reports/${encodeURIComponent(reportId)}/document`, options),
  revisionDocument: (revisionId: string): Promise<DocumentView> =>
    request(`/api/research/revisions/${encodeURIComponent(revisionId)}/document`),
  confirm: (taskId: string, body: { readonly expectedVersion?: number } = {}): Promise<unknown> =>
    request(`/api/research/tasks/${encodeURIComponent(taskId)}/confirm`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  brief: (taskId: string): Promise<{ readonly brief: BriefView }> =>
    request(`/api/research/tasks/${encodeURIComponent(taskId)}/brief`),
  patchBrief: (
    taskId: string,
    body: { readonly expectedVersion?: number; readonly patch: BriefPatch },
  ): Promise<{ readonly ok: boolean; readonly brief: BriefView; readonly changedFields: readonly BriefFieldName[] }> =>
    request(`/api/research/tasks/${encodeURIComponent(taskId)}/brief`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  guideNext: (
    taskId: string,
  ): Promise<{
    readonly ok: boolean;
    readonly complete: boolean;
    readonly started: boolean;
    readonly reason?: string;
    readonly target?: BriefFieldName;
    readonly question?: GuideQuestionView;
  }> =>
    request(`/api/research/tasks/${encodeURIComponent(taskId)}/brief/guide/next`, { method: "POST", body: "{}" }),
  guideAnswer: (
    taskId: string,
    body: { readonly questionId: string; readonly expectedVersion?: number; readonly optionIds?: readonly string[]; readonly freeText?: string },
  ): Promise<{
    readonly ok: boolean;
    readonly brief: BriefView;
    readonly appliedFields: readonly BriefFieldName[];
    readonly complete: boolean;
    readonly nextQuestion: "pending" | "none";
  }> =>
    request(`/api/research/tasks/${encodeURIComponent(taskId)}/brief/guide/answer`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  gap: (taskId: string): Promise<unknown> =>
    request(`/api/research/tasks/${encodeURIComponent(taskId)}/gap`, { method: "POST", body: "{}" }),
  report: (taskId: string): Promise<unknown> =>
    request(`/api/research/tasks/${encodeURIComponent(taskId)}/report`, { method: "POST", body: "{}" }),
  assistant: (
    taskId: string,
    body: { readonly text: string; readonly intent?: string; readonly targetSectionId?: string | null },
  ): Promise<{
    readonly ok: boolean;
    readonly started: string;
    readonly scope: string;
    /** The allowance of *this* instruction, for a Research action. */
    readonly actionBudget?: ActionBudgetView;
  }> =>
    request(`/api/research/tasks/${encodeURIComponent(taskId)}/assistant`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  exportPdf: (taskId: string): Promise<{ readonly ok: boolean; readonly failure: string; readonly exportId?: string }> =>
    request(`/api/research/tasks/${encodeURIComponent(taskId)}/export`, { method: "POST", body: "{}" }),
  freeze: (
    taskId: string,
    body: { readonly themeId?: string; readonly expectedContentHash?: string } = {},
  ): Promise<{ readonly ok: boolean; readonly existing: boolean; readonly revision: { readonly revisionId: string; readonly revision: number } }> =>
    request(`/api/research/tasks/${encodeURIComponent(taskId)}/revisions`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  acceptProposal: (
    proposalId: string,
    body: { readonly expectedBaseContentHash?: string } = {},
  ): Promise<{ readonly ok: boolean; readonly alreadyApplied: boolean; readonly reportId: string }> =>
    request(`/api/research/proposals/${encodeURIComponent(proposalId)}/accept`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  discardProposal: (proposalId: string): Promise<{ readonly ok: boolean }> =>
    request(`/api/research/proposals/${encodeURIComponent(proposalId)}/discard`, { method: "POST", body: "{}" }),
  exportRevision: (revisionId: string): Promise<{ readonly ok: boolean; readonly exportId?: string; readonly failure: string }> =>
    request(`/api/research/revisions/${encodeURIComponent(revisionId)}/export`, { method: "POST", body: "{}" }),
  assess: (
    taskId: string,
    body: {
      readonly cell: { readonly sectionId: string; readonly subjectId: string; readonly dimensionId: string };
      readonly evidenceIds: readonly string[];
      readonly relationship: string;
      readonly directness: string;
      readonly rationale: string;
    },
  ): Promise<{ readonly ok: boolean; readonly assessmentId: string }> =>
    request(`/api/research/tasks/${encodeURIComponent(taskId)}/assessments`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  proposal: (proposalId: string): Promise<{ readonly proposal: ProposalDetailView }> =>
    request(`/api/research/proposals/${encodeURIComponent(proposalId)}`),
  reportHtmlUrl: (reportId: string): string => `/api/research/reports/${encodeURIComponent(reportId)}/html`,
  revisionHtmlUrl: (revisionId: string): string => `/api/research/revisions/${encodeURIComponent(revisionId)}/html`,
  exportFileUrl: (exportId: string): string => `/api/research/exports/${encodeURIComponent(exportId)}/file`,
};

export const SCOPE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  metadata: "仅元数据",
  abstract: "仅摘要",
  body_excerpt: "正文节选",
  full_text: "完整正文",
});

export const STATUS_MARKS: Readonly<Record<string, string>> = Object.freeze({
  reviewed: "●",
  limited: "◐",
  unassessed: "◑",
  conflict: "◆",
  missing: "○",
});

/** What each support state means, in the words the workspace shows. */
export const STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  reviewed: "已核对",
  limited: "支持有限",
  unassessed: "有材料，待核对",
  conflict: "证据冲突",
  missing: "缺少依据",
});

/**
 * What an unwritten comparison cell says instead of nothing.
 *
 * A cell the report never filled in is not blank: the project knows something
 * about that pair, and if it knows nothing,「证据不足」is the honest word for
 * it. A blank cell reads as "nothing to say", which is a conclusion nobody
 * drew. `reviewed` is the case where material exists but the report has not
 * written the judgement yet, and it says exactly that.
 */
export const CELL_FALLBACK_LABELS: Readonly<Record<string, string>> = Object.freeze({
  reviewed: "尚未写出判断",
  limited: "支持有限",
  unassessed: "有材料，待核对",
  conflict: "不可直接比较",
  missing: "证据不足",
});

/** The fallback for a cell whose pair the project has no coverage row for. */
export const CELL_UNKNOWN_LABEL = "尚未写出判断";

/**
 * Whether one research action answered the question it was given.
 *
 * The three words are the whole of the answer a reader needs from a 补查, and
 * they are not a score: `unresolved` means the question is still open, not that
 * the search failed.
 */
export const RESOLUTION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  resolved: "已解决",
  partially_resolved: "部分解决",
  unresolved: "未解决",
});

/**
 * What became of a modification proposal, in the words of the decision.
 *
 * `stale` and `invalid` are the two the reader cannot act on any more, and they
 * say what to do instead of naming the state they are in.
 */
export const PROPOSAL_STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  pending: "待确认",
  accepted: "已接受",
  discarded: "已放弃",
  stale: "需要重新生成",
  invalid: "未生成修改建议",
});

export const STAGE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  card: "任务卡",
  guide: "引导问题",
  research: "检索与读取",
  gap: "定向补查",
  report: "撰写章节",
  synthesis: "综合与校验",
  ask: "提问",
  edit: "修改提案",
  followup: "追加指令（旧记录）",
});

/** What each brief field's state means, in the words the workspace shows. */
export const BRIEF_FIELD_LABELS: Readonly<Record<BriefFieldName, string>> = Object.freeze({
  topic: "主题",
  purpose: "研究问题 / 用途",
  audience: "读者",
  subjects: "比较对象",
  dimensions: "研究维度",
  focus: "关注点",
  exclusions: "不研究的内容",
  lengthTarget: "篇幅目标",
});

export const BRIEF_STATE_LABELS: Readonly<Record<BriefFieldState, string>> = Object.freeze({
  suggested: "助手建议",
  edited: "已修改",
  confirmed: "已确认",
});

export const CLAIM_TYPE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  fact: "事实",
  mechanism: "机制",
  comparison: "比较",
  performance: "性能",
  cost: "成本",
  synthesis: "综合判断",
  implication: "条件化建议",
});

export const ROLE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  primary: "一手材料",
  official: "官方文档",
  "independent-evaluation": "独立评测",
  survey: "综述",
  contextual: "背景",
  "user-provided": "用户提供",
});

export const ADEQUACY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  adequate: "证据充分",
  limited: "证据有限",
  incomparable: "不可直接比较",
  conflicted: "存在冲突",
  missing: "缺少证据",
  unassessed: "尚未评估",
});

export const COMPARABILITY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  comparable: "条件可比",
  "partially-comparable": "部分可比",
  "not-directly-comparable": "不可直接比较",
  unknown: "尚未判断可比性",
});

/** Tool calls, in the words a reader uses — the run log never shows raw names. */
export const TOOL_LABELS: Readonly<Record<string, string>> = Object.freeze({
  propose_task: "整理研究任务卡",
  search_sources: "检索候选来源",
  read_source: "读取来源上下文",
  assess_coverage: "核对证据覆盖",
  save_report: "撰写报告",
  propose_section_edit: "起草修改建议",
  load_research_state: "读取项目材料",
});
