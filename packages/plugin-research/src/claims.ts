/**
 * The claim contract: what may support what.
 *
 * The product's old rule was "a claim needs evidence". That rule is kept, and
 * it is not enough: a cost claim whose evidence mixes token counts with GPU
 * latency has evidence and is still nonsense, and a comparative claim supported
 * only by the first object's paper is a description of that paper wearing a
 * comparison's clothes. Each claim type therefore has its own requirements, and
 * this module is where they are decided.
 *
 * Two kinds of judgement live here and they are deliberately different:
 *
 *  - `validateClaimContract` is deterministic plus a small, documented lexicon.
 *    It reads the claim's own declarations (subjects, conditions, synthesis
 *    flag) and its evidence's provenance, and refuses the combinations that
 *    cannot be honest. Its failures block publication.
 *  - `deriveClaimAdequacy` is a derived state, like the matrix's coverage: it
 *    describes what the saved material and judgements currently support, and it
 *    is used for warnings and for what the reader sees. It never invents a
 *    judgement of its own — no assessment means `unassessed`, not `fine`.
 */

import type {
  Comparability,
  Evidence,
  ReportClaim,
  Source,
  SourceRole,
  SupportAssessment,
} from "./domain.js";
import { PRIMARY_ROLES } from "./domain.js";

export type AdequacyState = "adequate" | "limited" | "incomparable" | "conflicted" | "missing" | "unassessed";

export interface ClaimAdequacy {
  readonly state: AdequacyState;
  readonly reasons: readonly string[];
}

export interface ClaimVerdict {
  /** Problems that block publication of the report. */
  readonly errors: readonly string[];
  /** Contract obligations that were not met but do not block publication. */
  readonly warnings: readonly string[];
}

export interface ClaimContext {
  readonly evidence: readonly Evidence[];
  readonly sources: readonly Source[];
  readonly assessments: readonly SupportAssessment[];
  /** Subject id → name, for messages a reader can act on. */
  readonly subjectNames: ReadonlyMap<string, string>;
}

/**
 * Language that asserts a ranking rather than a description.
 *
 * It is a lexicon, not comprehension: it exists so that the *combination* "this
 * text ranks two objects" plus "this claim declares its evidence is not
 * comparable" can be refused. A claim that says "A 在各自报告中报告了更高吞吐"
 * is not caught here and does not need to be — it does not assert a winner.
 */
const RANKING_PATTERNS: readonly RegExp[] = Object.freeze([
  /优于/,
  /不如/,
  /更好/,
  /更强/,
  /更快/,
  /更慢/,
  /更便宜/,
  /更贵/,
  /更低/,
  /更高/,
  /更轻/,
  /更重/,
  /超过/,
  /领先/,
  /胜于/,
  /比[^。；;]{1,20}更/,
  /\boutperform/i,
  /\bbetter than\b/i,
  /\bfaster than\b/i,
  /\bcheaper than\b/i,
  /\bmore efficient\b/i,
  /\bhigher than\b/i,
  /\blower than\b/i,
]);

/** Language that recommends, which is only allowed with an explicit condition. */
const RECOMMENDATION_PATTERNS: readonly RegExp[] = Object.freeze([
  /推荐/,
  /建议采用/,
  /建议使用/,
  /应当部署/,
  /应该部署/,
  /应采用/,
  /建议选择/,
  /\brecommend/i,
  /\bshould (?:use|adopt|deploy)\b/i,
]);

/** Language that makes a condition explicit. */
const CONDITION_PATTERNS: readonly RegExp[] = Object.freeze([
  /若/,
  /如果/,
  /当[^。；;]{0,20}时/,
  /取决于/,
  /前提/,
  /在[^。；;]{0,24}条件下/,
  /的条件/,
  /\bif\b/i,
  /\bwhen\b/i,
  /\bdepending on\b/i,
  /\bprovided\b/i,
]);

/**
 * The families a cost number can belong to.
 *
 * Comparing across families is the specific mistake the cost contract exists to
 * stop: "A 更便宜" built from A's token count and B's wall-clock latency is not
 * a comparison of anything.
 */
const COST_FAMILIES: readonly { readonly id: string; readonly pattern: RegExp }[] = Object.freeze([
  { id: "tokens/calls", pattern: /token|api[- ]call|llm call|completion|prompt size/i },
  { id: "latency", pattern: /latency|runtime|wall[- ]clock|throughput|seconds? per|\bms\b/i },
  { id: "memory", pattern: /memory|\bram\b|\bvram\b|\bgb\b|footprint/i },
  { id: "compute", pattern: /gpu[- ]hour|gpu[- ]hours|\bflops?\b|a100|h100|v100|training time/i },
  { id: "money", pattern: /\$|usd|eur|cost per|pricing|price/i },
]);

/**
 * Where a clause ends, for the purpose of deciding what a refusal refuses.
 *
 * A negation governs its own clause and no further:「不能得出谁更便宜的判断，
 * 但 A 比 B 更便宜」refuses one ranking and states another, and a check that
 * exempted the whole paragraph on sight of「不能」would wave the second one
 * through. Sentence punctuation and the comma both end a clause, and so does an
 * adversative conjunction —「GraphRAG is not open source but outperforms
 * LightRAG」is one sentence and two claims. 、does not end a clause, because it
 * joins items *inside* one, which is exactly where a refusal keeps the objects
 * it refuses about. 但是 is tried before 但 so the longer breakword wins.
 */
const CLAUSE_BREAK = /[。；;！？!?\n，,]|但是|然而|不过|但|却|\b(?:but|however|yet)\b/i;

/**
 * The words a refusal uses to name the objects it refuses about.
 *
 * A refusal construction is only honoured when what sits between its verb and
 * the ranking predicate is an *object* — a name this task declares, or one of
 * these placeholders — and nothing else. 「无法处理中文的 GraphRAG 优于
 * LightRAG」contains a refusal word and asserts a ranking: the verb the refusal
 * is attached to is「处理」, which judges nothing. Accepting any text there would
 * put that sentence back on the exempt list.
 */
const PLACEHOLDER_OBJECTS: readonly string[] = Object.freeze([
  "A", "B", "C", "a", "b", "c", "甲", "乙", "丙",
  "二者", "两者", "双方", "谁", "哪个", "哪一个", "哪一方", "何者", "对方", "彼此",
  "the other", "either", "both", "neither", "them", "they", "it", "one", "two",
]);

/**
 * Language that puts a ranking phrase *under refusal* rather than stating it.
 *
 * The product's own contract tells a writer to do exactly this —「分口径陈述，
 * 不能合成一个『更便宜』的判断」— and the first version of this check read that
 * sentence as a ranking, because a lexicon that only looks for 「更便宜」 cannot
 * tell "A 更便宜" from "不能得出谁更便宜的判断". Both are about a ranking; only
 * one asserts one.
 *
 * The correction is that a refusal governs the ranking *it names* and nothing
 * further. Four constructions reach the predicate and are read as refusals:
 *
 *  - a negation directly in front of it (「A 不优于 B」/「A does not outperform B」);
 *  - a judgement verb whose object is the predicate (「不能合成一个更便宜的
 *    判断」/「不能对 A、B 给出更便宜的判断」);
 *  - an evidential phrase (「没有依据表明 A 优于 B」);
 *  - the English「no method outperforms the other」.
 *
 * Everything shorter is read as a ranking, because a false refusal is how an
 * unsupported ranking gets published — and a sentence that cannot be parsed
 * confidently is a ranking until proven otherwise. Three further rules say where
 * a refusal stops, because an exemption that reaches too far is the same defect
 * in a quieter spelling:
 *
 *  - it ends at the next ranking predicate:「No method outperforms GraphRAG and
 *    LightRAG outperforms GraphRAG」refuses the first ranking and states the
 *    second, and the second is not covered by the first one's words;
 *  - it must be adjacent to the predicate it refuses, not merely somewhere
 *    earlier in the clause:「No evidence was collected so GraphRAG outperforms
 *    LightRAG」asserts the ranking its own first half disclaims;
 *  - it may not itself be negated:「并非不能判断 GraphRAG 优于 LightRAG」denies the
 *    refusal, which leaves the ranking standing.
 */
const DIRECT_NEGATION =
  /(?:不[能否可该应得会宜足再需用是]?|未[能尝有取得找给报获证实]?|没有|无法|无从|难以|没法|无|非|别|勿)(?:\s|都|也|并|再|从|完全|根本|始终|从来|仍|仍然|已经|曾|可能|能够|会|直接)*["'“”‘’「」『』\s]*$/u;

const REFUSAL_VERB =
  "(?:不足以|不能|不可|不该|不应|不得|不会|不宜|不足|不再|无需|无法|无从|未能|未[能尝有取得找给报获证实]?|难以|没法|没有|缺乏|缺少)";

const JUDGEMENT_VERB = "(?:判断|认定|得出|证明|合成|给出|做出|形成|支持|表明|说明|断言)";

const JUDGEMENT_QUANTIFIER = "(?:一个|一种|任何|谁|哪个|哪一个|哪一方|哪一种|何者|什么)";

/** How far a refusal's own topic phrase (「对 A、B」) may reach. */
const TOPIC_PHRASE = "(?:(?:对|针对|就|把)\\s*[^，。；;！？!?\\n]{0,30}?\\s*)?";

const EVIDENTIAL_HEAD =
  "(?:(?:没有|并无|未有|毫无|缺乏|缺少|无)\\s*(?:任何)?\\s*(?:依据|证据|资料|数据|来源|研究|材料|记录)\\s*(?:能|能够|可以|可|足以)?\\s*(?:表明|证明|支持|说明|显示|找到|得出|给出))";

/**
 * The English「no method outperforms the other」construction, and its limit.
 *
 * The noun phrase has to be the subject the ranking predicate is attached to:
 * only quotes and whitespace may stand between them. A tail that reached
 * further — the first version allowed any run of text up to the next sentence
 * mark — swallowed whatever stood in front of the predicate, including the
 * second half of「No evidence was collected so GraphRAG outperforms LightRAG」.
 */
const ENGLISH_NOUN_REFUSAL =
  /\bno\s+(?:method|approach|system|model|evidence|study|source|paper|result|measurement|comparison|ranking|data|number)\b["'“”‘’「」『』\s]*$/i;

const ENGLISH_DIRECT_NEGATION = /\b(?:not|never|no|cannot|can't|don't|doesn't|didn't|isn't|aren't|won't)\s*$/i;

/**
 * Whether the refusal a matcher found is itself under a negation.
 *
 * 「并非不能判断 A 优于 B」does not refuse the ranking; it denies the refusal,
 * which is to say it states that the ranking *can* be judged. The same reading
 * covers「不是不能判断……」and the English「it is not the case that no method
 * outperforms……」, so a refusal that begins right after one of these words is
 * not an exemption at all. The bridge between the two negations is the short
 * closed set a second negation is actually spelled through —「不能说没有证据
 * 表明……」— and nothing else may stand there.
 */
const NEGATION_LEAD =
  /(?:并非|并不是|不是|不|未|没有|无|非|别|勿|not|never|no)(?:(?:是|为|会|能|可以|可能|说|认为|算|意味|代表|说明|表示|得))*\s*["'“”‘’「」『』]*$/iu;

/** The subject names and ids a refusal may name between its verb and the predicate. */
export interface RankingScope {
  /** Subject id → name, for the refusals that name the objects they refuse about. */
  readonly subjectNames?: ReadonlyMap<string, string>;
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One alternation of object tokens; ASCII words are kept from matching inside longer ones. */
function objectAlternation(words: readonly string[]): string {
  const parts = [...new Set(words.filter((word) => word.trim().length > 0))]
    .sort((left, right) => right.length - left.length)
    .map((word) => {
      const escaped = escapeRegExp(word.trim());
      return /^[ -~]+$/.test(word.trim()) ? `(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])` : escaped;
    });
  return parts.length === 0 ? "(?!)" : `(?:${parts.join("|")})`;
}

/** The refusal constructions, with the objects of the current claim's task substituted in. */
function refusalMatchers(scope: RankingScope | undefined): readonly RegExp[] {
  const declared: string[] = [];
  for (const [id, name] of scope?.subjectNames ?? []) declared.push(id, name);
  const filler = `(?:${objectAlternation([...PLACEHOLDER_OBJECTS, ...declared])}|["'“”‘’「」『』]|\\s)*`;
  return [
    DIRECT_NEGATION,
    new RegExp(`${REFUSAL_VERB}\\s*${TOPIC_PHRASE}${JUDGEMENT_VERB}\\s*(?:${JUDGEMENT_QUANTIFIER})?\\s*${filler}$`, "u"),
    new RegExp(`${EVIDENTIAL_HEAD}\\s*${filler}$`, "u"),
    ENGLISH_NOUN_REFUSAL,
    ENGLISH_DIRECT_NEGATION,
  ];
}

interface Range {
  readonly start: number;
  readonly end: number;
}

/**
 * Every ranking predicate in the clause, overlapped ranges merged.
 *
 * The first version of this check read only the *first* match of each pattern,
 * so a clause that ranked twice was judged on its first ranking alone. Each
 * pattern gets its own copy with `g` — never the shared frozen one, whose
 * `lastIndex` would leak between claims — and all matches are collected.
 */
function rankingRanges(clause: string): readonly Range[] {
  const found: Range[] = [];
  for (const pattern of RANKING_PATTERNS) {
    const local = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    let match = local.exec(clause);
    while (match !== null) {
      found.push({ start: match.index, end: match.index + match[0].length });
      if (match[0].length === 0) local.lastIndex += 1;
      match = local.exec(clause);
    }
  }
  found.sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: Range[] = [];
  for (const range of found) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range.start < last.end) {
      merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, range.end) };
      continue;
    }
    merged.push(range);
  }
  return merged;
}

/**
 * Whether a refusal covers the ranking predicate that begins at `start`.
 *
 * The text a refusal is read from runs from `from` — the end of the previous
 * ranking predicate in this clause, or the start of the clause — to the
 * predicate itself. Both ends matter: a refusal earns its exemption only where
 * it is, which is why one that states a ranking first does not hand that ranking
 * to the next predicate, and why a refusal whose own start is negated is no
 * refusal at all.
 */
function isRefused(clause: string, from: number, start: number, matchers: readonly RegExp[]): boolean {
  const region = clause.slice(from, start);
  return matchers.some((matcher) => {
    const local = new RegExp(matcher.source, matcher.flags.includes("g") ? matcher.flags : `${matcher.flags}g`);
    let match = local.exec(region);
    while (match !== null) {
      if (!NEGATION_LEAD.test(region.slice(0, match.index))) return true;
      if (match[0].length === 0) local.lastIndex += 1;
      match = local.exec(region);
    }
    return false;
  });
}

/**
 * Whether the text asserts a ranking rather than refusing one.
 *
 * Every ranking predicate in every clause is checked on its own: one covered
 * predicate does not cover the next one, in the same clause or in a later one.
 * The task's subjects may be passed in so that a refusal naming them —「不能对
 * GraphRAG、LightRAG 给出更便宜的判断」— is read as the refusal it is.
 */
export function assertsRanking(text: string, scope?: RankingScope): boolean {
  const matchers = refusalMatchers(scope);
  for (const clause of text.split(CLAUSE_BREAK)) {
    let previousEnd = 0;
    for (const range of rankingRanges(clause)) {
      if (!isRefused(clause, previousEnd, range.start, matchers)) return true;
      previousEnd = range.end;
    }
  }
  return false;
}

function hasExplicitCondition(text: string): boolean {
  return CONDITION_PATTERNS.some((pattern) => pattern.test(text));
}

function mentionsRecommendation(text: string): boolean {
  return RECOMMENDATION_PATTERNS.some((pattern) => pattern.test(text));
}

/** The cost families the given texts talk about. */
export function costFamiliesOf(texts: readonly string[]): readonly string[] {
  const families: string[] = [];
  for (const text of texts) {
    for (const family of COST_FAMILIES) {
      if (family.pattern.test(text) && !families.includes(family.id)) families.push(family.id);
    }
  }
  return families;
}

function subjectLabel(context: ClaimContext, subjectId: string): string {
  return context.subjectNames.get(subjectId) ?? subjectId;
}

/** The subjects an item of evidence is bound to, across its cells. */
function evidenceSubjects(evidence: Evidence): readonly string[] {
  return [...new Set(evidence.cells.map((cell) => cell.subjectId))];
}

function rolesOf(evidence: readonly Evidence[], sources: readonly Source[]): readonly SourceRole[] {
  const roleById = new Map(sources.map((source) => [source.id, source.role ?? null]));
  const roles: SourceRole[] = [];
  for (const item of evidence) {
    const role = roleById.get(item.sourceId);
    if (role !== null && role !== undefined && !roles.includes(role)) roles.push(role);
  }
  return roles;
}

function sourceCountOf(evidence: readonly Evidence[]): number {
  return new Set(evidence.map((item) => item.sourceId)).size;
}

/**
 * Judges one claim against its own contract.
 *
 * `errors` block publication; `warnings` do not. The rule of thumb is the one
 * the quality contract uses: a claim that *asserts* something its material
 * cannot carry is refused, and a claim that leaves an obligation open while
 * saying so honestly is reported and allowed to ship.
 */
export function validateClaimContract(claim: ReportClaim, context: ClaimContext): ClaimVerdict {
  const errors: string[] = [];
  const warnings: string[] = [];
  const byId = new Map(context.evidence.map((item) => [item.id, item]));
  const cited = claim.evidenceIds.map((id) => byId.get(id)).filter((item): item is Evidence => item !== undefined);
  const claimType = claim.claimType ?? "fact";
  const subjects = claim.subjects ?? [];
  const conditions = claim.conditions ?? {};
  const label = `claim ${claim.id}（${claimType}）`;

  const ranking = assertsRanking(claim.text, { subjectNames: context.subjectNames });
  const subjectsWithEvidence = new Set(cited.flatMap(evidenceSubjects));
  const missingEvidenceFor = subjects.filter((subjectId) => !subjectsWithEvidence.has(subjectId));

  switch (claimType) {
    case "mechanism": {
      const roles = rolesOf(cited, context.sources);
      const hasPrimary = roles.some((role) => PRIMARY_ROLES.includes(role));
      if (roles.length === 0) {
        warnings.push(`${label} 的机制依据没有登记来源角色：无法确认它是否来自原始方法或官方文档。`);
      } else if (!hasPrimary) {
        warnings.push(
          `${label} 的关键机制依据来自 ${roles.join("/")}，不是原始方法或官方文档。请在条件里说明是二手转述，或补查原始材料。`,
        );
      }
      break;
    }
    case "comparison": {
      if (subjects.length < 2) {
        errors.push(`${label} 是比较论断，必须声明被比较的对象（subjects，至少 2 个）。`);
      }
      if (ranking && missingEvidenceFor.length > 0) {
        errors.push(
          `${label} 在排序表述中只覆盖了部分对象的依据（缺：${missingEvidenceFor
            .map((id) => subjectLabel(context, id))
            .join("、")}）。请补齐依据、改成单对象描述，或删除该排序判断。`,
        );
      } else if (missingEvidenceFor.length > 0 || cited.length < subjects.length) {
        const missing = missingEvidenceFor.length > 0 ? missingEvidenceFor : subjects;
        warnings.push(
          `${label} 尚未覆盖 ${missing.map((id) => subjectLabel(context, id)).join("、")} 的依据；若确实不可得，请在正文写成明确缺口。`,
        );
      }
      break;
    }
    case "performance": {
      const comparability = conditions.comparability;
      if (comparability === undefined) {
        errors.push(
          `${label} 没有声明可比性（conditions.comparability）。请判断任务/数据/指标/设置是否对齐：对齐写 comparable，对齐不了就写 not-directly-comparable。`,
        );
      }
      if (ranking) {
        if (comparability !== undefined && comparability !== "comparable") {
          errors.push(
            `${label} 声明了「${comparability}」却仍在做优劣排序。请改写为「在各自报告的实验中……」并保留各自数字，或补足可比证据。`,
          );
        }
        const missingConditions = (["task", "dataset", "metric", "setting"] as const).filter(
          (key) => conditions[key] === undefined || conditions[key] === "",
        );
        if (comparability === "comparable" && missingConditions.length > 0) {
          errors.push(`${label} 声明条件可比，但缺少 ${missingConditions.join("、")}；不可比前不能直接排名。`);
        }
        if (missingEvidenceFor.length > 0) {
          errors.push(
            `${label} 缺少 ${missingEvidenceFor.map((id) => subjectLabel(context, id)).join("、")} 的证据，不能给出比较结论。`,
          );
        }
      }
      break;
    }
    case "cost": {
      if (conditions.costStage === undefined) {
        errors.push(
          `${label} 没有声明成本阶段（conditions.costStage）。索引、查询、更新、运维不是同一个成本，请分别说明。`,
        );
      }
      if (ranking) {
        if (conditions.comparability !== "comparable") {
          errors.push(
            `${label} 在成本上做排序，但未声明口径可比（当前：${conditions.comparability ?? "未声明"}）。请分口径并列，或收窄为「在各自口径下」。`,
          );
        }
        if (missingEvidenceFor.length > 0) {
          errors.push(`${label} 缺少 ${missingEvidenceFor.map((id) => subjectLabel(context, id)).join("、")} 的成本依据。`);
        }
        const families = costFamiliesOf(cited.map((item) => item.excerpt));
        if (families.length > 1) {
          errors.push(
            `${label} 的证据混用了不同成本口径（${families.join("、")}）；这些数字不能放在一个「更便宜」的判断里，请按口径拆开。`,
          );
        }
      } else if (conditions.comparability !== undefined && conditions.comparability !== "comparable" && cited.length > 1) {
        warnings.push(`${label} 报告了不可比口径下的成本，请确认正文明确写出这是各来源自身口径。`);
      }
      break;
    }
    case "synthesis": {
      if (claim.synthesis !== true) {
        errors.push(`${label} 必须显式标记 synthesis=true：综合判断要能与来源事实区分开。`);
      }
      if (cited.length < 2 || sourceCountOf(cited) < 2) {
        errors.push(
          `${label} 需要 ≥2 条证据、来自 ≥2 个不同来源（当前证据 ${cited.length} 条 / 来源 ${sourceCountOf(cited)} 个）。否则请降为单来源陈述或明确标为待验证假设。`,
        );
      }
      const bridge = conditions.scope ?? "";
      if (bridge.trim().length === 0) {
        warnings.push(`${label} 建议在 conditions.scope 写出推断桥梁与适用边界（这些证据如何支持这个综合判断）。`);
      }
      break;
    }
    case "implication": {
      const scope = (conditions.scope ?? "").trim();
      if (scope.length === 0) {
        errors.push(`${label} 是条件化建议，必须在 conditions.scope 写明成立条件。`);
      }
      if (mentionsRecommendation(claim.text) && !hasExplicitCondition(claim.text) && !hasExplicitCondition(scope)) {
        errors.push(
          `${label} 出现无条件推荐表述。请写成「若 X 成立，可先评估 A」这类带条件的判断，并说明条件来自哪里。`,
        );
      }
      break;
    }
    case "fact":
      break;
  }

  return { errors, warnings };
}

/**
 * What the saved material and judgements currently support for one claim.
 *
 * Derived, never stored: it moves when evidence, assessments or the claim's own
 * conditions move, and it cannot be raised by asserting a better state. The
 * matrix's cell states and this are related — both read the same assessments —
 * but they answer different questions, so they are computed separately rather
 * than one being read off the other.
 */
export function deriveClaimAdequacy(claim: ReportClaim, context: ClaimContext): ClaimAdequacy {
  const byId = new Map(context.evidence.map((item) => [item.id, item]));
  const cited = claim.evidenceIds.map((id) => byId.get(id)).filter((item): item is Evidence => item !== undefined);
  if (cited.length === 0) {
    return { state: "missing", reasons: ["没有任何可解析的证据"] };
  }

  const citedIds = new Set(cited.map((item) => item.id));
  const cellsOfCited = new Set(
    cited.flatMap((item) => item.cells.map((cell) => `${cell.sectionId}|${cell.subjectId}|${cell.dimensionId}`)),
  );
  const relevant = context.assessments.filter((entry) => {
    const target = entry.target as { sectionId?: string; subjectId?: string; dimensionId?: string; claimId?: string };
    if (typeof target.claimId === "string") return target.claimId === claim.id && entry.evidenceIds.some((id) => citedIds.has(id));
    return (
      cellsOfCited.has(`${target.sectionId ?? ""}|${target.subjectId ?? ""}|${target.dimensionId ?? ""}`) &&
      entry.evidenceIds.some((id) => citedIds.has(id))
    );
  });

  const reasons: string[] = [];
  const conditions = claim.conditions ?? {};
  const claimType = claim.claimType ?? "fact";

  if (relevant.some((entry) => entry.relationship === "contradicts")) {
    return { state: "conflicted", reasons: ["已有评估与这些证据相矛盾：需要在正文并置冲突或说明条件差异"] };
  }

  if (
    (claimType === "performance" || claimType === "cost") &&
    (conditions.comparability === "not-directly-comparable" || conditions.comparability === "partially-comparable")
  ) {
    return {
      state: "incomparable",
      reasons: [`条件被声明为 ${conditions.comparability}：只能并列报告各自口径，不能给出统一判断`],
    };
  }

  if (relevant.length === 0) {
    return { state: "unassessed", reasons: ["这些证据还没有保存支持评估（关系、直接性与适用条件）"] };
  }

  // Which evidence carries a direct, body-level, supportive judgement — and
  // *whose* material that is. A claim about two objects is only supported when
  // each of them has been judged, not when a judgement about one happens to sit
  // next to the other's passage.
  const judgedIds = new Set(
    relevant
      .filter((entry) => entry.relationship === "supports" && entry.directness === "direct")
      .flatMap((entry) =>
        entry.evidenceIds.filter((id) => {
          const item = byId.get(id);
          return item !== undefined && (item.readScope === "body_excerpt" || item.readScope === "full_text");
        }),
      ),
  );
  if (judgedIds.size === 0) {
    const why = relevant.some((entry) => entry.relationship === "supports")
      ? "支持评估为间接、仅背景，或只指向摘要级片段"
      : "现有评估只提供背景或语境";
    return { state: "limited", reasons: [why] };
  }

  const subjects = claim.subjects ?? [];
  const subjectsWithEvidence = new Set(cited.flatMap(evidenceSubjects));
  const uncovered = subjects.filter((subjectId) => !subjectsWithEvidence.has(subjectId));
  if (uncovered.length > 0) {
    reasons.push(...uncovered.map((subjectId) => `缺少 ${context.subjectNames.get(subjectId) ?? subjectId} 的对应证据`));
    return { state: "limited", reasons };
  }
  const unjudged = subjects.filter(
    (subjectId) =>
      !cited.some((item) => evidenceSubjects(item).includes(subjectId) && judgedIds.has(item.id)),
  );
  if (unjudged.length > 0) {
    return {
      state: "limited",
      reasons: unjudged.map((subjectId) => `${context.subjectNames.get(subjectId) ?? subjectId} 的依据还没有保存支持评估`),
    };
  }

  if (claimType === "synthesis" && sourceCountOf(cited) < 2) {
    return { state: "limited", reasons: ["综合判断只绑定了一个来源"] };
  }

  if ((claimType === "performance" || claimType === "cost") && conditions.comparability === undefined) {
    return { state: "limited", reasons: ["未声明可比性：无法确认这些数字可以放在一起判断"] };
  }

  return { state: "adequate", reasons: ["有正文级、直接相关的支持评估，且覆盖了声明的对象"] };
}

/** Whether an adequacy state means the claim still owes something. */
export function adequacyNeedsAttention(state: AdequacyState): boolean {
  return state !== "adequate";
}

/**
 * The adequacy states a report is allowed to publish *as long as it says so*.
 *
 * `incomparable` is a finding, not a defect: refusing it would push the model
 * back to inventing a winner. The ones that block are handled by the claim
 * contract above.
 */
export const HONEST_ADEQUACY_STATES: readonly AdequacyState[] = Object.freeze(["incomparable", "limited", "conflicted", "unassessed"]);

/** The comparability a comparison may be reported under, in reader-facing words. */
export function comparabilityLabel(value: Comparability): string {
  switch (value) {
    case "comparable":
      return "条件可比";
    case "partially-comparable":
      return "部分可比";
    case "not-directly-comparable":
      return "不可直接比较";
    case "unknown":
      return "尚未判断可比性";
  }
}
