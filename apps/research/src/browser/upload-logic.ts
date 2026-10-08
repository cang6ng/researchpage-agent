/**
 * What the page decides about a file before and after it is sent.
 *
 * Three kinds of statement live here. First, whether a file may be sent at all:
 * Markdown goes up as text the server will store, a PDF or DOCX goes up as
 * bytes that leave the machine, and the two have different limits and different
 * questions. Second, what a receipt is: a conversion happens on the server's
 * clock, the page can only remember the job id it was given, and that record is
 * what survives a reload. Third, what a reader is told about a job: whether it
 * is still running, whether a retry is offered, and what that retry costs.
 *
 * The rules are here rather than in the component because they are the ones
 * that must not be got wrong: a file that is sent without consent, or a retry
 * that fires by itself, is a charge the user did not agree to.
 */

import type { ConversionJobView, ConversionJobStatus } from "./api.js";

/* --------------------------------------------------------------- formats -- */

export type UploadKind = "markdown" | "pdf" | "docx" | "unsupported";

const MARKDOWN_EXTENSIONS: readonly string[] = [".md", ".markdown", ".txt"];
const CONVERSION_EXTENSIONS: readonly string[] = [".pdf", ".docx"];

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot < 0 ? "" : filename.slice(dot).toLowerCase();
}

export function uploadKindOf(filename: string): UploadKind {
  const extension = extensionOf(filename);
  if (MARKDOWN_EXTENSIONS.includes(extension)) return "markdown";
  if (extension === ".pdf") return "pdf";
  if (extension === ".docx") return "docx";
  return "unsupported";
}

/* ---------------------------------------------------------------- limits -- */

/** One Markdown document's own ceiling, as the library enforces it. */
export const MAX_MARKDOWN_BYTES = 512 * 1024;
/** How many documents one session may hold. */
export const MAX_DOCUMENTS_PER_SESSION = 20;
/**
 * The largest JSON envelope the create-intent route accepts.
 *
 * Base64 costs about a third more than the bytes it carries, and the ids and
 * filenames travel beside it, so a legal file could still be refused for the
 * way it was encoded. The page checks the encoded size itself and says which
 * files are the problem, rather than letting the reader learn it from a 413.
 */
export const MAX_ENVELOPE_BYTES = MAX_MARKDOWN_BYTES * 2 + 64 * 1024;
/** MinerU Flash mode's own per-file limit: bigger can only be refused upstream. */
export const MAX_CONVERSION_BYTES = 10 * 1024 * 1024;

/** How many jobs' receipts one session keeps. */
export const MAX_RECEIPTS_PER_SESSION = 20;

/* ----------------------------------------------------------------- bytes -- */

export type Utf8Reading = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly problem: string };

/**
 * Reads a file as UTF-8 text, or refuses it.
 *
 * `File.text()` replaces ill-formed sequences with U+FFFD, which would mean the
 * library stored text the user's file does not contain — and every excerpt
 * quoted from it is checked against that text. A checked decode refuses the
 * file instead, and the reader is told which file it was.
 */
export function readUtf8Text(bytes: ArrayBuffer): Utf8Reading {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { ok: true, text };
  } catch {
    return { ok: false, problem: "这不是有效的 UTF-8 文本文件，请另存为 UTF-8 后重试。" };
  }
}

/** The bytes as the JSON envelope carries them. */
export function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** How many bytes the create-intent request body would be, once encoded. */
export function envelopeBytesOf(body: unknown): number {
  return new TextEncoder().encode(JSON.stringify(body)).length;
}

/** A file the page is about to send, with the bytes it read. */
export interface PendingFile {
  readonly filename: string;
  readonly bytes: ArrayBuffer;
}

/** A PDF or DOCX the reader has consented to send for conversion. */
export interface ConsentedFile extends PendingFile {
  readonly kind: "pdf" | "docx";
}

export interface FileProblem {
  readonly filename: string;
  readonly problem: string;
}

/**
 * The Markdown files that cannot be sent, each with the reason.
 *
 * The two limits are checked together because they fail differently: a file
 * over its own ceiling has to be split, while a set of files that only overruns
 * the envelope can be sent one at a time after the exploration exists.
 */
export function markdownProblemsOf(files: readonly PendingFile[]): readonly FileProblem[] {
  const problems: FileProblem[] = [];
  for (const file of files) {
    if (file.bytes.byteLength > MAX_MARKDOWN_BYTES) {
      problems.push({ filename: file.filename, problem: `超过单文件上限 ${Math.round(MAX_MARKDOWN_BYTES / 1024)} KB，请拆分后再上传。` });
    }
  }
  return problems;
}

/**
 * A conversion's own record of itself, as the page keeps it.
 *
 * The server has no list of jobs — a job lives in memory and is gone after a
 * restart — so the receipt is the only way a reload can ask about one. It is
 * deliberately small: ids and a hash, never the file.
 */
export interface ConversionReceipt {
  readonly jobId: string;
  readonly sessionId: string;
  readonly filename: string;
  readonly kind: "pdf" | "docx";
  readonly sha256: string | null;
  readonly documentId: string | null;
  readonly at: string;
}

export const RECEIPTS_KEY = "researchpage.conversions.v1";
export const INTENT_POINTER_KEY = "researchpage.intent";
export const TASK_KEY = "researchpage.task";

/** One exploration the page may return to, as the pointer stores it. */
export interface IntentPointer {
  readonly intentId: string;
  readonly sessionId: string;
  readonly seedTopic: string;
}

export function parseIntentPointer(raw: string | null): IntentPointer | null {
  if (raw === null || raw.length === 0) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const intentId = record["intentId"];
    const sessionId = record["sessionId"];
    const seedTopic = record["seedTopic"];
    if (typeof intentId !== "string" || intentId.length === 0) return null;
    if (typeof sessionId !== "string" || sessionId.length === 0) return null;
    return { intentId, sessionId, seedTopic: typeof seedTopic === "string" ? seedTopic : "" };
  } catch {
    // A pointer a previous version wrote in another shape is not a reason to
    // stop the page from starting; it is treated as absent.
    return null;
  }
}

export function parseReceipts(raw: string | null): readonly ConversionReceipt[] {
  if (raw === null || raw.length === 0) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry): ConversionReceipt[] => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
      const record = entry as Record<string, unknown>;
      const jobId = record["jobId"];
      const sessionId = record["sessionId"];
      const filename = record["filename"];
      const kind = record["kind"];
      if (typeof jobId !== "string" || typeof sessionId !== "string") return [];
      if (typeof filename !== "string" || (kind !== "pdf" && kind !== "docx")) return [];
      return [
        {
          jobId,
          sessionId,
          filename,
          kind,
          sha256: typeof record["sha256"] === "string" ? record["sha256"] : null,
          documentId: typeof record["documentId"] === "string" ? record["documentId"] : null,
          at: typeof record["at"] === "string" ? record["at"] : "",
        },
      ];
    });
  } catch {
    return [];
  }
}

/**
 * The receipts that belong to one session, newest last.
 *
 * A job is asked about with its own session id, so a receipt from another
 * session is not merely useless — asking with it would be refused, and mixing
 * two projects' jobs on one page is exactly the confusion this prevents.
 */
export function receiptsForSession(receipts: readonly ConversionReceipt[], sessionId: string): readonly ConversionReceipt[] {
  return receipts.filter((receipt) => receipt.sessionId === sessionId);
}

/** Adds a receipt, keeping the newest ones and never a duplicate job. */
export function withReceipt(
  receipts: readonly ConversionReceipt[],
  receipt: ConversionReceipt,
  limit = MAX_RECEIPTS_PER_SESSION,
): readonly ConversionReceipt[] {
  const kept = receipts.filter((entry) => entry.jobId !== receipt.jobId);
  const forSession = kept.filter((entry) => entry.sessionId === receipt.sessionId);
  const others = kept.filter((entry) => entry.sessionId !== receipt.sessionId);
  const trimmed = [...forSession, receipt].slice(-limit);
  return [...others, ...trimmed];
}

export function withReceiptDocument(
  receipts: readonly ConversionReceipt[],
  jobId: string,
  documentId: string,
): readonly ConversionReceipt[] {
  return receipts.map((entry) => (entry.jobId === jobId ? { ...entry, documentId } : entry));
}

/** Whether a job has stopped moving: only then is there nothing left to ask. */
export function isTerminalJob(status: ConversionJobStatus): boolean {
  return status === "succeeded" || status === "failed";
}

/** Whether a job is one the page should be asking about right now. */
export function isActiveJob(status: ConversionJobStatus): boolean {
  return status === "queued" || status === "converting" || status === "importing";
}

/**
 * The order the page submits files in.
 *
 * One conversion runs at a time on the server and a burst is refused as busy, so
 * the page sends them one after another and says so while it waits. The order
 * itself is the reader's: what they chose first is what they want first.
 */
export function submissionOrder<T>(files: readonly T[]): readonly T[] {
  return [...files];
}

/** A short digest of the bytes, when the browser can compute one. */
export async function sha256Of(bytes: ArrayBuffer): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) return null;
  try {
    const digest = await subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------- the copy -- */

/** What the reader is told before a file leaves the machine. */
export const CONVERSION_CONSENT_TEXT =
  "原始文件会发送到 MinerU 的在线服务解析；重复提交或重试会再次消耗额度，并可能产生费用。同意仅针对本次选择的文件。";

/** The sentence shown next to a retry, before it is pressed. */
export function retryWarningOf(job: ConversionJobView): string {
  return `重试这次转换会再次把「${job.filename}」发送到 MinerU 在线解析，并再次消耗额度与产生费用。`;
}

/**
 * What to say about a job that failed, in the reader's terms.
 *
 * The server publishes a code, a sentence and a guidance, and all three are
 * shown: the code because a support conversation needs a name for the failure,
 * the sentence because it is the answer, and the guidance because it says what
 * to do next. Nothing here is derived from the converter's own output, because
 * there is no route that carries any.
 */
export function failureSummaryOf(job: ConversionJobView): { readonly title: string; readonly body: string; readonly code: string } {
  const failure = job.failure;
  if (failure === null) return { title: "转换失败", body: "服务端没有给出更详细的原因。", code: "conversion_failed" };
  return { title: failure.problem, body: failure.guidance, code: failure.code };
}

/**
 * Whether a repeat of this file should be flagged as possibly charged twice.
 *
 * Only what the page itself remembers counts: the server keeps no cache and
 * keeps no list of jobs, so a file sent in another session, or in a session
 * whose receipts have been trimmed, is simply unknown. Saying「已上传过」about
 * something the page cannot see would be a claim it cannot stand behind.
 */
export function duplicateWarningOf(
  receipts: readonly ConversionReceipt[],
  sessionId: string,
  sha256: string | null,
  filename: string,
): string | null {
  if (sha256 === null) return null;
  const seen = receiptsForSession(receipts, sessionId).find((receipt) => receipt.sha256 === sha256);
  if (seen === undefined) return null;
  return `这次会话里已经提交过内容相同的文件「${seen.filename}」；服务端没有转换缓存，再提交一次会再次调用 MinerU 并消耗额度。`;
}
