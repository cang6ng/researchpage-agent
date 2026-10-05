/**
 * The Research Plugin: the product's one extension of the agent.
 *
 * The plugin has no privileges of its own and reaches nothing through the
 * PluginContext. Everything it needs — the business repository, the discovery
 * path, the reader — is handed to it by the trusted composition that built
 * those things, which is also where the tool policy that permits them lives.
 * That inversion is what keeps the agent core untouched: from the core's point
 * of view these are six ordinary tools, and whether they may run is a question
 * for the composition's policy, not for the plugin.
 */

import type { Tool } from "@every-dagent/agent-core";
import type { Plugin } from "@every-dagent/plugin-system";

import type { ResearchService } from "./service.js";
import { createResearchTools, type ResearchTools } from "./tools.js";

export interface ResearchPluginOptions {
  readonly service: ResearchService;
  /** The tool objects, when the composition built them itself (for its policy). */
  readonly tools?: ResearchTools;
}

export interface ResearchPlugin {
  readonly plugin: Plugin;
  readonly tools: ResearchTools;
}

/**
 * Builds the plugin around a research service.
 *
 * The tool set is returned alongside the plugin because a policy speaks about
 * tool *identities*: the composition must classify the same objects the plugin
 * registers, and the only reliable way to arrange that is to build them once
 * and hand them to both.
 */
export function createResearchPlugin(options: ResearchPluginOptions): ResearchPlugin {
  const tools = options.tools ?? createResearchTools(options.service);
  const plugin: Plugin = {
    manifest: {
      id: "research",
      name: "ResearchPage 研究插件",
      version: "0.1.0",
      description:
        "结构驱动的研究工具：真实检索（arXiv）、真实读取与证据、证据矩阵、缺口补查与结构化报告。" +
        "Writing a report only from really read excerpts.",
    },
    activate(context) {
      for (const tool of tools.tools) context.tools.register(tool);
    },
  };
  return { plugin, tools };
}

/** The tool set alone, for a composition that composes rather than activates. */
export function createResearchToolSet(service: ResearchService): ResearchTools {
  return createResearchTools(service);
}

export type { ResearchTools, Tool };
