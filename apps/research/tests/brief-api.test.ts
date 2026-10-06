/**
 * The editable brief, over the product's real surface.
 *
 * The service-level tests prove the contracts; this one proves they survive the
 * trip a user's click actually takes — HTTP route → runner → host run → tool →
 * service → database — and that both ways of working on the brief end in one
 * document. The model is scripted and the network is absent, so what is under
 * test is the product and not a provider.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelClient, ModelEvent, ModelMessage, ModelRequest, RuntimeContext } from "@every-dagent/agent-core";
import { DEFAULT_MODEL_FRAMING } from "@every-dagent/agent-core";
import type { TrustedComposition } from "@every-dagent/host";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startResearchApp, type ResearchApp } from "../src/server/composition.js";

const workDir = mkdtempSync(join(tmpdir(), "researchpage-brief-"));
const dataDir = join(workDir, "data");
const staticRoot = join(process.cwd(), "apps", "research", "public");

const TOPIC = "比较 GraphRAG、LightRAG 和传统 RAG，重点看长文档问答与工程成本";

// ------------------------------------------------------------ scripted model ---

function instructionOf(messages: readonly ModelMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return message.text;
  }
  return "";
}

/**
 * The tool results of the *current* turn.
 *
 * A stage instruction stays in the conversation while the run works, so a
 * script that only looked at the instruction would call its tool again on every
 * model step. What came back after the newest instruction is what tells the
 * script its call already landed.
 */
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

/** The field a guide instruction says this question is about. */
function guideTargetOf(instruction: string): string {
  return /本次要确认的字段：(\S+)/.exec(instruction)?.[1] ?? "";
}

/** The current value of a bulleted line in the guide instruction. */
function lineOf(instruction: string, label: string): string {
  return new RegExp(`^- ${label}：(.*)$`, "m").exec(instruction)?.[1]?.trim() ?? "";
}

/**
 * A real question for whatever field the program picked.
 *
 * The fixture answers from the instruction's own view of the brief — the same
 * view the model gets — so the options it offers are values the service can
 * really install against this draft, which is what a stored option has to be.
 */
function questionFor(field: string, instruction: string): Record<string, unknown> | undefined {
  const lead = (text: string): Record<string, unknown> => ({ complete: false, leadIn: text, fieldTargets: [field] });
  if (field === "purpose") {
    return {
      ...lead("明白，这份材料要用来支撑一次选型，而不是只解释机制。"),
      question: "这次研究最重要的目标是什么？",
      whyThisMatters: "它决定检索方向、比较框架与结论的写法",
      options: [
        { label: "理解机制", value: { purpose: "理解机制：弄清三种方法的构建与检索机制差异" } },
        {
          label: "为技术选型提供依据",
          description: "在长文档问答场景比较工程成本与效果",
          recommended: true,
          value: { purpose: "为技术选型提供依据：在长文档问答场景比较工程成本与效果" },
        },
      ],
    };
  }
  if (field === "subjects") {
    const names = lineOf(instruction, "比较对象")
      .split("、")
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
    return {
      ...lead("明白了。既然要看工程成本，比较对象就要覆盖你真正会选的几种方案。"),
      question: "这次要比较哪些方案？",
      whyThisMatters: "对象是证据矩阵的行，也决定检索与读取的目标",
      options: [
        { label: `保持当前对象（${names.join("、")}）`, value: { subjects: names.map((name) => ({ name })) } },
        {
          label: "把传统 RAG 也纳入比较",
          value: { subjects: [...names.map((name) => ({ name })), { name: "传统 RAG" }] },
        },
      ],
    };
  }
  if (field === "audience") {
    return {
      ...lead("接下来确认读者是谁。"),
      question: "这份材料主要给谁看？",
      whyThisMatters: "读者决定解释深度与术语密度",
      options: [
        { label: "工程团队", value: { audience: "工程团队" } },
        { label: "导师与同行", value: { audience: "导师与同行" } },
      ],
    };
  }
  if (field === "focus") {
    return {
      ...lead("接下来确认这次要重点看什么。"),
      question: "这次最需要证据支撑的是哪些方面？",
      whyThisMatters: "重点决定哪些维度需要更深、更直接的证据",
      options: [
        { label: "只看机制差异", value: { focus: ["机制差异"] } },
        { label: "机制与工程成本并重", value: { focus: ["机制差异", "工程成本"] } },
      ],
    };
  }
  if (field === "exclusions") {
    return {
      ...lead("接下来确认这次明确不做什么。"),
      question: "哪些内容这次不研究？",
      whyThisMatters: "排除项决定检索与报告不去做的事情",
      options: [
        { label: "不额外限定", value: { exclusions: "" } },
        { label: "排除私有化部署与合规", value: { exclusions: "不涉及私有化部署与合规问题" } },
      ],
    };
  }
  if (field === "lengthTarget") {
    return {
      ...lead("最后一件事：篇幅。"),
      question: "这份材料大概需要多长？",
      whyThisMatters: "篇幅是写作预算，决定章节取舍的详略",
      options: [
        { label: "约 4–6 页", value: { lengthTarget: "约 4–6 页" } },
        { label: "约 8–10 页", value: { lengthTarget: "约 8–10 页" } },
      ],
    };
  }
  return undefined;
}

interface Scripted {
  readonly client: ModelClient;
  /** The field each guided question was asked about, in the order asked. */
  readonly guideTargets: readonly string[];
  /** The instruction each guide stage ran under, so the context is checkable. */
  readonly guideInstructions: readonly string[];
  /** Refusals the model received, as the tool answered them. */
  readonly refusals: { readonly name: string; readonly problems: readonly string[] }[];
}

/**
 * A model that proposes the card, asks about the purpose, asks about the
 * audience, and then insists that nothing further is worth asking — which is
 * the judgement the depth floor exists to refuse. Everything else here is the
 * product's own code.
 */
function scriptedModel(): Scripted {
  const guideTargets: string[] = [];
  const guideInstructions: string[] = [];
  const refusals: { name: string; problems: readonly string[] }[] = [];
  /** The instruction whose guide run is being served, so a retry is not a rerun. */
  let seenInstruction = "";
  let step = 0;
  const next = (events: readonly ModelEvent[]): AsyncIterable<ModelEvent> =>
    (async function* () {
      for (const event of events) yield event;
    })();
  const call = (name: string, input: unknown): readonly ModelEvent[] => [
    { type: "tool-call", call: { callId: `call-${step}-${name}`, name, input } },
    { type: "done" },
  ];
  const say = (text: string): readonly ModelEvent[] => [{ type: "text-delta", text }, { type: "done" }];

  const client: ModelClient = {
    limits: { contextWindow: 128 * 1024, maxOutputTokens: 8 * 1024, framing: DEFAULT_MODEL_FRAMING },
    stream(request: ModelRequest, _context: RuntimeContext): AsyncIterable<ModelEvent> {
      step += 1;
      const instruction = instructionOf(request.messages);
      const results = toolResultsOf(request.messages);

      if (instruction.includes("建立研究任务卡")) {
        if (results.some((result) => result.name === "propose_task")) {
          return next(say("任务卡已建立，等待用户确认。"));
        }
        return next(
          call("propose_task", {
            topic: "GraphRAG、LightRAG 与传统 RAG 的机制与工程成本比较",
            purpose: "组会汇报",
            audience: "工程师",
            focus: ["机制差异"],
            lengthTarget: "约 5 页",
            subjects: [{ name: "GraphRAG" }, { name: "LightRAG" }],
            dimensions: [
              { name: "核心思想", question: "解决什么问题，面向哪类任务" },
              { name: "构建与检索", question: "如何构建索引，查询时如何检索" },
              { name: "成本与部署", question: "索引、查询与更新分别产生什么成本" },
            ],
          }),
        );
      }

      if (instruction.includes("引导模式")) {
        for (const result of results) {
          if (result.value["ok"] !== false) continue;
          const problems = (result.value["problems"] ?? []) as string[];
          if (refusals.some((entry) => entry.problems.join("；") === problems.join("；"))) continue;
          refusals.push({ name: result.name, problems });
        }
        const attempts = results.filter((result) => result.name === "propose_guide_question");
        if (attempts.some((result) => result.value["ok"] !== false)) {
          return next(say("问题已提交，等待用户回答。"));
        }
        const target = guideTargetOf(instruction);
        if (seenInstruction !== instruction) {
          seenInstruction = instruction;
          guideTargets.push(target);
          guideInstructions.push(instruction);
        }
        // Two questions, and then the model judges that nothing further is
        // worth asking — a judgement the depth floor refuses. Told why, it
        // writes the question the program asked for, in the same run.
        const refused = attempts.filter((result) => result.value["ok"] === false).length;
        const question = refused > 0 || guideTargets.length <= 2 ? questionFor(target, instruction) : undefined;
        if (question !== undefined) return next(call("propose_guide_question", question));
        if (refused > 0) return next(say("（脚本化模型：无法为这个字段写出更合适的问题）"));
        return next(call("propose_guide_question", { complete: true, reason: "其余默认值已经足够具体" }));
      }

      // The research stage starts after confirmation; this test is about the
      // brief, so the model reads nothing and the task is left honestly failed.
      return next(say("（脚本化模型：本测试不进行检索）"));
    },
  };
  return { client, guideTargets, guideInstructions, refusals };
}

function offlineComposition(scripted: Scripted): TrustedComposition {
  return {
    toolPolicy: undefined,
    validateModel: () => ({ ok: true }),
    compose: async () => ({ modelClient: scripted.client }),
  };
}

// ------------------------------------------------------------------ the test ---

let app: ResearchApp;
let scripted: Scripted;
let taskId = "";

async function post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${app.pageOrigin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

async function patch(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${app.pageOrigin}${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

async function get(path: string): Promise<{ status: number; text: string }> {
  const response = await fetch(`${app.pageOrigin}${path}`);
  return { status: response.status, text: await response.text() };
}

async function waitUntil(predicate: () => Promise<boolean>, what: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });
  }
}

interface BriefShape {
  readonly readonly: boolean;
  readonly confirmed: boolean;
  readonly version: number;
  readonly topic: string;
  readonly purpose: string;
  readonly audience: string;
  readonly focus: readonly string[];
  readonly subjects: readonly { readonly id: string; readonly name: string }[];
  readonly dimensions: readonly { readonly id: string; readonly name: string; readonly question: string }[];
  readonly fieldStates: Readonly<Record<string, string>>;
  readonly editableFields: readonly string[];
  readonly validation: { readonly valid: boolean; readonly problems: readonly string[] };
  readonly canConfirm: boolean;
  readonly guide: {
    readonly complete: boolean;
    readonly reason: string;
    readonly limit: number;
    readonly minDecisions: number;
    readonly maxDecisions: number;
    readonly readiness: number;
    readonly decisions: readonly {
      readonly questionId: string;
      readonly leadIn: string;
      readonly question: string;
      readonly appliedFields: readonly string[];
      readonly selectedOptionLabels: readonly string[];
      readonly answerText: string;
    }[];
    readonly active: {
      readonly questionId: string;
      readonly leadIn: string;
      readonly question: string;
      readonly whyThisMatters: string;
      readonly fieldTargets: readonly string[];
      readonly options: readonly { readonly optionId: string; readonly label: string; readonly recommended?: boolean }[];
      readonly allowFreeText: boolean;
      readonly basedOnBriefVersion: number;
    } | null;
  };
  readonly matrix: { readonly subjects: number; readonly dimensions: number; readonly cells: number };
  readonly reportStructure: readonly { readonly id: string; readonly required: boolean }[];
  readonly contentHash: string;
}

interface BundleShape {
  readonly task: { readonly id: string; readonly status: string; readonly confirmed: boolean };
  readonly brief: BriefShape;
  readonly matrix: readonly { readonly subjectId: string; readonly dimensionId: string; readonly status: string }[];
  readonly busy: boolean;
}

async function bundle(): Promise<BundleShape> {
  return JSON.parse((await get(`/api/research/tasks/${taskId}`)).text) as BundleShape;
}

beforeAll(async () => {
  scripted = scriptedModel();
  app = await startResearchApp({
    dataDir,
    staticRoot,
    composition: offlineComposition(scripted),
    overrides: {
      search: async (query: string) => ({
        provider: "arxiv" as const,
        query,
        requestUrl: `fixture://${query}`,
        fetchedAt: new Date().toISOString(),
        total: 0,
        candidates: [],
        note: "（脚本化检索）",
      }),
      read: async () => ({
        status: "failed" as const,
        scope: null,
        title: "",
        text: "",
        paragraphs: [],
        readUrl: "",
        fetchedAt: new Date().toISOString(),
        contentType: "text/html",
        note: "（脚本化读取）",
        failure: "not used",
      }),
    },
    log: (message: string): void => {
      if (process.env["RESEARCHPAGE_TEST_LOG"] === "1") console.log(message);
    },
  });

  const started = await post("/api/research/tasks", { topic: TOPIC });
  expect(started.status).toBe(202);
  const sessionId = started.json["sessionId"] as string;
  await waitUntil(async () => {
    const state = JSON.parse((await get(`/api/research/sessions/${sessionId}`)).text) as { task: BundleShape | null };
    return state.task !== null;
  }, "the task card to appear");
  const state = JSON.parse((await get(`/api/research/sessions/${sessionId}`)).text) as { task: BundleShape };
  taskId = state.task.task.id;
}, 120_000);

afterAll(async () => {
  await app?.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe("the research brief, over HTTP", () => {
  it("starts as a complete default draft with every field suggested", async () => {
    const current = await bundle();
    expect(current.brief.confirmed).toBe(false);
    expect(current.brief.readonly).toBe(false);
    expect(current.brief.version).toBe(1);
    expect(current.brief.validation).toEqual({ valid: true, problems: [] });
    expect(Object.values(current.brief.fieldStates).every((state) => state === "suggested")).toBe(true);
    expect(current.brief.matrix).toEqual({ subjects: 2, dimensions: 3, cells: 6 });

    // The depth contract travels with the brief, so a page need not guess it,
    // and the user's own exit is stated rather than inferred from validation.
    expect(current.brief.guide.minDecisions).toBe(5);
    expect(current.brief.guide.maxDecisions).toBe(7);
    expect(current.brief.guide.limit).toBe(current.brief.guide.maxDecisions);
    expect(current.brief.guide.readiness).toBe(0);
    expect(current.brief.canConfirm).toBe(true);

    const response = await get(`/api/research/tasks/${taskId}/brief`);
    expect(response.status).toBe(200);
    const body = JSON.parse(response.text) as { brief: BriefShape };
    expect(body.brief.contentHash).toBeDefined();
    expect(body.brief.editableFields).toContain("audience");
    expect(body.brief.reportStructure.some((section) => section.required)).toBe(true);
  });

  it("edits the audience through a structured patch and refuses a stale version", async () => {
    const before = await bundle();
    const changed = await patch(`/api/research/tasks/${taskId}/brief`, {
      expectedVersion: before.brief.version,
      patch: { audience: "研究生组会" },
    });
    expect(changed.status).toBe(200);
    const body = changed.json as { brief: BriefShape; changedFields: readonly string[] };
    expect(body.changedFields).toEqual(["audience"]);
    expect(body.brief.audience).toBe("研究生组会");
    expect(body.brief.fieldStates["audience"]).toBe("edited");
    expect(body.brief.version).toBe(before.brief.version + 1);

    const stale = await patch(`/api/research/tasks/${taskId}/brief`, {
      expectedVersion: before.brief.version,
      patch: { audience: "导师与同行" },
    });
    expect(stale.status).toBe(409);
    expect((stale.json as { brief: BriefShape }).brief.audience).toBe("研究生组会");

    const forbidden = await patch(`/api/research/tasks/${taskId}/brief`, { patch: { confirmedAt: "now", status: "ready" } });
    expect(forbidden.status).toBe(400);
    expect(String((forbidden.json as { error: string }).error)).toContain("不允许通过 Brief 修改的字段");
  });

  it("drops one dimension and adds another without disturbing the surviving ids", async () => {
    const before = await bundle();
    const [d0, d1, d2] = before.brief.dimensions;
    if (d0 === undefined || d1 === undefined || d2 === undefined) throw new Error("expected three dimensions");

    const changed = await patch(`/api/research/tasks/${taskId}/brief`, {
      patch: {
        dimensions: [
          { id: d0.id, name: d0.name, question: d0.question },
          { id: d2.id, name: d2.name, question: d2.question },
          { name: "部署与更新成本", question: "部署与增量更新分别需要什么条件，成本如何随规模变化" },
        ],
      },
    });
    expect(changed.status).toBe(200);
    const brief = (changed.json as { brief: BriefShape }).brief;
    expect(brief.dimensions.map((dimension) => dimension.id).slice(0, 2)).toEqual([d0.id, d2.id]);
    expect(brief.dimensions.some((dimension) => dimension.id === d1.id)).toBe(false);
    expect(brief.validation.valid).toBe(true);

    // The matrix followed the edit, so no phantom column is ever shown.
    const after = await bundle();
    expect(after.matrix).toHaveLength(6);
    expect(after.matrix.some((cell) => cell.dimensionId === d1.id)).toBe(false);
  });

  it("asks one guided question, then applies the answer to the same draft", async () => {
    const asked = await post(`/api/research/tasks/${taskId}/brief/guide/next`, {});
    expect(asked.status).toBe(202);
    await waitUntil(async () => (await bundle()).brief.guide.active !== null, "the guided question to appear");

    const withQuestion = await bundle();
    const question = withQuestion.brief.guide.active;
    if (question === null) throw new Error("expected an active question");
    expect(question.fieldTargets).toEqual(["purpose"]);
    expect(question.options.length).toBeGreaterThanOrEqual(2);
    expect(question.options.length).toBeLessThanOrEqual(5);
    expect(question.allowFreeText).toBe(true);
    expect(question.basedOnBriefVersion).toBe(withQuestion.brief.version);
    expect(question.question).toContain("目标");
    // The lead-in is conversation, not a decision: it arrives with the question
    // and changes nothing in the draft.
    expect(question.leadIn).toBe("明白，这份材料要用来支撑一次选型，而不是只解释机制。");

    // Asking again while a question is live returns it rather than paying for
    // a second model run.
    const again = await post(`/api/research/tasks/${taskId}/brief/guide/next`, {});
    expect(again.status).toBe(200);
    expect((again.json as { started: boolean }).started).toBe(false);

    // A guided answer carrying a version the draft has moved past is refused
    // with the current brief, rather than applied blind.
    const stale = await post(`/api/research/tasks/${taskId}/brief/guide/answer`, {
      questionId: question.questionId,
      expectedVersion: question.basedOnBriefVersion - 1,
      optionIds: ["opt_2"],
    });
    expect(stale.status).toBe(409);
    expect((stale.json as { stale: boolean }).stale).toBe(true);
    expect((stale.json as { brief: BriefShape }).brief.purpose).toBe("组会汇报");

    const answered = await post(`/api/research/tasks/${taskId}/brief/guide/answer`, {
      questionId: question.questionId,
      expectedVersion: withQuestion.brief.version,
      optionIds: ["opt_2"],
    });
    expect(answered.status).toBe(200);
    const body = answered.json as { brief: BriefShape; appliedFields: readonly string[]; complete: boolean };
    expect(body.appliedFields).toEqual(["purpose"]);
    expect(body.brief.purpose).toBe("为技术选型提供依据：在长文档问答场景比较工程成本与效果");
    expect(body.brief.audience).toBe("研究生组会");
    expect(body.brief.fieldStates["purpose"]).toBe("confirmed");
    expect(body.brief.fieldStates["audience"]).toBe("edited");
    expect(body.brief.fieldStates["subjects"]).toBe("suggested");

    // One decision is one decision: the same question cannot be answered twice.
    const twice = await post(`/api/research/tasks/${taskId}/brief/guide/answer`, {
      questionId: question.questionId,
      optionIds: ["opt_1"],
    });
    expect(twice.status).toBe(400);
    expect((await bundle()).brief.purpose).toBe("为技术选型提供依据：在长文档问答场景比较工程成本与效果");
  });

  it("asks the next question about what is still open, and refuses to stop before the floor", async () => {
    // The question the answer triggered, written from the decision before it.
    await waitUntil(async () => (await bundle()).brief.guide.active !== null, "the next question to appear");
    const second = (await bundle()).brief.guide.active;
    if (second === null) throw new Error("expected a second question");
    // The fields the user already settled are behind the ladder: the audience
    // was edited in the structured editor, so the next decision is the objects.
    expect(second.fieldTargets).toEqual(["subjects"]);
    expect(second.leadIn.length).toBeGreaterThan(0);
    expect(scripted.guideTargets).toEqual(["purpose", "subjects"]);
    // The stage that wrote it was told what the user had just decided, so the
    // conversation continues instead of restarting as a questionnaire.
    expect(scripted.guideInstructions[1]).toContain("为技术选型提供依据");
    expect(scripted.guideInstructions[1]).toContain("至少要完成 5 个关键决策");

    const answered = await post(`/api/research/tasks/${taskId}/brief/guide/answer`, {
      questionId: second.questionId,
      optionIds: ["opt_1"],
    });
    expect(answered.status).toBe(200);
    const decisions = ((answered.json as { brief: BriefShape }).brief.guide).decisions;
    expect(decisions).toHaveLength(2);
    expect(decisions[0]).toMatchObject({
      leadIn: "明白，这份材料要用来支撑一次选型，而不是只解释机制。",
      question: "这次研究最重要的目标是什么？",
      selectedOptionLabels: ["为技术选型提供依据"],
      answerText: "为技术选型提供依据",
      appliedFields: ["purpose"],
    });
    // Readiness counts what the *user* decided, whichever way they decided it:
    // two guided answers plus the audience and dimensions they edited by hand.
    expect((answered.json as { brief: BriefShape }).brief.guide.readiness).toBe(4);

    // Two decisions in, the model declared the draft specific enough. The
    // service refused, told it why — and the same run answered with the
    // question the program asked for instead of ending the conversation.
    await waitUntil(async () => scripted.refusals.length > 0, "the model's early stop to be refused");
    expect(scripted.refusals[0]?.name).toBe("propose_guide_question");
    expect(scripted.refusals[0]?.problems.join("；")).toContain("4/5");
    expect(scripted.refusals[0]?.problems.join("；")).toContain("不能结束引导式规划");

    await waitUntil(async () => (await bundle()).brief.guide.active !== null, "the corrected question to appear");
    const third = (await bundle()).brief.guide.active;
    if (third === null) throw new Error("expected a third question");
    expect(third.fieldTargets).toEqual(["focus"]);
    expect(third.leadIn.length).toBeGreaterThan(0);
    expect(scripted.guideTargets).toEqual(["purpose", "subjects", "focus"]);

    const brief = (await bundle()).brief;
    expect(brief.guide.complete).toBe(false);
    expect(brief.guide.readiness).toBe(4);
    // The user's own exit does not wait for the agent's floor.
    expect(brief.canConfirm).toBe(true);
  }, 60_000);

  it("confirms the latest draft, rebuilds the matrix from it, and then locks everything", async () => {
    const before = await bundle();
    const confirmed = await post(`/api/research/tasks/${taskId}/confirm`, { expectedVersion: before.brief.version });
    expect(confirmed.status).toBe(202);

    const after = await bundle();
    expect(after.task.confirmed).toBe(true);
    expect(after.brief.readonly).toBe(true);
    expect(after.brief.validation.valid).toBe(true);
    expect(Object.values(after.brief.fieldStates).every((state) => state === "confirmed")).toBe(true);
    expect(after.brief.purpose).toBe("为技术选型提供依据：在长文档问答场景比较工程成本与效果");
    expect(after.brief.audience).toBe("研究生组会");

    // The matrix is exactly the confirmed subjects × dimensions.
    const subjectIds = after.brief.subjects.map((subject) => subject.id);
    const dimensionIds = after.brief.dimensions.map((dimension) => dimension.id);
    expect(after.matrix).toHaveLength(subjectIds.length * dimensionIds.length);
    const pairs = new Set<string>();
    for (const cell of after.matrix) {
      expect(subjectIds).toContain(cell.subjectId);
      expect(dimensionIds).toContain(cell.dimensionId);
      pairs.add(`${cell.subjectId}|${cell.dimensionId}`);
    }
    expect(pairs.size).toBe(subjectIds.length * dimensionIds.length);

    // And the draft is closed on both paths.
    expect((await patch(`/api/research/tasks/${taskId}/brief`, { patch: { audience: "别人" } })).status).toBe(409);
    expect((await post(`/api/research/tasks/${taskId}/brief/guide/next`, {})).status).toBe(409);
    await waitUntil(async () => !(await bundle()).busy, "the research stage to settle", 60_000);
  });
});
