/**
 * The editing semantics, at the scale they are decided.
 *
 * Each test here is one of the contracts the product promises about side
 * effects, and each one is written to fail if the boundary moves: Ask writes
 * nothing, Research changes material but not the report, Edit produces a
 * proposal and nothing else, Accept applies once, a stale proposal cannot
 * overwrite newer text, and an export is rendered from a frozen bundle rather
 * than from whatever the research happens to say now.
 *
 * The service is the real one over a real SQLite database; only the network is
 * absent, because none of these contracts is about the network.
 */

import { describe, expect, it } from "vitest";

import { openResearchRepository, type ResearchRepository } from "../src/repository.js";
import { createResearchService, type ResearchService } from "../src/service.js";
import { classifyIntent } from "../src/semantics.js";
import { renderRevisionHtml } from "../src/render.js";
import { reportContentHash } from "../src/report.js";
import type { ReadOutcome } from "../src/read.js";
import type { SearchOutcome } from "../src/search.js";
import type { CellRef, ReportTask, Source } from "../src/domain.js";

const SESSION = "session_editing_semantics";

interface Harness {
  readonly repo: ResearchRepository;
  readonly service: ResearchService;
  readonly taskId: string;
  close(): void;
}

function open(): Harness {
  const repo = openResearchRepository({ location: ":memory:" });
  const service = createResearchService({
    repo,
    search: async (query, options): Promise<SearchOutcome> => ({
      provider: "arxiv",
      query,
      requestUrl: `https://export.arxiv.org/api/query?search.text=${encodeURIComponent(query)}`,
      fetchedAt: new Date().toISOString(),
      total: 2,
      candidates: [
        {
          title: "Fixture Paper on Graph Retrieval",
          authors: ["A. Author"],
          abstract: "We describe a graph-based retrieval method and its evaluation.",
          absUrl: "https://arxiv.org/abs/2401.00001",
          pdfUrl: null,
          publishedAt: "2024-01-01T00:00:00Z",
          arxivId: "2401.00001",
          primaryCategory: "cs.CL",
          doi: null,
        },
        {
          title: "Fixture Paper on Community Summarisation",
          authors: ["B. Author"],
          abstract: "A second fixture source, used when a later round searches again.",
          absUrl: "https://arxiv.org/abs/2402.00002",
          pdfUrl: null,
          publishedAt: "2024-02-01T00:00:00Z",
          arxivId: "2402.00002",
          primaryCategory: "cs.CL",
          doi: null,
        },
        {
          title: "Fixture Paper on Deployment Costs",
          authors: ["C. Author"],
          abstract: "A third fixture source, discovered by later searches.",
          absUrl: "https://arxiv.org/abs/2403.00003",
          pdfUrl: null,
          publishedAt: "2024-03-01T00:00:00Z",
          arxivId: "2403.00003",
          primaryCategory: "cs.CL",
          doi: null,
        },
      ].slice(0, options.limit),
    }),
    read: async ({ url }): Promise<ReadOutcome> => {
      const second = url.includes("2402.00002");
      const paragraphs = [
        second
          ? "A second fixture document reports an independent evaluation of community-level summarisation for corpus-wide questions."
          : "GraphRAG builds a knowledge graph over the corpus, partitions it into communities, and pre-generates community summaries for query-focused summarization.",
        second
          ? "Its protocol pairs each question with a reference answer and scores faithfulness, which the first fixture does not attempt."
          : "The construction pipeline extracts entities and relations from each text unit, then applies community detection and summarises each community.",
        second
          ? "The authors report that faithfulness degrades for summaries of top-level communities, echoing a limitation the first fixture mentions."
          : "Reported evaluation compares community summaries against source-text summarization using an LLM-judged comprehensiveness rubric.",
      ];
      const text = paragraphs.join("\n\n");
      return {
        status: "ok",
        readUrl: url.replace("/abs/", "/html/"),
        fetchedAt: new Date().toISOString(),
        title: second ? "Fixture Paper on Community Summarisation" : "Fixture Paper on Graph Retrieval",
        scope: "full_text",
        text,
        paragraphs: paragraphs.map((paragraph, index) => {
          const charStart = paragraphs.slice(0, index).reduce((sum, item) => sum + item.length + 2, 0);
          return { index, headingPath: ["Fixture", `Section ${index + 1}`], text: paragraph, charStart, charEnd: charStart + paragraph.length };
        }),
        contentType: "text/html",
        note: "fixture",
        failure: null,
      };
    },
    now: () => new Date("2026-10-05T12:00:00.000Z"),
  });

  // The card stage: the application authorizes it, then the model proposes.
  service.issueGrant({ sessionId: SESSION, intent: "card", taskId: null });
  const proposed = service.proposeTask(SESSION, {
    topic: "GraphRAG 与图结构检索的机制比较",
    purpose: "组会汇报",
    audience: "研究生",
    focus: ["机制差异"],
    exclusions: "",
    lengthTarget: "约 4 页",
    subjects: [{ name: "GraphRAG" }, { name: "HippoRAG" }],
    dimensions: [
      { name: "核心思想", question: "解决什么问题" },
      { name: "结构与构建", question: "如何构建" },
      { name: "检索机制", question: "如何检索" },
    ],
  });
  if (!proposed.ok) throw new Error(`card refused: ${proposed.problems.join("; ")}`);
  const taskId = proposed.task.id;
  service.confirmTask(taskId);
  service.clearGrant(SESSION);
  return { repo, service, taskId, close: () => repo.close() };
}

async function research(harness: Harness): Promise<{ readonly evidenceIds: readonly string[]; readonly cell: CellRef }> {
  harness.service.issueGrant({ sessionId: SESSION, intent: "research", taskId: harness.taskId, allowResearch: true });
  const found = await harness.service.search(harness.taskId, { query: "graph retrieval", limit: 2 });
  if (!found.ok) throw new Error(`search refused: ${found.problems.join("; ")}`);
  const task = harness.service.getTask(harness.taskId)!;
  const sources = harness.service.sourcesOf(harness.taskId);
  const evidenceIds: string[] = [];
  // One read per compared object, like a real pass: each method's own paper,
  // bound to that object's column of the comparison.
  for (const [index, subject] of task.subjects.entries()) {
    const source = sources[index];
    if (source === undefined) continue;
    const read = await harness.service.read(harness.taskId, {
      sourceId: source.id,
      question: `${subject.name} 的图如何构建`,
      terms: ["graph", "community", "construction"],
      targetCell: { sectionId: "comparison", subjectId: subject.id, dimensionId: task.dimensions[1]!.id },
      role: "primary",
      maxEvidence: 2,
    });
    if (!read.ok) throw new Error(`read refused: ${read.problems.join("; ")}`);
    evidenceIds.push(...read.evidence.map((item) => item.evidenceId));
  }
  harness.service.clearGrant(SESSION);
  const cell: CellRef = {
    sectionId: "comparison",
    subjectId: task.subjects[0]!.id,
    dimensionId: task.dimensions[1]!.id,
  };
  return { evidenceIds, cell };
}

/**
 * A draft that satisfies Technical Comparison v2's content contract.
 *
 * The editing contracts are tested against a report that could really be
 * published, so that "the proposal was applied" is never silently a report the
 * validator would have refused: it declares its frame, builds a mental model,
 * explains a mechanism, compares under a declared table, synthesises two
 * sources and states what the material does not support.
 */
function draftFor(task: ReportTask, evidenceIds: readonly string[]) {
  const [a1 = "", a2 = a1, b1 = a1, b2 = b1] = evidenceIds;
  const [subjectA, subjectB] = task.subjects;
  const [dimIdea, dimBuild, dimRetrieval] = task.dimensions;
  return {
    title: "GraphRAG 与图结构检索的机制比较",
    summary: "本报告比较两种图结构检索方法的构建与检索机制，并说明当前材料不能支持的结论。",
    frame: {
      question: "这两种图结构检索方法在构建与检索机制上有什么可比较的差异？",
      audience: task.audience,
      scope: "只比较 GraphRAG 与 HippoRAG 两篇方法论文中的机制与报告设置，不覆盖其他实现。",
    },
    claims: [
      {
        id: "clm_mechanism_a",
        text: "GraphRAG 先抽取实体与关系，再用社区检测与摘要生成对语料的全局描述。",
        evidenceIds: [a1],
        kind: "fact" as const,
        claimType: "mechanism" as const,
        subjects: [subjectA?.id ?? ""],
        dimensions: [dimIdea?.id ?? "", dimBuild?.id ?? ""],
      },
      {
        id: "clm_mechanism_b",
        text: "HippoRAG 把文档与抽取的三元组放进同一图，用图扩散完成整合检索。",
        evidenceIds: [b1],
        kind: "fact" as const,
        claimType: "mechanism" as const,
        subjects: [subjectB?.id ?? ""],
        dimensions: [dimBuild?.id ?? ""],
      },
      {
        id: "clm_compare",
        text: "两者的构建产物不同：一方是社区摘要，另一方是可扩散的图索引。",
        evidenceIds: [a1, b1],
        kind: "comparison" as const,
        claimType: "comparison" as const,
        subjects: [subjectA?.id ?? "", subjectB?.id ?? ""],
        dimensions: [dimBuild?.id ?? ""],
        conditions: { scope: "只比较两者的构建产物，不比较效果。" },
      },
      {
        id: "clm_synth",
        text: "综合两篇方法论文可以看出，差异不在是否使用图，而在结构信息在哪个阶段被利用。",
        evidenceIds: [a1, b1],
        kind: "inference" as const,
        claimType: "synthesis" as const,
        synthesis: true,
        conditions: { scope: "两条机制证据共同支持；未取得独立评估，属于我们的综合判断。" },
      },
      {
        id: "clm_limit",
        text: "现有材料只有作者自报的评测口径，不能据此给出性能排名。",
        evidenceIds: [a2],
        kind: "fact" as const,
        claimType: "fact" as const,
      },
    ],
    sections: [
      {
        id: "overview",
        title: "一、研究问题与关键认识",
        blocks: [
          {
            kind: "paragraph" as const,
            text: "本次研究为组会汇报比较两种图结构检索方法，只覆盖两篇方法论文中的机制与设置。",
            claimIds: [] as string[],
          },
          {
            kind: "list" as const,
            items: [
              { text: "两者的构建产物不同：一方是社区摘要，另一方是可扩散的图索引。", claimIds: ["clm_compare"] },
              { text: "现有材料不能支持性能排名。", claimIds: ["clm_limit"] },
            ],
          },
          { kind: "callout" as const, tone: "gap" as const, text: "关键限制：没有独立评估，效果差异只能按各自报告的实验理解。" },
        ],
      },
      {
        id: "mental-model",
        title: "二、概念坐标",
        blocks: [
          {
            kind: "paragraph" as const,
            text: "图结构检索的共同思路是把文档之外的结构（实体、关系、社区）显式保存下来，再让查询使用它；差异在于结构在索引阶段还是查询阶段被利用。",
            claimIds: ["clm_synth"],
          },
          {
            kind: "list" as const,
            items: [
              { text: "社区摘要：对语料的全局描述，用于全局问题。", claimIds: ["clm_mechanism_a"] },
              { text: "图索引：可扩散的结构，用于多跳整合。", claimIds: ["clm_mechanism_b"] },
            ],
          },
        ],
      },
      {
        id: "mechanism",
        title: "三、机制解释",
        blocks: [
          {
            kind: "mechanism" as const,
            title: "GraphRAG 的构建与查询",
            input: "整份语料的文本单元。",
            intermediate: "实体关系图与社区层级摘要。",
            steps: [
              { text: "从每个文本单元抽取实体与关系。", claimIds: ["clm_mechanism_a"] },
              { text: "对图做社区检测并为每个社区生成摘要。", claimIds: ["clm_mechanism_a"] },
            ],
            output: "可在查询时被组织成全局回答的社区摘要集合。",
            tradeoff: "用一次全语料的 LLM 处理换取语料级归纳能力。",
            failure: "图抽取质量差时，社区摘要会失真。",
            claimIds: ["clm_mechanism_a"],
          },
        ],
      },
      {
        id: "representative",
        title: "四、代表工作与对象身份",
        blocks: [
          { kind: "paragraph" as const, text: "GraphRAG（Edge 等）以社区摘要为核心产物。", claimIds: ["clm_mechanism_a"] },
          { kind: "paragraph" as const, text: "HippoRAG 以图上的扩散检索为核心机制。", claimIds: ["clm_mechanism_b"] },
        ],
      },
      {
        id: "comparison",
        title: "五、条件化比较",
        blocks: [
          {
            kind: "table" as const,
            columns: ["对象", dimBuild?.name ?? "结构与构建"],
            columnDimensions: [null, dimBuild?.id ?? ""],
            rowSubjects: [subjectA?.id ?? "", subjectB?.id ?? ""],
            rows: [
              {
                cells: [
                  { text: subjectA?.name ?? "A", claimIds: [] as string[] },
                  { text: "实体图 + 社区摘要", claimIds: ["clm_mechanism_a"] },
                ],
              },
              {
                cells: [
                  { text: subjectB?.name ?? "B", claimIds: [] as string[] },
                  { text: "文档与三元组同图 + 扩散检索", claimIds: ["clm_mechanism_b"] },
                ],
              },
            ],
          },
          { kind: "paragraph" as const, text: "两者的构建产物不同，这是比较中最直接的差异。", claimIds: ["clm_compare"] },
          {
            kind: "callout" as const,
            tone: "gap" as const,
            dimensionIds: [dimRetrieval?.id ?? ""],
            text: "检索机制维度：本次只读到各自论文的描述，没有独立或共同设置下的比较，暂不下结论。",
          },
        ],
      },
      {
        id: "synthesis",
        title: "六、综合判断与权衡",
        blocks: [
          {
            kind: "paragraph" as const,
            text: "综合两篇方法论文可以看出，差异不在是否使用图，而在结构信息在哪个阶段被利用。",
            claimIds: ["clm_synth"],
          },
        ],
      },
      {
        id: "limitations",
        title: "七、局限、未知与下一步",
        blocks: [
          {
            kind: "list" as const,
            items: [
              { text: "缺独立评估：效果差异只有作者自报口径。", claimIds: ["clm_limit"] },
              { text: "检索机制维度没有取得可比较的依据，下一步应查共同设置下的对照实验。", claimIds: [] as string[] },
            ],
          },
        ],
      },
    ],
  };
}

/** A comparison section a proposal can substitute, still v2-valid. */
function comparisonReplacement(task: ReportTask, claimId: string) {
  const [subjectA, subjectB] = task.subjects;
  const [, dimBuild, dimRetrieval] = task.dimensions;
  return {
    id: "comparison",
    title: "五、条件化比较",
    blocks: [
      {
        kind: "table" as const,
        columns: ["对象", dimBuild?.name ?? "结构与构建"],
        columnDimensions: [null, dimBuild?.id ?? ""],
        rowSubjects: [subjectA?.id ?? "", subjectB?.id ?? ""],
        rows: [
          {
            cells: [
              { text: subjectA?.name ?? "A", claimIds: [] as string[] },
              { text: "构建流程拆成抽取、社区检测与摘要三步。", claimIds: [claimId] },
            ],
          },
          {
            cells: [
              { text: subjectB?.name ?? "B", claimIds: [] as string[] },
              { text: "构建产物是可扩散的图索引。", claimIds: [] as string[] },
            ],
          },
        ],
      },
      { kind: "callout" as const, tone: "gap" as const, dimensionIds: [dimRetrieval?.id ?? ""], text: "检索机制的独立比较尚未取得依据。" },
      { kind: "paragraph" as const, text: "对象身份与构建产物不同，比较只覆盖已取得依据的部分。", claimIds: [claimId] },
    ],
  };
}

function withReport(harness: Harness, evidenceIds: readonly string[]): string {
  const task = harness.service.getTask(harness.taskId)!;
  harness.service.issueGrant({ sessionId: SESSION, intent: "draft", taskId: harness.taskId, allowResearch: true });
  const saved = harness.service.saveReport(harness.taskId, draftFor(task, evidenceIds));
  harness.service.clearGrant(SESSION);
  if (!saved.ok) throw new Error(`report refused: ${saved.problems.join("; ")}`);
  return saved.reportId;
}

/** The content the product promises not to touch during Ask / Research / Edit. */
function reportFingerprint(harness: Harness): { readonly id: string | null; readonly hash: string | null; readonly evidenceCount: number } {
  const task = harness.service.getTask(harness.taskId)!;
  return {
    id: task.currentReportId,
    hash: harness.service.contentHashOf(harness.taskId),
    evidenceCount: harness.service.evidenceOf(harness.taskId).length,
  };
}

describe("A. Ask writes nothing", () => {
  it("refuses every write a run without research or report permission attempts", async () => {
    const harness = open();
    try {
      const { evidenceIds } = await research(harness);
      withReport(harness, evidenceIds);
      const before = reportFingerprint(harness);
      const sourcesBefore = harness.service.sourcesOf(harness.taskId).length;
      const matrixBefore = JSON.stringify(harness.service.cellsOf(harness.taskId));

      // The application starts an Ask action: read-only by construction.
      harness.service.issueGrant({ sessionId: SESSION, intent: "ask", taskId: harness.taskId });

      const searched = await harness.service.search(harness.taskId, { query: "another topic" });
      expect(searched.ok).toBe(false);
      if (!searched.ok) expect(searched.problems.join(" ")).toMatch(/没有授权|不允许/);

      const read = await harness.service.read(harness.taskId, { sourceId: "src_whatever", question: "q" });
      expect(read.ok).toBe(false);
      if (!read.ok) expect(read.problems.join(" ")).toMatch(/没有授权|不允许/);

      const assessed = harness.service.assess(harness.taskId, {
        proposals: [{ cell: { sectionId: "comparison", subjectId: "x", dimensionId: "y" } }],
      });
      expect(assessed.ok).toBe(false);

      const saved = harness.service.saveReport(harness.taskId, draftFor(harness.service.getTask(harness.taskId)!, evidenceIds));
      expect(saved.ok).toBe(false);
      if (!saved.ok) expect(saved.problems.join(" ")).toContain("保存报告");

      const proposed = harness.service.createProposal(harness.taskId, {
        actionId: "act_none",
        sections: [{ id: "comparison", title: "四", blocks: [] }],
        reason: "nope",
      });
      expect(proposed.ok).toBe(false);

      // The formal project state is byte for byte what it was.
      expect(reportFingerprint(harness)).toEqual(before);
      expect(harness.service.sourcesOf(harness.taskId).length).toBe(sourcesBefore);
      expect(JSON.stringify(harness.service.cellsOf(harness.taskId))).toBe(matrixBefore);
      expect(harness.service.assessmentsOf(harness.taskId).length).toBe(0);
    } finally {
      harness.close();
    }
  });

  it("reads the state it is allowed to read", async () => {
    const harness = open();
    try {
      const { evidenceIds } = await research(harness);
      withReport(harness, evidenceIds);
      harness.service.issueGrant({ sessionId: SESSION, intent: "ask", taskId: harness.taskId });
      const state = harness.service.state(harness.taskId);
      expect(state.currentReportId).not.toBeNull();
      expect(state.currentReport?.sections.length).toBeGreaterThan(0);
      expect(state.currentReportHash).toBe(harness.service.contentHashOf(harness.taskId));
    } finally {
      harness.close();
    }
  });
});

describe("B. Research adds material without touching the report", () => {
  it("keeps the report's content hash while evidence and assessments grow", async () => {
    const harness = open();
    try {
      const { evidenceIds, cell } = await research(harness);
      const reportId = withReport(harness, evidenceIds);
      const hashBefore = harness.service.contentHashOf(harness.taskId);
      expect(hashBefore).not.toBeNull();

      // A later research action: more evidence, an assessment, a review flag.
      harness.service.issueGrant({ sessionId: SESSION, intent: "research", taskId: harness.taskId, allowResearch: true });
      const found = await harness.service.search(harness.taskId, { query: "follow up" });
      expect(found.ok).toBe(true);
      const read = await harness.service.read(harness.taskId, {
        sourceId: harness.service.sourcesOf(harness.taskId)[1]!.id,
        question: "检索机制",
        terms: ["summarization", "community"],
        targetCell: cell,
      });
      expect(read.ok).toBe(true);
      const assessed = harness.service.assess(harness.taskId, {
        proposals: [
          {
            cell,
            evidenceIds: read.ok ? read.evidence.map((item) => item.evidenceId) : [],
            relationship: "supports",
            directness: "direct",
            scope: "仅作者自报的评测口径",
            note: "作者在正文中报告了构建流程。",
          },
        ],
      });
      expect(assessed.ok).toBe(true);
      harness.service.clearGrant(SESSION);

      const task = harness.service.getTask(harness.taskId)!;
      expect(task.currentReportId).toBe(reportId);
      expect(harness.service.contentHashOf(harness.taskId)).toBe(hashBefore);
      expect(harness.service.evidenceOf(harness.taskId).length).toBeGreaterThan(evidenceIds.length);
      expect(harness.service.assessmentsOf(harness.taskId).length).toBe(1);
      // The report is flagged for a human, not rewritten.
      expect(task.reportNeedsReview).not.toBeNull();
      expect(task.reportNeedsReview?.reason).toContain("复核");
    } finally {
      harness.close();
    }
  });

  it("stops research from writing a report at all", async () => {
    const harness = open();
    try {
      const { evidenceIds } = await research(harness);
      withReport(harness, evidenceIds);
      const hashBefore = harness.service.contentHashOf(harness.taskId);
      harness.service.issueGrant({ sessionId: SESSION, intent: "research", taskId: harness.taskId, allowResearch: true });
      const refused = harness.service.saveReport(harness.taskId, draftFor(harness.service.getTask(harness.taskId)!, evidenceIds));
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.problems.join(" ")).toContain("research");
      expect(harness.service.contentHashOf(harness.taskId)).toBe(hashBefore);
    } finally {
      harness.close();
    }
  });
});

describe("C, D, E, F. Proposals", () => {
  it("creates a proposal without changing the report, and applies only its target", async () => {
    const harness = open();
    try {
      const { evidenceIds } = await research(harness);
      const reportId = withReport(harness, evidenceIds);
      const before = harness.service.reportsOf(harness.taskId).find((report) => report.id === reportId)!;
      const hashBefore = reportContentHash(before);

      harness.service.issueGrant({
        sessionId: SESSION,
        intent: "edit",
        taskId: harness.taskId,
        targetType: "section",
        targetId: "comparison",
        allowResearch: false,
      });
      const created = harness.service.createProposal(harness.taskId, {
        actionId: "act_edit_1",
        sections: [comparisonReplacement(harness.service.getTask(harness.taskId)!, "clm_mechanism_a")],
        reason: "把构建流程写清楚，并标出仍缺依据的部分。",
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      // Before acceptance nothing about the report changed.
      expect(harness.service.contentHashOf(harness.taskId)).toBe(hashBefore);
      const untouched = harness.service.reportsOf(harness.taskId).find((report) => report.id === reportId)!;
      expect(untouched.sections.find((section) => section.id === "overview")).toEqual(
        before.sections.find((section) => section.id === "overview"),
      );
      expect(created.proposal.status).toBe("pending");
      expect(created.proposal.baseContentHash).toBe(hashBefore);

      // Accepting changes the authorized section and nothing else.
      const accepted = harness.service.acceptProposal(created.proposal.id);
      expect(accepted.ok, accepted.ok ? "" : accepted.problems.join("; ")).toBe(true);
      if (!accepted.ok) return;
      expect(accepted.alreadyApplied).toBe(false);

      const after = harness.service.reportsOf(harness.taskId).find((report) => report.id === accepted.reportId)!;
      expect(after.sections.find((section) => section.id === "comparison")).toEqual(
        comparisonReplacement(harness.service.getTask(harness.taskId)!, "clm_mechanism_a"),
      );
      for (const section of before.sections) {
        if (section.id === "comparison") continue;
        expect(after.sections.find((candidate) => candidate.id === section.id)).toEqual(section);
      }
      expect(after.summary).toBe(before.summary);
      expect(after.title).toBe(before.title);
      // The previous version still exists as its own record.
      expect(harness.service.reportsOf(harness.taskId).map((report) => report.id)).toContain(reportId);

      // Idempotence: a second accept reports the same report and writes nothing.
      const again = harness.service.acceptProposal(created.proposal.id);
      expect(again.ok).toBe(true);
      if (again.ok) {
        expect(again.alreadyApplied).toBe(true);
        expect(again.reportId).toBe(accepted.reportId);
      }
      expect(harness.service.reportsOf(harness.taskId).length).toBe(2);
      expect(harness.service.getTask(harness.taskId)!.currentReportId).toBe(accepted.reportId);
    } finally {
      harness.close();
    }
  });

  it("refuses a stale proposal instead of overwriting newer text", async () => {
    const harness = open();
    try {
      const { evidenceIds } = await research(harness);
      withReport(harness, evidenceIds);
      harness.service.issueGrant({
        sessionId: SESSION,
        intent: "edit",
        taskId: harness.taskId,
        targetType: "section",
        targetId: "comparison",
        allowResearch: false,
      });
      const created = harness.service.createProposal(harness.taskId, {
        actionId: "act_edit_stale",
        sections: [{ id: "comparison", title: "四、共同维度比较", blocks: [{ kind: "paragraph", text: "旧提案内容。", claimIds: [] }] }],
        reason: "基于旧版本的修改。",
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      harness.service.clearGrant(SESSION);

      // The user regenerates the report: a new version becomes current while
      // the proposal is still pending.
      const regenerated = withReport(harness, evidenceIds);
      expect(harness.service.getTask(harness.taskId)!.currentReportId).toBe(regenerated);

      const accepted = harness.service.acceptProposal(created.proposal.id);
      expect(accepted.ok).toBe(false);
      if (!accepted.ok) expect(accepted.problems.join(" ")).toContain("基线已变化");
      expect(harness.service.proposalById(created.proposal.id)?.status).toBe("stale");
      expect(harness.service.getTask(harness.taskId)!.currentReportId).toBe(regenerated);
    } finally {
      harness.close();
    }
  });

  it("discards a proposal while keeping the research it obtained", async () => {
    const harness = open();
    try {
      const { evidenceIds } = await research(harness);
      withReport(harness, evidenceIds);
      const evidenceBefore = harness.service.evidenceOf(harness.taskId).length;
      const sourcesBefore = harness.service.sourcesOf(harness.taskId).length;

      // An authorized Edit that also researched: the material it found must
      // outlive the proposal.
      harness.service.issueGrant({
        sessionId: SESSION,
        intent: "edit",
        taskId: harness.taskId,
        targetType: "section",
        targetId: "overview",
        allowResearch: true,
      });
      const found = await harness.service.search(harness.taskId, { query: "new material for the edit" });
      expect(found.ok).toBe(true);
      const secondSource = harness.service.sourcesOf(harness.taskId).find((source) => source.url.includes("2402.00002"));
      expect(secondSource, "the edit's search must have registered a new source").toBeDefined();
      const gained = await harness.service.read(harness.taskId, {
        sourceId: secondSource!.id,
        question: "独立评估如何评测",
        terms: ["faithfulness", "evaluation", "question"],
      });
      expect(gained.ok).toBe(true);
      const evidenceAfterResearch = harness.service.evidenceOf(harness.taskId).length;
      expect(evidenceAfterResearch).toBeGreaterThan(evidenceBefore);
      const created = harness.service.createProposal(harness.taskId, {
        actionId: "act_edit_discard",
        sections: [{ id: "overview", title: "一、研究任务与关键认识", blocks: [{ kind: "paragraph", text: "改写后的认识。", claimIds: [] }] }],
        reason: "换一种讲法。",
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const discarded = harness.service.discardProposal(created.proposal.id);
      expect(discarded.ok).toBe(true);
      expect(harness.service.proposalById(created.proposal.id)?.status).toBe("discarded");
      expect(harness.service.evidenceOf(harness.taskId).length).toBe(evidenceAfterResearch);
      expect(harness.service.evidenceOf(harness.taskId).length).toBeGreaterThan(evidenceBefore);
      expect(harness.service.sourcesOf(harness.taskId).length).toBeGreaterThan(sourcesBefore);

      // A discarded proposal cannot be accepted afterwards.
      const accepted = harness.service.acceptProposal(created.proposal.id);
      expect(accepted.ok).toBe(false);
    } finally {
      harness.close();
    }
  });

  it("keeps one pending proposal per project and refuses to widen an Edit's target", async () => {
    const harness = open();
    try {
      const { evidenceIds } = await research(harness);
      withReport(harness, evidenceIds);
      harness.service.issueGrant({
        sessionId: SESSION,
        intent: "edit",
        taskId: harness.taskId,
        targetType: "section",
        targetId: "comparison",
        allowResearch: false,
      });
      // A section-scoped Edit cannot quietly widen itself to another section.
      const widened = harness.service.createProposal(harness.taskId, {
        actionId: "act_c",
        sections: [
          { id: "comparison", title: "四", blocks: [{ kind: "paragraph", text: "正文。", claimIds: [] }] },
          { id: "limitations", title: "五", blocks: [{ kind: "paragraph", text: "顺手改掉。", claimIds: [] }] },
        ],
        reason: "顺手多改一节。",
      });
      expect(widened.ok).toBe(false);
      if (!widened.ok) expect(widened.problems.join(" ")).toContain("limitations");

      const first = harness.service.createProposal(harness.taskId, {
        actionId: "act_a",
        sections: [{ id: "comparison", title: "四", blocks: [{ kind: "paragraph", text: "第一版。", claimIds: [] }] }],
        reason: "第一次修改。",
      });
      expect(first.ok).toBe(true);

      // One project keeps at most one proposal waiting for a decision.
      const second = harness.service.createProposal(harness.taskId, {
        actionId: "act_b",
        sections: [{ id: "comparison", title: "四", blocks: [{ kind: "paragraph", text: "第二版。", claimIds: [] }] }],
        reason: "第二次修改。",
      });
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.problems.join(" ")).toContain("待接受");
    } finally {
      harness.close();
    }
  });
});

describe("G. Frozen export is isolated from later research", () => {
  it("re-renders identically after the matrix and evidence have moved on", async () => {
    const harness = open();
    try {
      const { evidenceIds, cell } = await research(harness);
      withReport(harness, evidenceIds);
      const frozen = harness.service.freezeRevision({ taskId: harness.taskId });
      expect(frozen.ok).toBe(true);
      if (!frozen.ok) return;
      const htmlBefore = renderRevisionHtml({ revision: frozen.revision });
      expect(frozen.revision.gapsCaptured).toBe(true);
      expect(frozen.revision.evidenceRefs.length).toBeGreaterThan(0);

      // Later research: new evidence, a new assessment, a different matrix.
      harness.service.issueGrant({ sessionId: SESSION, intent: "research", taskId: harness.taskId, allowResearch: true });
      await harness.service.search(harness.taskId, { query: "later" });
      const read = await harness.service.read(harness.taskId, {
        sourceId: harness.service.sourcesOf(harness.taskId)[1]!.id,
        question: "更多证据",
        terms: ["community", "summarization"],
        targetCell: cell,
      });
      expect(read.ok).toBe(true);
      harness.service.assess(harness.taskId, {
        proposals: [{ cell, evidenceIds: harness.service.evidenceOf(harness.taskId).slice(-1).map((item) => item.id), relationship: "contradicts", directness: "direct", rationale: "冲突" }],
      });
      harness.service.clearGrant(SESSION);

      // The frozen bundle re-reads from the store and renders the same file.
      const reread = harness.service.revisionById(frozen.revision.id)!;
      const htmlAfter = renderRevisionHtml({ revision: reread });
      expect(htmlAfter).toBe(htmlBefore);
      // Nothing from the later research leaked into it.
      for (const item of harness.service.evidenceOf(harness.taskId)) {
        if (reread.evidenceRefs.some((ref) => ref.evidenceId === item.id)) continue;
        expect(htmlAfter).not.toContain(item.excerpt.slice(0, 40));
      }
      expect(reread.contentHash).toBe(harness.service.revisionForReport(reread.reportId)?.contentHash);
    } finally {
      harness.close();
    }
  });

  it("freezes the same report content once", async () => {
    const harness = open();
    try {
      const { evidenceIds } = await research(harness);
      withReport(harness, evidenceIds);
      const first = harness.service.freezeRevision({ taskId: harness.taskId });
      const second = harness.service.freezeRevision({ taskId: harness.taskId });
      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(second.existing).toBe(true);
      expect(second.revision.id).toBe(first.revision.id);
      expect(harness.service.revisionsOf(harness.taskId).length).toBe(1);
    } finally {
      harness.close();
    }
  });

  it("refuses to freeze content that does not match the expected hash", async () => {
    const harness = open();
    try {
      const { evidenceIds } = await research(harness);
      withReport(harness, evidenceIds);
      const refused = harness.service.freezeRevision({ taskId: harness.taskId, expectedContentHash: "sha256:not-the-current-one" });
      expect(refused.ok).toBe(false);
      expect(harness.service.revisionsOf(harness.taskId).length).toBe(0);
    } finally {
      harness.close();
    }
  });

  it("marks a legacy report's revision as lacking a gap snapshot", async () => {
    const harness = open();
    try {
      const { evidenceIds } = await research(harness);
      const reportId = withReport(harness, evidenceIds);
      // An old record: written before reports carried their own gap snapshot.
      const stored = harness.service.reportsOf(harness.taskId).find((report) => report.id === reportId)!;
      const legacy = { ...stored };
      delete (legacy as { gapsAtSave?: unknown }).gapsAtSave;
      delete (legacy as { contentHash?: unknown }).contentHash;
      harness.repo.saveReport(legacy);

      const frozen = harness.service.freezeRevision({ taskId: harness.taskId });
      expect(frozen.ok).toBe(true);
      if (!frozen.ok) return;
      expect(frozen.revision.gapsCaptured).toBe(false);
      expect(frozen.revision.gaps).toEqual([]);
      const html = renderRevisionHtml({ revision: frozen.revision });
      expect(html).toContain("缺口快照：本版本未记录（旧版记录）");
    } finally {
      harness.close();
    }
  });
});

describe("H, I. Evidence is not sufficiency", () => {
  it("leaves a cell unassessed when material arrived without a judgement", async () => {
    const harness = open();
    try {
      const { cell } = await research(harness);
      const cells = harness.service.cellsOf(harness.taskId);
      const target = cells.find((entry) => entry.subjectId === cell.subjectId && entry.dimensionId === cell.dimensionId);
      expect(target?.status).toBe("unassessed");
      expect(target?.gap.length).toBeGreaterThan(0);
    } finally {
      harness.close();
    }
  });

  it("turns a limited or contradictory judgement into an honest state", async () => {
    const harness = open();
    try {
      const { evidenceIds, cell } = await research(harness);
      harness.service.issueGrant({ sessionId: SESSION, intent: "research", taskId: harness.taskId, allowResearch: true });
      harness.service.assess(harness.taskId, {
        proposals: [
          { cell, evidenceIds, relationship: "supports", directness: "indirect", scope: "迁移实验，任务不同", rationale: "任务与问题不一致" },
        ],
      });
      const limited = harness.service.cellsOf(harness.taskId).find((entry) => entry.dimensionId === cell.dimensionId);
      expect(limited?.status).toBe("limited");
      expect(limited?.gap.length).toBeGreaterThan(0);

      harness.service.assess(harness.taskId, {
        proposals: [
          { cell, evidenceIds: evidenceIds.slice(0, 1), relationship: "contradicts", directness: "direct", rationale: "另一处结论相反" },
        ],
      });
      const conflicted = harness.service.cellsOf(harness.taskId).find((entry) => entry.dimensionId === cell.dimensionId);
      expect(conflicted?.status).toBe("conflict");
    } finally {
      harness.close();
    }
  });
});

describe("the report structure is fixed by the task", () => {
  it("refuses a section whose id the research structure does not define", async () => {
    const harness = open();
    try {
      const { evidenceIds } = await research(harness);
      harness.service.issueGrant({ sessionId: SESSION, intent: "draft", taskId: harness.taskId, allowResearch: false });
      const draft = draftFor(harness.service.getTask(harness.taskId)!, evidenceIds);
      const saved = harness.service.saveReport(harness.taskId, {
        ...draft,
        sections: [...draft.sections, { id: "invented-section", title: "自造章节", blocks: [] }],
      });
      expect(saved.ok).toBe(false);
      if (!saved.ok) {
        expect(saved.problems.join(" ")).toContain("invented-section");
        expect(saved.guidance).toContain("comparison");
      }
      // The incremental path refuses it too, before anything is accumulated.
      const part = harness.service.saveReportPart(harness.taskId, {
        kind: "write",
        section: { id: "invented-section", title: "自造章节", blocks: [] },
      });
      expect(part.ok).toBe(false);
    } finally {
      harness.close();
    }
  });
});

describe("auto classification", () => {
  it("sends an unrecognised instruction to Ask, and reads Edit only from explicit wording", () => {
    expect(classifyIntent("GraphRAG 是哪一年发表的？").intent).toBe("ask");
    expect(classifyIntent("成本呢？").intent).toBe("ask");
    expect(classifyIntent("再找独立证据验证 GraphRAG 成本。").intent).toBe("research");
    expect(classifyIntent("把部署成本加入报告。").intent).toBe("edit");
    expect(classifyIntent("这段太难了，简化一下摘要").intent).toBe("edit");
  });
});
