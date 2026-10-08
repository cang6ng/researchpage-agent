/**
 * What a converter's diagnostics must never do: reach a client.
 *
 * MinerU's own failures carry things a user's browser has no business seeing —
 * a credential, a presigned object-storage URL, the traceback of an HTTP client
 * with the request line in it, a fragment of the document being converted, an
 * absolute path on the server. All of it arrives on the converter's stderr, and
 * all of it used to be recorded in the job's public `failure.detail`.
 *
 * These cases drive the real HTTP routes and assert on the JSON a client
 * actually receives — not on a helper function, which would only prove that one
 * call site was fixed while the next field kept carrying the original text. Each
 * scenario is a payload the scripted MCP peer plants in its failure, and the
 * assertion is that the exact string appears nowhere in the response while the
 * classification and the retry state stay correct.
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
const workRoot = join(tmpdir(), `researchpage-leak-${Date.now().toString(36)}`);
const staticRoot = join(process.cwd(), "apps", "research", "public");
const pdfBytes = new Uint8Array(readFileSync(samplePdf));

const CONSENT = "third_party_upload";

/** The payloads the scripted converter plants, keyed the way the tests name them. */
const PAYLOADS = {
  A: "sk-7char",
  B: "sk-live-9f8e7d6c5b4a39281706f5e4d3c2b1a0",
  C: "https://mineru.oss-cn-shanghai.aliyuncs.com/api-upload/extract/2026-10-08/agent/8f3a.pdf?Expires=1791551834&OSSAccessKeyId=LTAI5t8fSGMgiRhQn4mpp926&Signature=sEcReTsIgNaTuRe%2BQ%3D",
  D: "api_key=SECRETREQUESTKEY",
  E: "内部机密：这段结论只存在于用户上传的文档里，比如「上下文翻倍时成本涨了三倍」。",
  F: "C:\\Users\\Administrator\\Documents\\私有资料\\尚未公开的论文.pdf",
  G: "KeyError: 'markdown_url'",
} as const;

/** A fragment of every payload, so a truncated echo is caught too. */
const NEEDLES: Readonly<Record<keyof typeof PAYLOADS, readonly string[]>> = {
  A: ["sk-7char"],
  B: ["sk-live-9f8e7d6c5b4a39281706f5e4d3c2b1a0"],
  C: ["mineru.oss-", "OSSAccessKeyId", "Signature=", "Expires="],
  D: ["SECRETREQUESTKEY", "httpx.HTTPStatusError", "_send_handling_auth", "developer.mozilla.org"],
  E: ["内部机密", "上下文翻倍时成本涨了三倍"],
  F: ["C:\\Users\\", "私有资料", "尚未公开的论文.pdf"],
  G: ["KeyError", "markdown_url", "从未见过的异常类型"],
};

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

async function request(app: ResearchApp, method: string, path: string, body?: unknown): Promise<Response> {
  const response = await fetch(`${app.pageOrigin}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, text, json: text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

async function newSession(app: ResearchApp, seedTopic: string): Promise<string> {
  const created = await request(app, "POST", "/api/research/intents", { seedTopic });
  expect(created.status, created.text).toBe(202);
  return created.json["sessionId"] as string;
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

/** Every payload known to these tests, as needles: a response may contain none. */
function allNeedles(): readonly string[] {
  return Object.values(NEEDLES).flat();
}

function expectNoLeak(response: Response, needles: readonly string[] = allNeedles()): void {
  for (const needle of needles) {
    expect(response.text.includes(needle), `leaked "${needle}" in: ${response.text.slice(0, 400)}`).toBe(false);
  }
}

let app: ResearchApp;
let sessionId = "";

beforeAll(async () => {
  app = await appWith(["--mode=success"]);
  sessionId = await newSession(app, "泄漏反例");
}, 60_000);

afterAll(async () => {
  await app.close();
  rmSync(workRoot, { recursive: true, force: true });
});

describe("a converter's diagnostics never reach a client", () => {
  const scenarios: readonly { readonly leak: keyof typeof PAYLOADS; readonly code: string }[] = [
    { leak: "A", code: "conversion_failed" },
    { leak: "B", code: "conversion_failed" },
    { leak: "C", code: "conversion_failed" },
    // D is an HTTP 401 with the request line in it: the classification sees the
    // status and answers「凭据被拒绝」, which is the right reading of it — what
    // matters here is that the request URL itself stays on the server.
    { leak: "D", code: "provider_auth" },
    { leak: "E", code: "conversion_failed" },
    { leak: "F", code: "conversion_failed" },
    { leak: "G", code: "conversion_failed" },
  ];

  for (const scenario of scenarios) {
    it(`scenario ${scenario.leak}: the failure reaches the client without it`, async () => {
      const leaking = await appWith([`--mode=success`, `--leak=${scenario.leak}`]);
      try {
        const session = await newSession(leaking, `泄漏 ${scenario.leak}`);

        // The upload itself, the status of the failed job, and the retry
        // response are all client-visible: none of them may carry the payload.
        const created = await convert(leaking, session, "leak.pdf");
        expect(created.status, created.text).toBe(202);
        expectNoLeak(created);

        const settled = await waitForJob(leaking, session, ((created.json["job"] as { jobId: string }).jobId));
        expectNoLeak(settled);
        const job = settled.json["job"] as Record<string, unknown>;
        const failure = job["failure"] as Record<string, unknown>;
        expect(job["status"]).toBe("failed");
        expect(failure["code"], settled.text).toBe(scenario.code);
        // The sentence is this server's own, not the converter's.
        expect(String(failure["problem"]).length).toBeGreaterThan(8);
        expect(String(failure["problem"])).toMatch(/[\u4e00-\u9fa5]/);
        expect(job["retryable"]).toBe(true);

        const retried = await request(leaking, "POST", `/api/research/documents/convert/${String(job["jobId"])}/retry?sessionId=${encodeURIComponent(session)}`);
        expect(retried.status, retried.text).toBe(202);
        expectNoLeak(retried);
        await waitForJob(leaking, session, String(job["jobId"]));
      } finally {
        await leaking.close();
      }
    }, 180_000);
  }

  it("a presigned URL logged on a *successful* call stays in the server", async () => {
    // The real server logs its HTTP traffic at INFO, so a presigned OSS URL goes
    // past on the way to a perfectly good result. A success response is still a
    // client-visible document of what happened.
    const chatty = await appWith(["--mode=success", `--leak-stderr=${PAYLOADS.C}`]);
    try {
      const session = await newSession(chatty, "成功但日志里有 URL");
      const created = await convert(chatty, session, "chatty.pdf");
      expect(created.status, created.text).toBe(202);
      expectNoLeak(created);
      const settled = await waitForJob(chatty, session, (created.json["job"] as { jobId: string }).jobId);
      expect((settled.json["job"] as { status: string }).status).toBe("succeeded");
      expectNoLeak(settled);
    } finally {
      await chatty.close();
    }
  }, 120_000);

  it("a converter that dies during the handshake leaks nothing through the readiness route", async () => {
    const dying = await appWith(["--mode=success", `--fail-handshake=${PAYLOADS.B}`]);
    try {
      const readiness = await request(dying, "GET", "/api/research/mineru");
      expect(readiness.status, readiness.text).toBe(503);
      expectNoLeak(readiness);
      const mineru = readiness.json["mineru"] as Record<string, unknown>;
      expect(mineru["parseDocuments"]).toBe(false);
      expect(String(readiness.json["problem"]).length).toBeGreaterThan(8);

      const session = await newSession(dying, "握手期泄漏");
      const created = await convert(dying, session, "dying.pdf");
      expect(created.status, created.text).toBe(202);
      expectNoLeak(created);
      const settled = await waitForJob(dying, session, (created.json["job"] as { jobId: string }).jobId);
      expectNoLeak(settled);
      const failure = (settled.json["job"] as { failure: Record<string, unknown> }).failure;
      expect(failure["code"]).toBe("mcp_handshake_failed");
    } finally {
      await dying.close();
    }
  }, 180_000);

  it("the job record has no field that carries the converter's own words", async () => {
    // Not a string match but a shape check: the public failure is an allowlist,
    // so a future field cannot quietly reintroduce the raw text.
    const leaking = await appWith(["--mode=success", "--leak=D"]);
    try {
      const session = await newSession(leaking, "字段检查");
      const created = await convert(leaking, session, "fields.pdf");
      const settled = await waitForJob(leaking, session, (created.json["job"] as { jobId: string }).jobId);
      const job = settled.json["job"] as Record<string, unknown>;
      const failure = job["failure"] as Record<string, unknown>;
      expect(Object.keys(failure).sort()).toEqual(["code", "guidance", "problem"]);
      for (const value of Object.values(failure)) {
        expect(typeof value).toBe("string");
      }
      // And nothing anywhere in the job view carries a detail/traceback field.
      const serialized = JSON.stringify(job);
      expect(serialized).not.toContain("\"detail\"");
      expect(serialized).not.toContain("stderr");
      expect(serialized).not.toContain("stack");
    } finally {
      await leaking.close();
    }
  }, 120_000);
});
