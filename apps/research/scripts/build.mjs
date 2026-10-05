/**
 * The product's build: one browser bundle, one server bundle, one page.
 *
 * The same shape the generic shell uses, for the same reason — esbuild is
 * already the repository's tool, and both halves are single files node and a
 * browser run directly. The server bundle carries the host, the provider
 * adapter and the research package (none of which may appear in the page
 * bundle), and both builds keep a metafile so a test can assert exactly that
 * from the artifact rather than from the source tree.
 */

import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

export async function buildResearchApp(options = {}) {
  const root = options.packageRoot ?? packageRoot;
  const outDir = options.outDir ?? join(root, "dist");
  const quiet = options.quiet ?? true;

  await rm(outDir, { recursive: true, force: true });
  await mkdir(join(outDir, "public"), { recursive: true });

  const browser = await build({
    entryPoints: [join(root, "src", "browser", "main.tsx")],
    outfile: join(outDir, "public", "app.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["es2022"],
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    metafile: true,
    logLevel: quiet ? "silent" : "info",
  });

  const server = await build({
    entryPoints: [join(root, "src", "server", "main.ts")],
    outfile: join(outDir, "research-server.mjs"),
    bundle: true,
    format: "esm",
    platform: "node",
    target: ["node22"],
    metafile: true,
    logLevel: quiet ? "silent" : "info",
  });

  await writeFile(join(outDir, "browser-metafile.json"), JSON.stringify(browser.metafile, null, 2));
  await writeFile(join(outDir, "server-metafile.json"), JSON.stringify(server.metafile, null, 2));
  await cp(join(root, "public"), join(outDir, "public"), { recursive: true });

  return { outDir, browserMetafile: browser.metafile, serverMetafile: server.metafile };
}

const entry = process.argv[1] === undefined ? "" : pathToFileURL(process.argv[1]).href;
if (import.meta.url === entry) {
  const { outDir } = await buildResearchApp();
  console.log(`built ${outDir}: research-server.mjs, public/app.js, public/index.html, public/styles.css`);
}
