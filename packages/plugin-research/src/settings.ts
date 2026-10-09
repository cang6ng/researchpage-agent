/**
 * The product's own settings: what a *new* project will be, and nothing more.
 *
 * Two rules decide everything in this file.
 *
 * The first is that a setting is only a setting if it reaches behaviour. Every
 * field here is read at a specific moment by code that acts on it — the
 * research defaults when a card becomes a task, the provider order when a
 * search runs — and there is no field a page can change that nothing reads.
 * A number a reader can edit and the pipeline ignores is worse than no field
 * at all, because it is a claim about the product that is not true.
 *
 * The second is that these values are *frozen at creation*. A default governs
 * the next task; it never reaches into an existing one. A project that was
 * started under one budget keeps it, including through a retry, because the
 * work already done was done under the promises that budget made — and an
 * operator who lowers the ceiling must not thereby take away the room a
 * running project was told it had.
 */

import { DEFAULT_BUDGET, type ResearchBudget } from "./domain.js";

/** The providers discovery may ask, in the product's own vocabulary. */
export const RESEARCH_PROVIDERS = ["arxiv", "openalex"] as const;
export type ResearchProviderName = (typeof RESEARCH_PROVIDERS)[number];

/** The bounds a default may be set within. Outside these, a request is refused. */
export const BUDGET_LIMITS = Object.freeze({
  maxSearches: { min: 1, max: 30 },
  maxCandidatesPerSearch: { min: 1, max: 20 },
  maxReads: { min: 1, max: 50 },
  maxGapRounds: { min: 0, max: 5 },
  deadlineMs: { min: 60_000, max: 1_800_000 },
});

/** What a reader may decide about the next project's research budget. */
export interface ResearchDefaults {
  readonly maxSearches: number;
  readonly maxCandidatesPerSearch: number;
  readonly maxReads: number;
  readonly maxGapRounds: number;
  readonly deadlineMs: number;
}

/**
 * The stored settings document.
 *
 * `undefined` on a field means "not decided", which is read as the product's
 * own default rather than as a value someone chose. Keeping the two apart is
 * what lets the page say where a number came from.
 */
export interface ProductSettingsValue {
  readonly research?: ResearchDefaults;
  /**
   * The providers to ask, in order.
   *
   * At least one is required: a product whose only retrieval is switched off
   * cannot research, and a switch that produces that state is a switch that
   * breaks the product rather than configuring it.
   */
  readonly providers?: readonly ResearchProviderName[];
}

export interface ProductSettingsView {
  readonly revision: number;
  readonly research: ResearchDefaults;
  /** Where each field's value came from, so the page can say so. */
  readonly researchSource: "product-default" | "saved";
  readonly providers: readonly ResearchProviderName[];
  readonly providersSource: "product-default" | "saved";
  readonly limits: typeof BUDGET_LIMITS;
  readonly providerChoices: readonly ResearchProviderName[];
}

export interface SettingsProblem {
  readonly field: string;
  readonly problem: string;
}

export type SettingsWrite =
  | { readonly ok: true; readonly value: ProductSettingsValue }
  | { readonly ok: false; readonly problems: readonly SettingsProblem[] };

/** The product's own defaults, in the one place they are written down. */
export const DEFAULT_RESEARCH_DEFAULTS: ResearchDefaults = Object.freeze({
  maxSearches: DEFAULT_BUDGET.maxSearches,
  maxCandidatesPerSearch: DEFAULT_BUDGET.maxCandidatesPerSearch,
  maxReads: DEFAULT_BUDGET.maxReads,
  maxGapRounds: DEFAULT_BUDGET.maxGapRounds,
  deadlineMs: DEFAULT_BUDGET.deadlineMs,
});

export const DEFAULT_PROVIDER_ORDER: readonly ResearchProviderName[] = Object.freeze(["arxiv", "openalex"]);

/**
 * One number, read as the integer the contract allows — or refused.
 *
 * There is no rounding and no clamping. A caller that sends 7.5 or "7" has made
 * a different statement from the one the field accepts, and silently turning it
 * into 7 would be this product deciding a budget nobody asked for.
 */
function readBounded(
  value: unknown,
  field: keyof typeof BUDGET_LIMITS,
  problems: SettingsProblem[],
): number | undefined {
  if (value === undefined) return undefined;
  const limits = BUDGET_LIMITS[field];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    problems.push({ field, problem: `必须是整数（${String(limits.min)}–${String(limits.max)}）` });
    return undefined;
  }
  if (value < limits.min || value > limits.max) {
    problems.push({ field, problem: `超出允许范围（${String(limits.min)}–${String(limits.max)}）` });
    return undefined;
  }
  return value;
}

function readProviders(value: unknown, problems: SettingsProblem[]): readonly ResearchProviderName[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    problems.push({ field: "providers", problem: "必须是来源列表" });
    return undefined;
  }
  const seen: ResearchProviderName[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !(RESEARCH_PROVIDERS as readonly string[]).includes(entry)) {
      problems.push({ field: "providers", problem: `未知的检索来源：${JSON.stringify(entry)}` });
      return undefined;
    }
    const provider = entry as ResearchProviderName;
    if (!seen.includes(provider)) seen.push(provider);
  }
  // A product with every provider switched off cannot retrieve anything, so it
  // would promise research it cannot do. Keeping one is a requirement of the
  // product, not a preference of the reader.
  if (seen.length === 0) {
    problems.push({ field: "providers", problem: `至少要保留一个检索来源（${RESEARCH_PROVIDERS.join(" / ")}）` });
    return undefined;
  }
  return seen;
}

/**
 * Reads a settings write as the closed document the product stores.
 *
 * `patch` semantics: a field that is absent keeps what is stored, and a field
 * that is present replaces it. Everything present is validated before anything
 * is stored, so a write either publishes a document whose every field is legal
 * or changes nothing at all.
 */
export function readSettingsWrite(input: unknown, current: ProductSettingsValue): SettingsWrite {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, problems: [{ field: "", problem: "设置必须是一个对象" }] };
  }
  const record = input as Record<string, unknown>;
  const problems: SettingsProblem[] = [];

  let research = current.research;
  if (record["research"] !== undefined) {
    const raw = record["research"];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      problems.push({ field: "research", problem: "预算必须是一个对象" });
    } else {
      const fields = raw as Record<string, unknown>;
      const base = current.research ?? DEFAULT_RESEARCH_DEFAULTS;
      const next: ResearchDefaults = {
        maxSearches: readBounded(fields["maxSearches"], "maxSearches", problems) ?? base.maxSearches,
        maxCandidatesPerSearch:
          readBounded(fields["maxCandidatesPerSearch"], "maxCandidatesPerSearch", problems) ?? base.maxCandidatesPerSearch,
        maxReads: readBounded(fields["maxReads"], "maxReads", problems) ?? base.maxReads,
        maxGapRounds: readBounded(fields["maxGapRounds"], "maxGapRounds", problems) ?? base.maxGapRounds,
        deadlineMs: readBounded(fields["deadlineMs"], "deadlineMs", problems) ?? base.deadlineMs,
      };
      research = next;
    }
  }

  let providers = current.providers;
  if (record["providers"] !== undefined) {
    const read = readProviders(record["providers"], problems);
    if (read !== undefined) providers = read;
  }

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    value: {
      ...(research === undefined ? {} : { research }),
      ...(providers === undefined ? {} : { providers }),
    },
  };
}

/** What is in force now, with each field's provenance. */
export function settingsViewOf(stored: { readonly revision: number; readonly value: ProductSettingsValue } | undefined): ProductSettingsView {
  const value = stored?.value ?? {};
  return {
    revision: stored?.revision ?? 0,
    research: value.research ?? DEFAULT_RESEARCH_DEFAULTS,
    researchSource: value.research === undefined ? "product-default" : "saved",
    providers: value.providers ?? DEFAULT_PROVIDER_ORDER,
    providersSource: value.providers === undefined ? "product-default" : "saved",
    limits: BUDGET_LIMITS,
    providerChoices: RESEARCH_PROVIDERS,
  };
}

/**
 * The budget a new task is created with.
 *
 * It is a copy, not a reference: the task carries its own numbers from the
 * moment it exists, so a later change to the defaults cannot move them.
 */
export function budgetForNewTask(view: ProductSettingsView): ResearchBudget {
  return Object.freeze({
    maxSearches: view.research.maxSearches,
    maxCandidatesPerSearch: view.research.maxCandidatesPerSearch,
    maxReads: view.research.maxReads,
    maxGapRounds: view.research.maxGapRounds,
    deadlineMs: view.research.deadlineMs,
  });
}
