/**
 * HTML → PDF, through the browser that is already on the machine.
 *
 * The route is the one the product ships: the rendered report is written to a
 * file, a headless Chrome/Edge is started against a throw-away profile, and
 * `Page.printToPDF` returns the bytes over the DevTools protocol. Nothing here
 * renders text itself — which is the point, because the browser is what makes
 * the Chinese text, the table layout and the page breaks real.
 *
 * The implementation is deliberately strict about the two ways this can lie:
 * it waits for the document (and its fonts) to actually be ready before
 * printing, and it refuses to report success unless a non-empty PDF file
 * exists afterwards.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const BROWSER_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

/** The browser this machine will print with: the operator's override, or a found one. */
export function findPdfBrowser(): string | undefined {
  const override = process.env["RESEARCHPAGE_BROWSER"] ?? process.env["EVERY_DAGENT_BROWSER"];
  if (override !== undefined && override !== "") {
    return existsSync(override) ? override : undefined;
  }
  for (const candidate of BROWSER_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export type PdfExportResult =
  | { readonly ok: true; readonly path: string; readonly bytes: number; readonly browser: string }
  | { readonly ok: false; readonly failure: string };

export interface PdfExportOptions {
  readonly html: string;
  /** Where the PDF is written; the HTML file is written beside it. */
  readonly outPath: string;
  readonly browserPath?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

interface CdpAnswer {
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: { readonly message?: string };
}

/**
 * Waits for the DevTools endpoint the browser prints when it is listening.
 *
 * Chrome reports the address on stderr with an unpredictable port (`:0` asks
 * the OS for one), and reading it there is the only way that does not race a
 * fixed port against whatever else the machine is running.
 */
function devtoolsAddress(child: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise((resolveAddress, rejectAddress) => {
    const deadline = Date.now() + timeoutMs;
    let buffer = "";
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffer);
      if (match !== null) {
        cleanup();
        resolveAddress(match[1] ?? "");
      } else if (Date.now() > deadline) {
        cleanup();
        rejectAddress(new Error("the browser never reported a DevTools address"));
      }
    };
    const timer = setInterval(() => {
      if (Date.now() > deadline) {
        cleanup();
        rejectAddress(new Error("the browser never reported a DevTools address"));
      }
    }, 200);
    const cleanup = (): void => {
      clearInterval(timer);
      child.stderr?.off("data", onData);
    };
    child.stderr?.on("data", onData);
    child.once("exit", () => {
      cleanup();
      rejectAddress(new Error("the browser exited before it was ready"));
    });
  });
}

async function pageSocket(browserAddress: string, timeoutMs: number): Promise<string> {
  // The browser endpoint's /json/list is the documented way to find its pages;
  // the port comes from the address the browser itself printed.
  const parsed = new URL(browserAddress);
  const origin = `${parsed.protocol === "wss:" ? "https" : "http"}://${parsed.host}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`${origin}/json/list`);
      const targets = (await response.json()) as { type?: string; url?: string; webSocketDebuggerUrl?: string }[];
      const page = targets.find((target) => target.type === "page" && typeof target.webSocketDebuggerUrl === "string");
      if (page?.webSocketDebuggerUrl !== undefined) return page.webSocketDebuggerUrl;
    } catch {
      // The page target is not up yet.
    }
    if (Date.now() > deadline) throw new Error("the browser exposed no page target");
    await delay(100);
  }
}

/** A minimal, request/response-only CDP client over the built-in WebSocket. */
class CdpConnection {
  private readonly socket: WebSocket;
  private nextId = 0;
  private readonly pending = new Map<number, (answer: CdpAnswer) => void>();

  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as CdpAnswer;
      if (message.id === undefined) return;
      const settle = this.pending.get(message.id);
      if (settle !== undefined) {
        this.pending.delete(message.id);
        settle(message);
      }
    });
  }

  static async connect(url: string, timeoutMs: number): Promise<CdpConnection> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolveOpen, rejectOpen) => {
      const timer = setTimeout(() => {
        rejectOpen(new Error("the DevTools socket did not open"));
      }, timeoutMs);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolveOpen();
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        rejectOpen(new Error("the DevTools socket failed"));
      });
    });
    return new CdpConnection(socket);
  }

  call(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<unknown> {
    this.nextId += 1;
    const id = this.nextId;
    const answer = new Promise<unknown>((resolveAnswer, rejectAnswer) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectAnswer(new Error(`CDP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error !== undefined) {
          rejectAnswer(new Error(`CDP ${method} failed: ${message.error.message ?? "unknown"}`));
          return;
        }
        resolveAnswer(message.result);
      });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return answer;
  }

  close(): void {
    this.socket.close();
  }
}

async function evaluate<T>(connection: CdpConnection, expression: string): Promise<T> {
  const result = (await connection.call("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })) as { result?: { value?: unknown } };
  return result.result?.value as T;
}

/**
 * Prints one HTML document to one PDF file.
 *
 * Every failure path returns `ok: false` with a sentence — a missing browser, a
 * page that never became ready, a print that produced nothing — because a
 * caller that cannot tell "exported" from "did not export" would put the lie in
 * the UI.
 */
export async function exportHtmlToPdf(options: PdfExportOptions): Promise<PdfExportResult> {
  const browser = options.browserPath ?? findPdfBrowser();
  if (browser === undefined) {
    return { ok: false, failure: "未找到可用的 Chrome/Edge，可设置 RESEARCHPAGE_BROWSER 指定路径" };
  }

  const timeoutMs = options.timeoutMs ?? 60_000;
  const outPath = resolve(options.outPath);
  const htmlPath = join(dirname(outPath), `${outPath.split(/[\\/]/).pop() ?? "report"}.html`);
  writeFileSync(htmlPath, options.html, "utf8");

  const profile = mkdtempSync(join(tmpdir(), "researchpage-pdf-"));
  const child = spawn(
    browser,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      "--window-size=1240,1754",
      pathToFileURL(htmlPath).href,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  let connection: CdpConnection | undefined;
  try {
    const address = await devtoolsAddress(child, Math.min(timeoutMs, 30_000));
    const socketUrl = await pageSocket(address, Math.min(timeoutMs, 20_000));
    connection = await CdpConnection.connect(socketUrl, 15_000);
    await connection.call("Page.enable");
    await connection.call("Runtime.enable");

    // The document has to be complete *and* its fonts loaded: printing before
    // the CJK face is ready is exactly how a PDF ends up with empty boxes.
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let ready = false;
      try {
        ready = await evaluate<boolean>(
          connection,
          "document.readyState === 'complete' && document.fonts !== undefined && document.fonts.status === 'loaded' && document.body !== null",
        );
      } catch {
        ready = false;
      }
      if (ready) break;
      if (Date.now() > deadline) return { ok: false, failure: "页面在超时前未完成渲染（字体或文档未就绪）" };
      await delay(150);
    }

    const printed = (await connection.call(
      "Page.printToPDF",
      {
        printBackground: true,
        preferCSSPageSize: true,
        marginTop: 0.6,
        marginRight: 0.5,
        marginBottom: 0.6,
        marginLeft: 0.5,
      },
      timeoutMs,
    )) as { data?: string };

    const data = printed.data;
    if (typeof data !== "string" || data.length === 0) {
      return { ok: false, failure: "浏览器没有返回 PDF 数据" };
    }
    const bytes = Buffer.from(data, "base64");
    if (bytes.byteLength === 0) return { ok: false, failure: "导出的 PDF 为空文件" };
    writeFileSync(outPath, bytes);
    const stats = statSync(outPath);
    return { ok: true, path: outPath, bytes: stats.size, browser };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown failure";
    return { ok: false, failure: `PDF 导出失败：${reason}` };
  } finally {
    connection?.close();
    child.kill();
    await delay(150);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      // The killed browser may still hold the profile; the OS reclaims it.
    }
  }
}
