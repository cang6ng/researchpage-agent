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
  ResearchActivityEvent,
  ResearchRunRecord,
  Source,
  SupportAssessment,
} from "./domain.js";
import type { Proposal } from "./proposal.js";
import type { FrozenRevision } from "./revision.js";
import type { GuideQuestion } from "./brief.js";
import type { IntentDraft } from "./intent.js";
import type { ProductSettingsValue } from "./settings.js";
import type { StoredDocument } from "./documents.js";

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

/** How many activity lines one task keeps. Enough to read back a whole run. */
const ACTIVITY_LIMIT = 300;

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

  /**
   * The guided questions a task has asked, in the order they were asked.
   *
   * They are stored as records rather than kept as a transcript: a page that
   * was refreshed asks "which decisions has this brief already had?" and the
   * answer is the list, not a conversation.
   */
  saveGuideQuestion(question: GuideQuestion): void;
  getGuideQuestion(questionId: string): GuideQuestion | undefined;
  listGuideQuestions(taskId: string): readonly GuideQuestion[];

  saveExport(artifact: ExportArtifact): void;
  listExports(taskId: string): readonly ExportArtifact[];

  recordRun(record: ResearchRunRecord): void;
  listRuns(taskId: string): readonly ResearchRunRecord[];

  /**
   * Appends one line to a task's activity history.
   *
   * The history is bounded here rather than by its callers: this product needs
   *「刷新之后还看得见刚才发生了什么」, not a log retention policy, so only the
   * most recent lines of one task are kept.
   */
  appendActivity(event: ResearchActivityEvent): void;
  listActivity(taskId: string, limit?: number): readonly ResearchActivityEvent[];

  /**
   * One intent exploration per session: the conversation that precedes a task.
   *
   * It is stored under the session rather than under a task because it exists
   * *before* any task does — and because a conversation about what to research
   * must survive a page reload just as a research task does.
   */
  saveIntent(intent: IntentDraft): void;
  getIntent(intentId: string): IntentDraft | undefined;
  intentForSession(sessionId: string): IntentDraft | undefined;
  /** Removes an exploration that never got past its own first request. */
  deleteIntent(intentId: string): void;

  /**
   * The document library: what the user handed the product, and when.
   *
   * Documents are keyed by session and may be attached to a task later. Their
   * text lives in its own column for the same reason a read snapshot's does: it
   * is the large part, and every excerpt taken from it is checked against it.
   */
  addDocument(document: StoredDocument): void;
  getDocument(documentId: string): StoredDocument | undefined;
  listDocumentsBySession(sessionId: string): readonly StoredDocument[];
  listDocumentsForTask(taskId: string): readonly StoredDocument[];
  /** The documents whose ids are listed, in the order asked for. */
  listDocumentsByIds(documentIds: readonly string[]): readonly StoredDocument[];
  /** A document with the same bytes already in this session, if there is one. */
  findDocumentByHash(sessionId: string, contentHash: string): StoredDocument | undefined;
  updateDocument(document: StoredDocument): void;
  deleteDocument(documentId: string): void;

  /**
   * Runs several writes as one unit.
   *
   * The one place this product needs it is accepting a proposal, which writes
   * a report, advances the task and closes the proposal: a crash halfway
   * through would otherwise leave a task pointing at a report that was never
   * validated against it. Either every statement lands or none does.
   */
  transact<T>(work: () => T): T;

  /**
   * The product's own settings, and the revision they are at.
   *
   * `undefined` means nothing has ever been saved, which is not the same as
   * "the defaults were saved": the difference is what tells a reader whether
   * the numbers in force are the product's or theirs.
   */
  readProductSettings(): { readonly revision: number; readonly value: ProductSettingsValue } | undefined;
  /** Publishes a new revision. The caller has already validated it. */
  writeProductSettings(value: ProductSettingsValue, at: string): number;

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
CREATE TABLE IF NOT EXISTS brief_guide (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  status TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS brief_guide_task ON brief_guide (task_id);
CREATE TABLE IF NOT EXISTS research_activity (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS research_activity_task ON research_activity (task_id, at);
CREATE TABLE IF NOT EXISTS research_intents (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS research_intents_session ON research_intents (session_id);
CREATE TABLE IF NOT EXISTS research_documents (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  task_id TEXT,
  content_hash TEXT NOT NULL,
  markdown TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS research_documents_session ON research_documents (session_id);
CREATE INDEX IF NOT EXISTS research_documents_task ON research_documents (task_id);
CREATE INDEX IF NOT EXISTS research_documents_hash ON research_documents (session_id, content_hash);
CREATE TABLE IF NOT EXISTS product_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
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

  function documentByKey(documentId: string): StoredDocument | undefined {
    const row = database.prepare("SELECT markdown, payload FROM research_documents WHERE id = ?").get(documentId) as
      | { markdown: string; payload: string }
      | undefined;
    if (row === undefined) return undefined;
    return { ...readJson<Omit<StoredDocument, "markdown">>(row.payload), markdown: row.markdown };
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

    saveGuideQuestion(question: GuideQuestion): void {
      database
        .prepare(
          "INSERT INTO brief_guide (id, task_id, status, payload, created_at) VALUES (?, ?, ?, ?, ?)" +
            " ON CONFLICT(id) DO UPDATE SET status = excluded.status, payload = excluded.payload",
        )
        .run(question.id, question.taskId, question.status, JSON.stringify(question), question.createdAt);
    },
    getGuideQuestion(questionId: string): GuideQuestion | undefined {
      const row = database.prepare("SELECT payload FROM brief_guide WHERE id = ?").get(questionId) as
        | { payload: string }
        | undefined;
      return row === undefined ? undefined : readJson<GuideQuestion>(row.payload);
    },
    listGuideQuestions(taskId: string): readonly GuideQuestion[] {
      const rows = database
        .prepare("SELECT payload FROM brief_guide WHERE task_id = ? ORDER BY rowid ASC")
        .all(taskId) as { payload: string }[];
      return rows.map((row) => readJson<GuideQuestion>(row.payload));
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

    appendActivity(event: ResearchActivityEvent): void {
      database
        .prepare("INSERT INTO research_activity (id, task_id, payload, at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload")
        .run(event.id, event.taskId, JSON.stringify(event), event.at);
      // Keep the newest ACTIVITY_LIMIT lines: an activity history is for
      // reading back what just happened, and an unbounded one would grow with
      // every poll of a long-running project.
      database
        .prepare(
          "DELETE FROM research_activity WHERE task_id = ? AND id NOT IN (SELECT id FROM research_activity WHERE task_id = ? ORDER BY at DESC, rowid DESC LIMIT ?)",
        )
        .run(event.taskId, event.taskId, ACTIVITY_LIMIT);
    },
    listActivity(taskId: string, limit = ACTIVITY_LIMIT): readonly ResearchActivityEvent[] {
      const rows = database
        .prepare("SELECT payload FROM research_activity WHERE task_id = ? ORDER BY at DESC, rowid DESC LIMIT ?")
        .all(taskId, Math.max(1, Math.trunc(limit))) as { payload: string }[];
      return rows.map((row) => readJson<ResearchActivityEvent>(row.payload)).reverse();
    },

    saveIntent(intent: IntentDraft): void {
      database
        .prepare(
          "INSERT INTO research_intents (id, session_id, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?)" +
            " ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at",
        )
        .run(intent.id, intent.sessionId, JSON.stringify(intent), intent.createdAt, intent.updatedAt);
    },
    getIntent(intentId: string): IntentDraft | undefined {
      const row = database.prepare("SELECT payload FROM research_intents WHERE id = ?").get(intentId) as
        | { payload: string }
        | undefined;
      return row === undefined ? undefined : readJson<IntentDraft>(row.payload);
    },
    intentForSession(sessionId: string): IntentDraft | undefined {
      const row = database
        .prepare("SELECT payload FROM research_intents WHERE session_id = ? ORDER BY created_at DESC LIMIT 1")
        .get(sessionId) as { payload: string } | undefined;
      return row === undefined ? undefined : readJson<IntentDraft>(row.payload);
    },
    deleteIntent(intentId: string): void {
      database.prepare("DELETE FROM research_intents WHERE id = ?").run(intentId);
    },

    addDocument(document: StoredDocument): void {
      const { markdown, ...rest } = document;
      database
        .prepare(
          "INSERT INTO research_documents (id, session_id, task_id, content_hash, markdown, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          document.id,
          document.sessionId,
          document.taskId,
          document.contentHash,
          markdown,
          JSON.stringify(rest),
          document.createdAt,
        );
    },
    getDocument: documentByKey,
    listDocumentsBySession(sessionId: string): readonly StoredDocument[] {
      const rows = database
        .prepare("SELECT markdown, payload FROM research_documents WHERE session_id = ? ORDER BY created_at ASC, rowid ASC")
        .all(sessionId) as { markdown: string; payload: string }[];
      return rows.map((row) => ({ ...readJson<Omit<StoredDocument, "markdown">>(row.payload), markdown: row.markdown }));
    },
    listDocumentsForTask(taskId: string): readonly StoredDocument[] {
      const rows = database
        .prepare("SELECT markdown, payload FROM research_documents WHERE task_id = ? ORDER BY created_at ASC, rowid ASC")
        .all(taskId) as { markdown: string; payload: string }[];
      return rows.map((row) => ({ ...readJson<Omit<StoredDocument, "markdown">>(row.payload), markdown: row.markdown }));
    },
    listDocumentsByIds(documentIds: readonly string[]): readonly StoredDocument[] {
      const documents: StoredDocument[] = [];
      for (const documentId of documentIds) {
        const document = documentByKey(documentId);
        if (document !== undefined) documents.push(document);
      }
      return documents;
    },
    findDocumentByHash(sessionId: string, contentHash: string): StoredDocument | undefined {
      const row = database
        .prepare("SELECT markdown, payload FROM research_documents WHERE session_id = ? AND content_hash = ? ORDER BY rowid ASC LIMIT 1")
        .get(sessionId, contentHash) as { markdown: string; payload: string } | undefined;
      if (row === undefined) return undefined;
      return { ...readJson<Omit<StoredDocument, "markdown">>(row.payload), markdown: row.markdown };
    },
    updateDocument(document: StoredDocument): void {
      const { markdown, ...rest } = document;
      database
        .prepare("UPDATE research_documents SET task_id = ?, markdown = ?, payload = ? WHERE id = ?")
        .run(document.taskId, markdown, JSON.stringify(rest), document.id);
    },
    deleteDocument(documentId: string): void {
      database.prepare("DELETE FROM research_documents WHERE id = ?").run(documentId);
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

    readProductSettings() {
      const row = database.prepare("SELECT revision, payload FROM product_settings WHERE id = 1").get() as
        | { revision: number; payload: string }
        | undefined;
      return row === undefined ? undefined : { revision: row.revision, value: readJson<ProductSettingsValue>(row.payload) };
    },
    writeProductSettings(value: ProductSettingsValue, at: string): number {
      const current = database.prepare("SELECT revision FROM product_settings WHERE id = 1").get() as
        | { revision: number }
        | undefined;
      const revision = (current?.revision ?? 0) + 1;
      database
        .prepare(
          "INSERT INTO product_settings (id, revision, payload, updated_at) VALUES (1, ?, ?, ?) " +
            "ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, payload = excluded.payload, updated_at = excluded.updated_at",
        )
        .run(revision, JSON.stringify(value), at);
      return revision;
    },
    close(): void {
      database.close();
    },
  };
}
