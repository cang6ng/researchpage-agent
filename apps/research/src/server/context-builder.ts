/**
 * The research context builder: the system prompt, plus this session's brief.
 *
 * The brief is what makes a long research task possible inside a bounded
 * context: every run is told which task it belongs to, which cells are still
 * missing, which sources exist and how much budget is left — as ids and counts,
 * never as text. It goes into the *fixed* context (the system prompt), so the
 * Core's own selector still chooses the history that fits the remaining budget
 * rather than the product appending material after the budget was computed.
 */

import type { ContextBuilder, ContextBuilderInput, FixedContext, FixedContextInput } from "@every-dagent/agent-core";
import { createDefaultContextBuilder } from "@every-dagent/agent-core";
import { RESEARCH_SYSTEM_PROMPT, researchTaskBrief, type ResearchService } from "@every-dagent/plugin-research";

export interface ResearchContextBuilderOptions {
  readonly service: ResearchService;
  /** The task's own vocabulary, appended after the shared protocol. */
  readonly systemPrompt?: string;
}

/**
 * What a session without a task is told about itself.
 *
 * A session that has an exploration in progress is *not* one that has nothing:
 * it is one where the user has asked for something and not yet confirmed it,
 * and the model has to know that before it decides what to do with the tool it
 * was given. `undefined` from `researchTaskBrief` means no task exists yet —
 * which is exactly the state the intent conversation runs in.
 */
function noTaskBrief(service: ResearchService, sessionId: string): string {
  const intent = service.intentForSession(sessionId);
  if (intent === undefined) {
    return "本会话还没有研究任务：如果用户给出主题，先与用户确认研究方向（Intent Discovery），而不是直接替用户确定题目。";
  }
  const openFields = intent.openFields.length === 0 ? "（无）" : intent.openFields.join("、");
  return [
    "【当前意图探索】本会话还没有研究任务，正处于「与用户确认研究方向」阶段：",
    `- 用户最初的输入：${intent.seedTopic}`,
    `- 状态：${intent.statusLabel}；已记录 ${intent.userMessages.length} 条用户消息、${intent.assistantQuestions.length} 个助手问题`,
    `- 已提出的研究方向：${intent.proposalSummary === null ? "（尚未提出）" : intent.proposal?.topic ?? ""}`,
    `- 用户已确认的方向：${intent.confirmedDirection === null ? "（尚未确认）" : intent.confirmedDirection.topic}`,
    `- 这份方向尚未确定的简报字段：${openFields}`,
    `- 文档：${intent.documents.length === 0 ? "（无）" : intent.documents.map((document) => document.originalFilename).join("、")}`,
    "本阶段你只能提问（ask_intent_question）或提出研究方向（propose_research_direction）；确认只能由用户在界面上完成。",
  ].join("\n");
}

export function createResearchContextBuilder(options: ResearchContextBuilderOptions): ContextBuilder {
  const basePrompt =
    options.systemPrompt === undefined || options.systemPrompt.trim() === ""
      ? RESEARCH_SYSTEM_PROMPT
      : `${RESEARCH_SYSTEM_PROMPT}\n\n${options.systemPrompt}`;

  const promptFor = (sessionId: string): string => {
    const brief = researchTaskBrief(options.service, sessionId);
    return brief === undefined ? `${basePrompt}\n\n${noTaskBrief(options.service, sessionId)}` : `${basePrompt}\n\n${brief}`;
  };

  return {
    getFixedContext(input: FixedContextInput): FixedContext {
      return createDefaultContextBuilder(promptFor(input.context.sessionId)).getFixedContext(input);
    },
    build(input: ContextBuilderInput) {
      return createDefaultContextBuilder(promptFor(input.context.sessionId)).build(input);
    },
  };
}
