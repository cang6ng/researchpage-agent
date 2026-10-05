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

import type { CellRef, ReportBlock, ReportClaim, ReportSection } from "./domain.js";
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
        next: task.confirmedAt === null ? "等待用户在界面确认任务卡；确认前不要检索。" : "任务卡已确认，可以开始 search_sources。",
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
      "只有这里产生的 evidenceId 才能被报告引用；搜索摘要不能当证据。读取失败会如实记录失败状态。",
    inputSchema: {
      type: "object",
      properties: {
        sourceId: { type: "string", description: "search_sources 返回的 sourceId" },
        question: { type: "string", description: "这次读取要回答的问题（例如该方法的图构建步骤是什么）" },
        terms: { type: "array", items: { type: "string" }, description: "英文关键词，用于选择片段" },
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
      "评估证据矩阵覆盖情况：提交每个单元格的支持理由（可把已有 evidenceId 绑定到该单元格），工具校验后保存矩阵。" +
      "单元格状态由程序根据真实证据的读取范围推导（正文级 → sufficient，仅摘要 → partial，无证据 → missing），模型不能直接指定状态。" +
      "返回尚未覆盖的格子，用于决定是否定向补查（gapRound=true 表示开始一轮定向补查，受轮次预算限制）。",
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
              evidenceIds: { type: "array", items: { type: "string" }, description: "支持该单元格的 evidenceId" },
              note: { type: "string", description: "你的判断说明（不影响状态推导）" },
            },
            required: ["cell"],
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
      const proposals: { cell: CellRef; evidenceIds: readonly string[]; note?: string }[] = [];
      if (Array.isArray(rawProposals)) {
        for (const item of rawProposals) {
          const entry = asRecord(item) ?? {};
          const cell = asCellRef(entry["cell"]);
          if (cell === undefined) continue;
          const note = asString(entry["note"]);
          proposals.push({
            cell,
            evidenceIds: asStringArray(entry["evidenceIds"]),
            ...(note === undefined ? {} : { note }),
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
      "用于在长任务中恢复上下文；不会返回全文。",
    inputSchema: { type: "object", properties: {}, required: [] },
    async execute(_input, context) {
      const binding = taskFor(context.sessionId);
      if (binding === undefined) return noTask();
      return boundedJson({ ok: true, state: service.state(binding.taskId) });
    },
  };

  const saveReport: Tool = {
    name: "save_report",
    description:
      "保存结构化研究报告（不是 HTML）。报告 = title + summary + sections（blocks：paragraph/list/table/callout）+ claims（每条 claim 绑定真实 evidenceId）。" +
      "单次调用的输出有限（约 4096 tokens），长报告请分次提交：" +
      '先 {part:"start", title, summary}，再 {part:"write", claims:[...]}，' +
      '然后每节一次 {part:"write", section:{...}}（必需章节 overview/representative/comparison/limitations，可选 background/conditions/reading），' +
      '最后 {part:"finalize"} 校验并发布；也可以一次性提交完整 {title, summary, sections, claims}。' +
      "校验内容：必需章节、claim 的 evidence 是否存在且属于本任务、片段是否仍与保存文本一致；标注 inference 的综合判断也要绑定推断依据。" +
      '没有依据的比较项写成 callout（tone="gap"）明确缺失，不要编造。' +
      "篇幅建议：表格 ≤3 列、单元格 ≤40 字，段落 ≤150 字，claims ≤8 条。",
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
        claims: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "claim id，例如 clm_core_idea" },
              text: { type: "string" },
              evidenceIds: { type: "array", items: { type: "string" } },
              kind: { type: "string", enum: ["fact", "comparison", "inference"] },
            },
            required: ["id", "text", "evidenceIds"],
          },
        },
        sections: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "章节 id：overview/background/representative/comparison/conditions/limitations/reading" },
              title: { type: "string" },
              blocks: {
                type: "array",
                description:
                  "内容块：{kind:'paragraph',text,claimIds}, {kind:'list',items:[{text,claimIds}]}, " +
                  "{kind:'table',columns:[...],rows:[{cells:[{text,claimIds}]}]}, {kind:'callout',tone:'gap'|'note',text}",
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
        const result = service.saveReportPart(binding.taskId, {
          kind: part,
          ...(title === undefined ? {} : { title }),
          ...(summary === undefined ? {} : { summary }),
          ...(claims === undefined ? {} : { claims }),
          ...(section === undefined ? {} : { section }),
        });
        if (!result.ok) return boundedJson({ ok: false, problems: result.problems, guidance: result.guidance });
        const draft = service.reportDraftOf(binding.taskId);
        return boundedJson({
          ok: true,
          draft: {
            title: draft?.title ?? "",
            summaryLength: draft?.summary.length ?? 0,
            claims: draft?.claims.length ?? 0,
            sections: draft?.sections.map((item) => item.id) ?? [],
          },
          note: result.warnings.join("；"),
          next: "继续提交剩余章节，最后用 {part:'finalize'} 校验并发布。",
        });
      }

      const title = asString(record["title"]);
      const summary = asString(record["summary"]);
      if (title === undefined || summary === undefined) {
        return refuse("缺少 title 或 summary", "请补充报告标题与摘要，或使用 part 分次提交。");
      }

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

      const result = service.saveReport(binding.taskId, { title, summary, sections, claims });
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

  const tools = [proposeTask, searchSources, readSource, assessCoverage, loadResearchState, saveReport];
  const byName: Record<string, Tool> = {};
  for (const tool of tools) byName[tool.name] = tool;
  return { tools, byName };
}

/** One claim, as the wire carries it. */
function readClaim(value: unknown): ReportClaim {
  const entry = asRecord(value) ?? {};
  const kind = entry["kind"];
  return {
    id: asString(entry["id"]) ?? "",
    text: asString(entry["text"]) ?? "",
    evidenceIds: asStringArray(entry["evidenceIds"]),
    kind: kind === "comparison" || kind === "inference" ? kind : "fact",
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
      return { kind: "table", columns, rows };
    }
    case "callout":
      return { kind: "callout", tone: record["tone"] === "gap" ? "gap" : "note", text };
    default:
      return { kind: "paragraph", text, claimIds };
  }
}
