/**
 * A4 + the product's core loop, over the real world: a real model driving the
 * research tools through a real host, with real arXiv traffic and a real
 * business database.
 *
 * What this test is for is the claim the product makes: the agent proposes a
 * task card, the user confirms it, the agent searches, reads something real,
 * keeps only excerpts that exist in the saved text, and reports coverage that
 * the program derived. It runs only when asked (`RESEARCHPAGE_REAL_NETWORK=1`
 * and a DeepSeek credential) because it spends money and time on purpose.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createClient } from "@every-dagent/client";
import { createPiAiComposition, explicitCredentials } from "@every-dagent/model-pi-ai";
import { openResearchRepository, createResearchService, createResearchPlugin, RESEARCH_SYSTEM_PROMPT } from "@every-dagent/plugin-research";
import { afterEach, describe, expect, it } from "vitest";

import { createHostPlatform, runSettled, waitFor } from "../helpers/platform.js";

const apiKey = process.env["DEEPSEEK_API_KEY"];
const enabled = process.env["RESEARCHPAGE_REAL_NETWORK"] === "1" && apiKey !== undefined;

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const closer of open.splice(0)) await closer.close();
});

describe.skipIf(!enabled)("research plugin over a real model", () => {
  it(
    "proposes a card, then searches and reads for real through the host",
    { timeout: 600_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "researchpage-a4-"));
      const repo = openResearchRepository({ location: join(dir, "research.db") });
      const service = createResearchService({
        repo,
        now: () => new Date(),
      });
      const { plugin, tools } = createResearchPlugin({ service });

      const models = builtinModels();
      const model = models.getModel("deepseek", process.env["E2E_MODEL"] ?? "deepseek-flash");
      expect(model, "no deepseek model in the catalogue").toBeDefined();

      const piAi = createPiAiComposition({
        models: [model!],
        streamSource: models,
        credentials: explicitCredentials({ deepseek: apiKey! }),
        maxTokens: 4_096,
      });

      const platform = await createHostPlatform({
        // The policy belongs to the composition: a host composed without one
        // classifies nothing and refuses every tool call, so the research tools
        // are allowed *here*, by the same object that vouches for the model.
        composition: {
          toolPolicy: { revision: 1, tools: tools.tools, decide: () => "allow" },
          validateModel: (value) => piAi.validateModel(value),
          compose: (input) => piAi.compose(input),
        },
        plugins: [plugin],
        persistence: { kind: "sqlite", location: join(dir, "host.db") },
        bootstrap: {
          // The approved loop profile, unraised: a research pass is several stage
          // runs precisely because one run may not spend more than this.
          host: { systemPrompt: RESEARCH_SYSTEM_PROMPT, loop: { maxSteps: 12, maxModelAttempts: 3 } },
          model: { provider: "deepseek", model: process.env["E2E_MODEL"] ?? "deepseek-flash" },
        },
      });
      open.push({
        close: async () => {
          await platform.shutdown();
          repo.close();
          rmSync(dir, { recursive: true, force: true });
        },
      });

      const client = createClient({ connect: () => platform.connect() });
      await client.connect();
      const enabledPlugin = await client.plugins.enable({ pluginId: "research" });
      expect(enabledPlugin.plugin.status).toBe("enabled");

      const { session } = await client.sessions.create();

      // Turn 1: a vague topic becomes a task card.
      const first = await client.runs.start({
        sessionId: session.sessionId,
        submissionId: "sub-card-1",
        text: "明天组会我要讲 GraphRAG 和它的代表工作，帮我整理一下。",
      });
      await waitFor(() => runSettled(client.getSnapshot(), first.run.runId), {
        timeoutMs: 180_000,
        what: "the card run to settle",
      });

      const task = service.taskForSession(session.sessionId);
      if (task === undefined) {
        const snapshot = client.getSnapshot();
        const run = snapshot.presentation?.runs.items.find((candidate) => candidate.runId === first.run.runId);
        const events = snapshot.presentation?.sessions.items ?? [];
        throw new Error(
          `the agent did not create a research task: run=${run?.status ?? "?"}/${run?.endReason ?? "?"} sessions=${
            events.length
          } lastText=${(snapshot.live[first.run.runId]?.live ?? [])
            .filter((item) => item.kind === "text")
            .map((item) => item.text)
            .join(" ")
            .slice(0, 200)}`,
        );
      }
      expect(task!.status).toBe("draft");
      expect(task!.subjects.length).toBeGreaterThanOrEqual(2);
      expect(task!.dimensions.length).toBeGreaterThanOrEqual(3);
      expect(task!.matrix.length).toBe(task!.subjects.length * task!.dimensions.length);
      console.log(
        `[a4] card: ${task!.topic} | subjects=${task!.subjects.map((s) => s.name).join("/")} | dims=${task!.dimensions
          .map((d) => d.name)
          .join("/")}`,
      );

      // The user confirms in the workspace (an application action, not a tool).
      service.confirmTask(task!.id);
      service.startResearch(task!.id);
      repo.updateTask({ ...service.getTask(task!.id)!, budget: { ...service.getTask(task!.id)!.budget, maxSearches: 2, maxReads: 2 } });
      // The application also mints the permission the run acts under: without a
      // grant the tools refuse to write, which is what this test would see if
      // the boundary were broken.
      service.issueGrant({ sessionId: session.sessionId, intent: "research", taskId: task!.id, allowResearch: true });

      // Turn 2: the agent researches for real.
      const second = await client.runs.start({
        sessionId: session.sessionId,
        submissionId: "sub-research-1",
        text: "任务卡已确认。请开始检索并读取来源，然后评估证据矩阵覆盖情况。先做一轮检索与两次读取。",
      });
      await waitFor(() => runSettled(client.getSnapshot(), second.run.runId), {
        timeoutMs: 480_000,
        what: "the research run to settle",
      });

      const sources = service.sourcesOf(task!.id);
      console.log(`[a4] sources=${sources.length} reads=${service.getTask(task!.id)!.usage.reads} searches=${service.getTask(task!.id)!.usage.searches}`);
      for (const source of sources) {
        console.log(`[a4]   ${source.readStatus}/${source.readScope ?? "-"} ${source.title.slice(0, 70)}`);
      }
      expect(sources.length, "no sources were registered").toBeGreaterThan(0);
      const read = sources.filter((source) => source.readStatus === "ok");
      expect(read.length, "nothing was really read").toBeGreaterThan(0);

      // Every stored excerpt must be exactly the saved text at its range.
      const evidence = service.evidenceOf(task!.id);
      expect(evidence.length, "no evidence was created").toBeGreaterThan(0);
      for (const item of evidence) {
        const text = service.snapshotTextOf(item.readId);
        expect(text, `snapshot missing for ${item.id}`).toBeDefined();
        expect(text!.slice(item.locator.charStart, item.locator.charEnd)).toBe(item.excerpt);
      }
      console.log(`[a4] evidence=${evidence.length} (all verified against saved reads)`);

      // The matrix is derived, not self-reported: material alone never reaches
      // "reviewed", and a reviewed cell always names the evidence it rests on.
      const cells = service.cellsOf(task!.id);
      const reviewed = cells.filter((cell) => cell.status === "reviewed");
      for (const cell of reviewed) {
        expect(cell.evidenceIds.length).toBeGreaterThan(0);
      }
      expect(cells.some((cell) => cell.status === "missing")).toBe(true);
      const counts = cells.reduce<Record<string, number>>((tally, cell) => {
        tally[cell.status] = (tally[cell.status] ?? 0) + 1;
        return tally;
      }, {});
      console.log(`[a4] matrix: ${JSON.stringify(counts)}`);
      console.log(`[a4] assessments=${service.assessmentsOf(task!.id).length}`);
    },
  );
});
