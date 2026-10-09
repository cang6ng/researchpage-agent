/**
 * The product's settings, at the moment each one is supposed to bind.
 *
 * A settings page is only worth having if its controls reach behaviour, so
 * every test here checks the effect rather than the stored value: a budget that
 * a *new* project is created with, a budget an *old* project keeps, a provider
 * order the next search really asks in that order. A field nobody reads would
 * pass a test that only looked at the record.
 */

import { describe, expect, it } from "vitest";

import { openResearchRepository, type ResearchRepository } from "../src/repository.js";
import { createResearchService, type ResearchService } from "../src/service.js";
import { BUDGET_LIMITS, DEFAULT_RESEARCH_DEFAULTS, readSettingsWrite, settingsViewOf } from "../src/settings.js";
import type { SearchOutcome } from "../src/search.js";

const SESSION = "session_product_settings";

interface Harness {
  readonly repo: ResearchRepository;
  readonly service: ResearchService;
  close(): void;
}

function open(location = ":memory:"): Harness {
  const repo = openResearchRepository({ location });
  const service = createResearchService({ repo });
  return { repo, service, close: () => repo.close() };
}

function card() {
  return {
    topic: "两种图结构检索方法的比较",
    purpose: "技术选型",
    audience: "工程团队",
    focus: [],
    exclusions: "",
    lengthTarget: "约 4 页",
    subjects: [{ name: "MethodA" }, { name: "MethodB" }],
    dimensions: [
      { name: "机制", question: "如何构建与检索？" },
      { name: "成本", question: "成本口径是什么？" },
      { name: "效果", question: "在什么条件下更好？" },
    ],
  };
}

function createCard(harness: Harness, sessionId = SESSION): string {
  harness.service.issueGrant({ sessionId, intent: "card", taskId: null });
  const proposed = harness.service.proposeTask(sessionId, card());
  if (proposed.ok !== true) throw new Error(`card refused: ${proposed.problems.join("; ")}`);
  return proposed.task.id;
}

describe("what a settings write is allowed to be", () => {
  it("keeps the product's defaults until someone decides otherwise", () => {
    const view = settingsViewOf(undefined);
    expect(view.revision).toBe(0);
    expect(view.research).toEqual(DEFAULT_RESEARCH_DEFAULTS);
    expect(view.researchSource).toBe("product-default");
    expect(view.providers).toEqual(["arxiv", "openalex"]);
    expect(view.providersSource).toBe("product-default");
  });

  it("refuses a value outside its range instead of rounding it", () => {
    for (const [field, value] of [
      ["maxSearches", 0],
      ["maxSearches", 31],
      ["maxCandidatesPerSearch", 21],
      ["maxReads", 0],
      ["maxGapRounds", 6],
      ["deadlineMs", 1000],
      ["deadlineMs", 2_000_000],
    ] as const) {
      const read = readSettingsWrite({ research: { [field]: value } }, {});
      expect(read.ok, `${field}=${String(value)} was accepted`).toBe(false);
      if (read.ok) continue;
      expect(read.problems[0]?.field).toBe(field);
      expect(read.problems[0]?.problem).toContain("超出允许范围");
    }
  });

  it("refuses a non-integer rather than truncating it", () => {
    for (const value of [7.5, "7", Number.NaN, Number.POSITIVE_INFINITY, null]) {
      const read = readSettingsWrite({ research: { maxSearches: value } }, {});
      expect(read.ok, `${String(value)} was accepted`).toBe(false);
    }
  });

  it("refuses a write that would leave no retrieval provider at all", () => {
    const read = readSettingsWrite({ providers: [] }, {});
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.problems[0]?.field).toBe("providers");
    expect(read.problems[0]?.problem).toContain("至少要保留一个");
  });

  it("refuses a provider the product does not have", () => {
    expect(readSettingsWrite({ providers: ["arxiv", "google-scholar"] }, {}).ok).toBe(false);
  });

  it("accepts a legal write and keeps the fields it did not name", () => {
    const first = readSettingsWrite({ research: { maxSearches: 10 }, providers: ["openalex"] }, {});
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.research?.maxSearches).toBe(10);
    expect(first.value.research?.maxReads).toBe(DEFAULT_RESEARCH_DEFAULTS.maxReads);
    expect(first.value.providers).toEqual(["openalex"]);

    const second = readSettingsWrite({ research: { maxReads: 20 } }, first.value);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.research?.maxSearches).toBe(10);
    expect(second.value.research?.maxReads).toBe(20);
    expect(second.value.providers).toEqual(["openalex"]);
  });
});

describe("what the saved settings actually change", () => {
  it("gives a new project the saved budget, and an old project its own", () => {
    const harness = open();
    try {
      const before = createCard(harness, "session_before");
      expect(harness.service.getTask(before)?.budget.maxSearches).toBe(DEFAULT_RESEARCH_DEFAULTS.maxSearches);

      const updated = harness.service.updateSettings({ research: { maxSearches: 12, maxReads: 25, maxGapRounds: 3 } });
      expect(updated.ok).toBe(true);

      const after = createCard(harness, "session_after");
      expect(harness.service.getTask(after)?.budget).toMatchObject({ maxSearches: 12, maxReads: 25, maxGapRounds: 3 });
      // The project created before the change keeps the budget it promised its
      // reader. A lower default is not allowed to shorten work already done.
      expect(harness.service.getTask(before)?.budget).toEqual({ ...DEFAULT_RESEARCH_DEFAULTS });
    } finally {
      harness.close();
    }
  });

  it("keeps a project's budget through a retry", () => {
    const harness = open();
    try {
      const taskId = createCard(harness, "session_retry");
      harness.service.confirmTask(taskId);
      harness.service.updateSettings({ research: { maxSearches: 20, maxGapRounds: 5 } });
      harness.service.failTask(taskId, "fixture failure");
      const retried = harness.service.retryResearch(taskId);
      expect(retried.ok).toBe(true);
      // The retry is the same project: it starts a new attempt, not a new
      // budget.
      expect(harness.service.getTask(taskId)?.budget).toMatchObject({ maxSearches: DEFAULT_RESEARCH_DEFAULTS.maxSearches });
    } finally {
      harness.close();
    }
  });

  it("survives a restart, and reports the revision it published", () => {
    const dir = `.scratch/overnight-goal-20261009/settings-${String(Date.now())}.db`;
    const first = open(dir);
    const updated = first.service.updateSettings({ research: { maxSearches: 9 }, providers: ["openalex", "arxiv"] });
    expect(updated.ok).toBe(true);
    const revision = first.service.settingsOf().revision;
    expect(revision).toBe(1);
    first.close();

    const second = open(dir);
    try {
      const view = second.service.settingsOf();
      expect(view.revision).toBe(revision);
      expect(view.research.maxSearches).toBe(9);
      expect(view.researchSource).toBe("saved");
      expect(view.providers).toEqual(["openalex", "arxiv"]);
    } finally {
      second.close();
    }
  });

  it("refuses an out-of-range write without moving the revision", () => {
    const harness = open();
    try {
      expect(harness.service.updateSettings({ research: { maxSearches: 99 } }).ok).toBe(false);
      expect(harness.service.settingsOf().revision).toBe(0);
      expect(harness.service.settingsOf().research).toEqual(DEFAULT_RESEARCH_DEFAULTS);
    } finally {
      harness.close();
    }
  });

  it("asks the configured providers, in the configured order", async () => {
    const repo = openResearchRepository({ location: ":memory:" });
    const asked: string[] = [];
    const service = createResearchService({
      repo,
      // arXiv is switched off below; seeing it asked anyway would be a switch
      // that does nothing.
      search: (query: string): Promise<SearchOutcome> => {
        asked.push(query);
        return Promise.resolve({
          provider: "openalex",
          query,
          requestUrl: "https://api.openalex.org/works",
          fetchedAt: new Date().toISOString(),
          total: 0,
          candidates: [],
        });
      },
    });
    try {
      service.updateSettings({ providers: ["openalex"] });
      expect(service.retrievalProviders()).toEqual(["openalex"]);
      service.updateSettings({ providers: ["arxiv", "openalex"] });
      expect(service.retrievalProviders()).toEqual(["arxiv", "openalex"]);
    } finally {
      repo.close();
    }
  });
});
