/**
 * The ranking lexicon, at the sentences that decide it.
 *
 * A cost claim is refused when it ranks two objects whose numbers are not
 * comparable. That rule is right, and it was applied to the wrong sentence: a
 * claim that says「索引成本只能分口径陈述，不能合成一个『更便宜』的判断」is doing what
 * the contract asks, and the first version of the lexicon read it as the
 * ranking it is refusing. So the split under test here is between *asserting* a
 * ranking and *refusing* one — including the case where a paragraph does both,
 * which must still be refused for the part that asserts.
 */

import { describe, expect, it } from "vitest";

import type { Evidence, ReportClaim, Source, SupportAssessment } from "../src/domain.js";
import { assertsRanking, validateClaimContract, type ClaimContext } from "../src/claims.js";

function context(): ClaimContext {
  const sources: readonly Source[] = [
    { id: "src_a", taskId: "t", role: "primary" } as unknown as Source,
    { id: "src_b", taskId: "t", role: "primary" } as unknown as Source,
  ];
  const evidence: readonly Evidence[] = [
    { id: "ev_a", sourceId: "src_a", excerpt: "索引 token 为 X。", cells: [{ subjectId: "sub_a" }] } as unknown as Evidence,
    { id: "ev_b", sourceId: "src_b", excerpt: "索引时间与显存上升。", cells: [{ subjectId: "sub_b" }] } as unknown as Evidence,
  ];
  return {
    evidence,
    sources,
    assessments: [] as readonly SupportAssessment[],
    subjectNames: new Map([
      ["sub_a", "MethodA"],
      ["sub_b", "MethodB"],
    ]),
  };
}

/**
 * The real claim, verbatim from a failed run's draft.
 *
 * It is the sentence the lexicon misread: it states each source's own numbers
 * side by side and then says, in the same paragraph, that they cannot be merged
 * into a cheaper/expensive verdict.
 */
const REAL_COST_CLAIM_TEXT =
  "索引成本只能分口径陈述，不能合成一个“更便宜”的判断。在 HippoRAG 2 论文自身口径内：" +
  "token/调用量上它低于 GraphRAG 与 LightRAG；索引时间上快于二者、但慢于 RAPTOR 与 HippoRAG；" +
  "显存上因 fact embedding 而高于基线。两篇的来源、语料与度量项不同，因此不能合并为一张跨来源的成本排名。";

const REAL_COST_CLAIM: ReportClaim = {
  id: "clm_cost_scope_not_comparable",
  text: REAL_COST_CLAIM_TEXT,
  evidenceIds: ["ev_a", "ev_b"],
  kind: "comparison",
  claimType: "cost",
  subjects: ["sub_a", "sub_b"],
  conditions: {
    costStage: "indexing",
    comparability: "not-directly-comparable",
    basis: "author-reported",
    scope: "仅在原论文自身口径内陈述，按三项成本指标分开。",
  },
};

describe("the ranking lexicon", () => {
  it("does not read a refusal as a ranking", () => {
    expect(assertsRanking("不能得出谁更便宜的判断。")).toBe(false);
    expect(assertsRanking("本报告无法给出更便宜的排名。")).toBe(false);
    expect(assertsRanking("这些数字不能合成一个「更便宜」的判断。")).toBe(false);
    expect(assertsRanking("没有依据表明 A 优于 B。")).toBe(false);
    expect(assertsRanking("The numbers are not comparable, so no method outperforms the other.")).toBe(false);
  });

  it("still reads a stated ranking as one", () => {
    expect(assertsRanking("MethodA 比 MethodB 更便宜。")).toBe(true);
    expect(assertsRanking("MethodA 优于 MethodB。")).toBe(true);
    expect(assertsRanking("MethodB outperforms MethodA on multi-hop retrieval.")).toBe(true);
  });

  it("does not let one refusal exempt a ranking stated beside it", () => {
    // The whole point of scoping the refusal to its clause: a sentence that
    // refuses one ranking and states another still ranks.
    expect(assertsRanking("本报告不取任一数字为定论，MethodA 比 MethodB 更便宜。")).toBe(true);
    expect(assertsRanking("不能直接比较 tokens；但 MethodA 比 MethodB 更便宜。")).toBe(true);
    expect(assertsRanking("无法比较两篇的设置，然而 MethodA 的延迟更低。")).toBe(true);
  });

  it("keeps a refusal's own objects together, so 、 does not split it", () => {
    // 「A、B 两个对象都不更便宜」is one clause; splitting on 、 would put the
    // ranking word outside the refusal's reach.
    expect(assertsRanking("不能对 A、B 给出更便宜的判断。")).toBe(false);
  });
});

describe("the cost contract with the fixed lexicon", () => {
  it("lets the real draft's cost claim pass, because it refuses the verdict it is accused of", () => {
    const verdict = validateClaimContract(REAL_COST_CLAIM, context());
    expect(verdict.errors, verdict.errors.join("; ")).toEqual([]);
  });

  it("still refuses a cost ranking that declares its numbers incomparable", () => {
    const ranked: ReportClaim = { ...REAL_COST_CLAIM, text: "在索引阶段，MethodA 比 MethodB 更便宜。", conditions: { ...REAL_COST_CLAIM.conditions, comparability: "not-directly-comparable" } };
    const verdict = validateClaimContract(ranked, context());
    expect(verdict.errors.join(" ")).toContain("口径可比");
  });

  it("still refuses a cost ranking whose evidence mixes families", () => {
    const ranked: ReportClaim = {
      ...REAL_COST_CLAIM,
      text: "MethodA 的索引成本更低。",
      conditions: { ...REAL_COST_CLAIM.conditions, comparability: "comparable" },
    };
    const ctx = context();
    const mixed: ClaimContext = {
      ...ctx,
      evidence: [
        { id: "ev_a", sourceId: "src_a", excerpt: "索引消耗 1.2M tokens。", cells: [{ subjectId: "sub_a" }] } as unknown as Evidence,
        { id: "ev_b", sourceId: "src_b", excerpt: "显存占用 40 GB。", cells: [{ subjectId: "sub_b" }] } as unknown as Evidence,
      ],
    };
    const verdict = validateClaimContract(ranked, mixed);
    expect(verdict.errors.join(" ")).toContain("口径");
  });

  it("keeps the requirement that a cost claim declares its stage", () => {
    const undeclared: ReportClaim = { ...REAL_COST_CLAIM, conditions: { comparability: "not-directly-comparable" } };
    expect(validateClaimContract(undeclared, context()).errors.join(" ")).toContain("costStage");
  });

  it("keeps the synthesis requirement of two sources", () => {
    const oneSource: ReportClaim = {
      id: "clm_synth",
      text: "把两个来源放在一起看，成本结构分成抽取与社区摘要两项。",
      evidenceIds: ["ev_a"],
      kind: "inference",
      claimType: "synthesis",
      synthesis: true,
      conditions: { scope: "推断桥梁：两项成本在各自来源里都被报告。" },
    };
    expect(validateClaimContract(oneSource, context()).errors.join(" ")).toContain("≥2 个不同来源");
    const twoSources: ReportClaim = { ...oneSource, evidenceIds: ["ev_a", "ev_b"] };
    expect(validateClaimContract(twoSources, context()).errors).toEqual([]);
  });
});
