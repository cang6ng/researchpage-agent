/**
 * The feasibility checks that must talk to the real world.
 *
 * They are skipped unless `RESEARCHPAGE_REAL_NETWORK=1`, because a suite that
 * silently reached the network on every run would be neither honest about nor
 * cheap about what it is doing — and a *skip* is reported as a skip, never as a
 * pass. When they do run, they are the evidence that the product's discovery
 * and read paths are real: an arXiv query with real candidates, a real HTML
 * full text, and a real excerpt that is provably a substring of the saved read.
 */

import { describe, expect, it } from "vitest";

import { draftEvidence, pickParagraphs, tokenize, verifyEvidenceText } from "../src/evidence.js";
import { readSource } from "../src/read.js";
import { searchArxiv } from "../src/search.js";

const enabled = process.env["RESEARCHPAGE_REAL_NETWORK"] === "1";
const TOPIC = process.env["RESEARCHPAGE_TOPIC"] ?? "GraphRAG query-focused summarization knowledge graph";

describe.skipIf(!enabled)("real search and read (network)", () => {
  it("finds real GraphRAG candidates through arXiv", { timeout: 60_000 }, async () => {
    const outcome = await searchArxiv(TOPIC, { limit: 5 });
    expect(outcome.provider).toBe("arxiv");
    expect(outcome.candidates.length).toBeGreaterThan(0);
    for (const candidate of outcome.candidates) {
      expect(candidate.title.length).toBeGreaterThan(8);
      expect(candidate.absUrl).toMatch(/^http/);
      expect(candidate.abstract.length).toBeGreaterThan(50);
      console.log(`[search] ${candidate.arxivId} :: ${candidate.title}`);
    }
    // The canonical GraphRAG paper is one of the real hits for a topic query,
    // which is what "the search is about the topic" has to mean.
    expect(outcome.candidates.some((candidate) => candidate.arxivId.startsWith("2404.16130"))).toBe(true);

    const narrow = await searchArxiv("GraphRAG million-token summarization community reports", { limit: 5 });
    expect(narrow.candidates.length).toBeGreaterThan(0);
    console.log(`[search] relaxed query: ${narrow.requestUrl}`);
  });

  it("reads a real full text and produces verifiable evidence", { timeout: 120_000 }, async () => {
    // The paper the demo is about, addressed by id so the test reads the
    // document it means rather than whatever ranked first.
    const outcome = await readSource({ url: "https://arxiv.org/abs/2404.16130" });
    expect(outcome.status, outcome.failure ?? "").toBe("ok");
    expect(outcome.scope).toBe("full_text");
    expect(outcome.paragraphs.length).toBeGreaterThan(50);
    expect(outcome.title).toMatch(/Graph ?RAG/i);
    console.log(`[read] ${outcome.readUrl} scope=${outcome.scope} paragraphs=${outcome.paragraphs.length} chars=${outcome.text.length} title=${outcome.title}`);

    const terms = tokenize("community detection graph construction entities relationships summarization");
    const picks = pickParagraphs(outcome.paragraphs, terms, 3);
    expect(picks.length).toBeGreaterThan(0);
    for (const pick of picks) {
      const evidence = draftEvidence({
        taskId: "task_0000000000000000",
        sourceId: "src_0000000000000000",
        readId: "read_0000000000000000",
        readScope: outcome.scope!,
        draft: { paragraph: pick.paragraph, cells: [], pickedBecause: pick.because },
        now: new Date().toISOString(),
      });
      // The excerpt must be exactly the saved text at the recorded range.
      expect(verifyEvidenceText(evidence, outcome.text).ok).toBe(true);
      // And a tampered excerpt must fail the same check.
      const tampered = { ...evidence, excerpt: `${evidence.excerpt} 编造的内容` };
      expect(verifyEvidenceText(tampered, outcome.text).ok).toBe(false);
      console.log(`[evidence] ${evidence.locator.headingPath.join(" > ")} :: ${evidence.excerpt.slice(0, 100)}…`);
    }
  });

  it("records an abstract-only read for a source without HTML full text", { timeout: 60_000 }, async () => {
    // An old paper: arXiv serves no HTML full text for most papers before 2024.
    const outcome = await readSource({ url: "https://arxiv.org/abs/1409.0473" });
    expect(outcome.status, outcome.failure ?? "").toBe("ok");
    if (outcome.scope === "abstract") {
      expect(outcome.text.length).toBeGreaterThan(200);
      console.log(`[read-abstract] ${outcome.readUrl} :: ${outcome.note}`);
    } else {
      console.log(`[read-abstract] served ${outcome.scope} (HTML available): ${outcome.note}`);
    }
  });

  it("fails honestly when a source cannot be read", { timeout: 60_000 }, async () => {
    const outcome = await readSource({ url: "https://arxiv.org/abs/9999.99999" });
    expect(outcome.status).toBe("failed");
    expect(outcome.scope).toBeNull();
    expect(outcome.text).toBe("");
    console.log(`[read-failure] ${outcome.failure}`);
  });
});
