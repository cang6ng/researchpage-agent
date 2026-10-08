/**
 * The retry a failed project is actually offered.
 *
 * The product used to say「可以重试」next to a failure while the only retry that
 * existed was a person starting over: the workspace promised an action the API
 * did not have. This test drives the whole path a click takes — HTTP route →
 * service eligibility → runner → host run → tools → database — over the same
 * composition the demo runs, with the model and the network supplied.
 *
 * The failure being recovered from is a real one: the research stage runs with
 * a discovery path that answers HTTP 429, the tool reports it, the stage reads
 * nothing, and the runner stops the project with the sentence a user would
 * read. What the retry then has to prove is that the project is not reset —
 * material, report and frozen revision stay exactly as they were — that the old
 * deadline cannot reject the attempt it just allowed, and that a retry never
 * becomes a way to spend the project's budget twice.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelClient, ModelEvent, ModelMessage, ModelRequest, RuntimeContext } from "@every-dagent/agent-core";
import { DEFAULT_MODEL_FRAMING } from "@every-dagent/agent-core";
import type { ReadOutcome, Report } from "@every-dagent/plugin-research";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startResearchApp, type ResearchApp } from "../src/server/composition.js";
import { testComposition } from "../../../tests/helpers/test-composition.js";

const workDir = mkdtempSync(join(tmpdir(), "researchpage-retry-"));
const dataDir = join(workDir, "data");
const staticRoot = join(process.cwd(), "apps", "research", "public");

const PAPER_PARAGRAPHS = [
  "GraphRAG extracts a knowledge graph from a corpus with an LLM, partitions it into communities by hierarchical clustering, and pre-generates community summaries for query-focused summarization.",
  "The construction pipeline has two stages: entity and relationship extraction from each source text unit, followed by community detection using the Leiden algorithm and summarization of each community.",
  "At query time GraphRAG supports global search over community summaries and local search that walks entity neighbourhoods and their connected text units.",
  "Costs are dominated by graph construction, which needs one LLM pass over the whole corpus before any question is asked.",
];

const URL_ONE = "https://arxiv.org/abs/2404.16130";

/** Whether discovery answers in this test, or rate limits the product. */
let discoveryMode: "ok" | "rate_limited" = "ok";

function searchFixture(query: string, options: { readonly limit: number }) {
  if (discoveryMode === "rate_limited") {
    // The same failure a real 429 produced: a classified, retryable refusal
    // that the tool turns into a sentence the model can act on.
    return import("@every-dagent/plugin-research").then(({ SearchError }) => {
      throw new SearchError("arXiv answered HTTP 429", {
        kind: "rate_limited",
        provider: "arxiv",
        status: 429,
        attempts: [
          {
            provider: "arxiv",
            query,
            requestUrl: "https://export.arxiv.org/api/query?search_query=all:graph",
            startedAt: new Date().toISOString(),
            elapsedMs: 12,
            ok: false,
            attempt: 1,
            failureKind: "rate_limited",
            status: 429,
          },
        ],
      });
    });
  }
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
        title: "From Local to Global: A GraphRAG Approach to Query-Focused Summarization",
        authors: ["D. Edge"],
        abstract: "We describe a graph-based retrieval method and its evaluation over a corpus.",
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
  const text = PAPER_PARAGRAPHS.join("\n\n");
  return {
    status: "ok",
    readUrl: url.replace("/abs/", "/html/"),
    fetchedAt: new Date().toISOString(),
    title: "From Local to Global: A GraphRAG Approach",
    scope: "full_text",
    text,
    paragraphs: PAPER_PARAGRAPHS.map((paragraph, index) => {
      const charStart = PAPER_PARAGRAPHS.slice(0, index).reduce((sum, item) => sum + item.length + 2, 0);
      return { index, headingPath: ["Fixture", `Section ${index + 1}`], text: paragraph, charStart, charEnd: charStart + paragraph.length };
    }),
    contentType: "text/html",
    note: "fixture full text",
    failure: null,
  };
}

/** The last user turn's text, which is what decides what a scripted model does. */
function instructionOf(messages: readonly ModelMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return message.text;
  }
  return "";
}

function toolResultsOf(messages: readonly ModelMessage[]): { readonly name: string; readonly value: Record<string, unknown> }[] {
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
 * A model that does the research pass and nothing else.
 *
 * It searches once; if the search was refused it stops, which is exactly the
 * behaviour the product asks for («不要反复调用») and what leaves the stage with
 * zero reads. If the search answered, it reads the candidate, records one
 * judgement and stops.
 */
function scriptedModel(): ModelClient {
  let step = 0;
  return {
    limits: { contextWindow: 128 * 1024, maxOutputTokens: 8 * 1024, framing: DEFAULT_MODEL_FRAMING },
    stream(request: ModelRequest, _context: RuntimeContext): AsyncIterable<ModelEvent> {
      step += 1;
      const instruction = instructionOf(request.messages);
      const results = toolResultsOf(request.messages);
      const call = (name: string, input: unknown): readonly ModelEvent[] => [
        { type: "tool-call", call: { callId: `call-${step}-${name}`, name, input } },
        { type: "done" },
      ];
      const say = (text: string): readonly ModelEvent[] => [{ type: "text-delta", text }, { type: "done" }];

      if (!instruction.includes("任务卡已由用户确认")) return next(say("这个脚本只服务研究阶段。"));

      const searches = results.filter((result) => result.name === "search_sources");
      const reads = results.filter((result) => result.name === "read_source");
      if (searches.length === 0) return next(call("search_sources", { query: "GraphRAG graph construction", limit: 2 }));
      if (searches[0]?.value["ok"] === false) {
        // The honest response to「检索服务不可用」: stop, and say what happened.
        return next(say("检索服务当前不可用，本次没有读取任何来源。"));
      }
      const sources = (searches[0]?.value["sources"] ?? []) as { sourceId: string }[];
      if (reads.length === 0 && sources.length > 0) {
        return next(
          call("read_source", {
            sourceId: sources[0]?.sourceId,
            question: "GraphRAG 如何构建图并检索",
            terms: ["graph", "construction", "community"],
            role: "primary",
            maxEvidence: 2,
          }),
        );
      }
      if (!results.some((result) => result.name === "assess_coverage")) {
        const evidenceIds = reads.flatMap((result) => ((result.value["evidence"] ?? []) as { evidenceId: string }[]).map((item) => item.evidenceId));
        return next(
          call("assess_coverage", {
            proposals: [
              {
                cell: { sectionId: "comparison", subjectId: "sub_graphrag", dimensionId: "dim_mechanism" },
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
      return next(say("本轮检索、读取与评估完成。"));
    },
  };
}

function next(events: readonly ModelEvent[]): AsyncIterable<ModelEvent> {
  return (async function* () {
    for (const event of events) yield event;
  })();
}

interface Fixture {
  readonly app: ResearchApp;
  readonly sessionId: string;
  readonly taskId: string;
  readonly subjectId: string;
  readonly dimensionId: string;
}

async function openTask(): Promise<Fixture> {
  const created = await app.client.sessions.create();
  const sessionId = created.session.sessionId;
  app.service.issueGrant({ sessionId, intent: "card", taskId: null });
  const proposed = app.service.proposeTask(sessionId, {
    topic: "GraphRAG 的机制",
    purpose: "技术选型",
    audience: "工程团队",
    focus: ["机制"],
    exclusions: "",
    lengthTarget: "约 6 页",
    subjects: [{ name: "GraphRAG" }, { name: "LightRAG" }],
    dimensions: [
      { name: "机制", question: "如何构建与检索？" },
      { name: "成本", question: "成本如何？" },
      { name: "更新", question: "如何更新？" },
    ],
  });
  if (proposed.ok !== true) throw new Error(`fixture card was refused: ${JSON.stringify(proposed)}`);
  app.service.confirmTask(proposed.task.id);
  const task = app.service.getTask(proposed.task.id);
  return {
    app,
    sessionId,
    taskId: proposed.task.id,
    subjectId: task?.subjects[0]?.id ?? "",
    dimensionId: task?.dimensions[0]?.id ?? "",
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

async function post(path: string): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const response = await fetch(`${app.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function getTask(taskId: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${app.url}/api/research/tasks/${taskId}`);
  return (await response.json()) as Record<string, unknown>;
}

/**
 * Runs a research pass the way the application starts one.
 *
 * `/confirm` calls the service first — that is what opens the attempt the
 * pipeline budget governs — and then the runner. Doing only the second half
 * here would test a state no user can reach.
 */
async function runResearch(taskId: string): Promise<void> {
  app.service.startResearch(taskId);
  app.runner.startResearch(taskId);
  await app.runner.idle();
}

describe("the retry a failed project is offered (K, L, M, N, O)", () => {
  it("K. recovers a failed project through POST /retry-research, and says why it failed", async () => {
    const fixture = await openTask();

    // A project whose research pass ends with nothing read stops, with a
    // sentence about the search service rather than about the topic.
    discoveryMode = "rate_limited";
    await runResearch(fixture.taskId);
    discoveryMode = "ok";

    const failed = await getTask(fixture.taskId);
    const task = failed["task"] as Record<string, unknown>;
    expect(task["status"]).toBe("failed");
    const error = String(task["error"]);
    expect(error).toContain("论文检索暂时不可用");
    expect(error).toContain("429");
    expect(error).not.toContain("更换主题");
    expect(error).not.toContain("主题不合适");
    // The failure is explained by the request ledger, not by a guess.
    const discovery = failed["discovery"] as Record<string, unknown>;
    expect(discovery["failedRequests"]).toBeGreaterThan(0);
    expect(discovery["successfulRequests"]).toBe(0);
    expect(discovery["lastFailure"]).toMatchObject({ kind: "rate_limited", status: 429 });

    // The retry the workspace promised now exists.
    const retried = await post(`/api/research/tasks/${fixture.taskId}/retry-research`);
    expect(retried.status).toBe(202);
    expect(retried.body["ok"]).toBe(true);
    expect(String(retried.body["message"])).toContain("已重新开始研究");

    const attempt = retried.body["attempt"] as Record<string, unknown>;
    expect(attempt["number"]).toBe(2);
    const after = await getTask(fixture.taskId);
    const afterTask = after["task"] as Record<string, unknown>;
    expect(afterTask["status"]).toBe("researching");
    expect(afterTask["error"]).toBeNull();
    // The activity history says what happened, in order, and is readable.
    const log = after["activityLog"] as { kind: string; message: string }[];
    expect(log.map((event) => event.kind)).toContain("stage_failed");
    expect(log.map((event) => event.kind)).toContain("retry_started");
    expect(log.some((event) => event.message.includes("重新开始研究"))).toBe(true);

    // Wait for the retried pass, which this time can read.
    await app.runner.idle();
    const recovered = app.service.getTask(fixture.taskId);
    expect(recovered?.usage.reads).toBeGreaterThan(0);
    expect(app.service.sourcesOf(fixture.taskId).length).toBeGreaterThan(0);
  }, 120_000);

  it("L. refuses a second retry while one is running, an unconfirmed brief, and a project that did not fail", async () => {
    const fixture = await openTask();

    // A draft that was never confirmed: the retry has no run to re-do, and the
    // API says exactly that instead of silently starting research.
    const created = await app.client.sessions.create();
    const draftSession = created.session.sessionId;
    app.service.issueGrant({ sessionId: draftSession, intent: "card", taskId: null });
    const draft = app.service.proposeTask(draftSession, {
      topic: "还没确认的题目",
      purpose: "看看",
      audience: "自己",
      focus: [],
      exclusions: "",
      lengthTarget: "3 页",
      subjects: [{ name: "A" }, { name: "B" }],
      dimensions: [
        { name: "d1", question: "q1" },
        { name: "d2", question: "q2" },
        { name: "d3", question: "q3" },
      ],
    });
    if (draft.ok !== true) throw new Error(`fixture draft was refused: ${JSON.stringify(draft)}`);
    const unconfirmedResponse = await post(`/api/research/tasks/${draft.task.id}/retry-research`);
    expect(unconfirmedResponse.status).toBe(409);
    expect(unconfirmedResponse.body["reason"]).toBe("brief_unconfirmed");

    // A retry while the retried pass is still running is refused: two runs
    // writing one project is how one of them silently loses.
    discoveryMode = "rate_limited";
    await runResearch(fixture.taskId);
    discoveryMode = "ok";
    expect(app.service.getTask(fixture.taskId)?.status).toBe("failed");

    const first = await post(`/api/research/tasks/${fixture.taskId}/retry-research`);
    expect(first.status).toBe(202);
    const second = await post(`/api/research/tasks/${fixture.taskId}/retry-research`);
    expect(second.status).toBe(409);
    expect(second.body["reason"]).toBe("run_in_progress");
    await app.runner.idle();

    // And a project that is not stopped cannot be "retried" — it can only be
    // given more material, which is a different action with its own budget.
    const healthy = await openTask();
    expect(app.service.getTask(healthy.taskId)?.status).toBe("confirmed");
    const done = await post(`/api/research/tasks/${healthy.taskId}/retry-research`);
    expect(done.status).toBe(409);
    expect(done.body["reason"]).toBe("not_recoverable");

    const missing = await post(`/api/research/tasks/task_0000000000000000/retry-research`);
    expect(missing.status).toBe(404);
  }, 120_000);

  it("M. a retry is not blocked by the deadline the previous attempt ran out of", async () => {
    const fixture = await openTask();

    // The state a project is really in when a run has been going for a while:
    // its deadline started long ago. On the pipeline budget, that alone refuses
    // the next call.
    const stale = app.service.getTask(fixture.taskId);
    app.repository.updateTask({ ...(stale as NonNullable<typeof stale>), usage: { ...(stale as NonNullable<typeof stale>).usage, startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() } });
    app.service.issueGrant({ sessionId: fixture.sessionId, intent: "research", taskId: fixture.taskId, targetType: "project", targetId: null, allowResearch: true, scope: "研究" });
    const beforeRetry = await app.service.search(fixture.taskId, { query: "GraphRAG" });
    expect(beforeRetry.ok).toBe(false);
    if (!beforeRetry.ok) expect(beforeRetry.problems.join("")).toContain("时间预算已用尽");

    app.service.failTask(fixture.taskId, "论文检索暂时不可用：arXiv：请求过于频繁（HTTP 429）。");
    const retried = await post(`/api/research/tasks/${fixture.taskId}/retry-research`);
    expect(retried.status).toBe(202);
    await app.runner.idle();

    // The same call now answers: the retry's own attempt is what the deadline
    // is counted from, and the old one cannot reject it.
    app.service.issueGrant({ sessionId: fixture.sessionId, intent: "research", taskId: fixture.taskId, targetType: "project", targetId: null, allowResearch: true, scope: "研究" });
    const afterRetry = await app.service.search(fixture.taskId, { query: "GraphRAG" });
    expect(afterRetry.ok).toBe(true);
    if (afterRetry.ok) expect(afterRetry.searchCount).toBeGreaterThan(0);
  }, 120_000);

  it("N. a retry keeps the material, the report and the frozen revision it found", async () => {
    const fixture = await openTask();
    // Real material first, through the real read path.
    await runResearch(fixture.taskId);
    const sourcesBeforeIds = app.service.sourcesOf(fixture.taskId).map((entry) => entry.id);
    const sourcesBefore = sourcesBeforeIds.length;
    const evidenceBefore = app.service.evidenceOf(fixture.taskId);
    expect(sourcesBefore).toBeGreaterThan(0);
    expect(evidenceBefore.length).toBeGreaterThan(0);

    // A report and a frozen revision, written where the service reads them.
    const report: Report = {
      id: "rep_retry_fixture",
      taskId: fixture.taskId,
      title: "GraphRAG 的机制",
      summary: "一份用于验证重试保留语义的报告。",
      sections: [{ id: "overview", title: "一、概览", blocks: [{ kind: "paragraph", text: "正文内容不变。", claimIds: [] }] }],
      claims: [],
      validation: { ok: true, problems: [], warnings: [], checks: [], checkedAt: new Date().toISOString() },
      createdAt: new Date().toISOString(),
    };
    app.repository.saveReport(report);
    const current = app.service.getTask(fixture.taskId);
    app.repository.updateTask({ ...(current as NonNullable<typeof current>), currentReportId: report.id });
    const frozen = app.service.freezeRevision({ taskId: fixture.taskId });
    expect(frozen.ok).toBe(true);
    const revisionsBefore = app.service.revisionsOf(fixture.taskId);
    expect(revisionsBefore.length).toBe(1);

    app.service.failTask(fixture.taskId, "论文检索暂时不可用：arXiv：请求过于频繁（HTTP 429）。");
    const retried = await post(`/api/research/tasks/${fixture.taskId}/retry-research`);
    expect(retried.status).toBe(202);
    const preserved = retried.body["preserved"] as Record<string, unknown>;
    expect(preserved["sources"]).toBe(sourcesBefore);
    expect(preserved["evidence"]).toBe(evidenceBefore.length);
    expect(preserved["reports"]).toBe(1);
    expect(preserved["revisions"]).toBe(1);
    expect(preserved["reportKept"]).toBe(true);

    // Nothing was rewound: the report and the frozen revision are the same
    // rows, and everything the project already had is still there. (The
    // retried pass is free to *add* material — that is what it is for — so the
    // check is that nothing was lost, not that nothing changed.)
    const after = app.service.getTask(fixture.taskId);
    expect(after?.currentReportId).toBe(report.id);
    expect(app.service.reportsOf(fixture.taskId).map((entry) => entry.id)).toEqual([report.id]);
    expect(app.service.revisionsOf(fixture.taskId).map((entry) => entry.id)).toEqual(revisionsBefore.map((entry) => entry.id));
    await app.runner.idle();
    const evidenceAfter = app.service.evidenceOf(fixture.taskId).map((entry) => entry.id);
    const sourcesAfter = app.service.sourcesOf(fixture.taskId).map((entry) => entry.id);
    for (const id of evidenceBefore.map((entry) => entry.id)) expect(evidenceAfter).toContain(id);
    for (const id of sourcesBeforeIds) expect(sourcesAfter).toContain(id);
    // A project that already has a report does not get its text rewritten by a
    // retry: research only ever adds material.
    const settled = app.service.getTask(fixture.taskId);
    expect(settled?.currentReportId).toBe(report.id);
    expect(app.service.reportsOf(fixture.taskId)[0]?.sections[0]?.blocks[0]).toMatchObject({ text: "正文内容不变。" });
  }, 120_000);

  it("O. the retry's budget is the pipeline's, and the user action budget is untouched", async () => {
    const fixture = await openTask();
    await runResearch(fixture.taskId);
    const before = app.service.getTask(fixture.taskId);
    expect(before?.usage.searches).toBeGreaterThan(0);

    app.service.failTask(fixture.taskId, "论文检索暂时不可用：arXiv：请求过于频繁（HTTP 429）。");
    const retried = await post(`/api/research/tasks/${fixture.taskId}/retry-research`);
    expect(retried.status).toBe(202);

    const justRetried = app.service.getTask(fixture.taskId);
    expect(justRetried?.attempt?.number).toBe(2);
    // Nothing was wound back: the lifetime telemetry only ever grows, and the
    // attempt is what the next refusal is counted against.
    expect(justRetried?.usage.searches).toBeGreaterThanOrEqual(before?.usage.searches ?? 0);
    expect(justRetried?.usage.reads).toBeGreaterThanOrEqual(before?.usage.reads ?? 0);
    // A retry is the pipeline starting again, not a user action: no action
    // grant was issued.
    expect(app.service.actionBudgetOf(fixture.sessionId)).toBeUndefined();

    await app.runner.idle();
    // The two ledgers are separate and both真实: whatever the retried pass
    // spent is added to the project's lifetime total and to the attempt's own
    // counter, from an attempt that started at zero.
    const after = app.service.getTask(fixture.taskId);
    const spentByRetry = (after?.usage.searches ?? 0) - (before?.usage.searches ?? 0);
    expect(spentByRetry).toBeGreaterThan(0);
    expect(after?.attempt?.searches).toBe(spentByRetry);
    app.service.issueGrant({ sessionId: fixture.sessionId, intent: "research", taskId: fixture.taskId, targetType: "project", targetId: null, allowResearch: true, scope: "研究" });
    const search = await app.service.search(fixture.taskId, { query: "GraphRAG cost" });
    expect(search.ok).toBe(true);
    if (search.ok) {
      expect(search.budgetScope).toBe("project");
      // The remainder is counted against the attempt that governs the
      // pipeline, not against the project's lifetime total: the attempt has
      // spent one search, this call is the second.
      expect(search.searchesRemaining).toBe(Math.max(0, (after?.budget.maxSearches ?? 0) - ((after?.attempt?.searches ?? 0) + 1)));
      // The lifetime total is larger than the attempt's: both moved, and they
      // are answers to two different questions.
      expect(search.searchCount).toBeGreaterThan(after?.attempt?.searches ?? 0);
    }
  }, 120_000);
});
