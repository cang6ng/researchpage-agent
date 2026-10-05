/**
 * The research runner: how a task actually gets researched.
 *
 * A research pass does not fit inside one host run — the Core's loop profile
 * allows a bounded number of steps per turn, and that bound is part of the
 * approved resource profile rather than something this product may raise. So a
 * pass is a small, explicit sequence of *stage runs*: a card, a first
 * search/read/assess pass, up to two gap rounds, and a report. Each stage is an
 * ordinary host run started through the client, recorded in the business
 * database, and visible in the workspace — which is also what makes an
 * interrupted research pass resumable by action rather than by replay.
 *
 * The runner is the program's half of the gap policy: it reads the matrix after
 * each stage, decides whether another bounded round is worth spending, and stops
 * when the budget is spent. The model still does the searching, reading and
 * writing — it just does not get to decide how much of it is left.
 */

import type { Client } from "@every-dagent/client";
import type { LiveItem } from "@every-dagent/protocol";
import type {
  MatrixCell,
  ReportTask,
  ResearchRunRecord,
  ResearchService,
  ResearchStage,
} from "@every-dagent/plugin-research";
import { ID_PREFIX, newId } from "@every-dagent/plugin-research";

export interface ResearchRunnerOptions {
  readonly client: Client;
  readonly service: ResearchService;
  /** The longest one stage may take before it is cancelled, in ms. */
  readonly stageTimeoutMs?: number;
  /** Called when the runner wants to export the report the moment it exists. */
  readonly exportPdf?: (taskId: string) => Promise<{ readonly ok: boolean; readonly failure?: string }>;
  readonly log?: (message: string) => void;
}

export interface ResearchRunner {
  /**
   * The first stage: turn the user's topic into a task card draft.
   *
   * It runs against the *session*, before any task exists — the card stage is
   * what creates the task (via `propose_task`), so there is nothing to record
   * it against yet, and the workspace learns about it from the session route.
   */
  startCard(sessionId: string, topicInput: string): void;
  /** The main pass: search, read, assess. */
  startResearch(taskId: string): void;
  /** One targeted round at the current gaps. */
  startGapRound(taskId: string): void;
  /** Write and save the report. */
  startReport(taskId: string): void;
  /** A user's follow-up instruction, run against the existing task. */
  startFollowUp(taskId: string, text: string): void;
  /** Marks records left `running` by a previous process as interrupted. */
  reconcileInterrupted(): void;
  readonly busy: boolean;
  readonly queued: number;
  /** Resolves when nothing is queued and no stage is executing. */
  idle(): Promise<void>;
  /** Waits for the current stage, then stops accepting new ones. */
  shutdown(): Promise<void>;
}

interface StageRequest {
  /** The task this stage belongs to; `null` only for the card stage. */
  readonly taskId: string | null;
  readonly sessionId: string;
  readonly stage: ResearchStage;
  readonly instruction: string;
}

const STAGE_LABELS: Readonly<Record<ResearchStage, string>> = Object.freeze({
  card: "建立任务卡",
  research: "检索与读取",
  gap: "定向补查",
  report: "生成报告",
  followup: "追加指令",
});

function stageLabel(stage: ResearchStage): string {
  return STAGE_LABELS[stage];
}

function cellLabel(cell: MatrixCell, task: ReportTask): string {
  const subject = task.subjects.find((candidate) => candidate.id === cell.subjectId)?.name ?? cell.subjectId;
  const dimension = task.dimensions.find((candidate) => candidate.id === cell.dimensionId)?.name ?? cell.dimensionId;
  return `${subject} × ${dimension}（${cell.status === "partial" ? "仅摘要/部分依据" : "无依据"}）`;
}

/** The instruction one stage run is started with. Written here, not by a model. */
export function stageInstruction(input: {
  readonly stage: "card";
  readonly topicInput: string;
}): string;
export function stageInstruction(input: {
  readonly stage: "research" | "gap" | "report";
  readonly task: ReportTask;
}): string;
export function stageInstruction(input: {
  readonly stage: "followup";
  readonly task: ReportTask;
  readonly followUp: string;
}): string;
export function stageInstruction(input: {
  readonly stage: ResearchStage;
  readonly task?: ReportTask;
  readonly topicInput?: string;
  readonly followUp?: string;
}): string {
  if (input.stage === "card") {
    return [
      "请为用户的研究主题建立研究任务卡。",
      "调用 propose_task（一次调用即可），字段要求：",
      "- 比较对象（subjects）2–4 个，是具体的技术/方法/系统名称；",
      "- 研究维度（dimensions）3–6 个，要能驱动证据矩阵（例如核心思想、结构与构建、检索机制、实验与评测、成本与部署、局限与风险）；",
      "- topic 用一句话概括主题；purpose 写明用途；audience 写明读者；focus 写本次关注点。",
      "主题原文：",
      `"""${input.topicInput ?? ""}"""`,
      "保存后，用一两句话说明你确定的比较对象与研究维度，并请用户确认。不要调用检索工具。",
    ].join("\n");
  }

  const task = input.task;
  if (task === undefined) throw new Error(`the ${input.stage} stage needs a task`);
  const subjects = task.subjects.map((subject) => `${subject.name}(${subject.id})`).join("、");
  const dimensions = task.dimensions.map((dimension) => `${dimension.name}(${dimension.id})`).join("、");
  const gapCells = task.matrix.filter((cell) => cell.status !== "sufficient");

  switch (input.stage) {
    case "research":
      return [
        "任务卡已由用户确认，现在开始真实检索与读取。请按顺序执行：",
        "1) 用 search_sources 做 1–2 次检索（英文技术关键词，每次 limit 3–5），覆盖不同研究对象或不同维度；",
        "2) 用 read_source 读取最有代表性的 2–4 个候选：question 说明要回答什么，terms 给英文关键词，targetCell 指向该来源最能回答的矩阵单元格；",
        "3) 调用 assess_coverage 提交覆盖评估（可把已有的 evidenceId 绑定到单元格）。",
        `比较对象：${subjects}`,
        `研究维度：${dimensions}`,
        gapCells.length > 0
          ? `当前缺口（共 ${gapCells.length} 格，优先关注）：${gapCells.slice(0, 6).map((cell) => cellLabel(cell, task)).join("；")}`
          : "当前尚无任何证据，全部单元格都是缺口。",
        "本轮不要写报告；只做检索、读取与覆盖评估。若工具提示预算不足，就停止并说明。",
      ].join("\n");
    case "gap":
      return [
        `进入定向补查轮（已用 ${task.usage.gapRounds}/${task.budget.maxGapRounds} 轮）。请只针对下面的缺口做最少次数的补查：`,
        gapCells
          .slice(0, 3)
          .map((cell) => `- ${cellLabel(cell, task)}：${cell.gap.length > 0 ? cell.gap : cell.reason}`)
          .join("\n"),
        "可用手段：最多 1 次 search_sources（换更精确的英文关键词）或直接用已有未读来源做 read_source；读取时把 targetCell 指向对应单元格。",
        "完成后调用 assess_coverage（gapRound=true）。如果仍然没有公开依据，保持缺失，不要用常识补写。",
      ].join("\n");
    case "report":
      return [
        "请基于已保存的证据写出结构化研究报告。单次输出有限，请用 save_report 分次提交：",
        '1) {part:"start", title, summary}；',
        '2) {part:"write", claims:[{id,text,evidenceIds,kind}]}（每条 claim 的 evidenceIds 只能来自工具返回的真实 evidenceId；综合推断用 kind="inference"）；',
        '3) 逐节提交 {part:"write", section:{id,title,blocks}}：必需章节 overview / representative / comparison / limitations，可选 background / conditions / reading；',
        "4) 全部提交后用 {part:'finalize'} 校验并发布。",
        "写作要求：",
        `- comparison 章节用 table 块：列为「方法」+ 最关键的 2–3 个维度；行为 ${subjects}；`,
        '- 没有依据的比较项写成 callout（tone="gap"）明确说明缺失；',
        "- 报告使用中文，方法名与术语保留原文；不同实验设置/硬件的结果不要直接排名；",
        "- 篇幅控制：表格 ≤3 列、单元格 ≤40 字、段落 ≤150 字、claims ≤8 条（超出会因输出上限被截断）。",
        "finalize 成功后简要说明报告结构与仍存在的缺口。",
      ].join("\n");
    case "followup":
      return [
        "用户对当前研究任务追加了指令，请在已有材料与预算内执行：",
        `"""${input.followUp ?? ""}"""`,
        "如果指令要求新的检索或读取，注意预算限制；如果要求修改报告，请重新调用 save_report 覆盖保存。不要编造未读取到的内容。",
      ].join("\n");
  }
}

export function createResearchRunner(options: ResearchRunnerOptions): ResearchRunner {
  const { client, service } = options;
  const stageTimeoutMs = options.stageTimeoutMs ?? 9 * 60 * 1000;
  const log = options.log ?? ((): void => undefined);

  const queue: StageRequest[] = [];
  let active: Promise<void> | undefined;
  let stopping = false;
  let idleResolvers: (() => void)[] = [];
  /** Card stages have no task yet, so their one retry is counted here. */
  const cardAttempts = new Map<string, number>();

  function settleIdle(): void {
    if (active === undefined && queue.length === 0) {
      const resolvers = idleResolvers.splice(0);
      for (const resolve of resolvers) resolve();
    }
  }

  function enqueue(request: StageRequest): void {
    if (stopping) return;
    queue.push(request);
    pump();
  }

  function pump(): void {
    if (active !== undefined || queue.length === 0) {
      settleIdle();
      return;
    }
    const request = queue.shift() as StageRequest;
    active = execute(request).finally(() => {
      active = undefined;
      pump();
    });
  }

  /** Reads the live timeline of one run into the record's activity list. */
  function transcriptOf(runId: string): ResearchRunRecord["activity"] {
    const snapshot = client.getSnapshot();
    const live: readonly LiveItem[] = snapshot.live[runId]?.live ?? [];
    const at = new Date().toISOString();
    const seen = new Set<string>();
    const entries: { name: string; detail: string; ok: boolean | null; at: string }[] = [];
    for (const item of live) {
      if (item.kind !== "tool") continue;
      if (seen.has(item.callId)) continue;
      seen.add(item.callId);
      const ok = item.result === null ? null : item.result.ok;
      const detail =
        item.result === null
          ? "调用中"
          : item.result.ok
            ? item.result.content.slice(0, 220)
            : `失败：${item.result.content.slice(0, 200)}`;
      entries.push({ name: item.name, detail, ok, at });
    }
    return entries;
  }

  function runSettled(runId: string): { readonly settled: boolean; readonly status: string; readonly error: string | null } {
    const snapshot = client.getSnapshot();
    const run = snapshot.presentation?.runs.items.find((candidate) => candidate.runId === runId);
    if (run === undefined) return { settled: false, status: "unknown", error: null };
    const settled = run.status !== "accepted" && run.status !== "running" && snapshot.live[runId] === undefined;
    const failure =
      run.status === "failed"
        ? run.error === null || run.error === undefined
          ? "运行失败"
          : `${run.error.code}: ${run.error.message}`
        : null;
    return { settled, status: run.status, error: failure };
  }

  async function execute(request: StageRequest): Promise<void> {
    const task = request.taskId === null ? undefined : service.getTask(request.taskId);
    if (request.taskId !== null && task === undefined) {
      log(`[runner] task ${request.taskId} no longer exists; dropping ${request.stage}`);
      return;
    }

    // Only a stage that belongs to a task is recorded as one of its runs: the
    // card stage runs before the task exists, and the workspace reads its
    // progress from the session instead.
    let record: ResearchRunRecord | undefined =
      task === undefined
        ? undefined
        : {
            id: newId(ID_PREFIX.run),
            taskId: task.id,
            stage: request.stage,
            runId: null,
            status: "running",
            startedAt: new Date().toISOString(),
            endedAt: null,
            note: `${stageLabel(request.stage)}：已启动`,
            activity: [],
          };
    if (record !== undefined) service.recordRun(record);

    const finish = (patch: Partial<ResearchRunRecord>): void => {
      if (record === undefined) return;
      service.recordRun({ ...record, ...patch, endedAt: patch.endedAt ?? new Date().toISOString() });
    };

    let runId: string;
    try {
      const started = await client.runs.start({
        sessionId: request.sessionId,
        submissionId: newId(ID_PREFIX.submission),
        text: request.instruction,
      });
      runId = started.run.runId;
      if (record !== undefined) {
        record = { ...record, runId };
        service.recordRun(record);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "启动运行失败";
      finish({ status: "failed", note: `${stageLabel(request.stage)}：启动失败 — ${reason}` });
      log(`[runner] ${request.stage} could not start: ${reason}`);
      return;
    }

    const readsBefore = request.taskId === null ? 0 : service.getTask(request.taskId)?.usage.reads ?? 0;
    let runFailed = false;
    const deadline = Date.now() + stageTimeoutMs;
    for (;;) {
      await new Promise((resolve) => {
        setTimeout(resolve, 400);
      });
      const state = runSettled(runId);
      if (record !== undefined) {
        record = { ...record, activity: transcriptOf(runId) };
        service.recordRun(record);
      }
      if (state.settled) {
        runFailed = state.status !== "completed";
        finish({
          status: state.status === "completed" ? "completed" : "failed",
          note:
            state.status === "completed"
              ? `${stageLabel(request.stage)}：完成`
              : `${stageLabel(request.stage)}：${state.error ?? state.status}`,
          endedAt: new Date().toISOString(),
        });
        break;
      }
      if (Date.now() > deadline) {
        try {
          await client.runs.cancel({ runId });
        } catch {
          // The run may have settled between the check and the cancel.
        }
        runFailed = true;
        finish({ status: "failed", note: `${stageLabel(request.stage)}：超时后已取消` });
        log(`[runner] ${request.stage} timed out and was cancelled`);
        break;
      }
    }

    if (runFailed) {
      if (request.taskId === null) {
        const attempts = (cardAttempts.get(request.sessionId) ?? 0) + 1;
        cardAttempts.set(request.sessionId, attempts);
        if (attempts < 2) {
          log(`[runner] retrying ${request.stage} once for session ${request.sessionId}`);
          enqueue(request);
          return;
        }
      } else {
        const tally = stageAttempts(request.taskId, request.stage);
        if (tally.failures === 1 && tally.attempts === 1) {
          log(`[runner] retrying ${request.stage} once for task ${request.taskId}`);
          enqueue(request);
          return;
        }
      }
    }

    await afterStage(request, readsBefore, runFailed);
  }

  /**
   * How many gap rounds this task has already run.
   *
   * Counted from the run records the runner itself wrote, not from a number a
   * model reported: a model that forgets to mark a round must not turn the gap
   * policy into an unbounded loop, and a run that is interrupted must still
   * count as a round it spent.
   */
  function gapStagesSoFar(taskId: string): number {
    return service.runsOf(taskId).filter((record) => record.stage === "gap").length;
  }

  /** Whether the last stage actually added material; a round that did not is not repeated. */
  function readsProgressed(taskId: string, before: number): boolean {
    const task = service.getTask(taskId);
    return task !== undefined && task.usage.reads > before;
  }

  /**
   * How many times a stage has been tried for a task, and whether it already
   * failed before.
   *
   * A real provider occasionally fails a request for reasons that have nothing
   * to do with this product — a transient error, a momentary rate limit. The
   * bounded answer is one retry per stage, counted from the records the runner
   * itself wrote, so a demo that hits a hiccup recovers by itself and a stage
   * that is failing for a real reason stops after the second attempt.
   */
  function stageAttempts(taskId: string, stage: ResearchStage): { readonly attempts: number; readonly failures: number } {
    const records = service.runsOf(taskId).filter((record) => record.stage === stage);
    return {
      attempts: records.length,
      failures: records.filter((record) => record.status === "failed" || record.status === "interrupted").length,
    };
  }

  /** What the program does once a stage settles: the next bounded step, or a stop. */
  async function afterStage(request: StageRequest, readsBefore: number, runFailed: boolean): Promise<void> {
    const task = request.taskId === null ? undefined : service.getTask(request.taskId);
    if (task === undefined) return;
    const sessionId = request.sessionId;

    switch (request.stage) {
      case "card":
      case "followup":
        return;
      case "research": {
        if (task.usage.reads === 0) {
          // Nothing was read, so there is nothing to assess or report on. The
          // task keeps its materials and the workspace offers a retry.
          service.failTask(task.id, "研究阶段没有成功读取任何来源；可以重试或更换主题。");
          return;
        }
        const gaps = task.matrix.filter((cell) => cell.status !== "sufficient");
        if (runFailed) {
          // A stage that ended in an error does not get to spend another round:
          // whatever was read is written up honestly, gaps included.
          enqueue({ taskId: task.id, sessionId, stage: "report", instruction: stageInstruction({ stage: "report", task }) });
          return;
        }
        if (gaps.length > 0 && gapStagesSoFar(task.id) < task.budget.maxGapRounds) {
          enqueue({ taskId: task.id, sessionId, stage: "gap", instruction: stageInstruction({ stage: "gap", task }) });
          return;
        }
        enqueue({ taskId: task.id, sessionId, stage: "report", instruction: stageInstruction({ stage: "report", task }) });
        return;
      }
      case "gap": {
        const refreshed = service.getTask(task.id);
        if (refreshed === undefined) return;
        const gaps = refreshed.matrix.filter((cell) => cell.status !== "sufficient");
        const budgetLeft = gapStagesSoFar(refreshed.id) < refreshed.budget.maxGapRounds;
        // A round that read nothing new cannot have changed the matrix, so it
        // is not repeated: the report is written with the gaps that remain.
        const progressed = readsProgressed(refreshed.id, readsBefore);
        if (!runFailed && gaps.length > 0 && budgetLeft && progressed) {
          enqueue({
            taskId: refreshed.id,
            sessionId,
            stage: "gap",
            instruction: stageInstruction({ stage: "gap", task: refreshed }),
          });
          return;
        }
        enqueue({
          taskId: refreshed.id,
          sessionId,
          stage: "report",
          instruction: stageInstruction({ stage: "report", task: refreshed }),
        });
        return;
      }
      case "report": {
        const settled = service.getTask(task.id);
        if (settled === undefined) return;
        if (settled.currentReportId === null) {
          service.failTask(settled.id, "报告阶段结束但没有保存有效报告；可以在工作台重新生成。");
          return;
        }
        if (options.exportPdf !== undefined) {
          const exported = await options.exportPdf(settled.id);
          log(
            exported.ok
              ? `[runner] PDF exported for ${settled.id}`
              : `[runner] PDF export failed for ${settled.id}: ${exported.failure ?? "unknown"}`,
          );
        }
        return;
      }
    }
  }

  return {
    startCard(sessionId, topicInput) {
      cardAttempts.set(sessionId, 0);
      enqueue({ taskId: null, sessionId, stage: "card", instruction: stageInstruction({ stage: "card", topicInput }) });
    },
    startResearch(taskId) {
      const task = service.getTask(taskId);
      if (task === undefined) return;
      enqueue({ taskId, sessionId: task.sessionId, stage: "research", instruction: stageInstruction({ stage: "research", task }) });
    },
    startGapRound(taskId) {
      const task = service.getTask(taskId);
      if (task === undefined) return;
      enqueue({ taskId, sessionId: task.sessionId, stage: "gap", instruction: stageInstruction({ stage: "gap", task }) });
    },
    startReport(taskId) {
      const task = service.getTask(taskId);
      if (task === undefined) return;
      enqueue({ taskId, sessionId: task.sessionId, stage: "report", instruction: stageInstruction({ stage: "report", task }) });
    },
    startFollowUp(taskId, text) {
      const task = service.getTask(taskId);
      if (task === undefined) return;
      enqueue({
        taskId,
        sessionId: task.sessionId,
        stage: "followup",
        instruction: stageInstruction({ stage: "followup", task, followUp: text }),
      });
    },

    reconcileInterrupted() {
      for (const task of service.listTasks()) {
        for (const run of service.runsOf(task.id)) {
          if (run.status !== "running") continue;
          service.recordRun({
            ...run,
            status: "interrupted",
            endedAt: new Date().toISOString(),
            note: `${run.note}（应用重启后中断；材料已保留，可重新发起该阶段）`,
          });
        }
      }
    },

    get busy() {
      return active !== undefined;
    },
    get queued() {
      return queue.length;
    },
    idle(): Promise<void> {
      if (active === undefined && queue.length === 0) return Promise.resolve();
      return new Promise((resolve) => {
        idleResolvers.push(resolve);
      });
    },
    async shutdown() {
      stopping = true;
      queue.length = 0;
      if (active !== undefined) await active;
    },
  };
}
