/**
 * HTML → readable document text, with the position of every paragraph kept.
 *
 * This is the read layer's own extraction, not a browser and not a library: the
 * page that arrives is untrusted, and what this module produces is the text a
 * reader (and later an evidence excerpt) is allowed to quote. Two properties
 * matter and both are tested: the paragraph text is a *substring* of the
 * normalized document text with the recorded character range, and nothing from
 * `<script>`/`<style>`/comments ever reaches that text.
 *
 * The extractor is deliberately heuristic — headings, paragraphs and table
 * cells — because the honest alternative (a full layout engine) is out of scope
 * and would not change what an excerpt means. What it must never do is invent
 * text: every character it emits comes from the response body.
 */

import type { Paragraph } from "./domain.js";

export interface ExtractedDocument {
  readonly title: string;
  readonly paragraphs: readonly Paragraph[];
  /** The paragraph texts joined by a blank line; excerpts index into this. */
  readonly text: string;
  readonly truncated: boolean;
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  middot: "·",
  times: "×",
  minus: "−",
  deg: "°",
  plusmn: "±",
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ε",
  theta: "θ",
  lambda: "λ",
  mu: "μ",
  pi: "π",
  sigma: "σ",
  tau: "τ",
  phi: "φ",
  omega: "ω",
  Delta: "Δ",
  Sigma: "Σ",
  Omega: "Ω",
  le: "≤",
  ge: "≥",
  ne: "≠",
  asymp: "≈",
  infin: "∞",
  larr: "←",
  rarr: "→",
  harr: "↔",
});

/** XML/HTML entity decoding, numeric forms included. Unknown names stay literal. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

/** Whitespace normalization inside one paragraph, never across paragraphs. */
function normalizeInline(text: string): string {
  return decodeEntities(text).replace(/[\t\r\n\f\v\u00a0]+/g, " ").replace(/ {2,}/g, " ").trim();
}

const DROP_ELEMENTS = ["script", "style", "noscript", "template", "svg", "iframe", "head"] as const;

function dropElement(html: string, tag: string): string {
  const pattern = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}\\s*>`, "gi");
  return html.replace(pattern, " ");
}

interface TagToken {
  readonly name: string;
  readonly closing: boolean;
  readonly attrs: Readonly<Record<string, string>>;
}

function parseTag(raw: string): TagToken | undefined {
  const match = /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9:-]*)([\s\S]*?)\/?\s*>$/.exec(raw);
  if (match === null) return undefined;
  const closing = match[1] === "/";
  const name = (match[2] ?? "").toLowerCase();
  const attrText = match[3] ?? "";
  const attrs: Record<string, string> = {};
  const attrPattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let attr: RegExpExecArray | null;
  while ((attr = attrPattern.exec(attrText)) !== null) {
    const key = (attr[1] ?? "").toLowerCase();
    const value = attr[3] ?? attr[4] ?? attr[5] ?? "";
    attrs[key] = decodeEntities(value);
  }
  return { name, closing, attrs };
}

const BLOCK_BOUNDARY = new Set([
  "p",
  "li",
  "dt",
  "dd",
  "div",
  "section",
  "article",
  "aside",
  "blockquote",
  "pre",
  "figcaption",
  "figure",
  "table",
  "tr",
  "td",
  "th",
  "caption",
  "ul",
  "ol",
  "dl",
  "header",
  "footer",
  "main",
  "br",
  "hr",
]);

const HEADING_LEVELS: Readonly<Record<string, number>> = Object.freeze({
  h1: 1,
  h2: 2,
  h3: 3,
  h4: 4,
  h5: 5,
  h6: 6,
});

/** The max characters kept from one document; beyond it a read is an excerpt. */
export const MAX_DOCUMENT_CHARS = 900_000;

/**
 * Extracts the readable document from one HTML response.
 *
 * Headings build a stack that each paragraph inherits, so an excerpt can say
 * which section it came from without any page-specific rules. Table cells become
 * `cell | cell` lines inside their row, because a results table is evidence too.
 */
export function extractHtmlDocument(html: string, options: { readonly titleHint?: string } = {}): ExtractedDocument {
  // The document title is read *before* the `<head>` is dropped: a page's
  // `<title>` is its own statement of what it is, and losing it to the
  // boilerplate filter would leave every extraction to guess from an `<h1>`.
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);

  let source = html;
  for (const tag of DROP_ELEMENTS) source = dropElement(source, tag);
  source = source.replace(/<!--[\s\S]*?-->/g, " ");

  const h1Match = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(source);
  const rawTitle = titleMatch?.[1] ?? h1Match?.[1] ?? options.titleHint ?? "";
  const title = normalizeInline(rawTitle.replace(/<[^>]*>/g, " "));

  const paragraphs: { headingPath: readonly string[]; text: string }[] = [];
  // A level-indexed heading stack. Levels a document skips stay holes, and a
  // hole must never travel: a paragraph's path is built by *collecting* the
  // levels that hold text, so a document that starts at `<h3>` still yields a
  // path of real strings rather than an array with undefined in it.
  const headings: (string | undefined)[] = [];
  let buffer = "";
  let pendingHeadingLevel: number | null = null;

  const headingPath = (): string[] => {
    const path: string[] = [];
    for (const part of headings) {
      if (typeof part === "string" && part.length > 0) path.push(part);
    }
    return path;
  };

  const flush = (): void => {
    const text = normalizeInline(buffer);
    buffer = "";
    if (text.length === 0) return;
    if (pendingHeadingLevel !== null) {
      headings.length = pendingHeadingLevel - 1;
      headings[pendingHeadingLevel - 1] = text;
      pendingHeadingLevel = null;
      return;
    }
    paragraphs.push({ headingPath: headingPath(), text });
  };

  const tagPattern = /<[^>]*>/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(source)) !== null) {
    const textRun = source.slice(cursor, match.index);
    if (textRun.length > 0) buffer += textRun;
    cursor = match.index + match[0].length;

    const token = parseTag(match[0]);
    if (token === undefined) continue;
    const level = HEADING_LEVELS[token.name];
    if (level !== undefined) {
      // Both open and close end the run: `<h2>Title</h2>` sets the heading,
      // and any paragraph after it inherits the new path.
      if (!token.closing) {
        flush();
        pendingHeadingLevel = level;
        continue;
      }
      flush();
      continue;
    }
    if (token.name === "math" || token.name === "img") {
      const alt = token.attrs["alttext"] ?? token.attrs["alt"];
      if (alt !== undefined && alt.length > 0) buffer += ` ${alt} `;
      continue;
    }
    if (BLOCK_BOUNDARY.has(token.name)) {
      flush();
      continue;
    }
  }
  flush();

  // Join with blank lines, and record the exact range each paragraph occupies in
  // that text: the excerpt/quote checks are substring checks against it.
  const located: Paragraph[] = [];
  let text = "";
  for (const paragraph of paragraphs) {
    if (paragraph.text.length === 0) continue;
    if (text.length > 0) text += "\n\n";
    const charStart = text.length;
    text += paragraph.text;
    located.push({
      index: located.length,
      headingPath: paragraph.headingPath,
      text: paragraph.text,
      charStart,
      charEnd: text.length,
    });
    if (text.length > MAX_DOCUMENT_CHARS) {
      return {
        title: title.length > 0 ? title : options.titleHint ?? "",
        paragraphs: located,
        text,
        truncated: true,
      };
    }
  }

  return {
    title: title.length > 0 ? title : options.titleHint ?? "",
    paragraphs: located,
    text,
    truncated: false,
  };
}

/** Plain text (already text/plain or markdown): split on blank lines. */
export function extractPlainText(text: string): ExtractedDocument {
  const normalized = text.replace(/\r\n/g, "\n");
  const chunks = normalized.split(/\n{2,}/);
  const located: Paragraph[] = [];
  let joined = "";
  let truncated = false;
  for (const chunk of chunks) {
    const clean = chunk.trim();
    if (clean.length === 0) continue;
    if (joined.length > 0) joined += "\n\n";
    const charStart = joined.length;
    joined += clean;
    located.push({ index: located.length, headingPath: [], text: clean, charStart, charEnd: joined.length });
    if (joined.length > MAX_DOCUMENT_CHARS) {
      truncated = true;
      break;
    }
  }
  return { title: "", paragraphs: located, text: joined, truncated };
}
