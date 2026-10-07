/**
 * Where a project stands, as orthogonal facts.
 *
 * The acceptance found the workspace saying「报告就绪 · 无待查项」next to
 *「10/10 有依据」、「9 处义务未完全达成」and「1 处待复核」. Each sentence was true
 * and the ensemble was not: material coverage, unresolved research, the
 * report's review flag and its content contract are four different questions,
 * and a single status word merges them into one that answers none of them.
 *
 * Two of these tests are the specific wrong statements that were seen:
 * unclassified sources counted as an absence of primary material, and material
 * coverage printed as if it settled the research.
 */

import { describe, expect, it } from "vitest";

import type { ReportTask } from "@every-dagent/plugin-research";
import {
  artifactQualityOf,
  evidenceCoverageOf,
  presentationOf,
  reportReviewOf,
  runStateOf,
  sourceRolesOf,
  unresolvedResearchOf,
} from "../src/server/presentation.js";

function task(overrides: Partial<ReportTask> = {}): ReportTask {
  return {
    id: "task_1",
    sessionId: "sess_1",
    topic: "Microsoft GraphRAG 的语言支持与增量更新",
    purpose: "技术选型",
    audience: "工程团队",
    focus: [],
    exclusions: "",
    language: "zh",
    lengthTarget: "约 4 页",
    status: "ready",
    confirmedAt: "2026-10-06T09:00:00.000Z",
    structure: { sections: [] },
    subjects: [],
    dimensions: [],
    matrix: [],
    budget: { maxSearches: 6, maxCandidatesPerSearch: 5, maxReads: 10, maxGapRounds: 2, deadlineMs: 480_000 },
    usage: { searches: 1, reads: 1, gapRounds: 0 },
    currentReportId: "rep_1",
    reportDraft: null,
    createdAt: "2026-10-06T08:00:00.000Z",
    updatedAt: "2026-10-06T10:00:00.000Z",
    error: null,
    ...overrides,
  };
}

const CELLS = [
  { status: "reviewed" as const },
  { status: "reviewed" as const },
  { status: "limited" as const },
  { status: "unassessed" as const },
  { status: "missing" as const },
  { status: "conflict" as const },
];

describe("source roles: unknown is not zero", () => {
  it("says 未知 when nothing has been classified, instead of 0 primary", () => {
    const roles = sourceRolesOf([{ role: null }, { role: null }, { role: null }]);
    expect(roles.unknown).toBe(3);
    expect(roles.classified).toBe(0);
    expect(roles.primary).toBe(0);
    expect(roles.userMessage).toBe("原始论文 / 一手材料：未知（3 个来源尚未分类）");
    // The wrong statement, in the words the workspace used to print.
    expect(roles.userMessage).not.toContain("0 个");
  });

  it("separates what is confirmed from what is unclassified", () => {
    const roles = sourceRolesOf([{ role: "official" }, { role: "contextual" }, { role: null }, { role: null }]);
    expect(roles.primary).toBe(1);
    expect(roles.unknown).toBe(2);
    expect(roles.userMessage).toBe("原始论文 / 一手材料：1 个已确认；另有 2 个来源尚未分类（已分类 2 / 4）。");
  });

  it("only says zero when every source really was classified", () => {
    const roles = sourceRolesOf([{ role: "survey" }, { role: "contextual" }]);
    expect(roles.primary).toBe(0);
    expect(roles.userMessage).toContain("均已分类");
    expect(roles.userMessage).toContain("原始论文 / 一手材料：0 个");
  });
});

describe("the status fields answer different questions", () => {
  it("keeps material coverage apart from conclusions", () => {
    const coverage = evidenceCoverageOf(CELLS);
    expect(coverage.cells).toBe(6);
    expect(coverage.withMaterial).toBe(5);
    expect(coverage.reviewed).toBe(2);
    expect(coverage.displayName).toBe("5 / 6 个比较项已有材料");
    // Not「无待查项」: having material is not having an answer.
    expect(coverage.userMessage).toContain("材料覆盖不等于结论完成");
  });

  it("counts the unresolved questions in the three states a reader acts on", () => {
    const unresolved = unresolvedResearchOf(CELLS);
    expect(unresolved).toMatchObject({ unresolved: 2, limited: 1, incomparable: 1, resolved: 2 });
    expect(unresolved.userMessage).toContain("2 项还没有可用的依据");
    expect(unresolved.userMessage).toContain("1 项只有有限支持");
  });

  it("reports the report's review flag and its contract separately", () => {
    const flagged = reportReviewOf(
      task({ reportNeedsReview: { at: "2026-10-06T11:00:00.000Z", reason: "补查新增 2 条证据", evidenceIds: ["ev_1"] } }),
    );
    expect(flagged.state).toBe("needs_review");
    expect(flagged.userMessage).toContain("补查新增 2 条证据");
    const clean = reportReviewOf(task());
    expect(clean.state).toBe("clean");
    // "No flag" is not "independently reviewed", and the sentence says so.
    expect(clean.userMessage).toContain("不代表结论已经被独立复核过");

    const warnings = artifactQualityOf({
      ok: true,
      problems: [],
      warnings: ["Q03：claim clm_x（mechanism） 的机制依据没有登记来源角色。"],
      checks: [],
      checkedAt: "2026-10-06T10:00:00.000Z",
    });
    expect(warnings).toMatchObject({ state: "warnings", warnings: 1, blocking: 0 });
    expect(warnings.displayName).toBe("通过，1 处义务未完全达成");
  });

  it("reports all four facts at once for a project with material but no conclusions", () => {
    const readout = presentationOf({
      task: task({ reportNeedsReview: { at: "2026-10-06T11:00:00.000Z", reason: "补查新增 1 条证据", evidenceIds: ["ev_1"] } }),
      cells: CELLS,
      sources: [{ role: null }, { role: null }],
      hasReport: true,
      pendingProposal: false,
      runningStage: null,
      validation: {
        ok: true,
        problems: [],
        warnings: ["Q03：...", "Q09：..."],
        checks: [],
        checkedAt: "2026-10-06T10:00:00.000Z",
      },
    });
    expect(readout.runState.state).toBe("report_ready");
    expect(readout.evidenceCoverage.displayName).toBe("5 / 6 个比较项已有材料");
    expect(readout.unresolvedResearch.displayName).toBe("4 项还没有结论");
    expect(readout.reportReview.state).toBe("needs_review");
    expect(readout.artifactQuality.displayName).toBe("通过，2 处义务未完全达成");
    expect(readout.sourceRoles.userMessage).toContain("未知");
    // The four answers are different, which is the whole point of the readout.
    expect(
      new Set([
        readout.evidenceCoverage.displayName,
        readout.unresolvedResearch.displayName,
        readout.reportReview.displayName,
        readout.artifactQuality.displayName,
      ]).size,
    ).toBe(4);
  });
});

describe("run state", () => {
  it("separates what is running from what is waiting for a decision", () => {
    expect(runStateOf({ task: task({ confirmedAt: null }), hasReport: false, pendingProposal: false, runningStage: null }).state).toBe("preparing");
    expect(runStateOf({ task: task(), hasReport: false, pendingProposal: false, runningStage: "research" }).state).toBe("researching");
    expect(runStateOf({ task: task(), hasReport: true, pendingProposal: false, runningStage: null }).state).toBe("report_ready");
    expect(runStateOf({ task: task(), hasReport: true, pendingProposal: true, runningStage: null }).state).toBe("editing");
    expect(runStateOf({ task: task(), hasReport: true, pendingProposal: false, runningStage: "edit" }).state).toBe("editing");
    expect(runStateOf({ task: task({ error: "研究阶段没有成功读取任何来源" }), hasReport: false, pendingProposal: false, runningStage: null }).state).toBe("failed");
    expect(runStateOf({ task: task(), hasReport: false, pendingProposal: false, runningStage: null }).displayName).toBe("研究中");
  });
});
