/**
 * Guided planning, checked as the conversation it now is.
 *
 * Four questions these cases answer, all of them about what the page shows
 * rather than about the model behind it: does the transcript come back whole
 * and in order after a refresh, does the reader's own wording survive into
 * their turn, is the model's transition really rendered as Markdown, and does
 * the one state that needs recovery recover exactly once.
 *
 * The last case in this file is the one that is easy to get wrong: the panel
 * asks the application for another question when a question run ends without
 * leaving one behind — and it must not do that for the ordinary states it
 * passes through on the way to a question.
 */

import { MantineProvider } from "@mantine/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { BriefView, GuideDecisionView, GuideQuestionView } from "../src/browser/api.js";
import { GuidePanel } from "../src/browser/components/brief-guide.js";
import {
  answerTextOf,
  guideConfirmState,
  guideProgress,
  guideStalled,
  guideSummaryItems,
  guideTranscript,
} from "../src/browser/guide-logic.js";

/* --------------------------------------------------------------- fixtures -- */

function decisionFixture(index: number, overrides: Partial<GuideDecisionView> = {}): GuideDecisionView {
  return {
    questionId: `gq_${String(index)}`,
    leadIn: `我们先把第 ${String(index)} 项定下来。`,
    question: `第 ${String(index)} 个问题是什么？`,
    fieldTargets: ["purpose"],
    optionIds: ["opt_1"],
    selectedOptionLabels: ["选型建议为主"],
    answerText: "选型建议为主",
    freeText: "",
    appliedFields: ["purpose"],
    resultingBriefVersion: index + 1,
    at: `2026-10-07T0${String(index)}:00:00.000Z`,
    ...overrides,
  };
}

function questionFixture(index: number): GuideQuestionView {
  return {
    questionId: `gq_${String(index)}`,
    leadIn: "我理解你更关心的是**成本口径**。",
    question: "你希望比较的对象范围到哪里？",
    whyThisMatters: "对象范围决定了矩阵有多少列。",
    fieldTargets: ["subjects"],
    options: [
      { optionId: "opt_1", label: "只比较两个", recommended: true },
      { optionId: "opt_2", label: "再加一个做参照" },
    ],
    allowFreeText: true,
    basedOnBriefVersion: index,
    createdAt: `2026-10-07T0${String(index)}:30:00.000Z`,
  };
}

function briefFixture(overrides: Partial<BriefView> = {}): BriefView {
  return {
    taskId: "task_1",
    confirmed: false,
    readonly: false,
    version: 3,
    updatedAt: "2026-10-07T05:00:00.000Z",
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
    audience: "给组会用",
    focus: ["成本口径"],
    exclusions: "",
    lengthTarget: "约 4 页",
    subjects: [
      { id: "sub_a", name: "GraphRAG", note: "" },
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
    canConfirm: true,
    guide: { complete: false, reason: "", limit: 7, minDecisions: 5, maxDecisions: 7, readiness: 0, decisions: [], active: null },
    matrix: { subjects: 2, dimensions: 3, cells: 6 },
    contentHash: "hash",
    ...overrides,
  };
}

function render(brief: BriefView): string {
  return renderToStaticMarkup(
    createElement(
      MantineProvider,
      null,
      createElement(GuidePanel, {
        brief,
        busy: false,
        waiting: false,
        settledGuideRuns: 1,
        staleNote: null,
        onAsk: () => undefined,
        onAnswer: () => undefined,
        onViewStructured: () => undefined,
        onConfirm: () => undefined,
      }),
    ),
  );
}

/* ------------------------------------------------------------------ cases -- */

describe("A/B. the guided conversation comes back in order", () => {
  it("reads five decisions as ten turns, oldest first, and then the live question", () => {
    const brief = briefFixture({
      guide: {
        complete: false,
        reason: "",
        limit: 7,
        minDecisions: 5,
        maxDecisions: 7,
        readiness: 5,
        decisions: [1, 2, 3, 4, 5].map((index) => decisionFixture(index)),
        active: questionFixture(6),
      },
    });
    const transcript = guideTranscript(brief);
    expect(transcript).toHaveLength(11);
    expect(transcript.map((message) => message.role)).toEqual([
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    // The order is the record's order, and the live question is last.
    expect(transcript[0]?.id).toBe("gq_1-a");
    expect(transcript[1]?.id).toBe("gq_1-u");
    expect(transcript[9]?.id).toBe("gq_5-u");
    expect(transcript[10]?.id).toBe("gq_6-a");
    expect(transcript[10]?.answerable).toBe(true);
    expect(transcript[10]?.options).toHaveLength(2);
    // Only the live turn can be answered: an old question is a record.
    expect(transcript.filter((message) => message.answerable)).toHaveLength(1);
  });

  it("renders those ten turns and no placeholder question", () => {
    const brief = briefFixture({
      guide: {
        complete: false,
        reason: "",
        limit: 7,
        minDecisions: 5,
        maxDecisions: 7,
        readiness: 5,
        decisions: [1, 2, 3, 4, 5].map((index) => decisionFixture(index)),
        active: questionFixture(6),
      },
    });
    const markup = render(brief);
    expect(markup.match(/data-testid="guide-msg-assistant"/g)).toHaveLength(6);
    expect(markup.match(/data-testid="guide-msg-user"/g)).toHaveLength(5);
    expect(markup).toContain("data-testid=\"guide-options\"");
    expect(markup).toContain("你希望比较的对象范围到哪里？");
    expect(markup).not.toContain("正在准备下一个问题");
  });
});

describe("C. the reader's own words are shown as they were said", () => {
  it("uses the recorded answer text, the labels, then the free text", () => {
    expect(answerTextOf(decisionFixture(1))).toBe("选型建议为主");
    expect(answerTextOf(decisionFixture(1, { answerText: "", freeText: "" }))).toBe("选型建议为主");
    expect(
      answerTextOf(
        decisionFixture(1, { answerText: "", selectedOptionLabels: [], freeText: "重点是索引与查询两段的成本口径。" }),
      ),
    ).toBe("重点是索引与查询两段的成本口径。");
  });

  it("shows a free answer verbatim in the reader's turn", () => {
    const brief = briefFixture({
      guide: {
        complete: false,
        reason: "",
        limit: 7,
        minDecisions: 5,
        maxDecisions: 7,
        readiness: 1,
        decisions: [
          decisionFixture(1, {
            answerText: "重点是索引与查询两段的成本口径，更新成本可以只作定性说明。",
            selectedOptionLabels: [],
            freeText: "重点是索引与查询两段的成本口径，更新成本可以只作定性说明。",
          }),
        ],
        active: null,
      },
    });
    expect(render(brief)).toContain("重点是索引与查询两段的成本口径，更新成本可以只作定性说明。");
  });
});

describe("D. the transition is Markdown, and never HTML", () => {
  it("renders emphasis in a leadIn through the one Markdown renderer", () => {
    const markup = render(briefFixture({
      guide: {
        complete: false,
        reason: "",
        limit: 7,
        minDecisions: 5,
        maxDecisions: 7,
        readiness: 0,
        decisions: [],
        active: questionFixture(1),
      },
    }));
    expect(markup).toContain("<strong>成本口径</strong>");
    expect(markup).toContain("rp-md");
  });

  it("does not turn a model's HTML into elements", () => {
    const markup = render(briefFixture({
      guide: {
        complete: false,
        reason: "",
        limit: 7,
        minDecisions: 5,
        maxDecisions: 7,
        readiness: 0,
        decisions: [],
        active: { ...questionFixture(1), leadIn: "<script>alert(1)</script>先定范围。" },
      },
    }));
    // Raw HTML is never an element, and never executable: the sanitizer's
    // default schema plus the absence of `rehype-raw` means the block is
    // dropped whole rather than parsed. The question it introduced still shows,
    // because a hostile transition is not allowed to take the panel down.
    expect(markup).not.toContain("<script");
    expect(markup).not.toContain("alert(1)");
    expect(markup).toContain("你希望比较的对象范围到哪里？");
  });
});

describe("E. the one state that recovers by itself, once", () => {
  const asked = (overrides: Partial<BriefView> = {}, busy = false, runs = 2): string | null =>
    guideStalled(
      briefFixture({
        guide: {
          complete: false,
          reason: "",
          limit: 7,
          minDecisions: 5,
          maxDecisions: 7,
          readiness: 2,
          decisions: [decisionFixture(1), decisionFixture(2)],
          active: null,
        },
        ...overrides,
      }),
      busy,
      runs,
    );

  it("is not the ordinary states a session passes through", () => {
    // Before anything has been asked: the panel offers to start, it does not retry.
    expect(guideStalled(briefFixture(), false, 0)).toBeNull();
    // A session whose only decisions came from the structured editor: readiness
    // is above zero, and still nothing has been asked, so still nothing to retry.
    expect(
      guideStalled(
        briefFixture({
          guide: { complete: false, reason: "", limit: 7, minDecisions: 5, maxDecisions: 7, readiness: 3, decisions: [], active: null },
        }),
        false,
        0,
      ),
    ).toBeNull();
    // While a question run is alive.
    expect(asked({}, true)).toBeNull();
    // With a question waiting to be answered.
    expect(
      guideStalled(
        briefFixture({
          guide: { complete: false, reason: "", limit: 7, minDecisions: 5, maxDecisions: 7, readiness: 2, decisions: [], active: questionFixture(3) },
        }),
        false,
        1,
      ),
    ).toBeNull();
    // When the application has closed the session.
    expect(
      guideStalled(
        briefFixture({
          guide: { complete: true, reason: "已经足够清楚", limit: 7, minDecisions: 5, maxDecisions: 7, readiness: 6, decisions: [], active: null },
        }),
        false,
        1,
      ),
    ).toBeNull();
  });

  it("recovers the very first question too, when its run ended without one", () => {
    // The draft already had decisions made in the structured editor — readiness
    // is 3 — and the first guided run was refused its early close and left no
    // question behind. The panel still has to notice, because the reader is
    // looking at a "preparing" line that will never finish.
    expect(
      guideStalled(
        briefFixture({
          guide: { complete: false, reason: "", limit: 7, minDecisions: 5, maxDecisions: 7, readiness: 3, decisions: [], active: null },
        }),
        false,
        1,
      ),
    ).toBe("task_1:3:3");
  });

  it("names the exact brief it was true for, so a retry cannot repeat", () => {
    const key = asked();
    expect(key).toBe("task_1:3:2");
    // A decision landed: this is a different situation and may be retried again.
    expect(asked({ version: 4 })).toBe("task_1:4:2");
  });

  it("recovers a session whose question run ended without a question", () => {
    const brief = briefFixture({
      guide: {
        complete: false,
        reason: "",
        limit: 7,
        minDecisions: 5,
        maxDecisions: 7,
        readiness: 2,
        decisions: [decisionFixture(1), decisionFixture(2)],
        active: null,
      },
    });
    const markup = render(brief);
    // The turns stay on screen while the panel recovers; nothing is invented.
    expect(markup).toContain("data-testid=\"guide-msg-user\"");
    expect(markup).toContain("data-testid=\"guide-transcript\"");
  });
});

describe("the two bounds the reader sees", () => {
  it("says how far below the floor the session is", () => {
    const early = guideProgress(briefFixture({
      guide: { complete: false, reason: "", limit: 7, minDecisions: 5, maxDecisions: 7, readiness: 3, decisions: [], active: questionFixture(4) },
    }));
    expect(early.label).toBe("关键决策 3 / 至少 5");
    expect(early.reached).toBe(false);
    expect(early.note).toContain("不能自作主张结束");
  });

  it("says both ways out once the floor is reached, and names the ceiling", () => {
    const enough = guideProgress(briefFixture({
      guide: { complete: false, reason: "", limit: 7, minDecisions: 5, maxDecisions: 7, readiness: 5, decisions: [], active: questionFixture(6) },
    }));
    expect(enough.label).toBe("关键决策 5");
    expect(enough.reached).toBe(true);
    expect(enough.note).toContain("可以开始研究");
    expect(enough.note).toContain("继续完善");

    const ceiling = guideProgress(briefFixture({
      guide: { complete: true, reason: "够了", limit: 7, minDecisions: 5, maxDecisions: 7, readiness: 7, decisions: [], active: null },
    }));
    expect(ceiling.atCeiling).toBe(true);
    expect(ceiling.note).toContain("上限");
  });
});

describe("the reader's own way out", () => {
  it("is open at any depth, and closed with the reason when the draft is not valid", () => {
    const deep = briefFixture({
      guide: { complete: false, reason: "", limit: 7, minDecisions: 5, maxDecisions: 7, readiness: 2, decisions: [decisionFixture(1)], active: questionFixture(2) },
    });
    expect(guideConfirmState(deep).enabled).toBe(true);

    const invalid = briefFixture({
      canConfirm: false,
      validation: { valid: false, problems: ["比较对象至少需要 1 个（当前 0 个）"] },
    });
    expect(guideConfirmState(invalid)).toEqual({
      enabled: false,
      reason: "还不能开始：比较对象至少需要 1 个（当前 0 个）",
    });
    expect(render(invalid)).toContain("data-testid=\"guide-confirm-why\"");
  });
});

describe("the closing turn", () => {
  const closed = briefFixture({
    guide: {
      complete: true,
      reason: "目前的研究方案已经比较完整：对象、比较维度、重点与读者都已经确定。",
      limit: 7,
      minDecisions: 5,
      maxDecisions: 7,
      readiness: 5,
      decisions: [decisionFixture(1)],
      active: null,
    },
  });

  it("says the plan is complete instead of showing an empty page", () => {
    const markup = render(closed);
    expect(markup).toContain("目前的研究方案已经比较完整");
    expect(markup).toContain("data-testid=\"guide-complete\"");
    expect(markup).toContain("data-testid=\"guide-confirm-done\"");
    expect(markup).toContain("2 个比较对象");
    expect(markup).toContain("3 个研究维度");
  });

  it("summarises the plan from the brief itself", () => {
    expect(guideSummaryItems(closed)).toEqual(["2 个比较对象", "3 个研究维度", "篇幅 约 4 页", "读者：给组会用"]);
  });
});

describe("the idle state", () => {
  it("introduces the session with what the brief already has", () => {
    const markup = render(briefFixture());
    expect(markup).toContain("data-testid=\"guide-idle\"");
    expect(markup).toContain("当前这份简报已经有 2 个比较对象、3 个研究维度");
    expect(markup).not.toContain("data-testid=\"guide-transcript\"");
  });
});
