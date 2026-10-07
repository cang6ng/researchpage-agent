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

import type { CellStatus, ReportTask, ReportValidation, Source, SourceRole } from "@every-dagent/plugin-research";

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
