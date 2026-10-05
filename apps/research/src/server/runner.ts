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
  ActionGrant,
  AssistantIntent,
  MatrixCell,
  ReportTask,
  ResearchRunRecord,
  ResearchService,
  ResearchStage,
} from "@every-dagent/plugin-research";
import { ID_PREFIX, blueprintById, needsAttention, newId } from "@every-dagent/plugin-research";

export interface ResearchRunnerOptions {
  readonly client: Client;
  readonly service: ResearchService;
  /** The longest one stage may take before it is cancelled, in ms. */
  readonly stageTimeoutMs?: number;
  /** Called when the runner wants to export the report the moment it exists. */
  readonly exportPdf?: (taskId: string) => Promise<{ readonly ok: boolean; readonly failure?: string }>;
  readonly log?: (message: string) => void;
}

/** What the application decided about one user instruction, before it runs. */
export interface AssistantActionInput {
  readonly intent: AssistantIntent;
  readonly text: string;
  /** The section an Edit is aimed at; required for Edit, ignored otherwise. */
  readonly targetSectionId?: string | null;
  /** Whether this action may search and read. Ask never does. */
  readonly allowResearch?: boolean;
  /** Why the application read the instruction that way. */
  readonly reading: string;
}

export interface AssistantActionView {
  readonly intent: AssistantIntent;
  readonly targetType: "project" | "section";
  readonly targetId: string | null;
  readonly scope: string;
  readonly allowResearch: boolean;
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
  /**
   * Asks the assistant something, or asks it for a scoped edit.
   *
   * The application has already decided the intent and, for an Edit, the
   * target; this issues the grant those permissions turn into and starts the
   * run under it. A caller cannot ask for an intent the product does not have,
   * because the intent decides which writes the service will accept.
   */
  startAssistant(taskId: string, input: AssistantActionInput): AssistantActionView | undefined;
  /**
   * A user-asked research action on a task that already exists.
   *
   * It runs under the same budget a gap round does, and — critically — a task
   * that already has a report does not get a new one written at the end: the
   * material changes, the report is marked for review, and its text and hash
   * stay exactly as they were.
   */
  startResearchAction(
    taskId: string,
    input: { readonly text: string; readonly reading: string; readonly allowResearch?: boolean },
  ): { readonly intent: "research"; readonly scope: string; readonly gapRoundsRemaining: number } | undefined;
  /** Marks records left `running` by a previous process as interrupted. */
  reconcileInterrupted(): void;
  /**
   * The answer an Ask run produced, read from the session's committed history.
   *
   * An Ask writes nothing, by design, so its answer is not in any store: it is
   * the assistant turn of the run's own turn id, and the session's history is
   * the one place it is kept. Reading it needs the run, so this is async and
   * memoized — the read is bounded and the answer of a settled run never
   * changes.
   */
  answerOf(runId: string): Promise<string | undefined>;
  /** The question an Ask action was started with, by the run it produced. */
  questionOf(runId: string): string | undefined;
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
  /** What the application authorized for this run; issued right before it starts. */
  readonly grant: {
    readonly intent: "ask" | "research" | "edit" | "draft" | "card";
    readonly allowResearch: boolean;
    readonly targetType: "none" | "project" | "section" | "report";
    readonly targetId: string | null;
    readonly scope: string;
  };
  /** Set for an Edit: the section the proposal must be limited to. */
  readonly targetSectionId?: string | null;
  /** Set for an Ask: the user's own question, for the action log. */
  readonly question?: string;
}

const STAGE_LABELS: Readonly<Record<ResearchStage, string>> = Object.freeze({
  card: "建立任务卡",
  research: "检索与读取",
  gap: "定向补查",
  report: "撰写章节",
  synthesis: "综合与校验",
  followup: "追加指令（旧记录）",
  ask: "提问",
  edit: "修改提案",
});

function stageLabel(stage: ResearchStage): string {
  return STAGE_LABELS[stage] ?? stage;
}

const STATUS_LABELS: Readonly<Record<MatrixCell["status"], string>> = Object.freeze({
  missing: "无依据",
  unassessed: "有片段待核对",
  limited: "有限支持",
  conflict: "冲突/不可比",
  reviewed: "已核对",
});

function cellLabel(cell: MatrixCell, task: ReportTask): string {
  const subject = task.subjects.find((candidate) => candidate.id === cell.subjectId)?.name ?? cell.subjectId;
  const dimension = task.dimensions.find((candidate) => candidate.id === cell.dimensionId)?.name ?? cell.dimensionId;
  return `${subject} × ${dimension}（${STATUS_LABELS[cell.status] ?? cell.status}）`;
}

/**
 * Which sections each writing pass submits.
 *
 * One pass cannot write the whole report: the Core's step budget is part of the
 * approved resource profile, and a six-section report with its claims does not
 * fit inside it. The split is by cognitive responsibility rather than by size —
 * the first pass declares the question and explains how the objects work
 * (frame, mental model, mechanism, per-object identity); the second compares
 * them under shared conditions, synthesises across sources, states the limits
 * and publishes.
 */
const REPORT_PASS_SECTIONS: readonly string[] = Object.freeze(["overview", "mental-model", "mechanism", "representative"]);
const SYNTHESIS_PASS_SECTIONS: readonly string[] = Object.freeze(["comparison", "synthesis", "limitations", "reading"]);

/**
 * The blueprint's sections as instruction lines, for one writing pass.
 *
 * The list comes from the blueprint the task was created under, so what the
 * model is asked to write and what the validator will hold it to are the same
 * list; `include` only decides which pass submits which section.
 */
function blueprintSectionLines(blueprintId?: string, include?: readonly string[]): readonly string[] {
  const blueprint = blueprintById(blueprintId);
  if (blueprint === undefined) {
    return ["- 必需章节：overview / representative / comparison / limitations（旧结构任务）。"];
  }
  const sections = include === undefined ? blueprint.sections : blueprint.sections.filter((section) => include.includes(section.id));
  return sections
    .slice()
    .sort((a, b) => Number(b.required) - Number(a.required))
    .map((section) => {
      const mark = section.required ? "必需" : "可选";
      return `  · ${section.id}（${mark}｜${section.title}）：${section.cognitivePurpose}；须回答：${section.requiredQuestions.join("；")}；篇幅：${section.budget}`;
    });
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
  readonly stage: "synthesis";
  readonly task: ReportTask;
  readonly reportBrief: string;
}): string;
export function stageInstruction(input: {
  readonly stage: "ask";
  readonly task: ReportTask;
  readonly question: string;
}): string;
export function stageInstruction(input: {
  readonly stage: "edit";
  readonly task: ReportTask;
  readonly instruction: string;
  readonly targetSectionId: string;
}): string;
export function stageInstruction(input: {
  readonly stage: ResearchStage;
  readonly task?: ReportTask;
  readonly topicInput?: string;
  readonly question?: string;
  readonly instruction?: string;
  readonly targetSectionId?: string;
  readonly reportBrief?: string;
}): string {
  if (input.stage === "card") {
    return [
      "请为用户的研究主题建立研究任务卡。",
      "调用 propose_task（一次调用即可），字段要求：",
      "- 比较对象（subjects）2–4 个，是具体的技术/方法/系统名称；",
      "- 研究维度（dimensions）3–6 个，每个维度写成「要回答的问题」，而不是一个词（例如「索引构建、查询和更新分别产生什么可观察成本，来源是否在相同口径下报告」）；",
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
  const gapCells = task.matrix.filter((cell) => needsAttention(cell.status));

  switch (input.stage) {
    case "research":
      return [
        "任务卡已由用户确认，现在开始真实检索与读取。请按顺序执行：",
        "1) 用 search_sources 做 1–2 次检索（英文技术关键词，每次 limit 3–5），覆盖不同研究对象或不同维度；",
        "2) 用 read_source 读取最有代表性的 2–4 个候选：question 说明要回答什么，terms 给英文关键词，targetCell 指向该来源最能回答的矩阵单元格；",
        "3) 调用 assess_coverage 提交支持评估：每个单元格给出 relationship（supports/contradicts/contextual）、directness（direct/indirect/contextual/unassessed）、适用条件与理由。只绑定证据不给评估，单元格会停留在「待核对」。",
        `比较对象：${subjects}`,
        `研究维度：${dimensions}`,
        gapCells.length > 0
          ? `当前缺口（共 ${gapCells.length} 格，优先关注）：${gapCells.slice(0, 6).map((cell) => cellLabel(cell, task)).join("；")}`
          : "当前尚无任何证据，全部单元格都是缺口。",
        "本轮不要写报告；只做检索、读取与支持评估。若工具提示预算不足，就停止并说明。",
      ].join("\n");
    case "gap":
      return [
        `进入定向补查轮（已用 ${task.usage.gapRounds}/${task.budget.maxGapRounds} 轮）。请只针对下面的缺口做最少次数的补查：`,
        gapCells
          .slice(0, 3)
          .map((cell) => `- ${cellLabel(cell, task)}：${cell.gap.length > 0 ? cell.gap : cell.reason}`)
          .join("\n"),
        "可用手段：最多 1 次 search_sources（换更精确的英文关键词）或直接用已有未读来源做 read_source；读取时把 targetCell 指向对应单元格。",
        "完成后调用 assess_coverage（gapRound=true），并给出 relationship 与 directness。如果仍然没有公开依据，保持缺失或「有限支持」，不要用常识补写，也不要把间接材料写成直接支持。",
      ].join("\n");
    case "report":
      return [
        "请写这份技术比较报告的第一部分：声明研究框架与论断，然后解释对象如何工作。本阶段的步数预算有限，请用 save_report 分次提交：",
        "1) 先调用 load_research_state 确认可用的 evidenceId（只能引用它返回的 id）；",
        '2) {part:"start", title, summary, frame:{question, audience, scope}, claims:[...]}——frame 是报告自己的声明：研究问题是什么、给谁看、比较了哪些对象与哪类材料；claims 形状 {id,text,evidenceIds,claimType,subjects,dimensions,conditions,synthesis}；',
        '3) 每节一次 {part:"write", section:{id,title,blocks}}。本阶段要提交的章节与各自的认知义务：',
        ...blueprintSectionLines(task.blueprintId, REPORT_PASS_SECTIONS),
        "写作要求：",
        `- 比较对象：${subjects}；研究维度：${dimensions}；`,
        `- 全文篇幅目标：${task.lengthTarget}。这是写作预算而不是必须写满：每节只写支撑其义务所需的内容，宁精确勿冗长；机制块、表格与缺口说明不计入段落预算。`,
        "- mechanism 节必须有一个 mechanism 块：input / intermediate / steps（≥2 步）/ output / tradeoff / failure，都要写；",
        "- 机制判断优先引用 primary/official 来源；用 claim 的 dimensions 声明它回答了哪个研究维度；",
        "- 没有依据的项目写成 callout(tone=\"gap\")，不要用常识填空；",
        "- 各节的内容义务决定篇幅，没有全篇 claim 数上限；工具返回的 outstanding 只修正相关那一条，不要重写全部章节。",
        "本阶段不要调用 finalize，也不要写 comparison / synthesis / limitations：剩余章节由下一个阶段完成。",
        "写完这些章节后，用一两句话说明你提交了什么，然后停止。",
      ].join("\n");
    case "synthesis":
      return [
        "第一阶段已完成。现在写第二部分并校验发布：在共同条件下比较、跨来源综合、写明缺口。",
        input.reportBrief ?? "",
        "执行要求（步数预算有限，请按顺序做）：",
        "1) 用 load_research_state 复核矩阵与可用 evidenceId。",
        '2) 每节一次 {part:"write", section:{id,title,blocks}} 提交下面这些章节：',
        ...blueprintSectionLines(task.blueprintId, SYNTHESIS_PASS_SECTIONS),
        '3) 用 {part:"write", claims:[...]} 提交综合判断：claimType="synthesis"、synthesis=true、绑定 ≥2 条来自 ≥2 个不同来源的证据，conditions.scope 写明推断桥梁与适用边界；条件化建议用 claimType="implication" 并带 conditions.scope。',
        '4) 用 {part:"finalize"} 校验并发布。若返回 problems，只修正被指出的那一项后再次 finalize；不要为了通过校验删除诚实写出的缺口与限制。',
        "写作要求：",
        `- 全文篇幅目标：${task.lengthTarget}。这是写作预算而不是必须写满：每节只写支撑其义务所需的内容，宁精确勿冗长。`,
        "- comparison 节的表要写 columnDimensions（每列对应哪个研究维度 id）与 rowSubjects（每行是哪个对象 id），每列回答同一个问题；",
        "- 研究 frame 里的每个维度都要被处理：正文回答，或 callout(tone=\"gap\", dimensionIds=[维度 id]) 明确写出缺证据/不可比及原因；",
        "- 性能与成本判断要带 conditions（comparability / costStage），不可比就并列报告，不要排名；",
        "综合判断的最低标准：**它比逐篇摘要多给出了什么认识**——共性、关键差异、trade-off、冲突或研究空白——并且这些认识能回到各对象的证据。",
      ].join("\n");
    case "ask":
      return [
        "用户提出了一个问题。请只使用当前项目已有材料回答，不要写入任何正式数据。",
        "可用：load_research_state（读取任务卡、矩阵、来源与证据索引）。",
        "不可用：本次动作没有补查与写入授权，search_sources / read_source / assess_coverage / save_report / propose_section_edit 都会被服务端拒绝；不要反复尝试。",
        "回答要求：",
        "- 引用已有材料时只能引用工具返回的真实 id；材料没有覆盖的部分，明确说明「当前材料没有记录」；",
        "- 区分「材料里写了什么」与「你的推断」；不要用常识补齐来源；",
        "- 如果这次回答发现项目缺少关键材料，在回答末尾用一句话建议「转为补查（Research）」，由用户决定；不要自行检索。",
        "问题原文：",
        `"""${input.question ?? ""}"""`,
      ].join("\n");
    case "edit": {
      const targetSectionId = input.targetSectionId ?? "";
      return [
        "用户要求修改当前报告的指定目标。请只针对该目标生成一份修改提案，不要直接改写正文。",
        `目标章节：${targetSectionId}`,
        "提案的基线（报告 id、该章节当前内容、可用 evidenceId）与用户原话：",
        input.instruction ?? "",
        "执行要求：",
        "- 用 propose_section_edit 提交一次提案：section 为目标章节的替换内容（id 必须与目标一致；blocks 形状与 save_report 相同）；",
        "- 如果这次修改会影响摘要，必须同时显式提供 summary 字段，不要指望系统自动同步；",
        '- 新引入的论断必须绑定真实 evidenceId（可复用上面列出的 evidenceId）；拿不到依据的判断写成 callout(tone="gap")，或 kind="inference" 并绑定推断依据；',
        "- 如果被授权补查，最多做一次针对该章节问题的 search_sources 或 read_source，然后提交提案；",
        "- 报告正文在接受前不会改变：提交后简要说明「改了什么、依据是什么」，等待用户接受或放弃。",
      ].join("\n");
    }
    case "followup":
      // A stage value that only old records carry; new instructions never
      // reach it, and reading one back must not fail.
      return "（旧记录：该阶段已由 Ask / Research / Edit 动作取代。）";
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
  /** Ask answers already read back, keyed by the host run they belong to. */
  const answers = new Map<string, string>();
  /** How far back an Ask answer is looked for, in history pages. */
  const ANSWER_PAGES = 4;
  const ANSWER_PAGE_ITEMS = 30;
  /** The question each Ask run was started with, kept for the action log. */
  const questions = new Map<string, string>();

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

  /**
   * The text an Ask run has written so far.
   *
   * Only the model's own words are read — never a tool's — and only for the
   * Ask stage, whose answer *is* its text. A research or edit stage narrates
   * around its tool calls, and that narration is thinking, not a result.
   */
  function answerTextOf(runId: string): string | undefined {
    const snapshot = client.getSnapshot();
    const live: readonly LiveItem[] = snapshot.live[runId]?.live ?? [];
    const parts = live.flatMap((item) => (item.kind === "text" ? [item.text] : []));
    const text = parts.join("\n").trim();
    return text.length === 0 ? undefined : text;
  }

  async function readAnswer(runId: string): Promise<string | undefined> {
    const cached = answers.get(runId);
    if (cached !== undefined) return cached;
    // A running ask has no committed turn yet; the live timeline is how it is
    // read while it is still being written.
    const live = answerTextOf(runId);
    const run = await client.runs.get({ runId });
    const turnId = run.run.turnId;
    if (turnId === null || run.run.status === "accepted" || run.run.status === "running") {
      if (live !== undefined) answers.set(runId, live);
      return live;
    }
    // The answer is the assistant turn of the run's own turn id, and a session
    // holds many turns: the page carrying it may be several pages back, so the
    // read walks backwards until the turn is found or the history runs out. It
    // is bounded on purpose — an answer nobody can find in four pages is not
    // worth an unbounded read of a whole session.
    let cursor: string | undefined;
    let text = "";
    for (let page = 0; page < ANSWER_PAGES && text.length === 0; page += 1) {
      const result = await client.sessions.history({
        sessionId: run.run.sessionId,
        limit: ANSWER_PAGE_ITEMS,
        ...(cursor === undefined ? {} : { cursor }),
      });
      text = result.page.items
        .flatMap((item) => (item.kind === "assistant" && item.turnId === turnId ? [item.text.trim()] : []))
        .filter((part) => part.length > 0)
        .join("\n");
      cursor = result.page.nextCursor ?? undefined;
      if (cursor === undefined) break;
    }
    const answer = text.length === 0 ? live : text;
    if (answer !== undefined) answers.set(runId, answer);
    return answer;
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

    // The permission this run acts under, minted here and nowhere earlier: the
    // stage decides what the run may write, not the model and not the prompt.
    service.issueGrant({
      sessionId: request.sessionId,
      intent: request.grant.intent,
      taskId: request.taskId,
      targetType: request.grant.targetType,
      targetId: request.grant.targetId,
      scope: request.grant.scope,
      allowResearch: request.grant.allowResearch,
      ...(task === undefined || task.currentReportId === null ? {} : { baseReportId: task.currentReportId }),
    });

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
      if (request.question !== undefined) questions.set(runId, request.question);
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

    // The action is over, so the permission it carried is over too: a later run
    // gets its own grant, and nothing that is still settling can keep writing.
    if (!runFailed) service.clearGrant(request.sessionId);
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

  /** What each program-driven stage is allowed to do while it runs. */
  const STAGE_GRANTS: Readonly<Record<"card" | "research" | "gap" | "report" | "synthesis", StageRequest["grant"]>> = Object.freeze({
    card: {
      intent: "card",
      allowResearch: false,
      targetType: "project",
      targetId: null,
      scope: "建立研究任务卡（不检索）",
    },
    research: {
      intent: "research",
      allowResearch: true,
      targetType: "project",
      targetId: null,
      scope: "检索、读取并保存证据与支持评估；不修改报告正文",
    },
    gap: {
      intent: "research",
      allowResearch: true,
      targetType: "project",
      targetId: null,
      scope: "针对矩阵缺口的定向补查；不修改报告正文",
    },
    report: {
      intent: "draft",
      allowResearch: true,
      targetType: "report",
      targetId: null,
      scope: "撰写并保存本任务的报告版本",
    },
    synthesis: {
      intent: "draft",
      allowResearch: true,
      targetType: "report",
      targetId: null,
      scope: "综合判断、按校验问题修正并发布报告版本",
    },
  });

  /**
   * The synthesis stage's brief: what has been written, and what is still
   * wrong with it.
   *
   * The validator runs over the accumulated draft *before* the synthesis pass,
   * so the model concludes from a draft it has already been told the problems
   * of — repair and synthesis in one pass instead of a finalize-and-retry loop.
   */
  function synthesisBrief(taskId: string): string {
    const draft = service.reportDraftOf(taskId);
    if (draft === null) return "（本任务还没有已保存的报告草稿；请直接用 save_report 从 {part:\"start\"} 开始补写。）";
    const preview = service.previewDraftValidation(taskId);
    const sections = draft.sections.map((section) => section.id).join("、");
    const claims = draft.claims
      .slice(0, 24)
      .map((claim) => `${claim.id}[${claim.claimType ?? "fact"}${claim.synthesis === true ? ",synthesis" : ""}]`)
      .join("；");
    return [
      "当前草稿：",
      `- 标题：${draft.title}`,
      `- frame：${draft.frame === undefined ? "（未声明）" : `${draft.frame.question}｜${draft.frame.scope}`}`,
      `- 已提交章节：${sections || "（无）"}`,
      `- 已提交 claims：${claims || "（无）"}`,
      preview === null || preview.problems.length === 0
        ? "- 校验预检：没有结构性问题"
        : `- 校验预检问题（必须在 finalize 前修正）：\n${preview.problems.slice(0, 8).map((problem) => `    · ${problem}`).join("\n")}`,
      preview === null || preview.warnings.length === 0
        ? ""
        : `- 校验预检提醒（不阻止发布，但应处理或在正文说明）：\n${preview.warnings.slice(0, 6).map((warning) => `    · ${warning}`).join("\n")}`,
    ]
      .filter((line) => line.length > 0)
      .join("\n");
  }

  /** What the program does once a stage settles: the next bounded step, or a stop. */
  async function afterStage(request: StageRequest, readsBefore: number, runFailed: boolean): Promise<void> {
    const task = request.taskId === null ? undefined : service.getTask(request.taskId);
    if (task === undefined) return;
    const sessionId = request.sessionId;

    switch (request.stage) {
      case "card":
      case "ask":
      case "edit":
      case "followup":
        return;
      case "research": {
        if (task.usage.reads === 0) {
          // Nothing was read, so there is nothing to assess or report on. The
          // task keeps its materials and the workspace offers a retry.
          service.failTask(task.id, "研究阶段没有成功读取任何来源；可以重试或更换主题。");
          return;
        }
        // A task that already has a report is never re-written by research:
        // the material changes, the report is flagged, and the text stays.
        if (task.currentReportId !== null) return;
        const gaps = task.matrix.filter((cell) => needsAttention(cell.status));
        if (runFailed) {
          // A stage that ended in an error does not get to spend another round:
          // whatever was read is written up honestly, gaps included.
          enqueue({
            taskId: task.id,
            sessionId,
            stage: "report",
            instruction: stageInstruction({ stage: "report", task }),
            grant: STAGE_GRANTS.report,
          });
          return;
        }
        if (gaps.length > 0 && gapStagesSoFar(task.id) < task.budget.maxGapRounds) {
          enqueue({
            taskId: task.id,
            sessionId,
            stage: "gap",
            instruction: stageInstruction({ stage: "gap", task }),
            grant: STAGE_GRANTS.gap,
          });
          return;
        }
        enqueue({
          taskId: task.id,
          sessionId,
          stage: "report",
          instruction: stageInstruction({ stage: "report", task }),
          grant: STAGE_GRANTS.report,
        });
        return;
      }
      case "gap": {
        const refreshed = service.getTask(task.id);
        if (refreshed === undefined) return;
        // Same rule as above:补查 on a task that has a report ends with the
        // material, not with a new version of the report.
        if (refreshed.currentReportId !== null) return;
        const gaps = refreshed.matrix.filter((cell) => needsAttention(cell.status));
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
            grant: STAGE_GRANTS.gap,
          });
          return;
        }
        enqueue({
          taskId: refreshed.id,
          sessionId,
          stage: "report",
          instruction: stageInstruction({ stage: "report", task: refreshed }),
          grant: STAGE_GRANTS.report,
        });
        return;
      }
      case "report": {
        const settled = service.getTask(task.id);
        if (settled === undefined) return;
        // The report stage writes the sections; synthesis is its own run for two
        // reasons: a section pass plus a synthesis pass plus validation does not
        // fit in one step budget, and synthesis is a distinct cognitive step
        // that deserves its own instruction rather than being the last paragraph
        // of whatever section happened to be open.
        if (settled.currentReportId === null) {
          enqueue({
            taskId: settled.id,
            sessionId,
            stage: "synthesis",
            instruction: stageInstruction({ stage: "synthesis", task: settled, reportBrief: synthesisBrief(settled.id) }),
            grant: STAGE_GRANTS.synthesis,
          });
          return;
        }
        await afterReportSaved(settled);
        return;
      }
      case "synthesis": {
        const settled = service.getTask(task.id);
        if (settled === undefined) return;
        if (settled.currentReportId === null) {
          // The draft's own outstanding obligations are the most useful thing to
          // leave in the log: the pass ended, and this says what it still owed.
          const preview = service.previewDraftValidation(settled.id);
          log(
            `[runner] report was not saved for ${settled.id}: ${(preview?.problems ?? ["草稿校验未通过"]).slice(0, 6).join("；")}`,
          );
          service.failTask(settled.id, "报告阶段结束但没有保存有效报告；可以在工作台重新生成。");
          return;
        }
        await afterReportSaved(settled);
        return;
      }
    }
  }

  /** What happens once a validated report exists: export the PDF, and stop. */
  async function afterReportSaved(settled: ReportTask): Promise<void> {
    if (options.exportPdf === undefined) return;
    const exported = await options.exportPdf(settled.id);
    log(
      exported.ok
        ? `[runner] PDF exported for ${settled.id}`
        : `[runner] PDF export failed for ${settled.id}: ${exported.failure ?? "unknown"}`,
    );
  }

  return {
    startCard(sessionId, topicInput) {
      cardAttempts.set(sessionId, 0);
      enqueue({
        taskId: null,
        sessionId,
        stage: "card",
        instruction: stageInstruction({ stage: "card", topicInput }),
        grant: STAGE_GRANTS.card,
      });
    },
    startResearch(taskId) {
      const task = service.getTask(taskId);
      if (task === undefined) return;
      enqueue({
        taskId,
        sessionId: task.sessionId,
        stage: "research",
        instruction: stageInstruction({ stage: "research", task }),
        grant: STAGE_GRANTS.research,
      });
    },
    startGapRound(taskId) {
      const task = service.getTask(taskId);
      if (task === undefined) return;
      enqueue({
        taskId,
        sessionId: task.sessionId,
        stage: "gap",
        instruction: stageInstruction({ stage: "gap", task }),
        grant: STAGE_GRANTS.gap,
      });
    },
    startReport(taskId) {
      const task = service.getTask(taskId);
      if (task === undefined) return;
      enqueue({
        taskId,
        sessionId: task.sessionId,
        stage: "report",
        instruction: stageInstruction({ stage: "report", task }),
        grant: STAGE_GRANTS.report,
      });
    },

    startAssistant(taskId, input) {
      const task = service.getTask(taskId);
      if (task === undefined) return undefined;
      const targetSectionId = input.targetSectionId ?? null;
      if (input.intent === "edit") {
        const report =
          task.currentReportId === null ? undefined : service.reportsOf(taskId).find((candidate) => candidate.id === task.currentReportId);
        if (report === undefined) return undefined;
        const section = report.sections.find((candidate) => candidate.id === targetSectionId);
        if (section === undefined) return undefined;
        const evidenceIndex = service.evidenceOf(taskId).map((item) => ({
          evidenceId: item.id,
          sourceId: item.sourceId,
          scope: item.readScope,
          excerpt: item.excerpt.length > 160 ? `${item.excerpt.slice(0, 160)}…` : item.excerpt,
        }));
        const payload = [
          `报告 id：${report.id}（内容 hash ${report.contentHash ?? "（旧记录未记录 hash，提案只锁定章节内容）"}）`,
          `章节当前内容：${JSON.stringify({ id: section.id, title: section.title, blocks: section.blocks })}`,
          `可用 evidenceId（最多列出 20 条）：${JSON.stringify(evidenceIndex.slice(0, 20))}`,
          `用户原话："""${input.text}"""`,
        ].join("\n");
        const view = {
          intent: "edit" as const,
          targetType: "section" as const,
          targetId: section.id,
          scope: `只针对章节「${section.title}」生成修改提案；接受前正文不变`,
          allowResearch: input.allowResearch ?? true,
        };
        enqueue({
          taskId,
          sessionId: task.sessionId,
          stage: "edit",
          instruction: stageInstruction({ stage: "edit", task, instruction: payload, targetSectionId: section.id }),
          grant: {
            intent: "edit",
            allowResearch: view.allowResearch,
            targetType: "section",
            targetId: section.id,
            scope: view.scope,
          },
          targetSectionId: section.id,
        });
        return view;
      }
      const view = {
        intent: "ask" as const,
        targetType: "project" as const,
        targetId: null,
        scope: "只读取材料回答问题，不写入任何正式数据",
        allowResearch: false,
      };
      enqueue({
        taskId,
        sessionId: task.sessionId,
        stage: "ask",
        instruction: stageInstruction({ stage: "ask", task, question: input.text }),
        grant: { intent: "ask", allowResearch: false, targetType: "project", targetId: null, scope: view.scope },
        question: input.text,
      });
      return view;
    },

    startResearchAction(taskId, input) {
      const task = service.getTask(taskId);
      if (task === undefined) return undefined;
      if (task.usage.gapRounds >= task.budget.maxGapRounds) return undefined;
      const instruction = [
        stageInstruction({ stage: "gap", task }),
        "",
        `用户提出的补查要求（${input.reading}）：`,
        `"""${input.text}"""`,
        task.currentReportId === null
          ? "完成后由程序决定是否继续补查或生成报告。"
          : "本任务已有报告：只补充材料与支持评估，不要保存报告；报告正文会保持不变，相关目标会被标记为待复核。",
      ].join("\n");
      enqueue({
        taskId,
        sessionId: task.sessionId,
        stage: "gap",
        instruction,
        grant: STAGE_GRANTS.gap,
      });
      return {
        intent: "research",
        scope: "围绕用户提出的问题定向补查；不修改报告正文",
        gapRoundsRemaining: Math.max(0, task.budget.maxGapRounds - task.usage.gapRounds),
      };
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
    answerOf: readAnswer,
    questionOf: (runId) => questions.get(runId),
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
