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
  const found = await harness.service.search(harness.taskId, { query: "graph retrieval", limit: 1 });
  if (!found.ok) throw new Error(`search refused: ${found.problems.join("; ")}`);
  const source: Source = harness.service.sourcesOf(harness.taskId)[0] as Source;
  const cell: CellRef = {
    sectionId: "comparison",
    subjectId: harness.service.getTask(harness.taskId)!.subjects[0]!.id,
    dimensionId: harness.service.getTask(harness.taskId)!.dimensions[1]!.id,
  };
  const read = await harness.service.read(harness.taskId, {
    sourceId: source.id,
    question: "该方法的图如何构建",
    terms: ["graph", "community", "construction"],
    targetCell: cell,
    maxEvidence: 2,
  });
  if (!read.ok) throw new Error(`read refused: ${read.problems.join("; ")}`);
  harness.service.clearGrant(SESSION);
  return { evidenceIds: read.evidence.map((item) => item.evidenceId), cell };
}

/** The smallest draft that passes validation for the task's first report. */
function draftFor(task: ReportTask, evidenceIds: readonly string[]) {
  const first = evidenceIds[0] ?? "";
  const second = evidenceIds[1] ?? first;
  return {
    title: "GraphRAG 与图结构检索的机制比较",
    summary: "本报告比较两种图结构检索方法的构建与检索机制。",
    claims: [
      { id: "clm_build", text: "GraphRAG 先抽取实体与关系，再做社区检测与摘要。", evidenceIds: [first], kind: "fact" as const },
      { id: "clm_eval", text: "报告用 LLM 判定的涵盖度作为评测口径。", evidenceIds: [second], kind: "fact" as const },
    ],
    sections: [
      { id: "overview", title: "一、研究任务与关键认识", blocks: [{ kind: "paragraph" as const, text: "本次研究比较图结构检索方法。", claimIds: [] }] },
      { id: "representative", title: "三、代表工作", blocks: [{ kind: "paragraph" as const, text: "GraphRAG 构建实体图谱。", claimIds: ["clm_build"] }] },
      { id: "comparison", title: "四、共同维度比较", blocks: [{ kind: "paragraph" as const, text: "构建方式不同。", claimIds: ["clm_build"] }] },
      { id: "limitations", title: "五、局限与证据缺口", blocks: [{ kind: "paragraph" as const, text: "评测口径来自作者。", claimIds: ["clm_eval"] }] },
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
        sections: [
          {
            id: "comparison",
            title: "四、共同维度比较",
            blocks: [
              { kind: "paragraph", text: "构建流程拆成抽取、社区检测与摘要三步。", claimIds: ["clm_build"] },
              { kind: "callout", tone: "gap", text: "检索机制的独立比较尚未取得依据。" },
            ],
          },
        ],
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
      expect(accepted.ok).toBe(true);
      if (!accepted.ok) return;
      expect(accepted.alreadyApplied).toBe(false);

      const after = harness.service.reportsOf(harness.taskId).find((report) => report.id === accepted.reportId)!;
      expect(after.sections.find((section) => section.id === "comparison")).toEqual({
        id: "comparison",
        title: "四、共同维度比较",
        blocks: [
          { kind: "paragraph", text: "构建流程拆成抽取、社区检测与摘要三步。", claimIds: ["clm_build"] },
          { kind: "callout", tone: "gap", text: "检索机制的独立比较尚未取得依据。" },
        ],
      });
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

describe("auto classification", () => {
  it("sends an unrecognised instruction to Ask, and reads Edit only from explicit wording", () => {
    expect(classifyIntent("GraphRAG 是哪一年发表的？").intent).toBe("ask");
    expect(classifyIntent("成本呢？").intent).toBe("ask");
    expect(classifyIntent("再找独立证据验证 GraphRAG 成本。").intent).toBe("research");
    expect(classifyIntent("把部署成本加入报告。").intent).toBe("edit");
    expect(classifyIntent("这段太难了，简化一下摘要").intent).toBe("edit");
  });
});
