/**
 * The report table contract, at the scale it was broken.
 *
 * The failure this file pins down is a real one, from a real run: a model wrote
 * a five-column comparison table whose rows were string arrays
 * (`["HippoRAG 2", "第 1 格", …, "第 5 格"]`), the parser read each array as an
 * object, found no `cells`, and stored four empty rows. The report then failed
 * Q03 for twenty blank cells — while the text it had written was already gone.
 *
 * So every test here is one of two things: a shape that must keep its text, or
 * a shape that must be refused *by field path* rather than reshaped. The rows
 * used below are copied from the real tool call, not invented for the test.
 */

import { describe, expect, it } from "vitest";

import type { ResearchTools } from "../src/tools.js";
import { createResearchTools } from "../src/tools.js";
import { openResearchRepository, type ResearchRepository } from "../src/repository.js";
import { createResearchService, type ResearchService } from "../src/service.js";
import type { Subject, Dimension } from "../src/domain.js";
import { buildMatrix } from "../src/structure.js";

const SESSION = "session_table_contract";

const SUBJECTS: readonly Subject[] = [
  { id: "sub_hipporag_2", name: "HippoRAG 2" },
  { id: "sub_graphrag_微软路线", name: "GraphRAG（微软路线）" },
];

const DIMENSIONS: readonly Dimension[] = [
  { id: "dim_item1", name: "图构建机制", question: "索引期是否用 LLM 建结构" },
  { id: "dim_item2", name: "索引构建成本", question: "索引期开销口径与可比性" },
  { id: "dim_item3", name: "多跳问答效果", question: "报告了什么、是否可比" },
  { id: "dim_item4", name: "查询侧与更新维护", question: "线上开销与增量能力" },
  { id: "dim_item5", name: "成本-效果权衡的条件", question: "何时值得" },
];

interface Harness {
  readonly repo: ResearchRepository;
  readonly service: ResearchService;
  readonly tools: ResearchTools;
  readonly taskId: string;
  save(input: unknown): Promise<string>;
  draftTable():
    | {
        readonly rows: readonly { readonly cells: readonly { readonly text: string; readonly claimIds: readonly string[] }[] }[];
        readonly rowSubjects?: readonly (string | null)[];
      }
    | undefined;
  close(): void;
}

function open(): Harness {
  const repo = openResearchRepository({ location: ":memory:" });
  const service = createResearchService({ repo });
  service.issueGrant({ sessionId: SESSION, intent: "card", taskId: null });
  const proposed = service.proposeTask(SESSION, {
    topic: "图结构化检索方案的选型评估",
    purpose: "技术选型",
    audience: "工程决策者",
    focus: [],
    exclusions: "",
    lengthTarget: "约 5 页",
    subjects: SUBJECTS.map((subject) => ({ name: subject.name })),
    dimensions: DIMENSIONS.map((dimension) => ({ name: dimension.name, question: dimension.question })),
  });
  if (!proposed.ok) throw new Error(`card refused: ${proposed.problems.join("; ")}`);
  const task = proposed.task;
  service.confirmTask(task.id);
  service.clearGrant(SESSION);
  service.issueGrant({ sessionId: SESSION, intent: "draft", taskId: task.id, allowResearch: false });
  const tools = createResearchTools(service);
  const taskId = task.id;
  return {
    repo,
    service,
    tools,
    taskId,
    async save(input: unknown): Promise<string> {
      const tool = tools.byName["save_report"];
      if (tool === undefined) throw new Error("save_report is missing");
      const result = await tool.execute(input, { sessionId: SESSION, signal: new AbortController().signal });
      return typeof result === "string" ? result : JSON.stringify(result);
    },
    draftTable() {
      const draft = service.reportDraftOf(taskId);
      const section = draft?.sections.find((candidate) => candidate.id === "comparison");
      const block = section?.blocks.find((candidate) => candidate.kind === "table");
      return block?.kind === "table" ? block : undefined;
    },
    close() {
      repo.close();
    },
  };
}

/** A claim whose evidence ids are never checked here; the table is what is under test. */
function claim(id: string): Record<string, unknown> {
  return { id, text: "一条有依据的判断", evidenceIds: [] };
}

async function startDraft(harness: Harness, withSubjects: boolean): Promise<string> {
  const result = await harness.save({
    part: "start",
    title: "图结构化检索方案的选型评估",
    summary: "本报告比较两种图结构化检索方案在多跳问答上的机制与成本口径。",
    frame: { question: "哪种方案值得投入", audience: "工程决策者", scope: "两篇原始论文" },
    claims: [claim("clm_mechanism_hipporag2"), claim("clm_cost_scope")],
  });
  void withSubjects;
  return result;
}

/**
 * The real row, verbatim from the recorded tool call.
 *
 * Keeping the original text matters: the point of the test is that *this*
 * content survives, and a paraphrased fixture would pass against a parser that
 * only handles the easy case.
 */
const REAL_ROWS: readonly (readonly string[])[] = [
  [
    "HippoRAG 2",
    "可直接比较（primary 来源）：LLM 抽开放 KG 三元组加同义检测，短语与段落同为图节点；查询时 query-to-triple、recognition memory 与 PPR 扩散",
    "部分可比（作者自报，单语料内）：在 MuSiQue（11,656 段落）、Llama-3.3-70B-Instruct 下设四项统计；具体百分比本报告未切出，故不给量级",
    "仅作者自报、不可直接比较：报告取得最高平均 F1；缺第三方同 benchmark 并列测量，具体数值未切出",
    "有限可比：查询侧含 LLM 过滤与 PPR 扩散，作者按每查询时间口径统计；无三元组时回退稠密检索",
    "仅间接依据（作者自报）：比 GraphRAG/LightRAG 用更少 token、更快，但比 RAPTOR/HippoRAG 略慢",
  ],
  [
    "GraphRAG（微软路线）",
    "可直接比较（primary 来源）：抽取实体关系后聚类成社区，再让 LLM 为每个社区写摘要",
    "不可直接比较：本报告未取得社区摘要成本的同口径测量",
    "证据不足：没有可引用的多跳问答效果依据",
    "有限可比：更新维护需要重建社区结构，来自竞争方口径",
    "仅间接依据：社区摘要只在需要全局性问题时才有对应收益",
  ],
];

describe("the report table contract", () => {
  it("keeps every cell of a legacy array row, in the shape real models write", async () => {
    const harness = open();
    try {
      await startDraft(harness, true);
      const answer = await harness.save({
        part: "write",
        section: {
          id: "comparison",
          title: "条件化比较",
          blocks: [
            {
              kind: "table",
              columns: DIMENSIONS.map((dimension) => dimension.name),
              columnDimensions: DIMENSIONS.map((dimension) => dimension.id),
              rowSubjects: ["sub_hipporag_2", "sub_graphrag_微软路线"],
              rows: REAL_ROWS,
            },
          ],
        },
      });

      expect(JSON.parse(answer)).toMatchObject({ ok: true });
      const table = harness.draftTable();
      expect(table).toBeDefined();
      expect(table?.rows).toHaveLength(2);
      // The defect was exactly this: four rows with `cells: []`.
      expect(table?.rows[0]?.cells).toHaveLength(5);
      expect(table?.rows[1]?.cells).toHaveLength(5);
      expect(table?.rows[0]?.cells[0]?.text).toContain("可直接比较（primary 来源）");
      expect(table?.rows[1]?.cells[2]?.text).toContain("没有可引用的多跳问答效果依据");
      // The array row's leading element is its subject label, and it is recorded
      // as the row's identity rather than being dropped or counted as a cell.
      expect(table?.rowSubjects).toEqual(["sub_hipporag_2", "sub_graphrag_微软路线"]);
      expect(table?.rows[0]?.cells.map((cell) => cell.text)).not.toContain("HippoRAG 2");
    } finally {
      harness.close();
    }
  });

  it("accepts the canonical cells shape unchanged", async () => {
    const harness = open();
    try {
      await startDraft(harness, true);
      const answer = await harness.save({
        part: "write",
        section: {
          id: "comparison",
          title: "条件化比较",
          blocks: [
            {
              kind: "table",
              columns: ["机制", "成本"],
              columnDimensions: ["dim_item1", "dim_item2"],
              rowSubjects: ["sub_hipporag_2"],
              rows: [{ cells: [{ text: "离线建图", claimIds: ["clm_mechanism_hipporag2"] }, { text: "证据不足", claimIds: [] }] }],
            },
          ],
        },
      });
      expect(JSON.parse(answer)).toMatchObject({ ok: true });
      const table = harness.draftTable();
      expect(table?.rows[0]?.cells.map((cell) => cell.text)).toEqual(["离线建图", "证据不足"]);
      expect(table?.rows[0]?.cells[0]?.claimIds).toEqual(["clm_mechanism_hipporag2"]);
    } finally {
      harness.close();
    }
  });

  it("refuses a row whose width does not line up with the columns, by field path", async () => {
    const harness = open();
    try {
      await startDraft(harness, true);
      const answer = await harness.save({
        part: "write",
        section: {
          id: "comparison",
          title: "条件化比较",
          blocks: [
            {
              kind: "table",
              columns: ["机制", "成本", "效果"],
              rowSubjects: ["sub_hipporag_2"],
              // Five elements under three columns: neither [label, …cells]
              // (width 4) nor cells-only (width 3), so it is refused rather
              // than guessed at.
              rows: [["HippoRAG 2", "机制", "成本", "效果", "第五项"]],
            },
          ],
        },
      });
      const refused = JSON.parse(answer) as { ok: boolean; problems: string[]; fields: { path: string }[] };
      expect(refused.ok).toBe(false);
      expect(refused.problems[0]).toContain("5 个元素");
      expect(refused.problems[0]).toContain("3 列");
      expect(refused.fields[0]?.path).toBe("section.blocks[0].rows[0]");
      expect(harness.draftTable()).toBeUndefined();
    } finally {
      harness.close();
    }
  });

  it("refuses a row that loses or adds a cell in the canonical shape", async () => {
    const harness = open();
    try {
      await startDraft(harness, true);
      const answer = await harness.save({
        part: "write",
        section: {
          id: "comparison",
          title: "条件化比较",
          blocks: [
            {
              kind: "table",
              columns: ["机制", "成本"],
              rowSubjects: ["sub_hipporag_2"],
              rows: [{ cells: [{ text: "只有一格" }] }],
            },
          ],
        },
      });
      const refused = JSON.parse(answer) as { ok: boolean; fields: { path: string }[]; problems: string[] };
      expect(refused.ok).toBe(false);
      expect(refused.fields[0]?.path).toBe("section.blocks[0].rows[0].cells");
      expect(refused.problems[0]).toContain("1 格");
      expect(refused.problems[0]).toContain("2 列");
    } finally {
      harness.close();
    }
  });

  it("refuses a blank cell instead of storing a comparison full of blanks", async () => {
    const harness = open();
    try {
      await startDraft(harness, true);
      const answer = await harness.save({
        part: "write",
        section: {
          id: "comparison",
          title: "条件化比较",
          blocks: [
            {
              kind: "table",
              columns: ["机制", "成本"],
              rowSubjects: ["sub_hipporag_2"],
              rows: [{ cells: [{ text: "离线建图" }, { text: "   " }] }],
            },
          ],
        },
      });
      const refused = JSON.parse(answer) as { ok: boolean; fields: { path: string }[]; guidance: string };
      expect(refused.ok).toBe(false);
      expect(refused.fields[0]?.path).toBe("section.blocks[0].rows[0].cells[1].text");
      // A blank is refused with the sentence that says what to write instead.
      const body = JSON.stringify(refused);
      expect(body).toContain("证据不足");
      expect(harness.draftTable()).toBeUndefined();
    } finally {
      harness.close();
    }
  });

  it("refuses an array row whose leading element is not this row's subject", async () => {
    const harness = open();
    try {
      await startDraft(harness, true);
      const answer = await harness.save({
        part: "write",
        section: {
          id: "comparison",
          title: "条件化比较",
          blocks: [
            {
              kind: "table",
              columns: ["机制", "成本"],
              rowSubjects: ["sub_hipporag_2", "sub_graphrag_微软路线"],
              rows: [
                ["GraphRAG（微软路线）", "社区摘要", "证据不足"],
                ["GraphRAG（微软路线）", "社区摘要", "证据不足"],
              ],
            },
          ],
        },
      });
      const refused = JSON.parse(answer) as { ok: boolean; fields: { path: string }[]; problems: string[] };
      expect(refused.ok).toBe(false);
      // Row 0 declares HippoRAG 2 and opens with GraphRAG's name.
      expect(refused.fields[0]?.path).toBe("section.blocks[0].rows[0][0]");
      expect(refused.problems[0]).toContain("sub_hipporag_2");
    } finally {
      harness.close();
    }
  });

  it("refuses a section with no id, and says which field is missing", async () => {
    const harness = open();
    try {
      await startDraft(harness, true);
      const answer = await harness.save({
        part: "write",
        section: { title: "条件化比较", blocks: [{ kind: "paragraph", text: "正文" }] },
      });
      const refused = JSON.parse(answer) as { ok: boolean; fields: { path: string }[] };
      expect(refused.ok).toBe(false);
      expect(refused.fields[0]?.path).toBe("section.id");
      expect(harness.service.reportDraftOf(harness.taskId)?.sections ?? []).toHaveLength(0);
    } finally {
      harness.close();
    }
  });

  it("refuses a block kind the contract does not have, instead of reading it as prose", async () => {
    const harness = open();
    try {
      await startDraft(harness, true);
      const answer = await harness.save({
        part: "write",
        section: {
          id: "comparison",
          title: "条件化比较",
          // `matrix` is the kind a model reached for once; reading it as an
          // empty paragraph would store a section whose content is gone.
          blocks: [{ kind: "matrix", columns: ["a"], rows: [["b"]] }],
        },
      });
      const refused = JSON.parse(answer) as { ok: boolean; fields: { path: string }[]; problems: string[] };
      expect(refused.ok).toBe(false);
      expect(refused.fields[0]?.path).toBe("section.blocks[0].kind");
      expect(refused.problems[0]).toContain("matrix");
    } finally {
      harness.close();
    }
  });

  it("keeps a section's other blocks when it refuses, so nothing is half-written", async () => {
    const harness = open();
    try {
      await startDraft(harness, true);
      const answer = await harness.save({
        part: "write",
        section: {
          id: "comparison",
          title: "条件化比较",
          blocks: [
            { kind: "paragraph", text: "这一节会比较两个对象。" },
            { kind: "table", columns: ["机制"], rows: [["a", "b", "c"]] },
          ],
        },
      });
      expect((JSON.parse(answer) as { ok: boolean }).ok).toBe(false);
      // Nothing from the refused section is stored: a half-applied section is
      // text the model never agreed to.
      expect(harness.draftTable()).toBeUndefined();
      expect(harness.service.reportDraftOf(harness.taskId)?.sections ?? []).toHaveLength(0);
    } finally {
      harness.close();
    }
  });

  it("keeps the draft's subject ids, so the table's row identities stay checkable", () => {
    const harness = open();
    try {
      const task = harness.service.getTask(harness.taskId);
      expect(task?.subjects.map((subject) => subject.name)).toEqual(["HippoRAG 2", "GraphRAG（微软路线）"]);
      expect(buildMatrix(task?.subjects ?? [], task?.dimensions ?? [], "2026-10-09T00:00:00Z")).toHaveLength(10);
    } finally {
      harness.close();
    }
  });
});

/**
 * Object identity, at the version boundaries it was broken at.
 *
 * A row's label used to be accepted when it *contained* the declared subject's
 * name (or was contained by it), after every separator had been deleted — so a
 * task comparing「GraphRAG」with「GraphRAG 2」stored the newer version's content
 * under the older version's name, and the width check passed while the objects
 * did not correspond. Identity here is exact: an id, or a name that is that
 * subject's own.
 */
describe("the report table's object identity", () => {
  function openTask(subjectNames: readonly string[]): Harness {
    const repo = openResearchRepository({ location: ":memory:" });
    const service = createResearchService({ repo });
    service.issueGrant({ sessionId: SESSION, intent: "card", taskId: null });
    const proposed = service.proposeTask(SESSION, {
      topic: "图结构化检索方案的选型评估",
      purpose: "技术选型",
      audience: "工程决策者",
      focus: [],
      exclusions: "",
      lengthTarget: "约 5 页",
      subjects: subjectNames.map((name) => ({ name })),
      dimensions: DIMENSIONS.map((dimension) => ({ name: dimension.name, question: dimension.question })),
    });
    if (!proposed.ok) throw new Error(`card refused: ${proposed.problems.join("; ")}`);
    const task = proposed.task;
    service.confirmTask(task.id);
    service.clearGrant(SESSION);
    service.issueGrant({ sessionId: SESSION, intent: "draft", taskId: task.id, allowResearch: false });
    const tools = createResearchTools(service);
    const taskId = task.id;
    return {
      repo,
      service,
      tools,
      taskId,
      async save(input: unknown): Promise<string> {
        const tool = tools.byName["save_report"];
        if (tool === undefined) throw new Error("save_report is missing");
        const result = await tool.execute(input, { sessionId: SESSION, signal: new AbortController().signal });
        return typeof result === "string" ? result : JSON.stringify(result);
      },
      draftTable() {
        const draft = service.reportDraftOf(taskId);
        const section = draft?.sections.find((candidate) => candidate.id === "comparison");
        const block = section?.blocks.find((candidate) => candidate.kind === "table");
        return block?.kind === "table" ? block : undefined;
      },
      close() {
        repo.close();
      },
    };
  }

  /** A table section, written the way a model writes one. */
  function sectionWith(block: unknown): Record<string, unknown> {
    return { part: "write", section: { id: "comparison", title: "条件化比较", blocks: [block] } };
  }

  it("refuses the cross-version row that used to be stored under the other object", async () => {
    // The reproduction from the independent review: the task has GraphRAG and
    // GraphRAG 2, the row declares GraphRAG, and the array opens with GraphRAG 2.
    const harness = openTask(["GraphRAG", "GraphRAG 2"]);
    try {
      const subjects = harness.service.state(harness.taskId).subjects;
      const older = subjects.find((subject) => subject.name === "GraphRAG")?.id ?? "";
      const newer = subjects.find((subject) => subject.name === "GraphRAG 2")?.id ?? "";
      expect(older).not.toBe("");
      expect(newer).not.toBe("");

      const refused = JSON.parse(
        await harness.save(
          sectionWith({ kind: "table", columns: ["成本"], rowSubjects: [older], rows: [["GraphRAG 2", "GraphRAG 2 的正文被标为 GraphRAG"]] }),
        ),
      ) as { ok: boolean; fields: { path: string }[]; problems: string[] };
      expect(refused.ok).toBe(false);
      expect(refused.fields[0]?.path).toBe("section.blocks[0].rows[0][0]");
      expect(refused.problems[0]).toContain(older);
      // The refusal leaves no draft behind: the wrong identity was never stored.
      expect(harness.draftTable()).toBeUndefined();

      //…and the same row with the label its declaration names is accepted.
      const accepted = JSON.parse(
        await harness.save(sectionWith({ kind: "table", columns: ["成本"], rowSubjects: [older], rows: [["GraphRAG", "证据不足"]] })),
      ) as { ok: boolean };
      expect(accepted.ok).toBe(true);
      expect(harness.draftTable()?.rowSubjects?.[0]).toBe(older);

      // The exact id is an identity too, including for the newer version.
      const byId = JSON.parse(
        await harness.save(sectionWith({ kind: "table", columns: ["成本"], rowSubjects: [newer], rows: [[newer, "证据不足"]] })),
      ) as { ok: boolean };
      expect(byId.ok).toBe(true);
      expect(harness.draftTable()?.rowSubjects?.[0]).toBe(newer);
    } finally {
      harness.close();
    }
  });

  it("does not read a version suffix as the object it is a suffix of", async () => {
    const harness = openTask(["v1.0", "v10"]);
    try {
      const [v1, v10] = harness.service.state(harness.taskId).subjects.map((subject) => subject.id);
      const refused = JSON.parse(
        await harness.save(sectionWith({ kind: "table", columns: ["成本"], rowSubjects: [v1], rows: [["v10", "证据不足"]] })),
      ) as { ok: boolean };
      expect(refused.ok).toBe(false);
      const accepted = JSON.parse(
        await harness.save(sectionWith({ kind: "table", columns: ["成本"], rowSubjects: [v10], rows: [["v10", "证据不足"]] })),
      ) as { ok: boolean };
      expect(accepted.ok).toBe(true);
    } finally {
      harness.close();
    }
  });

  it("refuses a declaration that names no subject of this task", async () => {
    const harness = openTask(["GraphRAG", "GraphRAG 2"]);
    try {
      const refused = JSON.parse(
        await harness.save(sectionWith({ kind: "table", columns: ["成本"], rowSubjects: ["sub_invented"], rows: [{ cells: [{ text: "证据不足" }] }] })),
      ) as { ok: boolean; fields: { path: string }[] };
      expect(refused.ok).toBe(false);
      expect(refused.fields[0]?.path).toBe("section.blocks[0].rowSubjects[0]");
    } finally {
      harness.close();
    }
  });

  it("refuses a name that could be two subjects, and takes the id that cannot", async () => {
    // The two names normalise to the same string (a full-width letter), so the
    // name is not an identity: only the id says which object the row is.
    const harness = openTask(["GraphRAG", "ＧraphRAG"]);
    try {
      const subjects = harness.service.state(harness.taskId).subjects;
      const ids = subjects.map((subject) => subject.id);
      expect(ids.length).toBe(2);
      const refused = JSON.parse(
        await harness.save(sectionWith({ kind: "table", columns: ["成本"], rowSubjects: ["GraphRAG"], rows: [{ cells: [{ text: "证据不足" }] }] })),
      ) as { ok: boolean };
      expect(refused.ok).toBe(false);
      const accepted = JSON.parse(
        await harness.save(
          sectionWith({ kind: "table", columns: ["成本"], rowSubjects: [ids[1] ?? ""], rows: [[ids[1] ?? "", "证据不足"]] }),
        ),
      ) as { ok: boolean };
      expect(accepted.ok).toBe(true);
    } finally {
      harness.close();
    }
  });

  it("treats full-width brackets as the same name they are", async () => {
    const harness = open();
    try {
      const id = harness.service.state(harness.taskId).subjects.find((subject) => subject.name === "GraphRAG（微软路线）")?.id ?? "";
      const halfWidth = JSON.parse(
        await harness.save(sectionWith({ kind: "table", columns: ["成本"], rowSubjects: [id], rows: [["GraphRAG(微软路线)", "证据不足"]] })),
      ) as { ok: boolean };
      expect(halfWidth.ok).toBe(true);
      expect(harness.draftTable()?.rowSubjects?.[0]).toBe(id);
    } finally {
      harness.close();
    }
  });

  it("resolves an undeclared legacy label to its object, and keeps one that names nothing", async () => {
    const harness = open();
    try {
      const newer = harness.service.state(harness.taskId).subjects.find((subject) => subject.name === "GraphRAG（微软路线）")?.id ?? "";
      const resolved = JSON.parse(
        await harness.save(sectionWith({ kind: "table", columns: ["成本"], rows: [["GraphRAG（微软路线）", "证据不足"]] })),
      ) as { ok: boolean };
      expect(resolved.ok).toBe(true);
      expect(harness.draftTable()?.rowSubjects?.[0]).toBe(newer);

      // A label naming no subject of this task is kept as written rather than
      // guessed at, and Q05 still reports it.
      const kept = JSON.parse(
        await harness.save(sectionWith({ kind: "table", columns: ["成本"], rows: [["从未声明过的对象", "证据不足"]] })),
      ) as { ok: boolean };
      expect(kept.ok).toBe(true);
      expect(harness.draftTable()?.rowSubjects?.[0]).toBe("从未声明过的对象");
    } finally {
      harness.close();
    }
  });
});
