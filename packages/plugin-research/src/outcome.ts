/**
 * What a user action resolved, said in the reader's words.
 *
 * Two results reach a user, and both used to be reported as activity. A
 * research action answered「找到了 2 个来源」 when the honest answer was「没有
 * 找到满足条件的官方说明」— the count of what was fetched is not an answer to
 * the question that was asked. An Edit answered nothing at all until the user
 * pressed accept, at which point the validator refused the change it had just
 * been offered.
 *
 * This module derives both answers from what the product really knows: the
 * resolution comes from the coverage of the cells the action's own material
 * landed on, and the Edit's refusal comes from the validation problems the
 * candidate report failed — translated into sentences that name the kind of
 * content that was lost without printing a check id, a contract name or a hash.
 */

import type {
  ActionDelta,
  CellRef,
  CellStatus,
  Evidence,
  ResearchGapNote,
  ResearchResolution,
  ResearchResolutionStatus,
  Source,
  SourceRole,
  SupportAssessment,
} from "./domain.js";

/** The part of a matrix cell a resolution reads: a position and its live verdict. */
export interface ResolutionCell extends CellRef {
  readonly status: CellStatus;
  readonly reason: string;
  readonly gap: string;
}

/** How a source's role is said when a result counts what an action brought in. */
const ROLE_WORDS: Readonly<Record<SourceRole, string>> = Object.freeze({
  primary: "一手材料",
  official: "官方文档",
  "independent-evaluation": "独立评测",
  survey: "综述",
  contextual: "背景材料",
  "user-provided": "用户提供的材料",
});

/** Sources nobody classified are counted as unclassified, never as anything else. */
const UNCLASSIFIED_WORD = "未标注类型的来源";

function cellKey(cell: CellRef): string {
  return `${cell.sectionId}|${cell.subjectId}|${cell.dimensionId}`;
}

function sameRef(a: CellRef, b: CellRef): boolean {
  return a.sectionId === b.sectionId && a.subjectId === b.subjectId && a.dimensionId === b.dimensionId;
}

/** One line naming the material an action really added, or nothing when it added none. */
export function newMaterialSentence(sources: readonly Source[]): string {
  if (sources.length === 0) return "本轮没有新增来源。";
  const counts = new Map<string, number>();
  for (const source of sources) {
    const word = source.role === undefined || source.role === null ? UNCLASSIFIED_WORD : ROLE_WORDS[source.role];
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(([word, count]) => `${String(count)} 篇${word}`);
  return `本轮新增 ${parts.join("、")}。`;
}

/** What a resolution status means, in one word. */
export const RESOLUTION_LABELS: Readonly<Record<ResearchResolutionStatus, string>> = Object.freeze({
  resolved: "已解决",
  partially_resolved: "部分解决",
  unresolved: "未解决",
});

export interface ResolutionInput {
  readonly question: string;
  readonly delta: ActionDelta;
  readonly sources: readonly Source[];
  readonly evidence: readonly Evidence[];
  readonly assessments: readonly SupportAssessment[];
  /** The live matrix: coverage re-derived from material, never a stored claim. */
  readonly cells: readonly ResolutionCell[];
  readonly subjectNames: ReadonlyMap<string, string>;
  readonly dimensionNames: ReadonlyMap<string, string>;
  /** Whether there is a report whose text this action left alone. */
  readonly hasReport: boolean;
}

/**
 * Whether the question was resolved, derived from the cells the action touched.
 *
 * The unit is the cell, because a cell is what this product means by "a target
 * of this question" — a subject crossed with a research dimension. The action's
 * own evidence and judgements decide which cells are in scope, and the live
 * coverage of those cells decides the answer:
 *
 * - every scoped cell is `reviewed` (direct, body-level, supportive) → resolved;
 * - some are, some are not → partially resolved;
 * - none are, or nothing landed on a cell at all → unresolved.
 *
 * Contextual background material therefore resolves nothing by construction:
 * it can be saved, assessed and cited without ever reaching `reviewed`. No
 * percentage is produced, and no count of fetches is allowed to stand in for
 * an answer.
 */
export function deriveResearchResolution(input: ResolutionInput): ResearchResolution {
  const newSources = input.sources.filter((source) => input.delta.newSourceIds.includes(source.id));
  const newEvidence = input.evidence.filter((item) => input.delta.newEvidenceIds.includes(item.id));
  const newAssessments = input.assessments.filter((item) => input.delta.newAssessmentIds.includes(item.id));

  const supportingEvidenceIds = [
    ...new Set(
      newAssessments.filter((entry) => entry.relationship === "supports").flatMap((entry) => entry.evidenceIds),
    ),
  ];

  // The cells this action's material was bound to: where its evidence was
  // collected and where its judgements were recorded. An action that touched no
  // cell has resolved nothing, however much it fetched.
  const scoped: CellRef[] = [];
  for (const item of newEvidence) {
    for (const cell of item.cells) if (!scoped.some((ref) => sameRef(ref, cell))) scoped.push(cell);
  }
  for (const entry of newAssessments) {
    if (!scoped.some((ref) => sameRef(ref, entry.target))) scoped.push(entry.target);
  }
  const byKey = new Map(input.cells.map((cell) => [cellKey(cell), cell]));
  const scopedCells = scoped.flatMap((ref) => {
    const cell = byKey.get(cellKey(ref));
    return cell === undefined ? [] : [cell];
  });

  const nameOfCell = (cell: ResolutionCell): string =>
    `${input.subjectNames.get(cell.subjectId) ?? cell.subjectId} × ${input.dimensionNames.get(cell.dimensionId) ?? cell.dimensionId}`;
  const reviewed = scopedCells.filter((cell) => cell.status === "reviewed");
  const open = scopedCells.filter((cell) => cell.status !== "reviewed");
  const remainingGap: ResearchGapNote[] = open.map((cell) => ({
    subjectName: input.subjectNames.get(cell.subjectId) ?? cell.subjectId,
    dimensionName: input.dimensionNames.get(cell.dimensionId) ?? cell.dimensionId,
    status: cell.status,
    reason: cell.gap.trim().length > 0 ? cell.gap : cell.reason,
  }));

  const status: ResearchResolutionStatus =
    scopedCells.length === 0
      ? "unresolved"
      : reviewed.length === scopedCells.length
        ? "resolved"
        : reviewed.length > 0
          ? "partially_resolved"
          : "unresolved";

  const material = newMaterialSentence(newSources);
  const reportNote = input.hasReport ? "报告正文没有改变。" : "";
  const coveredNames = reviewed.map(nameOfCell);
  const gapNames = remainingGap.map((note) => `${note.subjectName} × ${note.dimensionName}`);
  const summary =
    status === "resolved"
      ? [`这一轮已经解决：${coveredNames.join("、")} 现在有直接支持这一问题的材料。`, material, reportNote]
          .filter((part) => part.length > 0)
          .join("")
      : status === "partially_resolved"
        ? [
            `部分解决：${coveredNames.join("、")} 有了直接依据；仍然缺少：${gapNames.join("、")}。`,
            material,
            reportNote,
          ]
            .filter((part) => part.length > 0)
            .join("")
        : [
            scopedCells.length === 0
              ? "没有找到能直接回答这一问题的材料。"
              : `没有找到能直接回答这一问题的材料：${gapNames.join("、")} 仍然只有背景或间接材料。`,
            material,
            reportNote,
          ]
            .filter((part) => part.length > 0)
            .join("");

  return {
    status,
    question: input.question,
    newSourceIds: newSources.map((source) => source.id),
    newEvidenceIds: newEvidence.map((item) => item.id),
    newAssessmentIds: newAssessments.map((item) => item.id),
    supportingEvidenceIds,
    targetCells: scopedCells.map((cell) => ({
      sectionId: cell.sectionId,
      subjectId: cell.subjectId,
      dimensionId: cell.dimensionId,
    })),
    remainingGap,
    summary,
  };
}

/**
 * Which kind of content a failed candidate lost, in the user's words.
 *
 * This is the one place the validator's vocabulary is translated. The patterns
 * are deliberately few and each names a *kind of content*, not a rule: a user
 * who asked for plain prose and is told「丢了这一节必须保留的综合判断」 can
 * try a different wording, while「Q03」 tells them nothing they can act on.
 */
const LOST_CONTENT: readonly { readonly test: RegExp; readonly says: string }[] = Object.freeze([
  { test: /没有综合判断|缺少综合判断/, says: "综合判断（这一节要形成跨来源的、有边界的判断）" },
  { test: /机制块|机制/, says: "机制说明（输入、过程与输出要写成一个完整的机制）" },
  { test: /没有比较表|比较表/, says: "比较表（共同维度下的比较需要一张表）" },
  { test: /空白单元格|空单元格|没有写判断/, says: "比较表里的判断（空白单元格不会被接受：每一格都要写出判断，或写明证据不足）" },
  { test: /可比性/, says: "可比性说明（不可比时要写明不可比）" },
  { test: /概念坐标|mental model|分类与术语/, says: "概念坐标（术语与分类要先于细节）" },
  { test: /内容过少|过于笼统|没有形成定向/, says: "这一节应有的内容深度" },
  { test: /没有依据|没有任何 evidence|缺乏依据|证据/, says: "每一句判断的依据" },
  { test: /维度被静默省略|未处理/, says: "研究维度（每个维度要么回答，要么写明缺证据）" },
  { test: /frame|研究问题|范围/, says: "报告自己声明的范围" },
]);

/**
 * Why a proposal was not created, said to the user rather than to the model.
 *
 * The technical problems are returned to the model in the tool result, where a
 * refusal has to name what to fix. What reaches the reader is this sentence:
 * it says the改写 was not submitted, that the report is untouched, and that a
 * different wording can be tried — and it never names a check id, an internal
 * claim type or a hash.
 */
export function proposalFailureCopy(problems: readonly string[]): string {
  const seen = new Set<string>();
  const reasons: string[] = [];
  for (const problem of problems) {
    for (const rule of LOST_CONTENT) {
      if (!rule.test.test(problem)) continue;
      if (seen.has(rule.says)) break;
      seen.add(rule.says);
      reasons.push(rule.says);
      break;
    }
  }
  const lost =
    reasons.length === 0
      ? "这一节必须保留的内容义务"
      : reasons.length === 1
        ? reasons[0]
        : `${reasons.slice(0, 3).join("、")}${reasons.length > 3 ? " 等" : ""}`;
  return `我准备的改写丢失了这一节必须保留的${lost}，因此没有提交为修改建议。报告正文没有改变。可以换一种写法重新尝试。`;
}

/** The same refusal, before the one repair chance was spent. */
export function proposalRepairCopy(problems: readonly string[]): string {
  return `${proposalFailureCopy(problems)}（这是这次动作唯一一次修正机会。）`;
}

/** A cell's state, said the way the comparison's cells say it. */
export const CELL_STATE_WORDS: Readonly<Record<CellStatus, string>> = Object.freeze({
  missing: "证据不足",
  unassessed: "有材料，待核对",
  limited: "有限支持",
  conflict: "冲突 / 不可比",
  reviewed: "已核对",
});
