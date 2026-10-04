/**
 * M5: the credential sentinel, at the layer a person can see.
 *
 * M3 proved the boundary at the node level — the database, the wire, the client
 * replica, the console, and the provider's own authorization header. This case
 * adds the surfaces only a real page has: the rendered DOM, every form field's
 * attribute and value, the browser's own console and page errors, and the host
 * process's stdout and stderr while the page drives a whole run.
 *
 * The sentinel is generated at runtime and never written into source; the one
 * place it is allowed to appear is the authorization header of the call the
 * composition's model client builds.
 */

import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { findBrowser, launchBrowser, type BrowserSession } from "./helpers/chrome-cdp.js";
import { startShellAcceptance, type ShellAcceptance } from "./helpers/shell-server.js";

const browser = findBrowser();

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const resource of open.splice(0)) await resource.close();
});

const connectionStatus = 'document.querySelector("[data-testid=connection-status]")?.textContent ?? ""';
const runStatus = 'document.querySelector("[data-testid=run-status]")?.textContent ?? ""';

describe("the credential sentinel", () => {
  it.skipIf(browser === undefined)(
    "reaches the provider-facing call and appears nowhere a page or a process can show",
    async () => {
      const sentinel = `CREDENTIAL_SENTINEL_M5_DO_NOT_LEAK_${randomUUID()}`;
      const acceptance: ShellAcceptance = await startShellAcceptance({ credential: sentinel });
      const session: BrowserSession = await launchBrowser({ executable: browser ?? "" });
      open.push({
        close: async () => {
          await session.close();
          await acceptance.close();
        },
      });

      // The host's own output, captured for the whole case: everything written
      // through `console.*`, and everything written to the process's own
      // streams — an in-process host can leak through either.
      const spoken: string[] = [];
      const streams: string[] = [];
      const original = {
        log: console.log,
        warn: console.warn,
        error: console.error,
        info: console.info,
        stdoutWrite: process.stdout.write.bind(process.stdout),
        stderrWrite: process.stderr.write.bind(process.stderr),
      };
      const record = (...args: unknown[]): void => {
        spoken.push(args.map(String).join(" "));
      };
      console.log = record;
      console.warn = record;
      console.error = record;
      console.info = record;
      process.stdout.write = ((chunk: unknown): boolean => {
        streams.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
      process.stderr.write = ((chunk: unknown): boolean => {
        streams.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;

      try {
        await session.navigate(acceptance.pageUrl);
        await session.waitFor(connectionStatus, (value) => value.includes("已就绪"), 45000, "the shell to become ready");

        // A whole run, so the composition really builds its provider-facing
        // call with the credential.
        await session.click('[data-testid="new-session"]');
        await session.waitFor(
          'document.querySelector("[data-testid=session-item][data-selected=true]") !== null ? "yes" : ""',
          (value) => value === "yes",
          15000,
          "a created session",
        );
        await session.waitFor('String(document.querySelector("[data-testid=new-session]").disabled)', (value) => value === "false", 10000, "the create to settle");
        await session.type('[data-testid="composer-input"]', "你好");
        await session.click('[data-testid="send-button"]');
        await session.waitFor(runStatus, (value) => value.includes("已完成"), 20000, "the run to finish");

        // The credential went where it belongs: into the authorization header
        // the composition's model client built for the provider call.
        expect(acceptance.model.authorizations.length).toBeGreaterThan(0);
        expect(acceptance.model.authorizations[0]).toBe(`Bearer ${sentinel}`);

        // The page: the rendered DOM, every field's attribute and every field's
        // live value.
        const dom = await session.evaluate<string>("document.documentElement.outerHTML");
        expect(dom.includes(sentinel), "the sentinel appeared in the page's DOM").toBe(false);
        const fields = await session.evaluate<string>(`JSON.stringify([...document.querySelectorAll("input, textarea")].map((el) => ({
          attribute: el.getAttribute("value"),
          value: el.value,
          name: el.getAttribute("name"),
          id: el.getAttribute("id"),
        })))`);
        expect(fields.includes(sentinel), "the sentinel appeared in a form field").toBe(false);
        // No form field is a credential field at all.
        expect(fields).not.toContain("password");

        // The browser's own channels.
        expect(session.uncaughtExceptions().join("\n").includes(sentinel)).toBe(false);
        expect(session.consoleErrors().join("\n").includes(sentinel)).toBe(false);

        // What the host process said while all of this ran: its console and its
        // own streams are separate surfaces, and neither carries the sentinel.
        expect(spoken.join("\n").includes(sentinel)).toBe(false);
        expect(streams.join("").includes(sentinel)).toBe(false);
        expect(session.uncaughtExceptions()).toEqual([]);
      } finally {
        console.log = original.log;
        console.warn = original.warn;
        console.error = original.error;
        console.info = original.info;
        process.stdout.write = original.stdoutWrite;
        process.stderr.write = original.stderrWrite;
      }
    },
    150000,
  );
});
