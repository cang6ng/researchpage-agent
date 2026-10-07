/**
 * The collaboration, read back as a conversation.
 *
 * The project already records every action a person asked for — the sentence
 * they typed, what the run did, whether it produced anything — and the page
 * must not invent a second history beside it. What this module does is put
 * those records in the order they happened and say what each one is: a
 * question, an errand for material, or a proposed change. The assistant's own
 * prose is only ever taken from a run that really wrote prose (an Ask); for the
 * others the sentence is the product's, because narrating a tool call as if the
 * model had said it would be putting words in its mouth.
 *
 * Two things are deliberately absent. Tool names and raw result JSON never
 * reach the reader — a tool call is shown as what it did in Chinese, and a
 * refusal is shown as the sentence the tool itself wrote. And the layout
 * arithmetic lives here too, so the 50/50 workspace can be checked as a number
 * rather than by looking at a screenshot.
 */

import type { AnswerView, ProposalView, RunOutcomeView, RunStepView, RunView, TaskBundle } from "./api.js";
import { TOOL_LABELS } from "./api.js";
import { countCalls, interactionIdOf, refusedCall } from "./outcome.js";

export { refusedCall };

/** How many interactions the workspace shows. Enough to be a history, not a log. */
export const CONVERSATION_LIMIT = 10;

export type InteractionKind = "ask" | "research" | "edit";

/** One thing the reader asked for, and what came back. */
export interface Interaction {
  readonly id: string;
  readonly runId: string | null;
  readonly kind: InteractionKind;
  readonly at: string;
  readonly endedAt: string | null;
  readonly status: RunView["status"];
  /** The reader's own sentence. */
  readonly userText: string;
  /** The assistant's words, when the run is one that answers in prose. */
  readonly answer: string | null;
  readonly searches: number;
  readonly reads: number;
  readonly assessments: number;
  /** An Edit that really drafted a proposal, read from the run's own record. */
  readonly drafted: boolean;
  /** Why an Edit produced nothing, in the tool's own words. */
  readonly refusal: string;
  /** The calls this run made, named in Chinese and without their payloads. */
  readonly steps: readonly { readonly label: string; readonly failed: boolean }[];
  /** When the run failed as a whole, the application's own sentence. */
  readonly failure: string;
  /**
   * What this action resolved, when the run carries an outcome.
   *
   * It is the answer to「问题解决了吗」, kept with the turn that produced it:
   * a research action's result is not how many tools ran, and an Edit's result
   * is not how many claims changed.
   */
  readonly outcome: RunOutcomeView | null;
}

/** A refusal arrives inside a tool result; the reader gets its sentences. */
export function refusalOf(detail: string): string {
  // When the refusal carries a sentence written for the person who asked for
  // the change, that sentence is the answer — the problems beside it are the
  // model's repair instructions and name checks, contracts and hashes.
  const forUser = /"userMessage":"((?:[^"\\]|\\.)*)"/.exec(detail);
  if (forUser !== null) return unescapeJson(forUser[1]);
  const match = /\{"ok":false,"problems":\[(.*?)\]/.exec(detail);
  if (match === null) return detail.length > 0 ? detail.slice(0, 160) : "";
  return match[1]
    .split(",")
    .map((part) => part.trim().replace(/^"|"$/g, ""))
    .filter((part) => part.length > 0)
    .join("；");
}

/** A JSON string's escapes, undone — a refusal may carry quotes and newlines. */
function unescapeJson(value: string): string {
  return value.replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
}

/** What one step did, said for a reader: what it read, not what a tool is called. */
export function stepLabel(step: RunStepView): string {
  return TOOL_LABELS[step.name] ?? "执行一步";
}

/** The steps of a run, as the reader's own summary of them. */
function stepsOf(run: RunView): Interaction["steps"] {
  return run.activity
    .filter((step) => step.ok !== null)
    .slice(-8)
    .map((step) => ({ label: stepLabel(step), failed: step.ok === false || refusedCall(step.detail) }));
}

function kindOf(stage: RunView["stage"]): InteractionKind | null {
  if (stage === "ask") return "ask";
  // The user's research action and the program's own gap round share a stage;
  // what tells them apart is whether a person's sentence is attached to it.
  if (stage === "gap") return "research";
  if (stage === "edit") return "edit";
  return null;
}

/**
 * The interactions of this project, oldest first.
 *
 * Only the runs a person asked for appear. The agent's own passes — the first
 * research, the automatic gap rounds, the writing — are work the product did,
 * and putting them in the same list would make the conversation claim a
 * collaboration that did not happen.
 */
export function conversationOf(bundle: TaskBundle, answers: readonly AnswerView[]): readonly Interaction[] {
  const interactions: Interaction[] = [];
  for (const run of bundle.runs) {
    const kind = kindOf(run.stage);
    if (kind === null || run.userText.length === 0) continue;
    const proposalCall = run.activity.filter((step) => step.name === "propose_section_edit").slice(-1)[0];
    interactions.push({
      id: interactionIdOf(run),
      runId: run.runId,
      kind,
      at: run.startedAt,
      endedAt: run.endedAt,
      status: run.status,
      userText: run.userText,
      answer: kind === "ask" ? (answers.find((entry) => entry.runId === run.runId)?.text ?? null) : null,
      searches: countCalls(run, "search_sources"),
      reads: countCalls(run, "read_source"),
      assessments: countCalls(run, "assess_coverage"),
      drafted:
        run.outcome?.kind === "edit"
          ? run.outcome.status === "proposal_created"
          : proposalCall !== undefined && proposalCall.ok === true && !refusedCall(proposalCall.detail),
      refusal: proposalCall === undefined ? "" : refusalOf(proposalCall.detail),
      steps: stepsOf(run),
      failure: run.status === "failed" || run.status === "interrupted" ? run.note : "",
      outcome: run.outcome ?? null,
    });
  }
  return interactions.slice(-CONVERSATION_LIMIT);
}

/**
 * The proposal an action produced, if the application still holds it.
 *
 * It is matched by time rather than by id, because the record of the run does
 * not carry the proposal's id — and it does not have to: a proposal can only
 * have been created while its own action ran. What the match has to avoid is
 * attaching a *later* action's proposal to an earlier one's message.
 */
export function proposalFor(
  interaction: Interaction,
  proposals: readonly ProposalView[],
  now: number,
): ProposalView | null {
  const start = Date.parse(interaction.at);
  const end = interaction.endedAt === null ? now : Date.parse(interaction.endedAt);
  const inWindow = proposals.filter((proposal) => {
    const at = Date.parse(proposal.createdAt);
    return Number.isFinite(at) && at >= start - 1_000 && at <= end + 60_000;
  });
  const pending = inWindow.filter((proposal) => proposal.status === "pending");
  return pending.slice(-1)[0] ?? inWindow.slice(-1)[0] ?? null;
}

/** Whether this action spent its own allowance and has nothing left to ask for. */
export function budgetExhausted(
  interaction: Interaction,
  allowance: { readonly searches: number; readonly reads: number },
): boolean {
  if (interaction.kind !== "research") return false;
  return interaction.searches >= allowance.searches || interaction.reads >= allowance.reads;
}

/* ---------------------------------------------------------------- layout -- */

/** The workspace in co-edit mode, split evenly and then by the reader's hand. */
export const COEDIT_SPLIT = Object.freeze({ default: 50, min: 40, max: 60 });

export function clampSplit(value: number): number {
  if (!Number.isFinite(value)) return COEDIT_SPLIT.default;
  return Math.min(COEDIT_SPLIT.max, Math.max(COEDIT_SPLIT.min, Math.round(value)));
}

/** The split a drag lands on, as a share of the whole workspace. */
export function splitFromDrag(input: {
  readonly startSplit: number;
  readonly startX: number;
  readonly x: number;
  readonly width: number;
}): number {
  if (input.width <= 0) return clampSplit(input.startSplit);
  return clampSplit(input.startSplit + ((input.x - input.startX) / input.width) * 100);
}

/** Which of the three shapes the studio is in. */
export type StudioLayout = "reading" | "inspect" | "coedit";

/**
 * The studio's shape, decided by what is open rather than by the window.
 *
 * Opening the assistant opens a workspace and the document shares the screen
 * with it; the panel keeps that shape while it shows something else (a
 * sentence's evidence, a proposal), because the reader is still working beside
 * the document. Closing it puts the document back in the middle of the page.
 */
export function studioLayout(input: {
  readonly dockOpen: boolean;
  readonly workspaceOpen: boolean;
}): StudioLayout {
  if (!input.dockOpen) return "reading";
  return input.workspaceOpen ? "coedit" : "inspect";
}
