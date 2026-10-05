/**
 * The workspace page's entry.
 *
 * Nothing here connects to a host, chooses a model or reads a credential: the
 * page mounts the workspace, and the workspace reads the application's own API
 * on the origin it was served from. Mantine provides the interaction
 * primitives; this bundle decides what the product looks like.
 */

import "@mantine/core/styles.css";

import { MantineProvider } from "@mantine/core";
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { researchTheme } from "./theme.js";
import { AppProvider } from "./store.js";
import { Workspace } from "./workspace.js";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("the workspace page has no #root element");
}

function Providers({ children }: { readonly children: ReactNode }) {
  return (
    <MantineProvider theme={researchTheme} forceColorScheme="light" env="default">
      <AppProvider>{children}</AppProvider>
    </MantineProvider>
  );
}

createRoot(container).render(
  <StrictMode>
    <Providers>
      <Workspace />
    </Providers>
  </StrictMode>,
);
