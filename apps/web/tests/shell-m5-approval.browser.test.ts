/**
 * M5: the tool approval in the normal Generic App.
 *
 * M4 answered approvals with a minimal harness page; this is the shell's own
 * card, driven the way a person would drive it. The host runs a real loop with
 * a trusted policy that refuses to run its counter tool without an approval,
 * and every assertion about execution counts is made against the tool that
 * really ran.
 *
 * The rules under test are the platform's, seen from a page: nothing runs
 * before an approval; a click is an answer this client sent and never a Host
 * decision; a disconnect is not a rejection; a reconnect to the same Host
 * redelivers the *same* business approval, and answering it then runs the tool
 * exactly once.
 */

import { afterEach, describe, expect, it } from "vitest";

import { findBrowser, launchBrowser, type BrowserSession } from "./helpers/chrome-cdp.js";
import { startShellAcceptance, type ShellAcceptance } from "./helpers/shell-server.js";

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
const disabledOf = (selector: string): string => `String(document.querySelector(${JSON.stringify(selector)}).disabled)`;
const existsOf = (selector: string): string => `document.querySelector(${JSON.stringify(selector)}) !== null ? "yes" : ""`;
const runStatus = 'document.querySelector("[data-testid=run-status]")?.textContent ?? ""';

interface ApprovalStep {
  readonly status: string | null;
  readonly reply: string | null;
}

/**
 * Records what the approval card and the local reply state said, in order.
 *
 * The card is short-lived once a decision exists — the Host clears it as soon
 * as the execution settles — so a case that is about a *transition* reads this
 * log instead of racing a poll.
 */
async function recordApprovalStates(session: BrowserSession): Promise<void> {
  await session.evaluate<string>(`(() => {
    window.__approvalLog = [];
    const record = () => {
      const card = document.querySelector("[data-testid=approval-panel]");
      const reply = document.querySelector("[data-testid=approval-reply-state]");
      window.__approvalLog.push({
        status: card === null ? null : card.getAttribute("data-status"),
        reply: reply === null ? null : reply.getAttribute("data-reply"),
      });
    };
    if (window.__approvalObserver !== undefined) window.__approvalObserver.disconnect();
    window.__approvalObserver = new MutationObserver(record);
    window.__approvalObserver.observe(document.body, { subtree: true, childList: true, attributes: true });
    record();
    return "recording";
  })()`);
}

async function approvalStates(session: BrowserSession): Promise<readonly ApprovalStep[]> {
  return await session.evaluate<readonly ApprovalStep[]>(`window.__approvalLog ?? []`);
}

async function openShell(acceptance?: ShellAcceptance): Promise<OpenShell> {
  const server = acceptance ?? (await startShellAcceptance({ requireApproval: true }));
  const session = await launchBrowser({ executable: browser ?? "" });
  open.push({
    close: async () => {
      await session.close();
      if (acceptance === undefined) await server.close();
    },
  });
  await session.navigate(server.pageUrl);
  await session.waitFor(
    'document.querySelector("[data-testid=connection-status]")?.textContent ?? ""',
    (value) => value.includes("已就绪"),
    45000,
    "the shell to become ready",
  );
  return { acceptance: server, session };
}

async function createSession(session: BrowserSession): Promise<void> {
  await session.click('[data-testid="new-session"]');
  await session.waitFor(
    'document.querySelector("[data-testid=session-item][data-selected=true]")?.getAttribute("data-session-id") ?? ""',
    (value) => value.length > 0,
    10000,
    "a created session to be selected",
  );
  await session.waitFor('String(document.querySelector("[data-testid=new-session]").disabled)', (value) => value === "false", 10000, "the create to settle");
}

/** Enables one plugin through the page, and waits for the host to say it is on. */
async function enablePlugin(session: BrowserSession, pluginId: string): Promise<void> {
  await session.click(`[data-testid="plugin-enable"][data-plugin-id="${pluginId}"]`);
  await session.waitFor(
    `document.querySelector('[data-testid=plugin-item][data-plugin-id=${pluginId}] [data-testid=plugin-status]')?.textContent ?? ""`,
    (value) => value === "enabled",
    15000,
    `the ${pluginId} plugin to become enabled`,
  );
}

/** Starts a run and waits for the approval card to be up. */
async function startAndWaitForApproval(shell: OpenShell): Promise<void> {
  // The tool exists exactly while its plugin is enabled: a step that names a
  // tool the registry does not have never reaches the gate.
  await enablePlugin(shell.session, "counter");
  await createSession(shell.session);
  await recordApprovalStates(shell.session);
  await shell.session.type('[data-testid="composer-input"]', "计数");
  await shell.session.click('[data-testid="send-button"]');
  await shell.session.waitFor(existsOf('[data-testid="approval-panel"]'), (value) => value === "yes", 20000, "the approval card");
  await shell.session.waitFor(
    'document.querySelector("[data-testid=approval-panel]")?.getAttribute("data-status") ?? ""',
    (value) => value === "pending",
    10000,
    "a pending approval",
  );
}

describe("the shell answers a tool approval, in a real browser", () => {
  it.skipIf(browser === undefined)(
    "shows the exact read-only input and waits for a decision, running nothing",
    async () => {
      const shell = await openShell();
      await startAndWaitForApproval(shell);

      // The card is the Host's own question, with the arguments it prepared.
      expect(await shell.session.evaluate<string>(textOf('[data-testid="approval-panel"]'))).toContain("counter");
      await shell.session.waitFor(textOf('[data-testid="approval-input"]'), (value) => value.includes('"n": 1'), 10000, "the exact input");
      expect(await shell.session.evaluate<string>(textOf('[data-testid="approval-input"]'))).toContain("{");
      // Read-only: there is no editable control anywhere in the card.
      expect(await shell.session.evaluate<string>(`String(document.querySelectorAll('[data-testid="approval-panel"] input, [data-testid="approval-panel"] textarea').length)`)).toBe("0");
      // The deadline is the Host's, and the buttons are live because both
      // halves hold: the Host can decide and this connection can deliver.
      expect(await shell.session.evaluate<string>(textOf('[data-testid="approval-deadline"]'))).toContain("截止时间");
      expect(await shell.session.evaluate<string>(disabledOf('[data-testid="approval-approve"]'))).toBe("false");
      expect(await shell.session.evaluate<string>(disabledOf('[data-testid="approval-reject"]'))).toBe("false");
      // Nothing has run.
      expect(shell.acceptance.executions).toEqual([]);

      expect(shell.session.uncaughtExceptions()).toEqual([]);
    },
    90000,
  );

  it.skipIf(browser === undefined)(
    "never shows the Host's decision before it has sent its own answer",
    async () => {
      const shell = await openShell();
      await startAndWaitForApproval(shell);

      await shell.session.click('[data-testid="approval-approve"]');
      await shell.session.waitFor(runStatus, (value) => value.includes("已完成"), 20000, "the run to finish");

      // The tool ran exactly once: the Host approved and dispatched it.
      expect(shell.acceptance.executions).toEqual([{ n: 1 }]);
      const states = await approvalStates(shell.session);
      const sentAt = states.findIndex((step) => step.reply === "sent");
      const approvedAt = states.findIndex((step) => step.status === "approved");
      // The answer left this page and the Host's decision only ever came after
      // it: the card never claimed an approval the Host had not said.
      expect(sentAt).toBeGreaterThanOrEqual(0);
      expect(approvedAt === -1 || approvedAt > sentAt).toBe(true);
      expect(states.slice(0, sentAt).every((step) => step.status !== "approved")).toBe(true);

      expect(shell.session.uncaughtExceptions()).toEqual([]);
    },
    90000,
  );

  it.skipIf(browser === undefined)(
    "shows the tool's own result and never claims an approval means success",
    async () => {
      const shell = await openShell();
      await startAndWaitForApproval(shell);

      // While the question is open, the card carries the call — never a result
      // that does not exist yet, and never a claim of success.
      expect(
        await shell.session.evaluate<string>(`document.querySelector('[data-testid="approval-panel"] [data-testid="tool-result-content"]') === null ? "none" : "shown"`),
      ).toBe("none");
      expect(await shell.session.evaluate<string>(textOf('[data-testid="approval-panel"]'))).not.toContain("成功");

      await shell.session.click('[data-testid="approval-approve"]');
      await shell.session.waitFor(runStatus, (value) => value.includes("已完成"), 20000, "the run to finish");

      // Two facts, kept as two: the execution that really happened, and the
      // tool's own result — which is the run's fact, shown by the conversation,
      // and never something the approval promised.
      expect(shell.acceptance.executions).toEqual([{ n: 1 }]);
      await shell.session.waitFor(
        'document.body.textContent.includes("count:1") ? "shown" : ""',
        (value) => value === "shown",
        20000,
        "the tool's own result",
      );

      expect(shell.session.uncaughtExceptions()).toEqual([]);
    },
    90000,
  );

  it.skipIf(browser === undefined)(
    "runs nothing when the rejection is answered, and says the call was not executed",
    async () => {
      const shell = await openShell();
      await startAndWaitForApproval(shell);

      await shell.session.click('[data-testid="approval-reject"]');
      await shell.session.waitFor(runStatus, (value) => value.includes("已完成"), 20000, "the run to finish");

      // Nothing ran: the refusal is a zero-dispatch decision, and the run
      // carries the Host's own not-executed observation.
      expect(shell.acceptance.executions).toEqual([]);
      expect(await shell.session.evaluate<boolean>(`document.body.textContent.includes("not executed")`)).toBe(true);
      // The page sent an answer, and never claimed the opposite decision: the
      // business state it shows is the Host's, and the Host said no.
      const states = await approvalStates(shell.session);
      expect(states.some((step) => step.reply === "sent")).toBe(true);
      expect(states.some((step) => step.status === "approved")).toBe(false);

      expect(shell.session.uncaughtExceptions()).toEqual([]);
    },
    90000,
  );

  it.skipIf(browser === undefined)(
    "treats a dropped connection as a lost delivery, never as a rejection",
    async () => {
      const shell = await openShell();
      await startAndWaitForApproval(shell);

      // The carrier dies while the Host is still waiting for an answer.
      shell.acceptance.controls.closeConnections();
      await shell.session.waitFor(
        'document.querySelector("[data-testid=connection-status]")?.textContent ?? ""',
        (value) => value.includes("连接已断开") || value.includes("未连接"),
        15000,
        "the lost connection",
      );

      // The card still shows the Host's pending approval and nothing this page
      // can do about it: the buttons are off because the *delivery* is gone,
      // and the page says so instead of claiming a refusal.
      await shell.session.waitFor(
        'document.querySelector("[data-testid=approval-panel]")?.getAttribute("data-status") ?? ""',
        (value) => value === "pending",
        10000,
        "the retained approval",
      );
      expect(await shell.session.evaluate<string>(textOf('[data-testid="approval-can-respond"]'))).toContain("否");
      expect(await shell.session.evaluate<string>(disabledOf('[data-testid="approval-approve"]'))).toBe("true");
      expect(await shell.session.evaluate<string>(disabledOf('[data-testid="approval-reject"]'))).toBe("true");
      expect(await shell.session.evaluate<string>(textOf('[data-testid="approval-waiting-note"]'))).toContain("这不是拒绝");
      expect(await shell.session.evaluate<boolean>(`document.body.textContent.includes("Host：已拒绝")`)).toBe(false);
      expect(shell.acceptance.executions).toEqual([]);

      expect(shell.session.uncaughtExceptions()).toEqual([]);
    },
    90000,
  );

  it.skipIf(browser === undefined)(
    "keeps the same business approval across a same-host reconnect",
    async () => {
      const shell = await openShell();
      await startAndWaitForApproval(shell);
      const identityBefore = await shell.session.evaluate<string>(textOf('[data-testid="approval-identity"]'));

      shell.acceptance.controls.closeConnections();
      await shell.session.waitFor(
        'document.querySelector("[data-testid=connection-status]")?.textContent ?? ""',
        (value) => value.includes("连接已断开") || value.includes("未连接"),
        15000,
        "the lost connection",
      );

      // Same Host, fresh delivery: the *same* business approval is answerable
      // again — same identity — and answering it runs the tool exactly once.
      await shell.session.click('[data-testid="reconnect-button"]');
      await shell.session.waitFor(
        'document.querySelector("[data-testid=connection-status]")?.textContent ?? ""',
        (value) => value.includes("已就绪"),
        45000,
        "the reconnected shell",
      );
      await shell.session.waitFor(disabledOf('[data-testid="approval-approve"]'), (value) => value === "false", 15000, "the approval to be answerable again");
      expect(await shell.session.evaluate<string>(textOf('[data-testid="approval-identity"]'))).toBe(identityBefore);
      expect(shell.acceptance.executions).toEqual([]);

      await shell.session.click('[data-testid="approval-approve"]');
      await shell.session.waitFor(runStatus, (value) => value.includes("已完成"), 20000, "the run to finish after the reconnect");
      expect(shell.acceptance.executions).toEqual([{ n: 1 }]);

      expect(shell.session.uncaughtExceptions()).toEqual([]);
    },
    120000,
  );

  it.skipIf(browser === undefined)(
    "stops offering an answer once the execution is cancelled",
    async () => {
      const shell = await openShell();
      await startAndWaitForApproval(shell);

      // Cancelling the run withdraws the execution: the Host publishes the
      // approval as cancelled, and the card stops offering a decision.
      await shell.session.click('[data-testid="cancel-button"]');
      await shell.session.waitFor(runStatus, (value) => value.includes("已完成") || value.includes("已取消"), 20000, "the run to settle");

      // The Host withdrew the execution: no tool ran, the approval is no longer
      // the Host's current one, and the card stops offering a decision at all.
      expect(shell.acceptance.executions).toEqual([]);
      expect(await shell.session.evaluate<string>(`String(document.querySelectorAll('[data-testid="approval-approve"]').length)`)).toBe("0");
      const states = await approvalStates(shell.session);
      expect(states.some((step) => step.status === "approved")).toBe(false);
      expect(states[states.length - 1]?.status ?? null).not.toBe("pending");

      expect(shell.session.uncaughtExceptions()).toEqual([]);
    },
    90000,
  );

  it.skipIf(browser === undefined)(
    "holds the host's execution lease while the approval waits",
    async () => {
      const shell = await openShell();
      await startAndWaitForApproval(shell);

      // While the approval waits, the execution lease is held: this shell
      // offers no second run, no plugin lifecycle change, and the host itself
      // refuses a settings save.
      await shell.session.type('[data-testid="composer-input"]', "再来一次");
      expect(await shell.session.evaluate<string>(disabledOf('[data-testid="send-button"]'))).toBe("true");
      expect(await shell.session.evaluate<string>(`document.querySelector('[data-testid="plugins-busy"]') !== null ? "yes" : ""`)).toBe("yes");
      expect(
        await shell.session.evaluate<string>('String(document.querySelector("[data-testid=plugin-enable][data-plugin-id=calculator]").disabled)'),
      ).toBe("true");

      // The settings are the sidebar's other entry; the pane swap is not a
      // write, and what happens next is the host's refusal to a real one.
      await shell.session.click('[data-testid="sidebar-tab-settings"]');
      await shell.session.waitFor(existsOf('[data-testid="settings-panel"]'), (value) => value === "yes", 15000, "the settings pane");
      await shell.session.click('[data-testid="settings-read-model"]');
      await shell.session.waitFor(
        'document.querySelector("[data-testid=settings-desired-model]") !== null ? "read" : ""',
        (value) => value === "read",
        15000,
        "the settings read",
      );
      await shell.session.click('[data-testid="settings-edit-model"]');
      await shell.session.type('[data-testid="settings-field-model"]', "blocked-model");
      await shell.session.click('[data-testid="settings-save-model"]');
      // The refusal is the *notice* the host's answer produced — the composer's
      // own placeholder says "Host 正忙" too, and a page-wide search would
      // match that instead of this answer.
      await shell.session.waitFor(
        '[...document.querySelectorAll("[data-testid=notice-item]")].some((n) => n.textContent.includes("HOST_BUSY")) ? "busy" : ""',
        (value) => value === "busy",
        20000,
        "the host's refusal of the settings write",
      );
      // Nothing ran, and the write really did cross the wire (it was the host
      // that refused it, holding the execution lease).
      expect(shell.acceptance.executions).toEqual([]);
      expect(shell.acceptance.controls.requestsOf("settings.update").length).toBeGreaterThan(0);

      // The approval is still answerable — it is not a setting — and answering
      // it runs the tool exactly once.
      await shell.session.click('[data-testid="approval-approve"]');
      await shell.session.waitFor(runStatus, (value) => value.includes("已完成"), 25000, "the run to finish");
      expect(shell.acceptance.executions).toEqual([{ n: 1 }]);

      expect(shell.session.uncaughtExceptions()).toEqual([]);
    },
    120000,
  );
});
