/**
 * The one real discovery path: arXiv's public API.
 *
 * It was chosen by trying it, in this repository, on 2026-10-05: the API needs
 * no key and no application, it answers with real metadata (title, authors,
 * abstract summary, abs/PDF links, DOI when the paper has one), and it is the
 * right corpus for the product's scope — public technical papers. The module
 * keeps exactly one provider on purpose: a second entry point is a scope cut,
 * not a feature, and every candidate it returns is a *candidate* — metadata
 * that may later be read, never evidence by itself.
 *
 * Two operational rules are respected because they are what keeps a public API
 * usable: requests are serialized with the interval the API documentation asks
 * for, and every request carries a timeout and an explicit user agent.
 */

const ARXIV_ENDPOINT = "https://export.arxiv.org/api/query";
const ARXIV_MIN_INTERVAL_MS = 3_000;
const DEFAULT_TIMEOUT_MS = 20_000;
const USER_AGENT = "researchpage-agent/0.1 (competition demo; contact: local run)";

export interface SearchCandidate {
  readonly title: string;
  readonly authors: readonly string[];
  readonly abstract: string;
  readonly absUrl: string;
  readonly pdfUrl: string | null;
  readonly publishedAt: string | null;
  readonly arxivId: string;
  readonly primaryCategory: string;
  readonly doi: string | null;
}

export interface SearchOutcome {
  readonly provider: "arxiv";
  readonly query: string;
  readonly requestUrl: string;
  readonly fetchedAt: string;
  readonly total: number | null;
  readonly candidates: readonly SearchCandidate[];
}

export class SearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchError";
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

let lastRequestAt = 0;
let queue: Promise<unknown> = Promise.resolve();

/** Serializes arXiv calls and keeps the documented interval between them. */
async function rateLimited<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = lastRequestAt + ARXIV_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    try {
      return await task();
    } finally {
      lastRequestAt = Date.now();
    }
  });
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_whole, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_whole, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function clean(text: string): string {
  return decodeEntities(text).replace(/\s+/g, " ").trim();
}

function field(entry: string, tag: string): string {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(entry);
  return match === null ? "" : clean(match[1] ?? "");
}

/**
 * Query words that carry no search meaning on their own.
 *
 * The ladder below relaxes a query by dropping terms, and "From", "Local" and
 * "to" are exactly how a relaxed query lands on an unrelated paper. Removing
 * them first is what makes the relaxed query still be about the topic.
 */
const QUERY_STOP_WORDS: ReadonlySet<string> = new Set([
  "from",
  "to",
  "the",
  "a",
  "an",
  "of",
  "and",
  "or",
  "for",
  "with",
  "in",
  "on",
  "at",
  "by",
  "is",
  "are",
  "be",
  "as",
  "that",
  "this",
  "these",
  "those",
  "it",
  "its",
  "how",
  "what",
  "which",
  "between",
  "vs",
  "versus",
  "using",
  "use",
  "used",
  "about",
  "into",
  "over",
  "under",
  "paper",
]);

/**
 * The indexable terms of a query, most significant first.
 *
 * arXiv's grammar is a boolean over fields and a bare phrase is ambiguous, so
 * the caller's words become ANDed `all:` terms. Non-Latin terms are dropped —
 * arXiv indexes English text, and sending them produces empty result sets that
 * look like failures.
 */
export function queryTerms(query: string): readonly string[] {
  return query
    .split(/[\s,;:，、。：]+/)
    .map((term) => term.replace(/["'()]/g, "").trim())
    .filter((term) => /^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(term))
    .filter((term) => !QUERY_STOP_WORDS.has(term.toLowerCase()))
    .slice(0, 6);
}

/** The `search_query` for a term list. */
export function buildArxivQuery(terms: readonly string[]): string {
  if (terms.length === 0) throw new SearchError("the query has no terms arXiv can index; use English keywords");
  return terms.map((term) => `all:${term}`).join("+AND+");
}

/**
 * The queries one search tries, in order.
 *
 * An AND over every word of a long, model-written query is how a real search
 * ends at zero candidates, so the search relaxes instead of reporting "no
 * results": all terms, then the first three, then the first two, then the first
 * one. Whatever answered is recorded in the outcome, so a thin result set is
 * visible as such — and because the means-nothing words are gone by now, the
 * last rung is still about the topic rather than about the grammar.
 */
export function queryLadder(query: string): readonly (readonly string[])[] {
  const terms = queryTerms(query);
  if (terms.length === 0) throw new SearchError("the query has no terms arXiv can index; use English keywords");
  const ladder: (readonly string[])[] = [terms];
  if (terms.length > 3) ladder.push(terms.slice(0, 3));
  if (terms.length > 2) ladder.push(terms.slice(0, 2));
  if (terms.length > 1) ladder.push(terms.slice(0, 1));
  return ladder;
}

/** Parses one Atom feed into candidates. Exported so a fixture can pin the grammar. */
export function parseArxivFeed(xml: string): { readonly total: number | null; readonly candidates: readonly SearchCandidate[] } {
  const totalMatch = /<opensearch:totalResults[^>]*>(\d+)<\/opensearch:totalResults>/.exec(xml);
  const total = totalMatch === null ? null : Number.parseInt(totalMatch[1] ?? "0", 10);

  const candidates: SearchCandidate[] = [];
  const entryPattern = /<entry>([\s\S]*?)<\/entry>/g;
  let entry: RegExpExecArray | null;
  while ((entry = entryPattern.exec(xml)) !== null) {
    const body = entry[1] ?? "";
    const rawId = field(body, "id");
    const absUrl = rawId.startsWith("http") ? rawId : "";
    const arxivId = /abs\/([^/]+)$/.exec(absUrl)?.[1] ?? "";
    if (absUrl === "") continue;

    const authors: string[] = [];
    const authorPattern = /<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g;
    let author: RegExpExecArray | null;
    while ((author = authorPattern.exec(body)) !== null) authors.push(clean(author[1] ?? ""));

    const pdfMatch = /<link[^>]*title="pdf"[^>]*href="([^"]+)"/.exec(body);
    const publishedAt = field(body, "published");
    const primaryCategory = /<arxiv:primary_category[^>]*term="([^"]+)"/.exec(body)?.[1] ?? "";
    const doi = field(body, "arxiv:doi");

    candidates.push({
      title: field(body, "title"),
      authors,
      abstract: field(body, "summary"),
      absUrl,
      pdfUrl: pdfMatch === null ? null : pdfMatch[1] ?? null,
      publishedAt: publishedAt === "" ? null : publishedAt,
      arxivId,
      primaryCategory,
      doi: doi === "" ? null : doi,
    });
  }
  return { total, candidates };
}

export interface SearchOptions {
  readonly limit: number;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly fetchImpl?: FetchLike;
  /** The clock the outcome records; a test passes a fixed one. */
  readonly now?: () => Date;
}

/**
 * One real search. Every call goes to the network unless a `fetchImpl` is
 * handed in, and the outcome records the exact request URL and time so a
 * candidate's provenance is checkable later.
 *
 * The ladder runs until a query returns candidates; the outcome carries the
 * query that actually answered, so a report's provenance names the real request
 * rather than the words it started from.
 */
export async function searchArxiv(query: string, options: SearchOptions): Promise<SearchOutcome> {
  const limit = Math.max(1, Math.min(20, Math.trunc(options.limit)));
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());

  const request = async (searchQuery: string): Promise<{ total: number | null; candidates: readonly SearchCandidate[]; url: string }> => {
    const requestUrl = `${ARXIV_ENDPOINT}?search_query=${searchQuery}&start=0&max_results=${limit}&sortBy=relevance&sortOrder=descending`;
    const xml = await rateLimited(async () => {
      const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
      let answer: Response;
      try {
        answer = await fetchImpl(requestUrl, {
          headers: { "user-agent": USER_AGENT, accept: "application/atom+xml" },
          signal,
          redirect: "follow",
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : "network failure";
        throw new SearchError(`arXiv request failed: ${reason}`);
      }
      if (!answer.ok) throw new SearchError(`arXiv answered HTTP ${answer.status}`);
      return answer.text();
    });
    const parsed = parseArxivFeed(xml);
    return { total: parsed.total, candidates: parsed.candidates.slice(0, limit), url: requestUrl };
  };

  let last: { total: number | null; candidates: readonly SearchCandidate[]; url: string } | undefined;
  for (const terms of queryLadder(query)) {
    last = await request(buildArxivQuery(terms));
    if (last.candidates.length > 0) break;
  }
  const answer = last ?? { total: null, candidates: [], url: "" };

  return {
    provider: "arxiv",
    query,
    requestUrl: answer.url,
    fetchedAt: now().toISOString(),
    total: answer.total,
    candidates: answer.candidates,
  };
}

/** The arXiv id inside an abs/PDF/HTML URL, when there is one. */
export function arxivIdOf(url: string): string | undefined {
  const match = /arxiv\.org\/(?:abs|pdf|html)\/([^/?#]+?)(?:v\d+)?(?:\.pdf)?(?:[?#].*)?$/.exec(url);
  return match?.[1];
}
