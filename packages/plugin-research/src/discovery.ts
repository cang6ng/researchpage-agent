/**
 * Discovery with a fallback: one query, two providers, bounded in every direction.
 *
 * A real 429 from arXiv used to end a research run, because arXiv was the only
 * door into the corpus. This module is the second door and the rules for using
 * it:
 *
 * - a provider request is retried inside that provider (bounded attempts,
 *   bounded backoff, `Retry-After` honoured up to a cap, every wait
 *   interruptible);
 * - a provider that is clearly rate limiting this client is *paused* for a
 *   short cooldown instead of being hammered, and the call moves to the
 *   fallback provider instead of waiting;
 * - the whole call has one deadline, so「arXiv is slow, then OpenAlex is slow」
 *   cannot become a two-minute search;
 * - two providers listing the same paper produce one candidate, because the
 *   identity of a work is its DOI, its arXiv id or its URL — never the provider
 *   that happened to mention it first.
 *
 * The circuit breaker is deliberately small: one record per provider with a
 * consecutive-failure count, the moment it may be probed again, and why it
 * opened. It is not a framework, and it must never be able to lock a provider
 * out forever — the cooldown expires, the next call probes, and a success
 * clears the record.
 */

import {
  dedupeCandidates,
  DEFAULT_DISCOVERY_BUDGET_MS,
  PROVIDER_NAMES,
  SearchError,
  type AttemptResult,
  type DiscoveryEvent,
  type FetchLike,
  type ResearchProvider,
  type SearchAttempt,
  type SearchFailureKind,
  type SearchOutcome,
  type SearchOptions,
  type SleepLike,
} from "./search.js";
import { attemptArxiv } from "./search.js";
import { attemptOpenAlex } from "./openalex.js";

/** How long a provider stays paused after it is clearly limiting this client. */
const DEFAULT_COOLDOWN_MS = 90_000;

/** Even a `Retry-After` of an hour must not pause longer than this. */
const MAX_COOLDOWN_MS = 120_000;

/** How many consecutive non-rate-limit failures open the breaker. */
const DEFAULT_FAILURE_THRESHOLD = 2;

export interface ProviderCircuitState {
  readonly provider: ResearchProvider;
  readonly consecutiveFailures: number;
  /** When the provider may be probed again, as epoch ms; null when healthy. */
  readonly openUntil: number | null;
  readonly openedAt: number | null;
  readonly reason: SearchFailureKind | null;
  /** True while the cooldown is running. */
  readonly open: boolean;
}

/**
 * The smallest thing that can stop hammering a provider and still recover.
 *
 * Two ways in: a clear rate limit opens it immediately (that is not a hiccup,
 * it is the provider saying no), and a run of other failures opens it once they
 * repeat (one timeout is noise, two in a row is a provider that is not
 * answering). One way out: time. Nothing here is permanent, and a success
 * clears the record — which is what keeps「熔断」from becoming「永久禁用」.
 */
export class ProviderCircuitBreaker {
  private readonly records = new Map<ResearchProvider, ProviderCircuitState>();
  private readonly cooldownMs: number;
  private readonly failureThreshold: number;
  private readonly now: () => number;

  constructor(options: { readonly cooldownMs?: number; readonly failureThreshold?: number; readonly now?: () => Date } = {}) {
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.now = () => (options.now ?? (() => new Date()))().getTime();
  }

  stateOf(provider: ResearchProvider): ProviderCircuitState {
    const record = this.records.get(provider);
    if (record === undefined) {
      return { provider, consecutiveFailures: 0, openUntil: null, openedAt: null, reason: null, open: false };
    }
    return { ...record, open: record.openUntil !== null && this.now() < record.openUntil };
  }

  /** Whether the provider is inside its cooldown, and so must not be asked now. */
  isOpen(provider: ResearchProvider): boolean {
    return this.stateOf(provider).open;
  }

  /** When the next probe is allowed, as an ISO string, while cooling down. */
  retryAtOf(provider: ResearchProvider): string | null {
    const state = this.stateOf(provider);
    return state.open && state.openUntil !== null ? new Date(state.openUntil).toISOString() : null;
  }

  recordSuccess(provider: ResearchProvider): void {
    this.records.delete(provider);
  }

  /**
   * Records one provider-level failure and answers whether the breaker opened.
   *
   * A cancellation is not a failure of the provider: it is the user (or the
   * calling layer) stopping, and recording it would pause a service that was
   * never asked a complete question.
   */
  recordFailure(provider: ResearchProvider, kind: SearchFailureKind, retryAfterMs: number | null = null, failures = 1): ProviderCircuitState {
    if (kind === "aborted") return this.stateOf(provider);
    const previous = this.records.get(provider);
    const consecutiveFailures = (previous?.consecutiveFailures ?? 0) + Math.max(1, failures);
    const rateLimited = kind === "rate_limited";
    const shouldOpen = rateLimited || consecutiveFailures >= this.failureThreshold;
    if (!shouldOpen) {
      this.records.set(provider, {
        provider,
        consecutiveFailures,
        openUntil: previous?.openUntil ?? null,
        openedAt: previous?.openedAt ?? null,
        reason: previous?.reason ?? null,
        open: false,
      });
      return this.stateOf(provider);
    }
    const at = this.now();
    const cooldown = Math.min(MAX_COOLDOWN_MS, Math.max(this.cooldownMs, rateLimited ? (retryAfterMs ?? 0) : 0));
    this.records.set(provider, {
      provider,
      consecutiveFailures,
      openUntil: at + cooldown,
      openedAt: at,
      reason: kind,
      open: true,
    });
    return this.stateOf(provider);
  }

  reset(provider?: ResearchProvider): void {
    if (provider === undefined) this.records.clear();
    else this.records.delete(provider);
  }
}

/** One provider's attempt function, as this module uses it. */
export type ProviderSearch = (query: string, options: SearchOptions) => Promise<AttemptResult<SearchOutcome>>;

export interface DiscoveryOptions {
  readonly limit: number;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: FetchLike;
  readonly now?: () => Date;
  readonly sleep?: SleepLike;
  readonly timeoutMs?: number;
  /** The whole call's ceiling, across every provider and every retry. */
  readonly budgetMs?: number;
  /** Which providers to ask, in order. Default: arXiv, then OpenAlex. */
  readonly providers?: readonly ResearchProvider[];
  readonly breaker?: ProviderCircuitBreaker;
  /** Where the reader-facing events go. */
  readonly onEvent?: (event: DiscoveryEvent) => void;
  /** Per-provider implementations; a test replaces one to simulate an outage. */
  readonly impls?: Partial<Record<ResearchProvider, ProviderSearch>>;
}

const DEFAULT_PROVIDER_ORDER: readonly ResearchProvider[] = Object.freeze(["arxiv", "openalex"]);

function implsOf(options: DiscoveryOptions): Readonly<Record<ResearchProvider, ProviderSearch>> {
  return {
    arxiv: options.impls?.arxiv ?? attemptArxiv,
    openalex: options.impls?.openalex ?? attemptOpenAlex,
  };
}

/** The failure that ends a discovery call when nothing answered. */
function summarise(failures: readonly SearchError[], attempts: readonly SearchAttempt[]): SearchError {
  const first = failures[0];
  const reasons = [...new Set(failures.map((failure) => `${PROVIDER_NAMES[failure.provider]}：${failure.technical.split(" → ").pop() ?? failure.userMessage}`))];
  return new SearchError(`discovery failed: ${reasons.join("；")}`, {
    kind: first?.kind ?? "network_error",
    provider: first?.provider ?? "arxiv",
    status: first?.status ?? null,
    requestUrl: first?.requestUrl ?? null,
    retryAfterMs: first?.retryAfterMs ?? null,
    technical: failures.map((failure) => failure.technical).join(" | "),
    attempts,
    userMessage: `论文检索服务都不可用（${[...new Set(failures.map((failure) => PROVIDER_NAMES[failure.provider]))].join("、")} 均失败）`,
  });
}

/**
 * One discovery call: every configured provider, in order, inside one deadline.
 *
 * A provider that answers with candidates ends the call. A provider that
 * answers with nothing is a real answer, not a failure — the call asks the next
 * provider rather than pretending the topic has no literature. A provider that
 * fails is classified, counted, and either retried inside itself (bounded) or
 * paused; when every provider has failed the call throws one classified
 * failure that names each provider's reason.
 *
 * Cancellation is not a failure path that continues: an aborted signal stops
 * the call immediately, without a retry and without a fallback.
 */
export async function searchSources(query: string, options: DiscoveryOptions): Promise<SearchOutcome> {
  const now = options.now ?? (() => new Date());
  const breaker = options.breaker ?? new ProviderCircuitBreaker({ now });
  const emit = options.onEvent ?? ((): void => undefined);
  const providers = options.providers ?? DEFAULT_PROVIDER_ORDER;
  const impls = implsOf(options);
  const startedAt = now().getTime();
  const deadline = startedAt + (options.budgetMs ?? DEFAULT_DISCOVERY_BUDGET_MS);
  const attempts: SearchAttempt[] = [];
  const failures: SearchError[] = [];
  const tried: ResearchProvider[] = [];
  let empty: SearchOutcome | null = null;

  for (const provider of providers) {
    if (options.signal?.aborted === true) {
      throw new SearchError("discovery was cancelled", {
        kind: "aborted",
        provider,
        attempts,
      });
    }
    const cooling = breaker.isOpen(provider);
    if (cooling) {
      const retryAt = breaker.retryAtOf(provider);
      emit({
        kind: "provider_skipped",
        level: "warn",
        at: now().toISOString(),
        provider,
        nextRetryAt: retryAt,
        message: `${PROVIDER_NAMES[provider]} 刚刚连续失败，正在冷却，暂时跳过${retryAt === null ? "" : `（${retryAt} 之后可重新探测）`}`,
      });
      continue;
    }
    if (tried.length > 0) {
      emit({
        kind: "provider_fallback",
        level: "warn",
        at: now().toISOString(),
        provider,
        message: `改用备用检索服务 ${PROVIDER_NAMES[provider]}`,
      });
    }
    tried.push(provider);
    const searchOptions: SearchOptions = {
      limit: options.limit,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      now,
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      budgetMs: Math.max(1_000, deadline - now().getTime()),
      deadline,
      ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
    };
    const result = await impls[provider](query, searchOptions);
    attempts.push(...result.attempts);
    const degraded = [...new Set(failures.map((failure) => failure.provider))]
      .filter((earlier) => earlier !== provider)
      .map((earlier) => {
        const failure = failures.find((entry) => entry.provider === earlier) as SearchError;
        return { provider: earlier, kind: failure.kind, userMessage: failure.userMessage };
      });

    if (result.ok) {
      breaker.recordSuccess(provider);
      const candidates = dedupeCandidates(result.value.candidates);
      if (candidates.length > 0) {
        emit({
          kind: "candidates_found",
          level: "info",
          at: now().toISOString(),
          provider,
          message: `${PROVIDER_NAMES[provider]} 返回 ${candidates.length} 个候选${result.value.total === null ? "" : `（命中约 ${result.value.total} 条）`}`,
        });
        return { ...result.value, candidates, providersTried: tried, attempts, ...(degraded.length === 0 ? {} : { providerFailures: degraded }) };
      }
      emit({
        kind: "search_empty",
        level: "info",
        at: now().toISOString(),
        provider,
        message: `${PROVIDER_NAMES[provider]} 没有返回候选`,
      });
      empty = { ...result.value, candidates: [], providersTried: tried, attempts, ...(degraded.length === 0 ? {} : { providerFailures: degraded }) };
      continue;
    }

    if (result.failure.kind === "aborted") {
      throw new SearchError(result.failure.message, { ...result.failure, attempts });
    }
    // The breaker counts failed *requests*, not failed calls: a call that spent
    // both of its attempts on timeouts has already shown this provider is not
    // answering, and waiting for a second such call to repeat that would be
    // asking the user to sit through it twice.
    const failedRequests = result.attempts.filter((entry) => !entry.ok).length;
    const state = breaker.recordFailure(provider, result.failure.kind, result.failure.retryAfterMs, failedRequests);
    failures.push(result.failure);
    if (state.open) {
      emit({
        kind: "provider_skipped",
        level: "error",
        at: now().toISOString(),
        provider,
        nextRetryAt: state.openUntil === null ? null : new Date(state.openUntil).toISOString(),
        failureKind: result.failure.kind,
        message:
          result.failure.kind === "rate_limited"
            ? `${PROVIDER_NAMES[provider]} 明确限流，已暂停请求（冷却后会自动重新探测）`
            : `${PROVIDER_NAMES[provider]} 连续失败，已暂停请求（冷却后会自动重新探测）`,
      });
    }
  }

  // What a provider answered outranks what another provider refused: a search
  // that reached an answer — even an empty one — is reported as a search, with
  // the refusals attached as provenance. Throwing instead would turn「arXiv is
  // rate limiting us, OpenAlex found nothing」into「the search failed」, which is
  // a different and less useful fact.
  if (empty !== null) return { ...empty, attempts, providersTried: tried };
  if (failures.length > 0) throw summarise(failures, attempts);
  throw new SearchError("no discovery provider was available for this search", {
    kind: "invalid_request",
    provider: providers[providers.length - 1] ?? "arxiv",
  });
}
