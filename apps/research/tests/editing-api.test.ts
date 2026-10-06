/**
 * The editing semantics over the product's real surface.
 *
 * The plugin-level tests prove the contracts at the service; this one proves
 * they survive the trip a user's click actually takes — HTTP route → application
 * decision → action grant → runner → host run → tools → service → database. It
 * is the same composition the demo runs, with the model and the network
 * supplied, so what it exercises is the product and not a stand-in.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelClient, ModelEvent, ModelMessage, ModelRequest, RuntimeContext } from "@every-dagent/agent-core";
import { DEFAULT_MODEL_FRAMING } from "@every-dagent/agent-core";
import type { TrustedComposition } from "@every-dagent/host";
import type { ReadOutcome } from "@every-dagent/plugin-research";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startResearchApp, type ResearchApp } from "../src/server/composition.js";

const workDir = mkdtempSync(join(tmpdir(), "researchpage-editing-"));
const dataDir = join(workDir, "data");
const staticRoot = join(process.cwd(), "apps", "research", "public");

// ------------------------------------------------------------------ fixtures ---

const PAPER_PARAGRAPHS = [
  "GraphRAG extracts a knowledge graph from a corpus with an LLM, partitions it into communities by hierarchical clustering, and pre-generates community summaries for query-focused summarization.",
  "The construction pipeline has two stages: entity and relationship extraction from each source text unit, followed by community detection using the Leiden algorithm and summarization of each community.",
  "At query time GraphRAG supports global search over community summaries and local search that walks entity neighbourhoods and their connected text units.",
  "Costs are dominated by graph construction, which needs one LLM pass over the whole corpus before any question is asked.",
];

const URL_ONE = "https://arxiv.org/abs/2404.16130";

const URL_TWO = "https://arxiv.org/abs/2405.14831";

/** The discovery path: fixed candidates, so the flow never depends on a network. */
function searchFixture(query: string, options: { readonly limit: number }) {
  return Promise.resolve({
    provider: "arxiv" as const,
    query,
    requestUrl: `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}`,
    fetchedAt: new Date().toISOString(),
    total: 2,
    candidates: [
      {
        title: "From Local to Global: A GraphRAG Approach to Query-Focused Summarization",
        authors: ["D. Edge"],
        abstract: "We describe a graph-based retrieval method and its evaluation over a corpus.",
        absUrl: URL_ONE,
        pdfUrl: null,
        publishedAt: "2024-04-24T00:00:00Z",
        arxivId: "2404.16130",
        primaryCategory: "cs.CL",
        doi: null,
      },
      {
        title: "HippoRAG: Neurobiologically Inspired Long-Term Memory",
        authors: ["B. Author"],
        abstract: "A second fixture source, used when a later round searches again.",
        absUrl: URL_TWO,
        pdfUrl: null,
        publishedAt: "2024-05-24T00:00:00Z",
        arxivId: "2405.14831",
        primaryCategory: "cs.CL",
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

// ------------------------------------------------------------ scripted model ---

/**
 * The tool results of the *current* turn.
 *
 * The conversation carries every earlier run, so a script that counted all
 * results would see the report stage's `save_report` while answering an Ask and
 * would think its work was already done. Only what came back after the newest
 * instruction belongs to the instruction being served.
 */
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

function instructionOf(messages: readonly ModelMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return message.text;
  }
  return "";
}

interface Scripted {
  readonly client: ModelClient;
  /** Tool calls the scripted model made, in order. */
  readonly attempts: string[];
  /** Refusals the model received, as the tool answered them. */
  readonly refusals: { readonly name: string; readonly problems: readonly string[] }[];
}

function scriptedModel(): Scripted {
  const attempts: string[] = [];
  const refusals: { name: string; problems: readonly string[] }[] = [];
  /** Keyed by what was refused, so the same refusal is recorded once. */
  const seenRefusals = new Set<string>();
  const note = (result: { readonly name: string; readonly value: Record<string, unknown> }): void => {
    if (result.value["ok"] !== false) return;
    const problems = (result.value["problems"] ?? []) as string[];
    const key = `${result.name}|${problems.join("；")}`;
    if (seenRefusals.has(key)) return;
    seenRefusals.add(key);
    refusals.push({ name: result.name, problems });
  };
  /**
   * The card as it was proposed.
   *
   * Its ids are the session's, not one run's: a later run is told the subjects
   * and dimensions in its own instruction, but the *ids* only ever came back
   * from `propose_task`, so the script keeps them.
   */
  let card: { subjects: { id: string; name: string }[]; dimensions: { id: string; name: string }[] } | undefined;
  let step = 0;
  /** The instruction currently being served, and how many steps it has taken. */
  let runInstruction = "";
  let runStep = 0;
  const next = (events: readonly ModelEvent[]): AsyncIterable<ModelEvent> =>
    (async function* () {
      for (const event of events) yield event;
    })();

  const client: ModelClient = {
    limits: { contextWindow: 128 * 1024, maxOutputTokens: 8 * 1024, framing: DEFAULT_MODEL_FRAMING },
    stream(request: ModelRequest, _context: RuntimeContext): AsyncIterable<ModelEvent> {
      step += 1;
      const instruction = instructionOf(request.messages);
      const results = toolResultsOf(request.messages);
      const cardResult = results.find((result) => result.name === "propose_task");
      if (cardResult !== undefined) {
        card = {
          subjects: (cardResult.value["subjects"] ?? []) as { id: string; name: string }[],
          dimensions: (cardResult.value["dimensions"] ?? []) as { id: string; name: string }[],
        };
      }
      const call = (name: string, input: unknown): readonly ModelEvent[] => {
        attempts.push(name);
        return [
          { type: "tool-call", call: { callId: `call-${step}-${name}`, name, input } },
          { type: "done" },
        ];
      };
      const say = (text: string): readonly ModelEvent[] => [{ type: "text-delta", text }, { type: "done" }];

      if (instruction.includes("建立研究任务卡")) {
        return next(
          call("propose_task", {
            topic: "GraphRAG 方法与代表工作",
            purpose: "组会汇报",
            audience: "研究生",
            lengthTarget: "约 3 页",
            subjects: [{ name: "GraphRAG" }, { name: "LightRAG" }],
            dimensions: [
              { name: "核心思想", question: "解决什么问题" },
              { name: "结构与构建", question: "如何构建" },
              { name: "局限与风险", question: "局限是什么" },
            ],
          }),
        );
      }

      if (instruction.includes("任务卡已由用户确认")) {
        const searches = results.filter((result) => result.name === "search_sources");
        const reads = results.filter((result) => result.name === "read_source");
        const subjects = card?.subjects ?? [];
        const dimensions = card?.dimensions ?? [];
        if (searches.length === 0) {
          return next(call("search_sources", { query: "GraphRAG graph construction summarization", limit: 2 }));
        }
        const found = (searches[0]!.value["sources"] ?? []) as { sourceId: string }[];
        const unreadFound = found.filter((source) => !reads.some((result) => String(result.value["sourceId"]) === source.sourceId));
        if (unreadFound.length > 0) {
          // One read per compared object: the second source is the other
          // method's material, which the synthesis has to stand on.
          const index = found.length - unreadFound.length;
          return next(
            call("read_source", {
              sourceId: unreadFound[0]!.sourceId,
              question: `${subjects[index]?.name ?? "该方法"} 的结构如何构建`,
              terms: ["graph", "construction", "community"],
              targetCell: {
                sectionId: "comparison",
                subjectId: subjects[index]?.id ?? subjects[0]!.id,
                dimensionId: dimensions[1]!.id,
              },
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
                  cell: { sectionId: "comparison", subjectId: subjects[0]!.id, dimensionId: dimensions[1]!.id },
                  evidenceIds,
                  relationship: "supports",
                  directness: "direct",
                  scope: "作者在方法章节直接描述了构建步骤。",
                  note: "构建步骤有正文片段直接支持。",
                },
                {
                  cell: { sectionId: "comparison", subjectId: subjects[0]!.id, dimensionId: dimensions[2]!.id },
                  evidenceIds: evidenceIds.slice(0, 1),
                  relationship: "supports",
                  directness: "indirect",
                  scope: "片段只提到成本结构，未覆盖局限。",
                  note: "局限只得到间接材料。",
                },
              ],
            }),
          );
        }
        return next(say("本轮完成检索、读取与评估。"));
      }

      if (instruction.includes("定向补查轮")) {
        const reads = results.filter((result) => result.name === "read_source");
        const searches = results.filter((result) => result.name === "search_sources");
        const sources = searches.flatMap((result) => (result.value["sources"] ?? []) as { sourceId: string }[]);
        const subjects = card?.subjects ?? [];
        const dimensions = card?.dimensions ?? [];
        if (reads.length === 0 && searches.length > 0 && sources.length > 0) {
          return next(
            call("read_source", {
              sourceId: sources[0]!.sourceId,
              question: "构建成本与资源条件",
              terms: ["cost", "construction", "corpus"],
              targetCell: { sectionId: "comparison", subjectId: subjects[0]!.id, dimensionId: dimensions[1]!.id },
              role: "primary",
              maxEvidence: 2,
            }),
          );
        }
        if (searches.length === 0) {
          return next(call("search_sources", { query: "GraphRAG construction cost", limit: 1 }));
        }
        if (!results.some((result) => result.name === "assess_coverage")) {
          const evidenceIds = reads.flatMap((result) =>
            ((result.value["evidence"] ?? []) as { evidenceId: string }[]).map((item) => item.evidenceId),
          );
          return next(
            call("assess_coverage", {
              proposals: [
                {
                  cell: { sectionId: "comparison", subjectId: subjects[0]!.id, dimensionId: dimensions[1]!.id },
                  evidenceIds,
                  relationship: "supports",
                  directness: "direct",
                  scope: "成本结构与构建阶段在正文中有直接说明。",
                  note: "补查得到构建成本的直接描述。",
                },
              ],
              gapRound: true,
            }),
          );
        }
        return next(say("补查结束：材料已更新，报告正文保持不变。"));
      }

      if (instruction.includes("写出结构化研究报告") || instruction.includes("报告的第一部分")) {
        if (runInstruction !== instruction) {
          runInstruction = instruction;
          runStep = 0;
        }
        runStep += 1;
        if (runStep === 1) return next(call("load_research_state", {}));
        const state = (results.filter((result) => result.name === "load_research_state").slice(-1)[0]?.value["state"] ?? {}) as {
          subjects?: { id: string; name: string }[];
          dimensions?: { id: string; name: string }[];
          cells?: { subjectId: string; dimensionId: string; evidenceIds: string[] }[];
        };
        const subjects = state.subjects ?? [];
        const dimensions = state.dimensions ?? [];
        const cells = state.cells ?? [];
        const subjectIds = subjects.map((subject) => subject.id);
        const evidenceFor = (subjectId: string): string[] => [
          ...new Set(cells.filter((cell) => cell.subjectId === subjectId).flatMap((cell) => cell.evidenceIds)),
        ];
        const first = evidenceFor(subjectIds[0] ?? "")[0] ?? "";
        const second = evidenceFor(subjectIds[1] ?? "")[0] ?? evidenceFor(subjectIds[0] ?? "")[1] ?? first;
        const dim = (index: number): string => dimensions[index]?.id ?? "";

        if (runStep === 2) {
          return next(
            call("save_report", {
              part: "start",
              title: "GraphRAG：机制、构建与证据边界",
              summary: "本报告说明 GraphRAG 的图构建流程与检索机制，并标出评测与局限方面的证据缺口。",
              frame: {
                question: "GraphRAG 的图构建与检索机制是什么，现有材料能支持到什么程度？",
                audience: "研究生",
                scope: "只覆盖读到的 GraphRAG 论文材料，不声称覆盖该方法的全部实现。",
              },
              claims: [
                {
                  id: "clm_build",
                  claimType: "mechanism",
                  text: "GraphRAG 先抽取实体与关系，再做社区检测与摘要生成。",
                  evidenceIds: [first],
                  kind: "fact",
                  subjects: [subjectIds[0] ?? ""],
                  dimensions: [dim(0), dim(1)],
                },
                {
                  id: "clm_query",
                  claimType: "mechanism",
                  text: "查询时可在社区摘要上做全局搜索，也可沿实体邻域做局部搜索。",
                  evidenceIds: [second],
                  kind: "fact",
                  subjects: [subjectIds[1] ?? subjectIds[0] ?? ""],
                  dimensions: [dim(1)],
                },
                {
                  id: "clm_limits",
                  claimType: "fact",
                  text: "现有材料没有给出可直接比较的评测设置与硬件条件。",
                  evidenceIds: [second],
                  kind: "fact",
                  dimensions: [dim(2)],
                },
              ],
            }),
          );
        }

        const passOne = [
          {
            id: "overview",
            title: "一、研究问题与关键认识",
            blocks: [
              { kind: "paragraph", text: "本次研究面向组会汇报，梳理 GraphRAG 的构建与检索机制，并把结论限定在读到的材料范围内。", claimIds: [] },
              {
                kind: "list",
                items: [
                  { text: "构建阶段抽取实体与关系，并生成社区摘要。", claimIds: ["clm_build"] },
                  { text: "评测与硬件条件没有取得可比较的材料。", claimIds: ["clm_limits"] },
                ],
              },
              { kind: "callout", tone: "gap", text: "关键限制：没有独立评估，本报告不给出效果结论。" },
            ],
          },
          {
            id: "mental-model",
            title: "二、概念坐标",
            blocks: [
              {
                kind: "paragraph",
                text: "理解这个方法需要两个概念：实体关系图（把语料中的对象与关系显式保存）和社区摘要（在图上分组后预生成的描述）。查询使用结构的方式决定了它适合什么问题。",
                claimIds: ["clm_build"],
              },
              { kind: "list", items: [{ text: "社区摘要：面向语料级问题的预生成描述。", claimIds: ["clm_build"] }] },
            ],
          },
          {
            id: "mechanism",
            title: "三、机制解释",
            blocks: [
              {
                kind: "mechanism",
                title: "GraphRAG 的索引与查询",
                input: "整份语料的文本单元。",
                intermediate: "实体关系图与社区层级摘要。",
                steps: [
                  { text: "从每个文本单元抽取实体与关系。", claimIds: ["clm_build"] },
                  { text: "对图做社区检测并为每个社区生成摘要。", claimIds: ["clm_build"] },
                ],
                output: "查询时可组织成全局回答的社区摘要。",
                tradeoff: "用一次覆盖全语料的处理换取语料级归纳能力。",
                failure: "图抽取质量差时社区摘要会失真。",
                claimIds: ["clm_build"],
              },
            ],
          },
        ];
        const section = passOne[runStep - 3];
        if (section !== undefined) return next(call("save_report", { part: "write", section }));
        return next(say("第一部分已提交，等待综合阶段完成比较与发布。"));
      }

      if (instruction.includes("写第二部分")) {
        if (runInstruction !== instruction) {
          runInstruction = instruction;
          runStep = 0;
        }
        runStep += 1;
        if (runStep === 1) return next(call("load_research_state", {}));
        const state = (results.filter((result) => result.name === "load_research_state").slice(-1)[0]?.value["state"] ?? {}) as {
          subjects?: { id: string; name: string }[];
          dimensions?: { id: string; name: string }[];
          cells?: { subjectId: string; dimensionId: string; evidenceIds: string[] }[];
        };
        const subjects = state.subjects ?? [];
        const dimensions = state.dimensions ?? [];
        const cells = state.cells ?? [];
        const subjectIds = subjects.map((subject) => subject.id);
        const evidenceFor = (subjectId: string): string[] => [
          ...new Set(cells.filter((cell) => cell.subjectId === subjectId).flatMap((cell) => cell.evidenceIds)),
        ];
        const first = evidenceFor(subjectIds[0] ?? "")[0] ?? "";
        const second = evidenceFor(subjectIds[1] ?? "")[0] ?? evidenceFor(subjectIds[0] ?? "")[1] ?? first;
        const dim = (index: number): string => dimensions[index]?.id ?? "";

        if (runStep === 2) {
          return next(
            call("save_report", {
              part: "write",
              section: {
                id: "comparison",
                title: "四、条件化比较",
                blocks: [
                  { kind: "paragraph", text: "构建流程与检索机制是本次比较的两个维度。", claimIds: ["clm_build"] },
                  {
                    kind: "table",
                    columns: ["对象", dimensions[1]?.name ?? "结构与构建"],
                    columnDimensions: [null, dim(1)],
                    rowSubjects: [subjectIds[0] ?? "", subjectIds[1] ?? ""],
                    rows: [
                      { cells: [{ text: subjects[0]?.name ?? "GraphRAG", claimIds: [] }, { text: "实体图 + 社区摘要", claimIds: ["clm_build"] }] },
                      { cells: [{ text: subjects[1]?.name ?? "LightRAG", claimIds: [] }, { text: "本次材料未取得该对象的正文依据", claimIds: [] }] },
                    ],
                  },
                  {
                    kind: "callout",
                    tone: "gap",
                    dimensionIds: [dim(0), dim(2)],
                    text: "核心思想与局限维度：只读到一方的正文材料，另一方没有取得依据，不作比较结论。",
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
                  text: "综合读到的材料可以看出，图结构检索的能力来自索引期预生成的结构，而不是查询期的检索技巧。",
                  evidenceIds: [first, second],
                  kind: "inference",
                  conditions: { scope: "由两条机制证据共同支持；没有独立评估，属于我们的综合判断。" },
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
                title: "五、综合判断与权衡",
                blocks: [
                  {
                    kind: "paragraph",
                    text: "综合读到的材料可以看出，图结构检索的能力来自索引期预生成的结构，而不是查询期的检索技巧。",
                    claimIds: ["clm_synthesis"],
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
                title: "六、局限、未知与下一步",
                blocks: [
                  {
                    kind: "list",
                    items: [
                      { text: "评测口径与硬件条件未取得可直接比较的材料。", claimIds: ["clm_limits"] },
                      { text: "下一步应补读另一对象的正文，再看两者的构建成本是否可比。", claimIds: [] },
                    ],
                  },
                ],
              },
            }),
          );
        }
        if (runStep === 6) return next(call("save_report", { part: "finalize" }));
        return next(say("报告已保存。"));
      }
      // An Ask run: the model tries to write anyway, and is refused.
      if (instruction.includes("用户提出了一个问题")) {
        for (const result of results) note(result);
        const writes = results.filter((result) => result.name === "search_sources" || result.name === "save_report");
        if (writes.length === 0) {
          return next(call("search_sources", { query: "unrelated side quest", limit: 1 }));
        }
        if (!results.some((result) => result.name === "save_report")) {
          return next(
            call("save_report", {
              title: "偷偷写的报告",
              summary: "这次回答不应该产生任何正式数据。",
              claims: [],
              sections: [],
            }),
          );
        }
        return next(say("当前材料记录了 GraphRAG 的构建步骤；本次提问没有写入任何正式数据。"));
      }

      // An Edit run: submit a proposal for the target section only.
      if (instruction.includes("用户要求修改当前报告的指定目标")) {
        for (const result of results) note(result);
        const proposed = results.some((result) => result.name === "propose_section_edit");
        if (proposed) return next(say("修改提案已提交，等待接受。"));
        // The Edit is authorized to look things up, and tries twice: the second
        // lookup is refused by the Edit's own allowance, and the proposal is
        // still written from what it has.
        const lookups = results.filter((result) => result.name === "search_sources");
        if (lookups.length === 0) return next(call("search_sources", { query: "cost reporting conventions", limit: 1 }));
        if (lookups.length === 1) return next(call("search_sources", { query: "another angle on cost", limit: 1 }));
        const match = /章节当前内容：(\{.*?\})\n/s.exec(instruction);
        const section = match === null ? undefined : (JSON.parse(match[1]!) as { id: string; title: string });
        const target = section ?? { id: "comparison", title: "四、共同维度比较" };
        const load = results.filter((result) => result.name === "load_research_state").slice(-1)[0];
        if (load === undefined) return next(call("load_research_state", {}));
        const state = (load.value["state"] ?? {}) as {
          subjects?: { id: string; name: string }[];
          dimensions?: { id: string; name: string }[];
        };
        const subjects = state.subjects ?? [];
        const dimensions = state.dimensions ?? [];
        return next(
          call("propose_section_edit", {
            section: {
              id: target.id,
              title: target.title,
              blocks: [
                { kind: "paragraph", text: "构建流程可拆成抽取、社区检测与摘要三步，均由正文片段支持。", claimIds: ["clm_build"] },
                {
                  kind: "table",
                  columns: ["对象", dimensions[1]?.name ?? "结构与构建"],
                  columnDimensions: [null, dimensions[1]?.id ?? ""],
                  rowSubjects: subjects.map((subject) => subject.id),
                  rows: subjects.map((subject, index) => ({
                    cells: [
                      { text: subject.name, claimIds: [] },
                      {
                        text: index === 0 ? "实体图 + 社区摘要" : "本次材料未取得该对象的正文依据",
                        claimIds: index === 0 ? ["clm_build"] : [],
                      },
                    ],
                  })),
                },
                {
                  kind: "callout",
                  tone: "gap",
                  dimensionIds: [dimensions[0]?.id ?? "", dimensions[2]?.id ?? ""],
                  text: "核心思想与局限：仍只读到一方的正文材料，评测口径也未取得可直接比较的依据。",
                },
              ],
            },
            reason: "把构建流程写成三步，并把仍未取得依据的部分显式标出。",
          }),
        );
      }

      return next(say("已按当前指令处理。"));
    },
  };
  return { client, attempts, refusals };
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

async function get(path: string): Promise<{ status: number; text: string }> {
  const response = await fetch(`${app.pageOrigin}${path}`);
  return { status: response.status, text: await response.text() };
}

async function waitUntil(predicate: () => Promise<boolean>, what: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });
  }
}

interface Bundle {
  readonly task: {
    readonly id: string;
    readonly status: string;
    readonly reportNeedsReview: { readonly reason: string } | null;
  };
  readonly matrix: readonly { readonly status: string; readonly subjectId: string; readonly dimensionId: string }[];
  readonly assessments: readonly { readonly relationship: string; readonly directness: string }[];
  readonly evidence: readonly { readonly evidenceId: string }[];
  readonly sources: readonly { readonly sourceId: string }[];
  readonly reports: readonly {
    readonly reportId: string;
    readonly isCurrent: boolean;
    readonly contentHash: string | null;
    readonly sections: readonly { readonly id: string; readonly title: string; readonly blocks: readonly unknown[] }[];
    readonly claims: readonly { readonly id: string; readonly text: string }[];
    readonly summary: string;
    readonly title: string;
  }[];
  readonly proposals: readonly { readonly proposalId: string; readonly status: string; readonly targets: readonly string[] }[];
  readonly revisions: readonly { readonly revisionId: string; readonly revision: number; readonly isCurrentReport: boolean }[];
  readonly exports: readonly { readonly exportId: string; readonly revisionId: string | null; readonly status: string }[];
  readonly runs: readonly { readonly stage: string; readonly status: string }[];
  readonly budget: { readonly maxSearches: number; readonly maxReads: number; readonly maxGapRounds: number };
  readonly usage: { readonly searches: number; readonly reads: number; readonly gapRounds: number };
  readonly currentReportId: string | null;
  readonly currentReportHash: string | null;
  readonly currentReportFrozen: boolean;
  readonly busy: boolean;
}

async function bundle(): Promise<Bundle> {
  return JSON.parse((await get(`/api/research/tasks/${taskId}`)).text) as Bundle;
}

beforeAll(async () => {
  scripted = scriptedModel();
  app = await startResearchApp({
    dataDir,
    staticRoot,
    composition: offlineComposition(scripted),
    overrides: { search: searchFixture, read: async ({ url }) => readFixture(url) },
    log: (message: string): void => {
      if (process.env["RESEARCHPAGE_TEST_LOG"] === "1") console.log(message);
    },
  });

  const started = await post("/api/research/tasks", { topic: "整理 GraphRAG 的机制与证据边界" });
  expect(started.status).toBe(202);
  const sessionId = started.json["sessionId"] as string;
  await waitUntil(async () => {
    const state = JSON.parse((await get(`/api/research/sessions/${sessionId}`)).text) as { task: Bundle | null };
    return state.task !== null;
  }, "the task card to appear");
  const state = JSON.parse((await get(`/api/research/sessions/${sessionId}`)).text) as { task: Bundle };
  taskId = state.task.task.id;
  await post(`/api/research/tasks/${taskId}/confirm`, {});
  await waitUntil(async () => {
    const current = await bundle();
    return current.currentReportId !== null && !current.busy;
  }, "the first report to be written", 180_000);
}, 240_000);

afterAll(async () => {
  await app?.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe("the assistant's three intents, over HTTP", () => {
  it("answers an Ask without touching the project", async () => {
    const before = await bundle();
    const started = await post(`/api/research/tasks/${taskId}/assistant`, {
      text: "这份材料里 GraphRAG 的构建步骤是什么？",
      intent: "ask",
    });
    expect(started.status).toBe(202);
    expect(started.json["intent"]).toBe("ask");
    expect(String(started.json["scope"])).toContain("不写入");

    await waitUntil(async () => {
      const current = await bundle();
      return current.runs.some((run) => run.stage === "ask") && !current.busy;
    }, "the ask run to settle");

    // The model tried to search and to save a report; both were refused by the
    // service, and the recorded run says so.
    expect(scripted.attempts).toContain("save_report");
    const after = await bundle();
    const askRun = app.service.runsOf(taskId).filter((run) => run.stage === "ask").slice(-1)[0]!;
    // A refusal is an answer, not a crash: what the model received back is the
    // proof the boundary held, and it is also the sentence it can act on.
    const refusedWrites = scripted.refusals.filter((entry) => entry.name === "save_report" || entry.name === "search_sources");
    expect(refusedWrites.length, "the writes must have been refused").toBeGreaterThanOrEqual(2);
    for (const refusal of refusedWrites) {
      expect(refusal.problems.join(" "), `${refusal.name} must be refused by the service`).toMatch(/没有授权|不允许/);
    }

    expect(after.currentReportId).toBe(before.currentReportId);
    expect(after.currentReportHash).toBe(before.currentReportHash);
    expect(after.evidence.length).toBe(before.evidence.length);
    expect(after.sources.length).toBe(before.sources.length);
    expect(JSON.stringify(after.matrix)).toBe(JSON.stringify(before.matrix));
  }, 120_000);

  it("classifies an unlabelled instruction as Ask and refuses an ambiguous Edit", async () => {
    const started = await post(`/api/research/tasks/${taskId}/assistant`, { text: "它是不是更适合企业部署？" });
    expect(started.status).toBe(202);
    expect(started.json["intent"]).toBe("ask");

    const edit = await post(`/api/research/tasks/${taskId}/assistant`, { text: "改一下这一节", intent: "edit" });
    expect(edit.status).toBe(409);
    expect(String(edit.json["error"])).toContain("章节");
  }, 60_000);

  it("turns an Edit into a proposal, and only acceptance changes the report", async () => {
    await waitUntil(async () => !(await bundle()).busy, "the ask run to settle");
    const before = await bundle();
    const current = before.reports.find((report) => report.isCurrent)!;
    const overviewBefore = current.sections.find((section) => section.id === "comparison");

    const started = await post(`/api/research/tasks/${taskId}/assistant`, {
      text: "把构建流程写清楚，并标出仍缺依据的部分",
      intent: "edit",
      targetSectionId: "comparison",
    });
    expect(started.status).toBe(202);
    expect(started.json["intent"]).toBe("edit");

    await waitUntil(async () => {
      const current = await bundle();
      return current.proposals.length > 0 && !current.busy;
    }, "the proposal to be staged");

    // The proposal exists; the report's text and hash do not change.
    const staged = await bundle();
    expect(staged.proposals[0]!.status).toBe("pending");
    expect(staged.proposals[0]!.targets).toEqual(["comparison"]);
    expect(staged.currentReportHash).toBe(before.currentReportHash);

    const proposalId = staged.proposals[0]!.proposalId;
    const accepted = await post(`/api/research/proposals/${proposalId}/accept`, {});
    expect(accepted.status, JSON.stringify(accepted.json)).toBe(200);
    expect(accepted.json["ok"]).toBe(true);
    expect(accepted.json["alreadyApplied"]).toBe(false);

    const after = await bundle();
    expect(after.currentReportId).not.toBe(before.currentReportId);
    expect(after.currentReportHash).not.toBe(before.currentReportHash);

    // The bundle carries section titles; the content itself is read from the
    // stored report, which is what "only the target changed" is a claim about.
    const storedBefore = app.service.reportsOf(taskId).find((report) => report.id === before.currentReportId)!;
    const storedAfter = app.service.reportsOf(taskId).find((report) => report.id === after.currentReportId)!;
    const targetBefore = storedBefore.sections.find((section) => section.id === "comparison");
    const targetAfter = storedAfter.sections.find((section) => section.id === "comparison");
    expect(overviewBefore).toEqual({ id: "comparison", title: targetBefore!.title });
    expect(targetAfter).not.toEqual(targetBefore);
    expect(targetAfter?.blocks[0]).toMatchObject({ kind: "paragraph", claimIds: ["clm_build"] });
    for (const section of storedBefore.sections) {
      if (section.id === "comparison") continue;
      expect(storedAfter.sections.find((candidate) => candidate.id === section.id)).toEqual(section);
    }
    expect(storedAfter.summary).toBe(storedBefore.summary);
    expect(storedAfter.title).toBe(storedBefore.title);

    // A second accept applies nothing again.
    const again = await post(`/api/research/proposals/${proposalId}/accept`, {});
    expect(again.status).toBe(200);
    expect(again.json["alreadyApplied"]).toBe(true);
    expect((await bundle()).currentReportId).toBe(after.currentReportId);

    // The Edit's own lookups were bounded: the second search is refused by the
    // Edit's allowance, and the refusal is what the model was told.
    const lookupRefusal = scripted.refusals.find((entry) =>
      entry.problems.some((problem) => problem.includes("本次补查的检索次数已用完")),
    );
    expect(lookupRefusal?.problems.join("；")).toContain("本次补查的检索次数已用完（1/1）");
  }, 120_000);

  it("freezes a revision, exports it, and keeps the file stable across later research", async () => {
    const frozen = await post(`/api/research/tasks/${taskId}/revisions`, {});
    expect(frozen.status).toBe(200);
    const revisionId = (frozen.json["revision"] as { revisionId: string }).revisionId;

    // The frozen version re-renders to the same document later, whatever the
    // research does in between.
    const beforeHtml = (await get(`/api/research/revisions/${revisionId}/html`)).text;
    expect(beforeHtml).toContain("GraphRAG");

    const exported = await post(`/api/research/revisions/${revisionId}/export`, {});
    expect(exported.status, String(exported.json["failure"] ?? "")).toBe(200);
    const exportId = exported.json["exportId"] as string;
    const download = await get(`/api/research/exports/${exportId}/file`);
    expect(download.status).toBe(200);

    const bundleAfterExport = await bundle();
    expect(bundleAfterExport.currentReportFrozen).toBe(true);
    const artifact = bundleAfterExport.exports.find((entry) => entry.exportId === exportId);
    expect(artifact?.revisionId).toBe(revisionId);
    const filePath = app.service.exportsOf(taskId).find((entry) => entry.id === exportId)?.path;
    expect(filePath).not.toBeNull();
    expect(existsSync(filePath!)).toBe(true);

    // More research: the material grows and the report is flagged, but the
    // frozen document and the file that was already written do not move.
    // The project's automatic research is closed first — every gap round spent
    // and the deadline long past — because that is the state a returning user
    // is actually in, and the state the old rule mistook for a reason to refuse
    // them.
    const before = app.service.getTask(taskId)!;
    app.repository.updateTask({
      ...before,
      usage: { ...before.usage, gapRounds: before.budget.maxGapRounds, searches: before.budget.maxSearches, startedAt: new Date(Date.now() - 3_600_000).toISOString() },
    });
    const spent = await bundle();
    expect(spent.usage.gapRounds).toBe(spent.budget.maxGapRounds);
    const beforeResearchRuns = spent.runs.filter((run) => run.stage === "gap").length;

    const researched = await post(`/api/research/tasks/${taskId}/assistant`, {
      text: "再找独立证据验证构建成本",
      intent: "research",
    });
    expect(researched.status, JSON.stringify(researched.json)).toBe(202);
    // What the workspace is told is this instruction's allowance, not what is
    // left of the project.
    expect(researched.json["actionBudget"]).toEqual({ searchesRemaining: 2, readsRemaining: 4, gapRoundsRemaining: 2 });
    await waitUntil(async () => {
      const current = await bundle();
      const gaps = current.runs.filter((run) => run.stage === "gap").length;
      return gaps > beforeResearchRuns && !current.busy;
    }, "the research action to settle", 120_000);

    const after = await bundle();
    expect(after.currentReportId).toBe(bundleAfterExport.currentReportId);
    expect(after.currentReportHash).toBe(bundleAfterExport.currentReportHash);
    expect(after.task.reportNeedsReview?.reason).toContain("复核");
    // The instruction spent its own allowance and none of the project's:
    // searches accumulate as telemetry, the automatic gap count does not move.
    expect(after.usage.gapRounds).toBe(spent.usage.gapRounds);
    expect(after.usage.searches).toBeGreaterThan(spent.usage.searches);
    // Research on a task that has a report does not write another one.
    expect(after.runs.filter((run) => run.stage === "report").length).toBe(1);
    expect((await get(`/api/research/revisions/${revisionId}/html`)).text).toBe(beforeHtml);

    // A second instruction gets its own allowance: a project out of automatic
    // rounds is not a reason to refuse the person twice.
    const again = await post(`/api/research/tasks/${taskId}/assistant`, {
      text: "再补查一次这两条成本口径的出处",
      intent: "research",
    });
    expect(again.status, JSON.stringify(again.json)).toBe(202);
    expect(again.json["actionBudget"]).toEqual({ searchesRemaining: 2, readsRemaining: 4, gapRoundsRemaining: 2 });
    await waitUntil(async () => {
      const current = await bundle();
      const gaps = current.runs.filter((run) => run.stage === "gap").length;
      return gaps > beforeResearchRuns + 1 && !current.busy;
    }, "the second research action to settle", 120_000);
    const settled = await bundle();
    expect(settled.currentReportId).toBe(bundleAfterExport.currentReportId);
    expect(settled.currentReportHash).toBe(bundleAfterExport.currentReportHash);
    expect(settled.usage.gapRounds).toBe(spent.usage.gapRounds);
  }, 240_000);

  it("refuses to export without a report and reports the frozen state honestly", async () => {
    const other = await post("/api/research/tasks", { topic: "一个还没有报告的主题" });
    expect(other.status).toBe(202);
    const sessionId = other.json["sessionId"] as string;
    await waitUntil(async () => {
      const state = JSON.parse((await get(`/api/research/sessions/${sessionId}`)).text) as { task: Bundle | null };
      return state.task !== null;
    }, "the second card");
    const state = JSON.parse((await get(`/api/research/sessions/${sessionId}`)).text) as { task: Bundle };
    const secondId = state.task.task.id;
    const exported = await post(`/api/research/tasks/${secondId}/export`, {});
    expect(exported.status).toBe(500);
    expect(String(exported.json["failure"])).toContain("报告");
    const frozen = await post(`/api/research/tasks/${secondId}/revisions`, {});
    expect(frozen.status).toBe(409);
  }, 120_000);
});
