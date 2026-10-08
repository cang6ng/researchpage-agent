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

import type {
  AssistantIntent,
  Report,
  ReportClaim,
  ReportFrame,
  ReportSection,
  ResearchService,
  SupportAssessment,
} from "@every-dagent/plugin-research";
import {
  DEFAULT_BUDGET,
  USER_RESEARCH_BUDGET,
  buildCitations,
  findPdfBrowser,
  classifyIntent,
  deriveClaimAdequacy,
  needsAttention,
  reportContentOf,
} from "@every-dagent/plugin-research";
import { exportRevisionPdf, exportTaskReportPdf, renderHtmlOf, revisionHtmlOf } from "./export.js";
import { presentationOf, researchProgressOf } from "./presentation.js";
import type { ResearchRunner } from "./runner.js";

const MAX_BODY_BYTES = 32 * 1024;

export interface ResearchRoutesOptions {
  readonly service: ResearchService;
  readonly runner: ResearchRunner;
  /** Creates one host session for a new research task. */
  readonly createSession: () => Promise<string>;
  readonly reportDir: string;
  readonly browserPath?: string;
  /** The model this instance runs with, for the workspace's own status line. */
  readonly model?: { readonly provider: string; readonly model: string };
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
  const revisions = service.revisionsOf(taskId);
  const proposals = service.proposalsOf(taskId);
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
      reportNeedsReview: task.reportNeedsReview ?? null,
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
    gaps: cells.filter((cell) => needsAttention(cell.status)),
    assessments: service.assessmentsOf(taskId).map((entry) => ({
      assessmentId: entry.id,
      target: entry.target,
      evidenceIds: entry.evidenceIds,
      relationship: entry.relationship,
      directness: entry.directness,
      scope: entry.scope,
      rationale: entry.rationale,
      assessor: entry.assessor,
      createdAt: entry.createdAt,
    })),
    sources: service.sourcesOf(taskId).map((source) => ({
      sourceId: source.id,
      title: source.title,
      authors: source.authors,
      venue: source.venue,
      publishedAt: source.publishedAt,
      url: source.url,
      doi: source.doi,
      abstract: source.abstract.slice(0, 900),
      role: source.role ?? null,
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
      frame: report.frame ?? null,
      validation: {
        ok: report.validation.ok,
        problems: report.validation.problems,
        warnings: report.validation.warnings ?? [],
        checks: report.validation.checks ?? [],
        checkedAt: report.validation.checkedAt,
      },
      contentHash: report.contentHash ?? null,
      gapsCaptured: report.gapsAtSave !== undefined,
      isCurrent: report.id === task.currentReportId,
      sections: report.sections.map((section) => ({ id: section.id, title: section.title })),
      claims: report.claims.map((claim) => ({
        id: claim.id,
        text: claim.text,
        kind: claim.kind,
        claimType: claim.claimType ?? "fact",
        synthesis: claim.synthesis === true,
        evidenceIds: claim.evidenceIds,
      })),
    })),
    proposals: proposals.map((proposal) => ({
      proposalId: proposal.id,
      actionId: proposal.actionId,
      status: proposal.status,
      baseReportId: proposal.baseReportId,
      baseContentHash: proposal.baseContentHash,
      targets: proposal.targets.map((target) => target.targetId),
      sections: proposal.sections.map((section) => ({ id: section.id, title: section.title })),
      reason: proposal.reason,
      evidenceIds: proposal.evidenceIds,
      researchAdded: proposal.researchAdded,
      acceptedReportId: proposal.acceptedReportId,
      createdAt: proposal.createdAt,
      decidedAt: proposal.decidedAt,
    })),
    revisions: revisions.map((revision) => ({
      revisionId: revision.id,
      reportId: revision.reportId,
      revision: revision.revision,
      contentHash: revision.contentHash,
      themeId: revision.themeId,
      evidenceCount: revision.evidenceRefs.length,
      sourceCount: revision.sourceRefs.length,
      gapsCaptured: revision.gapsCaptured,
      renderer: `${revision.renderer.name}@${revision.renderer.version}`,
      createdAt: revision.createdAt,
      isCurrentReport: revision.reportId === task.currentReportId,
    })),
    exports: service.exportsOf(taskId).map((artifact) => ({
      exportId: artifact.id,
      reportId: artifact.reportId,
      revisionId: artifact.revisionId ?? null,
      themeId: artifact.themeId ?? null,
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
      // The reader's own sentence, for the runs they asked for. Empty for the
      // program's own stages, which is how the workspace tells a turn of the
      // collaboration from the agent working on its own.
      userText: record.userText ?? "",
      // What the action resolved, when it was one a person asked for: kept with
      // the run so the history says what each turn answered rather than only
      // what it fetched.
      outcome: record.outcome ?? null,
    })),
    budget: task.budget,
    usage: task.usage,
    /**
     * The attempt the pipeline budget governs, and what discovery has tried.
     *
     * They are separate from `usage` on purpose: `usage` is the project's
     * lifetime telemetry, the attempt is what the next call is refused by, and
     * the discovery ledger is the honest count of requests — including the
     * failed ones, which used to be invisible.
     */
    attempt: task.attempt ?? null,
    discovery: task.discovery ?? null,
    // What a user action may still spend, while one is actually running: the
    // grant lives exactly as long as its stage, so this is null between
    // actions rather than a project-wide remainder dressed up as an allowance.
    actionBudget: service.actionBudgetOf(task.sessionId) ?? null,
    /**
     * Where the research really is, and why it is waiting.
     *
     * Derived from the same records the page already polls (run records and the
     * activity history), so a live run and a historical one are read the same
     * way, and no percentage is invented for either.
     */
    progress: researchProgressOf({
      task,
      runs: service.runsOf(taskId),
      activity: service.activityOf(taskId, 60),
      sources: service.sourcesOf(taskId),
    }),
    /**
     * The reader-facing activity history, oldest first.
     *
     * It is stored rather than kept in memory, so a page reload still shows the
     * 429, the wait and the fallback that happened before it — and it carries
     * no tool payloads, no model reasoning and no credentials.
     */
    activityLog: service.activityOf(taskId, 200),
    // The brief travels with the rest of the project: it is the same draft the
    // structured editor and the guided assistant write to, so a page that polls
    // one endpoint sees both ways of working on it.
    brief: service.briefOf(taskId),
    currentReportId: task.currentReportId,
    currentReportHash: current === undefined ? null : service.contentHashOf(taskId),
    currentReportFrozen: current !== undefined && revisions.some((revision) => revision.reportId === current.id),
    hasReport: current !== undefined,
    /*
     * Where this project stands, as six separate answers.
     *
     * They are deliberately not folded into one status word: material coverage,
     * unresolved research, whether the report is behind its material, and
     * whether it met its own content contract are four different facts, and a
     * page that merges them ends up saying「无待查项」next to「9 处义务未完全
     * 达成」. Each field carries its own displayName / userMessage so the page
     * never has to translate an internal term.
     */
    presentation: presentationOf({
      task,
      cells,
      sources: service.sourcesOf(taskId),
      hasReport: current !== undefined,
      pendingProposal: proposals.some((proposal) => proposal.status === "pending"),
      runningStage: service.runsOf(taskId).find((record) => record.status === "running")?.stage ?? null,
      validation: current?.validation ?? null,
    }),
    busy,
  };
}

let options: ResearchRoutesOptions;
let pendingTopics = new Map<string, string>();

/**
 * A report as a document the page can render itself.
 *
 * The workspace draws the report natively rather than framing a rendered HTML
 * page, so the structured content — sections, blocks, claims with their
 * conditions — has to reach the page as it is, together with the citation
 * numbering the renderer mints and the adequacy verdict each claim's evidence
 * was given. Nothing here is recomputed: the numbering comes from
 * `buildCitations`, the verdicts from `deriveClaimAdequacy`, and the validation
 * stamp is the one the report was saved with. This is a read of facts the
 * application already holds, in the shape the page reads.
 */
/** `ReportEvidenceScope` names the read scopes a citation can carry. */
type ReportEvidenceScope = "metadata" | "abstract" | "body_excerpt" | "full_text";

interface DocumentSource {
  readonly id: string;
  readonly title: string;
  readonly authors: readonly string[];
  readonly org: string;
  readonly venue: string;
  readonly publishedAt: string | null;
  readonly url: string;
  readonly doi: string | null;
  readonly readScope: ReportEvidenceScope | null;
}

interface DocumentEvidence {
  readonly id: string;
  readonly sourceId: string;
  readonly excerpt: string;
  readonly readScope: ReportEvidenceScope;
  readonly locator: { readonly headingPath: readonly string[]; readonly paragraphIndex: number };
  readonly cells: readonly { readonly sectionId: string; readonly subjectId: string; readonly dimensionId: string }[];
}

function documentOf(input: {
  readonly reportId: string;
  readonly content: {
    readonly title: string;
    readonly summary: string;
    readonly frame?: ReportFrame;
    readonly sections: readonly ReportSection[];
    readonly claims: readonly ReportClaim[];
  };
  readonly validation?: Report["validation"];
  readonly revision?: number;
  readonly themeId?: string;
  readonly contentHash?: string | null;
  readonly sources: readonly DocumentSource[];
  readonly evidence: readonly DocumentEvidence[];
  readonly assessments: readonly SupportAssessment[];
  readonly subjectNames: ReadonlyMap<string, string>;
  readonly dimensionNames: ReadonlyMap<string, string>;
}): unknown {
  const content = input.content;
  const citations = buildCitations({
    draft: { title: content.title, summary: content.summary, sections: content.sections, claims: content.claims },
    sources: input.sources,
    evidence: input.evidence,
  });
  // The adequacy verdict is derived from evidence that still carries its cells
  // and scope; the sources argument is not read by the derivation.
  const adequacyContext = {
    evidence: input.evidence,
    sources: [],
    assessments: input.assessments,
    subjectNames: input.subjectNames,
  } as unknown as Parameters<typeof deriveClaimAdequacy>[1];
  return {
    reportId: input.reportId,
    revision: input.revision ?? null,
    themeId: input.themeId ?? null,
    contentHash: input.contentHash ?? null,
    title: content.title,
    summary: content.summary,
    frame: content.frame ?? null,
    sections: content.sections,
    claims: content.claims.map((claim) => ({
      id: claim.id,
      text: claim.text,
      kind: claim.kind,
      claimType: claim.claimType ?? "fact",
      synthesis: claim.synthesis === true,
      evidenceIds: claim.evidenceIds,
      subjects: (claim.subjects ?? []).map((id) => ({ id, name: input.subjectNames.get(id) ?? id })),
      dimensions: (claim.dimensions ?? []).map((id) => ({ id, name: input.dimensionNames.get(id) ?? id })),
      conditions: claim.conditions ?? null,
      adequacy: deriveClaimAdequacy(claim, adequacyContext),
    })),
    citations: {
      references: citations.references.map((reference) => ({
        number: reference.number,
        sourceId: reference.sourceId,
        title: reference.source.title,
        authors: reference.source.authors,
        venue: reference.source.venue,
        publishedAt: reference.source.publishedAt,
        url: reference.source.url,
        doi: reference.source.doi,
        readScope: reference.source.readScope,
      })),
      evidenceIndex: citations.evidenceIndex,
      numbersByClaim: Object.fromEntries(citations.numbersForClaim),
    },
    validation:
      input.validation === undefined
        ? null
        : {
            ok: input.validation.ok,
            problems: input.validation.problems,
            warnings: input.validation.warnings ?? [],
            checks: input.validation.checks ?? [],
            checkedAt: input.validation.checkedAt,
          },
  };
}

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
    // Confirming is taken on the current draft and nothing else: a draft that is
    // still incomplete is refused here, before any query is aimed at it.
    const confirmId = taskIdOf(path, "/confirm");
    if (confirmId !== undefined && method === "POST") {
      const body = asRecord(await readBody(request));
      const task = service.getTask(confirmId);
      if (task === undefined) {
        sendJson(response, 404, { error: "任务不存在" });
        return;
      }
      const confirmed = service.confirmTask(confirmId, {
        ...(typeof body["expectedVersion"] === "number" ? { expectedVersion: body["expectedVersion"] } : {}),
      });
      if (!confirmed.ok) {
        sendJson(response, 409, {
          error: confirmed.problems.join("；"),
          // The same problems, unjoined: a page puts each one beside the field
          // it is about, and rejoining a sentence to find them again would be a
          // guess about punctuation.
          problems: confirmed.problems,
          guidance: confirmed.guidance,
          brief: service.briefOf(confirmId),
        });
        return;
      }
      service.startResearch(confirmId);
      runner.startResearch(confirmId);
      sendJson(response, 202, { ok: true, started: "research", briefVersion: confirmed.briefVersion, matrixRebuilt: confirmed.matrixRebuilt });
      return;
    }

    // ------------------------------------------------------------------ brief --
    // GET /api/research/tasks/:id/brief — the draft (or the frozen record).
    const briefId = taskIdOf(path, "/brief");
    if (briefId !== undefined && method === "GET") {
      if (service.getTask(briefId) === undefined) {
        sendJson(response, 404, { error: "任务不存在" });
        return;
      }
      sendJson(response, 200, { brief: service.briefOf(briefId) });
      return;
    }

    // PATCH /api/research/tasks/:id/brief {expectedVersion?, patch} — one edit.
    if (briefId !== undefined && method === "PATCH") {
      const body = asRecord(await readBody(request));
      if (service.getTask(briefId) === undefined) {
        sendJson(response, 404, { error: "任务不存在" });
        return;
      }
      // The patch is either wrapped or sent as the body itself; no brief field
      // is named "patch", so the two readings can never collide.
      const patch = body["patch"] !== undefined ? body["patch"] : Object.fromEntries(Object.entries(body).filter(([key]) => key !== "expectedVersion"));
      const result = service.patchBrief(briefId, {
        ...(typeof body["expectedVersion"] === "number" ? { expectedVersion: body["expectedVersion"] } : {}),
        patch,
      });
      if (!result.ok) {
        const stale = "stale" in result && result.stale === true;
        const conflict = stale || ("conflict" in result && result.conflict === true);
        sendJson(response, conflict ? 409 : 400, {
          ok: false,
          error: result.problems.join("；"),
          problems: result.problems,
          guidance: result.guidance,
          ...(stale ? { stale: true, brief: (result as { brief: unknown }).brief } : {}),
        });
        return;
      }
      sendJson(response, 200, { ok: true, brief: result.brief, changedFields: result.changedFields });
      return;
    }

    // POST /api/research/tasks/:id/brief/guide/next — the next guided question.
    // Asking is one bounded stage run: the question appears in the brief, and a
    // question that is already live is returned rather than paid for again.
    const guideNextId = taskIdOf(path, "/brief/guide/next");
    if (guideNextId !== undefined && method === "POST") {
      const task = service.getTask(guideNextId);
      if (task === undefined) {
        sendJson(response, 404, { error: "任务不存在" });
        return;
      }
      const brief = service.briefOf(guideNextId);
      if (brief.readonly) {
        sendJson(response, 409, { error: "研究简报已确认，引导式规划结束", brief });
        return;
      }
      if (brief.guide.active !== null) {
        sendJson(response, 200, { ok: true, complete: false, started: false, question: brief.guide.active });
        return;
      }
      if (brief.guide.complete) {
        sendJson(response, 200, { ok: true, complete: true, started: false, reason: brief.guide.reason });
        return;
      }
      const started = runner.startGuide(guideNextId);
      if (started === undefined) {
        sendJson(response, 200, { ok: true, complete: true, started: false, reason: service.guideTargetOf(guideNextId).reason });
        return;
      }
      sendJson(response, 202, { ok: true, complete: false, started: true, target: started.target, scope: started.scope });
      return;
    }

    // POST /api/research/tasks/:id/brief/guide/answer — one decision, applied.
    const guideAnswerId = taskIdOf(path, "/brief/guide/answer");
    if (guideAnswerId !== undefined && method === "POST") {
      const body = asRecord(await readBody(request));
      const questionId = typeof body["questionId"] === "string" ? body["questionId"].trim() : "";
      if (questionId.length === 0) {
        sendJson(response, 400, { error: "缺少 questionId" });
        return;
      }
      if (service.getTask(guideAnswerId) === undefined) {
        sendJson(response, 404, { error: "任务不存在" });
        return;
      }
      const optionIds = Array.isArray(body["optionIds"])
        ? (body["optionIds"] as unknown[]).filter((id): id is string => typeof id === "string")
        : [];
      const result = service.answerGuideQuestion(guideAnswerId, {
        questionId,
        ...(typeof body["expectedVersion"] === "number" ? { expectedVersion: body["expectedVersion"] } : {}),
        ...(optionIds.length === 0 ? {} : { optionIds }),
        ...(typeof body["freeText"] === "string" ? { freeText: body["freeText"] } : {}),
      });
      if (!result.ok) {
        const stale = "stale" in result && result.stale === true;
        const conflict = stale || ("conflict" in result && result.conflict === true);
        sendJson(response, conflict ? 409 : 400, {
          ok: false,
          error: result.problems.join("；"),
          problems: result.problems,
          guidance: result.guidance,
          ...(stale ? { stale: true, brief: (result as { brief: unknown }).brief } : {}),
        });
        return;
      }
      // The answer changed the same draft the structured editor writes to, so
      // the next question — if there is one — is written against the new value.
      if (!result.complete) runner.startGuide(guideAnswerId);
      sendJson(response, 200, {
        ok: true,
        brief: result.brief,
        appliedFields: result.appliedFields,
        complete: result.complete,
        nextQuestion: result.complete ? "none" : "pending",
      });
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

    // POST /api/research/tasks/:id/retry-research — the retry the workspace
    // already promised. A failed project can be researched again: the brief,
    // the material, the report and the frozen revisions stay exactly where they
    // are, the failure that was blocking it is cleared, and a new bounded
    // attempt starts. Everything that decides eligibility lives in the service;
    // the route adds the one fact only the runner knows — whether a stage for
    // this task is already running or waiting.
    const retryId = taskIdOf(path, "/retry-research");
    if (retryId !== undefined && method === "POST") {
      if (runner.hasWorkFor(retryId)) {
        sendJson(response, 409, {
          error: "这个项目还有一次运行正在进行中",
          problems: ["这个项目还有一次运行正在进行中"],
          guidance: "请等待当前运行结束后再重新研究，避免两次运行同时写入同一个项目。",
          reason: "run_in_progress",
        });
        return;
      }
      const result = service.retryResearch(retryId);
      if (!result.ok) {
        sendJson(response, result.reason === "task_unknown" ? 404 : 409, {
          error: result.problems.join("；"),
          problems: result.problems,
          guidance: result.guidance,
          reason: result.reason,
        });
        return;
      }
      runner.startResearch(retryId);
      sendJson(response, 202, {
        ok: true,
        started: "research",
        attempt: result.attempt,
        preserved: result.preserved,
        message: result.message,
      });
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

    // POST /api/research/tasks/:id/assistant {text, intent, targetSectionId} —
    // one assistant action: Ask answers, Research adds material, Edit proposes.
    const assistantId = taskIdOf(path, "/assistant");
    if (assistantId !== undefined && method === "POST") {
      const body = asRecord(await readBody(request));
      const text = typeof body["text"] === "string" ? body["text"].trim() : "";
      if (text.length === 0) {
        sendJson(response, 400, { error: "指令为空" });
        return;
      }
      const task = service.getTask(assistantId);
      if (task === undefined) {
        sendJson(response, 404, { error: "任务不存在" });
        return;
      }
      const requested = typeof body["intent"] === "string" ? body["intent"] : "auto";
      const reading =
        requested === "ask" || requested === "research" || requested === "edit"
          ? { intent: requested as AssistantIntent, explicit: true, reason: `用户显式选择 ${requested}` }
          : classifyIntent(text);

      const targetSectionId =
        typeof body["targetSectionId"] === "string" && body["targetSectionId"].trim().length > 0
          ? body["targetSectionId"].trim()
          : null;
      const report =
        task.currentReportId === null ? undefined : service.reportsOf(task.id).find((candidate) => candidate.id === task.currentReportId);

      if (reading.intent === "edit" && (report === undefined || targetSectionId === null)) {
        sendJson(response, 409, {
          error:
            report === undefined
              ? "当前任务还没有报告，无法提出修改"
              : "请指定要修改的章节（targetSectionId）后再发起 Edit",
          sections: report?.sections.map((section) => ({ id: section.id, title: section.title })) ?? [],
        });
        return;
      }

      if (reading.intent === "research") {
        // A user's补查 gets its own action budget, so it is never refused
        // because the project's automatic rounds or deadline are spent: what it
        // may spend is one instruction's worth, and the next instruction gets
        // its own.
        const view = runner.startResearchAction(task.id, {
          text,
          reading: reading.reason,
          allowResearch: true,
        });
        if (view === undefined) {
          sendJson(response, 404, { error: "任务不存在" });
          return;
        }
        sendJson(response, 202, { ok: true, started: "research", ...view, reading: reading.reason });
        return;
      }

      const view = runner.startAssistant(task.id, {
        intent: reading.intent,
        text,
        targetSectionId,
        allowResearch: reading.intent === "edit",
        reading: reading.reason,
      });
      if (view === undefined) {
        sendJson(response, 409, { error: "无法开始该动作（任务或目标章节不存在）" });
        return;
      }
      sendJson(response, 202, { ok: true, started: view.intent, intent: view.intent, scope: view.scope, reading: reading.reason });
      return;
    }

    // POST /api/research/tasks/:id/export — a PDF of the current report, frozen first.
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
        revisionId: outcome.revisionId ?? null,
        bytes: outcome.artifact?.bytes ?? 0,
      });
      return;
    }

    // POST /api/research/tasks/:id/revisions — freeze the report's dependencies.
    const freezeId = taskIdOf(path, "/revisions");
    if (freezeId !== undefined && method === "POST") {
      const body = asRecord(await readBody(request));
      const task = service.getTask(freezeId);
      if (task === undefined) {
        sendJson(response, 404, { error: "任务不存在" });
        return;
      }
      const result = service.freezeRevision({
        taskId: task.id,
        ...(typeof body["reportId"] === "string" && body["reportId"].length > 0 ? { reportId: body["reportId"] } : {}),
        ...(typeof body["expectedContentHash"] === "string" && body["expectedContentHash"].length > 0
          ? { expectedContentHash: body["expectedContentHash"] }
          : {}),
        ...(typeof body["themeId"] === "string" && body["themeId"].length > 0 ? { themeId: body["themeId"] } : {}),
      });
      if (!result.ok) {
        sendJson(response, 409, { error: result.problems.join("；"), guidance: result.guidance, failure: true });
        return;
      }
      sendJson(response, 200, {
        ok: true,
        existing: result.existing,
        revision: {
          revisionId: result.revision.id,
          revision: result.revision.revision,
          reportId: result.revision.reportId,
          contentHash: result.revision.contentHash,
          themeId: result.revision.themeId,
          gapsCaptured: result.revision.gapsCaptured,
          createdAt: result.revision.createdAt,
        },
      });
      return;
    }

    // GET /api/research/tasks/:id/assessments — the saved support judgements.
    const assessId = taskIdOf(path, "/assessments");
    if (assessId !== undefined && method === "GET") {
      if (service.getTask(assessId) === undefined) {
        sendJson(response, 404, { error: "任务不存在" });
        return;
      }
      sendJson(response, 200, {
        assessments: service.assessmentsOf(assessId).map((entry) => ({
          assessmentId: entry.id,
          target: entry.target,
          evidenceIds: entry.evidenceIds,
          relationship: entry.relationship,
          directness: entry.directness,
          scope: entry.scope,
          rationale: entry.rationale,
          assessor: entry.assessor,
          createdAt: entry.createdAt,
        })),
      });
      return;
    }

    // POST /api/research/tasks/:id/assessments — a person's own judgement.
    if (assessId !== undefined && method === "POST") {
      const body = asRecord(await readBody(request));
      const cell = asRecord(body["cell"]);
      const subjectId = typeof cell["subjectId"] === "string" ? cell["subjectId"] : "";
      const dimensionId = typeof cell["dimensionId"] === "string" ? cell["dimensionId"] : "";
      const sectionId = typeof cell["sectionId"] === "string" ? cell["sectionId"] : "comparison";
      if (subjectId === "" || dimensionId === "") {
        sendJson(response, 400, { error: "缺少单元格坐标（subjectId/dimensionId）" });
        return;
      }
      const recorded = service.recordAssessment(assessId, {
        target: { sectionId, subjectId, dimensionId },
        evidenceIds: Array.isArray(body["evidenceIds"]) ? (body["evidenceIds"] as string[]).filter((id) => typeof id === "string") : [],
        ...(typeof body["relationship"] === "string" ? { relationship: body["relationship"] as never } : {}),
        ...(typeof body["directness"] === "string" ? { directness: body["directness"] as never } : {}),
        ...(typeof body["scope"] === "string" ? { scope: body["scope"] } : {}),
        ...(typeof body["rationale"] === "string" ? { rationale: body["rationale"] } : {}),
        assessor: "user",
      });
      if ("ok" in recorded) {
        sendJson(response, 409, { error: recorded.problems.join("；"), guidance: recorded.guidance });
        return;
      }
      sendJson(response, 200, { ok: true, assessmentId: recorded.id, relationship: recorded.relationship, directness: recorded.directness });
      return;
    }

    // GET /api/research/revisions/:revisionId — the frozen bundle's summary.
    const revisionMatch = /^\/api\/research\/revisions\/([^/]+)$/.exec(path);
    if (revisionMatch !== null && method === "GET") {
      const revision = service.revisionById(revisionMatch[1] ?? "");
      if (revision === undefined) {
        sendJson(response, 404, { error: "冻结版本不存在" });
        return;
      }
      sendJson(response, 200, {
        revision: {
          revisionId: revision.id,
          revision: revision.revision,
          taskId: revision.taskId,
          reportId: revision.reportId,
          contentHash: revision.contentHash,
          themeId: revision.themeId,
          createdAt: revision.createdAt,
          renderer: `${revision.renderer.name}@${revision.renderer.version}`,
          gapsCaptured: revision.gapsCaptured,
          claimCount: revision.claimsUsed.length,
          evidenceIds: revision.evidenceRefs.map((ref) => ref.evidenceId),
          readIds: revision.readIds,
          sourceIds: revision.sourceRefs.map((ref) => ref.sourceId),
          assessmentCount: revision.assessments.length,
        },
      });
      return;
    }

    // GET /api/research/revisions/:revisionId/html — the frozen document.
    const revisionHtmlMatch = /^\/api\/research\/revisions\/([^/]+)\/html$/.exec(path);
    if (revisionHtmlMatch !== null && method === "GET") {
      const revision = service.revisionById(revisionHtmlMatch[1] ?? "");
      if (revision === undefined) {
        sendJson(response, 404, { error: "冻结版本不存在" });
        return;
      }
      sendText(response, 200, revisionHtmlOf(service, revision), "text/html; charset=utf-8");
      return;
    }

    // POST /api/research/revisions/:revisionId/export — a PDF from the frozen bundle.
    const revisionExportMatch = /^\/api\/research\/revisions\/([^/]+)\/export$/.exec(path);
    if (revisionExportMatch !== null && method === "POST") {
      const revision = service.revisionById(revisionExportMatch[1] ?? "");
      if (revision === undefined) {
        sendJson(response, 404, { error: "冻结版本不存在" });
        return;
      }
      const outcome = await exportRevisionPdf({
        service,
        reportDir: routeOptions.reportDir,
        revision,
        ...(routeOptions.browserPath === undefined ? {} : { browserPath: routeOptions.browserPath }),
      });
      sendJson(response, outcome.ok ? 200 : 500, {
        ok: outcome.ok,
        failure: outcome.failure,
        exportId: outcome.artifact?.id,
        revisionId: revision.id,
        bytes: outcome.artifact?.bytes ?? 0,
      });
      return;
    }

    // POST /api/research/proposals/:proposalId/accept — apply, exactly once.
    const acceptMatch = /^\/api\/research\/proposals\/([^/]+)\/accept$/.exec(path);
    if (acceptMatch !== null && method === "POST") {
      const body = asRecord(await readBody(request));
      const result = service.acceptProposal(acceptMatch[1] ?? "", {
        ...(typeof body["expectedBaseReportId"] === "string" && body["expectedBaseReportId"].length > 0
          ? { expectedBaseReportId: body["expectedBaseReportId"] }
          : {}),
        ...(typeof body["expectedBaseContentHash"] === "string" && body["expectedBaseContentHash"].length > 0
          ? { expectedBaseContentHash: body["expectedBaseContentHash"] }
          : {}),
      });
      if (!result.ok) {
        sendJson(response, 409, { ok: false, error: result.problems.join("；"), guidance: result.guidance });
        return;
      }
      sendJson(response, 200, {
        ok: true,
        alreadyApplied: result.alreadyApplied,
        proposalId: result.proposalId,
        reportId: result.reportId,
        contentHash: result.contentHash,
      });
      return;
    }

    // POST /api/research/proposals/:proposalId/discard — close it, keep the material.
    const discardMatch = /^\/api\/research\/proposals\/([^/]+)\/discard$/.exec(path);
    if (discardMatch !== null && method === "POST") {
      const result = service.discardProposal(discardMatch[1] ?? "");
      if (!result.ok) {
        sendJson(response, 409, { ok: false, error: result.problems.join("；"), guidance: result.guidance });
        return;
      }
      sendJson(response, 200, { ok: true, proposalId: result.proposal.id, status: result.proposal.status });
      return;
    }

    // GET /api/research/proposals/:proposalId — one proposal, with its targets.
    const proposalMatch = /^\/api\/research\/proposals\/([^/]+)$/.exec(path);
    if (proposalMatch !== null && method === "GET") {
      const proposal = service.proposalById(proposalMatch[1] ?? "");
      if (proposal === undefined) {
        sendJson(response, 404, { error: "修改提案不存在" });
        return;
      }
      sendJson(response, 200, {
        proposal: {
          proposalId: proposal.id,
          actionId: proposal.actionId,
          taskId: proposal.taskId,
          status: proposal.status,
          baseReportId: proposal.baseReportId,
          baseContentHash: proposal.baseContentHash,
          targets: proposal.targets,
          sections: proposal.sections,
          claims: proposal.claims,
          reason: proposal.reason,
          evidenceIds: proposal.evidenceIds,
          acceptedReportId: proposal.acceptedReportId,
          createdAt: proposal.createdAt,
          decidedAt: proposal.decidedAt,
        },
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

    // GET /api/research/runtime — what this instance is running with. The page
    // prints it in Settings and in its own status line; none of it is a secret.
    if (path === "/api/research/runtime" && method === "GET") {
      sendJson(response, 200, {
        model: routeOptions.model ?? null,
        // Whether an export can be rendered: a PDF needs a browser on this
        // machine, and the page says so instead of offering a button that
        // fails. The effective path is what an export would really use, which
        // is the configured one when there is one and otherwise the browser
        // this machine has.
        pdfRenderer: routeOptions.browserPath ?? findPdfBrowser() ?? null,
        budget: DEFAULT_BUDGET,
        // What one explicit Research instruction gets. Every instruction gets a
        // fresh allowance, so this is a per-action number and not a project
        // remainder: the composer says what the next 补查 may cost without the
        // page keeping its own copy of the number.
        actionAllowance: { searches: USER_RESEARCH_BUDGET.maxSearches, reads: USER_RESEARCH_BUDGET.maxReads },
        dataDir: routeOptions.reportDir,
        busy: busyState() || runner.busy || runner.queued > 0,
      });
      return;
    }

    // GET /api/research/tasks/:id/answers — the Ask answers of this project.
    // An Ask writes nothing, so its answer is read back from the session's own
    // committed history: the assistant turn of that action's run.
    const answersId = taskIdOf(path, "/answers");
    if (answersId !== undefined && method === "GET") {
      const task = service.getTask(answersId);
      if (task === undefined) {
        sendJson(response, 404, { error: "任务不存在" });
        return;
      }
      const asks = service
        .runsOf(task.id)
        .filter((run) => run.stage === "ask" && run.runId !== null)
        .slice(-5);
      const answers: { runId: string; question: string; status: string; text: string | null }[] = [];
      for (const run of asks) {
        let text: string | null = null;
        if (run.status === "completed") {
          try {
            text = (await runner.answerOf(run.runId as string)) ?? null;
          } catch (error) {
            // An unreadable answer is not a page failure, but the operator
            // should be able to see why one is missing.
            log(`[api] answer of ${run.runId as string} could not be read: ${error instanceof Error ? error.message : String(error)}`);
            text = null;
          }
        }
        answers.push({ runId: run.runId as string, question: runner.questionOf(run.runId as string) ?? "", status: run.status, text });
      }
      sendJson(response, 200, { answers });
      return;
    }

    // GET /api/research/reports/:reportId/document — the structured report.
    const documentMatch = /^\/api\/research\/reports\/([^/]+)\/document$/.exec(path);
    if (documentMatch !== null && method === "GET") {
      const task = service.listTasks().find((candidate) => service.reportsOf(candidate.id).some((report) => report.id === documentMatch[1]));
      const report = task === undefined ? undefined : service.reportsOf(task.id).find((candidate) => candidate.id === documentMatch[1]);
      if (task === undefined || report === undefined) {
        sendJson(response, 404, { error: "报告不存在" });
        return;
      }
      sendJson(
        response,
        200,
        documentOf({
          reportId: report.id,
          content: reportContentOf(report),
          validation: report.validation,
          contentHash: report.contentHash ?? null,
          sources: service.sourcesOf(task.id),
          evidence: service.evidenceOf(task.id).map((item) => ({
            id: item.id,
            sourceId: item.sourceId,
            excerpt: item.excerpt,
            readScope: item.readScope,
            locator: item.locator,
            cells: item.cells,
          })),
          assessments: service.assessmentsOf(task.id),
          subjectNames: new Map(task.subjects.map((subject) => [subject.id, subject.name])),
          dimensionNames: new Map(task.dimensions.map((dimension) => [dimension.id, dimension.name])),
        }),
      );
      return;
    }

    // GET /api/research/revisions/:revisionId/document — the frozen document.
    // Read from the bundle alone: it is what a frozen revision means.
    const frozenDocumentMatch = /^\/api\/research\/revisions\/([^/]+)\/document$/.exec(path);
    if (frozenDocumentMatch !== null && method === "GET") {
      const revision = service.revisionById(frozenDocumentMatch[1] ?? "");
      if (revision === undefined) {
        sendJson(response, 404, { error: "冻结版本不存在" });
        return;
      }
      const task = service.getTask(revision.taskId);
      sendJson(
        response,
        200,
        documentOf({
          reportId: revision.reportId,
          revision: revision.revision,
          themeId: revision.themeId,
          contentHash: revision.contentHash,
          content: reportContentOf(revision.report),
          validation: revision.report.validation,
          sources: revision.sourceRefs.map((ref) => ({
            id: ref.sourceId,
            title: ref.title,
            authors: ref.authors,
            org: ref.org,
            venue: ref.venue,
            publishedAt: ref.publishedAt,
            url: ref.url,
            doi: ref.doi,
            readScope: ref.readScope,
          })),
          evidence: revision.evidenceRefs.map((ref) => ({
            id: ref.evidenceId,
            sourceId: ref.sourceId,
            excerpt: ref.excerpt,
            readScope: ref.readScope,
            locator: ref.locator,
            cells: ref.cells,
          })),
          assessments: revision.assessments,
          subjectNames: new Map((task?.subjects ?? revision.frame.subjects).map((subject) => [subject.id, subject.name])),
          dimensionNames: new Map((task?.dimensions ?? revision.frame.dimensions).map((dimension) => [dimension.id, dimension.name])),
        }),
      );
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
