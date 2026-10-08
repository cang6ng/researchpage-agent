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
import { ResearchProgress, type ResearchProgressProps } from "../src/browser/components/research-progress.js";

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
    expect(markup).toContain("第 2 轮");
    expect(markup).toContain("本项目累计检索");
    expect(markup).toContain("检索请求");
    expect(markup).toContain("2 次（含失败）");
  });

  it("says a project that never started has no attempt rather than zero progress", () => {
    const markup = render({ attempt: null, status: "draft" });
    expect(markup).toContain("尚未开始");
    expect(markup).not.toContain("第 1 轮");
  });

  it("counts discovery's failures separately from its successes", () => {
    const markup = render();
    expect(markup).toContain("成功 3 / 尝试 4 / 失败 1");
    expect(markup).toContain("arxiv");
  });

  it("reports read state as counts rather than as a verdict", () => {
    const markup = render();
    expect(markup).toContain("已读 1");
    expect(markup).toContain("未读 1");
  });

  it("shows the stored activity log, oldest first, and offers the whole history", () => {
    const many = Array.from({ length: 14 }, (_unused, index) => activity({ id: `act_${String(index)}`, message: `第 ${String(index)} 条活动` }));
    const markup = render({ activityLog: many });
    expect(markup).toContain('data-testid="activity-log"');
    expect(markup).toContain("共 14 条（最早的在前）");
    expect(markup).toContain("展开全部");
    expect(markup).toContain("第 4 条活动");
    expect(markup).not.toContain("第 0 条活动");
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
type ProgressBundleFields = Pick<TaskBundle, "progress" | "attempt" | "discovery" | "activityLog" | "sources" | "usage">;
const _typed: ProgressBundleFields | null = null;
void _typed;
