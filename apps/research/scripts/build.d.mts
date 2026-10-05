import type { Metafile } from "esbuild";

export interface BuildResearchAppOptions {
  readonly packageRoot?: string;
  readonly outDir?: string;
  readonly quiet?: boolean;
}

export interface BuildResearchAppResult {
  readonly outDir: string;
  readonly browserMetafile: Metafile;
  readonly serverMetafile: Metafile;
}

/** Builds the workspace page bundle, the research server bundle and the page into `outDir`. */
export function buildResearchApp(options?: BuildResearchAppOptions): Promise<BuildResearchAppResult>;
