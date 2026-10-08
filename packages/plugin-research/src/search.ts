/**
 * The discovery contract, and the arXiv provider that was the first real one.
 *
 * Discovery talks to public paper APIs, and the module is split so that adding
 * a second one is a *provider*, not a rewrite: `SearchCandidate` describes a
 * work in the terms both APIs can honestly answer — a provider id, a landing
 * page, a DOI, an abstract — and nothing in it is an arXiv field with another
 * API's answer pushed into it. A candidate is metadata that may later be read;
 * it is never evidence by itself.
 *
 * Two operational rules are respected because they are what keeps a public API
 * usable: requests are serialized with the interval the API documentation asks
 * for, and every request carries a timeout and an explicit user agent.
 *
 * The third rule is what a real 429 taught this module: a failed request is a
 * *classified* failure, not the sentence「搜索失败」. Rate limiting, a timeout,
 * a network error, a 5xx, a request the API will never accept and a user's own
 * cancellation are five different facts with three different answers — retry,
 * give up on this provider, or stop entirely — and only the classification can
 * choose between them.
 */

import type { ResearchActivityKind } from "./domain.js";

const ARXIV_ENDPOINT = "https://export.arxiv.org/api/query";
const USER_AGENT = "researchpage-agent/0.1 (competition demo; contact: local run)";

/**
 * How long one physical request may take.
 *
 * It was 20s, which a genuinely slow arXiv answer — a query the API is
 * building a large result set for — can exceed by simply being slow. 35s is
 * still bounded, and a timeout is now a *retryable* classification, so the
 * extra patience is what makes one retry worth attempting at all.
 */
const DEFAULT_TIMEOUT_MS = 35_000;

/** The provider one candidate, or one failure, came from. */
export type ResearchProvider = "arxiv" | "openalex";

export const PROVIDER_NAMES: Readonly<Record<ResearchProvider, string>> = Object.freeze({
  arxiv: "arXiv",
  openalex: "OpenAlex",
});

/**
 * One work a provider says exists.
 *
 * `landingUrl` is the page a reader opens; `providerId` is the provider's own
 * id, and `arxivId` is filled only when the work really is an arXiv preprint —
 * an OpenAlex id is never written into an arXiv field, and an arXiv id is never
 * invented for a paper that has none.
 */
export interface SearchCandidate {
  readonly provider: ResearchProvider;
  /** The provider's own id: an arXiv id, or an OpenAlex work id. */
  readonly providerId: string;
  readonly title: string;
  readonly authors: readonly string[];
  readonly abstract: string;
  /** The page a reader opens (an abs page, a publisher page, a DOI link). */
  readonly landingUrl: string;
  readonly pdfUrl: string | null;
  readonly publishedAt: string | null;
  readonly doi: string | null;
  /** Where the work lives, in the provider's words (a journal, a repository). */
  readonly venue: string;
  /** Set only when this work is really an arXiv preprint. */
  readonly arxivId?: string | null;
}

/** How one physical request ended, as a fact about that request. */
export interface SearchAttempt {
  readonly provider: ResearchProvider;
  /** The query this request asked, as it was sent. */
  readonly query: string;
  readonly requestUrl: string;
  readonly startedAt: string;
  readonly elapsedMs: number;
  readonly ok: boolean;
  /** Which physical attempt this was for its logical request, 1-based. */
  readonly attempt: number;
  readonly failureKind?: SearchFailureKind;
  readonly status?: number;
  /** Candidates the request returned; 0 is a real answer, not a failure. */
  readonly candidates?: number;
}

export interface SearchOutcome {
  /** The provider whose answer this outcome carries. */
  readonly provider: ResearchProvider;
  readonly query: string;
  readonly requestUrl: string;
  readonly fetchedAt: string;
  readonly total: number | null;
  readonly candidates: readonly SearchCandidate[];
  /** Every provider this call asked, in order. */
  readonly providersTried?: readonly ResearchProvider[];
  /** Every physical request this call made, in order. */
  readonly attempts?: readonly SearchAttempt[];
  /**
   * Providers that failed while another one answered.
   *
   * A search can be answered *and* degraded — arXiv rate limited us, OpenAlex
   * found the paper — and saying so is not a detail: it is the reason a thin
   * result set is thin, and it is what the reader would otherwise have to
   * discover from a missing provider.
   */
  readonly providerFailures?: readonly {
    readonly provider: ResearchProvider;
    readonly kind: SearchFailureKind;
    readonly userMessage: string;
  }[];
}

/**
 * Why a request failed, in the only categories that change what happens next.
 *
 * `rate_limited`, `timeout`, `network_error` and `server_error` may be retried
 * within the provider; `invalid_request` never is; `aborted` means the user or
 * the calling layer cancelled, and a cancelled request must not start a retry
 * or a fallback provider.
 */
export type SearchFailureKind = "rate_limited" | "timeout" | "network_error" | "server_error" | "invalid_request" | "aborted";

const RETRYABLE_KINDS: ReadonlySet<SearchFailureKind> = new Set(["rate_limited", "timeout", "network_error", "server_error"]);

/** Reader-facing words for each classification; never a raw status code alone. */
const FAILURE_SENTENCES: Readonly<Record<SearchFailureKind, string>> = Object.freeze({
  rate_limited: "请求过于频繁（HTTP 429）",
  timeout: "请求超时",
  network_error: "网络连接失败",
  server_error: "服务端错误",
  invalid_request: "请求被服务端拒绝",
  aborted: "请求已被取消",
});

export interface SearchFailureDetails {
  readonly kind: SearchFailureKind;
  readonly provider: ResearchProvider;
  readonly status?: number | null;
  /** The request that failed, for the log and for the reader's context. */
  readonly requestUrl?: string | null;
  /** What the provider itself said to wait, when it said anything. */
  readonly retryAfterMs?: number | null;
  /** The technical sentence; logs and developer views only, never user copy. */
  readonly technical?: string;
  /** The classified wait for the next attempt, when a retry will happen. */
  readonly nextRetryAt?: string | null;
  /** The reader-facing sentence, when the caller can write a better one. */
  readonly userMessage?: string;
}

/**
 * A classified discovery failure.
 *
 * The message is the technical sentence; `userMessage` is the sentence a
 * reader can act on. Keeping both is the point:「arXiv returned HTTP 429」is
 * true and useless to a reader, while「论文检索暂时不可用」is useful and must
 * not replace the detail the log needs.
 */
export class SearchError extends Error {
  readonly kind: SearchFailureKind;
  readonly provider: ResearchProvider;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly requestUrl: string | null;
  readonly retryAfterMs: number | null;
  readonly technical: string;
  /** What to tell the user, in their own words. */
  readonly userMessage: string;
  /** The physical requests made before giving up, for the attempt ledger. */
  readonly attempts: readonly SearchAttempt[];

  constructor(message: string, details: SearchFailureDetails & { readonly attempts?: readonly SearchAttempt[] }) {
    super(message);
    this.name = "SearchError";
    this.kind = details.kind;
    this.provider = details.provider;
    this.status = details.status ?? null;
    this.requestUrl = details.requestUrl ?? null;
    this.retryAfterMs = details.retryAfterMs ?? null;
    this.retryable = RETRYABLE_KINDS.has(details.kind);
    this.technical = details.technical ?? message;
    this.attempts = details.attempts ?? [];
    const what = FAILURE_SENTENCES[details.kind];
    const derived =
      details.kind === "rate_limited"
        ? `${PROVIDER_NAMES[details.provider]}：${what}`
        : `${PROVIDER_NAMES[details.provider]}：${what}${details.status === null || details.status === undefined ? "" : `（HTTP ${details.status}）`}`;
    this.userMessage = details.userMessage ?? derived;
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type SleepLike = (ms: number, signal?: AbortSignal) => Promise<void>;

/**
 * One thing that happened while discovering sources, said to a reader.
 *
 * These are the events a person watching the product needs to see — a request
 * went out, a provider rate limited us, we are waiting, we are switching. They
 * are emitted where the facts are (inside the retry loop and the fallback
 * decision), and the application stores them; nothing here is model reasoning.
 *
 * The names are the activity ledger's own names, so a discovery event becomes a
 * line of the project's history without a translation table in between.
 */
export type DiscoveryEventKind = Extract<
  ResearchActivityKind,
  "request_started" | "request_failed" | "retry_wait" | "provider_skipped" | "provider_fallback" | "candidates_found" | "search_empty"
>;

export interface DiscoveryEvent {
  readonly kind: DiscoveryEventKind;
  readonly level: "info" | "warn" | "error";
  /** One sentence, written for a person; never a raw payload or a tool name. */
  readonly message: string;
  readonly at: string;
  readonly provider: ResearchProvider;
  readonly attempt?: number;
  readonly nextRetryAt?: string | null;
  readonly failureKind?: SearchFailureKind;
}

export interface SearchOptions {
  readonly limit: number;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly fetchImpl?: FetchLike;
  /** The clock the outcome records; a test passes a fixed one. */
  readonly now?: () => Date;
  /** How many physical requests one logical request may make. Default 2. */
  readonly maxAttemptsPerRequest?: number;
  /** The wait between two physical attempts, for tests that cannot wait. */
  readonly sleep?: SleepLike;
  /** The longest a whole call may take, in ms. */
  readonly budgetMs?: number;
  /** The moment the call started, for a caller keeping one budget across providers. */
  readonly deadline?: number;
  /** Where the reader-facing events of one request go. */
  readonly onEvent?: (event: DiscoveryEvent) => void;
}

/** The retry rules one logical request obeys. */
export interface RetryPolicy {
  readonly maxAttemptsPerRequest: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

/**
 * One logical request's retry policy.
 *
 * Two physical attempts is the whole ladder: a public API that answers 429
 * twice in a row is rate limiting this client, not asking it to keep trying,
 * and the second failure is what the circuit breaker is told about. The wait
 * is 5–10s, a `Retry-After` is honoured inside the same window rather than
 * obeyed literally (a provider that says「wait an hour」must not hang a run),
 * and every wait is interruptible.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
  maxAttemptsPerRequest: 2,
  baseDelayMs: 5_000,
  maxDelayMs: 10_000,
});

/** The whole discovery call's ceiling: retries and a fallback provider fit inside it. */
export const DEFAULT_DISCOVERY_BUDGET_MS = 60_000;

/** A deterministic, interruptible wait. */
export function sleepWithSignal(ms: number, signal?: AbortSignal, provider: ResearchProvider = "arxiv"): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new SearchError("the wait was cancelled", { kind: "aborted", provider }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new SearchError("the wait was cancelled", { kind: "aborted", provider }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** The `Retry-After` a response asked for, in ms, when it asked for one. */
export function retryAfterMsOf(response: Response, now: () => Date = () => new Date()): number | null {
  const raw = response.headers.get("retry-after");
  if (raw === null || raw.trim().length === 0) return null;
  const asNumber = Number(raw.trim());
  if (Number.isFinite(asNumber) && asNumber >= 0) return Math.round(asNumber * 1000);
  const asDate = Date.parse(raw);
  if (Number.isNaN(asDate)) return null;
  return Math.max(0, asDate - now().getTime());
}

/**
 * What an HTTP answer means, as a classification.
 *
 * The mapping is the product's: 429 is a rate limit, other 4xx are requests
 * this API will never accept, 5xx is the server's problem, and everything else
 * non-ok is treated as a retryable server-side failure rather than folded into
 * "invalid request" — a classification that guessed there would make the
 * fallback provider unreachable.
 */
export function classifyStatus(provider: ResearchProvider, status: number, requestUrl: string, retryAfterMs: number | null): SearchError {
  const kind: SearchFailureKind =
    status === 429
      ? "rate_limited"
      : status >= 500
        ? "server_error"
        : status >= 400
          ? "invalid_request"
          : "server_error";
  return new SearchError(`${PROVIDER_NAMES[provider]} answered HTTP ${status}`, {
    kind,
    provider,
    status,
    requestUrl,
    retryAfterMs,
    technical: `${PROVIDER_NAMES[provider]} ${requestUrl} → HTTP ${status}`,
  });
}

/** What a thrown fetch means, as a classification. */
export function classifyThrown(provider: ResearchProvider, error: unknown, requestUrl: string, signal?: AbortSignal): SearchError {
  if (signal?.aborted === true) {
    return new SearchError(`${PROVIDER_NAMES[provider]} request aborted`, {
      kind: "aborted",
      provider,
      requestUrl,
      technical: `${PROVIDER_NAMES[provider]} ${requestUrl} → aborted by the caller`,
    });
  }
  const reason = error instanceof Error ? error.message : "network failure";
  const timedOut = error instanceof Error && (error.name === "TimeoutError" || /timed? ?out/i.test(error.message));
  return new SearchError(`${PROVIDER_NAMES[provider]} request failed: ${reason}`, {
    kind: timedOut ? "timeout" : "network_error",
    provider,
    requestUrl,
    technical: `${PROVIDER_NAMES[provider]} ${requestUrl} → ${reason}`,
  });
}

/** What to do after a failure, decided here so every provider behaves alike. */
export interface RetryDecision {
  readonly retry: boolean;
  readonly delayMs: number;
  /** True when a `Retry-After` asked for more than this policy will wait. */
  readonly askedLongerThanPolicy: boolean;
}

export function retryDecisionOf(failure: SearchError, attempt: number, policy = DEFAULT_RETRY_POLICY): RetryDecision {
  if (attempt >= policy.maxAttemptsPerRequest) return { retry: false, delayMs: 0, askedLongerThanPolicy: false };
  if (!failure.retryable) return { retry: false, delayMs: 0, askedLongerThanPolicy: false };
  const asked = failure.retryAfterMs;
  const askedLonger = asked !== null && asked > policy.maxDelayMs;
  const delayMs = Math.min(policy.maxDelayMs, Math.max(policy.baseDelayMs, asked ?? 0));
  return { retry: true, delayMs, askedLongerThanPolicy: askedLonger };
}

/** The request one logical attempt makes, and the classification of its failure. */
export interface AttemptRequest<T> {
  readonly provider: ResearchProvider;
  readonly query: string;
  readonly requestUrl: string;
  /** Performs one physical request; a non-ok answer must already be classified. */
  readonly send: (input: { readonly signal: AbortSignal }) => Promise<T>;
  readonly options: SearchOptions;
}

export type AttemptResult<T> =
  | { readonly ok: true; readonly value: T; readonly attempts: readonly SearchAttempt[] }
  | { readonly ok: false; readonly failure: SearchError; readonly attempts: readonly SearchAttempt[] };

/**
 * One logical request with its bounded retries.
 *
 * Everything that could make this loop unbounded is bounded here: a maximum
 * number of physical attempts, a maximum wait, and a shared deadline the caller
 * can hand in so a fallback provider still gets what is left of the call rather
 * than a fresh minute of its own.
 */
export async function requestWithRetries<T>(input: AttemptRequest<T>): Promise<AttemptResult<T>> {
  const { options, provider, query, requestUrl } = input;
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms, signal) => sleepWithSignal(ms, signal, provider));
  const attempts: SearchAttempt[] = [];
  const deadline = input.options.deadline ?? now().getTime() + (options.budgetMs ?? DEFAULT_DISCOVERY_BUDGET_MS);
  const emit = options.onEvent ?? ((): void => undefined);

  for (let attempt = 1; ; attempt += 1) {
    if (options.signal?.aborted === true) {
      const failure = new SearchError(`${PROVIDER_NAMES[provider]} request aborted`, { kind: "aborted", provider, requestUrl });
      return { ok: false, failure: new SearchError(failure.message, { ...failure, attempts }), attempts };
    }
    const remaining = deadline - now().getTime();
    const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, remaining));
    const startedAt = now().toISOString();
    const started = now().getTime();
    const physical = AbortSignal.timeout(timeoutMs);
    const signal = options.signal === undefined ? physical : AbortSignal.any([options.signal, physical]);
    emit({
      kind: "request_started",
      level: "info",
      at: startedAt,
      provider,
      attempt,
      message: `正在向 ${PROVIDER_NAMES[provider]} 发起检索请求（第 ${attempt} 次）`,
    });
    try {
      const value = await input.send({ signal });
      attempts.push({ provider, query, requestUrl, startedAt, elapsedMs: now().getTime() - started, ok: true, attempt });
      return { ok: true, value, attempts };
    } catch (error) {
      const failure = error instanceof SearchError ? error : classifyThrown(provider, error, requestUrl, options.signal);
      attempts.push({
        provider,
        query,
        requestUrl,
        startedAt,
        elapsedMs: now().getTime() - started,
        ok: false,
        attempt,
        failureKind: failure.kind,
        ...(failure.status === null ? {} : { status: failure.status }),
      });
      emit({
        kind: "request_failed",
        level: failure.kind === "aborted" ? "info" : "warn",
        at: now().toISOString(),
        provider,
        attempt,
        failureKind: failure.kind,
        message: failure.userMessage,
      });
      const decision = retryDecisionOf(failure, attempt, retryPolicyOf(options));
      const waitUntil = now().getTime() + decision.delayMs;
      if (!decision.retry || waitUntil >= deadline) {
        return { ok: false, failure: new SearchError(failure.message, { ...failure, attempts }), attempts };
      }
      const nextRetryAt = new Date(waitUntil).toISOString();
      emit({
        kind: "retry_wait",
        level: "warn",
        at: now().toISOString(),
        provider,
        attempt: attempt + 1,
        nextRetryAt,
        failureKind: failure.kind,
        message: `等待 ${Math.round(decision.delayMs / 1000)} 秒后重试${PROVIDER_NAMES[provider]}${decision.askedLongerThanPolicy ? "（服务端要求的等待时间更长，这里按上限处理）" : ""}`,
      });
      try {
        await sleep(decision.delayMs, options.signal);
      } catch {
        const aborted = new SearchError(`${PROVIDER_NAMES[provider]} request aborted`, {
          kind: "aborted",
          provider,
          requestUrl,
          attempts,
        });
        return { ok: false, failure: aborted, attempts };
      }
    }
  }
}

function retryPolicyOf(options: SearchOptions): RetryPolicy {
  return {
    maxAttemptsPerRequest: options.maxAttemptsPerRequest ?? DEFAULT_RETRY_POLICY.maxAttemptsPerRequest,
    baseDelayMs: DEFAULT_RETRY_POLICY.baseDelayMs,
    maxDelayMs: DEFAULT_RETRY_POLICY.maxDelayMs,
  };
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
  if (terms.length === 0) throw new SearchError("the query has no terms arXiv can index; use English keywords", {
    kind: "invalid_request",
    provider: "arxiv",
  });
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
  if (terms.length === 0) {
    throw new SearchError("the query has no terms arXiv can index; use English keywords", {
      kind: "invalid_request",
      provider: "arxiv",
    });
  }
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
    const landingUrl = rawId.startsWith("http") ? rawId : "";
    const providerId = /abs\/([^/]+)$/.exec(landingUrl)?.[1] ?? "";
    if (landingUrl === "") continue;

    const authors: string[] = [];
    const authorPattern = /<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g;
    let author: RegExpExecArray | null;
    while ((author = authorPattern.exec(body)) !== null) authors.push(clean(author[1] ?? ""));

    const pdfMatch = /<link[^>]*title="pdf"[^>]*href="([^"]+)"/.exec(body);
    const publishedAt = field(body, "published");
    const primaryCategory = /<arxiv:primary_category[^>]*term="([^"]+)"/.exec(body)?.[1] ?? "";
    const doi = field(body, "arxiv:doi");

    candidates.push({
      provider: "arxiv",
      providerId: normalizeArxivId(providerId),
      title: field(body, "title"),
      authors,
      abstract: field(body, "summary"),
      landingUrl,
      pdfUrl: pdfMatch === null ? null : pdfMatch[1] ?? null,
      publishedAt: publishedAt === "" ? null : publishedAt,
      arxivId: normalizeArxivId(providerId),
      venue: primaryCategory.length > 0 ? `arXiv ${primaryCategory}` : "arXiv",
      doi: doi === "" ? null : normalizeDoi(doi),
    });
  }
  return { total, candidates };
}

/**
 * The interval each provider asks for between requests.
 *
 * arXiv documents a three-second interval for its API, and this module has kept
 * it since the first real search; OpenAlex asks only for identification, so its
 * smaller interval exists to be polite rather than to obey a limit.
 */
export const PROVIDER_INTERVALS: Readonly<Record<ResearchProvider, number>> = Object.freeze({
  arxiv: 3_000,
  openalex: 500,
});

const requestState: Record<ResearchProvider, { last: number; queue: Promise<unknown> }> = {
  arxiv: { last: 0, queue: Promise.resolve() },
  openalex: { last: 0, queue: Promise.resolve() },
};

/**
 * Serializes a provider's calls and keeps its documented interval between them.
 *
 * The wait is a real wait, so a test that must not spend three seconds passes
 * its own `sleep`; the interval itself is a property of the provider, not a
 * tunable of the test.
 */
export function rateLimitedFor<T>(provider: ResearchProvider, task: () => Promise<T>, sleep?: SleepLike): Promise<T> {
  const wait = sleep ?? ((ms: number, signal?: AbortSignal) => sleepWithSignal(ms, signal, provider));
  const state = requestState[provider];
  const run = state.queue.then(async () => {
    const delay = state.last + PROVIDER_INTERVALS[provider] - Date.now();
    if (delay > 0) await wait(delay);
    try {
      return await task();
    } finally {
      state.last = Date.now();
    }
  });
  state.queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** One provider's logical request, sent with the interval and the bounded retries. */
export interface ProviderAttempt<T> {
  readonly provider: ResearchProvider;
  readonly query: string;
  readonly requestUrl: string;
  readonly options: SearchOptions;
  readonly send: (input: { readonly signal: AbortSignal }) => Promise<T>;
  /** Turns one successful answer into the outcome the product reads. */
  readonly finalize: (value: T) => SearchOutcome;
  readonly label?: string;
}

/**
 * One provider's request, retried inside the provider's own policy.
 *
 * Every provider goes through this, which is what makes the operational rules
 * uniform: the provider's interval is kept, the retry is bounded and
 * interruptible, an aborted request is *not* retried, and the physical attempts
 * are reported back whether or not the request succeeded.
 */
export async function attemptWithProvider<T>(input: ProviderAttempt<T>): Promise<AttemptResult<SearchOutcome>> {
  const provider = input.provider;
  const sleep = input.options.sleep ?? ((ms: number, signal?: AbortSignal) => sleepWithSignal(ms, signal, provider));
  const result = await requestWithRetries({
    provider,
    query: input.query,
    requestUrl: input.requestUrl,
    options: input.options,
    send: ({ signal }) => rateLimitedFor(provider, () => input.send({ signal }), sleep),
  });
  if (!result.ok) {
    return {
      ok: false,
      failure: new SearchError(result.failure.message, { ...result.failure, attempts: result.attempts }),
      attempts: result.attempts,
    };
  }
  return { ok: true, value: input.finalize(result.value), attempts: result.attempts };
}

/**
 * One real search of arXiv. Every call goes to the network unless a `fetchImpl`
 * is handed in, and the outcome records the exact request URL and time so a
 * candidate's provenance is checkable later.
 *
 * The ladder runs until a query returns candidates; the outcome carries the
 * query that actually answered, so a report's provenance names the real request
 * rather than the words it started from.
 */
export async function searchArxiv(query: string, options: SearchOptions): Promise<SearchOutcome> {
  const result = await attemptArxiv(query, options);
  if (result.ok) return result.value;
  throw result.failure;
}

/** One arXiv search that reports its failure instead of throwing it. */
export async function attemptArxiv(query: string, options: SearchOptions): Promise<AttemptResult<SearchOutcome>> {
  const limit = Math.max(1, Math.min(20, Math.trunc(options.limit)));
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const attempts: SearchAttempt[] = [];
  const ladder = queryLadder(query);
  let lastUrl = `${ARXIV_ENDPOINT}?search_query=${buildArxivQuery(ladder[0] ?? [])}&start=0&max_results=${limit}`;

  for (const terms of ladder) {
    const searchQuery = buildArxivQuery(terms);
    const requestUrl = `${ARXIV_ENDPOINT}?search_query=${searchQuery}&start=0&max_results=${limit}&sortBy=relevance&sortOrder=descending`;
    lastUrl = requestUrl;
    const attempt = await attemptWithProvider({
      provider: "arxiv",
      query: searchQuery,
      requestUrl,
      options,
      send: async ({ signal }) => {
        let response: Response;
        try {
          response = await fetchImpl(requestUrl, {
            headers: { "user-agent": USER_AGENT, accept: "application/atom+xml" },
            signal,
            redirect: "follow",
          });
        } catch (error) {
          throw classifyThrown("arxiv", error, requestUrl, signal);
        }
        if (response.status !== 200) {
          throw classifyStatus("arxiv", response.status, requestUrl, retryAfterMsOf(response, now));
        }
        try {
          return await response.text();
        } catch (error) {
          throw classifyThrown("arxiv", error, requestUrl, signal);
        }
      },
      finalize: (xml) => {
        const parsed = parseArxivFeed(xml);
        return {
          provider: "arxiv",
          query,
          requestUrl,
          fetchedAt: now().toISOString(),
          total: parsed.total,
          candidates: parsed.candidates.slice(0, limit),
        };
      },
    });
    attempts.push(...attempt.attempts);
    if (!attempt.ok) {
      return {
        ok: false,
        failure: new SearchError(attempt.failure.message, { ...attempt.failure, attempts }),
        attempts,
      };
    }
    if (attempt.value.candidates.length > 0 || terms === ladder[ladder.length - 1]) {
      return { ok: true, value: attempt.value, attempts };
    }
  }

  return {
    ok: true,
    value: { provider: "arxiv", query, requestUrl: lastUrl, fetchedAt: now().toISOString(), total: 0, candidates: [] },
    attempts,
  };
}

/** The arXiv id inside an abs/PDF/HTML URL, when there is one. */
export function arxivIdOf(url: string): string | undefined {
  const match = /arxiv\.org\/(?:abs|pdf|html)\/([^/?#]+?)(?:v\d+)?(?:\.pdf)?(?:[?#].*)?$/.exec(url);
  return match?.[1] === undefined ? undefined : normalizeArxivId(match[1]);
}

/** An arXiv id without its version suffix, which is the identity of the paper. */
export function normalizeArxivId(id: string | null | undefined): string {
  return (id ?? "").trim().replace(/^arxiv:/i, "").replace(/v\d+$/i, "").trim();
}

/** A DOI without its resolver prefix or case, which is the identity of the work. */
export function normalizeDoi(doi: string | null | undefined): string | null {
  const raw = (doi ?? "").trim();
  if (raw.length === 0) return null;
  return raw.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").replace(/^doi:/i, "").toLowerCase();
}

/**
 * A URL reduced to the thing two providers have to agree on to be the same work.
 *
 * Providers hand back the same paper under different spellings — a version
 * suffix, a trailing slash, `www`, a hash fragment, `http` where the other used
 * `https` — and treating those as different papers is what makes a fallback
 * provider silently duplicate the whole corpus.
 */
export function normalizeUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url.trim().toLowerCase();
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const path = parsed.pathname.replace(/\/+$/, "").replace(/v\d+$/i, "");
  return `${host}${path}${parsed.search}`.toLowerCase();
}

/** Every identity a candidate can be deduplicated by, strongest first. */
export function candidateKeys(candidate: SearchCandidate): readonly string[] {
  const keys: string[] = [];
  const doi = normalizeDoi(candidate.doi);
  if (doi !== null && doi.length > 0) keys.push(`doi:${doi}`);
  const arxivId = normalizeArxivId(candidate.arxivId);
  if (arxivId.length > 0) keys.push(`arxiv:${arxivId}`);
  // An arXiv DOI is the same work as the arXiv preprint.
  const arxivFromDoi = /^10\.48550\/arxiv\.(.+)$/.exec(doi ?? "");
  if (arxivFromDoi !== null) keys.push(`arxiv:${normalizeArxivId(arxivFromDoi[1] ?? "")}`);
  if (candidate.landingUrl.length > 0) keys.push(`url:${normalizeUrl(candidate.landingUrl)}`);
  if (candidate.providerId.length > 0) keys.push(`pid:${candidate.provider}:${candidate.providerId.toLowerCase()}`);
  return keys;
}

/**
 * Keeps one candidate per work.
 *
 * The first sighting wins, because the first sighting is what the discovery
 * outcome is *about*: when arXiv answered first, the paper's provenance is
 * arXiv even if a fallback provider would also have listed it.
 */
export function dedupeCandidates(candidates: readonly SearchCandidate[]): readonly SearchCandidate[] {
  const seen = new Set<string>();
  const kept: SearchCandidate[] = [];
  for (const candidate of candidates) {
    const keys = candidateKeys(candidate);
    if (keys.some((key) => seen.has(key))) continue;
    for (const key of keys) seen.add(key);
    kept.push(candidate);
  }
  return kept;
}

/** The arXiv id inside a DOI, when the DOI is an arXiv DOI. */
export function arxivIdOfDoi(doi: string | null | undefined): string | undefined {
  const match = /^10\.48550\/arxiv\.(.+)$/i.exec(normalizeDoi(doi) ?? "");
  return match?.[1] === undefined ? undefined : normalizeArxivId(match[1]);
}
