/**
 * RichMarkdown, checked on the markup it produces.
 *
 * These are static renders — `renderToStaticMarkup`, no DOM — so what is
 * checked is the structure and the text a panel would contain, not the browser
 * behaviour (the real page is driven in `scripts/verify-workspace.mjs`). What
 * matters here is what a model's answer is allowed to become: paragraphs,
 * headings, lists, tables, quotations and links, and never an element that can
 * run, load or restyle anything.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RichInline, RichMarkdown } from "../src/browser/components/markdown.js";

function render(text: string): string {
  return renderToStaticMarkup(createElement(RichMarkdown, { text }));
}

function renderInline(text: string): string {
  return renderToStaticMarkup(createElement(RichInline, { text }));
}

describe("what an answer is allowed to become", () => {
  it("draws the paragraphs, headings and lists it was given", () => {
    const html = render("# 标题\n\n一段话。\n\n- 第一条\n- 第二条\n\n1. 有序一\n2. 有序二");
    expect(html).toContain("<h1>标题</h1>");
    expect(html).toContain("<p>一段话。</p>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>第一条</li>");
    expect(html).toContain("<ol>");
  });

  it("draws a GFM table with its own scroll container", () => {
    const html = render("| 方案 | 成本 |\n| --- | --- |\n| GraphRAG | 高 |\n| LightRAG | 低 |");
    expect(html).toContain("rp-md__scroll");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>方案</th>");
    expect(html).toContain("<td>LightRAG</td>");
  });

  it("draws quotation, emphasis, inline code and a fenced block", () => {
    const html = render("> 引用一句\n\n**粗** *斜* `行内` ~~删~~\n\n```js\nconst a = 1;\n```");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<strong>粗</strong>");
    expect(html).toContain("<em>斜</em>");
    expect(html).toContain("<code>行内</code>");
    expect(html).toContain("<del>删</del>");
    expect(html).toContain("language-js");
    expect(html).toContain("const a = 1;");
  });

  it("sends an external link out of the product safely, and an anchor nowhere", () => {
    const html = render("[arxiv](https://arxiv.org/abs/2404.16130) 与 [跳到结论](#conclusion)");
    expect(html).toContain('href="https://arxiv.org/abs/2404.16130"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('href="#conclusion"');
    expect(html).not.toContain('href="#conclusion" target');
  });

  it("leaves nothing that can run, load or restyle", () => {
    const html = render(
      [
        "<script>alert(1)</script>",
        "<iframe src=\"https://example.com\"></iframe>",
        "<style>body{display:none}</style>",
        "<img src=x onerror=\"alert(1)\">",
        "<a href=\"javascript:alert(1)\">点我</a>",
        "<div onclick=\"alert(1)\">块</div>",
      ].join("\n\n"),
    );
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<iframe/i);
    expect(html).not.toMatch(/<style/i);
    expect(html).not.toMatch(/onerror/i);
    expect(html).not.toMatch(/onclick/i);
    expect(html).not.toContain("javascript:");
    // The text of the tags that were refused is still text — nothing was
    // silently deleted from the answer, only the elements were.
    expect(html).toContain("点我");
  });

  it("renders nothing at all for an empty answer", () => {
    expect(render("   ")).toBe("");
  });
});

describe("the emphasis inside one sentence", () => {
  it("keeps bold, italics, code and links", () => {
    const html = renderInline("**判断**：这里的 `chunk` 与 [原文](https://example.com/x) 一致。");
    expect(html).toContain("<strong>判断</strong>");
    expect(html).toContain("<code>chunk</code>");
    expect(html).toContain('href="https://example.com/x"');
  });

  it("does not let a sentence become a document", () => {
    const html = renderInline("# 不是标题\n\n- 也不是列表");
    expect(html).not.toContain("<h1>");
    expect(html).not.toContain("<li>");
    expect(html).toContain("不是标题");
    expect(html).toContain("也不是列表");
  });

  it("takes the database's words out of a model's sentence", () => {
    expect(renderInline("**GraphRAG（sub_graphrag）** 与 ev_b28b34275968d807")).toContain("<strong>GraphRAG</strong>");
    expect(renderInline("**GraphRAG（sub_graphrag）** 与 ev_b28b34275968d807")).not.toMatch(/sub_|ev_/);
  });
});
