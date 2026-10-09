/**
 * The comparison table, as a document — offline, and with the browser the
 * product actually prints with.
 *
 * The defect this file is written against: the exported PDF of a real report
 * carried one of its eighteen comparison cells in full. The renderer had turned
 * each row's *first cell* into a nowrap `<th>`, so that column grew to the width
 * of the page, the table was laid out wider than the sheet, and the other five
 * columns were clipped away. Two things are checked here, and neither of them
 * is "a PDF file exists":
 *
 *  - the document's own semantics: a row's identity is its declared object, it
 *    is printed in its own column, and no cell's text is ever moved into a
 *    heading;
 *  - the printed result: the cells wrap, the table fits the page, and the
 *    browser really produces a file from this markup.
 *
 * The per-cell completeness of a real re-export — every text, identity and
 * citation, page by page — is verified by the extraction harness that ran
 * beside this test, on the report the review measured. What this file pins is
 * that the *renderer* produces a document where that is possible at all.
 */

import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  REPORT_CSS,
  RENDERER,
  exportHtmlToPdf,
  findPdfBrowser,
  renderRevisionHtml,
  type FrozenRevision,
} from "@every-dagent/plugin-research";

/** The six dimensions and three objects of the report the review measured. */
const COLUMNS = ["索引成本结构", "跨文档桥接型多跳效果", "轻量化机制与代价", "失败模式", "预算封顶下的取舍点", "自有语料上的验证设计"];
const SUBJECTS = [
  { id: "sub_graphrag", name: "GraphRAG" },
  { id: "sub_lightrag", name: "LightRAG" },
  { id: "sub_vanilla_rag", name: "vanilla RAG" },
];
/** A cell as long as the real ones: the defect only showed up on long text. */
const CELL = (subject: string, column: string): string =>
  `${subject} 在「${column}」上的有界判断：${"这一段正文在旧渲染器里会被整列裁掉，因为表格宽于纸张且第一格被当作不换行的标题。".repeat(2)}证据不足：本次未取得可直接引用的同口径数字。`;

function revisionFixture(): FrozenRevision {
  const cells = SUBJECTS.map((subject) => COLUMNS.map((column) => ({ text: CELL(subject.name, column), claimIds: [] })));
  return {
    id: "rev_fixture",
    taskId: "task_fixture",
    reportId: "rep_fixture",
    revision: 1,
    contentHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    frame: {
      topic: "图结构化检索方法的选型",
      title: "图结构化检索方法的选型",
      audience: "工程团队",
      subjects: SUBJECTS,
      dimensions: COLUMNS.map((name, index) => ({ id: `dim_${String(index + 1)}`, name })),
    },
    report: {
      id: "rep_fixture",
      title: "图结构化检索方法的选型",
      summary: "本报告比较三个对象在六个维度上的口径与缺口。",
      frame: { question: "哪一种更值得投入", audience: "工程团队", scope: "两篇原始论文与一份基线材料" },
      sections: [
        {
          id: "comparison",
          title: "条件化比较",
          blocks: [
            {
              kind: "table",
              columns: COLUMNS,
              columnDimensions: COLUMNS.map((_, index) => `dim_${String(index + 1)}`),
              rowSubjects: SUBJECTS.map((subject) => subject.id),
              rows: cells.map((row) => ({ cells: row })),
            },
          ],
        },
      ],
      claims: [],
    },
    sourceRefs: [],
    evidenceRefs: [],
    assessments: [],
    gapsCaptured: false,
    gaps: [],
    themeId: "editorial",
    // An older build's stamp: the document has to be able to say so.
    renderer: { name: RENDERER.name, version: "2.0.0" },
    createdAt: "2026-10-09T00:00:00.000Z",
  } as unknown as FrozenRevision;
}

describe("the comparison table as a document", () => {
  const html = renderRevisionHtml({ revision: revisionFixture() });

  it("gives the object column its own heading, and the dimensions theirs", () => {
    expect(html).toContain('<th scope="col">对象</th>');
    for (const column of COLUMNS) expect(html).toContain(`<th scope="col">${column}</th>`);
  });

  it("prints every row's own object in its own cell, and every written cell as a cell", () => {
    for (const subject of SUBJECTS) {
      expect(html).toContain(`<th scope="row" class="matrix__object">${subject.name}</th>`);
    }
    // Eighteen written cells are eighteen `<td>`s: none of them was moved into
    // a heading, which is what used to cost the row its other five columns.
    const table = html.slice(html.indexOf("<table class=\"matrix\">"), html.indexOf("</table>"));
    expect((table.match(/<td>/gu) ?? []).length).toBe(SUBJECTS.length * COLUMNS.length);
    expect((table.match(/<th scope="row"/gu) ?? []).length).toBe(SUBJECTS.length);
    for (const subject of SUBJECTS) {
      for (const column of COLUMNS) {
        expect(table).toContain(CELL(subject.name, column));
      }
    }
  });

  it("lets the cells wrap and keeps the table inside the page", () => {
    expect(REPORT_CSS).toContain("table-layout: fixed");
    expect(REPORT_CSS).toContain("overflow-wrap: anywhere");
    // No column is forbidden to wrap — the nowrap row heading was the defect.
    expect(REPORT_CSS).not.toMatch(/tbody th[^}]*white-space:\s*nowrap/u);
    expect(REPORT_CSS).not.toMatch(/table\.matrix[^}]*white-space:\s*nowrap/u);
  });

  it("lets a long table paginate instead of clipping it", () => {
    // The table as a whole may break; its header repeats; its rows may split.
    expect(REPORT_CSS).not.toMatch(/table\.matrix\s*,\s*\.callout/u);
    expect(REPORT_CSS).toMatch(/table\.matrix[^}]*break-inside:\s*auto/u);
    expect(REPORT_CSS).toContain("table-header-group");
  });

  it("says which renderer produced the file, and which one the revision was frozen by", () => {
    expect(html).toContain(`冻结记录渲染器 ${RENDERER.name}@2.0.0`);
    expect(html).toContain(`本次渲染 ${RENDERER.name}@${RENDERER.version}`);
  });
});

describe("the offline PDF export", () => {
  it("prints the frozen document with the product's own browser", async () => {
    const browser = findPdfBrowser();
    expect(browser, "no Chrome/Edge on this machine").toBeDefined();
    const dir = mkdtempSync(join(tmpdir(), "rp-report-pdf-"));
    try {
      const outPath = join(dir, "report.pdf");
      const outcome = await exportHtmlToPdf({ html: renderRevisionHtml({ revision: revisionFixture() }), outPath, browserPath: browser as string });
      if (outcome.ok !== true) throw new Error(outcome.failure);
      const bytes = readFileSync(outPath);
      expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      expect(statSync(outPath).size).toBeGreaterThan(10_000);
      // Nine-tenths of the content is Chinese; a PDF that lost it would still
      // be a PDF, so the embedded fonts are what the size argues for.
      expect(bytes.toString("latin1")).toContain("FontFile2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
