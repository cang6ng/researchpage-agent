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

import type { ReportGenerationState, ReportTask, ResearchActivityEvent, ResearchRunRecord } from "@every-dagent/plugin-research";
import { researchProgressOf, timingOf, type ProgressInput } from "../src/server/presentation.js";

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

/**
 * How long a project took, as two facts rather than one running clock.
 *
 * The defect this file is written against: a project that started at 10:23 and
 * finished at 10:25 showed「已完成 / 已用时 1 小时 23 分钟」when it was reopened
 * at 11:48 — the page had been adding the current time to a term that had ended
 * an hour earlier. Two rules are pinned here. A term that has ended is its own
 * two instants subtracted, so nothing about when the page is open can change
 * the answer. And a term whose end was never recorded — a run a restart
 * interrupted, an attempt a process died inside — says「无法确定」rather than
 * borrowing a time from somewhere else.
 */
/** One report attempt, as the service persists it. */
function generation(patch: Partial<ReportGenerationState> = {}): ReportGenerationState {
  return {
    attemptId: "jrn_gen",
    status: "running",
    stage: "report",
    startedAt: "2026-10-09T10:02:00.000Z",
    endedAt: null,
    failure: null,
    resumes: 0,
    repairs: 0,
    repairSignature: null,
    ...patch,
  };
}

describe("the two durations a project reports", () => {
  const ten = "2026-10-09T10:00:00.000Z";
  const tenTwo = "2026-10-09T10:02:00.000Z";
  const tenFive = "2026-10-09T10:05:00.000Z";
  const eleven = "2026-10-09T11:00:00.000Z";

  /** A task whose research attempt began at `startedAt`. */
  function attempted(startedAt: string, patch: Partial<ReportTask> = {}): ReportTask {
    return task({
      attempt: { number: 1, startedAt, searches: 1, reads: 1, gapRounds: 0, reason: "用户确认任务后开始研究" },
      ...patch,
    });
  }

  it("freezes research at the end of its own runs, whatever a report does afterwards", () => {
    const runs = [
      run({ id: "jrn_1", stage: "research", status: "completed", startedAt: ten, endedAt: tenTwo }),
      run({ id: "jrn_2", stage: "report", status: "completed", startedAt: tenTwo, endedAt: tenFive }),
      run({ id: "jrn_3", stage: "synthesis", status: "completed", startedAt: tenFive, endedAt: "2026-10-09T10:06:00.000Z" }),
    ];
    const timing = timingOf({ task: attempted(ten, { reportGeneration: generation({ startedAt: tenTwo, endedAt: tenFive }) }), runs, researchBusy: false, reportBusy: false });
    expect(timing.research).toEqual({ startedAt: ten, endedAt: tenTwo, state: "ended" });
  });

  it("does not extend research for a report recovered an hour later", () => {
    // 10:00–10:02 research, 10:02–10:05 report, the report recovered at 11:00:
    // the research is still two minutes, and the recovery is its own attempt.
    const runs = [
      run({ id: "jrn_1", stage: "research", status: "completed", startedAt: ten, endedAt: tenTwo }),
      run({ id: "jrn_2", stage: "report", status: "completed", startedAt: tenTwo, endedAt: tenFive }),
      run({ id: "jrn_3", stage: "report", status: "running", startedAt: eleven, endedAt: null }),
    ];
    const timing = timingOf({
      task: attempted(ten, { reportGeneration: generation({ attemptId: "jrn_recover", startedAt: eleven, endedAt: null, status: "running" }) }),
      runs,
      researchBusy: false,
      reportBusy: true,
    });
    expect(timing.research).toEqual({ startedAt: ten, endedAt: tenTwo, state: "ended" });
    expect(timing.report).toEqual({ startedAt: eleven, endedAt: null, state: "running" });
  });

  it("leaves a user's own补查 out of the pass it is not part of", () => {
    const runs = [
      run({ id: "jrn_1", stage: "research", status: "completed", startedAt: ten, endedAt: tenTwo }),
      run({ id: "jrn_2", stage: "gap", status: "completed", startedAt: tenTwo, endedAt: tenFive, userText: "再补查一些资料" }),
    ];
    const timing = timingOf({ task: attempted(ten), runs, researchBusy: false, reportBusy: false });
    expect(timing.research.endedAt).toBe(tenTwo);
  });

  it("does not let a report from before this attempt cut the research short", () => {
    // The real retry: research 10:00–10:05, its report failed, the reader asked
    // for research again at 11:00 — a new attempt — that pass ran 11:00–11:04 and
    // its own report began there. The failed report's record is older than the
    // attempt, so it is not a boundary of it: read as one, it filtered out the
    // very research that came after it, and a pass that really ran and really
    // ended was shown as「无法确定」.
    const elevenThree = "2026-10-09T11:03:00.000Z";
    const elevenFour = "2026-10-09T11:04:00.000Z";
    const elevenSix = "2026-10-09T11:06:00.000Z";
    const runs = [
      run({ id: "jrn_1", stage: "research", status: "completed", startedAt: ten, endedAt: tenTwo }),
      run({ id: "jrn_2", stage: "gap", status: "completed", startedAt: tenTwo, endedAt: tenFive }),
      run({ id: "jrn_3", stage: "report", status: "failed", startedAt: tenFive, endedAt: "2026-10-09T10:05:30.000Z" }),
      run({ id: "jrn_4", stage: "research", status: "completed", startedAt: eleven, endedAt: elevenThree }),
      run({ id: "jrn_5", stage: "gap", status: "completed", startedAt: elevenThree, endedAt: elevenFour }),
      run({ id: "jrn_6", stage: "report", status: "completed", startedAt: elevenFour, endedAt: elevenSix }),
    ];
    const timing = timingOf({
      task: task({
        attempt: {
          number: 2,
          startedAt: eleven,
          searches: 1,
          reads: 0,
          gapRounds: 0,
          reason: "用户请求重新研究（保留原有材料、报告与冻结版本）",
        },
        reportGeneration: generation({ attemptId: "jrn_new", startedAt: elevenFour, endedAt: elevenSix, status: "validated" }),
      }),
      runs,
      researchBusy: false,
      reportBusy: false,
    });
    expect(timing.research).toEqual({ startedAt: eleven, endedAt: elevenFour, state: "ended" });
    expect(timing.report).toEqual({ startedAt: elevenFour, endedAt: elevenSix, state: "ended" });
  });

  it("says unknown when a restart interrupted the pass", () => {
    // The end a restart records is when the interruption was *detected*, not
    // when the work stopped, so it is not an end this product may report.
    const runs = [run({ id: "jrn_1", stage: "research", status: "interrupted", startedAt: ten, endedAt: eleven })];
    const timing = timingOf({ task: attempted(ten), runs, researchBusy: false, reportBusy: false });
    expect(timing.research).toEqual({ startedAt: ten, endedAt: null, state: "unknown" });
  });

  it("says unknown for a pass that has no records at all", () => {
    const timing = timingOf({ task: attempted(ten), runs: [], researchBusy: false, reportBusy: false });
    expect(timing.research.state).toBe("unknown");
    expect(timing.research.startedAt).toBe(ten);
  });

  it("says idle when there is no attempt and no generation", () => {
    const timing = timingOf({ task: task(), runs: [], researchBusy: false, reportBusy: false });
    expect(timing.research.state).toBe("idle");
    expect(timing.report.state).toBe("idle");
  });

  it("runs only while work is really in flight", () => {
    const runs = [run({ id: "jrn_1", stage: "research", status: "running", startedAt: ten, endedAt: null })];
    const timing = timingOf({ task: attempted(ten), runs, researchBusy: true, reportBusy: false });
    expect(timing.research).toEqual({ startedAt: ten, endedAt: null, state: "running" });
    // A generation persisted as `running` by a process that is gone is not
    // running: nothing is producing an end for it.
    const stale = timingOf({
      task: attempted(ten, { reportGeneration: generation({ startedAt: ten, endedAt: null, status: "running" }) }),
      runs: [],
      researchBusy: false,
      reportBusy: false,
    });
    expect(stale.report).toEqual({ startedAt: ten, endedAt: null, state: "unknown" });
  });

  it("freezes a failed generation at the end it recorded, and says unknown when it recorded none", () => {
    const withEnd = timingOf({
      task: attempted(ten, { reportGeneration: generation({ startedAt: ten, endedAt: tenFive, status: "failed" }) }),
      runs: [],
      researchBusy: false,
      reportBusy: false,
    });
    expect(withEnd.report).toEqual({ startedAt: ten, endedAt: tenFive, state: "ended" });
    // A failure a restart detected has no end: the boot moment is not one.
    const interrupted = timingOf({
      task: attempted(ten, { reportGeneration: generation({ startedAt: ten, endedAt: null, status: "failed" }) }),
      runs: [],
      researchBusy: false,
      reportBusy: false,
    });
    expect(interrupted.report).toEqual({ startedAt: ten, endedAt: null, state: "unknown" });
  });
});
