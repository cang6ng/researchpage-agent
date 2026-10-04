/**
 * The strict browser acceptance gate.
 *
 * The ordinary suite treats a missing browser as a skip — that is how the
 * offline run stays honest without one. This script is the other direction: it
 * *requires* a real browser, runs the named acceptance files, and then reads
 * the machine report to prove that every required case actually ran and
 * passed. A missing browser, a failed launch, a skip, a todo, a zero-collected
 * file or a missing report are all failures here; exit code 0 alone is not
 * evidence, because a suite that skipped still exits 0.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const root = dirname(dirname(packageRoot));

const BROWSER_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

/** Every case that must be observed as passed, by file. */
const REQUIRED = [
  {
    file: "apps/web/tests/browser-smoke.test.ts",
    titles: ["creates a connection, streams downstream and posts upstream"],
  },
  {
    file: "apps/web/tests/shell-browser.test.ts",
    titles: [
      "connects, shows the host as ready and starts with no sessions",
      "creates a session and completes a streamed run",
      "shows calculator calls and results as generic cards",
      "shows a second plugin's tool through the same generic card",
      "keeps a newer selection and its draft when a create answer arrives late",
      "restores the session selection after a page reload",
    ],
  },
  {
    file: "apps/web/tests/shell-faults.browser.test.ts",
    titles: [
      "keeps start off while a run is in flight and cancels on request",
      "marks a max-steps run as limited, not completed",
      "marks a failed run as failed and keeps its partial text out of history",
      "shows a plugin activation failure as a safe summary without a retry",
      "refuses a non-JSON tool input before any tool runs, and keeps tool text inert",
      "renders a dangerous tool result as inert text without executing it",
    ],
  },
  {
    file: "apps/web/tests/shell-reconnect.browser.test.ts",
    titles: [
      "follows a still-running stream across a reconnect",
      "survives a dropped connection and resyncs the same host",
      "shows an unconfirmed submission instead of resending it",
      "treats a restarted host as a different host",
    ],
  },
  {
    // M4's own carrier acceptance: the browser answers a real tool approval.
    // It is kept, and it does not stand in for the shell's own approval UX.
    file: "apps/web/tests/shell-approval.browser.test.ts",
    titles: [
      "runs nothing until the browser approves, then runs exactly once",
      "runs nothing when the browser rejects, and says so",
      "keeps the approval answerable across a reconnect, and runs it once after approving",
    ],
  },
  {
    // M5: durable sessions, paging, rename and delete in the normal app.
    file: "apps/web/tests/shell-m5-sessions.browser.test.ts",
    titles: [
      "says durable storage can be read back after a restart",
      "says ephemeral storage lasts only as long as the process",
      "loads an older page of the directory and selects a session from it",
      "retires the traversal when the collection revision moves, and never presents a mixed window as complete",
      "renames a session and reports the host's own title",
      "refuses a rename aimed at a stale revision, and never replays it",
      "records a rename whose answer was lost as unconfirmed, and never asserts the title",
      "warns before a permanent delete and says what cannot be undone",
      "removes the deleted session, its cache and the selection",
      "refuses to delete a session the host is still running, and never cancels it",
      "records a delete whose answer was lost without claiming anything",
      "keeps a partial history honest and only calls it complete once it is",
      "says when the committed history has moved past what is loaded",
      "shows a plugin's desired intent, actual state and restart requirement apart",
      // The sidebar's two entries: the settings stay reachable however long the
      // directory is, and a repeated write reports its own subject once.
      "keeps the settings entry and the session list's scroll apart, however long the directory is",
      "switches the sidebar between the sessions and the settings without losing the selection",
      "reports a rename once, and keeps one report however often the session is renamed",
      "keeps every core control reachable in a narrow viewport, and offers no credential surface",
      "treats a restarted host as a different authority: no selection, no pages, no resurrection",
      "walks past everything its cache can hold and reaches the oldest sessions",
      "runs and shows a run for a focused session the window does not hold",
      "refuses a rename whose draft was based on a revision a real rename replaced",
      "keeps the reader's new selection when a deletion for the old one lands",
    ],
  },
  {
    // M5: desired and effective settings, and what a lost answer means.
    file: "apps/web/tests/shell-m5-settings.browser.test.ts",
    titles: [
      "shows desired and effective together when nothing is pending",
      "moves desired without moving effective, and says a restart is owed",
      "records a save whose answer was lost, and reads the truth instead of resending",
      "keeps a dirty draft when the host's settings move underneath it",
      "keeps the draft when a save's answer was lost, and clears it only on a confirmed save",
      "keeps text typed while a save is in flight",
      "refuses to save a draft against a different host, however equal the revisions look",
    ],
  },
  {
    // M5: the shell's own approval card, driven the way a person drives it.
    file: "apps/web/tests/shell-m5-approval.browser.test.ts",
    titles: [
      "shows the exact read-only input and waits for a decision, running nothing",
      "never shows the Host's decision before it has sent its own answer",
      "shows the tool's own result and never claims an approval means success",
      "runs nothing when the rejection is answered, and says the call was not executed",
      "treats a dropped connection as a lost delivery, never as a rejection",
      "keeps the same business approval across a same-host reconnect",
      "stops offering an answer once the execution is cancelled",
      "holds the host's execution lease while the approval waits",
    ],
  },
  {
    // M5: the credential sentinel at the layer only a page has.
    file: "apps/web/tests/shell-m5-credential.browser.test.ts",
    titles: ["reaches the provider-facing call and appears nowhere a page or a process can show"],
  },
  {
    // M5: what a killed host left behind, read by a live page.
    file: "apps/web/tests/shell-m5-interrupted.browser.test.ts",
    titles: [
      "says an accepted-but-never-started run can be proved not to have run",
      "says a run with a running marker cannot be known, and blocks the session without resuming it",
      "lets a blocked session be renamed and permanently deleted, and never comes back",
    ],
  },
];

function findBrowser() {
  const override = process.env["EVERY_DAGENT_BROWSER"];
  if (override !== undefined) {
    if (override === "" || override === "none") return undefined;
    return existsSync(override) ? override : undefined;
  }
  for (const candidate of BROWSER_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function fail(message) {
  console.error(`browser acceptance FAILED: ${message}`);
  process.exit(1);
}

const browser = findBrowser();
if (browser === undefined) {
  fail("no browser found; set EVERY_DAGENT_BROWSER to its executable to run this gate");
}

const version =
  spawnSync(browser, ["--version"], { encoding: "utf8" }).stdout?.trim() || "(version unavailable)";
console.log(`browser: ${browser}`);
console.log(`version: ${version}`);

const directory = mkdtempSync(join(tmpdir(), "every-dagent-browser-gate-"));
const reportPath = join(directory, "report.json");
const vitest = join(root, "node_modules", "vitest", "vitest.mjs");

const files = REQUIRED.map((entry) => entry.file);
const exitCode = await new Promise((resolve) => {
  const child = spawn(
    process.execPath,
    [
      vitest,
      "run",
      ...files,
      "--no-cache",
      "--exclude",
      "**/.zcode/**",
      // One browser file at a time, each in its own fork: every file starts
      // its own Chrome and its own host, and a gate that races them for the
      // machine reports timeouts instead of what the page did.
      "--pool=forks",
      "--poolOptions.forks.maxForks=1",
      "--reporter=json",
      `--outputFile=${reportPath.replace(/\\/g, "/")}`,
    ],
    {
      cwd: root,
      // `0` lifts the explicit disable; the tests still probe for a real browser.
      env: { ...process.env, EVERY_DAGENT_NO_BROWSER: "0", EVERY_DAGENT_BROWSER: browser },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let noise = "";
  child.stdout.on("data", (chunk) => {
    noise += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    noise += chunk.toString("utf8");
  });
  child.on("error", () => resolve(-1));
  child.on("close", (code) => {
    if (code !== 0) {
      console.error(noise.slice(-4000));
    }
    resolve(code ?? -1);
  });
});

try {
  if (exitCode !== 0) {
    // A run that failed says why: the machine report, when it was written, or
    // the child's own output when it was not.
    try {
      const report = JSON.parse(readFileSync(reportPath, "utf8"));
      const failed = (report.testResults ?? []).flatMap((file) =>
        (file.assertionResults ?? [])
          .filter((assertion) => assertion.status !== "passed")
          .map(
            (assertion) =>
              `${file.name}: "${assertion.title}" was ${assertion.status} :: ` +
              (assertion.failureMessages ?? []).join(" ").slice(0, 600),
          ),
      );
      for (const line of failed.slice(0, 20)) console.error(line);
      if (failed.length === 0) console.error("the report holds no failed assertion; the run did not finish");
    } catch {
      console.error("no readable machine report was written");
    }
    fail(`the vitest run exited with ${exitCode}`);
  }

  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    fail(`the machine report is missing or unreadable at ${reportPath}`);
  }

  const byFile = new Map();
  for (const fileResult of report.testResults ?? []) {
    byFile.set(String(fileResult.name).replace(/\\/g, "/"), fileResult.assertionResults ?? []);
  }

  let checked = 0;
  for (const entry of REQUIRED) {
    const match = [...byFile.entries()].find(([name]) => name.endsWith(entry.file));
    if (match === undefined) fail(`no report for ${entry.file} (the file did not run)`);
    const [, assertions] = match;

    for (const title of entry.titles) {
      checked += 1;
      const found = assertions.find((assertion) => assertion.title === title);
      if (found === undefined) fail(`${entry.file}: the required case never ran: "${title}"`);
      if (found.status !== "passed") {
        fail(`${entry.file}: "${title}" was reported as ${found.status}, not passed`);
      }
    }
    for (const assertion of assertions) {
      if (assertion.status !== "passed") {
        fail(`${entry.file}: "${assertion.title}" was ${assertion.status}; this gate admits no skips`);
      }
    }
  }

  console.log(`browser acceptance PASSED: ${checked} required cases, all passed, no skips`);
} finally {
  if (exitCode === 0) rmSync(directory, { recursive: true, force: true });
}
