/**
 * ResearchPage's research package: the domain, the real discovery and read
 * paths, the evidence rules, the report renderer and the PDF export — plus the
 * plugin that exposes them to the agent as tools.
 */

export type {
  CellRef,
  CellStatus,
  Dimension,
  Evidence,
  ExportArtifact,
  MatrixCell,
  Paragraph,
  ReadScope,
  ReadSnapshot,
  ReadStatus,
  Report,
  ReportBlock,
  ReportClaim,
  ReportDraftState,
  ReportSection,
  ReportTask,
  ResearchBudget,
  ResearchRunRecord,
  ResearchSection,
  ResearchStage,
  ResearchUsage,
  Source,
  Subject,
  TaskStatus,
} from "./domain.js";
export { DEFAULT_BUDGET, deriveCellCoverage, emptyUsage, ID_PREFIX, isCellRef } from "./domain.js";

export { openResearchRepository, newId, type ResearchRepository } from "./repository.js";

export {
  buildArxivQuery,
  parseArxivFeed,
  queryLadder,
  queryTerms,
  searchArxiv,
  SearchError,
  type SearchCandidate,
  type SearchOutcome,
} from "./search.js";

export { readSource, type ReadOutcome, type ReadRequest, type ReaderOptions } from "./read.js";
export { decodeEntities, extractHtmlDocument, extractPlainText, MAX_DOCUMENT_CHARS } from "./html.js";

export {
  draftEvidence,
  MAX_EXCERPT_CHARS,
  pickParagraphs,
  scopeLabel,
  tokenize,
  verifyEvidenceText,
  type EvidenceCheck,
} from "./evidence.js";

export {
  createTask,
  DEFAULT_DIMENSIONS,
  normalizeCard,
  outlineOf,
  slugId,
  STRUCTURE_ID,
  STRUCTURE_SECTIONS,
  taskOfSession,
  type NormalizedCard,
  type ProposedCard,
} from "./structure.js";

export {
  buildCitations,
  locatorLabel,
  missingCells,
  sealReport,
  validateReport,
  type Citations,
  type ReportDraft,
  type ValidationResult,
} from "./report.js";

export { escapeHtml, renderReportHtml, REPORT_CSS, type RenderInput } from "./render.js";
export { exportHtmlToPdf, findPdfBrowser, type PdfExportOptions, type PdfExportResult } from "./pdf.js";

export {
  createResearchService,
  SECTION_IDS,
  type AssessResult,
  type CellView,
  type ReadResult,
  type Refusal,
  type ResearchService,
  type ResearchServiceOptions,
  type SaveReportResult,
  type SearchResult,
  type WorkspaceState,
} from "./service.js";

export { boundedJson, createResearchTools, MAX_TOOL_RESULT_CHARS, type ResearchTools } from "./tools.js";
export { createResearchPlugin, createResearchToolSet, type ResearchPlugin } from "./plugin.js";
export { RESEARCH_SYSTEM_PROMPT, researchTaskBrief } from "./prompt.js";
