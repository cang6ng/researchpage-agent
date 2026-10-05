/**
 * The browser's half of the addresses: reading them, and going to one.
 *
 * The grammar lives in `routes.ts`; this file is the only place that touches
 * `window.location`. Navigation is a real hash assignment, so the back button,
 * a reload and a pasted link all mean the same thing here.
 */

import { useEffect, useState } from "react";

import { parseRoute, type Route } from "./routes.js";

export * from "./routes.js";

export function navigate(hash: string): void {
  if (window.location.hash === hash) return;
  window.location.hash = hash;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = (): void => {
      setRoute(parseRoute(window.location.hash));
    };
    window.addEventListener("hashchange", onChange);
    return () => {
      window.removeEventListener("hashchange", onChange);
    };
  }, []);
  return route;
}
