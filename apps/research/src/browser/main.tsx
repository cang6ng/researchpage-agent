/**
 * The workspace page's entry.
 *
 * Nothing here connects to a host, chooses a model or reads a credential: the
 * page mounts the workspace, and the workspace reads the application's own API
 * on the origin it was served from.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { Workspace } from "./workspace.js";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("the workspace page has no #root element");
}

createRoot(container).render(
  <StrictMode>
    <Workspace />
  </StrictMode>,
);
