/**
 * The read layer: what a source actually returned, and how much of it.
 *
 * The rule this module carries is the product's truth boundary: a source is
 * `read` only after a real response was fetched and its text extracted here.
 * For an arXiv paper the reader first asks for the HTML full text and, when the
 * publisher does not offer one, falls back to the paper's own abstract page —
 * and it *says which of the two happened*, because the coverage rules treat an
 * abstract-only read as partial. A PDF that cannot be parsed is a reported
 * failure, never a silent success.
 *
 * The third route exists because a fallback provider can locate papers this
 * reader cannot fetch (a paywalled publisher page, a PDF-only record, an arXiv
 * outage). When discovery already holds the paper's own abstract, that abstract
 * is read as an `abstract`-scope document with its provenance in the note —
 * partial, honest, and never body-level evidence. When there is no such
 * abstract either, the read fails and says why.
 */

import type { Paragraph, ReadScope } from "./domain.js";
import { extractHtmlDocument, extractPlainText, MAX_DOCUMENT_CHARS } from "./html.js";
import { arxivIdOf, PROVIDER_NAMES, type FetchLike, type ResearchProvider } from "./search.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 4_000_000;
const USER_AGENT = "researchpage-agent/0.1 (competition demo; contact: local run)";
const MIN_FULL_TEXT_PARAGRAPHS = 4;
/** The shortest abstract this reader will accept as a real one. */
const MIN_ABSTRACT_CHARS = 120;

/**
 * What discovery already knows about the work being read.
 *
 * It exists for the sources a reader can locate but not fetch — a paywalled
 * publisher page, a PDF-only open-access record, an arXiv outage on the day the
 * paper is read. The abstract in here came from the discovery provider's own
 * record of the paper, so it may be stored as an *abstract-level* read with the
 * provenance said out loud; it may never be presented as the paper's body, and
 * the coverage rules already treat it as partial.
 */
export interface ReadMetadata {
  readonly provider: ResearchProvider;
  /** The provider's record of this work (its API request URL). */
  readonly workUrl?: string | null;
  readonly title?: string | null;
  readonly abstract?: string | null;
  readonly doi?: string | null;
}

export interface ReadRequest {
  /** The address to read; an arXiv abs/PDF URL is upgraded to full text first. */
  readonly url: string;
  /** What discovery already knows, for the paths where nothing can be fetched. */
  readonly metadata?: ReadMetadata;
}

export interface ReadOutcome {
  readonly status: "ok" | "failed";
  /** The URL that was actually fetched for the text that came back. */
  readonly readUrl: string;
  readonly fetchedAt: string;
  readonly title: string;
  readonly scope: ReadScope | null;
  readonly text: string;
  readonly paragraphs: readonly Paragraph[];
  readonly contentType: string;
  /** What happened, in a sentence: which route was taken, or why it failed. */
  readonly note: string;
  readonly failure: string | null;
}

export interface ReaderOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly fetchImpl?: FetchLike;
  readonly now?: () => Date;
  /** The largest response this reader will accept, in bytes. */
  readonly maxBytes?: number;
}

async function fetchText(
  url: string,
  options: ReaderOptions,
): Promise<{ ok: true; text: string; contentType: string; finalUrl: string } | { ok: false; failure: string; contentType: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5" },
      signal,
      redirect: "follow",
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "network failure";
    return { ok: false, failure: `请求失败：${reason}`, contentType: "" };
  }

  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES;
  const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    return {
      ok: false,
      failure: `响应体过大（${declared} 字节 > 上限 ${maxBytes}）`,
      contentType,
    };
  }
  if (!response.ok) {
    return { ok: false, failure: `HTTP ${response.status}`, contentType };
  }

  let buffer: ArrayBuffer;
  try {
    buffer = await response.arrayBuffer();
  } catch (error) {
    const reason = error instanceof Error ? error.message : "body failure";
    return { ok: false, failure: `读取响应体失败：${reason}`, contentType };
  }
  if (buffer.byteLength > maxBytes) {
    return { ok: false, failure: `响应体过大（${buffer.byteLength} 字节 > 上限 ${maxBytes}）`, contentType };
  }
  return {
    ok: true,
    text: Buffer.from(buffer).toString("utf8"),
    contentType,
    finalUrl: response.url === "" ? url : response.url,
  };
}

function abstractFromAbsPage(html: string): string | undefined {
  const match = /<meta\s+name="citation_abstract"\s+content="([\s\S]*?)"\s*\/?>/i.exec(html);
  if (match === null) return undefined;
  const decoded = (match[1] ?? "")
    .replace(/&#x([0-9a-fA-F]+);/g, (_whole, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_whole, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  return decoded.length === 0 ? undefined : decoded;
}

interface Attempt {
  readonly url: string;
  readonly kind: "full-text" | "abstract";
}

function attemptsFor(request: ReadRequest): Attempt[] {
  const id = arxivIdOf(request.url);
  if (id !== undefined) {
    return [
      { url: `https://arxiv.org/html/${id}`, kind: "full-text" },
      { url: `https://arxiv.org/abs/${id}`, kind: "abstract" },
    ];
  }
  return [{ url: request.url, kind: "full-text" }];
}

function paragraphsToText(paragraphs: readonly Paragraph[]): string {
  return paragraphs.map((paragraph) => paragraph.text).join("\n\n");
}

/**
 * Reads one source: HTML full text first, the paper's own abstract page second,
 * and an explicit failure when neither produced text.
 */
export async function readSource(request: ReadRequest, options: ReaderOptions = {}): Promise<ReadOutcome> {
  const now = options.now ?? (() => new Date());
  const notes: string[] = [];

  for (const attempt of attemptsFor(request)) {
    const answer = await fetchText(attempt.url, options);
    if (!answer.ok) {
      notes.push(`${attempt.url}：${answer.failure}`);
      continue;
    }

    const isHtml =
      answer.contentType.includes("text/html") ||
      answer.contentType.includes("application/xhtml") ||
      answer.contentType === "";

    if (isHtml) {
      if (attempt.kind === "abstract") {
        const abstract = abstractFromAbsPage(answer.text);
        if (abstract === undefined || abstract.length < 80) {
          notes.push(`${attempt.url}：未取得可用的摘要文本`);
          continue;
        }
        const paragraph: Paragraph = {
          index: 0,
          headingPath: ["Abstract"],
          text: abstract,
          charStart: 0,
          charEnd: abstract.length,
        };
        return {
          status: "ok",
          readUrl: answer.finalUrl,
          fetchedAt: now().toISOString(),
          title: extractHtmlDocument(answer.text).title,
          scope: "abstract",
          text: abstract,
          paragraphs: [paragraph],
          contentType: answer.contentType,
          note: `${notes.length > 0 ? `${notes.join("；")}；` : ""}取得论文摘要页真实摘要（abstract 级读取）`,
          failure: null,
        };
      }

      const document = extractHtmlDocument(answer.text);
      if (document.paragraphs.length < MIN_FULL_TEXT_PARAGRAPHS) {
        notes.push(`${attempt.url}：正文段落过少（${document.paragraphs.length}），可能不是可读正文`);
        continue;
      }
      return {
        status: "ok",
        readUrl: answer.finalUrl,
        fetchedAt: now().toISOString(),
        title: document.title,
        scope: document.truncated || document.text.length >= MAX_DOCUMENT_CHARS ? "body_excerpt" : "full_text",
        text: document.text,
        paragraphs: document.paragraphs,
        contentType: answer.contentType,
        note: document.truncated
          ? "取得正文但超过长度上限，按 body_excerpt 记录（已截断）"
          : "取得公开 HTML 正文并以 full_text 记录",
        failure: null,
      };
    }

    if (answer.contentType.includes("application/pdf")) {
      notes.push(`${attempt.url}：返回 PDF，首版不解析 PDF 正文`);
      continue;
    }

    // Plain text, markdown, or a JSON/text document: the response body is the text.
    const document = extractPlainText(answer.text);
    if (document.paragraphs.length === 0) {
      notes.push(`${attempt.url}：未提取到可用文本`);
      continue;
    }
    return {
      status: "ok",
      readUrl: answer.finalUrl,
      fetchedAt: now().toISOString(),
      title: document.title,
      scope: document.truncated ? "body_excerpt" : "full_text",
      text: document.text,
      paragraphs: document.paragraphs,
      contentType: answer.contentType,
      note: `按纯文本读取（${answer.contentType}）`,
      failure: null,
    };
  }

  // Nothing could be fetched. If discovery already holds the paper's own
  // abstract, that is a real — and partial — read of the paper, and saying so
  // is better than reporting a bare failure: the material can be assessed, the
  // coverage rules keep it below body-level, and the reader learns which of the
  // two happened. What is never done here is dressing the abstract up as the
  // body, or turning a failed fetch into a silent success.
  const metadata = request.metadata;
  const abstract = (metadata?.abstract ?? "").replace(/\s+/g, " ").trim();
  if (metadata !== undefined && abstract.length >= MIN_ABSTRACT_CHARS) {
    const paragraph: Paragraph = {
      index: 0,
      headingPath: ["Abstract"],
      text: abstract,
      charStart: 0,
      charEnd: abstract.length,
    };
    const title = (metadata.title ?? "").trim();
    return {
      status: "ok",
      readUrl: (metadata.workUrl ?? "").trim().length > 0 ? (metadata.workUrl as string) : request.url,
      fetchedAt: now().toISOString(),
      title,
      scope: "abstract",
      text: abstract,
      paragraphs: [paragraph],
      contentType: "application/json",
      note: `${notes.length > 0 ? `${notes.join("；")}；` : ""}未能取得可读正文，改用 ${PROVIDER_NAMES[metadata.provider]} 返回的论文摘要（abstract 级读取：不是正文，不能当作正文证据）`,
      failure: null,
    };
  }

  return {
    status: "failed",
    readUrl: request.url,
    fetchedAt: now().toISOString(),
    title: "",
    scope: null,
    text: "",
    paragraphs: [],
    contentType: "",
    note: notes.join("；"),
    failure: notes.length === 0 ? "没有可尝试的读取地址" : notes[notes.length - 1] ?? "读取失败",
  };
}