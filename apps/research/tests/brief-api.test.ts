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

interface Scripted {
  readonly client: ModelClient;
  /** The field each guided question was asked about, in the order asked. */
  readonly guideTargets: readonly string[];
}

/**
 * A model that does exactly three things: propose the card, ask one guided
 * question about the purpose, and then report that nothing further is worth
 * asking. Everything else in this test is the product's own code.
 */
function scriptedModel(): Scripted {
  const guideTargets: string[] = [];
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
        if (results.some((result) => result.name === "propose_guide_question")) {
          return next(say("问题已提交，等待用户回答。"));
        }
        const target = guideTargetOf(instruction);
        guideTargets.push(target);
        if (target !== "purpose") {
          // A field the model judges need no decision: it says so rather than
          // inventing a question the user would have to read.
          return next(call("propose_guide_question", { complete: true, reason: "其余默认值已经足够具体" }));
        }
        return next(
          call("propose_guide_question", {
            complete: false,
            question: "这次研究最重要的目标是什么？",
            whyThisMatters: "它决定检索方向、比较框架与结论的写法",
            fieldTargets: ["purpose"],
            options: [
              {
                label: "理解机制",
                description: "弄清三种方法各自如何构建与检索",
                value: { purpose: "理解机制：弄清三种方法的构建与检索机制差异" },
              },
              {
                label: "为技术选型提供依据",
                description: "在长文档问答场景比较工程成本与效果",
                recommended: true,
                value: { purpose: "为技术选型提供依据：在长文档问答场景比较工程成本与效果" },
              },
              { label: "准备组会综述", value: { purpose: "准备组会综述：讲清三类方法的现状与边界" } },
            ],
          }),
        );
      }

      // The research stage starts after confirmation; this test is about the
      // brief, so the model reads nothing and the task is left honestly failed.
      return next(say("（脚本化模型：本测试不进行检索）"));
    },
  };
  return { client, guideTargets };
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
  readonly guide: {
    readonly complete: boolean;
    readonly reason: string;
    readonly decisions: readonly { readonly questionId: string; readonly question: string; readonly appliedFields: readonly string[] }[];
    readonly active: {
      readonly questionId: string;
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

  it("asks the next question about what is still open, and stops when the model says so", async () => {
    await waitUntil(async () => (await bundle()).brief.guide.complete, "the guide to conclude");
    const brief = (await bundle()).brief;
    expect(brief.guide.reason).toBe("其余默认值已经足够具体");
    expect(brief.guide.active).toBeNull();
    expect(brief.guide.decisions).toHaveLength(1);

    // The field the user settled is behind the ladder: the second question was
    // about the subjects, never about the audience they had already rewritten.
    expect(scripted.guideTargets).toEqual(["purpose", "subjects"]);
  });

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
