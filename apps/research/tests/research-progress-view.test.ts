/**
 * The progress panel, as markup.
 *
 * What a reader needs while a project runs is four different facts, and the
 * cases below are about keeping them apart: the stage the product is in, what
 * this attempt spent, what the network answered, and what happened while they
 * were away. Two rules get their own cases because they are the ones the
 * product must never break — there is no percentage anywhere, and a failure
 * that has already been recovered from is history rather than the current
 * state.
 */

import { MantineProvider } from "@mantine/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ActivityEventView, ProgressView, SourceView, TaskBundle } from "../src/browser/api.js";
import { ActivityDetails, ResearchDetailFacts, ResearchProgress, type ResearchProgressProps } from "../src/browser/components/research-progress.js";

function progress(overrides: Partial<ProgressView> = {}): ProgressView {
  return {
    currentStage: "searching",
    displayName: "正在检索",
    currentMessage: "正在向 arXiv 发起检索请求（第 1 次）",
    completedStages: ["preparing"],
    lastActivityAt: "2026-10-09T10:31:00.000Z",
    searchAttempts: 2,
    candidatesFound: 5,
    sourcesRead: 1,
    currentProvider: "arxiv",
    retrying: false,
    waitingUntil: null,
    ...overrides,
  };
}

function source(overrides: Partial<SourceView> & { readonly sourceId: string }): SourceView {
  return {
    title: "来源",
    authors: [],
    venue: "arXiv",
    publishedAt: null,
    url: "https://example.org/a",
    doi: null,
    abstract: "",
    role: null,
    readStatus: "not_read",
    readScope: null,
    readAt: null,
    readUrl: null,
    retrievalNote: "",
    failure: null,
    discovery: { provider: "arxiv", query: "q", queriedAt: "2026-10-09T00:00:00.000Z", target: null },
    ...overrides,
  };
}

function activity(overrides: Partial<ActivityEventView> & { readonly id: string }): ActivityEventView {
  return {
    taskId: "task_1",
    at: "2026-10-09T10:31:00.000Z",
    stage: "research",
    level: "info",
    kind: "search",
    message: "向 arXiv 发起检索请求",
    ...overrides,
  };
}

function render(overrides: Partial<ResearchProgressProps> = {}): string {
  const props: ResearchProgressProps = {
    progress: progress(),
    attempt: { number: 2, startedAt: "2026-10-09T10:30:00.000Z", searches: 3, reads: 2, gapRounds: 1, reason: "用户确认任务后开始研究" },
    discovery: {
      attemptedRequests: 4,
      successfulRequests: 3,
      failedRequests: 1,
      lastProvider: "arxiv",
      lastElapsedMs: 1500,
      lastFailure: null,
    },
    activityLog: [activity({ id: "act_1" }), activity({ id: "act_2", level: "warn", message: "检索被限流，稍后重试" })],
    sources: [source({ sourceId: "src_1", readStatus: "ok" }), source({ sourceId: "src_2" })],
    usage: { searches: 7, reads: 4, gapRounds: 1 },
    budget: { maxSearches: 6, maxCandidatesPerSearch: 5, maxReads: 10, maxGapRounds: 2, deadlineMs: 480_000 },
    unresolved: 3,
    status: "researching",
    confirmed: true,
    error: null,
    busy: false,
    retrying: false,
    retryMessage: null,
    onRetry: () => undefined,
    ...overrides,
  };
  return renderToStaticMarkup(createElement(MantineProvider, null, createElement(ResearchProgress, props)));
}

describe("what the progress panel reports", () => {
  it("shows the stage and the sentence the server wrote", () => {
    const markup = render();
    expect(markup).toContain('data-testid="research-progress"');
    expect(markup).toContain("正在检索");
    expect(markup).toContain("正在向 arXiv 发起检索请求（第 1 次）");
  });

  it("separates this attempt from the project's lifetime", () => {
    const markup = render();
    // The round is this attempt's; the budget sentence carries the project's
    // own cumulative usage, so the two are never read as one number.
    expect(markup).toContain("第 2 轮");
    expect(markup).toContain("7 次检索");
    expect(markup).toContain("4 次读取");
  });

  it("says a project that never started has no attempt rather than zero progress", () => {
    const markup = render({ attempt: null, status: "draft" });
    expect(markup).toContain("尚未开始");
    expect(markup).not.toContain("第 1 轮");
  });

  it("counts discovery's failures separately from its successes, in the details", () => {
    const markup = render();
    // Not in the summary: a reader waiting does not need it, a diagnosis does.
    expect(markup).not.toContain("成功 3 / 尝试 4 / 失败 1");
    const details = renderToStaticMarkup(
      createElement(
        MantineProvider,
        null,
        createElement(ResearchDetailFacts, {
          progress: progress(),
          discovery: { attemptedRequests: 4, successfulRequests: 3, failedRequests: 1, lastProvider: "arxiv", lastElapsedMs: 1500, lastFailure: null },
          sources: [source({ sourceId: "src_1", readStatus: "ok" }), source({ sourceId: "src_2" })],
        }),
      ),
    );
    expect(details).toContain("成功 3 / 尝试 4 / 失败 1");
    expect(details).toContain("已读 1");
    expect(details).toContain("未读 1");
  });

  it("keeps the full activity log closed by default, and says how to open it", () => {
    const many = Array.from({ length: 14 }, (_unused, index) => activity({ id: `act_${String(index)}`, message: `第 ${String(index)} 条活动` }));
    const markup = render({ activityLog: many });
    // The default is the summary. Thirty internal events are a diagnosis, not
    // a status, and they are one click away rather than in the way.
    expect(markup).not.toContain('data-testid="activity-log"');
    expect(markup).not.toContain("第 4 条活动");
    expect(markup).toContain("共 14 条");
    expect(markup).toContain("查看活动详情");
    expect(markup).toContain('data-testid="activity-log-toggle"');
  });

  it("can still show every event, and can group them by what they were", () => {
    const many = [
      activity({ id: "a1", kind: "search_started", stage: "research", message: "向 arXiv 发起检索" }),
      activity({ id: "a2", kind: "read_ok", stage: "research", message: "读取来源成功" }),
      activity({ id: "a3", kind: "gap_round", stage: "gap", message: "进入定向补查" }),
      activity({ id: "a4", kind: "assess", stage: "research", message: "保存支持评估" }),
      activity({ id: "a5", kind: "report_started", stage: "report", message: "开始撰写报告" }),
    ];
    const flat = renderToStaticMarkup(createElement(MantineProvider, null, createElement(ActivityDetails, { events: many, grouped: false })));
    expect(flat).toContain('data-testid="activity-log"');
    expect(flat).toContain("向 arXiv 发起检索");

    const grouped = renderToStaticMarkup(createElement(MantineProvider, null, createElement(ActivityDetails, { events: many, grouped: true })));
    expect(grouped).toContain('data-testid="activity-log-grouped"');
    for (const label of ["检索", "读取", "补查", "评估", "报告"]) {
      expect(grouped, `the ${label} group is missing`).toContain(label);
    }
  });

  it("puts the summary first, with the counts a reader is waiting for", () => {
    const markup = render();
    expect(markup).toContain('data-testid="summary-candidates"');
    expect(markup).toContain('data-testid="summary-read"');
    expect(markup).toContain('data-testid="summary-unresolved"');
    expect(markup).toContain('data-testid="summary-elapsed"');
    expect(markup).toContain('data-testid="summary-last-activity"');
    expect(markup).toContain("3 项");
  });

  it("says the research budget is not a completion time", () => {
    const markup = render();
    expect(markup).toContain("不是报告完成时间");
    expect(markup).toContain("无法准确预估");
  });
});

describe("failures and retries", () => {
  it("shows the project's own error as the current failure, with a retry", () => {
    const markup = render({ status: "failed", error: "检索连续失败：provider 拒绝了请求。" });
    expect(markup).toContain('data-testid="research-failure"');
    expect(markup).toContain("当前失败");
    expect(markup).toContain("provider 拒绝了请求");
    expect(markup).toContain('data-testid="research-retry"');
    expect(markup).toContain("已经有的来源、证据、评估、报告和冻结版本都会保留");
    // The recovery a failed report deserves comes first; starting the research
    // over is named for what it is.
    expect(markup).toContain("使用现有资料恢复报告");
    expect(markup).toContain("重新研究（会重新检索与读取）");
  });

  it("does not offer a retry while the project is running", () => {
    const markup = render({ status: "researching", error: null });
    expect(markup).not.toContain('data-testid="research-failure"');
  });

  it("marks a recovered failure as history instead of the current state", () => {
    const markup = render({
      status: "researching",
      error: null,
      discovery: {
        attemptedRequests: 3,
        successfulRequests: 2,
        failedRequests: 1,
        lastProvider: "arxiv",
        lastElapsedMs: 900,
        lastFailure: {
          at: "2026-10-09T10:00:00.000Z",
          provider: "arxiv",
          kind: "rate_limited",
          status: 429,
          userMessage: "arXiv 返回 429，已改用备用来源。",
        },
      },
    });
    expect(markup).toContain("历史错误（当前状态不是失败）");
    expect(markup).toContain("它不是当前状态");
    expect(markup).not.toContain('data-testid="research-retry"');
  });

  it("reports what a retry preserved when it has just run", () => {
    const markup = render({ retryMessage: "已重开一轮研究。（保留：来源 6 · 证据 12）" });
    expect(markup).toContain("已重开一轮研究");
    expect(markup).toContain("保留：来源 6");
  });

  it("shows a waiting retry without inventing a countdown", () => {
    const markup = render({ progress: progress({ retrying: true, waitingUntil: "2026-10-09T10:33:00.000Z" }) });
    expect(markup).toContain('data-testid="research-retrying"');
    expect(markup).toContain("正在等待下一次尝试");
  });
});

describe("what the panel must never say", () => {
  it("has no percentage and no progress bar", () => {
    const markup = render({ status: "researching", progress: progress({ displayName: "正在撰写", currentStage: "reporting" }) });
    expect(markup).not.toMatch(/\d+\s*%/);
    expect(markup).not.toContain("完成度");
    expect(markup).not.toContain("progressbar");
  });

  it("does not claim a stage list it was not given", () => {
    const markup = render({ progress: progress({ completedStages: [] }) });
    expect(markup).not.toContain("已完成过的阶段");
  });
});

/** The bundle-shaped fields this component reads, kept honest by the type. */
type ProgressBundleFields = Pick<TaskBundle, "progress" | "attempt" | "discovery" | "activityLog" | "sources" | "usage" | "budget">;
const _typed: ProgressBundleFields | null = null;
void _typed;
