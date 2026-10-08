/**
 * What the page decides about a file, before and after it is sent.
 *
 * Every rule here exists because getting it wrong costs the reader something
 * real: a file refused for the way it was encoded, a Markdown file whose bytes
 * were replaced with replacement characters before the server ever saw it, a
 * conversion submitted without consent, or a retry that fires by itself and
 * spends quota twice. The cases are written against those failures rather than
 * against the functions.
 */

import { describe, expect, it } from "vitest";

import {
  MAX_CONVERSION_BYTES,
  MAX_ENVELOPE_BYTES,
  MAX_MARKDOWN_BYTES,
  base64Of,
  duplicateWarningOf,
  envelopeBytesOf,
  extensionOf,
  failureSummaryOf,
  isActiveJob,
  isTerminalJob,
  markdownProblemsOf,
  parseIntentPointer,
  parseReceipts,
  readUtf8Text,
  receiptsForSession,
  retryWarningOf,
  sha256Of,
  uploadKindOf,
  withReceipt,
  withReceiptDocument,
  type ConversionReceipt,
} from "../src/browser/upload-logic.js";
import type { ConversionJobView } from "../src/browser/api.js";

function bytesOf(text: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(text);
  return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer;
}

function receipt(overrides: Partial<ConversionReceipt> & { readonly jobId: string }): ConversionReceipt {
  return {
    sessionId: "sess_1",
    filename: "paper.pdf",
    kind: "pdf",
    sha256: null,
    documentId: null,
    at: "2026-10-09T00:00:00.000Z",
    ...overrides,
  };
}

function job(overrides: Partial<ConversionJobView> = {}): ConversionJobView {
  return {
    jobId: "job_1",
    status: "failed",
    filename: "paper.pdf",
    format: "pdf",
    sizeBytes: 1024,
    sha256: "abc",
    usage: ["intent_context"],
    sessionId: "sess_1",
    taskId: null,
    attempts: 3,
    maxAttempts: 3,
    createdAt: "2026-10-09T00:00:00.000Z",
    startedAt: "2026-10-09T00:00:01.000Z",
    finishedAt: "2026-10-09T00:00:30.000Z",
    retryable: false,
    document: null,
    conversion: null,
    toolCall: null,
    failure: { code: "flash_page_limit", problem: "文档页数超过 Flash 模式上限。", guidance: "请拆分文件后重新上传。" },
    note: "",
    limits: { maxBytes: MAX_CONVERSION_BYTES, maxPages: 20, mode: "flash", transports: ["stdio"] },
    ...overrides,
  };
}

describe("what kind of file this is", () => {
  it("knows the two things the product can do with a file", () => {
    expect(uploadKindOf("notes.md")).toBe("markdown");
    expect(uploadKindOf("NOTES.MARKDOWN")).toBe("markdown");
    expect(uploadKindOf("paper.pdf")).toBe("pdf");
    expect(uploadKindOf("report.docx")).toBe("docx");
    expect(uploadKindOf("deck.pptx")).toBe("unsupported");
    expect(uploadKindOf("noextension")).toBe("unsupported");
  });

  it("reads the extension off the last dot", () => {
    expect(extensionOf("2026.09.paper.pdf")).toBe(".pdf");
    expect(extensionOf("noextension")).toBe("");
  });
});

describe("reading a file as text", () => {
  it("accepts valid UTF-8, including characters outside Latin-1", () => {
    const reading = readUtf8Text(bytesOf("# 标题\n\n中文正文，含全角标点。"));
    expect(reading.ok).toBe(true);
    if (reading.ok) expect(reading.text).toContain("中文正文");
  });

  it("refuses a file that is not UTF-8 instead of replacing its characters", () => {
    // `File.text()` would answer U+FFFD here, and the library would store text
    // the reader's file does not contain — while every excerpt quoted from it
    // is checked against exactly that text.
    const invalid = new Uint8Array([0x23, 0x20, 0xff, 0xfe, 0x0a]);
    const reading = readUtf8Text(invalid.buffer as ArrayBuffer);
    expect(reading.ok).toBe(false);
    if (!reading.ok) expect(reading.problem).toContain("UTF-8");
  });
});

describe("carrying bytes into the JSON envelope", () => {
  it("round-trips the bytes exactly", () => {
    const original = bytesOf("a\nb\n中文");
    const encoded = base64Of(new Uint8Array(original));
    const decoded = new Uint8Array(Buffer.from(encoded, "base64"));
    expect([...decoded]).toEqual([...new Uint8Array(original)]);
  });

  it("measures the request it would really send", () => {
    const size = envelopeBytesOf({ seedTopic: "topic", documents: [{ filename: "a.md", contentBase64: "AAAA" }] });
    expect(size).toBeGreaterThan(20);
    expect(size).toBeLessThan(MAX_ENVELOPE_BYTES);
  });
});

describe("the limits a file has to fit", () => {
  it("refuses a Markdown file over its own ceiling and says what to do", () => {
    const problems = markdownProblemsOf([
      { filename: "huge.md", bytes: new ArrayBuffer(MAX_MARKDOWN_BYTES + 1) },
      { filename: "fine.md", bytes: new ArrayBuffer(1024) },
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.filename).toBe("huge.md");
    expect(problems[0]?.problem).toContain("拆分");
  });
});

describe("receipts, which are all the page has after a reload", () => {
  it("ignores a pointer a previous version wrote in another shape", () => {
    expect(parseIntentPointer(null)).toBeNull();
    expect(parseIntentPointer("not json")).toBeNull();
    expect(parseIntentPointer('{"intentId":"itn_1"}')).toBeNull();
    expect(parseIntentPointer('{"intentId":"itn_1","sessionId":"sess_1","seedTopic":"t"}')).toEqual({
      intentId: "itn_1",
      sessionId: "sess_1",
      seedTopic: "t",
    });
  });

  it("keeps only well-formed receipts", () => {
    const parsed = parseReceipts(
      JSON.stringify([{ jobId: "job_1", sessionId: "sess_1", filename: "a.pdf", kind: "pdf" }, { jobId: 7 }, "nope"]),
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.jobId).toBe("job_1");
  });

  it("keeps one session's jobs away from another's", () => {
    // A job is asked about with its own session id. Mixing two projects' jobs
    // on one page is not a cosmetic problem: the request would be refused, and
    // the reader would be told their file failed when it did not.
    const receipts = [receipt({ jobId: "job_a" }), receipt({ jobId: "job_b", sessionId: "sess_2" })];
    expect(receiptsForSession(receipts, "sess_1").map((entry) => entry.jobId)).toEqual(["job_a"]);
    expect(receiptsForSession(receipts, "sess_2").map((entry) => entry.jobId)).toEqual(["job_b"]);
  });

  it("replaces a job's receipt rather than appending a duplicate", () => {
    const before = [receipt({ jobId: "job_a" })];
    const after = withReceipt(before, receipt({ jobId: "job_a", filename: "renamed.pdf" }));
    expect(after).toHaveLength(1);
    expect(after[0]?.filename).toBe("renamed.pdf");
  });

  it("remembers the document a job produced", () => {
    const after = withReceiptDocument([receipt({ jobId: "job_a" })], "job_a", "doc_1");
    expect(after[0]?.documentId).toBe("doc_1");
  });
});

describe("a job's own state", () => {
  it("stops asking once the job is over", () => {
    expect(isActiveJob("queued")).toBe(true);
    expect(isActiveJob("converting")).toBe(true);
    expect(isActiveJob("importing")).toBe(true);
    expect(isActiveJob("succeeded")).toBe(false);
    expect(isTerminalJob("failed")).toBe(true);
    expect(isTerminalJob("converting")).toBe(false);
  });

  it("shows the server's own sentence and guidance on failure", () => {
    const summary = failureSummaryOf(job());
    expect(summary.code).toBe("flash_page_limit");
    expect(summary.title).toContain("页数");
    expect(summary.body).toContain("拆分");
  });

  it("falls back to a general sentence when a job carries no code", () => {
    const summary = failureSummaryOf(job({ failure: null }));
    expect(summary.code).toBe("conversion_failed");
    expect(summary.title.length).toBeGreaterThan(0);
  });

  it("says what a retry costs before it is pressed", () => {
    expect(retryWarningOf(job())).toContain("再次消耗额度");
    expect(retryWarningOf(job())).toContain("paper.pdf");
  });
});

describe("duplicate files, which are only known to this page", () => {
  it("warns about a file whose bytes were already sent in this session", () => {
    const receipts = [receipt({ jobId: "job_a", sha256: "deadbeef" })];
    const warning = duplicateWarningOf(receipts, "sess_1", "deadbeef", "copy.pdf");
    expect(warning).toContain("再次调用 MinerU");
  });

  it("says nothing about a session it has no record of", () => {
    // The server keeps no conversion cache and no list of jobs, so claiming
    // 「已经上传过」about another session's file would be a claim the page cannot
    // stand behind.
    const receipts = [receipt({ jobId: "job_a", sha256: "deadbeef" })];
    expect(duplicateWarningOf(receipts, "sess_2", "deadbeef", "copy.pdf")).toBeNull();
    expect(duplicateWarningOf(receipts, "sess_1", null, "copy.pdf")).toBeNull();
  });

  it("computes a digest the page can compare with its own receipts", async () => {
    const digest = await sha256Of(bytesOf("hello"));
    expect(digest).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });
});
