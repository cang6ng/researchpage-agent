/**
 * A3: the real render route, from real material to a real PDF.
 *
 * This is deliberately not a hand-written demo page. Two papers are really
 * read, evidence is really extracted from their saved text, a structured report
 * cites that evidence, and the renderer under test turns it into a Chinese
 * document with a comparison table — which the browser then prints to a PDF
 * file. The assertions cover what a reader would notice: the file is a PDF, it
 * has real bytes and pages, and the HTML it came from holds the Chinese text,
 * the table and the references.
 */

import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { Evidence, Paragraph, Report, ReportTask, Source } from "../src/domain.js";
import { DEFAULT_BUDGET } from "../src/domain.js";
import { draftEvidence, pickParagraphs, tokenize } from "../src/evidence.js";
import { exportHtmlToPdf, findPdfBrowser } from "../src/pdf.js";
import { readSource } from "../src/read.js";
import { renderReportHtml } from "../src/render.js";
import { searchArxiv } from "../src/search.js";

const enabled = process.env["RESEARCHPAGE_REAL_NETWORK"] === "1";

const now = new Date().toISOString();

function taskFixture(): ReportTask {
  return {
    id: "task_0000000000000000",
    sessionId: "session-fixture",
    topic: "GraphRAG 与代表方法比较",
    purpose: "组会汇报准备",
    audience: "计算机专业研究生",
    focus: ["方法机制", "证据条件"],
    exclusions: "",
    language: "zh",
    lengthTarget: "约 2 页",
    status: "researching",
    confirmedAt: now,
    structure: { sections: [] },
    subjects: [
      { id: "sub_graphrag", name: "GraphRAG" },
      { id: "sub_hipporag", name: "HippoRAG" },
    ],
    dimensions: [
      { id: "dim_core", name: "核心思想", question: "方法的整体思路是什么" },
      { id: "dim_graph", name: "图/记忆构建", question: "如何构建图或记忆结构" },
    ],
    matrix: [],
    budget: DEFAULT_BUDGET,
    usage: { searches: 2, reads: 2, gapRounds: 1 },
    currentReportId: null,
    reportDraft: null,
    createdAt: now,
    updatedAt: now,
    error: null,
  };
}

function sourceFixture(input: {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly authors: readonly string[];
  readonly abstract: string;
}): Source {
  return {
    id: input.id,
    taskId: "task_0000000000000000",
    title: input.title,
    authors: input.authors,
    org: "",
    url: input.url,
    pdfUrl: null,
    doi: null,
    publishedAt: "2024-04-24T00:00:00Z",
    venue: "arXiv",
    abstract: input.abstract,
    discovery: { provider: "arxiv", query: "GraphRAG", queriedAt: now, target: null },
    readStatus: "ok",
    readScope: "full_text",
    readAt: now,
    readUrl: input.url,
    retrievalNote: "取得公开 HTML 正文并以 full_text 记录",
    failure: null,
    snapshotId: `read_${input.id}`,
  };
}

describe.skipIf(!enabled)("A3 real render to PDF (network + browser)", () => {
  it("prints a real Chinese report with a table and citations to a PDF", { timeout: 240_000 }, async () => {
    const browser = findPdfBrowser();
    expect(browser, "no Chrome/Edge on this machine").toBeDefined();

    // Two real papers, really read.
    const graphrag = await readSource({ url: "https://arxiv.org/abs/2404.16130" });
    const hipporag = await readSource({ url: "https://arxiv.org/abs/2405.14831" });
    expect(graphrag.status, graphrag.failure ?? "").toBe("ok");
    expect(hipporag.status, hipporag.failure ?? "").toBe("ok");

    const searched = await searchArxiv("GraphRAG query-focused summarization", { limit: 3 });
    const searchMeta = searched.candidates[0];

    const task = taskFixture();
    const sources: Source[] = [
      sourceFixture({
        id: "src_graphrag00000000",
        title: graphrag.title,
        url: "https://arxiv.org/abs/2404.16130",
        authors: ["Darren Edge", "Ha Trinh", "Newman Cheng"],
        abstract: searchMeta?.abstract ?? "",
      }),
      sourceFixture({
        id: "src_hipporag0000000",
        title: hipporag.title,
        url: "https://arxiv.org/abs/2405.14831",
        authors: ["Bernal Jiménez Gutiérrez", "Yiheng Shu", "Yu Su"],
        abstract: "",
      }),
    ];

    const evidence: Evidence[] = [];
    const pick = (document: { paragraphs: readonly Paragraph[]; text: string; scope: string | null }, sourceId: string, terms: string, readId: string): Evidence => {
      const picks = pickParagraphs(document.paragraphs, tokenize(terms), 1);
      expect(picks.length, `no paragraph picked for ${sourceId}`).toBeGreaterThan(0);
      const item = draftEvidence({
        taskId: task.id,
        sourceId,
        readId,
        readScope: (document.scope ?? "full_text") as Evidence["readScope"],
        draft: { paragraph: picks[0]!.paragraph, cells: [], pickedBecause: picks[0]!.because },
        now,
      });
      return item;
    };

    const graphragIdea = pick(graphrag, sources[0]!.id, "graph-based RAG sensemaking over an entire corpus community summaries", "read_graphrag000000");
    const graphragGraph = pick(graphrag, sources[0]!.id, "entity knowledge graph extraction community detection", "read_graphrag000000");
    const hipporagIdea = pick(hipporag, sources[1]!.id, "neurobiologically inspired long-term memory personalization", "read_hipporag000000");
    const hipporagGraph = pick(hipporag, sources[1]!.id, "knowledge graph indexing open information extraction", "read_hipporag000000");
    evidence.push(graphragIdea, graphragGraph, hipporagIdea, hipporagGraph);

    const report: Report = {
      id: "rep_0000000000000000",
      taskId: task.id,
      title: "GraphRAG 与 HippoRAG：图结构检索方法的机制比较",
      summary:
        "本报告比较两种以图结构组织知识的检索增强方法：GraphRAG 以实体知识图谱与社区摘要支持全局式归纳问答，HippoRAG 以受海马体启发的记忆索引支持多跳整合检索。两者都试图在传统向量检索之外补充结构化的全局信息。",
      sections: [
        {
          id: "overview",
          title: "一、研究任务与关键认识",
          blocks: [
            {
              kind: "paragraph",
              text: "本次研究面向组会汇报，聚焦两类方法的机制差异与各自适用的检索场景。",
              claimIds: [],
            },
            {
              kind: "paragraph",
              text: "GraphRAG 的核心是把语料预处理成实体知识图谱，并在其上生成社区摘要，用于回答需要覆盖整个语料的问题。",
              claimIds: ["clm_graphrag_idea"],
            },
            {
              kind: "paragraph",
              text: "HippoRAG 的核心是受神经生物学记忆机制启发，用知识图谱作为长期记忆索引，服务需要跨文档整合的多跳检索。",
              claimIds: ["clm_hipporag_idea"],
            },
          ],
        },
        {
          id: "background",
          title: "二、背景与方法分类",
          blocks: [
            {
              kind: "list",
              items: [
                { text: "全局式问答：问题需要理解整个语料库的主题结构，而非检索若干相关片段。", claimIds: [] },
                { text: "多跳整合检索：答案分散在多个文档中，需要沿关系链把信息连接起来。", claimIds: [] },
              ],
            },
          ],
        },
        {
          id: "representative",
          title: "三、代表工作",
          blocks: [
            { kind: "paragraph", text: "GraphRAG（Edge 等）提出图谱 + 社区摘要的检索增强路线。", claimIds: ["clm_graphrag_graph"] },
            { kind: "paragraph", text: "HippoRAG（Gutiérrez 等）提出以知识图谱作为长期记忆索引的检索路线。", claimIds: ["clm_hipporag_graph"] },
          ],
        },
        {
          id: "comparison",
          title: "四、共同维度比较",
          blocks: [
            {
              kind: "table",
              columns: ["方法", "核心思想", "图/记忆构建"],
              rows: [
                {
                  cells: [
                    { text: "GraphRAG", claimIds: [] },
                    { text: "用社区摘要回答覆盖整个语料的全局问题", claimIds: ["clm_graphrag_idea"] },
                    { text: "从语料抽取实体与关系，构建知识图谱并做社区检测", claimIds: ["clm_graphrag_graph"] },
                  ],
                },
                {
                  cells: [
                    { text: "HippoRAG", claimIds: [] },
                    { text: "以长期记忆索引支持多跳整合检索", claimIds: ["clm_hipporag_idea"] },
                    { text: "开放信息抽取构建知识图谱，作为检索的记忆结构", claimIds: ["clm_hipporag_graph"] },
                  ],
                },
              ],
            },
            {
              kind: "callout",
              tone: "gap",
              text: "部署成本与资源条件：本次材料未读取到可直接比较的官方设置说明，不做结论。",
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
                { text: "两种方法解决的问题并不完全相同，跨方法的直接性能排名需要谨慎对待。", claimIds: [] },
                { text: "本报告未覆盖两种方法的完整实验设置与硬件条件。", claimIds: [] },
              ],
            },
          ],
        },
      ],
      claims: [
        { id: "clm_graphrag_idea", text: "GraphRAG 用知识图谱与社区摘要服务全局式问答。", evidenceIds: [graphragIdea.id], kind: "fact" },
        { id: "clm_graphrag_graph", text: "GraphRAG 从语料抽取实体关系构建图谱并做社区检测。", evidenceIds: [graphragGraph.id], kind: "fact" },
        { id: "clm_hipporag_idea", text: "HippoRAG 以神经生物学启发的记忆索引支持整合检索。", evidenceIds: [hipporagIdea.id], kind: "fact" },
        { id: "clm_hipporag_graph", text: "HippoRAG 用开放信息抽取构建知识图谱作为记忆结构。", evidenceIds: [hipporagGraph.id], kind: "fact" },
      ],
      validation: { ok: true, problems: [], checkedAt: now },
      createdAt: now,
    };

    const html = renderReportHtml({
      task,
      report,
      sources,
      evidence,
      gaps: [],
      subjectNames: new Map([
        ["sub_graphrag", "GraphRAG"],
        ["sub_hipporag", "HippoRAG"],
      ]),
      dimensionNames: new Map([
        ["dim_core", "核心思想"],
        ["dim_graph", "图/记忆构建"],
      ]),
      generatedAt: now,
    });

    // The HTML itself must carry the Chinese content, the table and references.
    expect(html).toContain("研究任务与关键认识");
    expect(html).toContain("<table class=\"matrix\">");
    expect(html).toContain("参考来源");
    expect(html).toContain("[1]");
    // The default projection is a compact verification index, not an evidence dump.
    expect(html).toContain("核验索引");

    const dir = process.env["RESEARCHPAGE_KEEP_ARTIFACTS"] ?? mkdtempSync(join(tmpdir(), "researchpage-a3-"));
    try {
      const outPath = join(dir, "report-a3.pdf");
      const result = await exportHtmlToPdf({ html, outPath });
      expect(result.ok, result.ok ? "" : result.failure).toBe(true);
      if (!result.ok) return;

      const bytes = readFileSync(outPath);
      expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      const stats = statSync(outPath);
      expect(stats.size).toBeGreaterThan(20_000);
      const asText = bytes.toString("latin1");
      const pageCount = /\/Count (\d+)/.exec(asText);
      console.log(`[pdf] ${outPath} bytes=${stats.size} pages=${pageCount?.[1] ?? "?"} browser=${result.browser}`);
      if (pageCount !== null) expect(Number.parseInt(pageCount[1] ?? "0", 10)).toBeGreaterThanOrEqual(1);
    } finally {
      if (process.env["RESEARCHPAGE_KEEP_ARTIFACTS"] === undefined) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
