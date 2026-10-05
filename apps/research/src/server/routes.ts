/**
 * The application's own API: the workspace's whole view of the research.
 *
 * Every route here is an application action the user took — submit a topic,
 * confirm a card, start a pass, ask for a PDF — and none of them is a model
 * tool call. That split is the product's: the agent may search, read and write,
 * while starting runs, confirming cards and producing files stay with the
 * application, where a stray model decision cannot reach them.
 *
 * The responses are the workspace's own JSON. Nothing here exposes a raw
 * internal record: a source is returned with its read status and scope, an
 * evidence item with its verified excerpt and locator, and a run with what it
 * actually called. There is deliberately no route that accepts a report or an
 * excerpt from the client.
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { ResearchService } from "@every-dagent/plugin-research";
import { exportTaskReportPdf, renderHtmlOf } from "./export.js";
import type { ResearchRunner } from "./runner.js";

const MAX_BODY_BYTES = 32 * 1024;

export interface ResearchRoutesOptions {
  readonly service: ResearchService;
  readonly runner: ResearchRunner;
  /** Creates one host session for a new research task. */
  readonly createSession: () => Promise<string>;
  readonly reportDir: string;
  readonly browserPath?: string;
  readonly log?: (message: string) => void;
}

interface Deferred {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const payload = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(payload);
}

function sendText(response: ServerResponse, status: number, value: string, type: string): void {
  response.writeHead(status, {
    "content-type": type,
    "content-length": Buffer.byteLength(value),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(value);
}

function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > MAX_BODY_BYTES) {
        request.destroy();
        resolve(undefined);
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.trim().length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text) as unknown);
      } catch {
        resolve(undefined);
      }
    });
    request.on("error", () => {
      resolve(undefined);
    });
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The whole workspace state for one task: what the UI polls. */
function taskBundle(service: ResearchService, taskId: string, busy: boolean): unknown {
  const task = service.getTask(taskId);
  if (task === undefined) return undefined;
  const cells = service.cellsOf(taskId);
  const reports = service.reportsOf(taskId);
  const current = task.currentReportId === null ? undefined : reports.find((report) => report.id === task.currentReportId);
  return {
    task: {
      id: task.id,
      sessionId: task.sessionId,
      topic: task.topic,
      purpose: task.purpose,
      audience: task.audience,
      focus: task.focus,
      exclusions: task.exclusions,
      lengthTarget: task.lengthTarget,
      status: task.status,
      confirmed: task.confirmedAt !== null,
      confirmedAt: task.confirmedAt,
      error: task.error,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    },
    structure: task.structure.sections,
    subjects: task.subjects,
    dimensions: task.dimensions,
    matrix: cells.map((cell) => ({
      sectionId: cell.sectionId,
      subjectId: cell.subjectId,
      dimensionId: cell.dimensionId,
      subjectName: cell.subjectName,
      dimensionName: cell.dimensionName,
      status: cell.status,
      reason: cell.reason,
      gap: cell.gap,
      evidenceIds: cell.evidenceIds,
      note: cell.note,
    })),
    gaps: cells.filter((cell) => cell.status !== "sufficient"),
    sources: service.sourcesOf(taskId).map((source) => ({
      sourceId: source.id,
      title: source.title,
      authors: source.authors,
      venue: source.venue,
      publishedAt: source.publishedAt,
      url: source.url,
      doi: source.doi,
      abstract: source.abstract.slice(0, 900),
      readStatus: source.readStatus,
      readScope: source.readScope,
      readAt: source.readAt,
      readUrl: source.readUrl,
      retrievalNote: source.retrievalNote,
      failure: source.failure,
      discovery: source.discovery,
    })),
    evidence: service.evidenceOf(taskId).map((item) => ({
      evidenceId: item.id,
      sourceId: item.sourceId,
      excerpt: item.excerpt,
      locator: item.locator,
      readScope: item.readScope,
      pickedBecause: item.pickedBecause,
      cells: item.cells,
    })),
    reports: reports.map((report) => ({
      reportId: report.id,
      title: report.title,
      summary: report.summary,
      createdAt: report.createdAt,
      validation: report.validation,
      isCurrent: report.id === task.currentReportId,
      sections: report.sections.map((section) => ({ id: section.id, title: section.title })),
      claims: report.claims.map((claim) => ({
        id: claim.id,
        text: claim.text,
        kind: claim.kind,
        evidenceIds: claim.evidenceIds,
      })),
    })),
    exports: service.exportsOf(taskId).map((artifact) => ({
      exportId: artifact.id,
      reportId: artifact.reportId,
      status: artifact.status,
      bytes: artifact.bytes,
      failure: artifact.failure,
      createdAt: artifact.createdAt,
      isCurrentReport: artifact.reportId === task.currentReportId,
    })),
    runs: service.runsOf(taskId).map((record) => ({
      runId: record.runId,
      stage: record.stage,
      status: record.status,
      note: record.note,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      activity: record.activity,
    })),
    budget: task.budget,
    usage: task.usage,
    currentReportId: task.currentReportId,
    hasReport: current !== undefined,
    busy,
  };
}

let options: ResearchRoutesOptions;
let pendingTopics = new Map<string, string>();

/** The handler the page server calls before it serves a file. */
export function createResearchRouter(
  routeOptions: ResearchRoutesOptions,
  busyState: () => boolean = () => false,
): (request: IncomingMessage, response: ServerResponse) => boolean {
  pendingTopics = new Map();
  const { service, runner } = routeOptions;
  const log = routeOptions.log ?? ((): void => undefined);

  const taskIdOf = (path: string, suffix = ""): string | undefined => {
    const match = new RegExp(`^/api/research/tasks/([^/]+)${suffix}$`).exec(path);
    return match?.[1];
  };

  const handle = async ({ request, response }: Deferred, path: string, method: string): Promise<void> => {
    // GET /api/research/tasks — the list a reader reopens from.
    if (path === "/api/research/tasks" && method === "GET") {
      const tasks = service.listTasks().map((task) => ({
        id: task.id,
        sessionId: task.sessionId,
        topic: task.topic,
        status: task.status,
        subjects: task.subjects.map((subject) => subject.name),
        updatedAt: task.updatedAt,
        hasReport: task.currentReportId !== null,
      }));
      sendJson(response, 200, { tasks });
      return;
    }

    // POST /api/research/tasks {topic} — a new research task and its card stage.
    if (path === "/api/research/tasks" && method === "POST") {
      const body = asRecord(await readBody(request));
      const topic = typeof body["topic"] === "string" ? body["topic"].trim() : "";
      if (topic.length < 2) {
        sendJson(response, 400, { error: "主题太短" });
        return;
      }
      const sessionId = await routeOptions.createSession();
      pendingTopics.set(sessionId, topic);
      // The card stage creates the task itself (propose_task binds it to the
      // session), so the task id is known as soon as the stage has run.
      runner.startCard(sessionId, topic);
      log(`[api] card stage started for session ${sessionId}`);
      sendJson(response, 202, { sessionId, pending: true });
      return;
    }

    // GET /api/research/sessions/:sessionId — the state of one session.
    const sessionMatch = /^\/api\/research\/sessions\/([^/]+)$/.exec(path);
    if (sessionMatch !== null && method === "GET") {
      const sessionId = sessionMatch[1] ?? "";
      const task = service.taskForSession(sessionId);
      if (task === undefined) {
        sendJson(response, 200, { pending: pendingTopics.has(sessionId), task: null, busy: busyState() });
        return;
      }
      sendJson(response, 200, { pending: false, task: taskBundle(service, task.id, busyState()) });
      return;
    }

    // GET /api/research/tasks/:id — the whole workspace bundle.
    const getTaskId = taskIdOf(path);
    if (getTaskId !== undefined && method === "GET") {
      const bundle = taskBundle(service, getTaskId, busyState());
      if (bundle === undefined) {
        sendJson(response, 404, { error: "任务不存在" });
        return;
      }
      sendJson(response, 200, bundle);
      return;
    }

    // POST /api/research/tasks/:id/confirm — the user's decision, then research.
    const confirmId = taskIdOf(path, "/confirm");
    if (confirmId !== undefined && method === "POST") {
      const task = service.getTask(confirmId);
      if (task === undefined) {
        sendJson(response, 404, { error: "任务不存在" });
        return;
      }
      service.confirmTask(confirmId);
      service.startResearch(confirmId);
      runner.startResearch(confirmId);
      sendJson(response, 202, { ok: true, started: "research" });
      return;
    }

    const gapId = taskIdOf(path, "/gap");
    if (gapId !== undefined && method === "POST") {
      const task = service.getTask(gapId);
      if (task === undefined) {
        sendJson(response, 404, { error: "任务不存在" });
        return;
      }
      if (task.usage.gapRounds >= task.budget.maxGapRounds) {
        sendJson(response, 409, { error: "补查轮次预算已用完，请在报告中如实标注缺口" });
        return;
      }
      runner.startGapRound(gapId);
      sendJson(response, 202, { ok: true, started: "gap" });
      return;
    }

    const reportId2 = taskIdOf(path, "/report");
    if (reportId2 !== undefined && method === "POST") {
      const task = service.getTask(reportId2);
      if (task === undefined) {
        sendJson(response, 404, { error: "任务不存在" });
        return;
      }
      runner.startReport(reportId2);
      sendJson(response, 202, { ok: true, started: "report" });
      return;
    }

    const followId = taskIdOf(path, "/followup");
    if (followId !== undefined && method === "POST") {
      const body = asRecord(await readBody(request));
      const text = typeof body["text"] === "string" ? body["text"].trim() : "";
      if (text.length === 0) {
        sendJson(response, 400, { error: "追加指令为空" });
        return;
      }
      runner.startFollowUp(followId, text);
      sendJson(response, 202, { ok: true, started: "followup" });
      return;
    }

    const exportId = taskIdOf(path, "/export");
    if (exportId !== undefined && method === "POST") {
      const outcome = await exportTaskReportPdf({
        service,
        reportDir: routeOptions.reportDir,
        taskId: exportId,
        ...(routeOptions.browserPath === undefined ? {} : { browserPath: routeOptions.browserPath }),
      });
      sendJson(response, outcome.ok ? 200 : 500, {
        ok: outcome.ok,
        failure: outcome.failure,
        exportId: outcome.artifact?.id,
        bytes: outcome.artifact?.bytes ?? 0,
      });
      return;
    }

    // GET /api/research/exports/:exportId/file — the PDF itself.
    const fileMatch = /^\/api\/research\/exports\/([^/]+)\/file$/.exec(path);
    if (fileMatch !== null && method === "GET") {
      const exportArtifact = service
        .listTasks()
        .flatMap((task) => service.exportsOf(task.id))
        .find((artifact) => artifact.id === fileMatch[1]);
      if (exportArtifact === undefined || exportArtifact.status !== "exported" || exportArtifact.path === null) {
        sendJson(response, 404, { error: "导出文件不存在" });
        return;
      }
      if (!existsSync(exportArtifact.path)) {
        sendJson(response, 404, { error: "导出文件已被移动或删除" });
        return;
      }
      const stats = statSync(exportArtifact.path);
      response.writeHead(200, {
        "content-type": "application/pdf",
        "content-length": stats.size,
        "content-disposition": `attachment; filename="${exportArtifact.id}.pdf"`,
        "cache-control": "no-store",
      });
      createReadStream(exportArtifact.path).pipe(response);
      return;
    }

    // GET /api/research/reports/:reportId/html — the preview (and print) view.
    const htmlMatch = /^\/api\/research\/reports\/([^/]+)\/html$/.exec(path);
    if (htmlMatch !== null && method === "GET") {
      const report = service
        .listTasks()
        .flatMap((task) => service.reportsOf(task.id))
        .find((candidate) => candidate.id === htmlMatch[1]);
      if (report === undefined) {
        sendJson(response, 404, { error: "报告不存在" });
        return;
      }
      const html = renderHtmlOf(service, report.taskId, report.id);
      if (html === undefined) {
        sendJson(response, 404, { error: "报告不存在" });
        return;
      }
      sendText(response, 200, html, "text/html; charset=utf-8");
      return;
    }

    sendJson(response, 404, { error: "未知的研究 API 路径" });
  };

  return (request, response): boolean => {
    const url = request.url ?? "/";
    const path = url.split("?")[0] ?? "/";
    if (!path.startsWith("/api/research/")) return false;
    const method = request.method ?? "GET";
    void handle({ request, response }, path, method).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "接口失败";
      log(`[api] ${method} ${path} failed: ${message}`);
      try {
        sendJson(response, 500, { error: message });
      } catch {
        // The response may already be gone; the log line above is the record.
      }
    });
    return true;
  };
}
