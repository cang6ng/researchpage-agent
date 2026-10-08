/**
 * The feasibility checks that must talk to the real world.
 *
 * They are skipped unless `RESEARCHPAGE_REAL_NETWORK=1`, because a suite that
 * silently reached the network on every run would be neither honest about nor
 * cheap about what it is doing — and a *skip* is reported as a skip, never as a
 * pass. When they do run, they are the evidence that the product's discovery
 * and read paths are real: an arXiv query with real candidates, a real HTML
 * full text, and a real excerpt that is provably a substring of the saved read.
 *
 * The last block checks the other half of the body-scope rule on the open web:
 * a subscription landing page must not be read as the paper's body, and a real
 * open-access article must still be.
 */

import { describe, expect, it } from "vitest";

import { draftEvidence, pickParagraphs, tokenize, verifyEvidenceText } from "../src/evidence.js";
import { readSource } from "../src/read.js";
import { ProviderCircuitBreaker, searchSources } from "../src/discovery.js";
import { attemptArxiv, searchArxiv, SearchError } from "../src/search.js";
import { searchOpenAlex } from "../src/openalex.js";

const enabled = process.env["RESEARCHPAGE_REAL_NETWORK"] === "1";
const TOPIC = process.env["RESEARCHPAGE_TOPIC"] ?? "GraphRAG query-focused summarization knowledge graph";

describe.skipIf(!enabled)("real search and read (network)", () => {
  it("finds real GraphRAG candidates through arXiv", { timeout: 60_000 }, async () => {
    const outcome = await searchArxiv(TOPIC, { limit: 5 });
    expect(outcome.provider).toBe("arxiv");
    expect(outcome.candidates.length).toBeGreaterThan(0);
    for (const candidate of outcome.candidates) {
      expect(candidate.title.length).toBeGreaterThan(8);
      expect(candidate.landingUrl).toMatch(/^http/);
      expect(candidate.abstract.length).toBeGreaterThan(50);
      console.log(`[search] ${candidate.arxivId} :: ${candidate.title}`);
    }
    // The canonical GraphRAG paper is one of the real hits for a topic query,
    // which is what "the search is about the topic" has to mean.
    expect(outcome.candidates.some((candidate) => (candidate.arxivId ?? "").startsWith("2404.16130"))).toBe(true);

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

/**
 * The fallback provider, against the real service.
 *
 * This is the half of the reliability work that cannot be proved offline: a
 * second API really is reachable, really answers with metadata, and a paper it
 * finds really can be read into a snapshot whose excerpts are substrings of the
 * saved text. What the *rate-limited* path looks like is pinned deterministically
 * in `discovery-resilience.test.ts`; here the question is whether the fallback
 * exists at all on a real network.
 *
 * Nothing here is reported as a pass unless it really happened: when a provider
 * is unreachable the test says so and fails, rather than falling back to a
 * fixture and calling it a smoke test.
 */
describe.skipIf(!enabled)("real fallback discovery (network)", () => {
  it("records arXiv's current state without guessing it", { timeout: 90_000 }, async () => {
    const answer = await attemptArxiv("GraphRAG query-focused summarization", { limit: 3 });
    if (answer.ok) {
      console.log(`[arxiv-live] answered with ${answer.value.candidates.length} candidates`);
      expect(answer.value.candidates.length).toBeGreaterThan(0);
      return;
    }
    // A live 429 is not a test failure — it is the state of the world, and it
    // has to be *classified* rather than reported as「搜索失败」.
    const failure = answer.failure as SearchError;
    console.log(`[arxiv-live] unavailable: kind=${failure.kind} status=${failure.status ?? "—"} attempts=${failure.attempts.length}`);
    expect(["rate_limited", "timeout", "network_error", "server_error"]).toContain(failure.kind);
    expect(failure.userMessage.length).toBeGreaterThan(0);
  });

  it("finds real candidates through OpenAlex, with the metadata the product reads", { timeout: 90_000 }, async () => {
    const outcome = await searchOpenAlex("GraphRAG query-focused summarization", { limit: 5 });
    expect(outcome.provider).toBe("openalex");
    expect(outcome.candidates.length).toBeGreaterThan(0);
    for (const candidate of outcome.candidates) {
      expect(candidate.title.length).toBeGreaterThan(8);
      expect(candidate.landingUrl).toMatch(/^http/);
      expect(candidate.provider).toBe("openalex");
      expect(candidate.providerId.length).toBeGreaterThan(0);
      console.log(
        `[openalex] ${candidate.providerId} doi=${candidate.doi ?? "—"} arxiv=${candidate.arxivId ?? "—"} venue=${candidate.venue} :: ${candidate.title}`,
      );
    }
    // A work OpenAlex records as an arXiv preprint carries the arXiv id the
    // reader can actually fetch — that is what keeps the fallback readable.
    const arxivDerived = outcome.candidates.filter((candidate) => (candidate.arxivId ?? "").length > 0);
    console.log(`[openalex] ${arxivDerived.length}/${outcome.candidates.length} candidates point at an arXiv preprint`);
  });

  it("reads a fallback candidate into a real snapshot with verifiable evidence", { timeout: 120_000 }, async () => {
    const found = await searchOpenAlex(TOPIC, { limit: 5 });
    expect(found.candidates.length).toBeGreaterThan(0);
    // Prefer a candidate the reader can actually fetch as text: an arXiv
    // preprint gives the HTML full text, a publisher landing page gives the
    // abstract at worst — both are honest reads, and the test reports which.
    const ordered = [...found.candidates].sort((a, b) => Number((b.arxivId ?? "").length > 0) - Number((a.arxivId ?? "").length > 0));
    let read: Awaited<ReturnType<typeof readSource>> | undefined;
    for (const candidate of ordered.slice(0, 3)) {
      const attempt = await readSource({
        url: candidate.landingUrl,
        metadata: {
          provider: "openalex",
          workUrl: found.requestUrl,
          title: candidate.title,
          abstract: candidate.abstract,
          doi: candidate.doi,
        },
      });
      if (attempt.status === "ok") {
        read = attempt;
        break;
      }
      console.log(`[fallback-read] ${candidate.landingUrl} → ${attempt.failure}`);
    }
    expect(read, "no fallback candidate could be read into a snapshot").toBeDefined();
    const outcome = read as NonNullable<typeof read>;
    console.log(`[fallback-read] ${outcome.readUrl} scope=${outcome.scope} paragraphs=${outcome.paragraphs.length} chars=${outcome.text.length}`);
    console.log(`[fallback-read] note: ${outcome.note}`);
    expect(["full_text", "body_excerpt", "abstract"]).toContain(outcome.scope);
    if (outcome.scope === "abstract") {
      // An abstract-level read is allowed, and it is never dressed up as the
      // body: the note says where the text came from.
      expect(outcome.note).toContain("abstract");
    } else {
      expect(outcome.paragraphs.length).toBeGreaterThan(3);
    }

    const picks = pickParagraphs(outcome.paragraphs, tokenize("graph retrieval summarization evaluation"), 2);
    for (const pick of picks) {
      const evidence = draftEvidence({
        taskId: "task_0000000000000000",
        sourceId: "src_0000000000000000",
        readId: "read_0000000000000000",
        readScope: outcome.scope ?? "abstract",
        draft: { paragraph: pick.paragraph, cells: [], pickedBecause: pick.because },
        now: new Date().toISOString(),
      });
      expect(verifyEvidenceText(evidence, outcome.text).ok).toBe(true);
      console.log(`[fallback-evidence] ${evidence.locator.headingPath.join(" > ")} :: ${evidence.excerpt.slice(0, 90)}…`);
    }
  });

  it("goes through the real fallback chain and records what each provider did", { timeout: 120_000 }, async () => {
    const breaker = new ProviderCircuitBreaker();
    const outcome = await searchSources(TOPIC, { limit: 5, breaker });
    expect(outcome.providersTried?.length ?? 0).toBeGreaterThan(0);
    console.log(
      `[discovery] provider=${outcome.provider} tried=${(outcome.providersTried ?? []).join(",")} candidates=${outcome.candidates.length} attempts=${(outcome.attempts ?? []).length}`,
    );
    for (const attempt of outcome.attempts ?? []) {
      console.log(
        `[discovery-attempt] ${attempt.provider} ok=${attempt.ok}${attempt.ok ? "" : ` kind=${attempt.failureKind ?? "—"} status=${attempt.status ?? "—"}`} ${attempt.elapsedMs}ms`,
      );
    }
    expect(outcome.candidates.length).toBeGreaterThan(0);
    // Every candidate says which provider really found it.
    for (const candidate of outcome.candidates) {
      expect(["arxiv", "openalex"]).toContain(candidate.provider);
    }
  });

  it("answers and reads from OpenAlex when arXiv is down (simulated outage, real fallback)", { timeout: 180_000 }, async () => {
    // The one thing that cannot be produced on demand is a real 429, so the
    // arXiv half is simulated here and *everything else is real*: the real
    // retry policy, the real breaker, the real OpenAlex API, and the real
    // reader fetching the candidate it returns. This is the round's central
    // promise, exercised end to end.
    const now = new Date();
    const arxivAttempts = [1, 2].map((attempt) => ({
      provider: "arxiv" as const,
      query: TOPIC,
      requestUrl: "https://export.arxiv.org/api/query?search_query=all:GraphRAG",
      startedAt: now.toISOString(),
      elapsedMs: 40,
      ok: false,
      attempt,
      failureKind: "rate_limited" as const,
      status: 429,
    }));
    const breaker = new ProviderCircuitBreaker({ now: () => now });
    const outcome = await searchSources(TOPIC, {
      limit: 5,
      breaker,
      impls: {
        arxiv: async () => ({
          ok: false,
          failure: new SearchError("arXiv answered HTTP 429", {
            kind: "rate_limited",
            provider: "arxiv",
            status: 429,
            retryAfterMs: 4_000,
            attempts: arxivAttempts,
          }),
          attempts: arxivAttempts,
        }),
      },
    });

    expect(outcome.provider).toBe("openalex");
    expect(outcome.providersTried).toEqual(["arxiv", "openalex"]);
    expect(outcome.candidates.length).toBeGreaterThan(0);
    expect(outcome.providerFailures?.[0]?.kind).toBe("rate_limited");
    expect(breaker.isOpen("arxiv")).toBe(true);
    console.log(`[outage] arXiv paused; OpenAlex answered with ${outcome.candidates.length} candidates`);

    // …and the candidate it found can really be read.
    const candidate = outcome.candidates[0];
    const read = await readSource({
      url: (candidate as NonNullable<typeof candidate>).landingUrl,
      metadata: {
        provider: "openalex",
        workUrl: outcome.requestUrl,
        title: (candidate as NonNullable<typeof candidate>).title,
        abstract: (candidate as NonNullable<typeof candidate>).abstract,
        doi: (candidate as NonNullable<typeof candidate>).doi,
      },
    });
    console.log(`[outage-read] ${read.readUrl} status=${read.status} scope=${read.scope ?? "—"} note=${read.note}`);
    expect(read.status).toBe("ok");
    expect(["full_text", "body_excerpt", "abstract"]).toContain(read.scope);
    const picks = pickParagraphs(read.paragraphs, tokenize("graph retrieval"), 1);
    expect(picks.length).toBeGreaterThan(0);
    const evidence = draftEvidence({
      taskId: "task_0000000000000000",
      sourceId: "src_0000000000000000",
      readId: "read_0000000000000000",
      readScope: read.scope ?? "abstract",
      draft: { paragraph: picks[0]!.paragraph, cells: [], pickedBecause: picks[0]!.because },
      now: new Date().toISOString(),
    });
    expect(verifyEvidenceText(evidence, read.text).ok).toBe(true);
  });
});

/**
 * Body scope on real publisher pages.
 *
 * These two documents are addressed by URL so the test reads the pages it
 * means: one is a subscription article whose landing page renders its abstract,
 * its reference list and the site navigation, and one is an open-access article
 * whose full text really is on the page. A block page, a paywall or a network
 * refusal is a state of the world and is reported as one — what is never
 * acceptable is calling the first one's text the paper's body.
 */
describe.skipIf(!enabled)("body scope on real publisher pages (network)", () => {
  it("never reads a subscription landing page as the paper's body", { timeout: 90_000 }, async () => {
    const outcome = await readSource({ url: "https://www.nature.com/articles/nature14539" }, { timeoutMs: 35_000 });
    console.log(`[landing] status=${outcome.status} scope=${outcome.scope ?? "—"} chars=${outcome.text.length}`);
    console.log(`[landing] note: ${outcome.note}`);
    expect(["full_text", "body_excerpt"]).not.toContain(outcome.scope);
    if (outcome.status === "ok") {
      // The abstract is what the page really states, so that is what is saved.
      expect(outcome.scope).toBe("abstract");
      expect(outcome.paragraphs.length).toBe(1);
      expect(outcome.text).toContain("multiple processing layers");
    }
  });

  it("keeps the body of a real open-access article", { timeout: 90_000 }, async () => {
    const outcome = await readSource(
      { url: "https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0061217" },
      { timeoutMs: 35_000 },
    );
    console.log(
      `[oa] status=${outcome.status} scope=${outcome.scope ?? "—"} paragraphs=${outcome.paragraphs.length} chars=${outcome.text.length}`,
    );
    console.log(`[oa] note: ${outcome.note}`);
    expect(outcome.status, outcome.failure ?? "").toBe("ok");
    expect(outcome.scope).toBe("full_text");
    expect(outcome.paragraphs.length).toBeGreaterThan(50);

    const picks = pickParagraphs(outcome.paragraphs, tokenize("microbiome census data analysis methods"), 2);
    expect(picks.length).toBeGreaterThan(0);
    for (const pick of picks) {
      const evidence = draftEvidence({
        taskId: "task_0000000000000000",
        sourceId: "src_0000000000000000",
        readId: "read_0000000000000000",
        readScope: outcome.scope ?? "full_text",
        draft: { paragraph: pick.paragraph, cells: [], pickedBecause: pick.because },
        now: new Date().toISOString(),
      });
      expect(verifyEvidenceText(evidence, outcome.text).ok).toBe(true);
      console.log(`[oa] evidence :: ${evidence.locator.headingPath.join(" > ")} :: ${evidence.excerpt.slice(0, 90)}…`);
    }
  });
});
