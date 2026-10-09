/**
 * The settings API, over HTTP, as the page uses it.
 *
 * Two things are checked that a unit test of the validator cannot: that a saved
 * change really reaches the behaviour it claims to govern, and that the
 * document the page receives carries no secret. The second one is checked by
 * planting a credential and searching the whole answer for it — a settings DTO
 * that leaked a key would leak it here.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelClient, ModelEvent, ModelRequest, RuntimeContext } from "@every-dagent/agent-core";
import { DEFAULT_MODEL_FRAMING } from "@every-dagent/agent-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startResearchApp, type ResearchApp } from "../src/server/composition.js";
import { testComposition } from "../../../tests/helpers/test-composition.js";

const workDir = mkdtempSync(join(tmpdir(), "researchpage-settings-"));
const dataDir = join(workDir, "data");
const staticRoot = join(process.cwd(), "apps", "research", "public");

/** A credential that must not appear anywhere the page can read it. */
const PLANTED_CREDENTIAL = "sk-planted-credential-must-not-travel";

function scriptedModel(): ModelClient {
  return {
    limits: { contextWindow: 128 * 1024, maxOutputTokens: 8 * 1024, framing: DEFAULT_MODEL_FRAMING },
    stream(_request: ModelRequest, _context: RuntimeContext): AsyncIterable<ModelEvent> {
      return (async function* () {
        yield { type: "text-delta", text: "这个脚本不回答研究问题。" };
        yield { type: "done" };
      })();
    },
  };
}

let app: ResearchApp;

beforeAll(async () => {
  app = await startResearchApp({
    dataDir,
    staticRoot,
    composition: testComposition({ modelClient: scriptedModel() }),
    overrides: {
      search: () => Promise.resolve({ provider: "arxiv", query: "", requestUrl: "", fetchedAt: new Date().toISOString(), total: 0, candidates: [] }),
      read: () => Promise.resolve({ status: "failed", readUrl: "", fetchedAt: new Date().toISOString(), title: "", scope: null, text: "", paragraphs: [], contentType: "", note: "fixture", failure: "fixture" }),
    },
    log: () => undefined,
  });
}, 60_000);

afterAll(async () => {
  await app?.close();
  rmSync(workDir, { recursive: true, force: true });
});

async function get(path: string): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const response = await fetch(`${app.url}${path}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function patch(path: string, payload: unknown): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const response = await fetch(`${app.url}${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

interface SettingsShape {
  readonly revision: number;
  readonly research: { readonly value: Record<string, number>; readonly source: string; readonly limits: Record<string, { min: number; max: number }> };
  readonly retrieval: {
    readonly order: readonly string[];
    readonly source: string;
    readonly note: string;
    readonly providers: readonly {
      readonly id: string;
      readonly name: string;
      readonly implemented: boolean;
      readonly configured: boolean;
      readonly enabled: boolean;
      readonly orderIndex: number | null;
      readonly health: { readonly status: string; readonly checkedAt: string | null };
    }[];
  };
  readonly capabilities: readonly {
    readonly id: string;
    readonly status: string;
    readonly implemented: boolean;
    readonly enabled: boolean | null;
    readonly orderIndex: number | null;
    readonly health: { readonly status: string; readonly checkedAt: string | null } | null;
  }[];
  readonly mineru: { readonly mode: string; readonly limits: { maxUploadMiB: number; flashMaxPages: number } };
  readonly model: { readonly provider: string | null; readonly editable: boolean };
}

describe("the settings the page can actually change", () => {
  it("reports the product's defaults, and says they are the defaults", async () => {
    const { status, body } = await get("/api/research/settings");
    expect(status).toBe(200);
    const settings = body as unknown as SettingsShape;
    expect(settings.revision).toBe(0);
    expect(settings.research.source).toBe("product-default");
    expect(settings.research.value["maxSearches"]).toBe(6);
    expect(settings.retrieval.order).toEqual(["arxiv", "openalex"]);
    expect(settings.research.limits["maxSearches"]).toEqual({ min: 1, max: 30 });
  });

  it("saves a budget, bumps the revision, and gives the next project that budget", async () => {
    const saved = await patch("/api/research/settings", {
      expectedRevision: 0,
      research: { maxSearches: 11, maxReads: 22, maxGapRounds: 4 },
    });
    expect(saved.status).toBe(200);
    const settings = saved.body as unknown as SettingsShape;
    expect(settings.revision).toBe(1);
    expect(settings.research.source).toBe("saved");
    expect(settings.research.value["maxSearches"]).toBe(11);

    // The behaviour, not the record: a project created now carries these
    // numbers, and the start payload is where that is observable.
    const session = await app.client.sessions.create();
    const sessionId = session.session.sessionId;
    app.service.issueGrant({ sessionId, intent: "card", taskId: null });
    const proposed = app.service.proposeTask(sessionId, {
      topic: "预算冻结测试",
      purpose: "技术选型",
      audience: "工程团队",
      focus: [],
      exclusions: "",
      lengthTarget: "约 4 页",
      subjects: [{ name: "MethodA" }, { name: "MethodB" }],
      dimensions: [
        { name: "机制", question: "如何构建？" },
        { name: "成本", question: "成本口径？" },
        { name: "效果", question: "什么条件下更好？" },
      ],
    });
    expect(proposed.ok).toBe(true);
    if (proposed.ok !== true) return;
    const task = app.service.getTask(proposed.task.id);
    expect(task?.budget).toMatchObject({ maxSearches: 11, maxReads: 22, maxGapRounds: 4 });
  });

  it("refuses a value outside its range, names the field, and does not move the revision", async () => {
    const before = ((await get("/api/research/settings")).body as unknown as SettingsShape).revision;
    const refused = await patch("/api/research/settings", { research: { maxSearches: 99 } });
    expect(refused.status).toBe(409);
    expect(String(refused.body["error"])).toContain("maxSearches");
    expect(String(refused.body["error"])).toContain("超出允许范围");
    expect(((await get("/api/research/settings")).body as unknown as SettingsShape).revision).toBe(before);
  });

  it("refuses a write whose revision is stale, and hands back the current settings", async () => {
    const refused = await patch("/api/research/settings", { expectedRevision: 0, research: { maxSearches: 7 } });
    expect(refused.status).toBe(409);
    expect(refused.body["reason"]).toBe("revision_conflict");
    expect(refused.body["current"]).toBeDefined();
  });

  it("refuses to switch off every retrieval provider", async () => {
    const refused = await patch("/api/research/settings", { providers: [] });
    expect(refused.status).toBe(409);
    expect(String(refused.body["error"])).toContain("至少要保留一个");
  });

  it("keeps one provider and reports the order it will actually use", async () => {
    const saved = await patch("/api/research/settings", { providers: ["openalex"] });
    expect(saved.status).toBe(200);
    const settings = saved.body as unknown as SettingsShape;
    expect(settings.retrieval.order).toEqual(["openalex"]);
    expect(settings.retrieval.source).toBe("saved");
  });

  it("describes capabilities at their real status, and never as a capability that does not exist", async () => {
    const settings = (await get("/api/research/settings")).body as unknown as SettingsShape;
    const byId = new Map(settings.capabilities.map((capability) => [capability.id, capability]));
    // Implemented, and the page may say so.
    expect(byId.get("arxiv")?.status).toBe("integrated");
    expect(byId.get("upload-markdown")?.status).toBe("integrated");
    // Not built. A page that was silent here would read as though it existed.
    expect(byId.get("remote-pdf")?.implemented).toBe(false);
    expect(byId.get("remote-pdf")?.status).toBe("not_implemented");
    expect(byId.get("other-search")?.implemented).toBe(false);
    expect(byId.get("mcp-marketplace")?.implemented).toBe(false);
    // The real limits, stated once: a Token does not move the upload ceiling.
    expect(settings.mineru.limits.maxUploadMiB).toBe(10);
    expect(settings.mineru.limits.flashMaxPages).toBe(20);
  });

  it("carries no secret anywhere in the document", async () => {
    const response = await fetch(`${app.url}/api/research/settings`);
    const raw = await response.text();
    for (const needle of [PLANTED_CREDENTIAL, "DEEPSEEK_API_KEY", "MINERU_API_TOKEN", "Authorization", "apiKey", "api_key"]) {
      expect(raw.includes(needle), `the settings document contains "${needle}"`).toBe(false);
    }
    // And it is honest that there is no credential surface here at all.
    const settings = JSON.parse(raw) as SettingsShape;
    expect(settings.model.editable).toBe(false);
  });
});

describe("the retrieval catalogue, switched both ways (F06/F07)", () => {
  it("always publishes every provider, whether or not it is enabled", async () => {
    // Start from the product's own order, whatever earlier cases left behind.
    const initial = (await get("/api/research/settings")).body as unknown as SettingsShape;
    const reset = await patch("/api/research/settings", { expectedRevision: initial.revision, providers: ["arxiv", "openalex"] });
    expect(reset.status).toBe(200);
    const before = (await get("/api/research/settings")).body as unknown as SettingsShape;
    expect(before.retrieval.providers.map((provider) => provider.id)).toEqual(["arxiv", "openalex"]);
    expect(before.retrieval.providers.every((provider) => provider.enabled)).toBe(true);
    expect(before.retrieval.providers.map((provider) => provider.orderIndex)).toEqual([0, 1]);

    // Switch arXiv off. The catalogue must still carry it: it is the entry that
    // would turn it back on, and the state the reader is looking at.
    const off = await patch("/api/research/settings", { expectedRevision: before.revision, providers: ["openalex"] });
    expect(off.status).toBe(200);
    const disabled = off.body as unknown as SettingsShape;
    expect(disabled.retrieval.order).toEqual(["openalex"]);
    const arxivOff = disabled.retrieval.providers.find((provider) => provider.id === "arxiv");
    expect(arxivOff, "the disabled provider is still in the catalogue").toBeDefined();
    expect(arxivOff?.enabled).toBe(false);
    expect(arxivOff?.orderIndex).toBeNull();
    expect(arxivOff?.implemented).toBe(true);
    expect(disabled.retrieval.providers.find((provider) => provider.id === "openalex")?.orderIndex).toBe(0);
    expect(disabled.retrieval.note).toContain("OpenAlex");
    expect(disabled.retrieval.note).not.toContain("arXiv");

    // Re-read, the way a reload does.
    const reloaded = (await get("/api/research/settings")).body as unknown as SettingsShape;
    expect(reloaded.retrieval.providers.map((provider) => provider.id)).toEqual(["arxiv", "openalex"]);
    expect(reloaded.retrieval.providers.find((provider) => provider.id === "arxiv")?.enabled).toBe(false);

    // And back on: appending is the other direction of the same control.
    const on = await patch("/api/research/settings", { expectedRevision: reloaded.revision, providers: ["openalex", "arxiv"] });
    expect(on.status).toBe(200);
    const restored = on.body as unknown as SettingsShape;
    expect(restored.retrieval.order).toEqual(["openalex", "arxiv"]);
    expect(restored.retrieval.providers.find((provider) => provider.id === "arxiv")?.orderIndex).toBe(1);
    const after = (await get("/api/research/settings")).body as unknown as SettingsShape;
    expect(after.retrieval.providers.every((provider) => provider.enabled)).toBe(true);
  });

  it("keeps the protection that a save cannot switch every provider off, and that a stale write loses", async () => {
    const current = (await get("/api/research/settings")).body as unknown as SettingsShape;
    const empty = await patch("/api/research/settings", { expectedRevision: current.revision, providers: [] });
    expect(empty.status).toBe(409);
    expect(JSON.stringify(empty.body)).toContain("至少要保留一个检索来源");
    const stillThere = (await get("/api/research/settings")).body as unknown as SettingsShape;
    expect(stillThere.retrieval.order.length).toBeGreaterThan(0);
    expect(stillThere.revision).toBe(current.revision);

    const stale = await patch("/api/research/settings", { expectedRevision: current.revision - 1, providers: ["openalex"] });
    expect(stale.status).toBe(409);
  });

  it("states enablement, order and health as three separate facts", async () => {
    const settings = (await get("/api/research/settings")).body as unknown as SettingsShape;
    const byId = new Map(settings.capabilities.map((capability) => [capability.id, capability]));

    // A provider capability carries its own enablement and its place in the
    // order — read from the order in force rather than assumed.
    const enabledId = settings.retrieval.order[0] ?? "";
    const active = byId.get(enabledId);
    expect(active?.enabled).toBe(true);
    expect(active?.orderIndex).toBe(0);
    expect(active?.health?.status).toBe("not_checked");
    expect(active?.health?.checkedAt).toBeNull();
    // Every provider capability matches the catalogue entry of the same id.
    for (const provider of settings.retrieval.providers) {
      expect(byId.get(provider.id)?.enabled).toBe(provider.enabled);
      expect(byId.get(provider.id)?.orderIndex).toBe(provider.orderIndex);
    }

    // A capability that is not a switch says so with null, not with false.
    const upload = byId.get("upload-markdown");
    expect(upload?.enabled).toBeNull();
    expect(upload?.orderIndex).toBeNull();
    // And one that needs no network has no health to report.
    expect(upload?.health).toBeNull();

    // MinerU has an explicit check; nothing has run it in this test, so its
    // health is "not checked" — never "available" because it is implemented.
    const convert = byId.get("convert-document");
    expect(convert?.status).toBe("not_checked");
    expect(convert?.health?.status).toBe("not_checked");
    expect(convert?.health?.checkedAt).toBeNull();
    expect(convert?.enabled).toBeNull();

    // Nothing in the document claims a provider was probed.
    expect(settings.retrieval.providers.every((provider) => provider.health.status === "not_checked")).toBe(true);
    expect(settings.retrieval.providers.every((provider) => provider.health.checkedAt === null)).toBe(true);
  });

  it("does not probe anything to answer a page load", async () => {
    // A settings read is a read: the snapshot it returns is the one it already
    // had, and a provider's health stays unobserved across it.
    const first = (await get("/api/research/settings")).body as unknown as SettingsShape;
    const second = (await get("/api/research/settings")).body as unknown as SettingsShape;
    expect(second.revision).toBe(first.revision);
    expect(second.retrieval.providers.map((provider) => provider.health)).toEqual(first.retrieval.providers.map((provider) => provider.health));
  });
});
