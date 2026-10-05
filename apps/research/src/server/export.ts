/**
 * The application's PDF delivery: one report snapshot, one file on disk.
 *
 * Export is an application action rather than an agent tool on purpose — the
 * user asks for a file, and a file is not something a model should be able to
 * trigger as a side effect of thinking. The artifact this writes is recorded
 * with its path and byte count, and a failed export is a `failed` artifact with
 * its reason kept, so "导出成功" is always a claim about a file that exists.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { ExportArtifact, ResearchService } from "@every-dagent/plugin-research";
import { exportHtmlToPdf, ID_PREFIX, newId, renderReportHtml } from "@every-dagent/plugin-research";

export interface PdfExportOutcome {
  readonly ok: boolean;
  readonly failure: string;
  readonly artifact?: ExportArtifact;
  readonly path?: string;
}

export function reportHtmlFor(service: ResearchService, reportId: string): string | undefined {
  const report = service.listTasks().flatMap((task) => service.reportsOf(task.id)).find((candidate) => candidate.id === reportId);
  if (report === undefined) return undefined;
  return renderHtmlOf(service, report.taskId, report.id);
}

/** Renders the current report of a task, with its real sources and evidence. */
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
    gaps: task.matrix.filter((cell) => cell.status !== "sufficient"),
    subjectNames: new Map(task.subjects.map((subject) => [subject.id, subject.name])),
    dimensionNames: new Map(task.dimensions.map((dimension) => [dimension.id, dimension.name])),
    generatedAt: new Date().toISOString(),
  });
}

/**
 * Exports the task's current report to a PDF under `reportDir`.
 *
 * A task without a saved report is refused rather than rendered from whatever
 * is on screen: the PDF is a snapshot of a validated report, and there is no
 * such thing as exporting a draft that was never checked.
 */
export async function exportTaskReportPdf(input: {
  readonly service: ResearchService;
  readonly reportDir: string;
  readonly taskId: string;
  readonly browserPath?: string;
}): Promise<PdfExportOutcome> {
  const task = input.service.getTask(input.taskId);
  if (task === undefined) return { ok: false, failure: "研究任务不存在" };
  if (task.currentReportId === null) return { ok: false, failure: "当前任务还没有已保存的报告，无法导出" };

  const reportId = task.currentReportId;
  const html = renderHtmlOf(input.service, task.id, reportId);
  if (html === undefined) return { ok: false, failure: "报告不存在" };

  mkdirSync(input.reportDir, { recursive: true });
  const outPath = join(input.reportDir, `${task.id}-${reportId}.pdf`);
  const now = new Date().toISOString();
  const artifactId = newId(ID_PREFIX.export);

  const result = await exportHtmlToPdf({
    html,
    outPath,
    ...(input.browserPath === undefined ? {} : { browserPath: input.browserPath }),
  });

  const artifact: ExportArtifact = {
    id: artifactId,
    taskId: task.id,
    reportId,
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
    ? { ok: true, failure: "", artifact, path: result.path }
    : { ok: false, failure: result.failure, artifact };
}
