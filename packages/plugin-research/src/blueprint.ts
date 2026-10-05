/**
 * The blueprint: what a report must be, before it is written.
 *
 * A blueprint is not a template and not a prompt. It is the executable spec of
 * one research artifact — the cognitive journey it takes a reader through, the
 * sections that carry each step and the questions each section owes an answer
 * to, the claim contract its statements are judged by, and the quality checks a
 * finished report is measured against. The structure the task card shows, the
 * sections the model is asked to write, the obligations the validator enforces
 * and the order the report is assembled in all come from this one object.
 *
 * `technical-comparison-v1` was a list of section titles plus prose. This is
 * the version that can answer "did the report build a mental model, explain a
 * mechanism, compare under shared conditions, synthesise, and say what it does
 * not know" — because each of those is a named obligation here rather than an
 * adjective in an instruction.
 */

import type { ClaimType, Dimension, ResearchSection } from "./domain.js";

/** The blueprint id the current structure implements. */
export const BLUEPRINT_ID_V2 = "technical-comparison-v2";
/** The id a card written before blueprints existed is read under. */
export const BLUEPRINT_ID_V1 = "technical-comparison-v1";

/**
 * How much cognitive work a section has to do.
 *
 * These are the depth model's levels, used by the generator as an instruction
 * and by the validator as a floor. They are deliberately not shown to readers
 * as badges: a reader should be able to tell an explanation from a summary by
 * reading it.
 */
export type DepthLevel = "summary" | "explanation" | "analysis" | "synthesis";

/** The six cognitive components a technical comparison must be able to produce. */
export type CognitiveComponent =
  | "question-takeaways"
  | "mental-model"
  | "mechanism"
  | "comparison"
  | "evidence-judgment"
  | "implications-gaps";

export interface SectionSpec extends ResearchSection {
  readonly cognitivePurpose: string;
  /** What this section must actually answer; the generator works from these. */
  readonly requiredQuestions: readonly string[];
  readonly depth: DepthLevel;
  readonly component: CognitiveComponent;
  /** Whether a report may be published without this section. */
  readonly required: boolean;
  /** How much content this section is expected to carry, as guidance. */
  readonly budget: string;
}

export interface ClaimRequirement {
  readonly claimType: ClaimType;
  /** What must be true for a claim of this type to be allowed to stand. */
  readonly requires: string;
  /** Phrasings that remain available when the requirement is not met. */
  readonly allowed: string;
  /** What is refused outright. */
  readonly refused: string;
}

export interface QualityRule {
  readonly id: string;
  readonly requirement: string;
  readonly mode: "D" | "A" | "D+A" | "A+H" | "D+H";
  readonly severity: "error" | "warning";
}

export interface BlueprintSpec {
  readonly id: string;
  readonly name: string;
  readonly purpose: string;
  readonly idealIntent: string;
  readonly cognitiveJourney: readonly { readonly stage: string; readonly question: string; readonly responsibility: string }[];
  readonly requiredQuestions: readonly string[];
  readonly requiredComponents: readonly CognitiveComponent[];
  readonly optionalComponents: readonly string[];
  /** Candidate dimensions a card may draw on; not a fixed column set. */
  readonly comparisonDimensions: readonly Dimension[];
  /**
   * The floor a Brief draft has to meet before research may start.
   *
   * A brief is the user's to edit, but not to edit into something this
   * blueprint cannot honour: below these counts the report validator would
   * either have no comparison to check or would be checking a structure that
   * no longer claims anything. One subject is the floor rather than two,
   * because a single-object study is a real (if unusual) request; three
   * dimensions is the floor because that is the point below which "compare
   * across shared questions" stops being what the document does.
   */
  readonly briefMinimums: { readonly subjects: number; readonly dimensions: number };
  /** What this blueprint normally wants, for the guide and the workspace. */
  readonly briefRecommended: { readonly subjects: readonly [number, number]; readonly dimensions: readonly [number, number] };
  readonly claimRequirements: readonly ClaimRequirement[];
  readonly comparisonRules: readonly string[];
  readonly evidenceRules: readonly string[];
  readonly qualityChecks: readonly QualityRule[];
  readonly sections: readonly SectionSpec[];
  readonly whenNotToUse: string;
}

const JOURNEY = Object.freeze([
  {
    stage: "定向",
    question: "我为什么读？本文回答什么，不回答什么？",
    responsibility: "研究问题、读者、范围、结论预览与关键限制",
  },
  {
    stage: "建模",
    question: "有哪些基本对象？它们怎样关联？",
    responsibility: "必要术语、最小例子、分类轴或问题分解",
  },
  {
    stage: "解释",
    question: "它如何工作？为什么这样设计？代价是什么？",
    responsibility: "输入、中间产物、过程、输出、trade-off 与失效条件",
  },
  {
    stage: "有条件地比较",
    question: "我该从什么角度看差异？条件是否可比？",
    responsibility: "共同问题、维度定义、各对象的依据与可比性判断",
  },
  {
    stage: "综合判断",
    question: "哪些差异真正重要？",
    responsibility: "跨来源的共性、冲突、trade-off 与适用条件",
  },
  {
    stage: "明确下一问",
    question: "还缺什么才能进一步判断？",
    responsibility: "当前能/不能得出什么、缺什么证据、什么新证据会改变判断",
  },
] as const);

/**
 * The comparison dimensions the card normally starts from.
 *
 * Each carries the *question* a sufficient answer has to answer, because a
 * dimension named "成本" invites three objects to report three different things
 * and call it a comparison.
 */
export const V2_COMPARISON_DIMENSIONS: readonly Dimension[] = Object.freeze([
  { id: "dim_core_idea", name: "对象与任务适配", question: "这个方法具体是什么实现/版本，面向哪一类任务与问题" },
  { id: "dim_construction", name: "索引与结构构建", question: "输入是什么，构建出什么中间结构，需要哪些步骤与数据" },
  { id: "dim_retrieval", name: "查询机制", question: "查询如何被处理、检索到什么单位、上下文如何组织" },
  { id: "dim_evaluation", name: "实验与评测", question: "在什么任务/数据/指标/设置下被验证，这些条件是否可比" },
  { id: "dim_cost", name: "成本与资源条件", question: "索引构建、查询、更新分别产生什么可观察成本，来源是否在相同口径下报告" },
  { id: "dim_limits", name: "局限、失效与未知", question: "作者报告或明显存在的失效条件、局限与尚未验证的部分是什么" },
]);

const CLAIM_REQUIREMENTS: readonly ClaimRequirement[] = Object.freeze([
  {
    claimType: "mechanism",
    requires: "绑定真实证据；关键机制优先使用原始方法论文或官方技术说明（primary/official）；证据要直接描述方法机制或结构",
    allowed: "综述可以补充，但要在条件里写明这是二手转述，并保留未取得的缺口",
    refused: "拿不到关键机制依据却把步骤写得像已核实；把综述当作唯一机制来源而不说明",
  },
  {
    claimType: "comparison",
    requires: "声明被比较的对象（≥2）；每个对象都有对应依据；维度问题统一",
    allowed: "描述性对比可以在缺少一方依据时保留空缺并写明缺口",
    refused: "用 A 的论文描述 A，再凭常识给 B 定性；在有排序含义的表述里只覆盖一方依据",
  },
  {
    claimType: "performance",
    requires: "记录任务、数据、指标、baseline、关键设置与评测来源；对象身份明确",
    allowed: "条件不可比时并列展示各自结果与条件，写成「在各自报告的实验中……」",
    refused: "条件不可比却给出统一名次或优劣判断",
  },
  {
    claimType: "cost",
    requires: "声明成本阶段（indexing/query/update/operational）、单位与规模、模型/硬件等适用条件与来源口径",
    allowed: "分阶段分口径报告；未知记为 unknown，不记为零",
    refused: "把 token 消耗、延迟、API 调用、内存、GPU 时间混成一个「成本」；口径不同却写「更便宜」",
  },
  {
    claimType: "synthesis",
    requires: "显式标为综合判断（synthesis），绑定 ≥2 条证据且来自 ≥2 个不同来源",
    allowed: "无法满足来源数要求时降为假设或缩小范围，并写清推断桥梁",
    refused: "把综合判断写成来源原文；没有输入证据的判断",
  },
  {
    claimType: "implication",
    requires: "显式包含条件（若/当/取决于……）；说明该条件来自哪里",
    allowed: "条件未知时给出「下一步验证什么」，而不是宣布应当采用",
    refused: "无条件的推荐（「推荐使用 X」）",
  },
]);

const QUALITY_RULES: readonly QualityRule[] = Object.freeze([
  { id: "Q01", requirement: "报告明确 Research Question、读者与范围", mode: "D+A", severity: "error" },
  { id: "Q02", requirement: "标题与摘要不超过实际证据支持的任务与对象范围", mode: "A", severity: "warning" },
  { id: "Q03", requirement: "主要章节各有可区分的认知目的，内容实际履行该目的", mode: "D+A", severity: "error" },
  { id: "Q04", requirement: "Mental Model 在详细比较之前出现", mode: "D+A", severity: "error" },
  { id: "Q05", requirement: "所有比较维度有统一的问题定义", mode: "D+A", severity: "error" },
  { id: "Q06", requirement: "Research Frame 声明的维度不得静默省略", mode: "D", severity: "error" },
  { id: "Q07", requirement: "比较论断覆盖所有被比较对象的依据（或明确标出缺失）", mode: "D+A", severity: "error" },
  { id: "Q08", requirement: "性能/成本不可比时禁止排名", mode: "D+A", severity: "error" },
  { id: "Q09", requirement: "主要论断有有效证据，或明确标为 synthesis 并绑定输入", mode: "D", severity: "error" },
  { id: "Q10", requirement: "综合判断与来源事实区分，并标为我们的综合", mode: "D+A", severity: "warning" },
  { id: "Q11", requirement: "关键不确定性与缺口出现在正文判断附近，不藏在附录", mode: "A", severity: "warning" },
  { id: "Q12", requirement: "默认 PDF 不输出完整证据 dump，核验索引可定位", mode: "D+H", severity: "warning" },
]);

/**
 * Technical Comparison v2.
 *
 * The section order is the cognitive order, and the validator enforces the one
 * ordering rule a reader would notice immediately: concepts before comparison.
 */
export const TECHNICAL_COMPARISON_V2: BlueprintSpec = Object.freeze({
  id: BLUEPRINT_ID_V2,
  name: "Technical Comparison v2 / 技术比较",
  purpose: "让读者理解几种具体方法的机制差异、比较条件与实际可判断的范围，并知道哪些结论现在还不能下",
  idealIntent: "我需要为组会/技术预研解释 A/B/C，并知道哪些结论现在不能下",
  cognitiveJourney: JOURNEY,
  requiredQuestions: [
    "对象和版本是什么？它们被放在一起比较的是同一个问题吗？",
    "输入、中间产物与输出分别是什么？为什么这样设计，代价是什么？",
    "共同维度如何定义？每列回答的是同一个问题吗？",
    "性能与成本的口径是否一致？不可比时结论如何表述？",
    "有哪些失效条件、未知与不能下的结论？",
  ],
  requiredComponents: ["question-takeaways", "mental-model", "mechanism", "comparison", "evidence-judgment", "implications-gaps"] as const,
  optionalComponents: ["详细实验设置", "贯穿例子", "分类图", "可比的定量图", "扩展术语表", "阅读建议"],
  comparisonDimensions: V2_COMPARISON_DIMENSIONS,
  briefMinimums: { subjects: 1, dimensions: 3 },
  briefRecommended: { subjects: [2, 5] as const, dimensions: [3, 6] as const },
  claimRequirements: CLAIM_REQUIREMENTS,
  comparisonRules: [
    "每列必须回答同一个维度问题；不同对象不得各自发挥字段",
    "不同 benchmark/数据/指标的数值可以并列展示，但不得合成统一名次",
    "比较表要声明每列对应哪个研究维度、每行对应哪个对象",
    "没有统一成本口径时按阶段并列条件，不汇成「更便宜」",
    "共同点是结论，差异也是结论；两者都要写，不能只列不同",
  ],
  evidenceRules: [
    "机制优先原始方法或官方文档；综述可补充但需说明",
    "性能/成本论断必须记录任务、数据、指标、设置与来源口径",
    "综合判断必须绑定多个来源并显式标为我们的综合",
    "未知保留为未知：没有找到依据的项目写成明确缺口，不静默省略",
  ],
  qualityChecks: QUALITY_RULES,
  whenNotToUse: "单一主题科普、要求覆盖全部文献、必须在缺少本地约束时给出采购结论的请求",
  sections: Object.freeze([
    // eslint-disable-next-line
    {
      id: "overview",
      title: "研究问题与关键认识",
      question: "为谁研究、研究什么，当前最重要的 2–4 个判断是什么，它们在什么条件下成立",
      cognitivePurpose: "定向：让读者在 30 秒内知道本文回答什么、不回答什么，以及关键判断的适用条件",
      requiredQuestions: [
        "研究问题与读者是谁？本次比较的对象与材料范围是什么？",
        "最重要的 2–4 个判断是什么？各自依赖什么条件？",
        "哪些结论现在还不能下？关键不确定性是什么？",
      ],
      depth: "summary",
      component: "question-takeaways",
      required: true,
      budget: "1 段范围说明 + 2–4 条带条件的关键认识",
    },
    {
      id: "mental-model",
      title: "概念坐标",
      question: "读懂后面的比较需要哪些概念、术语与分类轴，这些对象为什么可以放在一起比较",
      cognitivePurpose: "建模：让不了解领域的读者先建立概念坐标（分类轴、共享术语或问题分解）",
      requiredQuestions: [
        "这个领域要解决的核心问题是什么？可以用什么轴来分类这些方法？",
        "本文比较的对象的身份与版本是什么？同名方法是否指同一实现？",
        "后面比较用到的关键术语分别指什么？",
      ],
      depth: "explanation",
      component: "mental-model",
      required: true,
      budget: "2–3 段或一个 3–5 项列表；分类是作者归纳时要标明",
    },
    {
      id: "mechanism",
      title: "机制解释",
      question: "这些方法如何工作：输入、中间产物、过程、输出，为什么这样设计，代价与失效条件是什么",
      cognitivePurpose: "解释：从「是什么」进入「怎样发生」，并说明设计代价与可能失败的条件",
      requiredQuestions: [
        "输入是什么？中间结构/产物是什么？输出是什么？",
        "关键过程有哪些步骤？查询时如何使用这些中间产物？",
        "为什么这样设计？换来了什么能力？付出了什么代价？",
        "什么条件下可能失效？",
      ],
      depth: "explanation",
      component: "mechanism",
      required: true,
      budget: "至少一个结构化机制块（输入/中间产物/步骤/输出/权衡/失效条件）+ 必要的对照说明",
    },
    {
      id: "representative",
      title: "代表工作与对象身份",
      question: "每个研究对象自己的核心主张与做法是什么",
      cognitivePurpose: "逐个确认对象身份与自述，防止把同名方法当成同一实现",
      requiredQuestions: ["每个对象的原始来源与版本是什么？", "它对自身方法的自述是什么？"],
      depth: "summary",
      component: "evidence-judgment",
      required: false,
      budget: "每个对象 1–2 段",
    },
    {
      id: "comparison",
      title: "条件化比较",
      question: "在统一的维度问题下，各对象的具体差异与依据是什么，这些条件是否可比",
      cognitivePurpose: "有条件地比较：同一问题、同一口径下比较对象，并明确可比/部分可比/不可比",
      requiredQuestions: [
        "每个比较维度的问题定义是什么？",
        "每个对象如何回答该维度？各自依据是什么？",
        "这些条件是否可比？不可比时如何表述？",
        "共同点是什么？核心 trade-off 是什么？",
      ],
      depth: "analysis",
      component: "comparison",
      required: true,
      budget: "一张声明了列维度/行对象的主比较表 + 针对不可比项的说明",
    },
    {
      id: "synthesis",
      title: "综合判断与权衡",
      question: "跨来源综合后，哪些差异真正重要，适用与不适用的条件是什么",
      cognitivePurpose: "综合：把多个来源整合成新的、有界的判断，而不是 A 说/B 说的并排呈现",
      requiredQuestions: [
        "把材料放在一起后，多知道了什么？",
        "哪些前提是互证、冲突、互补或条件不同？",
        "哪个 trade-off 真正决定选择？边界在哪里？",
      ],
      depth: "synthesis",
      component: "evidence-judgment",
      required: true,
      budget: "1–3 条显式标注的综合判断及其依据",
    },
    {
      id: "limitations",
      title: "局限、未知与下一步",
      question: "当前能得出什么、不能得出什么，缺什么证据，什么新证据会改变判断",
      cognitivePurpose: "明确下一问：把研究缺口写成分型的未知与可执行的下一步",
      requiredQuestions: [
        "哪些判断有证据边界（间接证据、口径不同、身份不明）？",
        "缺哪类证据？它会影响哪个判断？",
        "下一步最值得验证什么？",
      ],
      depth: "analysis",
      component: "implications-gaps",
      required: true,
      budget: "分型列出 2–4 项：缺证据 / 仅间接 / 不可比 / 待独立评估",
    },
    {
      id: "reading",
      title: "阅读建议",
      question: "按什么顺序读这些材料最有效率",
      cognitivePurpose: "为愿意深入的人给出有理由的阅读路径",
      requiredQuestions: ["先读什么、为什么？", "哪些材料只适合作为背景？"],
      depth: "summary",
      component: "implications-gaps",
      required: false,
      budget: "3–5 条",
    },
  ]) as readonly SectionSpec[],
});

/** Every blueprint this build knows, by id. */
export const BLUEPRINTS: Readonly<Record<string, BlueprintSpec>> = Object.freeze({
  [BLUEPRINT_ID_V2]: TECHNICAL_COMPARISON_V2,
});

/**
 * The blueprint a task is validated against, if it has one.
 *
 * `undefined` means the task predates blueprints: it keeps the legacy rule set
 * (required sections present, evidence real) and is never judged against
 * obligations it was not written under.
 */
export function blueprintById(id: string | undefined): BlueprintSpec | undefined {
  return id === undefined ? undefined : BLUEPRINTS[id];
}

export function sectionSpecOf(blueprint: BlueprintSpec, sectionId: string): SectionSpec | undefined {
  return blueprint.sections.find((section) => section.id === sectionId);
}

/** The sections a card created under this blueprint starts with. */
export function blueprintSections(blueprint: BlueprintSpec): readonly ResearchSection[] {
  return blueprint.sections.map(({ id, title, question }) => ({ id, title, question }));
}

/** The sections whose absence blocks publication. */
export function requiredSectionsOf(blueprint: BlueprintSpec): readonly SectionSpec[] {
  return blueprint.sections.filter((section) => section.required);
}

/** The one-line summary of a section's obligation, for prompts and messages. */
export function sectionObligation(section: SectionSpec): string {
  return `${section.title}（${section.cognitivePurpose}；须回答：${section.requiredQuestions.join("；")}）`;
}
