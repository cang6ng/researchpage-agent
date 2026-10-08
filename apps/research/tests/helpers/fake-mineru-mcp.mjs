/**
 * A stand-in for `mineru-open-mcp`, for the tests that cannot spend a network
 * round trip — and only for them.
 *
 * The real acceptance is a real conversion through the official server; this
 * file exists so the *failing* half of the integration can be tested at all.
 * Half of what the adapter has to get right is what happens when the converter
 * says no — a page limit, a dead network, a truncated answer, a saved file — and
 * those cases cannot be produced on demand by a service that is working.
 *
 * It speaks the MCP wire protocol over stdio with the official SDK's low-level
 * server, so the client under test is talking to a real MCP peer with a real
 * `tools/list` and `tools/call` exchange; what is scripted is only *what the
 * tool answers*. `--mode` picks the script (the adapter hands its child only the
 * environment variables it chose to hand it, so the mode travels as an argument
 * rather than in the environment):
 *
 * - `success` (default) — Markdown for the file it was handed
 * - `truncated`          — a short inline body plus the full text saved in `output_dir`
 * - `traverse`           — points `extract_path` outside `output_dir`
 * - `empty`              — success with no Markdown at all
 * - `huge`               — Markdown larger than the document library's limit
 * - `error`              — the failure a file over Flash's page ceiling really
 *                          gets: the reason in the entry, nothing on stderr
 * - `opaque`             — the generic failure with nothing to classify
 * - `rate-limit`         — a 429 line on stderr, generic message in the entry
 * - `network`            — a ConnectError traceback on stderr, generic message
 * - `no-tool`            — a server that does not offer parse_documents
 * - `crash`              — exits without answering
 * - `flaky`              — fails with a page-limit error until the file named by
 *                          `--recover-file` exists, then succeeds
 *
 * `--leak=A…G` makes the failure carry a payload that must never reach a client
 * (a short credential, a long one, a presigned URL, a multi-line HTTP traceback,
 * a fragment of the user's document, an absolute Windows path, an unknown
 * exception); `--leak-stderr=<payload>` logs a payload on an otherwise
 * successful call; `--fail-handshake=<payload>` writes one to stderr and dies
 * before answering. `--marker=<path>` appends one line per tool call.
 *
 * `--markdown` overrides the Markdown it returns, so a test can put a known
 * string (or a known number of characters) into the library. Every successful
 * answer also carries a trailing comment naming the file it was handed and the
 * output directory it was told to use, which is how a test can check that the
 * adapter passed its own controlled paths rather than anything a caller
 * supplied.
 */

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

function option(name, fallback) {
  const prefix = `--${name}=`;
  for (const value of process.argv.slice(2)) {
    if (value.startsWith(prefix)) return value.slice(prefix.length);
  }
  return fallback;
}

const mode = option("mode", "success");
const recoverFile = option("recover-file", "");
/**
 * A file the server appends one line to per tool call, when asked.
 *
 * It is how a test can prove a *negative*: that a whole research run — search,
 * read, snapshot, report — never reached the converter at all. Absence is not
 * observable from a server's answers, only from a server that was never asked.
 */
const marker = option("marker", "");

/**
 * What the server writes into its failure, when a test asks it to leak.
 *
 * `--leak=<key>` puts that payload in the entry's error *and* on stderr, which
 * are the two channels a converter's diagnostics really travel on. The real
 * server does both: it names a reason in the entry and prints stack traces,
 * HTTP request lines and presigned OSS URLs on stderr. A test uses these to
 * check what a *client* can read, not what the server said.
 */
const LEAKS = {
  // A. a short credential — seven characters, the length the token redaction
  //    used to ignore entirely.
  A: "sk-7char",
  // B. a long credential.
  B: "sk-live-9f8e7d6c5b4a39281706f5e4d3c2b1a0",
  // C. a complete presigned object-storage URL, query string included.
  C: "https://mineru.oss-cn-shanghai.aliyuncs.com/api-upload/extract/2026-10-08/agent/8f3a.pdf?Expires=1791551834&OSSAccessKeyId=LTAI5t8fSGMgiRhQn4mpp926&Signature=sEcReTsIgNaTuRe%2BQ%3D",
  // D. a multi-line HTTP SDK traceback with a request URL carrying a key.
  D: [
    "httpx.HTTPStatusError: Client error '401 Unauthorized' for url 'https://api.mineru.example/v1/parse?api_key=SECRETREQUESTKEY'",
    "For more information check: https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/401",
    '  File "httpx\\_client.py", line 914, in send',
    "    response = self._send_handling_auth(request)",
  ].join("\n"),
  // E. a fragment of the user's own document, quoted back inside an error.
  E: "内部机密：这段结论只存在于用户上传的文档里，比如「上下文翻倍时成本涨了三倍」。",
  // F. an absolute path on this machine.
  F: "C:\\Users\\Administrator\\Documents\\私有资料\\尚未公开的论文.pdf",
  // G. an exception nobody has seen before: no rule matches it.
  G: "KeyError: 'markdown_url' —— 一个从未见过的异常类型",
};
const leak = option("leak", "");
const leakPayload = leak === "" ? "" : (LEAKS[leak] ?? "");

/**
 * A payload the server logs on an otherwise *successful* call.
 *
 * This is not hypothetical: the real server logs its own HTTP traffic at INFO,
 * so a presigned URL goes past on the way to a perfectly good result.
 */
const leakStderr = option("leak-stderr", "");

/**
 * A payload written to stderr right before the server dies without answering,
 * so the failure happens during the handshake rather than during a call.
 */
const failHandshake = option("fail-handshake", "");
if (failHandshake !== "") {
  process.stderr.write(`${failHandshake}\n`);
  process.exit(4);
}

const DEFAULT_MARKDOWN = [
  "# 转换得到的 Markdown",
  "",
  "## 第一节",
  "",
  "这份内容来自一个受控的测试 MCP 服务，用来验证适配器在真实协议下的行为。",
  "",
  "## 第二节",
  "",
  "它同样包含足够的段落与标题，供文档库解析目录与段落。",
].join("\n");

function markdown() {
  return option("markdown", DEFAULT_MARKDOWN);
}

function provenance(source, outputDir) {
  return `\n\n<!-- fake-mineru source=${source} output_dir=${outputDir} -->`;
}

if (mode === "crash") {
  // No handshake, no answer: the client sees the process go away.
  process.exit(3);
}

/** The tool's failure shape, exactly as the real server writes it. */
function errorAnswer(name, message) {
  return {
    status: "error",
    results: [{ filename: name, status: "error", error: message }],
    summary: { total_files: 1, success_count: 0, error_count: 1 },
  };
}

const OPAQUE = "Document processing failed. Check server logs for details.";

function answer(args) {
  const sources = Array.isArray(args["file_sources"]) ? args["file_sources"] : [];
  const source = typeof sources[0] === "string" ? sources[0] : "unknown";
  const name = source.split(/[\\/]/).pop() ?? "unknown";
  const outputDir = typeof args["output_dir"] === "string" ? args["output_dir"] : "";
  process.stderr.write(`fake-mineru: parse_documents ${name} output_dir=${outputDir}\n`);
  if (marker !== "") {
    try {
      appendFileSync(marker, `parse_documents ${name}\n`, "utf8");
    } catch {
      // A marker the test cannot write is the test's problem, not the server's.
    }
  }

  if (mode === "error" || (mode === "flaky" && !existsSync(recoverFile))) {
    // What the real service answers for a file over Flash's page ceiling: the
    // reason is in the entry, and nothing about it is on stderr.
    return errorAnswer(name, "file page count exceeds API limit (20 pages), please input page_range to specify the page range");
  }
  if (leakPayload !== "") {
    // Both channels at once, the way a real failure arrives: the entry names a
    // reason, and the server's own log carries the traceback and the URLs.
    process.stderr.write(`mineru - ERROR - Processing failed for ${name}: ${leakPayload}\n`);
    process.stderr.write(`mineru.exceptions.UnknownError: ${leakPayload}\n`);
    if (leak === "G") {
      return {
        status: "error",
        results: [{ filename: name, status: "melted", error: leakPayload }],
        summary: { total_files: 1, success_count: 0, error_count: 1 },
      };
    }
    return errorAnswer(name, leakPayload);
  }
  if (leakStderr !== "") process.stderr.write(`mineru - INFO - HTTP Request: PUT ${leakStderr} "HTTP/1.1 200 OK"\n`);
  if (mode === "opaque") {
    // The same shape with nothing to classify: the adapter must report an
    // unknown refusal rather than invent a cause for it.
    return errorAnswer(name, OPAQUE);
  }
  if (mode === "rate-limit") {
    process.stderr.write("mineru - ERROR - [RATE_LIMITED] flash API rate limit exceeded; try again later\n");
    return errorAnswer(name, OPAQUE);
  }
  if (mode === "network") {
    process.stderr.write(
      "  File \"httpx\\_transports\\default.py\", line 118, in map_httpcore_exceptions\n" +
        "    raise mapped_exc(message) from exc\n" +
        "httpx.ConnectError: EOF occurred in violation of protocol (_ssl.c:1017)\n",
    );
    return errorAnswer(name, OPAQUE);
  }
  if (mode === "empty") {
    return {
      status: "success",
      results: [{ filename: name, status: "success", content: "   ", content_chars: 3, truncated: false }],
      summary: { total_files: 1, success_count: 1, error_count: 0 },
      message: "Parsing complete!\n",
    };
  }

  const body = mode === "huge" ? "# 大文档\n\n" + "字".repeat(200_000) : markdown() + provenance(source, outputDir);
  const entry = { filename: name, status: "success", content: body, content_chars: body.length, truncated: false };
  if (mode === "truncated") {
    const full = markdown() + provenance(source, outputDir) + "\n\n<!-- full -->\n" + "补充段落：".repeat(20);
    mkdirSync(outputDir, { recursive: true });
    const saved = join(outputDir, `${name.replace(/\.[^.]+$/, "")}.md`);
    writeFileSync(saved, full, "utf8");
    entry["content"] = full.slice(0, 40);
    entry["content_chars"] = full.length;
    entry["truncated"] = true;
    entry["extract_path"] = saved;
    process.stderr.write(`fake-mineru: saved truncated markdown to ${saved}\n`);
  }
  if (mode === "traverse") {
    entry["content"] = "";
    entry["truncated"] = true;
    entry["extract_path"] = join(outputDir, "..", "..", "outside.md");
  }
  return {
    status: "success",
    results: [entry],
    summary: { total_files: 1, success_count: 1, error_count: 0 },
    message: "Parsing complete!\n",
  };
}

const tools = [];
if (mode !== "no-tool") {
  tools.push({
    name: "parse_documents",
    title: "Parse documents to Markdown",
    description: "Scripted stand-in for MinerU's parse_documents (see --mode).",
    inputSchema: {
      type: "object",
      properties: {
        file_sources: { type: "array", description: "Files to parse: paths or URLs." },
        enable_ocr: { type: ["boolean", "null"] },
        language: { type: ["string", "null"] },
        model: { type: ["string", "null"] },
        output_dir: { type: ["string", "null"] },
      },
      required: ["file_sources"],
      additionalProperties: false,
    },
  });
}
tools.push({
  name: "get_ocr_languages",
  title: "List OCR language codes",
  description: "Scripted stand-in for MinerU's get_ocr_languages.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
});

const server = new Server(
  { name: "fake-mineru-open-mcp", version: "0.0.1-test" },
  { capabilities: { tools: {} }, instructions: "A scripted stand-in for mineru-open-mcp." },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (name !== "parse_documents") {
    return { content: [{ type: "text", text: JSON.stringify({ status: "success", languages: ["ch", "en"] }) }] };
  }
  // `--delay-ms` makes a conversion take real time, which is how the tests see
  // the queue: a second upload submitted while one is running has to wait for
  // its turn rather than run beside it.
  const delayMs = Number(option("delay-ms", "0"));
  if (Number.isFinite(delayMs) && delayMs > 0) await new Promise((done) => setTimeout(done, delayMs));
  return { content: [{ type: "text", text: JSON.stringify(answer(args ?? {})) }] };
});

await server.connect(new StdioServerTransport());
