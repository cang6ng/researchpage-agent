/**
 * What one action answered, said before anything about what it fetched.
 *
 * A 补查 used to end with a number: 「找到了 2 个来源的可用材料」。That sentence
 * is true of a search that found two background papers and answered nothing,
 * which is why the reader could not tell a resolved question from an open one.
 * The product now derives, for every research action, whether the question it
 * was given is resolved — from the coverage the new evidence actually produced
 * — and this module is the page's reading of that answer: the verdict first,
 * what it settled and what it did not, and only then what the action spent.
 *
 * Nothing here re-derives the verdict. It reads `run.outcome` (the application's
 * own `ResearchResolution`) and names the objects it talks about, because a
 * resolution about `sub_x × dim_y` is not something a reader can act on.
 */

import type {
  ActionDeltaView,
  AssessmentView,
  EvidenceView,
  ResearchResolutionView,
  RunOutcomeView,
  RunView,
  SourceView,
  TaskBundle,
} from "./api.js";
import { RESOLUTION_LABELS } from "./api.js";

/** How a research action ended, including the runs that predate the record. */
export type ResearchVerdict = "resolved" | "partially_resolved" | "unresolved" | "unrecorded";

export interface MissingTarget {
  readonly label: string;
  readonly status: string;
  readonly reason: string;
}

export interface ResearchOutcome {
  readonly verdict: ResearchVerdict;
  /** 已解决 / 部分解决 / 未解决, or what to say when nothing was recorded. */
  readonly headline: string;
  /** The application's own sentence about this action. */
  readonly sentence: string;
  /** The targets this action settled, named. */
  readonly settled: readonly string[];
  /** The targets it did not, with the reason the project gives. */
  readonly missing: readonly MissingTarget[];
  /** What the action added, counted from the ids it added them as. */
  readonly delta: ActionDeltaView | null;
  readonly hasDelta: boolean;
  /** What the action spent — a secondary line, and never the result. */
  readonly activity: string;
  /** Whether this action's own evidence can be opened. */
  readonly inspectable: boolean;
}

/** `sub_1 × dim_2`, said with the names the project gave them. */
function targetLabel(bundle: TaskBundle, target: { readonly subjectId: string; readonly dimensionId: string }): string {
  const subject = bundle.subjects.find((candidate) => candidate.id === target.subjectId)?.name ?? "比较对象";
  const dimension = bundle.dimensions.find((candidate) => candidate.id === target.dimensionId)?.name ?? "研究维度";
  return `${subject} × ${dimension}`;
}

/** What an action added, as a sentence — or the honest zero. */
export function deltaLine(delta: ActionDeltaView | null): string {
  if (delta === null) return "";
  const parts: string[] = [];
  if (delta.newSourceIds.length > 0) parts.push(`${String(delta.newSourceIds.length)} 个来源`);
  if (delta.newEvidenceIds.length > 0) parts.push(`${String(delta.newEvidenceIds.length)} 条证据`);
  if (delta.newAssessmentIds.length > 0) parts.push(`${String(delta.newAssessmentIds.length)} 项支持评估`);
  return parts.join(" · ");
}

/** What the action spent, in the reader's own units. */
export function activityLine(interaction: { readonly searches: number; readonly reads: number; readonly assessments: number }): string {
  const parts: string[] = [];
  if (interaction.searches > 0) parts.push(`${String(interaction.searches)} 次检索`);
  if (interaction.reads > 0) parts.push(`${String(interaction.reads)} 个来源读取`);
  if (interaction.assessments > 0) parts.push(`${String(interaction.assessments)} 格覆盖评估`);
  return parts.length === 0 ? "这次动作没有调用检索或读取。" : parts.join(" · ");
}

function missingOf(bundle: TaskBundle, resolution: ResearchResolutionView): readonly MissingTarget[] {
  const settled = new Set(
    resolution.targetCells
      .map((target) => targetLabel(bundle, target))
      .filter((label) => !resolution.remainingGap.some((gap) => `${gap.subjectName} × ${gap.dimensionName}` === label)),
  );
  return resolution.remainingGap
    .filter((gap) => !settled.has(`${gap.subjectName} × ${gap.dimensionName}`))
    .map((gap) => ({
      label: `${gap.subjectName} × ${gap.dimensionName}`,
      status: gap.status,
      reason: gap.reason,
    }));
}

function settledOf(bundle: TaskBundle, resolution: ResearchResolutionView): readonly string[] {
  const missing = new Set(resolution.remainingGap.map((gap) => `${gap.subjectName} × ${gap.dimensionName}`));
  return resolution.targetCells
    .map((target) => targetLabel(bundle, target))
    .filter((label) => !missing.has(label));
}

/**
 * One research action, as the reader's answer.
 *
 * `resolution` is what the application derived; when a run predates that record
 * the page says so instead of guessing a verdict from a material count, because
 * "two sources arrived" and "the question is answered" are different claims and
 * only the second one is what the reader asked for.
 */
export function researchOutcomeOf(
  bundle: TaskBundle,
  interaction: {
    readonly outcome: RunOutcomeView | null;
    readonly searches: number;
    readonly reads: number;
    readonly assessments: number;
  },
): ResearchOutcome {
  const resolution = interaction.outcome?.kind === "research" ? interaction.outcome.resolution : null;
  const delta = interaction.outcome?.kind === "research" ? interaction.outcome.delta : null;
  const activity = activityLine(interaction);
  if (resolution === null) {
    return {
      verdict: "unrecorded",
      headline: "结果未记录",
      sentence: "这次补查没有记录「问题是否解决」——它在升级之前运行。新增的材料与支持评估已经并入项目。",
      settled: [],
      missing: [],
      delta,
      hasDelta: delta !== null && deltaLine(delta).length > 0,
      activity,
      inspectable: false,
    };
  }
  const missing = missingOf(bundle, resolution);
  const settled = settledOf(bundle, resolution);
  return {
    verdict: resolution.status,
    headline: RESOLUTION_LABELS[resolution.status] ?? resolution.status,
    sentence: resolution.summary,
    settled,
    missing,
    delta,
    hasDelta: deltaLine(delta).length > 0,
    activity,
    inspectable: true,
  };
}

/** The run a conversation turn came from, by the id the turn is keyed on. */
export function runOfInteraction(bundle: TaskBundle, interactionId: string): RunView | null {
  return bundle.runs.find((run) => interactionIdOf(run) === interactionId) ?? null;
}

/** How a turn is identified — the run's own id, or its stage and start. */
export function interactionIdOf(run: Pick<RunView, "runId" | "stage" | "startedAt">): string {
  return run.runId ?? `${run.stage}-${run.startedAt}`;
}

/**
 * Whether a call the host completed was one the *service* refused.
 *
 * A refusal is a tool result, not a failure: the host ran the call and the
 * server said no, so the record carries `ok: true` and the sentence refusing
 * the call is inside the result body. Counting those as work done would let an
 * action report having searched three times when it searched twice and was
 * turned away once — and the allowance it says it spent would be wrong too.
 */
export function refusedCall(detail: string): boolean {
  return /\{"ok":false/.test(detail);
}

/** How many times a run really called one tool, refusals excluded. */
export function countCalls(run: RunView, name: string): number {
  return run.activity.filter((step) => step.name === name && step.ok !== false && !refusedCall(step.detail)).length;
}

/**
 * One run's outcome, read from the run itself.
 *
 * The dock opens an action from the run rather than from the conversation turn
 * that rendered it, so this is the entry point that keeps the two answers
 * identical: the same resolution, the same counts, the same verdict.
 */
export function outcomeOfRun(bundle: TaskBundle, run: RunView): ResearchOutcome {
  return researchOutcomeOf(bundle, {
    outcome: run.outcome,
    searches: countCalls(run, "search_sources"),
    reads: countCalls(run, "read_source"),
    assessments: countCalls(run, "assess_coverage"),
  });
}

/** What one action added, as the objects themselves. */
export interface ActionMaterial {
  readonly sources: readonly SourceView[];
  readonly evidence: readonly EvidenceView[];
  readonly assessments: readonly AssessmentView[];
}

/**
 * The material one action brought in — by id, from the run's own record.
 *
 * A difference of id sets rather than a slice of the project's lists: the
 * project may hold two hundred sources, and the three this action found are the
 * ones the reader asked about. An action that added nothing returns empty
 * lists, which is an answer.
 */
export function actionMaterial(bundle: TaskBundle, interactionId: string): ActionMaterial {
  const run = runOfInteraction(bundle, interactionId);
  const resolution = run?.outcome?.kind === "research" ? run.outcome.resolution : null;
  const sourceIds = new Set(resolution?.newSourceIds ?? []);
  const evidenceIds = new Set(resolution?.newEvidenceIds ?? []);
  const assessmentIds = new Set(resolution?.newAssessmentIds ?? []);
  return {
    sources: bundle.sources.filter((source) => sourceIds.has(source.sourceId)),
    evidence: bundle.evidence.filter((item) => evidenceIds.has(item.evidenceId)),
    assessments: bundle.assessments.filter((entry) => assessmentIds.has(entry.assessmentId)),
  };
}
