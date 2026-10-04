/**
 * M5: settings in the normal Generic App.
 *
 * The panel edits the host's two closed namespaces and nothing else, and the
 * facts it shows come from the host: what is desired, what this instance is
 * actually running, and whether a restart is owed. Saved is not applied, a
 * conflict is not retried, and a lost answer is shown as exactly that.
 */

import { afterEach, describe, expect, it } from "vitest";

import { findBrowser, launchBrowser, type BrowserSession } from "./helpers/chrome-cdp.js";
import { buildCompanionHost, startShellAcceptance, waitForHeld, type ShellAcceptance } from "./helpers/shell-server.js";

const browser = findBrowser();

interface OpenShell {
  readonly acceptance: ShellAcceptance;
  readonly session: BrowserSession;
}

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const resource of open.splice(0)) await resource.close();
});

const textOf = (selector: string): string => `(document.querySelector(${JSON.stringify(selector)})?.textContent ?? "")`;
const existsOf = (selector: string): string => `document.querySelector(${JSON.stringify(selector)}) !== null ? "yes" : ""`;
const disabledOf = (selector: string): string => `String(document.querySelector(${JSON.stringify(selector)}).disabled)`;
const connectionStatus = 'document.querySelector("[data-testid=connection-status]")?.textContent ?? ""';

async function openShell(): Promise<OpenShell> {
  const acceptance = await startShellAcceptance();
  const session = await launchBrowser({ executable: browser ?? "" });
  open.push({
    close: async () => {
      await session.close();
      await acceptance.close();
    },
  });
  await session.navigate(acceptance.pageUrl);
  await session.waitFor(connectionStatus, (value) => value.includes("已就绪"), 45000, "the shell to become ready");
  // The settings are one of the sidebar's two entries, and the shell opens on
  // the session directory: every case here enters through the entry, the way a
  // reader does — never by scrolling past a directory.
  await session.click('[data-testid="sidebar-tab-settings"]');
  await session.waitFor(existsOf('[data-testid="settings-panel"]'), (value) => value === "yes", 15000, "the settings pane");
  return { acceptance, session };
}

/** Reads one namespace through the panel and waits for the host's answer. */
async function readSettings(session: BrowserSession, namespace: "host" | "model"): Promise<void> {
  await session.click(`[data-testid="settings-read-${namespace}"]`);
  await session.waitFor(textOf(`[data-testid="settings-revisions-${namespace}"]`), (value) => value.includes("desired 修订"), 15000, `the ${namespace} settings`);
  await session.waitFor(existsOf(`[data-testid="settings-desired-${namespace}"]`), (value) => value === "yes", 15000, "the desired value");
}

describe("settings in the normal app", () => {
  it.skipIf(browser === undefined)(
    "shows desired and effective together when nothing is pending",
    async () => {
      const shell = await openShell();
      await readSettings(shell.session, "host");

      const revisions = await shell.session.evaluate<string>(textOf('[data-testid="settings-revisions-host"]'));
      expect(revisions).toContain("desired 修订 1");
      expect(revisions).toContain("本实例生效修订 1");
      expect(await shell.session.evaluate<string>(textOf('[data-testid="settings-restart-host"]'))).toContain("没有待重启的配置");
      const desired = await shell.session.evaluate<string>(textOf('[data-testid="settings-desired-host"]'));
      expect(desired).toContain("systemPrompt");
      // The value shown is the host's own, and the effective half is its own.
      expect(await shell.session.evaluate<string>(textOf('[data-testid="settings-effective-host"]'))).toContain("本实例当前生效");

      expect(shell.session.uncaughtExceptions()).toEqual([]);
    },
    90000,
  );

  it.skipIf(browser === undefined)(
    "moves desired without moving effective, and says a restart is owed",
    async () => {
      const shell = await openShell();
      await readSettings(shell.session, "model");

      await shell.session.click('[data-testid="settings-edit-model"]');
      await shell.session.type('[data-testid="settings-field-model"]', "next-model");
      await shell.session.click('[data-testid="settings-save-model"]');

      await shell.session.waitFor(textOf('[data-testid="settings-revisions-model"]'), (value) => value.includes("desired 修订 2"), 20000, "the desired revision to move");
      const revisions = await shell.session.evaluate<string>(textOf('[data-testid="settings-revisions-model"]'));
      expect(revisions).toContain("本实例生效修订 1");
      expect(await shell.session.evaluate<string>(textOf('[data-testid="settings-restart-model"]'))).toContain("需要重启 Host 进程");
      // Saved, never applied — and the effective value is unchanged.
      expect(await shell.session.evaluate<string>(textOf('[data-testid="settings-desired-model"]'))).toContain("next-model");
      const effective = await shell.session.evaluate<string>(textOf('[data-testid="settings-effective-model"]'));
      expect(effective).toContain("test-model");
      expect(effective).not.toContain("next-model");
      // The save notice says saved and names what applying would take.
      expect(await shell.session.evaluate<boolean>(`document.body.textContent.includes("设置已保存")`)).toBe(true);
      expect(await shell.session.evaluate<boolean>(`document.body.textContent.includes("已保存") && document.body.textContent.includes("重启")`)).toBe(true);
      // No restart control exists: applying is a person's action outside this page.
      expect(await shell.session.evaluate<string>(`String(document.querySelectorAll('[data-testid="restart-host"], [data-testid="settings-restart-button"]').length)`)).toBe("0");

      expect(shell.session.uncaughtExceptions()).toEqual([]);
    },
    90000,
  );

  it.skipIf(browser === undefined)(
    "records a save whose answer was lost, and reads the truth instead of resending",
    async () => {
      const shell = await openShell();
      await readSettings(shell.session, "model");
      const before = shell.acceptance.controls.requestsOf("settings.update").length;

      shell.acceptance.controls.dropNextSettingsResponse();
      await shell.session.click('[data-testid="settings-edit-model"]');
      await shell.session.type('[data-testid="settings-field-output-reserve"]', "2048");
      await shell.session.click('[data-testid="settings-save-model"]');

      await shell.session.waitFor(existsOf('[data-testid="unknown-panel"]'), (value) => value === "yes", 20000, "the unconfirmed record");
      const record = await shell.session.evaluate<string>(textOf('[data-testid="unknown-item"]'));
      expect(record).toContain("设置保存");
      expect(record).toContain("不会自动重发");
      // Exactly one settings write crossed the wire: nothing was replayed.
      expect(shell.acceptance.controls.requestsOf("settings.update")).toHaveLength(before + 1);

      // The dropped answer took its connection with it, so the page is
      // offline until it reconnects; then the way to learn what happened is a
      // read, and the read does not claim the original request's outcome.
      await shell.session.waitFor(
        'String(document.querySelector("[data-testid=reconnect-button]").disabled)',
        (value) => value === "false",
        15000,
        "reconnect to become available",
      );
      await shell.session.click('[data-testid="reconnect-button"]');
      await shell.session.waitFor(connectionStatus, (value) => value.includes("已就绪"), 45000, "the reconnected shell");
      await shell.session.click('[data-testid="unknown-check"]');
      await shell.session.waitFor(
        'document.body.textContent.includes("原来的保存请求结果仍未确认") ? "read" : ""',
        (value) => value === "read",
        20000,
        "the confirmation read",
      );
      expect(shell.acceptance.controls.requestsOf("settings.update")).toHaveLength(before + 1);
      expect(shell.acceptance.controls.requestsOf("settings.get").length).toBeGreaterThan(0);

      expect(shell.session.uncaughtExceptions()).toEqual([]);
    },
    90000,
  );

  it.skipIf(browser === undefined)(
    "keeps a dirty draft when the host's settings move underneath it",
    async () => {
      const shell = await openShell();
      await readSettings(shell.session, "model");

      await shell.session.click('[data-testid="settings-edit-model"]');
      await shell.session.type('[data-testid="settings-field-model"]', "draft-model");

      // The host's desired value moves while the draft is dirty: the page must
      // not overwrite the draft, and must not reload behind the user's back.
      const client = await shell.acceptance.connect();
      await client.settings.update({ namespace: "model", expectedRevision: 1, value: { provider: "test", model: "host-model" } });
      client.disconnect();

      await shell.session.waitFor(existsOf('[data-testid="settings-moved-model"]'), (value) => value === "yes", 20000, "the moved marker");
      expect(await shell.session.evaluate<string>(`document.querySelector('[data-testid="settings-field-model"]').value`)).toBe("draft-model");
      // The value this client holds is still the one it read — an invalidation
      // says a revision moved and carries no value — and the panel says so.
      expect(await shell.session.evaluate<string>(textOf('[data-testid="settings-desired-model"]'))).toContain("test-model");
      expect(await shell.session.evaluate<string>(textOf('[data-testid="settings-revisions-model"]'))).toContain("已过期");

      // The user's own choice: discard the draft and read again — and only the
      // read brings the host's new value to this page.
      await shell.session.click('[data-testid="settings-reload-model"]');
      await shell.session.waitFor(textOf('[data-testid="settings-desired-model"]'), (value) => value.includes("host-model"), 20000, "the reloaded settings");
      expect(await shell.session.evaluate<string>(`document.querySelector('[data-testid="settings-form-model"]') === null ? "closed" : "open"`)).toBe("closed");

      expect(shell.session.uncaughtExceptions()).toEqual([]);
    },
    90000,
  );

  it.skipIf(browser === undefined)(
    "keeps the draft when a save's answer was lost, and clears it only on a confirmed save",
    async () => {
      const shell = await openShell();
      await readSettings(shell.session, "model");

      // A save whose answer never arrives: the draft is the user's, and a lost
      // answer is not a saved value.
      shell.acceptance.controls.dropNextSettingsResponse();
      await shell.session.click('[data-testid="settings-edit-model"]');
      await shell.session.type('[data-testid="settings-field-model"]', "unsaved-model");
      await shell.session.click('[data-testid="settings-save-model"]');
      await shell.session.waitFor(existsOf('[data-testid="unknown-panel"]'), (value) => value === "yes", 20000, "the unconfirmed record");
      expect(await shell.session.evaluate<string>(`document.querySelector('[data-testid="settings-field-model"]').value`)).toBe("unsaved-model");

      // Back on the wire: the draft is still the user's text, and saving it is
      // a compare-and-set against a revision that has moved (the write landed;
      // only its answer was lost). That save is refused, and a refusal keeps
      // the draft too.
      await shell.session.waitFor(
        'String(document.querySelector("[data-testid=reconnect-button]").disabled)',
        (value) => value === "false",
        15000,
        "reconnect to become available",
      );
      await shell.session.click('[data-testid="reconnect-button"]');
      await shell.session.waitFor(connectionStatus, (value) => value.includes("已就绪"), 45000, "the reconnected shell");
      await shell.session.click('[data-testid="settings-read-model"]');
      await shell.session.waitFor(
        'document.querySelector("[data-testid=settings-revisions-model]")?.textContent?.includes("desired 修订") === true ? "read" : ""',
        (value) => value === "read",
        15000,
        "the re-read",
      );
      await shell.session.waitFor(existsOf('[data-testid="settings-form-model"]'), (value) => value === "yes", 15000, "the draft to still be open");
      await shell.session.click('[data-testid="settings-save-model"]');
      await shell.session.waitFor(
        'document.body.textContent.includes("保存被拒绝") ? "refused" : ""',
        (value) => value === "refused",
        20000,
        "the refusal",
      );
      expect(await shell.session.evaluate<string>(`document.querySelector('[data-testid="settings-field-model"]').value`)).toBe("unsaved-model");

      // The user's way forward: discard the draft for this namespace (which
      // re-reads the host) and save fresh text. That save is confirmed, and
      // only a confirmed save closes the form.
      await shell.session.click('[data-testid="settings-reload-model"]');
      await shell.session.waitFor(
        'document.querySelector("[data-testid=settings-form-model]") === null ? "closed" : "open"',
        (value) => value === "closed",
        20000,
        "the draft to be discarded",
      );
      await shell.session.click('[data-testid="settings-edit-model"]');
      await shell.session.type('[data-testid="settings-field-model"]', "confirmed-model");
      await shell.session.click('[data-testid="settings-save-model"]');
      await shell.session.waitFor(
        'document.querySelector("[data-testid=settings-form-model]") === null ? "closed" : "open"',
        (value) => value === "closed",
        20000,
        "the confirmed save to close the draft",
      );

      expect(shell.session.uncaughtExceptions()).toEqual([]);
    },
    120000,
  );

  it.skipIf(browser === undefined)(
    "keeps text typed while a save is in flight",
    async () => {
      const shell = await openShell();
      await readSettings(shell.session, "model");
      const readValue = await shell.session.evaluate<string>(textOf('[data-testid="settings-desired-model"]'));
      expect(readValue).not.toContain("version-one");

      await shell.session.click('[data-testid="settings-edit-model"]');
      await shell.session.type('[data-testid="settings-field-model"]', "version-one");

      // The save is sent and the host's own answer is parked on the binding:
      // exactly one request crossed, and this page cannot know the outcome yet.
      shell.acceptance.controls.holdNextSettingsResponse();
      await shell.session.click('[data-testid="settings-save-model"]');
      await waitForHeld(
        () => shell.acceptance.controls.settingsAnswerHeld(),
        "the host's save answer to be parked",
      );
      expect(shell.acceptance.controls.requestsOf("settings.update")).toHaveLength(1);
      expect(
        shell.acceptance.controls.settingsAnswersDelivered(),
        "nothing was delivered while it is parked",
      ).toBe(0);
      // The page is still waiting for that exact call: the button says so, and
      // the value it shows for desired is the one it read, not what was saved.
      expect(await shell.session.evaluate<string>(textOf('[data-testid="settings-save-model"]'))).toContain("保存中");
      expect(await shell.session.evaluate<string>(textOf('[data-testid="settings-desired-model"]'))).toBe(readValue);

      // While that call is unresolved, the user keeps editing.
      await shell.session.type('[data-testid="settings-field-model"]', "version-two");

      // Release once: the parked answer lands, and releasing again delivers
      // nothing more.
      shell.acceptance.controls.releaseSettingsAnswer();
      expect(shell.acceptance.controls.settingsAnswersDelivered()).toBe(1);
      shell.acceptance.controls.releaseSettingsAnswer();
      expect(shell.acceptance.controls.settingsAnswersDelivered()).toBe(1);

      // That exact completion is processed: the page answers for the call it
      // made and folds the host's snapshot — the host took version one.
      await shell.session.waitFor(
        'document.body.textContent.includes("设置已保存（desired）") ? "done" : ""',
        (value) => value === "done",
        20000,
        "the save's own completion",
      );
      await shell.session.waitFor(
        textOf('[data-testid="settings-desired-model"]'),
        (value) => value.includes("version-one"),
        20000,
        "the host's answer to fold",
      );

      // ...and the completion did not erase what the user typed after it.
      expect(await shell.session.evaluate<string>(`document.querySelector('[data-testid="settings-field-model"]').value`)).toBe("version-two");
      expect(await shell.session.evaluate<string>(`document.querySelector('[data-testid="settings-form-model"]') === null ? "closed" : "open"`)).toBe("open");
      expect(await shell.session.evaluate<string>(existsOf('[data-testid="settings-dirty-model"]'))).toBe("yes");
      expect(await shell.session.evaluate<string>(textOf('[data-testid="settings-desired-model"]'))).not.toContain("version-two");

      expect(shell.session.uncaughtExceptions()).toEqual([]);
    },
    120000,
  );

  it.skipIf(browser === undefined)(
    "refuses to save a draft against a different host, however equal the revisions look",
    async () => {
      const shell = await openShell();
      await readSettings(shell.session, "model");
      await shell.session.click('[data-testid="settings-edit-model"]');
      await shell.session.type('[data-testid="settings-field-model"]', "host-a-draft");

      // A second, independent host — same defaults, so the same revision number
      // — placed behind the *same* binding: the page keeps its address and its
      // state, and the next connection reaches the new instance.
      const companion = await buildCompanionHost();
      shell.acceptance.controls.swapTo(companion);
      shell.acceptance.controls.closeConnections();
      await shell.session.waitFor(
        'String(document.querySelector("[data-testid=reconnect-button]").disabled)',
        (value) => value === "false",
        20000,
        "reconnect to become available",
      );
      await shell.session.click('[data-testid="reconnect-button"]');
      await shell.session.waitFor(connectionStatus, (value) => value.includes("已就绪"), 45000, "the other host");
      await shell.session.waitFor(existsOf('[data-testid="settings-rebase-model"]'), (value) => value === "yes", 20000, "the rebase marker");

      // The draft is still the user's text, and it cannot be written to this
      // host: equal revision numbers are not equal authority.
      expect(await shell.session.evaluate<string>(`document.querySelector('[data-testid="settings-field-model"]').value`)).toBe("host-a-draft");
      expect(await shell.session.evaluate<string>(disabledOf('[data-testid="settings-save-model"]'))).toBe("true");
      expect(shell.acceptance.controls.requestsOf("settings.update")).toHaveLength(0);
      // Nothing was written to the other host either.
      const probe = await shell.acceptance.connect();
      const untouched = await probe.settings.get({ namespace: "model" });
      probe.disconnect();
      expect(untouched.settings.desiredRevision).toBe(1);
      expect(untouched.settings.restartRequired).toBe(false);

      // The user's way out: discard the draft and read *this* host's settings.
      await shell.session.click('[data-testid="settings-reload-model"]');
      await shell.session.waitFor(
        'document.querySelector("[data-testid=settings-form-model]") === null ? "closed" : "open"',
        (value) => value === "closed",
        20000,
        "the draft to be discarded",
      );

      expect(shell.session.uncaughtExceptions()).toEqual([]);
    },
    150000,
  );
});
