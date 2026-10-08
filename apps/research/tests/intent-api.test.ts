/**
 * Intent Discovery over the product's real surface.
 *
 * The seed topic goes in, and what comes out has to be the user's decision:
 * a conversation with a real record, a direction that stays a proposal, and a
 * confirmation the user performs. These cases drive HTTP route → runner → host
 * run → tool → service → database, with a scripted model standing in for the
 * provider, and they are written as the scenarios the round is accepted on.
 *
 * The one thing each case checks is the boundary the old flow did not have:
 * nothing becomes the research topic until a person says it is.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelClient, ModelEvent, ModelMessage, ModelRequest, RuntimeContext } from "@every-dagent/agent-core";
import { DEFAULT_MODEL_FRAMING } from "@every-dagent/agent-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startResearchApp, type ResearchApp } from "../src/server/composition.js";
import { testComposition } from "../../../tests/helpers/test-composition.js";

/**
 * A case that drives real stages needs real time.
 *
 * Each turn is a host run started by the runner and polled to completion, so
 * the default 5s budget is not a statement about the product.
 */
function slow(name: string, body: () => Promise<void>): void {
  it(name, body, 60_000);
}

const workDir = mkdtempSync(join(tmpdir(), "researchpage-intent-api-"));
const dataDir = join(workDir, "data");
const staticRoot = join(process.cwd(), "apps", "research", "public");

const DOCUMENT = [
  "# 长上下文部署笔记",
  "",
  "我们在生产环境里测量过 prefill 与 decode 的延迟，关注的是单位请求成本而不是峰值吞吐。",
  "",
  "## 观察",
  "",
  "上下文从 8k 增到 128k 时，prefill 成本的增长明显快于 decode。",
].join("\n");

function instructionOf(messages: readonly ModelMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return message.text;
  }
  return "";
}

function toolResultsOf(messages: readonly ModelMessage[]): readonly { readonly name: string; readonly value: Record<string, unknown> }[] {
  let start = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      start = index + 1;
      break;
    }
  }
  const views: { name: string; value: Record<string, unknown> }[] = [];
  for (const message of messages.slice(start)) {
    if (message.role !== "tool") continue;
    for (const result of message.results) {
      try {
        views.push({ name: result.name, value: JSON.parse(result.content) as Record<string, unknown> });
      } catch {
        // Not one of ours.
      }
    }
  }
  return views;
}

function next(events: readonly ModelEvent[]): AsyncIterable<ModelEvent> {
  return (async function* () {
    for (const event of events) yield event;
  })();
}

/** How many times the user has spoken, read off the instruction's transcript. */
function answersIn(instruction: string): number {
  return (instruction.match(/^用户：/gm) ?? []).length;
}

/**
 * The seed topic the instruction carries, and nothing else.
 *
 * The instruction quotes an example of a fully-specified request, so a script
 * that searched the whole instruction for「部署选型」would find its own example
 * and skip the conversation. What the user actually typed is between the quotes.
 */
function seedTopicOf(instruction: string): string {
  return /用户最初的输入："""([\s\S]*?)"""/.exec(instruction)?.[1] ?? "";
}

/**
 * A model that holds the conversation the way the stage instruction asks.
 *
 * A vague seed gets two real questions before a direction; a seed that already
 * states its purpose, objects and scope gets a direction immediately; and the
 * card it writes afterwards deliberately disagrees with the confirmed direction
 * so the case can prove which one wins.
 */
function scriptedModel(instructions: string[]): ModelClient {
  let step = 0;
  return {
    limits: { contextWindow: 128 * 1024, maxOutputTokens: 8 * 1024, framing: DEFAULT_MODEL_FRAMING },
    stream(request: ModelRequest, _context: RuntimeContext): AsyncIterable<ModelEvent> {
      step += 1;
      const instruction = instructionOf(request.messages);
      instructions.push(instruction);
      const results = toolResultsOf(request.messages);
      const call = (name: string, input: unknown): readonly ModelEvent[] => [
        { type: "tool-call", call: { callId: `call-${step}-${name}`, name, input } },
        { type: "done" },
      ];
      const say = (text: string): readonly ModelEvent[] => [{ type: "text-delta", text }, { type: "done" }];

      if (instruction.includes("请为用户的研究主题建立研究任务卡")) {
        if (results.some((result) => result.name === "propose_task")) return next(say("任务卡已提交。"));
        return next(
          call("propose_task", {
            // Deliberately different from any confirmed direction: the service
            // must keep the user's topic, and this case checks that it does.
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
          }),
        );
      }

      if (!instruction.includes("这是一段对话，不是问卷")) return next(say("这个脚本只服务意图探索与任务卡阶段。"));

      for (const result of results) {
        if (result.value["ok"] === false) refusals.push(`${result.name}: ${String(result.value["problems"] ?? result.value["problem"] ?? "")}`);
      }
      if (results.some((result) => result.name === "ask_intent_question" || result.name === "propose_research_direction")) {
        return next(say("已记录，本轮到此结束。"));
      }
      // The user asked for the direction: this script tries to keep asking
      // first, on purpose, so the case can prove the server refuses it and the
      // product's own retry gets the direction out of the model anyway.
      if ((instruction.match(/^用户：(.*)$/gm) ?? []).some((line) => line.includes("请给出正式的研究方向"))) {
        if (instruction.includes("第二次尝试")) {
          return next(
            call("propose_research_direction", {
              topic: "长上下文推理成本比较",
              purpose: "为部署选型判断推理成本",
              scope: "比较两类模型在长上下文下的推理成本",
              summary: "我理解你要为部署选型比较长上下文推理成本。",
              subjects: [{ name: "Transformer" }, { name: "Mamba" }],
            }),
          );
        }
        return next(call("ask_intent_question", { question: "那再确认一个细节好吗？" }));
      }

      // A user who asks to be understood again gets a new proposal, not a
      // rewrite of the one they had.
      if (instruction.includes("重新理解")) {
        return next(
          call("propose_research_direction", {
            topic: "部署视角下的长上下文推理成本",
            purpose: "为部署选型判断单位请求成本",
            scope: "以生产观测为材料，比较长上下文下的 prefill 与 decode 成本",
            summary: "我理解你想从部署观测出发，重新确定成本口径。",
            subjects: [{ name: "Transformer" }, { name: "Mamba" }],
          }),
        );
      }

      // An explicit seed: summarize and ask for confirmation at once.
      if (seedTopicOf(instruction).includes("部署选型") && answersIn(instruction) === 0) {
        return next(
          call("propose_research_direction", {
            topic: "Transformer、Mamba 与 RWKV 的长上下文推理成本比较",
            purpose: "为部署选型判断三者在长上下文下的推理成本特点",
            scope: "比较三者在意向上下文长度下的 prefill / decode 成本与工程代价",
            summary: "我理解你要比较三种架构在长上下文推理成本上的特点，用于部署选型。",
            audience: "架构与部署团队",
            subjects: [{ name: "Transformer" }, { name: "Mamba" }, { name: "RWKV" }],
            dimensions: [
              { name: "推理成本", question: "长上下文下的推理成本如何？" },
              { name: "机制", question: "为什么成本不同？" },
              { name: "部署条件", question: "在什么条件下更划算？" },
            ],
          }),
        );
      }

      const answers = answersIn(instruction);
      if (answers === 0) {
        return next(
          call("ask_intent_question", {
            question: "你想用这个主题回答什么问题？",
            whyThisMatters: "它决定检索方向、比较框架与结论的写法。",
            options: ["搞清原理", "工程选型", "写综述"],
            decisions: [],
          }),
        );
      }
      if (answers === 1) {
        return next(
          call("ask_intent_question", {
            question: "在这些方面里，哪些必须写进结论、哪些可以先排除？",
            whyThisMatters: "边界决定检索不去做什么。",
            options: ["只看推理阶段成本", "只看训练成本"],
            decisions: [
              {
                field: "focus",
                value: "关注长上下文推理成本与部署取舍",
                basedOn: "我想比较长上下文模型的推理成本，用于部署选型",
              },
            ],
          }),
        );
      }
      return next(
        call("propose_research_direction", {
          topic: "长上下文模型的推理成本比较",
          purpose: "为部署选型判断推理阶段成本",
          scope: "比较两类模型在长上下文下的推理成本，只看推理阶段",
          summary: "我理解你的研究方向是：为部署选型比较长上下文推理成本，且只看推理阶段。",
          subjects: [{ name: "Transformer" }, { name: "Mamba" }],
          dimensions: [
            { name: "推理成本", question: "推理成本如何？" },
            { name: "机制", question: "成本差异从何而来？" },
            { name: "条件", question: "什么条件下更划算？" },
          ],
        }),
      );
    },
  };
}

let app: ResearchApp;
let instructions: string[] = [];
/** Refusals the scripted model saw, so a case can prove a rule fired. */
let refusals: string[] = [];

beforeAll(async () => {
  instructions.length = 0;
  app = await startResearchApp({
    dataDir,
    staticRoot,
    composition: testComposition({ modelClient: scriptedModel(instructions) }),
    overrides: {
      search: () => Promise.reject(new Error("this test never searches")),
      read: () => Promise.reject(new Error("this test never reads the network")),
    },
    log: () => undefined,
  });
});

afterAll(async () => {
  await app.close();
  rmSync(workDir, { recursive: true, force: true });
});

interface Response {
  readonly status: number;
  readonly json: Record<string, unknown>;
}

async function post(path: string, body: unknown): Promise<Response> {
  const response = await fetch(`${app.pageOrigin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

async function get(path: string): Promise<Response> {
  const response = await fetch(`${app.pageOrigin}${path}`);
  const text = await response.text();
  return { status: response.status, json: text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

/**
 * The exploration's version, read from the server rather than assumed.
 *
 * The POST response describes the *new* exploration, not its view: the version
 * a writer must state is the one the server currently holds.
 */
async function versionOf(intentId: string): Promise<number> {
  const state = await intentState(intentId);
  return state?.version ?? 0;
}

/**
 * Sends one answer, waiting for the previous turn to finish first.
 *
 * The runner runs one stage at a time and refuses a second message for the same
 * conversation while the first is in flight — which is the product's own rule,
 * so the test waits rather than racing it.
 */
async function sendMessage(intentId: string, body: Record<string, unknown>): Promise<Response> {
  await waitUntil(async () => {
    const response = await get(`/api/research/intents/${intentId}`);
    return response.json["busy"] === false;
  }, "the previous turn to settle");
  return post(`/api/research/intents/${intentId}/messages`, body);
}

async function waitUntil(predicate: () => Promise<boolean>, what: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });
  }
}

interface IntentShape {
  readonly intentId: string;
  readonly status: string;
  readonly proposal: { readonly topic: string } | null;
  readonly confirmedDirection: { readonly topic: string; readonly purpose: string } | null;
  readonly userMessages: readonly string[];
  readonly assistantQuestions: readonly string[];
  readonly turns: readonly { readonly role: string; readonly text: string; readonly proposesDirection?: boolean }[];
  readonly pending: { readonly text: string; readonly options: readonly string[]; readonly proposesDirection: boolean } | null;
  readonly openFields: readonly string[];
  readonly documents: readonly { readonly documentId: string; readonly originalFilename: string }[];
  readonly taskId: string | null;
  readonly version: number;
}

async function intentState(intentId: string): Promise<IntentShape | null> {
  const response = await get(`/api/research/intents/${intentId}`);
  if (response.status !== 200) return null;
  return response.json["intent"] as IntentShape;
}

async function waitForIntent(intentId: string, predicate: (state: IntentShape) => boolean, what: string): Promise<IntentShape> {
  let found: IntentShape | null = null;
  await waitUntil(async () => {
    const state = await intentState(intentId);
    if (state === null) return false;
    if (!predicate(state)) return false;
    found = state;
    return true;
  }, what);
  if (found === null) throw new Error(`no state for ${what}`);
  return found;
}

async function taskOfSession(sessionId: string): Promise<Record<string, unknown> | null> {
  const response = await get(`/api/research/sessions/${sessionId}`);
  const task = response.json["task"];
  return typeof task === "object" && task !== null ? (task as Record<string, unknown>) : null;
}

describe("Scenario A — a vague seed becomes a question, not a题目", () => {
  let intentId = "";
  let sessionId = "";

  slow("starts an exploration instead of a task", async () => {
    const created = await post("/api/research/intents", { seedTopic: "Transformer" });
    expect(created.status).toBe(202);
    expect(created.json["created"]).toBe(true);
    intentId = created.json["intentId"] as string;
    sessionId = created.json["sessionId"] as string;
    expect(intentId.startsWith("itn_")).toBe(true);
    // No task exists, and none can: the topic is not decided.
    expect(await taskOfSession(sessionId)).toBeNull();
  });

  slow("asks a real question rather than declaring a research topic", async () => {
    const state = await waitForIntent(intentId, (value) => value.pending !== null, "the first question");
    expect(state.status).toBe("exploring");
    expect(state.proposal).toBeNull();
    expect(state.confirmedDirection).toBeNull();
    expect(state.userMessages).toEqual([]);
    expect(state.pending?.proposesDirection).toBe(false);
    expect(state.pending?.text.length).toBeGreaterThan(4);
    expect(state.pending?.options.length).toBeGreaterThan(1);
    expect(await taskOfSession(sessionId)).toBeNull();
  });

  slow("takes at least two real answers before offering a direction", async () => {
    const first = await sendMessage(intentId, { text: "我想比较长上下文模型的推理成本，用于部署选型" });
    expect(first.status).toBe(202);
    const afterFirst = await waitForIntent(intentId, (value) => value.userMessages.length === 1 && value.pending !== null, "the second question");
    expect(afterFirst.proposal).toBeNull();
    expect(afterFirst.assistantQuestions.length).toBe(2);
    // The second question builds on the first answer instead of restarting.
    expect(afterFirst.turns[1]?.text).toContain("部署选型");

    const second = await sendMessage(intentId, { text: "只看推理阶段成本，不做训练成本" });
    expect(second.status).toBe(202);
    const proposed = await waitForIntent(intentId, (value) => value.proposal !== null, "the direction proposal");
    expect(proposed.userMessages).toHaveLength(2);
    expect(proposed.status).toBe("ready_to_confirm");
    expect(proposed.proposal?.topic).toBe("长上下文模型的推理成本比较");
    // Still nothing official, and nothing was built from the proposal.
    expect(proposed.confirmedDirection).toBeNull();
    expect(await taskOfSession(sessionId)).toBeNull();
    expect(app.repository.listTasks().filter((task) => task.sessionId === sessionId)).toHaveLength(0);
  });

  slow("refuses to build a card while the direction is only proposed", async () => {
    // The card stage's own tool, run against this session, is refused by name.
    const before = app.service.intentForSession(sessionId);
    expect(before?.confirmedDirection).toBeNull();
    app.service.issueGrant({ sessionId, intent: "card", taskId: null });
    const refused = app.service.proposeTask(sessionId, {
      topic: "偷跑的题目",
      purpose: "偷跑",
      audience: "无",
      focus: [],
      exclusions: "",
      lengthTarget: "约 4 页",
      subjects: [{ name: "A" }, { name: "B" }],
      dimensions: [
        { name: "一", question: "一？" },
        { name: "二", question: "二？" },
        { name: "三", question: "三？" },
      ],
    });
    expect(refused.ok).toBe(false);
    expect(await taskOfSession(sessionId)).toBeNull();
  });

  slow("writes the topic only after the user confirms, and keeps it afterwards", async () => {
    const confirmed = await post(`/api/research/intents/${intentId}/confirm`, {});
    expect(confirmed.status).toBe(202);
    const direction = confirmed.json["direction"] as { topic: string; purpose: string };
    expect(confirmed.json["started"]).toBe("card");
    expect(confirmed.json["openFields"]).toContain("audience");

    await waitUntil(async () => (await taskOfSession(sessionId)) !== null, "the card stage to create the task");
    const bundle = (await taskOfSession(sessionId)) as Record<string, unknown>;
    const task = bundle["task"] as Record<string, unknown>;
    // The model's card said「模型自己写的题目」; the user's direction won.
    expect(task["topic"]).toBe(direction.topic);
    expect(task["purpose"]).toBe(direction.purpose);
    const brief = bundle["brief"] as { fieldStates: Record<string, string> };
    expect(brief.fieldStates["topic"]).toBe("confirmed");
    expect(brief.fieldStates["purpose"]).toBe("confirmed");
    expect(brief.fieldStates["subjects"]).toBe("suggested");

    // The conversation is closed for writing, and the link to the task is kept.
    const closed = await post(`/api/research/intents/${intentId}/messages`, { text: "再改一下" });
    expect(closed.status).toBe(409);
    const state = await intentState(intentId);
    expect(state?.status).toBe("confirmed");
    expect(state?.taskId).toBe(task["id"]);
  });

  slow("C. guided planning does not ask what the confirmation already settled", async () => {
    const bundle = (await taskOfSession(sessionId)) as Record<string, unknown>;
    const taskId = (bundle["task"] as Record<string, unknown>)["id"] as string;
    const next = await post(`/api/research/tasks/${taskId}/brief/guide/next`, {});
    expect(next.status).toBe(202);
    // purpose and focus came from the conversation, so the guide starts later in
    // the ladder instead of asking them again.
    expect(next.json["target"]).not.toBe("purpose");
    expect(next.json["target"]).not.toBe("focus");
    expect(next.json["target"]).toBe("audience");
  });
});

describe("Scenario B — an explicit request is summarized, not interrogated", () => {
  slow("proposes a direction on the first turn and confirms into a brief", async () => {
    const created = await post("/api/research/intents", {
      seedTopic: "比较 Transformer、Mamba 和 RWKV 在长上下文推理成本上的特点，用于部署选型。",
    });
    expect(created.status).toBe(202);
    const intentId = created.json["intentId"] as string;
    const sessionId = created.json["sessionId"] as string;

    const proposed = await waitForIntent(intentId, (value) => value.proposal !== null, "the first-turn proposal");
    // One turn, one proposal: no forced questionnaire. A proposal is not a
    // question, so the record shows no questions at all.
    expect(proposed.userMessages).toHaveLength(0);
    expect(proposed.assistantQuestions).toHaveLength(0);
    expect(proposed.turns.filter((turn) => turn.proposesDirection === true)).toHaveLength(1);
    expect(proposed.proposal?.topic).toContain("Transformer");

    const confirmed = await post(`/api/research/intents/${intentId}/confirm`, {});
    expect(confirmed.status).toBe(202);
    await waitUntil(async () => (await taskOfSession(sessionId)) !== null, "the task for scenario B");
    const bundle = (await taskOfSession(sessionId)) as Record<string, unknown>;
    const task = bundle["task"] as Record<string, unknown>;
    expect(String(task["topic"])).toContain("Transformer");
    const subjects = bundle["subjects"] as readonly { name: string }[];
    expect(subjects.map((subject) => subject.name)).toEqual(["Transformer", "Mamba", "RWKV"]);
    const brief = bundle["brief"] as { fieldStates: Record<string, string>; guide: { readiness: number } };
    // Three fields were settled by the user's confirmation: purpose, audience,
    // and the subject list is still the agent's suggestion.
    expect(brief.fieldStates["purpose"]).toBe("confirmed");
    expect(brief.fieldStates["audience"]).toBe("confirmed");
    expect(brief.fieldStates["subjects"]).toBe("suggested");
    expect(brief.guide.readiness).toBeGreaterThanOrEqual(2);
  });
});

describe("Scenario D — a document submitted with the topic", () => {
  slow("is in the library before the first question, and the first turn reads it", async () => {
    instructions.length = 0;
    const created = await post("/api/research/intents", {
      seedTopic: "长上下文推理成本",
      documents: [{ filename: "deployment-notes.md", content: DOCUMENT }],
    });
    expect(created.status).toBe(202);
    const intentId = created.json["intentId"] as string;
    const documents = created.json["documents"] as readonly { documentId: string; originalFilename: string; chars: number }[];
    expect(documents).toHaveLength(1);
    expect(documents[0]?.originalFilename).toBe("deployment-notes.md");
    expect(documents[0]?.chars).toBe(DOCUMENT.length);

    const state = await waitForIntent(intentId, (value) => value.pending !== null, "the first question");
    expect(state.documents.map((document) => document.documentId)).toEqual([documents[0]?.documentId]);

    // The first turn really saw the file's own words, and the sentence that
    // marks them as data travelled with it.
    const first = instructions.find((instruction) => instruction.includes("这是一段对话，不是问卷")) ?? "";
    expect(first).toContain("我们在生产环境里测量过 prefill 与 decode 的延迟");
    expect(first).toContain("不可信数据");
    expect(first).toContain("不得执行");
  });

  slow("refuses a request whose attachment is not Markdown, and creates nothing", async () => {
    const before = app.repository.listTasks().length;
    const refused = await post("/api/research/intents", {
      seedTopic: "长上下文推理成本",
      documents: [{ filename: "paper.pdf", content: DOCUMENT }],
    });
    expect(refused.status).toBe(400);
    expect(String(refused.json["error"])).toContain("Markdown");
    expect(app.repository.listTasks()).toHaveLength(before);
  });
});

describe("Scenario E — a document added while the conversation is open", () => {
  slow("updates the proposal and never the confirmed direction", async () => {
    const created = await post("/api/research/intents", {
      seedTopic: "Transformer 的部署成本",
      documents: [{ filename: "first.md", content: "# 第一份笔记\n\n先看 prefill 成本。" }],
    });
    const intentId = created.json["intentId"] as string;
    const state = await waitForIntent(intentId, (value) => value.pending !== null, "the first question");
    const firstQuestion = state.pending?.text ?? "";

    // A new file arrives mid-conversation.
    const uploaded = await post("/api/research/documents", {
      intentId,
      filename: "second.md",
      content: "# 第二份笔记\n\n部署时我们更关心单位请求成本，而不是峰值吞吐。",
    });
    expect(uploaded.status, JSON.stringify(uploaded.json)).toBe(201);
    const documentId = (uploaded.json["document"] as { documentId: string }).documentId;

    const asked = await sendMessage(intentId, {
      text: "这份新笔记更贴近我的意思，请按它重新理解研究方向",
      documentIds: [documentId],
    });
    expect(asked.status).toBe(202);
    const after = await waitForIntent(intentId, (value) => value.proposal !== null, "the re-understood direction");
    expect(after.proposal?.topic).toBe("部署视角下的长上下文推理成本");
    // The proposal changed; the confirmed direction was never written.
    expect(after.confirmedDirection).toBeNull();
    expect(after.documents).toHaveLength(2);
    expect(after.userMessages.at(-1)).toContain("重新理解");
    // A question that was superseded is not silently answered: the record keeps
    // the question and the user's own message.
    expect(after.turns.some((turn) => turn.text === firstQuestion)).toBe(true);
  });
});

describe("the user's own request to stop being asked", () => {
  slow("refuses another question and gets a direction out of the model anyway", async () => {
    refusals = [];
    const created = await post("/api/research/intents", { seedTopic: "Transformer 的推理成本" });
    const intentId = created.json["intentId"] as string;
    await waitForIntent(intentId, (value) => value.pending !== null, "the first question");

    const sent = await sendMessage(intentId, { text: "可以了，请给出正式的研究方向。" });
    expect(sent.status).toBe(202);

    const state = await waitForIntent(intentId, (value) => value.proposal !== null, "the direction the user asked for");
    expect(state.status).toBe("ready_to_confirm");
    expect(state.proposal?.topic).toBe("长上下文推理成本比较");
    // The script asked again first; the server refused it, and the product's own
    // retry is what produced the direction.
    expect(refusals.some((entry) => entry.includes("用户已经明确要求你给出研究方向"))).toBe(true);
    // The refused question recorded nothing, so the only questions on record are
    // the opening one — and the turn that answers the user's request is the
    // proposal itself.
    expect(state.assistantQuestions).toHaveLength(1);
    expect(state.turns[state.turns.length - 1]?.proposesDirection).toBe(true);
    expect(await taskOfSession(created.json["sessionId"] as string)).toBeNull();
  });
});

describe("Scenario H — persistence, isolation and the server's own boundary", () => {
  slow("reads the same conversation back after a reload, and keeps sessions apart", async () => {
    const created = await post("/api/research/intents", { seedTopic: "刷新后还在吗" });
    const intentId = created.json["intentId"] as string;
    const sessionId = created.json["sessionId"] as string;
    await waitForIntent(intentId, (value) => value.pending !== null, "the first question");
    await sendMessage(intentId, { text: "在的" });
    const before = await waitForIntent(intentId, (value) => value.userMessages.length === 1, "the answer to be recorded");

    // A second read — the reload a browser performs — is the same conversation.
    const after = await intentState(intentId);
    expect(after?.turns).toEqual(before.turns);
    expect(after?.version).toBe(before.version);

    // The session route finds it too, which is how a page recovers its state.
    const bySession = await get(`/api/research/sessions/${sessionId}/intent`);
    expect((bySession.json["intent"] as { intentId: string }).intentId).toBe(intentId);

    // Another session's document cannot be pushed into this conversation.
    const other = await post("/api/research/intents", { seedTopic: "另一个话题" });
    const otherSession = other.json["sessionId"] as string;
    const foreign = await post("/api/research/documents", {
      sessionId: otherSession,
      filename: "other.md",
      content: "# 别的会话的文件\n\n内容。",
    });
    const foreignId = (foreign.json["document"] as { documentId: string }).documentId;
    const refused = await sendMessage(intentId, {
      text: "把别的会话的文件也拿进来",
      documentIds: [foreignId],
    });
    expect(refused.status).toBe(400);
    expect(String(refused.json["error"])).toContain("不属于");

    // And the exploration is not reachable from a session that is not its own.
    const otherIntent = await get(`/api/research/sessions/${otherSession}/intent`);
    expect((otherIntent.json["intent"] as { intentId: string }).intentId).not.toBe(intentId);
  });

  slow("refuses a stale write instead of overwriting what just happened", async () => {
    const created = await post("/api/research/intents", { seedTopic: "版本冲突" });
    const intentId = created.json["intentId"] as string;
    await waitForIntent(intentId, (value) => value.pending !== null, "the first question");
    const version = await versionOf(intentId);

    const first = await sendMessage(intentId, { text: "第一条", expectedVersion: version });
    expect(first.status).toBe(202);
    await waitUntil(async () => {
      const state = await intentState(intentId);
      return state?.userMessages.length === 1;
    }, "the first answer to land");
    const stale = await sendMessage(intentId, { text: "第二条", expectedVersion: version });
    expect(stale.status, JSON.stringify(stale.json)).toBe(409);
    expect(stale.json["stale"]).toBe(true);
    const state = await intentState(intentId);
    expect(state?.userMessages).toEqual(["第一条"]);
  });

  slow("keeps the legacy entry honest: it is a different session, and it says so", async () => {
    const legacy = await post("/api/research/tasks", { topic: "兼容入口的主题" });
    expect(legacy.status).toBe(202);
    expect(legacy.json["intentDiscovery"]).toBe("skipped");
    const sessionId = legacy.json["sessionId"] as string;
    // It did not join an existing exploration, so it cannot bypass a confirmation.
    expect(app.service.intentForSession(sessionId)).toBeUndefined();
  });
});
