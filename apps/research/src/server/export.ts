/**
 * The application's PDF delivery: one frozen revision, one file on disk.
 *
 * Export is an application action rather than an agent tool on purpose — the
 * user asks for a file, and a file is not something a model should be able to
 * trigger as a side effect of thinking. What changed with revisions is *what*
 * gets exported: the document is rendered from the frozen dependency bundle, so
 * a file can never mix an old report's wording with today's sources, today's
 * matrix or today's gaps. Exporting a report that was never frozen freezes it
 * first, at that moment, and the artifact records which revision it came from.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { ExportArtifact, FrozenRevision, ResearchService } from "@every-dagent/plugin-research";
import { exportHtmlToPdf, ID_PREFIX, newId, renderReportHtml, renderRevisionHtml } from "@every-dagent/plugin-research";

export interface PdfExportOutcome {
  readonly ok: boolean;
  readonly failure: string;
  readonly artifact?: ExportArtifact;
  readonly path?: string;
  readonly revisionId?: string;
}

/**
 * The live preview of a working report.
 *
 * A preview is allowed to be live — it *is* the working draft — but it shows
 * the report's own gap snapshot, the same appendix the frozen export shows, so
 * the page and the file cannot disagree about what the document says.
 */
export function renderHtmlOf(service: ResearchService, taskId: string, reportId: string): string | undefined {
  const task = service.getTask(taskId);
  if (task === undefined) return undefined;
  const report = service.reportsOf(taskId).find((candidate) => candidate.id === reportId);
  if (report === undefined) return undefined;
  return renderReportHtml({
    task,
    report,
    sources: service.sourcesOf(taskId),
    evidence: service.evidenceOf(taskId),
    gaps: report.gapsAtSave ?? [],
    subjectNames: new Map(task.subjects.map((subject) => [subject.id, subject.name])),
    dimensionNames: new Map(task.dimensions.map((dimension) => [dimension.id, dimension.name])),
    generatedAt: new Date().toISOString(),
  });
}

export function reportHtmlFor(service: ResearchService, reportId: string): string | undefined {
  const report = service.listTasks().flatMap((task) => service.reportsOf(task.id)).find((candidate) => candidate.id === reportId);
  if (report === undefined) return undefined;
  return renderHtmlOf(service, report.taskId, report.id);
}

/** The HTML of a frozen revision, rendered from nothing but the bundle. */
export function revisionHtmlOf(service: ResearchService, revision: FrozenRevision): string {
  void service;
  return renderRevisionHtml({ revision });
}

/**
 * Exports one frozen revision to a PDF under `reportDir`.
 *
 * The caller must already have a revision: this function refuses to look up a
 * report's current state, which is the whole point of the split. Use
 * `exportTaskReportPdf` when the intent is "export whatever the current report
 * is" — that one freezes first and then comes here.
 */
export async function exportRevisionPdf(input: {
  readonly service: ResearchService;
  readonly reportDir: string;
  readonly revision: FrozenRevision;
  readonly browserPath?: string;
}): Promise<PdfExportOutcome> {
  const { revision } = input;
  const html = revisionHtmlOf(input.service, revision);
  mkdirSync(input.reportDir, { recursive: true });
  const outPath = join(input.reportDir, `${revision.taskId}-${revision.reportId}-R${revision.revision}.pdf`);
  const now = new Date().toISOString();
  const artifactId = newId(ID_PREFIX.export);

  const result = await exportHtmlToPdf({
    html,
    outPath,
    ...(input.browserPath === undefined ? {} : { browserPath: input.browserPath }),
  });

  const artifact: ExportArtifact = {
    id: artifactId,
    taskId: revision.taskId,
    reportId: revision.reportId,
    revisionId: revision.id,
    themeId: revision.themeId,
    rendererVersion: `${revision.renderer.name}@${revision.renderer.version}`,
    kind: "pdf",
    status: result.ok ? "exported" : "failed",
    path: result.ok ? result.path : null,
    bytes: result.ok ? result.bytes : 0,
    failure: result.ok ? null : result.failure,
    createdAt: now,
    updatedAt: now,
  };
  input.service.saveExport(artifact);

  return result.ok
    ? { ok: true, failure: "", artifact, path: result.path, revisionId: revision.id }
    : { ok: false, failure: result.failure, artifact, revisionId: revision.id };
}

/**
 * Exports a report, freezing it first when it has no revision yet.
 *
 * This is the workspace's "导出 PDF": the user asked for *this report*, and the
 * honest way to deliver it is to pin its dependencies at the moment of export
 * and render only from them. A report that already has a revision for its
 * current content reuses it, so re-exporting the same version produces the same
 * document.
 */
export async function exportTaskReportPdf(input: {
  readonly service: ResearchService;
  readonly reportDir: string;
  readonly taskId: string;
  readonly reportId?: string;
  readonly browserPath?: string;
}): Promise<PdfExportOutcome> {
  const task = input.service.getTask(input.taskId);
  if (task === undefined) return { ok: false, failure: "研究任务不存在" };
  const reportId = input.reportId ?? task.currentReportId;
  if (reportId === null) return { ok: false, failure: "当前任务还没有已保存的报告，无法导出" };

  const frozen = input.service.freezeRevision({ taskId: task.id, reportId });
  if (!frozen.ok) return { ok: false, failure: `冻结版本失败：${frozen.problems.join("；")}` };

  return exportRevisionPdf({
    service: input.service,
    reportDir: input.reportDir,
    revision: frozen.revision,
    ...(input.browserPath === undefined ? {} : { browserPath: input.browserPath }),
  });
}
