/**
 * Evidence: the passage a claim may quote, and the check that it is real.
 *
 * Two rules are enforced here and nowhere else. An evidence excerpt is a
 * verbatim substring of the text that was actually saved for its read — the
 * check re-derives the substring from the recorded character range, so a
 * fabricated or edited "quote" cannot pass. And choosing which passage to keep
 * is a *program* decision made from the read text, so the model never supplies
 * the characters it would later be allowed to cite.
 */

import type { CellRef, Evidence, Paragraph, ReadScope } from "./domain.js";
import { ID_PREFIX } from "./domain.js";
import { newId } from "./repository.js";

/** The longest excerpt stored for one evidence item. */
export const MAX_EXCERPT_CHARS = 1_500;

const STOP_WORDS: ReadonlySet<string> = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "are",
  "was",
  "were",
  "which",
  "what",
  "how",
  "does",
  "their",
  "there",
  "into",
  "than",
  "then",
  "they",
  "them",
  "these",
  "those",
  "about",
  "using",
  "used",
  "use",
  "can",
  "may",
  "not",
  "but",
  "all",
  "any",
  "our",
  "its",
  "has",
  "have",
  "been",
  "more",
  "most",
  "other",
  "such",
  "also",
  "between",
  "each",
  "when",
  "where",
  "while",
  "will",
  "would",
  "should",
  "could",
]);

/** The terms a query is scored by: Latin words and CJK bigrams. */
export function tokenize(text: string): readonly string[] {
  const terms: string[] = [];
  const latin = text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [];
  for (const word of latin) {
    if (!STOP_WORDS.has(word)) terms.push(word);
  }
  const cjkRuns = text.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  for (const run of cjkRuns) {
    for (let index = 0; index + 1 < run.length; index += 1) {
      terms.push(run.slice(index, index + 2));
    }
    if (run.length >= 3) terms.push(run);
  }
  return terms;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

export interface ParagraphPick {
  readonly paragraph: Paragraph;
  readonly score: number;
  readonly because: string;
}

/**
 * Ranks a document's paragraphs against the terms a cell's question is about.
 *
 * Scoring is plain term frequency over the paragraph plus a smaller weight on
 * its heading path, and it is deliberately readable: a person looking at the
 * chosen excerpt and the question can see why it was picked. When nothing
 * matches, the picks are the opening paragraphs of the document's top-level
 * sections — spread rather than first-N, so a failure to match does not hand
 * back four consecutive paragraphs of the introduction.
 */
export function pickParagraphs(
  paragraphs: readonly Paragraph[],
  terms: readonly string[],
  limit: number,
): readonly ParagraphPick[] {
  const usable = paragraphs.filter((paragraph) => paragraph.text.length >= 80);
  const pool = usable.length > 0 ? usable : paragraphs;

  const lowerTerms = terms.map((term) => term.toLowerCase()).filter((term) => term.length > 2);
  const scored = pool.map((paragraph) => {
    const body = paragraph.text.toLowerCase();
    let score = 0;
    for (const term of lowerTerms) score += countOccurrences(body, term);
    const heading = paragraph.headingPath.join(" ").toLowerCase();
    for (const term of lowerTerms) {
      if (heading.includes(term)) score += 2;
    }
    if (/abstract|introduction/i.test(paragraph.headingPath[0] ?? "")) score += 1;
    return { paragraph, score };
  });

  const hits = scored.filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score);
  if (hits.length > 0) {
    return hits.slice(0, limit).map((entry) => ({
      paragraph: entry.paragraph,
      score: entry.score,
      because: `与检索词匹配（命中权重 ${entry.score}）`,
    }));
  }

  const seenHeadings = new Set<string>();
  const spread: ParagraphPick[] = [];
  for (const entry of scored) {
    const key = entry.paragraph.headingPath.join(">") || "(document)";
    if (seenHeadings.has(key)) continue;
    seenHeadings.add(key);
    spread.push({ paragraph: entry.paragraph, score: 0, because: "未命中检索词，取该文档各章节起始段落" });
    if (spread.length >= limit) break;
  }
  return spread;
}

/** A paragraph trimmed to the excerpt bound, cut at a sentence end when possible. */
function trimExcerpt(paragraph: Paragraph): { text: string; charEnd: number } {
  if (paragraph.text.length <= MAX_EXCERPT_CHARS) {
    return { text: paragraph.text, charEnd: paragraph.charEnd };
  }
  const window = paragraph.text.slice(0, MAX_EXCERPT_CHARS);
  const sentenceEnd = Math.max(window.lastIndexOf(". "), window.lastIndexOf("。"), window.lastIndexOf("! "), window.lastIndexOf("? "));
  const cut = sentenceEnd > MAX_EXCERPT_CHARS / 2 ? sentenceEnd + 1 : MAX_EXCERPT_CHARS;
  return { text: paragraph.text.slice(0, cut).trimEnd(), charEnd: paragraph.charStart + cut };
}

export interface EvidenceDraft {
  readonly paragraph: Paragraph;
  readonly cells: readonly CellRef[];
  readonly pickedBecause: string;
}

/** Turns one picked paragraph into the evidence record that may be cited. */
export function draftEvidence(input: {
  readonly taskId: string;
  readonly sourceId: string;
  readonly readId: string;
  readonly readScope: ReadScope;
  readonly draft: EvidenceDraft;
  readonly now: string;
}): Evidence {
  const trimmed = trimExcerpt(input.draft.paragraph);
  return {
    id: newId(ID_PREFIX.evidence),
    taskId: input.taskId,
    sourceId: input.sourceId,
    readId: input.readId,
    excerpt: trimmed.text,
    locator: {
      paragraphIndex: input.draft.paragraph.index,
      headingPath: input.draft.paragraph.headingPath,
      charStart: input.draft.paragraph.charStart,
      charEnd: trimmed.charEnd,
    },
    readScope: input.readScope,
    cells: input.draft.cells,
    pickedBecause: input.draft.pickedBecause,
    createdAt: input.now,
  };
}

export interface EvidenceCheck {
  readonly ok: boolean;
  readonly problem: string;
}

/**
 * Re-derives an evidence excerpt from the saved read text.
 *
 * A passing check means the excerpt exists in the read text at the recorded
 * range. It is the reason a citation in a report can be trusted to point at
 * real characters, and it is run both when evidence is created and again when a
 * report that cites it is saved.
 */
export function verifyEvidenceText(evidence: Evidence, snapshotText: string): EvidenceCheck {
  const { charStart, charEnd } = evidence.locator;
  if (!Number.isInteger(charStart) || !Number.isInteger(charEnd) || charStart < 0 || charEnd > snapshotText.length || charEnd <= charStart) {
    return { ok: false, problem: `证据 ${evidence.id} 的位置范围越界` };
  }
  const slice = snapshotText.slice(charStart, charEnd);
  if (slice !== evidence.excerpt) {
    return { ok: false, problem: `证据 ${evidence.id} 的片段与读取文本不一致` };
  }
  return { ok: true, problem: "" };
}

/** How much of a document a scope represents, in words a reader can check. */
export function scopeLabel(scope: ReadScope): string {
  switch (scope) {
    case "metadata":
      return "仅元数据";
    case "abstract":
      return "仅摘要";
    case "body_excerpt":
      return "正文节选";
    case "full_text":
      return "完整正文";
  }
}
