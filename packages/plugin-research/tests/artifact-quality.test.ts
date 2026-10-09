/**
 * The artifact quality contract, at the scale each rule is decided.
 *
 * Truth-boundary validation is tested elsewhere; what these tests pin is the
 * layer above it — that a report which technically cites real material can
 * still be refused for not being a research artifact, and that the refusals say
 * which obligation was not met. Each test is one of the ten acceptance
 * scenarios the quality contract names, plus the two derived states they
 * depend on (claim adequacy, and what the default PDF projection contains).
 */

import { describe, expect, it } from "vitest";

import type {
  Evidence,
  MatrixCell,
  ReportClaim,
  ReportTask,
  Source,
  Subject,
  Dimension,
  SupportAssessment,
} from "../src/domain.js";
import { DEFAULT_BUDGET, emptyUsage } from "../src/domain.js";
import { BLUEPRINT_ID_V2 } from "../src/blueprint.js";
import { deriveClaimAdequacy, validateClaimContract, type ClaimContext } from "../src/claims.js";
import { renderReportHtml } from "../src/render.js";
import { validateReport, type ReportDraft } from "../src/report.js";
import { buildMatrix } from "../src/structure.js";

// ---------------------------------------------------------------- fixtures ---

const SUBJECTS: readonly Subject[] = [
  { id: "sub_a", name: "MethodA" },
  { id: "sub_b", name: "MethodB" },
];

const DIMENSIONS: readonly Dimension[] = [
  { id: "dim_idea", name: "对象与任务适配", question: "方法是什么、面向什么任务" },
  { id: "dim_build", name: "结构与构建", question: "输入与中间结构如何构建" },
  { id: "dim_query", name: "查询机制", question: "查询如何被处理" },
  { id: "dim_eval", name: "实验与评测", question: "在什么任务数据指标下验证，是否可比" },
  { id: "dim_cost", name: "成本与资源条件", question: "构建、查询、更新的成本口径是什么" },
  { id: "dim_limits", name: "局限、失效与未知", question: "局限与未验证部分是什么" },
];

function makeTask(): ReportTask {
  const matrix: readonly MatrixCell[] = buildMatrix(SUBJECTS, DIMENSIONS, "2026-10-05T00:00:00Z");
  return {
    id: "task_v2",
    sessionId: "session_v2",
    topic: "两种图结构检索方法的比较",
    purpose: "组会汇报",
    audience: "研究生",
    focus: [],
    exclusions: "",
    language: "zh",
    lengthTarget: "约 4–6 页",
    status: "researching",
    confirmedAt: "2026-10-05T00:00:00Z",
    blueprintId: BLUEPRINT_ID_V2,
    structure: {
      sections: [
        { id: "overview", title: "研究问题与关键认识", question: "研究什么" },
        { id: "mental-model", title: "概念坐标", question: "概念与分类" },
        { id: "mechanism", title: "机制解释", question: "如何工作" },
        { id: "comparison", title: "条件化比较", question: "共同维度下的差异" },
        { id: "synthesis", title: "综合判断与权衡", question: "多来源综合" },
        { id: "limitations", title: "局限、未知与下一步", question: "缺口" },
      ],
    },
    subjects: SUBJECTS,
    dimensions: DIMENSIONS,
    matrix,
    budget: DEFAULT_BUDGET,
    usage: emptyUsage(),
    currentReportId: null,
    reportDraft: null,
    createdAt: "2026-10-05T00:00:00Z",
    updatedAt: "2026-10-05T00:00:00Z",
    error: null,
  };
}

const SNAPSHOT_TEXT =
  "MethodA builds a graph index over the corpus and pre-generates community summaries for corpus-level questions. " +
  "Its reported indexing pass uses one LLM call over every text unit, and the paper reports token counts rather than wall-clock latency. " +
  "MethodB builds a passage graph and answers queries by personalized PageRank over it, reporting query latency in milliseconds. " +
  "Both papers evaluate on their own datasets with different metrics, and neither reports an independent evaluation.";

function evidenceAt(input: {
  readonly id: string;
  readonly sourceId: string;
  readonly text: string;
  readonly subjectId?: string;
  readonly dimensionId?: string;
  readonly scope?: Evidence["readScope"];
}): Evidence {
  const start = SNAPSHOT_TEXT.indexOf(input.text);
  return {
    id: input.id,
    taskId: "task_v2",
    sourceId: input.sourceId,
    readId: "read_1",
    excerpt: input.text,
    locator: {
      paragraphIndex: 0,
      headingPath: ["Method"],
      charStart: start,
      charEnd: start + input.text.length,
    },
    readScope: input.scope ?? "full_text",
    cells:
      input.subjectId === undefined || input.dimensionId === undefined
        ? []
        : [{ sectionId: "comparison", subjectId: input.subjectId, dimensionId: input.dimensionId }],
    pickedBecause: "test",
    createdAt: "2026-10-05T00:00:00Z",
  };
}

const EV_A = "MethodA builds a graph index over the corpus and pre-generates community summaries for corpus-level questions.";
const EV_A_COST = "Its reported indexing pass uses one LLM call over every text unit, and the paper reports token counts rather than wall-clock latency.";
const EV_B = "MethodB builds a passage graph and answers queries by personalized PageRank over it, reporting query latency in milliseconds.";
const EV_MIXED = "Both papers evaluate on their own datasets with different metrics, and neither reports an independent evaluation.";

function sources(): readonly Source[] {
  return [
    {
      id: "src_a",
      taskId: "task_v2",
      title: "MethodA paper",
      authors: [],
      org: "",
      url: "https://arxiv.org/abs/2401.00001",
      pdfUrl: null,
      doi: null,
      publishedAt: null,
      venue: "arXiv",
      role: "primary",
      abstract: "",
      discovery: { provider: "arxiv", query: "q", queriedAt: "2026-10-05T00:00:00Z", target: null },
      readStatus: "ok",
      readScope: "full_text",
      readAt: "2026-10-05T00:00:00Z",
      readUrl: "https://arxiv.org/html/2401.00001",
      retrievalNote: "",
      failure: null,
      snapshotId: "read_1",
    },
    {
      id: "src_b",
      taskId: "task_v2",
      title: "MethodB paper",
      authors: [],
      org: "",
      url: "https://arxiv.org/abs/2402.00002",
      pdfUrl: null,
      doi: null,
      publishedAt: null,
      venue: "arXiv",
      role: "primary",
      abstract: "",
      discovery: { provider: "arxiv", query: "q", queriedAt: "2026-10-05T00:00:00Z", target: null },
      readStatus: "ok",
      readScope: "full_text",
      readAt: "2026-10-05T00:00:00Z",
      readUrl: "https://arxiv.org/html/2402.00002",
      retrievalNote: "",
      failure: null,
      snapshotId: "read_1",
    },
  ];
}

function evidence(): readonly Evidence[] {
  return [
    evidenceAt({ id: "ev_a", sourceId: "src_a", text: EV_A, subjectId: "sub_a", dimensionId: "dim_build" }),
    evidenceAt({ id: "ev_a_cost", sourceId: "src_a", text: EV_A_COST, subjectId: "sub_a", dimensionId: "dim_cost" }),
    evidenceAt({ id: "ev_b", sourceId: "src_b", text: EV_B, subjectId: "sub_b", dimensionId: "dim_build" }),
    evidenceAt({ id: "ev_mixed", sourceId: "src_b", text: EV_MIXED, subjectId: "sub_b", dimensionId: "dim_eval" }),
  ];
}

function assessmentOn(evidenceIds: readonly string[], input: Partial<SupportAssessment> = {}): SupportAssessment {
  return {
    id: `asm_${evidenceIds.join("_")}`,
    taskId: "task_v2",
    target: { sectionId: "comparison", subjectId: input.target?.subjectId ?? "sub_a", dimensionId: input.target?.dimensionId ?? "dim_build" },
    evidenceIds,
    relationship: input.relationship ?? "supports",
    directness: input.directness ?? "direct",
    scope: input.scope ?? "作者自述",
    rationale: input.rationale ?? "正文片段直接描述",
    assessor: "agent",
    createdAt: "2026-10-05T00:00:00Z",
  };
}

/** The claim set a valid report starts from; each test mutates one of them. */
function baseClaims(): ReportClaim[] {
  return [
    {
      id: "clm_mech_a",
      text: "MethodA 以图索引与社区摘要组织全局检索。",
      evidenceIds: ["ev_a"],
      kind: "fact",
      claimType: "mechanism",
      subjects: ["sub_a"],
      dimensions: ["dim_idea", "dim_build"],
    },
    {
      id: "clm_mech_b",
      text: "MethodB 以段落图上的扩散完成整合检索。",
      evidenceIds: ["ev_b"],
      kind: "fact",
      claimType: "mechanism",
      subjects: ["sub_b"],
      dimensions: ["dim_build", "dim_query"],
    },
    {
      id: "clm_compare",
      text: "两者的构建产物不同：一方是社区摘要，另一方是可供扩散的段落图。",
      evidenceIds: ["ev_a", "ev_b"],
      kind: "comparison",
      claimType: "comparison",
      subjects: ["sub_a", "sub_b"],
      dimensions: ["dim_build"],
      conditions: { scope: "只比较构建产物。" },
    },
    {
      id: "clm_cost",
      text: "在各自报告中，MethodA 报告索引阶段的 token 消耗，MethodB 报告查询延迟。",
      evidenceIds: ["ev_a_cost", "ev_b"],
      kind: "fact",
      claimType: "cost",
      subjects: ["sub_a", "sub_b"],
      conditions: {
        costStage: "indexing",
        comparability: "not-directly-comparable",
        basis: "author-reported",
        scope: "两份来源口径不同，不能直接比较。",
      },
    },
    {
      id: "clm_synthesis",
      text: "综合两篇论文可见，差异不在是否使用图，而在结构信息被使用的阶段。",
      evidenceIds: ["ev_a", "ev_b"],
      kind: "inference",
      claimType: "synthesis",
      synthesis: true,
      subjects: ["sub_a", "sub_b"],
      conditions: { scope: "由两条机制证据共同支持；属于我们的综合判断。" },
    },
    {
      id: "clm_limits",
      text: "两份来源都没有独立评估，评测口径也不一致。",
      evidenceIds: ["ev_mixed"],
      kind: "fact",
      claimType: "fact",
    },
  ];
}

/** A draft that satisfies every obligation; tests mutate one thing at a time. */
function baseDraft(): ReportDraft {
  return {
    title: "MethodA 与 MethodB：机制差异与证据边界",
    summary: "本报告比较两种图结构检索方法的机制差异，并说明现有材料不能支持的结论。",
    frame: {
      question: "MethodA 与 MethodB 在机制上有什么可比较的差异？",
      audience: "研究生",
      scope: "只覆盖两篇方法论文中的机制与设置。",
    },
    claims: baseClaims(),
    sections: [
      {
        id: "overview",
        title: "一、研究问题与关键认识",
        blocks: [
          { kind: "paragraph", text: "本次研究比较两种图结构检索方法，结论限定在两篇方法论文的材料内。", claimIds: [] },
          { kind: "list", items: [{ text: "两者都使用图结构，但结构的使用阶段不同。", claimIds: ["clm_compare"] }] },
          { kind: "callout", tone: "gap", text: "关键限制：没有独立评估，本报告不给出效果排名。" },
        ],
      },
      {
        id: "mental-model",
        title: "二、概念坐标",
        blocks: [
          {
            kind: "paragraph",
            text: "图结构检索的共同思路是把实体与关系显式保存为结构，再让查询使用它；可以按「结构在哪个阶段被使用」分类，这条轴是后面比较的坐标。",
            claimIds: ["clm_mech_a"],
          },
          { kind: "list", items: [{ text: "社区摘要：面向语料级问题的预生成描述。", claimIds: ["clm_mech_a"] }] },
        ],
      },
      {
        id: "mechanism",
        title: "三、机制解释",
        blocks: [
          {
            kind: "mechanism",
            title: "MethodA 的索引与查询",
            input: "整份语料的文本单元。",
            intermediate: "实体关系图与社区摘要。",
            steps: [
              { text: "从每个文本单元抽取实体与关系。", claimIds: ["clm_mech_a"] },
              { text: "对图做社区检测并生成社区摘要。", claimIds: ["clm_mech_a"] },
            ],
            output: "查询时可组织成全局回答的社区摘要。",
            tradeoff: "用一次覆盖全语料的处理换取语料级归纳能力。",
            failure: "图抽取质量差时社区摘要会失真。",
            claimIds: ["clm_mech_a"],
          },
        ],
      },
      {
        id: "comparison",
        title: "四、条件化比较",
        blocks: [
          {
            kind: "table",
            columns: ["对象", "结构与构建"],
            columnDimensions: [null, "dim_build"],
            rowSubjects: ["sub_a", "sub_b"],
            rows: [
              { cells: [{ text: "MethodA", claimIds: [] }, { text: "实体图 + 社区摘要", claimIds: ["clm_mech_a"] }] },
              { cells: [{ text: "MethodB", claimIds: [] }, { text: "段落图 + 扩散检索", claimIds: ["clm_mech_b"] }] },
            ],
          },
          { kind: "paragraph", text: "两者的构建产物不同，这是比较中最直接的差异。", claimIds: ["clm_compare"] },
          {
            kind: "callout",
            tone: "gap",
            dimensionIds: ["dim_eval", "dim_cost", "dim_limits"],
            text: "评测、成本与局限三个维度：只有各自论文的自报口径，没有共同设置下的对照，不作统一结论。",
          },
        ],
      },
      {
        id: "synthesis",
        title: "五、综合判断与权衡",
        blocks: [{ kind: "paragraph", text: "综合两篇论文可见，差异不在是否使用图，而在结构信息被使用的阶段。", claimIds: ["clm_synthesis"] }],
      },
      {
        id: "limitations",
        title: "六、局限、未知与下一步",
        blocks: [
          {
            kind: "list",
            items: [
              { text: "缺独立评估：效果差异只有作者自报口径。", claimIds: ["clm_limits"] },
              { text: "成本口径不同，下一步应查共同设置下的对照。", claimIds: ["clm_cost"] },
            ],
          },
        ],
      },
    ],
  };
}

function validate(draft: ReportDraft, extra: { readonly sources?: readonly Source[]; readonly assessments?: readonly SupportAssessment[] } = {}) {
  return validateReport({
    draft,
    task: makeTask(),
    evidence: evidence(),
    sources: extra.sources ?? sources(),
    assessments: extra.assessments ?? [],
    snapshotText: (readId) => (readId === "read_1" ? SNAPSHOT_TEXT : undefined),
    now: "2026-10-05T00:00:00Z",
  });
}

function without<T extends { readonly id: string }>(items: readonly T[], id: string): T[] {
  return items.filter((item) => item.id !== id);
}

function replacing(draft: ReportDraft, sectionId: string, blocks: ReportDraft["sections"][number]["blocks"]): ReportDraft {
  return {
    ...draft,
    sections: draft.sections.map((section) => (section.id === sectionId ? { ...section, blocks } : section)),
  };
}

// ------------------------------------------------------------------ tests ---

describe("artifact quality: the ten acceptance scenarios", () => {
  it("accepts the contract-satisfying report", () => {
    const result = validate(baseDraft());
    expect(result.problems, result.problems.join("; ")).toEqual([]);
    expect(result.checks.some((check) => check.id === "Q01" && check.result === "pass")).toBe(true);
  });

  it("1. refuses a report with no mental model", () => {
    const draft = { ...baseDraft(), sections: without(baseDraft().sections, "mental-model") };
    const result = validate(draft);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain("mental-model");
    expect(result.problems.join(" ")).toContain("Q04");
  });

  it("2. refuses a report that silently drops a promised dimension", () => {
    // The frame promises six dimensions; this report handles four and declares
    // nothing about the other two.
    const draft = replacing(baseDraft(), "comparison", [
      {
        kind: "table",
        columns: ["对象", "结构与构建"],
        columnDimensions: [null, "dim_build"],
        rowSubjects: ["sub_a", "sub_b"],
        rows: [
          { cells: [{ text: "MethodA", claimIds: [] }, { text: "实体图 + 社区摘要", claimIds: ["clm_mech_a"] }] },
          { cells: [{ text: "MethodB", claimIds: [] }, { text: "段落图 + 扩散检索", claimIds: ["clm_mech_b"] }] },
        ],
      },
      { kind: "paragraph", text: "两者的构建产物不同。", claimIds: ["clm_compare"] },
    ]);
    const result = validate(draft);
    expect(result.ok).toBe(false);
    const problems = result.problems.join(" ");
    expect(problems).toContain("Q06");
    expect(problems).toContain("实验与评测");
    expect(problems).toContain("成本与资源条件");

    // The same report passes once the missing dimensions are declared as gaps.
    const declared = replacing(draft, "comparison", [
      ...draft.sections.find((section) => section.id === "comparison")!.blocks,
      {
        kind: "callout",
        tone: "gap",
        dimensionIds: ["dim_eval", "dim_cost", "dim_limits"],
        text: "评测、成本与局限维度：只有各自论文口径，没有共同设置下的对照。",
      },
    ]);
    expect(validate(declared).problems.filter((problem) => problem.includes("Q06"))).toEqual([]);
  });

  it("3. refuses a one-line mechanism and warns when the trade-off is missing", () => {
    const shallow = replacing(baseDraft(), "mechanism", [
      { kind: "paragraph", text: "MethodA 的机制是一种图结构检索。", claimIds: ["clm_mech_a"] },
    ]);
    const refused = validate(shallow);
    expect(refused.ok).toBe(false);
    expect(refused.problems.join(" ")).toContain("结构化机制块");

    // A mechanism block that explains the process but never says what it costs
    // is published with a warning rather than blocked: the explanation exists.
    const noTradeoff = replacing(baseDraft(), "mechanism", [
      {
        kind: "mechanism",
        input: "文本单元",
        intermediate: "实体关系图",
        steps: [
          { text: "抽取实体与关系。", claimIds: ["clm_mech_a"] },
          { text: "做社区检测并生成摘要。", claimIds: ["clm_mech_a"] },
        ],
        output: "社区摘要",
        tradeoff: "",
        failure: "",
        claimIds: ["clm_mech_a"],
      },
    ]);
    const warned = validate(noTradeoff);
    expect(warned.problems, warned.problems.join("; ")).toEqual([]);
    expect(warned.warnings.join(" ")).toContain("代价");
    expect(warned.warnings.join(" ")).toContain("失效条件");
  });

  it("4. refuses a performance ranking built from two benchmarks", () => {
    const claims = baseClaims();
    const ranked: ReportClaim[] = [
      ...claims,
      {
        id: "clm_perf",
        text: "MethodB 在多跳检索上优于 MethodA，延迟更低。",
        evidenceIds: ["ev_b", "ev_a"],
        kind: "comparison",
        claimType: "performance",
        subjects: ["sub_a", "sub_b"],
        conditions: { comparability: "not-directly-comparable", scope: "两篇论文的评测设置不同。" },
      },
    ];
    const draft = replacing(baseDraft(), "comparison", [
      ...baseDraft().sections.find((section) => section.id === "comparison")!.blocks,
      { kind: "paragraph", text: "MethodB 在多跳检索上优于 MethodA，延迟更低。", claimIds: ["clm_perf"] },
    ]);
    const result = validate({ ...draft, claims: ranked });
    expect(result.ok).toBe(false);
    const problems = result.problems.join(" ");
    expect(problems).toContain("Q08");
    expect(problems).toContain("not-directly-comparable");

    // The same finding phrased as "in each report's own experiments" is allowed.
    const honest: ReportClaim[] = [
      ...claims,
      {
        id: "clm_perf",
        text: "在各自报告的实验中，MethodB 报告了多跳检索上的结果，MethodA 报告的是语料级问答设置。",
        evidenceIds: ["ev_b", "ev_a"],
        kind: "comparison",
        claimType: "performance",
        subjects: ["sub_a", "sub_b"],
        conditions: { comparability: "not-directly-comparable", scope: "两篇论文的评测设置不同，不能直接比较。" },
      },
    ];
    const allowed = validate({ ...draft, claims: honest });
    expect(allowed.problems.filter((problem) => problem.includes("Q08"))).toEqual([]);
  });

  it("5. treats a token-vs-latency cost comparison as incomparable", () => {
    const claims = baseClaims().map((claim) =>
      claim.id === "clm_cost"
        ? {
            ...claim,
            text: "MethodA 的成本更低，token 消耗远小于 MethodB 的查询延迟。",
            conditions: { costStage: "indexing" as const, comparability: "comparable" as const, scope: "口径对齐" },
          }
        : claim,
    );
    const result = validate({ ...baseDraft(), claims });
    expect(result.ok).toBe(false);
    const problems = result.problems.join(" ");
    expect(problems).toContain("Q08");
    expect(problems).toContain("口径");

    // Declaring the stages and reporting them side by side is what survives.
    const honest = baseClaims().map((claim) =>
      claim.id === "clm_cost"
        ? {
            ...claim,
            text: "在各自口径下：MethodA 报告索引阶段的 token 消耗，MethodB 报告查询延迟。",
          }
        : claim,
    );
    expect(validate({ ...baseDraft(), claims: honest }).problems.filter((problem) => problem.includes("Q08"))).toEqual([]);
  });

  it("6. refuses a comparative ranking supported by one object's evidence", () => {
    const claims = baseClaims().map((claim) =>
      claim.id === "clm_compare"
        ? {
            ...claim,
            text: "MethodA 的构建流程比 MethodB 更轻量。",
            evidenceIds: ["ev_a"],
            conditions: { scope: "只有一方的论文" },
          }
        : claim,
    );
    const result = validate({ ...baseDraft(), claims });
    expect(result.ok).toBe(false);
    const problems = result.problems.join(" ");
    expect(problems).toContain("Q07");
    expect(problems).toContain("MethodB");

    // A descriptive comparison that says what is missing is a warning instead.
    const descriptive = baseClaims().map((claim) =>
      claim.id === "clm_compare" ? { ...claim, evidenceIds: ["ev_a"] } : claim,
    );
    const warned = validate({ ...baseDraft(), claims: descriptive });
    expect(warned.ok).toBe(true);
    expect(warned.warnings.join(" ")).toContain("MethodB");
  });

  it("7. accepts a synthesis that binds several sources and says it is ours", () => {
    const result = validate(baseDraft());
    expect(result.problems.filter((problem) => problem.includes("Q09"))).toEqual([]);
    expect(result.checks.some((check) => check.id === "Q10" && check.result === "pass")).toBe(true);
  });

  it("8. refuses a synthesis with no inputs", () => {
    const claims = baseClaims().map((claim) =>
      claim.id === "clm_synthesis" ? { ...claim, evidenceIds: [] } : claim,
    );
    const result = validate({ ...baseDraft(), claims });
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain("clm_synthesis");

    // One source is not a synthesis either.
    const single = baseClaims().map((claim) =>
      claim.id === "clm_synthesis" ? { ...claim, evidenceIds: ["ev_a", "ev_a_cost"] } : claim,
    );
    const refused = validate({ ...baseDraft(), claims: single });
    expect(refused.ok).toBe(false);
    expect(refused.problems.join(" ")).toContain("≥2 个不同来源");
  });

  it("9. warns when the title promises effects the material does not measure", () => {
    const draft = {
      ...baseDraft(),
      title: "MethodA 与 MethodB 的效果比较：性能评测",
      claims: baseClaims().filter((claim) => claim.claimType !== "comparison"),
      sections: baseDraft().sections.map((section) =>
        section.id === "comparison"
          ? {
              ...section,
              blocks: section.blocks.map((block) =>
                block.kind === "paragraph" ? { ...block, claimIds: ["clm_mech_a"] } : block,
              ),
            }
          : section,
      ),
    };
    const result = validate(draft);
    expect(result.warnings.join(" ")).toContain("Q02");
    // A warning does not block publication: the report still has to ship.
    expect(result.problems.filter((problem) => problem.includes("Q02"))).toEqual([]);
  });

  it("10. keeps the default projection compact while citations stay verifiable", () => {
    const draft = baseDraft();
    const html = renderReportHtml({
      task: { topic: "两种图结构检索方法的比较", audience: "研究生" },
      report: {
        id: "rep_1",
        title: draft.title,
        summary: draft.summary,
        frame: draft.frame,
        sections: draft.sections,
        claims: draft.claims,
      },
      sources: sources().map((source) => ({
        id: source.id,
        title: source.title,
        authors: source.authors,
        org: source.org,
        venue: source.venue,
        publishedAt: source.publishedAt,
        url: source.url,
        doi: source.doi,
        readScope: source.readScope,
      })),
      evidence: evidence().map((item) => ({
        id: item.id,
        sourceId: item.sourceId,
        excerpt: item.excerpt,
        readScope: item.readScope,
        locator: { headingPath: item.locator.headingPath, paragraphIndex: item.locator.paragraphIndex },
      })),
      gaps: [],
      subjectNames: new Map(SUBJECTS.map((subject) => [subject.id, subject.name])),
      dimensionNames: new Map(DIMENSIONS.map((dimension) => [dimension.id, dimension.name])),
      generatedAt: "2026-10-05T00:00:00Z",
    });

    // The excerpts themselves are not printed...
    for (const item of evidence()) {
      expect(html).not.toContain(item.excerpt);
    }
    // ...but every citation can still be located and its read scope checked.
    expect(html).toContain("核验索引");
    expect(html).toContain("完整正文");
    expect(html).toContain("Method");
    expect(html).toContain('id="ref-1"');
    // And the document states its own question before answering it.
    expect(html).toContain("研究问题");
    expect(html).toContain("综合判断");
  });
});

describe("the ranking lexicon's scope, through the whole validator", () => {
  /** The cost claim's own text replaced, leaving every other obligation as it was. */
  function withCostText(text: string): ReturnType<typeof validate> {
    const claims = baseClaims().map((claim) => (claim.id === "clm_cost" ? { ...claim, text } : claim));
    return validate({ ...baseDraft(), claims });
  }

  function q08(result: ReturnType<typeof validate>): { readonly result?: string; readonly detail?: string } {
    return result.checks.find((check) => check.id === "Q08") ?? {};
  }

  // The three sentences an independent review found being published: each has a
  // refusal word in it, each states a ranking, and the claim declares its
  // numbers are not comparable. Publishing them is the defect; refusing them is
  // the fix.
  it("refuses the counterexample that negates something unrelated to the ranking", () => {
    const result = withCostText("无法处理中文的 MethodA 优于 MethodB。");
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain("Q08");
    expect(q08(result).result).toBe("fail");
  });

  it("refuses the counterexample whose ranking follows an adversative but", () => {
    const result = withCostText("MethodA is not open source but outperforms MethodB.");
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain("Q08");
    expect(q08(result).result).toBe("fail");
  });

  it("refuses the counterexample that states a second ranking in the same clause", () => {
    const result = withCostText("不能判断 MethodA 更便宜但 MethodB 更便宜。");
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain("Q08");
    expect(q08(result).result).toBe("fail");
  });

  it("keeps a control ranking refused, so the fix did not loosen the rule", () => {
    const result = withCostText("MethodA 优于 MethodB。");
    expect(result.ok).toBe(false);
    expect(q08(result).result).toBe("fail");
  });

  it("keeps the honest refusal passing", () => {
    const refusal = withCostText("在索引阶段只能分口径陈述，不能合成一个更便宜的判断。");
    expect(refusal.problems.filter((problem) => problem.includes("Q08"))).toEqual([]);
    // Q08 may still carry the incomparability warning; what it must not carry
    // is the ranking failure.
    expect(q08(refusal).result).not.toBe("fail");
  });

  it("keeps the real draft's cost sentence passing", () => {
    // Verbatim from the run whose cost claim was refused by the first lexicon.
    const real =
      "索引成本只能分口径陈述，不能合成一个“更便宜”的判断。在 HippoRAG 2 论文自身口径内：" +
      "token/调用量上它低于 GraphRAG 与 LightRAG；索引时间上快于二者、但慢于 RAPTOR 与 HippoRAG；" +
      "显存上因 fact embedding 而高于基线。两篇的来源、语料与度量项不同，因此不能合并为一张跨来源的成本排名。";
    const result = withCostText(real);
    expect(result.problems.filter((problem) => problem.includes("Q08"))).toEqual([]);
    expect(q08(result).result).not.toBe("fail");
  });

  it("keeps Q09's evidence requirement independent of the ranking lexicon", () => {
    // A refusal is not a licence: the same claim with a fabricated citation is
    // still refused, so the lexicon's scope cannot be used to launder evidence.
    const draft = baseDraft();
    const claims = draft.claims.map((claim) =>
      claim.id === "clm_cost" ? { ...claim, text: "不能合成一个更便宜的判断。", evidenceIds: ["ev_fabricated"] } : claim,
    );
    const result = validate({ ...draft, claims });
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain("ev_fabricated");
  });
});

describe("claim adequacy is derived, not asserted", () => {
  function context(assessments: readonly SupportAssessment[] = []): ClaimContext {
    return {
      evidence: evidence(),
      sources: sources(),
      assessments,
      subjectNames: new Map(SUBJECTS.map((subject) => [subject.id, subject.name])),
    };
  }

  it("reports unassessed when nobody judged the passage", () => {
    const claim = baseClaims().find((candidate) => candidate.id === "clm_mech_a")!;
    expect(deriveClaimAdequacy(claim, context()).state).toBe("unassessed");
  });

  it("reaches adequate only with direct body-level support for every declared object", () => {
    const claim = baseClaims().find((candidate) => candidate.id === "clm_compare")!;
    const forA = assessmentOn(["ev_a"], { target: { sectionId: "comparison", subjectId: "sub_a", dimensionId: "dim_build" } } as Partial<SupportAssessment>);
    const forB = assessmentOn(["ev_b"], { target: { sectionId: "comparison", subjectId: "sub_b", dimensionId: "dim_build" } } as Partial<SupportAssessment>);
    expect(deriveClaimAdequacy(claim, context([forA])).state).toBe("limited");
    expect(deriveClaimAdequacy(claim, context([forA, forB])).state).toBe("adequate");
  });

  it("reports conflict and incomparability as findings, not as failures", () => {
    const claim = baseClaims().find((candidate) => candidate.id === "clm_mech_a")!;
    const contradicts = assessmentOn(["ev_a"], { relationship: "contradicts" });
    expect(deriveClaimAdequacy(claim, context([contradicts])).state).toBe("conflicted");

    const cost = baseClaims().find((candidate) => candidate.id === "clm_cost")!;
    expect(deriveClaimAdequacy(cost, context()).state).toBe("incomparable");
  });

  it("flags a mechanism claim whose only source is a survey", () => {
    const claim = baseClaims().find((candidate) => candidate.id === "clm_mech_a")!;
    const surveyOnly = sources().map((source) => (source.id === "src_a" ? { ...source, role: "survey" as const } : source));
    const verdict = validateClaimContract(claim, { ...context(), sources: surveyOnly });
    expect(verdict.errors).toEqual([]);
    expect(verdict.warnings.join(" ")).toContain("原始方法");
  });
});

describe("implications carry their conditions", () => {
  it("refuses an unconditional recommendation and accepts a conditional one", () => {
    const base = baseClaims().find((candidate) => candidate.id === "clm_limits")!;
    const context: ClaimContext = {
      evidence: evidence(),
      sources: sources(),
      assessments: [],
      subjectNames: new Map(SUBJECTS.map((subject) => [subject.id, subject.name])),
    };
    const unconditional: ReportClaim = {
      ...base,
      id: "clm_advice",
      claimType: "implication",
      text: "推荐使用 MethodA。",
      conditions: { scope: "" },
    };
    const refused = validateClaimContract(unconditional, context);
    expect(refused.errors.join(" ")).toContain("条件");

    const conditional: ReportClaim = {
      ...unconditional,
      text: "若主要问题是语料级全局归纳，可先评估 MethodA。",
      conditions: { scope: "条件取决于查询类型，需要在自有数据上验证。" },
    };
    expect(validateClaimContract(conditional, context).errors).toEqual([]);
  });
});

/**
 * The comparison matrix as content, not as a frame.
 *
 * Four real v2 reports were found holding a comparison table with its columns
 * and row subjects declared and every cell empty: `rows: [{cells: []}, …]`. The
 * reader got headings, rows and nothing to compare, and the validator passed it
 * because it only checked that the dimensions and subjects had been *declared*.
 * A declared frame is not a comparison — each required cell now has to carry a
 * bounded judgement or an explicit state.
 */
describe("the comparison table must be written, not just declared", () => {
  it("refuses a report whose comparison cells are empty", () => {
    const base = baseDraft();
    const draft = replacing(base, "comparison", [
      {
        kind: "table",
        columns: ["对象", "结构与构建", "评测口径", "成本与资源"],
        columnDimensions: [null, "dim_build", "dim_eval", "dim_cost"],
        rowSubjects: ["sub_a", "sub_b"],
        // The shape the real reports were saved with.
        rows: base.sections
          .find((section) => section.id === "comparison")!
          .blocks.filter((block) => block.kind === "table")
          .flatMap((block) => (block.kind === "table" ? block.rows.map(() => ({ cells: [] as { text: string; claimIds: string[] }[] })) : [])),
      },
      { kind: "callout", tone: "gap", dimensionIds: ["dim_query", "dim_limits", "dim_idea"], text: "其余维度：材料不足，不作结论。" },
    ]);
    const result = validate(draft);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain("空白单元格");
    expect(result.problems.join(" ")).toContain("第 1 行第 1 列");
  });

  it("accepts a cell that says the evidence is not there", () => {
    const base = baseDraft();
    const draft = replacing(base, "comparison", [
      {
        kind: "table",
        columns: ["对象", "结构与构建", "评测口径"],
        columnDimensions: [null, "dim_build", "dim_eval"],
        rowSubjects: ["sub_a", "sub_b"],
        rows: [
          {
            cells: [
              { text: "MethodA", claimIds: [] },
              { text: "实体图 + 社区摘要", claimIds: ["clm_mech_a"] },
              // A state word is a judgement about the evidence, and it is
              // exactly what a blank cell used to hide.
              { text: "证据不足：只有作者自报口径", claimIds: ["clm_limits"] },
            ],
          },
          {
            cells: [
              { text: "MethodB", claimIds: [] },
              { text: "段落图 + 扩散检索", claimIds: ["clm_mech_b"] },
              { text: "不可直接比较：数据集与指标不同", claimIds: ["clm_cost"] },
            ],
          },
        ],
      },
      { kind: "callout", tone: "gap", dimensionIds: ["dim_query", "dim_cost", "dim_limits", "dim_idea"], text: "其余维度：材料不足。" },
    ]);
    const result = validate(draft);
    expect(result.problems, result.problems.join("; ")).toEqual([]);
  });

  it("reports a blank the report already carried as a warning, not as a fault of this edit", () => {
    const base = baseDraft();
    const blankTable = replacing(base, "comparison", [
      {
        kind: "table",
        columns: ["对象", "结构与构建"],
        columnDimensions: [null, "dim_build"],
        rowSubjects: ["sub_a", "sub_b"],
        rows: [{ cells: [] }, { cells: [] }],
      },
      { kind: "callout", tone: "gap", dimensionIds: ["dim_eval", "dim_cost", "dim_limits", "dim_query", "dim_idea"], text: "其余维度：材料不足。" },
    ]);
    const edited = replacing(blankTable, "synthesis", [
      { kind: "paragraph", text: "综合两篇论文可见，差异不在是否使用图，而在结构信息被使用的阶段。", claimIds: ["clm_synthesis"] },
    ]);
    // The section being written here satisfies its own obligation, so the only
    // thing wrong with the draft is the table it inherited.
    const carriedOver = validateReport({
      draft: edited,
      task: makeTask(),
      evidence: evidence(),
      sources: sources(),
      assessments: [],
      snapshotText: (readId) => (readId === "read_1" ? SNAPSHOT_TEXT : undefined),
      carriedOverSectionIds: ["comparison"],
      now: "2026-10-05T00:00:00Z",
    });
    expect(carriedOver.problems, carriedOver.problems.join("; ")).toEqual([]);
    expect(carriedOver.warnings.join(" ")).toContain("空白单元格");
    expect(carriedOver.warnings.join(" ")).toContain("报告既有");

    // Without the declaration the same draft is refused: the content contract
    // applies in full to anything written now.
    const fresh = validate(edited);
    expect(fresh.ok).toBe(false);
    expect(fresh.problems.join(" ")).toContain("空白单元格");
  });
});
