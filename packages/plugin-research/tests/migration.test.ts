/**
 * Opening a database that an older version of the product wrote.
 *
 * The demo has real research in it, and a schema change is not a reason to make
 * it unreadable. What this test pins is the pair of promises the migration
 * makes: a task, its sources, evidence, report and export stay readable, and
 * none of them is *promoted* — a cell an older version called `sufficient`
 * reads back as `unassessed`, because the product no longer treats "a passage
 * exists" as "somebody judged it".
 *
 * The legacy database is built here from the old schema directly, so the test
 * does not depend on whatever happens to be on this machine.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { openResearchRepository } from "../src/repository.js";
import { createResearchService } from "../src/service.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The tables exactly as they stood before editing semantics were added. */
const LEGACY_SCHEMA = `
CREATE TABLE session_bindings (session_id TEXT PRIMARY KEY, task_id TEXT NOT NULL);
CREATE TABLE report_tasks (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE sources (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE read_snapshots (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, source_id TEXT NOT NULL, text TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE evidence (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, source_id TEXT NOT NULL, payload TEXT NOT NULL, excerpt TEXT NOT NULL);
CREATE TABLE reports (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE exports (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE research_runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, payload TEXT NOT NULL, started_at TEXT NOT NULL);
`;

const AT = "2026-10-04T10:00:00.000Z";
const TEXT = "GraphRAG builds a knowledge graph over the corpus and pre-generates community summaries for global questions.";

function writeLegacyDatabase(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(LEGACY_SCHEMA);

  const task = {
    id: "task_legacy00000001",
    sessionId: "session_legacy",
    topic: "GraphRAG 方法与代表工作",
    purpose: "组会汇报",
    audience: "研究生",
    focus: ["机制"],
    exclusions: "",
    language: "zh",
    lengthTarget: "约 4 页",
    status: "ready",
    confirmedAt: AT,
    structure: { sections: [{ id: "overview", title: "一", question: "q" }] },
    subjects: [
      { id: "sub_graphrag", name: "GraphRAG" },
      { id: "sub_lightrag", name: "LightRAG" },
    ],
    dimensions: [{ id: "dim_build", name: "结构与构建", question: "如何构建" }],
    // The old vocabulary: a body passage made a cell "sufficient".
    matrix: [
      {
        sectionId: "comparison",
        subjectId: "sub_graphrag",
        dimensionId: "dim_build",
        status: "sufficient",
        evidenceIds: ["ev_legacy00000001"],
        reason: "已有 1 条来自实际正文的片段",
        gap: "",
        note: "",
        updatedAt: AT,
      },
      {
        sectionId: "comparison",
        subjectId: "sub_lightrag",
        dimensionId: "dim_build",
        status: "missing",
        evidenceIds: [],
        reason: "尚无绑定到该单元格的证据",
        gap: "还没有读取",
        note: "",
        updatedAt: AT,
      },
    ],
    budget: { maxSearches: 6, maxCandidatesPerSearch: 5, maxReads: 10, maxGapRounds: 2, deadlineMs: 480000 },
    usage: { searches: 1, reads: 1, gapRounds: 1, startedAt: AT },
    currentReportId: "rep_legacy00000001",
    reportDraft: null,
    createdAt: AT,
    updatedAt: AT,
    error: null,
  };
  const source = {
    id: "src_legacy00000001",
    taskId: task.id,
    title: "From Local to Global: A GraphRAG Approach",
    authors: ["D. Edge"],
    org: "",
    url: "https://arxiv.org/abs/2404.16130",
    pdfUrl: null,
    doi: null,
    publishedAt: "2024-04-24T00:00:00Z",
    venue: "arXiv",
    abstract: "",
    discovery: { provider: "arxiv", query: "graphrag", queriedAt: AT, target: null },
    readStatus: "ok",
    readScope: "full_text",
    readAt: AT,
    readUrl: "https://arxiv.org/html/2404.16130",
    retrievalNote: "",
    failure: null,
    snapshotId: "read_legacy00000001",
  };
  const snapshot = {
    id: "read_legacy00000001",
    taskId: task.id,
    sourceId: source.id,
    url: source.readUrl,
    fetchedAt: AT,
    scope: "full_text",
    title: source.title,
    paragraphs: [{ index: 0, headingPath: ["Abstract"], text: TEXT, charStart: 0, charEnd: TEXT.length }],
    note: "",
  };
  const evidence = {
    id: "ev_legacy00000001",
    taskId: task.id,
    sourceId: source.id,
    readId: snapshot.id,
    excerpt: TEXT,
    locator: { paragraphIndex: 0, headingPath: ["Abstract"], charStart: 0, charEnd: TEXT.length },
    readScope: "full_text",
    cells: [{ sectionId: "comparison", subjectId: "sub_graphrag", dimensionId: "dim_build" }],
    pickedBecause: "test",
    createdAt: AT,
  };
  // A report written before reports carried a hash or their own gap snapshot.
  const report = {
    id: "rep_legacy00000001",
    taskId: task.id,
    title: "GraphRAG 机制与构建",
    summary: "旧版记录，依赖未冻结。",
    sections: [{ id: "overview", title: "一、研究任务与关键认识", blocks: [{ kind: "paragraph", text: "旧的正文。", claimIds: ["clm_legacy0000000"] }] }],
    claims: [{ id: "clm_legacy0000000", text: "GraphRAG 构建知识图谱与社区摘要。", evidenceIds: [evidence.id], kind: "fact" }],
    validation: { ok: true, problems: [], checkedAt: AT },
    createdAt: AT,
  };

  db.prepare("INSERT INTO session_bindings (session_id, task_id) VALUES (?, ?)").run(task.sessionId, task.id);
  db.prepare("INSERT INTO report_tasks (id, session_id, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
    task.id,
    task.sessionId,
    JSON.stringify(task),
    AT,
    AT,
  );
  db.prepare("INSERT INTO sources (id, task_id, payload) VALUES (?, ?, ?)").run(source.id, task.id, JSON.stringify(source));
  db.prepare("INSERT INTO read_snapshots (id, task_id, source_id, text, payload) VALUES (?, ?, ?, ?, ?)").run(
    snapshot.id,
    task.id,
    source.id,
    TEXT,
    JSON.stringify({ ...snapshot, text: undefined }),
  );
  db.prepare("INSERT INTO evidence (id, task_id, source_id, payload, excerpt) VALUES (?, ?, ?, ?, ?)").run(
    evidence.id,
    task.id,
    source.id,
    JSON.stringify(evidence),
    evidence.excerpt,
  );
  db.prepare("INSERT INTO reports (id, task_id, payload, created_at) VALUES (?, ?, ?, ?)").run(
    report.id,
    task.id,
    JSON.stringify(report),
    AT,
  );
  db.prepare("INSERT INTO exports (id, task_id, payload) VALUES (?, ?, ?)").run(
    "exp_legacy00000001",
    task.id,
    JSON.stringify({
      id: "exp_legacy00000001",
      taskId: task.id,
      reportId: report.id,
      kind: "pdf",
      status: "exported",
      path: "C:/tmp/legacy.pdf",
      bytes: 1234,
      failure: null,
      createdAt: AT,
      updatedAt: AT,
    }),
  );
  db.prepare("INSERT INTO research_runs (id, task_id, payload, started_at) VALUES (?, ?, ?, ?)").run(
    "jrn_legacy00000001",
    task.id,
    JSON.stringify({
      id: "jrn_legacy00000001",
      taskId: task.id,
      stage: "followup",
      runId: null,
      status: "completed",
      startedAt: AT,
      endedAt: AT,
      note: "旧阶段的记录",
      activity: [],
    }),
    AT,
  );
  db.close();
}

describe("opening a database written before editing semantics", () => {
  it("keeps every record readable and adds the new tables", () => {
    const dir = mkdtempSync(join(tmpdir(), "researchpage-migration-"));
    dirs.push(dir);
    const location = join(dir, "research.db");
    writeLegacyDatabase(location);

    const repo = openResearchRepository({ location });
    try {
      const task = repo.getTask("task_legacy00000001");
      expect(task, "the existing task must open").toBeDefined();
      expect(task?.topic).toContain("GraphRAG");
      expect(task?.currentReportId).toBe("rep_legacy00000001");

      expect(repo.listSources(task!.id).length).toBe(1);
      expect(repo.listEvidence(task!.id).length).toBe(1);
      expect(repo.getSnapshot("read_legacy00000001")?.text).toBe(TEXT);
      expect(repo.listExports(task!.id).length).toBe(1);
      expect(repo.listRuns(task!.id).map((run) => run.stage)).toEqual(["followup"]);

      // The new tables exist and are empty: nothing was back-filled, because
      // there is nothing honest to back-fill them with.
      expect(repo.listAssessments(task!.id).length).toBe(0);
      expect(repo.listProposals(task!.id).length).toBe(0);
      expect(repo.listRevisions(task!.id).length).toBe(0);
    } finally {
      repo.close();
    }
  });

  it("does not promote a legacy 'sufficient' cell into a reviewed one", () => {
    const dir = mkdtempSync(join(tmpdir(), "researchpage-migration-"));
    dirs.push(dir);
    const location = join(dir, "research.db");
    writeLegacyDatabase(location);
    const repo = openResearchRepository({ location });
    const service = createResearchService({ repo });
    try {
      const cells = service.cellsOf("task_legacy00000001");
      const previouslySufficient = cells.find((cell) => cell.subjectId === "sub_graphrag");
      expect(previouslySufficient?.status).toBe("unassessed");
      expect(previouslySufficient?.gap.length).toBeGreaterThan(0);
      expect(cells.find((cell) => cell.subjectId === "sub_lightrag")?.status).toBe("missing");

      const state = service.state("task_legacy00000001");
      expect(state.cells.every((cell) => cell.status !== ("sufficient" as never))).toBe(true);
    } finally {
      repo.close();
    }

    // A legacy report can be frozen from what is confirmable now, and the
    // revision says plainly that the old record carried no gap snapshot.
    const repo2 = openResearchRepository({ location });
    const service2 = createResearchService({ repo: repo2 });
    try {
      const frozen = service2.freezeRevision({ taskId: "task_legacy00000001" });
      expect(frozen.ok).toBe(true);
      if (!frozen.ok) return;
      expect(frozen.revision.gapsCaptured).toBe(false);
      expect(frozen.revision.contentHash.startsWith("sha256:")).toBe(true);
      expect(frozen.revision.evidenceRefs.length).toBe(1);
    } finally {
      repo2.close();
    }
  });

  it("refuses to freeze a legacy report whose content moved on", () => {
    const dir = mkdtempSync(join(tmpdir(), "researchpage-migration-"));
    dirs.push(dir);
    const location = join(dir, "research.db");
    writeLegacyDatabase(location);
    const repo = openResearchRepository({ location });
    const service = createResearchService({ repo });
    try {
      const refused = service.freezeRevision({
        taskId: "task_legacy00000001",
        expectedContentHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      });
      expect(refused.ok).toBe(false);
      expect(service.revisionsOf("task_legacy00000001").length).toBe(0);
    } finally {
      repo.close();
    }
  });
});
