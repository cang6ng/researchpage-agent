/**
 * The real thing: a real PDF and a real DOCX, converted by the official
 * `mineru-open-mcp` through mineru.net, landing in this product's document
 * library.
 *
 * It runs only when asked (`RESEARCHPAGE_REAL_MINERU=1`) because it uploads
 * files to a third-party service and takes minutes. What it asserts is what a
 * demo would be caught lying about: that the converter the product claims to
 * have used really answered, that the Markdown in the library really came from
 * these files, that the provenance says `server_verified` because this server
 * performed the conversion, and that the converted document is then readable,
 * promotable to a source and snapshot-backed like any other document.
 *
 * The offline suite (`conversion-api.test.ts`) covers the failures with a
 * scripted MCP peer; this one is deliberately narrow, and it prints the numbers
 * it measured so the round's report does not have to guess them.
 *
 *   RESEARCHPAGE_REAL_MINERU=1 pnpm vitest run tests/conversion-smoke.test.ts
 *   RESEARCHPAGE_SMOKE_PAGE_LIMIT=1 …   # also convert a 25-page PDF (Flash's limit is 20)
 *   RESEARCHPAGE_SMOKE_EXTRA_PDF=<path> …  # also convert one real-world PDF of your own
 *   RESEARCHPAGE_SMOKE_SCANNED_PDF=<path> RESEARCHPAGE_SMOKE_EXPECT_TEXT="A|B" …
 *                                        # also convert an image-only PDF and check the
 *                                        # recognised text (the OCR case)
 */

import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ModelClient, ModelEvent, ModelRequest, RuntimeContext } from "@every-dagent/agent-core";
import { DEFAULT_MODEL_FRAMING } from "@every-dagent/agent-core";
import { createResearchToolSet } from "@every-dagent/plugin-research";
import { afterAll, describe, expect, it } from "vitest";

import { startResearchApp, type ResearchApp } from "../src/server/composition.js";
import { testComposition } from "../../../tests/helpers/test-composition.js";

const here = dirname(fileURLToPath(import.meta.url));
const samplePdf = join(here, "fixtures", "conversion", "conversion-sample.pdf");
const sampleDocx = join(here, "fixtures", "conversion", "conversion-sample.docx");
const staticRoot = join(process.cwd(), "apps", "research", "public");

const enabled = process.env["RESEARCHPAGE_REAL_MINERU"] === "1";
const workDir = enabled ? mkdtempSync(join(tmpdir(), "researchpage-mineru-smoke-")) : "";
const extraPdf = process.env["RESEARCHPAGE_SMOKE_EXTRA_PDF"];

const CONSENT = "third_party_upload";

/** A model that never runs: this suite converts files, it does not research. */
function idleModel(): ModelClient {
  return {
    limits: { contextWindow: 128 * 1024, maxOutputTokens: 8 * 1024, framing: DEFAULT_MODEL_FRAMING },
    stream(_request: ModelRequest, _context: RuntimeContext): AsyncIterable<ModelEvent> {
      return (async function* () {
        yield { type: "text-delta", text: "（这次验收没有模型参与。）" } as ModelEvent;
        yield { type: "done" } as ModelEvent;
      })();
    },
  };
}

let app: ResearchApp;

/** What the smoke run measured, printed as one JSON line at the end. */
const measured: Record<string, unknown> = { conversions: [] };

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

async function convertFile(sessionId: string, path: string, usage: string, filename: string): Promise<Record<string, unknown>> {
  const search = new URLSearchParams({ sessionId, filename, usage, consent: CONSENT });
  const response = await fetch(`${app.pageOrigin}/api/research/documents/convert?${search.toString()}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: readFileSync(path),
  });
  const created = { status: response.status, json: (await response.json()) as Record<string, unknown> };
  expect(created.status, JSON.stringify(created.json)).toBe(202);
  return created.json["job"] as Record<string, unknown>;
}

async function waitForJob(sessionId: string, jobId: string, timeoutMs = 420_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await request("GET", `/api/research/documents/convert/${jobId}?sessionId=${encodeURIComponent(sessionId)}`);
    expect(response.status).toBe(200);
    const job = response.json["job"] as Record<string, unknown>;
    if (job["status"] === "succeeded" || job["status"] === "failed") return job;
    if (Date.now() > deadline) throw new Error(`job ${jobId} did not settle: ${JSON.stringify(job)}`);
    await new Promise((done) => setTimeout(done, 1_000));
  }
}

async function markdownOf(sessionId: string, documentId: string): Promise<string> {
  const response = await fetch(`${app.pageOrigin}/api/research/documents/${documentId}/content?sessionId=${encodeURIComponent(sessionId)}`);
  expect(response.status).toBe(200);
  return response.text();
}

describe.skipIf(!enabled)("mineru conversion smoke", () => {
  it("connects to the official server and lists its tools", async () => {
    app = await startResearchApp({
      dataDir: join(workDir, "data"),
      staticRoot,
      composition: testComposition({ modelClient: idleModel() }),
      // The real converter, with the settings the product ships by default.
      log: () => undefined,
    });
    const ready = await request("GET", "/api/research/mineru");
    const body = ready.json as Record<string, unknown>;
    console.log(`[smoke] mineru readiness: ${JSON.stringify(body)}`);
    expect(ready.status, JSON.stringify(body)).toBe(200);
    const mineru = body["mineru"] as Record<string, unknown>;
    expect(mineru["parseDocuments"]).toBe(true);
    expect(mineru["transport"]).toBe("stdio");
    expect(mineru["mode"]).toBe("flash");
    expect((body["limits"] as Record<string, unknown>)["online"]).toBe(true);
    measured["readiness"] = { ...mineru, limits: body["limits"] };
  }, 300_000);

  it("converts the real PDF into the library", async () => {
    const session = (await request("POST", "/api/research/intents", { seedTopic: "把一份真实 PDF 转成 Markdown" })).json["sessionId"] as string;
    const job = await convertFile(session, samplePdf, "research_source", "conversion-sample.pdf");
    const settled = await waitForJob(session, job["jobId"] as string);
    console.log(`[smoke] pdf job: ${JSON.stringify(settled)}`);
    expect(settled["status"], JSON.stringify(settled)).toBe("succeeded");

    const documentId = (settled["document"] as Record<string, unknown>)["documentId"] as string;
    const markdown = await markdownOf(session, documentId);
    // The Markdown has to be this file's content, not merely non-empty.
    expect(markdown).toContain("检索增强生成系统的评测方法");
    expect(markdown).toContain("BM25");
    expect(markdown).toContain("0.79");
    expect((settled["conversion"] as Record<string, unknown>)["trust"]).toBe("server_verified");
    expect((settled["conversion"] as Record<string, unknown>)["pageMap"]).toBeNull();

    const entry = {
      format: "pdf",
      source: samplePdf,
      sourceBytes: statSync(samplePdf).size,
      jobId: job["jobId"],
      documentId,
      durationMs: Date.parse(String(settled["finishedAt"])) - Date.parse(String(settled["createdAt"])),
      toolDurationMs: (settled["toolCall"] as Record<string, unknown>)["durationMs"],
      markdownChars: markdown.length,
      attempts: settled["attempts"],
      sha256: settled["sha256"],
      fromFile: (settled["toolCall"] as Record<string, unknown>)["fromFile"],
    };
    (measured["conversions"] as unknown[]).push(entry);
    (measured as Record<string, unknown>)["pdfSession"] = session;
  }, 600_000);

  it("converts the real DOCX into the library", async () => {
    const session = (await request("POST", "/api/research/intents", { seedTopic: "把一份真实 DOCX 转成 Markdown" })).json["sessionId"] as string;
    const job = await convertFile(session, sampleDocx, "research_source", "conversion-sample.docx");
    const settled = await waitForJob(session, job["jobId"] as string);
    console.log(`[smoke] docx job: ${JSON.stringify(settled)}`);
    expect(settled["status"], JSON.stringify(settled)).toBe("succeeded");

    const documentId = (settled["document"] as Record<string, unknown>)["documentId"] as string;
    const markdown = await markdownOf(session, documentId);
    expect(markdown).toContain("检索增强生成系统的评测方法");
    expect(markdown).toContain("Hybrid");
    expect((settled["conversion"] as Record<string, unknown>)["trust"]).toBe("server_verified");

    (measured["conversions"] as unknown[]).push({
      format: "docx",
      source: sampleDocx,
      sourceBytes: statSync(sampleDocx).size,
      jobId: job["jobId"],
      documentId,
      durationMs: Date.parse(String(settled["finishedAt"])) - Date.parse(String(settled["createdAt"])),
      toolDurationMs: (settled["toolCall"] as Record<string, unknown>)["durationMs"],
      markdownChars: markdown.length,
      attempts: settled["attempts"],
      sha256: settled["sha256"],
      fromFile: (settled["toolCall"] as Record<string, unknown>)["fromFile"],
    });
    (measured as Record<string, unknown>)["docxSession"] = session;
  }, 600_000);

  it("reads the converted PDF through the agent's own tool", async () => {
    const session = (measured as Record<string, unknown>)["pdfSession"] as string;
    const entry = (measured["conversions"] as { documentId: string }[])[0];
    const documentId = entry?.documentId ?? "";
    expect(documentId).not.toBe("");

    const tool = createResearchToolSet(app.service).byName["read_document"];
    const raw = await tool!.execute(
      { documentId, question: "三种检索策略的 MRR 分别是多少？", maxChars: 1_200 },
      { sessionId: session, signal: AbortSignal.timeout(30_000) },
    );
    const read = JSON.parse(String(raw)) as Record<string, unknown>;
    console.log(`[smoke] read_document: ${JSON.stringify(read).slice(0, 700)}`);
    expect(read["ok"], JSON.stringify(read)).toBe(true);
    expect(Number(read["readChars"])).toBeLessThanOrEqual(1_200);
    expect(JSON.stringify(read["fragments"])).toContain("0.63");
    expect((read["conversion"] as Record<string, unknown>)["trust"]).toBe("server_verified");
    const fragments = read["fragments"] as readonly Record<string, unknown>[];
    for (const fragment of fragments) expect(fragment["page"]).toBeNull();
    measured["readDocument"] = { readChars: read["readChars"], scope: read["scope"], fragments: fragments.length, pages: fragments.map((f) => f["page"]) };
  }, 120_000);

  it("goes from a converted document to a source and a snapshot", async () => {
    // A session of its own: the card path here is the product's own service,
    // because the subject of this case is the document's journey, not the
    // research flow (which other suites cover end to end).
    const bare = (await app.client.sessions.create()).session.sessionId;
    const job = await convertFile(bare, samplePdf, "research_source", "conversion-sample.pdf");
    const settled = await waitForJob(bare, job["jobId"] as string);
    expect(settled["status"], JSON.stringify(settled)).toBe("succeeded");
    const documentId = (settled["document"] as Record<string, unknown>)["documentId"] as string;

    app.service.issueGrant({ sessionId: bare, intent: "card", taskId: null });
    const card = app.service.proposeTask(bare, {
      topic: "转换后的文档能不能作为研究材料",
      purpose: "验收转换链路",
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

    const promoted = await request("POST", `/api/research/documents/${documentId}/source?sessionId=${encodeURIComponent(bare)}`, {
      taskId: card.task.id,
    });
    expect(promoted.status, JSON.stringify(promoted.json)).toBe(201);
    const sourceId = (promoted.json["source"] as Record<string, unknown>)["sourceId"] as string;
    expect((promoted.json["source"] as Record<string, unknown>)["role"]).toBe("user-provided");

    app.service.issueGrant({ sessionId: bare, intent: "research", taskId: card.task.id });
    const outcome = await app.service.read(card.task.id, { sourceId, question: "混合检索策略的指标是多少？", maxEvidence: 4 });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (outcome.ok !== true) return;
    const snapshotId = app.service.sourcesOf(card.task.id).find((source) => source.id === sourceId)?.snapshotId ?? "";
    const snapshot = app.service.snapshotTextOf(snapshotId) ?? "";
    expect(snapshot).toContain("BM25");
    expect(outcome.evidence.length).toBeGreaterThan(0);
    for (const item of outcome.evidence) expect(snapshot).toContain(item.excerpt);
    console.log(`[smoke] source: role=user-provided snapshotChars=${snapshot.length} evidence=${outcome.evidence.length}`);
    measured["source"] = { documentId, sourceId, snapshotChars: snapshot.length, evidence: outcome.evidence.length, role: "user-provided", taskId: card.task.id };
  }, 300_000);

  it.skipIf(extraPdf === undefined)("converts one real-world PDF of the operator's own", async () => {
    const session = (await request("POST", "/api/research/intents", { seedTopic: "转换一份真实论文 PDF" })).json["sessionId"] as string;
    const job = await convertFile(session, extraPdf as string, "intent_context", "extra.pdf");
    const settled = await waitForJob(session, job["jobId"] as string);
    console.log(`[smoke] extra pdf job: ${JSON.stringify(settled)}`);
    expect(settled["status"], JSON.stringify(settled)).toBe("succeeded");
    const documentId = (settled["document"] as Record<string, unknown>)["documentId"] as string;
    const markdown = await markdownOf(session, documentId);
    (measured["conversions"] as unknown[]).push({
      format: "pdf (real-world)",
      source: extraPdf,
      sourceBytes: statSync(String(extraPdf)).size,
      documentId,
      durationMs: Date.parse(String(settled["finishedAt"])) - Date.parse(String(settled["createdAt"])),
      markdownChars: markdown.length,
      fromFile: (settled["toolCall"] as Record<string, unknown>)["fromFile"],
      truncatedInline: (settled["toolCall"] as Record<string, unknown>)["inlineTruncated"],
    });
  }, 600_000);

  it.skipIf(process.env["RESEARCHPAGE_SMOKE_SCANNED_PDF"] === undefined)("reads text out of a scanned, image-only PDF", async () => {
    // The one case that is about OCR rather than about text extraction: the
    // file has no text layer at all (every page is a bitmap), so the only way
    // any Markdown can come back is if MinerU recognised the glyphs. The
    // adapter sends no `enable_ocr` — the server's own default is auto-detect —
    // so this is also the check that the default is the right one.
    const path = process.env["RESEARCHPAGE_SMOKE_SCANNED_PDF"] as string;
    const expected = process.env["RESEARCHPAGE_SMOKE_EXPECT_TEXT"] ?? "";
    const session = (await request("POST", "/api/research/intents", { seedTopic: "转换一份扫描件" })).json["sessionId"] as string;
    const job = await convertFile(session, path, "research_source", "scanned-sample.pdf");
    const settled = await waitForJob(session, job["jobId"] as string);
    console.log(`[smoke] scanned job: ${JSON.stringify(settled)}`);
    expect(settled["status"], JSON.stringify(settled)).toBe("succeeded");

    const documentId = (settled["document"] as Record<string, unknown>)["documentId"] as string;
    const markdown = await markdownOf(session, documentId);
    console.log(`[smoke] scanned markdown (first 300 chars): ${markdown.slice(0, 300).replace(/\n/g, "\\n")}`);
    for (const needle of expected.split("|").filter((entry) => entry.length > 0)) {
      expect(markdown, `expected "${needle}" in the recognised text`).toContain(needle);
    }
    (measured["conversions"] as unknown[]).push({
      format: "pdf (scanned, image-only)",
      source: path,
      sourceBytes: statSync(path).size,
      documentId,
      durationMs: Date.parse(String(settled["finishedAt"])) - Date.parse(String(settled["createdAt"])),
      toolDurationMs: (settled["toolCall"] as Record<string, unknown>)["durationMs"],
      markdownChars: markdown.length,
      fromFile: (settled["toolCall"] as Record<string, unknown>)["fromFile"],
    });
  }, 600_000);

  it.skipIf(process.env["RESEARCHPAGE_SMOKE_PAGE_LIMIT"] !== "1")("reports Flash mode's page limit as itself", async () => {
    // A 25-page PDF: over Flash's 20-page ceiling, so the real service refuses
    // it and the adapter has to say *that* rather than "something went wrong".
    const { exportHtmlToPdf, findPdfBrowser } = await import("@every-dagent/plugin-research");
    const body = `<!doctype html><html><head><meta charset="utf-8"></head><body>${Array.from(
      { length: 25 },
      (_, index) => `<section style="page-break-after: always"><h2>第 ${String(index + 1)} 页</h2><p>这一页用来把文件推过 Flash 模式的页数上限。</p></section>`,
    ).join("")}</body></html>`;
    const path = join(workDir, "twenty-five-pages.pdf");
    const printed = await exportHtmlToPdf({ html: body, outPath: path, browserPath: findPdfBrowser() as string });
    expect(printed.ok, JSON.stringify(printed)).toBe(true);

    const session = (await request("POST", "/api/research/intents", { seedTopic: "转换一份超过页数上限的文件" })).json["sessionId"] as string;
    const job = await convertFile(session, path, "intent_context", "twenty-five-pages.pdf");
    const settled = await waitForJob(session, job["jobId"] as string);
    console.log(`[smoke] page-limit job: ${JSON.stringify(settled)}`);
    expect(settled["status"]).toBe("failed");
    expect((settled["failure"] as Record<string, unknown>)["code"], JSON.stringify(settled)).toBe("flash_page_limit");
    measured["pageLimit"] = { code: "flash_page_limit", problem: (settled["failure"] as Record<string, unknown>)["problem"] };
  }, 600_000);
});

afterAll(async () => {
  await app?.close();
  console.log(`[smoke] measured: ${JSON.stringify(measured)}`);
  if (workDir !== "") rmSync(workDir, { recursive: true, force: true });
});
