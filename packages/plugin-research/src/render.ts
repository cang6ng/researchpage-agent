/**
 * Structured report → HTML. The only place a report becomes a document.
 *
 * The model never writes markup; this renderer does, from the report's data.
 * That is what makes the same content safely previewable in a page and
 * printable to a PDF: citation numbers, the reference list, the evidence index
 * and the honest-gaps appendix are all computed here, and every value that
 * came from a model or a source is escaped on the way in.
 */

import type { Evidence, MatrixCell, Report, ReportTask, Source } from "./domain.js";
import { scopeLabel } from "./evidence.js";
import { buildCitations, locatorLabel, type Citations } from "./report.js";

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface RenderInput {
  readonly task: ReportTask;
  readonly report: Report;
  readonly sources: readonly Source[];
  readonly evidence: readonly Evidence[];
  /** The cells still missing or partial, appended as a program-written section. */
  readonly gaps: readonly MatrixCell[];
  readonly subjectNames: ReadonlyMap<string, string>;
  readonly dimensionNames: ReadonlyMap<string, string>;
  readonly generatedAt: string;
}

const FONT_STACK =
  '"Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Source Han Sans SC", "WenQuanYi Micro Hei", "Segoe UI", system-ui, sans-serif';

export const REPORT_CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: ${FONT_STACK};
  color: #1c1c1e;
  background: #ffffff;
  font-size: 15px;
  line-height: 1.75;
}
.report { max-width: 860px; margin: 0 auto; padding: 32px 40px 56px; }
.report__eyebrow { font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; color: #6b6b70; }
.report__title { font-size: 27px; line-height: 1.35; margin: 6px 0 10px; font-weight: 650; }
.report__meta { font-size: 12.5px; color: #5c5c62; border-bottom: 1px solid #e3e3e6; padding-bottom: 14px; margin-bottom: 20px; }
.report__meta span { margin-right: 14px; white-space: nowrap; }
.report__summary { background: #f6f7f9; border: 1px solid #e3e3e6; border-left: 4px solid #4b6bfb; border-radius: 6px; padding: 14px 16px; margin: 0 0 24px; }
.report__summary h2 { font-size: 14px; margin: 0 0 6px; color: #34343a; }
.report__summary p { margin: 0; }
h2.section { font-size: 19px; margin: 26px 0 10px; padding-bottom: 6px; border-bottom: 1px solid #ececef; }
h3.subsection { font-size: 16px; margin: 18px 0 8px; }
p { margin: 0 0 12px; text-align: justify; }
ul.list, ol.list { margin: 0 0 14px; padding-left: 22px; }
ul.list li, ol.list li { margin-bottom: 6px; }
sup.cite { font-size: 11px; color: #3452d6; vertical-align: super; }
sup.cite a { color: inherit; text-decoration: none; }
table.matrix { width: 100%; border-collapse: collapse; margin: 6px 0 16px; font-size: 13.5px; }
table.matrix th, table.matrix td { border: 1px solid #d9d9de; padding: 7px 9px; vertical-align: top; text-align: left; }
table.matrix thead th { background: #f2f3f6; font-weight: 600; }
table.matrix tbody th { background: #fafbfc; font-weight: 600; white-space: nowrap; }
.callout { border-radius: 6px; padding: 12px 14px; margin: 8px 0 16px; font-size: 14px; }
.callout--gap { background: #fff8ec; border: 1px solid #f0d9a8; }
.callout--note { background: #f2f7ff; border: 1px solid #cddffb; }
.callout b { display: block; margin-bottom: 4px; }
section { break-inside: auto; }
h2.section { break-after: avoid; }
table.matrix, .callout { break-inside: avoid; }
ol.references { padding-left: 20px; }
ol.references li { margin-bottom: 10px; }
.evidence-index .excerpt-source { font-size: 12px; margin-top: 4px; }
.reference__title { font-weight: 600; }
.reference__detail { color: #4a4a52; font-size: 13px; }
.reference__link { color: #3452d6; word-break: break-all; font-size: 12.5px; }
.scope { display: inline-block; font-size: 11.5px; padding: 1px 6px; border-radius: 999px; border: 1px solid #cfcfd6; color: #4a4a52; margin-left: 6px; }
.evidence-index { font-size: 13px; }
.evidence-index li { margin-bottom: 12px; }
.evidence-index .excerpt { background: #f8f8fa; border: 1px solid #e6e6ea; border-radius: 4px; padding: 8px 10px; margin-top: 4px; }
.legend { font-size: 12.5px; color: #5c5c62; }
@media print {
  body { font-size: 10.5pt; }
  .report { max-width: none; padding: 0; }
  .report__title { font-size: 19pt; }
  a { color: #1c1c1e; }
}
`;

/**
 * A citation marker.
 *
 * The numbers link to the reference list inside the same document, so a reader
 * — in the preview *and* in the printed PDF, where no script runs — can follow a
 * claim to the source entry it came from.
 */
function citationSup(numbers: readonly number[]): string {
  if (numbers.length === 0) return "";
  const links = numbers.map((number) => `<a href="#ref-${number}">[${number}]</a>`).join(",");
  return `<sup class="cite">${links}</sup>`;
}

function renderBlocks(
  blocks: Report["sections"][number]["blocks"],
  citations: Citations,
): string {
  const parts: string[] = [];
  for (const block of blocks) {
    switch (block.kind) {
      case "paragraph": {
        parts.push(`<p>${escapeHtml(block.text)}${citationSup(numbersOf(citations, block.claimIds))}</p>`);
        break;
      }
      case "list": {
        parts.push(
          `<ul class="list">${block.items
            .map((item) => `<li>${escapeHtml(item.text)}${citationSup(numbersOf(citations, item.claimIds))}</li>`)
            .join("")}</ul>`,
        );
        break;
      }
      case "table": {
        const head = `<thead><tr>${block.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("")}</tr></thead>`;
        const body = block.rows
          .map(
            (row) =>
              `<tr>${row.cells
                .map(
                  (cell, index) =>
                    `<${index === 0 ? "th" : "td"}>${escapeHtml(cell.text)}${citationSup(numbersOf(citations, cell.claimIds))}</${
                      index === 0 ? "th" : "td"
                    }>`,
                )
                .join("")}</tr>`,
          )
          .join("");
        parts.push(`<table class="matrix">${head}<tbody>${body}</tbody></table>`);
        break;
      }
      case "callout": {
        const label = block.tone === "gap" ? "证据缺口" : "说明";
        parts.push(`<div class="callout callout--${block.tone}"><b>${label}</b>${escapeHtml(block.text)}</div>`);
        break;
      }
    }
  }
  return parts.join("\n");
}

function numbersOf(citations: Citations, claimIds: readonly string[]): readonly number[] {
  const numbers: number[] = [];
  for (const claimId of claimIds) {
    for (const number of citations.numbersForClaim.get(claimId) ?? []) {
      if (!numbers.includes(number)) numbers.push(number);
    }
  }
  return numbers;
}

/** The gap appendix: program-written from the matrix, never from the model. */
function renderGapAppendix(input: RenderInput): string {
  if (input.gaps.length === 0) return "";
  const items = input.gaps
    .map((cell) => {
      const subject = input.subjectNames.get(cell.subjectId) ?? cell.subjectId;
      const dimension = input.dimensionNames.get(cell.dimensionId) ?? cell.dimensionId;
      const status = cell.status === "partial" ? "部分依据" : "缺少依据";
      return `<li><b>${escapeHtml(subject)} × ${escapeHtml(dimension)}</b>（${status}）：${escapeHtml(
        cell.gap.length > 0 ? cell.gap : cell.reason,
      )}</li>`;
    })
    .join("");
  return `<h2 class="section">证据缺口清单（程序生成）</h2><div class="callout callout--gap">以下比较项在本次材料中没有找到足够公开依据，报告不对其作结论：<ul class="list">${items}</ul></div>`;
}

function renderReferences(citations: Citations): string {
  if (citations.references.length === 0) return "";
  const items = citations.references
    .map((reference) => {
      const source = reference.source;
      const authors = source.authors.length === 0 ? source.org : source.authors.slice(0, 6).join(", ");
      const scope = source.readScope === null ? "未读取" : scopeLabel(source.readScope);
      const published = source.publishedAt === null ? "" : source.publishedAt.slice(0, 10);
      const details = [authors, source.venue, published].filter((part) => part.length > 0).join(" · ");
      return `<li id="ref-${reference.number}"><span class="reference__title">${escapeHtml(source.title)}</span><span class="scope">${escapeHtml(
        scope,
      )}</span><div class="reference__detail">${escapeHtml(details)}</div><a class="reference__link" href="${escapeHtml(
        source.url,
      )}">${escapeHtml(source.doi ?? source.url)}</a></li>`;
    })
    .join("");
  return `<h2 class="section">参考来源</h2><ol class="references">${items}</ol>`;
}

function renderEvidenceIndex(citations: Citations, sources: readonly Source[]): string {
  if (citations.evidenceIndex.length === 0) return "";
  const bySource = new Map(sources.map((source) => [source.id, source]));
  const items = citations.evidenceIndex
    .map((entry) => {
      const source = bySource.get(entry.sourceId);
      const excerpt = entry.excerpt.length > 320 ? `${entry.excerpt.slice(0, 320)}…` : entry.excerpt;
      // `locatorLabel` tolerates holes in a stored heading path; the label is
      // the only thing this renderer asks of it.
      return `<li id="ev-${entry.number}"><b>[${entry.number}]</b> ${escapeHtml(source?.title ?? entry.sourceId)} · ${escapeHtml(
        locatorLabel(entry.headingPath, entry.paragraphIndex, source?.title),
      )} · ${escapeHtml(scopeLabel(entry.scope as never))}<div class="excerpt">${escapeHtml(excerpt)}</div>${
        source === undefined ? "" : `<div class="excerpt-source">来源：<a href="${escapeHtml(source.url)}">${escapeHtml(source.url)}</a></div>`
      }</li>`;
    })
    .join("");
  return `<h2 class="section">证据节选索引（程序生成）</h2><ul class="evidence-index">${items}</ul>`;
}

/** The whole document: one report snapshot, one HTML string. */
export function renderReportHtml(input: RenderInput): string {
  const citations = buildCitations({ draft: input.report, sources: input.sources, evidence: input.evidence });
  const sections = input.report.sections
    .map(
      (section) =>
        `<section id="section-${escapeHtml(section.id)}"><h2 class="section">${escapeHtml(section.title)}</h2>${renderBlocks(
          section.blocks,
          citations,
        )}</section>`,
    )
    .join("\n");

  const meta = [
    `主题：${escapeHtml(input.task.topic)}`,
    `读者：${escapeHtml(input.task.audience)}`,
    `检索入口：arXiv`,
    `生成时间：${escapeHtml(input.generatedAt)}`,
  ];

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(input.report.title)}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<article class="report" data-report-id="${escapeHtml(input.report.id)}">
<div class="report__eyebrow">ResearchPage 研究报告</div>
<h1 class="report__title">${escapeHtml(input.report.title)}</h1>
<div class="report__meta">${meta.map((line) => `<span>${line}</span>`).join("")}</div>
<div class="report__summary"><h2>摘要</h2><p>${escapeHtml(input.report.summary)}</p></div>
${sections}
${renderGapAppendix(input)}
${renderReferences(citations)}
${renderEvidenceIndex(citations, input.sources)}
<div class="legend">说明：本文只引用系统实际读取并保存的来源片段；引用编号对应「参考来源」，「证据节选索引」列出每条片段的位置与读取范围。</div>
</article>
</body>
</html>`;
}
