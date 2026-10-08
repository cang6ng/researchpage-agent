/**
 * PDF/DOCX conversion, over the product's real surface.
 *
 * The real acceptance for this feature is a real conversion through the
 * official `mineru-open-mcp` (see `conversion-smoke.test.ts`). This file is the
 * other half: everything that has to be true *around* the conversion, and
 * everything that has to happen when the converter says no.
 *
 * The MCP peer here is a scripted server speaking the same protocol
 * (`helpers/fake-mineru-mcp.mjs`), so what is exercised is the real adapter, the
 * real job lifecycle, the real routes, the real runner and the real document
 * library — with the converter's answers chosen by the test instead of by
 * mineru.net. A page-limit refusal, a truncated answer or a dead network cannot
 * be ordered from a working service, and they are exactly the cases the
 * integration has to get right.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ModelClient, ModelEvent, ModelRequest, RuntimeContext } from "@every-dagent/agent-core";
import { DEFAULT_MODEL_FRAMING } from "@every-dagent/agent-core";
import { createResearchToolSet } from "@every-dagent/plugin-research";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { startResearchApp, type ResearchApp } from "../src/server/composition.js";
import { testComposition } from "../../../tests/helpers/test-composition.js";

const here = dirname(fileURLToPath(import.meta.url));
const fakeServer = join(here, "helpers", "fake-mineru-mcp.mjs");
const samplePdf = join(here, "fixtures", "conversion", "conversion-sample.pdf");
const workRoot = join(tmpdir(), `researchpage-conversion-${Date.now().toString(36)}`);
const dataDir = join(workRoot, "data");
const staticRoot = join(process.cwd(), "apps", "research", "public");
const recoverFile = join(workRoot, "recover.marker");

const CONSENT = "third_party_upload";

/** A model that never runs: none of these cases starts a research stage. */
function idleModel(): ModelClient {
  return {
    limits: { contextWindow: 128 * 1024, maxOutputTokens: 8 * 1024, framing: DEFAULT_MODEL_FRAMING },
    stream(_request: ModelRequest, _context: RuntimeContext): AsyncIterable<ModelEvent> {
      return (async function* () {
        yield { type: "text-delta", text: "（这次测试没有模型参与。）" } as ModelEvent;
        yield { type: "done" } as ModelEvent;
      })();
    },
  };
}

/** One app per converter script, each with its own database under `dataDir`. */
async function appWithMode(mode: string, options: { readonly command?: string | null } = {}): Promise<ResearchApp> {
  const label = options.command === undefined ? "default" : options.command === null ? "no-command" : "custom-command";
  return startResearchApp({
    dataDir: join(dataDir, mode, label),
    staticRoot,
    composition: testComposition({ modelClient: idleModel() }),
    overrides: {
      search: () => Promise.reject(new Error("this test never searches")),
      read: () => Promise.reject(new Error("this test never reads the network")),
    },
    mineru:
      options.command === null
        ? { command: null }
        : {
            command: process.execPath,
            args: [fakeServer, `--mode=${mode}`, `--recover-file=${recoverFile}`],
            packageSpec: "mineru-open-mcp==1.0.22-test",
          },
    log: () => undefined,
  });
}

interface Response {
  readonly status: number;
  readonly json: Record<string, unknown>;
}

async function request(app: ResearchApp, method: string, path: string, body?: unknown): Promise<Response> {
  const response = await fetch(`${app.pageOrigin}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": typeof body === "string" ? "application/octet-stream" : "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, json: text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

function post(app: ResearchApp, path: string, body?: unknown): Promise<Response> {
  return request(app, "POST", path, body);
}

function get(app: ResearchApp, path: string): Promise<Response> {
  return request(app, "GET", path);
}

/** One upload of `bytes` as `filename`, with the metadata in the query string. */
function convert(
  app: ResearchApp,
  query: { readonly sessionId?: string; readonly intentId?: string; readonly filename?: string; readonly usage?: string; readonly consent?: string | null },
  bytes: Uint8Array,
): Promise<Response> {
  const search = new URLSearchParams();
  if (query.sessionId !== undefined) search.set("sessionId", query.sessionId);
  if (query.intentId !== undefined) search.set("intentId", query.intentId);
  if (query.filename !== undefined) search.set("filename", query.filename);
  if (query.usage !== undefined) search.set("usage", query.usage);
  if (query.consent !== null) search.set("consent", query.consent ?? CONSENT);
  const response = fetch(`${app.pageOrigin}/api/research/documents/convert?${search.toString()}`, {
    method: "POST",
    headers: { "content-type": "application/pdf" },
    body: Buffer.from(bytes),
  });
  return response.then(async (result) => {
    const text = await result.text();
    return { status: result.status, json: text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>) };
  });
}

function jobOf(response: Response): Record<string, unknown> {
  const job = response.json["job"];
  expect(job, JSON.stringify(response.json)).toBeDefined();
  return job as Record<string, unknown>;
}

async function waitForJob(app: ResearchApp, sessionId: string, jobId: string, timeoutMs = 60_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> = {};
  for (;;) {
    const response = await get(app, `/api/research/documents/convert/${jobId}?sessionId=${encodeURIComponent(sessionId)}`);
    expect(response.status, JSON.stringify(response.json)).toBe(200);
    last = jobOf(response);
    if (last["status"] === "succeeded" || last["status"] === "failed") return last;
    if (Date.now() > deadline) throw new Error(`job ${jobId} did not settle: ${JSON.stringify(last)}`);
    await new Promise((done) => setTimeout(done, 150));
  }
}

async function newSession(app: ResearchApp, seedTopic: string): Promise<string> {
  const created = await post(app, "/api/research/intents", { seedTopic });
  expect(created.status, JSON.stringify(created.json)).toBe(202);
  return created.json["sessionId"] as string;
}

/** The app the happy-path cases share, so one conversion serves several checks. */
let app: ResearchApp;
let sessionId = "";
const pdfBytes = new Uint8Array(readFileSync(samplePdf));

beforeAll(async () => {
  mkdirSync(dataDir, { recursive: true });
  app = await appWithMode("success");
  sessionId = await newSession(app, "把上传的 PDF 转成 Markdown");
}, 60_000);

afterEach(() => {
  if (existsSync(recoverFile)) rmSync(recoverFile, { force: true });
});

afterAll(async () => {
  await app.close();
  rmSync(workRoot, { recursive: true, force: true });
});

describe("the conversion entry", () => {
  it("refuses to upload anything without the user's own consent", async () => {
    // The command is a program that does not exist: if consent were checked
    // after the converter was started, this case would report a start failure
    // instead of the consent refusal.
    const guarded = await appWithMode("success", { command: "definitely-not-a-real-program-xyz" });
    try {
      const created = await newSession(guarded, "下载一份文件");
      const missing = await convert(guarded, { sessionId: created, filename: "paper.pdf", consent: null }, pdfBytes);
      expect(missing.status).toBe(400);
      expect(missing.json["code"]).toBe("consent_required");
      expect(String(missing.json["error"])).toContain("MinerU");

      const wrong = await convert(guarded, { sessionId: created, filename: "paper.pdf", consent: "sure" }, pdfBytes);
      expect(wrong.status).toBe(400);
      expect(wrong.json["code"]).toBe("consent_required");
    } finally {
      await guarded.close();
    }
  }, 60_000);

  it("refuses a format it does not convert, and a file that is not what its name says", async () => {
    const text = await convert(app, { sessionId, filename: "notes.txt" }, new TextEncoder().encode("hello"));
    expect(text.status).toBe(415);
    expect(text.json["code"]).toBe("unsupported_format");

    const html = await convert(app, { sessionId, filename: "page.html" }, new TextEncoder().encode("<html></html>"));
    expect(html.status).toBe(415);

    // A renamed ZIP is not a PDF, and a renamed PDF is not a DOCX: the bytes
    // decide, not the extension.
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]);
    const renamed = await convert(app, { sessionId, filename: "paper.pdf" }, zip);
    expect(renamed.status).toBe(400);
    expect(renamed.json["code"]).toBe("file_invalid");

    const pdfAsDocx = await convert(app, { sessionId, filename: "paper.docx" }, pdfBytes);
    expect(pdfAsDocx.status).toBe(400);
    expect(pdfAsDocx.json["code"]).toBe("file_invalid");

    const traversing = await convert(app, { sessionId, filename: "../etc/passwd.pdf" }, pdfBytes);
    expect(traversing.status).toBe(400);
    expect(traversing.json["code"]).toBe("file_invalid");
    expect(String(traversing.json["error"])).toContain("路径");
  }, 60_000);

  it("refuses a file over Flash mode's limit before it is written anywhere", async () => {
    const oversized = new Uint8Array(10 * 1024 * 1024 + 1024);
    oversized.set(new TextEncoder().encode("%PDF-1.7"), 0);
    const response = await convert(app, { sessionId, filename: "big.pdf" }, oversized);
    expect(response.status).toBe(413);
    expect(response.json["code"]).toBe("conversion_file_too_large");
  }, 120_000);

  it("needs a session, and refuses two scopes that disagree", async () => {
    const anonymous = await convert(app, { filename: "paper.pdf" }, pdfBytes);
    expect(anonymous.status).toBe(400);
    expect(anonymous.json["code"]).toBe("document_scope_missing");

    // One session in the query, an exploration of another session beside it.
    const other = await newSession(app, "另一个会话的主题");
    const intent = (await get(app, `/api/research/sessions/${encodeURIComponent(other)}/intent`)).json["intent"] as { intentId: string };
    const conflict = await convert(app, { sessionId, intentId: intent.intentId, filename: "paper.pdf" }, pdfBytes);
    expect(conflict.status).toBe(403);
    expect(conflict.json["code"]).toBe("document_scope_conflict");
  }, 60_000);

  it("binds a conversion to the exploration that asked for it", async () => {
    // Scenario A: a file uploaded before there is a task is part of the
    // conversation that is still deciding what the task is.
    const exploring = await newSession(app, "先上传一份 PDF，再决定方向");
    const intent = (await get(app, `/api/research/sessions/${encodeURIComponent(exploring)}/intent`)).json["intent"] as { intentId: string };
    const created = await convert(app, { intentId: intent.intentId, filename: "before-task.pdf", usage: "intent_context" }, pdfBytes);
    expect(created.status, JSON.stringify(created.json)).toBe(202);
    const settled = await waitForJob(app, exploring, jobOf(created)["jobId"] as string);
    expect(settled["status"], JSON.stringify(settled)).toBe("succeeded");
    expect(settled["sessionId"]).toBe(exploring);

    const after = (await get(app, `/api/research/sessions/${encodeURIComponent(exploring)}/intent`)).json["intent"] as {
      documents: readonly { documentId: string; origin: string; conversion?: Record<string, unknown> }[];
    };
    const documentId = (settled["document"] as Record<string, unknown>)["documentId"] as string;
    const attached = after.documents.find((entry) => entry.documentId === documentId);
    expect(attached, JSON.stringify(after.documents)).toBeDefined();
    expect(attached?.origin).toBe("converted");
    expect(attached?.conversion?.["trust"]).toBe("server_verified");
  }, 120_000);
});

describe("a conversion that works", () => {
  let jobId = "";
  let documentId = "";

  it("queues the job and converts the real file through the MCP server", async () => {
    const created = await convert(app, { sessionId, filename: "conversion-sample.pdf", usage: "research_source" }, pdfBytes);
    expect(created.status, JSON.stringify(created.json)).toBe(202);
    const job = jobOf(created);
    jobId = job["jobId"] as string;
    // The queue is a queue, not a delay: with nothing else running, the job is
    // already being converted by the time the caller is answered.
    expect(["queued", "converting"]).toContain(job["status"]);
    expect(job["format"]).toBe("pdf");
    expect(job["sizeBytes"]).toBe(pdfBytes.byteLength);
    expect(job["sha256"]).toBe(createHash("sha256").update(Buffer.from(pdfBytes)).digest("hex"));
    expect(job["usage"]).toEqual(["research_source"]);
    // The limits travel with the job, so the workspace never has to guess them.
    expect((job["limits"] as Record<string, unknown>)["maxBytes"]).toBe(10 * 1024 * 1024);
    expect((job["limits"] as Record<string, unknown>)["maxPages"]).toBe(20);
    expect((job["limits"] as Record<string, unknown>)["mode"]).toBe("flash");

    const settled = await waitForJob(app, sessionId, jobId);
    expect(settled["status"], JSON.stringify(settled)).toBe("succeeded");
    expect(settled["attempts"]).toBe(1);

    const call = settled["toolCall"] as Record<string, unknown>;
    expect(call["tool"]).toBe("parse_documents");
    expect(call["status"]).toBe("success");
    expect(call["fromFile"]).toBe(false);
    // What the peer said about itself is not part of the record a client reads.
    expect(Object.keys(call).sort()).toEqual(["contentChars", "durationMs", "fromFile", "inlineTruncated", "status", "tool"]);

    const conversion = settled["conversion"] as Record<string, unknown>;
    expect(conversion["trust"]).toBe("server_verified");
    expect(conversion["provider"]).toBe("mineru");
    expect(conversion["pageMap"]).toBeNull();
    expect(Number.isNaN(Date.parse(conversion["convertedAt"] as string))).toBe(false);
    expect(String(conversion["sourceRef"])).toContain("parse_documents");

    const document = settled["document"] as Record<string, unknown>;
    documentId = document["documentId"] as string;
    expect(document["filename"]).toBe("conversion-sample.md");
    expect(document["duplicate"]).toBe(false);
  }, 120_000);

  it("hands the converter a server-side path inside its own work directory", async () => {
    const content = await fetch(`${app.pageOrigin}/api/research/documents/${documentId}/content?sessionId=${encodeURIComponent(sessionId)}`);
    const text = await content.text();
    // The converter echoes the file it was handed and the output directory it
    // was told to use. Both have to be this server's own paths — the source
    // under the data directory, the output inside the job's work directory —
    // never anything a client supplied.
    const marker = /fake-mineru source=(.+) output_dir=(.+) -->/.exec(text);
    expect(marker, text.slice(-300)).not.toBeNull();
    const source = resolve(String(marker?.[1]).trim());
    const outputDir = resolve(String(marker?.[2]).trim());
    expect(source.startsWith(resolve(dataDir))).toBe(true);
    expect(outputDir.startsWith(resolve(dataDir))).toBe(true);
    expect(source.endsWith(`conversions\\${jobId}\\source.pdf`) || source.endsWith(`conversions/${jobId}/source.pdf`)).toBe(true);
    expect(source).toBe(join(outputDir, "source.pdf"));
  }, 60_000);

  it("stores the Markdown in the same library, with server_verified provenance", async () => {
    const listed = await get(app, `/api/research/documents?sessionId=${encodeURIComponent(sessionId)}`);
    expect(listed.status).toBe(200);
    const documents = listed.json["documents"] as readonly Record<string, unknown>[];
    const found = documents.find((entry) => entry["documentId"] === documentId);
    expect(found, JSON.stringify(documents)).toBeDefined();
    expect(found?.["origin"]).toBe("converted");
    expect(found?.["conversionProvider"]).toBe("mineru");
    expect((found?.["conversion"] as Record<string, unknown>)["trust"]).toBe("server_verified");
    expect(found?.["usage"]).toEqual(["research_source"]);

    const content = await fetch(`${app.pageOrigin}/api/research/documents/${documentId}/content?sessionId=${encodeURIComponent(sessionId)}`);
    expect(await content.text()).toContain("转换得到的 Markdown");
  }, 60_000);

  it("is readable with no page number rather than a guessed one", async () => {
    const read = await post(app, `/api/research/documents/${documentId}/read?sessionId=${encodeURIComponent(sessionId)}`, { maxChars: 600 });
    expect(read.status, JSON.stringify(read.json)).toBe(200);
    const fragments = read.json["fragments"] as readonly Record<string, unknown>[];
    expect(fragments.length).toBeGreaterThan(0);
    for (const fragment of fragments) expect(fragment["page"]).toBeNull();
  }, 60_000);

  it("removes the work directory once the Markdown is in the library", async () => {
    const workDir = join(dataDir, "success", "default", "conversions", jobId);
    expect(existsSync(workDir)).toBe(false);
  }, 30_000);

  it("refuses the job to another session, and refuses nothing to its own", async () => {
    const stranger = await newSession(app, "别人的会话");
    const denied = await get(app, `/api/research/documents/convert/${jobId}?sessionId=${encodeURIComponent(stranger)}`);
    expect(denied.status).toBe(403);
    expect(denied.json["code"]).toBe("job_cross_session");

    const anonymous = await get(app, `/api/research/documents/convert/${jobId}`);
    expect(anonymous.status).toBe(400);
    expect(anonymous.json["code"]).toBe("document_scope_missing");

    const unknown = await get(app, `/api/research/documents/convert/conv_nope?sessionId=${encodeURIComponent(sessionId)}`);
    expect(unknown.status).toBe(404);
    expect(unknown.json["code"]).toBe("job_not_found");

    const own = await get(app, `/api/research/documents/convert/${jobId}?sessionId=${encodeURIComponent(sessionId)}`);
    expect(own.status).toBe(200);
  }, 60_000);

  it("answers what the converter really is, before anything is converted", async () => {
    const ready = await get(app, "/api/research/mineru");
    expect(ready.status, JSON.stringify(ready.json)).toBe(200);
    const mineru = ready.json["mineru"] as Record<string, unknown>;
    expect(mineru["parseDocuments"]).toBe(true);
    // `parseDocuments` is the answer, and it was computed from a real
    // `tools/list` — but the list itself is the peer's own strings, so it is
    // not republished here.
    expect(Object.keys(mineru).sort()).toEqual(["command", "durationMs", "mode", "package", "parseDocuments", "transport"]);
    expect(mineru["transport"]).toBe("stdio");
    expect(mineru["mode"]).toBe("flash");
    const limits = ready.json["limits"] as Record<string, unknown>;
    expect(limits["online"]).toBe(true);
    expect(String(limits["dataHandling"])).toContain("mineru.net");
    expect(limits["formats"]).toEqual(["pdf", "docx"]);
  }, 120_000);
});

describe("what the converter's refusals look like", () => {
  it("runs one conversion at a time, and says so while a job waits", async () => {
    const slow = await startResearchApp({
      dataDir: join(dataDir, "slow"),
      staticRoot,
      composition: testComposition({ modelClient: idleModel() }),
      overrides: {
        search: () => Promise.reject(new Error("this test never searches")),
        read: () => Promise.reject(new Error("this test never reads the network")),
      },
      mineru: {
        command: process.execPath,
        args: [fakeServer, "--mode=success", "--delay-ms=1500"],
        packageSpec: "mineru-open-mcp==1.0.22-test",
      },
      log: () => undefined,
    });
    try {
      const session = await newSession(slow, "两次上传");
      const first = await convert(slow, { sessionId: session, filename: "first.pdf" }, pdfBytes);
      const second = await convert(slow, { sessionId: session, filename: "second.pdf" }, pdfBytes);
      const secondJob = jobOf(second);
      // The second upload is accepted and waits its turn instead of being
      // refused or run beside the first.
      expect(secondJob["status"]).toBe("queued");
      expect((await waitForJob(slow, session, jobOf(first)["jobId"] as string, 60_000))["status"]).toBe("succeeded");
      expect((await waitForJob(slow, session, secondJob["jobId"] as string, 60_000))["status"]).toBe("succeeded");
    } finally {
      await slow.close();
    }
  }, 180_000);

  it("reads the reason out of the tool's own words, and stops guessing when there are none", async () => {
    const failing = await appWithMode("error");
    try {
      const session = await newSession(failing, "转换一份超页数的文件");
      const created = await convert(failing, { sessionId: session, filename: "many-pages.pdf" }, pdfBytes);
      const jobId = jobOf(created)["jobId"] as string;
      const settled = await waitForJob(failing, session, jobId);
      expect(settled["status"]).toBe("failed");
      const failure = settled["failure"] as Record<string, unknown>;
      expect(failure["code"]).toBe("flash_page_limit");
      expect(String(failure["problem"])).toContain("20 页");
      expect(settled["retryable"]).toBe(true);
      expect((await get(failing, `/api/research/documents?sessionId=${encodeURIComponent(session)}`)).json["documents"]).toEqual([]);
    } finally {
      await failing.close();
    }

    // A refusal nobody can explain is reported as one: the same answer shape
    // with no recognisable reason must not be labelled with a cause.
    const opaque = await appWithMode("opaque");
    try {
      const session = await newSession(opaque, "转换失败但没有原因");
      const created = await convert(opaque, { sessionId: session, filename: "paper.pdf" }, pdfBytes);
      const settled = await waitForJob(opaque, session, jobOf(created)["jobId"] as string);
      expect(settled["status"]).toBe("failed");
      expect((settled["failure"] as Record<string, unknown>)["code"]).toBe("conversion_failed");
      // The general sentence, and not a word of the converter's own message —
      // its「Check server logs for details.」stays on the server.
      expect((settled["failure"] as Record<string, unknown>)["problem"]).toBe("文档转换失败，请检查文件或稍后重试。");
      expect(JSON.stringify(settled)).not.toContain("Check server logs");
    } finally {
      await opaque.close();
    }
  }, 240_000);

  it("tells a rate limit from a dead network from an unknown failure", async () => {
    for (const [mode, code] of [
      ["rate-limit", "flash_rate_limited"],
      ["network", "network_unavailable"],
    ] as const) {
      const failing = await appWithMode(mode);
      try {
        const session = await newSession(failing, `转换（${mode}）`);
        const created = await convert(failing, { sessionId: session, filename: "paper.pdf" }, pdfBytes);
        const settled = await waitForJob(failing, session, jobOf(created)["jobId"] as string);
        expect(settled["status"], JSON.stringify(settled)).toBe("failed");
        expect((settled["failure"] as Record<string, unknown>)["code"]).toBe(code);
      } finally {
        await failing.close();
      }
    }
  }, 180_000);

  it("never presents an empty Markdown as a converted document", async () => {
    const failing = await appWithMode("empty");
    try {
      const session = await newSession(failing, "转换一份空结果");
      const created = await convert(failing, { sessionId: session, filename: "blank.pdf" }, pdfBytes);
      const settled = await waitForJob(failing, session, jobOf(created)["jobId"] as string);
      expect(settled["status"]).toBe("failed");
      expect((settled["failure"] as Record<string, unknown>)["code"]).toBe("markdown_empty");
    } finally {
      await failing.close();
    }
  }, 120_000);

  it("fails a conversion whose Markdown would break the library's own limit", async () => {
    const failing = await appWithMode("huge");
    try {
      const session = await newSession(failing, "转换一份过大的结果");
      const created = await convert(failing, { sessionId: session, filename: "huge.pdf" }, pdfBytes);
      const settled = await waitForJob(failing, session, jobOf(created)["jobId"] as string);
      expect(settled["status"]).toBe("failed");
      expect((settled["failure"] as Record<string, unknown>)["code"]).toBe("document_too_large");
      // 512 KiB is still the rule: nothing truncated was stored in its place.
      expect((await get(failing, `/api/research/documents?sessionId=${encodeURIComponent(session)}`)).json["documents"]).toEqual([]);
    } finally {
      await failing.close();
    }
  }, 120_000);

  it("reads the full Markdown from the server's saved file, and only from inside its work directory", async () => {
    const truncated = await appWithMode("truncated");
    try {
      const session = await newSession(truncated, "转换一份被截断的结果");
      const created = await convert(truncated, { sessionId: session, filename: "long.pdf" }, pdfBytes);
      const jobId = jobOf(created)["jobId"] as string;
      const settled = await waitForJob(truncated, session, jobId);
      expect(settled["status"], JSON.stringify(settled)).toBe("succeeded");
      expect((settled["toolCall"] as Record<string, unknown>)["fromFile"]).toBe(true);
      expect((settled["toolCall"] as Record<string, unknown>)["inlineTruncated"]).toBe(true);
      const documentId = (settled["document"] as Record<string, unknown>)["documentId"] as string;
      const content = await fetch(`${truncated.pageOrigin}/api/research/documents/${documentId}/content?sessionId=${encodeURIComponent(session)}`);
      const markdown = await content.text();
      expect(markdown).toContain("<!-- full -->");
      expect(existsSync(join(dataDir, "truncated", "default", "conversions", jobId))).toBe(false);
    } finally {
      await truncated.close();
    }
  }, 120_000);

  it("refuses a result file the converter points at outside its work directory", async () => {
    const traversing = await appWithMode("traverse");
    try {
      const session = await newSession(traversing, "转换一份越界的结果");
      const created = await convert(traversing, { sessionId: session, filename: "escape.pdf" }, pdfBytes);
      const settled = await waitForJob(traversing, session, jobOf(created)["jobId"] as string);
      expect(settled["status"]).toBe("failed");
      expect((settled["failure"] as Record<string, unknown>)["code"]).toBe("output_outside_workdir");
    } finally {
      await traversing.close();
    }
  }, 120_000);

  it("reports a converter that is not installed, one that has no such tool, and one that never starts", async () => {
    const missing = await appWithMode("success", { command: null });
    try {
      const session = await newSession(missing, "没有 uvx 的机器");
      const readiness = await get(missing, "/api/research/mineru");
      expect(readiness.status).toBe(503);
      expect(String(readiness.json["problem"])).toContain("uvx");
      const created = await convert(missing, { sessionId: session, filename: "paper.pdf" }, pdfBytes);
      const settled = await waitForJob(missing, session, jobOf(created)["jobId"] as string);
      expect(settled["status"]).toBe("failed");
      expect((settled["failure"] as Record<string, unknown>)["code"]).toBe("mcp_not_installed");
    } finally {
      await missing.close();
    }

    const noTool = await appWithMode("no-tool");
    try {
      const session = await newSession(noTool, "服务没有 parse_documents");
      const readiness = await get(noTool, "/api/research/mineru");
      expect(readiness.status).toBe(503);
      // The sentence names the tool this product needs, never the ones the
      // converter offered instead — those are the peer's own strings.
      expect(readiness.json["problem"]).toBe("MinerU MCP 未提供所需的文档解析工具。");
      const created = await convert(noTool, { sessionId: session, filename: "paper.pdf" }, pdfBytes);
      const settled = await waitForJob(noTool, session, jobOf(created)["jobId"] as string);
      expect(settled["status"]).toBe("failed");
      expect((settled["failure"] as Record<string, unknown>)["code"]).toBe("mcp_tools_missing");
      expect((settled["failure"] as Record<string, unknown>)["problem"]).toBe("MinerU MCP 未提供所需的文档解析工具。");
    } finally {
      await noTool.close();
    }

    // A converter that dies before the handshake is a start failure. Its own
    // dying words — and the MCP client's message about the closed connection —
    // stay on the server: the client hears which failure it was, in this
    // server's own words.
    const crashing = await appWithMode("crash");
    try {
      const session = await newSession(crashing, "起不来的服务");
      const created = await convert(crashing, { sessionId: session, filename: "paper.pdf" }, pdfBytes);
      const settled = await waitForJob(crashing, session, jobOf(created)["jobId"] as string);
      expect(settled["status"]).toBe("failed");
      expect((settled["failure"] as Record<string, unknown>)["code"]).toBe("mcp_handshake_failed");
      expect((settled["failure"] as Record<string, unknown>)["problem"]).toBe("MinerU 服务启动或连接失败。");
      expect(JSON.stringify(settled)).not.toContain("Connection closed");
    } finally {
      await crashing.close();
    }
  }, 240_000);

  it("calls a converter that never answers a timeout, not a broken connection", async () => {
    const slow = await startResearchApp({
      dataDir: join(dataDir, "timeout"),
      staticRoot,
      composition: testComposition({ modelClient: idleModel() }),
      overrides: {
        search: () => Promise.reject(new Error("this test never searches")),
        read: () => Promise.reject(new Error("this test never reads the network")),
      },
      mineru: {
        command: process.execPath,
        args: [fakeServer, "--mode=success", "--delay-ms=60000"],
        packageSpec: "mineru-open-mcp==1.0.22-test",
        callTimeoutMs: 12_000,
      },
      log: () => undefined,
    });
    try {
      const session = await newSession(slow, "一个不回答的转换器");
      const created = await convert(slow, { sessionId: session, filename: "paper.pdf" }, pdfBytes);
      const settled = await waitForJob(slow, session, jobOf(created)["jobId"] as string, 120_000);
      expect(settled["status"]).toBe("failed");
      const failure = settled["failure"] as Record<string, unknown>;
      expect(failure["code"], JSON.stringify(failure)).toBe("conversion_timeout");
      expect(String(failure["problem"])).toBe("文档转换超时，可以重试。");
      // The converter's own answer — it was still holding the call when the
      // deadline passed — is not what the client is told.
      expect(JSON.stringify(settled)).not.toContain("Connection closed");
      expect(settled["retryable"]).toBe(true);
      // And nothing of the conversion was kept: no document, no output files.
      expect((await get(slow, `/api/research/documents?sessionId=${encodeURIComponent(session)}`)).json["documents"]).toEqual([]);
    } finally {
      await slow.close();
    }
  }, 300_000);

  it("stops after the attempt limit, and a retry that can succeed does", async () => {
    const flaky = await appWithMode("flaky");
    try {
      const session = await newSession(flaky, "先失败后成功的转换");
      const created = await convert(flaky, { sessionId: session, filename: "paper.pdf" }, pdfBytes);
      const jobId = jobOf(created)["jobId"] as string;
      const failed = await waitForJob(flaky, session, jobId);
      expect(failed["status"]).toBe("failed");
      expect(failed["retryable"]).toBe(true);

      // The first retry succeeds because the converter changed its mind — which
      // is what a rate limit or a transient network failure looks like.
      writeFileSync(recoverFile, "recovered", "utf8");
      const retried = await post(flaky, `/api/research/documents/convert/${jobId}/retry?sessionId=${encodeURIComponent(session)}`, {});
      expect(retried.status, JSON.stringify(retried.json)).toBe(202);
      const settled = await waitForJob(flaky, session, jobId);
      expect(settled["status"], JSON.stringify(settled)).toBe("succeeded");
      expect(settled["attempts"]).toBe(2);
      expect((settled["document"] as Record<string, unknown>)["documentId"]).toBeDefined();
      const second = await post(flaky, `/api/research/documents/convert/${jobId}/retry?sessionId=${encodeURIComponent(session)}`, {});
      expect(second.status).toBe(409);
      expect(second.json["code"]).toBe("job_not_retryable");
    } finally {
      await flaky.close();
    }
  }, 180_000);

  it("refuses a retry from another session and one with no session at all", async () => {
    const flaky = await appWithMode("flaky");
    try {
      const session = await newSession(flaky, "重试的会话检查");
      const created = await convert(flaky, { sessionId: session, filename: "paper.pdf" }, pdfBytes);
      const jobId = jobOf(created)["jobId"] as string;
      await waitForJob(flaky, session, jobId);
      const stranger = await newSession(flaky, "别人的会话");
      const denied = await post(flaky, `/api/research/documents/convert/${jobId}/retry?sessionId=${encodeURIComponent(stranger)}`, {});
      expect(denied.status).toBe(403);
      expect(denied.json["code"]).toBe("job_cross_session");
      const anonymous = await post(flaky, `/api/research/documents/convert/${jobId}/retry`, {});
      expect(anonymous.status).toBe(400);
      expect(anonymous.json["code"]).toBe("document_scope_missing");
    } finally {
      await flaky.close();
    }
  }, 180_000);
});

describe("a converted document behaves like any other document", () => {
  it("becomes a source with the user's own identity, and a snapshot with the converted text", async () => {
    // A session of its own, created the way the product creates one, so this
    // case does not depend on the exploration another case left open.
    const bare = (await app.client.sessions.create()).session.sessionId;
    const created = await convert(app, { sessionId: bare, filename: "for-source.pdf", usage: "research_source" }, pdfBytes);
    const settled = await waitForJob(app, bare, jobOf(created)["jobId"] as string);
    expect(settled["status"], JSON.stringify(settled)).toBe("succeeded");
    const documentId = (settled["document"] as Record<string, unknown>)["documentId"] as string;

    // A real task in the same session, made through the service this product
    // ships (the card and its confirmation are not what this case is about).
    app.service.issueGrant({ sessionId: bare, intent: "card", taskId: null });
    const card = app.service.proposeTask(bare, {
      topic: "转换后的文档能不能作为研究材料",
      purpose: "验证转换链路",
      audience: "工程团队",
      focus: ["转换"],
      exclusions: "",
      lengthTarget: "约 4 页",
      subjects: [{ name: "MinerU" }, { name: "文档库" }],
      dimensions: [
        { name: "机制", question: "转换如何工作？" },
        { name: "限制", question: "有什么限制？" },
        { name: "成本", question: "成本如何？" },
      ],
    });
    if (card.ok !== true) throw new Error(`card refused: ${JSON.stringify(card)}`);
    app.service.clearGrant(bare);
    app.service.confirmTask(card.task.id);

    const promoted = await post(app, `/api/research/documents/${documentId}/source?sessionId=${encodeURIComponent(bare)}`, { taskId: card.task.id });
    expect(promoted.status, JSON.stringify(promoted.json)).toBe(201);
    expect((promoted.json["source"] as Record<string, unknown>)["role"]).toBe("user-provided");

    const sourceId = ((promoted.json["source"] as Record<string, unknown>)["sourceId"] ?? "") as string;
    // Reading is a granted action, as it is for every source in this product.
    app.service.issueGrant({ sessionId: bare, intent: "research", taskId: card.task.id });
    const outcome = await app.service.read(card.task.id, { sourceId, question: "转换后的文档说了什么？", maxEvidence: 4 });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (outcome.ok !== true) return;
    // The snapshot is the converted Markdown itself, and every excerpt the read
    // produced is a substring of it — the same contract network sources have.
    const snapshotId = app.service.sourcesOf(card.task.id).find((source) => source.id === sourceId)?.snapshotId ?? "";
    const snapshot = app.service.snapshotTextOf(snapshotId) ?? "";
    // The snapshot's body is the converted Markdown's own prose, and every
    // excerpt the read produced is a substring of it — the same contract a
    // network source has.
    expect(snapshot).toContain("这份内容来自一个受控的测试 MCP 服务");
    expect(outcome.evidence.length).toBeGreaterThan(0);
    for (const item of outcome.evidence) {
      expect(snapshot).toContain(item.excerpt);
    }
    expect(app.service.evidenceOf(card.task.id).length).toBeGreaterThan(0);
    expect(app.service.sourcesOf(card.task.id).find((source) => source.id === sourceId)?.role).toBe("user-provided");
  }, 180_000);

  it("is read by the agent's own read_document tool, under the library's bounded budget", async () => {
    const created = await convert(app, { sessionId, filename: "readable.pdf" }, pdfBytes);
    const settled = await waitForJob(app, sessionId, jobOf(created)["jobId"] as string);
    expect(settled["status"], JSON.stringify(settled)).toBe("succeeded");
    const documentId = (settled["document"] as Record<string, unknown>)["documentId"] as string;

    // The tool the model calls, with its own implementation and its own
    // untrusted-data sentence — called directly so the assertion is about what
    // the tool returns rather than about what a model did with it.
    const tool = createResearchToolSet(app.service).byName["read_document"];
    expect(tool).toBeDefined();
    // A tool answers the model with JSON text; this is that text, parsed.
    const raw = await tool!.execute(
      { documentId, question: "第一节说了什么？", maxChars: 400 },
      { sessionId, signal: AbortSignal.timeout(20_000) },
    );
    const value = JSON.parse(String(raw)) as Record<string, unknown>;
    expect(value["ok"], JSON.stringify(value)).toBe(true);
    expect(String(value["untrusted"])).toContain("不可信");
    expect(Number(value["chars"] ?? value["readChars"])).toBeLessThanOrEqual(400);
    const fragments = value["fragments"] as readonly Record<string, unknown>[];
    expect(fragments.length).toBeGreaterThan(0);
    expect(JSON.stringify(fragments)).toContain("转换得到的 Markdown");
    for (const fragment of fragments) expect(fragment["page"]).toBeNull();

    // And the tool refuses a document belonging to another session, exactly as
    // the library does: a converted file is not exempt from the scope rule.
    const stranger = await newSession(app, "只读别人的文档");
    const denied = JSON.parse(
      String(await tool!.execute({ documentId, question: "读一下" }, { sessionId: stranger, signal: AbortSignal.timeout(20_000) })),
    ) as Record<string, unknown>;
    expect(denied["ok"]).toBe(false);
    expect(JSON.stringify(denied)).toContain("不属于这个会话");
  }, 120_000);
});
