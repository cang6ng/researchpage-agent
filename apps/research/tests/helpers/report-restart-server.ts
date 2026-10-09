/**
 * The child process the restart test drives.
 *
 * A restart can only be tested against a process that really dies, so this is
 * a *program*, not a fixture: it starts the application the way the product
 * does — the same composition, the same stores, the same runner — and the test
 * kills it with SIGKILL and starts it again on the same data directory.
 *
 * What it will not do is reach a provider. The model is scripted, the search
 * and read paths are fixtures, and the child is built with the same esbuild
 * parameters the product's own server bundle uses.
 *
 * Usage: node report-restart-server.mjs <scenario> <dataDir> <port>
 *
 *   material-hang  everything the product does before a report, then a report
 *                  pass whose model never answers — the state a hard kill
 *                  leaves behind
 *   seed           a persisted `running` generation with no run record at all,
 *                  which is the other half of the same crash window
 *   recover        no work of its own; it waits for the parent's POST and
 *                  writes the report the recovery asked for
 *
 * Every line it prints is JSON, and every model call prints one: that is how
 * the parent proves that nothing was asked of the model before it asked.
 */

import { DEFAULT_MODEL_FRAMING, NonRetryableModelError } from "@every-dagent/agent-core";
import type { ModelClient, ModelEvent, ModelMessage, ModelRequest } from "@every-dagent/agent-core";

import { startResearchApp } from "../../src/server/composition.js";
import { testComposition } from "../../../../tests/helpers/test-composition.js";

const [scenario = "recover", dataDir = "", portText = "0", staticRoot = "apps/research/public"] = process.argv.slice(2);
const port = Number(portText);

function emit(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
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

function next(events: readonly ModelEvent[]): AsyncIterable<ModelEvent> {
  return (async function* () {
    for (const event of events) yield event;
  })();
}

/** A model that never answers: the report pass it belongs to stays running. */
function hangingModel(): ModelClient {
  return {
    limits: { contextWindow: 128 * 1024, maxOutputTokens: 8 * 1024, framing: DEFAULT_MODEL_FRAMING },
    stream(): AsyncIterable<ModelEvent> {
      emit({ event: "model-call", instruction: "hang" });
      return {
        [Symbol.asyncIterator](): AsyncIterator<ModelEvent> {
          return {
            next: () => new Promise<IteratorResult<ModelEvent>>(() => undefined),
          };
        },
      };
    },
  };
}

/**
 * The scripted model: it researches, and then either hangs or writes.
 *
 * The report it writes is the same section set the end-to-end pipeline test
 * proves the Validator accepts — a smaller one would prove less, because the
 * point of the recovery is that a real report comes out of it.
 */
function scriptedModel(input: { readonly hangReport: boolean }): ModelClient {
  let step = 0;
  let runInstruction = "";
  let runStep = 0;
  return {
    limits: { contextWindow: 128 * 1024, maxOutputTokens: 8 * 1024, framing: DEFAULT_MODEL_FRAMING },
    stream(request: ModelRequest): AsyncIterable<ModelEvent> {
      step += 1;
      const instruction = lastUserText(request.messages);
      emit({ event: "model-call", stage: instruction.slice(0, 24) });
      const results = toolResults(request.messages);
      const call = (name: string, input_: unknown): readonly ModelEvent[] => [
        { type: "tool-call", call: { callId: `call-${String(step)}-${name}`, name, input: input_ } },
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
          cells?: { subjectId: string; evidenceIds: string[] }[];
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

      // 1. Research: one search, one read per source, one assessment pass.
      if (instruction.includes("任务卡已由用户确认")) {
        const searches = results.filter((result) => result.name === "search_sources");
        const reads = results.filter((result) => result.name === "read_source");
        const loaded = stateOf();
        if (loaded.subjects.length === 0) return next(call("load_research_state", {}));
        if (searches.length === 0) return next(call("search_sources", { query: "graph retrieval construction", limit: 2 }));
        const sources = (searches[0]?.value["sources"] ?? []) as { sourceId: string }[];
        const readAlready = new Set(reads.map((result) => String(result.value["sourceId"])));
        const nextRead = sources.map((source, index) => ({ source, index })).find(({ source }) => !readAlready.has(source.sourceId));
        if (nextRead !== undefined) {
          return next(
            call("read_source", {
              sourceId: nextRead.source.sourceId,
              question: `${loaded.subjects[nextRead.index]?.name ?? "对象"} 的构建与检索机制`,
              terms: ["graph", "index"],
              role: "primary",
              maxEvidence: 2,
              targetCell: {
                sectionId: "comparison",
                subjectId: loaded.subjects[nextRead.index]?.id ?? "",
                dimensionId: loaded.dimensions[0]?.id ?? "",
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
                  subjectId: loaded.subjects[index]?.id ?? "",
                  dimensionId: loaded.dimensions[0]?.id ?? "",
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

      // 2. The report pass. In the crash scenario it never answers; in the
      //    recovery scenario it writes the report and finalizes it.
      if (instruction.includes("报告的第一部分") || instruction.includes("写第二部分") || instruction.includes("修正下面这些未满足的义务")) {
        if (input.hangReport && instruction.includes("报告的第一部分")) {
          return { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<ModelEvent>>(() => undefined) }) };
        }
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
          return next(say("第一部分已提交。"));
        }

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

      return next(say("这个脚本只服务研究阶段。"));
    },
  };
}

const PARAGRAPHS = [
  "MethodA builds a knowledge graph over the corpus with an LLM and retrieves by walking it, which is the mechanism this fixture paper describes in its third section.",
  "MethodB keeps text embeddings and adds a graph layer on top, so its indexing pass costs one additional extraction step over the whole corpus.",
  "Both papers report their own evaluation numbers, but on different corpora and with different readers, so the two sets of figures are not directly comparable.",
];

const app = await startResearchApp({
  dataDir,
  staticRoot,
  port,
  composition: testComposition({
    modelClient: scenario === "material-hang" ? scriptedModel({ hangReport: true }) : scriptedModel({ hangReport: false }),
  }),
  overrides: {
    search: () =>
      Promise.resolve({
        provider: "arxiv" as const,
        query: "graph retrieval",
        requestUrl: "https://export.arxiv.org/api/query?search_query=all:graph",
        fetchedAt: new Date().toISOString(),
        total: 2,
        candidates: [
          {
            provider: "arxiv" as const,
            providerId: "2404.16130",
            title: "A Fixture Paper on Graph Retrieval",
            authors: ["D. Edge"],
            abstract: "A fixture method with a graph index.",
            landingUrl: "https://arxiv.org/abs/2404.16130",
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
            abstract: "A second fixture method with a graph layer.",
            landingUrl: "https://arxiv.org/abs/2404.16131",
            pdfUrl: null,
            publishedAt: "2024-04-25T00:00:00Z",
            arxivId: "2404.16131",
            venue: "arXiv cs.CL",
            doi: null,
          },
        ],
      }),
    read: (request: { readonly url: string }) =>
      Promise.resolve({
        status: "ok" as const,
        readUrl: request.url.replace("/abs/", "/html/"),
        fetchedAt: new Date().toISOString(),
        title: "A Fixture Paper on Graph Retrieval",
        scope: "full_text" as const,
        text: PARAGRAPHS.join("\n\n"),
        paragraphs: PARAGRAPHS.map((paragraph, index) => {
          const charStart = PARAGRAPHS.slice(0, index).reduce((sum, item) => sum + item.length + 2, 0);
          return { index, headingPath: ["Fixture", `Section ${String(index + 1)}`], text: paragraph, charStart, charEnd: charStart + paragraph.length };
        }),
        contentType: "text/html",
        note: "fixture full text",
        failure: null,
      }),
  },
  log: (message: string) => emit({ event: "log", message }),
});

emit({ event: "listening", url: app.url, port: new URL(app.url).port });

async function seedTask(): Promise<string> {
  const created = await app.client.sessions.create();
  const sessionId = created.session.sessionId;
  app.service.issueGrant({ sessionId, intent: "card", taskId: null });
  const card = app.service.proposeTask(sessionId, {
    topic: "报告中途重启的离线复现",
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
  if (!card.ok) throw new NonRetryableModelError(`card refused: ${card.problems.join("; ")}`);
  app.service.confirmTask(card.task.id);
  return card.task.id;
}

if (scenario === "material-hang") {
  // A real research pass, then a report pass whose model never answers: the
  // process will be killed while it is genuinely reporting.
  const taskId = await seedTask();
  emit({ event: "task", taskId });
  app.service.issueGrant({ sessionId: app.service.getTask(taskId)?.sessionId ?? "", intent: "research", taskId, allowResearch: true });
  app.runner.startResearch(taskId);
  const deadline = Date.now() + 60_000;
  for (;;) {
    const task = app.service.getTask(taskId);
    const generation = task?.reportGeneration ?? null;
    if (app.runner.hasReportWork(taskId) && generation !== null && generation.status === "running") {
      emit({ event: "running", taskId, attemptId: generation.attemptId });
      break;
    }
    if (Date.now() > deadline) {
      emit({ event: "timeout", taskId });
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

if (scenario === "seed") {
  // The other half of the crash window: the attempt is persisted `running` and
  // no run record exists yet, because the process died between opening the
  // attempt and starting its run. Nothing is in flight either, which is exactly
  // the state that used to leave a project waiting forever.
  const taskId = await seedTask();
  app.service.beginReportGeneration(taskId, { stage: "report", resume: false });
  emit({ event: "seeded", taskId });
}

process.on("SIGTERM", () => {
  // The test kills this process on purpose; there is nothing to flush.
  process.exit(0);
});
