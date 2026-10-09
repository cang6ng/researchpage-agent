/**
 * The truth rules of the product, at the smallest scale they are decided.
 *
 * Three things are pinned here because everything else depends on them: what a
 * cell's coverage is derived from (scope, never a model's opinion), that an
 * evidence excerpt is a real substring of the saved text (and a tampered one is
 * not), and that a report citing evidence which does not exist cannot be saved.
 * The last one is the negative case the demo could never survive losing.
 */

import { describe, expect, it } from "vitest";

import type { CellRef, Evidence, Report, ReportTask, Source } from "../src/domain.js";
import { DEFAULT_BUDGET, deriveCellCoverage, emptyUsage } from "../src/domain.js";
import { draftEvidence, verifyEvidenceText } from "../src/evidence.js";
import { validateReport } from "../src/report.js";
import { buildMatrix, STRUCTURE_SECTIONS } from "../src/structure.js";

const cell: CellRef = { sectionId: "comparison", subjectId: "sub_a", dimensionId: "dim_core" };
const other: CellRef = { sectionId: "comparison", subjectId: "sub_b", dimensionId: "dim_core" };

function evidenceAt(input: { readonly id: string; readonly scope: Evidence["readScope"]; readonly cells: readonly CellRef[] }): Evidence {
  return {
    id: input.id,
    taskId: "task_1",
    sourceId: "src_1",
    readId: "read_1",
    excerpt: "一段真实片段",
    locator: { paragraphIndex: 0, headingPath: [], charStart: 0, charEnd: 6 },
    readScope: input.scope,
    cells: input.cells,
    pickedBecause: "test",
    createdAt: "2026-10-05T00:00:00Z",
  };
}

describe("coverage derivation", () => {
  it("is missing when nothing is bound to the cell", () => {
    const verdict = deriveCellCoverage(cell, []);
    expect(verdict.status).toBe("missing");
    expect(verdict.evidenceIds).toEqual([]);
  });

  it("ignores metadata and evidence bound to another cell", () => {
    const verdict = deriveCellCoverage(cell, [
      evidenceAt({ id: "ev_meta", scope: "metadata", cells: [cell] }),
      evidenceAt({ id: "ev_other", scope: "full_text", cells: [other] }),
    ]);
    expect(verdict.status).toBe("missing");
    expect(verdict.evidenceIds).toEqual([]);
  });

  it("does not call a body passage an answer: material without a judgement is unassessed", () => {
    const verdict = deriveCellCoverage(cell, [evidenceAt({ id: "ev_body", scope: "body_excerpt", cells: [cell] })]);
    expect(verdict.status).toBe("unassessed");
    expect(verdict.evidenceIds).toEqual(["ev_body"]);
    expect(verdict.gap.length).toBeGreaterThan(0);
  });

  it("does not call an abstract an answer either", () => {
    const verdict = deriveCellCoverage(cell, [evidenceAt({ id: "ev_abs", scope: "abstract", cells: [cell] })]);
    expect(verdict.status).toBe("unassessed");
  });

  it("becomes limited when the judgement is indirect or only contextual", () => {
    const indirect = deriveCellCoverage(
      cell,
      [evidenceAt({ id: "ev_body", scope: "full_text", cells: [cell] })],
      [{ target: cell, evidenceIds: ["ev_body"], relationship: "supports", directness: "indirect" }],
    );
    expect(indirect.status).toBe("limited");
    expect(indirect.reason).toContain("间接");

    const unjudged = deriveCellCoverage(
      cell,
      [evidenceAt({ id: "ev_body", scope: "full_text", cells: [cell] })],
      [{ target: cell, evidenceIds: ["ev_body"], relationship: "supports", directness: "unassessed" }],
    );
    expect(unjudged.status).toBe("limited");
  });

  it("stays limited when only an abstract was judged", () => {
    const verdict = deriveCellCoverage(
      cell,
      [evidenceAt({ id: "ev_abs", scope: "abstract", cells: [cell] })],
      [{ target: cell, evidenceIds: ["ev_abs"], relationship: "supports", directness: "direct" }],
    );
    expect(verdict.status).toBe("limited");
    expect(verdict.reason).toContain("摘要");
  });

  it("is reviewed only for a direct, supportive judgement about body text", () => {
    const verdict = deriveCellCoverage(
      cell,
      [evidenceAt({ id: "ev_body", scope: "body_excerpt", cells: [cell] })],
      [{ target: cell, evidenceIds: ["ev_body"], relationship: "supports", directness: "direct" }],
    );
    expect(verdict.status).toBe("reviewed");
    expect(verdict.evidenceIds).toEqual(["ev_body"]);
  });

  it("reports a contradiction as conflict rather than averaging it away", () => {
    const verdict = deriveCellCoverage(
      cell,
      [evidenceAt({ id: "ev_body", scope: "full_text", cells: [cell] })],
      [
        { target: cell, evidenceIds: ["ev_body"], relationship: "supports", directness: "direct" },
        { target: cell, evidenceIds: ["ev_body"], relationship: "contradicts", directness: "direct" },
      ],
    );
    expect(verdict.status).toBe("conflict");
    expect(verdict.gap.length).toBeGreaterThan(0);
  });

  it("ignores a judgement that names evidence belonging to another cell", () => {
    const verdict = deriveCellCoverage(
      cell,
      [evidenceAt({ id: "ev_body", scope: "full_text", cells: [cell] })],
      [{ target: cell, evidenceIds: ["ev_somewhere_else"], relationship: "supports", directness: "direct" }],
    );
    expect(verdict.status).toBe("unassessed");
  });
});

describe("evidence text", () => {
  it("verifies a real excerpt and rejects a tampered one", () => {
    const text = "GraphRAG builds a knowledge graph and summarises its communities for global questions.";
    const evidence = draftEvidence({
      taskId: "task_1",
      sourceId: "src_1",
      readId: "read_1",
      readScope: "full_text",
      draft: {
        paragraph: { index: 0, headingPath: ["1 Introduction"], text, charStart: 0, charEnd: text.length },
        cells: [],
        pickedBecause: "test",
      },
      now: "2026-10-05T00:00:00Z",
    });
    expect(verifyEvidenceText(evidence, text).ok).toBe(true);
    expect(verifyEvidenceText({ ...evidence, excerpt: `${text} 编造` }, text).ok).toBe(false);
    expect(verifyEvidenceText({ ...evidence, locator: { ...evidence.locator, charStart: 1 } }, text).ok).toBe(false);
  });
});

function taskFixture(): ReportTask {
  const matrix = buildMatrix(
    [
      { id: "sub_a", name: "A" },
      { id: "sub_b", name: "B" },
    ],
    [{ id: "dim_core", name: "核心思想", question: "是什么" }],
    "2026-10-05T00:00:00Z",
  );
  return {
    id: "task_1",
    sessionId: "session_1",
    topic: "主题",
    purpose: "",
    audience: "",
    focus: [],
    exclusions: "",
    language: "zh",
    lengthTarget: "",
    status: "researching",
    confirmedAt: "2026-10-05T00:00:00Z",
    structure: { sections: STRUCTURE_SECTIONS.map(({ required: _required, ...section }) => section) },
    subjects: [
      { id: "sub_a", name: "A" },
      { id: "sub_b", name: "B" },
    ],
    dimensions: [{ id: "dim_core", name: "核心思想", question: "是什么" }],
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

function sourceFixture(): Source {
  return {
    id: "src_1",
    taskId: "task_1",
    title: "A paper",
    authors: [],
    org: "",
    url: "https://arxiv.org/abs/2401.00001",
    pdfUrl: null,
    doi: null,
    publishedAt: null,
    venue: "arXiv",
    abstract: "",
    discovery: { provider: "arxiv", query: "q", queriedAt: "2026-10-05T00:00:00Z", target: null },
    readStatus: "ok",
    readScope: "full_text",
    readAt: "2026-10-05T00:00:00Z",
    readUrl: "https://arxiv.org/html/2401.00001",
    retrievalNote: "",
    failure: null,
    snapshotId: "read_1",
  };
}

function draftWith(evidenceIds: readonly string[]) {
  return {
    title: "报告",
    summary: "摘要",
    claims: [{ id: "clm_1", text: "一个论断", evidenceIds, kind: "fact" as const }],
    sections: [
      { id: "overview", title: "一", blocks: [{ kind: "paragraph" as const, text: "内容", claimIds: ["clm_1"] }] },
      { id: "representative", title: "三", blocks: [{ kind: "paragraph" as const, text: "内容", claimIds: ["clm_1"] }] },
      { id: "comparison", title: "四", blocks: [{ kind: "paragraph" as const, text: "内容", claimIds: ["clm_1"] }] },
      { id: "limitations", title: "五", blocks: [{ kind: "paragraph" as const, text: "内容", claimIds: ["clm_1"] }] },
    ],
  };
}

describe("report validation", () => {
  const text = "GraphRAG builds a knowledge graph.";
  const valid: Evidence = {
    id: "ev_1",
    taskId: "task_1",
    sourceId: "src_1",
    readId: "read_1",
    excerpt: text,
    locator: { paragraphIndex: 0, headingPath: [], charStart: 0, charEnd: text.length },
    readScope: "full_text",
    cells: [],
    pickedBecause: "test",
    createdAt: "2026-10-05T00:00:00Z",
  };
  const input = {
    task: taskFixture(),
    sources: [sourceFixture()],
    snapshotText: (readId: string) => (readId === "read_1" ? text : undefined),
    now: "2026-10-05T00:00:00Z",
  };

  it("accepts a report whose claims cite real, verified evidence", () => {
    const result = validateReport({ ...input, draft: draftWith(["ev_1"]), evidence: [valid] });
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("refuses a claim citing evidence that does not exist", () => {
    const result = validateReport({ ...input, draft: draftWith(["ev_missing"]), evidence: [valid] });
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain("ev_missing");
  });

  it("refuses a claim citing another task's evidence", () => {
    const foreign: Evidence = { ...valid, id: "ev_foreign", taskId: "task_other" };
    const result = validateReport({ ...input, draft: draftWith(["ev_foreign"]), evidence: [foreign] });
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain("其他任务");
  });

  it("refuses an excerpt that no longer matches the saved read", () => {
    const edited: Evidence = { ...valid, excerpt: "GraphRAG builds a knowledge graph. 补充的话" };
    const result = validateReport({ ...input, draft: draftWith(["ev_1"]), evidence: [edited] });
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain("不一致");
  });

  it("refuses a claim with no evidence at all", () => {
    const result = validateReport({ ...input, draft: draftWith([]), evidence: [valid] });
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain("没有任何 evidence");
  });

  it("refuses a report missing a required section", () => {
    const draft = draftWith(["ev_1"]);
    const result = validateReport({
      ...input,
      draft: { ...draft, sections: draft.sections.filter((section) => section.id !== "comparison") },
      evidence: [valid],
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain("comparison");
  });

  it("refuses a block that references a claim which does not exist", () => {
    const draft = draftWith(["ev_1"]);
    const result = validateReport({
      ...input,
      draft: {
        ...draft,
        sections: draft.sections.map((section, index) =>
          index === 0
            ? { ...section, blocks: [{ kind: "paragraph" as const, text: "内容", claimIds: ["clm_missing"] }] }
            : section,
        ),
      },
      evidence: [valid],
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain("clm_missing");
  });

  it("refuses a claim that refuses a ranking and still cites nothing", () => {
    // The ranking lexicon decides whether a sentence *asserts* a ranking; it is
    // not a way past the truth boundary. A sentence that refuses one is still a
    // claim, and a claim still needs evidence that resolves.
    const draft = draftWith(["ev_missing"]);
    const result = validateReport({
      ...input,
      draft: {
        ...draft,
        claims: draft.claims.map((claim) => ({ ...claim, text: "不能合成一个更便宜的判断。" })),
      },
      evidence: [valid],
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain("ev_missing");
  });
});
