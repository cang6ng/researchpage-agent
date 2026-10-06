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
      // The card's topic is written by the model, so a new project is found by
      // watching for an id that was not there before, rather than by matching
      // the words the reader happened to type.
      const before = new Set(listed);
      await session.type('[data-testid="topic-input"]', "对比三种 RAG 方案在长文档问答上的成本与效果，给技术选型用");
      await session.click('[data-testid="topic-submit"]');
      let created;
      const deadline = Date.now() + 240_000;
      while (created === undefined && Date.now() < deadline) {
        const state = await api("/api/research/tasks");
        created = state.tasks.find((task) => !before.has(task.id))?.id;
        if (created === undefined) await delay(2_000);
      }
      draftId = created;
      case_("从起始页建立一份新的研究任务卡", created !== undefined, created ?? "主题提交后没有产生新项目");
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
      await session.click('[data-testid="apply-subjects"]');
      let valid = grown;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await delay(500);
        valid = await briefOf(draftId);
        if (valid.validation.valid) break;
      }
      case_("补齐之后草稿重新可以确认", valid.validation.valid === true, valid.validation.problems.join("；").slice(0, 70));

      /* ---------------------------------------------------------- guided -- */

      if (!withModel) {
        skip("智能引导（问题 / 选项 / 写回同一份草稿）", "未加 --model：引导问题由真实模型撰写");
      } else {
        await session.clickText("智能引导", '[data-testid="brief-mode"]');
        await session.waitFor(`document.querySelector('[data-testid="guide-panel"]') !== null`, "the guided panel", 10_000);
        if ((await session.evaluate(`document.querySelector('[data-testid="guide-idle"]') !== null`)) === true) {
          await session.click('[data-testid="guide-start"]');
        }
        let questionSeen = false;
        let completedEarly = false;
        try {
          await session.waitFor(
            `document.querySelector('[data-testid="guide-options"]') !== null || document.querySelector('[data-testid="guide-complete"]') !== null`,
            "the guided session to reach its first decision",
            180_000,
          );
          questionSeen = (await session.evaluate(`document.querySelector('[data-testid="guide-options"]') !== null`)) === true;
          completedEarly = !questionSeen;
        } catch {
          questionSeen = false;
        }
        const guided = await session.evaluate(
          `(() => {
             const card = document.querySelector('[data-testid="guide-panel"]');
             return {
               question: card.querySelector(".rp-guide__question")?.textContent ?? "",
               why: card.querySelector('[data-testid="guide-why"]')?.textContent ?? "",
               options: card.querySelectorAll('[data-testid^="option-"]').length,
               freeText: card.querySelector('[data-testid="guide-free-text"]') !== null,
               count: card.querySelector(".rp-guide__count")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
               bubbles: card.querySelectorAll(".rp-answer").length,
               done: card.querySelector('[data-testid="guide-complete"]') !== null,
               doneText: card.querySelector('[data-testid="guide-complete"]')?.textContent ?? "",
               doneActions: card.querySelectorAll('[data-testid="guide-confirm"]').length,
             };
           })()`,
        );
        case_(
          "智能引导给出一个具体决策，或者明确说不需要再问",
          questionSeen || completedEarly,
          questionSeen ? `一问：${guided.question.slice(0, 36)}` : guided.doneText.slice(0, 40),
        );
        if (completedEarly) {
          // The application may decide the plan is already specific enough. The
          // panel then says so and offers the decision; it does not manufacture
          // questions to reach a count, and the gate does not demand one.
          case_(
            "方案已经足够明确时，引导自然收束而不是凑满问题",
            guided.done === true && guided.doneActions === 1 && guided.bubbles === 0,
            guided.doneText.replace(/\s+/g, " ").slice(0, 60),
          );
        } else if (questionSeen) {
          case_(
            "它不像聊天：没有问题历史、没有气泡，只有一问、一句理由和几个选项",
            guided.bubbles === 0 && guided.options >= 2 && guided.options <= 5 && guided.why.length > 0 && guided.freeText === true,
            `${String(guided.options)} 个选项 · ${guided.count}`,
          );

          const beforeAnswer = await briefOf(draftId);
          await session.click('[data-testid="option-opt_1"]');
          await session.waitForEnabled('[data-testid="guide-submit"]', "the guided submit");
          await session.click('[data-testid="guide-submit"]');
          let answered = beforeAnswer;
          for (let attempt = 0; attempt < 60; attempt += 1) {
            await delay(500);
            answered = await briefOf(draftId);
            if (answered.version > beforeAnswer.version) break;
          }
          const applied = await session.evaluate(
            `(() => { const el = document.querySelector('[data-testid="guide-applied"]'); return el === null ? null : el.textContent.trim(); })()`,
          );
          case_(
            "选一个选项就写进同一份草稿，并回显刚做的决定",
            answered.version > beforeAnswer.version && applied !== null,
            applied === null ? "没有回显" : applied.slice(0, 54),
          );
          const changedTextFields = TEXT_FIELDS.filter(
            (field) => JSON.stringify(beforeAnswer[field]) !== JSON.stringify(answered[field]),
          );
          case_(
            "这一步只动了它要问的那一个字段",
            changedTextFields.length <= 1,
            changedTextFields.length === 0 ? "值未变（用户确认了默认）" : changedTextFields.join("、"),
          );

          // The next question may already be waiting; if it is, it is answered in
          // the reader's own words rather than by picking an option.
          let freeTextSeen = false;
          try {
            await session.waitFor(`document.querySelector('[data-testid="guide-free-text"]') !== null`, "the next question", 120_000);
            freeTextSeen = true;
          } catch {
            freeTextSeen = false;
          }
          if (freeTextSeen) {
            const beforeFree = await briefOf(draftId);
            const field = await session.evaluate(
              `(() => { const q = document.querySelector(".rp-guide__field"); return q === null ? "" : q.textContent.trim(); })()`,
            );
            await session.type('[data-testid="guide-free-text"]', "重点是索引与查询两段的成本口径，更新成本可以只作定性说明。");
            await session.waitForEnabled('[data-testid="guide-submit"]', "the free-text submit");
            await session.click('[data-testid="guide-submit"]');
            let afterFree = beforeFree;
            for (let attempt = 0; attempt < 60; attempt += 1) {
              await delay(500);
              afterFree = await briefOf(draftId);
              if (afterFree.version > beforeFree.version) break;
            }
            const changedFields = TEXT_FIELDS.filter(
              (name) => JSON.stringify(beforeFree[name]) !== JSON.stringify(afterFree[name]),
            );
            const wrote = changedFields.some((name) => JSON.stringify(afterFree[name]).includes("成本口径"));
            case_(
              "自由回答同样写进这份草稿，并只改它问的那一项",
              afterFree.version > beforeFree.version && changedFields.length <= 1,
              `${field.slice(0, 24)} → ${changedFields.join("、") || "值未变（被解析为确认默认）"}${wrote ? "（含原文）" : ""}`,
            );
          } else {
            skip("自由回答写进草稿", "模型在这一轮之后没有继续提问");
          }

          // Structured sees it at once: same draft, no client-side copy.
          await session.clickText("结构化编辑", '[data-testid="brief-mode"]');
          await session.waitFor(`document.querySelector('[data-testid="edit-purpose"]') !== null`, "structured mode", 8_000);
          const structured = await session.evaluate(
            `[...document.querySelectorAll(".rp-inline")].map((el) => el.textContent).join("\\u0000")`,
          );
          case_(
            "引导答完切回结构化，看到的是同一份草稿的最新值",
            structured.includes(answered.purpose.slice(0, 18)),
            `简报 v${String(answered.version)}`,
          );
        }
      }

      /* --------------------------------------------------------- confirm -- */

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

      // Selecting a sentence opens the evidence — in the same panel the
      // assistant works in, not in a second sidebar.
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
           };
         })()`,
      );
      case_("检查器区分「引用有效」与「证据是否足以支持」", inspector.hasValidity && inspector.hasAdequacy, inspector.tabs.join(" / "));
      case_("选中对象出现统一动作栏", inspector.rail === 1, `${String(inspector.rail)} 个动作栏`);
      case_("证据这类速览仍然是一栏 Dock，不是工作区", inspector.width <= 384, `${String(inspector.width)}px`);

      if (shots !== undefined) {
        await session.setViewport(1440, 900);
        await session.screenshot(join(shots, "studio-evidence-1440.png"));
      }

      // Opening the assistant widens the one panel and makes room for it.
      await session.click('[data-testid="open-assistant"]');
      await session.waitFor(`document.querySelector('[data-testid="assistant-input"]') !== null`, "the assistant workspace", 10_000);
      const coedit = await session.evaluate(
        `(() => {
           const studio = document.querySelector('[data-testid="studio"]');
           const dock = document.querySelector('[data-testid="context-dock"]');
           const sheet = document.querySelector(".rp-canvas__sheet");
           const scroll = document.querySelector(".rp-canvas-scroll");
           const toolbar = document.querySelector(".rp-toolbar");
           const d = dock.getBoundingClientRect();
           const s = sheet.getBoundingClientRect();
           return {
             layout: studio.getAttribute("data-layout"),
             width: Math.round(d.width),
             reading: Math.round(s.width - 144),
             docShare: Math.round((s.width / (s.width + d.width)) * 100),
             overflow: scroll.scrollWidth > scroll.clientWidth + 1,
             toolbarRows: Math.round(toolbar.getBoundingClientRect().height),
             target: document.querySelector('[data-testid="assistant-target"]')?.textContent ?? "",
             tabs: [...dock.querySelectorAll('[data-testid="dock-tabs"] button')].map((button) => button.textContent.trim()),
           };
         })()`,
      );
      case_("打开助手进入协作模式，文档与助手真正并排", coedit.layout === "coedit" && coedit.width >= 420, `${String(coedit.width)}px 宽`);
      case_(
        "文档仍是主体（约三分之二），不出现横向滚动，工具栏不被挤成两行",
        coedit.docShare >= 60 && coedit.overflow === false && coedit.toolbarRows < 70,
        `文档 ${String(coedit.docShare)}% · 阅读宽 ${String(coedit.reading)}px · 工具栏 ${String(coedit.toolbarRows)}px`,
      );
      case_("右侧始终只有一个工作区，标签随对象切换", coedit.tabs.includes("助手"), coedit.tabs.join(" / "));
      case_("助手顶部始终写明这条指令作用于谁", coedit.target.length > 0, coedit.target.slice(0, 40));

      if (shots !== undefined) {
        await session.setViewport(1440, 900);
        await session.screenshot(join(shots, "studio-coedit-1440.png"));
        await session.setViewport(1366, 768);
        await session.screenshot(join(shots, "studio-coedit-1366.png"));
        await session.setViewport(1920, 1080);
        await session.screenshot(join(shots, "studio-coedit-1920.png"));
        await session.setViewport(1440, 900);
      }

      // Closing it puts the document back to reading, and keeps what was typed.
      await session.type('[data-testid="assistant-input"]', "这句话先写着，关掉再打开应该还在。");
      await session.click('[data-testid="open-assistant"]');
      await delay(500);
      const closed = await session.evaluate(
        `(() => ({
           layout: document.querySelector('[data-testid="studio"]').getAttribute("data-layout"),
           dock: document.querySelector('[data-testid="context-dock"]') !== null,
         }))()`,
      );
      await session.click('[data-testid="open-assistant"]');
      await session.waitFor(`document.querySelector('[data-testid="assistant-input"]') !== null`, "the assistant again", 8_000);
      const kept = await session.evaluate(`document.querySelector('[data-testid="assistant-input"]').value`);
      case_(
        "关闭助手立刻回到阅读模式，重新打开时草稿还在",
        closed.layout === "reading" && closed.dock === false && kept.length > 0,
        `保留了 ${String(kept.length)} 字`,
      );
      await session.evaluate(
        `(() => { const el = document.querySelector('[data-testid="assistant-input"]'); el.focus(); el.select(); return true; })()`,
      );
      await session.evaluate(`document.execCommand("delete")`);

      /* ------------------------------------------------------ model asks -- */

      if (!withModel) {
        skip("助手动作（Ask / 补查 / Edit → 提案 → 接受）", "未加 --model：这些动作真实调用模型");
      } else {
        // The product runs one action at a time, and disables its actions while
        // one is in flight: wait for the machine to be free before asking it to
        // do something, rather than clicking a button that is right to refuse.
        const idleBy = Date.now() + 600_000;
        while ((await api("/api/research/runtime")).busy === true && Date.now() < idleBy) await delay(3_000);
        const reportWordsBefore = await session.evaluate(`document.querySelector('[data-testid="document-canvas"]').textContent.length`);

        await session.clickText("提问", '[data-testid="assistant-intent"]');
        case_("助手能切到提问模式", (await session.assistantIntent()) === "提问", String(await session.assistantIntent()));
        await session.type(
          '[data-testid="assistant-input"]',
          "只依据已有材料，用 Markdown 回答：先给一个二级标题，再用表格列出各对象的证据强度，最后用一段引用块总结。",
        );
        await session.waitForEnabled('[data-testid="assistant-submit"]', "the ask submit");
        await session.click('[data-testid="assistant-submit"]');
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
               };
             })()`,
          );
        } catch {
          answer = null;
        }
        case_(
          "Ask 用 Markdown 回答，长回答在宽栏里可以舒服地读",
          answer !== null && answer.tables >= 1 && answer.headings >= 1,
          answer === null ? "没有回答" : `${String(answer.words)} 字 · 表格 ${String(answer.tables)} · 列表 ${String(answer.lists)} · 引用块 ${String(answer.quotes)}`,
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

        const afterAsk = await session.evaluate(`document.querySelector('[data-testid="document-canvas"]').textContent.length`);
        case_("提问不改变报告正文", Math.abs(afterAsk - reportWordsBefore) < 40, `正文长度 ${String(reportWordsBefore)} → ${String(afterAsk)}`);

        // Research: bringing material in may be refused — a project can have
        // spent its rounds — and both outcomes are the product working. What is
        // never allowed is the report moving because material arrived.
        const beforeResearch = await session.evaluate(`document.querySelector('[data-testid="document-canvas"]').textContent.length`);
        await session.clickText("补查", '[data-testid="assistant-intent"]');
        await session.type('[data-testid="assistant-input"]', "补查成本口径这一项：找一找有没有公开的第三方成本评测。");
        await session.waitForEnabled('[data-testid="assistant-submit"]', "the research submit");
        await session.click('[data-testid="assistant-submit"]');
        // Cards for earlier runs stay on screen, so "ran" has to mean a new run
        // or an answer that says it could not start — never a card from before.
        const gapRunsBefore = (await api(`/api/research/tasks/${reportTaskId}`)).runs.filter((run) => run.stage === "gap").length;
        let researchOutcome = "none";
        try {
          await session.waitFor(
            `Boolean(document.querySelector('[data-testid="assistant-error"]')) ||
             (fetch("/api/research/tasks/" + ${JSON.stringify(reportTaskId)}).then((response) => response.json()).then((bundle) => bundle.runs.filter((run) => run.stage === "gap").length > ${String(gapRunsBefore)}))`,
            "the research action to settle",
            360_000,
          );
          const refused = await session.evaluate(
            `(() => { const el = document.querySelector('[data-testid="assistant-error"]'); return el === null ? null : el.textContent; })()`,
          );
          researchOutcome = refused === null ? "ran" : "refused";
        } catch {
          researchOutcome = "timeout";
        }
        if (researchOutcome === "refused") {
          const reason = await session.evaluate(
            `document.querySelector('[data-testid="assistant-error"]')?.textContent ?? ""`,
          );
          console.log(`       refusal: ${String(reason).slice(0, 80)}`);
        }
        const afterResearch = await session.evaluate(`document.querySelector('[data-testid="document-canvas"]').textContent.length`);
        case_(
          "补查如实结束（补查或说明预算用尽），正文不变",
          researchOutcome !== "timeout" && Math.abs(afterResearch - beforeResearch) < 10,
          `${researchOutcome} · 正文长度 ${String(beforeResearch)} → ${String(afterResearch)}`,
        );

        // Edit: a proposal, and the document must stay put until accepted.
        // A section's prose, without the citation markers: those are numbers the
        // program re-mints for the whole document, and a change in them is not a
        // change in anybody's text.
        const proseOf = `[...document.querySelectorAll("[data-section-id]")].map((section) => {
          const copy = section.cloneNode(true);
          for (const mark of copy.querySelectorAll(".rp-cite-group")) mark.remove();
          return [section.getAttribute("data-section-id"), copy.textContent];
        })`;
        const sectionsBefore = await session.evaluate(`Object.fromEntries(${proseOf})`);
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
        // This run's proposal, not a card left over from an earlier one: the
        // assistant keeps the last few actions on screen, and an old card's
        // button would open an old — already settled — proposal.
        let proposalReady = false;
        let pending = [];
        try {
          await session.waitFor(`document.querySelector('[data-testid="action-edit"]') !== null`, "the edit card", 300_000);
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
          await session.click('[data-testid="open-proposal"]');
          await session.waitFor(`document.querySelector('[data-testid="accept-proposal"]') !== null`, "the proposal panel", 30_000);
          const proposalView = await session.evaluate(
            `(() => {
               const dock = document.querySelector('[data-testid="context-dock"]');
               const text = dock.textContent ?? "";
               return {
                 width: Math.round(dock.getBoundingClientRect().width),
                 hasCurrent: /现在的正文/.test(text),
                 hasProposed: /修改后/.test(text),
                 hasEvidence: /证据/.test(text),
                 claims: dock.querySelectorAll(".rp-claimrow").length,
                 tabs: [...dock.querySelectorAll('[data-testid="dock-tabs"] button')].map((button) => button.textContent.trim()),
               };
             })()`,
          );
          case_(
            "修改建议在宽栏里展示「现在 / 修改后」、论断与证据变化",
            proposalView.hasCurrent && proposalView.hasProposed && proposalView.hasEvidence && proposalView.width >= 420,
            `${String(proposalView.width)}px · ${String(proposalView.claims)} 条论断 · ${proposalView.tabs.join(" / ")}`,
          );

          const targetTitles = await session.evaluate(
            `(() => { const el = document.querySelector('[data-testid="proposal-target"]'); return el === null ? "" : el.textContent.replace("目标：", "").trim(); })()`,
          );
          if (shots !== undefined) {
            await session.setViewport(1440, 900);
            await session.screenshot(join(shots, "studio-proposal-1440.png"));
          }
          await session.click('[data-testid="accept-proposal"]');
          await session.waitFor(`document.querySelector('[data-testid="accept-proposal"]') === null`, "the proposal to settle", 30_000);
          await delay(2_500);
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
          case_(
            "接受后只有目标章节改变",
            targetId !== null && changedIds.length === 1 && changedIds[0] === targetId,
            `目标 ${String(targetId)}（${targetTitles}）· 变化 ${String(changedIds.length)} 节`,
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
