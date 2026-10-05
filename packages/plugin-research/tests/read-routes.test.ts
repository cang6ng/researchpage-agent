/**
 * The read layer's honest-scope rules, checked with a stub network.
 *
 * These are the cases a demo could get wrong without anyone noticing: a paper
 * with no HTML full text must come back as `abstract`, not as a "read paper"; a
 * PDF must be a reported failure, not a silent success; and a 404 must record
 * nothing at all. The stub is a `fetch` and nothing else — the reader itself is
 * the code under test.
 */

import { describe, expect, it } from "vitest";

import { readSource } from "../src/read.js";

const ABS_PAGE = `<!doctype html><html><head>
<meta name="citation_title" content="An Older Paper" />
<meta name="citation_abstract" content="This paper studies a method. It reports results on several datasets and discusses limitations that matter for practitioners." />
</head><body><h1>An Older Paper</h1></body></html>`;

const FULL_TEXT_PAGE = `<!doctype html><html><head><title>Paper | arXiv</title></head><body>
<div class="ltx_page_main"><div class="ltx_page_content">
<h1>Paper Title</h1><h2>1 Introduction</h2>
<p>${"Retrieval augmented generation combines a language model with an external corpus. ".repeat(4)}</p>
<h2>2 Method</h2>
<p>${"The method builds a graph over the corpus and summarises its communities. ".repeat(4)}</p>
<p>${"At query time it maps questions to community summaries. ".repeat(4)}</p>
<h3>2.1 Construction</h3>
<p>${"Construction extracts entities and relations, then clusters them. ".repeat(4)}</p>
</div></div></body></html>`;

function respond(body: string, contentType: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": contentType } });
}

describe("readSource", () => {
  it("reads the HTML full text and records full_text", async () => {
    const outcome = await readSource(
      { url: "https://arxiv.org/abs/2401.00001" },
      {
        fetchImpl: async (input) =>
          String(input).includes("/html/") ? respond(FULL_TEXT_PAGE, "text/html") : respond(ABS_PAGE, "text/html"),
      },
    );
    expect(outcome.status).toBe("ok");
    expect(outcome.scope).toBe("full_text");
    expect(outcome.readUrl).toContain("/html/");
    expect(outcome.paragraphs.length).toBeGreaterThanOrEqual(4);
    // The paragraph text is a substring of the saved text at the recorded range.
    for (const paragraph of outcome.paragraphs) {
      expect(outcome.text.slice(paragraph.charStart, paragraph.charEnd)).toBe(paragraph.text);
    }
    // The heading path says which section each paragraph came from.
    const method = outcome.paragraphs.find((paragraph) => paragraph.text.includes("graph over the corpus"));
    expect(method?.headingPath).toContain("2 Method");
  });

  it("falls back to the paper's own abstract page and says so", async () => {
    const outcome = await readSource(
      { url: "https://arxiv.org/abs/1409.0473" },
      {
        fetchImpl: async (input, init) =>
          String(input).includes("/html/")
            ? respond("not found", "text/html", 404)
            : respond(ABS_PAGE, "text/html", 200),
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        ...{},
      },
    );
    expect(outcome.status).toBe("ok");
    expect(outcome.scope).toBe("abstract");
    expect(outcome.readUrl).toContain("/abs/");
    expect(outcome.text).toContain("studies a method");
    expect(outcome.note).toContain("abstract");
  });

  it("reports a PDF honestly instead of pretending to have read it", async () => {
    const outcome = await readSource(
      { url: "https://example.org/paper.pdf" },
      { fetchImpl: async () => respond("%PDF-1.7 binary", "application/pdf") },
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.scope).toBeNull();
    expect(outcome.text).toBe("");
    expect(outcome.failure).toContain("PDF");
  });

  it("records nothing when the source cannot be fetched", async () => {
    const outcome = await readSource(
      { url: "https://arxiv.org/abs/0000.00000" },
      { fetchImpl: async () => respond("gone", "text/html", 404) },
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.text).toBe("");
    expect(outcome.paragraphs).toEqual([]);
    expect(outcome.failure).toContain("404");
  });

  it("reads a plain-text document as a full text", async () => {
    const document = `Agent Memory systems\n\nAn agent memory system stores what an agent has seen.\n\nRetrieval from memory is the second half of the problem.`;
    const outcome = await readSource({ url: "https://example.org/notes.md" }, {
      fetchImpl: async () => respond(document, "text/markdown"),
    });
    expect(outcome.status).toBe("ok");
    expect(outcome.scope).toBe("full_text");
    expect(outcome.paragraphs.length).toBe(3);
  });
});
