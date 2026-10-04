/**
 * M5: durable sessions in the normal Generic App.
 *
 * Every case here runs against the real page, the real client, the real
 * binding and a real host; the only stand-in is the offline model. What is
 * under test is what the shell *claims*: how much of the directory it is
 * holding, what a rename or a deletion did, what a lost answer means, and which
 * writes it will offer at all.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { findBrowser, launchBrowser, type BrowserSession } from "./helpers/chrome-cdp.js";
import { startShellAcceptance, waitForHeld, type ShellAcceptance } from "./helpers/shell-server.js";

const browser = findBrowser();

/**
 * How many sessions the host's own snapshot page carries.
 *
 * It is the host's page size (`DEFAULT_PAGE_ITEMS`), not the shell's: the
 * directory window is what the cut published, and the pages the shell reads
 * below it are its own.
 */
const WINDOW = 20;

interface OpenShell {
  readonly acceptance: ShellAcceptance;
  readonly session: BrowserSession;
}

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const resource of open.splice(0)) await resource.close();
});



/**
 * Waits for a fact the *transport* reports, in the test process.
 *
 * The page's own state settles asynchronously, so a count taken the instant a
 * notice appears can be one request early. Waiting for the wire fact keeps the
 * assertion about the wire — and a request that never crosses still fails.
 */
async function waitForRequests(controls: ShellAcceptance["controls"], method: string, count: number, what: string): Promise<void> {
  const deadline = Date.now() + 15000;
  while (controls.requestsOf(method).length < count) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}: ${method} requests are ${String(controls.requestsOf(method).length)}, expected ${String(count)}`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
}

/** Types one message and sends it, waiting for the send button to be live first. */
async function sendMessage(session: BrowserSession, text: string): Promise<void> {
  await session.type('[data-testid="composer-input"]', text);
  await session.waitFor(
    'String(document.querySelector("[data-testid=send-button]").disabled)',
    (value) => value === "false",
    20000,
    "the send button to be live",
  );
  await session.click('[data-testid="send-button"]');
}

const textOf = (selector: string): string => `(document.querySelector(${JSON.stringify(selector)})?.textContent ?? "")`;
const countOf = (selector: string): string => `String(document.querySelectorAll(${JSON.stringify(selector)}).length)`;
const disabledOf = (selector: string): string => `String(document.querySelector(${JSON.stringify(selector)}).disabled)`;
const existsOf = (selector: string): string => `document.querySelector(${JSON.stringify(selector)}) !== null ? "yes" : ""`;
/** One element's box, as the numbers a layout question is about. */
const rectOf = (selector: string): string =>
  `(() => { const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return JSON.stringify({ top: Math.round(box.top), left: Math.round(box.left), width: Math.round(box.width), height: Math.round(box.height) }); })()`;
/** The controls that must be laid out and on the page: a collapsed or pulled-away one is missing. */
const reachableOf = (ids: readonly string[]): string => `(() => {
  const missing = ${JSON.stringify(ids)}.filter((id) => {
    const element = document.querySelector('[data-testid="' + id + '"]');
    if (element === null) return true;
    const box = element.getBoundingClientRect();
    return box.width <= 0 || box.height <= 0 || box.right <= 0 || box.bottom <= 0;
  });
  return JSON.stringify(missing);
})()`;
/** Every notice the page is showing, in order. */
const noticesOf = '[...document.querySelectorAll("[data-testid=notice-item]")].map((entry) => entry.textContent ?? "")';
const connectionStatus = 'document.querySelector("[data-testid=connection-status]")?.textContent ?? ""';
const runStatus = 'document.querySelector("[data-testid=run-status]")?.textContent ?? ""';

async function openShell(options: Parameters<typeof startShellAcceptance>[0] = {}): Promise<OpenShell> {
  const acceptance = await startShellAcceptance(options);
  const session = await launchBrowser({ executable: browser ?? "" });
  open.push({
    close: async () => {
      await session.close();
      await acceptance.close();
    },
  });
  await session.navigate(acceptance.pageUrl);
  await session.waitFor(connectionStatus, (value) => value.includes("已就绪"), 45000, "the shell to become ready");
  return { acceptance, session };
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

async function enablePlugin(session: BrowserSession, pluginId: string): Promise<void> {
  await session.click(`[data-testid="plugin-enable"][data-plugin-id="${pluginId}"]`);
  await session.waitFor(
    `document.querySelector('[data-testid=plugin-item][data-plugin-id=${pluginId}] [data-testid=plugin-status]')?.textContent ?? ""`,
    (value) => value === "enabled",
    15000,
    `the ${pluginId} plugin to become enabled`,
  );
}

/** Fills the directory with `count` sessions of its own, before the page reads it. */
async function seedSessions(acceptance: ShellAcceptance, count: number): Promise<void> {
  const client = await acceptance.connect();
  try {
    for (let index = 0; index < count; index += 1) {
      await client.sessions.create();
    }
  } finally {
    client.disconnect();
  }
}

describe("durable sessions in the normal app", () => {
  it.skipIf(browser === undefined)(
    "says durable storage can be read back after a restart",
    async () => {
      const databasePath = join(tmpdir(), `every-dagent-m5-durable-${String(Date.now())}.db`);
      const shell = await openShell({ databasePath });
      {
        const retention = await shell.session.evaluate<string>(textOf('[data-testid="host-retention"]'));
        expect(retention).toContain("durable");
        expect(retention).toContain("Host 重启后可以重新读取");
        expect(await shell.session.evaluate<string>(`document.querySelector('[data-testid="host-retention"]').getAttribute("data-retention")`)).toBe("durable");
        // The other half of the same fact: what a restart cannot bring back.
        expect(await shell.session.evaluate<boolean>(`document.body.textContent.includes("不是可恢复状态")`)).toBe(true);
        expect(shell.session.uncaughtExceptions()).toEqual([]);
      }
      void rmSync;
    },
    90000,
  );

  it.skipIf(browser === undefined)(
    "says ephemeral storage lasts only as long as the process",
    async () => {
      const shell = await openShell();
      const retention = await shell.session.evaluate<string>(textOf('[data-testid="host-retention"]'));
      expect(retention).toContain("ephemeral");
      expect(retention).toContain("进程停止后不再存在");
      expect(retention).not.toContain("Host 重启后可以重新读取");
      expect(await shell.session.evaluate<boolean>(`document.body.textContent.includes("不是可恢复状态")`)).toBe(true);
      expect(shell.session.uncaughtExceptions()).toEqual([]);
    },
    90000,
  );

  it.skipIf(browser === undefined)(
    "loads an older page of the directory and selects a session from it",
    async () => {
      const shell = await openShell();
      // More sessions than one page holds, created before the page reads them.
      await seedSessions(shell.acceptance, WINDOW + 5);
      await shell.session.reload();
      await shell.session.waitFor(connectionStatus, (value) => value.includes("已就绪"), 45000, "the shell after the reload");
      await shell.session.waitFor(countOf('[data-testid="session-item"]'), (value) => Number(value) > 0, 20000, "the first page");
      const firstPage = Number(await shell.session.evaluate<string>(countOf('[data-testid="session-item"]')));
      expect(firstPage).toBeLessThan(WINDOW + 5);
      // The window says what it is: a bounded window, not the whole collection.
      expect(await shell.session.evaluate<string>(textOf('[data-testid="sessions-window"]'))).toContain("仅覆盖已读取的窗口");

      await shell.session.click('[data-testid="load-older-sessions"]');
      await shell.session.waitFor(countOf('[data-testid="session-item"]'), (value) => Number(value) > firstPage, 20000, "the older page");
      expect(Number(await shell.session.evaluate<string>(countOf('[data-testid="session-item"]'))) >= WINDOW + 5).toBe(true);
      // Now the whole collection is loaded, and only now does the page say so.
      await shell.session.waitFor(textOf('[data-testid="sessions-window"]'), (value) => value.includes("已加载全部"), 20000, "the complete directory");

      // An older session selects and reads: its summary comes from the host.
      await shell.session.evaluate<string>(`(() => {
        const items = [...document.querySelectorAll("[data-testid=session-item]")];
        items[items.length - 1].click();
        return "clicked";
      })()`);
      await shell.session.waitFor(
        'document.querySelector("[data-testid=session-item][data-selected=true]") !== null ? "yes" : ""',
        (value) => value === "yes",
        10000,
        "the older session to be selected",
      );
      await shell.session.waitFor(existsOf('[data-testid="composer"]'), (value) => value === "yes", 10000, "the composer");
      await shell.session.waitFor(disabledOf('[data-testid="composer-input"]'), (value) => value === "false", 15000, "the confirmed session to allow writes");

      expect(shell.session.uncaughtExceptions()).toEqual([]);
    },
    120000,
  );

  it.skipIf(browser === undefined)(
    "retires the traversal when the collection revision moves, and never presents a mixed window as complete",
    async () => {
      const shell = await openShell();
      await seedSessions(shell.acceptance, WINDOW + 5);
      await shell.session.reload();
      await shell.session.waitFor(countOf('[data-testid="session-item"]'), (value) => Number(value) > 0, 25000, "the first page");
      const firstPage = Number(await shell.session.evaluate<string>(countOf('[data-testid="session-item"]')));
      await shell.session.click('[data-testid="load-older-sessions"]');
      await shell.session.waitFor(countOf('[data-testid="session-item"]'), (value) => Number(value) > firstPage, 20000, "the older page");

      // A new session moves the catalogue revision: the cursor the older page
      // was cut from no longer exists, and the window says so instead of
      // pretending the loaded pages are still the directory.
      const client = await shell.acceptance.connect();
      await client.sessions.create();
      client.disconnect();
      await shell.session.waitFor(textOf('[data-testid="sessions-window"]'), (value) => value.includes("目录版本已变化"), 20000, "the stale traversal");
      expect(await shell.session.evaluate<string>(textOf('[data-testid="sessions-window"]'))).not.toContain("已加载全部");
      expect(await shell.session.evaluate<string>(`document.querySelector('[data-testid="load-older-sessions"]') === null ? "gone" : "present"`)).toBe("gone");
      expect(await shell.session.evaluate<string>(existsOf('[data-testid="refresh-directory"]'))).toBe("yes");

      // Enough more sessions arrive that the fresh head cannot hold them all:
      // the shell's own page profile is fifty, and the point is that a head
      // read is a page like any other.
      const client2 = await shell.acceptance.connect();
      for (let index = 0; index < WINDOW * 2; index += 1) await client2.sessions.create();
      client2.disconnect();

      // Re-reading the head starts a fresh traversal: the window is honest
      // again, and loading continues from the new anchor.
      await shell.session.click('[data-testid="refresh-directory"]');
      await shell.session.waitFor(textOf('[data-testid="sessions-window"]'), (value) => value.includes("仅覆盖已读取的窗口"), 20000, "a fresh traversal");
      await shell.session.click('[data-testid="load-older-sessions"]');
      await shell.session.waitFor(textOf('[data-testid="sessions-window"]'), (value) => value.includes("已加载全部"), 20000, "the complete directory again");
      expect(await shell.session.evaluate<string>(textOf('[data-testid="sessions-window"]'))).not.toContain("目录版本已变化");

      expect(shell.session.uncaughtExceptions()).toEqual([]);
    },
    120000,
  );

  it.skipIf(browser === undefined)(
    "renames a session and reports the host's own title",
    async () => {
      const shell = await openShell();
      await createSession(shell.session);

      await shell.session.click('[data-testid="rename-start"]');
      await shell.session.type('[data-testid="rename-input"]', "第一个新标题");
      await shell.session.click('[data-testid="rename-submit"]');
      await shell.session.waitFor(
        'document.querySelector("[data-testid=session-item][data-selected=true] .session__label")?.textContent ?? ""',
        (value) => value === "第一个新标题",
        20000,
        "the renamed session",
      );
      // The form closed on an accepted rename, and exactly one rename crossed
      // the wire: no optimistic patch, no second request.
      expect(await shell.session.evaluate<string>(`document.querySelector('[data-testid="rename-form"]') === null ? "closed" : "open"`)).toBe("closed");
      expect(shell.acceptance.controls.requestsOf("sessions.rename")).toHaveLength(1);
      expect(await shell.session.evaluate<string>(textOf('[data-testid="notice-item"]'))).toContain("已保存");

      expect(shell.session.uncaughtExceptions()).toEqual([]);
    },
    120000,
  );

  it.skipIf(browser === undefined)(
    "refuses a rename aimed at a stale revision, and never replays it",
    async () => {
      const shell = await openShell();
      await createSession(shell.session);
      await shell.session.click('[data-testid="rename-start"]');
      await shell.session.type('[data-testid="rename-input"]', "先有一个标题");
      await shell.session.click('[data-testid="rename-submit"]');
      await shell.session.waitFor(
        'document.querySelector("[data-testid=session-item][data-selected=true] .session__label")?.textContent ?? ""',
        (value) => value === "先有一个标题",
        20000,
        "the accepted rename",
      );

      // A rename whose revision the host has already moved past is refused,
      // kept as a draft, and never retried.
      shell.acceptance.controls.breakNextRenameRevision();
      await shell.session.click('[data-testid="rename-start"]');
      await shell.session.type('[data-testid="rename-input"]', "不应生效的标题");
      await shell.session.click('[data-testid="rename-submit"]');
      await shell.session.waitFor(
        'document.body.textContent.includes("草稿保留") ? "refused" : ""',
        (value) => value === "refused",
        15000,
        "the refusal",
      );
      await waitForRequests(shell.acceptance.controls, "sessions.rename", 2, "both renames to cross the wire");
      // Exactly one more rename crossed the wire, the title is unchanged, and
      // the draft is still where the user left it.
      expect(shell.acceptance.controls.requestsOf("sessions.rename")).toHaveLength(2);
      expect(
        await shell.session.evaluate<string>('document.querySelector("[data-testid=session-item][data-selected=true] .session__label")?.textContent ?? ""'),
      ).toBe("先有一个标题");
      expect(await shell.session.evaluate<string>(`document.querySelector('[data-testid="rename-input"]').value`)).toBe("不应生效的标题");
      await shell.session.waitFor(
        'document.querySelector("[data-testid=unknown-item]") === null ? "none" : "present"',
        (value) => value === "none",
        5000,
        "no unconfirmed record for a definite refusal",
      );

      expect(shell.session.uncaughtExceptions()).toEqual([]);
    },
    120000,
  );

  it.skipIf(browser === undefined)(
    "records a rename whose answer was lost as unconfirmed, and never asserts the title",
    async () => {
      const shell = await openShell();
      await createSession(shell.session);
      const before = await shell.session.evaluate<string>('document.querySelector("[data-testid=session-item][data-selected=true] .session__label")?.textContent ?? ""');

      shell.acceptance.controls.dropNextRenameResponse();
      await shell.session.click('[data-testid="rename-start"]');
      await shell.session.type('[data-testid="rename-input"]', "未确认的标题");
      await shell.session.click('[data-testid="rename-submit"]');

      await shell.session.waitFor(existsOf('[data-testid="unknown-panel"]'), (value) => value === "yes", 20000, "the unconfirmed record");
      expect(await shell.session.evaluate<string>(textOf('[data-testid="unknown-item"]'))).toContain("重命名");
      // Nothing claimed the title: the page shows what it knows (it does not
      // know), and the session still carries its old name until the host says
      // otherwise.
      expect(await shell.session.evaluate<boolean>(`document.body.textContent.includes("标题可能已经改变")`)).toBe(true);
      expect(shell.acceptance.controls.requestsOf("sessions.rename")).toHaveLength(1);

      expect(shell.session.uncaughtExceptions()).toEqual([]);
    },
    120000,
  );

  it.skipIf(browser === undefined)(
    "warns before a permanent delete and says what cannot be undone",
    async () => {
      const shell = await openShell();
      await createSession(shell.session);

      await shell.session.click('[data-testid="delete-start"]');
      const warning = await shell.session.evaluate<string>(textOf('[data-testid="delete-warning"]'));
      expect(warning).toContain("永久删除");
      expect(warning).toContain("没有回收站");
      expect(warning).toContain("无法撤销");
      expect(warning).toContain("不会撤销已经发生的外部工具副作用");
      // Nothing has happened yet: the confirmation is a question, and the
      // session is still there until it is answered.
      expect(shell.acceptance.controls.requestsOf("sessions.delete")).toHaveLength(0);
      expect(await shell.session.evaluate<string>(countOf('[data-testid="session-item"]'))).toBe("1");
      await shell.session.click('[data-testid="delete-cancel"]');
      expect(await shell.session.evaluate<string>(`document.querySelector('[data-testid="delete-form"]') === null ? "closed" : "open"`)).toBe("closed");
      expect(shell.acceptance.controls.requestsOf("sessions.delete")).toHaveLength(0);

      expect(shell.session.uncaughtExceptions()).toEqual([]);
    },
    120000,
  );

  it.skipIf(browser === undefined)(
    "removes the deleted session, its cache and the selection",
    async () => {
      const shell = await openShell();
      await createSession(shell.session);
      const victim = await shell.session.evaluate<string>(
        'document.querySelector("[data-testid=session-item][data-selected=true]").getAttribute("data-session-id")',
      );
      await createSession(shell.session);
      await shell.session.evaluate<string>(`(() => {
        const item = document.querySelector('[data-testid="session-item"][data-session-id="${victim}"]');
        item.click();
        return "selected";
      })()`);
      await shell.session.waitFor(
        `document.querySelector('[data-testid="session-item"][data-session-id="${victim}"][data-selected=true]') !== null ? "yes" : ""`,
        (value) => value === "yes",
        10000,
        "the session to delete",
      );

      await shell.session.click('[data-testid="delete-start"]');
      await shell.session.click('[data-testid="delete-confirm"]');
      await shell.session.waitFor(
        `document.querySelector('[data-testid="session-item"][data-session-id="${victim}"]') === null ? "gone" : "present"`,
        (value) => value === "gone",
        20000,
        "the session to be gone",
      );
      // The selection was cleared and nothing else was selected in its place.
      expect(await shell.session.evaluate<string>(countOf('[data-testid="session-item"][data-selected=true]'))).toBe("0");
      expect(await shell.session.evaluate<string>(existsOf('[data-testid="no-session"]'))).toBe("yes");

      // A reload reads the host again: the deleted session does not come back.
      await shell.session.reload();
      await shell.session.waitFor(connectionStatus, (value) => value.includes("已就绪"), 45000, "the shell after the reload");
      expect(await shell.session.evaluate<string>(`document.querySelector('[data-testid="session-item"][data-session-id="${victim}"]') === null ? "gone" : "present"`)).toBe("gone");

      expect(shell.session.uncaughtExceptions()).toEqual([]);
    },
    120000,
  );

  it.skipIf(browser === undefined)(
    "refuses to delete a session the host is still running, and never cancels it",
    async () => {
      const shell = await openShell();
      await createSession(shell.session);
      const victim = await shell.session.evaluate<string>(
        'document.querySelector("[data-testid=session-item][data-selected=true]").getAttribute("data-session-id")',
      );
      await sendMessage(shell.session, "慢慢来 你好");
      await shell.session.waitFor(runStatus, (value) => value.includes("运行中"), 20000, "the running state");

      await shell.session.click('[data-testid="delete-start"]');
      // The confirmation says what the host will do, so the refusal is not a
      // surprise — and it is still offered, because the host is the authority.
      expect(await shell.session.evaluate<string>(textOf('[data-testid="delete-busy-note"]'))).toContain("不会自动取消运行");
      await shell.session.click('[data-testid="delete-confirm"]');
      // A *notice* about the host's refusal of the delete — not the composer's
      // own "Host 正忙" placeholder, which is on screen for the same reason.
      await shell.session.waitFor(
        '[...document.querySelectorAll("[data-testid=notice-item]")].some((n) => n.textContent.includes("Host 正忙")) ? "refused" : ""',
        (value) => value === "refused",
        20000,
        "the host's refusal of the delete",
      );
      await waitForRequests(shell.acceptance.controls, "sessions.delete", 1, "the refused delete to cross the wire");
      // No cancellation was attempted, and the run really is still running.
      expect(shell.acceptance.controls.requestsOf("runs.cancel")).toHaveLength(0);
      expect(await shell.session.evaluate<string>(runStatus)).toContain("运行中");
      expect(await shell.session.evaluate<string>(`document.querySelector('[data-testid="session-item"][data-session-id="${victim}"]') === null ? "gone" : "present"`)).toBe("present");

      // The run finishes on its own: the deletion was refused, not smuggled.
      shell.acceptance.model.openGate();
      await shell.session.waitFor(runStatus, (value) => value.includes("已完成"), 20000, "the run to finish");

      expect(shell.session.uncaughtExceptions()).toEqual([]);
    },
    120000,
  );

  it.skipIf(browser === undefined)(
    "records a delete whose answer was lost without claiming anything",
    async () => {
      const shell = await openShell();
      await createSession(shell.session);
      const victim = await shell.session.evaluate<string>(
        'document.querySelector("[data-testid=session-item][data-selected=true]").getAttribute("data-session-id")',
      );

      shell.acceptance.controls.dropNextDeleteResponse();
      await shell.session.click('[data-testid="delete-start"]');
      await shell.session.click('[data-testid="delete-confirm"]');

      await shell.session.waitFor(existsOf('[data-testid="unknown-panel"]'), (value) => value === "yes", 20000, "the unconfirmed record");
      // The record is the honest half: the *causal* outcome is unknown, and it
      // says so — a deletion the host confirmed would say something else.
      const record = await shell.session.evaluate<string>(textOf('[data-testid="unknown-item"]'));
      expect(record).toContain("删除");
      expect(record).toContain("也可能仍然存在");
      expect(shell.acceptance.controls.requestsOf("sessions.delete")).toHaveLength(1);
      // Nothing was replayed, and what the page shows about the session comes
      // from the host's own events, not from this request's answer.
      expect(shell.acceptance.controls.requestsOf("sessions.delete")).toHaveLength(1);
      void victim;

      expect(shell.session.uncaughtExceptions()).toEqual([]);
    },
    120000,
  );

  it.skipIf(browser === undefined)(
    "keeps a partial history honest and only calls it complete once it is",
    async () => {
      const shell = await openShell();
      await createSession(shell.session);
      // Long enough that the newest page cannot reach the start of the
      // conversation: a page is bounded, and the page says so.
      for (let turn = 0; turn < 6; turn += 1) {
        await sendMessage(shell.session, `第 ${String(turn)} 轮`);
        await shell.session.waitFor(runStatus, (value) => value.includes("已完成"), 20000, `turn ${String(turn)} to settle`);
      }

      await shell.session.reload();
      await shell.session.waitFor(connectionStatus, (value) => value.includes("已就绪"), 45000, "the shell after the reload");
      await shell.session.evaluate<string>(`(() => { document.querySelector("[data-testid=session-item]").click(); return "selected"; })()`);
      await shell.session.waitFor(textOf('[data-testid="history-truth"]'), (value) => value.includes("这还不是会话的开头"), 20000, "the honest partial reading");
      const partial = await shell.session.evaluate<string>(textOf('[data-testid="history-truth"]'));
      expect(await shell.session.evaluate<string>(`document.querySelector('[data-testid="history-truth"]').getAttribute("data-complete")`)).toBe("false");
      expect(await shell.session.evaluate<boolean>(`document.body.textContent.includes("这不是完整会话")`)).toBe(true);
      expect(await shell.session.evaluate<string>(`document.querySelector('[data-testid="load-older"]') === null ? "gone" : "present"`)).toBe("present");
      // The boundary of a bounded page can land inside a turn, and the page
      // says which kind of edge it is holding rather than rounding it up: a
      // fragment is never shown as a finished turn.
      expect(partial).toContain("这是一段片段");

      // Reading further back reaches the start, and only then is the union the
      // whole conversation.
      for (let attempt = 0; attempt < 8; attempt += 1) {
        if (await shell.session.evaluate<string>(`document.querySelector('[data-testid="load-older"]') === null ? "gone" : "present"`) === "gone") break;
        await shell.session.click('[data-testid="load-older"]');
        await shell.session.waitFor(
          `document.querySelector('[data-testid="load-older"]') === null ? "gone" : (document.querySelector('[data-testid="load-older"]').disabled ? "busy" : "present")`,
          (value) => value !== "busy",
          20000,
          "the next older page",
        );
      }
      await shell.session.waitFor(textOf('[data-testid="history-truth"]'), (value) => value.includes("覆盖了该会话当前的全部已提交历史"), 20000, "the complete reading");
      expect(await shell.session.evaluate<string>(`document.querySelector('[data-testid="history-truth"]').getAttribute("data-complete")`)).toBe("true");
      // Once the union is the whole conversation, no edge is a fragment.
      expect(await shell.session.evaluate<string>(textOf('[data-testid="history-truth"]'))).not.toContain("片段");
      // Every turn is readable, user message included.
      expect(await shell.session.evaluate<string>(countOf('[data-testid="msg-user"]'))).toBe("6");

      expect(shell.session.uncaughtExceptions()).toEqual([]);
    },
    180000,
  );

  it.skipIf(browser === undefined)(
    "says when the committed history has moved past what is loaded",
    async () => {
      const shell = await openShell();
      await createSession(shell.session);
      await sendMessage(shell.session, "第一轮");
      await shell.session.waitFor(runStatus, (value) => value.includes("已完成"), 20000, "the first run");

      // Watch what the page says about completeness while another turn lands
      // behind its back: the marker is a transition, and a poll would miss it.
      await shell.session.evaluate<string>(`(() => {
        window.__truthLog = [];
        const record = () => {
          const truth = document.querySelector("[data-testid=history-truth]");
          window.__truthLog.push({
            complete: truth === null ? null : truth.getAttribute("data-complete"),
            behind: document.querySelector("[data-testid=history-newer]") !== null,
          });
        };
        if (window.__truthObserver !== undefined) window.__truthObserver.disconnect();
        window.__truthObserver = new MutationObserver(record);
        window.__truthObserver.observe(document.body, { subtree: true, childList: true, attributes: true });
        record();
        return "recording";
      })()`);

      const sessionId = await shell.session.evaluate<string>(
        'document.querySelector("[data-testid=session-item][data-selected=true]").getAttribute("data-session-id")',
      );
      const client = await shell.acceptance.connect();
      await client.runs.start({ sessionId, submissionId: `behind-${String(Date.now())}`, text: "第二轮" });
      client.disconnect();

      await shell.session.waitFor(textOf('[data-testid="history-truth"]'), (value) => value.includes("覆盖了该会话当前的全部已提交历史"), 20000, "the page to catch up");
      await shell.session.waitFor(countOf('[data-testid="msg-user"]'), (value) => Number(value) >= 2, 20000, "the second turn");

      const log = await shell.session.evaluate<readonly { readonly complete: string | null; readonly behind: boolean }[]>(
        "window.__truthLog ?? []",
      );
      // The page did show the gap marker while the committed history was ahead
      // of what it had read, and it never claimed completeness while behind.
      expect(log.some((entry) => entry.behind)).toBe(true);
      expect(log.every((entry) => !(entry.behind && entry.complete === "true"))).toBe(true);

      expect(shell.session.uncaughtExceptions()).toEqual([]);
    },
    120000,
  );

  it.skipIf(browser === undefined)(
    "shows a plugin's desired intent, actual state and restart requirement apart",
    async () => {
      const shell = await openShell();
      const truthOf = (pluginId: string): string =>
        `([...document.querySelectorAll('[data-testid="plugin-item"][data-plugin-id=${pluginId}] [data-testid="plugin-truth"]')].map((n) => n.textContent).join(" "))`;
      const before = await shell.session.evaluate<string>(truthOf("calculator"));
      expect(before).toContain("期望（持久）：停用");
      expect(before).toContain("该插件没有配置契约");

      await enablePlugin(shell.session, "calculator");
      const after = await shell.session.evaluate<string>(truthOf("calculator"));
      expect(after).toContain("期望（持久）：启用；实际状态：enabled");
      // A lifecycle change applies without a restart: nothing here claims one.
      expect(after).not.toContain("需要重启 Host 进程");
      // A plugin whose activation fails becomes unavailable — and stays a
      // different sentence from a pending configuration.
      await shell.session.click('[data-testid="plugin-enable"][data-plugin-id="always-broken"]');
      await shell.session.waitFor(
        `document.querySelector('[data-testid=plugin-item][data-plugin-id=always-broken] [data-testid=plugin-status]')?.textContent ?? ""`,
        (value) => value === "error",
        15000,
        "the failing plugin to settle in error",
      );
      const broken = await shell.session.evaluate<string>(truthOf("always-broken"));
      expect(broken).toContain("该插件不可用");
      expect(broken).toContain("处于错误状态");
      expect(await shell.session.evaluate<string>(`String(document.querySelectorAll('[data-testid="plugin-retry"], [data-testid="plugin-reset"]').length)`)).toBe("0");

      expect(shell.session.uncaughtExceptions()).toEqual([]);
    },
    90000,
  );

  it.skipIf(browser === undefined)(
    "keeps every core control reachable in a narrow viewport, and offers no credential surface",
    async () => {
      const acceptance = await startShellAcceptance();
      const session = await launchBrowser({ executable: browser ?? "", width: 420, height: 820 });
      open.push({
        close: async () => {
          await session.close();
          await acceptance.close();
        },
      });
      await session.navigate(acceptance.pageUrl);
      await session.waitFor(connectionStatus, (value) => value.includes("已就绪"), 25000, "the narrow shell to become ready");

      await session.click('[data-testid="new-session"]');
      await session.waitFor(
        'document.querySelector("[data-testid=session-item][data-selected=true]") !== null ? "yes" : ""',
        (value) => value === "yes",
        15000,
        "a session in the narrow viewport",
      );
      const created = await session.evaluate<string>(
        'document.querySelector("[data-testid=session-item][data-selected=true]").getAttribute("data-session-id")',
      );
      // The session pane's own controls, at this width.
      expect(JSON.parse(await session.evaluate<string>(reachableOf(["composer-input", "send-button", "rename-start", "delete-start"])))).toEqual([]);

      // The other entry is one click away, and the settings behind it are
      // usable from here: read, edit and save, without the directory in the way.
      await session.click('[data-testid="sidebar-tab-settings"]');
      await session.waitFor(existsOf('[data-testid="settings-panel"]'), (value) => value === "yes", 15000, "the settings pane in the narrow viewport");
      expect(JSON.parse(await session.evaluate<string>(reachableOf(["settings-read-host", "settings-read-model"])))).toEqual([]);
      await session.click('[data-testid="settings-read-host"]');
      await session.waitFor(textOf('[data-testid="settings-revisions-host"]'), (value) => value.includes("desired 修订"), 20000, "the host settings");
      await session.click('[data-testid="settings-edit-host"]');
      await session.type('[data-testid="settings-field-max-steps"]', "3");
      await session.click('[data-testid="settings-save-host"]');
      await session.waitFor(textOf('[data-testid="settings-revisions-host"]'), (value) => value.includes("desired 修订 2"), 20000, "the saved setting");

      // Back to the sessions: the same session is still the one selected, and
      // the composer is where it was.
      await session.click('[data-testid="sidebar-tab-sessions"]');
      await session.waitFor(existsOf('[data-testid="sessions-panel"]'), (value) => value === "yes", 15000, "the session pane again");
      expect(
        await session.evaluate<string>('document.querySelector("[data-testid=session-item][data-selected=true]").getAttribute("data-session-id")'),
      ).toBe(created);
      expect(JSON.parse(await session.evaluate<string>(reachableOf(["composer-input", "send-button"])))).toEqual([]);

      // Nothing on this page can hold a credential: the settings panel edits
      // the host's closed schema, and no field is a secret field.
      expect(await session.evaluate<string>(`String(document.querySelectorAll('input[type="password"], [data-testid*="credential"], [data-testid*="token"], [data-testid*="apikey"]').length)`)).toBe("0");

      expect(session.uncaughtExceptions()).toEqual([]);
    },
    120000,
  );

  it.skipIf(browser === undefined)(
    "keeps the settings entry and the session list's scroll apart, however long the directory is",
    async () => {
      const shell = await openShell();
      await seedSessions(shell.acceptance, WINDOW * 2);
      await shell.session.reload();
      await shell.session.waitFor(connectionStatus, (value) => value.includes("已就绪"), 45000, "the reloaded shell");
      await shell.session.waitFor(countOf('[data-testid="session-item"]'), (value) => Number(value) > 0, 25000, "the first page");
      const firstPage = Number(await shell.session.evaluate<string>(countOf('[data-testid="session-item"]')));
      await shell.session.click('[data-testid="load-older-sessions"]');
      await shell.session.waitFor(countOf('[data-testid="session-item"]'), (value) => Number(value) > firstPage, 20000, "the older page");

      // The directory is longer than any pane: the list carries the scroll, and
      // the rail it sits in does not grow with it.
      const layout = await shell.session.evaluate<string>(`(() => {
        const list = document.querySelector(".sessions");
        const rail = document.querySelector(".shell__rail");
        return JSON.stringify({
          listScrolls: list.scrollHeight > list.clientHeight,
          railScrolls: rail.scrollHeight > rail.clientHeight,
        });
      })()`);
      expect(JSON.parse(layout)).toEqual({ listScrolls: true, railScrolls: false });

      // Scrolling the list to its end moves the list and nothing else: the two
      // entries are exactly where they were, and where they always are.
      const before = await shell.session.evaluate<string>(rectOf('[data-testid="sidebar-tab-settings"]'));
      expect(JSON.parse(before).height).toBeGreaterThan(0);
      await shell.session.evaluate<string>('(() => { const list = document.querySelector(".sessions"); list.scrollTop = list.scrollHeight; return "scrolled"; })()');
      expect(await shell.session.evaluate<string>(rectOf('[data-testid="sidebar-tab-settings"]'))).toBe(before);

      // And the settings are one click from here, whatever the directory holds.
      await shell.session.click('[data-testid="sidebar-tab-settings"]');
      await shell.session.waitFor(existsOf('[data-testid="settings-panel"]'), (value) => value === "yes", 15000, "the settings pane");
      expect(JSON.parse(await shell.session.evaluate<string>(reachableOf(["settings-read-host", "settings-read-model"])))).toEqual([]);

      expect(shell.session.uncaughtExceptions()).toEqual([]);
    },
    150000,
  );

  it.skipIf(browser === undefined)(
    "switches the sidebar between the sessions and the settings without losing the selection",
    async () => {
      const shell = await openShell();
      await createSession(shell.session);
      const selected = await shell.session.evaluate<string>(
        'document.querySelector("[data-testid=session-item][data-selected=true]").getAttribute("data-session-id")',
      );
      const settingsWrites = shell.acceptance.controls.requestsOf("settings.update").length;

      await shell.session.click('[data-testid="sidebar-tab-settings"]');
      await shell.session.waitFor(existsOf('[data-testid="settings-panel"]'), (value) => value === "yes", 15000, "the settings pane");
      // One pane at a time: the directory is not on screen to be scrolled, and
      // the two never share one document flow.
      expect(await shell.session.evaluate<string>(`document.querySelector('[data-testid="sidebar-pane"]').getAttribute("data-pane")`)).toBe("settings");
      expect(await shell.session.evaluate<string>(existsOf('[data-testid="sessions-panel"]'))).toBe("");

      await shell.session.click('[data-testid="sidebar-tab-sessions"]');
      await shell.session.waitFor(existsOf('[data-testid="sessions-panel"]'), (value) => value === "yes", 15000, "the session pane");
      // The session truth the pane comes back to is the same one: the selection
      // is still the reader's, and the shell is still aimed at it.
      expect(await shell.session.evaluate<string>(`document.querySelector('[data-testid="sidebar-pane"]').getAttribute("data-pane")`)).toBe("sessions");
      expect(
        await shell.session.evaluate<string>('document.querySelector("[data-testid=session-item][data-selected=true]").getAttribute("data-session-id")'),
      ).toBe(selected);
      // Looking at the other entry wrote nothing to the host.
      expect(shell.acceptance.controls.requestsOf("settings.update")).toHaveLength(settingsWrites);
      expect(shell.acceptance.controls.requestsOf("sessions.rename")).toHaveLength(0);

      expect(shell.session.uncaughtExceptions()).toEqual([]);
    },
    120000,
  );

  it.skipIf(browser === undefined)(
    "reports a rename once, and keeps one report however often the session is renamed",
    async () => {
      const shell = await openShell();
      await createSession(shell.session);

      const rename = async (title: string): Promise<void> => {
        await shell.session.click('[data-testid="rename-start"]');
        await shell.session.type('[data-testid="rename-input"]', title);
        await shell.session.click('[data-testid="rename-submit"]');
        await shell.session.waitFor(
          'document.querySelector("[data-testid=session-item][data-selected=true] .session__label")?.textContent ?? ""',
          (value) => value === title,
          20000,
          `the session renamed to ${title}`,
        );
      };

      await rename("第一版");
      await waitForRequests(shell.acceptance.controls, "sessions.rename", 1, "the rename to cross the wire");
      const once = await shell.session.evaluate<readonly string[]>(noticesOf);
      expect(once).toHaveLength(1);
      expect(once[0]).toContain("已保存");
      expect(once[0]).toContain("第一版");

      await rename("第二版");
      await rename("第三版");
      await waitForRequests(shell.acceptance.controls, "sessions.rename", 3, "each rename to cross the wire");
      // Three renames crossed the wire, so three results were answered — and the
      // page answers each subject once: one report, naming the session it is
      // about, saying what the newest rename did.
      expect(shell.acceptance.controls.requestsOf("sessions.rename")).toHaveLength(3);
      const repeated = await shell.session.evaluate<readonly string[]>(noticesOf);
      expect(repeated).toHaveLength(1);
      expect(repeated[0]).toContain("第三版");

      expect(shell.session.uncaughtExceptions()).toEqual([]);
    },
    150000,
  );

  it.skipIf(browser === undefined)(
    "treats a restarted host as a different authority: no selection, no pages, no resurrection",
    async () => {
      const first = await openShell();
      await seedSessions(first.acceptance, WINDOW + 5);
      await first.session.reload();
      await first.session.waitFor(connectionStatus, (value) => value.includes("已就绪"), 45000, "the reloaded shell");
      await first.session.waitFor(countOf('[data-testid="session-item"]'), (value) => Number(value) > 0, 20000, "the first page");
      const firstPage = Number(await first.session.evaluate<string>(countOf('[data-testid="session-item"]')));
      await first.session.click('[data-testid="load-older-sessions"]');
      await first.session.waitFor(countOf('[data-testid="session-item"]'), (value) => Number(value) > firstPage, 20000, "the older page");
      const firstInstance = await first.session.evaluate<string>(textOf('[data-testid="host-instance"]'));

      // The whole application restarts on the same ports: the page stays open.
      const pagePort = Number(new URL(first.acceptance.pageUrl).port);
      const bindingPort = Number(new URL(first.acceptance.bindingOrigin).port);
      await first.acceptance.close();
      const second = await startShellAcceptance({ pagePort, bindingPort });
      open.push({
        close: async () => {
          await second.close();
        },
      });
      await first.session.reload();
      await first.session.waitFor(connectionStatus, (value) => value.includes("已就绪"), 45000, "the restarted host");

      expect(await first.session.evaluate<string>(textOf('[data-testid="host-instance"]'))).not.toBe(firstInstance);
      // Nothing the old host's directory taught this page survives: no loaded
      // pages pretending to be this host's, and no selection.
      await first.session.waitFor(textOf('[data-testid="sessions-window"]'), (value) => value.includes("已加载全部 0 个会话"), 20000, "the new host's empty directory");
      expect(await first.session.evaluate<string>(countOf('[data-testid="session-item"][data-selected=true]'))).toBe("0");
      expect(await first.session.evaluate<string>(existsOf('[data-testid="load-older-sessions"]'))).toBe("");

      expect(first.session.uncaughtExceptions()).toEqual([]);
    },
    150000,
  );

  it.skipIf(browser === undefined)(
    "walks past everything its cache can hold and reaches the oldest sessions",
    async () => {
      // Five pages of the shell's own page profile, read one after another: the
      // cache is bounded, and the traversal is not.
      const total = 260;
      const acceptance = await startShellAcceptance();
      const seeder = await acceptance.connect();
      for (let index = 0; index < total; index += 1) await seeder.sessions.create();
      seeder.disconnect();

      const session = await launchBrowser({ executable: browser ?? "" });
      open.push({
        close: async () => {
          await session.close();
          await acceptance.close();
        },
      });
      await session.navigate(acceptance.pageUrl);
      await session.waitFor(connectionStatus, (value) => value.includes("已就绪"), 45000, "the shell to become ready");
      await session.waitFor(countOf('[data-testid="session-item"]'), (value) => Number(value) > 0, 20000, "the first window");

      let clicks = 0;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        if (await session.evaluate<string>(`document.querySelector('[data-testid="load-older-sessions"]') === null ? "gone" : "present"`) === "gone") break;
        await session.click('[data-testid="load-older-sessions"]');
        clicks += 1;
        await session.waitFor(
          `document.querySelector('[data-testid="load-older-sessions"]') === null ? "gone" : (document.querySelector('[data-testid="load-older-sessions"]').disabled ? "busy" : "present")`,
          (value) => value !== "busy",
          25000,
          "the next older page",
        );
      }

      // The traversal reached the end of the collection: the page says so, and
      // it says what it is not holding any more.
      expect(clicks).toBeGreaterThanOrEqual(4);
      await session.waitFor(textOf('[data-testid="sessions-window"]'), (value) => value.includes("已经读到最早的会话"), 20000, "the end of the traversal");
      expect(await session.evaluate<string>(textOf('[data-testid="sessions-window"]'))).toContain("不再保留的范围");
      // The cache is bounded: the window plus the profile's three older pages,
      // and never the whole collection.
      const held = Number(await session.evaluate<string>(countOf('[data-testid="session-item"]')));
      expect(held).toBeLessThanOrEqual(20 + 3 * 50);
      expect(held).toBeGreaterThanOrEqual(150);

      // The oldest sessions are reachable: selecting the last row shows it and
      // lets the reader write to it.
      await session.evaluate<string>(`(() => {
        const items = [...document.querySelectorAll("[data-testid=session-item]")];
        items[items.length - 1].click();
        return "clicked";
      })()`);
      await session.waitFor(
        'document.querySelector("[data-testid=session-item][data-selected=true]") !== null ? "yes" : ""',
        (value) => value === "yes",
        10000,
        "the oldest session to be selected",
      );
      await session.waitFor(disabledOf('[data-testid="composer-input"]'), (value) => value === "false", 15000, "the confirmed session to allow writes");

      expect(session.uncaughtExceptions()).toEqual([]);
    },
    180000,
  );

  it.skipIf(browser === undefined)(
    "runs and shows a run for a focused session the window does not hold",
    async () => {
      const total = 60;
      const acceptance = await startShellAcceptance();
      const seeder = await acceptance.connect();
      for (let index = 0; index < total; index += 1) await seeder.sessions.create();
      seeder.disconnect();

      const session = await launchBrowser({ executable: browser ?? "" });
      open.push({
        close: async () => {
          await session.close();
          await acceptance.close();
        },
      });
      await session.navigate(acceptance.pageUrl);
      await session.waitFor(connectionStatus, (value) => value.includes("已就绪"), 45000, "the shell to become ready");
      await session.waitFor(countOf('[data-testid="session-item"]'), (value) => Number(value) > 0, 20000, "the first window");
      await session.click('[data-testid="load-older-sessions"]');
      await session.waitFor(countOf('[data-testid="session-item"]'), (value) => Number(value) > 20, 20000, "the older page");

      // The oldest session is outside the window the host publishes: the pin,
      // not the window, is what this client stands behind for it.
      await session.evaluate<string>(`(() => {
        const items = [...document.querySelectorAll("[data-testid=session-item]")];
        items[items.length - 1].click();
        return "clicked";
      })()`);
      await session.waitFor(disabledOf('[data-testid="composer-input"]'), (value) => value === "false", 20000, "the confirmed session to allow writes");

      // A run started for it is still this client's business: it is shown as
      // running and it completes, with the live timeline and the result.
      await session.type('[data-testid="composer-input"]', "你好");
      await session.click('[data-testid="send-button"]');
      await session.waitFor(runStatus, (value) => value.includes("运行中") || value.includes("已完成"), 20000, "the run for the older session");
      await session.waitFor(runStatus, (value) => value.includes("已完成"), 25000, "the run to finish");
      await session.waitFor(textOf('[data-testid="msg-assistant"]'), (value) => value.includes("收到：你好"), 20000, "the answer recorded for that session");
      // The run's own facts are on the strip even though the session is outside
      // the published window.
      expect(await session.evaluate<string>(textOf('[data-testid="run-strip"]'))).toContain("已完成");

      expect(session.uncaughtExceptions()).toEqual([]);
    },
    180000,
  );

  it.skipIf(browser === undefined)(
    "refuses a rename whose draft was based on a revision a real rename replaced",
    async () => {
      const shell = await openShell();
      await createSession(shell.session);
      const sessionId = await shell.session.evaluate<string>(
        'document.querySelector("[data-testid=session-item][data-selected=true]").getAttribute("data-session-id")',
      );

      // The draft is opened first; then the host really changes the session, so
      // the client itself sees the new revision before the draft is submitted.
      await shell.session.click('[data-testid="rename-start"]');
      await shell.session.type('[data-testid="rename-input"]', "草稿标题");
      const external = await shell.acceptance.connect();
      const before = await external.sessions.get({ sessionId });
      await external.sessions.rename({
        sessionId,
        expectedRevision: before.session.metadataRevision,
        title: "外部标题",
      });
      external.disconnect();
      await shell.session.waitFor(
        'document.querySelector("[data-testid=session-item][data-selected=true] .session__label")?.textContent ?? ""',
        (value) => value === "外部标题",
        20000,
        "the host's own title",
      );

      await shell.session.click('[data-testid="rename-submit"]');
      // The sentence a rename conflict produces, and only that one.
      await shell.session.waitFor(
        'document.body.textContent.includes("草稿保留") ? "refused" : ""',
        (value) => value === "refused",
        20000,
        "the rename conflict",
      );

      // One rename crossed the wire, the host's title stands, and the draft is
      // still the user's text.
      await waitForRequests(shell.acceptance.controls, "sessions.rename", 1, "the refused rename to cross the wire");
      expect(shell.acceptance.controls.requestsOf("sessions.rename")).toHaveLength(1);
      expect(
        await shell.session.evaluate<string>('document.querySelector("[data-testid=session-item][data-selected=true] .session__label")?.textContent ?? ""'),
      ).toBe("外部标题");
      expect(await shell.session.evaluate<string>(`document.querySelector('[data-testid="rename-input"]').value`)).toBe("草稿标题");
      expect(await shell.session.evaluate<string>(textOf('[data-testid="rename-base"]'))).toContain("Host 上的版本现在是");

      expect(shell.session.uncaughtExceptions()).toEqual([]);
    },
    120000,
  );

  it.skipIf(browser === undefined)(
    "keeps the reader's new selection when a deletion for the old one lands",
    async () => {
      const shell = await openShell();
      await createSession(shell.session);
      const first = await shell.session.evaluate<string>(
        'document.querySelector("[data-testid=session-item][data-selected=true]").getAttribute("data-session-id")',
      );
      await createSession(shell.session);
      await shell.session.evaluate<string>(`(() => {
        document.querySelector('[data-testid="session-item"][data-session-id="${first}"]').click();
        return "selected";
      })()`);
      await shell.session.waitFor(
        `document.querySelector('[data-testid="session-item"][data-session-id="${first}"][data-selected=true]') !== null ? "yes" : ""`,
        (value) => value === "yes",
        10000,
        "the first session to be selected",
      );
      await shell.session.waitFor(disabledOf('[data-testid="composer-input"]'), (value) => value === "false", 20000, "the first session's confirmation");

      // The deletion is sent and the host's own answer is parked on the binding:
      // the request really reached the host, and this page cannot know the
      // outcome yet.
      shell.acceptance.controls.holdNextDeleteResponse();
      await shell.session.click('[data-testid="delete-start"]');
      await shell.session.click('[data-testid="delete-confirm"]');
      await waitForRequests(shell.acceptance.controls, "sessions.delete", 1, "the deletion to cross the wire");
      await waitForHeld(
        () => shell.acceptance.controls.deleteAnswerHeld(),
        "the host's delete answer to be parked",
      );
      expect(
        shell.acceptance.controls.deleteAnswersDelivered(),
        "nothing was delivered while it is parked",
      ).toBe(0);

      // What the host itself says while the page is waiting for its answer: the
      // session the first call asked for is gone from the host's directory.
      const hostNow = await shell.acceptance.connect();
      try {
        const listed = await hostNow.sessions.list({ limit: 20 });
        expect(listed.sessions.items.some((session) => session.sessionId === first)).toBe(false);
      } finally {
        hostNow.disconnect();
      }

      // The completion is not in the page yet: the call this page made is still
      // unanswered, so no outcome has been claimed either way.
      expect(
        await shell.session.evaluate<boolean>(`document.body.textContent.includes("会话已被 Host 永久删除")`),
      ).toBe(false);

      // The reader moves on: another session is selected, focused and confirmed
      // while the deletion's answer is still parked.
      const second = await shell.session.evaluate<string>(`(() => {
        const other = [...document.querySelectorAll('[data-testid="session-item"]')].find((item) => item.getAttribute("data-session-id") !== "${first}");
        other.click();
        return other.getAttribute("data-session-id");
      })()`);
      await shell.session.waitFor(
        `document.querySelector('[data-testid="session-item"][data-session-id="${second}"][data-selected=true]') !== null ? "yes" : ""`,
        (value) => value === "yes",
        10000,
        "the reader's own selection",
      );
      await shell.session.waitFor(disabledOf('[data-testid="composer-input"]'), (value) => value === "false", 20000, "the new session's confirmation");
      expect(second).not.toBe(first);
      expect(
        shell.acceptance.controls.deleteAnswersDelivered(),
        "still withheld while the reader moved on",
      ).toBe(0);
      expect(shell.acceptance.controls.deleteAnswerHeld()).toBe(true);

      // Release once: the parked answer lands, and releasing again delivers
      // nothing more.
      shell.acceptance.controls.releaseDeleteAnswer();
      expect(shell.acceptance.controls.deleteAnswersDelivered()).toBe(1);
      shell.acceptance.controls.releaseDeleteAnswer();
      expect(shell.acceptance.controls.deleteAnswersDelivered()).toBe(1);

      // The exact completion is processed: the page answers for the call it
      // made, and it answers about its own target only.
      await shell.session.waitFor(
        'document.body.textContent.includes("会话已被 Host 永久删除") ? "done" : ""',
        (value) => value === "done",
        20000,
        "the deletion's own completion",
      );

      expect(await shell.session.evaluate<string>(`document.querySelector('[data-testid="session-item"][data-session-id="${second}"][data-selected=true]') !== null ? "yes" : "no"`)).toBe("yes");
      await shell.session.waitFor(disabledOf('[data-testid="composer-input"]'), (value) => value === "false", 15000, "the composer to stay usable");
      expect(await shell.session.evaluate<string>(countOf(`[data-testid="session-item"][data-session-id="${first}"]`))).toBe("0");

      expect(shell.session.uncaughtExceptions()).toEqual([]);
    },
    150000,
  );
});
