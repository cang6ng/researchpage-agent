/**
 * Which part of a fetched page is a paper's body — and the words for when none
 * of it is.
 *
 * A publisher's landing page and a paper's full text arrive as the same kind of
 * thing: HTTP 200 with `text/html`. Nothing on the wire separates them. A
 * subscription page renders the title, the abstract, the reference list, the
 * author block and the site navigation, and the body sits behind the paywall —
 * yet it extracts into hundreds of paragraphs, so paragraph count, response
 * size and HTTP status cannot tell the two apart. Neither can `<article>`:
 * publishers wrap the landing page in one too.
 *
 * What a real full text has and a landing page does not is *sections a paper is
 * made of*. So this module asks that narrower question, and answers it
 * conservatively, from an allow-list of section names rather than a denylist of
 * the chrome: a page nobody has seen cannot be trusted to label its own
 * non-body parts, and an unrecognised page must degrade honestly (to an
 * abstract-level read, or to a reported failure) rather than pass as the body.
 *
 * Three further requirements keep a preview from clearing the bar: the body
 * must span at least two distinct sections, hold a real amount of prose, and
 * hold more prose than the abstract the page states. A paywalled page's teaser
 * — one section, a few hundred characters, about as long as its abstract —
 * fails on all three.
 */

import type { Paragraph } from "./domain.js";
import { MAX_DOCUMENT_CHARS, type ExtractedDocument } from "./html.js";

/** The shortest text this module will call an abstract. */
export const MIN_ABSTRACT_CHARS = 120;
/** The longest text it will call one: beyond this a section is not an abstract. */
export const MAX_ABSTRACT_CHARS = 4_000;
/** How many paragraphs an abstract may span before it looks like something else. */
const MAX_ABSTRACT_PARAGRAPHS = 8;

/** The fewest distinct paper sections a body must show. */
export const MIN_BODY_SECTIONS = 2;
/** The fewest prose paragraphs a body must hold. */
export const MIN_BODY_PARAGRAPHS = 4;
/** The fewest characters of prose a body must hold. */
export const MIN_BODY_CHARS = 1_500;
/**
 * How much longer than the abstract a body has to be.
 *
 * A landing page that previews the first section renders roughly as much text
 * as its abstract; a real full text is many times longer. Requiring a multiple
 * is what separates the two without trusting any single count.
 */
export const MIN_BODY_OVER_ABSTRACT = 2;

/**
 * Headings that are never a paper's body.
 *
 * Most of these matter because they would otherwise match a body word: a
 * "Data availability" section contains "data", "Author contributions" contains
 * "contributions", "Supplementary materials" contains "materials". The rest are
 * chrome that a page can render as a heading — access options, metrics,
 * citation tools — and none of them is prose the product may quote as the body.
 *
 * The check runs over the whole heading path, not just the deepest heading, so
 * a "Data sources" sub-heading under "References" stays out of the body.
 */
const NON_ARTICLE_HEADINGS: ReadonlySet<string> = new Set(
  [
    // Front matter and metadata blocks.
    "abstract",
    "abstracts",
    "summary",
    "executive summary",
    "graphical abstract",
    "highlights",
    "keywords",
    "key words",
    "abbreviations",
    "acronyms",
    "contents",
    "table of contents",
    // Reference lists and citation blocks.
    "references",
    "reference",
    "bibliography",
    "literature cited",
    "works cited",
    "citations",
    "citation",
    "cite this article",
    "how to cite",
    "export citation",
    "download citation",
    // Author and article administration.
    "acknowledgements",
    "acknowledgments",
    "acknowledgement",
    "acknowledgment",
    "author information",
    "author details",
    "author contributions",
    "contributions",
    "authors and affiliations",
    "corresponding author",
    "affiliations",
    "competing interests",
    "conflicts of interest",
    "conflict of interest",
    "declaration of interests",
    "declaration of competing interest",
    "declarations",
    "declaration",
    "ethics",
    "ethics declarations",
    "ethics statement",
    "ethical approval",
    "consent to participate",
    "additional information",
    "article information",
    "rights and permissions",
    "reprints and permissions",
    "permissions",
    "reprints",
    "about this article",
    "about the journal",
    "about the authors",
    // Sustainability of the work, which is not the work.
    "funding",
    "funding information",
    "funding statement",
    "funding sources",
    "financial support",
    "grant support",
    "data availability",
    "data availability statement",
    "availability of data and materials",
    "data and materials availability",
    "code availability",
    "code availability statement",
    "software availability",
    "supplementary information",
    "supplementary materials",
    "supplementary material",
    "supplementary data",
    "supporting information",
    "associated data",
    "associated content",
    // Site chrome, metrics and discovery furniture.
    "metrics",
    "article metrics",
    "citation metrics",
    "altmetric",
    "comments",
    "related articles",
    "related content",
    "related information",
    "recommended articles",
    "similar content",
    "similar content being viewed by others",
    "explore related subjects",
    "you might also like",
    "articles by this author",
    "most read",
    "most cited",
    "news",
    "events",
    "press release",
    "editor's summary",
    "plain language summary",
    "lay summary",
    "peer review",
    "peer review file",
    "reviewer information",
    "editor information",
    "editorial information",
    "editorial board",
    "editorial policies",
    "journal information",
    "journal metrics",
    "indexing",
    "abstracting and indexing",
    "submission guidelines",
    "instructions for authors",
    "author guidelines",
    "search",
    "menu",
    "navigation",
    "quick links",
    "explore content",
    "publish with us",
    "footer",
    "footer links",
    "access options",
    "additional access options",
    "access this article",
    "subscribe",
    "subscription",
    "sign in",
    "log in",
    "register",
    "purchase",
    "download pdf",
    "share this article",
  ].map((heading) => heading.toLowerCase()),
);

/**
 * Heading prefixes that are never the body.
 *
 * These carry either a body word in a longer phrase ("data availability and
 * accession codes", "supplementary materials and methods") or a family of
 * headings too large to list one by one (the many forms of a reference list).
 */
const NON_ARTICLE_PREFIXES: readonly string[] = Object.freeze([
  "supplementary",
  "supplemental",
  "supporting information",
  "associated data",
  "availability of data",
  "availability of code",
  "data availability",
  "data and code availability",
  "data and materials availability",
  "references",
  "reference list",
  "bibliography",
  "literature cited",
  "works cited",
  "cited by",
  "citation",
  "citations",
  "acknowledg",
  "author information",
  "author contribution",
  "affiliation",
  "conflict",
  "competing interest",
  "declaration",
  "ethics",
  "funding",
  "financial support",
  "grant support",
  "about this",
  "about the",
  "cite this",
  "share this",
  "download",
  "access options",
  "additional access",
  "related article",
  "related content",
  "related information",
  "recommended",
  "similar content",
  "you might also like",
  "most read",
  "most cited",
  "metrics",
  "altmetric",
  "peer review",
  "reviewer",
  "editorial",
  "journal information",
  "indexing",
  "abstracting",
  "instructions for authors",
  "submission guidelines",
  "author guidelines",
  "rights and permissions",
  "reprints",
  "erratum",
  "correction",
  "retraction",
]);

/**
 * Section names a paper's body is made of.
 *
 * Matching is whole-word containment in the heading, so "3.1 Evaluation setup"
 * and "Results and discussion" both count while "Data availability" is already
 * excluded above. The list is a set of names a paper really uses, not an
 * attempt to cover every possible heading: a page that names its sections
 * something else degrades honestly instead of being guessed at.
 */
const BODY_STEMS: readonly string[] = Object.freeze([
  // Framing.
  "introduction",
  "introductions",
  "background",
  "motivation",
  "rationale",
  "problem statement",
  "problem formulation",
  "problem definition",
  "preliminaries",
  "preliminary",
  "terminology",
  "notation",
  "overview",
  "related work",
  "related works",
  "literature review",
  "prior work",
  "previous work",
  "state of the art",
  // Method and system.
  "method",
  "methods",
  "methodology",
  "methodologies",
  "materials and methods",
  "material and methods",
  "materials and method",
  "methods and materials",
  "approach",
  "model",
  "models",
  "modeling",
  "modelling",
  "architecture",
  "framework",
  "system",
  "systems",
  "design",
  "implementation",
  "implementations",
  "algorithm",
  "algorithms",
  "protocol",
  "protocols",
  "theory",
  "theoretical analysis",
  // Data, setting and execution.
  "data",
  "data collection",
  "data and methods",
  "dataset",
  "datasets",
  "materials",
  "study design",
  "participants",
  "subjects",
  "procedure",
  "procedures",
  "setup",
  "settings",
  "study",
  "studies",
  "experiment",
  "experiments",
  "experimental",
  "experimental setup",
  "experimental design",
  "experimental procedures",
  "evaluation",
  "evaluations",
  "empirical evaluation",
  "performance evaluation",
  "assessment",
  "analysis",
  "analyses",
  "formal analysis",
  "statistical analysis",
  "data analysis",
  "qualitative analysis",
  "quantitative analysis",
  "benchmark",
  "benchmarks",
  "ablation",
  "ablation study",
  "case study",
  "case studies",
  "use case",
  "use cases",
  // Findings and closing.
  "result",
  "results",
  "results and discussion",
  "results and analysis",
  "findings",
  "main results",
  "experimental results",
  "discussion",
  "discussions",
  "general discussion",
  "conclusion",
  "conclusions",
  "concluding remarks",
  "concluding",
  "limitations",
  "threats to validity",
  "future work",
  "recommendations",
  "contributions",
  "our contributions",
  "application",
  "applications",
]);

/**
 * Headings that state a work's own abstract.
 *
 * "Summary" counts because journals use it for the same block; a page whose
 * summary is something else is still read at abstract scope, never at body
 * scope, so the cost of the assumption is a partial read rather than a false
 * one.
 */
const ABSTRACT_HEADINGS: ReadonlySet<string> = new Set(["abstract", "abstracts", "summary", "摘要"]);

/**
 * Meta tags a publisher uses to declare a work's own abstract.
 *
 * Ordered: the citation-format name is the most explicit statement, the Dublin
 * Core description is the loosest, and the note says which one was used so a
 * reader can audit the read. Only names that declare an abstract are here — a
 * plain `description` or `og:description` tag is often a site blurb rather than
 * the paper's abstract, and it is deliberately not accepted.
 */
export const ABSTRACT_META_NAMES: readonly string[] = Object.freeze([
  "citation_abstract",
  "dcterms.abstract",
  "dc.abstract",
  "dcterms.description",
  "dc.description",
]);

/** A heading reduced to the words a rule can match: numbering and punctuation gone. */
export function normaliseHeading(raw: string): string {
  let text = raw.replace(/\s+/g, " ").trim().toLowerCase();
  for (let pass = 0; pass < 2; pass += 1) {
    text = text
      .replace(/^(?:section|chapter|part)\s+/i, "")
      .replace(/^(?:\d+(?:\.\d+)*|[ivxlc]+)\s*[.)、．:：]?\s+/, "");
  }
  return text.replace(/[.:;、，,\s]+$/g, "").trim();
}

function escapeForPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const BODY_STEM_PATTERN = new RegExp(`\\b(?:${BODY_STEMS.map(escapeForPattern).join("|")})\\b`);

/** Whole-word containment, so "systematic" is not a "system" section. */
function hasBodyStem(normalised: string): boolean {
  return normalised.length > 0 && BODY_STEM_PATTERN.test(normalised);
}

function isNonArticle(normalised: string): boolean {
  if (NON_ARTICLE_HEADINGS.has(normalised)) return true;
  return NON_ARTICLE_PREFIXES.some((prefix) => normalised.startsWith(prefix));
}

/** Whether one heading (numbering and all) names a section of a paper's body. */
export function isArticleBodyHeading(raw: string): boolean {
  const heading = normaliseHeading(raw);
  return heading.length > 0 && !isNonArticle(heading) && hasBodyStem(heading);
}

/** Whether one heading names something that is never a paper's body. */
export function isNonArticleHeading(raw: string): boolean {
  const heading = normaliseHeading(raw);
  return heading.length > 0 && isNonArticle(heading);
}

/** Whether one heading states a work's own abstract. */
export function isAbstractHeading(raw: string): boolean {
  return ABSTRACT_HEADINGS.has(normaliseHeading(raw));
}

export interface ArticleBody {
  readonly recognised: boolean;
  /** The body paragraphs alone, renumbered and re-located in `text`. */
  readonly paragraphs: readonly Paragraph[];
  readonly text: string;
  /** The distinct section headings the body was assembled from. */
  readonly sections: readonly string[];
  readonly chars: number;
  /** True when the page's own extraction was cut off, so the body is partial. */
  readonly truncated: boolean;
  /** One sentence: what was recognised, or which requirement it failed. */
  readonly reason: string;
}

export interface BodyRecognitionOptions {
  /**
   * How long the abstract already in hand is, when there is one.
   *
   * A body has to be substantially longer than the abstract, because a page
   * that previews its first section renders about as much text as its abstract
   * does. Zero means no abstract is known and only the absolute floors apply.
   */
  readonly abstractChars?: number;
}

/** Rejoins selected paragraphs, keeping the excerpt ranges true to the new text. */
function rejoin(paragraphs: readonly Paragraph[]): { readonly text: string; readonly paragraphs: readonly Paragraph[] } {
  const located: Paragraph[] = [];
  let text = "";
  for (const paragraph of paragraphs) {
    if (text.length > 0) text += "\n\n";
    const charStart = text.length;
    text += paragraph.text;
    located.push({ ...paragraph, index: located.length, charStart, charEnd: text.length });
  }
  return { text, paragraphs: located };
}

function sectionList(sections: readonly string[]): string {
  const shown = sections.slice(0, 4).join("」「");
  return sections.length > 4 ? `「${shown}」等 ${sections.length} 个章节` : `「${shown}」`;
}

/**
 * The paper's body inside one extraction, or the reason there is none.
 *
 * A paragraph belongs to the body when its heading path names a paper section —
 * at least one body section, and nothing that is never one. Everything else in
 * the page (abstract, references, author block, chrome, and any paragraph that
 * sits under no heading at all) is left out of the returned text, so a body
 * scoped read cannot be quoted into evidence from a reference entry or an
 * abstract.
 *
 * A *counted* section is one that owns prose: its own heading is the deepest
 * heading of the paragraphs under it. A page title that happens to contain a
 * body word therefore owns only the chrome rendered directly under it, and the
 * sections named in the result are the ones the paper's prose really sits in.
 */
export function recogniseArticleBody(
  document: ExtractedDocument,
  options: BodyRecognitionOptions = {},
): ArticleBody {
  const collected: Paragraph[] = [];
  const sections: string[] = [];

  for (const paragraph of document.paragraphs) {
    if (paragraph.headingPath.length === 0) continue;
    const path = paragraph.headingPath.map(normaliseHeading);
    if (path.some(isNonArticle)) continue;
    if (!path.some(hasBodyStem)) continue;
    const owning = path[path.length - 1] as string;
    if (hasBodyStem(owning) && !sections.includes(owning)) sections.push(owning);
    collected.push(paragraph);
  }

  const joined = rejoin(collected);
  const chars = joined.text.length;
  const truncated = document.truncated || chars >= MAX_DOCUMENT_CHARS;
  const abstractChars = options.abstractChars ?? 0;

  const refuse = (reason: string): ArticleBody => ({
    recognised: false,
    paragraphs: [],
    text: "",
    sections,
    chars: 0,
    truncated,
    reason,
  });

  if (sections.length === 0) {
    return refuse(
      "页面没有可识别的论文章节标题（没有段落直接归属于 Introduction / Methods / Results 这类章节），只呈现摘要、参考文献或导航内容",
    );
  }
  if (sections.length < MIN_BODY_SECTIONS) {
    return refuse(`只识别到 1 个正文章节标题（少于 ${MIN_BODY_SECTIONS} 个），不足以确认这是论文正文`);
  }
  if (joined.paragraphs.length < MIN_BODY_PARAGRAPHS) {
    return refuse(`识别到的正文段落过少（${joined.paragraphs.length} 段 < ${MIN_BODY_PARAGRAPHS} 段）`);
  }
  if (chars < MIN_BODY_CHARS) {
    return refuse(`识别到的正文过短（${chars} 字 < ${MIN_BODY_CHARS} 字）`);
  }
  if (abstractChars > 0 && chars < abstractChars * MIN_BODY_OVER_ABSTRACT) {
    return refuse(
      `识别到的正文只有摘要的 ${(chars / abstractChars).toFixed(1)} 倍（不足 ${MIN_BODY_OVER_ABSTRACT} 倍），像是页面预览而不是全文`,
    );
  }

  return {
    recognised: true,
    paragraphs: joined.paragraphs,
    text: joined.text,
    sections,
    chars,
    truncated,
    reason: `识别到论文正文（${sectionList(sections)}，共 ${joined.paragraphs.length} 段、${chars} 字）；摘要、参考文献与页面导航不计入正文`,
  };
}

export interface PageAbstract {
  /** The abstract text, whitespace-normalised. */
  readonly text: string;
  /** Where it came from, in the note's words. */
  readonly source: string;
}

/** The shortest paragraph that can be part of an abstract's prose run. */
const MIN_ABSTRACT_PROSE_CHARS = 60;

/** The page's own abstract section's paragraphs, when they read as one. */
function abstractSectionOf(document: ExtractedDocument): string | undefined {
  const collected: string[] = [];
  let started = false;
  for (const paragraph of document.paragraphs) {
    const underAbstract = isAbstractHeading(paragraph.headingPath.at(-1) ?? "");
    if (!underAbstract) {
      // A section change ends the run: a second abstract-headed block later in
      // the page is a different block, not more of this one.
      if (started) break;
      continue;
    }
    // An abstract is prose. A card whose heading happens to be "Abstract" is
    // often followed by the page's bibliographic fields ("Volume:", "Month:",
    // "Year:"), and those short lines end the run rather than join it — which
    // is what keeps a metadata block from being recorded as the abstract.
    if (paragraph.text.length < MIN_ABSTRACT_PROSE_CHARS) {
      if (started) break;
      continue;
    }
    started = true;
    collected.push(paragraph.text);
    if (collected.length > MAX_ABSTRACT_PARAGRAPHS) return undefined;
  }
  if (collected.length === 0) return undefined;
  const text = collected.join("\n\n").trim();
  if (text.length < MIN_ABSTRACT_CHARS || text.length > MAX_ABSTRACT_CHARS) return undefined;
  return text;
}

/**
 * The abstract a page states about the work, from its own declaration.
 *
 * The rendered abstract section is preferred: it is what the page shows a
 * reader. A page that renders no such section may still declare its abstract in
 * a citation or Dublin Core meta tag, which is the page's own machine-readable
 * statement about this work. Both are abstract-level reads; neither is ever
 * allowed to stand in for the body.
 */
export function pageAbstractOf(
  document: ExtractedDocument,
  declaredAbstract: string | undefined,
): PageAbstract | undefined {
  const section = abstractSectionOf(document);
  if (section !== undefined) return { text: section, source: "页面自身渲染的 Abstract 段落" };
  if (declaredAbstract !== undefined && declaredAbstract.length >= MIN_ABSTRACT_CHARS) {
    return { text: declaredAbstract, source: "页面声明的 citation/dc 摘要元数据" };
  }
  return undefined;
}
