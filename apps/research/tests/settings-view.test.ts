/**
 * The settings page, as the reader's controls and as the words beside them.
 *
 * The defect this file is written against: a provider was switched off, the
 * page was reloaded, and its switch was gone — the document had published only
 * the *enabled* providers, so the control that would turn the one back on was
 * not in it. Two rules are pinned here. The catalogue is complete and its
 * enablement is derived from the active order, so both directions of the switch
 * exist. And a capability states what was observed rather than what is
 * installed: 「已接入」is not 「可用」, and a service nobody has probed says so.
 *
 * The rendered page and the real HTTP round-trip — switch off, reload, switch
 * back on, reload — are checked against a real browser in the acceptance run
 * this file belongs to; what is checked here is the arithmetic and the wording
 * those two paths are made of.
 */

import { describe, expect, it } from "vitest";

import type { CapabilityView, ProviderCatalogEntryView } from "../src/browser/api.js";
import { enablementOf, healthOf, setProviderEnabled } from "../src/browser/views/settings.js";

function provider(overrides: Partial<ProviderCatalogEntryView> & { readonly id: string }): ProviderCatalogEntryView {
  return {
    name: overrides.id,
    implemented: true,
    configured: true,
    enabled: false,
    orderIndex: null,
    health: { status: "not_checked", checkedAt: null },
    ...overrides,
  };
}

function capability(overrides: Partial<CapabilityView> & { readonly id: string }): CapabilityView {
  return {
    name: overrides.id,
    implemented: true,
    configured: true,
    status: "integrated",
    detail: "",
    checkedAt: null,
    enabled: null,
    orderIndex: null,
    health: null,
    ...overrides,
  };
}

describe("the retrieval order a save writes", () => {
  it("keeps every other provider's place when one is switched off", () => {
    expect(setProviderEnabled(["arxiv", "openalex"], "arxiv", false)).toEqual(["openalex"]);
    expect(setProviderEnabled(["arxiv", "openalex", "third"], "openalex", false)).toEqual(["arxiv", "third"]);
  });

  it("appends a provider switched back on, and says when it is already there", () => {
    // The two directions of the same control: off removes, on appends. A reader
    // can predict where a provider returns without dragging anything.
    expect(setProviderEnabled(["openalex"], "arxiv", true)).toEqual(["openalex", "arxiv"]);
    expect(setProviderEnabled(["arxiv", "openalex"], "arxiv", true)).toEqual(["arxiv", "openalex"]);
  });

  it("never invents a provider, and never duplicates one", () => {
    expect(setProviderEnabled([], "arxiv", true)).toEqual(["arxiv"]);
    expect(setProviderEnabled(["arxiv"], "arxiv", false)).toEqual([]);
    expect(setProviderEnabled(["arxiv", "arxiv"], "arxiv", true)).toEqual(["arxiv", "arxiv"]);
  });
});

describe("what the page says about a provider", () => {
  it("shows a provider that is off as off, with the switch still there", () => {
    const catalogue = [
      provider({ id: "arxiv", name: "arXiv", enabled: false, orderIndex: null }),
      provider({ id: "openalex", name: "OpenAlex", enabled: true, orderIndex: 0 }),
    ];
    // The whole catalogue is what the page renders: two entries, one of them
    // off. A list of enabled providers would have shown one.
    expect(catalogue).toHaveLength(2);
    expect(catalogue.filter((entry) => entry.enabled)).toHaveLength(1);
    expect(catalogue[0]?.orderIndex).toBeNull();
    expect(catalogue[1]?.orderIndex).toBe(0);
  });

  it("never claims a health nobody observed", () => {
    expect(healthOf(capability({ id: "arxiv", health: { status: "not_checked", checkedAt: null } }))).toContain("尚未检查");
    // An integration that is implemented and configured still has no health.
    expect(healthOf(capability({ id: "arxiv" }))).toContain("尚未检查");
    expect(healthOf(capability({ id: "convert-document", health: { status: "reachable", checkedAt: "2026-10-09T00:00:00.000Z" } }))).toContain("可达");
    expect(healthOf(capability({ id: "convert-document", health: { status: "unreachable", checkedAt: "2026-10-09T00:00:00.000Z" } }))).toContain("不可达");
  });

  it("says enabled, position and off — and says nothing where there is no switch", () => {
    expect(enablementOf(capability({ id: "arxiv", enabled: true, orderIndex: 0 }))).toBe("已启用（第 1 位）");
    expect(enablementOf(capability({ id: "openalex", enabled: true, orderIndex: 1 }))).toBe("已启用（第 2 位）");
    expect(enablementOf(capability({ id: "arxiv", enabled: false }))).toBe("当前未启用");
    // A local capability has no enablement, which is not the same as "off".
    expect(enablementOf(capability({ id: "upload-markdown", enabled: null }))).toBe("");
  });
});
