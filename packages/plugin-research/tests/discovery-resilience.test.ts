/**
 * Discovery when the network says no.
 *
 * Every test here is the deterministic reproduction of a real failure this
 * product hit: arXiv answering 429, a request timing out, a provider that is
 * simply down. None of them touches the network — the provider code, the
 * retries, the breaker and the fallback are the real ones, and only the socket
 * is replaced — because a test that needed arXiv to be broken on the same day
 * it ran would be neither a test nor honest about what it measured.
 *
 * What is asserted is the behaviour a user can see: one bounded retry, a
 * fallback that really answers, an honest failure when nobody does, a
 * cancellation that stops immediately, a breaker that pauses a provider and
 * then lets it come back, and a ledger that counts the requests which failed.
 */

import { describe, expect, it } from "vitest";

import { createResearchService, type ResearchService } from "../src/service.js";
import { openResearchRepository, type ResearchRepository } from "../src/repository.js";
import { ProviderCircuitBreaker, searchSources } from "../src/discovery.js";
import { SearchError, type FetchLike, type SearchOutcome } from "../src/search.js";
import { readSource } from "../src/read.js";

const SESSION = "session_discovery_resilience";

/** An Atom feed with one real-shaped entry. */
function arxivFeed(id: string, title = "A Fixture Paper"): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <opensearch:totalResults>1</opensearch:totalResults>
  <entry>
    <id>http://arxiv.org/abs/${id}</id>
    <published>2024-04-24T00:00:00Z</published>
    <title>${title}</title>
    <summary>We describe a graph-based retrieval method and its evaluation over a corpus of documents.</summary>
    <author><name>A. Author</name></author>
    <link title="pdf" href="https://arxiv.org/pdf/${id}"/>
    <arxiv:primary_category term="cs.CL"/>
  </entry>
</feed>`;
}

/** One OpenAlex answer with one real-shaped work. */
function openAlexBody(id: string, doi: string, title: string, arxivId?: string): string {
  return JSON.stringify({
    meta: { count: 1 },
    results: [
      {
        id: `https://openalex.org/${id}`,
        doi,
        title,
        display_name: title,
        publication_date: "2024-05-01",
        type: "preprint",
        authorships: [{ author: { display_name: "B. Author" } }],
        primary_location: {
          landing_page_url: arxivId === undefined ? "https://example.org/paper" : `https://arxiv.org/abs/${arxivId}`,
          pdf_url: null,
          source: { display_name: "Example Venue" },
        },
        best_oa_location: null,
        open_access: { is_oa: true, oa_url: null },
        abstract_inverted_index: { Graph: [1], retrieval: [0], "improves": [2], "recall.": [3] },
      },
    ],
  });
}

interface Scripted {
  readonly fetch: FetchLike;
  /** Every request URL, in order. */
  readonly calls: string[];
  /** Every wait the retry logic asked for, in ms. */
  readonly waits: number[];
}

/**
 * A network stand-in keyed by provider.
 *
 * Each provider is a list of planned answers, consumed in order; the last one
 * repeats, so "arXiv is rate limiting us" is one entry rather than a promise
 * about how many times the product will ask.
 */
function scriptedNetwork(plan: {
  readonly arxiv?: readonly (Response | "timeout" | "network")[];
  readonly openalex?: readonly (Response | "timeout" | "network")[];
}): Scripted {
  const calls: string[] = [];
  const waits: number[] = [];
  const queues: Record<"arxiv" | "openalex", (Response | "timeout" | "network")[]> = {
    arxiv: [...(plan.arxiv ?? [])],
    openalex: [...(plan.openalex ?? [])],
  };
  const fetchImpl: FetchLike = (input) => {
    calls.push(input);
    const provider = input.includes("openalex.org") ? "openalex" : "arxiv";
    const queue = queues[provider];
    const next = queue.length > 1 ? (queue.shift() as Response | "timeout" | "network") : (queue[0] ?? new Response("", { status: 500 }));
    if (next === "timeout") return Promise.reject(Object.assign(new Error("the operation was aborted due to timeout"), { name: "TimeoutError" }));
    if (next === "network") return Promise.reject(new TypeError("fetch failed"));
    return Promise.resolve(next.clone());
  };
  return {
    calls,
    waits,
    fetch: fetchImpl,
  };
}

function sleepRecorder(waits: number[]): (ms: number) => Promise<void> {
  return (ms: number) => {
    waits.push(ms);
    return Promise.resolve();
  };
}

/**
 * The classified failure of a discovery call that was expected to fail.
 *
 * Written as a helper rather than a `.catch(… as SearchError)` so the type is
 * the failure's and the test still says what it means: this call was supposed
 * to be refused, and here is how.
 */
async function failureOf(promise: Promise<SearchOutcome>): Promise<SearchError> {
  try {
    await promise;
  } catch (error) {
    return error as SearchError;
  }
  throw new Error("expected the discovery call to fail, but it returned an outcome");
}

const json = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { "content-type": "application/json" } });

const xml = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { "content-type": "application/atom+xml" } });

describe("discovery: classified failures and bounded retries (A, B, C, F, G, H)", () => {
  it("A. retries a 429 once, then uses the answer (bounded retry)", async () => {
    const network = scriptedNetwork({
      arxiv: [new Response("", { status: 429, headers: { "retry-after": "6" } }), xml(arxivFeed("2404.16130"))],
    });
    const waits: number[] = [];
    const outcome = await searchSources("GraphRAG summarization", {
      limit: 5,
      fetchImpl: network.fetch,
      sleep: sleepRecorder(waits),
      providers: ["arxiv"],
      breaker: new ProviderCircuitBreaker(),
    });

    expect(network.calls.length).toBe(2);
    expect(outcome.provider).toBe("arxiv");
    expect(outcome.candidates.length).toBe(1);
    // The provider asked for 6 seconds and got them — the wait is the server's
    // own instruction, inside the policy's window. The second wait is the
    // documented three-second interval between two arXiv requests, which the
    // retry does not get to bypass.
    expect(waits[0]).toBe(6_000);
    expect(waits.every((ms) => ms <= 6_000)).toBe(true);
    const attempts = outcome.attempts ?? [];
    expect(attempts.map((attempt) => attempt.ok)).toEqual([false, true]);
    expect(attempts[0]?.failureKind).toBe("rate_limited");
    expect(attempts[0]?.status).toBe(429);
  });

  it("B. gives up on arXiv after two rate limits and answers from the fallback", async () => {
    const network = scriptedNetwork({
      arxiv: [new Response("", { status: 429, headers: { "retry-after": "3" } })],
      openalex: [json(openAlexBody("W1", "https://doi.org/10.48550/arxiv.2404.16130", "Fallback Paper", "2404.16130"))],
    });
    const breaker = new ProviderCircuitBreaker();
    const outcome = await searchSources("GraphRAG summarization", {
      limit: 5,
      fetchImpl: network.fetch,
      sleep: sleepRecorder([]),
      breaker,
    });

    // Two physical attempts at arXiv, none more: a second 429 is the API saying
    // stop, not asking for a third try.
    expect(network.calls.filter((url) => url.includes("arxiv.org")).length).toBe(2);
    expect(network.calls.filter((url) => url.includes("openalex.org")).length).toBe(1);
    expect(outcome.provider).toBe("openalex");
    expect(outcome.providersTried).toEqual(["arxiv", "openalex"]);
    expect(breaker.isOpen("arxiv")).toBe(true);
    expect(breaker.retryAtOf("arxiv")).not.toBeNull();
  });

  it("C. reports the provider that actually answered, and the arXiv id it really has", async () => {
    const network = scriptedNetwork({
      arxiv: [new Response("", { status: 429 })],
      openalex: [json(openAlexBody("W7172414483", "https://doi.org/10.48550/arxiv.2608.01269", "ACE-GraphRAG", "2608.01269"))],
    });
    const outcome = await searchSources("GraphRAG", {
      limit: 5,
      fetchImpl: network.fetch,
      sleep: sleepRecorder([]),
      breaker: new ProviderCircuitBreaker(),
    });

    expect(outcome.provider).toBe("openalex");
    const candidate = outcome.candidates[0];
    expect(candidate?.provider).toBe("openalex");
    expect(candidate?.providerId).toBe("W7172414483");
    // The arXiv id is real — OpenAlex records the preprint — and the product
    // never invents one for a work that has none.
    expect(candidate?.arxivId).toBe("2608.01269");
    expect(candidate?.landingUrl).toBe("https://arxiv.org/abs/2608.01269");
    expect(candidate?.doi).toBe("10.48550/arxiv.2608.01269");
    // The abstract is OpenAlex's inverted index, rebuilt in position order.
    expect(candidate?.abstract).toBe("retrieval Graph improves recall.");
  });

  it("F. fails honestly and stops when every provider is down", async () => {
    const network = scriptedNetwork({
      arxiv: [new Response("", { status: 503 })],
      openalex: ["network"],
    });
    const waits: number[] = [];
    const failure = await failureOf(
      searchSources("GraphRAG", {
        limit: 5,
        fetchImpl: network.fetch,
        sleep: sleepRecorder(waits),
        breaker: new ProviderCircuitBreaker(),
      }),
    );
    expect(failure.kind).toBe("server_error");
    // Bounded: at most two attempts per provider, and never a third.
    expect(network.calls.length).toBeLessThanOrEqual(4);
    expect(failure.attempts.length).toBe(network.calls.length);
    expect(failure.userMessage).toContain("论文检索服务都不可用");
    expect(failure.userMessage).not.toContain("主题");
  });

  it("G. does not retry and does not fall back after a cancellation", async () => {
    const controller = new AbortController();
    const network = scriptedNetwork({ arxiv: [new Response("", { status: 429 })], openalex: [json(openAlexBody("W1", "10.1/x", "Never asked"))] });
    const completedWaits: number[] = [];
    const failure = await failureOf(
      searchSources("GraphRAG", {
        limit: 5,
        signal: controller.signal,
        fetchImpl: (input, init) => {
          controller.abort();
          return network.fetch(input, init);
        },
        // A wait that is interrupted is not a wait that happened: only a wait
        // that ran to completion is recorded, so a cancelled run can be told
        // apart from one that waited and then continued.
        sleep: (ms, signal) =>
          signal?.aborted === true
            ? Promise.reject(new SearchError("cancelled", { kind: "aborted", provider: "arxiv" }))
            : (completedWaits.push(ms), Promise.resolve()),
        breaker: new ProviderCircuitBreaker(),
      }),
    );

    expect(failure.kind).toBe("aborted");
    expect(network.calls.length).toBe(1);
    expect(network.calls[0]).toContain("arxiv.org");
    // The provider's three-second interval wait completes before the request
    // (it is not part of the retry); the 5s retry backoff never does.
    expect(completedWaits.every((ms) => ms <= 3_000)).toBe(true);
  });

  it("H. pauses a provider after a rate limit and probes it again once the cooldown expires", async () => {
    let clock = new Date("2026-10-08T10:00:00.000Z");
    const breaker = new ProviderCircuitBreaker({ cooldownMs: 60_000, now: () => clock });

    // First call: arXiv rate limits, and OpenAlex answers honestly with nothing.
    const first = scriptedNetwork({ arxiv: [new Response("", { status: 429 })], openalex: [json(JSON.stringify({ meta: { count: 0 }, results: [] }))] });
    const firstOutcome = await searchSources("GraphRAG", {
      limit: 3,
      fetchImpl: first.fetch,
      sleep: sleepRecorder([]),
      now: () => clock,
      breaker,
    });
    expect(firstOutcome.provider).toBe("openalex");
    expect(firstOutcome.candidates).toEqual([]);
    // A degraded answer says which provider refused, so a thin result set is
    // never read as "the topic has no literature".
    expect(firstOutcome.providerFailures?.[0]?.provider).toBe("arxiv");
    expect(firstOutcome.providerFailures?.[0]?.kind).toBe("rate_limited");
    expect(breaker.isOpen("arxiv")).toBe(true);

    // Second call, still cooling down: arXiv is not asked at all.
    const second = scriptedNetwork({ arxiv: [xml(arxivFeed("2404.16130"))], openalex: [json(openAlexBody("W2", "10.1/y", "Fallback again"))] });
    await searchSources("GraphRAG", { limit: 3, fetchImpl: second.fetch, sleep: sleepRecorder([]), now: () => clock, breaker });
    expect(second.calls.filter((url) => url.includes("arxiv.org")).length).toBe(0);

    // After the cooldown the provider is probed again — the breaker can never
    // lock a service out permanently, and one success clears the record.
    clock = new Date("2026-10-08T10:01:01.000Z");
    const third = scriptedNetwork({ arxiv: [xml(arxivFeed("2404.16130"))] });
    const thirdOutcome = await searchSources("GraphRAG", {
      limit: 3,
      fetchImpl: third.fetch,
      sleep: sleepRecorder([]),
      now: () => clock,
      breaker,
    });
    expect(thirdOutcome.provider).toBe("arxiv");
    expect(thirdOutcome.candidates.length).toBe(1);
    expect(breaker.isOpen("arxiv")).toBe(false);
    expect(breaker.stateOf("arxiv").consecutiveFailures).toBe(0);
  });

  it("H. pauses a provider that spent both of its attempts on timeouts, and a success clears the record", async () => {
    const breaker = new ProviderCircuitBreaker({ cooldownMs: 60_000 });
    const failing = scriptedNetwork({ arxiv: ["timeout"] });
    const failure = await failureOf(
      searchSources("GraphRAG", { limit: 3, fetchImpl: failing.fetch, sleep: sleepRecorder([]), providers: ["arxiv"], breaker }),
    );
    expect(failure.kind).toBe("timeout");
    expect(failing.calls.length).toBe(2);
    expect(breaker.isOpen("arxiv")).toBe(true);
    expect(breaker.stateOf("arxiv").reason).toBe("timeout");

    breaker.reset();
    expect(breaker.isOpen("arxiv")).toBe(false);
    const healthy = scriptedNetwork({ arxiv: [xml(arxivFeed("2404.16130"))] });
    await searchSources("GraphRAG", { limit: 3, fetchImpl: healthy.fetch, sleep: sleepRecorder([]), providers: ["arxiv"], breaker });
    expect(breaker.isOpen("arxiv")).toBe(false);
    expect(breaker.stateOf("arxiv").consecutiveFailures).toBe(0);
  });
});

/* ------------------------------------------------------------ the service -- */

interface Harness {
  readonly repo: ResearchRepository;
  readonly service: ResearchService;
  readonly taskId: string;
  readonly calls: string[];
  close(): void;
}

interface HarnessOptions {
  readonly arxiv?: readonly (Response | "timeout" | "network")[];
  readonly openalex?: readonly (Response | "timeout" | "network")[];
  /** What the reader returns for any URL; the default is a real HTML page. */
  readonly readFetch?: FetchLike;
  readonly breaker?: ProviderCircuitBreaker;
  readonly now?: () => Date;
}

/**
 * A confirmed task on a real database, with the real discovery path and only
 * the sockets replaced.
 */
function openHarness(options: HarnessOptions = {}): Harness {
  const repo = openResearchRepository({ location: ":memory:" });
  const network = scriptedNetwork(options);
  const service = createResearchService({
    repo,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.breaker === undefined ? {} : { breaker: options.breaker }),
    discovery: {
      fetchImpl: network.fetch,
      sleep: sleepRecorder([]),
    },
    // The reader is the real one too; only its socket is replaced, so a read
    // really extracts paragraphs and really verifies its excerpts.
    read: (request, readOptions) => readSource(request, { ...readOptions, ...(options.readFetch === undefined ? { fetchImpl: network.fetch } : { fetchImpl: options.readFetch }) }),
  });

  service.issueGrant({ sessionId: SESSION, intent: "card", taskId: null });
  const proposed = service.proposeTask(SESSION, {
    topic: "GraphRAG 与图结构检索",
    purpose: "技术选型",
    audience: "工程团队",
    focus: ["机制"],
    exclusions: "",
    lengthTarget: "6 页",
    subjects: [{ name: "GraphRAG" }, { name: "LightRAG" }],
    dimensions: [
      { name: "检索机制", question: "如何检索？" },
      { name: "成本", question: "成本如何？" },
      { name: "更新", question: "如何更新？" },
    ],
  });
  if (proposed.ok !== true) throw new Error(`fixture card was refused: ${JSON.stringify(proposed)}`);
  const taskId = proposed.task.id;
  service.confirmTask(taskId);
  // The pipeline grant, exactly as the runner mints it for a research stage.
  service.issueGrant({ sessionId: SESSION, intent: "research", taskId, targetType: "project", targetId: null, allowResearch: true, scope: "研究" });
  return { repo, service, taskId, calls: network.calls, close: () => repo.close() };
}

const HTML_PAGE = `<!doctype html><html><head><title>Fallback Paper</title></head><body>
<h1>Fallback Paper</h1>
<p>Retrieval over a knowledge graph improves recall on corpus-wide questions by summarising communities.</p>
<p>Community detection partitions the entity graph, and each community is summarised once at index time.</p>
<p>The reported evaluation compares community summaries against source-text summarisation with a judge.</p>
<p>Costs are dominated by the indexing pass, which visits the whole corpus before any question is asked.</p></body></html>`;

/**
 * A subscription publisher's landing page: HTTP 200, no body at all.
 *
 * Its text is the abstract, the reference list and the site chrome — the shape
 * a real Nature landing page extracts into, and the reason a generic page has
 * to earn `full_text` before anything in it may be quoted as body evidence.
 */
const LANDING_PAGE = `<!doctype html><html><head><title>Landing Paper | Nature</title></head><body><article>
<h1>Landing Paper</h1><p>B. Author and colleagues</p>
<h2>Abstract</h2><p>This review surveys graph-based retrieval, the index construction it depends on and the questions it answers well, and reports where its summaries help corpus-level questions rather than entity lookups.</p>
<h2>Access options</h2><p>Subscribe to this journal and receive 51 print issues and online access, or rent or buy this article.</p>
<h2>References</h2><ol>${Array.from(
  { length: 40 },
  (_whole, index) =>
    `<li>Author${index + 1}, A. A study of graph retrieval, study ${index + 1}. Journal of Retrieval Research ${index + 1}(2): 1${index}–${index + 30}, 20${10 + (index % 10)}.</li>`,
).join("")}</ol>
<h2>Acknowledgements</h2><p>We thank the colleagues who discussed this review with us over the years, and the library staff.</p>
<h2>Author information</h2><p>Affiliations, correspondence and the full author list are listed on this page for reference.</p>
<h2>Rights and permissions</h2><p>Reprints and permissions information is available from the publisher together with the licence.</p>
<h2>About this article</h2><p>Cite this article in the journal's own format, or export the citation to a reference manager.</p>
</article></body></html>`;

describe("discovery through the service: ledger, fallback, honest reads (C, D, E, I, J)", () => {
  it("C/I. a successful fallback search is counted as a search, and every request is counted", async () => {
    const harness = openHarness({
      arxiv: [new Response("", { status: 429 })],
      openalex: [json(openAlexBody("W1", "https://doi.org/10.48550/arxiv.2404.16130", "Fallback Paper", "2404.16130"))],
      readFetch: () => Promise.resolve(new Response(HTML_PAGE, { status: 200, headers: { "content-type": "text/html" } })),
    });
    const result = await harness.service.search(harness.taskId, { query: "GraphRAG community summarization" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.provider).toBe("openalex");
    expect(result.providersTried).toEqual(["arxiv", "openalex"]);
    expect(result.attempts).toEqual({ attempted: 3, succeeded: 1, failed: 2 });
    expect(result.sources.length).toBe(1);

    const task = harness.service.getTask(harness.taskId);
    expect(task?.usage.searches).toBe(1);
    expect(task?.discovery?.attemptedRequests).toBe(3);
    expect(task?.discovery?.successfulRequests).toBe(1);
    expect(task?.discovery?.failedRequests).toBe(2);
    expect(task?.discovery?.lastProvider).toBe("openalex");
    expect(task?.discovery?.lastFailure).toBeNull();

    const source = harness.service.sourcesOf(harness.taskId)[0];
    expect(source?.discovery.provider).toBe("openalex");
    expect(source?.discovery.providerId).toBe("W1");
    expect(source?.discovery.requestUrl).toContain("openalex.org");
    harness.close();
  });

  it("E. a fallback candidate really reaches a snapshot and evidence", async () => {
    const harness = openHarness({
      arxiv: [new Response("", { status: 429 })],
      openalex: [json(openAlexBody("W1", "https://doi.org/10.48550/arxiv.2404.16130", "Fallback Paper", "2404.16130"))],
      readFetch: () => Promise.resolve(new Response(HTML_PAGE, { status: 200, headers: { "content-type": "text/html" } })),
    });
    const search = await harness.service.search(harness.taskId, { query: "GraphRAG community summarization" });
    expect(search.ok).toBe(true);
    if (!search.ok) return;
    const sourceId = search.sources[0]?.sourceId as string;

    const cell = harness.service.cellsOf(harness.taskId)[0];
    const read = await harness.service.read(harness.taskId, {
      sourceId,
      question: "How does GraphRAG retrieve over the corpus?",
      terms: ["community", "retrieval"],
      targetCell: cell === undefined ? undefined : { sectionId: cell.sectionId, subjectId: cell.subjectId, dimensionId: cell.dimensionId },
      role: "primary",
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.readScope).toBe("full_text");
    expect(read.evidence.length).toBeGreaterThan(0);
    expect(harness.service.evidenceOf(harness.taskId).length).toBe(read.evidence.length);
    harness.close();
  });

  it("D. a candidate nobody can fetch is recorded as a failure, with no evidence invented", async () => {
    const harness = openHarness({
      arxiv: [new Response("", { status: 429 })],
      openalex: [json(JSON.stringify({ meta: { count: 1 }, results: [{ id: "https://openalex.org/W9", doi: "10.9999/closed", title: "Closed Paper", publication_date: "2024-01-01", authorships: [], primary_location: { landing_page_url: "https://closed.example.org/paper", source: { display_name: "Closed Venue" } }, best_oa_location: null, open_access: { is_oa: false, oa_url: null }, abstract_inverted_index: null }] }))],
      readFetch: () => Promise.resolve(new Response("forbidden", { status: 403, headers: { "content-type": "text/html" } })),
    });
    const search = await harness.service.search(harness.taskId, { query: "closed access paper" });
    expect(search.ok).toBe(true);
    if (!search.ok) return;
    const sourceId = search.sources[0]?.sourceId as string;

    const read = await harness.service.read(harness.taskId, { sourceId, question: "what does it say?" });
    expect(read.ok).toBe(false);
    expect(harness.service.evidenceOf(harness.taskId).length).toBe(0);
    const source = harness.service.sourcesOf(harness.taskId)[0];
    expect(source?.readStatus).toBe("failed");
    expect(source?.snapshotId).toBeNull();
    // The candidate is kept — it is a real paper — but nothing was manufactured
    // to make the read look successful.
    expect(harness.service.sourcesOf(harness.taskId).length).toBe(1);
    harness.close();
  });

  it("D. a candidate whose only readable material is the provider's abstract is marked abstract-level", async () => {
    const abstract = "This paper describes a graph-based retrieval method, its construction pipeline, its query path and the reported evaluation over a large corpus of documents.";
    const harness = openHarness({
      openalex: [
        json(
          JSON.stringify({
            meta: { count: 1 },
            results: [
              {
                id: "https://openalex.org/W7",
                doi: "10.9999/pdfonly",
                title: "Pdf Only Paper",
                publication_date: "2024-01-01",
                authorships: [{ author: { display_name: "C. Author" } }],
                primary_location: { landing_page_url: "https://elsevier.example.org/article.pdf", source: { display_name: "A Journal" } },
                best_oa_location: null,
                open_access: { is_oa: true, oa_url: "https://elsevier.example.org/article.pdf" },
                abstract_inverted_index: Object.fromEntries(abstract.split(" ").map((word, index) => [word, [index]])),
              },
            ],
          }),
        ),
      ],
      readFetch: () => Promise.resolve(new Response("%PDF-1.4", { status: 200, headers: { "content-type": "application/pdf" } })),
    });
    const search = await harness.service.search(harness.taskId, { query: "pdf only paper" });
    expect(search.ok).toBe(true);
    if (!search.ok) return;
    const sourceId = search.sources[0]?.sourceId as string;
    const read = await harness.service.read(harness.taskId, { sourceId, question: "what does it report?" });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.readScope).toBe("abstract");
    // The note says where the text came from, and that it is not the body.
    expect(read.note).toContain("abstract");
    expect(read.note).toContain("不是正文");
    const cell = harness.service.cellsOf(harness.taskId)[0];
    if (cell !== undefined && read.evidence[0] !== undefined) {
      harness.service.recordAssessment(harness.taskId, {
        target: { sectionId: cell.sectionId, subjectId: cell.subjectId, dimensionId: cell.dimensionId },
        evidenceIds: [read.evidence[0].evidenceId],
        relationship: "supports",
        directness: "direct",
        rationale: "supports",
        assessor: "agent",
      });
      expect(harness.service.assessmentsOf(harness.taskId).length).toBe(1);
      // An abstract-level read can never reach「已核对」: the coverage rule the
      // product has always had still holds for material found through a
      // fallback provider.
      const verdict = harness.service.cellsOf(harness.taskId).find((entry) => entry.subjectId === cell.subjectId);
      expect(verdict?.status).not.toBe("reviewed");
    }
    harness.close();
  });

  it("D. a publisher landing page that answers HTTP 200 is recorded as its abstract, not its body", async () => {
    const harness = openHarness({
      arxiv: [new Response("", { status: 429 })],
      openalex: [json(openAlexBody("W8", "10.9999/landing", "Landing Paper"))],
      readFetch: () => Promise.resolve(new Response(LANDING_PAGE, { status: 200, headers: { "content-type": "text/html" } })),
    });
    const search = await harness.service.search(harness.taskId, { query: "graph retrieval review" });
    expect(search.ok).toBe(true);
    if (!search.ok) return;
    const sourceId = search.sources[0]?.sourceId as string;

    const read = await harness.service.read(harness.taskId, { sourceId, question: "what does the review report?" });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.readScope).toBe("abstract");
    expect(read.note).toContain("仅摘要");
    // What was saved is the page's abstract, not the reference list it renders.
    const source = harness.service.sourcesOf(harness.taskId)[0];
    expect(source?.readStatus).toBe("ok");
    expect(source?.readScope).toBe("abstract");
    const snapshot = harness.repo.getSnapshot(source?.snapshotId ?? "");
    expect(snapshot?.scope).toBe("abstract");
    expect(snapshot?.text).toContain("surveys graph-based retrieval");
    expect(snapshot?.text).not.toContain("Journal of Retrieval Research");
    expect(read.evidence.length).toBeGreaterThan(0);
    for (const item of read.evidence) expect(item.scope).toBe("仅摘要");

    // Even when the agent judges the excerpt a direct support, an abstract-level
    // read cannot move the cell to「已核对」.
    const cell = harness.service.cellsOf(harness.taskId)[0];
    expect(cell).toBeDefined();
    if (cell === undefined) return;
    harness.service.recordAssessment(harness.taskId, {
      target: { sectionId: cell.sectionId, subjectId: cell.subjectId, dimensionId: cell.dimensionId },
      evidenceIds: [read.evidence[0]?.evidenceId as string],
      relationship: "supports",
      directness: "direct",
      rationale: "supports",
      assessor: "agent",
    });
    const verdict = harness.service.cellsOf(harness.taskId).find((entry) => entry.subjectId === cell.subjectId);
    expect(verdict?.status).not.toBe("reviewed");
    harness.close();
  });

  it("keeps the activity history bounded and in order, so a reload reads back the recent past", async () => {
    const harness = openHarness({ arxiv: [xml(arxivFeed("2404.16130"))] });
    for (let index = 0; index < 305; index += 1) {
      harness.service.recordActivity({
        taskId: harness.taskId,
        kind: "stage_started",
        message: `第 ${index} 行活动`,
        stage: "preparing",
      });
    }
    const history = harness.service.activityOf(harness.taskId);
    expect(history.length).toBe(300);
    // Oldest first, and it is the *recent* past that survives.
    expect(history[history.length - 1]?.message).toBe("第 304 行活动");
    expect(history[0]?.message).toBe("第 5 行活动");
    harness.close();
  });

  it("I/J. a search nobody could answer is refused with a reason, counted, and written to the activity log", async () => {
    const harness = openHarness({
      arxiv: [new Response("", { status: 429, headers: { "retry-after": "4" } })],
      openalex: [new Response("", { status: 429 })],
    });
    const result = await harness.service.search(harness.taskId, { query: "GraphRAG" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.join("")).toContain("arXiv");
    expect(result.guidance).toContain("不要反复调用");

    const task = harness.service.getTask(harness.taskId);
    // The budget does not pretend a failed search was a search…
    expect(task?.usage.searches).toBe(0);
    // …while the ledger does count the requests that really went out.
    expect(task?.discovery?.attemptedRequests).toBe(4);
    expect(task?.discovery?.failedRequests).toBe(4);
    expect(task?.discovery?.successfulRequests).toBe(0);
    expect(task?.discovery?.lastFailure?.kind).toBe("rate_limited");

    const kinds = harness.service.activityOf(harness.taskId).map((event) => event.kind);
    expect(kinds).toContain("search_started");
    expect(kinds).toContain("retry_wait");
    expect(kinds).toContain("provider_skipped");
    expect(kinds).toContain("search_failed");
    const waits = harness.service.activityOf(harness.taskId).filter((event) => event.kind === "retry_wait");
    expect(waits.length).toBeGreaterThan(0);
    expect(waits[0]?.nextRetryAt).not.toBeNull();
    expect(waits[0]?.message).toContain("等待");
    // Nothing from the network's own words leaks into the reader's history.
    for (const event of harness.service.activityOf(harness.taskId)) {
      expect(event.message).not.toContain("authorization");
      expect(event.message).not.toContain("stack");
    }
    harness.close();
  });
});
