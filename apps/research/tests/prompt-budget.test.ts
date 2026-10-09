/**
 * The system prompt has to fit, or the product does not start at all.
 *
 * This is not a style rule. The host validates its bootstrap settings before
 * they become durable, and a system prompt over the platform's byte budget is
 * refused as「the bootstrap host settings do not match this host's schema」 —
 * which happens at `startResearchApp`, before a route exists, so the failure
 * mode is "the server will not boot" rather than a message about the prompt.
 * The budget is also nearly spent: the research prompt sits a few dozen bytes
 * under the limit, so a paragraph added to it is a paragraph that breaks the
 * app.
 *
 * It is checked here rather than by starting the app, because the assertion a
 * writer needs is about the prompt, not about a process.
 */

import { describe, expect, it } from "vitest";

import { MAX_SYSTEM_PROMPT_BYTES } from "../../../packages/host/src/settings-profile.js";
import { RESEARCH_SYSTEM_PROMPT } from "@every-dagent/plugin-research";

function bytesOf(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

describe("the research system prompt", () => {
  it("fits the host's bootstrap budget, so the product can start", () => {
    const bytes = bytesOf(RESEARCH_SYSTEM_PROMPT);
    expect(bytes, `the system prompt is ${String(bytes)} bytes; the host accepts at most ${String(MAX_SYSTEM_PROMPT_BYTES)}`).toBeLessThanOrEqual(
      MAX_SYSTEM_PROMPT_BYTES,
    );
  });

  it("keeps the table contract's semantic rule, which is what Q03 enforces", () => {
    // The rule that a blank cell is not a gap declaration, and what a gap is
    // written as instead. It is in the prompt because it is a *content*
    // obligation; the exact shape it applies to is in the tool schema.
    expect(RESEARCH_SYSTEM_PROMPT).toContain("空白格不是缺口声明");
    expect(RESEARCH_SYSTEM_PROMPT).toContain("证据不足");
  });
});
