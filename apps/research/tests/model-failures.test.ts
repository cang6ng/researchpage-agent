/**
 * What a failure is called, and what is never called at all.
 *
 * The incident this module answers: every failed stage of a real project read
 * 「模型服务拒绝了这次请求（常见原因：凭据无效、账户余额或配额用尽…）」, and the
 * provider was simply rate limiting. The classification is therefore judged
 * here on three rules, and each of them is a case below:
 *
 *  - a reason is named only from a fact the model layer established — the safe
 *    kind the adapter carried, or the adapter's own fixed sentence;
 *  - an unknown reason says it is unknown, and does not send anyone to look at
 *    a balance nobody measured;
 *  - nothing a provider wrote reaches the reader, including a status code or a
 *    secret that arrived inside a message.
 */

import { describe, expect, it } from "vitest";

import { PiAiRequestFailure } from "@every-dagent/model-pi-ai";

import {
  ABORTED_FAILURE,
  INTERRUPTED_FAILURE,
  classifyModelFailure,
  createFailureLedger,
  unclassifiedFailure,
} from "../src/server/model-failures.js";

describe("the classification of a model failure", () => {
  it("names the kind the adapter carried, and nothing more", () => {
    expect(classifyModelFailure(new PiAiRequestFailure("payment_required")).code).toBe("model_payment_required");
    expect(classifyModelFailure(new PiAiRequestFailure("authentication_failed")).code).toBe("model_authentication_failed");
    expect(classifyModelFailure(new PiAiRequestFailure("rate_limited")).code).toBe("model_rate_limited");
    expect(classifyModelFailure(new PiAiRequestFailure("service_unavailable")).code).toBe("model_service_unavailable");
    expect(classifyModelFailure(new PiAiRequestFailure("aborted")).code).toBe("model_aborted");
    expect(classifyModelFailure(new PiAiRequestFailure("unknown")).code).toBe("model_request_failed");
  });

  it("says which failures may be retried, and refuses to guess about the rest", () => {
    // Only the two the adapter can name *and* stand behind are retryable.
    expect(classifyModelFailure(new PiAiRequestFailure("rate_limited")).retryable).toBe(true);
    expect(classifyModelFailure(new PiAiRequestFailure("service_unavailable")).retryable).toBe(true);
    for (const kind of ["payment_required", "authentication_failed", "aborted", "unknown"] as const) {
      expect(classifyModelFailure(new PiAiRequestFailure(kind)).retryable, kind).toBe(false);
    }
    // A cancellation has its own guidance: it was cancelled, not refused.
    expect(classifyModelFailure(new PiAiRequestFailure("aborted")).code).toBe("model_aborted");
    expect(ABORTED_FAILURE.retryable).toBe(false);
    expect(unclassifiedFailure().retryable).toBe(false);
  });

  it("carries the wait the provider asked for, when there is one", () => {
    const limited = classifyModelFailure(new PiAiRequestFailure("rate_limited", 2_000));
    expect(limited.retryAfterMs).toBe(2_000);
    expect(classifyModelFailure(new PiAiRequestFailure("rate_limited", null)).retryAfterMs).toBeUndefined();
    // A wait only means something for a failure that may be retried at all.
    expect(classifyModelFailure(new PiAiRequestFailure("payment_required", 2_000)).retryAfterMs).toBeUndefined();
  });

  it("reads the adapter's own fixed sentences, and no other text", () => {
    // The adapter's fixed words are the one other thing it publishes, so they
    // are read — and they carry no claim about a balance either.
    expect(classifyModelFailure(new Error("the provider request failed")).code).toBe("model_request_failed");
    expect(classifyModelFailure(new Error("the provider request was aborted")).code).toBe("model_aborted");
    expect(classifyModelFailure(new Error("the request could not be sent to the provider")).code).toBe("model_request_failed");
  });

  it("never reads a status code, a balance or a secret out of free text", () => {
    // The old classifier's mistake, in one sentence: a provider's own words
    // naming a status. Nothing here observed that status, so nothing here may
    // claim it — and the secret must not survive the classification either.
    const providerText = "HTTP 402 Insufficient Balance sk-live-SECRET https://provider.example/v1/chat 余额不足";
    const classified = classifyModelFailure(new Error(providerText));
    expect(classified.code).toBe("run_failed");
    expect(classified.retryable).toBe(false);
    const printed = JSON.stringify(classified);
    expect(printed).not.toContain("402");
    expect(printed).not.toContain("SECRET");
    expect(printed).not.toContain("provider.example");
    // "HTTP 503" in a message is the same: nothing observed a 503.
    expect(classifyModelFailure(new Error("HTTP 503 Service Unavailable")).code).toBe("run_failed");
  });

  it("keeps a provider's words out of the sentences a reader sees", () => {
    const failure = classifyModelFailure(new Error("recipient account sk-abc123 not found"));
    expect(failure.problem).not.toContain("sk-abc123");
    expect(failure.guidance).not.toContain("sk-abc123");
    expect(failure.category).toBe("runtime_unknown");
  });

  it("has a fixed vocabulary for every code it publishes", () => {
    const codes = [
      classifyModelFailure(new PiAiRequestFailure("payment_required")),
      classifyModelFailure(new PiAiRequestFailure("authentication_failed")),
      classifyModelFailure(new PiAiRequestFailure("rate_limited")),
      classifyModelFailure(new PiAiRequestFailure("service_unavailable")),
      classifyModelFailure(new PiAiRequestFailure("aborted")),
      classifyModelFailure(new PiAiRequestFailure("unknown")),
      unclassifiedFailure(),
      INTERRUPTED_FAILURE,
    ];
    for (const failure of codes) {
      expect(failure.code).toMatch(/^[a-z_]+$/);
      expect(failure.problem.length).toBeGreaterThan(0);
      expect(failure.guidance.length).toBeGreaterThan(0);
    }
    // No two failures claim the same code while saying different things.
    expect(new Set(codes.map((failure) => failure.code)).size).toBe(codes.length);
  });

  it("does not promise a budget it did not count", () => {
    // The old guidance asserted「本次没有消耗检索预算」for every failure. Nothing
    // in a model failure can establish that, so no code says it.
    for (const kind of ["payment_required", "rate_limited", "unknown", "aborted"] as const) {
      const failure = classifyModelFailure(new PiAiRequestFailure(kind));
      expect(failure.guidance).not.toContain("检索预算");
      expect(failure.problem).not.toContain("余额");
    }
  });
});

describe("the failure ledger", () => {
  const failure = classifyModelFailure(new PiAiRequestFailure("rate_limited"));

  it("keeps sessions apart", () => {
    let now = 1_000;
    const ledger = createFailureLedger(() => now);
    ledger.record("session_a", failure);
    expect(ledger.read("session_b", 900)).toBeUndefined();
    expect(ledger.read("session_a", 900)?.code).toBe("model_rate_limited");
  });

  it("refuses to hand a failure to a stage that started after it", () => {
    let now = 1_000;
    const ledger = createFailureLedger(() => now);
    ledger.record("session_a", failure);
    // The stage began at 1001, the failure was recorded at 1000: not this stage's.
    expect(ledger.read("session_a", 1_001)).toBeUndefined();
  });

  it("forgets a failure older than a stage can plausibly last", () => {
    let now = 1_000;
    const ledger = createFailureLedger(() => now);
    ledger.record("session_a", failure);
    now = 1_000 + 10 * 60 * 1000 + 1;
    expect(ledger.read("session_a", 0)).toBeUndefined();
  });

  it("stays bounded, dropping the oldest session", () => {
    let now = 0;
    const ledger = createFailureLedger(() => now);
    for (let index = 0; index < 205; index += 1) {
      now += 1;
      ledger.record(`session_${String(index)}`, failure);
    }
    expect(ledger.read("session_0", 0)).toBeUndefined();
    expect(ledger.read("session_204", 0)?.code).toBe("model_rate_limited");
  });

  it("hands the retry metadata on exactly as recorded", () => {
    const ledger = createFailureLedger(() => 1_000);
    ledger.record("session_a", classifyModelFailure(new PiAiRequestFailure("service_unavailable", 5_000)));
    const read = ledger.read("session_a", 900);
    expect(read?.retryable).toBe(true);
    expect(read?.retryAfterMs).toBe(5_000);
  });
});
