/**
 * The trust-UX browser acceptance: what a reader sees, and whether it is true.
 *
 * It drives a *running* product over the DevTools protocol, with real mouse
 * input, and checks the sentences the product is allowed to say and the
 * controls it is allowed to offer: three workspaces and nothing else in the
 * navigation, one honest status line with the six facts behind it, a 补查 that
 * answers「问题解决了吗」before it counts anything, an evidence panel that
 * shows this action's three excerpts rather than the project's two hundred, a
 * proposal that is a decision while it is pending and one line of history
 * after, and no internal word anywhere a reader can see.
 *
 *   node apps/research/scripts/verify-trust-ux.mjs \
 *     --url http://127.0.0.1:4599/ \
 *     --task <project with fixture runs and proposals> \
 *     --warnings-task <project whose report carries quality warnings> \
 *     --shots <dir>
 *
 * It prints one PASS/FAIL line per case and exits non-zero if any case failed.
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

const FORBIDDEN = [
  "Q01",
  "Q02",
  "Q03",
  "Q04",
  "Q05",
  "Q06",
  "Q07",
  "Q08",
  "Q09",
  "Q10",
  "Q11",
  "Q12",
  "synthesis",
  "conditions.",
  "claimId",
  "claim id",
  "sourceId",
  "evidenceId",
  "sub_",
  "dim_",
  "clm_",
  "ev_",
  "contentHash",
  "ActionGrant",
  "gapRounds",
  "tool call",
];

function parseArgs(argv) {
  const options = { url: undefined, task: undefined, warningsTask: undefined, shots: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1];
    switch (argv[index]) {
      case "--url":
        options.url = value;
        index += 1;
        break;
      case "--task":
        options.task = value;
        index += 1;
        break;
      case "--warnings-task":
        options.warningsTask = value;
        index += 1;
        break;
      case "--shots":
        options.shots = value;
        index += 1;
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

async function connect({ width = 1440, height = 900 } = {}) {
  const debugPort = 9300 + Math.floor(Math.random() * 500);
  const profile = mkdtempSync(join(tmpdir(), "researchpage-trust-"));
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
        await delay(160);
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
      for (let attempt = 0; attempt < 150; attempt += 1) {
        const state = await evaluate("document.readyState").catch(() => "loading");
        if (state === "complete") {
          await delay(400);
          return;
        }
        await delay(100);
      }
      throw new Error("the page never finished loading");
    },
    evaluate,
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
             return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
           })()`,
        ),
      );
    },
    async waitFor(expression, what, timeoutMs = 20_000) {
      const deadlineAt = Date.now() + timeoutMs;
      for (;;) {
        const value = await evaluate(`Boolean(${expression})`).catch(() => false);
        if (value === true) return;
        if (Date.now() > deadlineAt) throw new Error(`timed out waiting for ${what}`);
        await delay(150);
      }
    },
    async text(selector) {
      return await evaluate(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el === null ? null : el.innerText.replace(/\\s+/g, " ").trim(); })()`,
      );
    },
    /**
     * The text of the *last* element the selector matches.
     *
     * A conversation can hold several panels of the same kind — a decided
     * proposal folded to a line, a pending one in full — and the one the case
     * is about is the newest turn, not the oldest.
     */
    async textLast(selector) {
      return await evaluate(
        `(() => { const els = document.querySelectorAll(${JSON.stringify(selector)}); const el = els[els.length - 1]; return el === undefined ? null : el.innerText.replace(/\\s+/g, " ").trim(); })()`,
      );
    },
    async bodyText() {
      return await evaluate(`document.body.innerText.replace(/\\s+/g, " ")`);
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

/* ------------------------------------------------------------------ gate -- */

const options = parseArgs(process.argv.slice(2));
if (options.url === undefined) {
  console.error("usage: node verify-trust-ux.mjs --url <product url> [--task <id>] [--warnings-task <id>] [--shots <dir>]");
  process.exit(2);
}
const base = options.url.endsWith("/") ? options.url : `${options.url}/`;

let failures = 0;
let passes = 0;
const check = (name, ok, evidence) => {
  if (ok) {
    passes += 1;
    console.log(`PASS  ${name} — ${evidence}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${name} — ${evidence}`);
  }
};
const skip = (name, why) => {
  console.log(`SKIP  ${name} — ${why}`);
};

const shots = options.shots;
if (shots !== undefined) mkdirSync(shots, { recursive: true });
const session = await connect({ width: 1440, height: 900 });

/** The assistant is a toggle: open it, but never close it by accident. */
async function openAssistant() {
  const open = await session.evaluate(`document.querySelector('[data-testid="assistant-input"]') !== null`);
  if (open === true) return;
  await session.click('[data-testid="open-assistant"]');
}

try {
  const tasks = (await (await fetch(`${base}api/research/tasks`)).json()).tasks;
  const taskId = options.task ?? tasks.find((task) => task.hasReport)?.id;
  const warningsTaskId = options.warningsTask ?? tasks.find((task) => task.hasReport && task.id !== taskId)?.id;
  if (taskId === undefined) throw new Error("no project with a report to drive");
  console.log(`# project: ${taskId}${warningsTaskId === undefined ? "" : ` · warnings project: ${warningsTaskId}`}`);
  const withReport = tasks.filter((task) => task.hasReport).length;

  /* ------------------------------------------------- information architecture */

  await session.goto(`${base}#/p/${taskId}/report`);
  await session.waitFor(`document.querySelector('[data-testid="studio"]') !== null`, "the report");
  const nav = await session.evaluate(
    `(() => {
       const items = [...document.querySelectorAll('[data-testid="project-nav"] button[data-testid^="nav-"]')];
       return items.map((item) => ({
         label: item.textContent.replace(/\\s+/g, " ").trim(),
         key: item.getAttribute("data-testid"),
         current: item.getAttribute("aria-current") === "true",
       }));
     })()`,
  );
  const labels = nav.map((item) => item.label.replace(/\d+.*$/, "").trim());
  check(
    "主导航只有报告 / 研究 / 来源，顺序固定",
    nav.length === 3 &&
      nav[0].key === "nav-report" &&
      nav[1].key === "nav-research" &&
      nav[2].key === "nav-sources" &&
      !nav.some((item) => item.label.includes("模板")),
    nav.map((item) => `${item.label}${item.current ? "（当前）" : ""}`).join(" · "),
  );
  check("当前页面在导航里被标出", nav[0]?.current === true, `报告 current=${String(nav[0]?.current)}`);

  const bar = await session.evaluate(`document.querySelector('[data-testid="project-status"]')?.innerText ?? ""`);
  const barRaw = await session.evaluate(
    `(() => { const bar = document.querySelector(".rp-bar"); return bar === null ? "" : bar.innerText.replace(/\\s+/g, " "); })()`,
  );
  check(
    "顶栏只说项目在发生什么，不再常驻检索/读取额度",
    bar.length > 0 && !/搜索 \d+\/\d+/.test(barRaw) && !/读取 \d+\/\d+/.test(barRaw),
    barRaw.slice(0, 120),
  );
  check(
    "顶栏状态不把材料覆盖说成「无待查项」",
    !barRaw.includes("无待查项") && (bar.includes("未解决") || bar.includes("可阅读") || bar.includes("待复核") || bar.includes("待确认")),
    `状态：${bar}`,
  );

  await session.click('[data-testid="project-status"]');
  await session.waitFor(`document.querySelector('[data-testid="status-detail"]') !== null`, "the status detail");
  const detail = await session.text('[data-testid="status-detail"]');
  const detailRows = await session.evaluate(
    `[...document.querySelectorAll('[data-testid="status-detail"] dt')].map((el) => el.innerText.trim())`,
  );
  check(
    "点击状态能看到并列的事实（材料覆盖 / 研究判断 / 报告 / 质量检查 / 来源）",
    ["当前动作", "材料覆盖", "研究判断", "报告", "质量检查", "来源"].every((label) => detailRows.includes(label)),
    detailRows.join(" · "),
  );
  check(
    "材料覆盖不冒充结论",
    detail.includes("材料覆盖不等于结论完成"),
    detail.slice(0, 60),
  );
  if (shots !== undefined) await session.screenshot(join(shots, "status-detail.png"));
  await session.evaluate(`document.body.click()`);
  await session.click('[data-testid="project-status"]');
  await session.waitFor(`document.querySelector('[data-testid="status-detail"]') === null`, "the status detail to close", 8_000);

  if (shots !== undefined) await session.screenshot(join(shots, "report-main-1440.png"));

  /* ------------------------------------------------------- scope entry */

  await session.click('[data-testid="scope-entry"]');
  await session.waitFor(`location.hash.endsWith("/brief")`, "the scope");
  const briefKicker = await session.evaluate(
    `document.querySelector(".rp-brief__head .rp-kicker")?.innerText ?? document.querySelector(".rp-kicker")?.innerText ?? ""`,
  );
  check(
    "研究范围仍在项目标题旁可达，并且进去还是原来的页面",
    briefKicker.includes("研究范围"),
    `#/p/.../brief · ${briefKicker}`,
  );
  if (shots !== undefined) await session.screenshot(join(shots, "brief-entry.png"));

  /* -------------------------------------------------------------- styles */

  await session.goto(`${base}#/p/${taskId}/report`);
  await session.waitFor(`document.querySelector('[data-testid="studio"]') !== null`, "the report");
  await session.click('[data-testid="theme-menu"]');
  await session.waitFor(`document.querySelector('[data-testid="theme-option-swiss"]') !== null`, "the style menu");
  const themeLabel = await session.text('[data-testid="theme-menu"]');
  const themeText = await session.text(".mantine-Menu-dropdown");
  if (shots !== undefined) await session.screenshot(join(shots, "report-theme-menu.png"));
  await session.click('[data-testid="theme-option-swiss"]');
  await session.waitFor(`document.querySelector('.rp-doc[data-theme="swiss"]') !== null`, "the swiss document");
  const themeAfter = await session.text('[data-testid="theme-menu"]');
  check(
    "样式在报告工具栏里切换（不叫模板，也不用离开报告）",
    themeLabel.includes("样式") &&
      themeText.includes("Editorial") &&
      themeText.includes("Swiss") &&
      !themeText.includes("模板"),
    `${themeLabel} → ${themeAfter} · 菜单含 Editorial/Swiss · 正文已按 Swiss 重排`,
  );

  /* ------------------------------------------------------ quality detail */

  if (warningsTaskId === undefined) {
    skip("质量核验详情", "没有带 warnings 的项目");
  } else {
    await session.goto(`${base}#/p/${warningsTaskId}/report`);
    await session.waitFor(`document.querySelector('[data-testid="studio"]') !== null`, "the report");
    const chip = await session.evaluate(
      `document.querySelector('[data-testid="quality-chip"]')?.innerText.replace(/\\s+/g, " ").trim() ?? null`,
    );
    if (chip === null) {
      skip("质量核验详情", "这个项目没有需要核验的项");
    } else {
      await session.click('[data-testid="quality-chip"]');
      await session.waitFor(`document.querySelector('[data-testid="quality-detail"]') !== null`, "the detail");
      const detailText = await session.text('[data-testid="quality-detail"]');
      const technicalOpen = await session.evaluate(
        `document.querySelector('[data-testid="quality-technical"]')?.open === true`,
      );
      check(
        "工具栏说「需要进一步核验 · n」，详情里是人类语言的句子",
        chip.includes("需要进一步核验") && detailText.includes("核验详情") && technicalOpen === false,
        `${chip} · 技术细节默认折叠=${String(technicalOpen === false)}`,
      );
      await session.evaluate(`document.body.click()`);
    }
  }

  /* ------------------------------------------------------- sources roles */

  await session.goto(`${base}#/p/${taskId}/sources`);
  await session.waitFor(`document.querySelector('[data-testid="source-summary"]') !== null`, "the sources");
  await session.waitFor(`document.querySelectorAll('[data-testid^="source-row-"]').length > 0`, "source rows");
  const summary = await session.text('[data-testid="source-summary"]');
  const sourcesBody = await session.bodyText();
  check(
    "未分类的来源不说成「0 个一手材料」",
    summary.includes("尚未分类") && !summary.includes("0 个一手材料") && !summary.includes("0 个一手来源"),
    summary.slice(0, 90),
  );
  check(
    "来源行里不出现内部 id",
    !/src_[0-9a-f]{8}/.test(sourcesBody),
    "表格文本里没有 src_… 前缀的标识符",
  );
  if (shots !== undefined) await session.screenshot(join(shots, "sources-main-1440.png"));

  /* ------------------------------------------------------------- research */

  await session.goto(`${base}#/p/${taskId}/research`);
  await session.waitFor(`document.querySelector('[data-testid="evidence-matrix"]') !== null`, "the matrix");
  const matrixText = await session.evaluate(
    `document.querySelector('[data-testid="evidence-matrix"]').innerText.replace(/\\s+/g, " ")`,
  );
  check(
    "矩阵状态用读者的话：缺少依据 / 有材料，待核对 / 已核对 / 证据冲突",
    matrixText.includes("有材料，待核对") && matrixText.includes("已核对") && !matrixText.includes("冲突 / 不可比"),
    matrixText.slice(0, 80),
  );
  if (shots !== undefined) await session.screenshot(join(shots, "research-main-1440.png"));

  /* ------------------------------------------------------ research outcome */

  await session.goto(`${base}#/p/${taskId}/report`);
  await session.waitFor(`document.querySelector('[data-testid="studio"]') !== null`, "the report");
  await openAssistant();
  await session.waitFor(`document.querySelector('[data-testid="assistant-thread"]') !== null`, "the conversation");

  const turns = await session.evaluate(
    `[...document.querySelectorAll('[data-testid="research-outcome"]')].map((node) => ({
       status: node.getAttribute("data-status"),
       verdict: node.querySelector('[data-testid="research-verdict"]')?.innerText.trim() ?? "",
       text: node.innerText.replace(/\\s+/g, " ").trim(),
     }))`,
  );
  const unresolved = turns.find((turn) => turn.status === "unresolved");
  check(
    "未解决的补查先说「未解决」，并说清仍缺少什么",
    unresolved !== undefined &&
      unresolved.verdict === "未解决" &&
      unresolved.text.includes("仍缺少") &&
      !unresolved.text.includes("找到可用材料"),
    unresolved === undefined ? "没有未解决的补查" : unresolved.text.slice(0, 90),
  );
  const partial = turns.find((turn) => turn.status === "partially_resolved");
  check(
    "部分解决：已解决什么、仍缺什么都说",
    partial !== undefined && partial.verdict === "部分解决" && partial.text.includes("已解决") && partial.text.includes("仍缺少"),
    partial === undefined ? "没有部分解决的补查" : partial.text.slice(0, 90),
  );
  check(
    "本轮活动（次数）折叠在结果之后",
    (await session.evaluate(
      `[...document.querySelectorAll('[data-testid="research-activity"]')].length > 0 &&
       [...document.querySelectorAll('[data-testid="research-activity"]')].every((node) => node.open === false)`,
    )) === true,
    "折叠的 <details> 全部处于关闭状态",
  );
  if (shots !== undefined) {
    await session.evaluate(
      `document.querySelector('[data-status="unresolved"]')?.scrollIntoView({block: "center"})`,
    );
    await delay(250);
    await session.screenshot(join(shots, "research-unresolved.png"));
    await session.evaluate(
      `document.querySelector('[data-status="partially_resolved"]')?.scrollIntoView({block: "center"})`,
    );
    await delay(250);
    await session.screenshot(join(shots, "research-partial.png"));
  }

  const refused = await session.evaluate(
    `(() => { const node = document.querySelector('[data-testid="edit-outcome"]'); return node === null ? null : node.innerText.replace(/\\s+/g, " ").trim(); })()`,
  );
  check(
    "没有形成的修改建议：说原因、说正文没变、没有接受按钮",
    refused !== null &&
      refused.includes("这次改写没有形成可接受的修改建议") &&
      refused.includes("报告正文没有改变") &&
      (await session.evaluate(
        `(() => { const node = document.querySelector('[data-testid="edit-outcome"]'); const scope = node?.parentElement?.parentElement ?? null; return scope !== null && !scope.innerText.includes("接受这一节") && scope.querySelector('[data-testid="accept-proposal"]') === null; })()`,
      )) === true,
    refused === null ? "对话里没有这次失败的修改" : refused.slice(0, 80),
  );
  if (shots !== undefined) {
    await session.evaluate(`document.querySelector('[data-testid="edit-outcome"]')?.scrollIntoView({block: "center"})`);
    await delay(250);
    await session.screenshot(join(shots, "proposal-not-created.png"));
  }

  /* ------------------------------------------------------- action evidence */

  const inspectable = (await session.evaluate(
    `document.querySelectorAll('[data-testid="inspect-action-evidence"]').length`,
  )) > 0;
  if (!inspectable) {
    skip("查看本轮证据", "这次对话里没有可检查的补查");
  } else {
    const turnsBefore = await session.evaluate(
      `document.querySelectorAll('[data-testid="assistant-msg-user"]').length`,
    );
    await session.evaluate(
      `document.querySelector('[data-testid="inspect-action-evidence"]').scrollIntoView({block: "center"})`,
    );
    await session.click('[data-testid="inspect-action-evidence"]');
    await session.waitFor(`document.querySelector('[data-testid="action-evidence"]') !== null`, "this action's evidence");
    const panel = await session.text('[data-testid="action-evidence"]');
    const delta = await session.text('[data-testid="action-delta"]');
    check(
      "查看本轮证据：只打开这次动作带来的材料",
      panel.includes("新增来源") &&
        panel.includes("新增证据") &&
        panel.includes("对应的支持评估") &&
        panel.includes("仍未解决的缺口"),
      panel.replace(/\s+/g, " ").slice(0, 110),
    );
    check("本轮新增按真实 delta 说", /个来源/.test(delta) || delta.includes("没有找到新的材料"), delta);
    if (shots !== undefined) await session.screenshot(join(shots, "action-evidence.png"));

    await session.waitFor(`document.querySelector('[data-testid="back-to-conversation"]') !== null`, "the way back");
    await session.click('[data-testid="back-to-conversation"]');
    await session.waitFor(`document.querySelector('[data-testid="assistant-input"]') !== null`, "the conversation");
    const turnsAfter = await session.evaluate(
      `document.querySelectorAll('[data-testid="assistant-msg-user"]').length`,
    );
    check(
      "从本轮证据返回对话：对话没有丢",
      turnsBefore === turnsAfter && turnsAfter > 0,
      `${String(turnsAfter)} 轮仍在`,
    );
  }

  /* --------------------------------------------------------------- proposal */

  const pending = await session.evaluate(
    `document.querySelector('[data-testid="proposal-status"]') === null ? null : document.querySelector('[data-testid="proposal-status"]').innerText.trim()`,
  );
  if (pending === null) {
    skip("待确认的修改建议", "对话里没有待确认的提案");
  } else {
    const status = await session.text('[data-testid="proposal-status"]');
    const delta = await session.text('[data-testid="proposal-delta"]');
    const panel = await session.textLast('[data-testid="assistant-proposal"]');
    const hasDecision = await session.evaluate(
      `document.querySelector('[data-testid="accept-proposal"]') !== null && document.querySelector('[data-testid="discard-proposal"]') !== null`,
    );
    check(
      "待确认的提案完整展开：状态、目标、理由、当前与否两版、接受与放弃",
      status.includes("待确认") &&
        panel.includes("目标：") &&
        panel.includes("现在的正文") &&
        panel.includes("修改后") &&
        panel.includes("放弃提案") &&
        hasDecision === true,
      `${status} · delta=${delta}`,
    );
    check(
      "delta=0 时明说「本次修改没有新增研究材料」",
      delta.includes("本次修改没有新增研究材料"),
      delta,
    );
    check(
      "提案面板里不出现内容 hash 与内部 id",
      !/sha256:|hash [0-9a-f]{6}/.test(panel) && !/clm_[0-9a-z]/.test(panel),
      panel.replace(/\s+/g, " ").slice(0, 90),
    );
    if (shots !== undefined) {
      await session.evaluate(
        `(() => { const els = document.querySelectorAll('[data-testid="assistant-proposal"]'); els[els.length - 1]?.scrollIntoView({block: "center"}); return true; })()`,
      );
      await delay(300);
      await session.screenshot(join(shots, "proposal-pending.png"));
    }
  }

  const history = await session.evaluate(
    `[...document.querySelectorAll('[data-testid="proposal-history"]')].map((node) => node.innerText.replace(/\\s+/g, " ").trim())`,
  );
  check(
    "已决定的提案折叠成一行，展开按钮就在那里",
    history.length > 0 &&
      history.every((line) => line.length < 80) &&
      (await session.evaluate(`document.querySelectorAll('[data-testid="expand-proposal"]').length`)) === history.length,
    history.join(" | ").slice(0, 110),
  );
  if (shots !== undefined && history.length > 0) {
    await session.evaluate(`document.querySelector('[data-testid="proposal-history"]')?.scrollIntoView({block: "center"})`);
    await delay(250);
    await session.screenshot(join(shots, "proposal-accepted-collapsed.png"));
  }

  /* ------------------------------------------------------------ terminology */

  const pages = [
    { name: "报告", hash: `#/p/${taskId}/report` },
    { name: "研究", hash: `#/p/${taskId}/research` },
    { name: "来源", hash: `#/p/${taskId}/sources` },
    { name: "研究范围", hash: `#/p/${taskId}/brief` },
  ];
  const found = [];
  for (const page of pages) {
    await session.goto(`${base}${page.hash}`);
    await delay(600);
    const text = await session.bodyText();
    for (const token of FORBIDDEN) {
      if (text.includes(token)) found.push(`${page.name}: ${token}`);
    }
  }
  await session.goto(`${base}#/p/${taskId}/report`);
  await openAssistant();
  await session.waitFor(`document.querySelector('[data-testid="assistant-thread"]') !== null`, "the conversation");
  const chatText = await session.bodyText();
  for (const token of FORBIDDEN) {
    if (chatText.includes(token)) found.push(`对话: ${token}`);
  }
  check(
    "普通界面没有内部术语（Qxx / synthesis / 内部 id / contentHash / grant）",
    found.length === 0,
    found.length === 0 ? "五处页面全文都没有命中" : found.join(", "),
  );

  /* --------------------------------------------------------------- toast */

  const noticeBefore = await session.evaluate(
    `document.querySelector('[role="status"].rp-note')?.innerText ?? ""`,
  );
  await session.waitFor(`document.querySelector('[data-testid="revision-menu"]') !== null`, "the report toolbar");
  const frozen = true;
  if (frozen === true) {
    await session.click('[data-testid="revision-menu"]');
    await session.waitFor(
      `[...document.querySelectorAll(".mantine-Menu-item")].some((item) => item.innerText.includes("冻结当前版本"))`,
      "the version menu",
    );
    await session.evaluate(
      `(() => { const item = [...document.querySelectorAll(".mantine-Menu-item")].find((b) => b.innerText.includes("冻结当前版本")); item?.click(); return true; })()`,
    );
    await session.waitFor(`document.querySelector('[role="status"].rp-note') !== null`, "the confirmation", 15_000);
    const said = await session.evaluate(`document.querySelector('[role="status"].rp-note').innerText.replace(/\\s+/g, " ").trim()`);
    await session.click('[data-testid="nav-research"]');
    await session.waitFor(`document.querySelector('[data-testid="evidence-matrix"]') !== null`, "the matrix");
    const leftover = await session.evaluate(`document.querySelector('[role="status"].rp-note')?.innerText ?? null`);
    check(
      "动作提示不跨页面残留",
      leftover === null,
      `提示「${said.slice(0, 40)}」在切到研究之后${leftover === null ? "已消失" : `仍在：${leftover}`}`,
    );
    check("提示出现在动作发生的页面", noticeBefore === "" && said.length > 0, said.slice(0, 60));
  } else {
    skip("动作提示不跨页面残留", "发布菜单不可用");
  }

  /* ----------------------------------------------------------- responsive */

  if (shots !== undefined) {
    for (const [width, height, name] of [
      [1366, 768, "1366-report.png"],
      [1920, 1080, "1920-report.png"],
    ]) {
      await session.setViewport(width, height);
      await session.goto(`${base}#/p/${taskId}/report`);
      await session.waitFor(`document.querySelector('[data-testid="studio-toolbar"]') !== null`, "the toolbar");
      await session.screenshot(join(shots, name));
    }
    await session.setViewport(1440, 900);
  }
  await session.goto(`${base}#/p/${taskId}/report`);
  await session.waitFor(`document.querySelector('[data-testid="studio-toolbar"]') !== null`, "the toolbar");
  for (const [width, height] of [
    [1366, 768],
    [1440, 900],
    [1920, 1080],
  ]) {
    await session.setViewport(width, height);
    const box = await session.evaluate(
      `(() => {
         const bar = document.querySelector('.rp-bar');
         const nav = document.querySelector('[data-testid="project-nav"]');
         const toolbar = document.querySelector('[data-testid="studio-toolbar"]');
         return {
           barLines: bar.getBoundingClientRect().height,
           statusClipped: (() => { const el = document.querySelector('[data-testid="project-status"]'); return el === null ? true : el.scrollWidth > el.clientWidth + 4; })(),
           navCount: nav === null ? 0 : nav.querySelectorAll('button[data-testid^="nav-"]').length,
           /* How many controls sit off the toolbar's own centre line: a
              toolbar that wrapped would leave some of them on a second row. */
           toolbarOffCentre:
             toolbar === null
               ? 9
               : (() => {
                   const r = toolbar.getBoundingClientRect();
                   const centre = r.top + r.height / 2;
                   return [...toolbar.children].filter((child) => {
                     const b = child.getBoundingClientRect();
                     if (b.height === 0) return false;
                     return Math.abs(b.top + b.height / 2 - centre) > 12;
                   }).length;
                 })(),
           overflowX: document.documentElement.scrollWidth > window.innerWidth + 2,
         };
       })()`,
    );
    check(
      `${String(width)}×${String(height)}：导航三项、工具栏不换行、状态不截断、页面不横向溢出`,
      box.navCount === 3 && box.toolbarOffCentre === 0 && box.statusClipped === false && box.overflowX === false,
      JSON.stringify(box),
    );
  }
  await session.setViewport(1440, 900);
} catch (error) {
  failures += 1;
  console.log(`FAIL  (gate) — ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await session.close();
}

console.log(`\n${String(passes)} passed, ${String(failures)} failed`);
process.exit(failures === 0 ? 0 : 1);
