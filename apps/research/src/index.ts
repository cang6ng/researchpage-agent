/**
 * ResearchPage's application package: the server composition, the runner and
 * the workspace page. `@every-dagent/web` stays the generic shell; this is the
 * product built on top of it.
 */

export { createChannelPair } from "./server/channel.js";
export { createResearchContextBuilder, type ResearchContextBuilderOptions } from "./server/context-builder.js";
export { exportTaskReportPdf, renderHtmlOf, reportHtmlFor, type PdfExportOutcome } from "./server/export.js";
export { createResearchRouter, type ResearchRoutesOptions } from "./server/routes.js";
export {
  createResearchRunner,
  stageInstruction,
  type ResearchRunner,
  type ResearchRunnerOptions,
} from "./server/runner.js";
export { startResearchApp, type ResearchApp, type ResearchAppOptions } from "./server/composition.js";
export {
  credentialFor,
  parseArgs,
  runResearchServer,
  type ResearchCliOptions,
} from "./server/main.js";
