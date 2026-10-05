/**
 * What the product's build actually produced.
 *
 * The page and the server are one repository and two runtimes, and the boundary
 * between them is the point: the page must not be able to reach a host, a
 * provider adapter, the plugin or a node builtin, and the server bundle must
 * really contain the research package and the host it composes. Both claims are
 * checked against esbuild's own metafile — the artifact — rather than against
 * the source tree, and the page file is also read as inert text for the two
 * things that must never appear in it: a credential-shaped name and a server
 * entry point.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildResearchApp } from "../scripts/build.mjs";

const outDir = mkdtempSync(join(tmpdir(), "researchpage-bundle-"));
let result: Awaited<ReturnType<typeof buildResearchApp>>;

function inputsOf(metafile: { readonly inputs: Readonly<Record<string, unknown>> }): string[] {
  return Object.keys(metafile.inputs).map((file) => file.replace(/\\/g, "/"));
}

beforeAll(async () => {
  result = await buildResearchApp({ outDir });
}, 120_000);

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

describe("the workspace page bundle", () => {
  it("carries the workspace and React, and nothing of the server", () => {
    const inputs = inputsOf(result.browserMetafile);
    expect(inputs.some((file) => file.endsWith("apps/research/src/browser/main.tsx"))).toBe(true);
    expect(inputs.some((file) => file.includes("node_modules/react/"))).toBe(true);

    const forbidden = [
      /packages\/(host|agent-core|plugin-system|plugin-research|model-pi-ai)\//,
      /apps\/research\/src\/server\//,
      /apps\/research\/tests\//,
      /^node:/,
      /pi-ai/,
    ];
    for (const pattern of forbidden) {
      expect(inputs.filter((file) => pattern.test(file)), `page bundle must not include ${pattern}`).toEqual([]);
    }
  });

  it("reads as an asset: no server entry points and no credential surface", () => {
    const app = readFileSync(join(outDir, "public", "app.js"), "utf8");
    expect(app).not.toContain("startResearchApp");
    expect(app).not.toContain("createHost");
    expect(app).not.toContain("pi-ai");
    for (const name of ["apiKey", "DEEPSEEK", "OPENAI", "process.env"]) {
      expect(app, `the page bundle must not mention ${name}`).not.toContain(name);
    }
    // The page reaches the product only through its own routes.
    expect(app).toContain("/api/research/tasks");
  });
});

describe("the research server bundle", () => {
  it("contains the host, the research package and the product's own composition", () => {
    const inputs = inputsOf(result.serverMetafile);
    expect(inputs.some((file) => file.endsWith("apps/research/src/server/main.ts"))).toBe(true);
    expect(inputs.some((file) => file.includes("packages/host/src/"))).toBe(true);
    expect(inputs.some((file) => file.includes("packages/plugin-research/src/"))).toBe(true);
    expect(inputs.some((file) => file.includes("packages/model-pi-ai/src/"))).toBe(true);
    expect(inputs.some((file) => file.includes("node_modules/@earendil-works/pi-ai/"))).toBe(true);
  });
});
