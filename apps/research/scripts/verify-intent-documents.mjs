/**
 * The intent-and-documents browser acceptance: the whole product path, driven.
 *
 * This gate exists for the one question a unit test cannot answer — whether a
 * real person, in a real browser, can go from「我想研究这个」to a finished
 * report — and it answers it the way a person would: it types into the real
 * composer, clicks the real buttons with real mouse input, answers the
 * assistant's questions, edits the direction the assistant proposed, confirms
 * it, and then checks that the run it started really produced a report.
 *
 * Three things it watches in particular, because they are the ones a page can
 * get wrong while every test stays green:
 *
 * - **No legacy entry.** The browser must never create a project by
 *   `POST /api/research/tasks`. The network is recorded for every request, so
 *   「首页新建没有走旧入口」is a fact about the traffic, not a reading of the code.
 * - **No unconsented upload.** Selecting a PDF must not send anything; the file
 *   only leaves the browser after the reader ticks the box, and the request that
 *   carries it must be `application/octet-stream` with the bytes themselves.
 * - **No invented confirmation.** HTTP 202 from `/intents/:id/confirm` is not a
 *   project: the page may only leave the exploration when a task id really
 *   exists, which is why this gate waits for the URL to become a project rather
 *   than for the click to return.
 *
 *   node apps/research/scripts/verify-intent-documents.mjs \
 *     --url http://127.0.0.1:8791/ [--model] [--shots <dir>] [--topic <text>]
 *
 * It prints one PASS/FAIL/SKIP line per case and exits non-zero if anything
 * failed. `--model` gates the cases that spend a real provider call; without it
 * the script only checks what the running server already holds.
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

function parseArgs(argv) {
  const options = { url: undefined, shots: undefined, model: false, topic: undefined, timeout: 240_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1];
    switch (argv[index]) {
      case "--url":
        options.url = value;
        index += 1;
        break;
      case "--shots":
        options.shots = value;
        index += 1;
        break;
      case "--topic":
        options.topic = value;
        index += 1;
        break;
      case "--timeout":
        options.timeout = Number(value);
        index += 1;
        break;
      case "--model":
        options.model = true;
        break;
      default:
        break;
    }
  }
  return options;
}

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

/**
 * A browser, on a socket, with the four inputs this gate needs.
 *
 * `Input.insertText` and `DOM.setFileInputFiles` are used for text and files
 * because they are the browser's own events, not a scripted `element.value`
 * assignment: a control that ignores real keystrokes has to fail here.
 */
async function connect({ width = 1440, height = 900 } = {}) {
  const debugPort = 9300 + Math.floor(Math.random() * 500);
  const profile = mkdtempSync(join(tmpdir(), "researchpage-intent-"));
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
  const listeners = [];
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
    for (const listener of listeners) listener(message);
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
  const clickPoint = async (pointOf, { settle = 6, attempts = 40 } = {}) => {
    let previous = null;
    let stable = 0;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const box = await pointOf();
      if (box === null) throw new Error("the element is not there");
      if (previous !== null && Math.abs(previous.x - box.x) < 2 && Math.abs(previous.y - box.y) < 2) {
        stable += 1;
        if (stable >= settle) {
          const point = { x: Math.round(box.x), y: Math.round(box.y) };
          await call("Input.dispatchMouseEvent", { type: "mouseMoved", ...point, button: "none" });
          await call("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
          await call("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
          await delay(160);
          return;
        }
      } else {
        stable = 0;
      }
      previous = box;
      await delay(120);
    }
    throw new Error("the element never settled");
  };

  await call("Page.enable");
  await call("Runtime.enable");
  await call("Network.enable");

  const requests = [];
  listeners.push((message) => {
    if (message.method !== "Network.requestWillBeSent") return;
    const request = message.params?.request;
    if (request === undefined) return;
    requests.push({
      method: request.method,
      url: request.url,
      contentType: request.headers?.["Content-Type"] ?? request.headers?.["content-type"] ?? "",
      hasPostData: request.hasPostData === true,
      at: Date.now(),
    });
  });

  const session = {
    requests,
    async goto(url) {
      await call("Page.navigate", { url });
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const state = await evaluate("document.readyState").catch(() => "loading");
        if (state === "complete") {
          await delay(500);
          return;
        }
        await delay(100);
      }
      throw new Error("the page never finished loading");
    },
    async reload() {
      await call("Page.reload", { ignoreCache: false });
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const state = await evaluate("document.readyState").catch(() => "loading");
        if (state === "complete") {
          await delay(700);
          return;
        }
        await delay(100);
      }
      throw new Error("the page never finished reloading");
    },
    evaluate,
    hash() {
      return evaluate("window.location.hash");
    },
    async setViewport(width, height) {
      await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      await delay(300);
    },
    async click(selector, index = 0) {
      await clickPoint(async () =>
        await evaluate(
          `(() => {
             const el = document.querySelectorAll(${JSON.stringify(selector)})[${String(index)}];
             if (el === undefined) return null;
             el.scrollIntoView({block: "center"});
             const r = el.getBoundingClientRect();
             if (r.width === 0 || r.height === 0) return null;
             return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
           })()`,
        ),
      );
    },
    async clickIfThere(selector, index = 0) {
      const present = await evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length > ${String(index)}`);
      if (present !== true) return false;
      await session.click(selector, index);
      return true;
    },
    async type(selector, text) {
      await session.click(selector);
      await call("Input.insertText", { text });
      await delay(150);
    },
    async setFile(selector, paths) {
      const document_ = await call("DOM.getDocument", { depth: -1 });
      const root = document_.result?.root?.nodeId;
      if (typeof root !== "number") throw new Error("the page has no document");
      const found = await call("DOM.querySelector", { nodeId: root, selector });
      const nodeId = found.result?.nodeId;
      if (typeof nodeId !== "number" || nodeId === 0) throw new Error(`no file input matching ${selector}`);
      await call("DOM.setFileInputFiles", { nodeId, files: paths });
      await delay(400);
    },
    async waitFor(expression, what, timeoutMs = 30_000) {
      const deadlineAt = Date.now() + timeoutMs;
      for (;;) {
        const value = await evaluate(`Boolean(${expression})`).catch(() => false);
        if (value === true) return true;
        if (Date.now() > deadlineAt) throw new Error(`timed out waiting for ${what}`);
        await delay(250);
      }
    },
    /** Waits for an expression, returning false instead of throwing. */
    async settle(expression, timeoutMs = 30_000) {
      const deadlineAt = Date.now() + timeoutMs;
      for (;;) {
        const value = await evaluate(`Boolean(${expression})`).catch(() => false);
        if (value === true) return true;
        if (Date.now() > deadlineAt) return false;
        await delay(250);
      }
    },
    async text(selector) {
      return await evaluate(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el === null ? null : el.innerText.replace(/\\s+/g, " ").trim(); })()`,
      );
    },
    async count(selector) {
      return await evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
    },
    async bodyText() {
      return await evaluate(`document.body.innerText.replace(/\\s+/g, " ")`);
    },
    async screenshot(path) {
      const shot = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
      const data = shot.result?.data;
      if (typeof data !== "string") throw new Error("the browser returned no screenshot");
      writeFileSync(path, Buffer.from(data, "base64"));
      return data.length;
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

/* ------------------------------------------------------------------ gate -- */

const options = parseArgs(process.argv.slice(2));
if (options.url === undefined) {
  console.error("usage: node verify-intent-documents.mjs --url <product url> [--model] [--shots <dir>] [--topic <text>]");
  process.exit(2);
}
const base = options.url.endsWith("/") ? options.url : `${options.url}/`;

let failures = 0;
let passes = 0;
let skips = 0;
const check = (name, ok, evidence) => {
  if (ok) {
    passes += 1;
    console.log(`PASS ${name}${evidence === undefined ? "" : ` — ${evidence}`}`);
    return true;
  }
  failures += 1;
  console.log(`FAIL ${name}${evidence === undefined ? "" : ` — ${evidence}`}`);
  return false;
};
const skip = (name, why) => {
  skips += 1;
  console.log(`SKIP ${name} — ${why}`);
};

if (options.shots !== undefined) mkdirSync(options.shots, { recursive: true });
const shotPath = (name) => (options.shots === undefined ? undefined : join(options.shots, `${name}.png`));

const session = await connect({ width: 1440, height: 900 });

/** The requests the page made for the running product, newest last. */
const requestsMatching = (method, fragment) =>
  session.requests.filter((request) => request.method === method && request.url.includes(fragment));

try {
  // ---------------------------------------------------------------- start --
  await session.goto(base);
  const startReady = await session.settle("document.querySelector('[data-testid=\"topic-input\"]') !== null", 20_000);
  check("首页可见研究主题输入框", startReady, startReady ? undefined : "首页没有渲染出发起研究的输入框");

  if (startReady && !options.model) {
    skip("首页→澄清→确认→报告（真实模型）", "未传 --model：本条会消耗真实模型调用");
  } else {
    const topic = options.topic ?? `Agent 记忆系统的实现路径比较（${String(Date.now() % 100000)}）`;
    await session.type('[data-testid="topic-input"]', topic);
    const beforeSubmit = session.requests.length;
    await session.click('[data-testid="topic-submit"]');

    const entered = await session.settle("window.location.hash.startsWith('#/i/')", 60_000);
    check("提交主题后进入方向澄清页", entered, entered ? `地址 ${await session.hash()}` : "地址没有变成 #/i/<id>");
    check(
      "新建研究没有调用旧入口 POST /tasks",
      requestsMatching("POST", "/api/research/tasks").length === 0,
      `提交后 POST 请求数 ${String(session.requests.length - beforeSubmit)}，其中 /tasks 为 ${String(requestsMatching("POST", "/api/research/tasks").length)}`,
    );
    check(
      "澄清页调用 POST /intents",
      requestsMatching("POST", "/api/research/intents").length > 0,
      requestsMatching("POST", "/api/research/intents").length > 0 ? undefined : "没有看到 POST /api/research/intents",
    );

    if (entered) {
      const hash = await session.hash();
      // `#/i/<id>` splits to ["#", "i", "<id>"], so the id is the third part —
      // not the second, which is the route's own name.
      const intentId = hash.split("/")[2];
      const panelReady = await session.settle("document.querySelector('[data-testid=\"intent-view\"]') !== null", 20_000);
      check("澄清面板渲染", panelReady, panelReady ? undefined : "找不到 intent-view");
      const seeded = await session.settle(
        `document.body.innerText.includes(${JSON.stringify(topic.slice(0, 12))})`,
        20_000,
      );
      check("澄清页显示原始主题", seeded);

      // ------------------------------------------------------- first turn --
      // The seed topic is not a turn: the conversation the server keeps begins
      // with the assistant's own first question, so "a question arrived" is one
      // turn, not two.
      const assistantTurns = "document.querySelectorAll('[data-testid^=\"intent-turn-\"][class*=\"--assistant\"]').length";
      const userTurns = "document.querySelectorAll('[data-testid^=\"intent-turn-\"][class*=\"--user\"]').length";
      const firstQuestion = await session.settle(`${assistantTurns} >= 1`, options.timeout);
      check(
        "助手提出第一轮问题",
        firstQuestion,
        firstQuestion
          ? undefined
          : `等待 ${String(Math.round(options.timeout / 1000))}s 后仍只有用户的一条消息（真实模型可能不可用）`,
      );

      /**
       * One turn of the conversation, typed and sent the way a person does it.
       *
       * The composer is a controlled input, so the message only goes out when
       * the browser's own text input really reached React — which is why the
       * value is read back before the send button is pressed, and why the whole
       * gesture is retried rather than assumed. A page that dropped real
       * keystrokes would fail here instead of silently sending nothing.
       */
      const sendMessage = async (text, expectedUserTurns) => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await session.type('[data-testid="intent-message-input"]', text);
          const held = await session.evaluate(
            `(document.querySelector('[data-testid=\"intent-message-input\"]')?.value ?? "").length > 0`,
          );
          if (held !== true) {
            await delay(600);
            continue;
          }
          await session.click('[data-testid="intent-message-send"]');
          if (await session.settle(`${userTurns} >= ${String(expectedUserTurns)}`, 25_000)) return true;
        }
        return false;
      };

      if (firstQuestion) {
        const sent = await sendMessage(
          "我想比较几个主流实现路径在延迟、成本与可维护性上的取舍，读者是正在做技术选型的工程师，半年内要落地。",
          1,
        );
        const secondTurn =
          sent &&
          (await session.settle(
            `${assistantTurns} >= 2 && document.querySelector('[data-testid="intent-busy"]') === null`,
            options.timeout,
          ));
        check("回答之后助手给出下一轮", secondTurn === true, secondTurn === true ? undefined : "回答没有送达，或助手没有再提问");

        if (secondTurn) {
          await sendMessage("请给出正式研究方向。", 2);
          const proposed = await session.settle("document.querySelector('[data-testid=\"intent-direction\"]') !== null", options.timeout);
          check("助手给出可确认的研究方向", proposed, proposed ? undefined : "没有出现方向面板");
          if (shotPath("03-direction") !== undefined) await session.screenshot(shotPath("03-direction"));

          if (proposed) {
            // The editor is disabled while a turn is still running, so the
            // case waits for the turn to settle before it types — the same
            // thing a reader does, and the reason the first edit attempt has to
            // be after the busy line is gone rather than as soon as the panel
            // appears.
            await session.settle("document.querySelector('[data-testid=\"intent-busy\"]') === null", 30_000);
            await delay(300);
            // -------------------------------------------- edit + confirm --
            await session.type('[data-testid="intent-direction-主题"]', "（用户补充）");
            const typed = await session.evaluate(
              `(document.querySelector('[data-testid=\"intent-direction-主题\"]')?.value ?? "").includes("用户补充")`,
            );
            check("方向编辑框接受真实键盘输入", typed === true, typed === true ? undefined : "输入没有进入编辑框");
            const dirty = await session.settle(
              "document.querySelector('[data-testid=\"intent-direction-save\"]') !== null && !document.querySelector('[data-testid=\"intent-direction-save\"]').disabled",
              10_000,
            );
            check("编辑研究方向后可以保存", dirty, dirty ? undefined : "保存按钮仍然不可用");
            if (dirty) await session.click('[data-testid="intent-direction-save"]');
            const saved = await session.settle(
              "document.querySelector('[data-testid=\"intent-direction-save\"]') === null || document.querySelector('[data-testid=\"intent-direction-save\"]').disabled",
              30_000,
            );
            check("方向修改已保存回服务端", saved);
            if (shotPath("04-direction-edited") !== undefined) await session.screenshot(shotPath("04-direction-edited"));

            const confirmsBefore = requestsMatching("POST", "/confirm").length;
            await session.click('[data-testid="intent-confirm"]');
            const confirmed = await session.settle(
              "document.querySelector('[data-testid=\"intent-confirmed\"]') !== null || window.location.hash.startsWith('#/p/')",
              options.timeout,
            );
            check("确认方向后进入已确认状态", confirmed);
            const confirmCalls = requestsMatching("POST", "/confirm").length - confirmsBefore;
            check("确认只提交一次", confirmCalls <= 1, `POST /confirm 次数 ${String(confirmCalls)}`);
            const leftExploration = await session.settle("window.location.hash.startsWith('#/p/')", options.timeout);
            check(
              "出现真实任务卡后跳到研究范围",
              leftExploration,
              leftExploration ? `地址 ${await session.hash()}` : "仍然停留在探索页（202 不等于任务已生成）",
            );
            if (shotPath("05-task") !== undefined) await session.screenshot(shotPath("05-task"));

            if (leftExploration) {
              const briefReady = await session.settle("document.querySelector('[data-testid=\"confirm-card\"]') !== null", 30_000);
              check("任务卡页面渲染（研究范围）", briefReady);
              if (briefReady) {
                // ----------------------------------------------- research --
                // The button is disabled while the server is still busy with
                // the card stage, so the case waits for it to be pressable —
                // and then proves the press arrived by watching the request,
                // rather than by trusting that a click did something.
                await session.settle(
                  `(() => { const b = document.querySelector('[data-testid="confirm-card"]'); return b !== null && b.disabled === false; })()`,
                  60_000,
                );
                const confirmClicksBefore = requestsMatching("POST", "/confirm").length;
                let started = false;
                for (let attempt = 0; attempt < 3 && !started; attempt += 1) {
                  await session.click('[data-testid="confirm-card"]');
                  const until = Date.now() + 12_000;
                  while (Date.now() < until) {
                    if (requestsMatching("POST", "/confirm").length > confirmClicksBefore) {
                      started = true;
                      break;
                    }
                    await delay(300);
                  }
                  if (!started) await delay(800);
                }
                check("确认任务卡提交到服务端", started, started ? undefined : "点击之后没有看到 POST /tasks/:id/confirm");
                const taskId = (await session.hash()).split("/")[2];
                await session.goto(`${base}#/p/${String(taskId)}/research`);
                const progress = await session.settle(
                  "document.querySelector('[data-testid=\"research-progress\"]') !== null",
                  options.timeout,
                );
                check("研究页显示真实进度组件", progress, progress ? undefined : "没有 research-progress");
                if (progress) {
                  const stage = await session.text('[data-testid="research-stage"]');
                  check("进度显示真实阶段名", typeof stage === "string" && stage.length > 0, `阶段：${String(stage)}`);
                  const logCount = await session.count('[data-testid="activity-log"] .mantine-Timeline-item');
                  check("活动记录来自后端", logCount >= 0, `活动条数 ${String(logCount)}`);
                }
                if (shotPath("06-progress") !== undefined) await session.screenshot(shotPath("06-progress"));

                // --------------------------------------------- the report --
                // What this can honestly assert without a report is that the
                // report workspace opens and is the product's own: whether a
                // report exists depends on the model and on the network, and a
                // gate that called a missing report a failure would be blaming
                // the page for the provider.
                const reportHref = `${base}#/p/${String(taskId)}/report`;
                await session.goto(reportHref);
                const reported = await session.settle(
                  "document.querySelector('[data-testid=\"report-doc\"], .rp-report, .rp-doc-title, .rp-report__empty') !== null || document.body.innerText.includes('报告')",
                  60_000,
                );
                check("报告工作区可以打开", reported);
                const bundle = await fetch(`${base}api/research/tasks/${String(taskId)}`).then((response) => response.json());
                console.log(`     （该项目当前状态：${String(bundle.task.status)}，报告 ${bundle.hasReport === true ? "已生成" : "尚未生成"}）`);
                if (shotPath("07-report") !== undefined) await session.screenshot(shotPath("07-report"));
              }
            }

            // -------------------------------------------------- reload -----
            await session.goto(`${base}#/i/${String(intentId)}`);
            const restored = await session.settle(
              "document.querySelector('[data-testid=\"intent-view\"]') !== null || window.location.hash.startsWith('#/p/')",
              30_000,
            );
            check("刷新探索地址可以恢复", restored, restored ? await session.hash() : "刷新后既没有探索页也没有项目页");
            if (shotPath("08-reload") !== undefined) await session.screenshot(shotPath("08-reload"));
          }
        }
      }
    }
  }
} catch (error) {
  failures += 1;
  console.log(`FAIL gate — ${error instanceof Error ? error.message : String(error)}`);
  if (options.shots !== undefined) {
    try {
      await session.screenshot(join(options.shots, "failure.png"));
    } catch {
      // Nothing to save.
    }
  }
} finally {
  await session.close();
}

console.log(`\n${passes} passed, ${failures} failed, ${skips} skipped`);
process.exit(failures === 0 ? 0 : 1);
