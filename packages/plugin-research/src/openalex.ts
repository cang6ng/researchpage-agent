/**
 * The fallback discovery provider: OpenAlex.
 *
 * arXiv is a single point of failure for this product — one API, one rate
 * limit, one outage — and a real 429 in front of a user proved it. OpenAlex is
 * the fallback because it is a different service with a different operator and
 * a different level of access: it needs no key and no application, it answers
 * with real metadata (title, authors, DOI, publication date, venue, landing
 * page, open-access PDF, and the paper's own abstract), and — the part that
 * matters most for this product — it publishes a landing page URL, so a
 * candidate found here can still be *read* rather than merely listed.
 *
 * What this module refuses to do is dress OpenAlex up as arXiv. It does not
 * invent an arXiv id for a work that has none: `providerId` is the OpenAlex
 * work id, `arxivId` is filled only when the work genuinely is an arXiv
 * preprint (OpenAlex records that in its landing page or in an
 * `10.48550/arxiv.…` DOI), and the reader decides per source which of the two
 * it can actually fetch.
 *
 * Scope, deliberately: search and metadata only. No author disambiguation, no
 * citation graph, no filtering language — the product compares mechanisms, and
 * one honest query path is worth more than a filter surface nobody asked for.
 */

import {
  attemptWithProvider,
  classifyStatus,
  classifyThrown,
  PROVIDER_NAMES,
  retryAfterMsOf,
  type AttemptResult,
  type FetchLike,
  type ResearchProvider,
  type SearchCandidate,
  type SearchOutcome,
  type SearchOptions,
} from "./search.js";

const OPENALEX_ENDPOINT = "https://api.openalex.org/works";
const USER_AGENT = "researchpage-agent/0.1 (competition demo; contact: local run)";

/**
 * OpenAlex's polite pool: a `mailto` in the query. It is a static
 * identification string, not a credential, and it is the whole of this
 * provider's access configuration — there is no key to leak or to expire.
 */
const CONTACT = "researchpage-agent@example.invalid";

/**
 * The fields this provider reads.
 *
 * Naming them keeps the answer small and makes the contract explicit: the
 * product uses exactly these, and a field this product does not read is not
 * something to ask for on every request.
 */
const SELECT_FIELDS = [
  "id",
  "doi",
  "title",
  "display_name",
  "publication_year",
  "publication_date",
  "type",
  "authorships",
  "primary_location",
  "best_oa_location",
  "open_access",
  "abstract_inverted_index",
].join(",");

/** How many results one OpenAlex request may ask for. */
const MAX_PER_PAGE = 20;

interface OpenAlexLocation {
  readonly landing_page_url?: string | null;
  readonly pdf_url?: string | null;
  readonly source?: { readonly display_name?: string | null } | null;
  readonly is_oa?: boolean | null;
}

interface OpenAlexWork {
  readonly id?: string | null;
  readonly doi?: string | null;
  readonly title?: string | null;
  readonly display_name?: string | null;
  readonly publication_year?: number | null;
  readonly publication_date?: string | null;
  readonly type?: string | null;
  readonly authorships?: readonly { readonly author?: { readonly display_name?: string | null } | null }[] | null;
  readonly primary_location?: OpenAlexLocation | null;
  readonly best_oa_location?: OpenAlexLocation | null;
  readonly open_access?: { readonly is_oa?: boolean | null; readonly oa_url?: string | null } | null;
  readonly abstract_inverted_index?: Readonly<Record<string, readonly number[]>> | null;
}

/**
 * The abstract, rebuilt from OpenAlex's inverted index.
 *
 * OpenAlex stores abstracts as word → positions rather than as text, so the
 * sentence in a candidate is the paper's own abstract re-assembled in position
 * order — not a summary this product wrote, and not a paraphrase. Anything
 * malformed is dropped rather than guessed at: a candidate with no abstract is
 * honest, a candidate with an invented one is not.
 */
export function abstractFromInvertedIndex(index: Readonly<Record<string, readonly number[]>> | null | undefined): string {
  if (index === null || index === undefined) return "";
  const slots: string[] = [];
  for (const [word, positions] of Object.entries(index)) {
    if (!Array.isArray(positions)) continue;
    for (const position of positions) {
      if (!Number.isInteger(position) || position < 0 || position > 10_000) continue;
      slots[position] = word;
    }
  }
  return slots.filter((word) => word !== undefined).join(" ").replace(/\s+/g, " ").trim();
}

/** The OpenAlex work id, without its URL prefix. */
export function openAlexIdOf(raw: string | null | undefined): string {
  return (raw ?? "").trim().replace(/^https?:\/\/openalex\.org\//i, "");
}

/**
 * The arXiv id this OpenAlex work really carries, if any.
 *
 * Two honest signals exist: an arXiv landing page, and the arXiv DOI prefix
 * `10.48550/arxiv.…`. Both are checked, and neither is inferred from the work
 * merely being a preprint.
 */
function arxivIdFromWork(work: OpenAlexWork): string | undefined {
  const candidates = [work.primary_location?.landing_page_url, work.best_oa_location?.landing_page_url, work.open_access?.oa_url];
  for (const url of candidates) {
    if (typeof url !== "string") continue;
    const match = /arxiv\.org\/(?:abs|pdf|html)\/([^/?#]+?)(?:v\d+)?(?:\.pdf)?(?:[?#].*)?$/.exec(url);
    if (match?.[1] !== undefined) return match[1].replace(/v\d+$/i, "");
  }
  const doi = (work.doi ?? "").replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
  const fromDoi = /^10\.48550\/arxiv\.(.+)$/i.exec(doi);
  return fromDoi?.[1] === undefined ? undefined : fromDoi[1].replace(/v\d+$/i, "");
}

/**
 * Where a reader should go for this work.
 *
 * The order is the product's preference: the publisher's own landing page
 * first (that is the page a reader can actually read), then the open-access
 * landing page, then an arXiv `abs` page when the work has one, and only then
 * a DOI link — which resolves, but through a redirect the reader's browser may
 * be asked to authenticate at.
 */
function landingUrlOf(work: OpenAlexWork, arxivId: string | undefined): string {
  const primary = typeof work.primary_location?.landing_page_url === "string" ? work.primary_location.landing_page_url : "";
  if (primary.length > 0 && !/^https?:\/\/(dx\.)?doi\.org\//i.test(primary)) return primary;
  const best = typeof work.best_oa_location?.landing_page_url === "string" ? work.best_oa_location.landing_page_url : "";
  if (best.length > 0 && !/^https?:\/\/(dx\.)?doi\.org\//i.test(best)) return best;
  if (arxivId !== undefined) return `https://arxiv.org/abs/${arxivId}`;
  if (primary.length > 0) return primary;
  if (best.length > 0) return best;
  return openAlexIdOf(work.id);
}

/** The PDF this work exposes, when it exposes one. */
function pdfUrlOf(work: OpenAlexWork): string | null {
  const candidates = [
    work.best_oa_location?.pdf_url,
    work.primary_location?.pdf_url,
    work.open_access?.oa_url !== null && work.open_access?.oa_url !== undefined && /\.pdf($|\?)/i.test(work.open_access.oa_url)
      ? work.open_access.oa_url
      : null,
  ];
  for (const url of candidates) if (typeof url === "string" && url.length > 0) return url;
  return null;
}

/** One OpenAlex work as a candidate, or nothing when it cannot be located. */
export function candidateOfOpenAlexWork(work: OpenAlexWork): SearchCandidate | null {
  const title = (work.title ?? work.display_name ?? "").trim();
  const arxivId = arxivIdFromWork(work);
  const landingUrl = landingUrlOf(work, arxivId);
  if (title.length === 0 || landingUrl.length === 0) return null;
  const authors = (work.authorships ?? [])
    .map((authorship) => (authorship.author?.display_name ?? "").trim())
    .filter((name) => name.length > 0);
  const doi = (work.doi ?? "").replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").trim();
  const venue =
    (work.primary_location?.source?.display_name ?? "").trim() ||
    (typeof work.type === "string" && work.type.length > 0 ? `OpenAlex ${work.type}` : "OpenAlex");
  const publishedAt = (work.publication_date ?? "").trim();
  return {
    provider: "openalex",
    providerId: openAlexIdOf(work.id),
    title,
    authors,
    abstract: abstractFromInvertedIndex(work.abstract_inverted_index),
    landingUrl,
    pdfUrl: pdfUrlOf(work),
    publishedAt: publishedAt.length > 0 ? publishedAt : null,
    doi: doi.length > 0 ? doi : null,
    venue,
    ...(arxivId === undefined ? {} : { arxivId }),
  };
}

/** Parses one OpenAlex answer into candidates. Exported so a fixture can pin the shape. */
export function parseOpenAlexWorks(json: string): { readonly total: number | null; readonly candidates: readonly SearchCandidate[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    return { total: null, candidates: [] };
  }
  const body = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const results = Array.isArray(body["results"]) ? (body["results"] as OpenAlexWork[]) : [];
  const meta = typeof body["meta"] === "object" && body["meta"] !== null ? (body["meta"] as Record<string, unknown>) : {};
  const count = typeof meta["count"] === "number" && Number.isFinite(meta["count"]) ? meta["count"] : null;
  const candidates: SearchCandidate[] = [];
  for (const work of results) {
    const candidate = candidateOfOpenAlexWork(work);
    if (candidate !== null) candidates.push(candidate);
  }
  return { total: count, candidates };
}

function requestUrlFor(query: string, limit: number): string {
  const search = encodeURIComponent(query);
  return `${OPENALEX_ENDPOINT}?search=${search}&per-page=${limit}&select=${SELECT_FIELDS}&mailto=${CONTACT}`;
}

/**
 * One real OpenAlex search.
 *
 * OpenAlex answers a free-text query with relevance-ranked works, so the
 * relaxed query ladder arXiv needs is not repeated here: one query, one
 * request, and the same bounded retry every provider gets. What it does share
 * is the classification — an outage here is a classified failure with a reader
 * -facing sentence, not the word「失败」.
 */
export async function searchOpenAlex(query: string, options: SearchOptions): Promise<SearchOutcome> {
  const result = await attemptOpenAlex(query, options);
  if (result.ok) return result.value;
  throw result.failure;
}

/** One OpenAlex search that reports its failure instead of throwing it. */
export async function attemptOpenAlex(query: string, options: SearchOptions): Promise<AttemptResult<SearchOutcome>> {
  const limit = Math.max(1, Math.min(MAX_PER_PAGE, Math.trunc(options.limit)));
  const fetchImpl: FetchLike = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const requestUrl = requestUrlFor(query, limit);
  const provider: ResearchProvider = "openalex";

  return attemptWithProvider({
    provider,
    query,
    requestUrl,
    options,
    send: async ({ signal }) => {
      let response: Response;
      try {
        response = await fetchImpl(requestUrl, {
          headers: { "user-agent": USER_AGENT, accept: "application/json" },
          signal,
          redirect: "follow",
        });
      } catch (error) {
        throw classifyThrown(provider, error, requestUrl, signal);
      }
      if (response.status !== 200) {
        throw classifyStatus(provider, response.status, requestUrl, retryAfterMsOf(response, now));
      }
      try {
        return await response.text();
      } catch (error) {
        throw classifyThrown(provider, error, requestUrl, signal);
      }
    },
    finalize: (json) => {
      const parsed = parseOpenAlexWorks(json);
      return {
        provider,
        query,
        requestUrl,
        fetchedAt: now().toISOString(),
        total: parsed.total,
        candidates: parsed.candidates.slice(0, limit),
      };
    },
    label: PROVIDER_NAMES[provider],
  });
}
