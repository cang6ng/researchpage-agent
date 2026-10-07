/**
 * The co-edit workspace, checked as arithmetic and as order.
 *
 * Three things decide whether the right column is a workspace or a sidebar, and
 * all three are decidable without a browser. Which turns the conversation has —
 * the reader's own instructions, never the agent's own passes, in the order
 * they happened. Whether the split is even and stays inside the range the
 * reader may drag it to. And whether a proposal is attached to the action that
 * produced it rather than to whatever happened last.
 *
 * What a browser gate adds on top of this is that the boxes really are the size
 * this says they are; what it cannot show is the reasoning, which is here.
 */

import { describe, expect, it } from "vitest";

import type { AnswerView, ProposalView, RunView, TaskBundle } from "../src/browser/api.js";
import {
  COEDIT_SPLIT,
  budgetExhausted,
  clampSplit,
  conversationOf,
  proposalFor,
  refusedCall,
  refusalOf,
  splitFromDrag,
  stepLabel,
  studioLayout,
} from "../src/browser/conversation-logic.js";

function runFixture(overrides: Partial<RunView> & { readonly stage: RunView["stage"] }): RunView {
  return {
    runId: `run_${overrides.stage}_${String(overrides.startedAt ?? "1")}`,
    status: "completed",
    note: "完成",
    startedAt: "2026-10-07T01:00:00.000Z",
    endedAt: "2026-10-07T01:02:00.000Z",
    activity: [],
    userText: "",
    ...overrides,
  };
}

function bundleOf(runs: readonly RunView[], proposals: readonly ProposalView[] = []): TaskBundle {
  return { runs, proposals } as unknown as TaskBundle;
}

function proposalFixture(overrides: Partial<ProposalView> & { readonly proposalId: string }): ProposalView {
  return {
    actionId: "act_1",
    status: "pending",
    baseReportId: "rep_1",
    baseContentHash: "sha256:abc",
    targets: ["sec_cost"],
    sections: [{ id: "sec_cost", title: "成本与比较条件" }],
    reason: "把这一节改短",
    evidenceIds: [],
    researchAdded: { sources: 0, evidence: 0, assessments: 0 },
    acceptedReportId: null,
    createdAt: "2026-10-07T01:01:00.000Z",
    decidedAt: null,
    ...overrides,
  };
}

const TOOLS = [
  { name: "search_sources", detail: '{"ok":true,"candidates":5}', ok: true, at: "2026-10-07T01:00:10.000Z" },
  { name: "read_source", detail: '{"ok":true,"readId":"src_9"}', ok: true, at: "2026-10-07T01:00:20.000Z" },
  { name: "read_source", detail: '{"ok":false,"reason":"已用完"}', ok: false, at: "2026-10-07T01:00:30.000Z" },
  // A refusal is a *result*: the host ran the call and the service said no, so
  // the record says `ok: true` and the sentence is in the body.
  { name: "search_sources", detail: '{"ok":false,"problems":["本次补查的检索次数已用完（2/2）"]}', ok: true, at: "2026-10-07T01:00:40.000Z" },
];

describe("H. the conversation is the reader's turns, in order", () => {
  it("keeps the runs a person asked for and drops the agent's own passes", () => {
    const interactions = conversationOf(
      bundleOf([
        runFixture({ stage: "card", status: "completed", userText: "" }),
        runFixture({ stage: "research", startedAt: "2026-10-07T00:10:00.000Z", userText: "" }),
        runFixture({ stage: "ask", startedAt: "2026-10-07T00:20:00.000Z", userText: "这个判断为什么说不可比？" }),
        runFixture({ stage: "report", startedAt: "2026-10-07T00:30:00.000Z", userText: "" }),
        runFixture({ stage: "gap", startedAt: "2026-10-07T00:40:00.000Z", userText: "再帮我找一下独立评测。" }),
        runFixture({ stage: "gap", startedAt: "2026-10-07T00:45:00.000Z", userText: "" }),
        runFixture({ stage: "edit", startedAt: "2026-10-07T00:50:00.000Z", userText: "把这一节改得更适合组会讲。" }),
      ]),
      [],
    );
    expect(interactions.map((entry) => entry.kind)).toEqual(["ask", "research", "edit"]);
    expect(interactions.map((entry) => entry.userText)).toEqual([
      "这个判断为什么说不可比？",
      "再帮我找一下独立评测。",
      "把这一节改得更适合组会讲。",
    ]);
  });

  it("attaches an Ask's answer to its own turn, and counts what a research action did", () => {
    const answers: readonly AnswerView[] = [
      { runId: "run_ask_2026-10-07T00:20:00.000Z", question: "为什么不可比？", status: "completed", text: "因为口径不同。" },
    ];
    const interactions = conversationOf(
      bundleOf([
        runFixture({ stage: "ask", startedAt: "2026-10-07T00:20:00.000Z", userText: "为什么不可比？" }),
        runFixture({
          stage: "gap",
          startedAt: "2026-10-07T00:40:00.000Z",
          userText: "找独立评测",
          activity: [...TOOLS, { name: "assess_coverage", detail: "{}", ok: true, at: "2026-10-07T01:00:40.000Z" }],
        }),
      ]),
      answers,
    );
    expect(interactions[0]?.answer).toBe("因为口径不同。");
    expect(interactions[1]?.searches).toBe(1);
    expect(interactions[1]?.reads).toBe(1);
    expect(interactions[1]?.assessments).toBe(1);
  });

  it("does not count a call the service refused as work the action did", () => {
    const [interaction] = conversationOf(bundleOf([runFixture({ stage: "gap", userText: "补查", activity: TOOLS })]), []);
    expect(interaction?.searches).toBe(1);
    expect(interaction?.reads).toBe(1);
    expect(interaction?.steps.map((step) => step.failed)).toEqual([false, false, true, true]);
    expect(refusedCall('{"ok":false,"problems":["已用完"]}')).toBe(true);
    expect(refusedCall('{"ok":true,"sources":[]}')).toBe(false);
    expect(refusedCall("失败：运行未完成")).toBe(false);
  });

  it("says what a step did in words, and never prints a tool name or a payload", () => {
    const [interaction] = conversationOf(
      bundleOf([
        runFixture({
          stage: "gap",
          userText: "找独立评测",
          activity: TOOLS,
        }),
      ]),
      [],
    );
    expect(interaction?.steps.map((step) => step.label)).toEqual([
      "检索候选来源",
      "读取来源上下文",
      "读取来源上下文",
      "检索候选来源",
    ]);
    expect(interaction?.steps[2]?.failed).toBe(true);
    for (const step of interaction?.steps ?? []) {
      expect(step.label).not.toContain("search_sources");
      expect(step.label).not.toContain("{");
    }
    expect(stepLabel({ name: "unknown_tool", detail: "", ok: true, at: "" })).toBe("执行一步");
  });

  it("turns a refused proposal into the tool's own sentences", () => {
    expect(refusalOf('{"ok":false,"problems":["已有待接受的修改提案","目标章节不存在"]}')).toBe(
      "已有待接受的修改提案；目标章节不存在",
    );
    expect(refusalOf("没有任何结构")).toBe("没有任何结构");
  });

  it("stops at the last ten interactions, so the column stays a history", () => {
    const many = Array.from({ length: 14 }, (_, index) =>
      runFixture({
        stage: "ask",
        startedAt: `2026-10-07T00:${String(index + 10).padStart(2, "0")}:00.000Z`,
        userText: `第 ${String(index + 1)} 问`,
      }),
    );
    const interactions = conversationOf(bundleOf(many), []);
    expect(interactions).toHaveLength(10);
    expect(interactions[0]?.userText).toBe("第 5 问");
    expect(interactions[9]?.userText).toBe("第 14 问");
  });
});

describe("I. an exhausted allowance does not stop the next instruction", () => {
  const interaction = (overrides: Partial<RunView>): ReturnType<typeof conversationOf>[number] => {
    const [only] = conversationOf(bundleOf([runFixture({ stage: "gap", userText: "补查", ...overrides })]), []);
    return only as ReturnType<typeof conversationOf>[number];
  };

  it("knows when a research action spent its own allowance", () => {
    const spent = interaction({
      activity: [
        { name: "search_sources", detail: "", ok: true, at: "" },
        { name: "search_sources", detail: "", ok: true, at: "" },
      ],
    });
    expect(budgetExhausted(spent, { searches: 2, reads: 4 })).toBe(true);
    const partial = interaction({ activity: [{ name: "search_sources", detail: "", ok: true, at: "" }] });
    expect(budgetExhausted(partial, { searches: 2, reads: 4 })).toBe(false);
    // It is a fact about Research actions only: an Ask has no allowance to run out of.
    const asked = conversationOf(bundleOf([runFixture({ stage: "ask", userText: "问" })]), [])[0] as ReturnType<
      typeof conversationOf
    >[number];
    expect(budgetExhausted(asked, { searches: 0, reads: 0 })).toBe(false);
  });
});

describe("J. a proposal belongs to the action that produced it", () => {
  const earlier = conversationOf(
    bundleOf([
      runFixture({
        stage: "edit",
        startedAt: "2026-10-07T01:00:00.000Z",
        endedAt: "2026-10-07T01:05:00.000Z",
        userText: "改第一节",
        activity: [{ name: "propose_section_edit", detail: '{"ok":true}', ok: true, at: "2026-10-07T01:04:00.000Z" }],
      }),
      runFixture({
        stage: "edit",
        startedAt: "2026-10-07T02:00:00.000Z",
        endedAt: "2026-10-07T02:05:00.000Z",
        userText: "改第二节",
        activity: [{ name: "propose_section_edit", detail: '{"ok":false,"problems":["已有待接受的修改提案"]}', ok: false, at: "2026-10-07T02:04:00.000Z" }],
      }),
    ]),
    [],
  );

  it("is matched inside its own run's window, not to the newest one", () => {
    const first = earlier[0] as ReturnType<typeof conversationOf>[number];
    const second = earlier[1] as ReturnType<typeof conversationOf>[number];
    const proposal = proposalFixture({ proposalId: "prp_1", createdAt: "2026-10-07T01:04:30.000Z" });
    const now = Date.parse("2026-10-07T03:00:00.000Z");
    expect(proposalFor(first, [proposal], now)?.proposalId).toBe("prp_1");
    expect(proposalFor(second, [proposal], now)).toBeNull();
  });

  it("remembers an action that produced nothing, and why", () => {
    expect(earlier[0]?.drafted).toBe(true);
    expect(earlier[1]?.drafted).toBe(false);
    expect(earlier[1]?.refusal).toBe("已有待接受的修改提案");
  });
});

describe("F/G. the split screen and the reading page", () => {
  it("is even by default, and stays between the two shares the reader may drag to", () => {
    expect(COEDIT_SPLIT.default).toBe(50);
    expect(clampSplit(50)).toBe(50);
    expect(clampSplit(20)).toBe(COEDIT_SPLIT.min);
    expect(clampSplit(90)).toBe(COEDIT_SPLIT.max);
    expect(clampSplit(Number.NaN)).toBe(50);
  });

  it("reads a drag as a share of the workspace", () => {
    // 120px to the left on a 1440 workspace: the document gives up 8.3 points.
    expect(splitFromDrag({ startSplit: 50, startX: 700, x: 580, width: 1440 })).toBe(42);
    // Dragging past the limit stops at the limit.
    expect(splitFromDrag({ startSplit: 50, startX: 700, x: 100, width: 1440 })).toBe(40);
    expect(splitFromDrag({ startSplit: 50, startX: 700, x: 1400, width: 1440 })).toBe(60);
    expect(splitFromDrag({ startSplit: 50, startX: 700, x: 600, width: 0 })).toBe(50);
  });

  it("has three shapes, and the workspace keeps its shape when its subject changes", () => {
    expect(studioLayout({ dockOpen: false, workspaceOpen: false })).toBe("reading");
    // A glance panel: the document stays the subject of the page.
    expect(studioLayout({ dockOpen: true, workspaceOpen: false })).toBe("inspect");
    // The workspace stays open while it shows a sentence's evidence.
    expect(studioLayout({ dockOpen: true, workspaceOpen: true })).toBe("coedit");
  });
});
