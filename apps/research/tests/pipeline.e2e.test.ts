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
      provider: "arxiv" as const,
      providerId: paper.id,
      title: paper.title,
      authors: ["Fixture Author"],
      abstract: paper.paragraphs[0] ?? "",
      landingUrl: paper.url,
      pdfUrl: null,
      publishedAt: "2024-04-24T00:00:00Z",
      arxivId: paper.id,
      venue: "arXiv cs.CL",
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

      // The bounded view the product hands the model: the task's subjects,
      // dimensions and evidence index, read back from the most recent load.
      const latestResearchView = (): {
        readonly subjects: readonly { readonly id: string; readonly name: string }[];
        readonly dimensions: readonly { readonly id: string; readonly name: string }[];
        readonly evidenceForSubject: (subjectId: string) => string[];
      } => {
        const loads = results.filter((result) => result.name === "load_research_state");
        const state = (loads[loads.length - 1]?.value["state"] ?? {}) as {
          subjects?: { id: string; name: string }[];
          dimensions?: { id: string; name: string }[];
          cells?: { subjectId: string; dimensionId: string; evidenceIds: string[] }[];
        };
        const cells = state.cells ?? [];
        return {
          subjects: state.subjects ?? [],
          dimensions: state.dimensions ?? [],
          evidenceForSubject: (subjectId: string): string[] => [
            ...new Set(cells.filter((cell) => cell.subjectId === subjectId).flatMap((cell) => cell.evidenceIds)),
          ],
        };
      };

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

      // 4. The report stage: the frame-and-mechanism pass. It writes the
      //    sections that explain what the objects are and how they work, and
      //    stops; the synthesis pass compares, concludes and publishes.
      if (instruction.includes("前半部分") || instruction.includes("报告的第一部分")) {
        if (runInstruction !== instruction) {
          runInstruction = instruction;
          runStep = 0;
        }
        runStep += 1;
        if (runStep === 1) return next(call("load_research_state", {}));

        const view = latestResearchView();
        const { subjects, dimensions, evidenceForSubject } = view;
        const dim = (index: number): string => dimensions[index]?.id ?? "";
        const subjectIds = subjects.map((subject) => subject.id);
        const a = evidenceForSubject(subjectIds[0] ?? "")[0] ?? "";
        const b = evidenceForSubject(subjectIds[1] ?? "")[0] ?? a;
        const aCost = evidenceForSubject(subjectIds[0] ?? "")[1] ?? a;
        const bCost = evidenceForSubject(subjectIds[1] ?? "")[1] ?? b;

        if (runStep === 2) {
          return next(
            call("save_report", {
              part: "start",
              title: "GraphRAG 与 HippoRAG：机制差异与证据边界",
              summary:
                "本报告比较两种以图结构组织知识的方法在构建与检索机制上的差异，并说明现有材料不能支持的结论：没有独立评估，成本口径不可比。",
              frame: {
                question: "GraphRAG 与 HippoRAG 在机制上有什么可比较的差异，现有材料能支持到什么程度？",
                audience: "计算机专业研究生的组会",
                scope: "只覆盖 GraphRAG 与 HippoRAG 的方法论文与读到的相关材料，不声称覆盖该领域全部工作。",
              },
              claims: [
                {
                  id: "clm_graphrag_build",
                  claimType: "mechanism",
                  text: "GraphRAG 先抽取实体与关系，再对图做社区检测并预生成社区摘要。",
                  evidenceIds: [a],
                  kind: "fact",
                  subjects: [subjectIds[0] ?? ""],
                  dimensions: [dim(0), dim(1)],
                },
                {
                  id: "clm_hipporag_build",
                  claimType: "mechanism",
                  text: "HippoRAG 用开放信息抽取构建图索引，查询时在图上做扩散检索。",
                  evidenceIds: [b],
                  kind: "fact",
                  subjects: [subjectIds[1] ?? ""],
                  dimensions: [dim(1), dim(2)],
                },
                {
                  id: "clm_compare_build",
                  claimType: "comparison",
                  text: "两者的构建产物不同：GraphRAG 产出社区摘要，HippoRAG 产出可扩散的图索引。",
                  evidenceIds: [a, b],
                  kind: "comparison",
                  subjects: subjectIds,
                  dimensions: [dim(1)],
                  conditions: { scope: "只比较构建产物与检索方式，不比较效果。" },
                },
                {
                  id: "clm_cost",
                  claimType: "cost",
                  text: "在各自报告的实验中，GraphRAG 的索引成本随语料规模增长；HippoRAG 报告一次构建后按查询扩散。",
                  evidenceIds: [aCost, bCost],
                  kind: "fact",
                  subjects: subjectIds,
                  conditions: {
                    costStage: "indexing",
                    comparability: "not-directly-comparable",
                    basis: "author-reported",
                    scope: "两篇论文各自报告口径，规模与硬件未对齐，不能直接比较。",
                  },
                },
                {
                  id: "clm_limit",
                  claimType: "fact",
                  text: "现有材料没有独立评估：效果与成本都来自各自论文的自报口径。",
                  evidenceIds: [aCost],
                  kind: "fact",
                },
              ],
            }),
          );
        }

        const passOneSections: readonly { readonly id: string; readonly title: string; readonly blocks: readonly unknown[] }[] = [
          {
            id: "overview",
            title: "一、研究问题与关键认识",
            blocks: [
              {
                kind: "paragraph",
                text: "本次研究为组会汇报比较两种图结构检索方法，材料只覆盖读到的两篇方法论文，范围与结论都限定在这批材料内。",
                claimIds: [],
              },
              {
                kind: "list",
                items: [
                  { text: "两者都使用图结构，但结构信息被使用的位置不同。", claimIds: ["clm_compare_build"] },
                  { text: "成本来自各自论文口径，不能直接比较。", claimIds: ["clm_cost"] },
                ],
              },
              {
                kind: "callout",
                tone: "gap",
                text: "关键限制：没有独立评估，效果差异只能按各自报告的实验理解；本报告不给出排名。",
              },
            ],
          },
          {
            id: "mental-model",
            title: "二、概念坐标",
            blocks: [
              {
                kind: "paragraph",
                text: "图结构检索的共同思路是把实体与关系显式保存成结构，再让查询使用它；可以按「结构在哪个阶段被使用」分类：构建期预生成摘要，或查询期在图上扩散。理解这条轴之后，后面的比较才有共同坐标。",
                claimIds: ["clm_graphrag_build"],
              },
              {
                kind: "list",
                items: [
                  { text: "社区摘要：面向语料级问题的预生成描述。", claimIds: ["clm_graphrag_build"] },
                  { text: "图索引：查询时用于多跳整合的结构。", claimIds: ["clm_hipporag_build"] },
                ],
              },
            ],
          },
          {
            id: "mechanism",
            title: "三、机制解释",
            blocks: [
              {
                kind: "mechanism",
                title: "GraphRAG：抽取、社区检测、摘要",
                input: "整份语料的文本单元。",
                intermediate: "实体关系图与社区层级摘要。",
                steps: [
                  { text: "从每个文本单元抽取实体与关系。", claimIds: ["clm_graphrag_build"] },
                  { text: "对图做社区检测，并为每个社区生成摘要。", claimIds: ["clm_graphrag_build"] },
                ],
                output: "查询时可被组织成全局回答的社区摘要。",
                tradeoff: "用一次覆盖全语料的处理换取语料级归纳能力。",
                failure: "图抽取质量差时，社区摘要会失真。",
                claimIds: ["clm_graphrag_build"],
              },
              {
                kind: "mechanism",
                title: "HippoRAG：同图索引与扩散检索",
                input: "文档与抽取出的三元组。",
                intermediate: "文档节点与实体节点共享的图索引。",
                steps: [
                  { text: "用开放信息抽取得到三元组并与文档同图。", claimIds: ["clm_hipporag_build"] },
                  { text: "查询时以查询实体为种子在图上扩散，得到整合证据。", claimIds: ["clm_hipporag_build"] },
                ],
                output: "一次扩散即可覆盖多跳的证据集合。",
                tradeoff: "把整合成本放到查询期的图计算，索引期更轻。",
                failure: "查询实体有歧义时扩散会跑到无关子图。",
                claimIds: ["clm_hipporag_build"],
              },
            ],
          },
          {
            id: "representative",
            title: "四、代表工作与对象身份",
            blocks: [
              { kind: "paragraph", text: "GraphRAG（Edge 等）以社区摘要为核心产物。", claimIds: ["clm_graphrag_build"] },
              { kind: "paragraph", text: "HippoRAG 以图上的扩散检索为核心机制。", claimIds: ["clm_hipporag_build"] },
            ],
          },
        ];
        const nextSection = passOneSections[runStep - 3];
        if (nextSection !== undefined) return next(call("save_report", { part: "write", section: nextSection }));
        return next(say("第一部分（框架与机制）已提交，等待综合阶段完成比较、综合与发布。"));
      }

      // 5. The synthesis stage: comparison under shared conditions, the
      //    cross-source judgement, the limits — then validation.
      if (instruction.includes("综合成有界的判断") || instruction.includes("写第二部分")) {
        if (runInstruction !== instruction) {
          runInstruction = instruction;
          runStep = 0;
        }
        runStep += 1;
        if (runStep === 1) return next(call("load_research_state", {}));

        const view = latestResearchView();
        const subjects = view.subjects;
        const dimensions = view.dimensions;
        const subjectIds = subjects.map((subject) => subject.id);
        const dim = (index: number): string => dimensions[index]?.id ?? "";
        const a = view.evidenceForSubject(subjectIds[0] ?? "")[0] ?? "";
        const b = view.evidenceForSubject(subjectIds[1] ?? "")[0] ?? a;

        if (runStep === 2) {
          return next(
            call("save_report", {
              part: "write",
              section: {
                id: "comparison",
                title: "五、条件化比较",
                blocks: [
                  {
                    kind: "table",
                    columns: ["对象", dimensions[1]?.name ?? "结构与构建", dimensions[2]?.name ?? "检索机制"],
                    columnDimensions: [null, dim(1), dim(2)],
                    rowSubjects: subjectIds,
                    rows: [
                      {
                        cells: [
                          { text: subjects[0]?.name ?? "GraphRAG", claimIds: [] },
                          { text: "实体图 + 社区摘要", claimIds: ["clm_graphrag_build"] },
                          { text: "全局搜索映射到社区摘要", claimIds: ["clm_compare_build"] },
                        ],
                      },
                      {
                        cells: [
                          { text: subjects[1]?.name ?? "HippoRAG", claimIds: [] },
                          { text: "文档与三元组同图", claimIds: ["clm_hipporag_build"] },
                          { text: "以查询实体为种子的扩散检索", claimIds: ["clm_compare_build"] },
                        ],
                      },
                    ],
                  },
                  { kind: "paragraph", text: "两者的构建产物不同，这是比较中最直接的差异。", claimIds: ["clm_compare_build"] },
                  {
                    kind: "callout",
                    tone: "gap",
                    dimensionIds: [dim(3), dim(4), dim(5)],
                    text: "实验与评测、成本与资源条件、局限与风险三个维度：本次只读到各自论文的自报口径，没有共同设置下的对照，只能并列报告，不作统一排名。",
                  },
                ],
              },
            }),
          );
        }
        if (runStep === 3) {
          return next(
            call("save_report", {
              part: "write",
              claims: [
                {
                  id: "clm_synthesis",
                  claimType: "synthesis",
                  synthesis: true,
                  text: "综合两篇方法论文可以看出：差异不在是否使用图结构，而在结构信息被使用的阶段——构建期预生成，还是查询期现算。",
                  evidenceIds: [a, b],
                  kind: "inference",
                  subjects: subjectIds,
                  conditions: { scope: "由两条机制证据共同支持；没有独立评估，属于我们的综合判断。" },
                },
                {
                  id: "clm_implication",
                  claimType: "implication",
                  text: "若主要问题是语料级的全局归纳，可先评估 GraphRAG；若主要是多跳事实整合，可先评估 HippoRAG。",
                  evidenceIds: [a, b],
                  kind: "inference",
                  subjects: subjectIds,
                  conditions: { scope: "条件取决于实际查询类型；两篇论文的评测设置不同，需要在自己的数据上验证后再决定。" },
                },
              ],
            }),
          );
        }
        if (runStep === 4) {
          return next(
            call("save_report", {
              part: "write",
              section: {
                id: "synthesis",
                title: "六、综合判断与权衡",
                blocks: [
                  {
                    kind: "paragraph",
                    text: "综合两篇方法论文可以看出：差异不在是否使用图结构，而在结构信息被使用的阶段。",
                    claimIds: ["clm_synthesis"],
                  },
                  {
                    kind: "paragraph",
                    text: "这个区分带来一个可检验的取舍：构建期预生成把成本放在索引阶段，查询期扩散把成本放在查询阶段；两者的成本对照在各自论文中口径不同，因此这里只作为条件化建议。",
                    claimIds: ["clm_implication"],
                  },
                ],
              },
            }),
          );
        }
        if (runStep === 5) {
          return next(
            call("save_report", {
              part: "write",
              section: {
                id: "limitations",
                title: "七、局限、未知与下一步",
                blocks: [
                  {
                    kind: "list",
                    items: [
                      { text: "缺独立评估：效果差异只有作者自报口径。", claimIds: ["clm_limit"] },
                      { text: "成本口径不同：规模与硬件未对齐，不能合成一个「更便宜」。", claimIds: ["clm_cost"] },
                      { text: "下一步应查共同设置下的对照实验，或在自己的语料上做小规模验证。", claimIds: [] },
                    ],
                  },
                ],
              },
            }),
          );
        }
        if (runStep === 6) return next(call("save_report", { part: "finalize" }));
        return next(say("比较、综合与结论已提交，报告已保存并可在工作台预览与导出。"));
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
    // The report stage writes the sections; the synthesis pass is the one
    // that concludes and publishes, so it is the last stage of a pass.
    expect(stages).toContain("report");
    expect(stages[stages.length - 1]).toBe("synthesis");
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
    expect(html.text).toContain("研究问题与关键认识");
    expect(html.text).toContain("<table class=\"matrix\">");
    expect(html.text).toContain("参考来源");
    expect(html.text).toContain("核验索引");
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
