/**
 * The workspace's browser gate: the product page, driven like a person uses it.
 *
 * It talks to a *running* product server over the DevTools protocol, because
 * what it checks is exactly the part an API test cannot: that the page renders,
 * that a reader can type a topic, reopen a finished research task, click a
 * matrix cell and see the passage behind it, open the report preview, and get a
 * real PDF. Input goes through `Input.dispatchMouseEvent` and `Input.insertText`
 * — real browser-level input, not a scripted DOM call — so a click that the
 * page cannot receive is a failure here, not a workaround.
 *
 *   node scripts/verify-workspace.mjs --url http://127.0.0.1:47822/
 *
 * It prints one result line per case and exits non-zero if any case failed.
 * A missing browser is reported as a failure when a URL is given: this is a
 * gate, and "did not run" is not "passed".
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BROWSER_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

function findBrowser() {
  const override = process.env["RESEARCHPAGE_BROWSER"] ?? process.env["EVERY_DAGENT_BROWSER"];
  if (override !== undefined && override !== "" && existsSync(override)) return override;
  for (const candidate of BROWSER_CANDIDATES) if (existsSync(candidate)) return candidate;
  return undefined;
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function connect(url) {
  const debugPort = 9300 + Math.floor(Math.random() * 500);
  const profile = mkdtempSync(join(tmpdir(), "researchpage-gate-"));
  const executable = findBrowser();
  if (executable === undefined) throw new Error("no Chrome/Edge found; set RESEARCHPAGE_BROWSER");

  const child = spawn(
    executable,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${debugPort}`,
      "--window-size=1400,1000",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  const deadline = Date.now() + 20_000;
  let target;
  while (target === undefined) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const targets = await response.json();
      target = targets.find((candidate) => candidate.type === "page" && candidate.webSocketDebuggerUrl !== undefined);
    } catch {
      // Still starting.
    }
    if (target === undefined) {
      if (Date.now() > deadline) throw new Error("the browser never came up");
      await delay(100);
    }
  }

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("the devtools socket failed")));
  });

  const answers = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id !== undefined) {
      const settle = answers.get(message.id);
      if (settle !== undefined) {
        answers.delete(message.id);
        settle(message);
      }
    }
  });

  let nextId = 0;
  const call = async (method, params = {}) => {
    nextId += 1;
    const id = nextId;
    const answer = new Promise((resolve) => {
      answers.set(id, resolve);
    });
    socket.send(JSON.stringify({ id, method, params }));
    return answer;
  };

  const evaluate = async (expression) => {
    const answer = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    const result = answer.result?.result;
    if (result === undefined) throw new Error(`the page could not evaluate: ${expression}`);
    return result.value;
  };

  await call("Page.enable");
  await call("Runtime.enable");

  const session = {
    async goto(url) {
      await call("Page.navigate", { url });
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const state = await evaluate("document.readyState").catch(() => "loading");
        if (state === "complete") return;
        await delay(100);
      }
      throw new Error("the page never finished loading");
    },
    async evaluate(expression) {
      return await evaluate(expression);
    },
    /** A real mouse click at the centre of the element the selector names. */
    async click(selector) {
      const box = await evaluate(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el === null) return null; el.scrollIntoView({block: "center"}); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
      );
      if (box === null) throw new Error(`no element matches ${selector}`);
      const point = { x: Math.round(box.x), y: Math.round(box.y) };
      await call("Input.dispatchMouseEvent", { type: "mouseMoved", ...point, button: "none" });
      await call("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
      await call("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
    },
    /** Real typing into a focused field: click it, clear it, then insert text. */
    async type(selector, text) {
      await session.click(selector);
      await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.select?.(); return true; })()`);
      await call("Input.insertText", { text });
    },
    async waitFor(expression, what, timeoutMs = 15_000) {
      const deadlineAt = Date.now() + timeoutMs;
      for (;;) {
        const value = await evaluate(`Boolean(${expression})`).catch(() => false);
        if (value) return;
        if (Date.now() > deadlineAt) throw new Error(`timed out waiting for ${what}`);
        await delay(150);
      }
    },
    async close() {
      socket.close();
      child.kill();
      await delay(200);
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch {
        // The killed browser may still hold the profile.
      }
    },
  };

  return session;
}

const results = [];
function case_(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : ` — ${detail}`}`);
}

async function main() {
  const urlArg = process.argv.indexOf("--url");
  const url = urlArg === -1 ? undefined : process.argv[urlArg + 1];
  if (url === undefined) {
    console.error("usage: node scripts/verify-workspace.mjs --url <product url>");
    process.exit(2);
  }

  const session = await connect(url);
  try {
    await session.goto(url);

    // 1. The workspace renders.
    const hasInput = await session.evaluate(`document.querySelector('[data-testid="topic-input"]') !== null`);
    case_("workspace renders with a topic input", hasInput === true);

    // 2. A finished research task is listed and can be reopened by clicking it.
    // The list arrives with the page's first poll, so this waits for it rather
    // than sampling the instant the document reports itself complete.
    const historySelector = "[data-testid^='history-']";
    let hasHistory = false;
    try {
      await session.waitFor(
        `document.querySelector('[data-testid^="history-"]') !== null`,
        "the research list to arrive",
        10_000,
      );
      hasHistory = true;
    } catch {
      hasHistory = false;
    }
    case_("a finished research task is listed", hasHistory === true);
    if (hasHistory !== true) return;

    await session.click(historySelector);
    await session.waitFor(
      `document.querySelector('[data-testid="card-topic"]') !== null`,
      "the task card to open after the click",
    );
    const card = await session.evaluate(
      `(() => {
        const text = (id) => { const el = document.querySelector('[data-testid="' + id + '"]'); return el === null ? null : el.textContent; };
        return { topic: text("card-topic"), subjects: text("card-subjects"), dimensions: text("card-dimensions") };
      })()`,
    );
    case_("clicking the task reopens its card", card.topic !== null && card.subjects !== null, card.topic ?? "no topic");

    // 3. The evidence matrix renders from real data.
    const matrix = await session.evaluate(
      `(() => {
        const table = document.querySelector('[data-testid="evidence-matrix"]');
        if (table === null) return null;
        const cells = [...table.querySelectorAll('[data-testid^="cell-"]')];
        return {
          rows: table.querySelectorAll("tbody tr").length,
          columns: table.querySelectorAll("thead th").length,
          cells: cells.length,
          marks: cells.map((cell) => cell.textContent).join(""),
        };
      })()`,
    );
    case_(
      "the evidence matrix renders with derived marks",
      matrix !== null && matrix.cells > 0 && /[●◐◑◆○]/.test(matrix.marks),
      matrix === null ? "no matrix" : `${matrix.rows} rows × ${matrix.columns} columns, ${matrix.cells} cells`,
    );

    // 4. Clicking a cell that holds material shows the passage behind it. The
    //    cell does not have to be "reviewed": the state this product reports
    //    for a passage nobody has judged yet still has to be inspectable.
    const suppliedCell = await session.evaluate(
      `(() => {
        const held = ["cell--reviewed", "cell--limited", "cell--unassessed", "cell--conflict"];
        const cell = [...document.querySelectorAll('[data-testid^="cell-"]')].find((candidate) =>
          held.some((name) => candidate.className.includes(name)),
        );
        return cell === undefined ? null : cell.getAttribute("data-testid");
      })()`,
    );
    if (suppliedCell === null) {
      case_("a cell holding material can be inspected", false, "no cell with material in this task");
    } else {
      await session.click(`[data-testid="${suppliedCell}"]`);
      await session.waitFor(
        `document.querySelector('[data-testid="inspector"] .evidence__excerpt') !== null`,
        "the inspector to show an excerpt",
      );
      const inspector = await session.evaluate(
        `(() => {
          const excerpt = document.querySelector('[data-testid="inspector"] .evidence__excerpt');
          const scope = document.querySelector('[data-testid="inspector"] .evidence__item .tag');
          const sources = document.querySelectorAll('[data-testid="inspector"] .sources li').length;
          return { excerpt: excerpt === null ? "" : excerpt.textContent.slice(0, 60), scope: scope === null ? null : scope.textContent, sources };
        })()`,
      );
      case_(
        "clicking a cell with material shows its evidence and read scope",
        inspector.excerpt.length > 10,
        `${inspector.scope ?? "?"} · sources=${String(inspector.sources)} · ${inspector.excerpt.slice(0, 40)}…`,
      );
    }

    // 5. The report preview renders the same snapshot the PDF will use.
    const reportTabEnabled = await session.evaluate(
      `(() => { const tab = document.querySelector('[data-testid="tab-report"]'); return tab !== null && !tab.disabled; })()`,
    );
    if (reportTabEnabled !== true) {
      case_("the report preview opens", false, "no report for this task");
    } else {
      await session.click('[data-testid="tab-report"]');
      await session.waitFor(`document.querySelector('[data-testid="report-frame"]') !== null`, "the preview frame");
      const frameSrc = await session.evaluate(`document.querySelector('[data-testid="report-frame"]').getAttribute("src")`);
      const html = await (await fetch(new URL(frameSrc, url))).text();
      case_(
        "the report preview renders the report document",
        html.includes("参考来源") && html.includes("<table") && !html.includes("<script"),
        `${String(html.length)} chars`,
      );
    }

    // 6. A real PDF is downloadable from the workspace.
    const pdfLink = await session.evaluate(
      `(() => { const link = document.querySelector('[data-testid="download-pdf"]'); return link === null ? null : link.getAttribute("href"); })()`,
    );
    if (pdfLink === null) {
      case_("the workspace offers the exported PDF", false, "no download link");
    } else {
      const response = await fetch(new URL(pdfLink, url));
      const bytes = new Uint8Array(await response.arrayBuffer());
      const magic = String.fromCharCode(...bytes.slice(0, 5));
      case_("the workspace offers a real PDF", response.status === 200 && magic === "%PDF-", `${String(bytes.length)} bytes`);
    }

    // 7. A reload reopens the same research task.
    await session.goto(url);
    await session.waitFor(`document.querySelector('[data-testid="card-topic"]') !== null`, "the task to reopen after reload");
    const afterReload = await session.evaluate(
      `(() => {
        const card = document.querySelector('[data-testid="card-topic"]');
        const tab = document.querySelector('[data-testid="tab-report"]');
        return { topic: card === null ? null : card.textContent, reportReady: tab !== null && !tab.disabled };
      })()`,
    );
    case_(
      "a reload reopens the finished research",
      afterReload.topic !== null && afterReload.reportReady === true,
      afterReload.topic ?? "no topic",
    );

    // 8. A new research can be started from the workspace: the entry returns to
    //    the topic form, and the field accepts real typing.
    await session.click('[data-testid="new-research"]');
    await session.waitFor(`document.querySelector('[data-testid="topic-input"]') !== null`, "the topic form to return");
    await session.type('[data-testid="topic-input"]', "Agent memory 架构与代表系统比较");
    const typed = await session.evaluate(`document.querySelector('[data-testid="topic-input"]').value`);
    case_(
      "a new research can be started and the topic field accepts real typing",
      typeof typed === "string" && typed.includes("Agent memory"),
      String(typed),
    );
  } finally {
    await session.close();
  }
}

main()
  .then(() => {
    const failed = results.filter((result) => result.ok !== true);
    console.log(`\n${String(results.length - failed.length)}/${String(results.length)} cases passed`);
    process.exitCode = failed.length === 0 ? 0 : 1;
  })
  .catch((error) => {
    console.error(`the workspace gate could not run: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  });
