/**
 * The product's acceptance run, offline and end to end.
 *
 * Everything the product is — the runner and its stage sequence, the six tools
 * behind the trusted policy, the evidence rules, the coverage matrix, the gap
 * policy, report validation, the renderer, the real Chrome PDF export and the
 * workspace API — runs here for real. Only two things are supplied by the test:
 * the model (a scripted stand-in that follows the same protocol a real model
 * does) and the network (fixture papers instead of arXiv). That is what makes
 * this test evidence about the product rather than about the fixture.
 */

import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelClient, ModelEvent, ModelMessage, ModelRequest, RuntimeContext } from "@every-dagent/agent-core";
import { DEFAULT_MODEL_FRAMING } from "@every-dagent/agent-core";
import type { TrustedComposition } from "@every-dagent/host";
import type { ReadOutcome } from "@every-dagent/plugin-research";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startResearchApp, type ResearchApp } from "../src/server/composition.js";

const workDir = mkdtempSync(join(tmpdir(), "researchpage-acceptance-"));
const dataDir = join(workDir, "data");
const staticRoot = join(process.cwd(), "apps", "research", "public");

// ---------------------------------------------------------------- fixtures ---

interface FixturePaper {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly paragraphs: readonly string[];
}

const PAPERS: readonly FixturePaper[] = [
  {
    id: "2404.16130",
    title: "From Local to Global: A GraphRAG Approach to Query-Focused Summarization",
    url: "https://arxiv.org/abs/2404.16130",
    paragraphs: [
      "GraphRAG extracts a knowledge graph from a corpus using an LLM, then partitions it into communities with hierarchical clustering and pre-generates community summaries for query-focused summarization.",
      "The construction pipeline has two stages: entity and relationship extraction from each source text unit, followed by community detection using the Leiden algorithm and summarization of each community.",
      "At query time GraphRAG supports both global search, which maps a question to community summaries, and local search, which walks entity neighbourhoods and their connected text units.",
      "The reported evaluation compares community summaries against source-text summarization on a podcast transcript dataset, using an LLM-judged comprehensiveness and diversity rubric.",
      "Costs are dominated by graph construction: it requires one LLM pass over the whole corpus, so indexing cost grows with corpus size and is paid before any question is asked.",
      "Reported limitations include the dependence on the quality of the extracted graph and the observation that community summaries can be less faithful for root-level communities.",
    ],
  },
  {
    id: "2405.14831",
    title: "HippoRAG: Neurobiologically Inspired Long-Term Memory for Large Language Models",
    url: "https://arxiv.org/abs/2405.14831",
    paragraphs: [
      "HippoRAG is inspired by the hippocampal indexing theory of memory: it builds a knowledge graph index over the corpus and uses it as a long-term memory structure for retrieval.",
      "The offline indexing pass runs open information extraction over the passages to obtain triples, then merges them into a schemaless knowledge graph whose nodes also include the passages themselves.",
      "Retrieval is personalized PageRank over the graph seeded by the query entities, which integrates evidence across passages in a single step instead of iterative retrieval loops.",
      "The evaluation covers multi-hop question answering benchmarks such as MuSiQue and 2WikiMultiHopQA, reporting single-step retrieval with lower latency than iterative RAG baselines.",
      "Because indexing is a one-time cost and retrieval is a single graph traversal, the reported deployment profile is cheaper per query than multi-step retrieval agents.",
      "The paper notes that single-step retrieval can fail when the query entities are ambiguous, and that the graph construction inherits errors from open information extraction.",
    ],
  },
  {
    id: "2410.05779",
    title: "LightRAG: Simple and Fast Retrieval-Augmented Generation",
    url: "https://arxiv.org/abs/2410.05779",
    paragraphs: [
      "LightRAG combines graph structures with vector representations: it extracts entities and relations for graph indexing while keeping text embeddings for direct retrieval.",
      "The indexing step uses the LLM to profile entities and relations with keywords, which supports both low-level keyword queries and high-level conceptual queries.",
      "A dual-level retrieval scheme is proposed so that a single query can reach both specific facts and broader themes without a separate summarization pipeline.",
      "Incremental updates are a design goal: new documents are merged into the existing graph and vector stores instead of rebuilding the index from scratch.",
      "Experiments are reported on several domain datasets with LLM-judged evaluations, and the paper argues the approach is cheaper to run than hierarchical summarization pipelines.",
      "The paper does not report deployment measurements beyond token and API-call counts, so hardware-level cost claims are left to future work.",
    ],
  },
];

function fixtureRead(url: string): ReadOutcome {
  if (url.includes("9999")) {
    return {
      status: "failed",
      readUrl: url,
      fetchedAt: new Date().toISOString(),
      title: "",
      scope: null,
      text: "",
      paragraphs: [],
      contentType: "",
      note: "HTTP 404",
      failure: "HTTP 404",
    };
  }
  const paper = PAPERS.find((candidate) => candidate.url === url) ?? PAPERS[0]!;
  const text = paper.paragraphs.join("\n\n");
  const paragraphs = paper.paragraphs.map((paragraph, index) => {
    const charStart = paper.paragraphs.slice(0, index).reduce((sum, item) => sum + item.length + 2, 0);
    return { index, headingPath: ["Fixture", `Section ${index + 1}`], text: paragraph, charStart, charEnd: charStart + paragraph.length };
  });
  return {
    status: "ok",
    readUrl: `${url.replace("/abs/", "/html/")}`,
    fetchedAt: new Date().toISOString(),
    title: paper.title,
    scope: "full_text",
    text,
    paragraphs,
    contentType: "text/html",
    note: "取得公开 HTML 正文并以 full_text 记录",
    failure: null,
  };
}

function searchFixture(query: string, options: { readonly limit: number }) {
  return Promise.resolve({
    provider: "arxiv" as const,
    query,
    requestUrl: `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}`,
    fetchedAt: new Date().toISOString(),
    total: PAPERS.length,
    candidates: PAPERS.slice(0, options.limit).map((paper) => ({
      title: paper.title,
      authors: ["Fixture Author"],
      abstract: paper.paragraphs[0] ?? "",
      absUrl: paper.url,
      pdfUrl: null,
      publishedAt: "2024-04-24T00:00:00Z",
      arxivId: paper.id,
      primaryCategory: "cs.CL",
      doi: null,
    })),
  });
}

// ------------------------------------------------------------ scripted model ---

interface ToolResultView {
  readonly name: string;
  readonly value: Record<string, unknown>;
}

function toolResultsOf(messages: readonly ModelMessage[]): ToolResultView[] {
  const views: ToolResultView[] = [];
  for (const message of messages) {
    if (message.role !== "tool") continue;
    for (const result of message.results) {
      try {
        views.push({ name: result.name, value: JSON.parse(result.content) as Record<string, unknown> });
      } catch {
        // A tool that answered with something other than JSON is not one of ours.
      }
    }
  }
  return views;
}

function instructionOf(messages: readonly ModelMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return message.text;
  }
  return "";
}

/**
 * A model that follows the product's protocol with fixed decisions.
 *
 * It is the same protocol a real model follows — read the instruction, call the
 * tools in order, cite only ids that came back — which is what lets the whole
 * product run offline while the real-provider path stays covered by its own
 * end-to-end test.
 */
function scriptedResearchModel(): { readonly client: ModelClient; readonly calls: string[] } {
  const calls: string[] = [];
  let step = 0;
  let runInstruction = "";
  let runStep = 0;

  const next = (events: readonly ModelEvent[]): AsyncIterable<ModelEvent> =>
    (async function* () {
      for (const event of events) yield event;
    })();

  const client: ModelClient = {
    limits: { contextWindow: 128 * 1024, maxOutputTokens: 8 * 1024, framing: DEFAULT_MODEL_FRAMING },
    stream(request: ModelRequest, _context: RuntimeContext): AsyncIterable<ModelEvent> {
      step += 1;
      const instruction = instructionOf(request.messages);
      const results = toolResultsOf(request.messages);
      const call = (name: string, input: unknown): readonly ModelEvent[] => {
        calls.push(name);
        return [
          { type: "tool-call", call: { callId: `call-${step}-${name}`, name, input } },
          { type: "done" },
        ];
      };
      const say = (text: string): readonly ModelEvent[] => [{ type: "text-delta", text }, { type: "done" }];

      // 1. The card stage.
      if (instruction.includes("建立研究任务卡")) {
        return next(
          call("propose_task", {
            topic: "GraphRAG 与图结构检索方法的机制比较",
            purpose: "组会汇报",
            audience: "计算机专业研究生",
            focus: ["机制差异", "证据条件"],
            lengthTarget: "约 4 页",
            subjects: [{ name: "GraphRAG" }, { name: "HippoRAG" }],
            dimensions: [
              { name: "核心思想", question: "方法解决什么问题" },
              { name: "结构与构建", question: "图或记忆如何构建" },
              { name: "检索机制", question: "查询时如何检索" },
              { name: "实验与评测", question: "在什么数据与指标上验证" },
              { name: "成本与部署", question: "成本与资源条件" },
              { name: "局限与风险", question: "局限是什么" },
            ],
          }),
        );
      }

      // 2. The main research pass: search once, read two sources, assess.
      if (instruction.includes("任务卡已由用户确认")) {
        const searches = results.filter((result) => result.name === "search_sources");
        const reads = results.filter((result) => result.name === "read_source");
        const card = results.find((result) => result.name === "propose_task");
        if (searches.length === 0) {
          const card = results.find((result) => result.name === "propose_task");
          const firstSubject = (card?.value["subjects"] ?? []) as { id: string }[];
          const firstDimension = (card?.value["dimensions"] ?? []) as { id: string }[];
          // Aimed at a cell of the task's own matrix, like a real model aims a
          // search at the comparison it is trying to fill.
          return next(
            call("search_sources", {
              query: "GraphRAG graph retrieval summarization",
              limit: 3,
              targetCell: {
                sectionId: "comparison",
                subjectId: firstSubject[0]?.id ?? "sub_1",
                dimensionId: firstDimension[1]?.id ?? firstDimension[0]?.id ?? "dim_1",
              },
            }),
          );
        }
        const sources = (searches[0]!.value["sources"] ?? []) as { sourceId: string; url: string }[];
        const subjects = (card?.value["subjects"] ?? []) as { id: string; name: string }[];
        const dimensions = (card?.value["dimensions"] ?? []) as { id: string; name: string }[];
        const readSomething = new Set(reads.map((result) => String(result.value["sourceId"])));

        // One read per subject, aimed at the "结构与构建" cell.
        for (const [index, subject] of subjects.entries()) {
          const source = sources[index];
          if (source === undefined || readSomething.has(source.sourceId)) continue;
          return next(
            call("read_source", {
              sourceId: source.sourceId,
              question: `${subject.name} 的结构如何构建`,
              terms: ["graph", "construction", "indexing", "community"],
              targetCell: { sectionId: "comparison", subjectId: subject.id, dimensionId: dimensions[1]?.id ?? dimensions[0]?.id },
              maxEvidence: 2,
            }),
          );
        }
        if (!results.some((result) => result.name === "assess_coverage")) {
          const proposals = subjects.map((subject, index) => ({
            cell: {
              sectionId: "comparison",
              subjectId: subject.id,
              dimensionId: dimensions[1]?.id ?? dimensions[0]?.id,
            },
            evidenceIds: reads
              .filter((result) => String(result.value["sourceId"]) === sources[index]?.sourceId)
              .flatMap((result) => ((result.value["evidence"] ?? []) as { evidenceId: string }[]).map((item) => item.evidenceId)),
            relationship: "supports",
            directness: "direct",
            scope: `${subject.name} 的构建步骤有正文片段直接描述。`,
            note: `${subject.name} 的构建步骤有正文片段支持。`,
          }));
          return next(call("assess_coverage", { proposals }));
        }
        return next(say("本轮已完成检索、读取与覆盖评估；多数比较项仍缺少正文依据。"));
      }

      // 3. A targeted gap round: one read, one coverage assessment, then stop.
      if (instruction.includes("定向补查轮")) {
        // Steps are counted from the first call of this run: the instruction is
        // the stage, and a run's own steps are what the script follows.
        if (runInstruction !== instruction) {
          runInstruction = instruction;
          runStep = 0;
        }
        runStep += 1;

        const reads = results.filter((result) => result.name === "read_source");
        const searches = results.filter((result) => result.name === "search_sources");
        const card = results.find((result) => result.name === "propose_task");
        const sources = searches.flatMap(
          (result) => (result.value["sources"] ?? []) as { sourceId: string; url: string }[],
        );
        const readSomething = new Set(reads.map((result) => String(result.value["sourceId"])));
        const unread = sources.filter((source) => !readSomething.has(source.sourceId));
        const subjects = (card?.value["subjects"] ?? []) as { id: string; name: string }[];
        const dimensions = (card?.value["dimensions"] ?? []) as { id: string; name: string }[];

        if (runStep === 1 && unread.length > 0) {
          const source = unread[0]!;
          return next(
            call("read_source", {
              sourceId: source.sourceId,
              question: "检索机制与实验设置",
              terms: ["retrieval", "evaluation", "query", "latency"],
              targetCell: {
                sectionId: "comparison",
                subjectId: subjects[0]?.id ?? "sub_1",
                dimensionId: dimensions[2]?.id ?? dimensions[0]?.id ?? "dim_1",
              },
              maxEvidence: 2,
            }),
          );
        }
        if (runStep <= 2) {
          const proposals = subjects.map((subject) => ({
            cell: {
              sectionId: "comparison",
              subjectId: subject.id,
              dimensionId: dimensions[2]?.id ?? dimensions[0]?.id ?? "dim_1",
            },
            evidenceIds: reads
              .flatMap((result) => ((result.value["evidence"] ?? []) as { evidenceId: string }[]).map((item) => item.evidenceId))
              .slice(0, 2),
            // A real model reading a passage about evaluation settings cannot
            // claim those settings answer the retrieval question: this cell is
            // recorded as indirect support, and stays "limited" because of it.
            relationship: "supports",
            directness: "indirect",
            scope: "片段描述的是评测设置，与检索机制只是间接相关。",
            note: `${subject.name} 的检索机制说明（间接）。`,
          }));
          return next(call("assess_coverage", { proposals, gapRound: true }));
        }
        return next(say("补查完成，剩余缺口将在报告中如实标注。"));
      }

      // 4. The report stage: the incremental protocol, then the closing sentence.
      if (instruction.includes("写出结构化研究报告")) {
        const saved = results.filter((result) => result.name === "save_report");
        if (saved.some((result) => typeof result.value["reportId"] === "string" && result.value["reportId"] !== "")) {
          return next(say("报告已保存，可在工作台预览与导出。"));
        }
        const evidence = results
          .filter((result) => result.name === "read_source")
          .flatMap((result) => ((result.value["evidence"] ?? []) as { evidenceId: string }[]).map((item) => item.evidenceId));
        const card = results.find((result) => result.name === "propose_task");
        const subjects = (card?.value["subjects"] ?? []) as { id: string; name: string }[];
        const dimensions = (card?.value["dimensions"] ?? []) as { id: string; name: string }[];
        const first = evidence[0] ?? "";
        const second = evidence[Math.min(1, evidence.length - 1)] ?? first;
        const third = evidence[Math.min(2, evidence.length - 1)] ?? first;

        // One part per step — start, claims, four sections, finalize — which is
        // what a real model has to do: a whole report does not fit in one
        // step's output budget.
        const submitted = saved.length;
        if (submitted === 0) {
          return next(
            call("save_report", {
              part: "start",
              title: "GraphRAG 与 HippoRAG：图结构检索方法的机制比较",
              summary:
                "本报告比较两种以图结构组织知识的检索方法：GraphRAG 用实体知识图谱与社区摘要支撑覆盖整个语料的问答，HippoRAG 用知识图谱作为长期记忆索引支撑多跳整合检索。",
            }),
          );
        }
        if (submitted === 1) {
          return next(
            call("save_report", {
              part: "write",
              claims: [
              { id: "clm_graphrag_build", text: "GraphRAG 先抽取实体与关系，再做社区检测与摘要生成。", evidenceIds: [first], kind: "fact" },
              { id: "clm_hipporag_build", text: "HippoRAG 用开放信息抽取构建知识图谱作为检索的记忆结构。", evidenceIds: [second], kind: "fact" },
              { id: "clm_retrieval", text: "两者的检索机制不同：社区摘要驱动的全局搜索，与基于图扩散的单步多跳检索。", evidenceIds: [first, second], kind: "comparison" },
                { id: "clm_cost", text: "两者的索引成本都是一次性的构建开销，查询成本结构不同。", evidenceIds: [third], kind: "inference" },
              ],
            }),
          );
        }

        const SECTIONS: readonly { readonly id: string; readonly title: string; readonly blocks: readonly unknown[] }[] = [
              {
                id: "overview",
                title: "一、研究任务与关键认识",
                blocks: [
                  { kind: "paragraph", text: "本次研究面向组会汇报，比较两种图结构检索方法的机制差异与适用条件。", claimIds: [] },
                  { kind: "paragraph", text: "GraphRAG 在索引阶段构建实体图谱与社区摘要，回答需要覆盖整个语料的问题。", claimIds: ["clm_graphrag_build"] },
                  { kind: "paragraph", text: "HippoRAG 把知识图谱当作长期记忆索引，用单步图扩散完成多跳检索。", claimIds: ["clm_hipporag_build"] },
                ],
              },
              {
                id: "background",
                title: "二、背景与方法分类",
                blocks: [
                  {
                    kind: "list",
                    items: [
                      { text: "全局式问答：需要在语料级别归纳，而不是召回若干片段。", claimIds: [] },
                      { text: "多跳整合检索：答案分布在多个文档，需要沿关系链连接。", claimIds: [] },
                    ],
                  },
                ],
              },
              {
                id: "representative",
                title: "三、代表工作",
                blocks: [
                  { kind: "paragraph", text: "GraphRAG（Edge 等）提出图谱加社区摘要的路线。", claimIds: ["clm_graphrag_build"] },
                  { kind: "paragraph", text: "HippoRAG（Gutiérrez 等）提出图谱作记忆索引的路线。", claimIds: ["clm_hipporag_build"] },
                ],
              },
              {
                id: "comparison",
                title: "四、共同维度比较",
                blocks: [
                  {
                    kind: "table",
                    columns: ["方法", dimensions[0]?.name ?? "核心思想", dimensions[2]?.name ?? "检索机制"],
                    rows: [
                      {
                        cells: [
                          { text: "GraphRAG", claimIds: [] },
                          { text: "社区摘要支撑全局归纳问答", claimIds: ["clm_graphrag_build"] },
                          { text: "全局搜索映射到社区摘要；局部搜索沿实体邻域展开", claimIds: ["clm_retrieval"] },
                        ],
                      },
                      {
                        cells: [
                          { text: "HippoRAG", claimIds: [] },
                          { text: "图谱作为长期记忆索引", claimIds: ["clm_hipporag_build"] },
                          { text: "以查询实体为种子的个性化 PageRank 单步检索", claimIds: ["clm_retrieval"] },
                        ],
                      },
                    ],
                  },
                  {
                    kind: "callout",
                    tone: "gap",
                    text: "成本与部署：本次材料只读到构建成本结构，未取得可直接比较的硬件与运行条件，暂不下结论。",
                  },
                ],
              },
              {
                id: "limitations",
                title: "五、局限与证据缺口",
                blocks: [
                  {
                    kind: "list",
                    items: [
                      { text: "两种方法面向的问答类型不同，跨方法性能排名需要谨慎。", claimIds: [] },
                      { text: "本报告未覆盖全部实验设置与资源条件。", claimIds: [] },
                    ],
                  },
                ],
              },
        ];
        const nextSection = SECTIONS[submitted - 2];
        if (nextSection !== undefined) {
          return next(call("save_report", { part: "write", section: nextSection }));
        }
        return next(call("save_report", { part: "finalize" }));
      }

      return next(say("已按当前指令处理。"));
    },
  };

  return { client, calls };
}

function offlineComposition(): TrustedComposition {
  const scripted = scriptedResearchModel();
  return {
    toolPolicy: undefined,
    validateModel: () => ({ ok: true }),
    compose: async () => ({ modelClient: scripted.client }),
  };
}

// --------------------------------------------------------------- the test ---

let app: ResearchApp;

beforeAll(async () => {
  app = await startResearchApp({
    dataDir,
    staticRoot,
    composition: offlineComposition(),
    overrides: { search: searchFixture, read: async ({ url }) => fixtureRead(url) },
    log: (message: string): void => {
      if (process.env["RESEARCHPAGE_TEST_LOG"] === "1") console.log(message);
    },
  });
}, 60_000);

afterAll(async () => {
  await app?.close();
  rmSync(workDir, { recursive: true, force: true });
});

async function post(path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${app.pageOrigin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text.length === 0 ? {} : JSON.parse(text) };
}

async function get(path: string): Promise<{ status: number; text: string }> {
  const response = await fetch(`${app.pageOrigin}${path}`);
  return { status: response.status, text: await response.text() };
}

async function waitUntil(predicate: () => Promise<boolean>, what: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
  }
}

interface Bundle {
  readonly task: { readonly id: string; readonly status: string; readonly error: string | null; readonly confirmed: boolean };
  readonly subjects: readonly { readonly id: string; readonly name: string }[];
  readonly dimensions: readonly { readonly id: string; readonly name: string }[];
  readonly matrix: readonly { readonly status: string; readonly evidenceIds: readonly string[]; readonly subjectName: string; readonly dimensionName: string }[];
  readonly assessments: readonly { readonly assessmentId: string; readonly relationship: string; readonly directness: string }[];
  readonly sources: readonly {
    readonly sourceId: string;
    readonly readStatus: string;
    readonly readScope: string | null;
    readonly failure: string | null;
    readonly discovery: { readonly target: { readonly subjectId: string; readonly dimensionId: string } | null };
  }[];
  readonly evidence: readonly { readonly evidenceId: string; readonly excerpt: string; readonly sourceId: string }[];
  readonly reports: readonly { readonly reportId: string; readonly isCurrent: boolean; readonly validation: { readonly ok: boolean }; readonly claims: readonly { readonly id: string; readonly evidenceIds: readonly string[] }[] }[];
  readonly exports: readonly { readonly exportId: string; readonly status: string; readonly bytes: number; readonly isCurrentReport: boolean }[];
  readonly runs: readonly { readonly stage: string; readonly status: string }[];
  readonly currentReportId: string | null;
  readonly busy: boolean;
}

describe("the product, end to end, offline", () => {
  it("turns a topic into a confirmed card, reads real material, fills the matrix, reports, exports and reopens", async () => {
    // 1. A vague topic starts the card stage.
    const started = await post("/api/research/tasks", { topic: "帮我整理 GraphRAG 与代表工作，明天组会要用" });
    expect(started.status).toBe(202);
    const sessionId = (started.json as { sessionId: string }).sessionId;
    expect(sessionId.length).toBeGreaterThan(0);

    await waitUntil(async () => {
      const state = await get(`/api/research/sessions/${sessionId}`);
      const parsed = JSON.parse(state.text) as { task: Bundle | null };
      return parsed.task !== null;
    }, "the task card to appear");

    const sessionState = JSON.parse((await get(`/api/research/sessions/${sessionId}`)).text) as { task: Bundle };
    let bundle = sessionState.task;
    expect(bundle.task.status).toBe("draft");
    expect(bundle.task.confirmed).toBe(false);
    expect(bundle.subjects.map((subject) => subject.name)).toEqual(["GraphRAG", "HippoRAG"]);
    expect(bundle.dimensions.length).toBeGreaterThanOrEqual(3);
    expect(bundle.matrix.length).toBe(bundle.subjects.length * bundle.dimensions.length);
    expect(bundle.matrix.every((cell) => cell.status === "missing")).toBe(true);
    const taskId = bundle.task.id;

    // 2. The user confirms; the research pass runs with its gap rounds and report.
    const confirmed = await post(`/api/research/tasks/${taskId}/confirm`, {});
    expect(confirmed.status).toBe(202);

    const dump = (current: Bundle, label: string): void => {
      if (process.env["RESEARCHPAGE_TEST_LOG"] !== "1") return;
      console.log(
        `[test] ${label} status=${current.task.status} busy=${String(current.busy)} runs=${current.runs
          .map((run) => `${run.stage}:${run.status}`)
          .join(",")} reads=${current.sources.filter((source) => source.readStatus === "ok").length} evidence=${
          current.evidence.length
        } reports=${current.reports.length} error=${current.task.error ?? "-"}`,
      );
    };
    await waitUntil(async () => {
      const current = JSON.parse((await get(`/api/research/tasks/${taskId}`)).text) as Bundle;
      dump(current, "poll");
      const done = current.task.status === "ready" || current.task.status === "failed";
      // The task reaches `ready` the moment the report is saved, while the
      // stage that saved it is still settling; the product is finished when
      // nothing is running any more.
      return done && !current.busy;
    }, "the research pass to finish", 180_000);

    bundle = JSON.parse((await get(`/api/research/tasks/${taskId}`)).text) as Bundle;
    expect(bundle.task.status, bundle.task.error ?? "").toBe("ready");
    expect(bundle.task.confirmed).toBe(true);

    // 3. Stages really ran, in the order the product promises.
    const stages = bundle.runs.map((run) => run.stage);
    expect(stages[0]).toBe("research");
    expect(stages.filter((stage) => stage === "gap").length).toBeGreaterThanOrEqual(1);
    expect(stages.filter((stage) => stage === "gap").length).toBeLessThanOrEqual(2);
    expect(stages[stages.length - 1]).toBe("report");
    expect(bundle.runs.every((run) => run.status === "completed")).toBe(true);

    // 3b. The structure drove the work, not just the report's headings: the
    //     searches were aimed at the task's own comparison cells.
    const subjectIds = new Set(bundle.subjects.map((subject) => subject.id));
    const aims = bundle.sources.filter((source) => source.discovery.target !== null);
    expect(aims.length, "searches must be aimed at matrix cells").toBeGreaterThan(0);
    expect(aims.every((source) => subjectIds.has(source.discovery.target?.subjectId ?? ""))).toBe(true);

    // 4. Sources were really read; scopes are recorded truthfully.
    expect(bundle.sources.length).toBeGreaterThanOrEqual(3);
    const read = bundle.sources.filter((source) => source.readStatus === "ok");
    expect(read.length).toBeGreaterThanOrEqual(3);
    expect(read.every((source) => source.readScope === "full_text")).toBe(true);

    // 5. Evidence exists, is bound to cells, and the matrix was derived from it.
    expect(bundle.evidence.length).toBeGreaterThan(0);
    // Every judgement the run recorded is stored as its own object, with the
    // relationship and directness a reader can check.
    expect(bundle.assessments.length).toBeGreaterThan(0);
    expect(bundle.assessments.some((entry) => entry.directness === "direct")).toBe(true);
    expect(bundle.assessments.some((entry) => entry.directness === "indirect")).toBe(true);
    for (const item of bundle.evidence) {
      const text = app.service.snapshotTextOf(
        app.service.evidenceOf(taskId).find((candidate) => candidate.id === item.evidenceId)!.readId,
      );
      expect(text, "the snapshot behind an excerpt must be saved").toBeDefined();
      const stored = app.service.evidenceOf(taskId).find((candidate) => candidate.id === item.evidenceId)!;
      expect(text!.slice(stored.locator.charStart, stored.locator.charEnd)).toBe(item.excerpt);
    }
    const reviewed = bundle.matrix.filter((cell) => cell.status === "reviewed");
    expect(reviewed.length, "a directly assessed cell must reach reviewed").toBeGreaterThan(0);
    expect(reviewed.every((cell) => cell.evidenceIds.length > 0)).toBe(true);
    // The cells nobody read for stay missing — no optimistic green.
    expect(bundle.matrix.some((cell) => cell.status === "missing")).toBe(true);
    // And a cell with an indirect judgement is not green either.
    expect(bundle.matrix.some((cell) => cell.status === "limited")).toBe(true);
    const LEGACY_STATUSES = ["sufficient", "partial", "evaluating"];
    expect(bundle.matrix.every((cell) => !LEGACY_STATUSES.includes(cell.status))).toBe(true);

    // 6. The report is validated, its claims point at real evidence only.
    const current = bundle.reports.find((report) => report.isCurrent);
    expect(current, "a current report must exist").toBeDefined();
    expect(current!.validation.ok).toBe(true);
    expect(current!.claims.length).toBeGreaterThan(0);
    const evidenceIds = new Set(bundle.evidence.map((item) => item.evidenceId));
    for (const claim of current!.claims) {
      expect(claim.evidenceIds.length).toBeGreaterThan(0);
      for (const id of claim.evidenceIds) expect(evidenceIds.has(id)).toBe(true);
    }

    // 7. HTML preview renders the report, the table and the references.
    const html = await get(`/api/research/reports/${current!.reportId}/html`);
    expect(html.status).toBe(200);
    expect(html.text).toContain("研究任务与关键认识");
    expect(html.text).toContain("<table class=\"matrix\">");
    expect(html.text).toContain("参考来源");
    expect(html.text).toContain("证据节选索引");
    expect(html.text).not.toContain("<script");

    // 8. A real PDF was exported (the runner does it the moment a report lands).
    const exported = bundle.exports.filter(
      (artifact) => artifact.status === "exported" && artifact.isCurrentReport,
    );
    expect(exported.length, "the runner should have exported a PDF").toBeGreaterThan(0);
    expect(exported[0]!.bytes).toBeGreaterThan(20_000);
    const downloaded = await get(`/api/research/exports/${exported[0]!.exportId}/file`);
    expect(downloaded.status).toBe(200);
    const artifactPath = app.service
      .exportsOf(taskId)
      .find((candidate) => candidate.id === exported[0]!.exportId)?.path;
    expect(artifactPath).not.toBeNull();
    expect(existsSync(artifactPath!)).toBe(true);
    expect(statSync(artifactPath!).size).toBeGreaterThan(20_000);
  }, 240_000);

  it("refuses a report that cites evidence which does not exist", async () => {
    const tasks = JSON.parse((await get("/api/research/tasks")).text) as { tasks: readonly { id: string }[] };
    const taskId = tasks.tasks[0]!.id;
    // An authorized report action, so what refuses this draft is the citation
    // rule and not the permission check in front of it.
    const task = app.service.getTask(taskId)!;
    app.service.issueGrant({ sessionId: task.sessionId, intent: "draft", taskId, allowResearch: false });
    const result = app.service.saveReport(taskId, {
      title: "伪造引用测试",
      summary: "这份报告引用了不存在的证据。",
      claims: [{ id: "clm_fake", text: "一条没有依据的结论。", evidenceIds: ["ev_0000000000000000"], kind: "fact" }],
      sections: [
        { id: "overview", title: "一", blocks: [{ kind: "paragraph", text: "内容", claimIds: ["clm_fake"] }] },
        { id: "representative", title: "三", blocks: [{ kind: "paragraph", text: "内容", claimIds: ["clm_fake"] }] },
        { id: "comparison", title: "四", blocks: [{ kind: "paragraph", text: "内容", claimIds: ["clm_fake"] }] },
        { id: "limitations", title: "五", blocks: [{ kind: "paragraph", text: "内容", claimIds: ["clm_fake"] }] },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.join(" ")).toContain("ev_0000000000000000");
    }
  });

  it("reopens the finished research after a restart, with its report and PDF", async () => {
    const tasks = JSON.parse((await get("/api/research/tasks")).text) as { tasks: readonly { id: string; status: string; hasReport: boolean }[] };
    const finished = tasks.tasks.find((task) => task.status === "ready");
    expect(finished, "a finished task must be listed").toBeDefined();
    expect(finished!.hasReport).toBe(true);

    await app.close();

    app = await startResearchApp({
      dataDir,
      staticRoot,
      composition: offlineComposition(),
      overrides: { search: searchFixture, read: async ({ url }) => fixtureRead(url) },
      log: () => undefined,
    });

    const reopened = JSON.parse((await get(`/api/research/tasks/${finished!.id}`)).text) as Bundle;
    expect(reopened.task.status).toBe("ready");
    expect(reopened.currentReportId).not.toBeNull();
    expect(reopened.evidence.length).toBeGreaterThan(0);
    expect(reopened.reports.length).toBeGreaterThan(0);
    const pdf = reopened.exports.find((artifact) => artifact.status === "exported");
    expect(pdf, "the exported PDF survives a restart").toBeDefined();
    // A finished task is not re-run by coming back to it.
    expect(reopened.busy).toBe(false);
  }, 120_000);
});
