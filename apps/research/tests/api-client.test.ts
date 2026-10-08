/**
 * The page's half of the API contract, tested against a recorder.
 *
 * These cases are about the *shape* of what leaves the browser, which is the
 * one thing a server-side test cannot see: whether a GET carries a content type
 * it never asked for, whether a conversion's body is the file's own bytes
 * rather than a JSON string describing them, whether the scope a write belongs
 * to travels with it, and whether the four different 409s the product can
 * answer with arrive as four different facts instead of one word.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, THIRD_PARTY_UPLOAD_CONSENT, api } from "../src/browser/api.js";

interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: unknown;
}

let recorded: Recorded[] = [];

function respond(status: number, value: unknown): void {
  const body = value === undefined ? "" : JSON.stringify(value);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      recorded.push({
        url: String(url),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers ?? undefined),
        body: init?.body ?? null,
      });
      return new Response(body, { status, headers: { "content-type": "application/json" } });
    }),
  );
}

beforeEach(() => {
  recorded = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("how a request is put together", () => {
  it("does not attach a content type to a read", async () => {
    respond(200, { tasks: [] });
    const controller = new AbortController();
    await api.listTasks({ signal: controller.signal });
    expect(recorded[0]?.method).toBe("GET");
    expect(recorded[0]?.headers.has("content-type")).toBe(false);
    expect(recorded[0]?.body).toBeNull();
  });

  it("sends JSON with a content type and the body the caller wrote", async () => {
    respond(202, { ok: true });
    await api.createIntent({ seedTopic: "长文档问答的 RAG 选型" });
    expect(recorded[0]?.method).toBe("POST");
    expect(recorded[0]?.headers.get("content-type")).toContain("application/json");
    expect(JSON.parse(String(recorded[0]?.body))).toEqual({ seedTopic: "长文档问答的 RAG 选型" });
  });

  it("sends the direction edit as a flat {expectedVersion, direction} envelope", async () => {
    // The route reads `body.direction` and falls back to the body itself, so an
    // edit wrapped in a second key would arrive as an empty change.
    respond(200, { ok: true });
    await api.saveIntentDirection("itn_1", { expectedVersion: 4, direction: { scope: "只看中文语料" } });
    const body = JSON.parse(String(recorded[0]?.body)) as Record<string, unknown>;
    expect(body["expectedVersion"]).toBe(4);
    expect(body["direction"]).toEqual({ scope: "只看中文语料" });
  });

  it("carries the scope of a document write in the body it already needs", async () => {
    respond(200, { ok: true });
    await api.setDocumentUsage("doc_1", {
      usage: ["research_source"],
      expectedRevision: 3,
      scope: { taskId: "task_1" },
    });
    expect(recorded[0]?.method).toBe("PATCH");
    const body = JSON.parse(String(recorded[0]?.body)) as Record<string, unknown>;
    expect(body["taskId"]).toBe("task_1");
    expect(body["expectedRevision"]).toBe(3);
    expect(body["usage"]).toEqual(["research_source"]);
  });

  it("sends a conversion as the file's own bytes, not as JSON", async () => {
    respond(202, { ok: true, job: { jobId: "job_1" } });
    const bytes = new TextEncoder().encode("%PDF-1.7 fake").buffer;
    await api.submitConversion({
      scope: { sessionId: "sess_1" },
      filename: "paper.pdf",
      usage: ["intent_context"],
      bytes,
      consent: THIRD_PARTY_UPLOAD_CONSENT,
    });
    const request = recorded[0];
    expect(request?.headers.get("content-type")).toBe("application/octet-stream");
    expect(request?.body).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(request?.body as ArrayBuffer).byteLength).toBe(bytes.byteLength);
    const url = new URL(String(request?.url), "http://localhost");
    expect(url.searchParams.get("filename")).toBe("paper.pdf");
    expect(url.searchParams.get("consent")).toBe("third_party_upload");
    expect(url.searchParams.get("usage")).toBe("intent_context");
    expect(url.searchParams.get("sessionId")).toBe("sess_1");
  });

  it("asks about a job with the session the job belongs to", async () => {
    respond(200, { ok: true, job: { jobId: "job_1", status: "converting" } });
    await api.conversionJob("job_1", "sess_1");
    expect(String(recorded[0]?.url)).toContain("/documents/convert/job_1?sessionId=sess_1");
  });

  it("retries with the job's own session in the body", async () => {
    respond(202, { ok: true, job: { jobId: "job_1" } });
    await api.retryConversion("job_1", "sess_1");
    expect(recorded[0]?.method).toBe("POST");
    expect(JSON.parse(String(recorded[0]?.body))).toEqual({ sessionId: "sess_1" });
  });
});

describe("what a refusal carries back", () => {
  it("tells the three 409s apart", async () => {
    respond(409, {
      error: "这段对话正在处理上一轮内容",
      problems: ["这段对话正在处理上一轮内容"],
      guidance: "请等待当前一轮结束后再提交下一条消息。",
      reason: "run_in_progress",
    });
    const error = await api.sendIntentMessage("itn_1", { text: "你好" }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ApiError);
    const refusal = error as ApiError;
    expect(refusal.status).toBe(409);
    expect(refusal.reason).toBe("run_in_progress");
    expect(refusal.stale).toBe(false);
    expect(refusal.guidance).toContain("等待");
  });

  it("carries the exploration the page is out of date against", async () => {
    respond(409, {
      error: "方向已经被改过",
      problems: ["方向已经被改过"],
      guidance: "请重新读取。",
      stale: true,
      intent: { intentId: "itn_1", version: 9, status: "ready_to_confirm" },
    });
    const error = (await api.sendIntentMessage("itn_1", { text: "你好" }).catch((thrown: unknown) => thrown)) as ApiError;
    expect(error.stale).toBe(true);
    expect(error.intent?.version).toBe(9);
  });

  it("marks a document conflict without pretending it is a version clash", async () => {
    respond(409, {
      error: "文档已经被改过",
      problems: ["文档已经被改过"],
      guidance: "请重新读取后再提交。",
      code: "document_revision_conflict",
      conflict: true,
    });
    const error = (
      await api.setDocumentUsage("doc_1", { usage: ["intent_context"], expectedRevision: 1, scope: { sessionId: "s" } }).catch(
        (thrown: unknown) => thrown,
      )
    ) as ApiError;
    expect(error.conflict).toBe(true);
    expect(error.stale).toBe(false);
    expect(error.code).toBe("document_revision_conflict");
  });

  it("keeps the brief a 409 was taken against", async () => {
    respond(409, { error: "简报还没完成", problems: ["缺少读者"], guidance: "补齐后再确认。", brief: { version: 2 } });
    const error = (await api.confirm("task_1").catch((thrown: unknown) => thrown)) as ApiError;
    expect(error.brief).toEqual({ version: 2 });
    expect(error.problems).toEqual(["缺少读者"]);
  });

  it("reads the problem a conversion service reported", async () => {
    respond(503, {
      error: "转换服务不可用",
      problems: ["转换服务不可用"],
      guidance: "请检查 uvx 是否可用。",
      code: "mcp_not_installed",
    });
    const error = (await api.mineru().catch((thrown: unknown) => thrown)) as ApiError;
    expect(error.status).toBe(503);
    expect(error.code).toBe("mcp_not_installed");
  });
});
