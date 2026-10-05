/**
 * A proposal: one scoped change to one report, held until a person accepts it.
 *
 * The product's editing rule is that an agent never replaces the report. It
 * produces a proposal that names the base it was written against, the exact
 * targets it may change, the replacement content for those targets, and the
 * material it relies on. Applying it is a separate, explicit act that checks
 * the base still matches, touches only the authorized targets, validates the
 * result and records which report it produced — so the same proposal applied
 * twice lands once, and a proposal written against yesterday's text cannot
 * overwrite today's.
 *
 * Nothing here deletes research: discarding a proposal closes the proposal.
 */

import type { ReportBlock, ReportClaim, ReportFrame, ReportSection } from "./domain.js";
import { ID_PREFIX } from "./domain.js";
import { hashOf } from "./hash.js";
import { newId } from "./repository.js";

/**
 * A proposal's lifecycle.
 *
 * `stale` means the report moved underneath the proposal — the base hash check
 * failed, so it can never be merged. `invalid` means the proposal's own content
 * failed report validation. Both are refusals the product records rather than
 * silently retries.
 */
export type ProposalStatus = "pending" | "accepted" | "discarded" | "stale" | "invalid";

/** The edit granularities v1 ships: a section, or the summary as an extra target. */
export interface ProposalTarget {
  readonly targetType: "section" | "summary";
  readonly targetId: string;
  /** The target's content hash in the base report, as the proposal saw it. */
  readonly baseHash: string;
}

/** One replacement section, in the shape the renderer already understands. */
export interface ProposalSection {
  readonly id: string;
  readonly title: string;
  readonly blocks: readonly ReportBlock[];
}

export interface Proposal {
  readonly id: string;
  readonly actionId: string;
  readonly taskId: string;
  readonly baseReportId: string;
  readonly baseContentHash: string;
  readonly targets: readonly ProposalTarget[];
  /** Replacement content, one entry per target (extra entries are ignored). */
  readonly sections: readonly ProposalSection[];
  /** Claims the proposal adds or replaces; the base's other claims are kept. */
  readonly claims: readonly ReportClaim[];
  readonly evidenceIds: readonly string[];
  /** Why the change is proposed, in one or two sentences. */
  readonly reason: string;
  /** A replacement summary, when the summary was declared as a target. */
  readonly summary: string | null;
  readonly status: ProposalStatus;
  readonly createdAt: string;
  readonly decidedAt: string | null;
  /** The report this proposal produced, once accepted. */
  readonly acceptedReportId: string | null;
  /** What the edit's own research brought in, counted when the proposal was made. */
  readonly researchAdded: { readonly sources: number; readonly evidence: number; readonly assessments: number };
}

/** The report content a proposal is written against. */
export interface ProposalBase {
  readonly title: string;
  readonly summary: string;
  /** The report's declared question, audience and scope, when it has one. */
  readonly frame?: ReportFrame;
  readonly sections: readonly ReportSection[];
  readonly claims: readonly ReportClaim[];
}

/** A section's identity for staleness purposes: its title and its blocks. */
export function sectionHash(section: ProposalSection): string {
  return hashOf({ id: section.id, title: section.title, blocks: section.blocks });
}

/**
 * Applies a proposal to its base, changing only the authorized targets.
 *
 * The merge is intentionally dull: replace the named sections, replace or add
 * the named claims, replace the summary only when the summary is itself a
 * declared target. A proposal that wants the summary to move has to list it —
 * an edit to one section never rewrites the report's own claim on its way out.
 */
export function applyProposal(base: ProposalBase, proposal: Proposal): ProposalBase {
  const replacementBySection = new Map(proposal.sections.map((section) => [section.id, section]));
  const targetIds = new Set(proposal.targets.map((target) => target.targetId));

  // Only targets that actually exist in the base are replaced, and the base's
  // own section order is preserved: an edit may not silently reorder a report.
  const sections = base.sections.map((section) => {
    if (!targetIds.has(section.id)) return section;
    const replacement = replacementBySection.get(section.id);
    if (replacement === undefined) return section;
    return { id: section.id, title: replacement.title, blocks: replacement.blocks };
  });

  const claimById = new Map(base.claims.map((claim) => [claim.id, claim]));
  for (const claim of proposal.claims) claimById.set(claim.id, claim);
  const claims = [...claimById.values()];

  const summaryTarget = proposal.targets.some((target) => target.targetType === "summary");
  const summary = summaryTarget && proposal.summary !== null ? proposal.summary : base.summary;

  // The report's declared frame is part of the report, so an edit keeps it:
  // replacing a section is not a way to change what the report claims to be
  // about. Changing the frame is its own proposal target, not a side effect.
  return {
    title: base.title,
    summary,
    ...(base.frame === undefined ? {} : { frame: base.frame }),
    sections,
    claims,
  };
}

export type FreshnessCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly problem: string };

/**
 * Whether a proposal still describes the report it was written against.
 *
 * Three separate facts have to hold: the proposal is still the one being
 * decided, the report it named is still the current one, and the targets' text
 * has not moved. When any of them fails the answer names the failure — the
 * product refuses to merge, rather than merging something the user never saw.
 */
export function checkProposalFreshness(input: {
  readonly proposal: Proposal;
  readonly currentReportId: string | null;
  readonly base: ProposalBase | null;
}): FreshnessCheck {
  const { proposal } = input;
  if (proposal.status !== "pending") {
    return { ok: false, problem: `提案状态为 ${proposal.status}，不能按待处理提案应用` };
  }
  if (input.currentReportId !== proposal.baseReportId) {
    return {
      ok: false,
      problem: `基线已变化：提案基于 ${proposal.baseReportId}，当前报告是 ${input.currentReportId ?? "（无）"}；请重新生成修改提案`,
    };
  }
  if (input.base === null) {
    return { ok: false, problem: `提案的基线报告 ${proposal.baseReportId} 不存在` };
  }
  if (hashOf(contentOf(input.base)) !== proposal.baseContentHash) {
    return { ok: false, problem: "基线已变化：报告正文与提案记录的内容 hash 不一致；请重新生成修改提案" };
  }
  const byId = new Map(input.base.sections.map((section) => [section.id, section]));
  for (const target of proposal.targets) {
    if (target.targetType === "summary") {
      if (hashOf(input.base.summary) !== target.baseHash) {
        return { ok: false, problem: "基线已变化：摘要与提案记录的内容 hash 不一致；请重新生成修改提案" };
      }
      continue;
    }
    const section = byId.get(target.targetId);
    if (section === undefined) {
      return { ok: false, problem: `目标章节 ${target.targetId} 已不在基线报告中` };
    }
    if (sectionHash(section) !== target.baseHash) {
      return { ok: false, problem: `目标章节 ${target.targetId} 的内容已变化；请重新生成修改提案` };
    }
  }
  return { ok: true };
}

/**
 * The hashable content of a report-shaped value.
 *
 * It has to agree with `reportContentHash`, because the set of things a
 * proposal pins is exactly the set of things that make a report a different
 * report: wording, frame, structure, claims.
 */
export function contentOf(base: ProposalBase): {
  readonly title: string;
  readonly summary: string;
  readonly frame?: ReportFrame;
  readonly sections: readonly ReportSection[];
  readonly claims: readonly ReportClaim[];
} {
  return {
    title: base.title,
    summary: base.summary,
    ...(base.frame === undefined ? {} : { frame: base.frame }),
    sections: base.sections,
    claims: base.claims,
  };
}

export function createProposal(input: {
  readonly actionId: string;
  readonly taskId: string;
  readonly baseReportId: string;
  readonly base: ProposalBase;
  readonly targets: readonly ProposalTarget[];
  readonly sections: readonly ProposalSection[];
  readonly claims: readonly ReportClaim[];
  readonly evidenceIds: readonly string[];
  readonly reason: string;
  readonly researchAdded: Proposal["researchAdded"];
  readonly summary?: string | null;
  readonly now: string;
}): Proposal {
  return {
    id: newId(ID_PREFIX.proposal),
    actionId: input.actionId,
    taskId: input.taskId,
    baseReportId: input.baseReportId,
    baseContentHash: hashOf(contentOf(input.base)),
    targets: input.targets,
    sections: input.sections,
    claims: input.claims,
    evidenceIds: input.evidenceIds,
    reason: input.reason,
    summary: input.summary ?? null,
    status: "pending",
    createdAt: input.now,
    decidedAt: null,
    acceptedReportId: null,
    researchAdded: input.researchAdded,
  };
}
