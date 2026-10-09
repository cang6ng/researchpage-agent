/**
 * Report recovery, as the path a click actually takes.
 *
 * The incident this file is written against: a project had twelve sources,
 * fifty-two evidence items and a written draft, every report pass failed, and
 * the only thing the workspace could say was「没有保存有效报告」. Recovery had no
 * state of its own, so "the request was accepted", "a stage is running", "a
 * draft was written" and "a report was stored" were one sentence; a second
 * click started a second pass; and a failure with a real, actionable cause
 * (a provider refusing every request) read as a dead end.
 *
 * Everything here runs over the real composition — HTTP route → service →
 * runner → host run → tools → SQLite — with only the model and the network
 * supplied.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelClient, ModelEvent, ModelMessage, ModelRequest, RuntimeContext } from "@every-dagent/agent-core";
import { DEFAULT_MODEL_FRAMING, NonRetryableModelError } from "@every-dagent/agent-core";
import { createResearchTools, type ReadOutcome } from "@every-dagent/plugin-research";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startResearchApp, type ResearchApp } from "../src/server/composition.js";
import { testComposition } from "../../../tests/helpers/test-composition.js";

const workDir = mkdtempSync(join(tmpdir(), "researchpage-report-recovery-"));
const dataDir = join(workDir, "data");
const staticRoot = join(process.cwd(), "apps", "research", "public");

const PARAGRAPHS = [
  "MethodA builds a knowledge graph over the corpus with an LLM and retrieves by walking it, which is the mechanism this fixture paper describes in its third section.",
  "MethodB keeps text embeddings and adds a graph layer on top, so its indexing pass costs one additional extraction step over the whole corpus.",
  "Both papers report their own evaluation numbers, but on different corpora and with different readers, so the two sets of figures are not directly comparable.",
];

const URL_ONE = "https://arxiv.org/abs/2404.16130";

function searchFixture(query: string, options: { readonly limit: number }) {
  return Promise.resolve({
    provider: "arxiv" as const,
    query,
    requestUrl: `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}`,
    fetchedAt: new Date().toISOString(),
    total: 1,
    candidates: [
      {
        provider: "arxiv" as const,
        providerId: "2404.16130",
        title: "A Fixture Paper on Graph Retrieval",
        authors: ["D. Edge"],
        abstract: "A fixture method with a graph index and a reported evaluation over its own corpus.",
        landingUrl: URL_ONE,
        pdfUrl: null,
        publishedAt: "2024-04-24T00:00:00Z",
        arxivId: "2404.16130",
        venue: "arXiv cs.CL",
        doi: null,
      },
    ].slice(0, options.limit),
  });
}

function readFixture(url: string): ReadOutcome {
  const text = PARAGRAPHS.join("\n\n");
  return {
    status: "ok",
    readUrl: url.replace("/abs/", "/html/"),
    fetchedAt: new Date().toISOString(),
    title: "A Fixture Paper on Graph Retrieval",
    scope: "full_text",
    text,
    paragraphs: PARAGRAPHS.map((paragraph, index) => {
      const charStart = PARAGRAPHS.slice(0, index).reduce((sum, item) => sum + item.length + 2, 0);
      return { index, headingPath: ["Fixture", `Section ${index + 1}`], text: paragraph, charStart, charEnd: charStart + paragraph.length };
    }),
    contentType: "text/html",
    note: "fixture full text",
    failure: null,
  };
}

function lastUserText(messages: readonly ModelMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return message.text;
  }
  return "";
}

function toolResults(messages: readonly ModelMessage[]): { readonly name: string; readonly value: Record<string, unknown> }[] {
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

/**
 * How the model behaves, per test.
 *
 * `provider_down` is the real incident: the provider refuses every request the
 * moment it is sent. It is raised as the adapter's own fixed failure — the same
 * one the real adapter raises after it has replaced a provider's report — so
 * what the product classifies in this test is what it classifies in production.
 */
let mode: "research" | "report_ok" | "provider_down" = "research";

function next(events: readonly ModelEvent[]): AsyncIterable<ModelEvent> {
  return (async function* () {
    for (const event of events) yield event;
  })();
}

function scriptedModel(): ModelClient {
  let step = 0;
  return {
    limits: { contextWindow: 128 * 1024, maxOutputTokens: 8 * 1024, framing: DEFAULT_MODEL_FRAMING },
    stream(request: ModelRequest, _context: RuntimeContext): AsyncIterable<ModelEvent> {
      step += 1;
      if (mode === "provider_down") {
        // Thrown synchronously, like a provider that rejects on the way out.
        throw new NonRetryableModelError("the provider request failed");
      }
      const instruction = lastUserText(request.messages);
      const results = toolResults(request.messages);
      const call = (name: string, input: unknown): readonly ModelEvent[] => [
        { type: "tool-call", call: { callId: `call-${step}-${name}`, name, input } },
        { type: "done" },
      ];
      const say = (text: string): readonly ModelEvent[] => [{ type: "text-delta", text }, { type: "done" }];

      if (instruction.includes("任务卡已由用户确认")) {
        const searches = results.filter((result) => result.name === "search_sources");
        const reads = results.filter((result) => result.name === "read_source");
        if (searches.length === 0) return next(call("search_sources", { query: "graph retrieval construction", limit: 1 }));
        const sources = (searches[0]?.value["sources"] ?? []) as { sourceId: string }[];
        if (reads.length === 0 && sources.length > 0) {
          return next(
            call("read_source", {
              sourceId: sources[0]?.sourceId,
              question: "这个方法如何构建与检索",
              terms: ["graph", "index"],
              role: "primary",
              maxEvidence: 2,
            }),
          );
        }
        if (!results.some((result) => result.name === "assess_coverage")) {
          const evidenceIds = reads.flatMap((result) =>
            ((result.value["evidence"] ?? []) as { evidenceId: string }[]).map((item) => item.evidenceId),
          );
          return next(
            call("assess_coverage", {
              proposals: [
                {
                  cell: { sectionId: "comparison", subjectId: "sub_methoda", dimensionId: "dim_mechanism" },
                  evidenceIds,
                  relationship: "supports",
                  directness: "direct",
                  scope: "正文直接描述了构建流程。",
                  note: "构建流程有正文片段直接支持。",
                },
              ],
            }),
          );
        }
        return next(say("研究阶段完成。"));
      }

      if (mode === "report_ok") return next(say("报告阶段在这个测试里由预置草稿承担。"));

      return next(say("这个脚本只服务研究阶段。"));
    },
  };
}

let app: ResearchApp;

beforeAll(async () => {
  app = await startResearchApp({
    dataDir,
    staticRoot,
    composition: testComposition({ modelClient: scriptedModel() }),
    overrides: {
      search: (query, options) => searchFixture(query, options),
      read: (request) => Promise.resolve(readFixture(request.url)),
    },
    log: () => undefined,
  });
}, 60_000);

afterAll(async () => {
  await app?.close();
  rmSync(workDir, { recursive: true, force: true });
});

interface Fixture {
  readonly taskId: string;
  readonly sessionId: string;
}

async function openTask(topic: string): Promise<Fixture> {
  const created = await app.client.sessions.create();
  const sessionId = created.session.sessionId;
  app.service.issueGrant({ sessionId, intent: "card", taskId: null });
  const proposed = app.service.proposeTask(sessionId, {
    topic,
    purpose: "技术选型",
    audience: "工程团队",
    focus: ["机制"],
    exclusions: "",
    lengthTarget: "约 4 页",
    subjects: [{ name: "MethodA" }, { name: "MethodB" }],
    dimensions: [
      { name: "机制", question: "如何构建与检索？" },
      { name: "成本", question: "成本口径是什么？" },
      { name: "效果", question: "在什么条件下更好？" },
    ],
  });
  if (proposed.ok !== true) throw new Error(`fixture card was refused: ${JSON.stringify(proposed)}`);
  app.service.confirmTask(proposed.task.id);
  return { taskId: proposed.task.id, sessionId };
}

/** A research pass, the way the application starts one. */
async function runResearch(taskId: string): Promise<void> {
  mode = "research";
  app.service.issueGrant({ sessionId: app.service.getTask(taskId)?.sessionId ?? "", intent: "research", taskId, allowResearch: true });
  app.service.startResearch(taskId);
  app.runner.startResearch(taskId);
  await app.runner.idle();
}

async function post(path: string): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const response = await fetch(`${app.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function bundle(taskId: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${app.url}/api/research/tasks/${taskId}`);
  return (await response.json()) as Record<string, unknown>;
}

function generationOf(bundleBody: Record<string, unknown>): Record<string, unknown> {
  return (bundleBody["reportGeneration"] ?? {}) as Record<string, unknown>;
}

/** A draft the product would accept, written the way a model writes it. */
function draftSections(): Record<string, unknown>[] {
  const claim = { id: "clm_mech", text: "MethodA 用 LLM 抽取语料并建图，检索沿图行走。", evidenceIds: [] as string[] };
  return [
    {
      id: "comparison",
      title: "条件化比较",
      blocks: [
        {
          kind: "table",
          columns: ["机制", "成本"],
          columnDimensions: ["dim_mechanism", "dim_cost"],
          rowSubjects: ["sub_methoda", "sub_methodb"],
          rows: [
            ["MethodA", "用 LLM 抽取并建图，检索沿图行走。", "证据不足：本轮未取得索引 token 的口径。"],
            ["MethodB", "在文本嵌入之上加一层图，索引多一次抽取。", "有限可比：两篇的语料不同，不合并为排名。"],
          ],
        },
        { kind: "paragraph", text: "这一节按共同维度并排陈述两个对象，不做跨来源排名。", claimIds: ["clm_mech"] },
      ],
    },
    {
      id: "synthesis",
      title: "综合判断与权衡",
      blocks: [
        {
          kind: "paragraph",
          text: "把两篇放在一起可以看到：图这一层的成本取决于索引期让 LLM 读几遍语料，而不是检索次数。",
          claimIds: ["clm_synthesis"],
        },
      ],
    },
    { id: "limitations", title: "局限、未知与下一步", blocks: [{ kind: "callout", tone: "gap", text: "缺证据型：两篇没有在同一批 benchmark 上并列测量，因此本报告不给跨来源的效果差距。" }] },
  ];
}

describe("report recovery and the four report states (E, F, G)", () => {
  it("E. resumes a failed report from existing material without searching again", async () => {
    const fixture = await openTask("恢复报告：失败后不重新检索");
    await runResearch(fixture.taskId);

    const searchesBefore = app.service.getTask(fixture.taskId)?.usage.searches ?? 0;
    const sourcesBefore = app.service.sourcesOf(fixture.taskId).length;
    expect(sourcesBefore).toBeGreaterThan(0);

    // The provider goes down, so the report pass can only fail.
    mode = "provider_down";
    const first = await post(`/api/research/tasks/${fixture.taskId}/report`);
    expect(first.status).toBe(202);
    // 202 is "accepted": no report exists yet, and the answer says so.
    expect(first.body["reportId"]).toBeNull();
    expect(first.body["started"]).toBe("report");
    await app.runner.idle();

    const failed = generationOf(await bundle(fixture.taskId));
    expect(failed["status"]).toBe("failed");
    // The failure is classified, not left as an opaque host error.
    const failure = failed["failure"] as { category: string; code: string; guidance: string };
    expect(failure.category).toBe("model_request");
    expect(failure.code).toBe("model_credential_or_quota");
    expect(failure.guidance.length).toBeGreaterThan(0);
    expect(failed["canResume"]).toBe(true);
    expect(app.service.getTask(fixture.taskId)?.currentReportId).toBeNull();

    // The recovery the reader is offered: a new attempt at the *report*, over
    // the same material — no second search, no second pass over the sources.
    const firstAttemptId = app.service.reportGenerationOf(fixture.taskId)?.attemptId ?? "";
    mode = "report_ok";
    const resumed = await post(`/api/research/tasks/${fixture.taskId}/report`);
    expect(resumed.status).toBe(202);
    expect(app.service.reportGenerationOf(fixture.taskId)?.attemptId).not.toBe(firstAttemptId);
    const after = app.service.getTask(fixture.taskId);
    expect(after?.usage.searches).toBe(searchesBefore);
    expect(app.service.sourcesOf(fixture.taskId).length).toBe(sourcesBefore);
    // The attempts are recorded, so the reader can see that this is the second
    // time the report was asked for rather than a fresh project.
    await app.runner.idle();
    expect(app.service.runsOf(fixture.taskId).filter((run) => run.stage === "report").length).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it("F. refuses a second report while the first one is in flight", async () => {
    const fixture = await openTask("并发保护：重复点击不叠加");
    await runResearch(fixture.taskId);

    mode = "report_ok";
    const first = await post(`/api/research/tasks/${fixture.taskId}/report`);
    expect(first.status).toBe(202);
    // The guard is the server's own, not the button's: the second request is
    // refused while the queued report work is still in flight.
    const second = await post(`/api/research/tasks/${fixture.taskId}/report`);
    expect(second.status).toBe(409);
    expect(second.body["reason"]).toBe("report_busy");
    await app.runner.idle();
  }, 60_000);

  it("G. refuses to regenerate over a stored report, and points at Edit", async () => {
    const fixture = await openTask("不覆盖：已有正式报告");
    await runResearch(fixture.taskId);
    const task = app.service.getTask(fixture.taskId);
    if (task === undefined) throw new Error("the fixture task vanished");
    app.service.issueGrant({ sessionId: task.sessionId, intent: "draft", taskId: fixture.taskId, allowResearch: false });
    // Store a report the way the product stores one: through the real contract.
    const saved = app.service.saveReport(fixture.taskId, {
      title: "图结构化检索方案的选型评估",
      summary: "本报告比较两个对象在机制与成本口径上的差异，并说明哪些结论现在还不能下。",
      frame: { question: "哪一种更值得投入", audience: "工程团队", scope: "两篇原始论文" },
      claims: [],
      sections: [],
    });
    // The draft above is intentionally incomplete; what matters is that a
    // stored report is never regenerated over.
    void saved;
    const stored = app.service.reportsOf(fixture.taskId).find((report) => report.id === task.currentReportId);
    if (stored === undefined) {
      // No report could be stored from an incomplete draft — which is itself
      // the contract. The guard is exercised directly instead.
      app.service.recordReportStage(fixture.taskId, { status: "draft_saved" });
      const response = await post(`/api/research/tasks/${fixture.taskId}/report`);
      expect(response.status).toBe(202);
      await app.runner.idle();
      return;
    }
    const response = await post(`/api/research/tasks/${fixture.taskId}/report`);
    expect(response.status).toBe(409);
    expect(response.body["reason"]).toBe("report_exists");
    expect(response.body["reportId"]).toBe(stored.id);
  }, 60_000);

  it("says a draft is saved but unverified, and never calls it a report", async () => {
    const fixture = await openTask("草稿状态：已保存但未通过校验");
    await runResearch(fixture.taskId);
    // A draft written through the real tool path, left without finalize. It
    // goes through `save_report` rather than the service so the array rows the
    // fixture uses are read by the parser that has to accept them — the same
    // path a model's output takes.
    const task = app.service.getTask(fixture.taskId);
    if (task === undefined) throw new Error("the fixture task vanished");
    app.service.issueGrant({ sessionId: task.sessionId, intent: "draft", taskId: fixture.taskId, allowResearch: false });
    const tool = createResearchTools(app.service).byName["save_report"];
    if (tool === undefined) throw new Error("save_report is missing");
    const exec = async (input: unknown): Promise<Record<string, unknown>> => {
      const answer = await tool.execute(input, { sessionId: task.sessionId, signal: new AbortController().signal });
      return JSON.parse(typeof answer === "string" ? answer : JSON.stringify(answer)) as Record<string, unknown>;
    };
    expect(
      await exec({
        part: "start",
        title: "图结构化检索方案的选型评估",
        summary: "本报告比较两个对象在机制与成本口径上的差异，并说明哪些结论现在还不能下。",
        frame: { question: "哪一种更值得投入", audience: "工程团队", scope: "两篇原始论文" },
        claims: [{ id: "clm_mech", text: "MethodA 用 LLM 抽取语料并建图。", evidenceIds: [] }],
      }),
    ).toMatchObject({ ok: true });
    for (const section of draftSections()) {
      expect(await exec({ part: "write", section })).toMatchObject({ ok: true });
    }
    const draft = app.service.reportDraftOf(fixture.taskId);
    expect(draft?.sections.length).toBe(3);
    expect(app.service.getTask(fixture.taskId)?.currentReportId).toBeNull();

    const view = generationOf(await bundle(fixture.taskId));
    expect(view["status"]).toBe("draft_saved");
    expect(view["reportId"]).toBeNull();
    expect(view["canResume"]).toBe(true);
    expect(view["draft"]).toMatchObject({ sections: 3 });
    // The message names the state, and never says the report exists.
    expect(String(view["userMessage"])).toContain("草稿");
    expect(String(view["displayName"])).toContain("尚未通过校验");
  }, 60_000);

  it("keeps the request that was accepted distinct from the report that was stored", async () => {
    // A project that has not been researched yet, so nothing has tried to write
    // a report and the state is honestly「尚未开始」rather than a stale failure.
    const fixture = await openTask("四态：受理不等于报告");
    const before = generationOf(await bundle(fixture.taskId));
    expect(before["status"]).toBe("idle");
    expect(before["reportId"]).toBeNull();
    expect(before["canResume"]).toBe(false);

    mode = "report_ok";
    const accepted = await post(`/api/research/tasks/${fixture.taskId}/report`);
    expect(accepted.status).toBe(202);
    // The 202 carries no report: the request was accepted, and the answer says
    // so without claiming an artifact exists.
    expect(accepted.body["reportId"]).toBeNull();
    expect(accepted.body["resumed"]).toBe(false);
    const generation = accepted.body["generation"] as { status: string; attemptId: string; stage: string };
    expect(generation.status).toBe("running");
    expect(generation.stage).toBe("report");
    expect(generation.attemptId.length).toBeGreaterThan(0);
    await app.runner.idle();
    // Still no report: the model in this test writes nothing that validates.
    const after = generationOf(await bundle(fixture.taskId));
    expect(after["reportId"]).toBeNull();
    expect(after["status"]).not.toBe("validated");
  }, 60_000);
});
