/**
 * How the conversion smoke test's two files are made.
 *
 * It runs only when asked (`RESEARCHPAGE_MAKE_FIXTURES=1`) because it writes
 * into the repository: the material it produces is committed, so a normal test
 * run reads the files rather than making them. It is a test file rather than a
 * script because the PDF has to be printed by the product's own printer, which
 * is TypeScript the workspace tools already know how to run.
 *
 *   RESEARCHPAGE_MAKE_FIXTURES=1 pnpm vitest run tests/conversion-fixtures.test.ts
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { exportHtmlToPdf, findPdfBrowser } from "@every-dagent/plugin-research";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "fixtures", "conversion");
const enabled = process.env["RESEARCHPAGE_MAKE_FIXTURES"] === "1";

/**
 * What the two files say.
 *
 * The same content goes into both formats on purpose: the point of the smoke
 * test is not "a PDF converts" but "this PDF and this DOCX convert to Markdown
 * that still contains what the source said", and the only way to assert that
 * is to know the text in advance.
 */
const TITLE = "检索增强生成系统的评测方法";
const SECTIONS = [
  {
    heading: "1. 引言 Introduction",
    paragraphs: [
      "本文件用于验证文档转换链路：一份 PDF 与一份 DOCX 承载同样的内容，转换后应当得到语义一致的 Markdown。",
      "The benchmark compares three retrieval strategies on the same corpus, so that the comparison is about retrieval rather than about the corpus.",
    ],
  },
  {
    heading: "2. 指标 Metrics",
    paragraphs: [
      "我们报告三个指标：命中率（hit rate）、平均倒数排名（MRR）与答案正确率；三者都必须与同一份问题集一起报告。",
    ],
  },
];
const TABLE = [
  ["策略 Strategy", "命中率 Hit rate", "MRR"],
  ["BM25", "0.62", "0.48"],
  ["Dense", "0.71", "0.55"],
  ["Hybrid", "0.79", "0.63"],
];

function html(): string {
  const sections = SECTIONS.map(
    (section) => `<section><h2>${section.heading}</h2>${section.paragraphs.map((text) => `<p>${text}</p>`).join("")}</section>`,
  ).join("");
  const rows = TABLE.map(
    (row, index) => `<tr>${row.map((cell) => (index === 0 ? `<th>${cell}</th>` : `<td>${cell}</td>`)).join("")}</tr>`,
  ).join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${TITLE}</title>
<style>
 body { font-family: "Segoe UI", "Microsoft YaHei", sans-serif; margin: 48px; color: #111; }
 h1 { font-size: 24pt; margin: 0 0 24pt; }
 h2 { font-size: 14pt; margin: 20pt 0 8pt; }
 p { font-size: 11pt; line-height: 1.7; margin: 0 0 10pt; }
 table { border-collapse: collapse; margin: 12pt 0; }
 th, td { border: 1px solid #999; padding: 6pt 10pt; font-size: 10.5pt; }
</style></head><body>
<h1>${TITLE}</h1>
${sections}
<h2>3. 结果 Results</h2>
<table>${rows}</table>
</body></html>`;
}

describe.skipIf(!enabled)("conversion fixtures", () => {
  it("prints the PDF with the product's own browser printer", async () => {
    mkdirSync(outDir, { recursive: true });
    const browser = findPdfBrowser();
    expect(browser, "no Chrome/Edge on this machine").toBeDefined();
    const path = join(outDir, "conversion-sample.pdf");
    const outcome = await exportHtmlToPdf({ html: html(), outPath: path, browserPath: browser as string });
    if (outcome.ok !== true) throw new Error(outcome.failure);
    expect(statSync(path).size).toBeGreaterThan(1_000);
  }, 120_000);

  it("writes the DOCX as a real Office Open XML package", () => {
    mkdirSync(outDir, { recursive: true });
    const path = join(outDir, "conversion-sample.docx");
    const script = `
import json, sys
from docx import Document

title, sections, table, out = json.loads(sys.argv[1])
doc = Document()
doc.add_heading(title, level=1)
for section in sections:
    doc.add_heading(section["heading"], level=2)
    for paragraph in section["paragraphs"]:
        doc.add_paragraph(paragraph)
doc.add_heading("3. 结果 Results", level=2)
rows = table[0]
table_obj = doc.add_table(rows=len(table), cols=len(rows))
table_obj.style = "Table Grid"
for r, row in enumerate(table):
    for c, cell in enumerate(row):
        table_obj.cell(r, c).text = cell
doc.save(out)
`;
    const result = spawnSync(
      "uvx",
      ["--with", "python-docx", "python", "-c", script, JSON.stringify([TITLE, SECTIONS, TABLE, path])],
      { stdio: "inherit" },
    );
    expect(result.status, "uvx --with python-docx must be able to run").toBe(0);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).size).toBeGreaterThan(5_000);
  }, 240_000);
});
