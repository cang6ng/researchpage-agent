/**
 * The report truth boundary: validation, and the citation numbering a renderer
 * may rely on.
 *
 * A model writes the report's *content* — sections, paragraphs, claims — and
 * nothing else. Whether that content may be published is decided here: every
 * cited evidence id has to exist, belong to this task, and still verify against
 * the read it came from. A report that fails keeps its problems as its answer
 * and is not saved, so a fabricated citation cannot reach a reader through a
 * "just this once" path.
 *
 * Citation numbers are minted here too, from the order claims are referenced in
 * the document, because numbering is presentation and presentation is the
 * program's business — the same numbers serve the screen and the PDF.
 */

import type {
  Evidence,
  MatrixCell,
  QualityCheckRecord,
  ReadScope,
  Report,
  ReportBlock,
  ReportClaim,
  ReportFrame,
  ReportGapNote,
  ReportSection,
  ReportTask,
  Source,
  SupportAssessment,
} from "./domain.js";
import { hashOf } from "./hash.js";
import { needsAttention } from "./domain.js";
import { blueprintById, type BlueprintSpec } from "./blueprint.js";
import { validateArtifactQuality } from "./artifact.js";

export interface ReportDraft {
  readonly title: string;
  readonly summary: string;
  readonly frame?: ReportFrame;
  readonly sections: readonly ReportSection[];
  readonly claims: readonly ReportClaim[];
}

export interface ValidationInput {
  readonly draft: ReportDraft;
  readonly task: ReportTask;
  readonly evidence: readonly Evidence[];
  /** The saved read text for one read id; undefined means the read is missing. */
  readonly snapshotText: (readId: string) => string | undefined;
  /** The task's sources, needed to judge whether a claim's material is the right kind. */
  readonly sources?: readonly Source[];
  /** The saved support judgements, needed for claim adequacy. */
  readonly assessments?: readonly SupportAssessment[];
  /**
   * Section ids this draft did not write, when it is an edit of a report.
   *
   * Passing them keeps the content contract from punishing an edit for a fault
   * it does not touch: a blank the report already carried is reported as a
   * warning, while a blank in the content being written now is an error. A
   * fresh save passes nothing, which is how every new report meets the whole
   * contract.
   */
  readonly carriedOverSectionIds?: readonly string[];
  readonly now: string;
}

export interface ValidationResult {
  readonly ok: boolean;
  readonly problems: readonly string[];
  /** Obligations that were not met but do not block publication. */
  readonly warnings: readonly string[];
  /** The Q-series record, when the task is written under a blueprint. */
  readonly checks: readonly QualityCheckRecord[];
}

/** Sections a technical comparison report must actually contain. */
const REQUIRED_SECTIONS = ["overview", "representative", "comparison", "limitations"] as const;

function blocksOf(section: ReportSection): readonly ReportBlock[] {
  return section.blocks;
}

function blockClaimIds(block: ReportBlock): readonly string[] {
  switch (block.kind) {
    case "paragraph":
      return block.claimIds;
    case "list":
      return block.items.flatMap((item) => item.claimIds);
    case "table":
      return block.rows.flatMap((row) => (Array.isArray(row.cells) ? row.cells : []).flatMap((cell) => cell.claimIds));
    case "callout":
      return [];
    case "mechanism":
      return [...block.claimIds, ...block.steps.flatMap((step) => step.claimIds)];
  }
}

/**
 * Validates a report draft against the task's real materials.
 *
 * Two layers run here, and a reader can tell them apart in the result. The
 * truth boundary — required structure, every claim carrying resolvable
 * evidence, every excerpt still sitting where its read says it does — is
 * checked for every task, old and new. The artifact quality contract runs on
 * top of it when the task was written under a blueprint, and asks the harder
 * questions: is there a declared question, a mental model before the
 * comparison, a real mechanism, a comparison under shared conditions, a
 * synthesis, and a claim contract each statement obeys.
 *
 * Wording and whether a conclusion is *wise* are still not checked: those are
 * for the reader, and pretending a validator can judge them would be the
 * dishonest part.
 */
export function validateReport(input: ValidationInput): ValidationResult {
  const problems: string[] = [];
  const warnings: string[] = [];
  const checks: QualityCheckRecord[] = [];
  const byId = new Map(input.evidence.map((item) => [item.id, item]));
  const claimIds = new Set(input.draft.claims.map((claim) => claim.id));
  const blueprint: BlueprintSpec | undefined = blueprintById(input.task.blueprintId);

  // A task written under a blueprint has its sections checked by the artifact
  // contract below, which knows what each section owes; a legacy task keeps the
  // simple "these four sections exist and have content" rule it was written to.
  const requiredSections = blueprint === undefined ? REQUIRED_SECTIONS : [];
  for (const sectionId of requiredSections) {
    const section = input.draft.sections.find((candidate) => candidate.id === sectionId);
    if (section === undefined) {
      problems.push(`缺少必需章节：${sectionId}`);
      continue;
    }
    const hasContent = section.blocks.some((block) => {
      if (block.kind === "paragraph") return block.text.trim().length > 0;
      if (block.kind === "list") return block.items.length > 0;
      if (block.kind === "table") return block.rows.length > 0;
      if (block.kind === "mechanism") return block.steps.length > 0;
      return block.text.trim().length > 0;
    });
    if (!hasContent) problems.push(`章节「${section.title}」没有任何内容`);
  }

  if (input.draft.claims.length === 0) problems.push("报告没有任何 claim");

  for (const claim of input.draft.claims) {
    if (claim.text.trim().length === 0) problems.push(`claim ${claim.id} 文本为空`);
    if (claim.evidenceIds.length === 0) {
      problems.push(`claim ${claim.id} 没有任何 evidence（非综合论断不允许无依据）`);
      continue;
    }
    for (const evidenceId of claim.evidenceIds) {
      const evidence = byId.get(evidenceId);
      if (evidence === undefined) {
        problems.push(`claim ${claim.id} 引用了不存在的 evidence：${evidenceId}`);
        continue;
      }
      if (evidence.taskId !== input.task.id) {
        problems.push(`claim ${claim.id} 引用了其他任务的 evidence：${evidenceId}`);
        continue;
      }
      const text = input.snapshotText(evidence.readId);
      if (text === undefined) {
        problems.push(`evidence ${evidenceId} 的读取快照缺失`);
        continue;
      }
      const slice = text.slice(evidence.locator.charStart, evidence.locator.charEnd);
      if (slice !== evidence.excerpt) {
        problems.push(`evidence ${evidenceId} 的片段与读取文本不一致（不可引用）`);
      }
    }
  }

  for (const section of input.draft.sections) {
    for (const block of blocksOf(section)) {
      for (const id of blockClaimIds(block)) {
        if (!claimIds.has(id)) {
          problems.push(`章节「${section.title}」引用了不存在的 claim：${id}`);
        }
      }
    }
  }

  if (blueprint !== undefined) {
    const artifact = validateArtifactQuality({
      draft: input.draft,
      task: input.task,
      blueprint,
      evidence: input.evidence,
      sources: input.sources ?? [],
      assessments: input.assessments ?? [],
      ...(input.carriedOverSectionIds === undefined ? {} : { carriedOverSectionIds: input.carriedOverSectionIds }),
    });
    problems.push(...artifact.errors);
    warnings.push(...artifact.warnings);
    checks.push(...artifact.checks);
  }

  return { ok: problems.length === 0, problems, warnings, checks } as ValidationResult;
}

/**
 * The hash a proposal pins and a revision records.
 *
 * It covers the report's own content — wording, claims, their evidence ids —
 * and deliberately not its validation stamp or timestamps, so "the text is
 * unchanged" means exactly that.
 */
export function reportContentHash(report: {
  readonly title: string;
  readonly summary: string;
  readonly frame?: ReportFrame;
  readonly sections: readonly ReportSection[];
  readonly claims: readonly ReportClaim[];
}): string {
  return hashOf({
    title: report.title,
    summary: report.summary,
    frame: report.frame ?? null,
    sections: report.sections,
    claims: report.claims,
  });
}

/**
 * The evidence a report's text actually stands on, in order of first use.
 *
 * Only evidence a block's claim cites counts: material that was found but never
 * quoted is not part of the document, and must not reach a reference list or a
 * frozen dependency bundle.
 */
export function evidenceUsedBy(draft: {
  readonly sections: readonly ReportSection[];
  readonly claims: readonly ReportClaim[];
}): readonly string[] {
  const claimById = new Map(draft.claims.map((claim) => [claim.id, claim]));
  const used: string[] = [];
  const seen = new Set<string>();
  for (const section of draft.sections) {
    for (const block of blocksOf(section)) {
      for (const claimId of blockClaimIds(block)) {
        const claim = claimById.get(claimId);
        if (claim === undefined) continue;
        for (const evidenceId of claim.evidenceIds) {
          if (seen.has(evidenceId)) continue;
          seen.add(evidenceId);
          used.push(evidenceId);
        }
      }
    }
  }
  return used;
}

/** The gap appendix as it stood at save time, with reader-facing names copied in. */
export function gapNotesOf(task: ReportTask): readonly ReportGapNote[] {
  const subjectNames = new Map(task.subjects.map((subject) => [subject.id, subject.name]));
  const dimensionNames = new Map(task.dimensions.map((dimension) => [dimension.id, dimension.name]));
  return task.matrix
    .filter((cell) => cell.status !== "reviewed")
    .map((cell) => ({
      sectionId: cell.sectionId,
      subjectId: cell.subjectId,
      subjectName: subjectNames.get(cell.subjectId) ?? cell.subjectId,
      dimensionId: cell.dimensionId,
      dimensionName: dimensionNames.get(cell.dimensionId) ?? cell.dimensionId,
      status: cell.status,
      reason: cell.reason,
      gap: cell.gap.length > 0 ? cell.gap : cell.reason,
    }));
}

/**
 * The source fields a citation needs.
 *
 * Deliberately narrower than `Source`: a source read back from the business
 * database and a source copied into a frozen revision both satisfy it, which is
 * what lets one renderer serve the live preview and an archived export.
 */
export interface CitationSource {
  readonly id: string;
  readonly title: string;
  readonly authors: readonly string[];
  readonly org: string;
  readonly venue: string;
  readonly publishedAt: string | null;
  readonly url: string;
  readonly doi: string | null;
  readonly readScope: ReadScope | null;
}

/** The evidence fields a citation needs, for the same reason. */
export interface CitationEvidence {
  readonly id: string;
  readonly sourceId: string;
  readonly excerpt: string;
  readonly readScope: ReadScope;
  readonly locator: { readonly headingPath: readonly string[]; readonly paragraphIndex: number };
}

export interface CitationReference {
  readonly number: number;
  readonly sourceId: string;
  readonly source: CitationSource;
}

export interface EvidenceIndexEntry {
  readonly number: number;
  readonly evidenceId: string;
  readonly sourceId: string;
  readonly excerpt: string;
  readonly scope: ReadScope;
  readonly headingPath: readonly string[];
  readonly paragraphIndex: number;
}

export interface Citations {
  readonly references: readonly CitationReference[];
  readonly evidenceIndex: readonly EvidenceIndexEntry[];
  /** Reference numbers for one claim, in document order. */
  readonly numbersForClaim: ReadonlyMap<string, readonly number[]>;
  /** Source id → reference number. */
  readonly numberBySource: ReadonlyMap<string, number>;
}

/**
 * Numbers the sources a report actually cites, in order of first use.
 *
 * Only cited material gets a number: a source that was found but never quoted
 * is not a reference, and an evidence item that no claim uses has no business
 * appearing in the index either.
 */
export function buildCitations(input: {
  readonly draft: ReportDraft;
  readonly sources: readonly CitationSource[];
  readonly evidence: readonly CitationEvidence[];
}): Citations {
  const sourceById = new Map(input.sources.map((source) => [source.id, source]));
  const evidenceById = new Map(input.evidence.map((item) => [item.id, item]));

  const usedEvidenceIds = evidenceUsedBy(input.draft);

  const numberBySource = new Map<string, number>();
  const references: CitationReference[] = [];
  const evidenceIndex: EvidenceIndexEntry[] = [];
  const numbersForClaim = new Map<string, readonly number[]>();

  for (const evidenceId of usedEvidenceIds) {
    const evidence = evidenceById.get(evidenceId);
    if (evidence === undefined) continue;
    let number = numberBySource.get(evidence.sourceId);
    if (number === undefined) {
      const source = sourceById.get(evidence.sourceId);
      if (source === undefined) continue;
      number = references.length + 1;
      numberBySource.set(evidence.sourceId, number);
      references.push({ number, sourceId: evidence.sourceId, source });
    }
    evidenceIndex.push({
      number,
      evidenceId,
      sourceId: evidence.sourceId,
      excerpt: evidence.excerpt,
      scope: evidence.readScope,
      headingPath: evidence.locator.headingPath,
      paragraphIndex: evidence.locator.paragraphIndex,
    });
  }

  for (const claim of input.draft.claims) {
    const numbers: number[] = [];
    for (const evidenceId of claim.evidenceIds) {
      const evidence = evidenceById.get(evidenceId);
      if (evidence === undefined) continue;
      const number = numberBySource.get(evidence.sourceId);
      if (number !== undefined && !numbers.includes(number)) numbers.push(number);
    }
    numbersForClaim.set(claim.id, numbers);
  }

  return { references, evidenceIndex, numbersForClaim, numberBySource };
}

/** The cells a report still owes an answer for, as the reader should see them. */
export function missingCells(task: ReportTask): readonly MatrixCell[] {
  return task.matrix.filter((cell) => needsAttention(cell.status));
}

/**
 * Whether a heading and a source title name the same work.
 *
 * The two rarely match character for character — a discovery title from arXiv
 * says "A Graph RAG Approach" where the paper's own HTML says "A GraphRAG
 * Approach" — so the comparison ignores case, punctuation and spacing, and
 * accepts one being a prefix of the other. Short headings are compared exactly:
 * a heading like "Methods" is not a title, however the prefixes look.
 */
export function sameWorkTitle(heading: string, sourceTitle: string): boolean {
  const normalize = (value: string): string => value.toLowerCase().replace(/[^a-z0-9一-鿿]/g, "");
  const a = normalize(heading);
  const b = normalize(sourceTitle);
  if (a.length === 0 || b.length === 0) return false;
  if (a.length < 12 || b.length < 12) return a === b;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

/**
 * A heading path as one readable line.
 *
 * arXiv's HTML puts the paper title in the first heading, so a path would
 * otherwise read as the title twice; the part that repeats the source title is
 * dropped when the caller knows it.
 */
export function locatorLabel(headingPath: readonly string[], paragraphIndex: number, sourceTitle?: string): string {
  // A stored path may have come from a document that skipped heading levels;
  // holes are dropped rather than rendered, and never dereferenced.
  const parts = (headingPath ?? []).filter((part): part is string => typeof part === "string" && part.trim().length > 0);
  const trimmed =
    sourceTitle !== undefined && parts.length > 1 && sameWorkTitle(parts[0] ?? "", sourceTitle)
      ? parts.slice(1)
      : parts;
  const path = trimmed.join(" > ");
  return path.length > 0 ? `${path}（第 ${paragraphIndex + 1} 段）` : `第 ${paragraphIndex + 1} 段`;
}

/** The report as it is saved: the validated draft plus the program's own stamps. */
export function sealReport(input: {
  readonly id: string;
  readonly taskId: string;
  readonly draft: ReportDraft;
  readonly validation: ValidationResult;
  readonly now: string;
  /**
   * The task's matrix at this moment. Its outstanding cells become the report's
   * own gap appendix, so a document never shows gaps that were found later.
   */
  readonly task?: ReportTask;
}): Report {
  const report: Report = {
    id: input.id,
    taskId: input.taskId,
    title: input.draft.title,
    summary: input.draft.summary,
    ...(input.draft.frame === undefined ? {} : { frame: input.draft.frame }),
    sections: input.draft.sections,
    claims: input.draft.claims,
    validation: {
      ok: input.validation.ok,
      problems: input.validation.problems,
      warnings: input.validation.warnings,
      checks: input.validation.checks,
      checkedAt: input.now,
    },
    createdAt: input.now,
    contentHash: reportContentHash(input.draft),
  };
  return input.task === undefined ? report : { ...report, gapsAtSave: gapNotesOf(input.task) };
}
