/**
 * Structured report → HTML. The only place a report becomes a document.
 *
 * The model never writes markup; this renderer does, from the report's data.
 * That is what makes the same content safely previewable in a page and
 * printable to a PDF: citation numbers, the reference list, the evidence index
 * and the honest-gaps appendix are all computed here, and every value that
 * came from a model or a source is escaped on the way in.
 */

import type { MatrixCell, Report, ReportBlock, ReportFrame, ReportGapNote, ReportTask } from "./domain.js";
import { scopeLabel } from "./evidence.js";
import { buildCitations, locatorLabel, type CitationEvidence, type CitationSource, type Citations } from "./report.js";
import { RENDERER, type FrozenRevision } from "./revision.js";

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface RenderInput {
  /** Only the frame lines the document shows; a revision has no live task. */
  readonly task: Pick<ReportTask, "topic" | "audience">;
  readonly report: Pick<Report, "id" | "title" | "summary" | "sections" | "claims"> & { readonly frame?: ReportFrame };
  readonly sources: readonly CitationSource[];
  readonly evidence: readonly CitationEvidence[];
  /** The cells still needing work, appended as a program-written section. */
  readonly gaps: readonly ReportGapNote[] | readonly MatrixCell[];
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
.report__frame { border: 1px solid #e3e3e6; border-radius: 6px; padding: 10px 14px; margin: 0 0 18px; font-size: 14px; }
.report__frame div { margin: 4px 0; }
.report__frame-label { display: inline-block; min-width: 68px; color: #5c5c62; font-size: 12.5px; letter-spacing: 0.04em; }
h2.section { font-size: 19px; margin: 26px 0 10px; padding-bottom: 6px; border-bottom: 1px solid #ececef; }
h3.subsection { font-size: 16px; margin: 18px 0 8px; }
p { margin: 0 0 12px; text-align: justify; }
ul.list, ol.list { margin: 0 0 14px; padding-left: 22px; }
ul.list li, ol.list li { margin-bottom: 6px; }
sup.cite { font-size: 11px; color: #3452d6; vertical-align: super; }
sup.cite a { color: inherit; text-decoration: none; }
sup.cite--synthesis { color: #8a5a00; font-size: 10.5px; }
table.matrix { width: 100%; max-width: 100%; table-layout: fixed; border-collapse: collapse; margin: 6px 0 16px; font-size: 13.5px; }
table.matrix th, table.matrix td {
  min-width: 0;
  border: 1px solid #d9d9de;
  padding: 7px 9px;
  vertical-align: top;
  text-align: left;
  /* A cell wraps. The old rule forbade it in the first column, which is how a
     long cell grew to the width of the page and pushed every other column off
     the printed sheet. */
  white-space: normal;
  overflow-wrap: anywhere;
  word-break: break-word;
}
table.matrix thead th { background: #f2f3f6; font-weight: 600; }
table.matrix tbody th { background: #fafbfc; font-weight: 600; }
table.matrix th.matrix__object { width: 12%; }
table.verify { font-size: 12.5px; }
table.verify td, table.verify th { padding: 5px 8px; }
.verify__ref { white-space: nowrap; color: #3452d6; }
.table-note { font-size: 12px; color: #5c5c62; margin: -10px 0 16px; }
.mechanism { border: 1px solid #dde3ef; background: #fafbfe; border-radius: 6px; padding: 12px 16px; margin: 8px 0 16px; }
.mechanism__frame { margin: 6px 0 10px; }
.mechanism__frame dt { font-size: 12.5px; color: #5c5c62; margin-top: 6px; }
.mechanism__frame dd { margin: 2px 0; }
.mechanism__steps { margin: 6px 0 10px; padding-left: 22px; }
.mechanism__steps li { margin-bottom: 6px; }
.callout { border-radius: 6px; padding: 12px 14px; margin: 8px 0 16px; font-size: 14px; }
.callout--gap { background: #fff8ec; border: 1px solid #f0d9a8; }
.callout--note { background: #f2f7ff; border: 1px solid #cddffb; }
.callout b { display: block; margin-bottom: 4px; }
.callout__dims { display: block; margin-top: 4px; font-size: 12px; color: #5c5c62; }
section { break-inside: auto; }
h2.section { break-after: avoid; }
/* A table may break across pages: its header repeats and its rows stay whole
   as far as the page allows. Forbidding the break is what produced a table
   clipped at the foot of a page, and a clipped comparison is a comparison a
   reader cannot check. */
table.matrix, table.matrix tbody, table.matrix tr { break-inside: auto; }
table.matrix thead { display: table-header-group; }
.callout, .mechanism { break-inside: avoid; }
ol.references { padding-left: 20px; }
ol.references li { margin-bottom: 10px; }
.reference__title { font-weight: 600; }
.reference__detail { color: #4a4a52; font-size: 13px; }
.reference__link { color: #3452d6; word-break: break-all; font-size: 12.5px; }
.scope { display: inline-block; font-size: 11.5px; padding: 1px 6px; border-radius: 999px; border: 1px solid #cfcfd6; color: #4a4a52; margin-left: 6px; }
.legend { font-size: 12.5px; color: #5c5c62; }
@media print {
  body { font-size: 10.5pt; }
  .report { max-width: none; padding: 0; }
  .report__title { font-size: 19pt; }
  a { color: #1c1c1e; }
  /* Printing repeats the header on every page the table reaches, and lets a
     tall row start on one page and finish on the next. What it must not do —
     and no longer can — is clip the columns: the table is laid out to the page
     width and every cell wraps. */
  table.matrix { break-inside: auto; page-break-inside: auto; }
  table.matrix thead { display: table-header-group; }
  table.matrix tbody { display: table-row-group; }
  table.matrix tr { break-inside: auto; page-break-inside: auto; }
  .callout, .mechanism { break-inside: avoid; page-break-inside: avoid; }
}
`;

/**
 * A citation marker.
 *
 * The numbers link to the reference list inside the same document, so a reader
 * — in the preview *and* in the printed PDF, where no script runs — can follow a
 * claim to the source entry it came from. A synthesis claim carries its own
 * mark, because "this is our judgement over several sources" is a different
 * kind of statement from "this source says so".
 */
function citationSup(numbers: readonly number[], synthesis = false): string {
  if (numbers.length === 0) return synthesis ? `<sup class="cite cite--synthesis">⟨综合判断⟩</sup>` : "";
  const links = numbers.map((number) => `<a href="#ref-${number}">[${number}]</a>`).join(",");
  return `<sup class="cite">${links}</sup>${synthesis ? `<sup class="cite cite--synthesis">⟨综合判断⟩</sup>` : ""}`;
}

function renderBlocks(
  blocks: readonly ReportBlock[],
  citations: Citations,
  claims: ClaimsById,
  subjectNames: ReadonlyMap<string, string>,
  dimensionNames: ReadonlyMap<string, string>,
): string {
  void dimensionNames;
  const parts: string[] = [];
  for (const block of blocks) {
    switch (block.kind) {
      case "paragraph": {
        parts.push(
          `<p>${escapeHtml(block.text)}${citationSup(numbersOf(citations, block.claimIds), anySynthesis(block.claimIds, claims))}</p>`,
        );
        break;
      }
      case "list": {
        parts.push(
          `<ul class="list">${block.items
            .map(
              (item) =>
                `<li>${escapeHtml(item.text)}${citationSup(numbersOf(citations, item.claimIds), anySynthesis(item.claimIds, claims))}</li>`,
            )
            .join("")}</ul>`,
        );
        break;
      }
      case "table": {
        const rowSubjects = block.rowSubjects ?? [];
        // Whether this table names its rows at all, and whether every row has
        // an identity. A table that declares any object gets an object column;
        // one that declares none is not given a made-up one, and a row that
        // declares nothing says so instead of borrowing its first cell's text.
        const declaresObjects = rowSubjects.some((subject) => typeof subject === "string" && subject.length > 0);
        const partial = declaresObjects && rowSubjects.some((subject) => typeof subject !== "string" || subject.length === 0);
        const head = `<thead><tr>${[
          ...(declaresObjects ? ['<th scope="col">对象</th>'] : []),
          ...block.columns.map((column) => `<th scope="col">${escapeHtml(column)}</th>`),
        ].join("")}</tr></thead>`;
        const body = block.rows
          .map((row, rowIndex) => {
            // Every written cell is a cell: the row's identity is printed in its
            // own column, so no cell's text is ever moved into a heading — which
            // is what used to leave the rest of a long row off the page.
            const cells = row.cells
              .map(
                (cell) =>
                  `<td>${escapeHtml(cell.text)}${citationSup(
                    numbersOf(citations, cell.claimIds),
                    anySynthesis(cell.claimIds, claims),
                  )}</td>`,
              )
              .join("");
            const label = declaresObjects ? rowObjectLabel(rowSubjects[rowIndex] ?? null, subjectNames, partial) : "";
            const heading = declaresObjects ? `<th scope="row" class="matrix__object">${escapeHtml(label)}</th>` : "";
            return `<tr>${heading}${cells}</tr>`;
          })
          .join("");
        // A comparison table states its own frame: which dimension each column
        // answers and which object each row is. That is what lets a reader see
        // that every object was asked the same question.
        const columnNote =
          block.columnDimensions === undefined
            ? ""
            : `<div class="table-note">列对应维度：${block.columns
                .map((column, index) => `${escapeHtml(column)}=${escapeHtml(block.columnDimensions?.[index] ?? "（未声明）")}`)
                .join("；")}</div>`;
        parts.push(
          `<div class="matrix-wrap"><table class="matrix">${head}<tbody>${body}</tbody></table></div>${columnNote}`,
        );
        break;
      }
      case "callout": {
        const label = block.tone === "gap" ? "证据缺口" : "说明";
        const dimensions =
          block.dimensionIds === undefined || block.dimensionIds.length === 0
            ? ""
            : `<span class="callout__dims">涉及维度：${block.dimensionIds
                .map((id) => escapeHtml(dimensionNames.get(id) ?? id))
                .join("、")}</span>`;
        parts.push(`<div class="callout callout--${block.tone}"><b>${label}</b>${escapeHtml(block.text)}${dimensions}</div>`);
        break;
      }
      case "mechanism": {
        const numbers = numbersOf(citations, block.claimIds);
        const steps = block.steps
          .map(
            (step) =>
              `<li>${escapeHtml(step.text)}${citationSup(numbersOf(citations, step.claimIds), anySynthesis(step.claimIds, claims))}</li>`,
          )
          .join("");
        parts.push(
          `<div class="mechanism">${block.title === undefined ? "" : `<h3 class="subsection">${escapeHtml(block.title)}</h3>`}
<dl class="mechanism__frame">
<dt>输入</dt><dd>${escapeHtml(block.input)}</dd>
<dt>中间产物</dt><dd>${escapeHtml(block.intermediate)}</dd>
</dl>
<ol class="mechanism__steps">${steps}</ol>
<dl class="mechanism__frame">
<dt>输出</dt><dd>${escapeHtml(block.output)}</dd>
<dt>代价与权衡</dt><dd>${escapeHtml(block.tradeoff)}</dd>
<dt>失效条件</dt><dd>${escapeHtml(block.failure)}</dd>
</dl>${citationSup(numbers, anySynthesis(block.claimIds, claims))}</div>`,
        );
        break;
      }
    }
  }
  return parts.join("\n");
}

/**
 * What a row's identity column says.
 *
 * The name is read from the task's own subjects — the ids the table declared —
 * and an id this task does not have is printed as it was written rather than
 * hidden. A row that declared nothing says so: a blank cell there would read as
 * an object whose name was forgotten, which is a different claim from "this
 * table did not name its rows".
 */
function rowObjectLabel(subjectId: string | null, subjectNames: ReadonlyMap<string, string>, partial: boolean): string {
  if (typeof subjectId === "string" && subjectId.length > 0) return subjectNames.get(subjectId) ?? subjectId;
  return partial ? "对象未声明" : "";
}

/** The claims by id, so a block can render whether a judgement is ours. */
type ClaimsById = ReadonlyMap<string, { readonly synthesis?: boolean; readonly claimType?: string }>;

function anySynthesis(claimIds: readonly string[], claims: ClaimsById): boolean {
  return claimIds.some((claimId) => {
    const claim = claims.get(claimId);
    return claim !== undefined && (claim.synthesis === true || claim.claimType === "synthesis");
  });
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

/** A gap, as either the live matrix or a frozen snapshot describes it. */
function gapFields(cell: MatrixCell | ReportGapNote, input: RenderInput): { subject: string; dimension: string; status: string; detail: string } {
  const frozen = "subjectName" in cell;
  const status = cell.status === "reviewed" ? "已核对" : statusLabel(cell.status);
  return {
    subject: frozen ? cell.subjectName : (input.subjectNames.get(cell.subjectId) ?? cell.subjectId),
    dimension: frozen ? cell.dimensionName : (input.dimensionNames.get(cell.dimensionId) ?? cell.dimensionId),
    status,
    detail: cell.gap.length > 0 ? cell.gap : cell.reason,
  };
}

function statusLabel(status: MatrixCell["status"]): string {
  switch (status) {
    case "missing":
      return "缺少依据";
    case "unassessed":
      return "有片段，待核对";
    case "limited":
      return "有限支持";
    case "conflict":
      return "冲突/不可比";
    case "reviewed":
      return "已核对";
  }
}

/** The gap appendix: program-written from the report's own gap snapshot. */
function renderGapAppendix(input: RenderInput): string {
  if (input.gaps.length === 0) return "";
  const items = input.gaps
    .map((cell) => {
      const fields = gapFields(cell, input);
      return `<li><b>${escapeHtml(fields.subject)} × ${escapeHtml(fields.dimension)}</b>（${escapeHtml(
        fields.status,
      )}）：${escapeHtml(fields.detail)}</li>`;
    })
    .join("");
  return `<h2 class="section">证据缺口清单（程序生成）</h2><div class="callout callout--gap">以下比较项在本次材料中没有取得已核对的依据，报告不对其作结论：<ul class="list">${items}</ul></div>`;
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

/**
 * The verification index: what a reader needs to check a citation, and no more.
 *
 * The default document used to print every cited excerpt in full — in a real
 * report that was two pages of excerpts against three pages of argument, which
 * buries the reading behind its own evidence. What stays here is the compact
 * part of verification: which reference, which source, where in it, and how
 * much of the document was actually obtained. The excerpts themselves live in
 * the workspace's verification view, one citation at a time.
 */
function renderEvidenceIndex(citations: Citations, sources: readonly CitationSource[]): string {
  if (citations.evidenceIndex.length === 0) return "";
  const bySource = new Map(sources.map((source) => [source.id, source]));
  const rows = citations.evidenceIndex
    .map((entry) => {
      const source = bySource.get(entry.sourceId);
      const title = source?.title ?? entry.sourceId;
      return `<tr><td class="verify__ref">[${entry.number}]</td><td>${escapeHtml(
        title.length > 64 ? `${title.slice(0, 64)}…` : title,
      )}</td><td>${escapeHtml(locatorLabel(entry.headingPath, entry.paragraphIndex, source?.title))}</td><td>${escapeHtml(
        scopeLabel(entry.scope),
      )}</td></tr>`;
    })
    .join("");
  return `<h2 class="section">核验索引（程序生成）</h2>
<p class="legend">每条引用对应的来源、定位与读取范围；完整片段可在工作台的核验视图中逐条查看。</p>
<table class="matrix verify"><thead><tr><th>引用</th><th>来源</th><th>定位</th><th>读取范围</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** The whole document: one report snapshot, one HTML string. */
export function renderReportHtml(input: RenderInput): string {
  const claims = new Map(input.report.claims.map((claim) => [claim.id, { synthesis: claim.synthesis, claimType: claim.claimType }]));
  const citations = buildCitations({ draft: input.report, sources: input.sources, evidence: input.evidence });
  const sections = input.report.sections
    .map(
      (section) =>
        `<section id="section-${escapeHtml(section.id)}"><h2 class="section">${escapeHtml(section.title)}</h2>${renderBlocks(
          section.blocks,
          citations,
          claims,
          input.subjectNames,
          input.dimensionNames,
        )}</section>`,
    )
    .join("\n");

  // The document states its own question, audience and scope before it answers
  // anything: a reader who cannot see the question cannot judge the answer.
  const frame = input.report.frame;
  const frameHtml =
    frame === undefined
      ? ""
      : `<div class="report__frame">
<div><span class="report__frame-label">研究问题</span>${escapeHtml(frame.question)}</div>
<div><span class="report__frame-label">读者</span>${escapeHtml(frame.audience.length > 0 ? frame.audience : input.task.audience || "（未声明）")}</div>
<div><span class="report__frame-label">范围</span>${escapeHtml(frame.scope)}</div>
</div>`;

  const meta = [
    `主题：${escapeHtml(input.task.topic)}`,
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
${frameHtml}
<div class="report__summary"><h2>摘要</h2><p>${escapeHtml(input.report.summary)}</p></div>
${sections}
${renderGapAppendix(input)}
${renderReferences(citations)}
${renderEvidenceIndex(citations, input.sources)}
<div class="legend">说明：本文只引用系统实际读取并保存的来源片段；引用编号对应「参考来源」，「核验索引」给出每条片段的位置与读取范围，完整片段可在工作台的核验视图中查看。标注「综合判断」的结论是 ResearchPage 基于多个来源的推断，不是任一来源的原文。</div>
</article>
</body>
</html>`;
}

/**
 * Renders a frozen revision — and only what the revision contains.
 *
 * This is the export path, and it is deliberately unable to reach the task:
 * every value it prints comes from the bundle that was frozen with the report,
 * so the same revision produces the same document today, next week, and after
 * the research has moved on. Even the document's "generated" line is the
 * revision's own timestamp rather than the moment of rendering: a file that
 * called itself different because it was printed later would not be a frozen
 * version at all. The footer names the revision and the renderer that produced
 * it, so the document can state its own provenance.
 */
export function renderRevisionHtml(input: { readonly revision: FrozenRevision; readonly generatedAt?: string }): string {
  void input.generatedAt;
  const revision = input.revision;
  const subjectNames = new Map(revision.frame.subjects.map((subject) => [subject.id, subject.name]));
  const dimensionNames = new Map(revision.frame.dimensions.map((dimension) => [dimension.id, dimension.name]));
  const html = renderReportHtml({
    task: { topic: revision.frame.topic, audience: revision.frame.audience },
    report: {
      id: revision.report.id,
      title: revision.report.title,
      summary: revision.report.summary,
      ...(revision.report.frame === undefined ? {} : { frame: revision.report.frame }),
      sections: revision.report.sections,
      claims: revision.report.claims,
    },
    sources: revision.sourceRefs.map((source) => ({
      id: source.sourceId,
      title: source.title,
      authors: source.authors,
      org: source.org,
      venue: source.venue,
      publishedAt: source.publishedAt,
      url: source.url,
      doi: source.doi,
      readScope: source.readScope,
    })),
    evidence: revision.evidenceRefs.map((ref) => ({
      id: ref.evidenceId,
      sourceId: ref.sourceId,
      excerpt: ref.excerpt,
      readScope: ref.readScope,
      locator: ref.locator,
    })),
    gaps: revision.gaps,
    subjectNames,
    dimensionNames,
    generatedAt: revision.createdAt,
  });
  // The document states two facts a reader may need to compare: which renderer
  // the revision was frozen by, and which one actually drew this file. They are
  // the same string for a revision frozen today, and they are both printed when
  // they differ, because "this file was produced by a different program than
  // the record names" is exactly what a provenance line is for.
  const frozenRenderer = `${revision.renderer.name}@${revision.renderer.version}`;
  const currentRenderer = `${RENDERER.name}@${RENDERER.version}`;
  const stamp = [
    `冻结版本 R${revision.revision}`,
    `内容 hash ${revision.contentHash.slice(0, 19)}…`,
    revision.gapsCaptured ? "缺口快照：已记录" : "缺口快照：本版本未记录（旧版记录）",
    frozenRenderer === currentRenderer
      ? `渲染器 ${currentRenderer}`
      : `冻结记录渲染器 ${frozenRenderer} · 本次渲染 ${currentRenderer}`,
    `主题 ${revision.themeId}`,
    `冻结时间 ${revision.createdAt}`,
  ].join(" · ");
  return html.replace(
    `<div class="legend">`,
    `<div class="legend" data-revision-id="${escapeHtml(revision.id)}">${escapeHtml(stamp)}</div>\n<div class="legend">`,
  );
}
