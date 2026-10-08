/**
 * The interactive artifact, checked on the markup it produces.
 *
 * Two questions this product has to answer about its own report, answered here
 * rather than by eye in a browser. Does the page ever print the database's word
 * for something — `sub_graphrag`, `dim_item1`, `ev_…` — into text a reader
 * reads? And does a comparison come out as a frame a reader can compare in:
 * the questions down the side, the objects across the top, and a bounded
 * judgement in each cell rather than a blank.
 *
 * These are static renders, so the visible text is what is checked: an
 * identifier inside a `data-` attribute is how the page finds its own scroll
 * target, and is not something anyone reads.
 */

import { MantineProvider } from "@mantine/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { CellView, DocumentView, DocumentClaim, PresentationReadout, ReportBlock } from "../src/browser/api.js";
import { DocumentCanvas } from "../src/browser/components/document.js";
import { boundariesOf, boundarySummary, nameMaps, readerText, warningSummary } from "../src/browser/document-logic.js";
import type { TaskBundle } from "../src/browser/api.js";

/* ---------------------------------------------------------------- fixtures -- */

/**
 * The project readout a bundle carries.
 *
 * It is a fixture of the *server's* projection, not a second implementation:
 * the values here are what `presentationOf` derives for this project's matrix
 * and report, and the page is checked against them rather than against a
 * summary the page computed for itself.
 */
function presentationFixture(): PresentationReadout {
  return {
    runState: { state: "report_ready", displayName: "报告已就绪", userMessage: "报告已经写好并保存。" },
    evidenceCoverage: {
      cells: 6,
      withMaterial: 2,
      reviewed: 1,
      displayName: "2 / 6 个比较项已有材料",
      userMessage: "2 / 6 个比较项已有材料；其中 1 项已核对。材料覆盖不等于结论完成。",
    },
    unresolvedResearch: {
      unresolved: 4,
      limited: 1,
      incomparable: 0,
      resolved: 1,
      displayName: "5 项还没有结论",
      userMessage: "4 项还没有可用的依据、1 项只有有限支持；这些是研究层面的未解决项。",
    },
    reportReview: { state: "clean", reason: null, displayName: "未被标记待复核", userMessage: "报告写成之后没有新材料进入。" },
    artifactQuality: {
      state: "warnings",
      warnings: 1,
      blocking: 0,
      displayName: "通过，1 处义务未完全达成",
      userMessage: "报告通过了发布校验，但有 1 处义务没有完全达成（正文里已如实写出）。",
    },
    sourceRoles: {
      total: 0,
      classified: 0,
      unknown: 0,
      primary: 0,
      byRole: {},
      displayName: "还没有来源",
      userMessage: "还没有找到任何来源。",
    },
  };
}

function claimFixture(overrides: Partial<DocumentClaim> & { readonly id: string }): DocumentClaim {
  return {
    text: "一条论断",
    kind: "fact",
    claimType: "fact",
    synthesis: false,
    evidenceIds: ["ev_1"],
    subjects: [],
    dimensions: [],
    conditions: null,
    adequacy: { state: "adequate", reasons: [] },
    ...overrides,
  };
}

const COMPARISON: ReportBlock = {
  kind: "table",
  columns: ["成本口径（dim_cost）", "效果评测（dim_effect）", "增量更新（dim_update）"],
  columnDimensions: ["dim_cost", "dim_effect", "dim_update"],
  rowSubjects: ["sub_graphrag", "sub_lightrag"],
  rows: [
    {
      cells: [
        { text: "索引阶段一次性 token 开销最大", claimIds: ["clm_cost_graphrag"] },
        { text: "作者自报的 LLM-as-judge 结果", claimIds: ["clm_effect_graphrag"] },
        { text: "", claimIds: [] },
      ],
    },
    {
      cells: [
        { text: "增量更新只需重建受影响部分", claimIds: ["clm_cost_lightrag"] },
        { text: "", claimIds: [] },
        { text: "仅有作者报告的更新时间", claimIds: ["clm_update_lightrag"] },
      ],
    },
  ],
};

const PLAIN: ReportBlock = {
  kind: "table",
  columns: ["方法", "成本特征"],
  rows: [{ cells: [{ text: "GraphRAG", claimIds: [] }, { text: "高", claimIds: [] }] }],
};

function documentFixture(): DocumentView {
  return {
    reportId: "rep_1",
    revision: null,
    themeId: null,
    contentHash: "hash",
    title: "长文档问答的 RAG 选型",
    summary: "这**一份**报告比较三类方案。",
    frame: { question: "三段成本与效果各自如何？", audience: "工程读者", scope: "七个来源" },
    sections: [
      {
        id: "sec_overview",
        title: "研究问题与关键认识",
        blocks: [
          { kind: "paragraph", text: "**GraphRAG（sub_graphrag）** 与 **LightRAG（sub_lightrag）** 不是同一层次的实体。", claimIds: ["clm_intro"] },
          { kind: "list", items: [{ text: "综合判断一", claimIds: ["clm_syn"] }] },
          { kind: "callout", tone: "gap", text: "成本口径不可比。", dimensionIds: ["dim_cost"] },
        ],
      },
      {
        id: "sec_mechanism",
        title: "机制解释",
        blocks: [
          {
            kind: "mechanism",
            title: "机制块：从文档到可检索图索引",
            input: "原始文档集",
            intermediate: "实体与关系（clm_mech_index）",
            steps: [
              { text: "1) 实体与关系抽取", claimIds: ["clm_mech_index"] },
              { text: "2) 共指归并与建图", claimIds: ["clm_mech_index"] },
            ],
            output: "可检索的图结构索引",
            tradeoff: "索引端一次性高价换跨文档聚合能力",
            failure: "chunk 过大或过小都会影响抽取质量",
            claimIds: ["clm_mech_index"],
          },
        ],
      },
      { id: "sec_compare", title: "条件化比较", blocks: [COMPARISON] },
      { id: "sec_other", title: "它山之石", blocks: [PLAIN] },
    ],
    claims: [
      claimFixture({ id: "clm_intro", text: "两类对象不是同一层次" }),
      claimFixture({ id: "clm_syn", text: "判断一", claimType: "synthesis", synthesis: true }),
      claimFixture({ id: "clm_mech_index", text: "索引机制" }),
      claimFixture({ id: "clm_cost_graphrag", text: "成本", claimType: "cost", conditions: { costStage: "indexing" } }),
      claimFixture({ id: "clm_cost_lightrag", text: "成本", claimType: "cost", conditions: { costStage: "update" } }),
      claimFixture({ id: "clm_effect_graphrag", text: "效果", conditions: { comparability: "not-directly-comparable" } }),
      claimFixture({ id: "clm_update_lightrag", text: "更新", conditions: { comparability: "partially-comparable" } }),
    ],
    citations: {
      references: [{ number: 1, sourceId: "src_1", title: "From Local to Global", authors: ["Edge"], venue: "arXiv", publishedAt: "2024-04-24T00:00:00Z", url: "https://arxiv.org/abs/2404.16130", doi: null, readScope: "full_text" }],
      evidenceIndex: [
        { number: 1, evidenceId: "ev_1", sourceId: "src_1", excerpt: "片段", scope: "full_text", headingPath: ["正文"], paragraphIndex: 0 },
      ],
      numbersByClaim: { clm_intro: [1], clm_cost_graphrag: [1] },
    },
    validation: {
      ok: true,
      problems: [],
      warnings: ["Q03：claim clm_mech_index（mechanism） 的机制依据没有登记来源角色。"],
      checks: [],
      checkedAt: "2026-10-06T10:00:00.000Z",
    },
  };
}

function cellFixture(overrides: Partial<CellView> & { readonly subjectId: string; readonly dimensionId: string }): CellView {
  return {
    sectionId: "sec_compare",
    subjectName: "GraphRAG",
    dimensionName: "成本口径",
    status: "missing",
    reason: "这一项还没有绑定证据",
    gap: "需要一段正文级的支持",
    evidenceIds: [],
    note: "",
    ...overrides,
  };
}

function bundleFixture(): TaskBundle {
  const subjects = [
    { id: "sub_graphrag", name: "GraphRAG" },
    { id: "sub_lightrag", name: "LightRAG" },
  ];
  const dimensions = [
    { id: "dim_cost", name: "成本口径", question: "三段成本分别如何报告？" },
    { id: "dim_effect", name: "效果评测", question: "效果用什么指标衡量？" },
    { id: "dim_update", name: "增量更新", question: "文档变动后要重建什么？" },
  ];
  const matrix = subjects.flatMap((subject) =>
    dimensions.map((dimension) =>
      cellFixture({
        subjectId: subject.id,
        dimensionId: dimension.id,
        subjectName: subject.name,
        dimensionName: dimension.name,
        status:
          subject.id === "sub_graphrag" && dimension.id === "dim_cost"
            ? "reviewed"
            : subject.id === "sub_graphrag" && dimension.id === "dim_update"
              ? "limited"
              : "missing",
      }),
    ),
  );
  return {
    task: {
      id: "task_1",
      sessionId: "sess_1",
      topic: "长文档问答的 RAG 选型",
      purpose: "问题",
      audience: "读者",
      focus: [],
      exclusions: "",
      lengthTarget: "",
      status: "ready",
      confirmed: true,
      confirmedAt: "2026-10-06T09:00:00.000Z",
      error: null,
      createdAt: "2026-10-06T08:00:00.000Z",
      updatedAt: "2026-10-06T10:00:00.000Z",
      reportNeedsReview: null,
    },
    presentation: presentationFixture(),
    attempt: null,
    discovery: null,
    progress: {
      currentStage: "completed",
      displayName: "已完成",
      currentMessage: "报告已经写好并保存。",
      completedStages: ["preparing", "searching", "reporting", "validating"],
      lastActivityAt: "2026-10-06T10:00:00.000Z",
      searchAttempts: 2,
      candidatesFound: 3,
      sourcesRead: 2,
      currentProvider: "arxiv",
      retrying: false,
      waitingUntil: null,
    },
    activityLog: [],
    structure: [],
    subjects,
    dimensions,
    matrix,
    gaps: matrix.filter((cell) => cell.status === "missing"),
    assessments: [],
    sources: [],
    evidence: [],
    reports: [],
    proposals: [],
    revisions: [],
    exports: [],
    runs: [],
    actionBudget: null,
    budget: { maxSearches: 6, maxCandidatesPerSearch: 5, maxReads: 10, maxGapRounds: 2, deadlineMs: 480000 },
    usage: { searches: 1, reads: 1, gapRounds: 0 },
    brief: {
      taskId: "task_1",
      confirmed: true,
      readonly: true,
      version: 2,
      updatedAt: null,
      blueprint: {
        id: "technical-comparison-v2",
        name: "Technical Comparison v2",
        purpose: "比较",
        minimumSubjects: 1,
        minimumDimensions: 3,
        recommendedSubjects: [2, 5],
        recommendedDimensions: [3, 6],
      },
      topic: "长文档问答的 RAG 选型",
      question: "问题",
      purpose: "问题",
      audience: "读者",
      focus: [],
      exclusions: "",
      lengthTarget: "",
      subjects,
      dimensions,
      reportStructure: [],
      editableFields: [],
      fieldStates: {
        topic: "confirmed",
        purpose: "confirmed",
        audience: "confirmed",
        subjects: "confirmed",
        dimensions: "confirmed",
        focus: "confirmed",
        exclusions: "confirmed",
        lengthTarget: "confirmed",
      },
      validation: { valid: true, problems: [] },
      canConfirm: false,
      guide: { complete: true, reason: "已确认", limit: 7, minDecisions: 5, maxDecisions: 7, readiness: 7, decisions: [], active: null },
      matrix: { subjects: 2, dimensions: 3, cells: 6 },
      contentHash: "hash",
    },
    currentReportId: "rep_1",
    currentReportHash: "hash",
    currentReportFrozen: false,
    hasReport: true,
    documents: [],
    intent: null,
    busy: false,
  };
}

function render(mode: "read" | "verify" = "verify", revision: number | null = null): { readonly markup: string; readonly visible: string } {
  const bundle = bundleFixture();
  const document = revision === null ? documentFixture() : { ...documentFixture(), revision };
  // The canvas uses Mantine's tooltip for its inline hints, so it is rendered
  // the way the product renders it — inside the provider the app supplies.
  const markup = renderToStaticMarkup(
    createElement(
      MantineProvider,
      null,
      createElement(DocumentCanvas, {
        document,
        mode,
        themeId: "editorial",
        selection: null,
        names: nameMaps(bundle),
        boundaries: revision === null ? boundariesOf(bundle) : [],
        coverage: new Map(bundle.matrix.map((cell) => [`${cell.subjectId}|${cell.dimensionId}`, cell.status])),
        onSelect: () => undefined,
        onOpenReference: () => undefined,
      }),
    ),
  );
  // Mantine injects its own stylesheet into the provider's markup; the visible
  // text of the document is what is being checked, so that is taken out first.
  // The validator's own sentences are its audit trail and keep their exact
  // wording — identifiers included. They live behind one disclosure, and what
  // this file checks is everything a reader meets before opening it.
  const visible = markup
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<details class="rp-doc__checks__detail"[\s\S]*?<\/details>/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ");
  return { markup, visible };
}

/* ------------------------------------------------------------------- tests -- */

const INTERNAL_ID = /\b(?:sub|dim|ev|clm|sec|task|rep|rev|prp|gq|asmt|exp)_[A-Za-z0-9_\u4e00-\u9fff]+/;

describe("what the reader is allowed to see", () => {
  it("never prints an internal identifier, in either mode", () => {
    for (const mode of ["read", "verify"] as const) {
      const { visible } = render(mode);
      expect(visible).not.toMatch(INTERNAL_ID);
    }
  });

  it("keeps an identifier out of a sentence without rewriting the sentence", () => {
    expect(readerText("**GraphRAG（sub_graphrag）** 与 **LightRAG** 不是同一层次的实体。")).toBe(
      "**GraphRAG** 与 **LightRAG** 不是同一层次的实体。",
    );
    expect(readerText("普通的一句话（括号里是解释），不动它。")).toBe("普通的一句话（括号里是解释），不动它。");
  });

  it("still uses the identifiers it needs to address its own objects", () => {
    const { markup } = render("verify");
    expect(markup).toContain('data-section-id="sec_compare"');
    expect(markup).toContain('data-testid="compare-cell-dim_cost-sub_graphrag"');
  });
});

describe("the comparison, as a frame", () => {
  it("puts the questions down the side and the objects across the top", () => {
    const { markup } = render("verify");
    expect(markup).toContain('data-testid="comparison-matrix"');
    // Three dimension rows, in the order the table declared them.
    expect(markup).toContain('data-testid="compare-row-dim_cost"');
    expect(markup).toContain('data-testid="compare-row-dim_effect"');
    expect(markup).toContain('data-testid="compare-row-dim_update"');
    // The row heading is the dimension's name and the question it asks.
    expect(markup).toContain("成本口径");
    expect(markup).toContain("三段成本分别如何报告？");
    // The column headings are the objects' names, not their identifiers.
    expect(markup).toContain('data-testid="compare-col-0"');
    expect(markup).toContain(">GraphRAG<");
    expect(markup).toContain(">LightRAG<");
  });

  it("does not draw a matrix for a table that declared no frame", () => {
    const { markup } = render("verify");
    // The plain table keeps its own two headings and gets no dimension rows.
    expect(markup).toContain("成本特征");
    expect(markup).not.toContain('data-testid="compare-row-dim_cost" data');
  });

  it("says in the cell when a comparison is not directly comparable", () => {
    const { visible } = render("verify");
    expect(visible).toContain("不可直接比较");
    expect(visible).toContain("有限可比");
  });

  it("never leaves a cell blank: an empty one says where the project stands", () => {
    const { markup, visible } = render("verify");
    const empty = markup.match(/data-empty="true"/g) ?? [];
    expect(empty.length).toBe(2);
    // Each unwritten cell carries the coverage the project actually has for
    // that pair — one of them is limited rather than missing, and the other
    // says in words that the evidence is not there.
    expect(visible).toContain("证据不足");
    expect(visible).toContain("有限支持");
    expect(markup).toContain("rp-doc__cellfill");
  });

  /**
   * The shape the real acceptance found.
   *
   * Four real v2 reports hold a comparison table whose rows are `{cells: []}`:
   * the frame is declared, the cells were never written at all. That path used
   * to render a `<td>` with no text and no state — literally nothing in the
   * page — and it is what「内容 cell 在页面文本中为空」was describing.
   */
  it("says something in a cell whose row never reached that column", () => {
    const bundle = bundleFixture();
    const document = documentFixture();
    const blanked = {
      ...document,
      sections: document.sections.map((section) => ({
        ...section,
        blocks: section.blocks.map((block) =>
          block.kind === "table" && block.rowSubjects !== undefined
            ? { ...block, rows: block.rows.map(() => ({ cells: [] })) }
            : block,
        ),
      })),
    };
    const markup = renderToStaticMarkup(
      createElement(
        MantineProvider,
        null,
        createElement(DocumentCanvas, {
          document: blanked,
          mode: "verify",
          themeId: "editorial",
          selection: null,
          names: nameMaps(bundle),
          boundaries: boundariesOf(bundle),
          coverage: new Map(bundle.matrix.map((cell) => [`${cell.subjectId}|${cell.dimensionId}`, cell.status])),
          onSelect: () => undefined,
          onOpenReference: () => undefined,
        }),
      ),
    );
    // Every dimension × object cell is drawn, and none of them is empty: the
    // page says 「证据不足」 rather than pretending there is nothing to say.
    const cells = markup.match(/data-testid="compare-cell-/g) ?? [];
    expect(cells.length).toBe(6);
    const words = (markup.match(/rp-doc__cellfill[^>]*>[^<]*</g) ?? []).map((word) => word.replace(/.*>/, "").replace(/<$/, ""));
    expect(words).toHaveLength(6);
    for (const word of words) expect(word.trim().length).toBeGreaterThan(0);
    expect(markup).toContain("证据不足");
  });

  it("offers the evidence for an unwritten cell rather than a dead end", () => {
    const { markup } = render("verify");
    expect(markup).toContain("rp-doc__cellfill--open");
    const read = render("read");
    expect(read.markup).not.toContain("rp-doc__cellfill--open");
  });
});

describe("the research boundaries", () => {
  it("collects the open cells by question, not cell by cell", () => {
    const items = boundariesOf(bundleFixture());
    expect(items).toHaveLength(3);
    expect(items.every((item) => item.cells.length > 0)).toBe(true);
    // The question with the most still open comes first.
    expect(items[0]?.cells.length).toBeGreaterThanOrEqual(items[2]?.cells.length ?? 0);
  });

  it("says what is still open, for which objects, and what it needs", () => {
    const { markup } = render("verify");
    expect(markup).toContain("研究边界");
    expect(markup).toContain('data-testid="boundary-dim_cost"');
    expect(markup).toContain("涉及对象：GraphRAG、LightRAG");
    expect(markup).toContain("查看全部缺口");
  });

  it("counts the cells it is standing in for", () => {
    // Six cells, one of them established: five still need work.
    expect(boundarySummary(bundleFixture())).toBe("5 项需要进一步核验");
  });

  it("keeps a frozen revision free of today's coverage", () => {
    const { markup } = render("read", 1);
    expect(markup).not.toContain('data-testid="research-boundaries"');
  });
});

describe("the checks at the top of the document", () => {
  it("says how many obligations were not met, and keeps the sentences behind a disclosure", () => {
    expect(warningSummary(documentFixture())).toEqual({
      count: 1,
      headline: "需要进一步核验 · 1",
    });
    expect(warningSummary({ ...documentFixture(), validation: null })).toBeNull();
  });
});
