/**
 * What a converter's *metadata* must never do: reach a client.
 *
 * The conversion's own words are not the only thing a third-party process
 * chooses. Between the two of them, a peer names:
 *
 * - the file its result was saved to (`extract_path`) — a path on this machine,
 *   or a presigned URL that authorizes a download;
 * - the tools it offers (`tools/list`) — every name an arbitrary string, and one
 *   of them is quoted in the sentence that says the required tool is missing;
 * - the identity it reports at `initialize` (`server.name` / `server.version`).
 *
 * None of those strings is a fact this product established; all of them are
 * believed only as far as they are used, and the job record and the readiness
 * route are read by a browser. So each case here hands the client a peer whose
 * metadata *is* the payload and asserts, on the final HTTP JSON, that the
 * payload appears nowhere — while the job still reports the right failure code,
 * the right retry state and the right document.
 *
 * The response shapes are checked as allowlists for the same reason: a test that
 * only looks for one string would pass again the day a new field starts
 * carrying the same text.
 *
 * No real conversion happens here, so no MinerU quota is spent.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ModelClient, ModelEvent, ModelRequest, RuntimeContext } from "@every-dagent/agent-core";
import { DEFAULT_MODEL_FRAMING } from "@every-dagent/agent-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startResearchApp, type ResearchApp } from "../src/server/composition.js";
import { testComposition } from "../../../tests/helpers/test-composition.js";

const here = dirname(fileURLToPath(import.meta.url));
const fakeServer = join(here, "helpers", "fake-mineru-mcp.mjs");
const samplePdf = join(here, "fixtures", "conversion", "conversion-sample.pdf");
const workRoot = join(tmpdir(), `researchpage-dto-${Date.now().toString(36)}`);
const staticRoot = join(process.cwd(), "apps", "research", "public");
const pdfBytes = new Uint8Array(readFileSync(samplePdf));

const CONSENT = "third_party_upload";

/** Strings a peer can choose for itself, and that a client may never read. */
const PAYLOADS = {
  /** A seven-character credential: short enough to slip past any length rule. */
  token: "sk-7char",
  /** A complete presigned object-storage URL, query string included. */
  presigned:
    "https://mineru.oss-cn-shanghai.aliyuncs.com/api-upload/extract/2026-10-08/agent/8f3a.pdf?Expires=1791551834&OSSAccessKeyId=LTAI5t8fSGMgiRhQn4mpp926&Signature=sEcReTsIgNaTuRe%2BQ%3D",
  /** An absolute path on this machine. */
  privatePath: "C:\\Users\\Administrator\\Documents\\私有资料\\尚未公开的论文.pdf",
  /** A fragment of the document being converted. */
  document: "内部机密：这段结论只存在于用户上传的文档里",
} as const;

/** A fragment of every payload, so a truncated echo is caught too. */
const NEEDLES: readonly string[] = [
  PAYLOADS.token,
  "mineru.oss-",
  "OSSAccessKeyId",
  "Signature=",
  "Expires=",
  "C:\\Users\\",
  "私有资料",
  "尚未公开的论文.pdf",
  "内部机密",
];

/**
 * The fields a client may read on a job's tool call, and on the readiness
 * route. Both lists are the *whole* of what is published: a field that is not
 * on one of them is a field the frontend does not need.
 */
const TOOL_CALL_FIELDS = ["contentChars", "durationMs", "fromFile", "inlineTruncated", "status", "tool"];
const READINESS_FIELDS = ["command", "durationMs", "mode", "package", "parseDocuments", "transport"];

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

async function appWith(args: readonly string[]): Promise<ResearchApp> {
  return startResearchApp({
    dataDir: join(workRoot, args.join("_").replace(/[^a-zA-Z0-9_=]/g, "").slice(0, 40) || "app"),
    staticRoot,
    composition: testComposition({ modelClient: idleModel() }),
    overrides: {
      search: () => Promise.reject(new Error("this test never searches")),
      read: () => Promise.reject(new Error("this test never reads the network")),
    },
    mineru: { command: process.execPath, args: [fakeServer, ...args], packageSpec: "mineru-open-mcp==1.0.22-test" },
    log: () => undefined,
  });
}

interface Response {
  readonly status: number;
  readonly text: string;
  readonly json: Record<string, unknown>;
}

async function request(app: ResearchApp, method: string, path: string): Promise<Response> {
  const response = await fetch(`${app.pageOrigin}${path}`, { method });
  const text = await response.text();
  return { status: response.status, text, json: text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

async function newSession(app: ResearchApp, seedTopic: string): Promise<string> {
  const response = await fetch(`${app.pageOrigin}/api/research/intents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ seedTopic }),
  });
  const body = (await response.json()) as Record<string, unknown>;
  expect(response.status, JSON.stringify(body)).toBe(202);
  return body["sessionId"] as string;
}

async function convert(app: ResearchApp, sessionId: string, filename: string): Promise<Response> {
  const query = new URLSearchParams({ sessionId, filename, consent: CONSENT });
  const response = await fetch(`${app.pageOrigin}/api/research/documents/convert?${query.toString()}`, {
    method: "POST",
    headers: { "content-type": "application/pdf" },
    body: Buffer.from(pdfBytes),
  });
  const text = await response.text();
  return { status: response.status, text, json: text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

async function waitForJob(app: ResearchApp, sessionId: string, jobId: string, timeoutMs = 60_000): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await request(app, "GET", `/api/research/documents/convert/${jobId}?sessionId=${encodeURIComponent(sessionId)}`);
    expect(response.status, response.text).toBe(200);
    const job = response.json["job"] as { status: string };
    if (job.status === "succeeded" || job.status === "failed") return response;
    if (Date.now() > deadline) throw new Error(`job ${jobId} did not settle: ${response.text}`);
    await new Promise((done) => setTimeout(done, 100));
  }
}

/** A response may contain none of the payloads, however it was produced. */
function expectNoLeak(response: Response): void {
  for (const needle of NEEDLES) {
    expect(response.text.includes(needle), `leaked "${needle}" in: ${response.text.slice(0, 400)}`).toBe(false);
  }
}

function jobOf(response: Response): Record<string, unknown> {
  return response.json["job"] as Record<string, unknown>;
}

let app: ResearchApp;
let sessionId = "";

beforeAll(async () => {
  app = await appWith(["--mode=success"]);
  sessionId = await newSession(app, "元数据泄漏反例");
}, 60_000);

afterAll(async () => {
  await app.close();
  rmSync(workRoot, { recursive: true, force: true });
});

describe("a converter's metadata never reaches a client", () => {
  it("1. a path the converter chose for its own result stays on the server", async () => {
    // The peer points `extract_path` at a private file that is not this
    // conversion's output, so the adapter refuses to read it — and the refusal
    // is a *failure*, which is recorded on the job the client then polls.
    const pointing = await appWith(["--mode=traverse", `--extract-path=${PAYLOADS.privatePath}`]);
    try {
      const session = await newSession(pointing, "私有路径的结果文件");
      const created = await convert(pointing, session, "private.pdf");
      expect(created.status, created.text).toBe(202);
      expectNoLeak(created);

      const settled = await waitForJob(pointing, session, jobOf(created)["jobId"] as string);
      expectNoLeak(settled);
      const job = jobOf(settled);
      expect(job["status"]).toBe("failed");
      const failure = job["failure"] as Record<string, unknown>;
      expect(failure["code"], settled.text).toBe("output_outside_workdir");
      expect(job["retryable"]).toBe(true);
      // The tool call itself is still reported — without the path it named.
      const toolCall = job["toolCall"] as Record<string, unknown>;
      expect(Object.keys(toolCall).sort()).toEqual(TOOL_CALL_FIELDS);

      // Retrying keeps the failed attempt's record and is answered with it, so
      // this is the second place the path used to come back from.
      const retried = await fetch(`${pointing.pageOrigin}/api/research/documents/convert/${String(job["jobId"])}/retry?sessionId=${encodeURIComponent(session)}`, {
        method: "POST",
      });
      const retriedText = await retried.text();
      expect(retried.status, retriedText).toBe(202);
      expectNoLeak({ status: retried.status, text: retriedText, json: JSON.parse(retriedText) as Record<string, unknown> });
      const afterRetry = await waitForJob(pointing, session, String(job["jobId"]));
      expectNoLeak(afterRetry);
      expect((afterRetry.json["job"] as { status: string }).status).toBe("failed");
    } finally {
      await pointing.close();
    }
  }, 180_000);

  it("2. a presigned URL named on a successful call is not published with it", async () => {
    // The result arrives inline and complete, so the URL is never fetched — but
    // the call still *reports* where the peer said its file was, and that
    // report is what a client reads after a success.
    const naming = await appWith(["--mode=success", `--extract-path=${PAYLOADS.presigned}`]);
    try {
      const session = await newSession(naming, "成功响应里的预签名 URL");
      const created = await convert(naming, session, "presigned.pdf");
      expect(created.status, created.text).toBe(202);
      expectNoLeak(created);

      const settled = await waitForJob(naming, session, jobOf(created)["jobId"] as string);
      expectNoLeak(settled);
      const job = jobOf(settled);
      expect(job["status"], settled.text).toBe("succeeded");
      // The conversion still worked: the document is in the library.
      expect((job["document"] as Record<string, unknown>)["documentId"]).toBeTruthy();
      const toolCall = job["toolCall"] as Record<string, unknown>;
      expect(Object.keys(toolCall).sort()).toEqual(TOOL_CALL_FIELDS);
      expect(toolCall["fromFile"]).toBe(false);
      expect(toolCall["status"]).toBe("success");

      const library = await request(naming, "GET", `/api/research/documents?sessionId=${encodeURIComponent(session)}`);
      expectNoLeak(library);
      expect((library.json["documents"] as readonly unknown[]).length).toBe(1);
    } finally {
      await naming.close();
    }
  }, 180_000);

  it("3. a tool list full of secrets is not quoted back by the readiness route", async () => {
    // A peer that does not offer the tool this product needs is exactly the
    // case whose sentence used to name what it *did* offer.
    const offering = await appWith([
      `--tool-names=${[PAYLOADS.token, PAYLOADS.presigned, PAYLOADS.privatePath, PAYLOADS.document].join("|")}`,
    ]);
    try {
      const readiness = await request(offering, "GET", "/api/research/mineru");
      expect(readiness.status, readiness.text).toBe(503);
      expectNoLeak(readiness);
      expect(Object.keys(readiness.json).sort()).toEqual(["limits", "mineru", "ok", "problem"]);
      const mineru = readiness.json["mineru"] as Record<string, unknown>;
      expect(Object.keys(mineru).sort()).toEqual(READINESS_FIELDS);
      expect(mineru["parseDocuments"]).toBe(false);
      // The sentence is this server's, and it is about the tool that is
      // missing — not about the names the peer chose.
      expect(readiness.json["problem"]).toBe("MinerU MCP 未提供所需的文档解析工具。");

      // And the same peer's refusal of a conversion is equally unquoted.
      const session = await newSession(offering, "恶意工具名");
      const created = await convert(offering, session, "tools.pdf");
      expect(created.status, created.text).toBe(202);
      expectNoLeak(created);
      const settled = await waitForJob(offering, session, jobOf(created)["jobId"] as string);
      expectNoLeak(settled);
      const job = jobOf(settled);
      expect(job["status"]).toBe("failed");
      expect((job["failure"] as Record<string, unknown>)["code"]).toBe("mcp_tools_missing");
    } finally {
      await offering.close();
    }
  }, 180_000);

  it("4. the identity a peer reports for itself is not serialized either", async () => {
    const posing = await appWith([
      "--mode=success",
      `--server-name=${PAYLOADS.token} ${PAYLOADS.document}`,
      `--server-version=${PAYLOADS.privatePath}`,
    ]);
    try {
      const readiness = await request(posing, "GET", "/api/research/mineru");
      expect(readiness.status, readiness.text).toBe(200);
      expectNoLeak(readiness);
      const mineru = readiness.json["mineru"] as Record<string, unknown>;
      expect(Object.keys(mineru).sort()).toEqual(READINESS_FIELDS);
      expect(mineru["parseDocuments"]).toBe(true);
      expect(readiness.json["problem"]).toBeNull();

      const session = await newSession(posing, "自报身份");
      const created = await convert(posing, session, "identity.pdf");
      expect(created.status, created.text).toBe(202);
      expectNoLeak(created);
      const settled = await waitForJob(posing, session, jobOf(created)["jobId"] as string);
      expectNoLeak(settled);
      const job = jobOf(settled);
      expect(job["status"], settled.text).toBe("succeeded");
      const toolCall = job["toolCall"] as Record<string, unknown>;
      expect(Object.keys(toolCall).sort()).toEqual(TOOL_CALL_FIELDS);
      // Not just「the payload is absent」: the fields that could carry it do not
      // exist on the record at all.
      const serialized = JSON.stringify(job);
      expect(serialized).not.toContain("extractPath");
      expect(serialized).not.toContain("\"server\"");
      expect(serialized).not.toContain("\"tools\"");
    } finally {
      await posing.close();
    }
  }, 180_000);

  it("5. a healthy peer still answers everything the workspace needs", async () => {
    // The allowlist is only worth having if the useful half survives it.
    const readiness = await request(app, "GET", "/api/research/mineru");
    expect(readiness.status, readiness.text).toBe(200);
    expect(readiness.json["problem"]).toBeNull();
    const mineru = readiness.json["mineru"] as Record<string, unknown>;
    expect(mineru["parseDocuments"]).toBe(true);
    expect(mineru["transport"]).toBe("stdio");
    expect(mineru["mode"]).toBe("flash");
    expect(String(mineru["package"])).toContain("mineru-open-mcp");

    const created = await convert(app, sessionId, "healthy.pdf");
    expect(created.status, created.text).toBe(202);
    const settled = await waitForJob(app, sessionId, jobOf(created)["jobId"] as string);
    const job = jobOf(settled);
    expect(job["status"], settled.text).toBe("succeeded");
    const toolCall = job["toolCall"] as Record<string, unknown>;
    expect(toolCall["tool"]).toBe("parse_documents");
    expect(toolCall["status"]).toBe("success");
    expect(toolCall["fromFile"]).toBe(false);
    expect(Number(toolCall["contentChars"])).toBeGreaterThan(0);
    expect(job["retryable"]).toBe(false);
    // `document_too_large` / `import_refused` aside, a success reaches the
    // library with a real document id.
    expect((job["document"] as Record<string, unknown>)["documentId"]).toBeTruthy();
  }, 180_000);
});
