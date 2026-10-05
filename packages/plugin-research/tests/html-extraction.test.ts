/**
 * HTML extraction, held to the two properties evidence depends on.
 *
 * The first is that every paragraph's text is a substring of the saved document
 * at the recorded range — the invariant an excerpt is verified against. The
 * second is a bug this test exists because of: a document that skips heading
 * levels used to leave *holes* in a paragraph's heading path, and a hole is an
 * `undefined` that a later `.trim()` walks into. A path is now a dense array of
 * real strings, however irregular the document is.
 */

import { describe, expect, it } from "vitest";

import { decodeEntities, extractHtmlDocument, extractPlainText } from "../src/html.js";
import { locatorLabel } from "../src/report.js";

const TEXT = "Retrieval augmented generation combines a language model with an external corpus. ";

describe("extractHtmlDocument", () => {
  it("keeps every paragraph range a real substring of the text", () => {
    const html = `<html><head><title>Doc</title></head><body>
      <h1>Title</h1>
      <h2>1 Introduction</h2><p>${TEXT.repeat(3)}</p>
      <h3>1.1 Detail</h3><p>${TEXT.repeat(2)}</p>
      <table><tr><td>GraphRAG</td><td>community summaries</td></tr></table>
      </body></html>`;
    const document = extractHtmlDocument(html);
    expect(document.title).toBe("Doc");
    expect(document.paragraphs.length).toBeGreaterThanOrEqual(4);
    for (const paragraph of document.paragraphs) {
      expect(document.text.slice(paragraph.charStart, paragraph.charEnd)).toBe(paragraph.text);
    }
  });

  it("produces dense heading paths for a document that skips levels", () => {
    const html = `<html><body>
      <h3>Deep Section</h3><p>${TEXT.repeat(3)}</p>
      <h5>Deeper Still</h5><p>${TEXT.repeat(3)}</p>
      <h2>Back Up</h2><p>${TEXT.repeat(3)}</p>
      </body></html>`;
    const document = extractHtmlDocument(html);
    expect(document.paragraphs.length).toBe(3);

    for (const paragraph of document.paragraphs) {
      for (const part of paragraph.headingPath) {
        // A hole would arrive here as `undefined` and throw in any string use.
        expect(typeof part).toBe("string");
        expect((part as string).length).toBeGreaterThan(0);
      }
      // And it survives a JSON round trip without becoming null.
      const roundTripped = JSON.parse(JSON.stringify(paragraph.headingPath)) as unknown[];
      expect(roundTripped.every((part) => typeof part === "string")).toBe(true);
    }

    expect(document.paragraphs[0]!.headingPath).toEqual(["Deep Section"]);
    expect(document.paragraphs[1]!.headingPath).toEqual(["Deep Section", "Deeper Still"]);
    expect(document.paragraphs[2]!.headingPath).toEqual(["Back Up"]);
  });

  it("drops scripts, styles and comments from the text", () => {
    const html = `<html><head><style>p { color: red }</style><script>alert("x")</script></head>
      <body><!-- note --><p>${TEXT.repeat(2)}</p></body></html>`;
    const document = extractHtmlDocument(html);
    expect(document.text).not.toContain("alert");
    expect(document.text).not.toContain("color: red");
    expect(document.text).not.toContain("note");
  });

  it("decodes entities and keeps math alt text", () => {
    expect(decodeEntities("a &amp; b &lt;c&gt; &#65; &#x42;")).toBe("a & b <c> A B");
    const html = `<html><body><p>Score <math alttext="F_1 = 0.85"></math> on the test set ${TEXT.repeat(2)}</p></body></html>`;
    const document = extractHtmlDocument(html);
    expect(document.text).toContain("F_1 = 0.85");
  });
});

describe("locatorLabel", () => {
  it("renders a dense path, and tolerates a path with holes from older data", () => {
    expect(locatorLabel(["2 Method", "2.1 Construction"], 4)).toBe("2 Method > 2.1 Construction（第 5 段）");
    const withHoles = ["Title", undefined, "2.2 Detail"] as unknown as string[];
    expect(() => locatorLabel(withHoles, 0)).not.toThrow();
    expect(locatorLabel(withHoles, 0)).toBe("Title > 2.2 Detail（第 1 段）");
    expect(locatorLabel([], 3)).toBe("第 4 段");
  });

  it("drops a leading part that just repeats the source title", () => {
    expect(locatorLabel(["A Paper About Things", "3 Results"], 2, "A Paper About Things")).toBe("3 Results（第 3 段）");
  });

  it("drops a leading part that names the same work with different punctuation", () => {
    // The exact pair a real demo produced: arXiv's discovery title and the
    // paper's own HTML title spell "GraphRAG" differently.
    const discovery = "From Local to Global: A Graph RAG Approach to Query-Focused Summarization";
    const fromPaper = "From Local to Global: A GraphRAG Approach to Query-Focused Summarization";
    expect(locatorLabel([fromPaper, "Introduction"], 57, discovery)).toBe("Introduction（第 58 段）");
  });
});

describe("extractPlainText", () => {
  it("splits paragraphs on blank lines and records ranges", () => {
    const document = extractPlainText("First paragraph.\n\nSecond paragraph.\n\n\nThird one.");
    expect(document.paragraphs.map((paragraph) => paragraph.text)).toEqual([
      "First paragraph.",
      "Second paragraph.",
      "Third one.",
    ]);
    for (const paragraph of document.paragraphs) {
      expect(document.text.slice(paragraph.charStart, paragraph.charEnd)).toBe(paragraph.text);
    }
  });
});
