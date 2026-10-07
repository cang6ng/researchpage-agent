/**
 * Scenario 1 of the user acceptance: rewriting the synthesis section.
 *
 * The user asked for a section to become four plain paragraphs — the two
 * engineers, the two weeks, deliverables, stop conditions — and the product
 * showed「接受这一节修改」, waited for the reader to finish reading, and only
 * then refused with a validator complaint that the section no longer carried a
 * synthesis. That order is the defect: a pending proposal must mean "if the
 * base has not gone stale, this already satisfies the report's contract".
 *
 * These tests drive the real tool the model calls, against the real service, so
 * the repair path is exercised the way a run exercises it: a first submission
 * that loses an obligation, the problems it gets back, one repair, and — when
 * the repair is right — a pending proposal that accept really applies.
 */

import { describe, expect, it } from "vitest";

import { openResearchRepository, type ResearchRepository } from "../src/repository.js";
import { sealReport } from "../src/report.js";
import { createResearchService, type ResearchService } from "../src/service.js";
import { createResearchTools, type ResearchTools } from "../src/tools.js";
import type { ReadOutcome } from "../src/read.js";
import type { SearchOutcome } from "../src/search.js";
import type { ReportTask } from "../src/domain.js";
import type { RuntimeContext } from "@every-dagent/agent-core";

const SESSION = "session_edit_preflight";

function context(): RuntimeContext {
  return { sessionId: SESSION, signal: new AbortController().signal };
}

interface Harness {
  readonly repo: ResearchRepository;
  readonly service: ResearchService;
  readonly tools: ResearchTools;
  readonly taskId: string;
  close(): void;
}

function open(): Harness {
  const repo = openResearchRepository({ location: ":memory:" });
  const service = createResearchService({
    repo,
    search: async (query): Promise<SearchOutcome> => ({
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
          abstract: "A second fixture source.",
          absUrl: "https://arxiv.org/abs/2402.00002",
          pdfUrl: null,
          publishedAt: "2024-02-01T00:00:00Z",
          arxivId: "2402.00002",
          primaryCategory: "cs.CL",
          doi: null,
        },
        // A third paper that only a cost-focused query finds, so a later action
        // can add material the project did not already hold.
        ...(query.toLowerCase().includes("cost")
          ? [
              {
                title: "Fixture Paper on Indexing Cost",
                authors: ["C. Author"],
                abstract: "We report indexing costs in tokens.",
                absUrl: "https://arxiv.org/abs/2403.00003",
                pdfUrl: null,
                publishedAt: "2024-03-01T00:00:00Z",
                arxivId: "2403.00003",
                primaryCategory: "cs.CL",
                doi: null,
              },
            ]
          : []),
      ],
    }),
    read: async (request): Promise<ReadOutcome> => {
      const paragraphs = [
        "GraphRAG 在索引阶段抽取实体与关系，然后做社区检测并为每个社区生成摘要。",
        "HippoRAG 把文档与抽取的三元组放进同一张图，用图扩散完成整合检索。",
        "两篇论文各自报告了评测设置，但设置不同，不能直接比较效果。",
      ];
      return {
        status: "ok",
        readUrl: request.url,
        fetchedAt: new Date().toISOString(),
        scope: "full_text",
        title: "Fixture read",
        contentType: "text/html",
        failure: null,
        text: paragraphs.join("\n\n"),
        paragraphs: paragraphs.map((text, index) => ({
          index,
          headingPath: ["正文"],
          text,
          charStart: paragraphs.slice(0, index).reduce((sum, item) => sum + item.length + 2, 0),
          charEnd: paragraphs.slice(0, index).reduce((sum, item) => sum + item.length + 2, 0) + text.length,
        })),
        note: "",
      };
    },
    now: () => new Date("2026-10-08T09:00:00.000Z"),
  });

  service.issueGrant({ sessionId: SESSION, intent: "card", taskId: null });
  const proposed = service.proposeTask(SESSION, {
    topic: "图结构检索的机制比较",
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
  return { repo, service, tools: createResearchTools(service), taskId, close: () => repo.close() };
}

async function research(harness: Harness): Promise<readonly string[]> {
  harness.service.issueGrant({ sessionId: SESSION, intent: "research", taskId: harness.taskId, allowResearch: true });
  const found = await harness.service.search(harness.taskId, { query: "graph retrieval", limit: 2 });
  if (!found.ok) throw new Error(`search refused: ${found.problems.join("; ")}`);
  const task = harness.service.getTask(harness.taskId)!;
  const sources = harness.service.sourcesOf(harness.taskId);
  const evidenceIds: string[] = [];
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
  return evidenceIds;
}

function draftFor(task: ReportTask, evidenceIds: readonly string[]) {
  const [a1 = "", a2 = a1, b1 = a1] = evidenceIds;
  const [subjectA, subjectB] = task.subjects;
  const [dimIdea, dimBuild, dimRetrieval] = task.dimensions;
  return {
    title: "图结构检索的机制比较",
    summary: "本报告比较两种图结构检索方法的构建与检索机制，并说明材料不能支持的部分。",
    frame: {
      question: "这两种图结构检索方法在构建与检索机制上有什么可比较的差异？",
      audience: task.audience,
      scope: "只比较两篇方法论文中的机制与报告设置。",
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
        conditions: { scope: "两条机制证据共同支持；未取得独立评估。" },
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
              { text: "两者的构建产物不同。", claimIds: ["clm_compare"] },
              { text: "现有材料不能支持性能排名。", claimIds: ["clm_limit"] },
            ],
          },
          { kind: "callout" as const, tone: "gap" as const, text: "关键限制：没有独立评估。" },
        ],
      },
      {
        id: "mental-model",
        title: "二、概念坐标",
        blocks: [
          {
            kind: "paragraph" as const,
            text: "图结构检索的共同思路是把文档之外的结构显式保存下来，再让查询使用它；差异在于结构在哪个阶段被利用。",
            claimIds: ["clm_synth"],
          },
          {
            kind: "list" as const,
            items: [
              { text: "社区摘要：对语料的全局描述。", claimIds: ["clm_mechanism_a"] },
              { text: "图索引：可扩散的结构。", claimIds: ["clm_mechanism_b"] },
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
          {
            kind: "callout" as const,
            tone: "gap" as const,
            dimensionIds: [dimRetrieval?.id ?? ""],
            text: "检索机制维度：只有各自论文的描述，暂不下结论。",
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
              { text: "缺独立评估：效果差异只有作者自报口径，因此不能给出排名，下一步应查共同设置下的对照实验。", claimIds: ["clm_limit"] },
              { text: "检索机制维度没有取得可比较的依据，下一步要优先补这一维度的正文级材料。", claimIds: [] as string[] },
            ],
          },
        ],
      },
    ],
  };
}

function withReport(harness: Harness, evidenceIds: readonly string[]): string {
  harness.service.issueGrant({ sessionId: SESSION, intent: "draft", taskId: harness.taskId, allowResearch: true });
  const saved = harness.service.saveReport(harness.taskId, draftFor(harness.service.getTask(harness.taskId)!, evidenceIds));
  harness.service.clearGrant(SESSION);
  if (!saved.ok) throw new Error(`report refused: ${saved.problems.join("; ")}`);
  return saved.reportId;
}

/** The reader's instruction in Scenario 1, verbatim in spirit. */
const INSTRUCTION = "不用表格，改成四段纯文字：两位工程师两周的任务、交付物和停止条件。";

/** The rewrite that loses the section's obligation: prose only, no judgement cited. */
function obligationLosingRewrite(task: ReportTask) {
  const [subjectA, subjectB] = task.subjects;
  return {
    section: {
      id: "synthesis",
      title: "六、综合判断与权衡",
      blocks: [
        { kind: "paragraph" as const, text: "第一位工程师在第一周负责把两篇文章的索引与检索流程逐条对齐。", claimIds: [] as string[] },
        { kind: "paragraph" as const, text: "他在第二周交付一份流程图与术语对照表，作为后续讨论的共同基础。", claimIds: [] as string[] },
        { kind: "paragraph" as const, text: "第二位工程师同期负责搭建小型语料上的对照实验环境，只跑作者给出的设置。", claimIds: [] as string[] },
        {
          kind: "paragraph" as const,
          text: "两周后停止：如果对照实验仍不能在同一设置下运行，就保留各自口径，不做效果结论。",
          claimIds: [] as string[],
        },
      ],
    },
    reason: `按用户要求改成四段纯文字（对象：${subjectA?.name ?? ""} 与 ${subjectB?.name ?? ""}）。`,
  };
}

/** The same four paragraphs, with the section's own obligation kept. */
function repairedRewrite(task: ReportTask) {
  const losing = obligationLosingRewrite(task);
  return {
    section: {
      id: "synthesis",
      title: "六、综合判断与权衡",
      blocks: [
        ...losing.section.blocks.slice(0, 3),
        {
          kind: "paragraph" as const,
          // The judgement the section owes, kept and cited: the base report's
          // own synthesis claim stays in force, because a rewrite that drops it
          // stops being a synthesis section at all.
          text: "综合两篇方法论文可以看出，差异不在是否使用图，而在结构信息在哪个阶段被利用：因此两周的计划按阶段分工，而不是按论文分工。",
          claimIds: ["clm_synth"],
        },
        losing.section.blocks[3]!,
      ],
    },
    reason: losing.reason,
  };
}

async function callTool(harness: Harness, input: unknown): Promise<Record<string, unknown>> {
  const tool = harness.tools.tools.find((candidate) => candidate.name === "propose_section_edit")!;
  const result = (await tool.execute(input, context())) as string;
  return JSON.parse(result) as Record<string, unknown>;
}

function editGrant(harness: Harness): void {
  harness.service.issueGrant({
    sessionId: SESSION,
    intent: "edit",
    taskId: harness.taskId,
    targetType: "section",
    targetId: "synthesis",
    allowResearch: false,
    origin: "user",
  });
}

describe("Scenario 1: rewriting the synthesis section", () => {
  it("refuses the obligation-losing rewrite before it can be shown as pending", async () => {
    const harness = open();
    try {
      const evidenceIds = await research(harness);
      const reportId = withReport(harness, evidenceIds);
      const hashBefore = harness.service.contentHashOf(harness.taskId);
      editGrant(harness);

      const refused = await callTool(harness, obligationLosingRewrite(harness.service.getTask(harness.taskId)!));
      expect(refused["ok"]).toBe(false);
      expect(refused["code"]).toBe("proposal_invalid");
      // No pending proposal exists, so no「接受这一节修改」can be offered.
      expect(harness.service.pendingProposalOf(harness.taskId)).toBeUndefined();
      expect(harness.service.contentHashOf(harness.taskId)).toBe(hashBefore);
      expect(harness.service.getTask(harness.taskId)!.currentReportId).toBe(reportId);

      // The problems go to the model; the user-facing sentence names the kind
      // of content that was lost without printing a check id, a contract term
      // or a hash.
      const problems = (refused["problems"] ?? []) as string[];
      expect(problems.join(" ")).toContain("综合判断");
      const userMessage = String(refused["userMessage"]);
      expect(userMessage).toContain("丢失了这一节必须保留的综合判断");
      expect(userMessage).toContain("报告正文没有改变");
      for (const leak of ["Q03", "synthesis", "claim", "hash", "clm_"]) {
        expect(userMessage).not.toContain(leak);
      }
    } finally {
      harness.close();
    }
  });

  it("turns the repaired rewrite into a pending proposal that accept really applies", async () => {
    const harness = open();
    try {
      const evidenceIds = await research(harness);
      withReport(harness, evidenceIds);
      editGrant(harness);

      const first = await callTool(harness, obligationLosingRewrite(harness.service.getTask(harness.taskId)!));
      expect(first["ok"]).toBe(false);

      const repaired = await callTool(harness, repairedRewrite(harness.service.getTask(harness.taskId)!));
      expect(repaired["ok"], JSON.stringify(repaired)).toBe(true);
      const proposal = harness.service.pendingProposalOf(harness.taskId);
      expect(proposal).toBeDefined();

      // §1's promise, checked the way the product means it: what is pending can
      // be accepted. No second validation of the same contract is allowed to
      // refuse it at the moment the reader presses accept.
      const accepted = harness.service.acceptProposal(proposal!.id);
      expect(accepted.ok, accepted.ok ? "" : accepted.problems.join("; ")).toBe(true);
      if (!accepted.ok) return;
      const report = harness.service.reportsOf(harness.taskId).find((candidate) => candidate.id === accepted.reportId)!;
      const synthesis = report.sections.find((section) => section.id === "synthesis")!;
      expect(synthesis.blocks).toHaveLength(5);
      expect(synthesis.blocks.some((block) => block.kind === "paragraph" && block.claimIds.includes("clm_synth"))).toBe(true);
      expect(report.validation.ok).toBe(true);
    } finally {
      harness.close();
    }
  });

  it("ends the action as proposal_not_created when the repair fails too, and loops no further", async () => {
    const harness = open();
    try {
      const evidenceIds = await research(harness);
      const reportId = withReport(harness, evidenceIds);
      const hashBefore = harness.service.contentHashOf(harness.taskId);
      editGrant(harness);

      const task = harness.service.getTask(harness.taskId)!;
      const first = await callTool(harness, obligationLosingRewrite(task));
      const second = await callTool(harness, obligationLosingRewrite(task));
      expect(first["code"]).toBe("proposal_invalid");
      expect(second["code"]).toBe("proposal_not_created");

      // A third attempt is answered the same way — no proposal, ever.
      const third = await callTool(harness, obligationLosingRewrite(task));
      expect(third["code"]).toBe("proposal_not_created");
      expect(harness.service.pendingProposalOf(harness.taskId)).toBeUndefined();
      expect(harness.service.contentHashOf(harness.taskId)).toBe(hashBefore);
      expect(harness.service.getTask(harness.taskId)!.currentReportId).toBe(reportId);

      // And the action knows what it ended as, in words the reader can act on.
      const outcome = harness.service.actionOutcomeOf(SESSION, INSTRUCTION);
      expect(outcome?.kind).toBe("edit");
      if (outcome?.kind !== "edit") return;
      expect(outcome.status).toBe("proposal_not_created");
      expect(outcome.userMessage).toContain("可以换一种写法重新尝试");
    } finally {
      harness.close();
    }
  });

  it("still allows an edit of another section when the report's own table is blank", async () => {
    const harness = open();
    try {
      const evidenceIds = await research(harness);
      const task = harness.service.getTask(harness.taskId)!;
      // A report of the shape the real user acceptance found: a comparison
      // table that declares its frame and carries no judgement at all. It was
      // sealed before the blank-cell rule existed, and it has to stay editable —
      // an edit of the synthesis section cannot repair that table, and refusing
      // the edit would take the reader's only route away.
      const draft = draftFor(task, evidenceIds);
      const legacy = {
        ...draft,
        sections: draft.sections.map((section) =>
          section.id === "comparison"
            ? {
                ...section,
                blocks: section.blocks.map((block) => (block.kind === "table" ? { ...block, rows: block.rows.map(() => ({ cells: [] })) } : block)),
              }
            : section,
        ),
      };
      // A fresh save refuses that shape: the contract forbids sealing a
      // comparison whose cells say nothing.
      harness.service.issueGrant({ sessionId: SESSION, intent: "draft", taskId: harness.taskId, allowResearch: true });
      const refused = harness.service.saveReport(harness.taskId, legacy as ReturnType<typeof draftFor>);
      harness.service.clearGrant(SESSION);
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.problems.join(" ")).toContain("空白单元格");

      // The report that already exists is a different matter: it is written
      // straight into the repository, the way a project saved before this rule
      // looks on disk.
      const legacyReport = sealReport({
        id: "rep_legacy_blank",
        taskId: harness.taskId,
        draft: legacy as ReturnType<typeof draftFor>,
        validation: { ok: true, problems: [], warnings: [], checks: [] },
        now: "2026-10-01T00:00:00.000Z",
        task,
      });
      harness.repo.saveReport(legacyReport);
      harness.repo.updateTask({ ...harness.service.getTask(harness.taskId)!, currentReportId: legacyReport.id, status: "ready" });

      harness.service.issueGrant({
        sessionId: SESSION,
        intent: "edit",
        taskId: harness.taskId,
        targetType: "section",
        targetId: "limitations",
        allowResearch: false,
        origin: "user",
      });
      const edited = await callTool(harness, {
        section: {
          id: "limitations",
          title: "七、局限、未知与下一步",
          blocks: [
            {
              kind: "paragraph",
              text: "缺独立评估：效果差异只有作者自报口径，下一步应在共同设置下做对照，并把可比性写清楚。",
              claimIds: ["clm_limit"],
            },
          ],
        },
        reason: "把局限写得更具体。",
      });
      expect(edited["ok"], JSON.stringify(edited)).toBe(true);
      const proposal = harness.service.pendingProposalOf(harness.taskId);
      expect(proposal).toBeDefined();
      const accepted = harness.service.acceptProposal(proposal!.id);
      expect(accepted.ok, accepted.ok ? "" : accepted.problems.join("; ")).toBe(true);
      // The report's own blank table is reported as an unmet obligation, and it
      // did not block the edit the reader actually asked for.
      if (accepted.ok) {
        const report = harness.service.reportsOf(harness.taskId).find((candidate) => candidate.id === accepted.reportId)!;
        expect((report.validation.warnings ?? []).join(" ")).toContain("空白单元格");
      }
    } finally {
      harness.close();
    }
  });

  it("refuses a proposal whose own table would reach the reader with blank cells", async () => {
    const harness = open();
    try {
      const evidenceIds = await research(harness);
      withReport(harness, evidenceIds);
      const task = harness.service.getTask(harness.taskId)!;
      const [subjectA, subjectB] = task.subjects;
      const [, dimBuild] = task.dimensions;
      harness.service.issueGrant({
        sessionId: SESSION,
        intent: "edit",
        taskId: harness.taskId,
        targetType: "section",
        targetId: "comparison",
        allowResearch: false,
        origin: "user",
      });
      const refused = await callTool(harness, {
        section: {
          id: "comparison",
          title: "五、条件化比较",
          blocks: [
            {
              kind: "table",
              columns: ["对象", dimBuild?.name ?? "结构与构建", "检索机制"],
              columnDimensions: [null, dimBuild?.id ?? "", null],
              rowSubjects: [subjectA?.id ?? "", subjectB?.id ?? ""],
              // The shape the real acceptance found in an Edit proposal:
              // headings, rows, and nothing in them.
              rows: [{ cells: [] }, { cells: [] }, { cells: [] }, { cells: [] }],
            },
          ],
        },
        reason: "重排比较表。",
      });
      expect(refused["ok"]).toBe(false);
      expect((refused["problems"] as string[]).join(" ")).toContain("空白单元格");
      expect(harness.service.pendingProposalOf(harness.taskId)).toBeUndefined();
    } finally {
      harness.close();
    }
  });

  it("repairs a blank table once, and refuses to show an empty one twice", async () => {
    const harness = open();
    try {
      const evidenceIds = await research(harness);
      withReport(harness, evidenceIds);
      const task = harness.service.getTask(harness.taskId)!;
      const [subjectA, subjectB] = task.subjects;
      const [, dimBuild] = task.dimensions;
      harness.service.issueGrant({
        sessionId: SESSION,
        intent: "edit",
        taskId: harness.taskId,
        targetType: "section",
        targetId: "comparison",
        allowResearch: false,
        origin: "user",
      });
      const blank = {
        section: {
          id: "comparison",
          title: "五、条件化比较",
          blocks: [
            {
              kind: "table" as const,
              columns: ["对象", dimBuild?.name ?? "结构与构建"],
              columnDimensions: [null, dimBuild?.id ?? ""],
              rowSubjects: [subjectA?.id ?? "", subjectB?.id ?? ""],
              rows: [{ cells: [] }, { cells: [] }],
            },
          ],
        },
        reason: "重排比较表。",
      };
      const first = await callTool(harness, blank);
      expect(first["code"]).toBe("proposal_invalid");
      const userMessage = String(first["userMessage"]);
      expect(userMessage).toContain("空白");
      expect(userMessage).not.toContain("Q03");

      const second = await callTool(harness, blank);
      expect(second["code"]).toBe("proposal_not_created");
      expect(harness.service.pendingProposalOf(harness.taskId)).toBeUndefined();
    } finally {
      harness.close();
    }
  });

  it("reports a zero delta when the edit did not research", async () => {
    const harness = open();
    try {
      const evidenceIds = await research(harness);
      withReport(harness, evidenceIds);
      const sourcesBefore = harness.service.sourcesOf(harness.taskId).length;
      const evidenceBefore = harness.service.evidenceOf(harness.taskId).length;
      const assessmentsBefore = harness.service.assessmentsOf(harness.taskId).length;
      expect(sourcesBefore).toBeGreaterThan(0);

      editGrant(harness);
      const created = await callTool(harness, repairedRewrite(harness.service.getTask(harness.taskId)!));
      expect(created["ok"], JSON.stringify(created)).toBe(true);
      const proposal = harness.service.pendingProposalOf(harness.taskId)!;
      // The project holds sources and evidence already; the proposal must not
      // report them as「修改期间新增」just because they exist.
      expect(proposal.researchAdded).toEqual({ sources: 0, evidence: 0, assessments: 0 });
      expect(harness.service.sourcesOf(harness.taskId).length).toBe(sourcesBefore);
      expect(harness.service.evidenceOf(harness.taskId).length).toBe(evidenceBefore);
      expect(harness.service.assessmentsOf(harness.taskId).length).toBe(assessmentsBefore);

      const outcome = harness.service.actionOutcomeOf(SESSION, INSTRUCTION);
      if (outcome?.kind !== "edit") throw new Error("expected an edit outcome");
      expect(outcome.status).toBe("proposal_created");
      expect(outcome.delta.newEvidenceIds).toEqual([]);
    } finally {
      harness.close();
    }
  });

  it("counts only what this action's own research added", async () => {
    const harness = open();
    try {
      const evidenceIds = await research(harness);
      withReport(harness, evidenceIds);
      const evidenceBefore = harness.service.evidenceOf(harness.taskId).length;

      // An Edit authorized to look something up finds one new source and reads
      // it; the numbers on the proposal are what that action added, not what
      // the project now holds.
      harness.service.issueGrant({
        sessionId: SESSION,
        intent: "edit",
        taskId: harness.taskId,
        targetType: "section",
        targetId: "mechanism",
        allowResearch: true,
        origin: "user",
        budget: { maxSearches: 1, maxReads: 2, maxGapRounds: 1 },
      });
      const found = await harness.service.search(harness.taskId, { query: "graph construction cost detail" });
      expect(found.ok).toBe(true);
      const sources = harness.service.sourcesOf(harness.taskId);
      const last = sources[sources.length - 1]!;
      const task = harness.service.getTask(harness.taskId)!;
      const read = await harness.service.read(harness.taskId, {
        sourceId: last.id,
        question: "构建成本的细节",
        terms: ["cost", "index"],
        targetCell: { sectionId: "comparison", subjectId: task.subjects[0]!.id, dimensionId: task.dimensions[1]!.id },
        role: "primary",
        maxEvidence: 1,
      });
      expect(read.ok).toBe(true);
      expect(harness.service.evidenceOf(harness.taskId).length).toBeGreaterThan(evidenceBefore);

      const created = await callTool(harness, {
        section: {
          id: "mechanism",
          title: "三、机制解释",
          blocks: [
            {
              kind: "mechanism",
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
        reason: "把构建成本写进机制说明。",
      });
      expect(created["ok"], JSON.stringify(created)).toBe(true);
      const proposal = harness.service.pendingProposalOf(harness.taskId)!;
      expect(proposal.researchAdded.sources).toBe(1);
      expect(proposal.researchAdded.evidence).toBeGreaterThan(0);
      // The project as a whole holds more evidence than this action added, and
      // the number is the action's.
      expect(proposal.researchAdded.evidence).toBeLessThan(harness.service.evidenceOf(harness.taskId).length);
    } finally {
      harness.close();
    }
  });
});
