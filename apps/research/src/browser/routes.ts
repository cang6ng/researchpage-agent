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
  | { readonly kind: "project"; readonly taskId: string; readonly view: View };

export const VIEWS: readonly View[] = ["research", "report", "sources", "brief", "gallery"];

export const VIEW_LABELS: Readonly<Record<View, string>> = Object.freeze({
  brief: "研究任务",
  research: "研究",
  report: "报告",
  sources: "来源",
  gallery: "模板",
});

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, "");
  const parts = path.split("/").filter((part) => part.length > 0);
  if (parts.length === 0) return { kind: "start" };
  if (parts[0] === "settings") return { kind: "settings" };
  if (parts[0] === "p" && parts[1] !== undefined) {
    const view = VIEWS.find((candidate) => candidate === parts[2]) ?? "research";
    return { kind: "project", taskId: parts[1], view };
  }
  return { kind: "start" };
}

export function projectHash(taskId: string, view: View): string {
  return `#/p/${taskId}/${view}`;
}
