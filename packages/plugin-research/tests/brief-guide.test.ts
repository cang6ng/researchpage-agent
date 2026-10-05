/**
 * The Research Brief's contracts, at the scale they are decided.
 *
 * The product's claim in this round is narrow and testable: an unconfirmed task
 * *is* the brief, both ways of editing it write to that one object, confirming
 * it freezes the draft the user finally agreed to, and the matrix is that
 * draft's projection rather than a separate record that can drift.
 *
 * The service is the real one over a real SQLite database; only the network is
 * absent, because none of these contracts is about the network.
 */

import { describe, expect, it } from "vitest";

import { openResearchRepository, type ResearchRepository } from "../src/repository.js";
import { createResearchService, type ResearchService } from "../src/service.js";
import type { BriefFieldName, BriefPatch, GuideQuestion } from "../src/brief.js";
import type { BriefView, GuideAnswerInput, GuideAnswerResult, PatchBriefResult } from "../src/service.js";
import type { ReadOutcome } from "../src/read.js";
import type { SearchOutcome } from "../src/search.js";
import type { ReportTask } from "../src/domain.js";
import { suggestedFieldStates } from "../src/domain.js";

const SESSION = "session_brief_guide";
const NOW = "2026-10-06T12:00:00.000Z";

/** The card the agent proposes: the complete default this round starts from. */
const CARD = {
  topic: "比较 GraphRAG、LightRAG 与传统 RAG，重点看长文档问答与工程成本",
  purpose: "组会汇报",
  audience: "工程师",
  focus: ["机制差异"],
  exclusions: "",
  lengthTarget: "约 4–6 页",
  subjects: [{ name: "GraphRAG" }, { name: "LightRAG" }],
  dimensions: [
    { name: "核心思想", question: "解决什么问题，面向哪类任务" },
    { name: "构建与检索", question: "如何构建索引，查询时如何检索" },
    { name: "成本与部署", question: "索引、查询与更新分别产生什么成本" },
  ],
} as const;

interface Harness {
  readonly repo: ResearchRepository;
  readonly service: ResearchService;
  readonly taskId: string;
  asCard(): void;
  asGuide(): void;
  brief(): BriefView;
  task(): ReportTask;
  close(): void;
}

function open(): Harness {
  const repo = openResearchRepository({ location: ":memory:" });
  const service = createResearchService({
    repo,
    search: async (query: string): Promise<SearchOutcome> => ({
      provider: "arxiv",
      query,
      requestUrl: `fixture://${query}`,
      fetchedAt: NOW,
      total: 0,
      candidates: [],
    }),
    read: async (): Promise<ReadOutcome> => ({
      status: "failed",
      scope: null,
      title: "",
      text: "",
      paragraphs: [],
      readUrl: "",
      fetchedAt: NOW,
      contentType: "text/html",
      note: "（脚本化读取：本测试不涉及真实网络）",
      failure: "not used",
    }),
    now: () => new Date(NOW),
  });

  service.issueGrant({ sessionId: SESSION, intent: "card", taskId: null });
  const proposed = service.proposeTask(SESSION, {
    ...CARD,
    subjects: [...CARD.subjects],
    dimensions: [...CARD.dimensions],
  });
  if (!proposed.ok) throw new Error(`card refused: ${proposed.problems.join("; ")}`);
  service.clearGrant(SESSION);
  const taskId = proposed.task.id;

  return {
    repo,
    service,
    taskId,
    asCard: () => service.issueGrant({ sessionId: SESSION, intent: "card", taskId }),
    asGuide: () => service.issueGrant({ sessionId: SESSION, intent: "guide", taskId }),
    brief: () => service.briefOf(taskId),
    task: () => {
      const task = service.getTask(taskId);
      if (task === undefined) throw new Error("task disappeared");
      return task;
    },
    close: () => repo.close(),
  };
}

/** A structured patch that has to succeed; a refusal is the test's failure. */
function patched(h: Harness, patch: unknown, expectedVersion?: number): PatchBriefResult {
  const result = h.service.patchBrief(h.taskId, {
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
    patch,
  });
  if (!result.ok) throw new Error(`patch refused: ${result.problems.join("; ")}`);
  return result;
}

/** A guided answer that has to succeed. */
function answered(h: Harness, input: GuideAnswerInput): GuideAnswerResult {
  const result = h.service.answerGuideQuestion(h.taskId, input);
  if (!result.ok) throw new Error(`answer refused: ${result.problems.join("; ")}`);
  return result;
}

function withQuestion(h: Harness, input: unknown): GuideQuestion {
  h.asGuide();
  const result = h.service.proposeGuideQuestion(h.taskId, input);
  h.service.clearGrant(SESSION);
  if (!result.ok) throw new Error(`question refused: ${result.problems.join("; ")}`);
  if (result.question === null) throw new Error("expected a question, got completion");
  return result.question;
}

/** Two real, different options for any field the ladder can ask about. */
function optionsFor(field: BriefFieldName, brief: BriefView): { readonly label: string; readonly value: BriefPatch }[] {
  const subjects = brief.subjects.map((subject) => ({ id: subject.id, name: subject.name }));
  const dimensions = brief.dimensions.map((dimension) => ({ id: dimension.id, name: dimension.name, question: dimension.question }));
  switch (field) {
    case "topic":
      return [
        { label: "保持现状", value: { topic: brief.topic } },
        { label: "收窄主题", value: { topic: "长文档问答中的图增强检索" } },
      ];
    case "purpose":
      return [
        { label: "理解机制", value: { purpose: "理解机制：弄清三种方法的构建与检索机制差异" } },
        { label: "为技术选型提供依据", value: { purpose: "为技术选型提供依据：比较工程成本与效果" } },
      ];
    case "audience":
      return [
        { label: "研究生组会", value: { audience: "研究生组会" } },
        { label: "工程团队", value: { audience: "工程团队" } },
      ];
    case "subjects":
      return [
        { label: "保持当前对象", value: { subjects } },
        { label: "加入传统 RAG", value: { subjects: [...subjects, { name: "传统 RAG" }] } },
      ];
    case "dimensions":
      return [
        { label: "保持当前维度", value: { dimensions } },
        {
          label: "加入部署与更新成本",
          value: { dimensions: [...dimensions, { name: "部署与更新成本", question: "部署与增量更新分别需要什么条件" }] },
        },
      ];
    case "focus":
      return [
        { label: "只看机制", value: { focus: ["机制差异"] } },
        { label: "机制加成本", value: { focus: ["机制差异", "工程成本"] } },
      ];
    case "exclusions":
      return [
        { label: "不限定", value: { exclusions: "" } },
        { label: "排除私有部署", value: { exclusions: "不涉及私有化部署与合规问题" } },
      ];
    case "lengthTarget":
      return [
        { label: "短", value: { lengthTarget: "约 2 页" } },
        { label: "深入", value: { lengthTarget: "约 8–10 页" } },
      ];
  }
}

const PURPOSE_QUESTION: Record<string, unknown> = {
  complete: false,
  question: "这次研究最重要的目标是什么？",
  whyThisMatters: "它决定检索方向、比较框架与结论的写法",
  fieldTargets: ["purpose"],
  options: [
    {
      label: "理解机制",
      description: "弄清三种方法各自如何构建与检索",
      value: { purpose: "理解机制：弄清三种方法的构建与检索机制差异" },
    },
    {
      label: "为技术选型提供依据",
      description: "比较工程成本与效果，支撑一次选型",
      value: { purpose: "为技术选型提供依据：在长文档问答场景比较工程成本与效果" },
      recommended: true,
    },
    { label: "准备组会综述", value: { purpose: "准备组会综述：向同方向同学讲清三类方法的现状与边界" } },
  ],
};

function purposeQuestion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...PURPOSE_QUESTION, ...overrides };
}

// -------------------------------------------------------------------------- A --

describe("A. a proposed card is a complete default draft", () => {
  it("carries the agent's fields, validates, and marks every field suggested", () => {
    const h = open();
    const brief = h.brief();

    expect(brief.confirmed).toBe(false);
    expect(brief.readonly).toBe(false);
    expect(brief.version).toBe(1);
    expect(brief.topic).toBe(CARD.topic);
    expect(brief.question).toBe("组会汇报");
    expect(brief.audience).toBe("工程师");
    expect(brief.focus).toEqual(["机制差异"]);
    expect(brief.subjects.map((subject) => subject.name)).toEqual(["GraphRAG", "LightRAG"]);
    expect(brief.dimensions).toHaveLength(3);
    expect(brief.validation).toEqual({ valid: true, problems: [] });

    expect(brief.fieldStates).toEqual(suggestedFieldStates());
    expect(Object.values(brief.fieldStates).every((state) => state === "suggested")).toBe(true);

    // The report structure is derived from the blueprint, shown but not a field.
    expect(brief.reportStructure.map((section) => section.id)).toContain("comparison");
    expect(brief.editableFields).toEqual([
      "topic",
      "purpose",
      "audience",
      "subjects",
      "dimensions",
      "focus",
      "exclusions",
      "lengthTarget",
    ]);

    // The matrix is the brief's projection from the moment the card exists.
    expect(brief.matrix).toEqual({ subjects: 2, dimensions: 3, cells: 6 });
    h.close();
  });
});

// -------------------------------------------------------------------------- B --

describe("B. a structured patch touches only what it names", () => {
  it("changes the targeted field, bumps the version, and leaves the rest untouched", () => {
    const h = open();
    const before = h.brief();

    const result = patched(h, { audience: "研究生组会" }, before.version);

    expect(result.changedFields).toEqual(["audience"]);
    expect(result.brief.audience).toBe("研究生组会");
    expect(result.brief.version).toBe(before.version + 1);
    expect(result.brief.fieldStates.audience).toBe("edited");
    expect(result.brief.fieldStates.purpose).toBe("suggested");

    // Everything else is what it was: a patch is not a rewrite of the card.
    expect(result.brief.topic).toBe(before.topic);
    expect(result.brief.purpose).toBe(before.purpose);
    expect(result.brief.focus).toEqual(before.focus);
    expect(result.brief.exclusions).toBe(before.exclusions);
    expect(result.brief.lengthTarget).toBe(before.lengthTarget);
    expect(result.brief.subjects).toEqual(before.subjects);
    expect(result.brief.dimensions).toEqual(before.dimensions);

    // And it is the same draft on the way back in.
    expect(h.brief().audience).toBe("研究生组会");
    h.close();
  });

  it("refuses a patch that names a field the brief does not have", () => {
    const h = open();
    const result = h.service.patchBrief(h.taskId, { patch: { confirmedAt: NOW, matrix: [], status: "ready" } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.join("；")).toContain("不允许通过 Brief 修改的字段");
    expect(h.brief().version).toBe(1);
    expect(h.task().confirmedAt).toBeNull();
    h.close();
  });

  it("refuses a stale expectedVersion instead of overwriting a newer draft", () => {
    const h = open();
    patched(h, { audience: "研究生组会" }, 1);
    const stale = h.service.patchBrief(h.taskId, { expectedVersion: 1, patch: { audience: "导师与同行" } });
    expect(stale.ok).toBe(false);
    if (stale.ok || !("stale" in stale)) throw new Error("expected a stale conflict");
    expect(stale.stale).toBe(true);
    expect(stale.brief.audience).toBe("研究生组会");
    expect(stale.brief.version).toBe(2);
    h.close();
  });
});

// -------------------------------------------------------------------------- C --

describe("C. ids stay stable across an edit", () => {
  it("keeps a renamed object's id and mints one only for a new object", () => {
    const h = open();
    const before = h.brief();
    const [first, second] = before.subjects;
    if (first === undefined || second === undefined) throw new Error("expected two subjects");

    const renamed = patched(h, {
      subjects: [
        { id: first.id, name: "GraphRAG" },
        { id: second.id, name: "LightRAG（图增强检索）" },
      ],
    });
    expect(renamed.brief.subjects.map((subject) => subject.id)).toEqual([first.id, second.id]);
    expect(renamed.brief.subjects[1]?.name).toBe("LightRAG（图增强检索）");

    // A reorder is a reorder, not a re-creation: the same ids in a new order.
    const reordered = patched(h, {
      subjects: [
        { id: second.id, name: "LightRAG（图增强检索）" },
        { id: first.id, name: "GraphRAG" },
      ],
    });
    expect(reordered.brief.subjects.map((subject) => subject.id)).toEqual([second.id, first.id]);

    // A new object is the only thing that gets a new id.
    const added = patched(h, {
      subjects: [
        { id: second.id, name: "LightRAG（图增强检索）" },
        { id: first.id, name: "GraphRAG" },
        { name: "传统 RAG" },
      ],
    });
    const ids = added.brief.subjects.map((subject) => subject.id);
    expect(ids.slice(0, 2)).toEqual([second.id, first.id]);
    expect(ids[2]).toBeTruthy();
    expect(ids[2]).not.toBe(first.id);
    expect(added.brief.subjects[2]?.name).toBe("传统 RAG");

    // Dimensions behave the same way, and a dimension keeps its question.
    const dimensionBefore = h.brief().dimensions[0];
    if (dimensionBefore === undefined) throw new Error("expected a dimension");
    const renamedDimension = patched(h, {
      dimensions: h.brief().dimensions.map((dimension) =>
        dimension.id === dimensionBefore.id ? { ...dimension, name: "核心思想与任务适配" } : dimension,
      ),
    });
    expect(renamedDimension.brief.dimensions[0]?.id).toBe(dimensionBefore.id);
    expect(renamedDimension.brief.dimensions[0]?.name).toBe("核心思想与任务适配");
    expect(renamedDimension.brief.dimensions[0]?.question).toBe(dimensionBefore.question);
    h.close();
  });

  it("refuses an id that belongs to no object on this brief", () => {
    const h = open();
    const result = h.service.patchBrief(h.taskId, {
      patch: { subjects: [{ id: "sub_999999999999", name: "凭空对象" }] },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.join("；")).toContain("未知的比较对象 id");
    expect(h.brief().subjects).toHaveLength(2);
    h.close();
  });
});

// -------------------------------------------------------------------------- D --

describe("D. an incomplete draft is readable but not startable", () => {
  it("accepts a partial edit, reports what it owes, and refuses to confirm it", () => {
    const h = open();

    const emptied = patched(h, { purpose: "", subjects: [] });
    expect(emptied.brief.validation.valid).toBe(false);
    expect(emptied.brief.validation.problems.join("；")).toContain("purpose");
    expect(emptied.brief.validation.problems.join("；")).toContain("比较对象至少需要");

    const refused = h.service.confirmTask(h.taskId);
    expect(refused.ok).toBe(false);
    expect(h.task().confirmedAt).toBeNull();
    expect(h.task().status).toBe("draft");

    // The draft is still editable, so nobody is left holding a broken card.
    patched(h, { purpose: CARD.purpose });
    patched(h, { subjects: [{ name: "GraphRAG" }, { name: "LightRAG" }] });
    expect(h.brief().validation.valid).toBe(true);
    expect(h.service.confirmTask(h.taskId).ok).toBe(true);
    h.close();
  });

  it("keeps the blueprint's comparison floor: the dimensions cannot be edited away", () => {
    const h = open();
    const short = h.brief().dimensions.slice(0, 2);
    const reduced = patched(h, {
      dimensions: short.map((dimension) => ({ id: dimension.id, name: dimension.name, question: dimension.question })),
    });
    expect(reduced.brief.validation.valid).toBe(false);
    expect(reduced.brief.validation.problems.join("；")).toContain("最低比较义务");
    expect(h.service.confirmTask(h.taskId).ok).toBe(false);
    h.close();
  });

  it("refuses to confirm a dimension whose question is empty", () => {
    const h = open();
    const result = patched(h, {
      dimensions: h.brief().dimensions.map((dimension, index) => (index === 0 ? { ...dimension, question: "" } : dimension)),
    });
    expect(result.brief.validation.problems.join("；")).toContain("要回答的问题");
    expect(h.service.confirmTask(h.taskId).ok).toBe(false);
    h.close();
  });
});

// --------------------------------------------------------------------- E + M --

describe("E/M. confirming uses the latest draft and projects it into the matrix", () => {
  it("confirms the edited brief, not the original proposal", () => {
    const h = open();
    patched(h, { audience: "研究生组会", purpose: "为技术选型提供依据" });

    const confirmed = h.service.confirmTask(h.taskId);
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.task.audience).toBe("研究生组会");
    expect(confirmed.task.purpose).toBe("为技术选型提供依据");
    expect(h.brief().readonly).toBe(true);
    expect(h.brief().validation.valid).toBe(true);
    h.close();
  });

  it("rebuilds the matrix to exactly the confirmed subjects and dimensions", () => {
    const h = open();
    const before = h.brief();
    const [first, second] = before.subjects;
    const [d0, d1, d2] = before.dimensions;
    if (first === undefined || second === undefined || d0 === undefined || d1 === undefined || d2 === undefined) {
      throw new Error("expected a full card");
    }

    // One subject added, one dimension deleted and another added: together they
    // decide both the rows and the columns of the matrix.
    patched(h, {
      subjects: [{ id: first.id, name: "GraphRAG" }, { id: second.id, name: "LightRAG" }, { name: "传统 RAG" }],
      dimensions: [
        { id: d0.id, name: d0.name, question: d0.question },
        { id: d2.id, name: d2.name, question: d2.question },
        { name: "部署与更新成本", question: "部署与增量更新分别需要什么条件，成本如何随规模变化" },
      ],
    });

    const confirmed = h.service.confirmTask(h.taskId);
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    // Nothing to reconcile: a structural edit already kept the matrix equal to
    // the brief, which is why the workspace never shows a phantom row.
    expect(confirmed.matrixRebuilt).toBe(false);

    const task = h.task();
    const expectedSubjects = task.subjects.map((subject) => subject.id);
    const expectedDimensions = task.dimensions.map((dimension) => dimension.id);
    expect(expectedSubjects).toHaveLength(3);
    expect(expectedDimensions).toHaveLength(3);

    // No stale cells: every cell is a real pair of the final brief, each pair
    // appears once, and the deleted dimension has no cell left anywhere.
    expect(task.matrix).toHaveLength(9);
    const seen = new Set<string>();
    for (const cell of task.matrix) {
      expect(expectedSubjects).toContain(cell.subjectId);
      expect(expectedDimensions).toContain(cell.dimensionId);
      seen.add(`${cell.subjectId}|${cell.dimensionId}`);
    }
    expect(seen.size).toBe(9);
    expect(task.matrix.some((cell) => cell.dimensionId === d1.id)).toBe(false);
    h.close();
  });

  it("reconciles a matrix that does not match the brief, and drops the stale cells", () => {
    const h = open();
    const card = h.task();
    const [first] = card.subjects;
    if (first === undefined) throw new Error("expected a subject");
    // A record whose matrix is not this brief's projection — the state
    // confirmation has to be able to repair rather than inherit.
    const stale: ReportTask = {
      ...card,
      id: "task_stalematrix1",
      sessionId: "session_stale_matrix",
      matrix: [
        {
          sectionId: "comparison",
          subjectId: first.id,
          dimensionId: "dim_removed",
          status: "reviewed",
          evidenceIds: [],
          reason: "旧记录里的比较对象",
          gap: "",
          note: "旧笔记",
          updatedAt: NOW,
        },
      ],
    };
    h.repo.createTask(stale);

    const confirmed = h.service.confirmTask(stale.id);
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.matrixRebuilt).toBe(true);

    const after = h.service.getTask(stale.id);
    expect(after?.matrix).toHaveLength(6);
    expect(after?.matrix.some((cell) => cell.dimensionId === "dim_removed")).toBe(false);
    const pairs = new Set(after?.matrix.map((cell) => `${cell.subjectId}|${cell.dimensionId}`));
    expect(pairs.size).toBe(6);
    h.close();
  });

  it("refuses a structural edit once real material exists, instead of orphaning it", () => {
    const h = open();
    const [first, second] = h.brief().subjects;
    if (first === undefined || second === undefined) throw new Error("expected two subjects");
    // A read source is real material, even though the card was never confirmed.
    h.repo.addSource({
      id: "src_aaaaaaaaaaaa",
      taskId: h.taskId,
      title: "fixture",
      authors: [],
      org: "",
      url: "https://example.invalid/paper",
      pdfUrl: null,
      doi: null,
      publishedAt: null,
      venue: "fixture",
      abstract: "",
      discovery: { provider: "fixture", query: "q", queriedAt: NOW, target: null },
      readStatus: "ok",
      readScope: "full_text",
      readAt: NOW,
      readUrl: "https://example.invalid/paper",
      retrievalNote: "",
      failure: null,
      snapshotId: null,
    });

    const result = h.service.patchBrief(h.taskId, { patch: { subjects: [{ id: first.id, name: first.name }] } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.join("；")).toContain("不能再用编辑简报的方式增删对象或维度");
    expect(h.brief().subjects).toHaveLength(2);
    h.close();
  });
});

// --------------------------------------------------------------------- F + G --

describe("F/G. confirmation locks the draft", () => {
  it("refuses structured edits, guided questions and guided answers afterwards", () => {
    const h = open();
    const question = withQuestion(h, purposeQuestion());
    expect(h.service.confirmTask(h.taskId).ok).toBe(true);

    const patchedAfter = h.service.patchBrief(h.taskId, { patch: { audience: "别人" } });
    expect(patchedAfter.ok).toBe(false);
    if (!patchedAfter.ok) expect(patchedAfter.problems.join("；")).toContain("已确认");

    h.asGuide();
    const questioned = h.service.proposeGuideQuestion(h.taskId, purposeQuestion());
    h.service.clearGrant(SESSION);
    expect(questioned.ok).toBe(false);

    const answeredAfter = h.service.answerGuideQuestion(h.taskId, { questionId: question.id, optionIds: ["opt_2"] });
    expect(answeredAfter.ok).toBe(false);
    expect(h.brief().audience).toBe("工程师");
    expect(h.brief().readonly).toBe(true);
    h.close();
  });

  it("normalises every field state to confirmed once the card is confirmed", () => {
    const h = open();
    patched(h, { audience: "研究生组会" });
    expect(h.brief().fieldStates.audience).toBe("edited");

    expect(h.service.confirmTask(h.taskId).ok).toBe(true);
    const brief = h.brief();
    expect(brief.readonly).toBe(true);
    expect(brief.confirmed).toBe(true);
    expect(Object.values(brief.fieldStates).every((state) => state === "confirmed")).toBe(true);
    h.close();
  });
});

// --------------------------------------------------------------------- H + I --

describe("H. Guided Mode asks one question at a time", () => {
  it("keeps one active question and retires it when a new one is written", () => {
    const h = open();
    const first = withQuestion(h, purposeQuestion());
    expect(h.service.activeGuideQuestion(h.taskId)?.id).toBe(first.id);
    expect(first.options.length).toBeGreaterThanOrEqual(2);
    expect(first.options.length).toBeLessThanOrEqual(5);
    expect(first.options.every((option) => option.label.length > 0)).toBe(true);
    expect(first.options.every((option) => Object.keys(option.value).length > 0)).toBe(true);
    expect(first.allowFreeText).toBe(true);
    expect(first.basedOnBriefVersion).toBe(1);
    expect(first.fieldTargets).toEqual(["purpose"]);

    const second = withQuestion(h, purposeQuestion({ question: "换个说法：这次研究要达成什么？" }));
    expect(h.service.activeGuideQuestion(h.taskId)?.id).toBe(second.id);
    expect(h.service.guideQuestionsOf(h.taskId).map((question) => question.status)).toEqual(["superseded", "active"]);
    h.close();
  });

  it("refuses a question that drifts off the field the program chose", () => {
    const h = open();
    h.asGuide();
    const drifted = h.service.proposeGuideQuestion(h.taskId, purposeQuestion({ fieldTargets: ["audience"] }));
    h.service.clearGrant(SESSION);
    expect(drifted.ok).toBe(false);
    if (drifted.ok) return;
    expect(drifted.problems.join("；")).toContain("fieldTargets 必须正好是");

    expect(h.service.activeGuideQuestion(h.taskId)).toBeUndefined();
    expect(h.brief().version).toBe(1);
    h.close();
  });

  it("refuses options that are not real patches for the targeted field", () => {
    const h = open();
    const outside = withQuestion_(
      h,
      purposeQuestion({
        options: [
          { label: "改读者", value: { audience: "研究生" } },
          { label: "改维度", value: { dimensions: [{ id: "dim_999999999999", name: "x", question: "y" }] } },
        ],
      }),
    );
    expect(outside.ok).toBe(false);
    if (outside.ok) return;
    expect(outside.problems.join("；")).toContain("value 只能包含字段 purpose");

    const missing = withQuestion_(
      h,
      purposeQuestion({ options: [{ label: "没有取值" }, { label: "也没有" }] }),
    );
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.problems.join("；")).toContain("value 必须是该字段的取值 patch");
    expect(h.brief().version).toBe(1);
    h.close();
  });

  it("accepts a declaration that nothing further is worth asking", () => {
    const h = open();
    h.asGuide();
    const done = h.service.proposeGuideQuestion(h.taskId, { complete: true, reason: "默认方案已经足够具体" });
    h.service.clearGrant(SESSION);
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.complete).toBe(true);
    expect(h.service.activeGuideQuestion(h.taskId)).toBeUndefined();
    expect(h.brief().guide.complete).toBe(true);
    expect(h.brief().guide.reason).toBe("默认方案已经足够具体");

    // And a completion without a reason is not a decision anyone can read.
    h.close();
  });

  it("requires a reason when the guide declares itself complete", () => {
    const h = open();
    h.asGuide();
    const done = h.service.proposeGuideQuestion(h.taskId, { complete: true });
    h.service.clearGrant(SESSION);
    expect(done.ok).toBe(false);
    if (done.ok) return;
    expect(done.problems.join("；")).toContain("必须给出 reason");
    expect(h.brief().guide.complete).toBe(false);
    h.close();
  });
});

/** Calls the service's question writer and returns the raw result. */
function withQuestion_(h: Harness, input: unknown): { readonly ok: boolean; readonly problems: readonly string[] } {
  h.asGuide();
  const result = h.service.proposeGuideQuestion(h.taskId, input);
  h.service.clearGrant(SESSION);
  return result.ok ? { ok: true, problems: [] } : { ok: false, problems: result.problems };
}

describe("I. a guided answer writes the same draft, through the same rules", () => {
  it("applies the chosen option's patch to the targeted field and to nothing else", () => {
    const h = open();
    const before = h.brief();
    const question = withQuestion(h, purposeQuestion());

    const result = answered(h, { questionId: question.id, optionIds: ["opt_2"] });

    expect(result.appliedFields).toEqual(["purpose"]);
    expect(result.brief.purpose).toBe("为技术选型提供依据：在长文档问答场景比较工程成本与效果");
    expect(result.brief.version).toBe(before.version + 1);
    expect(result.brief.fieldStates.purpose).toBe("confirmed");
    expect(result.brief.fieldStates.audience).toBe("suggested");
    expect(result.brief.audience).toBe(before.audience);
    expect(result.brief.subjects).toEqual(before.subjects);
    expect(result.brief.dimensions).toEqual(before.dimensions);

    // The decision is part of the record, so a refresh can say what was decided.
    const decisions = h.brief().guide.decisions;
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.questionId).toBe(question.id);
    expect(decisions[0]?.optionIds).toEqual(["opt_2"]);
    expect(decisions[0]?.appliedFields).toEqual(["purpose"]);
    expect(decisions[0]?.resultingBriefVersion).toBe(result.brief.version);
    h.close();
  });

  it("turns free text into a patch by the field's own rule", () => {
    const h = open();
    const question = withQuestion(h, purposeQuestion());
    const result = answered(h, {
      questionId: question.id,
      freeText: "给组里的同学讲清楚三类方法在长文档问答上的取舍",
    });
    expect(result.brief.purpose).toBe("给组里的同学讲清楚三类方法在长文档问答上的取舍");
    expect(result.brief.fieldStates.purpose).toBe("confirmed");
    h.close();
  });

  it("parses a structural free-text answer into real rows, keeping the ids it names", () => {
    const h = open();
    // Decide purpose so the ladder moves on to the audience, then subjects.
    const purpose = withQuestion(h, purposeQuestion());
    answered(h, { questionId: purpose.id, optionIds: ["opt_1"] });
    const audience = withQuestion(h, purposeQuestion({ fieldTargets: ["audience"], options: optionsFor("audience", h.brief()) }));
    answered(h, { questionId: audience.id, optionIds: ["opt_1"] });
    expect(h.service.guideTargetOf(h.taskId).target?.field).toBe("subjects");

    const subjects = withQuestion(h, purposeQuestion({ fieldTargets: ["subjects"], options: optionsFor("subjects", h.brief()) }));
    const before = h.brief().subjects.map((subject) => subject.id);
    const result = answered(h, {
      questionId: subjects.id,
      freeText: "GraphRAG\nLightRAG\n传统 RAG | 基于关键词与向量检索的基线",
    });
    expect(result.appliedFields).toEqual(["subjects"]);
    expect(result.brief.subjects.map((subject) => subject.name)).toEqual(["GraphRAG", "LightRAG", "传统 RAG"]);
    expect(result.brief.subjects.slice(0, 2).map((subject) => subject.id)).toEqual(before);
    expect(result.brief.subjects[2]?.note).toBe("基于关键词与向量检索的基线");
    // The matrix followed the same draft.
    expect(h.task().matrix).toHaveLength(3 * 3);
    h.close();
  });

  it("refuses an answer that names no option and no text, or an option that is not there", () => {
    const h = open();
    const question = withQuestion(h, purposeQuestion());
    expect(h.service.answerGuideQuestion(h.taskId, { questionId: question.id }).ok).toBe(false);
    const unknown = h.service.answerGuideQuestion(h.taskId, { questionId: question.id, optionIds: ["opt_9"] });
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.problems.join("；")).toContain("没有这个选项");
    expect(h.brief().version).toBe(1);
    h.close();
  });

  it("refuses to answer the same question twice", () => {
    const h = open();
    const question = withQuestion(h, purposeQuestion());
    expect(h.service.answerGuideQuestion(h.taskId, { questionId: question.id, optionIds: ["opt_1"] }).ok).toBe(true);
    const again = h.service.answerGuideQuestion(h.taskId, { questionId: question.id, optionIds: ["opt_3"] });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.problems.join("；")).toContain("已经回答过");
    h.close();
  });
});

// -------------------------------------------------------------------------- J --

describe("J. a question written against an older brief cannot overwrite a newer one", () => {
  it("rejects the answer as stale when the version moved", () => {
    const h = open();
    const question = withQuestion(h, purposeQuestion());
    // The user goes back to the structured editor and changes something else.
    patched(h, { audience: "研究生组会" });

    const stale = h.service.answerGuideQuestion(h.taskId, {
      questionId: question.id,
      expectedVersion: question.basedOnBriefVersion,
      optionIds: ["opt_2"],
    });
    expect(stale.ok).toBe(false);
    if (stale.ok || !("stale" in stale)) throw new Error("expected a stale conflict");
    expect(stale.stale).toBe(true);
    expect(stale.brief.audience).toBe("研究生组会");
    expect(stale.brief.purpose).toBe(CARD.purpose);
    h.close();
  });

  it("rejects the answer as stale when its own target was edited, even without a version", () => {
    const h = open();
    const question = withQuestion(h, purposeQuestion());
    patched(h, { purpose: "换成结构化编辑写下的研究问题" });

    const stale = h.service.answerGuideQuestion(h.taskId, { questionId: question.id, optionIds: ["opt_2"] });
    expect(stale.ok).toBe(false);
    if (stale.ok || !("stale" in stale)) throw new Error("expected a stale conflict");
    expect(stale.stale).toBe(true);
    expect(stale.brief.purpose).toBe("换成结构化编辑写下的研究问题");

    // The old question is retired rather than left looking answerable.
    expect(h.service.activeGuideQuestion(h.taskId)).toBeUndefined();
    expect(h.service.guideQuestionsOf(h.taskId)[0]?.status).toBe("superseded");
    h.close();
  });

  it("refuses an answer once the brief is confirmed", () => {
    const h = open();
    const question = withQuestion(h, purposeQuestion());
    expect(h.service.confirmTask(h.taskId).ok).toBe(true);
    expect(h.service.answerGuideQuestion(h.taskId, { questionId: question.id, optionIds: ["opt_2"] }).ok).toBe(false);
    h.close();
  });
});

// -------------------------------------------------------------------------- K --

describe("K. Guided Mode reads the latest draft and never re-asks a decided field", () => {
  it("moves past every field the user already decided", () => {
    const h = open();
    const fresh = h.service.guideTargetOf(h.taskId);
    expect(fresh.complete).toBe(false);
    expect(fresh.target?.field).toBe("purpose");
    expect(fresh.target?.currentValue).toBe(CARD.purpose);

    // Structured edits settle purpose, audience, subjects and dimensions.
    patched(h, { purpose: "为技术选型提供依据" });
    patched(h, { audience: "研究生组会" });
    const [first, second] = h.brief().subjects;
    if (first === undefined || second === undefined) throw new Error("expected subjects");
    patched(h, {
      subjects: [{ id: first.id, name: "GraphRAG" }, { id: second.id, name: "LightRAG" }, { name: "传统 RAG" }],
    });
    patched(h, {
      dimensions: h.brief().dimensions.map((dimension) => ({ id: dimension.id, name: dimension.name, question: dimension.question })),
    });

    // The next decision is the first field nobody decided: the fields the user
    // settled are behind it, so "你是不是工程师" is never asked again.
    const next = h.service.guideTargetOf(h.taskId);
    expect(next.complete).toBe(false);
    expect(next.target?.field).toBe("focus");
    expect(next.target?.currentValue).toBe("机制差异");
    const states = h.brief().fieldStates;
    expect(states.purpose).toBe("edited");
    expect(states.audience).toBe("edited");
    expect(states.subjects).toBe("edited");
    expect(states.dimensions).toBe("edited");
    expect(states.focus).toBe("suggested");
    h.close();
  });

  it("stops after the decision budget instead of becoming a wizard", () => {
    const h = open();
    const answeredFields: BriefFieldName[] = [];
    for (let step = 0; step < 5; step += 1) {
      const target = h.service.guideTargetOf(h.taskId);
      expect(target.complete).toBe(false);
      const field = target.target?.field;
      if (field === undefined) throw new Error("expected a target");
      const question = withQuestion(h, purposeQuestion({ fieldTargets: [field], options: optionsFor(field, h.brief()) }));
      answered(h, { questionId: question.id, optionIds: ["opt_2"] });
      answeredFields.push(field);
    }
    expect(answeredFields).toEqual(["purpose", "audience", "subjects", "dimensions", "focus"]);

    const after = h.service.guideTargetOf(h.taskId);
    expect(after.complete).toBe(true);
    expect(after.answered).toBe(5);
    expect(after.reason).toContain("上限");
    h.close();
  });
});

// -------------------------------------------------------------------------- L --

describe("L. the brief is one object, whichever way it was written", () => {
  it("shows a structured edit made after a guided answer, and vice versa", () => {
    const h = open();
    const question = withQuestion(h, purposeQuestion());
    answered(h, { questionId: question.id, optionIds: ["opt_2"] });
    patched(h, { focus: ["动态更新"] });

    const brief = h.brief();
    expect(brief.purpose).toBe("为技术选型提供依据：在长文档问答场景比较工程成本与效果");
    expect(brief.focus).toEqual(["动态更新"]);
    expect(brief.fieldStates.purpose).toBe("confirmed");
    expect(brief.fieldStates.focus).toBe("edited");
    expect(brief.version).toBe(3);

    // A question written now is written against this version, not the first one.
    const next = h.service.guideTargetOf(h.taskId);
    expect(next.target?.field).toBe("audience");
    const second = withQuestion(h, purposeQuestion({ fieldTargets: ["audience"], options: optionsFor("audience", brief) }));
    expect(second.basedOnBriefVersion).toBe(brief.version);

    // A guided answer on top of that is visible to the structured view at once.
    const after = answered(h, { questionId: second.id, optionIds: ["opt_2"] });
    expect(after.brief.audience).toBe("工程团队");
    expect(h.brief().audience).toBe("工程团队");
    expect(h.brief().purpose).toBe(brief.purpose);
    h.close();
  });
});

// -------------------------------------------------------------------------- N --

describe("N. projects that predate the brief stay readable and frozen", () => {
  function legacy(confirmed: boolean): ReportTask {
    return {
      id: `task_${confirmed ? "confirmed" : "draft"}legacy1`,
      sessionId: `session_legacy_${confirmed}`,
      topic: "GraphRAG 与 PageRank 的历史项目",
      purpose: "组会汇报",
      audience: "研究生",
      focus: [],
      exclusions: "",
      language: "zh",
      lengthTarget: "约 4 页",
      status: confirmed ? "ready" : "draft",
      confirmedAt: confirmed ? NOW : null,
      structure: {
        sections: [
          { id: "overview", title: "研究问题与关键认识", question: "研究什么" },
          { id: "comparison", title: "条件化比较", question: "如何比较" },
          { id: "limitations", title: "局限与未知", question: "缺什么" },
        ],
      },
      subjects: [
        { id: "sub_graphrag", name: "GraphRAG" },
        { id: "sub_pagerank", name: "PageRank" },
      ],
      dimensions: [
        { id: "dim_core", name: "核心思想", question: "解决什么问题" },
        { id: "dim_retrieval", name: "检索机制", question: "如何检索" },
        { id: "dim_cost", name: "成本", question: "成本如何" },
      ],
      matrix: [
        {
          sectionId: "comparison",
          subjectId: "sub_graphrag",
          dimensionId: "dim_core",
          status: "missing",
          evidenceIds: [],
          reason: "",
          gap: "",
          note: "",
          updatedAt: NOW,
        },
      ],
      budget: { maxSearches: 6, maxCandidatesPerSearch: 5, maxReads: 10, maxGapRounds: 2, deadlineMs: 480_000 },
      usage: { searches: 1, reads: 1, gapRounds: 0 },
      currentReportId: null,
      reportDraft: null,
      createdAt: NOW,
      updatedAt: NOW,
      error: null,
    };
  }

  it("reads an old confirmed project without re-opening it as a draft", () => {
    const h = open();
    const task = legacy(true);
    h.repo.createTask(task);
    h.repo.bindSession(task.sessionId, task.id);

    const brief = h.service.briefOf(task.id);
    expect(brief.readonly).toBe(true);
    expect(brief.version).toBe(1);
    expect(brief.subjects.map((subject) => subject.name)).toEqual(["GraphRAG", "PageRank"]);
    expect(Object.values(brief.fieldStates).every((state) => state === "confirmed")).toBe(true);

    expect(h.service.patchBrief(task.id, { patch: { audience: "别人" } }).ok).toBe(false);
    expect(h.service.guideTargetOf(task.id).complete).toBe(true);
    expect(h.service.confirmTask(task.id).ok).toBe(true);
    expect(h.service.getTask(task.id)?.confirmedAt).toBe(NOW);
    h.close();
  });

  it("reads an old unconfirmed task as suggested and lets it be edited", () => {
    const h = open();
    const task = legacy(false);
    h.repo.createTask(task);
    h.repo.bindSession(task.sessionId, task.id);

    const brief = h.service.briefOf(task.id);
    expect(brief.readonly).toBe(false);
    expect(Object.values(brief.fieldStates).every((state) => state === "suggested")).toBe(true);
    // Nothing invents a decision the user never made.
    expect(brief.guide.decisions).toEqual([]);

    expect(h.service.patchBrief(task.id, { patch: { audience: "研究生组会" } }).ok).toBe(true);
    expect(h.service.briefOf(task.id).version).toBe(2);
    h.close();
  });
});
