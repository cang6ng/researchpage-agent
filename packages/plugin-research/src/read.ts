/**
 * The read layer: what a source actually returned, and how much of it.
 *
 * The rule this module carries is the product's truth boundary: a source is
 * `read` only after a real response was fetched and its text extracted here,
 * and the *scope* it reports is the claim the rest of the product trusts. For
 * an arXiv paper the reader asks for the HTML full text first and falls back to
 * the paper's own abstract page — and it says which of the two happened,
 * because the coverage rules treat an abstract-only read as partial. A PDF that
 * cannot be parsed is a reported failure, never a silent success.
 *
 * For every other page the scope has to be earned, because the same HTTP 200
 * carries two very different things: a paper's full text, and a subscription
 * landing page that renders the abstract, the reference list and the site
 * navigation as ordinary paragraphs. Only the first may be recorded as body
 * text — a reference entry or an abstract quoted as body evidence would let a
 * matrix cell reach「已核对」on material that never contained the claim. So a
 * generic page is passed through `recogniseArticleBody`, and what it does not
 * recognise is not called the body: the page's own abstract, when it states
 * one, is recorded as an `abstract`-scope read with its provenance in the note,
 * and otherwise the read fails and says why.
 *
 * Discovery's own abstract does not change that. When nothing can be fetched at
 * all, the abstract the provider holds is still a real — and partial — read of
 * the work, and it is recorded as one: `abstract`, with the provider named,
 * never as the body.
 */

import {
  ABSTRACT_META_NAMES,
  MIN_ABSTRACT_CHARS,
  pageAbstractOf,
  recogniseArticleBody,
} from "./article.js";
import type { Paragraph, ReadScope } from "./domain.js";
import { extractHtmlDocument, extractPlainText, MAX_DOCUMENT_CHARS, metaContent } from "./html.js";
import { arxivIdOf, PROVIDER_NAMES, type FetchLike, type ResearchProvider } from "./search.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 4_000_000;
const USER_AGENT = "researchpage-agent/0.1 (competition demo; contact: local run)";
const MIN_FULL_TEXT_PARAGRAPHS = 4;

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

interface Attempt {
  readonly url: string;
  readonly kind: "full-text" | "abstract";
  /**
   * Which reading rule applies to the HTML that comes back.
   *
   * `arxiv-html` is a known full-text document: the whole page really is the
   * paper, so its paragraphs stand on their own. `generic` is every other host:
   * nothing there is taken on trust.
   */
  readonly structure: "arxiv-html" | "generic";
}

function attemptsFor(request: ReadRequest): Attempt[] {
  const id = arxivIdOf(request.url);
  if (id !== undefined) {
    return [
      { url: `https://arxiv.org/html/${id}`, kind: "full-text", structure: "arxiv-html" },
      { url: `https://arxiv.org/abs/${id}`, kind: "abstract", structure: "generic" },
    ];
  }
  return [{ url: request.url, kind: "full-text", structure: "generic" }];
}

/**
 * Reads one source: the paper's own HTML full text first, its abstract page
 * second, an abstract the page or discovery states third, and an explicit
 * failure when none of those produced text.
 */
export async function readSource(request: ReadRequest, options: ReaderOptions = {}): Promise<ReadOutcome> {
  const now = options.now ?? (() => new Date());
  const notes: string[] = [];

  /** An abstract-level outcome: one paragraph, and a note that says so. */
  const abstractRead = (input: {
    readonly text: string;
    readonly readUrl: string;
    readonly title: string;
    readonly contentType: string;
    readonly note: string;
  }): ReadOutcome => {
    const paragraph: Paragraph = {
      index: 0,
      headingPath: ["Abstract"],
      text: input.text,
      charStart: 0,
      charEnd: input.text.length,
    };
    return {
      status: "ok",
      readUrl: input.readUrl,
      fetchedAt: now().toISOString(),
      title: input.title,
      scope: "abstract",
      text: input.text,
      paragraphs: [paragraph],
      contentType: input.contentType,
      note: `${notes.length > 0 ? `${notes.join("；")}；` : ""}${input.note}`,
      failure: null,
    };
  };

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
      const document = extractHtmlDocument(answer.text);

      if (attempt.kind === "abstract") {
        const abstract = metaContent(answer.text, ABSTRACT_META_NAMES);
        if (abstract === undefined || abstract.length < 80) {
          notes.push(`${attempt.url}：未取得可用的摘要文本`);
          continue;
        }
        return abstractRead({
          text: abstract,
          readUrl: answer.finalUrl,
          title: document.title,
          contentType: answer.contentType,
          note: "取得论文摘要页真实摘要（abstract 级读取）",
        });
      }

      if (attempt.structure === "arxiv-html") {
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

      // Any other host has to *show* the paper's body before the read may be
      // recorded as body-level. A publisher's landing page renders its abstract,
      // its reference list and its navigation as ordinary paragraphs; counting
      // those as full text is how a reference entry becomes body evidence.
      const declared = pageAbstractOf(document, metaContent(answer.text, ABSTRACT_META_NAMES));
      const held = (request.metadata?.abstract ?? "").replace(/\s+/g, " ").trim();
      const abstract =
        declared ??
        (request.metadata !== undefined && held.length >= MIN_ABSTRACT_CHARS
          ? { text: held, source: `${PROVIDER_NAMES[request.metadata.provider]} 返回的论文摘要` }
          : undefined);
      const body = recogniseArticleBody(document, { abstractChars: abstract?.text.length ?? 0 });
      if (body.recognised) {
        return {
          status: "ok",
          readUrl: answer.finalUrl,
          fetchedAt: now().toISOString(),
          title: document.title,
          scope: body.truncated ? "body_excerpt" : "full_text",
          text: body.text,
          paragraphs: body.paragraphs,
          contentType: answer.contentType,
          note: `按 ${body.truncated ? "body_excerpt" : "full_text"} 记录：${body.reason}`,
          failure: null,
        };
      }

      if (abstract !== undefined) {
        return abstractRead({
          text: abstract.text,
          readUrl: answer.finalUrl,
          title: document.title,
          contentType: answer.contentType,
          note: `该页面没有可读正文（${body.reason}），改用${abstract.source}并记录为 abstract 级读取（摘要不是正文，不能当作正文证据）`,
        });
      }
      notes.push(`${attempt.url}：${body.reason}`);
      continue;
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
    return abstractRead({
      text: abstract,
      readUrl: (metadata.workUrl ?? "").trim().length > 0 ? (metadata.workUrl as string) : request.url,
      title: (metadata.title ?? "").trim(),
      contentType: "application/json",
      note: `未能取得可读正文，改用 ${PROVIDER_NAMES[metadata.provider]} 返回的论文摘要（abstract 级读取：不是正文，不能当作正文证据）`,
    });
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
