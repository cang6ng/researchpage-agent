/**
 * Converting a PDF or a DOCX is a job, not a request.
 *
 * A conversion leaves this process twice — up to mineru.net and back — and
 * takes tens of seconds on a good day. Holding an HTTP request open for that
 * would mean the browser, the proxy and the user all wait on one connection,
 * and a reload would lose the only record that a file was ever uploaded. So an
 * upload creates a job: the bytes are on disk inside this process, the job is
 * queued, and the workspace asks about it by id.
 *
 * What this file is *not* is a task scheduler. There is one lane, one file per
 * job, a fixed number of attempts and a work directory that is deleted as soon
 * as it is no longer needed; the durable record of a conversion is the document
 * that lands in the library, not the job that produced it.
 *
 * Two rules that the code below enforces rather than documents:
 *
 * - **Nothing is uploaded without the user's own consent.** The request has to
 *   carry it, this file refuses the job without it, and neither the model nor a
 *   default can supply it. The document this produces says where it went.
 * - **The library is the only way in.** The converted Markdown is handed to
 *   `importConvertedDocument`, which is this process's own trusted path: same
 *   scope checks, same limits, same de-duplication, same reading as any other
 *   document, with `server_verified` provenance because this server really did
 *   call the converter.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import type {
  DocumentAccessRef,
  DocumentScopeDeclaration,
  DocumentUsage,
  Refusal,
  ResearchService,
} from "@every-dagent/plugin-research";
import { markdownNameFor } from "@every-dagent/plugin-research";

import {
  MINERU_FLASH_MAX_BYTES,
  MINERU_FLASH_MAX_PAGES,
  MINERU_TOOL,
  convertWithMineru,
  probeMineru,
  type MineruConversionFailure,
  type MineruSettings,
  type MineruStatus,
  type MineruToolCall,
} from "./mineru.js";

export type ConversionJobStatus = "queued" | "converting" | "importing" | "succeeded" | "failed";

/** The one consent value that lets a file leave this machine. */
export const THIRD_PARTY_UPLOAD_CONSENT = "third_party_upload";

/** How many conversions run at once. MinerU Flash is rate-limited; one is enough. */
const MAX_CONCURRENT = 1;
/** How many conversions may wait. Beyond this the caller is asked to come back. */
const MAX_QUEUED = 4;
/** Total attempts one job gets, the first try included. */
const MAX_ATTEMPTS = 3;
/**
 * How many failed jobs keep their uploaded file so they can be retried.
 *
 * A retry needs the bytes, and the bytes are the user's file — so a failed
 * conversion keeps its source until it is retried or pushed out by newer
 * failures, and every work directory is deleted on success, on eviction and at
 * shutdown. This is the one place where「转换结束后清理」has a deliberate
 * exception, because the alternative is a retry button that can only apologize.
 */
const MAX_RETAINED_FAILURES = 8;
/** How long a converter's own error text may be when it leaves this process. */
const MAX_DETAIL_CHARS = 2_000;

/** How long a readiness probe is believed, in ms. */
const PROBE_TTL_MS = 60_000;

/** The two formats this round converts, and what their bytes have to look like. */
const CONVERSION_FORMATS: Readonly<Record<string, string>> = Object.freeze({ ".pdf": "pdf", ".docx": "docx" });

export const MAX_CONVERSION_FILENAME_CHARS = 200;

/**
 * A refusal from this file, told apart from the library's own refusals.
 *
 * `kind` is the machine-readable reason; the route turns it into a status. The
 * library's scope refusals never come through here — they arrive as `Refusal`
 * and are answered by the same mapping every other document route uses.
 */
export interface ConversionProblem {
  readonly ok: false;
  readonly kind:
    | "consent_required"
    | "unsupported_format"
    | "file_invalid"
    | "file_too_large"
    | "busy"
    | "job_not_found"
    | "job_cross_session"
    | "job_not_retryable"
    | "file_gone"
    | "service_unavailable";
  readonly problems: readonly string[];
  readonly guidance: string;
}

export interface ConversionSubmitInput {
  /** The scope exactly as the request declared it, for the import to re-check. */
  readonly declarations: readonly DocumentScopeDeclaration[];
  readonly sessionId: string;
  readonly taskId: string | null;
  readonly filename: unknown;
  readonly bytes: Uint8Array;
  readonly usage: readonly DocumentUsage[];
  readonly consent: unknown;
}

/** One job, as the workspace reads it. */
export interface ConversionJobView {
  readonly jobId: string;
  readonly status: ConversionJobStatus;
  readonly filename: string;
  readonly format: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly usage: readonly DocumentUsage[];
  readonly sessionId: string;
  readonly taskId: string | null;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly retryable: boolean;
  readonly document: { readonly documentId: string; readonly filename: string; readonly duplicate: boolean } | null;
  readonly conversion: {
    readonly provider: string;
    readonly version: string | null;
    readonly status: string;
    readonly convertedAt: string;
    readonly sourceRef: string;
    readonly pageMap: null;
    readonly trust: "server_verified";
  } | null;
  readonly toolCall: {
    readonly tool: string;
    readonly command: string;
    readonly server: { readonly name: string; readonly version: string };
    readonly durationMs: number;
    readonly status: string;
    readonly contentChars: number | null;
    readonly inlineTruncated: boolean;
    readonly extractPath: string | null;
    readonly fromFile: boolean;
  } | null;
  readonly failure: { readonly code: string; readonly problem: string; readonly guidance: string; readonly detail: string | null } | null;
  readonly note: string;
  readonly limits: {
    readonly maxBytes: number;
    readonly maxPages: number;
    readonly mode: "flash" | "token";
    readonly transports: readonly string[];
  };
}

interface ConversionJob {
  readonly id: string;
  readonly filename: string;
  readonly format: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly usage: readonly DocumentUsage[];
  readonly declarations: readonly DocumentScopeDeclaration[];
  readonly sessionId: string;
  readonly taskId: string | null;
  readonly createdAt: string;
  readonly workDir: string;
  readonly sourcePath: string;
  status: ConversionJobStatus;
  attempts: number;
  startedAt: string | null;
  finishedAt: string | null;
  document: ConversionJobView["document"];
  conversion: ConversionJobView["conversion"];
  toolCall: MineruToolCall | null;
  fromFile: boolean;
  failure: ConversionJobView["failure"];
  /** Set while the job is running, so shutdown can stop it. */
  abort: AbortController | null;
}

export interface ConversionManagerOptions {
  readonly service: ResearchService;
  readonly settings: MineruSettings;
  /** The directory jobs put their files in. Created if missing. */
  readonly workRoot: string;
  readonly log: (message: string) => void;
}

export interface ConversionManager {
  /** Whether MinerU is usable right now, as the server itself answers it. */
  readiness(): Promise<MineruStatus>;
  submit(input: ConversionSubmitInput): { readonly ok: true; readonly job: ConversionJobView } | ConversionProblem | Refusal;
  view(jobId: string, ref: DocumentAccessRef): { readonly ok: true; readonly job: ConversionJobView } | ConversionProblem | Refusal;
  retry(jobId: string, ref: DocumentAccessRef): { readonly ok: true; readonly job: ConversionJobView } | ConversionProblem | Refusal;
  /** Stops the queue, aborts what runs, and removes every work directory. */
  shutdown(): Promise<void>;
}

function problem(kind: ConversionProblem["kind"], problems: readonly string[], guidance: string): ConversionProblem {
  return { ok: false, kind, problems, guidance };
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Reads the uploaded file's name, and refuses anything that is not a plain name.
 *
 * The name is *never* used to build a path — the source is written at
 * `<job>/source.<format>` — but it is stored in the conversion record and shown
 * to the user, so it still has to be a name and not a path, a device or a
 * directory.
 */
function readFilename(raw: unknown): { readonly ok: true; readonly filename: string; readonly format: string } | ConversionProblem {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text.length === 0) {
    return problem("file_invalid", ["缺少文件名（filename）"], "上传时要带上原始文件名，例如 paper.pdf。");
  }
  if (text.length > MAX_CONVERSION_FILENAME_CHARS) {
    return problem("file_invalid", [`文件名过长（上限 ${String(MAX_CONVERSION_FILENAME_CHARS)} 字符）`], "请把文件名改短后重新上传。");
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(text)) {
    return problem("file_invalid", ["文件名里有控制字符"], "请使用普通文件名。");
  }
  if (/[\\/]/.test(text) || /^[A-Za-z]:/.test(text) || text === "." || text === ".." || text.startsWith("~")) {
    return problem("file_invalid", [`文件名必须是纯文件名，不接受路径：${text}`], "只提供文件名本身，路径由服务端决定。");
  }
  const dot = text.lastIndexOf(".");
  const extension = dot === -1 ? "" : text.slice(dot).toLowerCase();
  const format = CONVERSION_FORMATS[extension];
  if (format === undefined) {
    return problem(
      "unsupported_format",
      [`本轮只支持 PDF 与 DOCX，收到的是「${extension === "" ? "无扩展名" : extension}」`],
      "请上传 .pdf 或 .docx 文件。HTML 会在确认 MinerU 支持后另行开放。",
    );
  }
  return { ok: true, filename: text, format };
}

/**
 * Checks that the bytes are what the name says.
 *
 * An extension is a claim, not a fact: a renamed ZIP is not a PDF, and handing
 * one to the converter spends a network round trip to learn that. A PDF starts
 * with `%PDF-`; a DOCX is a ZIP whose entries include `word/document.xml`, and
 * both of those facts live in the first bytes of the file.
 */
function looksLikeFormat(bytes: Uint8Array, format: string): boolean {
  const head = Buffer.from(bytes.subarray(0, Math.min(bytes.byteLength, 512 * 1024)));
  if (format === "pdf") return head.subarray(0, 5).toString("latin1") === "%PDF-";
  if (format === "docx") {
    const isZip = head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
    return isZip && head.includes("word/document.xml");
  }
  return false;
}

export function createConversionManager(options: ConversionManagerOptions): ConversionManager {
  const { service, settings, log } = options;
  const workRoot = resolve(options.workRoot);
  const jobs = new Map<string, ConversionJob>();
  const queue: ConversionJob[] = [];
  let running: ConversionJob | null = null;
  let stopping = false;

  let probe: { readonly at: number; readonly status: MineruStatus } | null = null;
  let probing: Promise<MineruStatus> | null = null;

  function workDirFor(jobId: string): string {
    return join(workRoot, jobId);
  }

  /**
   * Readiness as a real call already answered it.
   *
   * A conversion that reached `tools/call` has more evidence than the probe
   * does: the server answered, and it answered about this exact tool.
   */
  function readinessFromCall(call: MineruToolCall): MineruStatus {
    return {
      ok: true,
      transport: "stdio",
      command: settings.command,
      package: settings.packageSpec,
      mode: settings.token === undefined ? "flash" : "token",
      server: call.server,
      tools: [call.tool],
      parseDocuments: call.tool === MINERU_TOOL,
      problem: null,
      detail: null,
      durationMs: call.durationMs,
    };
  }

  function removeWorkDir(jobId: string): void {
    try {
      rmSync(workDirFor(jobId), { recursive: true, force: true });
    } catch (error) {
      log(`[convert] could not remove ${workDirFor(jobId)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Keeps only the newest failed jobs' files, so retries stay possible but bounded. */
  function evictOldFailures(): void {
    const failed = [...jobs.values()]
      .filter((job) => job.status === "failed" && existsSync(job.sourcePath))
      .sort((left, right) => (left.finishedAt ?? "").localeCompare(right.finishedAt ?? ""));
    for (const job of failed.slice(0, Math.max(0, failed.length - MAX_RETAINED_FAILURES))) {
      removeWorkDir(job.id);
    }
  }

  function limits(): ConversionJobView["limits"] {
    return {
      maxBytes: MINERU_FLASH_MAX_BYTES,
      maxPages: MINERU_FLASH_MAX_PAGES,
      mode: settings.token === undefined ? "flash" : "token",
      transports: ["stdio"],
    };
  }

  function viewOf(job: ConversionJob): ConversionJobView {
    return {
      jobId: job.id,
      status: job.status,
      filename: job.filename,
      format: job.format,
      sizeBytes: job.sizeBytes,
      sha256: job.sha256,
      usage: job.usage,
      sessionId: job.sessionId,
      taskId: job.taskId,
      attempts: job.attempts,
      maxAttempts: MAX_ATTEMPTS,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      retryable: job.status === "failed" && job.attempts < MAX_ATTEMPTS && existsSync(job.sourcePath),
      document: job.document,
      conversion: job.conversion,
      toolCall:
        job.toolCall === null
          ? null
          : {
              tool: job.toolCall.tool,
              command: job.toolCall.command,
              server: job.toolCall.server,
              durationMs: job.toolCall.durationMs,
              status: job.toolCall.status,
              contentChars: job.toolCall.contentChars,
              inlineTruncated: job.toolCall.inlineTruncated,
              extractPath: job.toolCall.extractPath,
              fromFile: job.fromFile,
            },
      failure: job.failure,
      note:
        job.status === "succeeded"
          ? `原始文件（${job.filename}）已经发送到 MinerU 的在线服务（mineru.net）解析，Markdown 由服务端调用 mineru-open-mcp 转换得到，因此来源记录是 server_verified。它仍然是你提供的材料，不会因此变成官方或一手来源。`
          : `上传的原始文件会被发送到 MinerU 在线服务（mineru.net）解析，这是你已经同意的第三方传输。`,
      limits: limits(),
    };
  }

  /** Removes what a conversion wrote, keeping the source while a retry is still possible. */
  function cleanupAfterFailure(job: ConversionJob): void {
    if (job.attempts >= MAX_ATTEMPTS) {
      removeWorkDir(job.id);
      return;
    }
    // The source stays: a retry needs the bytes, and the alternative is a
    // retry button that can only apologize. Everything else the converter may
    // have written — its saved Markdown, its scratch files — goes now, and the
    // directory itself goes when the job stops being retryable or at shutdown.
    try {
      for (const entry of readdirSync(job.workDir)) {
        if (entry === basename(job.sourcePath)) continue;
        rmSync(join(job.workDir, entry), { recursive: true, force: true });
      }
    } catch (error) {
      log(`[convert] could not clean ${job.workDir}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * What a person may read about a failure.
   *
   * The detail is the converter's own stderr and stack trace: useful for the
   * operator, and exactly the place a credential could leak into a log line and
   * then into a response. The token this process holds is removed, and what
   * remains is bounded so a runaway traceback cannot become the payload.
   */
  function safeDetail(detail: string | null): string | null {
    if (detail === null) return null;
    const token = settings.token ?? "";
    const redacted = token.length >= 8 ? detail.split(token).join("«MINERU_API_TOKEN»") : detail;
    return redacted.length > MAX_DETAIL_CHARS ? `${redacted.slice(0, MAX_DETAIL_CHARS)}…（已截断）` : redacted;
  }

  function fail(job: ConversionJob, code: string, message: string, guidance: string, detail: string | null): void {
    job.status = "failed";
    job.finishedAt = nowIso();
    job.failure = { code, problem: message, guidance, detail: safeDetail(detail) };
    job.abort = null;
    cleanupAfterFailure(job);
    evictOldFailures();
    log(`[convert] ${job.id} failed (${code}): ${message}`);
  }

  /**
   * One attempt: convert, then import.
   *
   * The import is a separate status because it is a separate thing that can
   * fail — the conversion succeeded and the library still may refuse the
   * document (too large, not UTF-8, the session already has twenty). Reporting
   * 「转换失败」for those would be a lie about what happened.
   */
  async function attempt(job: ConversionJob): Promise<void> {
    job.attempts += 1;
    job.status = "converting";
    job.startedAt = nowIso();
    job.abort = new AbortController();
    const controller = job.abort;
    const started = Date.now();

    const conversion = await convertWithMineru(settings, {
      filePath: job.sourcePath,
      outputDir: job.workDir,
      signal: controller.signal,
    });
    if (conversion.ok !== true) {
      const failure: MineruConversionFailure = conversion;
      job.toolCall = failure.call;
      if (failure.call !== null) {
        job.fromFile = failure.call.extractPath !== null;
        // A successful call updates the readiness cache: this is the same server
        // answering, so it is the freshest evidence the product has.
        probe = { at: Date.now(), status: readinessFromCall(failure.call) };
      }
      fail(
        job,
        failure.code,
        failure.problem,
        controller.signal.aborted
          ? "服务端正在关闭，这次转换被中断。重新发起即可。"
          : "可以稍后重试；若重试仍失败，请换一份更小的文件，或先确认这台机器能访问 mineru.net。",
        failure.detail,
      );
      return;
    }

    job.toolCall = conversion.call;
    job.fromFile = conversion.fromFile;
    probe = { at: Date.now(), status: readinessFromCall(conversion.call) };
    job.status = "importing";
    const convertedAt = nowIso();
    const sourceRef = `mineru-open-mcp ${conversion.call.tool} job=${job.id}`;
    const imported = service.importConvertedDocument({
      declared: job.declarations,
      sessionId: job.sessionId,
      filename: markdownNameFor(job.filename),
      content: { text: conversion.markdown },
      usage: job.usage,
      conversion: {
        provider: "mineru",
        version: settings.packageSpec.replace(/^mineru-open-mcp==/, ""),
        originalFilename: job.filename,
        originalFormat: job.format,
        status: "succeeded",
        // No page map: MinerU Flash answers with Markdown and no page
        // boundaries, so there is nothing to map. A page number invented from
        // paragraph order would look like knowledge and be wrong.
        convertedAt,
        sourceRef,
      },
    });
    if (imported.ok !== true) {
      fail(
        job,
        "import_refused",
        imported.problems.join("；"),
        imported.guidance,
        `import refused: ${imported.problems.join(" | ")}`,
      );
      return;
    }
    job.status = "succeeded";
    job.finishedAt = nowIso();
    job.document = { documentId: imported.document.documentId, filename: imported.document.originalFilename, duplicate: imported.duplicate };
    job.conversion = {
      provider: "mineru",
      version: settings.packageSpec.replace(/^mineru-open-mcp==/, ""),
      status: "succeeded",
      convertedAt,
      sourceRef,
      pageMap: null,
      trust: "server_verified",
    };
    job.abort = null;
    // The work directory is not kept: the durable result is the document, and
    // the Markdown now lives in the library's own column.
    removeWorkDir(job.id);
    log(
      `[convert] ${job.id} succeeded: ${job.filename} → document ${imported.document.documentId}（${String(conversion.markdownChars)} 字，${String(Date.now() - started)} ms，工具调用 ${String(conversion.call.durationMs)} ms）`,
    );
  }

  async function drain(): Promise<void> {
    if (running !== null || stopping) return;
    const next = queue.shift();
    if (next === undefined) return;
    running = next;
    try {
      await attempt(next);
    } catch (error) {
      fail(next, "conversion_failed", "转换过程中服务端出现内部错误，这次转换没有完成。", "请重试；如果反复出现，请查看服务端日志。", error instanceof Error ? error.stack ?? error.message : String(error));
    } finally {
      running = null;
    }
    void drain();
  }

  return {
    async readiness(): Promise<MineruStatus> {
      if (probe !== null && Date.now() - probe.at < PROBE_TTL_MS) return probe.status;
      if (probing !== null) return probing;
      probing = probeMineru(settings)
        .then((status) => {
          probe = { at: Date.now(), status };
          return status;
        })
        .finally(() => {
          probing = null;
        });
      return probing;
    },

    submit(input: ConversionSubmitInput): { readonly ok: true; readonly job: ConversionJobView } | ConversionProblem | Refusal {
      // Consent first, and it is the user's to give: it is a field of the
      // request, not a default, not an environment variable and not something a
      // model can set on the user's behalf.
      if (input.consent !== THIRD_PARTY_UPLOAD_CONSENT) {
        return problem(
          "consent_required",
          ["这次转换会把文件上传到 MinerU 的在线服务（mineru.net）解析，需要你明确同意后才能开始"],
          `请在请求里带上 consent: "${THIRD_PARTY_UPLOAD_CONSENT}"，表示你同意把这份文件发送给 MinerU 解析。`,
        );
      }
      const named = readFilename(input.filename);
      if (named.ok !== true) return named;
      if (input.bytes.byteLength === 0) {
        return problem("file_invalid", ["上传的文件是空的"], "请选择一份非空的 PDF 或 DOCX。");
      }
      if (input.bytes.byteLength > MINERU_FLASH_MAX_BYTES) {
        return problem(
          "file_too_large",
          [`文件超过 Flash 模式的上限（${String(MINERU_FLASH_MAX_BYTES / 1024 / 1024)} MB，当前 ${(input.bytes.byteLength / 1024 / 1024).toFixed(1)} MB）`],
          "请压缩或拆分这份文件；也可以在服务端设置 MINERU_API_TOKEN 以使用更大的限额。",
        );
      }
      if (!looksLikeFormat(input.bytes, named.format)) {
        return problem(
          "file_invalid",
          [`这份文件的内容不像 ${named.format.toUpperCase()}（扩展名与内容不一致）`],
          "请确认文件没有被改名或损坏后重新上传。",
        );
      }
      if (stopping) {
        return problem("service_unavailable", ["服务端正在关闭，无法接受新的转换"], "请稍后重新发起。");
      }
      if (queue.length >= MAX_QUEUED) {
        return problem(
          "busy",
          [`已经排队的转换太多（当前排队 ${String(queue.length)} 个，上限 ${String(MAX_QUEUED)} 个）`],
          "请等前面的转换结束后再上传，或先查询已有任务的状态。",
        );
      }

      const id = `conv_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const dir = workDirFor(id);
      const sourcePath = join(dir, `source.${named.format}`);
      const bytes = Buffer.from(input.bytes);
      const job: ConversionJob = {
        id,
        filename: named.filename,
        format: named.format,
        sizeBytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        usage: input.usage.length === 0 ? ["intent_context"] : input.usage,
        declarations: input.declarations,
        sessionId: input.sessionId,
        taskId: input.taskId,
        createdAt: nowIso(),
        workDir: dir,
        sourcePath,
        status: "queued",
        attempts: 0,
        startedAt: null,
        finishedAt: null,
        document: null,
        conversion: null,
        toolCall: null,
        fromFile: false,
        failure: null,
        abort: null,
      };
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(sourcePath, bytes);
      } catch (error) {
        removeWorkDir(id);
        return problem(
          "service_unavailable",
          ["服务端无法保存这份上传的文件"],
          "请检查服务端的数据目录是否可写，然后重试。",
        );
      }
      jobs.set(id, job);
      queue.push(job);
      log(`[convert] ${id} queued: ${named.filename}（${String(bytes.byteLength)} 字节，${named.format}，会话 ${input.sessionId}）`);
      void drain();
      return { ok: true, job: viewOf(job) };
    },

    view(jobId, ref) {
      const job = jobs.get(jobId);
      if (job === undefined) {
        return problem(
          "job_not_found",
          [`没有找到这个转换任务：${jobId}`],
          "转换任务只保存在服务端进程内；服务端重启后，请重新上传文件发起转换。",
        );
      }
      const scope = service.resolveDocumentScope(ref);
      if (scope.ok !== true) return scope;
      if (scope.sessionId !== job.sessionId) {
        return problem("job_cross_session", [`转换任务 ${jobId} 不属于这个会话`], "请带上发起这次转换的会话 id。");
      }
      return { ok: true, job: viewOf(job) };
    },

    retry(jobId, ref) {
      const viewed = this.view(jobId, ref);
      if (viewed.ok !== true) return viewed;
      const job = jobs.get(jobId) as ConversionJob;
      if (job.status !== "failed") {
        return problem("job_not_retryable", [`这个任务的状态是 ${job.status}，只有失败的转换可以重试`], "请查询任务状态后再决定。");
      }
      if (job.attempts >= MAX_ATTEMPTS) {
        return problem(
          "job_not_retryable",
          [`这个任务已经尝试过 ${String(job.attempts)} 次（上限 ${String(MAX_ATTEMPTS)} 次，含首次）`],
          "请重新上传文件发起一次新的转换，而不是继续重试这个任务。",
        );
      }
      if (!existsSync(job.sourcePath)) {
        return problem("file_gone", ["这份转换的原始文件已经被清理，无法重试"], "请重新上传这份文件发起新的转换。");
      }
      job.failure = null;
      job.status = "queued";
      job.finishedAt = null;
      queue.push(job);
      log(`[convert] ${job.id} queued for attempt ${String(job.attempts + 1)}`);
      void drain();
      return { ok: true, job: viewOf(job) };
    },

    async shutdown(): Promise<void> {
      stopping = true;
      queue.length = 0;
      running?.abort?.abort();
      // Wait for the running attempt to notice: it holds the only handle on the
      // child process, and the work directory cannot be removed under it.
      const deadline = Date.now() + 15_000;
      while (running !== null && Date.now() < deadline) {
        await new Promise((done) => setTimeout(done, 100));
      }
      for (const job of jobs.values()) removeWorkDir(job.id);
      jobs.clear();
    },
  };
}
