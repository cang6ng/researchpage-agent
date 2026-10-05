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

export function createResearchContextBuilder(options: ResearchContextBuilderOptions): ContextBuilder {
  const basePrompt =
    options.systemPrompt === undefined || options.systemPrompt.trim() === ""
      ? RESEARCH_SYSTEM_PROMPT
      : `${RESEARCH_SYSTEM_PROMPT}\n\n${options.systemPrompt}`;

  const promptFor = (sessionId: string): string => {
    const brief = researchTaskBrief(options.service, sessionId);
    return brief === undefined
      ? `${basePrompt}\n\n【当前研究任务】本会话还没有研究任务：如果用户给出主题，先调用 propose_task 建立任务卡。`
      : `${basePrompt}\n\n${brief}`;
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
