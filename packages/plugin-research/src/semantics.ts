/**
 * The side-effect contract: who is allowed to change what, decided by the
 * application rather than by the model.
 *
 * Ask, Research and Edit are not three writing styles — they are three
 * different amounts of permission. Ask reads. Research may add material and
 * judgements. Edit may propose a change to one target and nothing else. A model
 * that writes "intent: ask" in a tool argument gets no credit for saying so:
 * the application mints an Action Grant when *it* starts a run, the grant is
 * the only thing the service consults, and a run that has no grant can write
 * nothing at all.
 *
 * The grant also carries the target, the base it was taken against and the
 * budget the application chose, so the boundary is inspectable after the fact
 * instead of being spread across prompt sentences.
 */

import { ID_PREFIX } from "./domain.js";
import { newId } from "./repository.js";

/** The three intents the assistant exposes. */
export type AssistantIntent = "ask" | "research" | "edit";

/**
 * Every intent a run can be started under.
 *
 * `draft`, `card` and `guide` are the program's own authorizations: the stage
 * that produces the first research card, the stage that writes the first
 * report, and the stage that writes the next guided question about the brief.
 * They exist so that "the agent may write a report" is never an ambient
 * permission — only the report stage holds it, and only the guide stage may
 * change the brief's guided record.
 */
export type ActionIntent = AssistantIntent | "draft" | "card" | "guide";

/** What a grant lets its run do. Nothing else in the product is writable. */
export type ActionCapability = "card" | "brief" | "research" | "report" | "proposal";

export interface GrantBudget {
  readonly maxSearches: number;
  readonly maxReads: number;
  readonly maxGapRounds: number;
}

/** What a grant's write is aimed at. */
export type GrantTargetType = "none" | "project" | "section" | "report";

export interface ActionGrant {
  readonly id: string;
  readonly sessionId: string;
  /** The task this action belongs to; `null` only for the card stage. */
  readonly taskId: string | null;
  readonly intent: ActionIntent;
  readonly targetType: GrantTargetType;
  readonly targetId: string | null;
  /** A sentence a person can read, describing what this action may touch. */
  readonly scope: string;
  readonly baseReportId: string | null;
  readonly baseContentHash: string | null;
  /** Whether this run may search and read at all. */
  readonly allowResearch: boolean;
  readonly capabilities: readonly ActionCapability[];
  readonly budget: GrantBudget;
  readonly createdAt: string;
}

/** The capabilities an intent confers, before the research switch is applied. */
const INTENT_CAPABILITIES: Readonly<Record<ActionIntent, readonly ActionCapability[]>> = Object.freeze({
  ask: [],
  research: ["research"],
  edit: ["proposal"],
  draft: ["report"],
  card: ["card"],
  guide: ["brief"],
});

/**
 * Resolves an intent into the exact set of writes it may perform.
 *
 * Research is the only capability `allowResearch` controls: an Edit that was
 * authorized to look things up before proposing still never gains the right to
 * commit a report, and an Ask that claimed to need the network gains nothing.
 */
export function capabilitiesFor(intent: ActionIntent, allowResearch: boolean): readonly ActionCapability[] {
  const base = INTENT_CAPABILITIES[intent];
  if (!allowResearch || base.includes("research")) return [...base];
  return [...base, "research"];
}

export interface GrantInput {
  readonly sessionId: string;
  readonly intent: ActionIntent;
  readonly taskId: string | null;
  readonly targetType?: GrantTargetType;
  readonly targetId?: string | null;
  readonly scope?: string;
  readonly baseReportId?: string | null;
  readonly baseContentHash?: string | null;
  readonly allowResearch?: boolean;
  readonly budget?: GrantBudget;
  readonly now?: string;
}

/** What each intent does by default, in the words the workspace shows. */
const SCOPE_TEXT: Readonly<Record<ActionIntent, string>> = Object.freeze({
  ask: "只读取当前项目材料作答，不写入任何正式数据",
  research: "可以检索、读取并保存证据与支持评估；不修改报告正文",
  edit: "只针对指定目标生成修改提案；接受前报告正文不变",
  draft: "撰写并保存本任务的报告版本",
  card: "建立研究任务卡",
  guide: "针对研究简报草稿生成下一个引导问题",
});

/** The default research budget a grant carries: the task's own limits apply too. */
const DEFAULT_GRANT_BUDGET: GrantBudget = Object.freeze({ maxSearches: 6, maxReads: 10, maxGapRounds: 2 });

export function createGrant(input: GrantInput): ActionGrant {
  const allowResearch = input.allowResearch ?? false;
  return {
    id: newId(ID_PREFIX.action),
    sessionId: input.sessionId,
    taskId: input.taskId,
    intent: input.intent,
    targetType: input.targetType ?? (input.intent === "ask" ? "project" : "none"),
    targetId: input.targetId ?? null,
    scope: input.scope ?? SCOPE_TEXT[input.intent],
    baseReportId: input.baseReportId ?? null,
    baseContentHash: input.baseContentHash ?? null,
    allowResearch,
    capabilities: capabilitiesFor(input.intent, allowResearch),
    budget: input.budget ?? DEFAULT_GRANT_BUDGET,
    createdAt: input.now ?? new Date().toISOString(),
  };
}

export interface IntentReading {
  readonly intent: AssistantIntent;
  readonly explicit: boolean;
  /** Why the application read it that way, in one sentence. */
  readonly reason: string;
}

/**
 * Reads an instruction's intent, with the safe answer as the default.
 *
 * This is the "Auto" layer and it is deliberately small: a handful of readable
 * markers instead of a classifier, because the cost of guessing wrong is not
 * symmetric. Guessing `research` when the user asked a question spends budget;
 * guessing `edit` would start writing. Guessing `ask` costs one clarifying
 * sentence, so anything the markers do not claim stays an Ask.
 */
export function classifyIntent(text: string): IntentReading {
  const value = text.trim();
  const edit = EDIT_MARKERS.find((marker) => marker.test(value));
  if (edit !== undefined) {
    return { intent: "edit", explicit: false, reason: `指令包含修改目标对象的表述（${edit.source}），按 Edit 处理` };
  }
  const research = RESEARCH_MARKERS.find((marker) => marker.test(value));
  if (research !== undefined) {
    return { intent: "research", explicit: false, reason: `指令要求补充材料（${research.source}），按 Research 处理` };
  }
  return { intent: "ask", explicit: false, reason: "未识别出补查或修改要求，按 Ask 处理（不写入正式数据）" };
}

const EDIT_MARKERS: readonly RegExp[] = [
  /修改|改成|改写|重写|润色|简化|精简|扩写|缩短|编辑|替换|重排/,
  /(加入|补充|更新|写进|写进|纳入|添加到).{0,6}(报告|正文|章节|摘要)/,
  /(报告|正文|章节|摘要).{0,6}(加|补|改|删|去掉)/,
];

const RESEARCH_MARKERS: readonly RegExp[] = [
  /补查|补充材料|再找|多找|查证|考证|找(一?些)?(独立)?(证据|依据|来源|反例)/,
  /检索|搜索|深入调查|调研一下|读取/,
];

export function grantHasCapability(grant: ActionGrant | undefined, capability: ActionCapability): boolean {
  return grant !== undefined && grant.capabilities.includes(capability);
}
