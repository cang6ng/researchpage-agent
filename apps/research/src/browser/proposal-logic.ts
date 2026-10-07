/**
 * What a proposal looks like from the reader's side of the decision.
 *
 * There are five states in the record and two things a reader can do, so this
 * module is the one place that decides which is which: the label in the
 * reader's words, whether the decision is still theirs to make, and whether the
 * proposal opens as the task in front of them or as one line of history. A
 * pending proposal is the only one that offers a decision, and it is the only
 * one that cannot be folded away.
 */

import { PROPOSAL_STATUS_LABELS, type ProposalView } from "./api.js";

export interface ProposalViewState {
  readonly label: string;
  readonly tone: "accent" | "reviewed" | "quiet" | "danger";
  /** Whether accepting or discarding it is still the reader's to decide. */
  readonly decidable: boolean;
  /** Whether it opens as one line of history rather than as the full panel. */
  readonly folded: boolean;
}

export function proposalViewState(status: ProposalView["status"]): ProposalViewState {
  return {
    label: PROPOSAL_STATUS_LABELS[status] ?? status,
    tone: status === "pending" ? "accent" : status === "accepted" ? "reviewed" : status === "invalid" ? "danger" : "quiet",
    decidable: status === "pending",
    folded: status !== "pending",
  };
}

/**
 * What an edit's own research added, as one line.
 *
 * Zero is a real answer and it is said in words: an edit that searched for
 * nothing reports that it added nothing, rather than quietly omitting the line
 * or reporting how much material the project happens to hold.
 */
export function proposalDeltaLine(added: {
  readonly sources: number;
  readonly evidence: number;
  readonly assessments: number;
}): string {
  if (added.sources === 0 && added.evidence === 0 && added.assessments === 0) return "本次修改没有新增研究材料。";
  const parts: string[] = [];
  if (added.sources > 0) parts.push(`${String(added.sources)} 个来源`);
  if (added.evidence > 0) parts.push(`${String(added.evidence)} 条证据`);
  if (added.assessments > 0) parts.push(`${String(added.assessments)} 条评估`);
  return parts.join(" · ");
}
