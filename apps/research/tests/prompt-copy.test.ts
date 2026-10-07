/**
 * What the product tells the model, and what it therefore cannot promise.
 *
 * Two instructions are checked here because both were places where the model
 * was free to say something the record would contradict.
 *
 * An Edit: saying「改成四段纯文字」changes a section's form, not its cognitive
 * duty — and the prompt has to say so, or a rewrite that drops the synthesis
 * judgement looks like obedience. The instruction names the target section's
 * obligation from the same blueprint the validator reads.
 *
 * A guide question: a free-text answer can carry information about several
 * brief fields at once, and only one is written. The prompt allows the model to
 * say it noticed the rest, and forbids claiming they were already changed —
 * verbal acknowledgement and the stored brief must not disagree.
 */

import { describe, expect, it } from "vitest";

import { createResearchTools } from "@every-dagent/plugin-research";
import { createResearchService } from "@every-dagent/plugin-research";
import { openResearchRepository } from "@every-dagent/plugin-research";
import { stageInstruction } from "../src/server/runner.js";
import type { ReportTask } from "@every-dagent/plugin-research";

function task(): ReportTask {
  const repo = openResearchRepository({ location: ":memory:" });
  const service = createResearchService({ repo, now: () => new Date("2026-10-08T09:00:00.000Z") });
  const session = "session_copy";
  service.issueGrant({ sessionId: session, intent: "card", taskId: null });
  const card = service.proposeTask(session, {
    topic: "两种图检索方法的比较",
    purpose: "组会汇报",
    audience: "研究生",
    focus: [],
    exclusions: "",
    lengthTarget: "约 4 页",
    subjects: [{ name: "A" }, { name: "B" }],
    dimensions: [
      { name: "核心思想", question: "解决什么问题" },
      { name: "结构与构建", question: "如何构建" },
      { name: "检索机制", question: "如何检索" },
    ],
  });
  if (!card.ok) throw new Error("card refused");
  service.confirmTask(card.task.id);
  const confirmed = service.getTask(card.task.id)!;
  repo.close();
  return confirmed;
}

describe("the Edit instruction keeps the section's obligation", () => {
  it("names the obligation of the section being rewritten", () => {
    const instruction = stageInstruction({
      stage: "edit",
      task: task(),
      instruction: "用户原话：不用表格，改成四段纯文字。",
      targetSectionId: "synthesis",
    });
    expect(instruction).toContain("内容义务");
    expect(instruction).toContain("综合");
    expect(instruction).toContain("改写的是表达形式，不是义务");
    // And it says what happens when the rewrite loses the obligation.
    expect(instruction).toContain("一次修正机会");
    expect(instruction).toContain("不要为了通过校验删掉义务");
  });

  it("says the same thing in the tool's own contract", () => {
    const repo = openResearchRepository({ location: ":memory:" });
    const tools = createResearchTools(createResearchService({ repo }));
    const edit = tools.tools.find((tool) => tool.name === "propose_section_edit")!;
    expect(edit.description).toContain("内容义务");
    expect(edit.description).toContain("综合判断");
    expect(edit.description).toContain("每一行的每一格");
    expect(edit.description).toContain("一次修正机会");
    repo.close();
  });
});

describe("the guide instruction does not over-promise", () => {
  it("allows noticing other fields but forbids claiming they were written", () => {
    const instruction = stageInstruction({
      stage: "guide",
      task: task(),
      guideTarget: {
        field: "audience",
        ask: "这份报告给谁看",
        whyItMatters: "读者背景决定解释深度",
        currentValue: "研究生",
      },
      answered: 1,
      recentDecisions: [],
    });
    expect(instruction).toContain("只写入 fieldTargets 指定的那一个字段");
    expect(instruction).toContain("我注意到你还提到了");
    expect(instruction).toContain("不要说「我已经把你刚才说的都改好了」");
  });
});
