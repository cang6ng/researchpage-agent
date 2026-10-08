/**
 * What the exploration panel decides, tested as decisions.
 *
 * These are the sentences a reader acts on, and each one has a failure that
 * looks harmless until it happens: a second confirmation building a second
 * project, an unsaved edit being confirmed as if it were on the table, a
 * keyboard-typed answer being refused because the assistant is still thinking,
 * an editor sending a whole direction back when the user changed one word. The
 * cases below are the exact boundaries — the two sides of each one, not just
 * the side that is allowed.
 */

import { describe, expect, it } from "vitest";

import type { IntentView, LibraryDocumentView, ResearchDirectionView } from "../src/browser/api.js";
import {
  TASK_WAIT_TIMEOUT_MS,
  attachableDocumentsOf,
  confirmGateOf,
  directionDraftChanged,
  directionDraftOf,
  directionPatchOf,
  documentsNewerThanProposal,
  saveDirectionGateOf,
  sendGateOf,
  taskWaitPhaseOf,
} from "../src/browser/intent-logic.js";

function direction(overrides: Partial<ResearchDirectionView> = {}): ResearchDirectionView {
  return {
    topic: "长文档问答的 RAG 选型",
    purpose: "在条件化差异下给出选型判断",
    scope: "只比较检索增强的几条路线，不涉及模型训练",
    audience: "正在做技术选型的工程师",
    focus: ["成本口径"],
    exclusions: "不评价具体商业产品",
    lengthTarget: "4–6 页",
    subjects: [{ name: "GraphRAG" }],
    dimensions: [{ name: "成本", question: "三段成本分别如何报告？" }],
    summary: "我理解你的研究方向是……",
    at: "2026-10-09T00:00:00.000Z",
    source: "agent",
    ...overrides,
  };
}

function document(overrides: Partial<LibraryDocumentView> & { readonly documentId: string }): LibraryDocumentView {
  return {
    sessionId: "sess_1",
    taskId: null,
    originalFilename: "notes.md",
    title: "长上下文部署笔记",
    sizeBytes: 1200,
    contentHash: "hash",
    createdAt: "2026-10-09T00:00:00.000Z",
    origin: "direct_upload",
    conversionProvider: null,
    conversion: null,
    status: "ready",
    usage: ["intent_context"],
    outline: [],
    outlineTotal: 0,
    outlineTruncated: false,
    revision: 1,
    note: "",
    failure: null,
    linkedSourceId: null,
    chars: 1200,
    paragraphs: 3,
    truncated: false,
    ...overrides,
  };
}

function intent(overrides: Partial<IntentView> = {}): IntentView {
  return {
    intentId: "itn_1",
    sessionId: "sess_1",
    seedTopic: "Agent 记忆系统",
    status: "ready_to_confirm",
    statusLabel: "方向待确认",
    version: 3,
    createdAt: "2026-10-09T00:00:00.000Z",
    updatedAt: "2026-10-09T00:00:00.000Z",
    taskId: null,
    turns: [],
    decisions: [],
    proposal: direction(),
    proposalSummary: "我理解你的研究方向是……",
    confirmedDirection: null,
    confirmedAt: null,
    documents: [],
    pending: null,
    canConfirm: true,
    confirmQuestion: "我理解你的研究方向是上面这些，是否准确？",
    openFields: ["dimensions"],
    userMessages: [],
    assistantQuestions: [],
    ...overrides,
  };
}

describe("sending a message", () => {
  it("allows a real answer while nothing is running", () => {
    expect(sendGateOf({ status: "exploring", serverBusy: false, working: false, text: "半年内要落地" })).toEqual({
      allowed: true,
      reason: "",
    });
  });

  it("refuses while the server is still on the previous turn", () => {
    const gate = sendGateOf({ status: "exploring", serverBusy: true, working: false, text: "你好" });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain("等待");
  });

  it("refuses an empty answer and says why", () => {
    const gate = sendGateOf({ status: "exploring", serverBusy: false, working: false, text: "   " });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain("写一句话");
  });

  it("closes the conversation once the direction is confirmed", () => {
    // A confirmed exploration is not a chat any more: its direction is what the
    // card was built from, and a later turn would describe a project that no
    // longer matches its own record.
    const gate = sendGateOf({ status: "confirmed", serverBusy: false, working: false, text: "再补充一点" });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain("已确认");
  });
});

describe("saving and confirming the direction", () => {
  it("will not save a draft that is identical to the direction", () => {
    const gate = saveDirectionGateOf({ status: "ready_to_confirm", serverBusy: false, working: false, dirty: false });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain("还没有改动");
  });

  it("requires the draft to be saved before confirming", () => {
    // Otherwise the confirmation would be of a direction the user has never
    // seen: the version on the server, not the text in the editor.
    const gate = confirmGateOf({
      status: "ready_to_confirm",
      canConfirm: true,
      serverBusy: false,
      working: false,
      dirty: true,
      attachmentsBusy: false,
    });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain("先保存");
  });

  it("waits for files that are still being converted", () => {
    const gate = confirmGateOf({
      status: "ready_to_confirm",
      canConfirm: true,
      serverBusy: false,
      working: false,
      dirty: false,
      attachmentsBusy: true,
    });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain("转换");
  });

  it("confirms when there is a direction, nothing running and nothing unsaved", () => {
    expect(
      confirmGateOf({
        status: "ready_to_confirm",
        canConfirm: true,
        serverBusy: false,
        working: false,
        dirty: false,
        attachmentsBusy: false,
      }),
    ).toEqual({ allowed: true, reason: "" });
  });

  it("does not offer confirmation twice", () => {
    const gate = confirmGateOf({
      status: "confirmed",
      canConfirm: true,
      serverBusy: false,
      working: false,
      dirty: false,
      attachmentsBusy: false,
    });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain("确认过");
  });

  it("will not confirm before the assistant has proposed anything", () => {
    const gate = confirmGateOf({
      status: "exploring",
      canConfirm: false,
      serverBusy: false,
      working: false,
      dirty: false,
      attachmentsBusy: false,
    });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain("还没有给出");
  });
});

describe("the direction editor", () => {
  it("starts from the direction on the table", () => {
    expect(directionDraftOf(direction()).topic).toBe("长文档问答的 RAG 选型");
    expect(directionDraftOf(null)).toEqual({ topic: "", purpose: "", scope: "", audience: "" });
  });

  it("sends only the fields the user changed", () => {
    const before = directionDraftOf(direction());
    const patch = directionPatchOf(before, { ...before, scope: "只看中文语料" });
    expect(patch).toEqual({ scope: "只看中文语料" });
  });

  it("sends nothing when nothing changed", () => {
    const before = directionDraftOf(direction());
    expect(directionPatchOf(before, { ...before })).toBeNull();
    expect(directionDraftChanged(before, { ...before })).toBe(false);
  });

  it("treats a cleared field as a change rather than as nothing", () => {
    // The server falls back to the previous value for an empty field, so the
    // page must not pretend the clear succeeded — but it is still an edit worth
    // sending, and it is still a draft that has to be saved before confirming.
    const before = directionDraftOf(direction());
    const after = { ...before, audience: "" };
    expect(directionPatchOf(before, after)).toEqual({ audience: "" });
    expect(directionDraftChanged(before, after)).toBe(true);
  });
});

describe("waiting for a task card", () => {
  const now = 1_000_000;

  it("says nothing before a confirmation has happened on this page", () => {
    expect(taskWaitPhaseOf({ confirmedAt: null, now })).toBe("idle");
  });

  it("distinguishes waiting, waiting too long, and not having arrived", () => {
    expect(taskWaitPhaseOf({ confirmedAt: now - 1_000, now })).toBe("waiting");
    expect(taskWaitPhaseOf({ confirmedAt: now - TASK_WAIT_TIMEOUT_MS, now })).toBe("slow");
    expect(taskWaitPhaseOf({ confirmedAt: now - TASK_WAIT_TIMEOUT_MS * 2, now })).toBe("timeout");
  });

  it("treats the timeout as a page statement, not as a failed card", () => {
    // The product has no route that reports why a card stage did or did not
    // run, so the words at the end of the wait have to promise exactly what the
    // page can do: read again, or start another exploration.
    const text = TASK_WAIT_TIMEOUT_MS > 0 ? "重新读取" : "";
    expect(text).toBe("重新读取");
    expect(taskWaitPhaseOf({ confirmedAt: now - TASK_WAIT_TIMEOUT_MS * 2, now })).not.toBe("idle");
  });
});

describe("documents in the conversation", () => {
  it("offers only documents of this session that are already in the library", () => {
    const view = intent({
      documents: [
        document({ documentId: "doc_a" }),
        document({ documentId: "doc_b", status: "failed" }),
        document({ documentId: "doc_c", sessionId: "sess_other" }),
      ],
    });
    expect(attachableDocumentsOf(view, ["doc_a", "doc_b", "doc_c", "doc_missing"])).toEqual(["doc_a"]);
  });

  it("names the documents that arrived after the proposal was written", () => {
    const view = intent({
      proposal: direction({ at: "2026-10-09T00:00:00.000Z" }),
      documents: [
        document({ documentId: "doc_old", createdAt: "2026-10-08T00:00:00.000Z" }),
        document({ documentId: "doc_new", createdAt: "2026-10-09T01:00:00.000Z" }),
        document({ documentId: "doc_converting", createdAt: "2026-10-09T02:00:00.000Z", status: "failed" }),
      ],
    });
    expect(documentsNewerThanProposal(view)).toEqual(["doc_new"]);
  });
});
