/**
 * Trust: what the page says about an action, a proposal, and the project.
 *
 * Three statements this product must never make and used to make: that a
 * search which found two background papers answered the question, that a
 * modification proposal was ready to accept before anything had checked it, and
 * that a project with material in every cell had nothing left to look into.
 * They are checked here on the markup and on the pure decisions behind it,
 * because they are sentences a reader acts on.
 *
 * The browser gate drives the same surfaces with real clicks; these tests are
 * the part of it that can be run in a second, and they are the ones that name
 * the exact wording.
 */

import { MantineProvider } from "@mantine/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ADEQUACY_LABELS,
  BRIEF_FIELD_LABELS,
  BRIEF_STATE_LABELS,
  CELL_FALLBACK_LABELS,
  CLAIM_TYPE_LABELS,
  COMPARABILITY_LABELS,
  PROPOSAL_STATUS_LABELS,
  RESOLUTION_LABELS,
  ROLE_LABELS,
  SCOPE_LABELS,
  STAGE_LABELS,
  STATUS_LABELS,
  TOOL_LABELS,
  type AssessmentView,
  type CellView,
  type EvidenceView,
  type PresentationReadout,
  type ProposalView,
  type RunView,
  type SourceView,
  type TaskBundle,
} from "../src/browser/api.js";
import { AssistantTurn } from "../src/browser/components/assistant.js";
import { DOC_THEME_OPTIONS } from "../src/browser/views/studio.js";
import { interactionIdOf, actionMaterial, deltaLine, researchOutcomeOf } from "../src/browser/outcome.js";
import { proposalDeltaLine, proposalViewState } from "../src/browser/proposal-logic.js";
import { primaryStatusOf, scopeEntryLabel, statusDetails } from "../src/browser/status.js";
import { conversationOf, type Interaction } from "../src/browser/conversation-logic.js";
import { VIEW_LABELS } from "../src/browser/routes.js";

/* --------------------------------------------------------------- fixtures -- */

function sourceFixture(overrides: Partial<SourceView> & { readonly sourceId: string }): SourceView {
  return {
    title: "Microsoft GraphRAG 的中文语料实践",
    authors: ["一位作者"],
    venue: "arXiv",
    publishedAt: "2026-01-02T00:00:00.000Z",
    url: "https://example.org/a",
    doi: null,
    abstract: "",
    role: "contextual",
    readStatus: "ok",
    readScope: "abstract",
    readAt: "2026-10-08T02:00:00.000Z",
    readUrl: "https://example.org/a",
    retrievalNote: "",
    failure: null,
    discovery: { provider: "crossref", query: "graphrag 中文", queriedAt: "2026-10-08T02:00:00.000Z", target: null },
    ...overrides,
  };
}

function evidenceFixture(overrides: Partial<EvidenceView> & { readonly evidenceId: string }): EvidenceView {
  return {
    sourceId: "src_bg",
    excerpt: "本文讨论了一种基于社区摘要的检索方式。",
    locator: { paragraphIndex: 1, headingPath: ["方法"], charStart: 40, charEnd: 80 },
    readScope: "abstract",
    pickedBecause: "提到检索结构",
    cells: [{ sectionId: "sec_compare", subjectId: "sub_graphrag", dimensionId: "dim_update" }],
    ...overrides,
  };
}

function assessmentFixture(overrides: Partial<AssessmentView> & { readonly assessmentId: string }): AssessmentView {
  return {
    target: { sectionId: "sec_compare", subjectId: "sub_graphrag", dimensionId: "dim_update" },
    evidenceIds: ["ev_bg"],
    relationship: "contextual",
    directness: "contextual",
    scope: "背景",
    rationale: "只说明一般机制，没有生产限制。",
    assessor: "agent",
    createdAt: "2026-10-08T02:00:00.000Z",
    ...overrides,
  };
}

function cellFixture(overrides: Partial<CellView> & { readonly subjectId: string; readonly dimensionId: string }): CellView {
  return {
    sectionId: "sec_compare",
    subjectName: "GraphRAG",
    dimensionName: "增量更新",
    status: "unassessed",
    reason: "有背景材料，但还没有直接依据",
    gap: "缺少官方说明",
    evidenceIds: [],
    note: "",
    ...overrides,
  };
}

function readout(overrides: Partial<PresentationReadout> = {}): PresentationReadout {
  return {
    runState: { state: "report_ready", displayName: "报告已就绪", userMessage: "报告已经写好并保存。" },
    evidenceCoverage: {
      cells: 4,
      withMaterial: 4,
      reviewed: 0,
      displayName: "4 / 4 个比较项已有材料",
      userMessage: "4 / 4 个比较项已有材料；其中 0 项已核对。材料覆盖不等于结论完成。",
    },
    unresolvedResearch: {
      unresolved: 2,
      limited: 1,
      incomparable: 1,
      resolved: 0,
      displayName: "4 项还没有结论",
      userMessage: "2 项还没有可用的依据、1 项只有有限支持、1 项冲突或不可直接比较。",
    },
    reportReview: {
      state: "clean",
      reason: null,
      displayName: "未被标记待复核",
      userMessage: "报告写成之后没有新材料进入。",
    },
    artifactQuality: {
      state: "warnings",
      warnings: 1,
      blocking: 0,
      displayName: "通过，1 处义务未完全达成",
      userMessage: "报告通过了发布校验，但有 1 处义务没有完全达成。",
    },
    sourceRoles: {
      total: 3,
      classified: 0,
      unknown: 3,
      primary: 0,
      byRole: {},
      displayName: "一手材料（部分未分类）",
      userMessage: "原始论文 / 一手材料：未知（3 个来源尚未分类）",
    },
    ...overrides,
  };
}

function bundleFixture(overrides: Partial<TaskBundle> = {}): TaskBundle {
  const subjects = [{ id: "sub_graphrag", name: "GraphRAG" }];
  const dimensions = [{ id: "dim_update", name: "增量更新", question: "文档变动后要重建什么？" }];
  const matrix = [
    cellFixture({ subjectId: "sub_graphrag", dimensionId: "dim_update" }),
    cellFixture({ subjectId: "sub_graphrag", dimensionId: "dim_update", status: "missing", subjectName: "LightRAG" }),
  ];
  return {
    task: {
      id: "task_1",
      sessionId: "sess_1",
      topic: "Microsoft GraphRAG 的中文处理与增量更新",
      purpose: "技术选型",
      audience: "工程团队",
      focus: [],
      exclusions: "",
      lengthTarget: "",
      status: "ready",
      confirmed: true,
      confirmedAt: "2026-10-07T09:00:00.000Z",
      error: null,
      createdAt: "2026-10-07T08:00:00.000Z",
      updatedAt: "2026-10-08T02:00:00.000Z",
      reportNeedsReview: null,
    },
    structure: [],
    subjects,
    dimensions,
    matrix,
    gaps: matrix,
    assessments: [assessmentFixture({ assessmentId: "asmt_bg" })],
    sources: [sourceFixture({ sourceId: "src_bg" })],
    evidence: [evidenceFixture({ evidenceId: "ev_bg" })],
    reports: [],
    proposals: [],
    revisions: [],
    exports: [],
    runs: [],
    budget: { maxSearches: 6, maxCandidatesPerSearch: 5, maxReads: 10, maxGapRounds: 2, deadlineMs: 480000 },
    usage: { searches: 2, reads: 3, gapRounds: 0 },
    brief: {
      taskId: "task_1",
      confirmed: true,
      readonly: true,
      version: 3,
      updatedAt: null,
      blueprint: {
        id: "technical-comparison-v2",
        name: "Technical Comparison v2",
        purpose: "比较",
        minimumSubjects: 1,
        minimumDimensions: 1,
        recommendedSubjects: [2, 5],
        recommendedDimensions: [3, 6],
      },
      topic: "Microsoft GraphRAG 的中文处理与增量更新",
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
      matrix: { subjects: 1, dimensions: 1, cells: 1 },
      contentHash: "sha256:abcdef",
    },
    actionBudget: null,
    currentReportId: "rep_1",
    currentReportHash: "sha256:abcdef",
    currentReportFrozen: false,
    hasReport: true,
    presentation: readout(),
    busy: false,
    ...overrides,
  };
}

const UNRESOLVED: Interaction = {
  id: "run_1",
  runId: "run_1",
  kind: "research",
  at: "2026-10-08T01:00:00.000Z",
  endedAt: "2026-10-08T01:03:00.000Z",
  status: "completed",
  userText: "补查 Microsoft 官方对 GraphRAG 中文处理与增量更新的说明",
  answer: null,
  searches: 2,
  reads: 4,
  assessments: 1,
  drafted: false,
  refusal: "",
  steps: [],
  failure: "",
  outcome: {
    kind: "research",
    resolution: {
      status: "unresolved",
      question: "补查 Microsoft 官方对 GraphRAG 中文处理与增量更新的说明",
      newSourceIds: ["src_bg"],
      newEvidenceIds: ["ev_bg"],
      newAssessmentIds: ["asmt_bg"],
      supportingEvidenceIds: [],
      targetCells: [{ sectionId: "sec_compare", subjectId: "sub_graphrag", dimensionId: "dim_update" }],
      remainingGap: [
        { subjectName: "GraphRAG", dimensionName: "增量更新", status: "limited", reason: "只有间接材料，没有官方说明" },
      ],
      summary:
        "没有找到能直接回答这一问题的材料：GraphRAG × 增量更新 仍然只有背景或间接材料。本轮新增 1 篇背景材料。报告正文没有改变。",
    },
    delta: { newSourceIds: ["src_bg"], newEvidenceIds: ["ev_bg"], newAssessmentIds: ["asmt_bg"] },
  },
};

const PARTIAL: Interaction = {
  ...UNRESOLVED,
  id: "run_2",
  runId: "run_2",
  outcome: {
    kind: "research",
    resolution: {
      status: "partially_resolved",
      question: "中文处理与增量更新",
      newSourceIds: ["src_bg"],
      newEvidenceIds: ["ev_bg"],
      newAssessmentIds: ["asmt_bg"],
      supportingEvidenceIds: ["ev_cn"],
      targetCells: [
        { sectionId: "sec_compare", subjectId: "sub_graphrag", dimensionId: "dim_cn" },
        { sectionId: "sec_compare", subjectId: "sub_graphrag", dimensionId: "dim_update" },
      ],
      remainingGap: [{ subjectName: "GraphRAG", dimensionName: "增量更新", status: "limited", reason: "缺少公开说明" }],
      summary: "找到了一部分直接依据，但「增量更新」仍缺少公开说明。",
    },
    delta: { newSourceIds: ["src_bg"], newEvidenceIds: ["ev_bg"], newAssessmentIds: ["asmt_bg"] },
  },
};

const SILENT: Interaction = {
  ...UNRESOLVED,
  id: "run_3",
  runId: "run_3",
  // A run from before the outcome was recorded: the page says so rather than
  // counting the material and calling it an answer.
  outcome: null,
};

/** The markup one assistant turn produces, with the props a real turn gets. */
function turn(interaction: Interaction, bundle: TaskBundle = bundleFixture()): string {
  return renderToStaticMarkup(
    createElement(
      MantineProvider,
      null,
      createElement(AssistantTurn, {
        bundle,
        interaction,
        proposal: null,
        allowance: { searches: 2, reads: 4 },
        answerBudget: null,
        onInspect: () => undefined,
        onOpenProposal: () => undefined,
        onEditFromResearch: () => undefined,
        onRetryEdit: () => undefined,
        onRewrite: () => undefined,
      }),
    ),
  );
}

function visibleText(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* ------------------------------------------------------- the research turn -- */

describe("a research action's result", () => {
  it("answers whether the question was resolved before it counts anything", () => {
    const markup = turn(UNRESOLVED);
    const text = visibleText(markup);
    expect(text).toContain("未解决");
    expect(text).toContain("没有找到能直接回答这一问题的材料");
    // The verdict is the first thing in the turn's own order, not a footnote.
    expect(markup.indexOf("未解决")).toBeLessThan(markup.indexOf("本轮新增"));
  });

  it("says what is still missing, named as the reader knows it", () => {
    const text = visibleText(turn(UNRESOLVED));
    expect(text).toContain("仍缺少");
    expect(text).toContain("GraphRAG × 增量更新");
    expect(text).toContain("只有间接材料，没有官方说明");
  });

  it("names the part that was settled when only part of it was", () => {
    const text = visibleText(turn(PARTIAL));
    expect(text).toContain("部分解决");
    expect(text).toContain("已解决");
    expect(text).toContain("GraphRAG × 增量更新");
  });

  it("does not dress a fetch count as an answer", () => {
    const text = visibleText(turn(UNRESOLVED));
    for (const wrong of ["找到可用材料", "问题已有答案", "补查成功", "找到 2 个"]) {
      expect(text).not.toContain(wrong);
    }
  });

  it("keeps what the action spent folded, behind the result", () => {
    const markup = turn(UNRESOLVED);
    expect(markup).toContain('data-testid="research-activity"');
    expect(markup.indexOf("<details")).toBeLessThan(markup.indexOf("2 次检索"));
    const text = visibleText(markup);
    expect(text).toContain("2 次检索");
    expect(text).toContain("4 个来源读取");
  });

  it("offers this action's evidence, and says so honestly for a run that predates the record", () => {
    expect(turn(UNRESOLVED)).toContain('data-testid="inspect-action-evidence"');
    const legacy = turn(SILENT);
    expect(visibleText(legacy)).toContain("结果未记录");
    expect(legacy).not.toContain('data-testid="inspect-action-evidence"');
  });
});

/* ---------------------------------------------------- one action's evidence -- */

describe("one action's evidence", () => {
  const bundle = bundleFixture({
    sources: [
      sourceFixture({ sourceId: "src_bg" }),
      sourceFixture({ sourceId: "src_other", title: "项目里早就有的材料" }),
    ],
    evidence: [
      evidenceFixture({ evidenceId: "ev_bg" }),
      evidenceFixture({ evidenceId: "ev_other", sourceId: "src_other" }),
    ],
    assessments: [assessmentFixture({ assessmentId: "asmt_bg" }), assessmentFixture({ assessmentId: "asmt_other" })],
    runs: [runFixture(UNRESOLVED)],
  });

  it("returns only what this action added, never the project's own library", () => {
    const material = actionMaterial(bundle, "run_1");
    expect(material.sources.map((source) => source.sourceId)).toEqual(["src_bg"]);
    expect(material.evidence.map((item) => item.evidenceId)).toEqual(["ev_bg"]);
    expect(material.assessments.map((entry) => entry.assessmentId)).toEqual(["asmt_bg"]);
  });

  it("is empty — and says nothing — for an action that added nothing", () => {
    const quiet = bundleFixture({ runs: [runFixture({ ...UNRESOLVED, id: "run_9", runId: "run_9", outcome: null })] });
    const material = actionMaterial(quiet, "run_9");
    expect(material.sources).toEqual([]);
    expect(material.evidence).toEqual([]);
    expect(material.assessments).toEqual([]);
  });

  it("finds an action by the id the conversation keys it on", () => {
    const runs = [runFixture(UNRESOLVED)];
    expect(interactionIdOf(runs[0]!)).toBe("run_1");
    const listed = conversationOf({ ...bundle, runs }, []);
    expect(listed[0]?.id).toBe("run_1");
  });
});

/** The run record behind one interaction, as the API carries it. */
function runFixture(interaction: Interaction): RunView {
  return {
    runId: interaction.runId,
    stage: interaction.kind === "research" ? "gap" : interaction.kind === "edit" ? "edit" : "ask",
    status: "completed",
    note: "",
    startedAt: interaction.at,
    endedAt: interaction.endedAt,
    activity: [],
    userText: interaction.userText,
    outcome: interaction.outcome,
  };
}

/* ------------------------------------------------------------- proposals -- */

describe("a modification proposal", () => {
  const states: readonly ProposalView["status"][] = ["pending", "accepted", "discarded", "stale", "invalid"];

  it("labels every state in the reader's words, and none of them in the contract's", () => {
    expect(states.map((status) => proposalViewState(status).label)).toEqual([
      "待确认",
      "已接受",
      "已放弃",
      "需要重新生成",
      "未生成修改建议",
    ]);
    for (const status of states) {
      expect(Object.keys(PROPOSAL_STATUS_LABELS)).toContain(status);
    }
  });

  it("offers the decision while it is pending, and never again after that", () => {
    expect(proposalViewState("pending").decidable).toBe(true);
    expect(proposalViewState("pending").folded).toBe(false);
    for (const status of states.filter((candidate) => candidate !== "pending")) {
      expect(proposalViewState(status).decidable).toBe(false);
      expect(proposalViewState(status).folded).toBe(true);
    }
  });

  it("says a zero delta in words rather than leaving the line out", () => {
    expect(proposalDeltaLine({ sources: 0, evidence: 0, assessments: 0 })).toBe("本次修改没有新增研究材料。");
    expect(proposalDeltaLine({ sources: 2, evidence: 4, assessments: 1 })).toBe("2 个来源 · 4 条证据 · 1 条评估");
  });

  it("shows an Edit that produced nothing as a refusal with a reason and no way to accept", () => {
    const refused: Interaction = {
      ...UNRESOLVED,
      id: "run_edit",
      runId: "run_edit",
      kind: "edit",
      drafted: false,
      outcome: {
        kind: "edit",
        status: "proposal_not_created",
        userMessage: "我准备的改写丢失了这一节必须保留的综合判断（跨来源的、有边界的判断），因此没有提交为修改建议。报告正文没有改变。",
        delta: { newSourceIds: [], newEvidenceIds: [], newAssessmentIds: [] },
      },
    };
    const markup = turn(refused);
    const text = visibleText(markup);
    expect(text).toContain("这次改写没有形成可接受的修改建议");
    expect(text).toContain("丢失了这一节必须保留的综合判断");
    expect(text).toContain("重新尝试");
    expect(text).toContain("换一种修改方式");
    // No proposal and no decision: the reader cannot accept something that was
    // never created, so no proposal card and no accept control is rendered.
    expect(text).not.toContain("接受这一节");
    expect(markup).not.toContain('data-testid="accept-proposal"');
    expect(markup).not.toContain('data-testid="assistant-proposal"');
  });
});

/* ----------------------------------------------------------- project status -- */

describe("the project's one status line", () => {
  it("never turns material coverage into「无待查项」", () => {
    // Every cell has material; none of them has a conclusion. The old label
    // said「报告就绪 · 无待查项」here, which is a claim about the research made
    // out of a count of files.
    const bundle = bundleFixture();
    const status = primaryStatusOf(bundle);
    expect(status.kind).toBe("unresolved");
    expect(status.label).toContain("项研究问题仍未解决");
    expect(status.label).not.toContain("无待查项");
  });

  it("puts work in flight and decisions owed ahead of a ready project", () => {
    const running = bundleFixture({
      presentation: readout({
        runState: { state: "researching", displayName: "研究中", userMessage: "正在检索、读取与核对材料。" },
      }),
    });
    expect(primaryStatusOf(running).kind).toBe("running");

    const pending = bundleFixture({
      proposals: [{ proposalId: "prp_1", status: "pending" } as unknown as ProposalView],
    });
    expect(primaryStatusOf(pending).kind).toBe("proposal");

    const review = bundleFixture({
      task: { ...bundleFixture().task, reportNeedsReview: { at: "2026-10-08T02:00:00.000Z", reason: "材料在报告之后发生了变化", evidenceIds: [] } },
      presentation: readout({ reportReview: { state: "needs_review", reason: "材料在报告之后发生了变化", displayName: "需要复核", userMessage: "建议复核。" } }),
    });
    expect(primaryStatusOf(review).kind).toBe("needs_review");
  });

  it("says a ready project is ready only when the research is settled", () => {
    const settled = bundleFixture({
      presentation: readout({
        evidenceCoverage: { cells: 1, withMaterial: 1, reviewed: 1, displayName: "1 / 1", userMessage: "1 / 1 个比较项都有材料，且都已核对。" },
        unresolvedResearch: { unresolved: 0, limited: 0, incomparable: 0, resolved: 1, displayName: "没有未解决的研究项", userMessage: "每个比较项都已经有直接依据。" },
      }),
    });
    const status = primaryStatusOf(settled);
    expect(status.kind).toBe("ready");
    expect(status.label).toContain("比较项均已核对");
  });

  it("keeps the facts behind the status side by side instead of merged", () => {
    const rows = statusDetails(bundleFixture());
    expect(rows.map((row) => row.label)).toEqual(["当前动作", "材料覆盖", "研究判断", "报告", "质量检查", "来源"]);
    const coverage = rows.find((row) => row.label === "材料覆盖");
    expect(coverage?.text).toContain("材料覆盖不等于结论完成");
    const roles = rows.find((row) => row.label === "来源");
    expect(roles?.text).toContain("尚未分类");
    expect(roles?.text).not.toContain("0 个一手材料");
  });

  it("keeps the research scope reachable beside the project's own title", () => {
    expect(scopeEntryLabel(bundleFixture())).toBe("研究范围 · 已确认");
    expect(scopeEntryLabel(bundleFixture({ task: { ...bundleFixture().task, confirmed: false } }))).toBe("研究范围 · 待确认");
  });
});

/* ---------------------------------------------------------------- wording -- */

describe("the page's vocabulary", () => {
  const FORBIDDEN = /Q\d\d|synthesis|conditions\.|claim id|contentHash|ActionGrant|gapRounds|tool call|sub_|dim_|clm_|ev_/;

  it("has no internal word in any label a reader can see", () => {
    const labels: Readonly<Record<string, string>>[] = [
      STATUS_LABELS,
      CELL_FALLBACK_LABELS,
      PROPOSAL_STATUS_LABELS,
      RESOLUTION_LABELS,
      ROLE_LABELS,
      SCOPE_LABELS,
      STAGE_LABELS,
      CLAIM_TYPE_LABELS,
      ADEQUACY_LABELS,
      COMPARABILITY_LABELS,
      BRIEF_FIELD_LABELS,
      BRIEF_STATE_LABELS,
      TOOL_LABELS,
      VIEW_LABELS,
    ];
    for (const map of labels) {
      for (const [key, value] of Object.entries(map)) {
        expect(FORBIDDEN.test(value), `${key}: ${value}`).toBe(false);
      }
    }
  });

  it("offers both print styles from the report's own toolbar", () => {
    expect(DOC_THEME_OPTIONS.map((option) => option.id)).toEqual(["editorial", "swiss"]);
    expect(DOC_THEME_OPTIONS.map((option) => option.name).join(" ")).toContain("Swiss");
  });
});
