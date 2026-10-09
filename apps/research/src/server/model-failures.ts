/**
 * What went wrong, in words a person can act on.
 *
 * The real failure this module exists for: a research project's report and
 * synthesis runs began failing about half a second in, over and over, and the
 * workspace could only say「报告阶段结束但没有保存有效报告」. The underlying
 * cause was a provider refusing every request — the account had run out of
 * balance — and nothing in the product's own vocabulary could say so, because
 * the host masks provider failures by design and the Core records them as「a
 * turn that ended in an error」without the reason.
 *
 * The first version of the fix over-corrected: every fixed failure the model
 * layer could produce became「凭据或配额」, so a cancellation and a momentary
 * service error both sent the reader to check their balance. Two rules keep that
 * from happening again. A failure is classified from *facts the model layer
 * established* — the safe kind the adapter named, and the retryability that kind
 * implies — never from prose, and never by reading a status out of free text. And
 * the reader is told what was established and what was not: "the reason is
 * unknown" is its own answer, and it does not send anyone to look at something
 * nobody measured.
 *
 * What travels onward is still a *safe* summary: a category, a fixed code from a
 * closed set, and the action a reader can take. Nothing of the provider's report
 * travels with it: no status line, no body, no header, no credential, no URL, no
 * stack.
 */

import { PiAiRequestFailure } from "@every-dagent/model-pi-ai";

/** The shape a failure is reported in, everywhere a client can see it. */
export interface SafeFailure {
  readonly category: FailureCategory;
  readonly code: string;
  /** One sentence saying what happened, in the reader's vocabulary. */
  readonly problem: string;
  /** What to do about it. */
  readonly guidance: string;
  /**
   * Whether trying the same request again could plausibly work.
   *
   * It is a fact the model layer established, not a guess: a rate limit and a
   * temporarily unavailable service are the two the adapter can name and is
   * willing to stand behind. Everything else — including every unknown reason —
   * is false, because "we do not know why" is not a licence to retry.
   */
  readonly retryable: boolean;
  /** How long the provider itself asked the caller to wait, in milliseconds. */
  readonly retryAfterMs?: number;
}

export type FailureCategory =
  | "context_build"
  | "model_request"
  | "tool_schema"
  | "validation"
  | "storage"
  | "runtime_unknown";

/** The fixed codes this product publishes. A code outside this list is a bug, not a message. */
export const FAILURE_CODES = [
  "model_payment_required",
  "model_authentication_failed",
  "model_rate_limited",
  "model_service_unavailable",
  "model_aborted",
  "model_request_failed",
  "model_output_truncated",
  "model_context_overflow",
  "model_request_invalid",
  "tool_declaration_invalid",
  "report_validation_failed",
  "run_in_progress",
  "run_interrupted",
  "storage_unavailable",
  "run_failed",
] as const;

export type FailureCode = (typeof FAILURE_CODES)[number];

/**
 * The failures the model adapter can name, as this product's own vocabulary.
 *
 * Each one says what was established, and the guidance is written for that fact
 * alone: no sentence here asserts a balance, a quota or a credential that
 * nobody measured.
 */
const ADAPTER_KINDS: Readonly<Record<string, SafeFailure>> = Object.freeze({
  payment_required: {
    category: "model_request",
    code: "model_payment_required",
    problem: "模型服务以「需要付费」拒绝了这次请求（HTTP 402）。",
    guidance: "请检查模型服务的支付方式、账户余额或配额；这是账户侧的状态，重试同样的请求在它改变之前不会成功。已读材料与草稿都保留着。",
    retryable: false,
  },
  authentication_failed: {
    category: "model_request",
    code: "model_authentication_failed",
    problem: "模型服务以「未通过认证」拒绝了这次请求（HTTP 401/403）。",
    guidance: "请检查模型凭据与授权范围（例如密钥是否有效、是否有该模型的权限）；重试同样的请求在凭据改变之前不会成功。已读材料与草稿都保留着。",
    retryable: false,
  },
  rate_limited: {
    category: "model_request",
    code: "model_rate_limited",
    problem: "模型服务对这次请求限流了（HTTP 429）。",
    guidance: "请稍后重试；系统本身也会在短时间内自动再试一次。已读材料与草稿都保留着。",
    retryable: true,
  },
  service_unavailable: {
    category: "model_request",
    code: "model_service_unavailable",
    problem: "模型服务暂时不可用（HTTP 503）。",
    guidance: "这是服务端的暂时状态，稍后重试通常即可；系统本身也会在短时间内自动再试一次。已读材料与草稿都保留着。",
    retryable: true,
  },
  aborted: {
    category: "model_request",
    code: "model_aborted",
    problem: "这次模型请求已被取消。",
    guidance: "请求是被取消的，不是模型服务的故障；可以显式重新发起。已读材料与草稿都保留着。",
    retryable: false,
  },
  unknown: {
    category: "model_request",
    code: "model_request_failed",
    problem: "模型请求失败了，但没有取得可安全分类的原因。",
    guidance: "可以在「研究状态」里查看活动详情后重试；这不是余额或凭据的结论——本次没有取得任何可信的状态码。已读材料与草稿都保留着。",
    retryable: false,
  },
});

/**
 * The adapter's fixed words, read as the categories they stand for.
 *
 * These strings are the *only* other thing the model adapter offers — an error
 * that is not the safe type but is one of these exact sentences is still the
 * adapter speaking, and a message that is not one of them is read as an unknown
 * runtime failure rather than guessed at. Nothing here parses a status code out
 * of text: a provider that writes「HTTP 402」into a message this product did not
 * write it is not a status anybody observed.
 */
const ADAPTER_MESSAGES: readonly { readonly match: RegExp; readonly failure: SafeFailure }[] = Object.freeze([
  {
    match: /^the provider request failed$/,
    failure: ADAPTER_KINDS["unknown"] as SafeFailure,
  },
  {
    match: /^the provider request was aborted$/,
    failure: ADAPTER_KINDS["aborted"] as SafeFailure,
  },
  {
    match: /^the request could not be sent to the provider$/,
    failure: {
      category: "model_request",
      code: "model_request_failed",
      problem: "这次请求没有发到模型服务（网络或本地传输失败）。",
      guidance: "请检查网络与代理设置后重试；已读材料与草稿都保留着。",
      retryable: false,
    },
  },
  {
    match: /truncated|output token limit/i,
    failure: {
      category: "model_request",
      code: "model_output_truncated",
      problem: "模型这次回答超出了单次输出上限，被截断。",
      guidance: "请让它分次提交（每次只写一节），或收窄这一节要写的内容。",
      retryable: false,
    },
  },
  {
    match: /context budget|does not fit the model/i,
    failure: {
      category: "context_build",
      code: "model_context_overflow",
      problem: "这次请求放不进模型的上下文预算。",
      guidance: "请减少单次读取量或换用上下文更大的模型；已读材料不会丢失。",
      retryable: false,
    },
  },
  {
    match: /request is not a body|output cap|not the one this request reserved|not a body this adapter/i,
    failure: {
      category: "model_request",
      code: "model_request_invalid",
      problem: "这次请求不符合该模型协议的要求，没有发出。",
      guidance: "请确认模型 id 与协议匹配；这是配置问题，重试同样的请求不会有不同结果。",
      retryable: false,
    },
  },
  {
    match: /tool call .* is not a JSON object|tool declaration/i,
    failure: {
      category: "tool_schema",
      code: "tool_declaration_invalid",
      problem: "模型给出的工具参数不是可解析的对象。",
      guidance: "请让工具调用按 schema 重新提交；这类问题需要改写参数，重试同一份参数不会成功。",
      retryable: false,
    },
  },
]);

/** The one failure an unrecognized error becomes. */
const UNKNOWN: SafeFailure = Object.freeze({
  category: "runtime_unknown",
  code: "run_failed",
  problem: "这次运行失败了，但没有取得可安全分类的原因。",
  guidance: "可以在「研究状态」里查看活动详情，或直接重试；已读材料与草稿都保留着。",
  retryable: false,
});

/**
 * The failure a cancelled stage is reported as, before anything else is read.
 *
 * A signal that was aborted is the one cause this product can always establish,
 * and it outranks whatever the provider happened to say while being cancelled.
 */
export const ABORTED_FAILURE: SafeFailure = Object.freeze({
  ...(ADAPTER_KINDS["aborted"] as SafeFailure),
});

/** The failure a generation interrupted by a process that died is reported as. */
export const INTERRUPTED_FAILURE: SafeFailure = Object.freeze({
  category: "runtime_unknown",
  code: "run_interrupted",
  problem: "这次生成被应用重启打断了，没有留下可继续的痕迹。",
  guidance: "已读材料、草稿与预算都保留着，可以用「使用现有资料恢复报告」重新开始这次生成。",
  retryable: false,
});

/**
 * Classifies a caught model error.
 *
 * The safe type first, then the adapter's own fixed sentences, and nothing else:
 * this function never reads a status code, a provider's words or a body, because
 * a classification built on prose is a classification that can be talked into
 * saying anything.
 */
export function classifyModelFailure(error: unknown): SafeFailure {
  if (error instanceof PiAiRequestFailure) {
    const known = ADAPTER_KINDS[error.kind];
    // The provider's wait is only meaningful for a failure that may be retried
    // at all; a wait attached to a permanent refusal is a number nothing will
    // act on, so it does not travel.
    if (known !== undefined) {
      return error.retryAfterMs === null || !known.retryable ? known : { ...known, retryAfterMs: error.retryAfterMs };
    }
  }
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  for (const entry of ADAPTER_MESSAGES) {
    if (entry.match.test(message)) return entry.failure;
  }
  return UNKNOWN;
}

/**
 * The failure to report when nothing better was observed.
 *
 * A run that failed without the wrapper recording a reason — a tool fault, a
 * cancelled stage, a host projection failure — is reported as exactly that. It
 * is a real answer: it says the product has no safe classification for this
 * one, which is different from claiming a cause it did not establish.
 */
export function unclassifiedFailure(): SafeFailure {
  return UNKNOWN;
}

/**
 * The most recent model failure per session, bounded.
 *
 * A run's own failure reason never reaches the runner: the host answers with a
 * masked code, and the Core turns a model failure into「the turn ended in an
 * error」. The wrapper that *does* see the reason records it here, keyed by the
 * session and timestamped, and the runner reads it back the moment a stage it
 * started settles as failed. It is a delivery mechanism, not storage: the
 * durable record of a failure is the task's own `reportGeneration.failure` and
 * its activity line, both written from what this ledger returned.
 *
 * Entries are dropped as soon as they are older than a stage can plausibly
 * last, so a stale failure can never be attributed to a later run.
 */
export interface FailureLedger {
  /** Records an already-classified failure, exactly as the wrapper classified it. */
  record(sessionId: string, failure: SafeFailure): void;
  /** The failure for this session if it was recorded within `withinMs` of `since`. */
  read(sessionId: string, since: number, withinMs?: number): SafeFailure | undefined;
}

const LEDGER_RETENTION_MS = 10 * 60 * 1000;
const LEDGER_MAX_SESSIONS = 200;

export function createFailureLedger(now: () => number = Date.now): FailureLedger {
  const entries = new Map<string, { readonly at: number; readonly failure: SafeFailure }>();
  return {
    record(sessionId, failure) {
      entries.set(sessionId, { at: now(), failure });
      if (entries.size <= LEDGER_MAX_SESSIONS) return;
      const oldest = [...entries.entries()].sort((left, right) => left[1].at - right[1].at)[0];
      if (oldest !== undefined) entries.delete(oldest[0]);
    },
    read(sessionId, since, withinMs = LEDGER_RETENTION_MS) {
      const entry = entries.get(sessionId);
      if (entry === undefined) return undefined;
      const at = now();
      if (at - entry.at > withinMs) return undefined;
      if (entry.at < since) return undefined;
      return entry.failure;
    },
  };
}
