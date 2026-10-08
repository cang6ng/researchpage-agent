/**
 * Intent Discovery: the user decides the research topic, not the model.
 *
 * The product used to take a seed topic and let the model declare a full
 * research题目 in the same breath — and the user was then asked to fill in
 * information about a decision they never made. These cases are the contract
 * that replaced it: a conversation with a real record, a direction that stays a
 * proposal, and a confirmation that only a user action can perform.
 *
 * Everything here is the real service on a real SQLite repository. There is no
 * model in this file at all: what is under test is what the product lets a model
 * do, and the answer it gives when it tries to do more.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createResearchService, openResearchRepository, type ResearchService } from "@every-dagent/plugin-research";
import { asksForDirection, nextGuideTarget } from "@every-dagent/plugin-research";

const workDir = mkdtempSync(join(tmpdir(), "researchpage-intent-"));
let opened: ResearchService[] = [];

function service(): ResearchService {
  const instance = createResearchService({ repo: openResearchRepository({ location: ":memory:" }) });
  opened.push(instance);
  return instance;
}

afterEach(() => {
  opened = [];
});

/** A session with a card grant: what the card stage runs under. */
function cardSession(input: { readonly service: ResearchService; readonly sessionId: string }): void {
  input.service.issueGrant({ sessionId: input.sessionId, intent: "card", taskId: null });
}

/** A session with an intent grant: what the conversation stage runs under. */
function intentSession(input: { readonly service: ResearchService; readonly sessionId: string }): void {
  input.service.issueGrant({ sessionId: input.sessionId, intent: "intent", taskId: null });
}

const CARD = {
  topic: "模型自己写的题目",
  purpose: "模型自己写的目的",
  audience: "研究生",
  focus: [],
  exclusions: "",
  lengthTarget: "约 4 页",
  subjects: [{ name: "A" }, { name: "B" }],
  dimensions: [
    { name: "机制", question: "如何工作？" },
    { name: "成本", question: "成本如何？" },
    { name: "更新", question: "如何更新？" },
  ],
};

describe("a seed topic stays a conversation until the user settles it", () => {
  it("A. creating an exploration creates no task, no proposal and no confirmed direction", () => {
    const app = service();
    const created = app.createIntent("s_1", { seedTopic: "Transformer" });
    expect(created.ok).toBe(true);
    if (created.ok !== true) return;
    expect(created.created).toBe(true);
    expect(created.intent.status).toBe("exploring");
    expect(created.intent.seedTopic).toBe("Transformer");
    expect(created.intent.proposal).toBeNull();
    expect(created.intent.confirmedDirection).toBeNull();
    expect(created.intent.taskId).toBeNull();
    expect(app.taskForSession("s_1")).toBeUndefined();
  });

  it("B. the conversation records what the assistant asked and what it understood", () => {
    const app = service();
    const created = app.createIntent("s_2", { seedTopic: "Transformer" });
    if (created.ok !== true) throw new Error("intent refused");
    const intentId = created.intent.intentId;
    cardSession({ service: app, sessionId: "s_2" });
    intentSession({ service: app, sessionId: "s_2" });

    const asked = app.recordIntentQuestion("s_2", {
      question: "你想用它回答什么？",
      whyThisMatters: "它决定检索方向与比较框架。",
      options: ["搞清原理", "工程选型", "写综述"],
      decisions: [],
    });
    expect(asked.ok).toBe(true);
    if (asked.ok !== true) return;
    expect(asked.intent.status).toBe("exploring");
    expect(asked.intent.assistantQuestions).toEqual(["你想用它回答什么？"]);
    expect(asked.intent.pending?.options).toEqual(["搞清原理", "工程选型", "写综述"]);

    const answered = app.submitIntentMessage(intentId, { text: "用于部署选型，关心推理成本" });
    expect(answered.ok).toBe(true);
    if (answered.ok !== true) return;
    expect(answered.intent.userMessages).toEqual(["用于部署选型，关心推理成本"]);
    expect(answered.intent.pending).toBeNull();

    // A decision quotes the user's own words; it is not a summary with no source.
    const second = app.recordIntentQuestion("s_2", {
      question: "在哪些方面需要边界？",
      decisions: [{ field: "purpose", value: "用于部署选型，关心推理成本", basedOn: "用于部署选型，关心推理成本" }],
    });
    if (second.ok !== true) throw new Error("second question refused");
    expect(second.intent.decisions).toHaveLength(1);
    expect(second.intent.decisions[0]?.basedOn).toBe("用于部署选型，关心推理成本");
    expect(second.intent.decisions[0]?.field).toBe("purpose");
  });

  it("C. a proposed direction is a proposal: it does not become the research topic", () => {
    const app = service();
    const created = app.createIntent("s_3", { seedTopic: "Transformer" });
    if (created.ok !== true) throw new Error("intent refused");
    intentSession({ service: app, sessionId: "s_3" });

    const proposed = app.proposeIntentDirection("s_3", {
      topic: "长上下文模型在推理成本上的比较",
      purpose: "为部署选型提供技术判断",
      scope: "比较三类模型在长上下文下的推理成本与工程代价",
      summary: "我理解你的研究方向是：为部署选型比较长上下文模型的推理成本。",
      subjects: [{ name: "Transformer" }, { name: "Mamba" }],
      dimensions: [{ name: "成本", question: "推理成本如何？" }],
    });
    expect(proposed.ok).toBe(true);
    if (proposed.ok !== true) return;
    expect(proposed.intent.status).toBe("ready_to_confirm");
    expect(proposed.intent.proposal?.topic).toBe("长上下文模型在推理成本上的比较");
    expect(proposed.intent.confirmedDirection).toBeNull();
    expect(proposed.intent.canConfirm).toBe(true);
    expect(proposed.intent.confirmQuestion).toContain("是否准确");
    // The four things the user is asked to confirm are all there.
    expect(proposed.intent.proposalSummary).toContain("题目：");
    expect(proposed.intent.proposalSummary).toContain("目的：");
    expect(proposed.intent.proposalSummary).toContain("范围：");
    // And the fields this direction leaves open are named, so guided planning
    // knows what is still worth asking about.
    expect(proposed.intent.openFields).toContain("audience");

    // Still nothing official after a proposal.
    expect(app.taskForSession("s_3")).toBeUndefined();
    expect(app.intentForSession("s_3")?.confirmedDirection).toBeNull();
  });

  it("D. only the user's confirmation writes confirmedDirection", () => {
    const app = service();
    const created = app.createIntent("s_4", { seedTopic: "Transformer" });
    if (created.ok !== true) throw new Error("intent refused");
    const intentId = created.intent.intentId;
    intentSession({ service: app, sessionId: "s_4" });

    // Nothing to confirm yet: the product asks 「我理解你的研究方向是……」about
    // something it has actually proposed.
    const early = app.confirmIntentDirection(intentId, {});
    expect(early.ok).toBe(false);
    if (early.ok !== false) return;
    expect(early.problems.join("")).toContain("还没有可以确认的研究方向");

    app.proposeIntentDirection("s_4", {
      topic: "题目 A",
      purpose: "目的 A",
      scope: "范围 A",
      summary: "我理解你的研究方向是 A。",
    });
    const confirmed = app.confirmIntentDirection(intentId, {});
    expect(confirmed.ok).toBe(true);
    if (confirmed.ok !== true) return;
    expect(confirmed.intent.status).toBe("confirmed");
    expect(confirmed.intent.confirmedDirection?.topic).toBe("题目 A");
    expect(confirmed.intent.confirmedAt).not.toBeNull();

    // Confirming twice is not an error and does not rewrite anything.
    const again = app.confirmIntentDirection(intentId, {});
    if (again.ok !== true) throw new Error("second confirmation refused");
    expect(again.note).toContain("此前已经确认");
    expect(again.direction.topic).toBe("题目 A");

    // And the conversation is closed to the model afterwards.
    const late = app.recordIntentQuestion("s_4", { question: "还有什么？" });
    expect(late.ok).toBe(false);
    const lateProposal = app.proposeIntentDirection("s_4", {
      topic: "题目 B",
      purpose: "目的 B",
      scope: "范围 B",
      summary: "我理解你的研究方向是 B。",
    });
    expect(lateProposal.ok).toBe(false);
  });

  it("E. a write against a stale conversation is refused, not applied", () => {
    const app = service();
    const created = app.createIntent("s_5", { seedTopic: "Transformer" });
    if (created.ok !== true) throw new Error("intent refused");
    const intentId = created.intent.intentId;
    intentSession({ service: app, sessionId: "s_5" });
    const version = created.intent.version;

    const first = app.submitIntentMessage(intentId, { text: "第一条", expectedVersion: version });
    expect(first.ok).toBe(true);

    const stale = app.submitIntentMessage(intentId, { text: "第二条", expectedVersion: version });
    expect(stale.ok).toBe(false);
    if (stale.ok !== false) return;
    expect("stale" in stale && stale.stale).toBe(true);
    expect(stale.problems.join("")).toContain("已经更新到版本");
    const view = app.intentViewOf(intentId);
    expect(view?.userMessages).toEqual(["第一条"]);
  });

  it("F. a new question retires the direction that was on the table", () => {
    const app = service();
    const created = app.createIntent("s_6", { seedTopic: "Transformer" });
    if (created.ok !== true) throw new Error("intent refused");
    intentSession({ service: app, sessionId: "s_6" });
    app.proposeIntentDirection("s_6", {
      topic: "题目 A",
      purpose: "目的 A",
      scope: "范围 A",
      summary: "我理解你的研究方向是 A。",
    });
    const asked = app.recordIntentQuestion("s_6", { question: "那我再确认一件事：你更关心训练还是推理成本？" });
    if (asked.ok !== true) throw new Error("question refused");
    expect(asked.intent.status).toBe("exploring");
    expect(asked.intent.proposal).toBeNull();
    // The record keeps the turn that carried it: history is not rewritten.
    expect(asked.intent.turns.some((turn) => turn.proposesDirection === true)).toBe(true);
  });

  it("G. an unconfirmed exploration cannot produce a task card", () => {
    const app = service();
    app.createIntent("s_7", { seedTopic: "Transformer" });
    cardSession({ service: app, sessionId: "s_7" });
    const refused = app.proposeTask("s_7", CARD);
    expect(refused.ok).toBe(false);
    if (refused.ok !== false) return;
    expect(refused.problems.join("")).toContain("确认研究方向");
    expect(app.taskForSession("s_7")).toBeUndefined();

    intentSession({ service: app, sessionId: "s_7" });
    app.proposeIntentDirection("s_7", {
      topic: "题目 A",
      purpose: "目的 A",
      scope: "范围 A",
      summary: "我理解你的研究方向是 A。",
    });
    // A proposal is still not a confirmation.
    const stillRefused = app.proposeTask("s_7", CARD);
    expect(stillRefused.ok).toBe(false);
    expect(app.taskForSession("s_7")).toBeUndefined();

    const intentId = app.intentForSession("s_7")?.intentId ?? "";
    app.confirmIntentDirection(intentId, {});
    // Confirmation hands over to the card stage, which runs under its own grant
    // — the conversation's grant cannot build a card.
    cardSession({ service: app, sessionId: "s_7" });
    const created = app.proposeTask("s_7", CARD);
    expect(created.ok).toBe(true);
    if (created.ok !== true) return;
    expect(created.task.topic).toBe("题目 A");
  });
});

describe("the card is built inside the confirmed direction", () => {
  function confirmed(input: {
    readonly app: ResearchService;
    readonly sessionId: string;
    readonly direction: Record<string, unknown>;
  }): string {
    const created = input.app.createIntent(input.sessionId, { seedTopic: "Transformer" });
    if (created.ok !== true) throw new Error("intent refused");
    intentSession({ service: input.app, sessionId: input.sessionId });
    const proposed = input.app.proposeIntentDirection(input.sessionId, input.direction);
    if (proposed.ok !== true) throw new Error(JSON.stringify(proposed));
    const confirmed = input.app.confirmIntentDirection(created.intent.intentId, {});
    if (confirmed.ok !== true) throw new Error("confirmation refused");
    cardSession({ service: input.app, sessionId: input.sessionId });
    return created.intent.intentId;
  }

  it("H. the topic and purpose are the user's, and a later proposal cannot overwrite them", () => {
    const app = service();
    confirmed({
      app,
      sessionId: "s_8",
      direction: {
        topic: "长上下文模型的推理成本比较",
        purpose: "为部署选型提供技术判断",
        scope: "比较三类模型在长上下文下的推理成本",
        summary: "我理解你的研究方向是：为部署选型比较推理成本。",
        audience: "架构组",
        exclusions: "不做训练成本比较",
      },
    });
    const created = app.proposeTask("s_8", CARD);
    if (created.ok !== true) throw new Error("card refused");
    const task = created.task;
    expect(task.topic).toBe("长上下文模型的推理成本比较");
    expect(task.purpose).toBe("为部署选型提供技术判断");
    expect(task.audience).toBe("架构组");
    expect(task.exclusions).toBe("不做训练成本比较");
    expect(task.intent?.confirmedAt).toBe(task.intent?.direction.at ?? "");
    expect(task.intent?.seedTopic).toBe("Transformer");

    // A second proposal in the same stage — the model trying again — still
    // cannot rename what the user confirmed.
    const again = app.proposeTask("s_8", { ...CARD, topic: "另一个题目", purpose: "另一个目的" });
    if (again.ok !== true) throw new Error("second proposal refused");
    expect(again.task.topic).toBe("长上下文模型的推理成本比较");
    expect(again.task.purpose).toBe("为部署选型提供技术判断");
  });

  it("I. the fields the confirmation settled are decided; the rest stay suggestions", () => {
    const app = service();
    confirmed({
      app,
      sessionId: "s_9",
      direction: {
        topic: "题目",
        purpose: "目的",
        scope: "范围",
        summary: "我理解你的研究方向是……",
        subjects: [{ name: "Alpha" }, { name: "Beta" }],
        dimensions: [
          { name: "成本", question: "成本如何？" },
          { name: "机制", question: "如何工作？" },
          { name: "更新", question: "如何更新？" },
        ],
      },
    });
    const created = app.proposeTask("s_9", CARD);
    if (created.ok !== true) throw new Error("card refused");
    const brief = app.briefOf(created.task.id);
    expect(brief.fieldStates.topic).toBe("confirmed");
    expect(brief.fieldStates.purpose).toBe("confirmed");
    expect(brief.fieldStates.audience).toBe("suggested");
    // Objects and dimensions the direction *suggested* are kept — they were part
    // of what the user read — but they are not claims of a user decision.
    expect(brief.fieldStates.subjects).toBe("suggested");
    expect(brief.fieldStates.dimensions).toBe("suggested");
    expect(brief.subjects.map((subject) => subject.name)).toEqual(["Alpha", "Beta"]);
    expect(created.task.matrix).toHaveLength(6);
  });

  it("J. guided planning does not ask again what the confirmation settled", () => {
    const app = service();
    confirmed({
      app,
      sessionId: "s_10",
      direction: {
        topic: "题目",
        purpose: "目的",
        scope: "范围",
        summary: "我理解你的研究方向是……",
        audience: "架构组",
        focus: ["推理成本"],
        subjects: [{ name: "Alpha" }, { name: "Beta" }],
      },
    });
    const created = app.proposeTask("s_10", CARD);
    if (created.ok !== true) throw new Error("card refused");
    const brief = app.briefOf(created.task.id);
    // Three fields were settled by the confirmation: purpose, audience, focus.
    expect(brief.guide.readiness).toBeGreaterThanOrEqual(3);
    const target = nextGuideTarget({ task: created.task, answered: 0 });
    expect(target?.field).toBe("subjects");
    expect(target?.field).not.toBe("purpose");
    expect(target?.field).not.toBe("audience");
    expect(target?.currentValue).toContain("Alpha");

    // The two questionnaires do not stack: the confirmation's decisions count
    // towards the same floor the guide is held to.
    expect(brief.guide.minDecisions).toBe(5);
    const sequence: string[] = [];
    let answered = 0;
    for (;;) {
      const next = nextGuideTarget({ task: created.task, answered });
      if (next === undefined) break;
      sequence.push(next.field);
      answered += 1;
    }
    expect(sequence).not.toContain("purpose");
    expect(sequence).not.toContain("audience");
    expect(sequence).not.toContain("focus");
    // The settled fields plus the remaining questions reach the guide's floor.
    expect(3 + sequence.length).toBeGreaterThanOrEqual(5);
  });

  it("K. without an exploration the legacy path is unchanged", () => {
    const app = service();
    cardSession({ service: app, sessionId: "s_11" });
    const created = app.proposeTask("s_11", CARD);
    if (created.ok !== true) throw new Error("card refused");
    const brief = app.briefOf(created.task.id);
    expect(created.task.topic).toBe(CARD.topic);
    expect(created.task.intent ?? null).toBeNull();
    expect(brief.fieldStates.purpose).toBe("suggested");
    expect(brief.guide.readiness).toBe(0);
  });
});

describe("the conversation survives a restart", () => {
  it("M. once the user asks for a direction, asking again is refused", () => {
    const app = service();
    const created = app.createIntent("s_13", { seedTopic: "Transformer" });
    if (created.ok !== true) throw new Error("intent refused");
    intentSession({ service: app, sessionId: "s_13" });
    app.recordIntentQuestion("s_13", { question: "你想理解什么？" });
    app.submitIntentMessage(created.intent.intentId, { text: "可以了，请给出正式的研究方向。" });

    // The markers are the product's reading of「用户要方向了」, and they are few
    // and readable on purpose.
    expect(asksForDirection("可以了，请给出正式的研究方向。")).toBe(true);
    expect(asksForDirection("别再问了，直接给个方向")).toBe(true);
    expect(asksForDirection("确认方向")).toBe(true);
    expect(asksForDirection("我想比较三种架构的成本")).toBe(false);
    expect(asksForDirection("")).toBe(false);

    const refused = app.recordIntentQuestion("s_13", { question: "那再确认一个细节？" });
    expect(refused.ok).toBe(false);
    if (refused.ok !== false) return;
    expect(refused.problems.join("")).toContain("用户已经明确要求你给出研究方向");
    expect(refused.guidance).toContain("propose_research_direction");
    // Nothing was recorded by the refused call, and the model can still comply.
    expect(app.intentForSession("s_13")?.assistantQuestions).toHaveLength(1);
    const proposed = app.proposeIntentDirection("s_13", {
      topic: "长上下文推理成本比较",
      purpose: "部署选型",
      scope: "比较三类模型的长上下文推理成本",
      summary: "我理解你的研究方向是为部署选型比较长上下文推理成本。",
    });
    expect(proposed.ok).toBe(true);
  });

  it("L. the exploration and its turns are read back from the database", () => {
    const location = join(workDir, "intent-persistence.db");
    const first = openResearchRepository({ location });
    const appA = createResearchService({ repo: first });
    const created = appA.createIntent("s_12", { seedTopic: "Transformer" });
    if (created.ok !== true) throw new Error("intent refused");
    appA.issueGrant({ sessionId: "s_12", intent: "intent", taskId: null });
    appA.recordIntentQuestion("s_12", { question: "你想理解什么？" });
    appA.submitIntentMessage(created.intent.intentId, { text: "推理成本" });
    first.close();

    const second = openResearchRepository({ location });
    const appB = createResearchService({ repo: second });
    const restored = appB.intentForSession("s_12");
    expect(restored?.intentId).toBe(created.intent.intentId);
    expect(restored?.seedTopic).toBe("Transformer");
    expect(restored?.userMessages).toEqual(["推理成本"]);
    expect(restored?.assistantQuestions).toEqual(["你想理解什么？"]);
    second.close();
    rmSync(location, { force: true });
    rmSync(`${location}-wal`, { force: true });
    rmSync(`${location}-shm`, { force: true });
  });
});
