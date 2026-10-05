/**
 * The research application's own SQLite store.
 *
 * It is deliberately a separate database from the host's: the host keeps
 * sessions, runs and history under its own schema, and the research product
 * keeps tasks, sources, read snapshots, evidence, reports and exports under
 * this one. Neither schema knows about the other; the only link is the trusted
 * session→task binding this store owns, which is how a tool call finds the task
 * its session is working on without ever trusting a model-supplied id.
 *
 * Rows are values plus a JSON payload: the queries this product makes are all
 * "by task" or "by id", so columns exist for the keys that are looked up and
 * the rest of the record travels as the document it is. Read snapshots keep
 * their text in their own table because they are the one genuinely large thing
 * here, and every evidence excerpt is checked against that text.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import type {
  Evidence,
  ExportArtifact,
  Report,
  ReportTask,
  ReadSnapshot,
  ResearchRunRecord,
  Source,
  SupportAssessment,
} from "./domain.js";
import type { Proposal } from "./proposal.js";
import type { FrozenRevision } from "./revision.js";

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

export interface ResearchRepository {
  /** The task a session is trusted to work on, if one is bound. */
  taskForSession(sessionId: string): ReportTask | undefined;
  bindSession(sessionId: string, taskId: string): void;
  createTask(task: ReportTask): void;
  getTask(taskId: string): ReportTask | undefined;
  listTasks(): readonly ReportTask[];
  updateTask(task: ReportTask): void;

  addSource(source: Source): void;
  getSource(sourceId: string): Source | undefined;
  listSources(taskId: string): readonly Source[];
  updateSource(source: Source): void;

  saveSnapshot(snapshot: ReadSnapshot): void;
  getSnapshot(readId: string): ReadSnapshot | undefined;

  addEvidence(evidence: Evidence): void;
  /** Replaces one evidence row in place — how a cell binding is added. */
  updateEvidence(evidence: Evidence): void;
  getEvidence(evidenceId: string): Evidence | undefined;
  listEvidence(taskId: string): readonly Evidence[];

  saveReport(report: Report): void;
  getReport(reportId: string): Report | undefined;
  listReports(taskId: string): readonly Report[];

  addAssessment(assessment: SupportAssessment): void;
  listAssessments(taskId: string): readonly SupportAssessment[];

  saveProposal(proposal: Proposal): void;
  getProposal(proposalId: string): Proposal | undefined;
  listProposals(taskId: string): readonly Proposal[];

  saveRevision(revision: FrozenRevision): void;
  getRevision(revisionId: string): FrozenRevision | undefined;
  listRevisions(taskId: string): readonly FrozenRevision[];

  saveExport(artifact: ExportArtifact): void;
  listExports(taskId: string): readonly ExportArtifact[];

  recordRun(record: ResearchRunRecord): void;
  listRuns(taskId: string): readonly ResearchRunRecord[];

  /**
   * Runs several writes as one unit.
   *
   * The one place this product needs it is accepting a proposal, which writes
   * a report, advances the task and closes the proposal: a crash halfway
   * through would otherwise leave a task pointing at a report that was never
   * validated against it. Either every statement lands or none does.
   */
  transact<T>(work: () => T): T;

  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS session_bindings (
  session_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS report_tasks (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS report_tasks_session ON report_tasks (session_id);
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sources_task ON sources (task_id);
CREATE TABLE IF NOT EXISTS read_snapshots (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  text TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS read_snapshots_task ON read_snapshots (task_id);
CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  excerpt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS evidence_task ON evidence (task_id);
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reports_task ON reports (task_id);
CREATE TABLE IF NOT EXISTS exports (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS exports_task ON exports (task_id);
CREATE TABLE IF NOT EXISTS research_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  started_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS research_runs_task ON research_runs (task_id);
CREATE TABLE IF NOT EXISTS support_assessments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS support_assessments_task ON support_assessments (task_id);
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  status TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS proposals_task ON proposals (task_id);
CREATE TABLE IF NOT EXISTS report_revisions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  report_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS report_revisions_task ON report_revisions (task_id);
`;

export function openResearchRepository(options: { readonly location: string }): ResearchRepository {
  const location = options.location;
  if (location !== ":memory:") {
    mkdirSync(dirname(location), { recursive: true });
  }
  const database = new DatabaseSync(location);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec(SCHEMA);

  const readJson = <T>(payload: string): T => JSON.parse(payload) as T;

  function taskByKey(taskId: string): ReportTask | undefined {
    const row = database.prepare("SELECT payload FROM report_tasks WHERE id = ?").get(taskId) as
      | { payload: string }
      | undefined;
    return row === undefined ? undefined : readJson<ReportTask>(row.payload);
  }

  return {
    taskForSession(sessionId: string): ReportTask | undefined {
      const binding = database
        .prepare("SELECT task_id FROM session_bindings WHERE session_id = ?")
        .get(sessionId) as { task_id: string } | undefined;
      if (binding === undefined) return undefined;
      return taskByKey(binding.task_id);
    },
    bindSession(sessionId: string, taskId: string): void {
      database
        .prepare("INSERT INTO session_bindings (session_id, task_id) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET task_id = excluded.task_id")
        .run(sessionId, taskId);
    },
    createTask(task: ReportTask): void {
      database
        .prepare("INSERT INTO report_tasks (id, session_id, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run(task.id, task.sessionId, JSON.stringify(task), task.createdAt, task.updatedAt);
    },
    getTask: taskByKey,
    listTasks(): readonly ReportTask[] {
      const rows = database
        .prepare("SELECT payload FROM report_tasks ORDER BY created_at DESC")
        .all() as { payload: string }[];
      return rows.map((row) => readJson<ReportTask>(row.payload));
    },
    updateTask(task: ReportTask): void {
      database
        .prepare("UPDATE report_tasks SET payload = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(task), task.updatedAt, task.id);
    },

    addSource(source: Source): void {
      database
        .prepare("INSERT INTO sources (id, task_id, payload) VALUES (?, ?, ?)")
        .run(source.id, source.taskId, JSON.stringify(source));
    },
    getSource(sourceId: string): Source | undefined {
      const row = database.prepare("SELECT payload FROM sources WHERE id = ?").get(sourceId) as
        | { payload: string }
        | undefined;
      return row === undefined ? undefined : readJson<Source>(row.payload);
    },
    listSources(taskId: string): readonly Source[] {
      const rows = database
        .prepare("SELECT payload FROM sources WHERE task_id = ? ORDER BY rowid ASC")
        .all(taskId) as { payload: string }[];
      return rows.map((row) => readJson<Source>(row.payload));
    },
    updateSource(source: Source): void {
      database.prepare("UPDATE sources SET payload = ? WHERE id = ?").run(JSON.stringify(source), source.id);
    },

    saveSnapshot(snapshot: ReadSnapshot): void {
      const { text, ...rest } = snapshot;
      database
        .prepare("INSERT INTO read_snapshots (id, task_id, source_id, text, payload) VALUES (?, ?, ?, ?, ?)")
        .run(snapshot.id, snapshot.taskId, snapshot.sourceId, text, JSON.stringify(rest));
    },
    getSnapshot(readId: string): ReadSnapshot | undefined {
      const row = database
        .prepare("SELECT text, payload FROM read_snapshots WHERE id = ?")
        .get(readId) as { text: string; payload: string } | undefined;
      if (row === undefined) return undefined;
      return { ...readJson<Omit<ReadSnapshot, "text">>(row.payload), text: row.text };
    },

    addEvidence(evidence: Evidence): void {
      database
        .prepare("INSERT INTO evidence (id, task_id, source_id, payload, excerpt) VALUES (?, ?, ?, ?, ?)")
        .run(evidence.id, evidence.taskId, evidence.sourceId, JSON.stringify(evidence), evidence.excerpt);
    },
    updateEvidence(evidence: Evidence): void {
      database
        .prepare("UPDATE evidence SET payload = ? WHERE id = ?")
        .run(JSON.stringify(evidence), evidence.id);
    },
    getEvidence(evidenceId: string): Evidence | undefined {
      const row = database.prepare("SELECT payload FROM evidence WHERE id = ?").get(evidenceId) as
        | { payload: string }
        | undefined;
      return row === undefined ? undefined : readJson<Evidence>(row.payload);
    },
    listEvidence(taskId: string): readonly Evidence[] {
      const rows = database
        .prepare("SELECT payload FROM evidence WHERE task_id = ? ORDER BY rowid ASC")
        .all(taskId) as { payload: string }[];
      return rows.map((row) => readJson<Evidence>(row.payload));
    },

    saveReport(report: Report): void {
      database
        .prepare(
          "INSERT INTO reports (id, task_id, payload, created_at) VALUES (?, ?, ?, ?)" +
            " ON CONFLICT(id) DO UPDATE SET payload = excluded.payload",
        )
        .run(report.id, report.taskId, JSON.stringify(report), report.createdAt);
    },
    getReport(reportId: string): Report | undefined {
      const row = database.prepare("SELECT payload FROM reports WHERE id = ?").get(reportId) as
        | { payload: string }
        | undefined;
      return row === undefined ? undefined : readJson<Report>(row.payload);
    },
    listReports(taskId: string): readonly Report[] {
      const rows = database
        .prepare("SELECT payload FROM reports WHERE task_id = ? ORDER BY created_at ASC")
        .all(taskId) as { payload: string }[];
      return rows.map((row) => readJson<Report>(row.payload));
    },

    addAssessment(assessment: SupportAssessment): void {
      database
        .prepare("INSERT INTO support_assessments (id, task_id, payload, created_at) VALUES (?, ?, ?, ?)")
        .run(assessment.id, assessment.taskId, JSON.stringify(assessment), assessment.createdAt);
    },
    listAssessments(taskId: string): readonly SupportAssessment[] {
      const rows = database
        .prepare("SELECT payload FROM support_assessments WHERE task_id = ? ORDER BY rowid ASC")
        .all(taskId) as { payload: string }[];
      return rows.map((row) => readJson<SupportAssessment>(row.payload));
    },

    saveProposal(proposal: Proposal): void {
      database
        .prepare(
          "INSERT INTO proposals (id, task_id, status, payload, created_at) VALUES (?, ?, ?, ?, ?)" +
            " ON CONFLICT(id) DO UPDATE SET status = excluded.status, payload = excluded.payload",
        )
        .run(proposal.id, proposal.taskId, proposal.status, JSON.stringify(proposal), proposal.createdAt);
    },
    getProposal(proposalId: string): Proposal | undefined {
      const row = database.prepare("SELECT payload FROM proposals WHERE id = ?").get(proposalId) as
        | { payload: string }
        | undefined;
      return row === undefined ? undefined : readJson<Proposal>(row.payload);
    },
    listProposals(taskId: string): readonly Proposal[] {
      const rows = database
        .prepare("SELECT payload FROM proposals WHERE task_id = ? ORDER BY rowid ASC")
        .all(taskId) as { payload: string }[];
      return rows.map((row) => readJson<Proposal>(row.payload));
    },

    saveRevision(revision: FrozenRevision): void {
      database
        .prepare("INSERT INTO report_revisions (id, task_id, report_id, payload, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(revision.id, revision.taskId, revision.reportId, JSON.stringify(revision), revision.createdAt);
    },
    getRevision(revisionId: string): FrozenRevision | undefined {
      const row = database.prepare("SELECT payload FROM report_revisions WHERE id = ?").get(revisionId) as
        | { payload: string }
        | undefined;
      return row === undefined ? undefined : readJson<FrozenRevision>(row.payload);
    },
    listRevisions(taskId: string): readonly FrozenRevision[] {
      const rows = database
        .prepare("SELECT payload FROM report_revisions WHERE task_id = ? ORDER BY rowid ASC")
        .all(taskId) as { payload: string }[];
      return rows.map((row) => readJson<FrozenRevision>(row.payload));
    },

    saveExport(artifact: ExportArtifact): void {
      database
        .prepare(
          "INSERT INTO exports (id, task_id, payload) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload",
        )
        .run(artifact.id, artifact.taskId, JSON.stringify(artifact));
    },
    listExports(taskId: string): readonly ExportArtifact[] {
      const rows = database
        .prepare("SELECT payload FROM exports WHERE task_id = ? ORDER BY rowid ASC")
        .all(taskId) as { payload: string }[];
      return rows.map((row) => readJson<ExportArtifact>(row.payload));
    },

    recordRun(record: ResearchRunRecord): void {
      database
        .prepare(
          "INSERT INTO research_runs (id, task_id, payload, started_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload",
        )
        .run(record.id, record.taskId, JSON.stringify(record), record.startedAt);
    },
    listRuns(taskId: string): readonly ResearchRunRecord[] {
      const rows = database
        .prepare("SELECT payload FROM research_runs WHERE task_id = ? ORDER BY started_at ASC")
        .all(taskId) as { payload: string }[];
      return rows.map((row) => readJson<ResearchRunRecord>(row.payload));
    },

    transact<T>(work: () => T): T {
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = work();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },

    close(): void {
      database.close();
    },
  };
}
