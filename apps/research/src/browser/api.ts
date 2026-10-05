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

export interface RunView {
  readonly runId: string | null;
  readonly stage: "card" | "guide" | "research" | "gap" | "report" | "synthesis" | "ask" | "edit" | "followup";
  readonly status: "running" | "completed" | "failed" | "interrupted";
  readonly note: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly activity: readonly RunStepView[];
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

/** A decision already made through Guided Mode, for the page's own record. */
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
  readonly guide: {
    readonly complete: boolean;
    readonly reason: string;
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
  /** The Research Brief: the editable draft, or the frozen record once confirmed. */
  readonly brief: BriefView;
  readonly currentReportId: string | null;
  /** The current report's own content hash; null when there is no report. */
  readonly currentReportHash: string | null;
  /** Whether the current report already has a frozen revision. */
  readonly currentReportFrozen: boolean;
  readonly hasReport: boolean;
  readonly busy: boolean;
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  const value = text.length === 0 ? {} : (JSON.parse(text) as unknown);
  if (!response.ok) {
    const message = (value as { error?: string }).error ?? `HTTP ${response.status}`;
    throw new Error(message);
  }
  return value as T;
}

export const api = {
  runtime: (): Promise<RuntimeView> => request("/api/research/runtime"),
  listTasks: (): Promise<{ readonly tasks: readonly TaskSummary[] }> => request("/api/research/tasks"),
  startTask: (topic: string): Promise<{ readonly sessionId: string }> =>
    request("/api/research/tasks", { method: "POST", body: JSON.stringify({ topic }) }),
  sessionState: (sessionId: string): Promise<{ readonly pending: boolean; readonly task: TaskBundle | null }> =>
    request(`/api/research/sessions/${encodeURIComponent(sessionId)}`),
  task: (taskId: string): Promise<TaskBundle> => request(`/api/research/tasks/${encodeURIComponent(taskId)}`),
  answers: (taskId: string): Promise<{ readonly answers: readonly AnswerView[] }> =>
    request(`/api/research/tasks/${encodeURIComponent(taskId)}/answers`),
  document: (reportId: string): Promise<DocumentView> =>
    request(`/api/research/reports/${encodeURIComponent(reportId)}/document`),
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
  ): Promise<{ readonly ok: boolean; readonly started: string; readonly scope: string }> =>
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
  limited: "有限支持",
  unassessed: "有材料，待核对",
  conflict: "冲突 / 不可比",
  missing: "待查",
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
