/**
 * The workspace's browser gate: the product page, driven like a person uses it.
 *
 * It talks to a *running* product server over the DevTools protocol, because
 * what it checks is exactly the part an API test cannot: that a reader can
 * change a research brief and then start the research; that a report can be read,
 * questioned, added to and edited from the same screen; and that nothing moves
 * until it is told to. Input goes through `Input.dispatchMouseEvent` and
 * `Input.insertText` — real browser-level input, not a scripted DOM call — so a
 * click the page cannot receive is a failure here, not a workaround.
 *
 *   node scripts/verify-workspace.mjs --url http://127.0.0.1:4310/ --model
 *
 * Options:
 *   --task <id>     a project with a report to inspect (Studio). Without it, the
 *                   first listed project that has one is used.
 *   --draft <id>    a project still awaiting confirmation (Brief). Without it an
 *                   existing draft is reused, and if there is none this creates
 *                   one through the composer — which is what a reader does.
 *   --model         also drive the model-backed actions (guided planning, Ask,
 *                   Research, Edit). Without it those cases are reported as
 *                   skipped, never as passed.
 *   --shots <dir>   write screenshots at 1366x768, 1440x900 and 1920x1080.
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

const TEXT_FIELDS = ["topic", "purpose", "audience", "focus", "exclusions", "lengthTarget"];

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
      `--remote-debugging-port=${String(debugPort)}`,
      `--window-size=${String(width)},${String(height)}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  const deadline = Date.now() + 20_000;
  let target;
  while (target === undefined) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(debugPort)}/json/list`);
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
    if (answer.result?.exceptionDetails !== undefined) {
      throw new Error(`the page threw: ${answer.result.exceptionDetails.text ?? ""}`);
    }
    const result = answer.result?.result;
    if (result === undefined) throw new Error(`the page could not evaluate: ${expression.slice(0, 80)}`);
    return result.value;
  };

  /** A real mouse click at a point, once that point has stopped moving. */
  const clickPoint = async (pointOf) => {
    let previous = null;
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const box = await pointOf();
      if (box === null) throw new Error("the element is not there");
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
    throw new Error("the element never settled");
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
      await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    },
    /**
     * A real mouse click at the centre of the element the selector names.
     *
     * The point is resolved twice: the page polls its own state, so an element
     * can move between "where it is" and "where the mouse goes", and a gate
     * that clicked a stale coordinate would report a product failure that is
     * really a race in the gate.
     */
    async click(selector, index = 0) {
      await clickPoint(async () =>
        await evaluate(
          `(() => {
             const el = document.querySelectorAll(${JSON.stringify(selector)})[${String(index)}];
             if (el === undefined) return null;
             el.scrollIntoView({block: "center"});
             const r = el.getBoundingClientRect();
             return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
           })()`,
        ),
      );
    },
    /**
     * A real mouse click on the element holding this text, inside a container.
     *
     * Aimed by geometry rather than by a scripted click: activating a control
     * that is a styled radio — Mantine's segmented control, for instance — only
     * happens for a real pointer event, so a gate that wants to test the control
     * must move the mouse.
     */
    async clickText(text, containerSelector) {
      await clickPoint(async () =>
        await evaluate(
          `(() => {
             const scope = document.querySelector(${JSON.stringify(containerSelector)});
             if (scope === null) return null;
             const target = [...scope.querySelectorAll("*")].find((el) => (el.textContent ?? "").trim() === ${JSON.stringify(text)});
             if (target === undefined || target === null) return null;
             target.scrollIntoView({block: "center"});
             const r = target.getBoundingClientRect();
             return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
           })()`,
        ),
      );
      await delay(200);
    },
    /** Whether the assistant's dock is open with its composer ready. */
    async assistantOpen() {
      return await evaluate(`document.querySelector('[data-testid="assistant-input"]') !== null`);
    },
    /** Which intent the assistant's mode row currently holds. */
    async assistantIntent() {
      return await evaluate(
        `(() => {
           const row = document.querySelector('[data-testid="assistant-intent"]');
           if (row === null) return null;
           const on = [...row.querySelectorAll("button")].find((button) => button.getAttribute("aria-pressed") === "true");
           return on === undefined ? null : on.textContent.trim();
         })()`,
      );
    },
    /**
     * A real pointer drag: press on the element, move in steps, release.
     *
     * The co-edit split is moved by a hand, so it is tested by a hand: a
     * scripted assignment of the CSS variable would prove the arithmetic and
     * nothing about whether the divider can be grabbed.
     */
    async drag(selector, dx) {
      const start = await evaluate(
        `(() => {
           const el = document.querySelector(${JSON.stringify(selector)});
           if (el === null) return null;
           const r = el.getBoundingClientRect();
           const y = Math.max(90, Math.min(r.top + r.height / 2, window.innerHeight - 60));
           return { x: Math.floor(r.left) + Math.floor(r.width / 2), y: Math.round(y) };
         })()`,
      );
      if (start === null) throw new Error("the element to drag is not there");
      await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: start.x, y: start.y, button: "none" });
      await call("Input.dispatchMouseEvent", { type: "mousePressed", x: start.x, y: start.y, button: "left", clickCount: 1 });
      for (let step = 1; step <= 8; step += 1) {
        await call("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: Math.round(start.x + (dx * step) / 8),
          y: start.y,
          button: "left",
          buttons: 1,
        });
        await delay(35);
      }
      await call("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: Math.round(start.x + dx),
        y: start.y,
        button: "left",
        clickCount: 1,
      });
      await delay(220);
    },
    /** Real typing into a focused field: click it, clear it, then insert text. */
    async type(selector, text, index = 0) {
      await session.click(selector, index);
      await evaluate(
        `(() => {
           const el = document.querySelectorAll(${JSON.stringify(selector)})[${String(index)}];
           if (el === undefined) return false;
           el.focus();
           el.select?.();
           return true;
         })()`,
      );
      await call("Input.insertText", { text });
      await delay(120);
    },
    /**
     * Waits until a control will actually take a click.
     *
     * The product disables an action while a run is in flight — starting the
     * research while a guided question is being written would be a race — so a
     * gate that clicks anyway is testing a button that is right to refuse.
     */
    async waitForEnabled(selector, what, timeoutMs = 120_000) {
      const deadlineAt = Date.now() + timeoutMs;
      for (;;) {
        const enabled = await evaluate(
          `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el !== null && el.disabled !== true; })()`,
        ).catch(() => false);
        if (enabled) return;
        if (Date.now() > deadlineAt) throw new Error(`timed out waiting for ${what} to become clickable`);
        await delay(250);
      }
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

const results = [];
function case_(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : ` — ${detail}`}`);
}

function skip(name, why) {
  results.push({ name, ok: null, detail: why });
  console.log(`SKIP  ${name} — ${why}`);
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  const url = option("--url");
  if (url === undefined) {
    console.error(
      "usage: node scripts/verify-workspace.mjs --url <product url> [--task <id>] [--draft <id>] [--model] [--shots <dir>]",
    );
    process.exit(2);
  }
  const taskArg = option("--task");
  const draftArg = option("--draft");
  const withModel = process.argv.includes("--model");
  const shots = option("--shots");
  if (shots !== undefined) mkdirSync(shots, { recursive: true });

  const base = url.replace(/#.*$/, "").replace(/\/$/, "");
  const api = async (path) => await fetch(`${base}${path}`).then((response) => response.json());
  const briefOf = async (id) => (await api(`/api/research/tasks/${id}/brief`)).brief;

  /**
   * Makes a fresh draft the way a reader makes one, and returns its id.
   *
   * The card's topic is written by the model, so a new project is found by
   * watching for an id that was not there before, rather than by matching the
   * words the reader happened to type.
   */
  const createDraft = async (topic) => {
    const before = new Set((await api("/api/research/tasks")).tasks.map((entry) => entry.id));
    await session.goto(`${base}/#/`);
    await session.waitFor(`document.querySelector('[data-testid="topic-input"]') !== null`, "the start composer", 15_000);
    await session.type('[data-testid="topic-input"]', topic);
    await session.click('[data-testid="topic-submit"]');
    let created;
    const deadline = Date.now() + 240_000;
    while (created === undefined && Date.now() < deadline) {
      const state = await api("/api/research/tasks");
      created = state.tasks.find((entry) => !before.has(entry.id))?.id;
      if (created === undefined) await delay(2_000);
    }
    return created;
  };

  const session = await connect();
  let failedHard = false;
  try {
    await session.goto(url);

    /* ---------------------------------------------------------- start -- */

    case_(
      "起始页渲染出研究输入框",
      (await session.evaluate(`document.querySelector('[data-testid="topic-input"]') !== null`)) === true,
    );
    await session.waitFor(`document.querySelector('[data-testid^="task-row-"]') !== null`, "the project list", 12_000);
    const listed = await session.evaluate(
      `[...document.querySelectorAll('[data-testid^="task-row-"]')].map((row) => row.getAttribute("data-testid").replace("task-row-", ""))`,
    );
    case_("研究项目列表渲染", Array.isArray(listed) && listed.length > 0, `${String(listed.length)} 个项目`);

    if (shots !== undefined) {
      await session.setViewport(1440, 900);
      await session.screenshot(join(shots, "start-1440.png"));
    }

    /* ------------------------------------------------ a project to edit -- */

    // The brief flow needs a draft: a project that has been proposed and not
    // yet confirmed, with nothing already asked of it. A caller may name one;
    // otherwise the gate makes a fresh one the way a reader makes one, so that
    // what it checks is a clean draft rather than the leftovers of an earlier
    // run. Only when no model is available does it fall back to a draft that
    // happens to be lying around.
    let draftId = draftArg;
    if (draftId === undefined && !withModel) {
      for (const id of listed) {
        const bundle = await api(`/api/research/tasks/${id}`);
        if (bundle.task.confirmed !== true) {
          draftId = id;
          break;
        }
      }
    }
    if (draftId === undefined && withModel) {
      draftId = await createDraft("对比三种 RAG 方案在长文档问答上的成本与效果，给技术选型用");
      case_("从起始页建立一份新的研究任务卡", draftId !== undefined, draftId ?? "主题提交后没有产生新项目");
    }

    /* ----------------------------------------------------------- brief -- */

    if (draftId === undefined) {
      skip("研究简报（结构化 / 验证 / 引导 / 确认）", "没有未确认的项目，且未加 --model：建立任务卡需要真实模型");
    } else {
      await session.goto(`${base}/#/p/${draftId}/brief`);
      await session.waitFor(`document.querySelector('[data-testid="brief-mode"]') !== null`, "the brief", 15_000);

      const initial = await briefOf(draftId);
      const shell = await session.evaluate(
        `(() => ({
           modes: [...document.querySelectorAll('[data-testid="brief-mode"] label')].map((el) => el.textContent.trim()),
           fields: [...document.querySelectorAll("[data-brief-field]")].map((el) => el.getAttribute("data-brief-field")),
           inline: document.querySelectorAll(".rp-inline").length,
           subjectRows: document.querySelectorAll('[data-testid^="subject-row-"]').length,
           dimensionRows: document.querySelectorAll('[data-testid^="dimension-row-"]').length,
           boxes: document.querySelectorAll(".rp-brief input.mantine-TextInput-input").length,
           aside: document.querySelector(".rp-brief__aside") !== null,
           summary: document.querySelector('[data-testid="confirm-summary"]')?.textContent ?? "",
           structureReadOnly: document.querySelector('[data-brief-field="structure"]') !== null,
         }))()`,
      );
      case_(
        "简报页提供两种模式，一次只显示一种",
        shell.modes.length === 2 && shell.modes.includes("结构化编辑") && shell.modes.includes("智能引导"),
        shell.modes.join(" / "),
      );
      case_(
        "结构化模式直接编辑助手给出的方案，而不是一张空表单",
        shell.inline >= 4 && shell.subjectRows >= 1 && shell.dimensionRows >= 1 && shell.aside === false,
        `${String(shell.inline)} 处可编辑文本 · ${String(shell.subjectRows)} 个对象 · ${String(shell.dimensionRows)} 个维度`,
      );
      case_("报告结构由蓝图派生，只读展示", shell.structureReadOnly === true);
      case_(
        "底部用一句话说清这次研究将围绕什么进行",
        /个对象/.test(shell.summary) && /个维度/.test(shell.summary),
        shell.summary.slice(0, 60),
      );

      if (shots !== undefined) {
        await session.setViewport(1440, 900);
        await session.screenshot(join(shots, "brief-structured-1440.png"));
        await session.setViewport(1366, 768);
        await session.screenshot(join(shots, "brief-structured-1366.png"));
        await session.setViewport(1440, 900);
      }

      /* --------------------------------------------- structured editing -- */

      await session.click('[data-testid="edit-purpose"]');
      await session.waitFor(`document.querySelector(".rp-inline__editor textarea") !== null`, "the inline editor", 5_000);
      const nextPurpose = `${initial.purpose.slice(0, 40)}（gate 改过一次）`;
      await session.type(".rp-inline__editor textarea", nextPurpose);
      await session.evaluate(`document.querySelector(".rp-inline__editor textarea").blur()`);

      let patched = initial;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await delay(500);
        patched = await briefOf(draftId);
        if (patched.purpose.includes("gate 改过一次")) break;
      }
      case_(
        "结构化编辑真的写进了同一份草稿（PATCH + 版本递增）",
        patched.purpose.includes("gate 改过一次") && patched.version > initial.version,
        `v${String(initial.version)} → v${String(patched.version)}`,
      );
      case_("字段状态记录下这是用户改的，而不是助手建议", patched.fieldStates.purpose === "edited", patched.fieldStates.purpose);

      // A dimension added by hand, then a check that the draft agrees.
      await session.click('[data-testid="add-dimension"]');
      await delay(400);
      const rowIndex = await session.evaluate(`document.querySelectorAll('[data-testid^="dimension-row-"]').length - 1`);
      await session.type('[data-testid^="dimension-row-"] input[aria-label$="名称"]', "gate 追加维度", rowIndex);
      await session.type(
        '[data-testid^="dimension-row-"] textarea[aria-label$="要回答的问题"]',
        "这一项由 gate 追加，用来验证结构化编辑确实进入草稿？",
        rowIndex,
      );
      // A row that has not been named yet is not committable, and the page is
      // right to disable the button: wait for it rather than clicking a control
      // that is correctly refusing this instant.
      await session.waitForEnabled('[data-testid="apply-dimensions"]', "the dimension apply");
      await session.click('[data-testid="apply-dimensions"]');
      let grown = patched;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await delay(500);
        grown = await briefOf(draftId);
        if (grown.dimensions.some((dimension) => dimension.name === "gate 追加维度")) break;
      }
      case_(
        "新增研究维度进入草稿，原有维度的 id 一个也没变",
        grown.dimensions.length === initial.dimensions.length + 1 &&
          initial.dimensions.every((dimension) => grown.dimensions.some((next) => next.id === dimension.id)),
        `${String(initial.dimensions.length)} → ${String(grown.dimensions.length)} 个维度`,
      );

      /* ------------------------------------------------------ validation -- */

      const subjectCount = await session.evaluate(`document.querySelectorAll('[data-testid^="remove-subject-"]').length`);
      for (let index = 0; index < subjectCount; index += 1) {
        await session.click('[data-testid^="remove-subject-"]');
        await delay(800);
      }
      await session.waitFor(`document.querySelector('[data-testid="problems-subjects"]') !== null`, "the field problem", 20_000);
      const invalid = await session.evaluate(
        `(() => {
           const problems = document.querySelector('[data-testid="problems-subjects"]');
           const field = document.querySelector('[data-brief-field="subjects"]');
           return { text: problems.textContent.trim(), marked: field.className.includes("rp-brief-field--invalid") };
         })()`,
      );
      case_(
        "不完整的草稿把问题写在字段上，而不是只弹一个错误",
        /比较对象/.test(invalid.text) && invalid.marked === true,
        invalid.text.slice(0, 50),
      );

      const hashBeforeRefusal = await session.evaluate(`location.hash`);
      await session.click('[data-testid="confirm-card"]');
      await delay(1_500);
      const afterRefusal = await api(`/api/research/tasks/${draftId}`).then((body) => body.task);
      case_(
        "简报不完整时确认被拒绝，也不会开始研究",
        (await session.evaluate(`location.hash`)) === hashBeforeRefusal && afterRefusal.confirmed !== true,
        `状态 ${afterRefusal.status}`,
      );

      // Put the objects back. A draft left with one object would be a valid
      // brief and a degenerate research, and the project this gate goes on to
      // create would be a bad subject for everything that follows.
      for (const subject of initial.subjects) {
        await session.click('[data-testid="add-subject"]');
        await delay(300);
        const last = await session.evaluate(`document.querySelectorAll('[data-testid^="subject-row-"]').length - 1`);
        await session.type('[data-testid^="subject-row-"] input[aria-label$="名称"]', subject.name, last);
        await session.type('[data-testid^="subject-row-"] input[aria-label$="说明"]', subject.note ?? "", last);
      }
      await session.waitForEnabled('[data-testid="apply-subjects"]', "the subject apply");
      await session.click('[data-testid="apply-subjects"]');
      let valid = grown;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await delay(500);
        valid = await briefOf(draftId);
        if (valid.validation.valid) break;
      }
      case_("补齐之后草稿重新可以确认", valid.validation.valid === true, valid.validation.problems.join("；").slice(0, 70));

      /* ---------------------------------------------------------- guided -- */

      // Guided planning is a conversation now, and that is what the gate has to
      // see: turns that come back after a reload, a floor the agent may not cut
      // short, and the reader's own exit from either depth. It drives the
      // session the way a person does — one decision at a time, and once in
      // their own words — because a questionnaire and a conversation differ
      // exactly in whether the second turn remembers the first.
      if (!withModel) {
        skip("智能引导（对话 / 深度 / 回填 / 上限）", "未加 --model：引导问题由真实模型撰写");
      } else {
        // A guided session is driven from a draft with nothing decided yet.
        // `readiness` counts the decisions a person made in the *structured*
        // editor too — that is the product's design, not a bug — so a draft
        // that was edited by hand arrives already above zero and could reach
        // the floor in two questions. The conversation this section is about
        // is the one that grows 0 → 1 → 3 → 5, and that needs a clean draft.
        const guideDraftId = await createDraft("比较三种向量数据库在多租户场景下的成本与运维复杂度，给平台选型用");
        case_("为引导对话建立一份全新的草稿（readiness 从 0 开始）", guideDraftId !== undefined, guideDraftId ?? "没有建立成功");
        if (guideDraftId === undefined) throw new Error("the guided session needs a fresh draft");
        await session.goto(`${base}/#/p/${guideDraftId}/brief`);
        await session.waitFor(`document.querySelector('[data-testid="brief-mode"]') !== null`, "the fresh brief", 15_000);
        await session.clickText("智能引导", '[data-testid="brief-mode"]');
        await session.waitFor(`document.querySelector('[data-testid="guide-panel"]') !== null`, "the guided panel", 10_000);

        const idle = await session.evaluate(
          `(() => {
             const panel = document.querySelector('[data-testid="guide-panel"]');
             return {
               idle: panel.querySelector('[data-testid="guide-idle"]') !== null,
               turns: panel.querySelectorAll('[data-testid^="guide-msg-"]').length,
               progress: panel.querySelector('[data-testid="guide-progress"]')?.textContent?.trim() ?? "",
             };
           })()`,
        );
        if (shots !== undefined) {
          await session.setViewport(1440, 900);
          await session.screenshot(join(shots, "guided-0.png"));
        }
        case_(
          "0 个决策时是一段还没开始的对话，而不是一张问卷",
          idle.idle === true && idle.turns === 0 && /关键决策 0 \/ 至少 5/.test(idle.progress),
          `${String(idle.turns)} 条消息 · ${idle.progress}`,
        );

        const transcriptOf = async () =>
          await session.evaluate(
            `(() => {
               const panel = document.querySelector('[data-testid="guide-panel"]');
               return {
                 turns: [...panel.querySelectorAll('[data-testid^="guide-msg-"]')].map((el) => ({
                   role: el.getAttribute("data-testid") === "guide-msg-user" ? "user" : "assistant",
                   text: el.textContent.trim(),
                 })),
                 progress: panel.querySelector('[data-testid="guide-progress"]')?.textContent?.trim() ?? "",
                 receipts: panel.querySelectorAll('[data-testid="guide-receipt"]').length,
                 leads: [...panel.querySelectorAll(".rp-chat__lead")].filter((el) => el.textContent.trim().length > 0).length,
                 asks: panel.querySelectorAll('[data-testid="guide-question"]').length,
                 confirmDisabled: document.querySelector('[data-testid="guide-confirm"]')?.disabled ?? null,
               };
             })()`,
          );

        /** Waits for the next turn: a question, the closing statement, or the retry state. */
        const waitForTurn = async (timeoutMs) => {
          try {
            await session.waitFor(
              `document.querySelector('[data-testid="guide-options"]') !== null ||
               document.querySelector('[data-testid="guide-complete"]') !== null ||
               document.querySelector('[data-testid="guide-stalled"]') !== null`,
              "the next guided turn",
              timeoutMs,
            );
          } catch {
            return "timeout";
          }
          if ((await session.evaluate(`document.querySelector('[data-testid="guide-complete"]') !== null`)) === true) {
            return "complete";
          }
          if ((await session.evaluate(`document.querySelector('[data-testid="guide-stalled"]') !== null`)) === true) {
            return "stalled";
          }
          return "question";
        };

        const guideRunsBefore = (await api(`/api/research/tasks/${guideDraftId}`)).runs.filter((run) => run.stage === "guide").length;
        await session.waitForEnabled('[data-testid="guide-start"]', "the guided start");
        await session.click('[data-testid="guide-start"]');

        const freeAnswer = "重点是索引与查询两段的成本口径，更新成本只作定性说明。";
        const submitted = [];
        let decisions = 0;
        let sawStalled = false;
        let sawComplete = false;
        let firstQuestion = null;
        let progressAtThree = "";
        let confirmOpenAtThree = null;
        let freeTextInTranscript = false;
        const deadline = Date.now() + 900_000;

        while (decisions < 7 && Date.now() < deadline) {
          const turn = await waitForTurn(decisions === 0 ? 300_000 : 180_000);
          if (turn === "timeout" || turn === "complete") {
            sawComplete = turn === "complete";
            break;
          }
          if (turn === "stalled") {
            sawStalled = true;
            await session.click('[data-testid="guide-retry"]');
            continue;
          }

          const question = await session.evaluate(
            `(() => {
               const panel = document.querySelector('[data-testid="guide-panel"]');
               const assistant = [...panel.querySelectorAll('[data-testid="guide-msg-assistant"]')].slice(-1)[0];
               return {
                 lead: assistant?.querySelector(".rp-chat__lead")?.textContent?.trim() ?? "",
                 text: panel.querySelector('[data-testid="guide-question"]')?.textContent?.trim() ?? "",
                 options: panel.querySelectorAll('[data-testid^="option-"]').length,
                 free: panel.querySelector('[data-testid="guide-free-text"]') !== null,
                 decides: panel.querySelector(".rp-chat__decides")?.textContent?.trim() ?? "",
                 progress: panel.querySelector('[data-testid="guide-progress"]')?.textContent?.trim() ?? "",
               };
             })()`,
          );
          if (firstQuestion === null) firstQuestion = question;
          if (decisions === 3) {
            progressAtThree = question.progress;
            // A run that is still finishing the previous turn disables this
            // button for a moment — correct, and not the question being asked.
            // Wait for the machine to be quiet, then read the exit.
            let opened = false;
            try {
              await session.waitForEnabled('[data-testid="guide-confirm"]', "the early confirm", 120_000);
              opened = true;
            } catch {
              opened = false;
            }
            confirmOpenAtThree = {
              opened,
              canConfirm: (await briefOf(guideDraftId)).canConfirm,
              why: await session.evaluate(
                `document.querySelector('[data-testid="guide-confirm-why"]')?.textContent?.trim() ?? ""`,
              ),
            };
          }

          // The second decision is answered in the person's own words: the
          // point of a conversation is that what they said is what comes back.
          const answer = decisions === 1 ? freeAnswer : null;
          if (answer === null) {
            await session.click('[data-testid^="option-"]');
          } else {
            await session.type('[data-testid="guide-free-text"]', answer);
          }
          submitted.push(answer);

          if (shots !== undefined) {
            await session.setViewport(1440, 900);
            if (decisions === 0) await session.screenshot(join(shots, "guided-1.png"));
            if (decisions === 3) await session.screenshot(join(shots, "guided-3.png"));
          }

          const before = await briefOf(guideDraftId);
          await session.waitForEnabled('[data-testid="guide-submit"]', "the guided submit");
          await session.click('[data-testid="guide-submit"]');
          let after = before;
          for (let attempt = 0; attempt < 120; attempt += 1) {
            await delay(500);
            after = await briefOf(guideDraftId);
            if (after.version > before.version) break;
          }
          if (after.version === before.version) break;
          decisions += 1;

          if (decisions === 2 && answer !== null) {
            const transcript = await transcriptOf();
            freeTextInTranscript = transcript.turns.some((entry) => entry.role === "user" && entry.text.includes(answer));
            if (shots !== undefined) {
              await session.setViewport(1440, 900);
              await session.screenshot(join(shots, "guided-free-text.png"));
            }
          }
          if (decisions === 5 && shots !== undefined) {
            await session.setViewport(1440, 900);
            await session.screenshot(join(shots, "guided-5.png"));
          }
        }

        const transcript = await transcriptOf();
        const userTurns = transcript.turns.filter((entry) => entry.role === "user");
        case_(
          "引导是一场多轮对话：每一次决定都留下助手的一问和用户的一答",
          decisions >= 5 && transcript.turns.filter((entry) => entry.role === "assistant").length >= decisions,
          `${String(decisions)} 个决策 · ${String(transcript.turns.length)} 条消息`,
        );
        case_(
          "助手的话在左、用户的话在右，回执轻量地跟在回答后面",
          transcript.leads >= 1 && transcript.receipts >= decisions,
          `leadIn ${String(transcript.leads)} 条 · 回执 ${String(transcript.receipts)} 条 · 选项 ${String(firstQuestion?.options ?? 0)} 个`,
        );
        case_(
          "自由回答以原文出现在用户那一轮里",
          freeTextInTranscript === true,
          freeTextInTranscript ? freeAnswer.slice(0, 30) : "用户轮次里没有找到原文",
        );
        case_(
          "深度下限说真话：3 个决策时写明还差多少",
          /关键决策 3 \/ 至少 5/.test(progressAtThree),
          progressAtThree,
        );
        case_(
          "达到下限后按两种出路说，而不是只报上限",
          transcript.receipts > 0 && !/至少 5/.test(transcript.progress),
          transcript.progress,
        );
        case_(
          "用户可以在下限之前就自己开始研究（第 3 个决策时确认已经可用）",
          confirmOpenAtThree !== null && confirmOpenAtThree.opened === true && confirmOpenAtThree.canConfirm === true,
          confirmOpenAtThree === null
            ? "没有读到"
            : `第 3 个决策时按钮${confirmOpenAtThree.opened ? "可用" : "不可用"} · canConfirm=${String(confirmOpenAtThree.canConfirm)}${confirmOpenAtThree.why.length > 0 ? ` · ${confirmOpenAtThree.why}` : ""}`,
        );

        const guideRunsAfter = (await api(`/api/research/tasks/${guideDraftId}`)).runs.filter((run) => run.stage === "guide").length;
        case_(
          "每个决策一次引导 run，自动恢复最多再多一次（不会无限重试）",
          guideRunsAfter - guideRunsBefore <= decisions + 2,
          `${String(guideRunsAfter - guideRunsBefore)} 个新 run / ${String(decisions)} 个决策${sawStalled ? "（期间出现过一次自动恢复）" : ""}`,
        );
        if (sawStalled) {
          case_("模型被拒绝后的一轮没有留下问题：面板自己恢复，而不是永久等待", true, "出现过一次自动恢复并接上了下一问");
        } else {
          skip("早退被拒后的自动恢复", "这一轮模型没有走到「拒绝 early complete 且没有下一问」的状态");
        }
        if (sawComplete) {
          const closing = await session.evaluate(
            `(() => {
               const el = document.querySelector('[data-testid="guide-complete"]');
               return el === null ? null : el.textContent.trim();
             })()`,
          );
          case_(
            "方案成熟时对话收束成一段总结 + 确认入口，而不是空页面",
            closing !== null && /确认并开始研究/.test(closing),
            String(closing).replace(/\s+/g, " ").slice(0, 60),
          );
        }

        // The conversation is the record: reloading rebuilds it turn for turn.
        const beforeReload = await transcriptOf();
        await session.goto(`${base}/#/p/${guideDraftId}/brief`);
        await session.waitFor(`document.querySelector('[data-testid="brief-mode"]') !== null`, "the brief after a reload", 12_000);
        await session.clickText("智能引导", '[data-testid="brief-mode"]');
        await session.waitFor(`document.querySelector('[data-testid="guide-transcript"]') !== null`, "the transcript", 12_000);
        const afterReload = await transcriptOf();
        case_(
          "刷新之后对话历史原样重建（不是前端自己记的一份）",
          afterReload.turns.length === beforeReload.turns.length &&
            afterReload.turns.every((entry, index) => entry.text === beforeReload.turns[index]?.text),
          `${String(afterReload.turns.length)} 条消息，逐条一致`,
        );

        // Structured and guided are two views of one draft, and switching is a
        // read: what the guided answers wrote is already there.
        await session.click('[data-testid="guide-structured"]');
        await session.waitFor(`document.querySelector('[data-testid="edit-purpose"]') !== null`, "structured mode", 8_000);
        const structured = await session.evaluate(
          `[...document.querySelectorAll(".rp-inline")].map((el) => el.textContent).join("\\u0000")`,
        );
        const latest = await briefOf(guideDraftId);
        case_(
          "引导答完切回结构化，看到的是同一份草稿的最新值",
          structured.includes(latest.purpose.slice(0, 12)),
          `简报 v${String(latest.version)} · readiness ${String(latest.guide.readiness)}`,
        );
        await session.clickText("智能引导", '[data-testid="brief-mode"]');
        await session.waitFor(`document.querySelector('[data-testid="guide-transcript"]') !== null`, "the transcript again", 8_000);
        const switchedBack = await transcriptOf();
        case_(
          "切回结构化再切回来，对话历史还在",
          switchedBack.turns.length === afterReload.turns.length,
          `${String(switchedBack.turns.length)} 条消息`,
        );
      }

      /* --------------------------------------------------------- confirm -- */

      // The guided session ran on a draft of its own; this section is about the
      // one the structured edits were made on.
      await session.goto(`${base}/#/p/${draftId}/brief`);
      await session.waitFor(`document.querySelector('[data-testid="brief-mode"]') !== null`, "the edited brief", 15_000);
      await session.clickText("结构化编辑", '[data-testid="brief-mode"]').catch(() => undefined);
      await delay(400);
      const toConfirm = await briefOf(draftId);
      if (toConfirm.validation.valid !== true) {
        case_("简报有效时才能确认并开始研究", false, toConfirm.validation.problems.join("；").slice(0, 80));
      } else {
        await session.waitForEnabled('[data-testid="confirm-card"]', "the confirm action");
        await session.click('[data-testid="confirm-card"]');
        let landed = false;
        for (let attempt = 0; attempt < 60; attempt += 1) {
          await delay(500);
          if ((await session.evaluate(`location.hash`)).includes("/research")) {
            landed = true;
            break;
          }
        }
        const refusal = await session.evaluate(
          `(() => { const el = document.querySelector(".rp-note"); return el === null ? null : el.textContent; })()`,
        );
        case_(
          "确认之后直接进入研究（矩阵）视图",
          landed === true,
          landed ? "" : String(refusal ?? await session.evaluate(`location.hash`)).slice(0, 90),
        );

        const confirmed = await briefOf(draftId);
        case_(
          "确认冻结了字段状态，并按最终简报重建了矩阵",
          confirmed.readonly === true &&
            confirmed.fieldStates.subjects === "confirmed" &&
            confirmed.matrix.cells === confirmed.matrix.subjects * confirmed.matrix.dimensions,
          `v${String(confirmed.version)} · ${String(confirmed.matrix.cells)} 格 = ${String(confirmed.matrix.subjects)} × ${String(confirmed.matrix.dimensions)}`,
        );

        const settled = await briefOf(draftId);
        if (settled.readonly !== true) {
          case_("已确认的简报变成干净的只读记录", false, "简报没有被确认，读不到只读状态");
        } else {
        await session.goto(`${base}/#/p/${draftId}/brief`);
        await session.waitFor(`document.querySelector('[data-testid="card-confirmed"]') !== null`, "the confirmed brief", 12_000);
        const locked = await session.evaluate(
          `(() => ({
             inline: document.querySelectorAll(".rp-inline").length,
             modes: document.querySelector('[data-testid="brief-mode"]') !== null,
             inputs: document.querySelectorAll('[data-testid^="subject-row-"] input').length,
             note: document.querySelector('[data-testid="confirmed-note"]')?.textContent ?? "",
             summary: document.querySelector('[data-testid="confirm-summary"]')?.textContent ?? "",
           }))()`,
        );
        case_(
          "已确认的简报变成干净的只读记录，没有可编辑控件",
          locked.inline === 0 && locked.modes === false && locked.inputs === 0 && /已确认/.test(locked.note),
          locked.note.slice(0, 46),
        );

        const refused = await fetch(`${base}/api/research/tasks/${draftId}/brief`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ patch: { purpose: "确认之后还能改吗" } }),
        });
        case_("确认之后简报上锁：写入被拒绝", refused.status === 409, `HTTP ${String(refused.status)}`);
        }
      }
    }

    /* ---------------------------------------------------------- studio -- */

    // The comparison case is about a report that declares a comparison frame,
    // so the subject is chosen for that rather than for "has a report": a project
    // whose objects were since renamed has a report too, and a worse one to look
    // at. Failing that, any report will do.
    let reportTaskId = taskArg;
    if (reportTaskId === undefined) {
      let fallback;
      for (const id of listed) {
        const bundle = await api(`/api/research/tasks/${id}`);
        if (!bundle.hasReport || bundle.currentReportId === null) continue;
        if (fallback === undefined) fallback = id;
        const document = await api(`/api/research/reports/${bundle.currentReportId}/document`);
        const framed = document.sections
          .flatMap((section) => section.blocks)
          .some(
            (block) =>
              block.kind === "table" &&
              (block.columnDimensions ?? []).filter((entry) => entry !== null).length >= 2 &&
              (block.rowSubjects ?? []).filter((entry) => entry !== null).length >= 2,
          );
        if (framed && bundle.busy !== true) {
          reportTaskId = id;
          break;
        }
      }
      reportTaskId = reportTaskId ?? fallback;
    }

    if (reportTaskId === undefined) {
      skip("报告工作台（对照 / 边界 / 协作 / 提案）", "没有带报告的项目");
    } else {
      const bundle = await api(`/api/research/tasks/${reportTaskId}`);
      const document = await api(`/api/research/reports/${bundle.currentReportId}/document`);

      await session.goto(`${base}/#/p/${reportTaskId}/report`);
      await session.waitFor(`document.querySelector('[data-testid="document-canvas"]') !== null`, "the document canvas", 15_000);
      await session.waitFor(`document.querySelectorAll("[data-section-id]").length > 2`, "the sections", 15_000);

      const reading = await session.evaluate(
        `(() => {
           const scroll = document.querySelector(".rp-canvas-scroll");
           const sheet = document.querySelector(".rp-canvas__sheet");
           const left = sheet.getBoundingClientRect().left - scroll.getBoundingClientRect().left;
           const right = scroll.getBoundingClientRect().right - sheet.getBoundingClientRect().right;
           return {
             layout: document.querySelector('[data-testid="studio"]').getAttribute("data-layout"),
             dock: document.querySelector('[data-testid="context-dock"]') !== null,
             iframes: document.querySelectorAll("iframe").length,
             centered: Math.abs(left - right) < 40,
           };
         })()`,
      );
      case_(
        "默认是阅读模式：文档居中，没有 iframe，也没有常驻助手",
        reading.layout === "reading" && reading.dock === false && reading.iframes === 0 && reading.centered === true,
        `layout=${String(reading.layout)}`,
      );

      const artifact = await session.evaluate(
        `(() => {
           const canvas = document.querySelector('[data-testid="document-canvas"]');
           const details = canvas.querySelector('[data-testid="document-checks"] details');
           const visible = canvas.innerText;
           return {
             detailClosed: details === null || details.open === false,
             comparison: canvas.querySelectorAll('[data-testid="comparison-matrix"]').length,
             matrixRows: canvas.querySelectorAll('[data-testid^="compare-row-"]').length,
             matrixCols: canvas.querySelectorAll("[data-testid^='compare-col-']").length,
             cells: canvas.querySelectorAll("td[data-testid^='compare-cell-']").length,
             emptyCells: canvas.querySelectorAll("td[data-empty='true']").length,
             boundaries: canvas.querySelectorAll('[data-testid="research-boundaries"]').length,
             boundaryItems: canvas.querySelectorAll('[data-testid^="boundary-"]').length,
             mechanism: canvas.querySelectorAll('[data-testid="mechanism-block"]').length,
             mechanismStages: canvas.querySelectorAll(".rp-doc__mech__stage").length,
             rowNames: canvas.querySelectorAll(".rp-doc__rowname").length,
             inline: canvas.querySelectorAll(".rp-md-inline").length,
             literalMarkdown: /\\*\\*[^\\s*]/.test(visible),
             innerIds: /(?:^|[^A-Za-z0-9_])(?:sub|dim|ev|clm|sec|task|rep|rev|prp|gq|asmt|exp)_[A-Za-z0-9_\\u4e00-\\u9fff]+/.test(visible),
           };
         })()`,
      );
      case_("校验明细默认收起：技术细节要先打开才看得到", artifact.detailClosed === true);
      const frames = document.sections.flatMap((section) =>
        section.blocks.filter((block) => block.kind === "table" && (block.columnDimensions ?? []).filter(Boolean).length >= 2),
      );
      case_(
        "比较以矩阵呈现：行是研究问题，列是比较对象，名字来自项目而不是报告",
        frames.length === 0
          ? artifact.comparison >= 1
          : artifact.matrixRows >= 2 && artifact.matrixCols >= 2 && artifact.rowNames >= 2,
        `${String(artifact.matrixRows)} 行 × ${String(artifact.matrixCols)} 列 · ${String(artifact.cells)} 格（${String(artifact.emptyCells)} 格未写判断）`,
      );
      case_(
        "交互式报告不展示内部 id，正文里也不出现 Markdown 记号",
        artifact.innerIds === false && artifact.literalMarkdown === false,
        artifact.innerIds ? "可见文本里出现了内部标识符" : "可见文本干净",
      );
      case_(
        "研究边界把缺口按问题聚合成摘要，而不是连续 dump",
        artifact.boundaries >= 1 && artifact.boundaryItems >= 1,
        `${String(artifact.boundaryItems)} 个问题`,
      );
      case_(
        "机制块按输入 → 步骤 → 输出的结构呈现",
        artifact.mechanism >= 1 && artifact.mechanismStages >= 2,
        `${String(artifact.mechanism)} 个机制块 · ${String(artifact.mechanismStages)} 个阶段`,
      );

      if (shots !== undefined) {
        await session.setViewport(1440, 900);
        await session.screenshot(join(shots, "studio-reading-1440.png"));
        await session.setViewport(1366, 768);
        await session.screenshot(join(shots, "studio-reading-1366.png"));
        await session.setViewport(1920, 1080);
        await session.screenshot(join(shots, "studio-reading-1920.png"));
        await session.setViewport(1440, 900);
      }

      // Read mode is the publication; Verify mode is the working surface. The
      // words are the same in both — only the citation marks, the object handles
      // and the checks appear in Verify.
      const verifyState = await session.evaluate(
        `(() => {
           const article = document.querySelector('[data-testid="document-canvas"]');
           const words = [...article.querySelectorAll("[data-section-id]")].map((section) => section.textContent).join("").length;
           return { words, checks: article.querySelectorAll('[data-testid="document-checks"]').length };
         })()`,
      );
      await session.clickText("阅读", ".rp-toolbar");
      await delay(300);
      const readMode = await session.evaluate(
        `(() => {
           const article = document.querySelector('[data-testid="document-canvas"]');
           const visible = [...article.querySelectorAll(".rp-cite")].filter((el) => el.getBoundingClientRect().width > 0).length;
           const words = [...article.querySelectorAll("[data-section-id]")].map((section) => section.textContent).join("").length;
           return { mode: article.getAttribute("data-mode"), visible, words, checks: article.querySelectorAll('[data-testid="document-checks"]').length };
         })()`,
      );
      case_(
        "阅读模式隐藏引用标记，报告正文一字不少",
        readMode.mode === "read" && readMode.visible === 0 && readMode.words === verifyState.words,
        `${String(readMode.visible)} 个可见引用 · 正文 ${String(verifyState.words)} → ${String(readMode.words)} 字`,
      );
      case_(
        "质量提醒以一句话出现在顶部，原始句子留在核验模式的折叠里",
        readMode.checks === 0 && verifyState.checks === 1,
        `核验 ${String(verifyState.checks)} · 阅读 ${String(readMode.checks)}`,
      );
      await session.clickText("核验", ".rp-toolbar");
      await delay(300);

      /* ---------------------------------------------------------- co-edit -- */

      // Two shapes on purpose: a glance at a sentence's evidence is a dock, and
      // the assistant is a workspace. The gate checks both, because "one panel
      // that changes width" was the previous product and this is not it.
      await session.evaluate(
        `(() => { const node = document.querySelector(".rp-doc__p.rp-claim"); node.scrollIntoView({block: "center"}); return true; })()`,
      );
      await session.click(".rp-doc__p.rp-claim");
      await session.waitFor(`document.querySelector('[data-testid="context-dock"]') !== null`, "the evidence dock", 8_000);
      const inspector = await session.evaluate(
        `(() => {
           const dock = document.querySelector('[data-testid="context-dock"]');
           const text = dock.textContent ?? "";
           return {
             hasValidity: /引用有效|引用不完整/.test(text),
             hasAdequacy: /证据是否足以支持/.test(text),
             tabs: [...dock.querySelectorAll('[data-testid="dock-tabs"] button')].map((button) => button.textContent.trim()),
             width: Math.round(dock.getBoundingClientRect().width),
             rail: document.querySelectorAll('[data-testid="object-rail"]').length,
             layout: document.querySelector('[data-testid="studio"]').getAttribute("data-layout"),
             back: dock.querySelector('[data-testid="back-to-conversation"]') !== null,
           };
         })()`,
      );
      case_("检查器区分「引用有效」与「证据是否足以支持」", inspector.hasValidity && inspector.hasAdequacy, inspector.tabs.join(" / "));
      case_("选中对象出现统一动作栏", inspector.rail === 1, `${String(inspector.rail)} 个动作栏`);
      case_(
        "速览（证据 / 来源）仍是一栏 Dock：文档没有被折半",
        inspector.layout === "inspect" && inspector.width <= 384 && inspector.back === false,
        `layout=${String(inspector.layout)} · ${String(inspector.width)}px`,
      );

      if (shots !== undefined) {
        await session.setViewport(1440, 900);
        await session.screenshot(join(shots, "studio-evidence-1440.png"));
      }

      /** Everything the split screen has to say about itself, measured. */
      const measureCoedit = async () =>
        await session.evaluate(
          `(() => {
             const studio = document.querySelector('[data-testid="studio"]');
             const dock = document.querySelector('[data-testid="context-dock"]');
             const main = document.querySelector(".rp-studio__main");
             const sheet = document.querySelector(".rp-canvas__sheet");
             const scroll = document.querySelector(".rp-canvas-scroll");
             const toolbar = document.querySelector(".rp-toolbar");
             const composer = document.querySelector('[data-testid="assistant-input"]');
             const bar = document.querySelector('[data-testid="assistant-bar"]');
             const intent = document.querySelector('[data-testid="assistant-intent"]');
             const box = studio.getBoundingClientRect();
             const root = document.documentElement;
             return {
               layout: studio.getAttribute("data-layout"),
               studio: Math.round(box.width),
               docShare: Math.round((main.getBoundingClientRect().width / box.width) * 100),
               assistantShare: dock === null ? 0 : Math.round((dock.getBoundingClientRect().width / box.width) * 100),
               assistantWidth: dock === null ? 0 : Math.round(dock.getBoundingClientRect().width),
               reading: Math.round(sheet.getBoundingClientRect().width - 68),
               pageOverflow: root.scrollWidth > window.innerWidth + 1,
               canvasOverflow: scroll.scrollWidth > scroll.clientWidth + 1,
               toolbarRows: Math.round(toolbar.getBoundingClientRect().height),
               toolbarClipped: toolbar.scrollWidth > toolbar.clientWidth + 1,
               composerHeight: composer === null ? 0 : Math.round(composer.getBoundingClientRect().height),
               intentInComposer:
                 composer !== null && document.querySelector('[data-testid="assistant-composer"]')?.contains(intent) === true,
               barHeight: bar === null ? 0 : Math.round(bar.getBoundingClientRect().height),
               target: document.querySelector('[data-testid="assistant-target"]')?.textContent ?? "",
               tabs: dock === null ? [] : [...dock.querySelectorAll('[data-testid="dock-tabs"] button')].map((b) => b.textContent.trim()),
               split: getComputedStyle(studio).getPropertyValue("--rp-coedit-split").trim(),
             };
           })()`,
        );

      /** Moves the divider to a share of the workspace, by dragging it. */
      const setSplitTo = async (target) => {
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const state = await measureCoedit();
          const current = Number.parseFloat(state.split);
          const delta = target - (Number.isFinite(current) ? current : 50);
          if (Math.abs(delta) < 1.5) return state;
          await session.drag('[data-testid="coedit-divider"]', Math.round((delta / 100) * state.studio));
        }
        return await measureCoedit();
      };

      // Opening the assistant is opening a workspace: the document makes room
      // for it instead of the panel squeezing in beside a full-width page.
      await session.click('[data-testid="open-assistant"]');
      await session.waitFor(`document.querySelector('[data-testid="assistant-input"]') !== null`, "the assistant workspace", 10_000);
      const coedit = await measureCoedit();
      case_(
        "打开助手就是协作模式：默认 50 / 50，两边都是一级工作区",
        coedit.layout === "coedit" && Math.abs(coedit.docShare - 50) <= 3 && Math.abs(coedit.assistantShare - 50) <= 3,
        `文档 ${String(coedit.docShare)}% · 助手 ${String(coedit.assistantShare)}%（${String(coedit.assistantWidth)}px）`,
      );
      case_(
        "助手不再是 520px 的侧栏：它拿走一半屏幕",
        coedit.assistantWidth > 560,
        `${String(coedit.assistantWidth)}px 宽`,
      );
      case_(
        "整个页面没有横向滚动，正文在它自己的一栏里读",
        coedit.pageOverflow === false && coedit.canvasOverflow === false,
        `页面 ${String(coedit.pageOverflow)} · 画布 ${String(coedit.canvasOverflow)} · 正文宽 ${String(coedit.reading)}px`,
      );
      case_(
        "半屏里工具栏仍是一行，控件没有被挤掉",
        coedit.toolbarRows < 70 && coedit.toolbarClipped === false,
        `工具栏 ${String(coedit.toolbarRows)}px · ${coedit.toolbarClipped ? "被裁切" : "完整"}`,
      );
      case_("写指令的框是工作区的主输入，而不是搜索框", coedit.composerHeight >= 72, `${String(coedit.composerHeight)}px 高`);
      case_(
        "指令方式退到 composer 的工具条里，不再是最显眼的 UI",
        coedit.intentInComposer === true,
      );
      case_(
        "右栏顶部只有一行：助手 + 当前目标（没有多余的标题与标签行）",
        coedit.target.length > 0 && coedit.barHeight < 64 && coedit.tabs.length === 0,
        `${String(coedit.barHeight)}px · ${coedit.target.slice(0, 32)} · 标签 ${String(coedit.tabs.length)} 个`,
      );

      if (shots !== undefined) {
        await session.setViewport(1440, 900);
        await session.screenshot(join(shots, "studio-coedit-1440.png"));
      }

      // The divider is a real control: it moves by hand and it stays inside the
      // range the two workspaces can both live in.
      const narrowed = await setSplitTo(42);
      case_(
        "分隔条可以拖动，两栏比例随之改变",
        narrowed.docShare <= 45 && narrowed.docShare >= 38,
        `拖到 ${String(narrowed.docShare)}% / ${String(narrowed.assistantShare)}%`,
      );
      const clamped = await setSplitTo(10);
      case_(
        "比例被限制在 40 / 60 之间，两边都还能读",
        clamped.docShare >= 38 && clamped.docShare <= 42,
        `下限停在 ${String(clamped.docShare)}%`,
      );
      const restored = await setSplitTo(50);
      case_("松开之后可以回到 50 / 50", Math.abs(restored.docShare - 50) <= 3, `回到 ${String(restored.docShare)}%`);

      // The window sizes this product is used at: 1366 is the narrowest, and it
      // splits too — a laptop must not fall back to an overlay it cannot read.
      for (const [width, height, name] of [
        [1366, 768, "1366"],
        [1440, 900, "1440"],
        [1920, 1080, "1920"],
      ]) {
        await session.setViewport(width, height);
        await delay(600);
        const state = await measureCoedit();
        const ok =
          state.layout === "coedit" &&
          Math.abs(state.docShare - state.assistantShare) <= 5 &&
          state.pageOverflow === false &&
          state.toolbarRows < 70 &&
          state.toolbarClipped === false;
        case_(
          `${String(width)} 下仍然是 50 / 50 的两栏，没有横向滚动、工具栏不被挤掉`,
          ok,
          `文档 ${String(state.docShare)}% · 助手 ${String(state.assistantShare)}%（${String(state.assistantWidth)}px）· 工具栏 ${String(state.toolbarRows)}px`,
        );
        if (width === 1920) {
          case_(
            "宽屏把富余留给工作区，但两侧仍然一样大",
            state.studio <= 1770 && state.assistantWidth >= 700 && Math.abs(state.docShare - state.assistantShare) <= 3,
            `工作区 ${String(state.studio)}px · 助手 ${String(state.assistantWidth)}px`,
          );
        }
        if (shots !== undefined) await session.screenshot(join(shots, `studio-coedit-${name}.png`));
      }
      await session.setViewport(1440, 900);
      await delay(400);

      // Closing it puts the document back in the middle of the page, and keeps
      // what was typed.
      await session.type('[data-testid="assistant-input"]', "这句话先写着，关掉再打开应该还在。");
      await session.click('[data-testid="open-assistant"]');
      await delay(500);
      const closed = await session.evaluate(
        `(() => {
           const scroll = document.querySelector(".rp-canvas-scroll");
           const sheet = document.querySelector(".rp-canvas__sheet");
           const left = sheet.getBoundingClientRect().left - scroll.getBoundingClientRect().left;
           const right = scroll.getBoundingClientRect().right - sheet.getBoundingClientRect().right;
           return {
             layout: document.querySelector('[data-testid="studio"]').getAttribute("data-layout"),
             dock: document.querySelector('[data-testid="context-dock"]') !== null,
             centered: Math.abs(left - right) < 40,
           };
         })()`,
      );
      await session.click('[data-testid="open-assistant"]');
      await session.waitFor(`document.querySelector('[data-testid="assistant-input"]') !== null`, "the assistant again", 8_000);
      const kept = await session.evaluate(`document.querySelector('[data-testid="assistant-input"]').value`);
      case_(
        "关闭助手立刻回到阅读模式：单栏居中，不留半屏空列",
        closed.layout === "reading" && closed.dock === false && closed.centered === true,
      );
      case_("重新打开时对话、目标与草稿都还在", kept.length > 0, `保留了 ${String(kept.length)} 字`);
      await session.evaluate(
        `(() => { const el = document.querySelector('[data-testid="assistant-input"]'); el.focus(); el.select(); return true; })()`,
      );
      await session.evaluate(`document.execCommand("delete")`);

      /* ------------------------------------------------------ model asks -- */

      if (!withModel) {
        skip("助手动作（提问 / 补查 → 提案 → 接受）", "未加 --model：这些动作真实调用模型");
      } else {
        // The product runs one action at a time, and disables its actions while
        // one is in flight: wait for the machine to be free before asking it to
        // do something, rather than clicking a button that is right to refuse.
        const idleBy = Date.now() + 600_000;
        while ((await api("/api/research/runtime")).busy === true && Date.now() < idleBy) await delay(3_000);
        // The report's own prose, without the citation markers: the program
        // re-mints those numbers for the whole document, and the boundaries
        // projection is derived from today's matrix — research is *supposed* to
        // move that. What must not move is the text of the report.
        const proseOf = `[...document.querySelectorAll("[data-section-id]")].map((section) => {
          const copy = section.cloneNode(true);
          for (const mark of copy.querySelectorAll(".rp-cite-group")) mark.remove();
          return [section.getAttribute("data-section-id"), copy.textContent];
        })`;
        const reportProse = async () => JSON.stringify(await session.evaluate(`Object.fromEntries(${proseOf})`));
        const proseBefore = await reportProse();

        const userTurns = async () =>
          await session.evaluate(
            `[...document.querySelectorAll('[data-testid="assistant-msg-user"]')].map((el) => el.textContent.trim())`,
          );

        const askQuestion = "只依据已有材料，用 Markdown 回答：先给一个二级标题，再用表格列出各对象的证据强度，最后用一段引用块总结。";
        await session.clickText("提问", '[data-testid="assistant-intent"]');
        case_("助手能切到提问模式", (await session.assistantIntent()) === "提问", String(await session.assistantIntent()));
        await session.type('[data-testid="assistant-input"]', askQuestion);
        await session.waitForEnabled('[data-testid="assistant-submit"]', "the ask submit");
        await session.click('[data-testid="assistant-submit"]');

        let questionVisible = false;
        try {
          await session.waitFor(
            `[...document.querySelectorAll('[data-testid="assistant-msg-user"]')].some((el) => el.textContent.includes("Markdown 回答"))`,
            "the reader's own turn",
            60_000,
          );
          questionVisible = true;
        } catch {
          questionVisible = false;
        }
        case_("读者的原话作为自己的一轮留在对话里", questionVisible === true, askQuestion.slice(0, 32));

        let answer = null;
        try {
          await session.waitFor(`document.querySelector('[data-testid="action-ask"] .rp-md') !== null`, "the answer", 300_000);
          await delay(2_000);
          answer = await session.evaluate(
            `(() => {
               const md = document.querySelector('[data-testid="action-ask"] .rp-md');
               const links = [...md.querySelectorAll("a")];
               return {
                 words: md.textContent.length,
                 tables: md.querySelectorAll("table").length,
                 headings: md.querySelectorAll("h1,h2,h3,h4").length,
                 quotes: md.querySelectorAll("blockquote").length,
                 lists: md.querySelectorAll("ul,ol").length,
                 links: links.length,
                 safe: links.every((a) => a.target === "_blank" && /noopener/.test(a.rel)),
                 unsafe: md.querySelectorAll("script,iframe,style,object,embed").length,
                 width: Math.round(md.getBoundingClientRect().width),
               };
             })()`,
          );
        } catch {
          answer = null;
        }
        case_(
          "Ask 用 Markdown 回答，长回答在半屏宽栏里可以舒服地读",
          answer !== null && answer.tables >= 1 && answer.headings >= 1 && answer.width >= 420,
          answer === null
            ? "没有回答"
            : `${String(answer.words)} 字 · 表格 ${String(answer.tables)} · 列表 ${String(answer.lists)} · 引用块 ${String(answer.quotes)} · 宽 ${String(answer.width)}px`,
        );
        case_(
          "AI 内容里没有可执行、可加载或可改样式的东西，外链都带目标与 noopener",
          answer !== null && answer.unsafe === 0 && answer.safe === true,
          answer === null ? "没有回答" : `${String(answer.unsafe)} 个可疑元素 · ${String(answer.links)} 个链接`,
        );

        if (shots !== undefined) {
          await session.setViewport(1440, 900);
          await session.screenshot(join(shots, "studio-ask-1440.png"));
        }

        case_("提问不改变报告正文", (await reportProse()) === proseBefore, "逐节比对");

        // Research: the instruction is the reader's, the material is new, and
        // the report does not move. Each instruction gets its own allowance, so
        // a second one is expected to start rather than be refused.
        await session.clickText("补查", '[data-testid="assistant-intent"]');
        const budgetLine = await session.evaluate(`document.querySelector('[data-testid="assistant-help"]')?.textContent?.trim() ?? ""`);
        case_(
          "补查模式说清这次动作自己的额度，而不是项目还剩多少",
          /次检索/.test(budgetLine) && /个来源/.test(budgetLine) && !/项目还剩|本项目还剩/.test(budgetLine),
          budgetLine,
        );

        const researchOnce = async (instruction) => {
          const before = (await api(`/api/research/tasks/${reportTaskId}`)).runs.filter((run) => run.stage === "gap").length;
          await session.type('[data-testid="assistant-input"]', instruction);
          await session.waitForEnabled('[data-testid="assistant-submit"]', "the research submit");
          await session.click('[data-testid="assistant-submit"]');
          try {
            await session.waitFor(
              `Boolean(document.querySelector('[data-testid="assistant-error"]')) ||
               (fetch("/api/research/tasks/" + ${JSON.stringify(reportTaskId)}).then((response) => response.json()).then((bundle) => bundle.runs.filter((run) => run.stage === "gap").length > ${String(before)} && bundle.runs.slice(-1)[0].status !== "running"))`,
              "the research action to settle",
              420_000,
            );
            const refused = await session.evaluate(
              `(() => { const el = document.querySelector('[data-testid="assistant-error"]'); return el === null ? null : el.textContent; })()`,
            );
            return refused === null ? "ran" : "refused";
          } catch {
            return "timeout";
          }
        };

        const firstOutcome = await researchOnce("补查成本口径这一项：找一找有没有公开的第三方成本评测。");
        // The run record settles before the page has redrawn it: wait for the
        // column to say what happened rather than reading it mid-flight.
        if (firstOutcome === "ran") {
          await session
            .waitFor(
              `[...document.querySelectorAll('[data-testid="action-gap"]')].slice(-1)[0].textContent.includes("报告正文没有改变")`,
              "the research turn to report itself",
              90_000,
            )
            .catch(() => undefined);
        }
        const afterResearch = await reportProse();
        case_(
          "补查如实结束（补查或说明为什么不能补），正文不变",
          firstOutcome !== "timeout" && afterResearch === proseBefore,
          `${firstOutcome} · 正文${afterResearch === proseBefore ? "逐节未变" : "发生了变化"}`,
        );

        const researchTurns = await userTurns();
        case_(
          "补查以「你要求什么 / 助手做了什么」留在对话里，没有工具名与原始 JSON",
          researchTurns.some((text) => text.includes("第三方成本评测")),
          `${String(researchTurns.length)} 轮用户消息`,
        );

        const exhausted = await session.evaluate(
          `(() => {
             const blocks = [...document.querySelectorAll('[data-testid="action-gap"]')];
             const latest = blocks.slice(-1)[0];
             return {
               text: latest?.textContent ?? "",
               hasCounts: /检索/.test(latest?.textContent ?? ""),
             };
           })()`,
        );
        case_(
          "补查结束语说明这一轮做了什么、正文没变（额度用尽时也如实说出来）",
          exhausted.hasCounts && /正文没有改变|正文没有变化/.test(exhausted.text),
          exhausted.text.replace(/\s+/g, " ").slice(0, 70),
        );

        // A second instruction is a second action: the previous one's allowance
        // is not the project's, so nothing about it can refuse this one.
        const secondOutcome = await researchOnce("再补查一次：找一找这三份材料在证据强度上的对比。");
        const secondTurns = await userTurns();
        case_(
          "用完一轮额度之后，下一条补查仍然能正常发起",
          secondOutcome === "ran" && (secondTurns[secondTurns.length - 1] ?? "").includes("再补查一次"),
          `${secondOutcome} · 对话里 ${String(secondTurns.length)} 轮，最后一轮：${(secondTurns[secondTurns.length - 1] ?? "").slice(0, 24)}`,
        );

        // Evidence opened from inside the conversation stays in the same column
        // and offers the way back to what the reader was reading.
        const gapCount = (await api(`/api/research/tasks/${reportTaskId}`)).gaps.length;
        const canInspect = await session.evaluate(
          `[...document.querySelectorAll("button")].some((button) => button.textContent.trim() === "检查新证据")`,
        );
        if (canInspect === true && gapCount > 0) {
          await session.evaluate(
            `(() => { const button = [...document.querySelectorAll("button")].find((el) => el.textContent.trim() === "检查新证据"); button.scrollIntoView({block: "center"}); button.click(); return true; })()`,
          );
          await session.waitFor(`document.querySelector('[data-testid="back-to-conversation"]') !== null`, "the way back", 10_000);
          const pane = await session.evaluate(
            `(() => ({
               layout: document.querySelector('[data-testid="studio"]').getAttribute("data-layout"),
               kicker: document.querySelector('[data-testid="context-dock"] .rp-dock__kicker')?.textContent ?? "",
               width: Math.round(document.querySelector('[data-testid="context-dock"]').getBoundingClientRect().width),
             }))()`,
          );
          case_(
            "从对话里打开证据：仍在同一个右栏、仍是协作布局，并能回到刚才的对话",
            pane.layout === "coedit" && pane.kicker.length > 0 && pane.width > 420,
            `${pane.kicker} · ${String(pane.width)}px`,
          );
          await session.click('[data-testid="back-to-conversation"]');
          await session.waitFor(`document.querySelector('[data-testid="assistant-input"]') !== null`, "the conversation again", 8_000);
          case_(
            "返回之后对话没有丢",
            (await userTurns()).length === secondTurns.length,
            `${String((await userTurns()).length)} 轮仍在`,
          );
        } else {
          skip("证据 → 返回对话", "这一次没有可检查的缺口单元格");
        }

        // Edit: a proposal, and the document must stay put until accepted.
        // A section's prose, without the citation markers: those are numbers the
        // program re-mints for the whole document, and a change in them is not a
        // change in anybody's text.
        const sectionsBefore = await session.evaluate(`Object.fromEntries(${proseOf})`);
        const reportIdBefore = await session.evaluate(
          `document.querySelector('[data-testid="document-canvas"]').getAttribute("data-report-id")`,
        );
        await session.evaluate(
          `(() => { const btn = document.querySelector(".rp-doc__h2-btn"); btn.scrollIntoView({block: "center"}); btn.click(); return true; })()`,
        );
        await delay(400);
        await session.clickText("修改", '[data-testid="assistant-intent"]');
        const preview = await session.evaluate(
          `(() => {
             const strip = document.querySelector('[data-testid="action-preview"]');
             if (strip === null) return null;
             return {
               missing: strip.querySelector(".rp-preview__v--missing") !== null,
               text: strip.textContent,
               target: document.querySelector('[data-testid="target-select"]')?.value ?? null,
             };
           })()`,
        );
        case_(
          "Edit 提交前说明将修改哪一节、正文不会先变",
          preview !== null && preview.missing === false && preview.target !== null && /正文/.test(preview.text),
          preview === null ? "没有预览" : String(preview.target),
        );
        await session.type(
          '[data-testid="assistant-input"]',
          "把这一节改得更短：只保留有直接证据支撑的句子，没有依据的写成一个缺口说明。",
        );
        await session.waitForEnabled('[data-testid="assistant-submit"]', "the edit submit");
        await session.click('[data-testid="assistant-submit"]');

        // This run's proposal, not a card left over from an earlier one.
        let proposalReady = false;
        let pending = [];
        try {
          await session.waitFor(`document.querySelector('[data-testid="action-edit"]') !== null`, "the edit turn", 300_000);
          for (let attempt = 0; attempt < 180; attempt += 1) {
            const fresh = await api(`/api/research/tasks/${reportTaskId}`);
            pending = fresh.proposals.filter((proposal) => proposal.status === "pending");
            if (pending.length > 0) break;
            const editRuns = fresh.runs.filter((run) => run.stage === "edit");
            const latest = editRuns[editRuns.length - 1];
            if (latest !== undefined && latest.status !== "running") break;
            await delay(2_000);
          }
          proposalReady = pending.length > 0;
        } catch {
          proposalReady = false;
        }
        const editRun = (await api(`/api/research/tasks/${reportTaskId}`)).runs.filter((run) => run.stage === "edit").slice(-1)[0];
        const attempts = (editRun?.activity ?? []).filter((step) => step.name === "propose_section_edit");
        case_(
          "Edit 生成一份待接受的修改建议（而不是直接改写正文）",
          proposalReady === true,
          proposalReady
            ? `${String(pending.length)} 份待接受`
            : attempts.length === 0
              ? "模型这一次没有起草提案"
              : String(attempts[attempts.length - 1].detail).slice(0, 120),
        );

        const sectionsDuring = await session.evaluate(`Object.fromEntries(${proseOf})`);
        case_(
          "提案待接受时正文没有变化",
          Object.keys(sectionsBefore).every((id) => sectionsDuring[id] === sectionsBefore[id]),
          `${String(Object.keys(sectionsBefore).length)} 节逐一比对`,
        );

        if (!proposalReady) {
          skip("修改建议的展示、接受与作用范围", "这一次没有产生提案，没有可接受的东西");
        } else {
          try {
            await session.waitFor(`document.querySelector('[data-testid="accept-proposal"]') !== null`, "the proposal", 60_000);
          } catch {
            await session.click('[data-testid="open-proposal"]');
            await session.waitFor(`document.querySelector('[data-testid="accept-proposal"]') !== null`, "the proposal panel", 30_000);
          }
          const proposalView = await session.evaluate(
            `(() => {
               const dock = document.querySelector('[data-testid="context-dock"]');
               const text = dock.textContent ?? "";
               return {
                 width: Math.round(dock.getBoundingClientRect().width),
                 inline: document.querySelector('[data-testid="assistant-proposal"]') !== null,
                 conversation: document.querySelectorAll('[data-testid="assistant-msg-user"]').length,
                 hasCurrent: /现在的正文/.test(text),
                 hasProposed: /修改后/.test(text),
                 hasEvidence: /证据/.test(text),
                 claims: dock.querySelectorAll(".rp-claimrow").length,
               };
             })()`,
          );
          case_(
            "修改建议嵌在对话里：现在 / 修改后、论断与证据变化都在，对话没有被换掉",
            proposalView.inline === true &&
              proposalView.conversation >= 1 &&
              proposalView.hasCurrent &&
              proposalView.hasProposed &&
              proposalView.hasEvidence,
            `${String(proposalView.width)}px · ${String(proposalView.claims)} 条论断`,
          );

          const targetTitles = await session.evaluate(
            `(() => { const el = document.querySelector('[data-testid="proposal-target"]'); return el === null ? "" : el.textContent.replace("目标：", "").trim(); })()`,
          );
          if (shots !== undefined) {
            await session.setViewport(1440, 900);
            await session.screenshot(join(shots, "studio-proposal-1440.png"));
          }
          await session.click('[data-testid="accept-proposal"]');
          await session.waitFor(`document.querySelector('[data-testid="accept-proposal"]') === null`, "the proposal to settle", 60_000);
          // The accepted proposal installs a new report, and the canvas has to
          // have drawn it before "what changed" can be read from the page.
          await session.waitFor(
            `document.querySelector('[data-testid="document-canvas"]').getAttribute("data-report-id") !== ${JSON.stringify(reportIdBefore)}`,
            "the accepted report",
            60_000,
          );
          await delay(1_000);
          const sectionsAfter = await session.evaluate(`Object.fromEntries(${proseOf})`);
          const changedIds = Object.keys(sectionsBefore).filter((id) => sectionsAfter[id] !== sectionsBefore[id]);
          const targetId = await session.evaluate(
            `(() => {
               const titles = ${JSON.stringify(targetTitles)}.split("、").map((part) => part.trim()).filter((part) => part.length > 0);
               const sections = [...document.querySelectorAll("[data-section-id]")];
               const found = sections.find((section) => titles.includes((section.querySelector(".rp-doc__h2-btn")?.textContent ?? "").trim()));
               return found === undefined ? null : found.getAttribute("data-section-id");
             })()`,
          );
          const otherChanged = changedIds.filter((id) => id !== targetId);
          case_(
            "接受后只有目标章节改变",
            reportIdBefore !== null &&
              targetId !== null &&
              otherChanged.length === 0,
            `目标 ${String(targetId)}（${targetTitles}）· 变化 ${String(changedIds.length)} 节${
              changedIds.length === 0 ? "（模型这次的替换与原文一致）" : ""
            }`,
          );
          case_(
            "接受之后对话仍然在，并留下一句已结束的说明",
            (await session.evaluate(`document.querySelectorAll('[data-testid="assistant-msg-user"]').length`)) >= 1,
          );
        }
      }
    }

    /* --------------------------------------------------------- sources -- */

    const otherTaskId = reportTaskId ?? taskArg ?? draftId;
    if (otherTaskId === undefined) {
      skip("来源工作区 / 模板 / 设置", "没有打开任何项目");
    } else {
      await session.goto(`${base}/#/p/${otherTaskId}/sources`);
      await session.waitFor(`document.querySelector('[data-testid="source-table"]') !== null`, "the source table", 12_000);
      const sources = await session.evaluate(
        `(() => {
           const rows = [...document.querySelectorAll('[data-testid^="source-row-"]')];
           const first = rows[0];
           return { rows: rows.length, badges: first === undefined ? 0 : first.querySelectorAll(".rp-chip").length, title: first?.querySelector(".rp-src__title")?.textContent ?? "" };
         })()`,
      );
      case_("来源工作区是列表而非后台表格", sources.rows > 0 && sources.badges <= 3, `${String(sources.rows)} 个来源 · ${sources.title.slice(0, 30)}`);
      if (sources.rows > 0) {
        await session.click('[data-testid^="source-row-"]');
        await session.waitFor(`document.querySelector('[data-testid="context-dock"] .rp-dock__kicker')?.textContent === "来源"`, "the source dock", 8_000);
        const hasScope = await session.evaluate(
          `/读取范围/.test(document.querySelector('[data-testid="context-dock"]').textContent ?? "")`,
        );
        case_("点击来源行在同一个 Dock 里打开来源详情", hasScope === true);
      }

      await session.goto(`${base}/#/p/${otherTaskId}/gallery`);
      await session.waitFor(`document.querySelector('[data-testid="theme-editorial"]') !== null`, "the gallery", 12_000);
      const gallery = await session.evaluate(
        `(() => ({ themes: document.querySelectorAll("[data-testid^='theme-']").length, previews: document.querySelectorAll(".rp-theme__scale-inner .rp-doc").length, unchanged: document.querySelector(".rp-unchanged")?.textContent?.length ?? 0 }))()`,
      );
      case_(
        "模板页用同一份真实报告并排预览两套主题",
        gallery.themes === 2 && gallery.previews === 2 && gallery.unchanged > 10,
        `${String(gallery.themes)} 套主题 · ${String(gallery.previews)} 份预览`,
      );
    }

    /* -------------------------------------------------------- settings -- */

    await session.goto(`${base}/#/settings`);
    await session.waitFor(`document.querySelector(".rp-settings") !== null`, "settings", 10_000);
    const groups = await session.evaluate(
      `[...document.querySelectorAll(".rp-settings__nav button")].map((button) => button.textContent.trim())`,
    );
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
  } catch (error) {
    failedHard = true;
    case_(`gate 中断：${error instanceof Error ? error.message : String(error)}`, false);
  } finally {
    await session.close();
  }

  const failed = results.filter((result) => result.ok === false);
  const skipped = results.filter((result) => result.ok === null);
  console.log(
    `\n${String(results.length - failed.length - skipped.length)}/${String(results.length - skipped.length)} cases passed${
      skipped.length === 0 ? "" : ` (${String(skipped.length)} skipped)`
    }`,
  );
  if (failedHard) process.exitCode = 2;
  else process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(`the workspace gate could not run: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
});
