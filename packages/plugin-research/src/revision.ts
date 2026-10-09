/**
 * A frozen revision: the report, plus every dependency it was written from.
 *
 * The problem this solves is the one that made old exports untrustworthy. A
 * report record holds the wording, but a PDF also shows citation metadata, an
 * evidence index and the gap appendix — all of which used to be read from the
 * task's *current* state at render time. Re-exporting last week's report after
 * a week of research produced a document that mixed last week's text with this
 * week's sources, and nothing in the file said so.
 *
 * A revision therefore copies what it needs to be re-rendered on its own: the
 * structured report, the frame it was written under, the sources and evidence
 * it cites (with the location and text needed to check a quote), the support
 * assessments behind its claims, and the gaps that were still open when it was
 * saved. It deliberately does not copy whole documents: an excerpt and a
 * locator are enough to verify a citation, and the read snapshot ids remain the
 * way back to the original text.
 */

import type {
  MatrixCell,
  ReadScope,
  Report,
  ReportBlock,
  ReportClaim,
  ReportFrame,
  ReportSection,
  ReportTask,
  Source,
  SupportAssessment,
} from "./domain.js";
import { ID_PREFIX } from "./domain.js";
import { hashOf } from "./hash.js";
import { evidenceUsedBy } from "./report.js";
import { newId } from "./repository.js";

/**
 * Named so an old file can say which program produced it.
 *
 * The version moves when the *document* changes: 2.1.0 widened the comparison
 * table's layout and stopped moving a row's first cell into a heading, which
 * changes what a reader sees without changing a byte of the report's content.
 */
export const RENDERER = Object.freeze({ name: "researchpage-report-html", version: "2.1.0" });

/**
 * A renderer stamp as a revision carries it.
 *
 * The version is a string rather than the literal the current renderer happens
 * to have: a revision frozen by an earlier build records *that* build's version,
 * and a reader has to be able to compare the two without the type refusing to
 * represent one of them.
 */
export interface RendererStamp {
  readonly name: string;
  readonly version: string;
}

/** The default theme; v1 renders one theme, and switching one is a later step. */
export const DEFAULT_THEME_ID = "editorial";

/** One quoted passage, with everything needed to re-render and re-check it. */
export interface FrozenEvidenceRef {
  readonly evidenceId: string;
  readonly sourceId: string;
  readonly readId: string;
  readonly excerpt: string;
  readonly locator: {
    readonly paragraphIndex: number;
    readonly headingPath: readonly string[];
    readonly charStart: number;
    readonly charEnd: number;
  };
  readonly readScope: ReadScope;
  readonly cells: readonly { readonly sectionId: string; readonly subjectId: string; readonly dimensionId: string }[];
  readonly createdAt: string;
}

/** The citation metadata a reference list needs, and nothing more. */
export interface FrozenSourceRef {
  readonly sourceId: string;
  readonly title: string;
  readonly authors: readonly string[];
  readonly org: string;
  readonly venue: string;
  readonly publishedAt: string | null;
  readonly url: string;
  readonly doi: string | null;
  readonly readScope: ReadScope | null;
}

/** One gap as the report's own appendix showed it. */
export interface FrozenGap {
  readonly sectionId: string;
  readonly subjectId: string;
  readonly subjectName: string;
  readonly dimensionId: string;
  readonly dimensionName: string;
  readonly status: MatrixCell["status"];
  readonly reason: string;
  readonly gap: string;
}

/** The research frame the report was written under. */
export interface FrozenFrame {
  readonly topic: string;
  readonly purpose: string;
  readonly audience: string;
  readonly focus: readonly string[];
  readonly exclusions: string;
  readonly lengthTarget: string;
  readonly structure: readonly { readonly id: string; readonly title: string; readonly question: string }[];
  readonly subjects: readonly { readonly id: string; readonly name: string }[];
  readonly dimensions: readonly { readonly id: string; readonly name: string; readonly question: string }[];
}

export interface FrozenRevision {
  readonly id: string;
  readonly taskId: string;
  readonly reportId: string;
  /** 1-based, per task, in the order revisions were frozen. */
  readonly revision: number;
  readonly contentHash: string;
  readonly report: {
    readonly id: string;
    readonly title: string;
    readonly summary: string;
    /** The research question, audience and scope the report declared. */
    readonly frame?: ReportFrame;
    readonly sections: readonly ReportSection[];
    readonly claims: readonly ReportClaim[];
    readonly validation: Report["validation"];
    readonly createdAt: string;
  };
  readonly frame: FrozenFrame;
  readonly claimsUsed: readonly string[];
  readonly evidenceRefs: readonly FrozenEvidenceRef[];
  readonly readIds: readonly string[];
  readonly sourceRefs: readonly FrozenSourceRef[];
  readonly assessments: readonly SupportAssessment[];
  /**
   * Whether the report carried a gap snapshot. A legacy report does not, and
   * the revision says so instead of inventing an appendix for it.
   */
  readonly gapsCaptured: boolean;
  readonly gaps: readonly FrozenGap[];
  readonly themeId: string;
  readonly renderer: RendererStamp;
  readonly createdAt: string;
}

export interface RevisionBundleInput {
  readonly task: ReportTask;
  readonly report: Report;
  readonly sources: readonly Source[];
  readonly evidence: readonly {
    readonly id: string;
    readonly sourceId: string;
    readonly readId: string;
    readonly excerpt: string;
    readonly locator: FrozenEvidenceRef["locator"];
    readonly readScope: ReadScope;
    readonly cells: FrozenEvidenceRef["cells"];
    readonly createdAt: string;
  }[];
  readonly assessments: readonly SupportAssessment[];
  readonly revision: number;
  readonly now: string;
  readonly themeId?: string;
}

/**
 * Builds the dependency bundle for one report.
 *
 * Only material the report actually stands on is copied: the evidence its
 * claims cite, the sources those passages came from, and the assessments that
 * judged them. A source that was found but never quoted is not part of the
 * document, so it is not part of the revision either.
 */
export function buildRevisionBundle(input: RevisionBundleInput): FrozenRevision {
  const draft: { readonly sections: readonly ReportSection[]; readonly claims: readonly ReportClaim[] } = {
    sections: input.report.sections,
    claims: input.report.claims,
  };
  const usedEvidenceIds = evidenceUsedBy(draft);
  const evidenceById = new Map(input.evidence.map((item) => [item.id, item]));

  const evidenceRefs: FrozenEvidenceRef[] = [];
  const sourceIds: string[] = [];
  const seenSources = new Set<string>();
  for (const evidenceId of usedEvidenceIds) {
    const evidence = evidenceById.get(evidenceId);
    if (evidence === undefined) continue;
    evidenceRefs.push({
      evidenceId: evidence.id,
      sourceId: evidence.sourceId,
      readId: evidence.readId,
      excerpt: evidence.excerpt,
      locator: evidence.locator,
      readScope: evidence.readScope,
      cells: evidence.cells,
      createdAt: evidence.createdAt,
    });
    if (!seenSources.has(evidence.sourceId)) {
      seenSources.add(evidence.sourceId);
      sourceIds.push(evidence.sourceId);
    }
  }

  const sourceById = new Map(input.sources.map((source) => [source.id, source]));
  const sourceRefs: FrozenSourceRef[] = [];
  for (const sourceId of sourceIds) {
    const source = sourceById.get(sourceId);
    if (source === undefined) continue;
    sourceRefs.push({
      sourceId: source.id,
      title: source.title,
      authors: source.authors,
      org: source.org,
      venue: source.venue,
      publishedAt: source.publishedAt,
      url: source.url,
      doi: source.doi,
      readScope: source.readScope,
    });
  }

  // The cells the report's own passages were collected for: the assessments
  // kept here are exactly the ones that judged those cells.
  const cellKeys = new Set<string>();
  for (const ref of evidenceRefs) {
    for (const cell of ref.cells) cellKeys.add(`${cell.sectionId}|${cell.subjectId}|${cell.dimensionId}`);
  }
  const assessments = input.assessments.filter((entry) =>
    cellKeys.has(`${entry.target.sectionId}|${entry.target.subjectId}|${entry.target.dimensionId}`),
  );

  const claimsUsed = [...new Set(input.report.claims.map((claim) => claim.id))];
  const gaps = (input.report.gapsAtSave ?? []).map((note) => ({
    sectionId: note.sectionId,
    subjectId: note.subjectId,
    subjectName: note.subjectName,
    dimensionId: note.dimensionId,
    dimensionName: note.dimensionName,
    status: note.status,
    reason: note.reason,
    gap: note.gap,
  }));

  return {
    id: newId(ID_PREFIX.revision),
    taskId: input.task.id,
    reportId: input.report.id,
    revision: input.revision,
    contentHash: hashOf(reportContentOf(input.report)),
    report: {
      id: input.report.id,
      title: input.report.title,
      summary: input.report.summary,
      ...(input.report.frame === undefined ? {} : { frame: input.report.frame }),
      sections: input.report.sections,
      claims: input.report.claims,
      validation: input.report.validation,
      createdAt: input.report.createdAt,
    },
    frame: {
      topic: input.task.topic,
      purpose: input.task.purpose,
      audience: input.task.audience,
      focus: input.task.focus,
      exclusions: input.task.exclusions,
      lengthTarget: input.task.lengthTarget,
      structure: input.task.structure.sections.map((section) => ({ id: section.id, title: section.title, question: section.question })),
      subjects: input.task.subjects.map((subject) => ({ id: subject.id, name: subject.name })),
      dimensions: input.task.dimensions.map((dimension) => ({ id: dimension.id, name: dimension.name, question: dimension.question })),
    },
    claimsUsed,
    evidenceRefs,
    readIds: [...new Set(evidenceRefs.map((ref) => ref.readId))],
    sourceRefs,
    assessments,
    gapsCaptured: input.report.gapsAtSave !== undefined,
    gaps,
    themeId: input.themeId ?? DEFAULT_THEME_ID,
    renderer: RENDERER,
    createdAt: input.now,
  };
}

/** The content a revision pins: its wording, and nothing about the task. */
export function reportContentOf(report: {
  readonly title: string;
  readonly summary: string;
  readonly frame?: ReportFrame;
  readonly sections: readonly ReportSection[];
  readonly claims: readonly ReportClaim[];
}): {
  readonly title: string;
  readonly summary: string;
  readonly frame?: ReportFrame;
  readonly sections: readonly ReportSection[];
  readonly claims: readonly ReportClaim[];
} {
  return {
    title: report.title,
    summary: report.summary,
    ...(report.frame === undefined ? {} : { frame: report.frame }),
    sections: report.sections,
    claims: report.claims,
  };
}

/** Whether a revision is a frozen dependency bundle rather than a bare report. */
export function isFrozenRevision(value: FrozenRevision | undefined): value is FrozenRevision {
  return value !== undefined && Array.isArray(value.evidenceRefs) && typeof value.contentHash === "string";
}

/** Blocks of one section, for callers that only need the text a reader sees. */
export function blockText(blocks: readonly ReportBlock[]): string {
  return blocks
    .map((block) => {
      switch (block.kind) {
        case "paragraph":
          return block.text;
        case "list":
          return block.items.map((item) => item.text).join("\n");
        case "table":
          return block.rows.map((row) => row.cells.map((cell) => cell.text).join(" | ")).join("\n");
        case "callout":
          return block.text;
        case "mechanism":
          return [block.input, block.intermediate, ...block.steps.map((step) => step.text), block.output, block.tradeoff, block.failure].join("\n");
      }
    })
    .join("\n");
}
