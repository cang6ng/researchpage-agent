/**
 * MinerU, through its official MCP server.
 *
 * The product's own document library only stores Markdown; PDF and DOCX have to
 * become Markdown before they can be read, cited or turned into a source. This
 * file is that step and nothing else: it starts `mineru-open-mcp` over stdio,
 * asks it for its tools, calls `parse_documents` on one local file, and hands
 * back the Markdown the server actually returned.
 *
 * Three things about this path are worth stating where the code is, because
 * they are properties of the tool and not of this adapter:
 *
 * - **It is not offline.** `mineru-open-mcp` uploads the document to
 *   mineru.net and returns the result; the tool's own description says so. The
 *   adapter therefore never runs without the caller having recorded the user's
 *   consent, and the document record it produces does not pretend otherwise.
 * - **Flash mode has limits** — about 20 pages and 10 MB per file, no token
 *   required. A file over either limit is refused by the service, and this
 *   adapter reports that refusal as itself rather than as a generic failure.
 * - **Failures are opaque at the MCP boundary.** The tool catches the SDK's
 *   exception and answers「Document processing failed. Check server logs for
 *   details.」, so the reason only exists on the server's stderr. That stream is
 *   captured here and classified — a rate limit, a page limit, a dead network
 *   and an unknown failure have to reach the user as four different sentences,
 *   and a guess is not one of them.
 *
 * Nothing here writes to the document library: it returns text, and the
 * conversion job hands that text to `service.importConvertedDocument`.
 */

import { existsSync, realpathSync, readFileSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { Readable } from "node:stream";

import { MAX_DOCUMENT_BYTES } from "@every-dagent/plugin-research";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

/** The tool this integration is built on, as `tools/list` names it. */
export const MINERU_TOOL = "parse_documents";

/**
 * The MCP server this product was verified against.
 *
 * Pinned rather than floating: the tool's arguments, its result shape and its
 * error behaviour are what the rest of this file is written against, and a
 * silent upgrade would move all three. An operator can point the product at
 * another build with `MINERU_MCP_PACKAGE`.
 */
export const MINERU_PACKAGE = "mineru-open-mcp==1.0.22";

/** Flash mode's per-file ceiling, as the tool itself describes it. */
export const MINERU_FLASH_MAX_BYTES = 10 * 1024 * 1024;
/** Flash mode's page ceiling; the service refuses a longer file instead of trimming it. */
export const MINERU_FLASH_MAX_PAGES = 20;

/** How long the MCP server has to answer the initialize/tools handshake, in ms. */
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 120_000;
/**
 * How long one `parse_documents` call may take, in ms.
 *
 * Deliberately longer than the SDK's own 300 s poll timeout: the server's own
 * deadline must fire first, so that a document nobody can parse comes back as
 * the service's timeout message rather than as a killed process this adapter
 * then has to interpret.
 */
const DEFAULT_CALL_TIMEOUT_MS = 360_000;

/** How much of the server's stderr is kept for classification and the log. */
const STDERR_LINE_LIMIT = 400;
const STDERR_LINE_CHARS = 600;

export type MineruFailureCode =
  | "mcp_not_installed"
  | "mcp_handshake_failed"
  | "mcp_tools_missing"
  | "mcp_disconnected"
  | "conversion_timeout"
  | "conversion_cancelled"
  | "flash_file_too_large"
  | "flash_page_limit"
  | "flash_unsupported_type"
  | "flash_rate_limited"
  | "provider_auth"
  | "network_unavailable"
  | "conversion_failed"
  | "markdown_empty"
  | "output_missing"
  | "output_outside_workdir"
  | "document_too_large";

export interface MineruSettings {
  /** The executable to run, or `null` when this machine has none. */
  readonly command: string | null;
  /** Its arguments. With uvx this is `--from <package> mineru-open-mcp`. */
  readonly args: readonly string[];
  readonly packageSpec: string;
  /**
   * The MinerU credential, when the operator supplied one.
   *
   * It is passed to the child process and nowhere else: it is not in any HTTP
   * response, any document record, any log line or the repository.
   */
  readonly token: string | undefined;
  readonly callTimeoutMs: number;
  readonly handshakeTimeoutMs: number;
  /** The proxy the child should use, when the operator named one. */
  readonly proxy: string | undefined;
}

export interface MineruServerInfo {
  readonly name: string;
  readonly version: string;
}

/** What one real tool call was, for the conversion record and the log. */
export interface MineruToolCall {
  readonly tool: string;
  readonly command: string;
  readonly package: string;
  readonly server: MineruServerInfo;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly durationMs: number;
  readonly status: string;
  readonly contentChars: number | null;
  /** The server cut the inline Markdown short; the full text is on disk. */
  readonly inlineTruncated: boolean;
  /** The server's own reference to the saved Markdown, when it saved one. */
  readonly extractPath: string | null;
  readonly stderrTail: readonly string[];
}

/**
 * How the converter answered a readiness probe.
 *
 * Its `server` and `tools` are what the peer *said* about itself — a name, a
 * version and a list of tool names, each of them an arbitrary string chosen by
 * a third-party process. They are kept here because they are what the probe
 * learned (and what `parseDocuments` is computed from), and they are the reason
 * this type is not serialized to a client as it stands: a route that publishes
 * a status publishes an allowlist of it, with the reason as a `code` and the
 * sentence looked up on the server side.
 */
export interface MineruStatus {
  readonly ok: boolean;
  readonly transport: "stdio";
  readonly command: string | null;
  readonly package: string;
  readonly mode: "flash" | "token";
  readonly server: MineruServerInfo | null;
  readonly tools: readonly string[];
  readonly parseDocuments: boolean;
  /** Why the converter is not usable, when it is not. A code, not a sentence. */
  readonly code: MineruFailureCode | null;
  readonly detail: string | null;
  readonly durationMs: number;
}

export interface MineruConversionRequest {
  /** The local file to convert. It has to live inside `outputDir`. */
  readonly filePath: string;
  /** The directory this conversion may read its own output from. */
  readonly outputDir: string;
  readonly signal?: AbortSignal | undefined;
}

export interface MineruConversionSuccess {
  readonly ok: true;
  readonly markdown: string;
  readonly markdownChars: number;
  /** True when the full Markdown was read from the server's saved file. */
  readonly fromFile: boolean;
  readonly call: MineruToolCall;
}

export interface MineruConversionFailure {
  readonly ok: false;
  readonly code: MineruFailureCode;
  /** The sentence the user gets. */
  readonly problem: string;
  /** The technical detail, for the server log. */
  readonly detail: string;
  readonly call: MineruToolCall | null;
}

export type MineruConversionOutcome = MineruConversionSuccess | MineruConversionFailure;

/** Fails a call without pretending to know more than the failure says. */
function failure(code: MineruFailureCode, problem: string, detail: string, call: MineruToolCall | null = null): MineruConversionFailure {
  return { ok: false, code, problem, detail, call };
}

/**
 * The environment the MCP server runs in.
 *
 * Not the ambient one. `getDefaultEnvironment()` is the SDK's allow-list of
 * variables a child process may inherit (PATH, TEMP, USERPROFILE…), and the
 * model credential this product holds is deliberately not on it: a converter
 * that uploads documents to a third party has no business being able to read
 * the key that drives the research.
 *
 * Proxies are the one place where inheriting would be wrong in a way that is
 * hard to see. Python reads the Windows registry proxy as well as the
 * environment, so a child can end up behind a proxy the parent never used — and
 * on the machine this was verified on, that proxy answered mineru.net but broke
 * the Markdown download with `EOF occurred in violation of protocol`. The child
 * therefore runs with proxying disabled unless the operator asks for a proxy
 * with `MINERU_MCP_PROXY`, which is the only case where a proxy is believed.
 */
export function mineruChildEnvironment(settings: MineruSettings): Record<string, string> {
  const env = getDefaultEnvironment();
  env["MINERU_LOG_LEVEL"] = "INFO";
  // `PYTHONUTF8` so a Windows console code page cannot turn the server's own
  // logs into mojibake before this adapter classifies them.
  env["PYTHONUTF8"] = "1";
  env["PYTHONIOENCODING"] = "utf-8";
  if (settings.token !== undefined && settings.token.length > 0) {
    env["MINERU_API_TOKEN"] = settings.token;
  }
  if (settings.proxy !== undefined && settings.proxy.length > 0) {
    env["HTTP_PROXY"] = settings.proxy;
    env["HTTPS_PROXY"] = settings.proxy;
    env["http_proxy"] = settings.proxy;
    env["https_proxy"] = settings.proxy;
  } else {
    env["NO_PROXY"] = "*";
    env["no_proxy"] = "*";
  }
  return env;
}

/** Where `uvx` is, if this machine has one. */
export function findUvx(environment: NodeJS.ProcessEnv): string | null {
  const override = (environment["MINERU_MCP_COMMAND"] ?? "").trim();
  if (override.length > 0) return existsSync(override) ? override : null;
  const path = environment["PATH"] ?? environment["Path"] ?? "";
  const suffixes = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const directory of path.split(delimiter)) {
    if (directory.trim().length === 0) continue;
    for (const suffix of suffixes) {
      const candidate = join(directory, `uvx${suffix}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Splits a command line into an executable and its arguments.
 *
 * Only what is needed for the documented use — an operator (or a test) pointing
 * the product at a specific command line, such as
 * `MINERU_MCP_COMMAND="uvx --from mineru-open-mcp==1.0.22 mineru-open-mcp"`.
 * Arguments are split on whitespace and double quotes group a value; there is
 * no shell, so nothing is expanded and nothing is interpreted.
 */
function splitCommandLine(value: string): { readonly command: string; readonly args: readonly string[] } | null {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (const char of value.trim()) {
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && /\s/.test(char)) {
      if (current.length > 0) parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current.length > 0) parts.push(current);
  const [command, ...args] = parts;
  return command === undefined || command.length === 0 ? null : { command, args };
}

/** The args `uvx` needs to run the official server at a pinned version. */
export function uvxArgsFor(packageSpec: string): readonly string[] {
  return ["--from", packageSpec, "mineru-open-mcp"];
}

/** The adapter's configuration, read from the operator's environment once. */
export function mineruSettingsFrom(
  environment: NodeJS.ProcessEnv,
  overrides: {
    readonly command?: string | null | undefined;
    readonly args?: readonly string[] | undefined;
    readonly packageSpec?: string | undefined;
    readonly token?: string | undefined;
    readonly callTimeoutMs?: number | undefined;
  } = {},
): MineruSettings {
  const requested = (environment["MINERU_MCP_PACKAGE"] ?? "").trim();
  const packageSpec = overrides.packageSpec ?? (requested.length > 0 ? requested : MINERU_PACKAGE);
  const configured = (environment["MINERU_MCP_COMMAND"] ?? "").trim();
  // An explicit command line wins over everything: it is how an operator points
  // the product at a local checkout, and how a test drives the same adapter
  // against a server it controls.
  const explicit = overrides.command === undefined ? (configured.length > 0 ? splitCommandLine(configured) : null) : null;
  const command = overrides.command !== undefined ? overrides.command : (explicit?.command ?? findUvx(environment));
  const args = overrides.args ?? explicit?.args ?? uvxArgsFor(packageSpec);
  const configuredTimeout = Number(environment["MINERU_TIMEOUT_MS"] ?? "");
  const callTimeout = overrides.callTimeoutMs ?? configuredTimeout;
  return {
    command,
    args,
    packageSpec,
    token: overrides.token ?? ((environment["MINERU_API_TOKEN"] ?? "").trim() || undefined),
    callTimeoutMs: Number.isFinite(callTimeout) && callTimeout >= 10_000 ? callTimeout : DEFAULT_CALL_TIMEOUT_MS,
    handshakeTimeoutMs: DEFAULT_HANDSHAKE_TIMEOUT_MS,
    proxy: (environment["MINERU_MCP_PROXY"] ?? "").trim() || undefined,
  };
}

function freshBoundedLines(): { push(chunk: string): void; tail(count: number): string[] } {
  const lines: string[] = [];
  return {
    push(chunk: string): void {
      for (const line of chunk.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        lines.push(trimmed.length > STDERR_LINE_CHARS ? trimmed.slice(0, STDERR_LINE_CHARS) : trimmed);
      }
      if (lines.length > STDERR_LINE_LIMIT) lines.splice(0, lines.length - STDERR_LINE_LIMIT);
    },
    tail(count: number): string[] {
      return lines.slice(Math.max(0, lines.length - count));
    },
  };
}

/** One MCP server process, with its stderr collected for the length of the call. */
interface ServerRun {
  readonly client: Client;
  readonly stderr: ReturnType<typeof freshBoundedLines>;
  readonly server: MineruServerInfo;
  readonly tools: readonly string[];
}

async function withServer<T>(
  settings: MineruSettings,
  work: (run: ServerRun) => Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T | MineruConversionFailure> {
  if (settings.command === null) {
    return failure(
      "mcp_not_installed",
      "这台机器上没有找到 uvx，无法启动官方的 mineru-open-mcp。请先安装 uv（https://docs.astral.sh/uv/），然后重新发起转换。",
      "uvx not found on PATH and MINERU_MCP_COMMAND is unset",
    );
  }
  const stderr = freshBoundedLines();
  const transport = new StdioClientTransport({
    command: settings.command,
    args: [...settings.args],
    env: mineruChildEnvironment(settings),
    stderr: "pipe",
  });
  const client = new Client({ name: "researchpage", version: "0.1.0" });
  const stream = transport.stderr;
  if (stream instanceof Readable) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => stderr.push(chunk));
  }
  try {
    await client.connect(transport, { timeout: settings.handshakeTimeoutMs, ...(signal === undefined ? {} : { signal }) });
  } catch (error) {
    await closeQuietly(client, transport);
    return failure(
      "mcp_handshake_failed",
      "MinerU MCP 服务没有启动成功。请检查 uvx 是否可用、mineru-open-mcp 是否已下载，以及网络是否可访问。",
      describeError(error, stderr.tail(12)),
    );
  }
  try {
    const listed = await client.listTools({}, { timeout: settings.handshakeTimeoutMs, ...(signal === undefined ? {} : { signal }) });
    const server = client.getServerVersion();
    const run: ServerRun = {
      client,
      stderr,
      server: { name: server?.name ?? "mineru-open-mcp", version: server?.version ?? "unknown" },
      tools: listed.tools.map((tool) => tool.name),
    };
    if (!run.tools.includes(MINERU_TOOL)) {
      // What the peer offers instead is an operator's question, so it is asked
      // in `detail` (the server's own log) rather than in a sentence a client
      // reads: a tool name is the peer's string, and it is the peer that chose
      // whether it means a version mismatch or a credential.
      return failure(
        "mcp_tools_missing",
        `MinerU MCP 未提供所需的文档解析工具（${MINERU_TOOL} 缺失）。它通常意味着安装的是另一个版本的 mineru-open-mcp。`,
        `tools/list = ${run.tools.join(",")}`,
      );
    }
    return await work(run);
  } catch (error) {
    // Three different things end up here and they are three different answers:
    // the caller asked us to stop, the call ran past its deadline, or the
    // connection went away. Collapsing them into「连接中断」would tell the user to
    // check their network when the converter was simply too slow.
    const detail = describeError(error, stderr.tail(12));
    if (signal?.aborted === true) {
      return failure("conversion_cancelled", "这次转换被中止了（服务端正在关闭）。", detail);
    }
    if (isTimeoutError(error)) {
      return failure(
        "conversion_timeout",
        `MinerU 在超时时间内（${String(Math.round(settings.callTimeoutMs / 1000))} 秒）没有返回结果。文件越大越容易超时，可以稍后重试或换一份更小的文件。`,
        detail,
      );
    }
    return failure("mcp_disconnected", "与 MinerU MCP 服务的连接中断了，这次转换没有完成。", detail);
  } finally {
    await closeQuietly(client, transport);
  }
}

/** Whether an error is this client's own deadline rather than a broken link. */
function isTimeoutError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as Record<string, unknown>;
  if (record["name"] === "AbortError") return record["code"] === "REQUEST_TIMEOUT_MSEC" || record["code"] === -32001;
  if (record["code"] === -32001) return true;
  const message = typeof record["message"] === "string" ? record["message"] : "";
  return /timed out|timeout/i.test(message);
}

async function closeQuietly(client: Client, transport: StdioClientTransport): Promise<void> {
  try {
    await client.close();
  } catch {
    // A failed close is not a second failure: the process is being torn down
    // either way, and the transport's own exit handler has already been told.
  }
  try {
    await transport.close();
  } catch {
    // Same reasoning as above.
  }
}

function describeError(error: unknown, stderrTail: readonly string[]): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return stderrTail.length === 0 ? message : `${message}\n--- mineru-open-mcp stderr ---\n${stderrTail.join("\n")}`;
}

/** Argv-shaped so the log can show the exact same call a person could make. */
function commandLine(settings: MineruSettings): string {
  return [settings.command ?? "uvx", ...settings.args].join(" ");
}

/**
 * Starts the MCP server and asks it what it can do.
 *
 * The same connect → `tools/list` sequence a conversion performs, without
 * converting anything: this is what lets the workspace answer「MinerU 可用吗」
 * with the server's real name, version and tool list instead of a guess based
 * on whether a binary exists.
 */
export async function probeMineru(settings: MineruSettings, signal?: AbortSignal): Promise<MineruStatus> {
  const started = Date.now();
  const base = {
    transport: "stdio" as const,
    command: settings.command,
    package: settings.packageSpec,
    mode: settings.token === undefined ? ("flash" as const) : ("token" as const),
  };
  const run = await withServer(
    settings,
    async (server) => ({ server: server.server, tools: server.tools }),
    signal,
  );
  if ("ok" in run && run.ok === false) {
    return {
      ...base,
      ok: false,
      server: null,
      tools: [],
      parseDocuments: false,
      code: run.code,
      detail: run.detail,
      durationMs: Date.now() - started,
    };
  }
  const answered = run as { server: MineruServerInfo; tools: readonly string[] };
  return {
    ...base,
    ok: true,
    server: answered.server,
    tools: answered.tools,
    parseDocuments: answered.tools.includes(MINERU_TOOL),
    code: null,
    detail: null,
    durationMs: Date.now() - started,
  };
}

function isInside(directory: string, candidate: string): boolean {
  const step = relative(directory, candidate);
  return step.length > 0 && !step.startsWith("..") && !isAbsolute(step);
}

/**
 * Reads the Markdown the server saved beside the call.
 *
 * The one rule here is that this file is *this conversion's own output*: the
 * path comes back from a third-party process, so it is only accepted when it
 * resolves inside the directory this conversion created, and when the resolved
 * file (symlinks followed) is still inside it. Anything else is refused — a
 * result the process asks us to read from elsewhere is not a result.
 */
function readSavedMarkdown(
  extractPath: string,
  outputDir: string,
): { readonly ok: true; readonly markdown: string } | MineruConversionFailure {
  const resolvedOutput = resolve(outputDir);
  const resolvedPath = resolve(extractPath);
  if (!isInside(resolvedOutput, resolvedPath)) {
    return failure(
      "output_outside_workdir",
      "MinerU 返回的结果文件不在本次转换的工作目录里，出于安全考虑没有读取它。",
      `extract_path=${extractPath} output_dir=${resolvedOutput}`,
    );
  }
  if (!existsSync(resolvedPath) || !statSync(resolvedPath).isFile()) {
    return failure(
      "output_missing",
      "MinerU 说结果已保存到文件，但该文件不存在，这次转换没有拿到完整的 Markdown。",
      `extract_path=${extractPath}`,
    );
  }
  const realPath = realpathSync(resolvedPath);
  if (!isInside(realpathSync(resolvedOutput), realPath)) {
    return failure(
      "output_outside_workdir",
      "MinerU 返回的结果文件实际指向本次转换的工作目录之外，出于安全考虑没有读取它。",
      `extract_path=${extractPath} realpath=${realPath}`,
    );
  }
  const bytes = readFileSync(realPath);
  if (bytes.byteLength > maxMarkdownBytes()) {
    return failure("document_too_large", tooLargeProblem(), `extract_path size=${String(bytes.byteLength)}`);
  }
  try {
    return { ok: true, markdown: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return failure("conversion_failed", "MinerU 返回的结果文件不是合法的 UTF-8 文本，这份转换结果无法入库。", `extract_path=${extractPath}`);
  }
}

/**
 * The largest Markdown this library stores, in bytes.
 *
 * It is the document library's own limit, not this adapter's: a conversion that
 * produces more than the library can hold fails as `document_too_large` with
 * that sentence, because silently trimming it would hand the user a document
 * that only looks complete.
 */
function maxMarkdownBytes(): number {
  return MAX_DOCUMENT_BYTES;
}

function tooLargeProblem(): string {
  return `转换得到的 Markdown 超过文档库的单份上限（${String(Math.round(maxMarkdownBytes() / 1024))} KB）。请拆分这份文件，或只转换其中的部分页面后重试。`;
}

/**
 * Turns the server's own words into the reason the tool would not tell us.
 *
 * Two sources are read together, because the real service splits the reason
 * between them and either may be the one that carries it: the tool's per-entry
 * error (which is where「file page count exceeds API limit (20 pages)」arrives)
 * and the server's stderr (which is where the SDK's exception codes and stack
 * traces land). Both are matched against the same table, and a message that
 * matches nothing stays `conversion_failed` with its text attached — an
 * unrecognised refusal is reported as unrecognised, never guessed at.
 */
function classifyFailure(entryError: string | null, stderrTail: readonly string[]): { readonly code: MineruFailureCode; readonly problem: string } {
  const text = `${entryError ?? ""}\n${stderrTail.join("\n")}`;
  const rules: readonly { readonly match: RegExp; readonly code: MineruFailureCode; readonly problem: string }[] = [
    {
      match: /-30001|FlashFileTooLargeError|file size exceeds|exceeds the size limit|file too large/i,
      code: "flash_file_too_large",
      problem: `文件超过 Flash 模式的大小上限（${String(MINERU_FLASH_MAX_BYTES / 1024 / 1024)} MB）。请压缩文件，或设置 MINERU_API_TOKEN 后重试。`,
    },
    {
      match: /-30003|FlashPageLimitError|page count exceeds|exceeds API limit|too many pages|page_range to specify/i,
      code: "flash_page_limit",
      problem: `文件超过 Flash 模式的页数上限（${String(MINERU_FLASH_MAX_PAGES)} 页）。这个上限下超出的页面不会被解析，所以这份转换被拒绝了；请拆分文件，或设置 MINERU_API_TOKEN 后重试。`,
    },
    {
      match: /-30002|FlashUnsupportedTypeError|unsupported file type/i,
      code: "flash_unsupported_type",
      problem: "Flash 模式不支持这种文件类型。",
    },
    {
      match: /RATE_LIMITED|rate limit/i,
      code: "flash_rate_limited",
      problem: "MinerU 返回了限流（Flash 模式有频率限制）。稍后再试通常就能成功。",
    },
    {
      match: /A0202|A0211|AuthError|NoAuthClientError|401 Unauthorized/i,
      code: "provider_auth",
      problem: "MinerU 拒绝了这次请求的凭据。请检查服务端环境变量 MINERU_API_TOKEN，或去掉它改用 Flash 模式。",
    },
    {
      match: /TIMEOUT|did not complete within|ReadTimeout|PoolTimeout/i,
      code: "conversion_timeout",
      problem: "MinerU 在超时时间内没有返回结果。文件越大越容易超时，可以稍后重试或换一份更小的文件。",
    },
    {
      match: /_ssl|SSLError|ConnectError|ConnectTimeout|ProxyError|EOF occurred|getaddrinfo|NameResolutionError|ConnectionResetError/i,
      code: "network_unavailable",
      problem: "这次转换没有连上 MinerU（网络不可用或被代理拦截）。文档没有被解析，也没有写入文档库。",
    },
  ];
  for (const rule of rules) {
    if (rule.match.test(text)) return { code: rule.code, problem: rule.problem };
  }
  return {
    code: "conversion_failed",
    problem: "MinerU 没有解析成功，而且没有说明原因（它把具体错误只写在自己的日志里）。可以稍后重试。",
  };
}

/** The MCP result block as the tool really shapes it, read field by field. */
interface ParsedToolResult {
  readonly status: string;
  readonly error: string | null;
  readonly entry: {
    readonly status: string;
    readonly error: string | null;
    readonly content: string | null;
    readonly contentChars: number | null;
    readonly truncated: boolean;
    readonly extractPath: string | null;
  } | null;
}

function jsonTextOf(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  const blocks = (result as Record<string, unknown>)["content"];
  if (!Array.isArray(blocks)) return null;
  for (const block of blocks) {
    if (typeof block !== "object" || block === null) continue;
    const record = block as Record<string, unknown>;
    if (record["type"] === "text" && typeof record["text"] === "string") return record["text"];
  }
  return null;
}

/**
 * Reads the tool's answer.
 *
 * The shape is the tool's own (`status` / `results[]` / entry fields), read the
 * way it was observed from the real server rather than assumed: this parser
 * exists so that a result which does not look like that is reported as an
 * unknown shape instead of being mistaken for success.
 */
function parseToolResult(raw: string): ParsedToolResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const status = typeof record["status"] === "string" ? record["status"] : null;
  if (status === null) return null;
  const results = Array.isArray(record["results"]) ? record["results"] : [];
  let entry: ParsedToolResult["entry"] = null;
  // The per-entry error is where the tool states its reason. It matters: for a
  // file over Flash's page ceiling the server answers
  // 「file page count exceeds API limit (20 pages)…」here, and that sentence is
  // the difference between telling the user which limit they hit and telling
  // them nothing at all.
  let firstError: string | null = null;
  for (const item of results) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;
    const rowStatus = typeof row["status"] === "string" ? row["status"] : "unknown";
    const rowError = typeof row["error"] === "string" ? row["error"] : null;
    if (rowStatus !== "success" && firstError === null) firstError = rowError ?? `result status: ${rowStatus}`;
    if (rowStatus === "success" && entry === null) {
      entry = {
        status: rowStatus,
        error: rowError,
        content: typeof row["content"] === "string" ? (row["content"] as string) : null,
        contentChars: typeof row["content_chars"] === "number" ? (row["content_chars"] as number) : null,
        truncated: row["truncated"] === true,
        extractPath: typeof row["extract_path"] === "string" ? (row["extract_path"] as string) : null,
      };
    }
  }
  const topLevelError = typeof record["error"] === "string" ? (record["error"] as string) : null;
  return { status, error: topLevelError ?? firstError, entry };
}

/**
 * Converts one local file to Markdown through the official MinerU MCP server.
 *
 * The caller is responsible for the file being where it claims to be and for
 * having the user's consent; both are checked before this is called, in the
 * conversion job, because that is where the request's identity lives.
 */
export async function convertWithMineru(
  settings: MineruSettings,
  request: MineruConversionRequest,
): Promise<MineruConversionOutcome> {
  if (settings.command === null) {
    return failure(
      "mcp_not_installed",
      "这台机器上没有找到 uvx，无法启动官方的 mineru-open-mcp。请先安装 uv（https://docs.astral.sh/uv/），然后重新发起转换。",
      "uvx not found on PATH and MINERU_MCP_COMMAND is unset",
    );
  }
  const filePath = resolve(request.filePath);
  const outputDir = resolve(request.outputDir);
  if (!isInside(outputDir, filePath)) {
    return failure("output_outside_workdir", "这次转换的源文件不在它自己的工作目录里，出于安全考虑没有执行。", `file=${filePath}`);
  }
  if (!existsSync(filePath)) {
    return failure("output_missing", "上传的原始文件没有找到，这次转换没有执行。", `file=${filePath}`);
  }

  const outcome = await withServer(
    settings,
    async (server) => {
      const args = { file_sources: [filePath], output_dir: outputDir };
      const started = Date.now();
      const result = await server.client.callTool({ name: MINERU_TOOL, arguments: args }, undefined, {
        timeout: settings.callTimeoutMs,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      const durationMs = Date.now() - started;
      const text = jsonTextOf(result);
      const parsed = text === null ? null : parseToolResult(text);
      const call: MineruToolCall = {
        tool: MINERU_TOOL,
        command: commandLine(settings),
        package: settings.packageSpec,
        server: server.server,
        arguments: { file_sources: [filePath], output_dir: outputDir },
        durationMs,
        status: parsed?.status ?? (result.isError === true ? "error" : "unknown"),
        contentChars: parsed?.entry?.contentChars ?? null,
        inlineTruncated: parsed?.entry?.truncated ?? false,
        extractPath: parsed?.entry?.extractPath ?? null,
        stderrTail: server.stderr.tail(12),
      };
      if (result.isError === true && parsed === null) {
        return failure("conversion_failed", "MinerU MCP 返回了一个错误结果，这次转换没有完成。", text ?? "no text content");
      }
      if (parsed === null) {
        return failure(
          "conversion_failed",
          "MinerU MCP 的返回结果不是预期的结构，这次转换没有被采用。",
          (text ?? "no text content").slice(0, 800),
          call,
        );
      }
      if (parsed.entry === null) {
        const classified = classifyFailure(parsed.error, call.stderrTail);
        return failure(
          classified.code,
          classified.problem,
          `${parsed.error ?? "no successful result entry"}\n--- mineru-open-mcp stderr ---\n${server.stderr.tail(20).join("\n")}`,
          call,
        );
      }

      // The inline Markdown is the result when the server did not cut it short.
      // When it did, the full text is in the file the same answer points at —
      // and a truncated body that cannot be completed is a failure, never a
      // document that quietly says less than the file did.
      let markdown = parsed.entry.content ?? "";
      let fromFile = false;
      if (parsed.entry.truncated || markdown.length === 0) {
        if (parsed.entry.extractPath === null) {
          return failure(
            "output_missing",
            "MinerU 截断了返回的 Markdown，但没有给出完整结果的位置，这次转换没有拿到完整内容。",
            "truncated without extract_path",
            call,
          );
        }
        const saved = readSavedMarkdown(parsed.entry.extractPath, outputDir);
        if (saved.ok !== true) return { ...saved, call };
        markdown = saved.markdown;
        fromFile = true;
      }
      if (markdown.trim().length === 0) {
        return failure("markdown_empty", "MinerU 返回了空的 Markdown，这份文件没有被转换。", "empty markdown", call);
      }
      if (Buffer.byteLength(markdown, "utf8") > maxMarkdownBytes()) {
        return failure("document_too_large", tooLargeProblem(), `markdown bytes=${String(Buffer.byteLength(markdown, "utf8"))}`, call);
      }
      return { ok: true as const, markdown, markdownChars: markdown.length, fromFile, call };
    },
    request.signal,
  );
  if ("ok" in outcome && outcome.ok === false) return outcome;
  return outcome as MineruConversionSuccess;
}
