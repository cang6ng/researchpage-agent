/**
 * The demo run: the real product, real model, real network.
 *
 * This is the acceptance the competition is about — not a fixture. A topic goes
 * in through the application's own API; a real model drives the research tools
 * over real arXiv traffic; the sources that come back are read for real; the
 * matrix is derived from those reads; the report is written and validated
 * against them; and the PDF the user downloads is produced by a real browser.
 *
 * It runs only when asked (`RESEARCHPAGE_REAL_NETWORK=1` plus a DeepSeek
 * credential) because it spends money and minutes on purpose. Its assertions
 * are about facts a demo would be caught lying about: which sources were
 * really read, whether every excerpt exists in the saved text, whether the
 * report cites only evidence that exists, and whether the PDF is a real file.
 */

import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { startResearchApp } from "../src/server/composition.js";

const apiKey = process.env["DEEPSEEK_API_KEY"];
const enabled = process.env["RESEARCHPAGE_REAL_NETWORK"] === "1" && apiKey !== undefined;

const workDir = enabled ? mkdtempSync(join(tmpdir(), "researchpage-demo-")) : "";
let app: Awaited<ReturnType<typeof startResearchApp>> | undefined;

afterAll(async () => {
  await app?.close();
  if (workDir === "") return;
  // A failing demo run is exactly the run whose data is worth keeping: the
  // session events it wrote are the only record of what the model really did.
  if (process.env["RESEARCHPAGE_KEEP_ARTIFACTS"] !== undefined) {
    console.log(`[demo] artifacts kept at ${workDir}`);
    return;
  }
  rmSync(workDir, { recursive: true, force: true });
});

async function waitUntil(predicate: () => Promise<boolean>, what: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => {
      setTimeout(resolve, 1_000);
    });
  }
}

/**
 * The topic is the demo's one variable: the same product must research a
 * different subject through the same structure, which is what "the structure is
 * general" has to mean in practice.
 */
const DEMO_TOPIC = process.env["RESEARCHPAGE_DEMO_TOPIC"] ?? "帮我整理 GraphRAG 方法与代表论文，明天组会要用";

describe.skipIf(!enabled)(`the real demo run: ${DEMO_TOPIC.slice(0, 40)}`, () => {
  it(
    "researches a real topic end to end and delivers a real PDF",
    { timeout: 1_500_000 },
    async () => {
      app = await startResearchApp({
        dataDir: join(workDir, "data"),
        staticRoot: join(process.cwd(), "apps", "research", "public"),
        model: { provider: "deepseek", model: process.env["E2E_MODEL"] ?? "deepseek-flash" },
        credential: apiKey!,
        log: (message) => {
          console.log(message);
        },
      });
      const origin = app.pageOrigin;
      const get = async (path: string): Promise<string> => (await fetch(`${origin}${path}`)).text();
      const post = async (path: string, body: unknown): Promise<void> => {
        const response = await fetch(`${origin}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${await response.text()}`);
      };

      // 1. The topic, exactly as a user would type it.
      const started = (await (
        await fetch(`${origin}/api/research/tasks`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ topic: DEMO_TOPIC }),
        })
      ).json()) as { sessionId: string };
      expect(started.sessionId.length).toBeGreaterThan(0);

      await waitUntil(
        async () => {
          const state = JSON.parse(await get(`/api/research/sessions/${started.sessionId}`)) as {
            task: { task: { id: string; status: string } } | null;
          };
          return state.task !== null;
        },
        "the card stage to produce a task",
        300_000,
      );

      const state = JSON.parse(await get(`/api/research/sessions/${started.sessionId}`)) as {
        task: {
          task: { id: string; topic: string };
          subjects: readonly { name: string }[];
          dimensions: readonly { name: string }[];
        };
      };
      expect(state.task.subjects.length).toBeGreaterThanOrEqual(2);
      expect(state.task.dimensions.length).toBeGreaterThanOrEqual(3);
      console.log(`[demo] card: ${state.task.task.topic} | ${state.task.subjects.map((s) => s.name).join("/")} | ${state.task.dimensions.map((d) => d.name).join("/")}`);

      // 2. Confirm, and let the pass run: research, gap rounds, report, export.
      await post(`/api/research/tasks/${state.task.task.id}/confirm`, {});
      await waitUntil(
        async () => {
          const bundle = JSON.parse(await get(`/api/research/tasks/${state.task.task.id}`)) as {
            task: { status: string; error: string | null };
            busy: boolean;
            sources: readonly { title: string; readStatus: string; readScope: string | null; url: string }[];
            runs: readonly { stage: string; status: string }[];
          };
          console.log(
            `[demo] status=${bundle.task.status} busy=${String(bundle.busy)} runs=${bundle.runs.map((r) => `${r.stage}:${r.status}`).join(",")} reads=${
              bundle.sources.filter((s) => s.readStatus === "ok").length
            }`,
          );
          const done = bundle.task.status === "ready" || bundle.task.status === "failed";
          return done && !bundle.busy;
        },
        "the research pass to finish",
        1_200_000,
      );

      interface DemoBundle {
        readonly task: { readonly status: string; readonly error: string | null };
        readonly sources: readonly {
          readonly sourceId: string;
          readonly title: string;
          readonly url: string;
          readonly readStatus: string;
          readonly readScope: string | null;
        }[];
        readonly evidence: readonly { readonly evidenceId: string; readonly excerpt: string; readonly sourceId: string }[];
        readonly matrix: readonly { readonly status: string; readonly evidenceIds: readonly string[] }[];
        readonly reports: readonly {
          readonly reportId: string;
          readonly isCurrent: boolean;
          readonly title: string;
          readonly validation: { readonly ok: boolean };
          readonly claims: readonly { readonly evidenceIds: readonly string[] }[];
        }[];
        readonly exports: readonly { readonly exportId: string; readonly status: string; readonly bytes: number; readonly isCurrentReport: boolean }[];
        readonly currentReportId: string | null;
      }

      const bundle = JSON.parse(await get(`/api/research/tasks/${state.task.task.id}`)) as DemoBundle;
      expect(bundle.task.status, bundle.task.error ?? "").toBe("ready");

      // 3. Real sources, really read, scopes recorded.
      const read = bundle.sources.filter((source) => source.readStatus === "ok");
      expect(read.length, "the demo must read real sources").toBeGreaterThanOrEqual(1);
      expect(read.some((source) => source.url.includes("arxiv.org"))).toBe(true);
      for (const source of read) console.log(`[demo] read ${source.readScope}: ${source.title.slice(0, 80)}`);
      expect(read.some((source) => source.readScope === "full_text" || source.readScope === "body_excerpt")).toBe(true);

      // 4. Every excerpt is really in the text that was saved, and the matrix
      //    is derived from those excerpts.
      expect(bundle.evidence.length).toBeGreaterThan(0);
      for (const item of bundle.evidence) {
        const stored = app!.service.evidenceOf(state.task.task.id).find((candidate) => candidate.id === item.evidenceId);
        expect(stored).toBeDefined();
        const text = app!.service.snapshotTextOf(stored!.readId);
        expect(text).toBeDefined();
        expect(text!.slice(stored!.locator.charStart, stored!.locator.charEnd)).toBe(item.excerpt);
      }
      const sufficient = bundle.matrix.filter((cell) => cell.status === "sufficient");
      expect(sufficient.length).toBeGreaterThan(0);
      expect(sufficient.every((cell) => cell.evidenceIds.length > 0)).toBe(true);

      // 5. The report is validated and cites only evidence that exists.
      const report = bundle.reports.find((candidate) => candidate.isCurrent);
      expect(report, "a current report must exist").toBeDefined();
      expect(report!.validation.ok).toBe(true);
      const evidenceIds = new Set(bundle.evidence.map((item) => item.evidenceId));
      for (const claim of report!.claims) {
        for (const id of claim.evidenceIds) expect(evidenceIds.has(id)).toBe(true);
      }
      console.log(`[demo] report: ${report!.title} | claims=${report!.claims.length}`);

      // 6. A real PDF exists, downloaded from the product's own route.
      const exported = bundle.exports.filter((artifact) => artifact.status === "exported" && artifact.isCurrentReport);
      expect(exported.length, "the report must be exported as a PDF").toBeGreaterThan(0);
      expect(exported[0]!.bytes).toBeGreaterThan(20_000);
      const response = await fetch(`${origin}/api/research/exports/${exported[0]!.exportId}/file`);
      expect(response.status).toBe(200);
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(String.fromCharCode(...bytes.slice(0, 5))).toBe("%PDF-");
      const artifactPath = app!.service.exportsOf(state.task.task.id).find((a) => a.id === exported[0]!.exportId)?.path;
      expect(artifactPath).not.toBeNull();
      expect(existsSync(artifactPath!)).toBe(true);
      expect(statSync(artifactPath!).size).toBeGreaterThan(20_000);
      console.log(`[demo] PDF: ${artifactPath} (${String(exported[0]!.bytes)} bytes)`);
    },
  );
});
