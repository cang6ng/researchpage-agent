/**
 * Scenario 2 of the user acceptance: a research action's answer.
 *
 * The user asked for official material on Microsoft GraphRAG's Chinese-language
 * handling and incremental-update limits. The system found two sources and
 * reported「找到 2 个可用来源」— while both were background papers that said
 * nothing about either question. The product owed the reader an answer to
 * whether the question was resolved, not a count of how many tools ran.
 *
 * The rule these tests pin down: resolution is derived from the coverage of the
 * cells the action's own material landed on. Background material can be saved,
 * assessed and cited without ever reaching「已核对」, so it resolves nothing by
 * construction — and the action's own delta is the only material it may report
 * as new.
 */

import { describe, expect, it } from "vitest";

import { openResearchRepository } from "../src/repository.js";
import { createResearchService, type ResearchService } from "../src/service.js";
import { deriveResearchResolution, newMaterialSentence, proposalFailureCopy } from "../src/outcome.js";
import type { ReadOutcome } from "../src/read.js";
import type { SearchOutcome } from "../src/search.js";
import type { ReportTask } from "../src/domain.js";

const SESSION = "session_resolution";

/** Two background papers, both about GraphRAG in general. */
const BACKGROUND_SOURCES = [
  {
    provider: "arxiv" as const,
    providerId: "2401.00001",
    title: "A Survey of Graph-Based Retrieval (background)",
    authors: ["A. Author"],
    abstract: "We survey graph-based retrieval methods.",
    landingUrl: "https://arxiv.org/abs/2401.00001",
    pdfUrl: null,
    publishedAt: "2024-01-01T00:00:00Z",
    arxivId: "2401.00001",
    venue: "arXiv cs.CL",
    doi: null,
  },
  {
    provider: "arxiv" as const,
    providerId: "2402.00002",
    title: "Community Summarisation in Practice (background)",
    authors: ["B. Author"],
    abstract: "A general discussion of community summarisation.",
    landingUrl: "https://arxiv.org/abs/2402.00002",
    pdfUrl: null,
    publishedAt: "2024-02-01T00:00:00Z",
    arxivId: "2402.00002",
    venue: "arXiv cs.CL",
    doi: null,
  },
];

const BACKGROUND_TEXT = [
  "GraphRAG 属于图结构检索的一类方法，本文只讨论一般方法背景，不涉及具体语言支持。",
  "增量更新不是本文的讨论范围；读者应参考各实现的官方文档。",
  "中文处理在本文中没有涉及。",
];

function textOf(): { readonly text: string; readonly paragraphs: ReadOutcome["paragraphs"] } {
  const text = BACKGROUND_TEXT.join("\n\n");
  return {
    text,
    paragraphs: BACKGROUND_TEXT.map((paragraph, index) => {
      const charStart = BACKGROUND_TEXT.slice(0, index).reduce((sum, item) => sum + item.length + 2, 0);
      return { index, headingPath: ["正文"], text: paragraph, charStart, charEnd: charStart + paragraph.length };
    }),
  };
}

interface Harness {
  readonly service: ResearchService;
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
      total: BACKGROUND_SOURCES.length,
      candidates: [...BACKGROUND_SOURCES],
    }),
    read: async (request): Promise<ReadOutcome> => ({
      ...textOf(),
      status: "ok",
      readUrl: request.url,
      fetchedAt: new Date().toISOString(),
      scope: "full_text",
      title: "Fixture read",
      contentType: "text/html",
      failure: null,
      note: "",
    }),
    now: () => new Date("2026-10-08T09:00:00.000Z"),
  });

  service.issueGrant({ sessionId: SESSION, intent: "card", taskId: null });
  const proposed = service.proposeTask(SESSION, {
    topic: "Microsoft GraphRAG 的语言支持与增量更新",
    purpose: "技术选型",
    audience: "工程团队",
    focus: ["官方说明"],
    exclusions: "",
    lengthTarget: "约 3 页",
    subjects: [{ name: "Microsoft GraphRAG" }, { name: "LightRAG" }],
    dimensions: [
      { name: "Language support", question: "官方是否声明中文处理与相关限制？" },
      { name: "Incremental update", question: "官方是否声明增量更新及其限制？" },
      { name: "Cost", question: "索引与查询成本如何报告？" },
    ],
  });
  if (!proposed.ok) throw new Error(`card refused: ${proposed.problems.join("; ")}`);
  const taskId = proposed.task.id;
  service.confirmTask(taskId);
  service.clearGrant(SESSION);
  return { service, taskId, close: () => repo.close() };
}

/** The user's instruction in Scenario 2, verbatim in spirit. */
const QUESTION = "优先找 Microsoft GraphRAG 官方材料，确认中文处理与增量更新限制。";

function task(harness: Harness): ReportTask {
  return harness.service.getTask(harness.taskId)!;
}

/**
 * One research action: the user's instruction, its own grant, and whatever the
 * run read and judged inside it.
 */
async function researchAction(
  harness: Harness,
  options: { readonly relationships: "contextual" | "mixed" | "direct" },
): Promise<{ readonly resolution: ReturnType<ResearchService["actionOutcomeOf"]> }> {
  harness.service.issueGrant({
    sessionId: SESSION,
    intent: "research",
    taskId: harness.taskId,
    allowResearch: true,
    origin: "user",
    budget: { maxSearches: 2, maxReads: 4, maxGapRounds: 2 },
  });
  const found = await harness.service.search(harness.taskId, { query: "Microsoft GraphRAG official documentation language support" });
  if (!found.ok) throw new Error(`search refused: ${found.problems.join("; ")}`);
  const current = task(harness);
  const sources = harness.service.sourcesOf(harness.taskId);
  const languageCell = { sectionId: "comparison", subjectId: current.subjects[0]!.id, dimensionId: current.dimensions[0]!.id };
  const updateCell = { sectionId: "comparison", subjectId: current.subjects[0]!.id, dimensionId: current.dimensions[1]!.id };

  const evidenceForLanguage: string[] = [];
  let evidenceForUpdate: string[] = [];
  for (const [index, source] of sources.entries()) {
    const read = await harness.service.read(harness.taskId, {
      sourceId: source.id,
      question: index === 0 ? "官方是否说明中文处理" : "官方是否说明增量更新",
      terms: ["language", "update", "incremental"],
      targetCell: index === 0 ? languageCell : updateCell,
      // Both are papers about the field, not the vendor's documentation.
      role: "contextual",
      maxEvidence: 2,
    });
    if (!read.ok) throw new Error(`read refused: ${read.problems.join("; ")}`);
    if (index === 0) evidenceForLanguage.push(...read.evidence.map((item) => item.evidenceId));
    else evidenceForUpdate = read.evidence.map((item) => item.evidenceId);
  }

  // How the material bears on the question is the model's judgement, recorded
  // as an assessment. Background material is judged as background.
  const proposals = [
    {
      cell: languageCell,
      evidenceIds: evidenceForLanguage,
      // "mixed" is the case one question got direct, official material and the
      // other did not.
      relationship: options.relationships === "contextual" ? ("contextual" as const) : ("supports" as const),
      directness: options.relationships === "contextual" ? ("contextual" as const) : ("direct" as const),
      scope: options.relationships === "contextual" ? "这篇文章只谈一般方法背景，不涉及语言支持。" : "官方文档直接说明了中文处理。",
    },
    {
      cell: updateCell,
      evidenceIds: evidenceForUpdate,
      relationship: options.relationships === "direct" ? ("supports" as const) : ("contextual" as const),
      directness: options.relationships === "direct" ? ("direct" as const) : ("contextual" as const),
      scope: options.relationships === "direct" ? "官方文档直接说明了增量更新。" : "没有取得增量更新的官方说明。",
    },
  ];
  const assessed = harness.service.assess(harness.taskId, { proposals });
  if (!assessed.ok) throw new Error(`assess refused: ${assessed.problems.join("; ")}`);
  const outcome = harness.service.actionOutcomeOf(SESSION, QUESTION);
  harness.service.clearGrant(SESSION);
  return { resolution: outcome };
}

describe("Scenario 2: official material that is not there", () => {
  it("reports unresolved when only background material was found", async () => {
    const harness = open();
    try {
      const { resolution } = await researchAction(harness, { relationships: "contextual" });
      expect(resolution?.kind).toBe("research");
      if (resolution?.kind !== "research") return;
      const resolved = resolution.resolution;
      expect(resolved.status).toBe("unresolved");
      // The material is still reported as what it is — and as this action's own.
      expect(resolved.newSourceIds).toHaveLength(2);
      expect(resolved.newEvidenceIds.length).toBeGreaterThan(0);
      expect(resolved.newAssessmentIds).toHaveLength(2);
      expect(resolved.summary).toContain("没有找到能直接回答这一问题的材料");
      expect(resolved.summary).toContain("本轮新增 2 篇背景材料");
      expect(resolved.summary).not.toContain("已解决");
      // What is still open is named by question, not by id.
      const open = resolved.remainingGap.map((note) => `${note.subjectName} × ${note.dimensionName}`);
      expect(open.join(" ")).toContain("Language support");
      expect(open.join(" ")).toContain("Incremental update");
      // §14: the ids the workspace needs to open exactly this action's material.
      expect(resolved.targetCells.length).toBeGreaterThan(0);
      expect(resolved.supportingEvidenceIds).toEqual([]);
    } finally {
      harness.close();
    }
  });

  it("reports partially_resolved when one target got direct material and the other did not", async () => {
    const harness = open();
    try {
      const { resolution } = await researchAction(harness, { relationships: "mixed" });
      if (resolution?.kind !== "research") throw new Error("expected a research outcome");
      expect(resolution.resolution.status).toBe("partially_resolved");
      expect(resolution.resolution.summary).toContain("部分解决");
      expect(resolution.resolution.remainingGap.map((note) => note.dimensionName)).toContain("Incremental update");
    } finally {
      harness.close();
    }
  });

  it("reports resolved only when the targets are covered by direct material", async () => {
    const harness = open();
    try {
      const { resolution } = await researchAction(harness, { relationships: "direct" });
      if (resolution?.kind !== "research") throw new Error("expected a research outcome");
      expect(resolution.resolution.status).toBe("resolved");
      expect(resolution.resolution.summary).toContain("这一轮已经解决");
      expect(resolution.resolution.remainingGap).toEqual([]);
    } finally {
      harness.close();
    }
  });

  it("counts only what this action added, not what the project already held", async () => {
    const harness = open();
    try {
      const first = await researchAction(harness, { relationships: "contextual" });
      if (first.resolution?.kind !== "research") throw new Error("expected a research outcome");
      const firstIds = new Set(first.resolution.resolution.newSourceIds);
      expect(firstIds.size).toBe(2);

      // A second action that reads nothing new adds nothing, however large the
      // project has become: the delta is a difference, not a total.
      harness.service.issueGrant({
        sessionId: SESSION,
        intent: "research",
        taskId: harness.taskId,
        allowResearch: true,
        origin: "user",
        budget: { maxSearches: 2, maxReads: 4, maxGapRounds: 2 },
      });
      const outcome = harness.service.actionOutcomeOf(SESSION, "再确认一下同一件事。");
      if (outcome?.kind !== "research") throw new Error("expected a research outcome");
      expect(outcome.resolution.newSourceIds).toEqual([]);
      expect(outcome.resolution.newEvidenceIds).toEqual([]);
      expect(outcome.resolution.newAssessmentIds).toEqual([]);
      expect(outcome.resolution.status).toBe("unresolved");
      expect(outcome.resolution.summary).toContain("本轮没有新增来源");
      harness.service.clearGrant(SESSION);
    } finally {
      harness.close();
    }
  });
});

describe("the user-facing copy", () => {
  it("names the lost kind of content without printing the validator's words", () => {
    const copy = proposalFailureCopy([
      "Q03：章节「综合判断与权衡」没有综合判断（synthesis）：这一节要形成跨来源的新的有界判断",
      "Q03：章节「条件化比较」的比较表存在空白单元格（第 1 行第 2 列）：每一格必须给出一个有界判断",
    ]);
    expect(copy).toContain("综合判断");
    expect(copy).toContain("报告正文没有改变");
    expect(copy).toContain("可以换一种写法重新尝试");
    for (const leak of ["Q03", "synthesis", "claim", "clm_", "sha256"]) {
      expect(copy).not.toContain(leak);
    }
  });

  it("counts sources by role, and says unclassified when nobody classified them", () => {
    expect(
      newMaterialSentence([
        { role: "contextual" } as never,
        { role: "contextual" } as never,
      ]),
    ).toBe("本轮新增 2 篇背景材料。");
    expect(newMaterialSentence([{ role: null } as never])).toContain("未标注类型");
    expect(newMaterialSentence([])).toBe("本轮没有新增来源。");
  });

  it("derives the same resolution from a pure fixture", () => {
    const resolution = deriveResearchResolution({
      question: "官方是否支持中文？",
      delta: { newSourceIds: ["src_1"], newEvidenceIds: ["ev_1"], newAssessmentIds: ["asm_1"] },
      sources: [
        {
          id: "src_1",
          taskId: "task_1",
          title: "背景材料",
          authors: [],
          org: "",
          url: "https://example.org",
          pdfUrl: null,
          doi: null,
          publishedAt: null,
          venue: "",
          role: "contextual",
          abstract: "",
          discovery: { provider: "arxiv", query: "q", queriedAt: "2026-10-08T09:00:00.000Z", target: null },
          readStatus: "ok",
          readScope: "full_text",
          readAt: "2026-10-08T09:00:00.000Z",
          readUrl: null,
          retrievalNote: "",
          failure: null,
          snapshotId: "read_1",
        },
      ],
      evidence: [
        {
          id: "ev_1",
          taskId: "task_1",
          sourceId: "src_1",
          readId: "read_1",
          excerpt: "片段",
          locator: { paragraphIndex: 0, headingPath: [], charStart: 0, charEnd: 2 },
          readScope: "full_text",
          cells: [{ sectionId: "comparison", subjectId: "sub_1", dimensionId: "dim_1" }],
          pickedBecause: "",
          createdAt: "2026-10-08T09:00:00.000Z",
        },
      ],
      assessments: [
        {
          id: "asm_1",
          taskId: "task_1",
          target: { sectionId: "comparison", subjectId: "sub_1", dimensionId: "dim_1" },
          evidenceIds: ["ev_1"],
          relationship: "contextual",
          directness: "contextual",
          scope: "",
          rationale: "",
          assessor: "agent",
          createdAt: "2026-10-08T09:00:00.000Z",
        },
      ],
      cells: [
        {
          sectionId: "comparison",
          subjectId: "sub_1",
          dimensionId: "dim_1",
          status: "limited",
          reason: "现有评估只提供背景或语境",
          gap: "需要正文级、直接相关的支持",
        },
      ],
      subjectNames: new Map([["sub_1", "Microsoft GraphRAG"]]),
      dimensionNames: new Map([["dim_1", "中文处理"]]),
      hasReport: false,
    });
    expect(resolution.status).toBe("unresolved");
    expect(resolution.remainingGap[0]?.subjectName).toBe("Microsoft GraphRAG");
    expect(resolution.summary).not.toContain("报告正文");
  });
});
