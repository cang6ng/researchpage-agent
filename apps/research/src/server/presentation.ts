/**
 * Where a project stands, as orthogonal facts rather than one summary label.
 *
 * The workspace used to say「报告就绪 · 无待查项」next to「10/10 有依据」、
 * 「9 处义务未完全达成」and「1 处待复核」— each sentence true, and the ensemble
 * misleading, because they are answers to four different questions that were
 * never separated. This module separates them:
 *
 * - `runState` answers "what is happening now";
 * - `evidenceCoverage` answers "how much material exists" (material, not truth);
 * - `unresolvedResearch` answers "how many questions still have no conclusion";
 * - `reportReview` answers "is the report known to be behind the material";
 * - `artifactQuality` answers "did the report pass its own content contract";
 * - `sourceRoles` answers "what kind of material is this" — with unclassified
 *   sources counted as *unclassified* rather than as an absence of primary work.
 *
 * Nothing here is a new state machine: every field is derived from what the
 * service already knows, each carries a `displayName`/`userMessage` so the page
 * never has to translate an internal word, and the raw values stay on the
 * bundle for anything that needs to compute with them.
 */

import type {
  CellStatus,
  ReportGenerationFailure,
  ReportTask,
  ReportValidation,
  ResearchActivityEvent,
  ResearchProgressStage,
  ResearchRunRecord,
  Source,
  SourceRole,
} from "@every-dagent/plugin-research";

export type RunStateName = "preparing" | "researching" | "report_ready" | "editing" | "failed";

export interface RunStateProjection {
  readonly state: RunStateName;
  readonly displayName: string;
  readonly userMessage: string;
}

export interface EvidenceCoverageProjection {
  readonly cells: number;
  /** Cells with any material attached, whatever its judgement. */
  readonly withMaterial: number;
  /** Cells a direct body-level judgement now covers. */
  readonly reviewed: number;
  readonly displayName: string;
  readonly userMessage: string;
}

export interface UnresolvedResearchProjection {
  readonly unresolved: number;
  readonly limited: number;
  readonly incomparable: number;
  readonly resolved: number;
  readonly displayName: string;
  readonly userMessage: string;
}

export type ReportReviewState = "clean" | "needs_review";

export interface ReportReviewProjection {
  readonly state: ReportReviewState;
  readonly reason: string | null;
  readonly displayName: string;
  readonly userMessage: string;
}

export type ArtifactQualityState = "passed" | "warnings" | "blocking" | "unknown";

export interface ArtifactQualityProjection {
  readonly state: ArtifactQualityState;
  readonly warnings: number;
  readonly blocking: number;
  readonly displayName: string;
  readonly userMessage: string;
}

export interface SourceRoleProjection {
  readonly total: number;
  readonly classified: number;
  readonly unknown: number;
  /** How many of the classified sources are original or official material. */
  readonly primary: number;
  readonly byRole: Readonly<Record<SourceRole, number>>;
  readonly displayName: string;
  readonly userMessage: string;
}

export interface PresentationReadout {
  readonly runState: RunStateProjection;
  readonly evidenceCoverage: EvidenceCoverageProjection;
  readonly unresolvedResearch: UnresolvedResearchProjection;
  readonly reportReview: ReportReviewProjection;
  readonly artifactQuality: ArtifactQualityProjection;
  readonly sourceRoles: SourceRoleProjection;
}

/** The minimum a cell has to answer for the coverage facts to be derivable. */
export interface CoverageCell {
  readonly status: CellStatus;
}

const RUN_STATE_WORDS: Readonly<Record<RunStateName, string>> = Object.freeze({
  preparing: "准备中",
  researching: "研究中",
  report_ready: "报告已就绪",
  editing: "正在修改",
  failed: "运行失败",
});

/** How each role is counted when the product says what kind of material it has. */
const ROLE_NAMES: Readonly<Record<SourceRole, string>> = Object.freeze({
  primary: "原始论文 / 一手材料",
  official: "官方文档",
  "independent-evaluation": "独立评测",
  survey: "综述",
  contextual: "背景材料",
  "user-provided": "用户提供",
});

export interface RunStateInput {
  readonly task: ReportTask;
  readonly hasReport: boolean;
  readonly pendingProposal: boolean;
  /** The stage of the run actually executing, if one is. */
  readonly runningStage: string | null;
}

/**
 * What the project is doing, and nothing else.
 *
 * A running Ask or Edit is the assistant working on the report; a running
 * research or gap stage is the research moving. A pending proposal is a
 * decision waiting for the reader — which is why it reads as "editing" rather
 * than as "ready".
 */
export function runStateOf(input: RunStateInput): RunStateProjection {
  const name: RunStateName =
    input.task.error !== null
      ? "failed"
      : input.runningStage === "ask" || input.runningStage === "edit"
        ? "editing"
        : input.runningStage !== null
          ? "researching"
          : input.pendingProposal
            ? "editing"
            : !input.task.confirmedAt
              ? "preparing"
              : input.hasReport
                ? "report_ready"
                : "researching";
  const userMessage =
    name === "failed"
      ? `这个项目停在一次失败上：${input.task.error ?? "运行失败"}`
      : name === "editing"
        ? input.runningStage !== null
          ? "助手正在按你的指令处理这个项目；正文在接受修改建议之前不会变化。"
          : "有一份修改建议在等你决定是否接受。"
        : name === "preparing"
          ? "任务卡还没有确认，研究还没有开始。"
          : name === "report_ready"
            ? "报告已经写好并保存；可以继续补充材料或提出修改。"
            : "正在检索、读取与核对材料。";
  return { state: name, displayName: RUN_STATE_WORDS[name], userMessage };
}

/**
 * How much material exists, said as material.
 *
 * The point of the sentence is what it refuses to claim: material coverage is
 * not a conclusion, and a page that calls it「无待查项」is telling the reader
 * something the number does not say.
 */
export function evidenceCoverageOf(cells: readonly CoverageCell[]): EvidenceCoverageProjection {
  const total = cells.length;
  const withMaterial = cells.filter((cell) => cell.status !== "missing").length;
  const reviewed = cells.filter((cell) => cell.status === "reviewed").length;
  const displayName = `${withMaterial} / ${total} 个比较项已有材料`;
  const userMessage =
    total === 0
      ? "还没有建立比较矩阵。"
      : reviewed === total
        ? `${withMaterial} / ${total} 个比较项都有材料，且都已核对。`
        : `${withMaterial} / ${total} 个比较项已有材料；其中 ${reviewed} 项已核对。材料覆盖不等于结论完成。`;
  return { cells: total, withMaterial, reviewed, displayName, userMessage };
}

/**
 * How many research questions still have no conclusion.
 *
 * The buckets are the matrix's own states, grouped by what they mean to a
 * reader: no conclusion (待查 / 有材料待核对),有限支持, 冲突或不可比, and 已核对.
 */
export function unresolvedResearchOf(cells: readonly CoverageCell[]): UnresolvedResearchProjection {
  const count = (status: CellStatus): number => cells.filter((cell) => cell.status === status).length;
  const unresolved = count("missing") + count("unassessed");
  const limited = count("limited");
  const incomparable = count("conflict");
  const resolved = count("reviewed");
  const open = unresolved + limited + incomparable;
  const displayName = open === 0 ? "没有未解决的研究项" : `${open} 项还没有结论`;
  const parts = [
    unresolved > 0 ? `${unresolved} 项还没有可用的依据` : "",
    limited > 0 ? `${limited} 项只有有限支持` : "",
    incomparable > 0 ? `${incomparable} 项冲突或不可直接比较` : "",
  ].filter((part) => part.length > 0);
  const userMessage =
    open === 0
      ? "每个比较项都已经有直接依据。"
      : `${parts.join("、")}；这些是研究层面的未解决项，报告正文未解决的部分应当与它一致。`;
  return { unresolved, limited, incomparable, resolved, displayName, userMessage };
}

/** Whether the report is known to be behind the material that arrived after it. */
export function reportReviewOf(task: ReportTask): ReportReviewProjection {
  const flag = task.reportNeedsReview ?? null;
  const state: ReportReviewState = flag === null ? "clean" : "needs_review";
  return {
    state,
    reason: flag === null ? null : flag.reason,
    displayName: state === "clean" ? "未被标记待复核" : "需要复核",
    userMessage:
      flag === null
        ? "报告写成之后没有新材料进入，因此没有被标记为待复核；这不代表结论已经被独立复核过。"
        : `报告写成之后材料的支持状态发生了变化，建议复核：${flag.reason}`,
  };
}

/**
 * Whether the report passed its own content contract.
 *
 * The three states are the ones the validator records: nothing flagged, soft
 * obligations unmet, or blocking problems. A saved report cannot carry blocking
 * problems — the product refuses to seal one — so "blocking" is reported as
 * data rather than as an expected state.
 */
export function artifactQualityOf(validation: ReportValidation | null): ArtifactQualityProjection {
  if (validation === null) {
    return {
      state: "unknown",
      warnings: 0,
      blocking: 0,
      displayName: "还没有报告",
      userMessage: "这个项目还没有保存过报告版本。",
    };
  }
  const warnings = validation.warnings?.length ?? 0;
  const blocking = validation.problems.length;
  const state: ArtifactQualityState = blocking > 0 ? "blocking" : warnings > 0 ? "warnings" : "passed";
  return {
    state,
    warnings,
    blocking,
    displayName:
      state === "blocking"
        ? `有 ${blocking} 项未通过`
        : state === "warnings"
          ? `通过，${warnings} 处义务未完全达成`
          : "通过全部内容契约",
    userMessage:
      state === "blocking"
        ? `报告有 ${blocking} 项没有通过内容契约；这些在报告被保存时不应该存在，请人工检查。`
        : state === "warnings"
          ? `报告通过了发布校验，但有 ${warnings} 处义务没有完全达成（正文里已如实写出）。`
          : "报告通过了全部内容契约校验。",
  };
}

/**
 * What kind of material this project holds.
 *
 * The rule this projection exists to keep: a source nobody classified is
 * *unclassified*, not "not primary material". Counting 未声明 as zero used to
 * produce「原始论文 / 官方材料 = 0」for a project whose sources simply had no
 * role yet — a claim about the material that the data does not support.
 */
export function sourceRolesOf(sources: readonly Pick<Source, "role">[]): SourceRoleProjection {
  const byRole: Record<SourceRole, number> = {
    primary: 0,
    official: 0,
    "independent-evaluation": 0,
    survey: 0,
    contextual: 0,
    "user-provided": 0,
  };
  let unknown = 0;
  for (const source of sources) {
    const role = source.role ?? null;
    if (role === null) {
      unknown += 1;
      continue;
    }
    byRole[role] += 1;
  }
  const total = sources.length;
  const classified = total - unknown;
  const primary = byRole.primary + byRole.official;
  const listed = (Object.keys(byRole) as SourceRole[])
    .filter((role) => byRole[role] > 0)
    .map((role) => `${ROLE_NAMES[role]} ${byRole[role]}`)
    .join(" · ");
  const displayName = total === 0 ? "还没有来源" : primary > 0 && unknown === 0 ? `一手材料 ${primary}` : "一手材料（部分未分类）";
  const userMessage =
    total === 0
      ? "还没有找到任何来源。"
      : unknown === total
        ? `${ROLE_NAMES.primary}：未知（${total} 个来源尚未分类）`
        : unknown > 0
          ? `${ROLE_NAMES.primary}：${primary} 个已确认；另有 ${unknown} 个来源尚未分类（已分类 ${classified} / ${total}）。`
          : `${ROLE_NAMES.primary}：${primary} 个（${total} 个来源均已分类：${listed}）。`;
  return { total, classified, unknown, primary, byRole, displayName, userMessage };
}

export interface PresentationInput {
  readonly task: ReportTask;
  readonly cells: readonly CoverageCell[];
  readonly sources: readonly Pick<Source, "role">[];
  readonly hasReport: boolean;
  readonly pendingProposal: boolean;
  readonly runningStage: string | null;
  readonly validation: ReportValidation | null;
}

/** All six readouts, derived together from what the service already holds. */
export function presentationOf(input: PresentationInput): PresentationReadout {
  return {
    runState: runStateOf(input),
    evidenceCoverage: evidenceCoverageOf(input.cells),
    unresolvedResearch: unresolvedResearchOf(input.cells),
    reportReview: reportReviewOf(input.task),
    artifactQuality: artifactQualityOf(input.validation),
    sourceRoles: sourceRolesOf(input.sources),
  };
}

/**
 * Where the report is, as one of the states a reader can act on.
 *
 * Four states were being reported as one sentence —「没有保存有效报告」— and they
 * are not the same fact: a request that was accepted is not a report being
 * written, a draft that was written is not a report, and only a validated and
 * stored report is a report. `validated` is the only value that means success;
 * every other value says what would move it forward, and says it in words that
 * come from the failure classification rather than from an exception.
 */
export type ReportGenerationStatus = "idle" | "accepted" | "running" | "draft_saved" | "validated" | "failed";

export interface ReportGenerationProjection {
  readonly status: ReportGenerationStatus;
  readonly displayName: string;
  readonly userMessage: string;
  readonly stage: "report" | "synthesis" | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly resumes: number;
  readonly repairs: number;
  /** The safe, classified reason this attempt failed, if it did. */
  readonly failure: ReportGenerationFailure | null;
  /** What the saved draft already holds, counted rather than quoted. */
  readonly draft: { readonly sections: number; readonly claims: number; readonly outstanding: number } | null;
  /** Whether resuming would reuse existing material rather than searching again. */
  readonly canResume: boolean;
  /** Non-null only once a report is validated and stored. */
  readonly reportId: string | null;
  /** Why a resume is not available, when it is not. */
  readonly blockedBy: "report_exists" | "brief_unconfirmed" | "busy" | null;
}

const REPORT_STATUS_WORDS: Readonly<Record<ReportGenerationStatus, string>> = Object.freeze({
  idle: "尚未开始",
  accepted: "已受理",
  running: "正在生成报告",
  draft_saved: "草稿已保存（尚未通过校验）",
  validated: "报告已通过校验并保存",
  failed: "报告生成失败",
});

export interface ReportGenerationInput {
  readonly task: ReportTask;
  /** The stage of the run actually executing, if one is. */
  readonly runningStage: string | null;
  readonly draft: { readonly sections: number; readonly claims: number; readonly outstanding: number } | null;
  readonly busy: boolean;
}

export function reportGenerationOf(input: ReportGenerationInput): ReportGenerationProjection {
  const reportId = input.task.currentReportId;
  const generation = input.task.reportGeneration ?? null;
  const base = {
    stage: generation === null ? null : generation.stage,
    startedAt: generation?.startedAt ?? null,
    endedAt: generation?.endedAt ?? null,
    resumes: generation?.resumes ?? 0,
    repairs: generation?.repairs ?? 0,
    failure: generation?.failure ?? null,
    draft: input.draft,
    reportId,
  };

  // A stored report is the only success, and it outranks everything else: a
  // stale attempt record can never make a saved report look unfinished.
  if (reportId !== null) {
    return {
      ...base,
      status: "validated",
      displayName: REPORT_STATUS_WORDS.validated,
      userMessage: `报告 ${reportId} 已通过校验并保存；修改请走 Edit 提案。`,
      canResume: false,
      blockedBy: "report_exists",
    };
  }

  if (input.task.confirmedAt === null) {
    return {
      ...base,
      status: "idle",
      displayName: REPORT_STATUS_WORDS.idle,
      userMessage: "研究简报还没有确认；确认后才能开始撰写报告。",
      canResume: false,
      blockedBy: "brief_unconfirmed",
    };
  }

  if (input.busy || (generation !== null && generation.status === "running")) {
    const accepted = input.runningStage === null;
    return {
      ...base,
      status: accepted ? "accepted" : "running",
      displayName: accepted ? REPORT_STATUS_WORDS.accepted : REPORT_STATUS_WORDS.running,
      userMessage: accepted
        ? "报告请求已受理，正在排队；这不代表报告已经生成。"
        : `正在${base.stage === "synthesis" ? "综合与校验" : "撰写章节"}；完成前不会有正式报告。`,
      canResume: false,
      blockedBy: "busy",
    };
  }

  // A written draft outranks the attempt that produced it: what the reader has
  // is a document that did not pass validation — not "nothing" — and the
  // failure that stopped the pass is reported *with* it rather than instead of
  // it. What this projection has to keep apart is "no report exists" from "a
  // report exists"; a draft is the first of those, and it says how close it is.
  if (input.draft !== null) {
    const outstanding = input.draft.outstanding;
    const failure = generation?.failure ?? null;
    return {
      ...base,
      status: "draft_saved",
      displayName: REPORT_STATUS_WORDS.draft_saved,
      userMessage:
        failure !== null
          ? `草稿已保存但没有通过校验，最近一次执行也没有完成：${failure.problem} ${failure.guidance}`
          : outstanding === 0
            ? "草稿已经写齐，但还没有通过校验；用现有资料恢复报告即可继续，不需要重新检索。"
            : `草稿已保存，但仍有 ${outstanding} 项校验问题没有解决；用现有资料恢复报告只会针对这些问题。`,
      canResume: true,
      blockedBy: null,
    };
  }

  if (generation !== null && generation.status === "failed") {
    const failure = generation.failure;
    return {
      ...base,
      status: "failed",
      displayName: REPORT_STATUS_WORDS.failed,
      userMessage:
        failure === null
          ? "报告生成失败，而且还没有写出可用的草稿；已读材料都保留着，可以用现有资料重试报告，不需要重新检索。"
          : `${failure.problem} ${failure.guidance}`,
      canResume: true,
      blockedBy: null,
    };
  }

  return {
    ...base,
    status: "idle",
    displayName: REPORT_STATUS_WORDS.idle,
    userMessage: "还没有开始撰写报告；材料已经就绪，可以直接生成。",
    canResume: false,
    blockedBy: null,
  };
}

/**
 * Where the research actually is, and why it is waiting.
 *
 * This is the honest answer to the question a progress bar lies about. There is
 * no percentage here and there cannot be one: research does not complete a
 * fixed amount of work per second, and「63%」would be a number this product made
 * up. What it can say truthfully is which stage is running, what that stage is
 * doing right now, which stages have finished, how many requests and candidates
 * there have been, and — when something is waiting — what it is waiting for and
 * until when.
 *
 * The stage is read from two places that know different things: the run record
 * knows the *stage* (searching, reporting, validating), and the activity stream
 * knows what the stage is doing *within itself* (a research stage spends its
 * time searching, reading, assessing) and whether it is in a retry wait. The
 * projection prefers the more specific answer when the two disagree, because
 * the newer event is the one that is true now.
 */
export type ResearchStageName = ResearchProgressStage;

export interface ResearchProgressProjection {
  readonly currentStage: ResearchStageName;
  readonly displayName: string;
  readonly currentMessage: string;
  /** The stages that finished, in the order the product ran them. */
  readonly completedStages: readonly ResearchProgressStage[];
  readonly lastActivityAt: string | null;
  /** Physical discovery requests: the real count, including the failed ones. */
  readonly searchAttempts: number;
  readonly candidatesFound: number;
  readonly sourcesRead: number;
  readonly currentProvider: string | null;
  readonly retrying: boolean;
  /** When a retry or a provider cooldown ends, if the research is waiting. */
  readonly waitingUntil: string | null;
}

const PROGRESS_STAGE_WORDS: Readonly<Record<ResearchStageName, string>> = Object.freeze({
  preparing: "准备中",
  searching: "正在检索",
  reading: "正在读取",
  assessing: "正在核对证据",
  gap_research: "正在定向补查",
  reporting: "正在撰写报告",
  validating: "正在校验报告",
  answering: "正在回答问题",
  editing: "正在修改报告",
  waiting_retry: "正在等待检索服务",
  completed: "已完成",
  failed: "已失败",
});

/** Which progress stage a finished internal run corresponds to. */
function completedStageOf(stage: ResearchRunRecord["stage"]): ResearchProgressStage {
  switch (stage) {
    case "card":
    case "guide":
      return "preparing";
    case "research":
      return "searching";
    case "gap":
      return "gap_research";
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

/** What the newest activity line says the run is doing inside its stage. */
function stageFromActivity(event: ResearchActivityEvent, fallback: ResearchProgressStage): ResearchProgressStage {
  switch (event.kind) {
    case "search_started":
    case "request_started":
      return "searching";
    case "retry_wait":
      return "waiting_retry";
    case "read_started":
    case "read_completed":
    case "read_failed":
      return "reading";
    case "assessment_recorded":
      return "assessing";
    case "stage_started":
    case "stage_completed":
    case "stage_failed":
      return event.stage;
    default:
      return fallback;
  }
}

/** The stages a research pass moves through inside itself. */
const RESEARCH_INNER_STAGES: ReadonlySet<ResearchProgressStage> = new Set(["searching", "reading", "assessing", "waiting_retry"]);

export interface ProgressInput {
  readonly task: ReportTask;
  readonly runs: readonly ResearchRunRecord[];
  readonly activity: readonly ResearchActivityEvent[];
  readonly sources: readonly Pick<Source, "readStatus">[];
}

export function researchProgressOf(input: ProgressInput): ResearchProgressProjection {
  const newest = input.activity[input.activity.length - 1];
  const running = input.runs.find((record) => record.status === "running");
  const failed = input.task.status === "failed";
  const completedStages = [
    ...new Set(input.runs.filter((record) => record.status === "completed").map((record) => completedStageOf(record.stage))),
  ];
  const base: ResearchProgressStage =
    running === undefined
      ? failed
        ? "failed"
        : input.task.currentReportId !== null
          ? "completed"
          : "preparing"
      : completedStageOf(running.stage);
  // A stage is the run's fact; what the stage is *doing* is the activity's.
  // The refinement only applies inside the stage that is actually running —
  // a search event left over from the research pass must not make a reporting
  // run look like it is searching again.
  const refine =
    running !== undefined &&
    newest !== undefined &&
    (newest.stage === base || (RESEARCH_INNER_STAGES.has(newest.stage) && (base === "searching" || base === "gap_research")));
  const currentStage: ResearchStageName = refine ? stageFromActivity(newest as ResearchActivityEvent, base) : base;
  const retrying = newest !== undefined && (newest.kind === "retry_wait" || newest.kind === "provider_skipped");
  const waitingUntil = retrying ? (newest?.nextRetryAt ?? null) : null;

  const searches = input.task.discovery?.attemptedRequests ?? 0;
  const sourcesRead = input.sources.filter((source) => source.readStatus === "ok").length;
  const candidatesFound = input.sources.length;
  const currentProvider = running === undefined ? (input.task.discovery?.lastProvider ?? null) : (newest?.provider ?? input.task.discovery?.lastProvider ?? null);

  const message =
    newest !== undefined && (running !== undefined || recentEnough(newest, input.task.updatedAt))
      ? newest.message
      : currentStage === "failed"
        ? (input.task.error ?? "这个项目停在一次失败上。")
        : currentStage === "completed"
          ? "报告已经写好并保存；可以继续补充材料或提出修改。"
        : currentStage === "preparing"
          ? "研究还没有开始。"
          : PROGRESS_STAGE_WORDS[currentStage];

  return {
    currentStage,
    displayName: PROGRESS_STAGE_WORDS[currentStage],
    currentMessage: message,
    completedStages,
    lastActivityAt: newest?.at ?? null,
    searchAttempts: searches,
    candidatesFound,
    sourcesRead,
    currentProvider,
    retrying,
    waitingUntil,
  };
}

/** Whether an activity line is still about now, rather than about last week. */
function recentEnough(event: ResearchActivityEvent, updatedAt: string): boolean {
  const at = Date.parse(event.at);
  const updated = Date.parse(updatedAt);
  if (Number.isNaN(at) || Number.isNaN(updated)) return false;
  return at >= updated - 60_000;
}
