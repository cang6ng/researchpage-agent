/**
 * The Brief page's own logic, tested as logic.
 *
 * What a browser gate proves is that a reader can change a brief; what it
 * cannot show is *why* a refused confirm pointed at the field it did, or why a
 * rename kept the object's identity. These cases cover the rules the page
 * leans on: a server problem is placed beside the field it is about, a list of
 * rows becomes a patch that keeps the ids the server minted, and a guided
 * decision is repeated back in the reader's own words.
 */

import { describe, expect, it } from "vitest";

import type { BriefView } from "../src/browser/api.js";
import {
  addFocus,
  confirmSummary,
  decisionLabel,
  dimensionsCommittable,
  dimensionsPatch,
  firstProblemField,
  moved,
  problemFieldOf,
  problemsByField,
  removeFocus,
  sameDimensions,
  sameSubjects,
  subjectRowsOf,
  subjectsCommittable,
  subjectsPatch,
} from "../src/browser/brief-logic.js";

function briefFixture(overrides: Partial<BriefView> = {}): BriefView {
  return {
    taskId: "task_1",
    confirmed: false,
    readonly: false,
    version: 3,
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
    topic: "主题",
    question: "问题",
    purpose: "问题",
    audience: "读者",
    focus: ["成本口径"],
    exclusions: "不研究多模态",
    lengthTarget: "约 4 页",
    subjects: [
      { id: "sub_a", name: "GraphRAG", note: "图增强" },
      { id: "sub_b", name: "LightRAG", note: "" },
    ],
    dimensions: [
      { id: "dim_1", name: "成本", question: "成本从哪里来？" },
      { id: "dim_2", name: "效果", question: "效果如何评测？" },
      { id: "dim_3", name: "更新", question: "增量更新怎么做？" },
    ],
    reportStructure: [],
    editableFields: [],
    fieldStates: {
      topic: "suggested",
      purpose: "suggested",
      audience: "suggested",
      subjects: "suggested",
      dimensions: "suggested",
      focus: "suggested",
      exclusions: "suggested",
      lengthTarget: "suggested",
    },
    validation: { valid: true, problems: [] },
    guide: { complete: false, reason: "", limit: 5, decisions: [], active: null },
    matrix: { subjects: 2, dimensions: 3, cells: 6 },
    contentHash: "hash",
    ...overrides,
  };
}

describe("where a refused confirm points", () => {
  it("places each problem beside the field it names", () => {
    expect(problemFieldOf("研究主题（topic）不能为空")).toBe("topic");
    expect(problemFieldOf("研究问题 / 用途（purpose）不能为空")).toBe("purpose");
    expect(problemFieldOf("读者（audience）不能为空")).toBe("audience");
    expect(problemFieldOf("比较对象至少需要 1 个（当前 0 个）")).toBe("subjects");
    expect(problemFieldOf("比较对象名称重复：GraphRAG")).toBe("subjects");
    expect(problemFieldOf("研究维度至少需要 3 个（Technical Comparison v2 的最低比较义务，当前 2 个）")).toBe("dimensions");
    expect(problemFieldOf("每个研究维度都必须写成要回答的问题（question 不能为空）")).toBe("dimensions");
  });

  it("keeps a problem it cannot place about the draft as a whole", () => {
    expect(problemFieldOf("patch 没有包含任何字段")).toBeNull();
    expect(problemFieldOf("不允许通过 Brief 修改的字段：budget")).toBeNull();
  });

  it("groups problems by field, in the order the page shows them", () => {
    const grouped = problemsByField([
      "研究维度至少需要 3 个（当前 2 个）",
      "研究问题 / 用途（purpose）不能为空",
      "比较对象名称不能为空",
      "比较对象至少需要 1 个（当前 1 个）",
      "不允许通过 Brief 修改的字段：status",
    ]);
    expect(grouped.map((entry) => entry.field)).toEqual(["purpose", "subjects", "dimensions", null]);
    expect(grouped[1]?.problems).toHaveLength(2);
    expect(grouped[3]?.problems).toEqual(["不允许通过 Brief 修改的字段：status"]);
  });

  it("names the first field a reader has to fix, so the page can scroll to it", () => {
    expect(firstProblemField(["研究维度至少需要 3 个（当前 2 个）", "研究问题 / 用途（purpose）不能为空"])).toBe("purpose");
    expect(firstProblemField(["不允许通过 Brief 修改的字段：status"])).toBeNull();
    expect(firstProblemField([])).toBeNull();
  });
});

describe("a list of rows becomes a patch", () => {
  it("keeps the id of a row that already exists and mints nothing itself", () => {
    const patch = subjectsPatch([
      { id: "sub_a", name: "GraphRAG（原版）", note: "改名保留材料" },
      { name: "LightRAG", note: "" },
    ]);
    expect(patch.subjects).toEqual([
      { id: "sub_a", name: "GraphRAG（原版）", note: "改名保留材料" },
      { name: "LightRAG" },
    ]);
  });

  it("does the same for dimensions, whose question travels with the name", () => {
    const patch = dimensionsPatch([{ id: "dim_1", name: "成本", question: "成本从哪里来？" }, { name: "新维度", question: "新问题？" }]);
    expect(patch.dimensions).toEqual([
      { id: "dim_1", name: "成本", question: "成本从哪里来？" },
      { name: "新维度", question: "新问题？" },
    ]);
  });

  it("knows when a list is the same one it came from", () => {
    const brief = briefFixture();
    expect(sameSubjects(subjectRowsOf(brief), brief)).toBe(true);
    expect(sameSubjects([...subjectRowsOf(brief), { name: "x", note: "" }], brief)).toBe(false);
    expect(sameSubjects([{ id: "sub_a", name: "改了", note: "图增强" }, { id: "sub_b", name: "LightRAG", note: "" }], brief)).toBe(false);
    expect(sameDimensions(brief.dimensions.map((d) => ({ ...d })), brief)).toBe(true);
    expect(sameDimensions(brief.dimensions.map((d, i) => ({ ...d, name: i === 0 ? "改名" : d.name })), brief)).toBe(false);
  });

  it("holds back a row the reader has not named yet", () => {
    expect(subjectsCommittable([{ name: "写了一部分", note: "" }])).toBe(true);
    expect(subjectsCommittable([{ id: "sub_a", name: "", note: "" }])).toBe(true);
    expect(subjectsCommittable([{ name: "", note: "" }])).toBe(false);
    expect(dimensionsCommittable([{ name: "", question: "" }])).toBe(false);
  });

  it("moves a row without losing what it was", () => {
    const rows = subjectRowsOf(briefFixture());
    expect(moved(rows, 0, 1).map((row) => row.id)).toEqual(["sub_b", "sub_a"]);
    expect(moved(rows, 1, 0).map((row) => row.id)).toEqual(["sub_b", "sub_a"]);
    expect(moved(rows, 0, 9)).toEqual(rows);
    expect(moved(rows, 5, 0)).toEqual(rows);
  });
});

describe("focus is a set of chips", () => {
  it("adds one once, trimmed, and never a blank", () => {
    expect(addFocus(["a"], "  b  ")).toEqual(["a", "b"]);
    expect(addFocus(["a"], "A")).toEqual(["a"]);
    expect(addFocus(["a"], "   ")).toEqual(["a"]);
  });

  it("removes only the one asked for", () => {
    expect(removeFocus(["a", "b"], "a")).toEqual(["b"]);
    expect(removeFocus(["a", "b"], "c")).toEqual(["a", "b"]);
  });
});

describe("a guided decision, said back", () => {
  const question = {
    options: [
      { optionId: "opt_1", label: "选型建议为主" },
      { optionId: "opt_2", label: "证据评估为主" },
    ],
  };

  it("names the option the reader picked", () => {
    expect(decisionLabel(question, ["opt_2"], "")).toBe("证据评估为主");
  });

  it("names a free answer by what was written", () => {
    expect(decisionLabel(question, [], "  给组会用，重点讲机制  ")).toBe("给组会用，重点讲机制");
    expect(decisionLabel(question, [], "  ")).toBe("（空回答）");
  });

  it("truncates a long free answer rather than repeating it whole", () => {
    const long = "一句话".repeat(30);
    const label = decisionLabel(question, [], long);
    expect(label.length).toBeLessThanOrEqual(27);
    expect(label.endsWith("…")).toBe(true);
  });
});

describe("what the reader is about to start", () => {
  it("counts the objects and the questions, and the length only when it is set", () => {
    expect(confirmSummary(briefFixture())).toBe("2 个对象 · 3 个维度 · 约 4 页");
    expect(confirmSummary(briefFixture({ lengthTarget: "  " }))).toBe("2 个对象 · 3 个维度");
  });
});
