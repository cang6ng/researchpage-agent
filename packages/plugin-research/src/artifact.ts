/**
 * The artifact quality contract: the twelve checks a report is held to.
 *
 * Truth-boundary validation answers "is every citation real". This module
 * answers the next question — "is this a research artifact or a summary with
 * references" — and it is deliberately built from content obligations rather
 * than from prose: the frame must be declared, the mental model must precede the
 * comparison, every promised dimension must be handled or declared missing,
 * a mechanism must actually explain a process, and the claim contract decides
 * what each statement may assert.
 *
 * Each check records what was required, how it was checked and what happened,
 * and each is either blocking (the report cannot be published) or a warning
 * (the report may ship, and the record says what is soft about it).
 */

import type {
  Evidence,
  QualityCheckRecord,
  ReportBlock,
  ReportClaim,
  ReportFrame,
  ReportSection,
  ReportTask,
  Source,
  SupportAssessment,
} from "./domain.js";
import type { BlueprintSpec, QualityRule, SectionSpec } from "./blueprint.js";
import { deriveClaimAdequacy, validateClaimContract, type ClaimContext } from "./claims.js";

export interface ArtifactDraft {
  readonly title: string;
  readonly summary: string;
  readonly frame?: ReportFrame;
  readonly sections: readonly ReportSection[];
  readonly claims: readonly ReportClaim[];
}

export interface ArtifactInput {
  readonly draft: ArtifactDraft;
  readonly task: ReportTask;
  readonly blueprint: BlueprintSpec;
  readonly evidence: readonly Evidence[];
  readonly sources: readonly Source[];
  readonly assessments: readonly SupportAssessment[];
}

export interface ArtifactVerdict {
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly checks: readonly QualityCheckRecord[];
}

/** The smallest text a block carries, for the content-minimum checks. */
function blockText(block: ReportBlock): string {
  switch (block.kind) {
    case "paragraph":
      return block.text;
    case "list":
      return block.items.map((item) => item.text).join("\n");
    case "table":
      return block.rows.map((row) => row.cells.map((cell) => cell.text).join(" | ")).join("\n");
    case "callout":
      return block.text;
    case "mechanism":
      return [block.input, block.intermediate, ...block.steps.map((step) => step.text), block.output, block.tradeoff, block.failure]
        .filter((part) => part.trim().length > 0)
        .join("\n");
  }
}

function sectionText(section: ReportSection): string {
  return section.blocks.map((block) => blockText(block)).join("\n");
}

function claimIdsOf(block: ReportBlock): readonly string[] {
  switch (block.kind) {
    case "paragraph":
      return block.claimIds;
    case "list":
      return block.items.flatMap((item) => item.claimIds);
    case "table":
      return block.rows.flatMap((row) => row.cells.flatMap((cell) => cell.claimIds));
    case "callout":
      return [];
    case "mechanism":
      return [...block.claimIds, ...block.steps.flatMap((step) => step.claimIds)];
  }
}

function sectionsById(sections: readonly ReportSection[]): Map<string, ReportSection> {
  return new Map(sections.map((section) => [section.id, section]));
}

/** The claims the document actually cites, in document order. */
function citedClaimIds(sections: readonly ReportSection[]): readonly string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const section of sections) {
    for (const block of section.blocks) {
      for (const claimId of claimIdsOf(block)) {
        if (seen.has(claimId)) continue;
        seen.add(claimId);
        ordered.push(claimId);
      }
    }
  }
  return ordered;
}

const EFFECT_PROMISE = /效果|性能|评测|基准|benchmark|准确率?|提速|效率比较|更快|表现/;
const LIMITATION_HINT = /缺|未|无法|不能|不可比|局限|限制|不足|仅|边界/;

/**
 * Runs the twelve artifact checks and the claim contract over a draft.
 *
 * Order matters only for readability of the result: the frame and structure
 * checks come first because a report missing them cannot be meaningfully judged
 * on anything else.
 */
export function validateArtifactQuality(input: ArtifactInput): ArtifactVerdict {
  const errors: string[] = [];
  const warnings: string[] = [];
  const checks: QualityCheckRecord[] = [];
  const { draft, task, blueprint } = input;
  const sections = sectionsById(draft.sections);
  const claimById = new Map(draft.claims.map((claim) => [claim.id, claim]));
  const cited = citedClaimIds(draft.sections);
  const citedClaims = cited.map((id) => claimById.get(id)).filter((claim): claim is ReportClaim => claim !== undefined);

  const frame: ReportFrame = {
    question: (draft.frame?.question ?? "").trim(),
    audience: (draft.frame?.audience ?? task.audience).trim(),
    scope: (draft.frame?.scope ?? "").trim(),
  };

  const record = (qualityRule: QualityRule, result: QualityCheckRecord["result"], detail: string): void => {
    checks.push({
      id: qualityRule.id,
      requirement: qualityRule.requirement,
      mode: qualityRule.mode,
      severity: qualityRule.severity,
      result,
      detail,
    });
  };
  const rule: (id: string) => QualityRule = (id) => {
    const found = blueprint.qualityChecks.find((candidate) => candidate.id === id);
    return found ?? { id, requirement: id, mode: "D", severity: "error" };
  };

  // ---------------------------------------------------------------- Q01 -----
  const q01 = rule("Q01");
  if (frame.question.length === 0 || frame.scope.length === 0) {
    const missing = [frame.question.length === 0 ? "Research Question" : "", frame.scope.length === 0 ? "范围（scope）" : ""]
      .filter((part) => part.length > 0)
      .join("、");
    errors.push(`Q01：报告没有声明 ${missing}。请在 save_report 的 frame 里写明研究问题与本次材料范围。`);
    record(q01, "fail", `缺少 ${missing}`);
  } else if (frame.audience.length === 0) {
    warnings.push("Q01：读者没有声明，任务卡里也没有；建议在 frame.audience 写明读者背景。");
    record(q01, "warning", "问题与范围已声明，读者缺失");
  } else {
    record(q01, "pass", `问题：${frame.question.slice(0, 60)}｜范围：${frame.scope.slice(0, 60)}｜读者：${frame.audience.slice(0, 30)}`);
  }

  // ------------------------------------------------------- Q03 / components --
  const requiredSections = blueprint.sections.filter((section) => section.required);
  const missingSections: SectionSpec[] = [];
  const shallowSections: string[] = [];
  for (const spec of requiredSections) {
    const section = sections.get(spec.id);
    if (section === undefined || sectionText(section).trim().length === 0) {
      missingSections.push(spec);
      continue;
    }
    const verdict = checkSectionObligation(spec, section, claimById);
    if (verdict.problem !== undefined) shallowSections.push(verdict.problem);
    warnings.push(...verdict.warnings);
  }
  const q03 = rule("Q03");
  if (missingSections.length > 0) {
    errors.push(
      `Q03：报告缺少必需章节：${missingSections.map((section) => `${section.id}（${section.title}）`).join("、")}。每个章节是一种认知责任，不能只靠其他章节覆盖。`,
    );
    record(q03, "fail", `缺少 ${missingSections.map((section) => section.id).join("、")}`);
  } else if (shallowSections.length > 0) {
    errors.push(...shallowSections.map((problem) => `Q03：${problem}`));
    record(q03, "fail", shallowSections.join("；"));
  } else {
    record(q03, "pass", `${requiredSections.length} 个必需章节均满足各自的内容契约`);
  }

  // ---------------------------------------------------------------- Q04 -----
  const q04 = rule("Q04");
  const mentalModel = sections.get("mental-model");
  const comparison = sections.get("comparison");
  if (mentalModel === undefined) {
    errors.push("Q04：Technical Comparison v2 必须先建立 mental model（概念坐标）再进入详细比较；本报告没有该章节。");
    record(q04, "fail", "缺少概念坐标章节");
  } else if (comparison !== undefined && draft.sections.findIndex((section) => section.id === "mental-model") > draft.sections.findIndex((section) => section.id === "comparison")) {
    errors.push("Q04：概念坐标出现在比较之后；读者会在没有坐标系的情况下读到 A/B/C 的细节。");
    record(q04, "fail", "章节顺序颠倒");
  } else {
    record(q04, "pass", "概念坐标在详细比较之前");
  }

  // ------------------------------------------------------- Q05 / comparison --
  const q05 = rule("Q05");
  const dimensionById = new Map(task.dimensions.map((dimension) => [dimension.id, dimension]));
  const subjectIds = new Set(task.subjects.map((subject) => subject.id));
  const comparisonTable = comparison?.blocks.find((block) => block.kind === "table");
  const mappedDimensions = new Set<string>();
  const unmappedColumns: string[] = [];
  if (comparisonTable === undefined) {
    errors.push("Q05：比较章节没有比较表；条件化比较需要一张声明了列维度与行对象的表。");
    record(q05, "fail", "没有比较表");
  } else if (comparisonTable.kind === "table") {
    const mappings = comparisonTable.columnDimensions ?? [];
    if (mappings.length === 0) {
      errors.push("Q05：比较表没有声明每列对应的研究维度（columnDimensions），无法证明每列回答的是同一个问题。");
      record(q05, "fail", "缺少列维度声明");
    } else {
      mappings.forEach((dimensionId, index) => {
        if (dimensionId === null || dimensionId === undefined) return;
        const dimension = dimensionById.get(dimensionId);
        if (dimension === undefined) {
          unmappedColumns.push(`${comparisonTable.columns[index] ?? `第 ${index + 1} 列`}→${dimensionId}`);
          return;
        }
        mappedDimensions.add(dimensionId);
      });
      if (unmappedColumns.length > 0) {
        errors.push(`Q05：比较表列维度指向不存在的维度：${unmappedColumns.join("、")}。`);
        record(q05, "fail", `未知维度：${unmappedColumns.join("、")}`);
      } else {
        record(q05, "pass", `${mappedDimensions.size} 个列维度均有统一的问题定义`);
      }
    }
    const rowSubjects = comparisonTable.rowSubjects ?? [];
    if (rowSubjects.filter((id): id is string => typeof id === "string").length < 2) {
      warnings.push("Q05：比较表没有声明每行对应的对象（rowSubjects），读者只能从文字推测行身份。");
    }
    const unknownRows = rowSubjects.filter((id): id is string => typeof id === "string" && !subjectIds.has(id));
    if (unknownRows.length > 0) {
      warnings.push(`Q05：比较表的行对象不在本次任务的对象列表中：${unknownRows.join("、")}。`);
    }
  }

  // ---------------------------------------------------------------- Q06 -----
  const q06 = rule("Q06");
  const declaredGapDimensions = new Set<string>();
  for (const section of draft.sections) {
    for (const block of section.blocks) {
      if (block.kind === "callout") {
        for (const dimensionId of block.dimensionIds ?? []) declaredGapDimensions.add(dimensionId);
      }
      if (block.kind === "table") {
        for (const dimensionId of block.columnDimensions ?? []) {
          if (dimensionId !== null && dimensionId !== undefined) mappedDimensions.add(dimensionId);
        }
      }
    }
  }
  for (const claim of citedClaims) {
    for (const dimensionId of claim.dimensions ?? []) mappedDimensions.add(dimensionId);
  }
  const silentDimensions = task.dimensions.filter(
    (dimension) => !mappedDimensions.has(dimension.id) && !declaredGapDimensions.has(dimension.id),
  );
  if (silentDimensions.length > 0) {
    errors.push(
      `Q06：研究维度被静默省略：${silentDimensions
        .map((dimension) => dimension.name)
        .join("、")}。每个维度必须在正文被处理，或用一个写明原因的缺口说明（callout dimensionIds）声明。`,
    );
    record(q06, "fail", `未处理：${silentDimensions.map((dimension) => dimension.name).join("、")}`);
  } else {
    record(q06, "pass", `${task.dimensions.length} 个研究维度均有正文处理或明确的缺口声明`);
  }

  // -------------------------------------------- Q07-Q10: claim contract -----
  const context: ClaimContext = {
    evidence: input.evidence,
    sources: input.sources,
    assessments: input.assessments,
    subjectNames: new Map(task.subjects.map((subject) => [subject.id, subject.name])),
  };
  const contractErrorsByCheck = new Map<string, string[]>();
  const contractWarningsByCheck = new Map<string, string[]>();
  const checkIdForClaimType: Readonly<Record<string, string>> = Object.freeze({
    mechanism: "Q03",
    comparison: "Q07",
    performance: "Q08",
    cost: "Q08",
    synthesis: "Q09",
    implication: "Q09",
    fact: "Q09",
  });
  const adequacyCounts = new Map<string, number>();
  for (const claim of citedClaims) {
    const verdict = validateClaimContract(claim, context);
    const checkId = checkIdForClaimType[claim.claimType ?? "fact"] ?? "Q09";
    if (verdict.errors.length > 0) {
      const list = contractErrorsByCheck.get(checkId) ?? [];
      // Each message names the rule it failed, so a model reading the refusal
      // can see which contract it is being held to.
      list.push(...verdict.errors.map((message) => `${checkId}：${message}`));
      contractErrorsByCheck.set(checkId, list);
    }
    if (verdict.warnings.length > 0) {
      const list = contractWarningsByCheck.get(checkId) ?? [];
      list.push(...verdict.warnings.map((message) => `${checkId}：${message}`));
      contractWarningsByCheck.set(checkId, list);
      warnings.push(...verdict.warnings.map((message) => `${checkId}：${message}`));
    }

    const adequacy = deriveClaimAdequacy(claim, context);
    adequacyCounts.set(adequacy.state, (adequacyCounts.get(adequacy.state) ?? 0) + 1);
    if (adequacy.state === "missing") {
      const list = contractErrorsByCheck.get("Q09") ?? [];
      list.push(`Q09：claim ${claim.id} 没有任何可解析的证据（主要论断必须有依据，或明确标为 synthesis 并绑定输入）。`);
      contractErrorsByCheck.set("Q09", list);
    }
    if (adequacy.state === "conflicted" || adequacy.state === "incomparable") {
      warnings.push(`claim ${claim.id} 的评估状态是「${adequacy.state}」：正文必须并置冲突或说明不可比，不能给出统一判断（${adequacy.reasons.join("；")}）。`);
    }
  }
  for (const [checkId, messages] of contractErrorsByCheck) {
    errors.push(...messages);
    record(rule(checkId), "fail", messages.slice(0, 3).join("；"));
  }
  for (const checkId of ["Q07", "Q08", "Q09"]) {
    if (contractErrorsByCheck.has(checkId)) continue;
    const soft = contractWarningsByCheck.get(checkId) ?? [];
    record(rule(checkId), soft.length > 0 ? "warning" : "pass", soft.length > 0 ? soft.slice(0, 2).join("；") : "论断contract满足");
  }

  // ---------------------------------------------------------------- Q10 -----
  const q10 = rule("Q10");
  const synthesisClaims = citedClaims.filter((claim) => (claim.claimType ?? "fact") === "synthesis");
  const synthesisSection = sections.get("synthesis");
  if (synthesisClaims.length === 0) {
    warnings.push("Q10：报告没有显式的综合判断（synthesis）：跨来源形成的判断才是这份成果超过逐篇摘要的地方。");
    record(q10, "warning", "没有综合判断");
  } else if (synthesisSection === undefined || synthesisClaims.every((claim) => !sectionCites(synthesisSection, claim.id))) {
    warnings.push("Q10：综合判断没有出现在「综合判断与权衡」章节；请把跨来源结论放到它自己的位置。");
    record(q10, "warning", "综合判断不在综合章节");
  } else {
    record(q10, "pass", `${synthesisClaims.length} 条综合判断显式标注并绑定多个来源`);
  }

  // ---------------------------------------------------------------- Q11 -----
  const q11 = rule("Q11");
  const softClaims = citedClaims.filter((claim) => {
    const state = deriveClaimAdequacy(claim, context).state;
    return state !== "adequate";
  });
  const surfacedSomewhere = draft.sections
    .filter((section) => ["overview", "comparison", "limitations", "synthesis"].includes(section.id))
    .some((section) => section.blocks.some((block) => block.kind === "callout" || (block.kind === "paragraph" && LIMITATION_HINT.test(block.text))));
  if (softClaims.length > 0 && !surfacedSomewhere) {
    warnings.push("Q11：仍有未达到充分支持的判断，但正文没有在判断附近写出限制；不要只把未知放在附录或缺口清单里。");
    record(q11, "warning", `${softClaims.length} 条判断的支持状态低于充分，正文未声明限制`);
  } else {
    record(q11, "pass", softClaims.length === 0 ? "没有低于充分支持的判断" : `已在正文写出限制（${softClaims.length} 条判断的支持状态低于充分）`);
  }

  // ---------------------------------------------------------------- Q02 -----
  const q02 = rule("Q02");
  const titleAndSummary = `${draft.title}\n${draft.summary}`;
  const promisesEffect = EFFECT_PROMISE.test(draft.title) || EFFECT_PROMISE.test(draft.summary);
  const effectClaims = citedClaims.filter((claim) => {
    const type = claim.claimType ?? "fact";
    if (type !== "performance" && type !== "comparison") return false;
    return deriveClaimAdequacy(claim, context).state !== "missing";
  });
  const subjectNamesMissingFromEvidence = task.subjects.filter((subject) => {
    if (!titleAndSummary.includes(subject.name)) return false;
    return !input.evidence.some((item) => item.cells.some((cell) => cell.subjectId === subject.id));
  });
  if (promisesEffect && effectClaims.length === 0) {
    warnings.push(
      "Q02：标题/摘要承诺了效果或性能比较，但报告没有可比较的效果论断。请收窄标题与摘要的承诺，或在正文明确写出证据不足。",
    );
    record(q02, "warning", "标题承诺效果比较，正文没有对应论断");
  } else if (subjectNamesMissingFromEvidence.length > 0) {
    warnings.push(
      `Q02：标题/摘要提到 ${subjectNamesMissingFromEvidence.map((subject) => subject.name).join("、")}，但报告没有这些对象的证据。`,
    );
    record(q02, "warning", "标题涉及无证据对象");
  } else {
    record(q02, "pass", "标题与摘要的承诺在证据范围内");
  }

  // ---------------------------------------------------------------- Q12 -----
  record(
    rule("Q12"),
    "pass",
    "默认投影由渲染器固定为紧凑核验索引（编号/来源/定位/读取范围），完整片段只在工作台核验视图中出现（渲染测试覆盖）",
  );

  return { errors, warnings, checks };
}

/** Whether a section cites a given claim. */
function sectionCites(section: ReportSection, claimId: string): boolean {
  return section.blocks.some((block) => claimIdsOf(block).includes(claimId));
}

/**
 * Whether a section's content meets the obligation its blueprint assigns it.
 *
 * These are the checks that make "有标题无解释" detectable: a section is not
 * complete because it exists, and a mechanism is not explained because the
 * paragraph says the word "机制".
 */
function checkSectionObligation(
  spec: SectionSpec,
  section: ReportSection,
  claimById: ReadonlyMap<string, ReportClaim>,
): { readonly problem?: string; readonly warnings: readonly string[] } {
  const warnings: string[] = [];
  const text = sectionText(section);
  const cites = section.blocks.flatMap((block) => claimIdsOf(block));
  const citedClaims = cites.map((id) => claimById.get(id)).filter((claim): claim is ReportClaim => claim !== undefined);

  switch (spec.id) {
    case "overview": {
      if (text.trim().length < 40) return { problem: `章节「${spec.title}」内容过少，没有形成定向（问题、关键认识与边界）`, warnings };
      if (citedClaims.length === 0) return { problem: `章节「${spec.title}」的关键认识没有任何论断绑定证据`, warnings };
      return { warnings };
    }
    case "mental-model": {
      const items = section.blocks.flatMap((block) => (block.kind === "list" ? block.items : []));
      if (text.trim().length < 80 && items.length < 2) {
        return { problem: `章节「${spec.title}」还没有建立概念坐标（内容过少）`, warnings };
      }
      if (citedClaims.length === 0) {
        return { problem: `章节「${spec.title}」的分类与术语没有任何依据绑定`, warnings };
      }
      const unauthorized = citedClaims.filter((claim) => (claim.claimType ?? "fact") === "fact" && claim.synthesis !== true && claim.evidenceIds.length === 0);
      if (unauthorized.length > 0) {
        return { problem: `章节「${spec.title}」存在没有依据的概念陈述`, warnings };
      }
      return { warnings };
    }
    case "mechanism": {
      const mechanisms = section.blocks.filter((block) => block.kind === "mechanism");
      if (mechanisms.length === 0) {
        return { problem: `章节「${spec.title}」没有结构化机制块：把输入、中间产物、步骤、输出、权衡与失效条件写成一个机制块`, warnings };
      }
      const block = mechanisms[0];
      if (block?.kind !== "mechanism") return { warnings };
      const missing: string[] = [];
      if (block.input.trim().length === 0) missing.push("input（输入）");
      if (block.intermediate.trim().length === 0) missing.push("intermediate（中间产物）");
      if (block.steps.filter((step) => step.text.trim().length > 0).length < 2) missing.push("steps（至少两个步骤）");
      if (block.output.trim().length === 0) missing.push("output（输出）");
      if (missing.length > 0) {
        return { problem: `章节「${spec.title}」的机制块没有解释完整过程，缺：${missing.join("、")}`, warnings };
      }
      const mechanismClaims = [...block.claimIds, ...block.steps.flatMap((step) => step.claimIds)];
      if (mechanismClaims.length === 0) {
        return { problem: `章节「${spec.title}」的机制说明没有绑定任何证据`, warnings };
      }
      if (block.tradeoff.trim().length === 0) warnings.push("Q03：机制块没有写代价/权衡（为什么这样设计、付出了什么）。");
      if (block.failure.trim().length === 0) warnings.push("Q03：机制块没有写失效条件（什么情况下会失败）。");
      return { warnings };
    }
    case "comparison": {
      // A conditional comparison needs its shared frame: a table that declares
      // its columns and rows. Which claims support its cells is the claim
      // contract's business (Q07), not this section's.
      const hasTable = section.blocks.some((block) => block.kind === "table" && block.rows.length > 0);
      if (!hasTable) {
        return { problem: `章节「${spec.title}」没有比较表：共同维度下的比较需要一张声明了列维度与行对象的表`, warnings };
      }
      return { warnings };
    }
    case "synthesis": {
      if (!citedClaims.some((claim) => (claim.claimType ?? "fact") === "synthesis")) {
        return { problem: `章节「${spec.title}」没有综合判断（synthesis）：这一节要形成跨来源的新的有界判断`, warnings };
      }
      return { warnings };
    }
    case "limitations": {
      if (text.trim().length < 40) return { problem: `章节「${spec.title}」过于笼统：需要分型写出缺什么证据、影响哪个判断、下一步验证什么`, warnings };
      return { warnings };
    }
    default:
      return { warnings };
  }
}
