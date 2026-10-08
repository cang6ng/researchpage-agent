/**
 * The document library as the network actually reaches it.
 *
 * The service-level cases live beside the library; these are the ones that can
 * only fail (or pass) over HTTP: whether a request that names somebody else's
 * session gets a document, whether a client that says「这是 MinerU 转换的，trusted:
 * true」gets a verified conversion, which status the transport answers for an
 * oversized file, and whether a document with two thousand headings blows the
 * instruction the runner hands the model. Every case here drives the real
 * server, the real routes and the real runner.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelClient, ModelEvent, ModelMessage, ModelRequest, RuntimeContext } from "@every-dagent/agent-core";
import { DEFAULT_MODEL_FRAMING } from "@every-dagent/agent-core";
import { UNTRUSTED_DOCUMENT_NOTE } from "@every-dagent/plugin-research";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startResearchApp, type ResearchApp } from "../src/server/composition.js";
import { testComposition } from "../../../tests/helpers/test-composition.js";

const workDir = mkdtempSync(join(tmpdir(), "researchpage-document-isolation-"));
const dataDir = join(workDir, "data");
const staticRoot = join(process.cwd(), "apps", "research", "public");

/** Every instruction the runner handed the model, for the context-budget case. */
let seenInstructions: string[] = [];

function instructionOf(messages: readonly ModelMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return message.text;
  }
  return "";
}

function next(events: readonly ModelEvent[]): AsyncIterable<ModelEvent> {
  return (async function* () {
    for (const event of events) yield event;
  })();
}

/**
 * A model that only ever talks.
 *
 * These cases are about the library and the wire, not about a research pass:
 * the conversation stage gets a sentence, which leaves the exploration open and
 * the instructions inspectable.
 */
function quietModel(): ModelClient {
  return {
    limits: { contextWindow: 128 * 1024, maxOutputTokens: 8 * 1024, framing: DEFAULT_MODEL_FRAMING },
    stream(request: ModelRequest, _context: RuntimeContext): AsyncIterable<ModelEvent> {
      seenInstructions.push(instructionOf(request.messages));
      return next([{ type: "text-delta", text: "我先读一下你给的材料。" }, { type: "done" }]);
    },
  };
}

let app: ResearchApp;

beforeAll(async () => {
  app = await startResearchApp({
    dataDir,
    staticRoot,
    composition: testComposition({ modelClient: quietModel() }),
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

async function request(method: string, path: string, body?: unknown): Promise<Response> {
  const response = await fetch(`${app.pageOrigin}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, json: text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

async function post(path: string, body: unknown): Promise<Response> {
  return request("POST", path, body);
}

async function postRaw(path: string, body: Uint8Array | string, contentType: string): Promise<Response> {
  const response = await fetch(`${app.pageOrigin}${path}`, { method: "POST", headers: { "content-type": contentType }, body });
  const text = await response.text();
  return { status: response.status, json: text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

const NOTES = ["# 部署观测", "", "## 成本", "", "生产环境下 prefill 成本随上下文长度近似线性增长。"].join("\n");

async function newSession(seedTopic: string): Promise<string> {
  const created = await post("/api/research/intents", { seedTopic });
  expect(created.status, JSON.stringify(created.json)).toBe(202);
  return created.json["sessionId"] as string;
}

async function upload(sessionId: string, filename: string, content: string): Promise<string> {
  const uploaded = await post("/api/research/documents", { sessionId, filename, content });
  expect(uploaded.status, JSON.stringify(uploaded.json)).toBe(201);
  return (uploaded.json["document"] as { documentId: string }).documentId;
}

describe("the caller's session is checked, not copied off the document", () => {
  it("refuses every operation another session asks for, and leaves the document intact", async () => {
    const sessionA = await newSession("A 的会话");
    const sessionB = await newSession("B 的会话");
    const documentId = await upload(sessionA, "notes.md", NOTES);

    const foreignView = await request("GET", `/api/research/documents/${documentId}?sessionId=${sessionB}`);
    expect(foreignView.status).toBe(403);
    expect(foreignView.json["code"]).toBe("document_cross_session");

    const foreignContent = await request("GET", `/api/research/documents/${documentId}/content?sessionId=${sessionB}`);
    expect(foreignContent.status).toBe(403);

    const foreignRead = await post(`/api/research/documents/${documentId}/read`, { sessionId: sessionB, question: "成本" });
    expect(foreignRead.status).toBe(403);
    expect(foreignRead.json["code"]).toBe("document_cross_session");

    const foreignPatch = await request("PATCH", `/api/research/documents/${documentId}`, {
      sessionId: sessionB,
      usage: ["intent_context", "research_source"],
    });
    expect(foreignPatch.status).toBe(403);

    const foreignDelete = await request("DELETE", `/api/research/documents/${documentId}?sessionId=${sessionB}`);
    expect(foreignDelete.status).toBe(403);

    // The document is where it was, readable by the session that owns it.
    const owned = await request("GET", `/api/research/documents/${documentId}?sessionId=${sessionA}`);
    expect(owned.status, JSON.stringify(owned.json)).toBe(200);
    const content = await fetch(`${app.pageOrigin}/api/research/documents/${documentId}/content?sessionId=${sessionA}`);
    expect(content.status).toBe(200);
    expect(await content.text()).toBe(NOTES);
    const listed = await request("GET", `/api/research/documents?sessionId=${sessionB}`);
    expect(listed.status, JSON.stringify(listed.json)).toBe(200);
    expect((listed.json["documents"] as readonly unknown[]).length).toBe(0);
  }, 60_000);

  it("refuses an operation that names no session, and a list that names none", async () => {
    const sessionId = await newSession("无会话的请求");
    const documentId = await upload(sessionId, "notes.md", NOTES);

    const noScope = await request("GET", `/api/research/documents/${documentId}`);
    expect(noScope.status).toBe(400);
    expect(noScope.json["code"]).toBe("document_scope_missing");

    const noScopeRead = await post(`/api/research/documents/${documentId}/read`, {});
    expect(noScopeRead.status).toBe(400);
    expect(noScopeRead.json["code"]).toBe("document_scope_missing");

    const noScopeDelete = await request("DELETE", `/api/research/documents/${documentId}`);
    expect(noScopeDelete.status).toBe(400);

    const noScopeList = await request("GET", "/api/research/documents");
    expect(noScopeList.status).toBe(400);
    expect(noScopeList.json["code"]).toBe("document_scope_missing");

    // An unknown document in a valid session is a 404, not a 403.
    const unknown = await request("GET", `/api/research/documents/doc_missing?sessionId=${sessionId}`);
    expect(unknown.status).toBe(404);
    expect(unknown.json["code"]).toBe("document_not_found");
  }, 60_000);

  it("refuses a stale update instead of overwriting what just changed", async () => {
    const sessionId = await newSession("并发写");
    const documentId = await upload(sessionId, "notes.md", NOTES);
    const first = await request("GET", `/api/research/documents/${documentId}?sessionId=${sessionId}`);
    const revision = (first.json["document"] as { revision: number }).revision;
    expect(revision).toBe(1);

    const marked = await request("PATCH", `/api/research/documents/${documentId}`, {
      sessionId,
      usage: ["intent_context", "research_source"],
      expectedRevision: revision,
    });
    expect(marked.status, JSON.stringify(marked.json)).toBe(200);
    expect((marked.json["document"] as { revision: number }).revision).toBe(2);

    const stale = await request("PATCH", `/api/research/documents/${documentId}`, {
      sessionId,
      usage: ["intent_context"],
      expectedRevision: revision,
    });
    expect(stale.status).toBe(409);
    expect(stale.json["conflict"]).toBe(true);

    const still = await request("GET", `/api/research/documents/${documentId}?sessionId=${sessionId}`);
    expect((still.json["document"] as { usage: readonly string[] }).usage).toEqual(["intent_context", "research_source"]);
  }, 60_000);
});

describe("a client cannot promote its own conversion", () => {
  it("records an import as a claim, whatever the payload says", async () => {
    const sessionId = await newSession("转换导入");
    const markdown = "# 从 PDF 转换\n\n这一段来自转换器的 Markdown 输出。";
    const imported = await post("/api/research/documents/import", {
      sessionId,
      originalFilename: "paper.pdf",
      originalFormat: "pdf",
      converter: "mineru",
      markdown,
      conversionStatus: "succeeded",
      // A payload that tries to promote itself: none of this is read.
      trusted: true,
      verified: true,
      trust: "server_verified",
      conversion: { provider: "mineru", pageMap: [{ page: 1, charStart: 0, charEnd: markdown.length }] },
    });
    expect(imported.status, JSON.stringify(imported.json)).toBe(201);
    expect(imported.json["conversionTrust"]).toBe("client_claimed");
    const document = imported.json["document"] as { conversion: { trust: string; pageMap: readonly unknown[] } };
    expect(document.conversion.trust).toBe("client_claimed");
    expect(document.conversion.pageMap).toHaveLength(1);
    expect(String(imported.json["note"])).toContain("client_claimed");

    // The server's own conversion path is the only one that writes verified
    // provenance, and it is not reachable from here.
    const viaServer = app.service.importConvertedDocument({
      sessionId,
      filename: "converted-by-server.md",
      content: { text: `${markdown}

服务端路径写入的补充段落。` },
      conversion: { provider: "mineru", originalFilename: "paper.pdf", originalFormat: "pdf", status: "succeeded" },
    });
    if (viaServer.ok !== true) throw new Error(JSON.stringify(viaServer));
    expect(viaServer.document.conversion?.trust).toBe("server_verified");
  }, 60_000);
});

describe("the library's limits, as the transport reports them", () => {
  it("accepts 40 KiB over JSON and base64, and refuses a broken encoding by name", async () => {
    const sessionId = await newSession("大小与编码");
    const forty = `# 四十 KB\n\n${"内容".repeat(20 * 1024)}`;

    const json = await post("/api/research/documents", { sessionId, filename: "forty.md", content: forty });
    expect(json.status, JSON.stringify(json.json).slice(0, 200)).toBe(201);
    expect((json.json["document"] as { chars: number }).chars).toBeGreaterThan(40_000);

    const base64 = await post("/api/research/documents", {
      sessionId,
      filename: "forty-base64.md",
      contentBase64: Buffer.from(`# 四十 KB\n\n${"内容".repeat(20 * 1024)}`, "utf8").toString("base64"),
    });
    expect(base64.status, JSON.stringify(base64.json)).toBe(201);
    // The same bytes are the same document, and base64 is not a second library.
    expect(base64.json["duplicate"]).toBe(true);

    const gbk = new Uint8Array([0xb1, 0xe0, 0xb1, 0xe0, 0x0a, 0xd6, 0xd0, 0xce, 0xc4]);
    const notUtf8 = await postRaw(`/api/research/documents?sessionId=${sessionId}&filename=gbk.md`, gbk, "text/markdown");
    expect(notUtf8.status).toBe(400);
    expect(String(notUtf8.json["error"])).toContain("UTF-8");

    // The same bytes inside a JSON envelope: refusing them has to happen before
    // JSON decoding, or the body arrives as a document full of U+FFFD.
    const inJson = Buffer.concat([
      Buffer.from(`{"sessionId":"${sessionId}","filename":"gbk.md","content":"`, "utf8"),
      gbk,
      Buffer.from('"}', "utf8"),
    ]);
    const notUtf8Json = await postRaw("/api/research/documents", inJson, "application/json");
    expect(notUtf8Json.status).toBe(400);
    expect(String(notUtf8Json.json["error"])).toContain("UTF-8");

    const badName = await post("/api/research/documents", { sessionId, filename: "../escape.md", content: NOTES });
    expect(badName.status).toBe(400);
    expect(String(badName.json["error"])).toContain("路径分隔符");
  }, 60_000);

  it("answers the same way for the same oversized file, whatever the entry point", async () => {
    const sessionId = await newSession("超限");
    const oversized = `# 太大\n\n${"x".repeat(600 * 1024)}`;

    const raw = await postRaw(
      `/api/research/documents?sessionId=${sessionId}&filename=big.md`,
      new Uint8Array(600 * 1024).fill(65),
      "text/markdown",
    );
    expect(raw.status).toBe(413);
    expect(String(raw.json["error"])).toContain("文件过大");

    const json = await post("/api/research/documents", { sessionId, filename: "big.md", content: oversized });
    expect(json.status).toBe(413);
    expect(json.json["code"]).toBe("document_too_large");

    const base64 = await post("/api/research/documents", {
      sessionId,
      filename: "big.md",
      contentBase64: Buffer.from(oversized, "utf8").toString("base64"),
    });
    expect(base64.status).toBe(413);

    // An envelope over the transport limit is a *request* problem, and says so.
    const envelope = await post("/api/research/documents", {
      sessionId,
      filename: "big.md",
      content: "x".repeat(1_400_000),
    });
    expect(envelope.status).toBe(413);
    expect(String(envelope.json["error"])).toContain("请求体过大");
  }, 60_000);

  it("reports a missing session as a missing session and a huge file as a huge file", async () => {
    // The file is checked before the session, so a caller who got both wrong is
    // told the thing that actually helps.
    const oversized = `# 太大\n\n${"x".repeat(600 * 1024)}`;
    const both = await post("/api/research/documents", { filename: "big.md", content: oversized });
    expect(both.status).toBe(413);
    expect(both.json["code"]).toBe("document_too_large");

    const anonymous = await post("/api/research/documents", { filename: "notes.md", content: NOTES });
    expect(anonymous.status).toBe(400);
    expect(anonymous.json["code"]).toBe("document_scope_missing");
    expect(String(anonymous.json["error"])).toContain("会话");

    // A document attached to a seed topic is the same file through the same
    // limits: 40 KiB must not be dropped because the envelope is small JSON.
    const attached = await post("/api/research/intents", {
      seedTopic: "随主题一起上传",
      documents: [{ filename: "seed-notes.md", content: `# 随主题上传\n\n${"内容".repeat(20 * 1024)}` }],
    });
    expect(attached.status, JSON.stringify(attached.json).slice(0, 200)).toBe(202);
    expect((attached.json["documents"] as readonly unknown[]).length).toBe(1);
  }, 60_000);

  it("answers an over-limit attachment to a seed topic as too large, and creates nothing", async () => {
    // The same file and the same limit as every other entry point: an attachment
    // that is over it is a 413 here too, not a 400 that reads as「请求不合法」.
    const oversized = `# 太大\n\n${"x".repeat(600 * 1024)}`;
    const text = await post("/api/research/intents", {
      seedTopic: "带一个超大附件",
      documents: [{ filename: "big.md", content: oversized }],
    });
    expect(text.status, JSON.stringify(text.json).slice(0, 200)).toBe(413);
    expect(text.json["code"]).toBe("document_too_large");
    expect(String(text.json["error"])).toContain("文件过大");

    const base64 = await post("/api/research/intents", {
      seedTopic: "带一个超大附件（base64）",
      documents: [{ filename: "big.md", contentBase64: Buffer.from(oversized, "utf8").toString("base64") }],
    });
    expect(base64.status).toBe(413);
    expect(base64.json["code"]).toBe("document_too_large");

    // Nothing half-made: no exploration was started (there is no intent to name),
    // and the ordinary creation path still works right after.
    expect(text.json["intentId"]).toBeUndefined();
    expect(base64.json["intentId"]).toBeUndefined();
    const ordinary = await post("/api/research/intents", { seedTopic: "正常创建" });
    expect(ordinary.status, JSON.stringify(ordinary.json).slice(0, 200)).toBe(202);
    expect(typeof ordinary.json["intentId"]).toBe("string");
  }, 60_000);
});

describe("a request that names two sessions is refused, not executed as one of them", () => {
  it("refuses a list whose session and exploration do not agree", async () => {
    const sessionA = await newSession("列表作用域的会话 A");
    const sessionB = await newSession("列表作用域的会话 B");
    await upload(sessionA, "notes.md", NOTES);
    const state = await request("GET", `/api/research/sessions/${sessionA}/intent`);
    const intentId = (state.json["intent"] as { intentId: string }).intentId;

    // B's own library is empty, and A's exploration is not B's to read. Reading
    // only the exploration id is how this request used to answer with A's file.
    const conflict = await request("GET", `/api/research/documents?sessionId=${sessionB}&intentId=${intentId}`);
    expect(conflict.status).toBe(403);
    expect(conflict.json["code"]).toBe("document_scope_conflict");

    // One claim each still answers the library it named.
    const byIntent = await request("GET", `/api/research/documents?intentId=${intentId}`);
    expect(byIntent.status).toBe(200);
    expect((byIntent.json["documents"] as readonly unknown[]).length).toBe(1);
    const bySession = await request("GET", `/api/research/documents?sessionId=${sessionA}`);
    expect((bySession.json["documents"] as readonly unknown[]).length).toBe(1);
  }, 60_000);

  it("refuses an operation whose query and body name different sessions", async () => {
    const sessionA = await newSession("作用域交叉的会话 A");
    const sessionB = await newSession("作用域交叉的会话 B");
    const documentId = await upload(sessionA, "notes.md", NOTES);
    const state = await request("GET", `/api/research/sessions/${sessionA}/intent`);
    const intentId = (state.json["intent"] as { intentId: string }).intentId;

    // The same field written twice with two values: whichever is read first, the
    // other one is a claim the request also made.
    const readConflict = await post(`/api/research/documents/${documentId}/read?sessionId=${sessionB}`, {
      sessionId: sessionA,
      question: "成本",
    });
    expect(readConflict.status).toBe(403);
    expect(readConflict.json["code"]).toBe("document_scope_conflict");

    // A session in the query, somebody else's exploration in the body.
    const uploadConflict = await post(`/api/research/documents?sessionId=${sessionB}`, {
      intentId,
      filename: "smuggled.md",
      content: NOTES,
    });
    expect(uploadConflict.status).toBe(403);
    expect(uploadConflict.json["code"]).toBe("document_scope_conflict");

    // Nothing was read, written or moved: A's document is intact and B's library
    // still holds nothing.
    const owned = await request("GET", `/api/research/documents/${documentId}?sessionId=${sessionA}`);
    expect(owned.status, JSON.stringify(owned.json)).toBe(200);
    const listed = await request("GET", `/api/research/documents?sessionId=${sessionB}`);
    expect(listed.status).toBe(200);
    expect(listed.json["documents"]).toEqual([]);
    const inA = await request("GET", `/api/research/documents?sessionId=${sessionA}`);
    expect((inA.json["documents"] as readonly unknown[]).length).toBe(1);
  }, 60_000);
});

describe("a table of contents cannot spend the model's context", () => {
  it("keeps the first instruction small, and says the outline was cut short", async () => {
    const headings = Array.from({ length: 2_000 }, (_, index) => `## 章节 ${index + 1}\n\n第 ${index + 1} 节的内容。`).join("\n\n");
    const document = `# 目录很长的文档\n\n${headings}`;
    expect(document.length).toBeGreaterThan(40_000);

    seenInstructions = [];
    // The intent route creates the session, so the seed topic names it uniquely.
    const created = await post("/api/research/intents", {
      seedTopic: "一个带超长目录的材料",
      documents: [{ filename: "many-headings.md", content: document }],
    });
    expect(created.status, JSON.stringify(created.json).slice(0, 300)).toBe(202);
    const sessionId = created.json["sessionId"] as string;
    const documentId = (created.json["documents"] as readonly { documentId: string }[])[0]?.documentId ?? "";

    const document$ = await request("GET", `/api/research/documents/${documentId}?sessionId=${sessionId}`);
    const view = document$.json["document"] as { outlineTotal: number; outlineTruncated: boolean; outline: readonly unknown[] };
    expect(view.outlineTotal).toBe(2_001);
    expect(view.outlineTruncated).toBe(true);
    expect(view.outline.length).toBeLessThan(200);

    // The stage that reads the attachments has run; its instruction is bounded.
    await waitFor(
      () => Promise.resolve(seenInstructions.some((text) => text.includes(documentId))),
      "the first instruction for this document",
    );
    // The instruction that belongs to *this* document: stages from the other
    // cases in this file also write intent instructions.
    const instruction = seenInstructions.find((text) => text.includes(documentId) && text.includes("这是一段对话，不是问卷")) ?? "";
    expect(instruction.length).toBeGreaterThan(0);
    expect(instruction.length).toBeLessThan(20_000);
    expect(instruction).toContain("目录");
    expect(instruction).toContain("只列出前");
    expect(instruction).toContain("不可信数据");
  }, 60_000);

  it("carries a short document to the model whole, and marks the text as data once", async () => {
    // The other end of the same budget: a document that fits is not cut for the
    // sake of a sentence about being cut, and the model is told it has all of it.
    const body = "短文档正文".repeat(8);
    expect(body.length).toBe(40);
    const created = await post("/api/research/intents", {
      seedTopic: "一个很短的材料",
      documents: [{ filename: "short.md", content: `# Short\n\n${body}` }],
    });
    expect(created.status, JSON.stringify(created.json).slice(0, 300)).toBe(202);
    const documentId = (created.json["documents"] as readonly { documentId: string }[])[0]?.documentId ?? "";

    await waitFor(
      () => Promise.resolve(seenInstructions.some((text) => text.includes(documentId))),
      "the first instruction for this short document",
    );
    const instruction = seenInstructions.find((text) => text.includes(documentId) && text.includes("这是一段对话，不是问卷")) ?? "";
    expect(instruction.length).toBeGreaterThan(0);
    // Every character of the body reached the model, and the line says the
    // fragment is the whole document rather than a partial read.
    expect(instruction).toContain(body);
    expect(instruction).toContain("本次片段已包含全文");
    expect(instruction).not.toContain("部分读取，不要当成读完了全文");
    // The sentence that makes the file's contents data rather than instruction is
    // written exactly once — it is not appended beside the budget as well as
    // inside it.
    expect(instruction.split(UNTRUSTED_DOCUMENT_NOTE).length - 1).toBe(1);
  }, 60_000);
});

async function waitFor(predicate: () => Promise<boolean>, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }
}
