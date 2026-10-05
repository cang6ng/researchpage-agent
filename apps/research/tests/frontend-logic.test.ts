/**
 * The page's own logic, tested as logic.
 *
 * What a browser gate proves is that a reader can do something; what it cannot
 * show is *why* two screens agreed. These cases cover the small, decidable
 * things the product leans on: an address opens the view it names, a citation
 * number belongs to exactly one claim, a synthesis is marked rather than
 * guessed, and a proposal knows which claims it adds and which it replaces.
 *
 * The interactive half — clicking a matrix cell, asking a question, accepting a
 * proposal, switching themes — is driven for real in
 * `scripts/verify-workspace.mjs`, against a running product, because a DOM
 * stub would prove only that the test can click.
 */

import { describe, expect, it } from "vitest";

import { blockIsSynthesis, citationNumbersFor, claimChanges, firstClaimByNumber } from "../src/browser/claims.js";
import { parseRoute, projectHash, VIEWS } from "../src/browser/routes.js";

describe("the page's addresses", () => {
  it("opens the view a project URL names", () => {
    expect(parseRoute("#/p/task_1/research")).toEqual({ kind: "project", taskId: "task_1", view: "research" });
    expect(parseRoute("#/p/task_1/report")).toEqual({ kind: "project", taskId: "task_1", view: "report" });
    expect(parseRoute("#/p/task_1/sources")).toEqual({ kind: "project", taskId: "task_1", view: "sources" });
    expect(parseRoute("#/p/task_1/gallery")).toEqual({ kind: "project", taskId: "task_1", view: "gallery" });
  });

  it("treats the start page and settings as their own places", () => {
    expect(parseRoute("")).toEqual({ kind: "start" });
    expect(parseRoute("#/")).toEqual({ kind: "start" });
    expect(parseRoute("#/settings")).toEqual({ kind: "settings" });
  });

  it("falls back to the research view for an address it does not know", () => {
    expect(parseRoute("#/p/task_1/whatever")).toEqual({ kind: "project", taskId: "task_1", view: "research" });
    expect(parseRoute("#/p/task_1")).toEqual({ kind: "project", taskId: "task_1", view: "research" });
  });

  it("round-trips every view through its own hash", () => {
    for (const view of VIEWS) {
      expect(parseRoute(projectHash("task_x", view))).toEqual({ kind: "project", taskId: "task_x", view });
    }
  });
});

describe("citation numbers", () => {
  const numbersByClaim = { c1: [1, 2], c2: [2, 3], c3: [1] };

  it("keeps a block's numbers in the order the report minted them, without repeats", () => {
    expect(citationNumbersFor(["c2", "c1"], numbersByClaim)).toEqual([2, 3, 1]);
    expect(citationNumbersFor(["c1", "c3"], numbersByClaim)).toEqual([1, 2]);
  });

  it("maps a number back to one claim, so clicking it selects something real", () => {
    const byNumber = firstClaimByNumber(["c1", "c2"], numbersByClaim);
    expect(byNumber.get(1)).toBe("c1");
    expect(byNumber.get(2)).toBe("c1");
    expect(byNumber.get(3)).toBe("c2");
    expect(byNumber.get(9)).toBeUndefined();
  });

  it("returns nothing for a block with no claims", () => {
    expect(citationNumbersFor([], numbersByClaim)).toEqual([]);
    expect(firstClaimByNumber([], numbersByClaim).size).toBe(0);
  });
});

describe("synthesis marks", () => {
  const claims = new Map([
    ["s1", { synthesis: true, claimType: "synthesis" as const }],
    ["s2", { synthesis: undefined, claimType: "synthesis" as const }],
    ["f1", { synthesis: undefined, claimType: "fact" as const }],
  ]);

  it("marks a block as ours only when the claim contract says so", () => {
    expect(blockIsSynthesis(["s1"], claims)).toBe(true);
    expect(blockIsSynthesis(["s2"], claims)).toBe(true);
    expect(blockIsSynthesis(["f1"], claims)).toBe(false);
    expect(blockIsSynthesis(["f1", "s1"], claims)).toBe(false);
    expect(blockIsSynthesis([], claims)).toBe(false);
  });

  it("does not guess from a claim it cannot resolve", () => {
    expect(blockIsSynthesis(["missing"], claims)).toBe(false);
  });
});

describe("a proposal's claim changes", () => {
  it("splits additions from replacements by the base report's own ids", () => {
    const changes = claimChanges(
      [
        { id: "c1", text: "kept id" },
        { id: "c9", text: "new" },
      ],
      ["c1", "c2"],
    );
    expect(changes).toEqual([
      { claim: { id: "c1", text: "kept id" }, replaced: true },
      { claim: { id: "c9", text: "new" }, replaced: false },
    ]);
  });

  it("treats every claim as new against an empty base", () => {
    expect(claimChanges([{ id: "c1" }], []).every((change) => !change.replaced)).toBe(true);
  });
});
