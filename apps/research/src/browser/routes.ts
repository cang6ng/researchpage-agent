/**
 * The page's addresses, as a grammar.
 *
 * A hash route is the whole of it: the product is a desktop tool served from
 * one document, and a route is what makes "the report of this project" a thing
 * a reader can reload, keep open in a second window, or send to themselves.
 *
 * This module is deliberately DOM-free — it decides what an address *means*.
 * `router.ts` is the part that talks to the browser's history and React.
 */

export type View = "brief" | "research" | "report" | "sources" | "gallery";

export type Route =
  | { readonly kind: "start" }
  | { readonly kind: "settings" }
  /**
   * A project, and the view of it the address names.
   *
   * `view` is null when the address names none — `#/p/<task>` — which is not the
   * same as asking for the research matrix. Where a project opens by default is
   * a question about the project (is the brief confirmed? is there a report?),
   * so the address says "no view named" and the workspace answers it from the
   * project's own state rather than from a guess frozen into the URL grammar.
   */
  | { readonly kind: "project"; readonly taskId: string; readonly view: View | null };

export const VIEWS: readonly View[] = ["research", "report", "sources", "brief", "gallery"];

/**
 * The product's three workspaces, in the order they are shown.
 *
 * A report is what the research is for, so it leads; the matrix is where the
 * research itself stands; the sources are the material behind both. Everything
 * else the product can show — the brief, the theme comparison — is a property
 * of the project or of the document rather than a place to work, and is reached
 * from the thing it belongs to.
 */
export const PRIMARY_NAV: readonly View[] = ["report", "research", "sources"];

export const VIEW_LABELS: Readonly<Record<View, string>> = Object.freeze({
  brief: "研究范围",
  research: "研究",
  report: "报告",
  sources: "来源",
  gallery: "样式对照",
});

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, "");
  const parts = path.split("/").filter((part) => part.length > 0);
  if (parts.length === 0) return { kind: "start" };
  if (parts[0] === "settings") return { kind: "settings" };
  if (parts[0] === "p" && parts[1] !== undefined) {
    const view = VIEWS.find((candidate) => candidate === parts[2]) ?? null;
    return { kind: "project", taskId: parts[1], view };
  }
  return { kind: "start" };
}

export function projectHash(taskId: string, view: View): string {
  return `#/p/${taskId}/${view}`;
}

/**
 * Where a project opens when no view was named.
 *
 * An unconfirmed brief is the whole flow — there is nothing else to look at yet
 * — and once a report exists it is what the reader came back for. The matrix is
 * the middle case: material is being gathered and there is nothing written yet.
 */
export function defaultViewOf(project: { readonly confirmed: boolean; readonly hasReport: boolean }): View {
  if (!project.confirmed) return "brief";
  return project.hasReport ? "report" : "research";
}

/** The view an address means, given what the project looks like today. */
export function resolveView(
  route: Extract<Route, { readonly kind: "project" }>,
  project: { readonly confirmed: boolean; readonly hasReport: boolean },
): View {
  return route.view ?? defaultViewOf(project);
}
