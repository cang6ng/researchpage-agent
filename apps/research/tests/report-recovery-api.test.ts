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
import { PiAiRequestFailure } from "@every-dagent/model-pi-ai";
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
    total: 2,
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
      {
        provider: "arxiv" as const,
        providerId: "2404.16131",
        title: "A Second Fixture Paper on Graph Retrieval",
        authors: ["A. Vertex"],
        abstract: "A second fixture method whose indexing pass costs one more extraction step.",
        landingUrl: "https://arxiv.org/abs/2404.16131",
        pdfUrl: null,
        publishedAt: "2024-04-25T00:00:00Z",
        arxivId: "2404.16131",
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
 * That message carries no trusted status, which is exactly why the honest
 * classification for it is「原因未知」rather than a guess at a balance.
 *
 * `report_full` writes a real report through the real stages: the same sections,
 * table and claims the end-to-end pipeline test proves are accepted, so the
 * tests that need a *stored* report get one from the product's own validator
 * rather than from a fixture that pretends.
 *
 * `research_unknown` is the failure nobody can classify: a research pass reads
 * its material and then the provider fails with a plain error — no status, no
 * fixed sentence, no cause the product may name. It is the shape the closure
 * review measured 25 model calls on: the pass failed, and a report pass, a
 * synthesis pass and a repair synthesis were all spent on top of it.
 */
let mode:
  | "research"
  | "research_unknown"
  | "report_ok"
  | "provider_down"
  | "report_full"
  | "rate_limited_once"
  | "rate_limited_always" = "research";
/** How many times the scripted provider has refused with a trusted status. */
let refusals = 0;
/** Every stream the scripted provider was asked to open, for the call-count tests. */
let modelCalls = 0;

function next(events: readonly ModelEvent[]): AsyncIterable<ModelEvent> {
  return (async function* () {
    for (const event of events) yield event;
  })();
}

function scriptedModel(): ModelClient {
  let step = 0;
  /** Which instruction the writer is currently answering, and how far into it. */
  let runInstruction = "";
  let runStep = 0;
  return {
    limits: { contextWindow: 128 * 1024, maxOutputTokens: 8 * 1024, framing: DEFAULT_MODEL_FRAMING },
    stream(request: ModelRequest, _context: RuntimeContext): AsyncIterable<ModelEvent> {
      step += 1;
      modelCalls += 1;
      if (mode === "provider_down") {
        // Thrown synchronously, like a provider that rejects on the way out.
        throw new NonRetryableModelError("the provider request failed");
      }
      if (mode === "rate_limited_once" && refusals === 0) {
        refusals += 1;
        throw new PiAiRequestFailure("rate_limited");
      }
      if (mode === "rate_limited_always") {
        refusals += 1;
        throw new PiAiRequestFailure("service_unavailable");
      }
      const instruction = lastUserText(request.messages);
      const results = toolResults(request.messages);
      const call = (name: string, input: unknown): readonly ModelEvent[] => [
        { type: "tool-call", call: { callId: `call-${step}-${name}`, name, input } },
        { type: "done" },
      ];
      const say = (text: string): readonly ModelEvent[] => [{ type: "text-delta", text }, { type: "done" }];

      const stateOf = (): {
        readonly subjects: readonly { readonly id: string; readonly name: string }[];
        readonly dimensions: readonly { readonly id: string; readonly name: string }[];
        readonly evidenceForSubject: (subjectId: string) => string[];
      } => {
        const loads = results.filter((result) => result.name === "load_research_state");
        const state = (loads[loads.length - 1]?.value["state"] ?? {}) as {
          subjects?: { id: string; name: string }[];
          dimensions?: { id: string; name: string }[];
          cells?: { subjectId: string; dimensionId: string; evidenceIds: string[] }[];
        };
        const cells = state.cells ?? [];
        return {
          subjects: state.subjects ?? [],
          dimensions: state.dimensions ?? [],
          evidenceForSubject: (subjectId: string): string[] => [
            ...new Set(cells.filter((cell) => cell.subjectId === subjectId).flatMap((cell) => cell.evidenceIds)),
          ],
        };
      };

      if (instruction.includes("任务卡已由用户确认")) {
        const searches = results.filter((result) => result.name === "search_sources");
        const reads = results.filter((result) => result.name === "read_source");
        // The unclassifiable failure, raised on the call after the material has
        // really been read: the pass has something to write about, which is the
        // only reason the pipeline would ever consider writing it up.
        if (mode === "research_unknown" && reads.length > 0) {
          throw new Error("the fixture provider vanished without a word");
        }
        // The card's own ids are read from the tool that publishes them: this
        // fixture confirms a card the way the product does, and a guessed
        // dimension id would bind nothing.
        const loaded = stateOf();
        if (loaded.subjects.length === 0 || loaded.dimensions.length === 0) return next(call("load_research_state", {}));
        if (searches.length === 0) return next(call("search_sources", { query: "graph retrieval construction", limit: 2 }));
        const subjects = loaded.subjects;
        const dimensions = loaded.dimensions;
        const sources = (searches[0]?.value["sources"] ?? []) as { sourceId: string }[];
        // One read per source, each aimed at one subject's cell: a report that
        // has to pass the validator needs material from more than one source,
        // and evidence is only bound to a cell it was read for.
        const readAlready = new Set(reads.map((result) => String(result.value["sourceId"])));
        const nextRead = sources
          .map((source, index) => ({ source, index }))
          .find(({ source }) => !readAlready.has(source.sourceId));
        if (nextRead !== undefined) {
          return next(
            call("read_source", {
              sourceId: nextRead.source.sourceId,
              question: `${subjects[nextRead.index]?.name ?? "对象"} 的构建与检索机制`,
              terms: ["graph", "index"],
              role: "primary",
              maxEvidence: 2,
              targetCell: {
                sectionId: "comparison",
                subjectId: subjects[nextRead.index]?.id ?? subjects[0]?.id ?? "sub_methoda",
                dimensionId: dimensions[0]?.id ?? "dim_mechanism",
              },
            }),
          );
        }
        if (!results.some((result) => result.name === "assess_coverage")) {
          const evidenceFor = (sourceId: string): string[] =>
            reads
              .filter((result) => String(result.value["sourceId"]) === sourceId)
              .flatMap((result) => ((result.value["evidence"] ?? []) as { evidenceId: string }[]).map((item) => item.evidenceId));
          return next(
            call("assess_coverage", {
              proposals: sources.map((source, index) => ({
                cell: {
                  sectionId: "comparison",
                  subjectId: subjects[index]?.id ?? subjects[0]?.id ?? "",
                  dimensionId: dimensions[0]?.id ?? "",
                },
                evidenceIds: evidenceFor(source.sourceId),
                relationship: "supports",
                directness: "direct",
                scope: "正文直接描述了构建流程。",
                note: "构建流程有正文片段直接支持。",
              })),
            }),
          );
        }
        return next(say("研究阶段完成。"));
      }

      if (mode === "report_ok") return next(say("报告阶段在这个测试里由预置草稿承担。"));

      // The writer, for the tests that need a report the product really stored.
      //
      // It follows the stage's own instructions step by step, the way the
      // end-to-end pipeline's writer does: one load, one start, one write per
      // section, then finalize. Nothing here decides what the report says — the
      // Validator does, and it is the product's own Validator.
      if (mode === "report_full" || mode === "rate_limited_once") {
        // Per run, not per instruction: a retry runs the same instruction again
        // with an empty transcript, and its writer has to start at the load.
        if (runInstruction !== instruction || results.length === 0) {
          runInstruction = instruction;
          runStep = 0;
        }
        runStep += 1;
        if (runStep === 1) return next(call("load_research_state", {}));
        const view = stateOf();
        const { subjects, dimensions, evidenceForSubject } = view;
        const dim = (index: number): string => dimensions[index]?.id ?? "";
        const subjectIds = subjects.map((subject) => subject.id);
        const a = evidenceForSubject(subjectIds[0] ?? "")[0] ?? "";
        const b = evidenceForSubject(subjectIds[1] ?? "")[0] ?? a;

        if (instruction.includes("报告的第一部分")) {
          if (runStep === 2) {
            return next(
              call("save_report", {
                part: "start",
                title: "两个对象：机制差异与证据边界",
                summary: "本报告比较两个对象在构建与检索机制上的差异，并说明现有材料不能支持的结论。",
                frame: {
                  question: "两个对象在机制上有什么可比较的差异，现有材料能支持到什么程度？",
                  audience: "工程团队的评审",
                  scope: "只覆盖本次读到的两篇材料，不声称覆盖该领域全部工作。",
                },
                claims: [
                  {
                    id: "clm_a_build",
                    claimType: "mechanism",
                    text: "第一个对象先用 LLM 抽取语料并建图，再沿着结构检索。",
                    evidenceIds: [a],
                    kind: "fact",
                    subjects: [subjectIds[0] ?? ""],
                    dimensions: [dim(0), dim(1)],
                  },
                  {
                    id: "clm_b_build",
                    claimType: "mechanism",
                    text: "第二个对象在文本嵌入之上加了一层图结构，索引期多一次抽取。",
                    evidenceIds: [b],
                    kind: "fact",
                    subjects: [subjectIds[1] ?? ""],
                    dimensions: [dim(1), dim(2)],
                  },
                  {
                    id: "clm_compare",
                    claimType: "comparison",
                    text: "两者的构建产物不同：一个是抽取后的图，一个是叠加在嵌入上的图。",
                    evidenceIds: [a, b],
                    kind: "comparison",
                    subjects: subjectIds,
                    dimensions: [dim(1)],
                    conditions: { scope: "只比较构建产物与检索方式，不比较效果。" },
                  },
                  {
                    id: "clm_cost",
                    claimType: "cost",
                    text: "在各自报告的口径内，两者的索引期都要额外调用一次 LLM；规模与硬件未对齐。",
                    evidenceIds: [a, b],
                    kind: "fact",
                    subjects: subjectIds,
                    conditions: {
                      costStage: "indexing",
                      comparability: "not-directly-comparable",
                      basis: "author-reported",
                      scope: "两篇材料各自报告口径，规模与硬件未对齐，不能直接比较。",
                    },
                  },
                  {
                    id: "clm_limit",
                    claimType: "fact",
                    text: "现有材料没有独立评估：效果与成本都来自各自的自报口径。",
                    evidenceIds: [b],
                    kind: "fact",
                  },
                ],
              }),
            );
          }
          const pass: readonly { readonly id: string; readonly title: string; readonly blocks: readonly unknown[] }[] = [
            {
              id: "overview",
              title: "一、研究问题与关键认识",
              blocks: [
                { kind: "paragraph", text: "本次比较只覆盖读到的两篇材料，范围与结论都限定在这批材料内。", claimIds: [] },
                { kind: "list", items: [{ text: "两者都使用图结构，但结构信息被使用的位置不同。", claimIds: ["clm_compare"] }] },
                { kind: "callout", tone: "gap", text: "关键限制：没有独立评估，本报告不给出排名。" },
              ],
            },
            {
              id: "mental-model",
              title: "二、概念坐标",
              blocks: [
                {
                  kind: "paragraph",
                  text: "图结构检索的共同思路是把实体与关系显式保存成结构，再让查询使用它；可以按「结构在哪个阶段被使用」分类，这条轴是后面比较的坐标。",
                  claimIds: ["clm_a_build"],
                },
                {
                  kind: "list",
                  items: [
                    { text: "构图期：实体与关系在建索引时被写成结构。", claimIds: ["clm_a_build"] },
                    { text: "查询期：结构被遍历或扩散，用来取回片段。", claimIds: ["clm_b_build"] },
                  ],
                },
              ],
            },
            {
              id: "mechanism",
              title: "三、机制解释",
              blocks: [
                {
                  kind: "mechanism",
                  title: "第一个对象的抽取与检索",
                  input: "整份语料的文本单元。",
                  intermediate: "实体关系图。",
                  steps: [
                    { text: "从每个文本单元抽取实体与关系。", claimIds: ["clm_a_build"] },
                    { text: "沿图检索，把相关片段带回回答。", claimIds: ["clm_a_build"] },
                  ],
                  output: "可被遍历的结构。",
                  tradeoff: "用一次覆盖全语料的处理换取结构化检索。",
                  failure: "抽取质量差时结构会失真。",
                  claimIds: ["clm_a_build"],
                },
              ],
            },
            {
              id: "representative",
              title: "四、代表工作与对象身份",
              blocks: [
                { kind: "paragraph", text: "第一个对象以抽取后的图为核心产物。", claimIds: ["clm_a_build"] },
                { kind: "paragraph", text: "第二个对象以叠加在嵌入之上的图为核心机制。", claimIds: ["clm_b_build"] },
              ],
            },
          ];
          const section = pass[runStep - 3];
          if (section !== undefined) return next(call("save_report", { part: "write", section }));
          return next(say("第一部分已提交，等待综合阶段完成比较、综合与发布。"));
        }

        if (instruction.includes("写第二部分") || instruction.includes("修正下面这些未满足的义务")) {
          if (runStep === 2) {
            return next(
              call("save_report", {
                part: "write",
                section: {
                  id: "comparison",
                  title: "五、条件化比较",
                  blocks: [
                    {
                      kind: "table",
                      columns: ["对象", dimensions[1]?.name ?? "结构与构建", dimensions[2]?.name ?? "检索机制"],
                      columnDimensions: [null, dim(1), dim(2)],
                      rowSubjects: subjectIds,
                      rows: [
                        {
                          cells: [
                            { text: subjects[0]?.name ?? "A", claimIds: [] },
                            { text: "抽取后的实体关系图", claimIds: ["clm_a_build"] },
                            { text: "沿图遍历取回片段", claimIds: ["clm_compare"] },
                          ],
                        },
                        {
                          cells: [
                            { text: subjects[1]?.name ?? "B", claimIds: [] },
                            { text: "嵌入之上叠加的图", claimIds: ["clm_b_build"] },
                            { text: "由图扩展候选片段", claimIds: ["clm_compare"] },
                          ],
                        },
                      ],
                    },
                    { kind: "paragraph", text: "两者的构建产物不同，这是比较中最直接的差异。", claimIds: ["clm_compare"] },
                    {
                      kind: "callout",
                      tone: "gap",
                      dimensionIds: [dim(2)],
                      text: "实验与评测：只有各自材料的自报口径，没有共同设置下的对照，只能并列报告，不作统一排名。",
                    },
                  ],
                },
              }),
            );
          }
          if (runStep === 3) {
            return next(
              call("save_report", {
                part: "write",
                claims: [
                  {
                    id: "clm_synthesis",
                    claimType: "synthesis",
                    synthesis: true,
                    text: "综合两篇材料可以看出：差异不在是否使用图结构，而在结构信息被使用的阶段。",
                    evidenceIds: [a, b],
                    kind: "inference",
                    subjects: subjectIds,
                    conditions: { scope: "由两条机制证据共同支持；没有独立评估，属于我们的综合判断。" },
                  },
                  {
                    id: "clm_implication",
                    claimType: "implication",
                    text: "若主要问题是结构化的整合检索，可先评估这两个对象；具体选择需要在自有语料上验证。",
                    evidenceIds: [a, b],
                    kind: "inference",
                    subjects: subjectIds,
                    conditions: { scope: "条件取决于实际查询类型；两篇材料的评测设置不同。", comparability: "not-directly-comparable" },
                  },
                ],
              }),
            );
          }
          if (runStep === 4) {
            return next(
              call("save_report", {
                part: "write",
                section: {
                  id: "synthesis",
                  title: "六、综合判断与权衡",
                  blocks: [
                    { kind: "paragraph", text: "综合两篇材料可以看出：差异不在是否使用图结构，而在结构信息被使用的阶段。", claimIds: ["clm_synthesis"] },
                    {
                      kind: "paragraph",
                      text: "这个区分带来一个可检验的取舍：结构在构建期建立，还是在查询期被使用；两者的成本对照口径不同，因此这里只作为条件化建议。",
                      claimIds: ["clm_implication"],
                    },
                  ],
                },
              }),
            );
          }
          if (runStep === 5) {
            return next(
              call("save_report", {
                part: "write",
                section: {
                  id: "limitations",
                  title: "七、局限、未知与下一步",
                  blocks: [
                    {
                      kind: "list",
                      items: [
                        { text: "缺独立评估：效果差异只有作者自报口径。", claimIds: ["clm_limit"] },
                        { text: "成本口径不同：规模与硬件未对齐，不能合成一个「更便宜」。", claimIds: ["clm_cost"] },
                        { text: "下一步应查共同设置下的对照实验。", claimIds: [] },
                      ],
                    },
                  ],
                },
              }),
            );
          }
          if (runStep === 6) return next(call("save_report", { part: "finalize" }));
          return next(say("比较、综合与结论已提交，报告已保存。"));
        }
      }

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
    const runsBefore = app.service.runsOf(fixture.taskId).length;
    const first = await post(`/api/research/tasks/${fixture.taskId}/report`);
    expect(first.status).toBe(202);
    // 202 is "accepted": no report exists yet, and the answer says so.
    expect(first.body["reportId"]).toBeNull();
    expect(first.body["started"]).toBe("report");
    await app.runner.idle();

    const failed = generationOf(await bundle(fixture.taskId));
    expect(failed["status"]).toBe("failed");
    // The failure is classified, not left as an opaque host error — and it is
    // classified honestly: this failure carries no trusted status, so the code
    // says the reason is unknown instead of sending the reader to check a
    // balance nobody measured.
    const failure = failed["failure"] as { category: string; code: string; guidance: string; retryable: boolean };
    expect(failure.category).toBe("model_request");
    expect(failure.code).toBe("model_request_failed");
    expect(failure.retryable).toBe(false);
    expect(failure.guidance.length).toBeGreaterThan(0);
    expect(failed["canResume"]).toBe(true);
    expect(app.service.getTask(fixture.taskId)?.currentReportId).toBeNull();
    // A permanent failure is not retried, and it does not drag synthesis along
    // behind it: exactly one report pass was spent, and nothing followed it.
    const spent = app.service.runsOf(fixture.taskId).slice(runsBefore);
    expect(spent.map((run) => run.stage)).toEqual(["report"]);

    // The recovery the reader is offered: a new attempt at the *report*, over
    // the same material — no second search, no second pass over the sources.
    const firstAttemptId = app.service.reportGenerationOf(fixture.taskId)?.attemptId ?? "";
    mode = "report_ok";
    const resumed = await post(`/api/research/tasks/${fixture.taskId}/report`);
    expect(resumed.status).toBe(202);
    const resumedAttemptId = app.service.reportGenerationOf(fixture.taskId)?.attemptId ?? "";
    expect(resumedAttemptId).not.toBe(firstAttemptId);
    expect(resumedAttemptId.length).toBeGreaterThan(0);
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
    // The report is produced the way the product produces one: the writer runs
    // through the real stages and the real `save_report` tool, and what is
    // stored is what the Validator accepted. A fixture that stored an
    // incomplete draft would test the guard against a report that is not one.
    mode = "report_full";
    const accepted = await post(`/api/research/tasks/${fixture.taskId}/report`);
    expect(accepted.status).toBe(202);
    await app.runner.idle();
    const stored = app.service.getTask(fixture.taskId)?.currentReportId ?? null;
    expect(stored).not.toBeNull();

    const runsBefore = app.service.runsOf(fixture.taskId).length;
    const response = await post(`/api/research/tasks/${fixture.taskId}/report`);
    expect(response.status).toBe(409);
    expect(response.body["reason"]).toBe("report_exists");
    expect(response.body["reportId"]).toBe(stored);
    // Nothing was queued and no model was called: the guard is a guard, not a
    // stage that fails later.
    expect(app.service.runsOf(fixture.taskId).length).toBe(runsBefore);
    await app.runner.idle();
    expect(app.service.runsOf(fixture.taskId).length).toBe(runsBefore);
  }, 120_000);

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

describe("the one automatic retry, and only where it belongs (F04)", () => {
  it("retries a rate limit once, and the retry can succeed", async () => {
    const fixture = await openTask("限流一次：自动再试一次");
    await runResearch(fixture.taskId);
    mode = "rate_limited_once";
    refusals = 0;
    const runsBefore = app.service.runsOf(fixture.taskId).length;
    const accepted = await post(`/api/research/tasks/${fixture.taskId}/report`);
    expect(accepted.status).toBe(202);
    await app.runner.idle();
    // Two attempts at the report — the refused one and its retry — and the
    // second one went on to write the report, so the retry is real work.
    const runs = app.service.runsOf(fixture.taskId).slice(runsBefore);
    expect(runs.filter((run) => run.stage === "report")).toHaveLength(2);
    expect(app.service.getTask(fixture.taskId)?.currentReportId).not.toBeNull();
  }, 120_000);

  it("stops after the second attempt when the rate limit persists", async () => {
    const fixture = await openTask("限流持续：最多两次调用");
    await runResearch(fixture.taskId);
    mode = "rate_limited_always";
    refusals = 0;
    const runsBefore = app.service.runsOf(fixture.taskId).length;
    const accepted = await post(`/api/research/tasks/${fixture.taskId}/report`);
    expect(accepted.status).toBe(202);
    await app.runner.idle();
    // Exactly two report attempts and nothing else: the failure is classified
    // as a temporary service problem, and the pipeline does not spend a
    // synthesis pass against the same wall.
    const runs = app.service.runsOf(fixture.taskId).slice(runsBefore);
    expect(runs.map((run) => run.stage)).toEqual(["report", "report"]);
    expect(refusals).toBe(2);
    const generation = generationOf(await bundle(fixture.taskId));
    expect(generation["status"]).toBe("failed");
    const failure = generation["failure"] as { code: string; retryable: boolean };
    expect(failure.code).toBe("model_service_unavailable");
    expect(failure.retryable).toBe(true);
    expect(generation["canResume"]).toBe(true);
    // The queue is empty again, so the button is usable rather than waiting for
    // work that no longer exists.
    expect(app.runner.hasReportWork(fixture.taskId)).toBe(false);
  }, 120_000);

  it("does not retry a permanent refusal", async () => {
    const fixture = await openTask("永久拒绝：不自动重试");
    await runResearch(fixture.taskId);
    mode = "provider_down";
    const runsBefore = app.service.runsOf(fixture.taskId).length;
    const accepted = await post(`/api/research/tasks/${fixture.taskId}/report`);
    expect(accepted.status).toBe(202);
    await app.runner.idle();
    const runs = app.service.runsOf(fixture.taskId).slice(runsBefore);
    expect(runs.map((run) => run.stage)).toEqual(["report"]);
    // The generation says the same thing the run does: one attempt, no retry,
    // and a reason nobody measured a balance for.
    const generation = generationOf(await bundle(fixture.taskId));
    expect((generation["failure"] as { code: string }).code).toBe("model_request_failed");
    expect(generation["canResume"]).toBe(true);
  }, 120_000);
});

describe("failures that must not be followed by more work (F03, F04)", () => {
  it("stops the pipeline when a research pass fails for a reason nobody could classify", async () => {
    const fixture = await openTask("研究失败：原因未知时不再自动写作");
    const callsBefore = modelCalls;

    mode = "research_unknown";
    app.service.issueGrant({ sessionId: fixture.sessionId, intent: "research", taskId: fixture.taskId, allowResearch: true });
    app.service.startResearch(fixture.taskId);
    app.runner.startResearch(fixture.taskId);
    await app.runner.idle();
    const callsAtRest = modelCalls;
    mode = "research";

    // The failure is reported in the product's own vocabulary: the reason is
    // unknown, and it does not send the reader to check something nobody
    // measured.
    const task = app.service.getTask(fixture.taskId);
    expect(task?.status).toBe("failed");
    expect(task?.error ?? "").toContain("没有取得可安全分类的原因");

    // Nothing downstream ran at all: no report pass, no synthesis, no repair —
    // the closure review measured a report, two syntheses and 25 model calls
    // here. The pass itself is four calls in this fixture (load, search, read,
    // and the call that is refused), and all four are the research pass's own.
    const spent = app.service.runsOf(fixture.taskId);
    expect(spent.map((run) => run.stage)).toEqual(["research"]);
    expect(spent[0]?.status).toBe("failed");
    expect(app.service.reportGenerationOf(fixture.taskId)).toBeNull();
    expect(callsAtRest - callsBefore).toBe(4);
  }, 120_000);

  it("ends the attempt and releases the grant when the host refuses to start the run", async () => {
    const fixture = await openTask("启动失败：生成必须进入可恢复终态");
    await runResearch(fixture.taskId);
    const callsBefore = modelCalls;

    const start = app.client.runs.start;
    (app.client.runs as { start: typeof start }).start = async () => {
      throw new Error("独立的 Host 启动失败注入");
    };
    try {
      const accepted = await post(`/api/research/tasks/${fixture.taskId}/report`);
      expect(accepted.status).toBe(202);
      await app.runner.idle();
    } finally {
      (app.client.runs as { start: typeof start }).start = start;
    }

    // No run existed, so nothing was asked of the model — and the two things
    // only the stage itself can close are closed: the permission it minted and
    // the attempt it opened. Left open, they are the state the reader cannot
    // recover from: a project that looks busy with nothing running.
    expect(modelCalls).toBe(callsBefore);
    expect(app.service.activeGrant(fixture.sessionId)).toBeUndefined();
    const generation = generationOf(await bundle(fixture.taskId));
    expect(generation["status"]).toBe("failed");
    expect(generation["endedAt"]).not.toBeNull();
    expect(generation["canResume"]).toBe(true);
    expect(app.service.getTask(fixture.taskId)?.status).toBe("failed");
    const reports = app.service.runsOf(fixture.taskId).filter((run) => run.stage === "report");
    expect(reports.at(-1)?.status).toBe("failed");
    expect(reports.at(-1)?.note ?? "").toContain("启动失败");
  }, 120_000);
});

describe("the attempt a stage belongs to, and the work it may not disturb", () => {
  it("refuses a callback that names an attempt it no longer owns", async () => {
    const fixture = await openTask("attempt 守卫：旧回调不许改新 attempt");
    const opened = app.service.beginReportGeneration(fixture.taskId, { stage: "report", resume: false });
    if (!("attemptId" in opened)) throw new Error("the attempt was refused");
    // A stage queued before a recovery belongs to the attempt before it. Its
    // callback may not move — or close — the attempt that replaced it.
    const stale = app.service.recordReportStage(
      fixture.taskId,
      { status: "validated", endedAt: new Date().toISOString() },
      "jrn_someone_elses_attempt",
    );
    expect(stale).toBeUndefined();
    expect(app.service.reportGenerationOf(fixture.taskId)?.status).toBe("running");
    // The attempt's own callback is the one that moves it.
    const mine = app.service.recordReportStage(fixture.taskId, { status: "draft_saved" }, opened.attemptId);
    expect(mine?.status).toBe("draft_saved");
  }, 60_000);

  it("does not converge a project this process is still working on", async () => {
    const fixture = await openTask("活动运行：启动收敛不得动它");
    await runResearch(fixture.taskId);
    mode = "report_full";
    const accepted = await post(`/api/research/tasks/${fixture.taskId}/report`);
    expect(accepted.status).toBe(202);
    const opened = app.service.reportGenerationOf(fixture.taskId);
    expect(opened?.status).toBe("running");
    // Convergence is a statement about a process that is gone. Asking for it
    // while this runner is executing must leave the live attempt alone.
    app.runner.reconcileInterrupted();
    const after = app.service.reportGenerationOf(fixture.taskId);
    expect(after?.status).toBe("running");
    expect(after?.attemptId).toBe(opened?.attemptId);
    expect(app.service.runsOf(fixture.taskId).find((run) => run.stage === "report" && run.status === "running")).toBeDefined();
    await app.runner.idle();
    expect(app.service.getTask(fixture.taskId)?.currentReportId).not.toBeNull();
  }, 120_000);

  it("gives an explicit re-research a report attempt of its own", async () => {
    const fixture = await openTask("重新研究：新 attempt，不用上次失败");
    await runResearch(fixture.taskId);
    mode = "provider_down";
    const failedRun = await post(`/api/research/tasks/${fixture.taskId}/report`);
    expect(failedRun.status).toBe(202);
    await app.runner.idle();
    const failed = app.service.reportGenerationOf(fixture.taskId);
    expect(failed?.status).toBe("failed");
    const searchesBefore = app.service.getTask(fixture.taskId)?.usage.searches ?? 0;

    // The user asks for the research again. That is a new pass, and the report
    // it eventually produces belongs to a new attempt — the failed one is not
    // silently reopened.
    mode = "report_full";
    const retried = await post(`/api/research/tasks/${fixture.taskId}/retry-research`);
    expect(retried.status).toBe(202);
    await app.runner.idle();
    const next = app.service.reportGenerationOf(fixture.taskId);
    expect(next?.attemptId).not.toBe(failed?.attemptId);
    expect(app.service.getTask(fixture.taskId)?.currentReportId).not.toBeNull();
    // The retry was a real research pass: it spent its own searches.
    expect(app.service.getTask(fixture.taskId)?.usage.searches).toBeGreaterThan(searchesBefore);
  }, 180_000);

  // Last in the file on purpose: a shutdown stops this runner for good.
  it("closes the attempt it is shutting down over, and drops its queued work", async () => {
    const fixture = await openTask("关闭：排队中的 attempt 会被关闭");
    await runResearch(fixture.taskId);
    const accepted = await post(`/api/research/tasks/${fixture.taskId}/report`);
    expect(accepted.status).toBe(202);
    await app.runner.shutdown();
    const generation = app.service.reportGenerationOf(fixture.taskId);
    expect(generation?.status).toBe("failed");
    const view = generationOf(await bundle(fixture.taskId));
    // The reader is told the attempt was cancelled rather than left wondering
    // whether it is still running, and the recovery is open.
    expect(view["status"]).toBe("failed");
    expect(view["canResume"]).toBe(true);
    expect(app.service.getTask(fixture.taskId)?.currentReportId).toBeNull();
  }, 120_000);
});
