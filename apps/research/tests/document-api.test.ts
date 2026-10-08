/**
 * The document library over the product's real surface.
 *
 * A user's Markdown has to behave the same way wherever it is added: it lands in
 * one library, it is read in bounded pieces, and it becomes evidence only
 * through the same read path as anything found on the network. The last case
 * here is the one the product's own promises rest on — a project that already
 * has a report, with a new file uploaded to it: the file is readable, the report
 * does not move, and the material still has to be read before it changes
 * anything.
 *
 * The model is scripted and the network is absent; the runner, the host, the
 * tools, the matrix and the report validator are the real ones.
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
 * A research pass, a report pass and a synthesis pass are three host runs
 * started by the runner; the default budget is not a statement about them.
 */
function slow(name: string, body: () => Promise<void>): void {
  it(name, body, 120_000);
}

const workDir = mkdtempSync(join(tmpdir(), "researchpage-document-api-"));
const dataDir = join(workDir, "data");
const staticRoot = join(process.cwd(), "apps", "research", "public");

const NOTES_A = [
  "# Transformer 部署观测",
  "",
  "## 成本",
  "",
  "我们的生产观测里，Transformer 的 prefill 成本随上下文长度近似线性增长，decode 阶段相对平稳。",
  "",
  "## 机制",
  "",
  "注意力机制让每个 token 都要与上下文中的其它 token 交互，因此 prefill 的计算量随上下文二次增长、实测延迟随长度上升。",
].join("\n");

const NOTES_B = [
  "# Mamba 部署观测",
  "",
  "## 成本",
  "",
  "Mamba 的状态更新是固定开销，prefill 与 decode 都不随上下文长度显著增长。",
  "",
  "## 机制",
  "",
  "选择性状态空间让信息按顺序压缩进一个固定大小的状态，因此没有 token 两两交互的二次项。",
].join("\n");

const project: { sourceIds: string[]; subjectIds: string[]; dimensionIds: string[] } = {
  sourceIds: [],
  subjectIds: [],
  dimensionIds: [],
};
let seenInstructions: string[] = [];

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

/**
 * A model that reads the two attached documents and writes a real report.
 *
 * It is deliberately the *document* path under test: the sources it reads are
 * `user-provided`, the excerpts come from the saved Markdown, and the report it
 * writes is subject to the same validator as any other.
 */
function scriptedModel(): ModelClient {
  let step = 0;
  let cardStep = 0;
  let reportStep = 0;
  let synthesisStep = 0;
  let cardInstruction = "";
  let reportInstruction = "";
  let synthesisInstruction = "";
  return {
    limits: { contextWindow: 128 * 1024, maxOutputTokens: 8 * 1024, framing: DEFAULT_MODEL_FRAMING },
    stream(request: ModelRequest, _context: RuntimeContext): AsyncIterable<ModelEvent> {
      step += 1;
      const instruction = instructionOf(request.messages);
      seenInstructions.push(instruction);
      const results = toolResultsOf(request.messages);
      const call = (name: string, input: unknown): readonly ModelEvent[] => [
        { type: "tool-call", call: { callId: `call-${step}-${name}`, name, input } },
        { type: "done" },
      ];
      const say = (text: string): readonly ModelEvent[] => [{ type: "text-delta", text }, { type: "done" }];

      // --- intent discovery: propose a direction at once (the seed is explicit)
      if (instruction.includes("这是一段对话，不是问卷")) {
        if (results.some((result) => result.name === "propose_research_direction")) return next(say("方向已提交。"));
        return next(
          call("propose_research_direction", {
            topic: "长上下文模型的推理成本比较",
            purpose: "为部署选型判断两类模型的推理成本特点",
            scope: "以两份部署观测为材料，比较推理阶段的成本与机制",
            summary: "我理解你要为部署选型比较两类模型在长上下文下的推理成本。",
            audience: "架构与部署团队",
            subjects: [{ name: "Transformer" }, { name: "Mamba" }],
            dimensions: [
              { name: "成本", question: "长上下文下的推理成本如何？" },
              { name: "机制", question: "成本差异从何而来？" },
              { name: "部署条件", question: "在什么条件下更划算？" },
            ],
          }),
        );
      }

      // --- card
      if (instruction.includes("请为用户的研究主题建立研究任务卡")) {
        if (instruction !== cardInstruction) {
          cardInstruction = instruction;
          cardStep = 0;
        }
        cardStep += 1;
        if (cardStep > 1) return next(say("任务卡已提交。"));
        return next(
          call("propose_task", {
            topic: "模型自己写的题目",
            purpose: "模型自己写的目的",
            audience: "部署团队",
            focus: [],
            exclusions: "",
            lengthTarget: "约 5 页",
            subjects: [{ name: "Transformer" }, { name: "Mamba" }],
            dimensions: [
              { name: "成本", question: "成本如何？" },
              { name: "机制", question: "如何工作？" },
              { name: "部署条件", question: "什么条件下更划算？" },
            ],
          }),
        );
      }

      // --- research: read the two user documents, then assess the cells
      if (instruction.includes("任务卡已由用户确认")) {
        const reads = results.filter((result) => result.name === "read_source");
        const targets: readonly { readonly sourceId: string; readonly subjectId: string; readonly terms: readonly string[] }[] = [
          { sourceId: project.sourceIds[0] ?? "", subjectId: project.subjectIds[0] ?? "", terms: ["prefill", "成本"] },
          { sourceId: project.sourceIds[1] ?? "", subjectId: project.subjectIds[1] ?? "", terms: ["prefill", "成本"] },
        ];
        if (reads.length < targets.length) {
          const target = targets[reads.length];
          if (target === undefined) return next(say("没有更多可读的来源。"));
          return next(
            call("read_source", {
              sourceId: target.sourceId,
              question: "这类模型在长上下文下的推理成本与机制",
              terms: target.terms,
              role: "user-provided",
              targetCell: {
                sectionId: "comparison",
                subjectId: target.subjectId,
                dimensionId: project.dimensionIds[0] ?? "",
              },
              maxEvidence: 3,
            }),
          );
        }
        if (!results.some((result) => result.name === "assess_coverage")) {
          const readFor = (sourceId: string): readonly string[] =>
            results
              .filter((result) => result.name === "read_source" && result.value["sourceId"] === sourceId)
              .flatMap((result) => ((result.value["evidence"] ?? []) as readonly { evidenceId: string }[]).map((item) => item.evidenceId));
          const proposals = project.subjectIds.flatMap((subjectId) =>
            project.dimensionIds.map((dimensionId) => ({
              cell: { sectionId: "comparison", subjectId, dimensionId },
              evidenceIds: readFor(subjectId === project.subjectIds[0] ? project.sourceIds[0] ?? "" : project.sourceIds[1] ?? ""),
              relationship: "supports",
              directness: "direct",
              scope: "用户提供的部署观测直接描述了该模型在长上下文下的成本表现。",
              note: "说明来自用户提供的观测记录。",
            })),
          );
          return next(call("assess_coverage", { proposals }));
        }
        return next(say("本轮读取与评估完成。"));
      }

      // --- gap: nothing more to look for, so the report can be written
      if (instruction.includes("定向补查轮")) return next(say("没有需要补查的项目，直接写报告。"));

      // --- report pass one
      if (instruction.includes("请写这份技术比较报告的第一部分")) {
        if (instruction !== reportInstruction) {
          reportInstruction = instruction;
          reportStep = 0;
        }
        reportStep += 1;
        if (reportStep === 1) return next(call("load_research_state", {}));
        const index = results.find((result) => result.name === "load_research_state")?.value["state"] as
          | { readonly evidence: readonly { readonly evidenceId: string; readonly sourceId: string }[] }
          | undefined;
        const bySource = (sourceId: string): readonly string[] =>
          (index?.evidence ?? []).filter((item) => item.sourceId === sourceId).map((item) => item.evidenceId);
        const a = bySource(project.sourceIds[0] ?? "");
        const b = bySource(project.sourceIds[1] ?? "");
        const [subA, subB] = project.subjectIds;
        const [dimCost, dimMechanism, dimDeploy] = project.dimensionIds;
        if (reportStep === 2) {
          return next(
            call("save_report", {
              part: "start",
              title: "长上下文推理成本：两份部署观测的比较",
              summary:
                "本报告以用户提供的两份部署观测为材料，比较两类模型在长上下文下的推理成本与机制差异，并说明材料不能支持的部分：没有独立评估，也不覆盖训练成本。",
              frame: {
                question: "两类模型在长上下文下的推理成本特点是什么，现有材料能支持到什么程度？",
                audience: "架构与部署团队",
                scope: "只覆盖用户提供的两份部署观测，不声称覆盖全部实现或全部部署条件。",
              },
              claims: [
                {
                  id: "clm_a_cost",
                  claimType: "cost",
                  text: "在用户观测里，Transformer 的 prefill 成本随上下文长度上升。",
                  evidenceIds: a.slice(0, 1),
                  kind: "fact",
                  subjects: [subA ?? ""],
                  dimensions: [dimCost ?? ""],
                  conditions: {
                    costStage: "operational",
                    comparability: "not-directly-comparable",
                    basis: "author-reported",
                    scope: "单次生产观测，未给出硬件与批次口径，不能与另一份观测直接比较。",
                  },
                },
                {
                  id: "clm_b_cost",
                  claimType: "cost",
                  text: "在用户观测里，Mamba 的推理成本不随上下文长度显著增长。",
                  evidenceIds: b.slice(0, 1),
                  kind: "fact",
                  subjects: [subB ?? ""],
                  dimensions: [dimCost ?? ""],
                  conditions: {
                    costStage: "operational",
                    comparability: "not-directly-comparable",
                    basis: "author-reported",
                    scope: "另一份生产观测，条件不同，不与上一份并列排名。",
                  },
                },
                {
                  id: "clm_a_mech",
                  claimType: "mechanism",
                  text: "Transformer 的成本来自注意力中每对 token 的交互，计算量随上下文上升。",
                  evidenceIds: a.slice(-1),
                  kind: "fact",
                  subjects: [subA ?? ""],
                  dimensions: [dimMechanism ?? ""],
                },
                {
                  id: "clm_b_mech",
                  claimType: "mechanism",
                  text: "Mamba 把信息压缩进固定大小的状态，因此没有两两交互的二次项。",
                  evidenceIds: b.slice(-1),
                  kind: "fact",
                  subjects: [subB ?? ""],
                  dimensions: [dimMechanism ?? ""],
                },
              ],
            }),
          );
        }
        const sections: readonly { readonly id: string; readonly title: string; readonly blocks: readonly unknown[] }[] = [
          {
            id: "overview",
            title: "一、研究问题与关键认识",
            blocks: [
              {
                kind: "paragraph",
                text: "本次比较以两份部署观测为材料，回答两类模型在长上下文下的推理成本特点；结论只在这两份观测的范围内成立。",
                claimIds: [],
              },
              {
                kind: "list",
                items: [
                  { text: "一份观测里成本随上下文上升，另一份里不显著增长。", claimIds: ["clm_a_cost", "clm_b_cost"] },
                  { text: "差异与两者处理上下文的机制不同有关。", claimIds: ["clm_a_mech", "clm_b_mech"] },
                ],
              },
              { kind: "callout", tone: "gap", text: "关键限制：两份观测的硬件、批次与口径都未对齐，本报告不给出统一名次。" },
            ],
          },
          {
            id: "mental-model",
            title: "二、概念坐标",
            blocks: [
              {
                kind: "paragraph",
                text: "理解这类比较需要一条轴：上下文信息是被「逐对比较」还是被「压缩进固定状态」。前者随上下文增长，后者不随；成本特点由此而来。下面两个词是本报告的基本坐标。",
                claimIds: ["clm_a_mech"],
              },
              {
                kind: "list",
                items: [
                  { text: "逐对交互：每个位置与上下文其它位置计算交互，成本随上下文上升。", claimIds: ["clm_a_mech"] },
                  { text: "固定状态：把历史压缩进固定大小的状态，更新成本与长度脱钩。", claimIds: ["clm_b_mech"] },
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
                title: "Transformer：逐对交互",
                input: "上下文中的全部 token。",
                intermediate: "注意力权重矩阵。",
                steps: [
                  { text: "每个 token 与上下文中的其它 token 计算交互。", claimIds: ["clm_a_mech"] },
                  { text: "上下文变长时交互对数上升，prefill 计算量随之上升。", claimIds: ["clm_a_mech"] },
                ],
                output: "随上下文增长的预填充成本。",
                tradeoff: "用可并行的逐对计算换取对上下文的完整访问。",
                failure: "上下文极长时计算与显存压力成为瓶颈。",
                claimIds: ["clm_a_mech"],
              },
              {
                kind: "mechanism",
                title: "Mamba：固定状态",
                input: "按顺序到达的 token。",
                intermediate: "固定大小的隐状态。",
                steps: [
                  { text: "把信息依次压缩进固定大小的状态。", claimIds: ["clm_b_mech"] },
                  { text: "状态更新开销与上下文长度基本无关。", claimIds: ["clm_b_mech"] },
                ],
                output: "不随上下文增长的状态更新成本。",
                tradeoff: "用固定开销换取对历史信息的压缩式访问。",
                failure: "需要精确定位远端细节时，压缩状态可能丢失信息。",
                claimIds: ["clm_b_mech"],
              },
            ],
          },
          {
            id: "representative",
            title: "四、对象身份与材料来源",
            blocks: [
              { kind: "paragraph", text: "两类模型的材料都是用户提供的部署观测记录，不是公开可验证的论文正文。", claimIds: ["clm_a_cost"] },
            ],
          },
        ];
        const section = sections[reportStep - 3];
        if (section !== undefined) return next(call("save_report", { part: "write", section }));
        return next(say("第一部分已提交。"));
      }

      // --- synthesis pass: comparison, synthesis, limitations, publish
      if (instruction.includes("写第二部分") || instruction.includes("综合")) {
        if (instruction !== synthesisInstruction) {
          synthesisInstruction = instruction;
          synthesisStep = 0;
        }
        synthesisStep += 1;
        if (synthesisStep === 1) return next(call("load_research_state", {}));
        const index = results.find((result) => result.name === "load_research_state")?.value["state"] as
          | { readonly evidence: readonly { readonly evidenceId: string; readonly sourceId: string }[] }
          | undefined;
        const bySource = (sourceId: string): readonly string[] =>
          (index?.evidence ?? []).filter((item) => item.sourceId === sourceId).map((item) => item.evidenceId);
        const a = bySource(project.sourceIds[0] ?? "");
        const b = bySource(project.sourceIds[1] ?? "");
        const [subA, subB] = project.subjectIds;
        const [dimCost, dimMechanism, dimDeploy] = project.dimensionIds;
        if (synthesisStep === 2) {
          return next(
            call("save_report", {
              part: "write",
              section: {
                id: "comparison",
                title: "五、条件化比较",
                blocks: [
                  {
                    kind: "table",
                    columns: ["推理成本", "机制来源", "部署条件"],
                    columnDimensions: [dimCost ?? "", dimMechanism ?? "", dimDeploy ?? ""],
                    rowSubjects: [subA ?? "", subB ?? ""],
                    rows: [
                      {
                        cells: [
                          { text: "成本随上下文上升；口径为单次生产观测。", claimIds: ["clm_a_cost"] },
                          { text: "逐对交互带来的计算量。", claimIds: ["clm_a_mech"] },
                          { text: "长上下文且预算充足时更可控。", claimIds: ["clm_a_mech"] },
                        ],
                      },
                      {
                        cells: [
                          { text: "成本不随上下文显著增长；另一份观测，口径不同。", claimIds: ["clm_b_cost"] },
                          { text: "固定状态的更新开销。", claimIds: ["clm_b_mech"] },
                          { text: "需要长上下文且关注单位成本时更合适。", claimIds: ["clm_b_mech"] },
                        ],
                      },
                    ],
                  },
                ],
              },
            }),
          );
        }
        if (synthesisStep === 3) {
          return next(
            call("save_report", {
              part: "write",
              claims: [
                {
                  id: "clm_synthesis",
                  claimType: "synthesis",
                  synthesis: true,
                  text: "把两份观测放在一起看，成本差异与「是否逐对比较上下文」有关：逐对比较让成本随上下文上升，固定状态让成本与长度脱钩。",
                  evidenceIds: [...a.slice(0, 1), ...b.slice(0, 1)],
                  kind: "inference",
                  subjects: [subA ?? "", subB ?? ""],
                  dimensions: [dimCost ?? "", dimMechanism ?? ""],
                  conditions: {
                    scope: "两份观测条件不同，这条认识是机制层面的推断，不能读成同一条件下的排名。",
                    comparability: "not-directly-comparable",
                  },
                },
              ],
            }),
          );
        }
        if (synthesisStep === 4) {
          return next(
            call("save_report", {
              part: "write",
              section: {
                id: "synthesis",
                title: "六、综合判断",
                blocks: [
                  {
                    kind: "paragraph",
                    text: "成本特点的差异可以回到机制：逐对比较的模型在长上下文下付出随长度增长的计算，固定状态的模型把成本压成常数。这条判断是跨两份材料的推断，证据是两份用户观测。",
                    claimIds: ["clm_synthesis"],
                  },
                  {
                    kind: "callout",
                    tone: "note",
                    text: "适用边界：两份观测的硬件与批次未对齐，只在机制层面成立，不构成同一条件下的性能排名。",
                  },
                ],
              },
            }),
          );
        }
        if (synthesisStep === 5) {
          return next(
            call("save_report", {
              part: "write",
              section: {
                id: "limitations",
                title: "七、局限与下一步",
                blocks: [
                  { kind: "paragraph", text: "材料只有两份用户观测：没有独立评估，也没有训练成本的任何数据。", claimIds: ["clm_a_cost"] },
                  { kind: "callout", tone: "gap", text: "缺哪类证据：独立评估与同条件基准；只取得间接证据：机制层推断。", dimensionIds: [dimDeploy ?? ""] },
                ],
              },
            }),
          );
        }
        if (synthesisStep === 6) {
          return next(
            call("save_report", {
              part: "write",
              section: {
                id: "reading",
                title: "八、核验索引",
                blocks: [{ kind: "paragraph", text: "全部判断可回到两份观测中的原样片段，位置见核验索引。", claimIds: ["clm_synthesis"] }],
              },
            }),
          );
        }
        if (synthesisStep === 7) return next(call("save_report", { part: "finalize" }));
        return next(say("报告已发布。"));
      }

      return next(say("这个脚本只服务本测试的流程。"));
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
      search: () => Promise.reject(new Error("this test never searches")),
      read: () => Promise.reject(new Error("this test never reads the network")),
    },
    log: () => undefined,
  });
}, 60_000);

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

async function postRaw(path: string, body: string | Uint8Array, contentType: string): Promise<Response> {
  const response = await fetch(`${app.pageOrigin}${path}`, {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });
  const text = await response.text();
  return { status: response.status, json: text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

async function get(path: string): Promise<Response> {
  const response = await fetch(`${app.pageOrigin}${path}`);
  const text = await response.text();
  return { status: response.status, json: text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

async function getText(path: string): Promise<{ readonly status: number; readonly text: string; readonly type: string | null }> {
  const response = await fetch(`${app.pageOrigin}${path}`);
  return { status: response.status, text: await response.text(), type: response.headers.get("content-type") };
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

async function taskBundle(taskId: string): Promise<Record<string, unknown>> {
  const response = await get(`/api/research/tasks/${taskId}`);
  return response.json;
}

describe("Scenario D' — one library, whatever the entry point", () => {
  it("stores, lists, reads and deletes a document over HTTP", async () => {
    const created = await post("/api/research/intents", { seedTopic: "长上下文推理成本" });
    const intentId = created.json["intentId"] as string;
    const sessionId = created.json["sessionId"] as string;

    const uploaded = await post("/api/research/documents", { intentId, filename: "notes.md", content: NOTES_A });
    expect(uploaded.status, JSON.stringify(uploaded.json)).toBe(201);
    const document = uploaded.json["document"] as { documentId: string; originalFilename: string; usage: readonly string[]; chars: number };
    expect(document.originalFilename).toBe("notes.md");
    expect(document.usage).toEqual(["intent_context"]);

    // The same bytes are the same document, by content and not by name.
    const duplicate = await post("/api/research/documents", { intentId, filename: "copy.md", content: NOTES_A });
    expect(duplicate.status).toBe(201);
    expect(duplicate.json["duplicate"]).toBe(true);
    expect((duplicate.json["document"] as { documentId: string }).documentId).toBe(document.documentId);

    const listed = await get(`/api/research/documents?intentId=${intentId}`);
    expect((listed.json["documents"] as readonly unknown[]).length).toBe(1);
    const bySession = await get(`/api/research/documents?sessionId=${sessionId}`);
    expect((bySession.json["documents"] as readonly unknown[]).length).toBe(1);

    const content = await getText(`/api/research/documents/${document.documentId}/content?sessionId=${sessionId}`);
    expect(content.status).toBe(200);
    expect(content.type).toContain("text/markdown");
    expect(content.text).toBe(NOTES_A);

    // A read never claims the whole document unless it really brought it: with
    // no question it is a spread preview, with one it is an aimed excerpt, and
    // both say so in the same words.
    const preview = await post(`/api/research/documents/${document.documentId}/read`, { sessionId });
    expect(preview.status).toBe(200);
    expect(preview.json["scope"]).toBe("partial");
    expect(String(preview.json["note"])).toContain("部分读取");
    expect((preview.json["fragments"] as readonly unknown[]).length).toBeGreaterThan(0);

    const read = await post(`/api/research/documents/${document.documentId}/read`, { sessionId, question: "prefill 成本" });
    expect(read.status).toBe(200);
    expect(read.json["scope"]).toBe("partial");
    expect(String(read.json["note"])).toContain("部分读取");
    expect(String(read.json["untrusted"])).toContain("不可信数据");
    const fragments = read.json["fragments"] as readonly { readonly text: string; readonly charStart: number }[];
    expect(fragments.some((fragment) => fragment.text.includes("prefill"))).toBe(true);

    // Putting it to use is an explicit act, and it is reversible.
    const marked = await fetch(`${app.pageOrigin}/api/research/documents/${document.documentId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, usage: ["intent_context", "research_source"] }),
    });
    expect(marked.status).toBe(200);
    expect((await marked.json() as { document: { usage: readonly string[] } }).document.usage).toEqual(["intent_context", "research_source"]);

    // The one case where a read may say「已读取全文」: it really did.
    const single = await post("/api/research/documents", { sessionId, filename: "single.md", content: "只有一段。" });
    expect(single.status).toBe(201);
    const singleRead = await post(`/api/research/documents/${(single.json["document"] as { documentId: string }).documentId}/read`, { sessionId });
    expect(singleRead.json["scope"]).toBe("full");
    expect(String(singleRead.json["note"])).toContain("已读取全文");

    const removed = await fetch(`${app.pageOrigin}/api/research/documents/${document.documentId}?sessionId=${sessionId}`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect((await get(`/api/research/documents/${document.documentId}?sessionId=${sessionId}`)).status).toBe(404);
  }, 60_000);

  it("refuses what the library does not accept, and says why", async () => {
    const created = await post("/api/research/intents", { seedTopic: "限制" });
    const sessionId = created.json["sessionId"] as string;

    const wrongType = await post("/api/research/documents", { sessionId, filename: "notes.pdf", content: NOTES_A });
    expect(wrongType.status).toBe(400);
    expect(String(wrongType.json["error"])).toContain("Markdown");

    const traversal = await post("/api/research/documents", { sessionId, filename: "../../etc/passwd.md", content: NOTES_A });
    expect(traversal.status).toBe(400);
    expect(String(traversal.json["error"])).toContain("路径分隔符");

    // Raw bytes: a GBK file is not UTF-8 text, and the refusal says so.
    const gbk = new Uint8Array([0xb1, 0xe0, 0xb1, 0xe0, 0x0a, 0xd6, 0xd0, 0xce, 0xc4]);
    const notUtf8 = await postRaw(`/api/research/documents?sessionId=${sessionId}&filename=gbk.md`, gbk, "text/markdown");
    expect(notUtf8.status).toBe(400);
    expect(String(notUtf8.json["error"])).toContain("UTF-8");

    // The same path accepts real UTF-8 bytes.
    const raw = await postRaw(
      `/api/research/documents?sessionId=${sessionId}&filename=raw.md`,
      Buffer.from("# 原始字节\n\n这是一份以原始请求体上传的 Markdown。", "utf8"),
      "text/markdown",
    );
    expect(raw.status, JSON.stringify(raw.json)).toBe(201);
    expect((raw.json["document"] as { originalFilename: string }).originalFilename).toBe("raw.md");

    // Above the file limit the library refuses, and the transport says 413.
    const huge = await postRaw(
      `/api/research/documents?sessionId=${sessionId}&filename=huge.md`,
      new Uint8Array(600 * 1024).fill(65),
      "text/markdown",
    );
    expect(huge.status).toBe(413);
  }, 60_000);

  it("imports a converted document through the contract 3.7C will call", async () => {
    const created = await post("/api/research/intents", { seedTopic: "转换导入" });
    const sessionId = created.json["sessionId"] as string;
    const response = await post("/api/research/documents/import", {
      sessionId,
      originalFilename: "paper.pdf",
      originalFormat: "pdf",
      converter: "mineru",
      markdown: "# 从 PDF 转换\n\n这一段来自 MinerU 的 Markdown 输出。",
      conversionStatus: "succeeded",
      pageMap: [{ page: 1, charStart: 0, charEnd: 30 }],
    });
    expect(response.status, JSON.stringify(response.json)).toBe(201);
    const document = response.json["document"] as { origin: string; conversionProvider: string; conversion: Record<string, unknown>; originalFilename: string };
    expect(document.origin).toBe("converted");
    expect(document.conversionProvider).toBe("mineru");
    expect(document.originalFilename).toBe("paper.md");
    expect(document.conversion["originalFilename"]).toBe("paper.pdf");
    expect((document.conversion["pageMap"] as readonly unknown[]).length).toBe(1);

    const failed = await post("/api/research/documents/import", {
      sessionId,
      originalFilename: "broken.pdf",
      originalFormat: "pdf",
      converter: "mineru",
      markdown: "# x",
      conversionStatus: "failed",
    });
    expect(failed.status).toBe(400);
    expect(String(failed.json["error"])).toContain("转换");

    const noProvider = await post("/api/research/documents/import", { sessionId, markdown: "# x", originalFilename: "a.pdf" });
    expect(noProvider.status).toBe(400);
    expect(String(noProvider.json["error"])).toContain("provider");
  }, 60_000);
});

describe("Scenarios F and G — material, reports and the boundary between them", () => {
  let taskId = "";
  let sessionId = "";
  let documentIds: readonly string[] = [];

  it("builds a project whose material is two user documents", async () => {
    const created = await post("/api/research/intents", {
      seedTopic: "比较 Transformer 与 Mamba 在长上下文推理成本上的特点，用于部署选型",
      documents: [
        { filename: "transformer-notes.md", content: NOTES_A },
        { filename: "mamba-notes.md", content: NOTES_B },
      ],
    });
    expect(created.status).toBe(202);
    sessionId = created.json["sessionId"] as string;
    documentIds = (created.json["documents"] as readonly { documentId: string }[]).map((entry) => entry.documentId);
    const intentId = created.json["intentId"] as string;

    // The direction is proposed by the first turn; the user confirms it.
    await waitUntil(async () => {
      const state = await get(`/api/research/intents/${intentId}`);
      return (state.json["intent"] as { proposal: unknown } | undefined)?.proposal != null;
    }, "the direction proposal");
    const confirmed = await post(`/api/research/intents/${intentId}/confirm`, {});
    expect(confirmed.status).toBe(202);
    await waitUntil(async () => {
      const state = await get(`/api/research/sessions/${sessionId}`);
      return state.json["task"] !== null;
    }, "the task to exist");
    const bundle = (await get(`/api/research/sessions/${sessionId}`)).json["task"] as Record<string, unknown>;
    taskId = (bundle["task"] as { id: string }).id;
    // The user's confirmed topic, not the model's.
    expect((bundle["task"] as { topic: string }).topic).toBe("长上下文模型的推理成本比较");

    const task = (await taskBundle(taskId))["task"] as { id: string };
    expect(task.id).toBe(taskId);
    expect(((await taskBundle(taskId))["documents"] as readonly unknown[]).length).toBe(2);

    // Both files are marked as material by the user, then promoted to sources.
    for (const documentId of documentIds) {
      const marked = await fetch(`${app.pageOrigin}/api/research/documents/${documentId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, usage: ["intent_context", "research_source"] }),
      });
      expect(marked.status).toBe(200);
      const promoted = await post(`/api/research/documents/${documentId}/source`, { taskId });
      expect(promoted.status, JSON.stringify(promoted.json)).toBe(201);
      expect((promoted.json["source"] as { role: string }).role).toBe("user-provided");
    }
    const sources = app.service.sourcesOf(taskId);
    expect(sources).toHaveLength(2);
    project.sourceIds = sources.map((source) => source.id);
    project.subjectIds = app.service.getTask(taskId)?.subjects.map((subject) => subject.id) ?? [];
    project.dimensionIds = app.service.getTask(taskId)?.dimensions.map((dimension) => dimension.id) ?? [];

    // The research pass reads the user's documents, assesses the matrix and
    // writes the report: a real report on real, user-supplied material. It
    // starts where it always starts — the user confirming the brief.
    seenInstructions = [];
    const started = await post(`/api/research/tasks/${taskId}/confirm`, {});
    expect(started.status, JSON.stringify(started.json)).toBe(202);
    await waitUntil(async () => {
      const bundle = await taskBundle(taskId);
      return typeof bundle["currentReportId"] === "string" && bundle["currentReportId"].length > 0;
    }, "the report to be published", 240_000);
  }, 240_000);

  it("F. the document became the source, the snapshot and the evidence", async () => {
    const bundle = await taskBundle(taskId);
    const sources = bundle["sources"] as readonly { sourceId: string; role: string | null; readStatus: string; readScope: string | null }[];
    expect(sources).toHaveLength(2);
    expect(sources.map((source) => source.role)).toEqual(["user-provided", "user-provided"]);
    expect(sources.map((source) => `${source.readStatus}/${source.readScope}`)).toEqual(["ok/full_text", "ok/full_text"]);

    const evidence = bundle["evidence"] as readonly { evidenceId: string; excerpt: string; locator: { charStart: number; charEnd: number }; readScope: string }[];
    expect(evidence.length).toBeGreaterThan(0);
    // Every excerpt really is a substring of the text that was saved for it.
    const stored = app.service.evidenceOf(taskId);
    const snapshots = new Map(app.service.sourcesOf(taskId).map((source) => [source.id, app.service.snapshotTextOf(source.snapshotId ?? "") ?? ""]));
    for (const item of stored) {
      const text = snapshots.get(item.sourceId) ?? "";
      expect(text.slice(item.locator.charStart, item.locator.charEnd)).toBe(item.excerpt);
      expect(text.includes(item.excerpt)).toBe(true);
    }
    // And the material really is the user's own file.
    expect(snapshots.get(project.sourceIds[0] ?? "")).toContain("prefill 成本随上下文长度近似线性增长");
    // The read was not a discovery: the project's read budget is untouched.
    expect((bundle["usage"] as { reads: number }).reads).toBe(0);
    expect(String(bundle["currentReportId"]).length).toBeGreaterThan(0);
  }, 60_000);

  it("G. a file uploaded to a project with a report is readable and moves nothing", async () => {
    const before = await taskBundle(taskId);
    const beforeReport = app.service.reportsOf(taskId).find((report) => report.id === String(before["currentReportId"]));
    expect(beforeReport?.contentHash, `reports=${app.service.reportsOf(taskId).length}`).toBeDefined();
    const beforeText = JSON.stringify(beforeReport?.sections);

    const uploaded = await post("/api/research/documents", {
      taskId,
      filename: "third-notes.md",
      content: "# 第三份观测\n\n这次我们关注 decode 阶段在长上下文下的表现。",
    });
    expect(uploaded.status, JSON.stringify(uploaded.json)).toBe(201);
    const documentId = (uploaded.json["document"] as { documentId: string }).documentId;

    // Reading it is available, and it says what it read.
    const read = await post(`/api/research/documents/${documentId}/read`, { taskId });
    expect(read.status).toBe(200);
    expect(read.json["scope"]).toBe("full");
    expect(String(read.json["note"])).toContain("已读取全文");

    // Nothing about the report moved because a file arrived.
    const afterUpload = await taskBundle(taskId);
    const afterReport = app.service.reportsOf(taskId).find((report) => report.id === String(afterUpload["currentReportId"]));
    expect(afterReport?.id).toBe(beforeReport?.id);
    expect(afterReport?.contentHash).toBe(beforeReport?.contentHash);
    expect(JSON.stringify(afterReport?.sections)).toBe(beforeText);
    expect(app.service.reportsOf(taskId)).toHaveLength(1);
    expect((afterUpload["task"] as { reportNeedsReview: unknown }).reportNeedsReview).toBeNull();

    // The document is visible to the actions that read a project, and the
    // project's own records still know where the direction came from.
    expect((afterUpload["documents"] as readonly { documentId: string }[]).some((entry) => entry.documentId === documentId)).toBe(true);
    expect((afterUpload["intent"] as { seedTopic: string }).seedTopic).toContain("Transformer");
    expect((afterUpload["intent"] as { direction: { topic: string } }).direction.topic).toBe("长上下文模型的推理成本比较");
  }, 60_000);

  it("G'. a change the file suggests still needs a proposal the user accepts", async () => {
    // The only path to the report's text is a proposal: the document library
    // has no write into it, and a session holding a document grant has none
    // either.
    const before = await taskBundle(taskId);
    const reportId = String(before["currentReportId"]);
    const beforeReportHash = app.service.reportsOf(taskId).find((report) => report.id === reportId)?.contentHash;
    const accepted = await post(`/api/research/proposals/prop_does_not_exist/accept`, {});
    expect(accepted.status).toBe(409);

    app.service.issueGrant({ sessionId, intent: "edit", taskId, targetType: "section", targetId: "overview", scope: "测试" });
    const refused = app.service.saveReportPart(taskId, { kind: "finalize" });
    expect(refused.ok).toBe(false);
    if (refused.ok !== false) return;
    // The report is exactly where it was.
    const after = app.service.reportsOf(taskId).find((report) => report.id === reportId);
    expect(after?.contentHash).toBe(beforeReportHash);
  }, 60_000);

  it("H. a request that names two sessions is refused, whichever entry it uses", async () => {
    // A second session of the same product, with its own exploration: an id that
    // exists is not the same thing as an id that belongs to this request.
    const other = await post("/api/research/intents", { seedTopic: "另一个会话的主题" });
    expect(other.status, JSON.stringify(other.json)).toBe(202);
    const otherSession = other.json["sessionId"] as string;

    const state = await get(`/api/research/sessions/${sessionId}/intent`);
    const intentId = (state.json["intent"] as { intentId: string }).intentId;
    const documentId = documentIds[0] as string;
    const before = app.service.sourcesOf(taskId).length;

    // The list: B's session beside A's exploration. Answering with the
    // exploration's documents is how this request used to read somebody else's
    // library while naming its own session.
    const listConflict = await get(`/api/research/documents?sessionId=${otherSession}&intentId=${intentId}`);
    expect(listConflict.status).toBe(403);
    expect(listConflict.json["code"]).toBe("document_scope_conflict");

    // The promotion: the query says B, the body names A's task. The query used to
    // be dropped, and the source was created.
    const promoteConflict = await post(`/api/research/documents/${documentId}/source?sessionId=${otherSession}`, { taskId });
    expect(promoteConflict.status).toBe(403);
    expect(promoteConflict.json["code"]).toBe("document_scope_conflict");

    // The upload: the query says B, the body names A's exploration.
    const uploadConflict = await post(`/api/research/documents?sessionId=${otherSession}`, {
      intentId,
      filename: "smuggled.md",
      content: NOTES_A,
    });
    expect(uploadConflict.status).toBe(403);
    expect(uploadConflict.json["code"]).toBe("document_scope_conflict");

    // One field written twice with two values: `sessionId=B` in the query and
    // `sessionId=A` in the body is still a request that claimed both.
    const readConflict = await post(`/api/research/documents/${documentId}/read?sessionId=${otherSession}`, {
      sessionId,
      question: "成本",
    });
    expect(readConflict.status).toBe(403);
    expect(readConflict.json["code"]).toBe("document_scope_conflict");

    // Nothing was created, read or moved, and the honest requests still work.
    expect(app.service.sourcesOf(taskId)).toHaveLength(before);
    const otherLibrary = await get(`/api/research/documents?sessionId=${otherSession}`);
    expect(otherLibrary.status).toBe(200);
    expect(otherLibrary.json["documents"]).toEqual([]);
    const own = await get(`/api/research/documents?intentId=${intentId}`);
    expect(own.status).toBe(200);
    const bySession = await get(`/api/research/documents?sessionId=${sessionId}`);
    expect((own.json["documents"] as readonly unknown[]).length).toBe((bySession.json["documents"] as readonly unknown[]).length);
    expect((own.json["documents"] as readonly unknown[]).length).toBeGreaterThanOrEqual(2);
    const promoted = await post(`/api/research/documents/${documentId}/source`, { taskId, sessionId });
    expect([200, 201]).toContain(promoted.status);
  }, 60_000);
});
