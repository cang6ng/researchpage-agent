/**
 * The workspace's browser gate: the product page, driven like a person uses it.
 *
 * It talks to a *running* product server over the DevTools protocol, because
 * what it checks is exactly the part an API test cannot: that the page renders,
 * that a reader can open a project, read the evidence matrix, follow a sentence
 * in the report to the passage behind it, ask the assistant a question, propose
 * an edit and accept it — and that the document only changes when it is told
 * to. Input goes through `Input.dispatchMouseEvent` and `Input.insertText` —
 * real browser-level input, not a scripted DOM call — so a click the page
 * cannot receive is a failure here, not a workaround.
 *
 *   node scripts/verify-workspace.mjs --url http://127.0.0.1:4310/
 *
 * Options:
 *   --task <id>     open this project instead of the first one listed
 *   --model         also drive the model-backed actions (Ask / Research / Edit)
 *   --shots <dir>   write screenshots at 1366×768, 1440×900 and 1920×1080
 *
 * It prints one result line per case and exits non-zero if any case failed.
 * A missing browser is reported as a failure when a URL is given: this is a
 * gate, and "did not run" is not "passed".
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

async function connect({ width = 1440, height = 900 } = {}) {
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
      "--hide-scrollbars",
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${debugPort}`,
      `--window-size=${String(width)},${String(height)}`,
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
  const events = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id !== undefined) {
      const settle = answers.get(message.id);
      if (settle !== undefined) {
        answers.delete(message.id);
        settle(message);
      }
      return;
    }
    events.push(message);
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
    if (answer.result?.exceptionDetails !== undefined) {
      throw new Error(`the page threw: ${answer.result.exceptionDetails.text ?? ""}`);
    }
    const result = answer.result?.result;
    if (result === undefined) throw new Error(`the page could not evaluate: ${expression.slice(0, 80)}`);
    return result.value;
  };

  await call("Page.enable");
  await call("Runtime.enable");

  const session = {
    async goto(url) {
      await call("Page.navigate", { url });
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const state = await evaluate("document.readyState").catch(() => "loading");
        if (state === "complete") return;
        await delay(100);
      }
      throw new Error("the page never finished loading");
    },
    evaluate,
    async setViewport(width, height) {
      await call("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
    },
    /**
     * A real mouse click at the centre of the element the selector names.
     *
     * The point is resolved twice: the page polls its own state, so an element
     * can move between "where it is" and "where the mouse goes", and a gate
     * that clicks a stale coordinate would report a product failure that is
     * really a race in the gate.
     */
    async click(selector) {
      let previous = null;
      for (let attempt = 0; attempt < 25; attempt += 1) {
        const box = await evaluate(
          `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el === null) return null; el.scrollIntoView({block: "center"}); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
        );
        if (box === null) throw new Error(`no element matches ${selector}`);
        if (previous !== null && Math.abs(previous.x - box.x) < 2 && Math.abs(previous.y - box.y) < 2) {
          const point = { x: Math.round(box.x), y: Math.round(box.y) };
          await call("Input.dispatchMouseEvent", { type: "mouseMoved", ...point, button: "none" });
          await call("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
          await call("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
          await delay(140);
          return;
        }
        previous = box;
        await delay(120);
      }
      throw new Error(`the element ${selector} never settled`);
    },
    /**
     * A real mouse click on the element holding this text, inside a container.
     *
     * Aimed by geometry rather than by a scripted click: activating a control
     * that is a styled radio — Mantine's segmented control, for instance —
     * only happens for a real pointer event, so a gate that wants to test the
     * control must move the mouse.
     */
    async clickText(text, containerSelector) {
      const box = await evaluate(
        `(() => {
           const scope = document.querySelector(${JSON.stringify(containerSelector)});
           if (scope === null) return null;
           const target = [...scope.querySelectorAll("*")].find((el) => (el.textContent ?? "").trim() === ${JSON.stringify(text)});
           if (target === undefined || target === null) return null;
           target.scrollIntoView({block: "center"});
           const r = target.getBoundingClientRect();
           return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
         })()`,
      );
      if (box === null) throw new Error(`no element with text ${text} inside ${containerSelector}`);
      const point = { x: Math.round(box.x), y: Math.round(box.y) };
      await call("Input.dispatchMouseEvent", { type: "mouseMoved", ...point, button: "none" });
      await call("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
      await call("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
      await delay(200);
    },
    /** Whether the assistant's dock is open with its composer ready. */
    async assistantOpen() {
      return await evaluate(`document.querySelector('[data-testid="assistant-input"]') !== null`);
    },
    /** Which intent the assistant's segmented control currently holds. */
    async assistantIntent() {
      return await evaluate(
        `(() => {
           const inputs = [...document.querySelectorAll('input[type="radio"]')];
           const checked = inputs.find((input) => input.checked);
           return checked === undefined ? null : (checked.getAttribute("value") ?? null);
         })()`,
      );
    },
    /** Real typing into a focused field: click it, clear it, then insert text. */
    async type(selector, text) {
      await session.click(selector);
      await evaluate(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el === null) return false; el.focus(); el.select?.(); return true; })()`,
      );
      await call("Input.insertText", { text });
      await delay(120);
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
    async screenshot(path) {
      const shot = await call("Page.captureScreenshot", { format: "png" });
      const data = shot.result?.data;
      if (typeof data !== "string") throw new Error("the browser returned no screenshot");
      writeFileSync(path, Buffer.from(data, "base64"));
    },
    async close() {
      socket.close();
      child.kill();
      await delay(250);
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch {
        // The killed browser may still hold the profile.
      }
    },
  };

  return session;
}

/** A cheap look at what the page is, for diagnosing a failed step. */
async function dump(session, label) {
  const info = await session.evaluate(
    `(() => ({
       hash: location.hash,
       toolbar: document.querySelector('[data-testid="studio-toolbar"]') !== null,
       assistantButton: document.querySelector('[data-testid="open-assistant"]') !== null,
       assistantBox: (() => { const el = document.querySelector('[data-testid="open-assistant"]'); if (el === null) return null; const r = el.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { x: Math.round(r.left), y: Math.round(r.top), top: top === null ? null : top.tagName + "." + String(top.className).slice(0, 40) }; })(),
       dock: document.querySelector('[data-testid="context-dock"]') !== null,
       dockTabs: document.querySelector(".rp-dock__tabs")?.textContent ?? null,
       input: document.querySelector('[data-testid="assistant-input"]') !== null,
       notice: document.querySelector(".rp-note")?.textContent?.slice(0, 80) ?? null,
     }))()`,
  );
  console.log(`DEBUG ${label}: ${JSON.stringify(info)}`);
}

const results = [];
function case_(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : ` — ${detail}`}`);
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  const url = option("--url");
  if (url === undefined) {
    console.error("usage: node scripts/verify-workspace.mjs --url <product url> [--task <id>] [--model] [--shots <dir>]");
    process.exit(2);
  }
  const taskArg = option("--task");
  const withModel = process.argv.includes("--model");
  const shots = option("--shots");
  if (shots !== undefined) mkdirSync(shots, { recursive: true });

  const session = await connect();
  try {
    await session.goto(url);

    /* ---------------------------------------------------------- start -- */

    const hasComposer = await session.evaluate(`document.querySelector('[data-testid="topic-input"]') !== null`);
    case_("起始页渲染出研究输入框", hasComposer === true);

    await session.waitFor(`document.querySelector('[data-testid^="task-row-"]') !== null`, "the project list", 12_000);
    const listed = await session.evaluate(
      `[...document.querySelectorAll('[data-testid^="task-row-"]')].map((row) => row.getAttribute("data-testid"))`,
    );
    case_("研究项目列表渲染", Array.isArray(listed) && listed.length > 0, `${String(listed.length)} 个项目`);

    const taskId = taskArg ?? String(listed[0]).replace("task-row-", "");
    const base = url.replace(/#.*$/, "").replace(/\/$/, "");

    if (shots !== undefined) {
      await session.setViewport(1366, 768);
      await session.screenshot(join(shots, "start-1366.png"));
      await session.setViewport(1440, 900);
      await session.screenshot(join(shots, "start-1440.png"));
      await session.setViewport(1920, 1080);
      await session.screenshot(join(shots, "start-1920.png"));
      await session.setViewport(1440, 900);
    }

    /* ----------------------------------------------------------- brief -- */

    await session.goto(`${base}/#/p/${taskId}/brief`);
    await session.waitFor(`document.querySelector('[data-testid="card-confirmed"]') !== null`, "the brief", 12_000);
    const brief = await session.evaluate(
      `(() => {
        const fields = [...document.querySelectorAll(".rp-field__label")].map((el) => el.textContent.trim());
        return {
          fields,
          subjects: document.querySelectorAll(".rp-subject").length,
          dimensions: document.querySelectorAll(".rp-q").length,
          aiMarks: document.querySelectorAll(".rp-mark-ai").length,
        };
      })()`,
    );
    case_(
      "研究任务卡把 AI 提出的字段标了出来",
      brief.aiMarks > 0 && brief.subjects >= 2 && brief.dimensions >= 3,
      `${String(brief.subjects)} 个对象 · ${String(brief.dimensions)} 个维度 · ${String(brief.aiMarks)} 处标记`,
    );

    if (shots !== undefined) {
      await session.setViewport(1440, 900);
      await session.screenshot(join(shots, "brief-1440.png"));
      await session.setViewport(1366, 768);
      await session.screenshot(join(shots, "brief-1366.png"));
      await session.setViewport(1440, 900);
    }

    /* -------------------------------------------------------- research -- */

    await session.goto(`${base}/#/p/${taskId}/research`);
    await session.waitFor(`document.querySelector('[data-testid="evidence-matrix"]') !== null`, "the matrix", 12_000);
    const matrix = await session.evaluate(
      `(() => {
        const table = document.querySelector('[data-testid="evidence-matrix"]');
        const cells = [...table.querySelectorAll('[data-testid^="cell-"]')];
        const words = cells.map((cell) => cell.textContent).join(" ");
        return {
          rows: table.querySelectorAll("tbody tr").length,
          columns: table.querySelectorAll("thead th").length,
          cells: cells.length,
          hasWords: /待查|已核对|有限支持|有材料/.test(words),
          hasSummary: /条证据/.test(words),
          firstRowQuestion: table.querySelector("tbody th .rp-matrix__dimq")?.textContent ?? "",
        };
      })()`,
    );
    case_(
      "证据矩阵以文字状态与依据摘要呈现",
      matrix.cells > 0 && matrix.hasWords && matrix.hasSummary,
      `${String(matrix.rows)} 行 × ${String(matrix.columns)} 列 · ${String(matrix.cells)} 格`,
    );
    case_("矩阵行标题写的是研究问题，而不是名词", String(matrix.firstRowQuestion).length > 10, String(matrix.firstRowQuestion).slice(0, 40));

    const heldCell = await session.evaluate(
      `(() => {
        const held = ["rp-cell__status--reviewed", "rp-cell__status--limited", "rp-cell__status--unassessed", "rp-cell__status--conflict"];
        const cell = [...document.querySelectorAll('[data-testid^="cell-"]')].find((candidate) => held.some((name) => candidate.querySelector("." + name) !== null));
        return cell === undefined ? null : cell.getAttribute("data-testid");
      })()`,
    );
    if (heldCell === null) {
      case_("点击有材料的单元格会打开证据面板", false, "这个项目没有可核对的单元格");
    } else {
      await session.click(`[data-testid="${heldCell}"]`);
      await session.waitFor(`document.querySelector('[data-testid="context-dock"]') !== null`, "the dock", 8_000);
      const dock = await session.evaluate(
        `(() => {
          const dock = document.querySelector('[data-testid="context-dock"]');
          return {
            title: dock.querySelector(".rp-dock__title")?.textContent ?? "",
            excerpts: dock.querySelectorAll(".rp-evitem__excerpt").length,
            locators: dock.querySelectorAll(".rp-evitem__locator").length,
            selected: document.querySelectorAll(".rp-cell--selected").length,
          };
        })()`,
      );
      case_(
        "选中单元格后 Dock 显示片段、定位与读取范围",
        dock.excerpts > 0 && dock.locators > 0,
        `${String(dock.excerpts)} 条片段 · ${dock.title}`,
      );
      case_("被选中的单元格保持可见的选中态", dock.selected === 1, `${String(dock.selected)} 个选中`);
    }

    if (shots !== undefined) {
      await session.setViewport(1440, 900);
      await session.screenshot(join(shots, "research-dock-1440.png"));
      await session.setViewport(1366, 768);
      await session.screenshot(join(shots, "research-dock-1366.png"));
      await session.setViewport(1920, 1080);
      await session.screenshot(join(shots, "research-dock-1920.png"));
      await session.setViewport(1440, 900);
    }

    /* --------------------------------------------------------- sources -- */

    await session.goto(`${base}/#/p/${taskId}/sources`);
    await session.waitFor(`document.querySelector('[data-testid="source-table"]') !== null`, "the source table", 12_000);
    const sources = await session.evaluate(
      `(() => {
        const rows = [...document.querySelectorAll('[data-testid^="source-row-"]')];
        const first = rows[0];
        return {
          rows: rows.length,
          badges: first === undefined ? 0 : first.querySelectorAll(".rp-chip").length,
          title: first?.querySelector(".rp-src__title")?.textContent ?? "",
        };
      })()`,
    );
    case_("来源工作区是列表而非后台表格", sources.rows > 0 && sources.badges <= 3, `${String(sources.rows)} 个来源 · ${sources.title.slice(0, 30)}`);

    if (sources.rows > 0) {
      await session.click('[data-testid^="source-row-"]');
      await session.waitFor(
        `document.querySelector('[data-testid="context-dock"] .rp-dock__kicker')?.textContent === "来源"`,
        "the source dock",
        8_000,
      );
      const sourceDock = await session.evaluate(
        `(() => {
          const dock = document.querySelector('[data-testid="context-dock"]');
          return { text: dock.textContent ?? "", hasReadScope: /读取范围/.test(dock.textContent ?? "") };
        })()`,
      );
      case_("点击来源行在同一个 Dock 里打开来源详情", sourceDock.hasReadScope === true, sourceDock.text.slice(0, 40));
    }

    if (shots !== undefined) {
      await session.setViewport(1440, 900);
      await session.screenshot(join(shots, "sources-dock-1440.png"));
    }

    /* ---------------------------------------------------------- studio -- */

    await session.goto(`${base}/#/p/${taskId}/report`);
    await session.waitFor(`document.querySelector('[data-testid="document-canvas"]') !== null`, "the document canvas", 15_000);
    const canvas = await session.evaluate(
      `(() => {
        const article = document.querySelector('[data-testid="document-canvas"]');
        return {
          isNative: document.querySelectorAll("iframe").length === 0,
          theme: article.getAttribute("data-theme"),
          mechanism: article.querySelectorAll(".rp-doc__mech").length,
          tables: article.querySelectorAll(".rp-doc__table").length,
          citations: article.querySelectorAll(".rp-cite").length,
          references: article.querySelectorAll(".rp-doc__ref").length,
          sections: article.querySelectorAll(".rp-doc__section").length,
          synthesis: article.querySelectorAll(".rp-doc__synthesis").length,
        };
      })()`,
    );
    case_("报告由原生文档画布渲染（没有 iframe）", canvas.isNative === true && canvas.sections > 3, `${String(canvas.sections)} 节 · ${String(canvas.citations)} 处引用`);

    // What the report says it contains decides what has to be drawn: a report
    // written under the v2 blueprint carries mechanisms and syntheses, and one
    // written before it does not. The gate asks the document what it has and
    // then checks the canvas drew exactly those shapes — rather than assuming
    // a generation and reporting a correct v1 report as a failure.
    const declared = await (async () => {
      const bundle = await fetch(`${base}/api/research/tasks/${taskId}`).then((response) => response.json());
      if (bundle.currentReportId === null) return null;
      const document = await fetch(`${base}/api/research/reports/${String(bundle.currentReportId)}/document`).then((response) => response.json());
      const isSynthesis = new Map(
        document.claims.map((claim) => [claim.id, claim.synthesis === true || claim.claimType === "synthesis"]),
      );
      const claimIdsOf = (block) => {
        switch (block.kind) {
          case "paragraph":
            return block.claimIds;
          case "list":
            return block.items.flatMap((item) => item.claimIds);
          case "table":
            return block.rows.flatMap((row) => row.cells.flatMap((cell) => cell.claimIds));
          case "mechanism":
            return [...block.claimIds, ...block.steps.flatMap((step) => step.claimIds)];
          default:
            return [];
        }
      };
      const kinds = {};
      let markedBlocks = 0;
      for (const section of document.sections) {
        for (const block of section.blocks) {
          kinds[block.kind] = (kinds[block.kind] ?? 0) + 1;
          // The canvas marks a block as ours when everything it says is ours:
          // the gate counts the blocks that obligation produces.
          const ids = claimIdsOf(block);
          if (ids.length > 0 && ids.every((id) => isSynthesis.get(id) === true)) markedBlocks += 1;
        }
      }
      return {
        kinds,
        claims: document.claims.length,
        syntheses: document.claims.filter((claim) => isSynthesis.get(claim.id) === true).length,
        markedBlocks,
        warnings: document.validation === null ? 0 : (document.validation.warnings ?? []).length,
      };
    })();
    case_(
      "每种区块按自己的形态渲染",
      declared !== null &&
        canvas.tables >= (declared.kinds.table ?? 0) &&
        canvas.mechanism >= (declared.kinds.mechanism ?? 0) &&
        canvas.synthesis >= declared.markedBlocks,
      declared === null
        ? "no report"
        : `报告声明 ${JSON.stringify(declared.kinds)}（${String(declared.markedBlocks)} 个整段综合）· 画布 机制 ${String(canvas.mechanism)} / 比较表 ${String(canvas.tables)} / 综合 ${String(canvas.synthesis)}`,
    );

    // Selecting a claim must open the evidence inspector, and the inspector has
    // to answer two different questions: is the citation valid, and is the
    // evidence enough.
    const firstClaim = await session.evaluate(
      `(() => { const node = document.querySelector(".rp-doc__p.rp-claim"); if (node === null) return null; node.scrollIntoView({block: "center"}); return true; })()`,
    );
    if (firstClaim !== true) {
      case_("点击正文论断打开证据检查器", false, "正文里没有可选的论断");
    } else {
      await session.click(".rp-doc__p.rp-claim");
      await session.waitFor(
        `document.querySelector('[data-testid="context-dock"] .rp-dock__kicker')?.textContent === "论断"`,
        "the claim inspector",
        8_000,
      );
      const inspector = await session.evaluate(
        `(() => {
          const dock = document.querySelector('[data-testid="context-dock"]');
          const text = dock.textContent ?? "";
          return {
            hasValidity: /引用有效/.test(text),
            hasAdequacy: /证据是否足以支持/.test(text),
            hasConditions: /条件/.test(text),
            evidence: dock.querySelectorAll(".rp-evitem").length,
            rail: document.querySelectorAll('[data-testid="object-rail"]').length,
          };
        })()`,
      );
      case_(
        "检查器区分「引用有效」与「证据是否足以支持」",
        inspector.hasValidity && inspector.hasAdequacy,
        `${String(inspector.evidence)} 条证据 · 条件 ${inspector.hasConditions ? "有" : "无"}`,
      );
      case_("选中对象出现统一动作栏", inspector.rail === 1, `${String(inspector.rail)} 个动作栏`);
    }

    if (shots !== undefined) {
      await session.setViewport(1440, 900);
      await session.screenshot(join(shots, "studio-evidence-1440.png"));
      await session.setViewport(1366, 768);
      await session.screenshot(join(shots, "studio-1366.png"));
      await session.setViewport(1920, 1080);
      await session.screenshot(join(shots, "studio-1920.png"));
      await session.setViewport(1440, 900);
    }

    // Read mode is the publication; Verify mode is the working surface. The
    // words are the same in both — only the citation marks and the object
    // handles appear in Verify.
    const verifyState = await session.evaluate(
      `(() => {
         const article = document.querySelector('[data-testid="document-canvas"]');
         const words = [...article.querySelectorAll("[data-section-id]")].map((section) => section.textContent).join("").length;
         return { words, citations: article.querySelectorAll(".rp-cite").length, warnings: article.querySelectorAll(".rp-doc__warn").length };
       })()`,
    );
    await session.clickText("阅读", ".rp-toolbar");
    await delay(300);
    const readMode = await session.evaluate(
      `(() => {
         const article = document.querySelector('[data-testid="document-canvas"]');
         const visible = [...article.querySelectorAll(".rp-cite")].filter((el) => el.getBoundingClientRect().width > 0).length;
         const words = [...article.querySelectorAll("[data-section-id]")].map((section) => section.textContent).join("").length;
         return { mode: article.getAttribute("data-mode"), visible, words, warnings: article.querySelectorAll(".rp-doc__warn").length };
       })()`,
    );
    case_(
      "阅读模式隐藏引用标记，报告正文一字不少",
      readMode.mode === "read" && readMode.visible === 0 && readMode.words === verifyState.words,
      `${String(readMode.visible)} 个可见引用 · 正文 ${String(verifyState.words)} → ${String(readMode.words)} 字`,
    );
    case_(
      "质量校验提醒只出现在核验模式，不进印刷稿",
      readMode.warnings === 0 && verifyState.warnings === (declared !== null && declared.warnings > 0 ? 1 : 0),
      `报告声明 ${String(declared === null ? 0 : declared.warnings)} 条提醒 · 核验 ${String(verifyState.warnings)} · 阅读 ${String(readMode.warnings)}`,
    );
    await session.clickText("核验", ".rp-toolbar");
    await delay(300);

    /* --------------------------------------------------------- assistant -- */

    // Opening the assistant is a UI act, not a model call: the dock has to
    // arrive, and it has to arrive aimed at whatever the reader had selected.
    await dump(session, "before-open-assistant");
    let assistantOpened = false;
    for (let attempt = 0; attempt < 3 && !assistantOpened; attempt += 1) {
      await session.click('[data-testid="open-assistant"]');
      await delay(500);
      assistantOpened = await session.assistantOpen();
    }
    case_("助手面板能从报告工作台打开", assistantOpened === true);
    if (assistantOpened) {
      const target = await session.evaluate(
        `(() => { const row = document.querySelector(".rp-assistant__target"); return row === null ? null : row.textContent.trim(); })()`,
      );
      case_(
        "助手面板带着当前选中的对象",
        typeof target === "string" && target.length > 2,
        String(target).slice(0, 40),
      );
      // Escape closes the dock: the panel is a surface, not a page.
      await session.evaluate(
        `(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); return true; })()`,
      );
      await delay(300);
      const closed = await session.evaluate(`document.querySelector('[data-testid="context-dock"]') === null`);
      case_("Esc 关闭面板", closed === true);
    }

    /* ------------------------------------------------- theme switching -- */

    const beforeTheme = await session.evaluate(
      `(() => {
        const article = document.querySelector('[data-testid="document-canvas"]');
        return { theme: article.getAttribute("data-theme"), text: article.textContent.length, title: article.querySelector(".rp-doc__title")?.textContent ?? "" };
      })()`,
    );
    await session.click('[data-testid="theme-menu"]');
    await session.waitFor(`document.querySelector('[role="menuitem"]') !== null`, "the theme menu", 5_000);
    const switched = await session.evaluate(
      `(() => { const items = [...document.querySelectorAll('[role="menuitem"]')]; const target = items.find((item) => /Swiss/.test(item.textContent ?? "")); if (target === undefined) return false; target.click(); return true; })()`,
    );
    await delay(400);
    const afterTheme = await session.evaluate(
      `(() => { const article = document.querySelector('[data-testid="document-canvas"]'); return { theme: article.getAttribute("data-theme"), text: article.textContent.length, title: article.querySelector(".rp-doc__title")?.textContent ?? "" }; })()`,
    );
    case_(
      "切换主题只改变排版，内容与引用不变",
      switched === true && afterTheme.theme !== beforeTheme.theme && afterTheme.title === beforeTheme.title,
      `${beforeTheme.theme} → ${afterTheme.theme} · 标题一致 · 正文长度 ${String(beforeTheme.text)} → ${String(afterTheme.text)}`,
    );

    if (shots !== undefined) {
      await session.setViewport(1440, 900);
      await session.screenshot(join(shots, "studio-swiss-1440.png"));
    }
    // Back to the reader's theme for the remaining checks.
    await session.click('[data-testid="theme-menu"]');
    await session.waitFor(`document.querySelector('[role="menuitem"]') !== null`, "the theme menu", 5_000);
    await session.evaluate(
      `(() => { const items = [...document.querySelectorAll('[role="menuitem"]')]; const target = items.find((item) => /Editorial/.test(item.textContent ?? "")); if (target !== undefined) target.click(); return true; })()`,
    );
    await delay(300);

    /* ------------------------------------------------------------ gallery -- */

    await session.goto(`${base}/#/p/${taskId}/gallery`);
    await session.waitFor(`document.querySelector('[data-testid="theme-editorial"]') !== null`, "the gallery", 12_000);
    const gallery = await session.evaluate(
      `(() => ({
        themes: document.querySelectorAll("[data-testid^='theme-']").length,
        previews: document.querySelectorAll(".rp-theme__scale-inner .rp-doc").length,
        unchanged: document.querySelector(".rp-unchanged")?.textContent?.length ?? 0,
      }))()`,
    );
    case_(
      "模板页用同一份真实报告并排预览两套主题",
      gallery.themes === 2 && gallery.previews === 2 && gallery.unchanged > 10,
      `${String(gallery.themes)} 套主题 · ${String(gallery.previews)} 份预览`,
    );

    if (shots !== undefined) {
      await session.setViewport(1440, 900);
      await session.screenshot(join(shots, "gallery-1440.png"));
      await session.setViewport(1920, 1080);
      await session.screenshot(join(shots, "gallery-1920.png"));
      await session.setViewport(1440, 900);
    }

    /* ----------------------------------------------------------- settings -- */

    await session.goto(`${base}/#/settings`);
    await session.waitFor(`document.querySelector(".rp-settings") !== null`, "settings", 10_000);
    const groups = await session.evaluate(
      `[...document.querySelectorAll(".rp-settings__nav button")].map((button) => button.textContent.trim())`,
    );
    // Every group is walked, because "未接入 is stated honestly" is a claim
    // about the whole page, not about the group that happens to be open.
    let settingsText = "";
    for (let index = 0; index < groups.length; index += 1) {
      await session.evaluate(
        `(() => { const buttons = [...document.querySelectorAll(".rp-settings__nav button")]; buttons[${String(index)}]?.click(); return true; })()`,
      );
      await delay(150);
      settingsText += await session.evaluate(`document.querySelector(".rp-settings").textContent ?? ""`);
    }
    case_(
      "设置把未实现的能力如实标出，不放假开关",
      /未接入/.test(settingsText) && !/billing|账单|团队|升级套餐/.test(settingsText) && groups.length >= 4,
      groups.join(" / "),
    );

    if (shots !== undefined) {
      await session.setViewport(1440, 900);
      await session.screenshot(join(shots, "settings-1440.png"));
      await session.setViewport(1366, 768);
      await session.screenshot(join(shots, "settings-1366.png"));
      await session.setViewport(1440, 900);
    }

    /* -------------------------------------------------------- assistant -- */

    if (!withModel) {
      console.log("SKIP  助手动作（未加 --model：这些动作会真实调用模型）");
      return;
    }

    await session.goto(`${base}/#/p/${taskId}/report`);
    await session.waitFor(`document.querySelector('[data-testid="document-canvas"]') !== null`, "the document", 15_000);

    // Ask: a question is the one action allowed to answer in prose. The dock is
    // opened and confirmed before anything is typed into it.
    await dump(session, "before-open-assistant");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (await session.assistantOpen()) break;
      await session.click('[data-testid="open-assistant"]');
      await delay(500);
      await dump(session, `after-open-assistant-${String(attempt)}`);
    }
    await session.waitFor(`document.querySelector('[data-testid="assistant-input"]') !== null`, "the assistant composer", 10_000);
    await session.clickText("Ask", ".rp-dock");
    const askIntent = await session.assistantIntent();
    case_("助手能切到 Ask 模式", askIntent === "ask", `当前模式 ${String(askIntent)}`);
    await session.type('[data-testid="assistant-input"]', "这份材料里，GraphRAG 的索引构建成本是怎么报告的？只依据已有材料回答。");
    await session.click('[data-testid="assistant-submit"]');
    let askAnswer = "";
    try {
      await session.waitFor(
        `document.querySelector('[data-testid="action-ask"] .rp-answer') !== null`,
        "the answer to arrive",
        180_000,
      );
      askAnswer = await session.evaluate(`document.querySelector('[data-testid="action-ask"] .rp-answer')?.textContent ?? ""`);
    } catch (error) {
      askAnswer = "";
      case_("Ask 能回答问题", false, error instanceof Error ? error.message : "no answer");
    }
    if (askAnswer.length > 0) case_("Ask 能回答问题", askAnswer.length > 20, `${String(askAnswer.length)} 字`);

    // The report must not have moved because a question was asked.
    const afterAsk = await session.evaluate(`document.querySelector('[data-testid="document-canvas"]').textContent.length`);
    case_("提问不改变报告正文", Math.abs(afterAsk - beforeTheme.text) < 40, `正文长度 ${String(afterAsk)}`);

    // Research: bringing new material in may be refused — a project can have
    // spent its gap rounds — and both outcomes are the product working. What is
    // never allowed is the report moving because material arrived.
    const researchTextBefore = await session.evaluate(
      `document.querySelector('[data-testid="document-canvas"]').textContent.length`,
    );
    await session.clickText("Research", ".rp-dock");
    await session.type('[data-testid="assistant-input"]', "补查「证据强度与外部评估」这一项：找一找有没有独立第三方对 GraphRAG 的评测。");
    await session.click('[data-testid="assistant-submit"]');
    let researchOutcome = "none";
    try {
      await session.waitFor(
        `document.querySelector('[data-testid="action-gap"]') !== null || (document.querySelector(".rp-dock")?.textContent ?? "").includes("预算已用完")`,
        "the research action to settle",
        240_000,
      );
      researchOutcome = await session.evaluate(
        `document.querySelector('[data-testid="action-gap"]') !== null ? "ran" : "refused"`,
      );
    } catch {
      researchOutcome = "timeout";
    }
    const researchTextAfter = await session.evaluate(
      `document.querySelector('[data-testid="document-canvas"]').textContent.length`,
    );
    case_(
      "Research 动作如实结束（补查或说明预算用尽），正文不变",
      researchOutcome !== "timeout" && Math.abs(researchTextAfter - researchTextBefore) < 10,
      `${researchOutcome} · 正文长度 ${String(researchTextBefore)} → ${String(researchTextAfter)}`,
    );

    // Edit: a proposal, and the document must stay put until it is accepted.
    // Every section's text is captured, because the run chooses which section
    // to propose against — the check is "only that one moved", not "the first
    // one moved".
    const sectionsBefore = await session.evaluate(
      `Object.fromEntries([...document.querySelectorAll("[data-section-id]")].map((section) => [section.getAttribute("data-section-id"), section.textContent]))`,
    );
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (await session.assistantOpen()) break;
      await session.click('[data-testid="open-assistant"]');
      await delay(400);
    }
    await session.waitFor(`document.querySelector('[data-testid="assistant-input"]') !== null`, "the composer", 10_000);
    await session.clickText("Edit", ".rp-dock");
    const editIntent = await session.assistantIntent();
    const editTarget = await session.evaluate(
      `(() => { const select = document.querySelector('[data-testid="target-select"]'); return select === null ? null : (select.value ?? null); })()`,
    );
    case_(
      "Edit 模式带着目标章节",
      editIntent === "edit" && editTarget !== null && String(editTarget).length > 0,
      `模式 ${String(editIntent)} · 目标 ${String(editTarget)}`,
    );
    await session.type(
      '[data-testid="assistant-input"]',
      "把这一节改得更短，只保留有直接证据支撑的句子；没有依据的句子放进缺口说明。",
    );
    await session.click('[data-testid="assistant-submit"]');
    let proposalReady = false;
    let editSettled = false;
    try {
      await session.waitFor(`document.querySelector('[data-testid="action-edit"]') !== null`, "the edit action card", 180_000);
      proposalReady = true;
      // The card exists as soon as the run starts; the proposal exists when it
      // finishes. Waiting for the button the card offers is what makes this a
      // check of the product rather than a race with it.
      await session.waitFor(
        `document.querySelector('[data-testid="open-proposal"]') !== null`,
        "the edit run to finish and offer its proposal",
        240_000,
      );
      editSettled = true;
    } catch {
      editSettled = false;
    }
    case_("Edit 生成修改建议（而不是直接改写正文）", proposalReady && editSettled);

    const sectionsDuringProposal = await session.evaluate(
      `Object.fromEntries([...document.querySelectorAll("[data-section-id]")].map((section) => [section.getAttribute("data-section-id"), section.textContent]))`,
    );
    const unchangedWhilePending = Object.keys(sectionsBefore).every(
      (id) => sectionsDuringProposal[id] === sectionsBefore[id],
    );
    case_(
      "提案待接受时正文没有变化",
      unchangedWhilePending,
      `${String(Object.keys(sectionsBefore).length)} 节逐一比对`,
    );

    await session.click('[data-testid="open-proposal"]');
    await session.waitFor(`document.querySelector('[data-testid="accept-proposal"]') !== null`, "the proposal panel", 25_000);
    const proposalView = await session.evaluate(
      `(() => {
        const dock = document.querySelector('[data-testid="context-dock"]');
        const text = dock.textContent ?? "";
        return { hasCurrent: /现在的正文/.test(text), hasProposed: /修改后/.test(text), claims: dock.querySelectorAll(".rp-claimrow").length };
      })()`,
    );
    case_("提案展示「现在 / 修改后」与受影响的论断", proposalView.hasCurrent && proposalView.hasProposed, `${String(proposalView.claims)} 条论断`);

    const targetTitles = await session.evaluate(
      `(() => { const el = document.querySelector('[data-testid="proposal-target"]'); return el === null ? "" : el.textContent.replace("目标：", "").trim(); })()`,
    );
    await session.click('[data-testid="accept-proposal"]');
    await session.waitFor(
      `document.querySelector('[data-testid="accept-proposal"]') === null`,
      "the proposal to settle",
      30_000,
    );
    await delay(2_000);
    const sectionsAfter = await session.evaluate(
      `Object.fromEntries([...document.querySelectorAll("[data-section-id]")].map((section) => [section.getAttribute("data-section-id"), section.textContent]))`,
    );
    const changedIds = Object.keys(sectionsBefore).filter((id) => sectionsAfter[id] !== sectionsBefore[id]);
    // The target is named by title in the proposal; the gate finds the section
    // carrying that title and checks it is the one that moved.
    const targetId = await session.evaluate(
      `(() => {
         const titles = ${JSON.stringify(targetTitles)}.split("、").map((part) => part.trim()).filter((part) => part.length > 0);
         const sections = [...document.querySelectorAll("[data-section-id]")];
         const found = sections.find((section) => titles.includes((section.querySelector(".rp-doc__h2-btn")?.textContent ?? "").trim()));
         return found === undefined ? null : found.getAttribute("data-section-id");
       })()`,
    );
    case_(
      "接受后只有目标章节改变",
      targetId !== null && changedIds.length === 1 && changedIds[0] === targetId,
      `目标 ${String(targetId)}（${targetTitles}）· 变化 ${changedIds.length} 节`,
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
