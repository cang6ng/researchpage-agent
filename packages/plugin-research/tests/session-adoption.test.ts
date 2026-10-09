/**
 * Who a session belongs to.
 *
 * The binding a session has to a research task is the identity every tool
 * resolves its target from — a tool call never carries a task id of its own — so
 * it is also the whole of what an agent run may read and write. This file pins
 * the one operation that writes it: adoption, which exists because a session
 * whose run a process died inside is blocked by the host and cannot accept the
 * project's next stage.
 *
 * An independent closure review found the operation had no guard at all: a
 * session already working on project B could be moved onto project A, after
 * which B's session read A's project and a report grant held for A let it write
 * A's draft. What is tested here is that adoption is now an *add*, never a move.
 *
 * The service is the real one — the real repository, the real tools — over an
 * in-memory database; only the network is absent.
 */

import { describe, expect, it } from "vitest";

import { openResearchRepository, type ResearchRepository } from "../src/repository.js";
import { createResearchService, type ResearchService } from "../src/service.js";
import { createResearchTools } from "../src/tools.js";
import type { ReadOutcome } from "../src/read.js";
import type { SearchOutcome } from "../src/search.js";

const NOW = "2026-10-09T12:00:00.000Z";

/** A tool's answer, as the model's runtime reads it: the bounded JSON text. */
function asJson(answer: unknown): Record<string, unknown> {
  return JSON.parse(String(answer)) as Record<string, unknown>;
}

interface Harness {
  readonly repo: ResearchRepository;
  readonly service: ResearchService;
  readonly tools: ReturnType<typeof createResearchTools>;
  makeTask(sessionId: string, topic: string): string;
  savedBy(sessionId: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  loadedBy(sessionId: string): Promise<Record<string, unknown>>;
  close(): void;
}

function open(): Harness {
  const repo = openResearchRepository({ location: ":memory:" });
  const service = createResearchService({
    repo,
    search: async (query: string): Promise<SearchOutcome> => ({
      provider: "arxiv",
      query,
      requestUrl: `fixture://${query}`,
      fetchedAt: NOW,
      total: 0,
      candidates: [],
    }),
    read: async (): Promise<ReadOutcome> => ({
      status: "failed",
      scope: null,
      title: "",
      text: "",
      paragraphs: [],
      readUrl: "",
      fetchedAt: NOW,
      contentType: "text/html",
      note: "（脚本化读取：本测试不涉及真实网络）",
      failure: "not used",
    }),
    now: () => new Date(NOW),
  });
  const tools = createResearchTools(service);
  return {
    repo,
    service,
    tools,
    makeTask(sessionId, topic) {
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
      service.confirmTask(proposed.task.id);
      service.clearGrant(sessionId);
      return proposed.task.id;
    },
    savedBy: async (sessionId, input) =>
      asJson(await tools.byName.save_report.execute(input, { sessionId, signal: new AbortController().signal })),
    loadedBy: async (sessionId) =>
      asJson(await tools.byName.load_research_state.execute({}, { sessionId, signal: new AbortController().signal })),
    close: () => repo.close(),
  };
}

/** The topic a session's own project was created with, as its state reports it. */
function topicLoadedBy(state: Record<string, unknown>): string {
  const task = (state["state"] ?? {}) as { task?: { topic?: string } };
  return task.task?.topic ?? "";
}

describe("session adoption", () => {
  it("refuses to move a session that already carries another project", () => {
    const h = open();
    try {
      const a = h.makeTask("session_task_A", "项目 A");
      const b = h.makeTask("session_task_B", "项目 B");
      expect(h.service.taskForSession("session_task_B")?.id).toBe(b);

      expect(() => h.service.adoptSessionForTask(a, "session_task_B")).toThrow(/已绑定任务/);
      // The binding is exactly what it was: B's session still works on B.
      expect(h.service.taskForSession("session_task_B")?.id).toBe(b);
    } finally {
      h.close();
    }
  });

  it("refuses an empty session id", () => {
    const h = open();
    try {
      const a = h.makeTask("session_task_A", "项目 A");
      expect(() => h.service.adoptSessionForTask(a, "")).toThrow(/不能为空/);
      expect(() => h.service.adoptSessionForTask(a, "   ")).toThrow(/不能为空/);
    } finally {
      h.close();
    }
  });

  it("is a no-op when the session already works on the same project", () => {
    const h = open();
    try {
      const a = h.makeTask("session_task_A", "项目 A");
      expect(() => h.service.adoptSessionForTask(a, "session_task_A")).not.toThrow();
      expect(h.service.taskForSession("session_task_A")?.id).toBe(a);
    } finally {
      h.close();
    }
  });

  it("adopts a fresh session, and the project is reachable from it", async () => {
    const h = open();
    try {
      const a = h.makeTask("session_task_A", "项目 A");
      h.service.adoptSessionForTask(a, "session_recovery_carrier");
      expect(h.service.taskForSession("session_recovery_carrier")?.id).toBe(a);
      // What the project's own blocks-excluded session keeps is its binding.
      expect(h.service.taskForSession("session_task_A")?.id).toBe(a);
      const loaded = await h.loadedBy("session_recovery_carrier");
      expect(loaded["ok"]).toBe(true);
      expect(topicLoadedBy(loaded)).toBe("项目 A");
    } finally {
      h.close();
    }
  });

  it("gives a session no read or write of a project it does not carry", async () => {
    const h = open();
    try {
      const a = h.makeTask("session_task_A", "项目 A");
      const b = h.makeTask("session_task_B", "项目 B");
      // A recovery that tries to borrow B's session for A is refused…
      expect(() => h.service.adoptSessionForTask(a, "session_task_B")).toThrow();
      // …so B's session reads B, not A.
      expect(topicLoadedBy(await h.loadedBy("session_task_B"))).toBe("项目 B");

      // A grant is held for A and B's session asks to write a draft. B's
      // session holds none of its own, so the write is refused before it
      // touches anything — not A's draft, which is the harm the review
      // demonstrated, and not B's either.
      const draftInput = {
        part: "start",
        title: "B 自己的草稿",
        summary: "跨会话写入隔离验证",
        frame: { question: "Q", audience: "A", scope: "S" },
      };
      h.service.issueGrant({ sessionId: "session_task_A", intent: "draft", taskId: a, allowResearch: false });
      const refused = await h.savedBy("session_task_B", draftInput);
      expect(refused["ok"]).toBe(false);
      expect(h.service.reportDraftOf(a)).toBeNull();
      expect(h.service.reportDraftOf(b)).toBeNull();

      // What B's session writes under B's own draft grant goes to B, and A's
      // draft stays untouched.
      h.service.issueGrant({ sessionId: "session_task_B", intent: "draft", taskId: b, allowResearch: false });
      const saved = await h.savedBy("session_task_B", draftInput);
      expect(saved["ok"]).toBe(true);
      expect(h.service.reportDraftOf(a)).toBeNull();
      expect(h.service.reportDraftOf(b)?.title).toBe("B 自己的草稿");
    } finally {
      h.close();
    }
  });
});
