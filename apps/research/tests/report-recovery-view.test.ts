/**
 * What the report button offers, at the moment it matters.
 *
 * The button used to say「撰写报告」whatever had happened, so a project whose
 * report had failed twice offered the same action as a project that had never
 * tried — and a reader who clicked it again paid for the same failure. Two
 * things are checked here: that resuming is what is offered whenever there is
 * something to resume, and that nothing ever reads as a report until one has
 * been validated and stored.
 */

import { describe, expect, it } from "vitest";

import type { ReportGenerationView, TaskBundle } from "../src/browser/api.js";
import { reportActionOf } from "../src/browser/views/research.js";

function generation(overrides: Partial<ReportGenerationView> = {}): ReportGenerationView {
  return {
    status: "idle",
    displayName: "尚未开始",
    userMessage: "还没有开始撰写报告；材料已经就绪，可以直接生成。",
    stage: null,
    startedAt: null,
    endedAt: null,
    resumes: 0,
    repairs: 0,
    failure: null,
    draft: null,
    canResume: false,
    reportId: null,
    blockedBy: null,
    ...overrides,
  };
}

function bundle(reportGeneration: ReportGenerationView, hasReport = false): TaskBundle {
  return { hasReport, reportGeneration } as unknown as TaskBundle;
}

describe("the report button", () => {
  it("offers to write the report when there is nothing to resume", () => {
    const action = reportActionOf(bundle(generation()));
    expect(action.label).toBe("撰写报告");
    expect(action.disabled).toBe(false);
    expect(action.hint).toContain("不会重新检索");
  });

  it("offers to resume, by name, once an attempt has failed", () => {
    const action = reportActionOf(
      bundle(
        generation({
          status: "failed",
          canResume: true,
          failure: {
            category: "model_request",
            code: "model_payment_required",
            problem: "模型服务以「需要付费」拒绝了这次请求（HTTP 402）。",
            guidance: "请检查模型服务的支付方式、账户余额或配额。",
            retryable: false,
          },
        }),
      ),
    );
    expect(action.label).toBe("使用现有资料恢复报告");
    expect(action.disabled).toBe(false);
    expect(action.hint).toContain("不会再检索");
  });

  it("offers to resume a saved draft, and says how much is still open", () => {
    const action = reportActionOf(
      bundle(generation({ status: "draft_saved", canResume: true, draft: { sections: 8, claims: 9, outstanding: 3 } })),
    );
    expect(action.label).toBe("使用现有资料恢复报告");
    expect(action.hint).toContain("3 项");
  });

  it("waits while a pass is in flight instead of offering a second one", () => {
    for (const status of ["accepted", "running"] as const) {
      const action = reportActionOf(bundle(generation({ status, blockedBy: "busy" })));
      expect(action.disabled).toBe(true);
      expect(action.label).toBe("正在生成报告");
    }
  });

  it("never calls a project without a stored report a report", () => {
    // The whole point of the four states: only the validated one is a report,
    // and only it opens the report view.
    for (const status of ["idle", "accepted", "running", "draft_saved", "failed"] as const) {
      const action = reportActionOf(bundle(generation({ status, canResume: status === "failed" || status === "draft_saved" })));
      expect(action.label).not.toBe("报告已生成");
    }
    const stored = reportActionOf(bundle(generation({ status: "validated", reportId: "rep_1", blockedBy: "report_exists" }), true));
    expect(stored.label).toBe("报告已生成");
    expect(stored.disabled).toBe(true);
    expect(stored.hint).toContain("Edit");
  });
});
