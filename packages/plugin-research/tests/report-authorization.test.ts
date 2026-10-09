/**
 * Who may write the report draft.
 *
 * The draft is the report's own text, not a private scratchpad: the next report
 * stage is handed it as the work in progress and `finalize` seals it into a
 * version. A closure review found the incremental path — `start`, `write`,
 * `clear` — wrote it with no check at all, so a real Ask run (capabilities
 * `[]`, scope「只读取材料回答问题，不写入任何正式数据」) could persist a draft
 * that a later authorized pass would have resumed from, and an unconfirmed task
 * could be given report text through the same tool.
 *
 * What is tested here is that every part of `save_report` passes the same
 * boundary as the one-shot save: the current session must hold the `report`
 * capability for *this* task, and a refusal changes nothing.
 *
 * The service is the real one — the real repository, the real tools, the real
 * refusals — over an in-memory database; only the network is absent.
 */

import { describe, expect, it } from "vitest";

import { openResearchRepository, type ResearchRepository } from "../src/repository.js";
import { createResearchService, type ResearchService } from "../src/service.js";
import { createResearchTools } from "../src/tools.js";

const NOW = "2026-10-09T12:00:00.000Z";
const SESSION = "session_report_auth";

/** A tool's answer, as the model's runtime reads it: the bounded JSON text. */
function asJson(answer: unknown): Record<string, unknown> {
  return JSON.parse(String(answer)) as Record<string, unknown>;
}

/** The refusal a call produced, or a failure if it was not refused. */
function refusalOf(answer: Record<string, unknown>): readonly string[] {
  expect(answer["ok"], JSON.stringify(answer)).toBe(false);
  return (answer["problems"] ?? []) as readonly string[];
}

interface Harness {
  readonly repo: ResearchRepository;
  readonly service: ResearchService;
  makeTask(topic: string, sessionId?: string): string;
  save(input: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>>;
  draft(taskId: string): unknown;
  close(): void;
}

function open(): Harness {
  const repo = openResearchRepository({ location: ":memory:" });
  const service = createResearchService({ repo, now: () => new Date(NOW) });
  const tools = createResearchTools(service);
  return {
    repo,
    service,
    makeTask(topic, sessionId = SESSION) {
      service.issueGrant({ sessionId, intent: "card", taskId: null });
      const proposed = service.proposeTask(sessionId, {
        topic,
        purpose: "技术选型",
        audience: "工程师",
        focus: [],
        exclusions: "",
        lengthTarget: "约 4 页",
        subjects: [{ name: "GraphRAG" }, { name: "LightRAG" }],
        dimensions: [
          { name: "机制", question: "机制如何" },
          { name: "成本", question: "成本如何" },
          { name: "效果", question: "效果如何" },
        ],
      });
      if (!proposed.ok) throw new Error(`card refused: ${proposed.problems.join("; ")}`);
      service.clearGrant(sessionId);
      return proposed.task.id;
    },
    save: async (input, sessionId = SESSION) =>
      asJson(await tools.byName.save_report.execute(input, { sessionId, signal: new AbortController().signal })),
    draft: (taskId) => service.reportDraftOf(taskId),
    close: () => repo.close(),
  };
}

/** The one part of the report each negative case must not be able to touch. */
const START = {
  part: "start",
  title: "未授权草稿",
  summary: "这一行不该出现在任何任务的草稿里。",
  frame: { question: "Q", audience: "A", scope: "S" },
} as const;

const WRITE = {
  part: "write",
  section: {
    id: "overview",
    title: "未授权章节",
    blocks: [{ kind: "paragraph", text: "这一节不该被写进任何草稿。", claimIds: [] }],
  },
} as const;

/** Every part of the tool that writes, so a gate cannot cover only some of them. */
const PARTS: readonly (readonly [string, Record<string, unknown>])[] = [
  ["start", START],
  ["write", WRITE],
  ["clear", { part: "clear" }],
  ["finalize", { part: "finalize" }],
];

/**
 * A real draft, written the way the product writes it: under a `draft` grant
 * for this very task. Negative cases then have something to leave alone, which
 * is what "refused" has to mean — the draft is byte-identical afterwards,
 * `updatedAt` included.
 */
function withDraft(h: Harness, taskId: string): unknown {
  h.service.issueGrant({ sessionId: SESSION, intent: "draft", taskId, allowResearch: false });
  const saved = h.service.saveReportPart(taskId, {
    kind: "start",
    title: "已授权的草稿",
    summary: "这是报告阶段自己写下的工作稿。",
    frame: { question: "Q", audience: "A", scope: "S" },
  });
  expect(saved.ok).toBe(true);
  h.service.clearGrant(SESSION);
  const draft = h.draft(taskId);
  expect(draft).not.toBeNull();
  return draft;
}

describe("who may write the report draft", () => {
  it("refuses every part from a session that holds no grant, and leaves the draft alone", async () => {
    const h = open();
    try {
      const taskId = h.makeTask("无授权写入");
      const before = withDraft(h, taskId);
      for (const [name, input] of PARTS) {
        const refusal = refusalOf(await h.save(input));
        expect(refusal.join(" "), `${name} must be refused without a grant`).toContain("没有授权");
        expect(h.draft(taskId), `${name} must not have changed the draft`).toEqual(before);
      }
    } finally {
      h.close();
    }
  });

  it("refuses a Research grant: adding material is not writing the report", async () => {
    const h = open();
    try {
      const taskId = h.makeTask("研究授权");
      const before = withDraft(h, taskId);
      h.service.issueGrant({ sessionId: SESSION, intent: "research", taskId, allowResearch: true });
      for (const [name, input] of PARTS) {
        const refusal = refusalOf(await h.save(input));
        expect(refusal.join(" "), `${name} must be refused under Research`).toContain("不允许");
        expect(h.draft(taskId), `${name} must not have changed the draft`).toEqual(before);
      }
    } finally {
      h.close();
    }
  });

  it("refuses an Edit grant: a proposal is not a draft", async () => {
    const h = open();
    try {
      const taskId = h.makeTask("编辑授权");
      const before = withDraft(h, taskId);
      h.service.issueGrant({ sessionId: SESSION, intent: "edit", taskId, allowResearch: false });
      for (const [name, input] of PARTS) {
        const refusal = refusalOf(await h.save(input));
        expect(refusal.join(" "), `${name} must be refused under Edit`).toContain("不允许");
        expect(h.draft(taskId), `${name} must not have changed the draft`).toEqual(before);
      }
    } finally {
      h.close();
    }
  });

  it("refuses an Ask grant: its capabilities are empty and its scope says so", async () => {
    const h = open();
    try {
      const taskId = h.makeTask("只读提问");
      const before = withDraft(h, taskId);
      h.service.issueGrant({ sessionId: SESSION, intent: "ask", taskId, allowResearch: false });
      for (const [name, input] of PARTS) {
        const refusal = refusalOf(await h.save(input));
        expect(refusal.join(" "), `${name} must be refused under Ask`).toContain("不允许");
        expect(h.draft(taskId), `${name} must not have changed the draft`).toEqual(before);
      }
    } finally {
      h.close();
    }
  });

  it("refuses a draft grant that belongs to another task", async () => {
    const h = open();
    try {
      const taskId = h.makeTask("本任务");
      const other = h.makeTask("另一个任务", "session_report_auth_other");
      const before = withDraft(h, taskId);
      // The grant is real and does carry `report`, but it was minted for the
      // other task: a permission is not transferable between projects.
      h.service.issueGrant({ sessionId: SESSION, intent: "draft", taskId: other, allowResearch: false });
      const refusal = refusalOf(await h.save(START));
      expect(refusal.join(" ")).toContain("不能写入任务");
      expect(h.draft(taskId)).toEqual(before);
      expect(h.draft(other)).toBeNull();
    } finally {
      h.close();
    }
  });

  it("refuses every part for a task that was never confirmed", async () => {
    const h = open();
    try {
      // A card that the user has not confirmed: the product has no report stage
      // to mint a `report` grant for it, and the tool is not a way around that.
      const taskId = h.makeTask("未确认任务");
      expect(h.service.getTask(taskId)?.confirmedAt).toBeNull();
      for (const [name, input] of PARTS) {
        const refusal = refusalOf(await h.save(input));
        expect(refusal.join(" "), `${name} must be refused while unconfirmed`).toContain("没有授权");
        expect(h.draft(taskId), `${name} must not have created a draft`).toBeNull();
      }
      // The positive control for the sentence above: once the same session is
      // granted the capability, a draft exists — so what kept the task clean
      // was the boundary, not an accidental refusal.
      h.service.confirmTask(taskId);
      h.service.issueGrant({ sessionId: SESSION, intent: "draft", taskId, allowResearch: false });
      const saved = await h.save(START);
      expect(saved["ok"]).toBe(true);
      expect(h.draft(taskId)).not.toBeNull();
    } finally {
      h.close();
    }
  });
});

describe("the report stage still writes its own draft", () => {
  it("writes start, write and clear under a draft grant for this task", async () => {
    const h = open();
    try {
      const taskId = h.makeTask("合法报告阶段");
      h.service.confirmTask(taskId);
      h.service.issueGrant({ sessionId: SESSION, intent: "draft", taskId, allowResearch: false });

      const started = await h.save(START);
      expect(started["ok"], JSON.stringify(started)).toBe(true);
      expect(h.service.reportDraftOf(taskId)?.title).toBe("未授权草稿");

      const written = await h.save(WRITE);
      expect(written["ok"], JSON.stringify(written)).toBe(true);
      expect(h.service.reportDraftOf(taskId)?.sections.map((section) => section.id)).toEqual(["overview"]);

      const cleared = await h.save({ part: "clear" });
      expect(cleared["ok"], JSON.stringify(cleared)).toBe(true);
      expect(h.service.reportDraftOf(taskId)).toBeNull();
    } finally {
      h.close();
    }
  });

  it("lets finalize through the boundary to the validator rather than to a refusal", async () => {
    const h = open();
    try {
      const taskId = h.makeTask("finalize 路径");
      h.service.confirmTask(taskId);
      // No grant: the refusal names the permission.
      const unauthorised = refusalOf(await h.save({ part: "finalize" }));
      expect(unauthorised.join(" ")).toContain("没有授权");

      // With the grant, the same call is answered by the validator instead: the
      // draft is empty, and that is the only thing wrong with it.
      h.service.issueGrant({ sessionId: SESSION, intent: "draft", taskId, allowResearch: false });
      const incomplete = refusalOf(await h.save({ part: "finalize" }));
      expect(incomplete.join(" ")).toContain("草稿还不完整");
    } finally {
      h.close();
    }
  });
});
