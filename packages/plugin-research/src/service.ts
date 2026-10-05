/**
 * The research service: everything the product does with real material.
 *
 * Both callers share this one implementation — the Agent's tools, which a model
 * drives, and the application's own API, which the workspace drives — so that
 * "what the agent did" and "what the UI shows" can never be two different
 * stories. The service owns the truth rules: what counts as a source, what
 * counts as evidence, what a cell's coverage is, and what a report may cite.
 *
 * Budgets are enforced here, in the code that spends them, rather than in a
 * prompt: a search past the task's limit is refused with a sentence the model
 * can act on, and the refusal is a result rather than an exception, so a run
 * ends with an honest partial report instead of a loop.
 */

import type {
  CellRef,
  CoverageEvidence,
  ReportDraftState,
  Evidence,
  ExportArtifact,
  MatrixCell,
  Report,
  ReportClaim,
  ReportSection,
  ReportTask,
  ReadSnapshot,
  ResearchRunRecord,
  Source,
} from "./domain.js";
import { deriveCellCoverage, ID_PREFIX } from "./domain.js";
import { draftEvidence, pickParagraphs, scopeLabel, tokenize, verifyEvidenceText } from "./evidence.js";
import { readSource, type ReadOutcome } from "./read.js";
import { newId, type ResearchRepository } from "./repository.js";
import { searchArxiv, type SearchOutcome } from "./search.js";
import { buildMatrix, createTask, normalizeCard, slugId, STRUCTURE_SECTIONS, type ProposedCard } from "./structure.js";
import { buildCitations, missingCells, sealReport, validateReport, type ReportDraft, type ValidationResult } from "./report.js";

export interface ResearchServiceOptions {
  readonly repo: ResearchRepository;
  /** The discovery path; the default is the real arXiv client. */
  readonly search?: (query: string, options: { readonly limit: number; readonly signal?: AbortSignal }) => Promise<SearchOutcome>;
  /** The read path; the default is the real HTTP reader. */
  readonly read?: (request: { readonly url: string }, options: { readonly signal?: AbortSignal }) => Promise<ReadOutcome>;
  readonly now?: () => Date;
}

/** One incremental write to the report draft. */
export type ReportPart =
  | {
      readonly kind: "start";
      readonly title?: string;
      readonly summary?: string;
      readonly claims?: readonly ReportClaim[];
      readonly section?: ReportSection;
    }
  | {
      readonly kind: "write";
      readonly title?: string;
      readonly summary?: string;
      readonly claims?: readonly ReportClaim[];
      readonly section?: ReportSection;
    }
  | { readonly kind: "finalize" }
  | { readonly kind: "clear" };

export interface Refusal {
  readonly ok: false;
  readonly problems: readonly string[];
  /** What the caller can still do, in one sentence. */
  readonly guidance: string;
}

export interface SearchResult {
  readonly ok: true;
  readonly sources: readonly {
    readonly sourceId: string;
    readonly title: string;
    readonly authors: readonly string[];
    readonly year: string;
    readonly url: string;
    readonly abstract: string;
    readonly alreadyKnown: boolean;
  }[];
  readonly query: string;
  readonly requestUrl: string;
  readonly total: number | null;
  readonly searchCount: number;
  readonly searchesRemaining: number;
  readonly note: string;
}

export interface ReadResult {
  readonly ok: true;
  readonly sourceId: string;
  readonly title: string;
  readonly readStatus: Source["readStatus"];
  readonly readScope: Source["readScope"];
  readonly readUrl: string;
  readonly textChars: number;
  readonly paragraphCount: number;
  readonly reuse: boolean;
  readonly evidence: readonly {
    readonly evidenceId: string;
    readonly excerpt: string;
    readonly locator: string;
    readonly scope: string;
    readonly pickedBecause: string;
  }[];
  readonly readsRemaining: number;
  readonly note: string;
}

export interface CellView extends CellRef {
  readonly subjectName: string;
  readonly dimensionName: string;
  readonly status: MatrixCell["status"];
  readonly reason: string;
  readonly gap: string;
  readonly evidenceIds: readonly string[];
  readonly note: string;
}

export interface AssessResult {
  readonly ok: true;
  readonly cells: readonly CellView[];
  readonly gaps: readonly CellView[];
  readonly gapRoundsUsed: number;
  readonly gapRoundsRemaining: number;
  readonly note: string;
}

export interface SaveReportResult {
  readonly ok: true;
  readonly reportId: string;
  readonly citations: number;
  readonly references: number;
  readonly warnings: readonly string[];
  readonly missingCells: number;
}

export interface WorkspaceState {
  readonly task: {
    readonly id: string;
    readonly topic: string;
    readonly purpose: string;
    readonly audience: string;
    readonly focus: readonly string[];
    readonly exclusions: string;
    readonly language: string;
    readonly lengthTarget: string;
    readonly status: ReportTask["status"];
    readonly confirmed: boolean;
  };
  readonly structure: readonly { readonly id: string; readonly title: string; readonly question: string }[];
  readonly subjects: readonly { readonly id: string; readonly name: string }[];
  readonly dimensions: readonly { readonly id: string; readonly name: string; readonly question: string }[];
  readonly cells: readonly CellView[];
  readonly sources: readonly {
    readonly sourceId: string;
    readonly title: string;
    readonly readStatus: Source["readStatus"];
    readonly readScope: Source["readScope"];
    readonly url: string;
  }[];
  readonly evidence: readonly {
    readonly evidenceId: string;
    readonly sourceId: string;
    readonly excerpt: string;
    readonly locator: string;
    readonly scope: string;
  }[];
  readonly usage: ReportTask["usage"];
  readonly budget: ReportTask["budget"];
  readonly currentReportId: string | null;
}

export interface ResearchService {
  /** The task a session is trusted to: the only way a tool finds its target. */
  taskForSession(sessionId: string): ReportTask | undefined;
  proposeTask(sessionId: string, card: ProposedCard): { readonly ok: true; readonly task: ReportTask; readonly created: boolean } | Refusal;
  confirmTask(taskId: string): ReportTask;
  startResearch(taskId: string): ReportTask;
  failTask(taskId: string, error: string): void;
  getTask(taskId: string): ReportTask | undefined;
  search(taskId: string, input: { readonly query: string; readonly limit?: number; readonly targetSectionId?: string; readonly targetCell?: CellRef; readonly signal?: AbortSignal }): Promise<SearchResult | Refusal>;
  read(taskId: string, input: { readonly sourceId: string; readonly question: string; readonly terms?: readonly string[]; readonly targetCell?: CellRef; readonly maxEvidence?: number; readonly paragraphIndex?: number; readonly signal?: AbortSignal }): Promise<ReadResult | Refusal>;
  assess(taskId: string, input: { readonly proposals: readonly { readonly cell: CellRef; readonly evidenceIds?: readonly string[]; readonly note?: string }[]; readonly gapRound?: boolean }): AssessResult | Refusal;
  saveReport(taskId: string, draft: ReportDraft): SaveReportResult | Refusal;
  /**
   * The incremental path: accumulate the report across calls, then seal it.
   *
   * A full report does not fit in one step's output budget, so a model may
   * write it in parts. Accumulation is stored on the task, and only `finalize`
   * runs the validator — the same one the one-shot path uses.
   */
  saveReportPart(taskId: string, part: ReportPart): SaveReportResult | Refusal;
  reportDraftOf(taskId: string): ReportDraftState | null;
  state(taskId: string): WorkspaceState;
  cellsOf(taskId: string): readonly CellView[];
  sourcesOf(taskId: string): readonly Source[];
  evidenceOf(taskId: string): readonly Evidence[];
  reportsOf(taskId: string): readonly Report[];
  exportsOf(taskId: string): readonly ExportArtifact[];
  saveExport(artifact: ExportArtifact): void;
  runsOf(taskId: string): readonly ResearchRunRecord[];
  recordRun(record: ResearchRunRecord): void;
  listTasks(): readonly ReportTask[];
  snapshotTextOf(readId: string): string | undefined;
}

function sameCell(a: CellRef, b: CellRef): boolean {
  return a.sectionId === b.sectionId && a.subjectId === b.subjectId && a.dimensionId === b.dimensionId;
}

function locatorLabelOf(evidence: Evidence): string {
  const parts = (evidence.locator.headingPath ?? []).filter(
    (part): part is string => typeof part === "string" && part.trim().length > 0,
  );
  return parts.length > 0
    ? `${parts.join(" > ")}（第 ${evidence.locator.paragraphIndex + 1} 段）`
    : `第 ${evidence.locator.paragraphIndex + 1} 段`;
}

export function createResearchService(options: ResearchServiceOptions): ResearchService {
  const repo = options.repo;
  const now = options.now ?? (() => new Date());
  const searchImpl = options.search ?? ((query: string, searchOptions: { readonly limit: number; readonly signal?: AbortSignal }) => searchArxiv(query, searchOptions));
  const readImpl = options.read ?? ((request: { readonly url: string }, readOptions: { readonly signal?: AbortSignal }) => readSource(request, readOptions));

  const isoNow = (): string => now().toISOString();

  function requireTask(taskId: string): ReportTask {
    const task = repo.getTask(taskId);
    if (task === undefined) throw new Error(`没有找到研究任务：${taskId}`);
    return task;
  }

  function updateTask(task: ReportTask, patch: Partial<ReportTask>): ReportTask {
    const next: ReportTask = { ...task, ...patch, updatedAt: isoNow() };
    repo.updateTask(next);
    return next;
  }

  /** Recomputes every cell's coverage from the evidence that exists right now. */
  function recomputeMatrix(task: ReportTask): ReportTask {
    const evidence: readonly CoverageEvidence[] = repo.listEvidence(task.id).map((item) => ({
      id: item.id,
      readScope: item.readScope,
      cells: item.cells,
    }));
    const at = isoNow();
    const matrix = task.matrix.map((cell) => {
      const verdict = deriveCellCoverage({ sectionId: cell.sectionId, subjectId: cell.subjectId, dimensionId: cell.dimensionId }, evidence);
      return {
        ...cell,
        status: verdict.status,
        reason: verdict.reason,
        gap: verdict.status === "sufficient" ? "" : verdict.gap,
        evidenceIds: verdict.evidenceIds,
        updatedAt: at,
      };
    });
    return updateTask(task, { matrix });
  }

  function budgetRefusal(task: ReportTask, what: string, guidance: string): Refusal | undefined {
    const started = task.usage.startedAt;
    if (started !== undefined) {
      const elapsed = now().getTime() - new Date(started).getTime();
      if (elapsed > task.budget.deadlineMs) {
        return {
          ok: false,
          problems: [`研究时间预算已用尽（${Math.round(elapsed / 1000)} 秒 > ${Math.round(task.budget.deadlineMs / 1000)} 秒）`],
          guidance: "请基于现有证据生成报告；对没有依据的项目明确写出缺口，不要继续检索。",
        };
      }
    }
    switch (what) {
      case "search":
        if (task.usage.searches >= task.budget.maxSearches) {
          return {
            ok: false,
            problems: [`搜索次数已达上限（${task.usage.searches}/${task.budget.maxSearches}）`],
            guidance: "请读取已知候选来源，并用 assess_coverage 评估覆盖情况。",
          };
        }
        break;
      case "read":
        if (task.usage.reads >= task.budget.maxReads) {
          return {
            ok: false,
            problems: [`读取次数已达上限（${task.usage.reads}/${task.budget.maxReads}）`],
            guidance: "请停止读取，评估矩阵并用已有证据生成报告；缺少依据的项目如实标注。",
          };
        }
        break;
      case "gap":
        if (task.usage.gapRounds >= task.budget.maxGapRounds) {
          return {
            ok: false,
            problems: [`定向补查轮次已达上限（${task.usage.gapRounds}/${task.budget.maxGapRounds}）`],
            guidance: "补查预算已用完：请在报告中明确写出仍未找到依据的比较项。",
          };
        }
        break;
    }
    return undefined;
  }

  function cellViews(task: ReportTask): readonly CellView[] {
    const subjectNames = new Map(task.subjects.map((subject) => [subject.id, subject.name]));
    const dimensionNames = new Map(task.dimensions.map((dimension) => [dimension.id, dimension.name]));
    return task.matrix.map((cell) => ({
      sectionId: cell.sectionId,
      subjectId: cell.subjectId,
      dimensionId: cell.dimensionId,
      subjectName: subjectNames.get(cell.subjectId) ?? cell.subjectId,
      dimensionName: dimensionNames.get(cell.dimensionId) ?? cell.dimensionId,
      status: cell.status,
      reason: cell.reason,
      gap: cell.gap,
      evidenceIds: cell.evidenceIds,
      note: cell.note,
    }));
  }

  function refusalsOf(validation: ValidationResult): readonly string[] {
    return validation.problems;
  }

  return {
    taskForSession: (sessionId) => repo.taskForSession(sessionId),

    proposeTask(sessionId, card) {
      const normalized = normalizeCard(card);
      if (!normalized.ok) {
        return {
          ok: false,
          problems: normalized.problems.map((entry) => entry.problem),
          guidance: "请修正任务卡字段后重新提交（比较对象 2–4 个，研究维度 3–6 个，topic 必填）。",
        };
      }
      const existing = repo.taskForSession(sessionId);
      if (existing !== undefined) {
        // A confirmed card is the user's decision: a later proposal may not
        // silently rewrite the structure the research is already running on.
        if (existing.confirmedAt !== null) {
          return { ok: true, created: false, task: existing };
        }
        const next: ReportTask = {
          ...existing,
          ...normalized.value,
          structure: { sections: STRUCTURE_SECTIONS.map(({ required: _required, ...section }) => section) },
          matrix: buildMatrix(normalized.value.subjects, normalized.value.dimensions, isoNow()),
          updatedAt: isoNow(),
        };
        repo.updateTask(next);
        return { ok: true, created: false, task: next };
      }
      const task = createTask({ sessionId, card: normalized.value, now: isoNow() });
      repo.createTask(task);
      repo.bindSession(sessionId, task.id);
      return { ok: true, created: true, task };
    },

    confirmTask(taskId) {
      const task = requireTask(taskId);
      if (task.confirmedAt !== null) return task;
      return updateTask(task, { confirmedAt: isoNow(), status: "confirmed" });
    },

    startResearch(taskId) {
      const task = requireTask(taskId);
      return updateTask(task, { status: "researching", usage: { ...task.usage, startedAt: isoNow() } });
    },

    failTask(taskId, error) {
      const task = requireTask(taskId);
      updateTask(task, { status: "failed", error });
    },

    getTask: (taskId) => repo.getTask(taskId),

    async search(taskId, input) {
      const task = requireTask(taskId);
      const refusal = budgetRefusal(task, "search", "");
      if (refusal !== undefined) return refusal;

      const limit = Math.max(1, Math.min(task.budget.maxCandidatesPerSearch, input.limit ?? task.budget.maxCandidatesPerSearch));
      const outcome = await searchImpl(input.query, {
        limit,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });

      const known = new Set(repo.listSources(task.id).map((source) => source.url));
      const target: CellRef | null = input.targetCell ?? null;
      const created: SearchResult["sources"][number][] = [];
      for (const candidate of outcome.candidates) {
        const url = candidate.absUrl;
        const alreadyKnown = known.has(url);
        const existing = repo.listSources(task.id).find((source) => source.url === url);
        if (existing !== undefined) {
          created.push({
            sourceId: existing.id,
            title: existing.title,
            authors: existing.authors,
            year: (existing.publishedAt ?? "").slice(0, 4),
            url: existing.url,
            abstract: existing.abstract.slice(0, 400),
            alreadyKnown: true,
          });
          continue;
        }
        const source: Source = {
          id: newId(ID_PREFIX.source),
          taskId: task.id,
          title: candidate.title,
          authors: candidate.authors,
          org: "",
          url,
          pdfUrl: candidate.pdfUrl,
          doi: candidate.doi,
          publishedAt: candidate.publishedAt,
          venue: candidate.primaryCategory.length > 0 ? `arXiv ${candidate.primaryCategory}` : "arXiv",
          abstract: candidate.abstract,
          discovery: {
            provider: outcome.provider,
            query: input.query,
            queriedAt: outcome.fetchedAt,
            target,
          },
          readStatus: "not_read",
          readScope: null,
          readAt: null,
          readUrl: null,
          retrievalNote: "",
          failure: null,
          snapshotId: null,
        };
        repo.addSource(source);
        known.add(url);
        created.push({
          sourceId: source.id,
          title: source.title,
          authors: source.authors.slice(0, 4),
          year: (source.publishedAt ?? "").slice(0, 4),
          url: source.url,
          abstract: source.abstract.slice(0, 400),
          alreadyKnown,
        });
      }

      const searches = task.usage.searches + 1;
      updateTask(task, { usage: { ...task.usage, searches } });

      return {
        ok: true,
        sources: created,
        query: input.query,
        requestUrl: outcome.requestUrl,
        total: outcome.total,
        searchCount: searches,
        searchesRemaining: Math.max(0, task.budget.maxSearches - searches),
        note:
          created.length === 0
            ? "本次检索没有返回候选：请换英文关键词或更基础的术语。搜索结果只是候选，不是依据。"
            : "以上是检索候选（metadata）。只有 read_source 真正读取后才会产生可引用证据。",
      };
    },

    async read(taskId, input) {
      const task = requireTask(taskId);
      const source = repo.getSource(input.sourceId);
      if (source === undefined || source.taskId !== task.id) {
        return {
          ok: false,
          problems: [`来源 ${input.sourceId} 不属于当前任务或不存在`],
          guidance: "请使用 search_sources 返回的 sourceId，不要自行编造。",
        };
      }

      const targetCells: readonly CellRef[] = input.targetCell === undefined ? [] : [input.targetCell];
      const terms = [...(input.terms ?? []), ...tokenize(input.question)];

      // A source already read is reused, not re-fetched: the saved snapshot is
      // the thing evidence may quote, and re-reading the network would spend the
      // task's read budget to obtain text it already has.
      let snapshot = source.snapshotId === null ? undefined : repo.getSnapshot(source.snapshotId);
      let reuse = snapshot !== undefined;
      let note = "";

      if (snapshot === undefined) {
        const refusal = budgetRefusal(task, "read", "");
        if (refusal !== undefined) return refusal;

        const outcome = await readImpl({ url: source.url }, input.signal === undefined ? {} : { signal: input.signal });
        const reads = task.usage.reads + 1;
        if (outcome.status === "failed" || outcome.scope === null) {
          repo.updateSource({
            ...source,
            readStatus: "failed",
            readScope: null,
            readAt: outcome.fetchedAt,
            readUrl: outcome.readUrl,
            retrievalNote: outcome.note,
            failure: outcome.failure,
          });
          updateTask(task, { usage: { ...task.usage, reads } });
          return {
            ok: false,
            problems: [`读取失败：${outcome.failure ?? outcome.note}`],
            guidance:
              "该来源的正文没有取到（失败状态已记录，不能作为证据）。请改为读取其他候选，或对该维度如实标注缺口。",
          };
        }

        snapshot = {
          id: newId(ID_PREFIX.read),
          taskId: task.id,
          sourceId: source.id,
          url: outcome.readUrl,
          fetchedAt: outcome.fetchedAt,
          scope: outcome.scope,
          title: outcome.title,
          text: outcome.text,
          paragraphs: outcome.paragraphs,
          note: outcome.note,
        };
        repo.saveSnapshot(snapshot);
        repo.updateSource({
          ...source,
          readStatus: "ok",
          readScope: outcome.scope,
          readAt: outcome.fetchedAt,
          readUrl: outcome.readUrl,
          retrievalNote: outcome.note,
          failure: null,
          snapshotId: snapshot.id,
        });
        updateTask(task, { usage: { ...task.usage, reads } });
        note = outcome.note;
      } else {
        note = `${snapshot.note}（复用已保存读取快照，未重复消耗读取预算）`;
      }

      // Evidence comes from the saved text, and from a range that is verified
      // before it is stored — the model never supplies characters.
      const maxEvidence = Math.max(1, Math.min(5, input.maxEvidence ?? 3));
      const picks =
        input.paragraphIndex === undefined
          ? pickParagraphs(snapshot.paragraphs, terms, maxEvidence)
          : snapshot.paragraphs
              .filter((paragraph) => paragraph.index === input.paragraphIndex)
              .slice(0, 1)
              .map((paragraph) => ({ paragraph, score: 1, because: "按指定段落建立证据" }));

      if (picks.length === 0) {
        return {
          ok: false,
          problems: [`在 ${source.title} 中没有找到可用的段落（段落数 ${snapshot.paragraphs.length}）`],
          guidance: "可以换 read_source 的 question/terms，或读取其他来源。",
        };
      }

      const createdEvidence: Evidence[] = [];
      for (const pick of picks) {
        const evidence = draftEvidence({
          taskId: task.id,
          sourceId: source.id,
          readId: snapshot.id,
          readScope: snapshot.scope,
          draft: { paragraph: pick.paragraph, cells: targetCells, pickedBecause: pick.because },
          now: isoNow(),
        });
        const check = verifyEvidenceText(evidence, snapshot.text);
        if (!check.ok) continue;
        repo.addEvidence(evidence);
        createdEvidence.push(evidence);
      }

      recomputeMatrix(requireTask(task.id));
      const refreshed = requireTask(task.id);

      return {
        ok: true,
        sourceId: source.id,
        title: source.title,
        readStatus: "ok",
        readScope: snapshot.scope,
        readUrl: snapshot.url,
        textChars: snapshot.text.length,
        paragraphCount: snapshot.paragraphs.length,
        reuse,
        evidence: createdEvidence.map((evidence) => ({
          evidenceId: evidence.id,
          excerpt: evidence.excerpt.length > 500 ? `${evidence.excerpt.slice(0, 500)}…` : evidence.excerpt,
          locator: locatorLabelOf(evidence),
          scope: scopeLabel(evidence.readScope),
          pickedBecause: evidence.pickedBecause,
        })),
        readsRemaining: Math.max(0, refreshed.budget.maxReads - refreshed.usage.reads),
        note: `${note}（读取范围：${scopeLabel(snapshot.scope)}；excerpt 均为保存文本中的原样片段）`,
      };
    },

    assess(taskId, input) {
      let task = requireTask(taskId);
      if (input.gapRound === true) {
        const refusal = budgetRefusal(task, "gap", "");
        if (refusal !== undefined) return refusal;
        task = updateTask(task, { usage: { ...task.usage, gapRounds: task.usage.gapRounds + 1 } });
      }

      const allEvidence = repo.listEvidence(task.id);
      const byId = new Map(allEvidence.map((evidence) => [evidence.id, evidence]));
      const knownCells = task.matrix;

      for (const proposal of input.proposals) {
        const cell = knownCells.find(
          (candidate) =>
            candidate.sectionId === proposal.cell.sectionId &&
            candidate.subjectId === proposal.cell.subjectId &&
            candidate.dimensionId === proposal.cell.dimensionId,
        );
        if (cell === undefined) continue;

        // Binding an existing, verified passage to a cell is the model's
        // judgement — the passage and its text stay the program's, and the
        // status that follows is still derived from scope, never from the model.
        for (const evidenceId of proposal.evidenceIds ?? []) {
          const evidence = byId.get(evidenceId);
          if (evidence === undefined || evidence.taskId !== task.id) continue;
          if (evidence.cells.some((ref) => sameCell(ref, proposal.cell))) continue;
          const updated: Evidence = { ...evidence, cells: [...evidence.cells, proposal.cell] };
          byId.set(evidenceId, updated);
          repo.updateEvidence(updated);
        }

        if (proposal.note !== undefined && proposal.note.trim() !== "") {
          const index = task.matrix.findIndex((candidate) => candidate === cell);
          if (index >= 0) {
            const matrix = [...task.matrix];
            matrix[index] = { ...cell, note: proposal.note.trim().slice(0, 300) };
            task = updateTask(task, { matrix });
          }
        }
      }

      task = recomputeMatrix(requireTask(task.id));
      const views = cellViews(task);
      const gaps = views
        .filter((cell) => cell.status === "missing" || cell.status === "partial")
        .sort((a, b) => (a.status === b.status ? 0 : a.status === "missing" ? -1 : 1));

      return {
        ok: true,
        cells: views,
        gaps,
        gapRoundsUsed: task.usage.gapRounds,
        gapRoundsRemaining: Math.max(0, task.budget.maxGapRounds - task.usage.gapRounds),
        note:
          gaps.length === 0
            ? "所有单元格都有正文级证据。若有新增材料，可用 read_source 继续增强。"
            : `仍有 ${gaps.length} 个单元格缺少充分依据。若补查预算允许，可优先处理缺口最大的项目；否则在报告中如实写明缺口。`,
      };
    },

    saveReportPart(taskId, part) {
      let task = requireTask(taskId);
      const current: ReportDraftState =
        task.reportDraft ?? { title: "", summary: "", claims: [], sections: [], updatedAt: isoNow() };

      if (part.kind === "clear") {
        updateTask(task, { reportDraft: null });
        return { ok: true, reportId: "", citations: 0, references: 0, warnings: ["已清空报告草稿"], missingCells: 0 };
      }

      if (part.kind !== "finalize") {
        const claims = part.claims === undefined ? current.claims : mergeClaims(current.claims, part.claims);
        const sections =
          part.section === undefined
            ? current.sections
            : [...current.sections.filter((section) => section.id !== part.section?.id), part.section];
        const draft: ReportDraftState = {
          title: part.title ?? current.title,
          summary: part.summary ?? current.summary,
          claims,
          sections,
          updatedAt: isoNow(),
        };
        task = updateTask(task, { reportDraft: draft });
        return {
          ok: true,
          reportId: "",
          citations: 0,
          references: 0,
          warnings: [
            `草稿已保存：claims ${draft.claims.length} 条，sections ${draft.sections.length} 节（${
              REQUIRED_SECTION_IDS.filter((id) => draft.sections.some((section) => section.id === id)).length
            }/${REQUIRED_SECTION_IDS.length} 个必需章节已提交）`,
          ],
          missingCells: 0,
        };
      }

      if (current.title.trim() === "" || current.summary.trim() === "" || current.sections.length === 0) {
        return {
          ok: false,
          problems: ["报告草稿还不完整：请先用 save_report 提交 title/summary，再逐节提交 sections，然后 finalize"],
          guidance: "可以先 part=\"start\" 提交标题与摘要，再多次 part=\"section\" 提交章节，最后 part=\"finalize\"。",
        };
      }

      // Finalize goes through the same validator as the one-shot path.
      const sealed = this.saveReport(task.id, {
        title: current.title,
        summary: current.summary,
        sections: current.sections,
        claims: current.claims,
      });
      if (!sealed.ok) return sealed;
      const done = requireTask(task.id);
      updateTask(done, { reportDraft: null });
      return sealed;
    },

    reportDraftOf: (taskId) => requireTask(taskId).reportDraft,

    saveReport(taskId, draft) {
      const task = requireTask(taskId);
      const evidence = repo.listEvidence(task.id);
      const validation = validateReport({
        draft,
        task,
        evidence,
        snapshotText: (readId) => repo.getSnapshot(readId)?.text,
        now: isoNow(),
      });

      if (!validation.ok) {
        return {
          ok: false,
          problems: refusalsOf(validation),
          guidance:
            "报告未通过校验：请修正引用（只能使用 load_research_state 中存在的 evidence ID），或删除无法核实的论断后重新保存。",
        };
      }

      const citations = buildCitations({ draft, sources: repo.listSources(task.id), evidence });
      const gaps = missingCells(task);
      const warnings: string[] = [];
      if (gaps.length > 0) {
        warnings.push(`矩阵中仍有 ${gaps.length} 个单元格为 partial/missing，渲染时会附加程序生成的「证据缺口清单」。`);
      }
      const reportId = newId(ID_PREFIX.report);
      const report = sealReport({ id: reportId, taskId: task.id, draft, validation, now: isoNow() });
      repo.saveReport(report);
      updateTask(task, { status: "ready", currentReportId: reportId, error: null });

      return {
        ok: true,
        reportId,
        citations: citations.evidenceIndex.length,
        references: citations.references.length,
        warnings,
        missingCells: gaps.length,
      };
    },

    state(taskId) {
      const task = requireTask(taskId);
      const sources = repo.listSources(task.id);
      const evidence = repo.listEvidence(task.id);
      return {
        task: {
          id: task.id,
          topic: task.topic,
          purpose: task.purpose,
          audience: task.audience,
          focus: task.focus,
          exclusions: task.exclusions,
          language: task.language,
          lengthTarget: task.lengthTarget,
          status: task.status,
          confirmed: task.confirmedAt !== null,
        },
        structure: task.structure.sections.map((section) => ({ id: section.id, title: section.title, question: section.question })),
        subjects: task.subjects.map((subject) => ({ id: subject.id, name: subject.name })),
        dimensions: task.dimensions.map((dimension) => ({ id: dimension.id, name: dimension.name, question: dimension.question })),
        cells: cellViews(task),
        sources: sources.map((source) => ({
          sourceId: source.id,
          title: source.title,
          readStatus: source.readStatus,
          readScope: source.readScope,
          url: source.url,
        })),
        evidence: evidence.map((item) => ({
          evidenceId: item.id,
          sourceId: item.sourceId,
          excerpt: item.excerpt.length > 200 ? `${item.excerpt.slice(0, 200)}…` : item.excerpt,
          locator: locatorLabelOf(item),
          scope: scopeLabel(item.readScope),
        })),
        usage: task.usage,
        budget: task.budget,
        currentReportId: task.currentReportId,
      };
    },

    cellsOf: (taskId) => cellViews(requireTask(taskId)),
    sourcesOf: (taskId) => repo.listSources(taskId),
    evidenceOf: (taskId) => repo.listEvidence(taskId),
    reportsOf: (taskId) => repo.listReports(taskId),
    exportsOf: (taskId) => repo.listExports(taskId),
    saveExport: (artifact) => repo.saveExport(artifact),
    runsOf: (taskId) => repo.listRuns(taskId),
    recordRun: (record) => repo.recordRun(record),
    listTasks: () => repo.listTasks(),
    snapshotTextOf: (readId) => repo.getSnapshot(readId)?.text,
  };
}

/** The sections a report is not publishable without. */
export const REQUIRED_SECTION_IDS: readonly string[] = ["overview", "representative", "comparison", "limitations"];

/** Replaces claims by id, keeping the order the draft already had. */
function mergeClaims(current: readonly ReportClaim[], incoming: readonly ReportClaim[]): readonly ReportClaim[] {
  const byId = new Map(current.map((claim) => [claim.id, claim]));
  for (const claim of incoming) byId.set(claim.id, claim);
  return [...byId.values()];
}

/** The structure's own section ids, for callers that validate a draft's shape. */
export const SECTION_IDS: readonly string[] = STRUCTURE_SECTIONS.map((section) => section.id);

/** Re-exported so a caller can mint ids for its own artifacts consistently. */
export { ID_PREFIX };
export type { ReportClaim, ReportSection };
export { slugId };
