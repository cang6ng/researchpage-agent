/**
 * The one status line the product is allowed to keep, and the detail behind it.
 *
 * The bar answers exactly one question — what is happening with this project
 * right now — and it answers it with one sentence. Everything else the project
 * knows about itself is a different question: how much material exists, how
 * many research questions are still open, whether the report is behind its
 * material, whether it passed its own content contract, what kind of material
 * the sources are. Those belong in the detail, side by side, each in its own
 * words, because a single badge that merges them says something true of none of
 * them —「报告就绪 · 无待查项」printed next to「9 处义务未完全达成」.
 *
 * The priority order is the product's: work in flight, then a decision the
 * reader owes, then what the research has not settled, and only then "nothing
 * needs you". A finished state is the last thing the bar says, never the first.
 */

import type { TaskBundle } from "./api.js";

export type PrimaryStatusKind =
  | "failed"
  | "running"
  | "preparing"
  | "proposal"
  | "needs_review"
  | "unresolved"
  | "ready";

export interface PrimaryStatus {
  readonly kind: PrimaryStatusKind;
  readonly label: string;
  readonly tone: "accent" | "limited" | "reviewed" | "danger";
}

/** How many research questions still have no settled conclusion. */
export function openResearchCount(bundle: TaskBundle): number {
  const research = bundle.presentation.unresolvedResearch;
  return research.unresolved + research.limited + research.incomparable;
}

/**
 * What the project is doing, in one sentence, in the reader's words.
 *
 * Nothing here recomputes a fact the server already derived: the stages come
 * from `presentation.runState`, the review flag from `presentation.reportReview`
 * and the open questions from `presentation.unresolvedResearch`.
 */
export function primaryStatusOf(bundle: TaskBundle): PrimaryStatus {
  const readout = bundle.presentation;
  const run = readout.runState.state;
  const open = openResearchCount(bundle);

  if (run === "failed") return { kind: "failed", label: "运行失败", tone: "danger" };
  if (run === "preparing") return { kind: "preparing", label: "待确认研究范围", tone: "limited" };
  if (run === "researching" || (run === "editing" && bundle.busy)) {
    return { kind: "running", label: readout.runState.displayName, tone: "accent" };
  }
  if (bundle.proposals.some((proposal) => proposal.status === "pending")) {
    return { kind: "proposal", label: "有修改待确认", tone: "accent" };
  }
  if (readout.reportReview.state === "needs_review") {
    return {
      kind: "needs_review",
      label: open > 0 ? `报告待复核 · ${String(open)} 项未定论` : "报告待复核",
      tone: "limited",
    };
  }
  if (open > 0) {
    return {
      kind: "unresolved",
      label: bundle.hasReport ? `报告可阅读 · ${String(open)} 项研究问题仍未解决` : `${String(open)} 项研究问题仍未解决`,
      tone: "limited",
    };
  }
  return {
    kind: "ready",
    label: bundle.hasReport ? "报告可阅读 · 比较项均已核对" : "材料已核对",
    tone: "reviewed",
  };
}

export interface StatusDetailRow {
  readonly label: string;
  readonly text: string;
}

/**
 * The same project, told as the separate facts it is made of.
 *
 * The rows do not collapse into one another: material coverage is not a
 * conclusion, a clean review flag is not an independent verification, and a
 * report that passed its content contract is not a report without open
 * research. Reading them side by side is exactly how the reader sees that.
 */
export function statusDetails(bundle: TaskBundle): readonly StatusDetailRow[] {
  const readout = bundle.presentation;
  return [
    { label: "当前动作", text: readout.runState.userMessage },
    { label: "材料覆盖", text: readout.evidenceCoverage.userMessage },
    { label: "研究判断", text: readout.unresolvedResearch.userMessage },
    { label: "报告", text: readout.reportReview.userMessage },
    { label: "质量检查", text: readout.artifactQuality.userMessage },
    { label: "来源", text: readout.sourceRoles.userMessage },
  ];
}

/**
 * Where the research scope lives now, said as one line.
 *
 * It is a property of the project rather than a workspace: the reader looks it
 * up to remember what was agreed, not to work in it, so the entry sits beside
 * the project's own title.
 */
export function scopeEntryLabel(bundle: TaskBundle): string {
  return bundle.task.confirmed ? "研究范围 · 已确认" : "研究范围 · 待确认";
}

/** The scope in the smallest useful summary: what the matrix is built on. */
export function scopeSummary(bundle: TaskBundle): string {
  const subjects = bundle.subjects.length;
  const dimensions = bundle.dimensions.length;
  if (subjects === 0 && dimensions === 0) return "还没有确定比较对象与研究维度";
  return `${String(subjects)} 个比较对象 · ${String(dimensions)} 个研究维度`;
}
