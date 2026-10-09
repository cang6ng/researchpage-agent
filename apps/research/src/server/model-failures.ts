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
 * So the classification is done where the reason is still visible — the
 * application's own model-client wrapper — and what travels onward is a *safe*
 * summary: a category, a fixed code from a closed set, and the action a reader
 * can take. Nothing of the provider's report travels with it: no status line,
 * no body, no header, no credential, no URL, no stack. The categories are the
 * ones the product acts on, and they are deliberately few.
 */

/** The shape a failure is reported in, everywhere a client can see it. */
export interface SafeFailure {
  readonly category: FailureCategory;
  readonly code: string;
  /** One sentence saying what happened, in the reader's vocabulary. */
  readonly problem: string;
  /** What to do about it. */
  readonly guidance: string;
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
  "model_credential_or_quota",
  "model_request_rejected",
  "model_output_truncated",
  "model_request_failed",
  "model_context_overflow",
  "model_request_invalid",
  "tool_declaration_invalid",
  "report_validation_failed",
  "storage_unavailable",
  "run_failed",
] as const;

export type FailureCode = (typeof FAILURE_CODES)[number];

/**
 * The adapter's fixed words, read as the categories they stand for.
 *
 * These strings are the *only* thing the model adapter offers — it deliberately
 * replaces every provider report with one of them — so they are what a
 * classification can honestly be built on. A message that is not one of them is
 * read as an unknown runtime failure rather than guessed at.
 */
const ADAPTER_MESSAGES: readonly { readonly match: RegExp; readonly failure: SafeFailure }[] = Object.freeze([
  {
    match: /^the provider request failed$|^the provider request was aborted$/,
    failure: {
      category: "model_request",
      code: "model_credential_or_quota",
      problem: "模型服务拒绝了这次请求（常见原因：凭据无效、账户余额或配额用尽、模型名不可用）。",
      guidance: "请在设置里检查模型凭据与账户余额，确认模型 id 可用后重试；本次没有消耗检索预算，已读材料与草稿都保留着。",
    },
  },
  {
    match: /^the request could not be sent to the provider$/,
    failure: {
      category: "model_request",
      code: "model_request_failed",
      problem: "这次请求没有发到模型服务（网络或本地传输失败）。",
      guidance: "请检查网络与代理设置后重试；已读材料与草稿都保留着。",
    },
  },
  {
    match: /truncated|output token limit/i,
    failure: {
      category: "model_request",
      code: "model_output_truncated",
      problem: "模型这次回答超出了单次输出上限，被截断。",
      guidance: "请让它分次提交（每次只写一节），或收窄这一节要写的内容。",
    },
  },
  {
    match: /context budget|does not fit the model/i,
    failure: {
      category: "context_build",
      code: "model_context_overflow",
      problem: "这次请求放不进模型的上下文预算。",
      guidance: "请减少单次读取量或换用上下文更大的模型；已读材料不会丢失。",
    },
  },
  {
    match: /request is not a body|output cap|not the one this request reserved|not a body this adapter/i,
    failure: {
      category: "model_request",
      code: "model_request_invalid",
      problem: "这次请求不符合该模型协议的要求，没有发出。",
      guidance: "请确认模型 id 与协议匹配；这是配置问题，重试同样的请求不会有不同结果。",
    },
  },
  {
    match: /tool call .* is not a JSON object|tool declaration/i,
    failure: {
      category: "tool_schema",
      code: "tool_declaration_invalid",
      problem: "模型给出的工具参数不是可解析的对象。",
      guidance: "请让工具调用按 schema 重新提交；这类问题需要改写参数，重试同一份参数不会成功。",
    },
  },
]);

/** The one failure an unrecognized error becomes. */
const UNKNOWN: SafeFailure = Object.freeze({
  category: "runtime_unknown",
  code: "run_failed",
  problem: "这次运行失败了，但没有取得可安全分类的原因。",
  guidance: "可以在「研究状态」里查看活动详情，或直接重试；已读材料与草稿都保留着。",
});

/**
 * Classifies a caught model error.
 *
 * Only the error's *message* is read, and only against the adapter's own fixed
 * vocabulary: the adapter is the component that already decided what may leave
 * a provider boundary, so a classification that reads its words cannot leak
 * more than the adapter already does.
 */
export function classifyModelFailure(error: unknown): SafeFailure {
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
  record(sessionId: string, error: unknown): void;
  /** The failure for this session if it was recorded within `withinMs` of `since`. */
  read(sessionId: string, since: number, withinMs?: number): SafeFailure | undefined;
}

const LEDGER_RETENTION_MS = 10 * 60 * 1000;
const LEDGER_MAX_SESSIONS = 200;

export function createFailureLedger(now: () => number = Date.now): FailureLedger {
  const entries = new Map<string, { readonly at: number; readonly failure: SafeFailure }>();
  return {
    record(sessionId, error) {
      entries.set(sessionId, { at: now(), failure: classifyModelFailure(error) });
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
