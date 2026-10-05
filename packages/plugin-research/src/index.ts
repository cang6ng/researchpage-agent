/**
 * ResearchPage's research package: the domain, the real discovery and read
 * paths, the evidence rules, the report renderer and the PDF export — plus the
 * plugin that exposes them to the agent as tools.
 */

export type {
  AssessmentDirectness,
  AssessmentRelationship,
  CellRef,
  CellStatus,
  ClaimBasis,
  ClaimConditions,
  ClaimType,
  Comparability,
  CostStage,
  Dimension,
  Evidence,
  ExportArtifact,
  MatrixCell,
  MechanismStep,
  Paragraph,
  QualityCheckRecord,
  ReadScope,
  ReadSnapshot,
  ReadStatus,
  Report,
  ReportBlock,
  ReportClaim,
  ReportDraftState,
  ReportFrame,
  ReportGapNote,
  ReportReviewFlag,
  ReportSection,
  ReportTask,
  ReportValidation,
  ResearchBudget,
  ResearchRunRecord,
  ResearchSection,
  ResearchStage,
  ResearchUsage,
  Source,
  SourceRole,
  Subject,
  SupportAssessment,
  TaskStatus,
} from "./domain.js";
export {
  DEFAULT_BUDGET,
  deriveCellCoverage,
  emptyUsage,
  ID_PREFIX,
  isCellRef,
  isCovered,
  needsAttention,
  PRIMARY_ROLES,
} from "./domain.js";

export {
  BLUEPRINT_ID_V1,
  BLUEPRINT_ID_V2,
  BLUEPRINTS,
  blueprintById,
  blueprintSections,
  requiredSectionsOf,
  sectionObligation,
  sectionSpecOf,
  TECHNICAL_COMPARISON_V2,
  V2_COMPARISON_DIMENSIONS,
  type BlueprintSpec,
  type ClaimRequirement,
  type CognitiveComponent,
  type DepthLevel,
  type QualityRule,
  type SectionSpec,
} from "./blueprint.js";

export {
  adequacyNeedsAttention,
  assertsRanking,
  comparabilityLabel,
  costFamiliesOf,
  deriveClaimAdequacy,
  validateClaimContract,
  type AdequacyState,
  type ClaimAdequacy,
  type ClaimContext,
  type ClaimVerdict,
} from "./claims.js";

export { validateArtifactQuality, type ArtifactDraft, type ArtifactInput, type ArtifactVerdict } from "./artifact.js";

export { canonicalJson, hashOf } from "./hash.js";

export {
  capabilitiesFor,
  classifyIntent,
  createGrant,
  grantHasCapability,
  type ActionCapability,
  type ActionGrant,
  type ActionIntent,
  type AssistantIntent,
  type GrantBudget,
  type GrantInput,
  type GrantTargetType,
  type IntentReading,
} from "./semantics.js";

export {
  applyProposal,
  checkProposalFreshness,
  contentOf,
  createProposal,
  sectionHash,
  type Proposal,
  type ProposalBase,
  type ProposalSection,
  type ProposalStatus,
  type ProposalTarget,
} from "./proposal.js";

export {
  blockText,
  buildRevisionBundle,
  DEFAULT_THEME_ID,
  isFrozenRevision,
  RENDERER,
  reportContentOf,
  type FrozenEvidenceRef,
  type FrozenFrame,
  type FrozenGap,
  type FrozenRevision,
  type FrozenSourceRef,
  type RevisionBundleInput,
} from "./revision.js";

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
  evidenceUsedBy,
  gapNotesOf,
  locatorLabel,
  missingCells,
  reportContentHash,
  sealReport,
  validateReport,
  type CitationEvidence,
  type Citations,
  type CitationSource,
  type ReportDraft,
  type ValidationResult,
} from "./report.js";

export { escapeHtml, renderReportHtml, renderRevisionHtml, REPORT_CSS, type RenderInput } from "./render.js";
export { exportHtmlToPdf, findPdfBrowser, type PdfExportOptions, type PdfExportResult } from "./pdf.js";

export {
  createResearchService,
  SECTION_IDS,
  type AcceptProposalResult,
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
