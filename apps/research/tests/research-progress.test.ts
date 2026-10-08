/**
 * What the progress readout is allowed to say.
 *
 * The point of this projection is the number it refuses to produce. A research
 * pass does not complete a fixed fraction of work per second, so「63%」would be
 * a figure the product invented; what it *can* say truthfully is which stage is
 * running, what that stage is doing inside itself, which stages finished, how
 * many requests and candidates there were, and — when something is waiting —
 * what it is waiting for and until when. Each test below pins one of those, and
 * the last one pins the absence of the fake one.
 */

import { describe, expect, it } from "vitest";

import type { ReportTask, ResearchActivityEvent, ResearchRunRecord } from "@every-dagent/plugin-research";
import { researchProgressOf, type ProgressInput } from "../src/server/presentation.js";

const AT = "2026-10-08T10:00:00.000Z";

function task(patch: Partial<ReportTask> = {}): ReportTask {
  return {
    id: "task_1",
    sessionId: "sess_1",
    topic: "GraphRAG",
    purpose: "选型",
    audience: "工程团队",
    focus: [],
    exclusions: "",
    language: "zh",
    lengthTarget: "6 页",
    status: "researching",
    confirmedAt: AT,
    structure: { sections: [] },
    subjects: [],
    dimensions: [],
    matrix: [],
    budget: { maxSearches: 6, maxCandidatesPerSearch: 5, maxReads: 10, maxGapRounds: 2, deadlineMs: 480_000 },
    usage: { searches: 2, reads: 1, gapRounds: 0, startedAt: AT },
    currentReportId: null,
    reportDraft: null,
    createdAt: AT,
    updatedAt: AT,
    error: null,
    ...patch,
  };
}

function run(patch: Partial<ResearchRunRecord> = {}): ResearchRunRecord {
  return {
    id: "jrn_1",
    taskId: "task_1",
    stage: "research",
    runId: "run_1",
    status: "running",
    startedAt: AT,
    endedAt: null,
    note: "检索与读取：已启动",
    activity: [],
    ...patch,
  };
}

function event(patch: Partial<ResearchActivityEvent> = {}): ResearchActivityEvent {
  return {
    id: "actv_1",
    taskId: "task_1",
    at: AT,
    stage: "searching",
    level: "info",
    kind: "request_started",
    message: "正在向 arXiv 发起检索请求（第 1 次）",
    ...patch,
  };
}

function progress(input: Partial<ProgressInput> = {}): ReturnType<typeof researchProgressOf> {
  return researchProgressOf({
    task: input.task ?? task(),
    runs: input.runs ?? [run()],
    activity: input.activity ?? [event()],
    sources: input.sources ?? [],
  });
}

describe("research progress", () => {
  it("says which stage the run is in, and what it is doing inside that stage", () => {
    expect(progress().currentStage).toBe("searching");
    expect(progress().displayName).toBe("正在检索");
    expect(progress({ activity: [event({ kind: "read_started", message: "开始读取：GraphRAG 论文" })] }).currentStage).toBe("reading");
    expect(progress({ activity: [event({ kind: "assessment_recorded", message: "记录 3 条支持评估" })] }).currentStage).toBe("assessing");
  });

  it("reads the stage from the run when there is no activity yet, and from the task when nothing runs", () => {
    expect(progress({ activity: [] }).currentStage).toBe("searching");
    expect(progress({ runs: [run({ stage: "report" })], activity: [] }).currentStage).toBe("reporting");
    expect(progress({ runs: [run({ stage: "synthesis" })], activity: [] }).currentStage).toBe("validating");
    expect(progress({ runs: [run({ stage: "gap" })], activity: [] }).currentStage).toBe("gap_research");
    expect(progress({ runs: [], activity: [], task: task({ status: "confirmed" }) }).currentStage).toBe("preparing");
  });

  it("says a waiting run is waiting, and until when", () => {
    const waiting = progress({
      activity: [
        event({
          kind: "retry_wait",
          level: "warn",
          message: "等待 6 秒后重试arXiv",
          provider: "arxiv",
          attempt: 2,
          nextRetryAt: "2026-10-08T10:00:06.000Z",
        }),
      ],
    });
    expect(waiting.currentStage).toBe("waiting_retry");
    expect(waiting.displayName).toBe("正在等待检索服务");
    expect(waiting.retrying).toBe(true);
    expect(waiting.waitingUntil).toBe("2026-10-08T10:00:06.000Z");
    // The last thing the run said is what the reader is told, verbatim.
    expect(waiting.currentMessage).toContain("等待 6 秒");

    const quiet = progress({ activity: [event()] });
    expect(quiet.retrying).toBe(false);
    expect(quiet.waitingUntil).toBeNull();
  });

  it("counts requests, candidates and reads from real records rather than from a model's account", () => {
    const ledger: ReportTask["discovery"] = {
      attemptedRequests: 5,
      successfulRequests: 2,
      failedRequests: 3,
      lastProvider: "openalex",
      lastElapsedMs: 1200,
      lastFailure: null,
    };
    const view = progress({
      task: task({ discovery: ledger }),
      sources: [{ readStatus: "ok" }, { readStatus: "not_read" }, { readStatus: "failed" }],
    });
    expect(view.searchAttempts).toBe(5);
    expect(view.candidatesFound).toBe(3);
    expect(view.sourcesRead).toBe(1);
    // With no live line naming a provider, the last provider that answered is
    // the honest answer.
    expect(view.currentProvider).toBe("openalex");
    // A live line that names one outranks the ledger.
    const live = progress({
      task: task({ discovery: ledger }),
      activity: [event({ provider: "arxiv", kind: "request_started", message: "正在向 arXiv 发起检索请求（第 2 次）" })],
    });
    expect(live.currentProvider).toBe("arxiv");
  });

  it("lists the stages that actually finished, and never claims a fraction of the work", () => {
    const view = progress({
      runs: [
        run({ id: "jrn_1", stage: "card", status: "completed" }),
        run({ id: "jrn_2", stage: "research", status: "completed" }),
        run({ id: "jrn_3", stage: "gap", status: "completed" }),
        run({ id: "jrn_4", stage: "report", status: "running", runId: "run_4" }),
      ],
      // A search line left over from the research pass: the run is writing the
      // report now, and a stale line must not claim otherwise.
      activity: [event({ kind: "candidates_found", stage: "searching", message: "arXiv 返回 3 个候选" })],
    });
    expect(view.completedStages).toEqual(["preparing", "searching", "gap_research"]);
    expect(view.currentStage).toBe("reporting");
    expect(JSON.stringify(view)).not.toContain("%");
    expect(Object.keys(view)).not.toContain("percent");
    expect(Object.keys(view)).not.toContain("progress");
  });

  it("reports a failed project as failed, with the reason the project itself recorded", () => {
    const view = progress({
      task: task({ status: "failed", error: "论文检索暂时不可用：arXiv：请求过于频繁（HTTP 429）。已有的研究范围与已读材料都保留了。" }),
      runs: [],
      activity: [],
    });
    expect(view.currentStage).toBe("failed");
    expect(view.currentMessage).toContain("论文检索暂时不可用");
    expect(view.currentMessage).not.toContain("主题");
  });

  it("calls a project with a saved report what it is — but only when nothing is running", () => {
    const view = progress({ task: task({ currentReportId: "rep_1" }), runs: [], activity: [] });
    expect(view.currentStage).toBe("completed");
    expect(view.displayName).toBe("已完成");
  });
});
