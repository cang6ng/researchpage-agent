/**
 * The gate in front of the research pipeline.
 *
 * The failure this file is written against: a project nobody had confirmed was
 * given a normal Research action, the gap round it started ended, and the
 * runner's own automatic transition into the report stage minted a `report`
 * grant for it — so an unconfirmed task wrote a draft (and, one validator pass
 * away, a report) on a card the user had never agreed to. `/report` had refused
 * unconfirmed tasks from the start; the research pipeline was the other door
 * into the same writing, and it stood open.
 *
 * What is pinned here is that both doors answer the same way and that the gate
 * is the *only* thing that changed: the same request is accepted once the brief
 * is confirmed, and the automatic transition still happens then.
 *
 * Everything runs over the real composition — HTTP route → service → runner →
 * host run → tools → SQLite — with only the model and the network supplied.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelClient, ModelEvent, ModelMessage, ModelRequest, RuntimeContext } from "@every-dagent/agent-core";
import { DEFAULT_MODEL_FRAMING } from "@every-dagent/agent-core";
import type { ReadOutcome } from "@every-dagent/plugin-research";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startResearchApp, type ResearchApp } from "../src/server/composition.js";
import { testComposition } from "../../../tests/helpers/test-composition.js";

const workDir = mkdtempSync(join(tmpdir(), "researchpage-unconfirmed-gate-"));
const dataDir = join(workDir, "data");
const staticRoot = join(process.cwd(), "apps", "research", "public");
const dbPath = join(dataDir, "store", "research.db");

const PARAGRAPHS = [
  "MethodA builds a knowledge graph over the corpus with an LLM and retrieves by walking it, which is the mechanism this fixture paper describes in its third section.",
  "MethodB keeps text embeddings and adds a graph layer on top, so its indexing pass costs one additional extraction step over the whole corpus.",
];

function searchFixture(query: string) {
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
        landingUrl: "https://arxiv.org/abs/2404.16130",
        pdfUrl: null,
        publishedAt: "2024-04-24T00:00:00Z",
        arxivId: "2404.16130",
        venue: "arXiv cs.CL",
        doi: null,
      },
    ],
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

let app: ResearchApp;
/** Every model stream opened, and the grant that was in force when it opened. */
let calls: { readonly stage: string; readonly capabilities: readonly string[] }[] = [];
/** The task the model is currently answering for, so its grant can be read. */
let activeTaskId = "";
/** Distinct sessions per fixture, so one project's grants can never leak on. */
let fixtureCount = 0;

/**
 * A model that researches and then stops talking.
 *
 * The research pass is real enough to leave material behind — one search, one
 * read, one assessment — because that is what makes the pipeline want to write
 * a report, which is the transition under test. Everything after it answers
 * with text and no tool call, so the run ends and the program decides.
 */
function scriptedModel(): ModelClient {
  let step = 0;
  let runInstruction = "";
  let runStep = 0;
  return {
    limits: { contextWindow: 128 * 1024, maxOutputTokens: 8 * 1024, framing: DEFAULT_MODEL_FRAMING },
    stream(request: ModelRequest, _context: RuntimeContext): AsyncIterable<ModelEvent> {
      step += 1;
      const instruction = lastUserText(request.messages);
      const grant = app.service.activeGrant(app.service.getTask(activeTaskId)?.sessionId ?? "") ?? null;
      calls.push({ stage: instruction.slice(0, 16), capabilities: grant?.capabilities ?? [] });
      const results = toolResults(request.messages);
      const call = (name: string, input: unknown): readonly ModelEvent[] => [
        { type: "tool-call", call: { callId: `call-${String(step)}-${name}`, name, input } },
        { type: "done" },
      ];
      const say = (text: string): readonly ModelEvent[] => [{ type: "text-delta", text }, { type: "done" }];
      const next = (events: readonly ModelEvent[]): AsyncIterable<ModelEvent> =>
        (async function* () {
          for (const event of events) yield event;
        })();

      if (instruction.includes("任务卡已由用户确认")) {
        if (runInstruction !== instruction) {
          runInstruction = instruction;
          runStep = 0;
        }
        runStep += 1;
        if (runStep === 1) return next(call("load_research_state", {}));
        const state = (results.filter((result) => result.name === "load_research_state").slice(-1)[0]?.value["state"] ?? {}) as {
          subjects?: { id: string; name: string }[];
          dimensions?: { id: string; name: string }[];
        };
        const subjectId = state.subjects?.[0]?.id ?? "";
        const dimensionIds = (state.dimensions ?? []).map((dimension) => dimension.id);
        const searches = results.filter((result) => result.name === "search_sources");
        if (searches.length === 0) return next(call("search_sources", { query: "graph retrieval construction", limit: 1 }));
        const sourceId = ((searches[0]?.value["sources"] ?? []) as { sourceId: string }[])[0]?.sourceId ?? "";
        const reads = results.filter((result) => result.name === "read_source");
        if (reads.length === 0) {
          return next(
            call("read_source", {
              sourceId,
              question: "这套结构如何构建",
              terms: ["graph", "construction"],
              targetCell: { sectionId: "comparison", subjectId, dimensionId: dimensionIds[0] ?? "" },
              role: "primary",
              maxEvidence: 1,
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
                  cell: { sectionId: "comparison", subjectId, dimensionId: dimensionIds[0] ?? "" },
                  evidenceIds,
                  relationship: "supports",
                  directness: "direct",
                  scope: "作者在方法章节直接描述了构建步骤。",
                  note: "构建步骤有正文片段直接支持。",
                },
              ],
            }),
          );
        }
        return next(say("研究阶段完成。"));
      }
      return next(say("这一轮没有提交任何内容。"));
    },
  };
}

/**
 * A card the product really created, in a session the host really knows.
 *
 * The template is registered through the service rather than modelled, so the
 * fixture is an unconfirmed project and nothing else: no confirmTask call, no
 * hand-issued report grant, no second task.
 */
async function makeUnconfirmedTask(topic: string): Promise<{ readonly taskId: string; readonly sessionId: string }> {
  fixtureCount += 1;
  const created = await app.client.sessions.create();
  const sessionId = created.session.sessionId;
  app.service.issueGrant({ sessionId, intent: "card", taskId: null });
  const proposed = app.service.proposeTask(sessionId, {
    topic,
    purpose: "技术选型",
    audience: "工程师",
    focus: [],
    exclusions: "",
    lengthTarget: "约 4 页",
    subjects: [{ name: "MethodA" }, { name: "MethodB" }],
    dimensions: [
      { name: "机制", question: "机制如何" },
      { name: "成本", question: "成本如何" },
      { name: "效果", question: "效果如何" },
    ],
  });
  if (!proposed.ok) throw new Error(`card refused: ${proposed.problems.join("; ")}`);
  app.service.clearGrant(sessionId);
  return { taskId: proposed.task.id, sessionId };
}

async function post(path: string, body: unknown): Promise<{ readonly status: number; readonly json: Record<string, unknown> }> {
  const response = await fetch(`${app.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

/** The task as the disk holds it, read without the running app's help. */
function persistedTask(taskId: string): { readonly confirmedAt: string | null; readonly reportDraft: unknown } {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT payload FROM report_tasks WHERE id=?").get(taskId) as { payload: string } | undefined;
    if (row === undefined) throw new Error(`task ${taskId} is not on disk`);
    const payload = JSON.parse(row.payload) as { confirmedAt: string | null; reportDraft: unknown };
    return { confirmedAt: payload.confirmedAt, reportDraft: payload.reportDraft };
  } finally {
    db.close();
  }
}

beforeAll(async () => {
  app = await startResearchApp({
    dataDir,
    staticRoot,
    composition: testComposition({ modelClient: scriptedModel() }),
    overrides: {
      search: (query) => searchFixture(query),
      read: (request) => Promise.resolve(readFixture(request.url)),
    },
    log: () => undefined,
  });
}, 60_000);

afterAll(async () => {
  await app?.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe("an unconfirmed brief is the one thing neither door into research lets through", () => {
  it("refuses the Research action, and nothing is queued, granted or written", async () => {
    const fixture = await makeUnconfirmedTask("unconfirmed research");
    activeTaskId = fixture.taskId;
    const callsBefore = calls.length;

    const response = await post(`/api/research/tasks/${fixture.taskId}/assistant`, {
      intent: "research",
      text: "Find additional existing evidence.",
    });

    // The same word `/report` uses, because it is the same missing decision.
    expect(response.status, JSON.stringify(response.json)).toBe(409);
    expect(response.json["reason"]).toBe("brief_unconfirmed");
    expect(String(response.json["error"])).toContain("还没有确认");
    expect(String(response.json["guidance"])).toContain("确认研究简报");

    // Nothing ran: no stage was queued, no model was asked, no grant was minted
    // and no draft exists — in memory or on disk.
    expect(calls.length, "a refused action must not call the model").toBe(callsBefore);
    expect(app.service.runsOf(fixture.taskId)).toEqual([]);
    expect(app.service.activeGrant(fixture.sessionId)).toBeUndefined();
    expect(app.service.reportDraftOf(fixture.taskId)).toBeNull();
    expect(app.runner.queued).toBe(0);
    expect(app.runner.busy).toBe(false);

    const persisted = persistedTask(fixture.taskId);
    expect(persisted.confirmedAt).toBeNull();
    expect(persisted.reportDraft).toBeNull();
  });

  it("refuses the runner's own entry too, whatever calls it", async () => {
    const fixture = await makeUnconfirmedTask("unconfirmed runner entry");
    activeTaskId = fixture.taskId;
    const view = app.runner.startResearchAction(fixture.taskId, {
      text: "Find additional existing evidence.",
      reading: "用户显式选择 research",
    });
    expect(view).toBeDefined();
    if (view === undefined || !("ok" in view)) throw new Error(`expected a refusal, got ${JSON.stringify(view)}`);
    expect(view.reason).toBe("brief_unconfirmed");
    expect(view.problems.join(" ")).toContain("还没有确认");
    expect(app.runner.queued).toBe(0);
    expect(app.service.runsOf(fixture.taskId)).toEqual([]);
  });

  it("stops an automatic pass before the report stage, and leaves no report permission behind", async () => {
    const fixture = await makeUnconfirmedTask("unconfirmed pipeline");
    activeTaskId = fixture.taskId;
    calls = [];
    app.service.startResearch(fixture.taskId);
    app.runner.startResearch(fixture.taskId);
    await app.runner.idle();

    // The pass read real material, so the pipeline wanted to write it up — and
    // that is exactly the transition the gate refuses.
    const runs = app.service.runsOf(fixture.taskId).map((run) => run.stage);
    expect(runs).toContain("research");
    expect(runs).toContain("gap");
    expect(runs).not.toContain("report");
    expect(runs).not.toContain("synthesis");

    const task = app.service.getTask(fixture.taskId);
    expect(task?.status, "the project must not be left researching forever").toBe("failed");
    expect(String(task?.error)).toContain("研究简报还没有确认");
    expect(task?.reportGeneration ?? null).toBeNull();
    expect(app.service.reportDraftOf(fixture.taskId)).toBeNull();
    expect(task?.currentReportId).toBeNull();
    // No run ever held the capability the writing needs — the grant the review
    // caught being minted automatically.
    const reportGrants = calls.filter((entry) => entry.capabilities.includes("report"));
    expect(reportGrants, "no model call may run under a report grant").toEqual([]);
    expect(calls.length).toBeGreaterThan(0);
    expect(app.service.activeGrant(fixture.sessionId)).toBeUndefined();
    expect(app.runner.queued).toBe(0);
    expect(app.runner.busy).toBe(false);
    expect(persistedTask(fixture.taskId).reportDraft).toBeNull();
  }, 60_000);

  it("lets the same Research action through once the brief is confirmed", async () => {
    const fixture = await makeUnconfirmedTask("confirmed research");
    activeTaskId = fixture.taskId;
    const confirmed = app.service.confirmTask(fixture.taskId);
    expect(confirmed.ok, JSON.stringify(confirmed)).toBe(true);

    const response = await post(`/api/research/tasks/${fixture.taskId}/assistant`, {
      intent: "research",
      text: "Find additional existing evidence.",
    });
    expect(response.status, JSON.stringify(response.json)).toBe(202);
    expect(response.json["started"]).toBe("research");
    await app.runner.idle();
    // The gate is the only thing that changed: the confirmed project enters the
    // same pipeline and its补查 runs.
    expect(app.service.runsOf(fixture.taskId).map((run) => run.stage)).toContain("gap");
    expect(app.service.getTask(fixture.taskId)?.confirmedAt).not.toBeNull();
  });
});
