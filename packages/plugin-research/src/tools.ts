/**
 * The six research tools, as the model sees them.
 *
 * Each tool is a thin, strict adapter over the research service: it resolves
 * the task from the *session* the runtime handed it — never from an argument —
 * validates the model's parameters, spends at most the task's remaining budget,
 * and answers with a bounded JSON result. The tool descriptions are part of the
 * product: they are where the model is told that a search hit is not evidence,
 * that only saved excerpts may be cited, and that a missing answer must be
 * written as missing rather than filled in.
 */

import type { Tool } from "@every-dagent/agent-core";

import type {
  CellRef,
  ClaimConditions,
  ClaimType,
  Comparability,
  CostStage,
  ReportBlock,
  ReportClaim,
  ReportFrame,
  ReportSection,
  SourceRole,
} from "./domain.js";
import type { ResearchService } from "./service.js";

/** The largest tool answer this product writes, well under the Core's item cap. */
export const MAX_TOOL_RESULT_CHARS = 7_000;

/**
 * A JSON answer, guaranteed small enough to travel.
 *
 * Tool results are observations, not storage: the full text lives in the
 * business database and the model asks for what it needs by id. When an answer
 * is too large anyway, this trims it deterministically — note first, then the
 * longest strings, then array tails — so the model always receives parseable
 * JSON and always learns that it saw a trimmed view.
 */
export function boundedJson(value: unknown, maxChars = MAX_TOOL_RESULT_CHARS): string {
  const encode = (candidate: unknown): string => JSON.stringify(candidate);
  let encoded = encode(value);
  if (encoded.length <= maxChars) return encoded;

  const trim = (candidate: unknown, depth: number): unknown => {
    if (typeof candidate === "string") {
      const limit = depth === 0 ? 400 : 200;
      return candidate.length > limit ? `${candidate.slice(0, limit)}…` : candidate;
    }
    if (Array.isArray(candidate)) {
      const kept = candidate.slice(0, depth === 0 ? 6 : 3).map((item) => trim(item, depth + 1));
      if (candidate.length > kept.length) kept.push(`…(+${candidate.length - kept.length} more, trimmed)`);
      return kept;
    }
    if (typeof candidate === "object" && candidate !== null) {
      const result: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(candidate)) result[key] = trim(item, depth + 1);
      return result;
    }
    return candidate;
  };

  const trimmed = { truncated: true, note: "结果已裁剪：需要完整信息请通过 id 定向查询", data: trim(value, 0) };
  encoded = encode(trimmed);
  if (encoded.length <= maxChars) return encoded;
  return encode({ truncated: true, note: "结果已裁剪", data: trim(value, 1) }).slice(0, maxChars);
}

/** Reads a tool argument as the closed shape the tool expects, or refuses. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function asCellRef(value: unknown, fallbackSection?: string): CellRef | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const sectionId = asString(record["sectionId"]) ?? fallbackSection ?? "comparison";
  const subjectId = asString(record["subjectId"]);
  const dimensionId = asString(record["dimensionId"]);
  if (subjectId === undefined || dimensionId === undefined) return undefined;
  return { sectionId, subjectId, dimensionId };
}

/** Reads a relationship, keeping unknown values out rather than guessing one. */
function asRelationship(value: unknown): "supports" | "contradicts" | "contextual" | undefined {
  return value === "supports" || value === "contradicts" || value === "contextual" ? value : undefined;
}

function asDirectness(value: unknown): "direct" | "indirect" | "contextual" | "unassessed" | undefined {
  return value === "direct" || value === "indirect" || value === "contextual" || value === "unassessed" ? value : undefined;
}

const CLAIM_TYPES: readonly ClaimType[] = ["fact", "mechanism", "comparison", "performance", "cost", "synthesis", "implication"];
const COST_STAGES: readonly CostStage[] = ["indexing", "query", "update", "operational"];
const COMPARABILITIES: readonly Comparability[] = ["comparable", "partially-comparable", "not-directly-comparable", "unknown"];
const BASES = ["author-reported", "external-evaluation", "our-analysis"] as const;
const SOURCE_ROLES: readonly SourceRole[] = ["primary", "official", "independent-evaluation", "survey", "contextual", "user-provided"];

function asClaimType(value: unknown): ClaimType | undefined {
  return typeof value === "string" && (CLAIM_TYPES as readonly string[]).includes(value) ? (value as ClaimType) : undefined;
}

/** Reads the conditions object, keeping only fields the contract defines. */
function asConditions(value: unknown): ClaimConditions | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const conditions: Record<string, unknown> = {};
  const strings = ["scope", "task", "dataset", "metric", "baseline", "setting"] as const;
  for (const key of strings) {
    const text = asString(record[key]);
    if (text !== undefined) conditions[key] = text;
  }
  const costStage = record["costStage"];
  if (typeof costStage === "string" && (COST_STAGES as readonly string[]).includes(costStage)) conditions["costStage"] = costStage;
  const comparability = record["comparability"];
  if (typeof comparability === "string" && (COMPARABILITIES as readonly string[]).includes(comparability)) {
    conditions["comparability"] = comparability;
  }
  const basis = record["basis"];
  if (typeof basis === "string" && (BASES as readonly string[]).includes(basis)) conditions["basis"] = basis;
  return Object.keys(conditions).length === 0 ? undefined : (conditions as ClaimConditions);
}

function asFrame(value: unknown): ReportFrame | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const question = asString(record["question"]);
  const audience = asString(record["audience"]);
  const scope = asString(record["scope"]);
  if (question === undefined && audience === undefined && scope === undefined) return undefined;
  return { question: question ?? "", audience: audience ?? "", scope: scope ?? "" };
}

function refuse(message: string, guidance: string): string {
  return boundedJson({ ok: false, problem: message, guidance });
}

export interface ResearchTools {
  readonly tools: readonly Tool[];
  /** The same objects, by name, for the trusted policy's catalogue. */
  readonly byName: Readonly<Record<string, Tool>>;
}

/**
 * Builds the tool set.
 *
 * `taskOfSession` is the trusted binding: the runtime's session id is resolved
 * through the application's own record, so a model that invents a task id
 * cannot make a tool write into another research task.
 */
export function createResearchTools(service: ResearchService): ResearchTools {
  const taskFor = (sessionId: string): { readonly taskId: string } | undefined => {
    const task = service.taskForSession(sessionId);
    return task === undefined ? undefined : { taskId: task.id };
  };

  const noTask = (): string =>
    refuse(
      "当前会话还没有研究任务绑定。",
      "请先调用 propose_task 建立任务卡；用户确认后再开始检索。",
    );

  const proposeTask: Tool = {
    name: "propose_task",
    description:
      "为用户的研究主题建立/更新一页研究任务卡（Research Task Card）：主题、目的、读者、关注点、2–4 个比较对象、3–6 个研究维度。" +
      "只保存模型提议的草稿，不代表用户已确认。同一个会话只有一个任务；用户确认后本工具不能再改。",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "研究主题（一句话）" },
        purpose: { type: "string", description: "研究用途，例如组会汇报、技术选型" },
        audience: { type: "string", description: "读者背景" },
        focus: { type: "array", items: { type: "string" }, description: "本次重点关注的方面" },
        exclusions: { type: "string", description: "明确不研究的内容" },
        lengthTarget: { type: "string", description: "篇幅目标，例如 约 4–6 页" },
        subjects: {
          type: "array",
          description: "2–4 个比较对象（技术/方法/产品名）",
          items: {
            type: "object",
            properties: { name: { type: "string" }, note: { type: "string" } },
            required: ["name"],
          },
        },
        dimensions: {
          type: "array",
          description: "3–6 个研究维度，将驱动证据矩阵",
          items: {
            type: "object",
            properties: { name: { type: "string" }, question: { type: "string" } },
            required: ["name"],
          },
        },
      },
      required: ["topic", "subjects"],
    },
    async execute(input: unknown, context) {
      const record = asRecord(input);
      if (record === undefined) return refuse("参数必须是对象", "请按 schema 提供任务卡字段。");
      const topic = asString(record["topic"]);
      if (topic === undefined) return refuse("缺少 topic", "请给出研究主题。");
      const subjects = Array.isArray(record["subjects"])
        ? record["subjects"].map((item) => {
            const entry = asRecord(item) ?? {};
            return {
              name: asString(entry["name"]) ?? "",
              ...(asString(entry["note"]) === undefined ? {} : { note: asString(entry["note"]) as string }),
            };
          })
        : [];
      const dimensions = Array.isArray(record["dimensions"])
        ? record["dimensions"].map((item) => {
            const entry = asRecord(item) ?? {};
            return { name: asString(entry["name"]) ?? "", question: asString(entry["question"]) ?? "" };
          })
        : [];

      const result = service.proposeTask(context.sessionId, {
        topic,
        purpose: asString(record["purpose"]) ?? "",
        audience: asString(record["audience"]) ?? "",
        focus: asStringArray(record["focus"]),
        exclusions: asString(record["exclusions"]) ?? "",
        lengthTarget: asString(record["lengthTarget"]) ?? "",
        subjects,
        dimensions,
      });
      if (!result.ok) {
        return boundedJson({ ok: false, problems: result.problems, guidance: result.guidance });
      }
      const task = result.task;
      // The card is a draft and is validated as one while it is still a draft:
      // saying so here, while the model is still running, is the moment it can
      // fix it. A card missing its research question or audience cannot be
      // confirmed, and the user should never receive a brief that can only be
      // started after they repair it by hand.
      const brief = service.briefOf(task.id);
      return boundedJson({
        ok: true,
        created: result.created,
        taskId: task.id,
        confirmed: task.confirmedAt !== null,
        card: {
          topic: task.topic,
          purpose: task.purpose,
          audience: task.audience,
          focus: task.focus,
          lengthTarget: task.lengthTarget,
        },
        subjects: task.subjects.map((subject) => ({ id: subject.id, name: subject.name })),
        dimensions: task.dimensions.map((dimension) => ({ id: dimension.id, name: dimension.name, question: dimension.question })),
        matrixCells: task.matrix.length,
        briefVersion: brief.version,
        briefValidation: brief.validation,
        next: !brief.validation.valid
          ? `任务卡还不完整：${brief.validation.problems.join("；")}。请再次调用 propose_task 补全这些字段（用户只能在界面确认完整的研究简报）。`
          : task.confirmedAt === null
            ? "等待用户在界面确认任务卡；确认前不要检索。"
            : "任务卡已确认，可以开始 search_sources。",
      });
    },
  };

  const searchSources: Tool = {
    name: "search_sources",
    description:
      "在 arXiv 检索公开技术论文候选（真实网络请求）。返回的是候选 metadata（标题/作者/年份/链接/摘要），不是已读证据。" +
      "要用英文技术关键词检索。可指定 targetCell 说明这次检索服务于哪个矩阵单元格。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "英文检索词，例如 GraphRAG community summarization" },
        limit: { type: "number", description: "候选数量上限（默认 5）" },
        targetCell: {
          type: "object",
          description: "本次检索服务的目标单元格",
          properties: {
            sectionId: { type: "string" },
            subjectId: { type: "string" },
            dimensionId: { type: "string" },
          },
          required: ["subjectId", "dimensionId"],
        },
      },
      required: ["query"],
    },
    async execute(input, context) {
      const binding = taskFor(context.sessionId);
      if (binding === undefined) return noTask();
      const record = asRecord(input);
      const query = record === undefined ? undefined : asString(record["query"]);
      if (query === undefined) return refuse("缺少 query", "请提供英文检索词。");
      const limitValue = record === undefined ? undefined : record["limit"];
      const limit = typeof limitValue === "number" && Number.isFinite(limitValue) ? Math.trunc(limitValue) : undefined;
      const targetCell = record === undefined ? undefined : asCellRef(record["targetCell"]);

      const result = await service.search(binding.taskId, {
        query,
        ...(limit === undefined ? {} : { limit }),
        ...(targetCell === undefined ? {} : { targetCell }),
        signal: context.signal,
      });
      if (!result.ok) return boundedJson({ ok: false, problems: result.problems, guidance: result.guidance });
      return boundedJson(result);
    },
  };

  const readSource: Tool = {
    name: "read_source",
    description:
      "真实读取一个候选来源并保存读取快照：arXiv 论文优先取 HTML 正文（full_text / body_excerpt），没有正文时退回论文摘要（abstract）。" +
      "工具会从保存的文本中切出与 question/terms 最相关的 1–5 条证据片段（excerpt 为原文原样字符，带位置）。" +
      "只有这里产生的 evidenceId 才能被报告引用；搜索摘要不能当证据。读取失败会如实记录失败状态。\n" +
      "role：你读完材料后判断这条来源是什么——primary（原始方法/原始研究）、official（官方文档/实现说明）、independent-evaluation（第三方评估）、" +
      "survey（综述/转述）、contextual（背景资料）。角色的用途只有一个：机制论断优先绑定 primary/official，用 survey 代替时要说明。",
    inputSchema: {
      type: "object",
      properties: {
        sourceId: { type: "string", description: "search_sources 返回的 sourceId" },
        question: { type: "string", description: "这次读取要回答的问题（例如该方法的图构建步骤是什么）" },
        terms: { type: "array", items: { type: "string" }, description: "英文关键词，用于选择片段" },
        role: {
          type: "string",
          enum: ["primary", "official", "independent-evaluation", "survey", "contextual", "user-provided"],
          description: "这条来源在这次研究中的角色",
        },
        targetCell: {
          type: "object",
          description: "这些证据要绑定到的矩阵单元格",
          properties: {
            sectionId: { type: "string" },
            subjectId: { type: "string" },
            dimensionId: { type: "string" },
          },
          required: ["subjectId", "dimensionId"],
        },
        maxEvidence: { type: "number", description: "切出的证据条数上限（默认 3，最多 5）" },
        paragraphIndex: { type: "number", description: "指定段落序号直接建立证据（可选）" },
      },
      required: ["sourceId", "question"],
    },
    async execute(input, context) {
      const binding = taskFor(context.sessionId);
      if (binding === undefined) return noTask();
      const record = asRecord(input);
      const sourceId = record === undefined ? undefined : asString(record["sourceId"]);
      const question = record === undefined ? undefined : asString(record["question"]);
      if (sourceId === undefined) return refuse("缺少 sourceId", "请使用 search_sources 返回的 sourceId。");
      if (question === undefined) return refuse("缺少 question", "请说明这次读取要回答什么问题。");
      const targetCell = record === undefined ? undefined : asCellRef(record["targetCell"]);
      const roleValue = record === undefined ? undefined : record["role"];
      const role =
        typeof roleValue === "string" && (SOURCE_ROLES as readonly string[]).includes(roleValue) ? (roleValue as SourceRole) : undefined;
      const maxEvidenceValue = record === undefined ? undefined : record["maxEvidence"];
      const maxEvidence =
        typeof maxEvidenceValue === "number" && Number.isFinite(maxEvidenceValue) ? Math.trunc(maxEvidenceValue) : undefined;
      const paragraphIndexValue = record === undefined ? undefined : record["paragraphIndex"];
      const paragraphIndex =
        typeof paragraphIndexValue === "number" && Number.isFinite(paragraphIndexValue) ? Math.trunc(paragraphIndexValue) : undefined;

      const result = await service.read(binding.taskId, {
        sourceId,
        question,
        terms: asStringArray(record?.["terms"]),
        ...(targetCell === undefined ? {} : { targetCell }),
        ...(role === undefined ? {} : { role }),
        ...(maxEvidence === undefined ? {} : { maxEvidence }),
        ...(paragraphIndex === undefined ? {} : { paragraphIndex }),
        signal: context.signal,
      });
      if (!result.ok) return boundedJson({ ok: false, problems: result.problems, guidance: result.guidance });
      return boundedJson(result);
    },
  };

  const assessCoverage: Tool = {
    name: "assess_coverage",
    description:
      "保存对证据矩阵的支持评估：对每个单元格说明「已有片段如何支持/反对/仅作为背景」，并给出直接性与适用条件。" +
      "必须分别提交 relationship（supports/contradicts/contextual）与 directness（direct/indirect/contextual/unassessed）：" +
      "只有「supports + direct + 正文级片段」才会把单元格推进到 reviewed（已核对，不表示结论已被证明为真）；" +
      "只绑定证据而不给评估，单元格停留在 unassessed（有片段，待核对）。" +
      "单元格状态始终由程序根据真实证据与已保存评估推导，模型不能直接指定状态。" +
      "返回尚未达到 reviewed 的格子，用于决定是否定向补查（gapRound=true 表示开始一轮定向补查，受轮次预算限制）。",
    inputSchema: {
      type: "object",
      properties: {
        proposals: {
          type: "array",
          description: "每个要评估的单元格",
          items: {
            type: "object",
            properties: {
              cell: {
                type: "object",
                properties: {
                  sectionId: { type: "string" },
                  subjectId: { type: "string" },
                  dimensionId: { type: "string" },
                },
                required: ["subjectId", "dimensionId"],
              },
              evidenceIds: { type: "array", items: { type: "string" }, description: "支持/反对该单元格的 evidenceId" },
              relationship: {
                type: "string",
                enum: ["supports", "contradicts", "contextual"],
                description: "该片段与这个单元格问题的关系",
              },
              directness: {
                type: "string",
                enum: ["direct", "indirect", "contextual", "unassessed"],
                description: "该片段是否直接涉及所问的对象、关系和条件；不确定就写 unassessed",
              },
              scope: { type: "string", description: "支持成立的适用范围与条件（例如「仅作者自报，未与共同口径对比」）" },
              note: { type: "string", description: "理由，会作为评估的 rationale 保存" },
            },
            required: ["cell", "evidenceIds", "relationship", "directness"],
          },
        },
        gapRound: { type: "boolean", description: "这一轮是否算作定向补查轮" },
      },
      required: ["proposals"],
    },
    async execute(input, context) {
      const binding = taskFor(context.sessionId);
      if (binding === undefined) return noTask();
      const record = asRecord(input);
      const rawProposals = record === undefined ? undefined : record["proposals"];
      const proposals: {
        cell: CellRef;
        evidenceIds: readonly string[];
        note?: string;
        relationship?: "supports" | "contradicts" | "contextual";
        directness?: "direct" | "indirect" | "contextual" | "unassessed";
        scope?: string;
        rationale?: string;
      }[] = [];
      if (Array.isArray(rawProposals)) {
        for (const item of rawProposals) {
          const entry = asRecord(item) ?? {};
          const cell = asCellRef(entry["cell"]);
          if (cell === undefined) continue;
          const note = asString(entry["note"]);
          const relationship = asRelationship(entry["relationship"]);
          const directness = asDirectness(entry["directness"]);
          const scope = asString(entry["scope"]);
          proposals.push({
            cell,
            evidenceIds: asStringArray(entry["evidenceIds"]),
            ...(note === undefined ? {} : { note }),
            ...(relationship === undefined ? {} : { relationship }),
            ...(directness === undefined ? {} : { directness }),
            ...(scope === undefined ? {} : { scope }),
            ...(note === undefined ? {} : { rationale: note }),
          });
        }
      }
      const result = service.assess(binding.taskId, {
        proposals,
        ...(record?.["gapRound"] === true ? { gapRound: true } : {}),
      });
      if (!result.ok) return boundedJson({ ok: false, problems: result.problems, guidance: result.guidance });
      return boundedJson({
        ok: true,
        cells: result.cells,
        gaps: result.gaps.slice(0, 6),
        gapRoundsUsed: result.gapRoundsUsed,
        gapRoundsRemaining: result.gapRoundsRemaining,
        note: result.note,
      });
    },
  };

  const loadResearchState: Tool = {
    name: "load_research_state",
    description:
      "读取当前研究任务的有界状态：任务卡、章节结构、比较对象、研究维度、证据矩阵（含缺口）、来源索引、证据索引、预算使用情况。" +
      "用于在长任务中恢复上下文；不会返回全文。矩阵状态由真实证据与已保存评估推导，可以据此判断哪些维度还缺依据。",
    inputSchema: { type: "object", properties: {}, required: [] },
    async execute(_input, context) {
      const binding = taskFor(context.sessionId);
      if (binding === undefined) return noTask();
      const state = service.state(binding.taskId);
      // The tool answer is an index, not a transcript: the model needs ids,
      // statuses and short labels to decide what to look at next, and the long
      // prose a reader sees in the workspace would push the payload past the
      // size the Core will carry.
      return boundedJson({
        ok: true,
        state: {
          task: {
            id: state.task.id,
            topic: state.task.topic,
            purpose: state.task.purpose,
            audience: state.task.audience,
            focus: state.task.focus,
            lengthTarget: state.task.lengthTarget,
            status: state.task.status,
            confirmed: state.task.confirmed,
          },
          structure: state.structure.map((section) => ({ id: section.id, title: section.title, question: section.question })),
          subjects: state.subjects,
          dimensions: state.dimensions,
          cells: state.cells.map((cell) => ({
            subjectId: cell.subjectId,
            dimensionId: cell.dimensionId,
            status: cell.status,
            evidenceIds: cell.evidenceIds,
            reason: cell.reason.length > 90 ? `${cell.reason.slice(0, 90)}…` : cell.reason,
            gap: cell.gap.length > 90 ? `${cell.gap.slice(0, 90)}…` : cell.gap,
          })),
          sources: state.sources.map((source) => ({
            sourceId: source.sourceId,
            title: source.title.length > 90 ? `${source.title.slice(0, 90)}…` : source.title,
            role: source.role,
            readStatus: source.readStatus,
            readScope: source.readScope,
          })),
          evidence: state.evidence.map((item) => ({
            evidenceId: item.evidenceId,
            sourceId: item.sourceId,
            scope: item.scope,
            locator: item.locator,
            excerpt: item.excerpt.length > 140 ? `${item.excerpt.slice(0, 140)}…` : item.excerpt,
          })),
          usage: state.usage,
          budget: state.budget,
          currentReportId: state.currentReportId,
          currentReportHash: state.currentReportHash,
          reportNeedsReview: state.reportNeedsReview,
          currentReport:
            state.currentReport === null
              ? null
              : {
                  reportId: state.currentReport.reportId,
                  title: state.currentReport.title,
                  summary: state.currentReport.summary,
                  sections: state.currentReport.sections,
                  claims: state.currentReport.claims.map((claim) => ({
                    id: claim.id,
                    text: claim.text.length > 120 ? `${claim.text.slice(0, 120)}…` : claim.text,
                    claimType: claim.claimType,
                    synthesis: claim.synthesis,
                  })),
                },
        },
      });
    },
  };

  const saveReport: Tool = {
    name: "save_report",
    description:
      "保存结构化研究报告（不是 HTML）。报告 = frame（研究问题/读者/范围）+ title + summary + sections（blocks）+ claims（每条 claim 绑定真实 evidenceId）。" +
      "只能在被授权撰写报告的阶段调用（生成报告 / 综合）；Research 动作只有补查权限，Edit 动作只能提交修改提案。\n" +
      "单次调用的输出有限（约 4096 tokens），长报告请分次提交：" +
      '先 {part:"start", title, summary, frame}，再 {part:"write", claims:[...]}，' +
      '然后每节一次 {part:"write", section:{...}}，最后 {part:"finalize"} 校验并发布。\n' +
      "claim 的 claimType 决定它被如何校验：" +
      'mechanism（机制：优先原始方法/官方来源）、comparison（比较：声明 subjects≥2 且每个对象都要有依据）、' +
      'performance（性能：必须声明 conditions.comparability，不可比时不要排名）、' +
      'cost（成本：必须声明 conditions.costStage，不同口径不能合成「更便宜」）、' +
      'synthesis（综合判断：必须 synthesis=true 且 ≥2 条来自不同来源的证据）、' +
      'implication（条件化建议：conditions.scope 必须写明成立条件）。\n' +
      "conditions 可选字段：scope / task / dataset / metric / baseline / setting / costStage(indexing|query|update|operational) / " +
      "basis(author-reported|external-evaluation|our-analysis) / comparability(comparable|partially-comparable|not-directly-comparable|unknown)。\n" +
      "block 种类：paragraph / list / table / callout / mechanism。" +
      "mechanism 块形状：{kind:'mechanism', title, input, intermediate, steps:[{text,claimIds}], output, tradeoff, failure, claimIds}——" +
      "它是机制的解释契约，缺步骤或中间产物会被拒绝。" +
      "比较表要写 columnDimensions（每列对应的研究维度 id，可为 null）与 rowSubjects（每行对应的对象 id）。" +
      "没有依据的项目写成 callout（tone='gap'，可用 dimensionIds 声明对应维度），不要用常识填空。\n" +
      "篇幅由各章节的内容义务决定，没有全篇 claim 数量上限；仍受单次输出预算限制，按节提交即可。",
    inputSchema: {
      type: "object",
      properties: {
        part: {
          type: "string",
          enum: ["start", "write", "finalize", "clear"],
          description: "分次提交的步骤；一次性提交完整报告时省略",
        },
        section: { type: "object", description: "part=write 时提交的单个章节 {id,title,blocks}" },
        title: { type: "string" },
        summary: { type: "string" },
        frame: {
          type: "object",
          description: "报告声明的研究问题、读者与范围（finalize 前必须提供 question 与 scope）",
          properties: {
            question: { type: "string", description: "本次研究回答的问题" },
            audience: { type: "string", description: "读者背景；省略时用任务卡上的读者" },
            scope: { type: "string", description: "对象与材料范围（比较了哪些对象、读了哪类来源）" },
          },
        },
        claims: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "claim id，例如 clm_mechanism_index" },
              text: { type: "string" },
              evidenceIds: { type: "array", items: { type: "string" } },
              kind: { type: "string", enum: ["fact", "comparison", "inference"], description: "兼容字段；新写法用 claimType" },
              claimType: {
                type: "string",
                enum: ["fact", "mechanism", "comparison", "performance", "cost", "synthesis", "implication"],
              },
              subjects: { type: "array", items: { type: "string" }, description: "涉及的对象 id（comparison/performance/cost 必填）" },
              dimensions: { type: "array", items: { type: "string" }, description: "该论断回答的研究维度 id" },
              synthesis: { type: "boolean", description: "claimType=synthesis 时必须为 true" },
              conditions: { type: "object", description: "条件与口径（见工具说明）" },
            },
            required: ["id", "text", "evidenceIds"],
          },
        },
        sections: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
                description:
                  "章节 id：overview / mental-model / mechanism / representative / comparison / synthesis / limitations / reading",
              },
              title: { type: "string" },
              blocks: {
                type: "array",
                description:
                  "内容块：{kind:'paragraph',text,claimIds}, {kind:'list',items:[{text,claimIds}]}, " +
                  "{kind:'table',columns,rows,columnDimensions,rowSubjects}, {kind:'callout',tone:'gap'|'note',text,dimensionIds}, " +
                  "{kind:'mechanism',input,intermediate,steps,output,tradeoff,failure,claimIds}",
                items: { type: "object" },
              },
            },
            required: ["id", "title", "blocks"],
          },
        },
      },
      required: [],
    },
    async execute(input, context) {
      const binding = taskFor(context.sessionId);
      if (binding === undefined) return noTask();
      const record = asRecord(input);
      if (record === undefined) return refuse("参数必须是对象", "请提供 title/summary/sections/claims 或 part。");

      const part = asString(record["part"]);
      if (part === "finalize" || part === "clear") {
        const result = service.saveReportPart(binding.taskId, { kind: part });
        if (!result.ok) return boundedJson({ ok: false, problems: result.problems, guidance: result.guidance });
        return boundedJson({
          ok: true,
          reportId: result.reportId,
          citations: result.citations,
          references: result.references,
          warnings: result.warnings,
          missingCells: result.missingCells,
          next: "报告已保存并可在工作台预览/导出 PDF。",
        });
      }

      if (part === "start" || part === "write") {
        const claims = Array.isArray(record["claims"]) ? record["claims"].map(readClaim) : undefined;
        const sectionRecord = asRecord(record["section"]);
        const section =
          sectionRecord === undefined
            ? undefined
            : {
                id: asString(sectionRecord["id"]) ?? "",
                title: asString(sectionRecord["title"]) ?? "",
                blocks: (Array.isArray(sectionRecord["blocks"]) ? sectionRecord["blocks"] : []).map(normalizeBlock),
              };
        const title = asString(record["title"]);
        const summary = asString(record["summary"]);
        const frame = asFrame(record["frame"]);
        const result = service.saveReportPart(binding.taskId, {
          kind: part,
          ...(title === undefined ? {} : { title }),
          ...(summary === undefined ? {} : { summary }),
          ...(frame === undefined ? {} : { frame }),
          ...(claims === undefined ? {} : { claims }),
          ...(section === undefined ? {} : { section }),
        });
        if (!result.ok) return boundedJson({ ok: false, problems: result.problems, guidance: result.guidance });
        const draft = service.reportDraftOf(binding.taskId);
        const preview = service.previewDraftValidation(binding.taskId);
        return boundedJson({
          ok: true,
          draft: {
            title: draft?.title ?? "",
            frameDeclared: draft?.frame !== undefined && draft.frame.question.trim().length > 0,
            summaryLength: draft?.summary.length ?? 0,
            claims: draft?.claims.length ?? 0,
            sections: draft?.sections.map((item) => item.id) ?? [],
          },
          note: result.warnings.join("；"),
          // The draft's outstanding obligations, surfaced per write so the model
          // can fix a section while it still has output budget for it.
          outstanding: preview === null ? [] : preview.problems.slice(0, 6),
          softObligations: preview === null ? [] : preview.warnings.slice(0, 6),
          next: "继续提交剩余章节，最后用 {part:'finalize'} 校验并发布。",
        });
      }

      const title = asString(record["title"]);
      const summary = asString(record["summary"]);
      if (title === undefined || summary === undefined) {
        return refuse("缺少 title 或 summary", "请补充报告标题与摘要，或使用 part 分次提交。");
      }

      const frame = asFrame(record["frame"]);
      const claims: ReportClaim[] = Array.isArray(record["claims"]) ? record["claims"].map(readClaim) : [];
      const sections = Array.isArray(record["sections"])
        ? record["sections"].map((item) => {
            const entry = asRecord(item) ?? {};
            const blocks = Array.isArray(entry["blocks"]) ? entry["blocks"] : [];
            return {
              id: asString(entry["id"]) ?? "",
              title: asString(entry["title"]) ?? "",
              blocks: blocks.map((block) => normalizeBlock(block)),
            };
          })
        : [];

      const result = service.saveReport(binding.taskId, {
        title,
        summary,
        ...(frame === undefined ? {} : { frame }),
        sections,
        claims,
      });
      if (!result.ok) return boundedJson({ ok: false, problems: result.problems, guidance: result.guidance });
      return boundedJson({
        ok: true,
        reportId: result.reportId,
        citations: result.citations,
        references: result.references,
        warnings: result.warnings,
        missingCells: result.missingCells,
        next: "报告已保存并可在工作台预览/导出 PDF；如需继续补查可先 assess_coverage。",
      });
    },
  };

  const proposeSectionEdit: Tool = {
    name: "propose_section_edit",
    description:
      "对报告的一个章节生成修改提案（Edit）。本工具不会修改报告正文：它保存旧内容 hash、目标章节、替换内容与理由，" +
      "由用户在界面上接受后才产生新的报告版本。只在被授权 Edit 的动作中可用；目标章节必须与本次授权的目标一致。" +
      "如果需要改动摘要，必须额外提供 summary 字段（摘要会被显式列为目标，不会因为改动一个章节而被顺手重写）。" +
      "新引入的论断必须引用真实存在的 evidenceId。",
    inputSchema: {
      type: "object",
      properties: {
        section: {
          type: "object",
          description: "目标章节的替换内容 {id, title, blocks}，block 形状与 save_report 相同",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            blocks: { type: "array", items: { type: "object" } },
          },
          required: ["id", "title", "blocks"],
        },
        claims: {
          type: "array",
          description: "提案新增或替换的 claim（其余 claim 保持不变）",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              text: { type: "string" },
              evidenceIds: { type: "array", items: { type: "string" } },
              kind: { type: "string", enum: ["fact", "comparison", "inference"] },
            },
            required: ["id", "text", "evidenceIds"],
          },
        },
        summary: { type: "string", description: "仅当需要同步修改摘要时提供" },
        reason: { type: "string", description: "为什么提出这次修改（一两句话）" },
      },
      required: ["section", "reason"],
    },
    async execute(input, context) {
      const binding = taskFor(context.sessionId);
      if (binding === undefined) return noTask();
      const grant = service.activeGrant(context.sessionId);
      if (grant === undefined || !grant.capabilities.includes("proposal")) {
        return refuse(
          "本次动作没有修改授权（Edit）。",
          "Ask 只回答问题，Research 只增加材料；要修改报告请由用户在界面发起 Edit 动作并指定目标章节。",
        );
      }
      const record = asRecord(input);
      const sectionRecord = asRecord(record?.["section"]);
      if (sectionRecord === undefined) return refuse("缺少 section", "请给出目标章节 {id,title,blocks}。");
      const reason = asString(record?.["reason"]);
      if (reason === undefined) return refuse("缺少 reason", "请说明这次修改的理由。");

      const section = {
        id: asString(sectionRecord["id"]) ?? "",
        title: asString(sectionRecord["title"]) ?? "",
        blocks: (Array.isArray(sectionRecord["blocks"]) ? sectionRecord["blocks"] : []).map((block) => normalizeBlock(block)),
      };
      if (section.id === "" || section.blocks.length === 0) {
        return refuse("section 不完整", "请提供章节 id 与至少一个 block。");
      }
      const claims = Array.isArray(record?.["claims"]) ? record!["claims"].map(readClaim) : [];
      const summary = asString(record?.["summary"]);

      const result = service.createProposal(binding.taskId, {
        actionId: grant.id,
        sections: [section],
        claims,
        ...(summary === undefined ? {} : { summary }),
        reason,
      });
      if (!result.ok) return boundedJson({ ok: false, problems: result.problems, guidance: result.guidance });
      const proposal = result.proposal;
      return boundedJson({
        ok: true,
        proposalId: proposal.id,
        status: proposal.status,
        baseReportId: proposal.baseReportId,
        targets: proposal.targets.map((target) => target.targetId),
        note: "修改提案已保存，报告正文未改变。请在界面上选择「接受」或「放弃」。",
        next: "不要再次提交同一章节的提案；等待用户决定。",
      });
    },
  };

  /**
   * The one write Guided Mode makes: the next question about the brief.
   *
   * The target is not the model's to choose — the program decided which field
   * is worth deciding next, and the stage instruction says which — so this tool
   * checks that the question stayed on it rather than trusting the schema. What
   * the model *is* responsible for is the wording and the offered answers; and
   * because every option has to carry the patch it means, the server can apply
   * a chosen answer without interpreting it a second time.
   */
  const proposeGuideQuestion: Tool = {
    name: "propose_guide_question",
    description:
      "为研究简报（Research Brief）写出下一个引导问题。一次只处理一个字段，字段由本次阶段的指令指定。\n" +
      "输出形状：{ complete: false, question, whyThisMatters, fieldTargets, options }，" +
      "其中 options 为 2–5 项，每项 { label, description?, recommended?, value }，" +
      "value 是该字段的最小取值 patch（例如 { \"audience\": \"研究生组会\" }），必须只包含 fieldTargets 里的字段，且是可以真正写进简报的取值。\n" +
      "如果当前默认值已经足够具体、不值得占用用户的一次决定，返回 { complete: true, reason: \"...\" } 并说明理由。\n" +
      "不要输出 Markdown 或对话文本；不要调用其他工具。",
    inputSchema: {
      type: "object",
      properties: {
        complete: { type: "boolean", description: "true 表示没有更值得确认的字段" },
        reason: { type: "string", description: "complete=true 时说明理由" },
        question: { type: "string", description: "要问用户的问题（一次只问一个决策）" },
        whyThisMatters: { type: "string", description: "一句话说明它如何影响检索、比较框架或报告深度" },
        fieldTargets: {
          type: "array",
          items: { type: "string" },
          description: "本次问题涉及的简报字段；必须正好是阶段指令指定的那一个",
        },
        options: {
          type: "array",
          description: "2–5 个候选项",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "选项文字" },
              description: { type: "string", description: "这个选项意味着什么（可选）" },
              recommended: { type: "boolean", description: "是否是推荐项（可选）" },
              value: { type: "object", description: "该选项对应的简报取值 patch，只包含 fieldTargets 里的字段" },
            },
            required: ["label", "value"],
          },
        },
      },
      required: ["complete"],
    },
    async execute(input, context) {
      const binding = taskFor(context.sessionId);
      if (binding === undefined) return noTask();
      const result = service.proposeGuideQuestion(binding.taskId, input);
      if (!result.ok) return boundedJson({ ok: false, problems: result.problems, guidance: result.guidance });
      if (result.complete) {
        return boundedJson({ ok: true, complete: true, reason: result.reason, next: "引导式规划到此结束，不要再提问。" });
      }
      return boundedJson({
        ok: true,
        complete: false,
        questionId: result.question.id,
        fieldTargets: result.question.fieldTargets,
        options: result.question.options.map((option) => option.optionId),
        next: "问题已保存并显示给用户；本轮到此结束，不要重复提问。",
      });
    },
  };

  const tools = [
    proposeTask,
    proposeGuideQuestion,
    searchSources,
    readSource,
    assessCoverage,
    loadResearchState,
    saveReport,
    proposeSectionEdit,
  ];
  const byName: Record<string, Tool> = {};
  for (const tool of tools) byName[tool.name] = tool;
  return { tools, byName };
}

/** One claim, as the wire carries it. */
function readClaim(value: unknown): ReportClaim {
  const entry = asRecord(value) ?? {};
  const kind = entry["kind"];
  const claimType = asClaimType(entry["claimType"]);
  const subjects = asStringArray(entry["subjects"]);
  const dimensions = asStringArray(entry["dimensions"]);
  const conditions = asConditions(entry["conditions"]);
  const synthesis = entry["synthesis"] === true || claimType === "synthesis" ? true : undefined;
  return {
    id: asString(entry["id"]) ?? "",
    text: asString(entry["text"]) ?? "",
    evidenceIds: asStringArray(entry["evidenceIds"]),
    kind: kind === "comparison" || kind === "inference" ? kind : claimType === "comparison" ? "comparison" : claimType === "synthesis" ? "inference" : "fact",
    ...(claimType === undefined ? {} : { claimType }),
    ...(subjects.length === 0 ? {} : { subjects }),
    ...(dimensions.length === 0 ? {} : { dimensions }),
    ...(conditions === undefined ? {} : { conditions }),
    ...(synthesis === undefined ? {} : { synthesis }),
  };
}

/** Blocks arrive as loose JSON; this keeps the shape the renderer expects. */
function normalizeBlock(value: unknown): ReportBlock {
  const record = asRecord(value) ?? {};
  const kind = asString(record["kind"]) ?? "paragraph";
  const claimIds = asStringArray(record["claimIds"]);
  const text = asString(record["text"]) ?? "";
  switch (kind) {
    case "list": {
      const items = Array.isArray(record["items"])
        ? record["items"].map((item) => {
            const entry = asRecord(item) ?? {};
            return { text: asString(entry["text"]) ?? "", claimIds: asStringArray(entry["claimIds"]) };
          })
        : [];
      return { kind: "list", items };
    }
    case "table": {
      const columns = asStringArray(record["columns"]);
      const rows = Array.isArray(record["rows"])
        ? record["rows"].map((row) => {
            const entry = asRecord(row) ?? {};
            const cells = Array.isArray(entry["cells"])
              ? entry["cells"].map((cell) => {
                  const cellEntry = asRecord(cell) ?? {};
                  return { text: asString(cellEntry["text"]) ?? "", claimIds: asStringArray(cellEntry["claimIds"]) };
                })
              : [];
            return { cells };
          })
        : [];
      const columnDimensions = Array.isArray(record["columnDimensions"])
        ? record["columnDimensions"].map((item) => (typeof item === "string" && item.trim().length > 0 ? item.trim() : null))
        : undefined;
      const rowSubjects = Array.isArray(record["rowSubjects"])
        ? record["rowSubjects"].map((item) => (typeof item === "string" && item.trim().length > 0 ? item.trim() : null))
        : undefined;
      return {
        kind: "table",
        columns,
        rows,
        ...(columnDimensions === undefined ? {} : { columnDimensions }),
        ...(rowSubjects === undefined ? {} : { rowSubjects }),
      };
    }
    case "callout": {
      const dimensionIds = asStringArray(record["dimensionIds"]);
      return {
        kind: "callout",
        tone: record["tone"] === "gap" ? "gap" : "note",
        text,
        ...(dimensionIds.length === 0 ? {} : { dimensionIds }),
      };
    }
    case "mechanism": {
      const steps = Array.isArray(record["steps"])
        ? record["steps"].map((step) => {
            const entry = asRecord(step) ?? {};
            return { text: asString(entry["text"]) ?? "", claimIds: asStringArray(entry["claimIds"]) };
          })
        : [];
      const title = asString(record["title"]);
      return {
        kind: "mechanism",
        ...(title === undefined ? {} : { title }),
        input: asString(record["input"]) ?? "",
        intermediate: asString(record["intermediate"]) ?? "",
        steps,
        output: asString(record["output"]) ?? "",
        tradeoff: asString(record["tradeoff"]) ?? "",
        failure: asString(record["failure"]) ?? "",
        claimIds,
      };
    }
    default:
      return { kind: "paragraph", text, claimIds };
  }
}
