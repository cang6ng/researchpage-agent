/**
 * What the research agent is told, and what this session's task brief adds.
 *
 * The system prompt is the product's protocol: the order of work, the truth
 * rules (a search hit is not evidence, an excerpt is saved text, a gap is
 * written as a gap), and the budget behaviour. The per-session brief is the
 * *state* — which task, which cells are still missing, how much budget is left
 * — read from the business database at build time so a long run can always tell
 * where it is without the whole corpus in context.
 */

import type { ResearchService } from "./service.js";

export const RESEARCH_SYSTEM_PROMPT = `你是 ResearchPage 的研究助手：把模糊的研究主题变成可执行的研究结构，围绕证据缺口主动补查，产出关键结论可以回到实际来源片段的中文研究报告。

工作顺序（严格遵守）：
1. 用户给出主题后，先调用 propose_task 建立任务卡（比较对象 2–4 个、研究维度 3–6 个）。任务卡未确认前不要检索。
2. 确认后，用 search_sources 检索真实候选（英文技术关键词）。搜索结果只是 metadata 候选，不是证据，绝不能据此下结论。
3. 用 read_source 逐个真实读取候选。只有 read_source 返回的 evidenceId 才能引用。读取范围会如实记录：full_text/body_excerpt 是正文级，abstract 是摘要级。
4. 读取若干来源后调用 assess_coverage，提交每个单元格的支持理由，并查看仍缺少依据的格子。
5. 对最重要的缺口做定向补查（gapRound=true），最多两轮；每轮只处理少数关键缺口。补查后重新 assess_coverage。
6. 最后调用 save_report 提交结构化报告。报告是数据，不是 HTML：sections + blocks（paragraph/list/table/callout）+ claims，每个 block 用 claimIds 关联 claim，每条 claim 用 evidenceIds 关联真实证据。
   单次输出预算有限（约 4096 tokens）：长报告请分次提交 —— 先 part="start"（title/summary），再 part="write"（claims），然后每节一次 part="write"（section），最后 part="finalize" 校验发布。

真实性要求：
- 只使用工具返回的 id（sourceId / evidenceId）。不要编造 id、页码、引用或结论。
- 关键事实、数字、方法比较结论必须有 evidence；综合推断用 kind="inference" 并绑定推断依据；过渡句可以不带引用。
- 没有找到依据的比较项，写成明确缺失（callout tone="gap"），不要用常识填空。
- 不同数据/设置/硬件下的数字不能直接排名；无法比较就直接说明。
- 明确区分「作者报告的结果」与「你的判断」。

预算行为：搜索、读取、补查轮次都有上限。工具拒绝时要接受拒绝：改用已有材料评估覆盖，并生成诚实报告（写明缺口），不要改预算、不要重复无效调用。

语言：报告、章节、表格与说明一律使用中文；论文标题、方法名与术语保留原文。`;

/**
 * The brief one session's task adds to the fixed context.
 *
 * It is bounded on purpose: counts and ids rather than text, so the model knows
 * what exists and asks for the parts it needs. `undefined` means this session
 * has no research task yet — which is itself information the prompt tells the
 * model how to act on.
 */
export function researchTaskBrief(service: ResearchService, sessionId: string, maxChars = 2_600): string | undefined {
  const task = service.taskForSession(sessionId);
  if (task === undefined) return undefined;

  const state = service.state(task.id);
  const lines: string[] = [];
  lines.push("【当前研究任务】");
  lines.push(`任务卡：${state.task.topic}｜用途：${state.task.purpose || "未填写"}｜读者：${state.task.audience || "未填写"}`);
  if (state.task.focus.length > 0) lines.push(`关注点：${state.task.focus.join("、")}`);
  lines.push(`确认状态：${state.task.confirmed ? "已确认（可以检索）" : "未确认（等待用户在界面确认；确认前不要调用检索工具）"}`);
  lines.push(`比较对象：${state.subjects.map((subject) => `${subject.name}(${subject.id})`).join("、") || "（无）"}`);
  lines.push(`研究维度：${state.dimensions.map((dimension) => `${dimension.name}(${dimension.id})`).join("、") || "（无）"}`);
  lines.push(`报告结构章节：${state.structure.map((section) => `${section.id}=${section.title}`).join("；")}`);

  const counts = { sufficient: 0, partial: 0, missing: 0 };
  for (const cell of state.cells) counts[cell.status === "evaluating" ? "missing" : cell.status] += 1;
  lines.push(
    `矩阵覆盖：sufficient ${counts.sufficient} / partial ${counts.partial} / missing ${counts.missing}（共 ${state.cells.length} 格）`,
  );
  const gaps = state.cells.filter((cell) => cell.status !== "sufficient").slice(0, 8);
  if (gaps.length > 0) {
    lines.push(
      `待补缺口（示例）：${gaps
        .map((cell) => `${cell.subjectName}×${cell.dimensionName}[${cell.status}]`)
        .join("；")}`,
    );
  }

  lines.push(
    `来源：已登记 ${state.sources.length} 个（已读 ${state.sources.filter((source) => source.readStatus === "ok").length} 个；读取失败 ${
      state.sources.filter((source) => source.readStatus === "failed").length
    } 个）`,
  );
  lines.push(`证据：${state.evidence.length} 条可引用片段（按 evidenceId 引用）`);
  lines.push(
    `预算：搜索 ${state.usage.searches}/${state.budget.maxSearches}，读取 ${state.usage.reads}/${state.budget.maxReads}，补查轮 ${state.usage.gapRounds}/${state.budget.maxGapRounds}`,
  );
  if (state.currentReportId !== null) lines.push(`已保存报告：${state.currentReportId}（如需修订可重新 save_report）`);

  const text = lines.join("\n");
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}
