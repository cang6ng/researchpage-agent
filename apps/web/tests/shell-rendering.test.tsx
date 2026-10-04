/**
 * What the panels render, checked on the markup they produce.
 *
 * These are static renders — `renderToStaticMarkup`, no DOM — so what is
 * checked is the structure and the text a page would contain, not the browser
 * behaviour (the real-browser files cover that). What matters here is the
 * vocabulary: live items are labelled live, terminal states carry their
 * caveats, `ok:false` is not explained away, a plugin in error has no reset,
 * and tool text is escaped rather than executed.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ClientSnapshot, HistoryCoverage } from "@every-dagent/client";
import type {
  ActiveRunSnapshot,
  ApprovalSnapshot,
  CanonicalItem,
  HostSnapshot,
  LiveItem,
  PluginSummary,
  RunSummary,
  SessionSummary,
} from "@every-dagent/protocol";

import { App } from "../src/browser/App.js";
import { ApprovalPanel } from "../src/browser/ApprovalPanel.js";
import { ConnectionPanel } from "../src/browser/ConnectionPanel.js";
import { ConnectionStatus } from "../src/browser/ConnectionStatus.js";
import { Conversation } from "../src/browser/Conversation.js";
import { HostPanel } from "../src/browser/HostPanel.js";
import { NoticesPanel } from "../src/browser/NoticesPanel.js";
import { PluginsPanel } from "../src/browser/PluginsPanel.js";
import { SettingsPanel } from "../src/browser/SettingsPanel.js";
import { RunStrip } from "../src/browser/RunStrip.js";
import { ToolCallCard, ToolResultCard } from "../src/browser/ToolCard.js";
import { createShellControllerWith, type ShellUiState } from "../src/browser/controller.js";
import { memorySelectionStorage } from "../src/browser/selection.js";

const INSTANCE = "instance-abcdefgh";

const DURABLE_STORAGE = { storageId: "storage-1", retention: "durable" as const, schemaVersion: 1 };

function uiState(parts: Partial<ShellUiState> = {}): ShellUiState {
  return {
    bindingOrigin: "http://127.0.0.1:4100",
    selection: null,
    creatingSession: false,
    startingRun: false,
    cancellingRunId: null,
    pluginPending: {},
    historyLoading: false,
    sessionWrite: null,
    renameDraft: null,
    settingsPending: null,
    directoryLoading: false,
    directoryRefreshing: false,
    notices: [],
    unknownWrites: [],
    approvalWaiter: null,
    ...parts,
  };
}

function presentation(parts: Partial<HostSnapshot> = {}): HostSnapshot {
  return {
    hostInstanceId: INSTANCE,
    watermark: { streamId: "s", sequence: 1 },
    storage: DURABLE_STORAGE,
    collections: { sessions: 1, runs: 1, plugins: 1 },
    sessions: { items: [], collectionRevision: 1, nextCursor: null, hasMore: false },
    runs: { items: [], collectionRevision: 1, nextCursor: null, hasMore: false },
    plugins: [],
    approval: null,
    settings: [
      { namespace: "host", desiredRevision: 1, effectiveRevision: 1, restartRequired: false },
      { namespace: "model", desiredRevision: 1, effectiveRevision: 1, restartRequired: false },
    ],
    ...parts,
  };
}

function snapshot(parts: Partial<ClientSnapshot> = {}): ClientSnapshot {
  const base: ClientSnapshot = {
    status: "ready",
    description: {
      protocolVersion: "2",
      hostInstanceId: INSTANCE,
      host: { name: "every-dagent-host", version: "0.1.0" },
      storage: DURABLE_STORAGE,
      capabilities: {
        sessions: true,
        runs: true,
        plugins: true,
        subscriptions: true,
        reverseRequests: false,
        historyPages: true,
        sessionMutations: true,
        settings: false,
        approvals: false,
      },
      clientCapabilities: { reverseRequests: true },
      limits: {
        maxActiveRuns: 1,
        maxInputBytes: 65536,
        maxRecordBytes: 262144,
        maxPageItems: 50,
        maxPageBytes: 196608,
        maxFrameBytes: 262144,
        maxOutboxBytes: 1048576,
        maxTitleChars: 200,
      },
    },
    presentation: presentation(),
    presentationHost: "current",
    directory: {
      hostInstanceId: INSTANCE,
      storageId: DURABLE_STORAGE.storageId,
      revision: 1,
      head: null,
      pages: [],
      nextCursor: null,
      hasMore: false,
      anchorBottomId: null,
      detached: false,
      evicted: false,
      stale: false,
    },
    focusedSession: null,
    live: {},
    history: {},
    settings: {},
    approvalReply: { state: "none" },
    approvalCanRespond: false,
    stale: false,
    error: null,
  };
  return { ...base, ...parts };
}

function session(parts: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: "session-1",
    generation: 1,
    title: "会话 session-1",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    status: "ready",
    blockedReason: null,
    metadataRevision: 0,
    historyRevision: 1,
    committedSeq: 4,
    activeRunId: null,
    ...parts,
  };
}

/** What the client has read of one session's history, as `Conversation` takes it. */
function coverage(items: readonly CanonicalItem[], parts: Partial<HistoryCoverage> = {}): HistoryCoverage {
  return {
    storageId: "storage-1",
    sessionId: "session-1",
    generation: 1,
    historyRevision: 1,
    fenceSeq: 4,
    fromSeq: 0,
    toSeq: 4,
    atStart: true,
    atFence: true,
    behind: false,
    fragmentOldest: false,
    fragmentNewest: false,
    nextCursor: null,
    items,
    // One segment covering the whole range: the client keeps what it read as
    // the pages it read it as, and continuity is a claim about those pages.
    segments: [
      {
        fromSeq: 0,
        toSeq: 4,
        atStart: true,
        atFence: true,
        startsAtTurnBoundary: true,
        endsAtTurnBoundary: true,
        cursorBelow: null,
        items,
        bytes: 0,
      },
    ],
    ...parts,
  };
}

function activeRun(parts: Partial<ActiveRunSnapshot> = {}): ActiveRunSnapshot {
  const base = {
    runId: "run-1",
    submissionId: "sub-1",
    sessionId: "session-1",
    text: "算一下",
    turnId: null,
    cancelRequested: false,
    acceptedAt: 1_700_000_000_000,
    startedAt: 1_700_000_000_000,
    endedAt: null,
    live: [],
    liveTruncated: false,
  };
  return { ...base, status: "running", endReason: null, error: null, executionKnowledge: null, ...parts };
}

/** The durable summary a settled run is shown by, once its timeline is gone. */
function runSummary(parts: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: "run-1",
    submissionId: "sub-1",
    sessionId: "session-1",
    text: "算一下",
    turnId: null,
    cancelRequested: false,
    acceptedAt: 1_700_000_000_000,
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_000_000,
    status: "completed",
    endReason: "completed",
    error: null,
    executionKnowledge: null,
    ...parts,
  };
}

const noop = (): void => undefined;

describe("the connection chip and panel", () => {
  it("names every status in plain words", () => {
    for (const [status, expected] of [
      ["disconnected", "未连接"],
      ["connecting", "正在连接"],
      ["connected", "已连接（未同步）"],
      ["syncing", "正在同步"],
      ["lost", "连接已断开"],
      ["protocol-error", "协议错误（已停止）"],
    ] as const) {
      const markup = renderToStaticMarkup(
        <ConnectionStatus snapshot={snapshot({ status, presentation: null, presentationHost: "none" })} />,
      );
      expect(markup).toContain(expected);
    }
  });

  it("says a stale presentation is read-only and was not cancelled", () => {
    const markup = renderToStaticMarkup(
      <ConnectionPanel
        snapshot={snapshot({ status: "lost", stale: true })}
        ui={uiState()}
        onConnectTo={noop}
        onReconnect={noop}
        onDisconnect={noop}
      />,
    );
    expect(markup).toContain("断开连接不会取消正在运行的任务");
  });

  it("keeps the previous-host and stale notes while a connection is not ready", () => {
    // A panel full of the previous host's facts under a "正在同步" chip is
    // exactly where a reader would take them for confirmed, current facts —
    // every unsettled status has to keep saying what the presentation is.
    for (const status of ["disconnected", "connecting", "connected", "syncing"] as const) {
      const markup = renderToStaticMarkup(
        <ConnectionPanel
          snapshot={snapshot({ status, stale: true, presentationHost: "previous" })}
          ui={uiState()}
          onConnectTo={noop}
          onReconnect={noop}
          onDisconnect={noop}
        />,
      );
      expect(markup, `${status} must carry the previous-host note`).toContain("展示的是上一个 Host 的内容，仅供参考。");
      expect(markup, `${status} must carry the stale note`).toContain("展示的是最后一次同步的内容。");
    }

    // And a syncing page with nothing to show yet has nothing to warn about.
    const empty = renderToStaticMarkup(
      <ConnectionPanel
        snapshot={snapshot({ status: "syncing", stale: false, presentation: null, presentationHost: "none" })}
        ui={uiState()}
        onConnectTo={noop}
        onReconnect={noop}
        onDisconnect={noop}
      />,
    );
    expect(empty).not.toContain("展示的是最后一次同步的内容。");
  });
});

describe("the conversation", () => {
  const canonical: readonly CanonicalItem[] = [
    { id: "item-1", turnId: "turn-1", seq: 0, kind: "user", text: "算一下 6*7" },
    { id: "item-2", turnId: "turn-1", seq: 1, kind: "tool-call", invocationId: "inv-1", callId: "call-1", name: "calculator", input: { kind: "json", value: { a: 6, b: 7 } } },
    { id: "item-3", turnId: "turn-1", seq: 2, kind: "tool-result", invocationId: "inv-1", callId: "call-1", name: "calculator", ok: true, content: "42" },
    { id: "item-4", turnId: "turn-1", seq: 3, kind: "assistant", text: "结果是 42。" },
  ];

  it("renders history and labels the live area as live", () => {
    const live: readonly LiveItem[] = [
      { kind: "text", itemId: "live-1", text: "正在生成" },
      { kind: "tool", itemId: "live-2", invocationId: "inv-2", executionId: "exec-2", callId: "", name: "calculator", input: { kind: "json", value: { a: 1, b: 2 } }, result: null },
    ];
    const markup = renderToStaticMarkup(
      <Conversation
        snapshot={snapshot()}
        session={session({ activeRunId: "run-1" })}
        coverage={coverage(canonical)}
        activeRun={activeRun({ live })}
        loading={false}
        onLoadOlder={noop}
        onLoadNewer={noop}
      />,
    );

    expect(markup).toContain("data-testid=\"msg-user\"");
    expect(markup).toContain("data-testid=\"msg-assistant\"");
    expect(markup).toContain("data-testid=\"tool-input-json\"");
    expect(markup).toContain("42");
    // The live area is its own region, with the streaming text labelled.
    expect(markup).toContain("data-testid=\"live-run\"");
    expect(markup).toContain("生成中");
    expect(markup).toContain("data-testid=\"tool-pending\"");
    // An empty callId is shown as empty, never hidden.
    expect(markup).toContain("（空）");
  });

  it("says a conversation that has not been read yet is unread, not empty", () => {
    // The absence of coverage is a fact of its own: nothing has been read,
    // which is not the same as the session having no recorded messages.
    const markup = renderToStaticMarkup(
      <Conversation snapshot={snapshot()} session={session()} coverage={null} activeRun={null} loading={false} onLoadOlder={noop} onLoadNewer={noop} />,
    );
    expect(markup).toContain("data-testid=\"history-unloaded\"");
    expect(markup).toContain("尚未读取该会话的历史");
  });

  it("keeps a blocked session readable but says it cannot continue", () => {
    const markup = renderToStaticMarkup(
      <Conversation
        snapshot={snapshot()}
        session={session({ status: "blocked", blockedReason: "unknown-execution" })}
        coverage={coverage(canonical)}
        activeRun={null}
        loading={false}
        onLoadOlder={noop}
        onLoadNewer={noop}
      />,
    );
    expect(markup).toContain("data-testid=\"blocked-banner\"");
    // The banner names the reason the host gave, not a generic "blocked".
    expect(markup).toContain("无法确认是否已经产生副作用");
    expect(markup).toContain("结果是 42。");
  });

  it("escapes tool text instead of executing it", () => {
    const markup = renderToStaticMarkup(
      <ToolResultCard name="echo" callId="c" ok={true} content={'<script>alert("x")</script>'} />,
    );
    expect(markup).not.toContain("<script>");
    expect(markup).toContain("&lt;script&gt;");
  });

  it("shows an unavailable input honestly and does not explain ok:false away", () => {
    const markup = renderToStaticMarkup(
      <>
        <ToolCallCard name="calculator" callId="c" invocationId="i" input={{ kind: "unavailable", reason: "not-json-safe" }} result={null} live={false} />
        <ToolResultCard name="calculator" callId="c" ok={false} content="the tool failed" />
      </>,
    );
    expect(markup).toContain("data-testid=\"tool-input-unavailable\"");
    expect(markup).toContain("无法表示为 JSON");
    expect(markup).toContain("badge--fail");
    expect(markup).toContain("不证明调用没有被派发");
  });
});

describe("the run strip", () => {
  it("offers cancel while active and stops offering it once requested", () => {
    const active = renderToStaticMarkup(
      <RunStrip run={runSummary({ status: "running", endReason: null, endedAt: null })} cancelling={false} canWrite onCancel={noop} />,
    );
    expect(active).toContain("运行中");
    expect(active).toContain("data-testid=\"cancel-button\"");

    const requested = renderToStaticMarkup(
      <RunStrip
        run={runSummary({ status: "running", endReason: null, endedAt: null, cancelRequested: true })}
        cancelling={false}
        canWrite
        onCancel={noop}
      />,
    );
    expect(requested).toContain("data-testid=\"cancel-requested\"");
    expect(requested).not.toContain("data-testid=\"cancel-button\"");
    // The request is not the stop.
    expect(requested).toContain("运行中");
  });

  it("never describes a limited or cancelled run as a completion", () => {
    const limited = renderToStaticMarkup(
      <RunStrip run={runSummary({ status: "limited", endReason: "max_steps" })} cancelling={false} canWrite onCancel={noop} />,
    );
    expect(limited).toContain("达到步数上限");
    expect(limited).toContain("不是一次完整回答");
    expect(limited).not.toContain("已完成");

    const cancelled = renderToStaticMarkup(
      <RunStrip run={runSummary({ status: "cancelled", endReason: "cancelled" })} cancelling={false} canWrite onCancel={noop} />,
    );
    expect(cancelled).toContain("不会因此回滚");
  });

  it("shows a failed run's safe error", () => {
    const failed = renderToStaticMarkup(
      <RunStrip
        run={runSummary({
          status: "failed",
          endReason: "error",
          error: { code: "INTERNAL_ERROR", message: "it failed" },
        })}
        cancelling={false}
        canWrite
        onCancel={noop}
      />,
    );
    expect(failed).toContain("data-testid=\"run-error\"");
    expect(failed).toContain("INTERNAL_ERROR");
  });

  it("describes an interrupted run by what the record can prove", () => {
    // `interrupted` is its own terminal: a previous host stopped without
    // committing an outcome. An execution that was never observed running is
    // provably not-started; one with a running marker cannot be called either way.
    const notStarted = renderToStaticMarkup(
      <RunStrip
        run={runSummary({ status: "interrupted", endReason: "interrupted", executionKnowledge: "not-started" })}
        cancelling={false}
        canWrite
        onCancel={noop}
      />,
    );
    expect(notStarted).toContain("已中断");
    expect(notStarted).toContain("可以确认它没有被执行");

    const unknown = renderToStaticMarkup(
      <RunStrip
        run={runSummary({ status: "interrupted", endReason: "interrupted", executionKnowledge: "unknown" })}
        cancelling={false}
        canWrite
        onCancel={noop}
      />,
    );
    expect(unknown).toContain("无法确认是否已经产生副作用");
    expect(unknown).not.toContain("可以确认它没有被执行");
  });
});

describe("the plugin panel", () => {
  const plugins: readonly PluginSummary[] = [
    summary({ id: "calculator", name: "Calculator", version: "0.1.0", status: "disabled" }),
    summary({
      id: "text-stats",
      name: "Text Stats",
      version: "1.0.0",
      description: "Measures a text.",
      permissions: ["storage"],
      status: "enabled",
      desiredEnabled: true,
    }),
    {
      id: "broken",
      name: "Broken",
      version: "0.0.1",
      permissions: [],
      status: "error",
      desiredEnabled: false,
      configRevision: null,
      effectiveConfigRevision: null,
      restartRequired: false,
      unavailable: true,
      lastFailure: { operation: "enable", phase: "activate", code: "PLUGIN_OPERATION_FAILED", message: "activation failed", cleanupFailureCount: 1 },
    },
  ];

  it("offers the one operation each state actually has", () => {
    const markup = renderToStaticMarkup(
      <PluginsPanel snapshot={snapshot({ presentation: presentation({ plugins }) })} ui={uiState()} canWrite hostBusy={false} onSetEnabled={noop} />,
    );
    expect(markup).toContain("data-testid=\"plugin-enable\" data-plugin-id=\"calculator\"");
    expect(markup).toContain("data-testid=\"plugin-disable\" data-plugin-id=\"text-stats\"");
    // An error plugin cannot be operated on at all: no reset, no retry.
    expect(markup).not.toContain("data-plugin-id=\"broken\" data-");
    expect(markup).toContain("没有自动重试或重置");
    expect(markup).toContain("activate");
    expect(markup).toContain("清理失败");
  });

  it("explains a busy host instead of hiding the buttons' reason", () => {
    const markup = renderToStaticMarkup(
      <PluginsPanel snapshot={snapshot({ presentation: presentation({ plugins }) })} ui={uiState()} canWrite hostBusy onSetEnabled={noop} />,
    );
    expect(markup).toContain("data-testid=\"plugins-busy\"");
    expect(markup).toContain("disabled");
  });

  it("does not mistake an inherited property for a pending plugin", () => {
    // A plugin id may legally be `constructor`; reading the pending map
    // unguarded would find `Object.prototype.constructor` and render the
    // plugin as permanently mid-operation, with its button disabled.
    const inherited: readonly PluginSummary[] = [
      summary({ id: "constructor", name: "Constructor", version: "1.0.0", status: "disabled" }),
    ];
    const markup = renderToStaticMarkup(
      <PluginsPanel
        snapshot={snapshot({ presentation: presentation({ plugins: inherited }) })}
        ui={uiState()}
        canWrite
        hostBusy={false}
        onSetEnabled={noop}
      />,
    );
    expect(markup).toContain("data-testid=\"plugin-enable\" data-plugin-id=\"constructor\"");
    expect(markup).not.toContain("启用中…");
  });
});

describe("notices and unconfirmed writes", () => {
  it("never lets a lost answer read as a failure or a retry", () => {
    const markup = renderToStaticMarkup(
      <NoticesPanel
        ui={uiState({
          unknownWrites: [
            { id: "u1", kind: "start", hostInstanceId: INSTANCE, createdAt: 0, sessionId: "s", submissionId: "sub", text: "hi" },
          ],
        })}
        snapshot={snapshot()}
        canWrite
        onCheck={noop}
        onResubmit={noop}
        onRefresh={noop}
        onDismiss={noop}
        onDismissNotice={noop}
      />,
    );
    expect(markup).toContain("可能已被接受并执行");
    expect(markup).toContain("不会自动重发");
    expect(markup).toContain("data-testid=\"unknown-resubmit\"");
    // Dismissing is not a claim about what happened.
    expect(markup).toContain("不代表该操作没有执行");
  });

  it("offers no resubmit for a different host and only refresh for a create", () => {
    const markup = renderToStaticMarkup(
      <NoticesPanel
        ui={uiState({
          unknownWrites: [
            { id: "u1", kind: "start", hostInstanceId: "other-host", createdAt: 0, sessionId: "s", submissionId: "sub", text: "hi" },
            { id: "u2", kind: "create-session", hostInstanceId: INSTANCE, createdAt: 0 },
          ],
        })}
        snapshot={snapshot()}
        canWrite
        onCheck={noop}
        onResubmit={noop}
        onRefresh={noop}
        onDismiss={noop}
        onDismissNotice={noop}
      />,
    );
    expect(markup).toContain("Host 已更换");
    expect(markup).toContain("data-testid=\"unknown-refresh\"");
  });

  it("identifies each unconfirmed operation by the ids its panels use", () => {
    // Two lost answers of the same kind are otherwise indistinguishable text:
    // the record has to name the session, the submission, the run, the plugin
    // or the host instance it concerns, in the same short forms used around it.
    const markup = renderToStaticMarkup(
      <NoticesPanel
        ui={uiState({
          unknownWrites: [
            {
              id: "u1",
              kind: "start",
              hostInstanceId: "11111111-2222-3333-4444-555555555555",
              createdAt: 0,
              sessionId: "aaaaaaaa-1111-2222-3333-444444444444",
              submissionId: "bbbbbbbb-1111-2222-3333-444444444444",
              text: "算一下 6*7 顺带解释一下每一步怎么来的，越详细越好",
            },
            { id: "u2", kind: "cancel", hostInstanceId: "11111111-2222-3333-4444-555555555555", createdAt: 0, runId: "cccccccc-1111-2222-3333-444444444444" },
            { id: "u3", kind: "plugin", hostInstanceId: "11111111-2222-3333-4444-555555555555", createdAt: 0, pluginId: "calculator", operation: "disable" },
          ],
        })}
        snapshot={snapshot()}
        canWrite
        onCheck={noop}
        onResubmit={noop}
        onRefresh={noop}
        onDismiss={noop}
        onDismissNotice={noop}
      />,
    );
    expect(markup).toContain("data-testid=\"unknown-meta\"");
    expect(markup).toContain("会话 aaaaaaaa");
    expect(markup).toContain("提交 bbbbbbbb");
    // The prompt is recognisable, and a long one is cut rather than dropped in.
    expect(markup).toContain("内容「算一下 6*7 顺带解释一下每一步怎么来");
    expect(markup).not.toContain("越详细越好");
    expect(markup).toContain("运行 cccccccc");
    expect(markup).toContain("插件 calculator · 停用");
    expect(markup).toContain("Host 11111111");
  });
});

describe("the host panel and the whole shell", () => {
  it("states the host's own retention plainly, in both modes", () => {
    const durable = renderToStaticMarkup(<HostPanel snapshot={snapshot()} />);
    expect(durable).toContain("every-dagent-host");
    expect(durable).toContain("实例 instance");
    expect(durable).toContain("并发运行上限 1");
    // Durable: committed things come back after a restart, and the half that
    // does not come back is said next to it.
    expect(durable).toContain("durable");
    expect(durable).toContain("Host 重启后可以重新读取");
    expect(durable).toContain("不是可恢复状态");
    expect(durable).not.toContain("历史只保留在 Host 的内存中");

    // Ephemeral: the same card, the honest other sentence.
    const ephemeral = renderToStaticMarkup(
      <HostPanel
        snapshot={snapshot({
          description: {
            ...snapshot().description!,
            storage: { storageId: "storage-1", retention: "ephemeral", schemaVersion: 1 },
          },
        })}
      />,
    );
    expect(ephemeral).toContain("ephemeral");
    expect(ephemeral).toContain("进程停止后不再存在");
    expect(ephemeral).toContain("不是可恢复状态");
    expect(ephemeral).not.toContain("Host 重启后可以重新读取");
  });

  it("renders the whole shell with no sessions and no connection", () => {
    // One frozen snapshot candidate: `getSnapshot` must keep its identity, or
    // React would have to re-read it forever.
    const disconnected = snapshot({ status: "disconnected", description: null, presentation: null, presentationHost: "none" });
    const controller = createShellControllerWith(
      {
        // The smallest client that satisfies the shell: nothing is called here.
        connect: async () => undefined,
        reconnect: async () => undefined,
        disconnect: () => undefined,
        resync: async () => undefined,
        closeSubscription: async () => undefined,
        getSnapshot: () => disconnected,
        getState: () => disconnected,
        subscribe: () => () => undefined,
        registerToolApprovalHandler: () => undefined,
        directory: {
          loadOlder: async () => ({ loaded: false, stale: false }),
          refreshHead: async () => ({ loaded: false, stale: false }),
          focus: async () => undefined,
          unfocus: () => undefined,
          clearFocusIf: () => undefined,
        },
        sessions: {
          list: async () => ({ sessions: presentation().sessions }),
          create: async () => ({ session: session() }),
          get: async () => ({ session: session() }),
          history: async () => {
            throw new Error("nothing is read here");
          },
          rename: async () => ({ session: session() }),
          delete: async () => ({ sessionId: "session-1", generation: 1, deleted: true as const }),
        },
        runs: {
          start: async () => ({ run: activeRun() }),
          get: async () => ({ run: activeRun() }),
          list: async () => ({ runs: presentation().runs }),
          cancel: async () => ({ run: activeRun() }),
        },
        settings: {
          get: async () => {
            throw new Error("nothing is read here");
          },
          update: async () => {
            throw new Error("nothing is written here");
          },
        },
        plugins: { list: async () => ({ plugins: [] }), enable: async () => ({ plugin: plugins0() }), disable: async () => ({ plugin: plugins0() }) },
      },
      { storage: memorySelectionStorage(), initialBinding: null },
    );
    const markup = renderToStaticMarkup(<App controller={controller} />);

    expect(markup).toContain("Every-DAgent");
    expect(markup).toContain("data-testid=\"connection-status\"");
    expect(markup).toContain("未连接");
    expect(markup).toContain("data-testid=\"sessions-empty\"");
    expect(markup).toContain("data-testid=\"host-empty\"");
    expect(markup).toContain("data-testid=\"no-session\"");
    // The sidebar's two entries are on screen from the first render, and the
    // sessions are the pane a reader gets: the settings are reached through
    // their own entry, never by scrolling past the directory.
    expect(markup).toContain("data-testid=\"sidebar-tab-sessions\"");
    expect(markup).toContain("data-testid=\"sidebar-tab-settings\"");
    expect(markup).toContain("data-testid=\"sidebar-pane\"");
    expect(markup).toContain("data-pane=\"sessions\"");
    expect(markup).toContain("data-testid=\"sessions-panel\"");
    expect(markup).not.toContain("data-testid=\"settings-panel\"");
  });
});


describe("the session writes and the settings panel", () => {
  it("asks before a permanent deletion, and says what cannot be undone", () => {
    const controller = createShellControllerWith(
      {
        connect: async () => undefined,
        reconnect: async () => undefined,
        disconnect: () => undefined,
        resync: async () => undefined,
        closeSubscription: async () => undefined,
        getSnapshot: () =>
          snapshot({
            focusedSession: focusedFixture(),
            presentation: presentation({
              sessions: { items: [session()], collectionRevision: 1, nextCursor: null, hasMore: false },
            }),
          }),
        getState: () =>
          snapshot({
            focusedSession: focusedFixture(),
            presentation: presentation({
              sessions: { items: [session()], collectionRevision: 1, nextCursor: null, hasMore: false },
            }),
          }),
        subscribe: () => () => undefined,
        registerToolApprovalHandler: () => undefined,
        directory: {
          loadOlder: async () => ({ loaded: false, stale: false }),
          refreshHead: async () => ({ loaded: false, stale: false }),
          focus: async () => undefined,
          unfocus: () => undefined,
          clearFocusIf: () => undefined,
        },
        sessions: {
          list: async () => ({ sessions: presentation().sessions }),
          create: async () => ({ session: session() }),
          get: async () => ({ session: session() }),
          history: async () => {
            throw new Error("nothing is read here");
          },
          rename: async () => ({ session: session() }),
          delete: async () => ({ sessionId: "session-1", generation: 1, deleted: true as const }),
        },
        runs: {
          start: async () => ({ run: activeRun() }),
          get: async () => ({ run: activeRun() }),
          list: async () => ({ runs: presentation().runs }),
          cancel: async () => ({ run: activeRun() }),
        },
        settings: {
          get: async () => {
            throw new Error("nothing is read here");
          },
          update: async () => {
            throw new Error("nothing is written here");
          },
        },
        plugins: { list: async () => ({ plugins: [] }), enable: async () => ({ plugin: plugins0() }), disable: async () => ({ plugin: plugins0() }) },
      },
      { storage: memorySelectionStorage({ hostInstanceId: INSTANCE, sessionId: "session-1" }), initialBinding: null },
    );

    const markup = renderToStaticMarkup(<App controller={controller} />);
    // The two writes are offered for a confirmed session, and the delete is the
    // warned one.
    expect(markup).toContain("data-testid=\"delete-start\"");
    expect(markup).toContain("重命名");
  });

  it("states desired, effective and restartRequired from the client's own cache", () => {
    const cached = snapshot({
      settings: {
        model: {
          namespace: "model",
          desiredRevision: 4,
          effectiveRevision: 3,
          restartRequired: true,
          snapshot: {
            namespace: "model",
            desiredRevision: 4,
            effectiveRevision: 3,
            restartRequired: true,
            desiredValue: { provider: "test", model: "next-model" },
            effectiveValue: { provider: "test", model: "test-model" },
          },
          stale: false,
        },
      },
    });
    const markup = renderToStaticMarkup(
      <SettingsPanel snapshot={cached} ui={uiState()} canWrite onRead={noop} onSave={async () => ({ kind: "confirmed" as const })} />,
    );

    expect(markup).toContain("data-testid=\"settings-revisions-model\"");
    expect(markup).toContain("desired 修订 4");
    expect(markup).toContain("本实例生效修订 3");
    expect(markup).toContain("data-testid=\"settings-restart-model\"");
    expect(markup).toContain("需要重启 Host 进程");
    expect(markup).toContain("next-model");
    expect(markup).toContain("test-model");
    // The unread namespace says so instead of showing an empty form.
    expect(markup).toContain("data-testid=\"settings-unread-host\"");
    // No credential surface exists on this page.
    expect(markup).not.toContain("apiKey");
    expect(markup).not.toContain("type=\"password\"");
    expect(markup).not.toContain("settings-secret");
    expect(markup).toContain("没有凭据、环境变量或任意键");
  });

  it("shows a plugin's desired intent, actual state and pending configuration apart", () => {
    const markup = renderToStaticMarkup(
      <PluginsPanel
        snapshot={snapshot({
          presentation: presentation({
            plugins: [
              summary({ id: "pending", status: "disabled", desiredEnabled: true, configRevision: 2, effectiveConfigRevision: 1 }),
              summary({ id: "broken", status: "error", desiredEnabled: true }),
            ],
          }),
        })}
        ui={uiState()}
        canWrite
        hostBusy={false}
        onSetEnabled={noop}
      />,
    );

    expect(markup).toContain("期望（持久）：启用；实际状态：disabled");
    expect(markup).toContain("配置修订：期望 2，本实例实际 1");
    expect(markup).toContain("需要重启 Host 进程后才会应用");
    expect(markup).toContain("期望启用，但当前实例并未运行它");
    // The error state still offers no reset or retry.
    expect(markup).toContain("处于错误状态，无法继续操作");
    expect(markup).not.toContain("data-testid=\"plugin-retry\"");
    expect(markup).not.toContain("data-testid=\"plugin-reset\"");
  });

  it("says how far a loaded history falls short of the whole conversation", () => {
    const partial = renderToStaticMarkup(
      <Conversation
        snapshot={snapshot()}
        session={session()}
        coverage={coverage([], { atStart: false, atFence: false, nextCursor: "c1", fragmentOldest: true })}
        activeRun={null}
        loading={false}
        onLoadOlder={noop}
        onLoadNewer={noop}
      />,
    );
    expect(partial).toContain("data-testid=\"history-truth\"");
    expect(partial).toContain("这还不是会话的开头");
    expect(partial).toContain("这是一段片段");
    expect(partial).not.toContain("已覆盖当前全部已提交历史");

    const complete = renderToStaticMarkup(
      <Conversation
        snapshot={snapshot()}
        session={session()}
        coverage={coverage([])}
        activeRun={null}
        loading={false}
        onLoadOlder={noop}
        onLoadNewer={noop}
      />,
    );
    expect(complete).toContain("data-complete=\"true\"");
    expect(complete).toContain("已加载的记录覆盖了该会话当前的全部已提交历史");
  });
});


describe("the approval panel", () => {
  function approval(parts: Partial<ApprovalSnapshot> = {}): ApprovalSnapshot {
    return {
      approvalId: "approval-1",
      executionId: "exec-1",
      sessionId: "session-1",
      runId: "run-1",
      turnId: "turn-1",
      invocationId: "inv-1",
      callId: "call-1",
      name: "counter",
      input: { kind: "json", value: { n: 1, note: "<b>not html</b>" } },
      deadlineAt: 1_700_000_120_000,
      status: "pending",
      canRespond: true,
      ...parts,
    };
  }

  function panel(parts: {
    readonly approval?: Partial<ApprovalSnapshot> | null;
    readonly canRespond?: boolean;
    readonly reply?: ClientSnapshot["approvalReply"];
    readonly waiter?: ShellUiState["approvalWaiter"];
  }) {
    const approvalValue = parts.approval === null ? null : approval(parts.approval ?? {});
    return (
      <ApprovalPanel
        snapshot={snapshot({
          presentation: presentation({ approval: approvalValue }),
          approvalCanRespond: parts.canRespond ?? true,
          approvalReply: parts.reply ?? { state: "pending", requestId: "h-1", approvalId: "approval-1", executionId: "exec-1" },
        })}
        ui={uiState({
          approvalWaiter: parts.waiter === undefined ? { token: 1, approvalId: "approval-1", executionId: "exec-1", decision: null } : parts.waiter,
        })}
        onRespond={noop}
      />
    );
  }

  it("shows the Host's question as read-only text, and offers a decision only while it can be delivered", () => {
    const markup = renderToStaticMarkup(panel({}));

    expect(markup).toContain("data-testid=\"approval-panel\"");
    expect(markup).toContain("counter");
    expect(markup).toContain("将要执行的确切参数");
    // The arguments are inert text: markup inside them is escaped, not parsed.
    expect(markup).toContain("&lt;b&gt;not html&lt;/b&gt;");
    expect(markup).not.toContain("<b>not html</b>");
    expect(markup).toContain("data-testid=\"approval-approve\"");
    expect(markup).toContain("data-testid=\"approval-reject\"");
    // No editable control exists in the card.
    expect(markup).not.toContain("<input");
    expect(markup).not.toContain("<textarea");
    // A pending approval this page is holding a delivery for says so.
    expect(markup).toContain("尚未答复");
  });

  it("offers nothing when the Host is waiting but this connection cannot answer", () => {
    const markup = renderToStaticMarkup(panel({ canRespond: false, waiter: null }));

    expect(markup).toContain("当前连接可以答复：否");
    expect(markup).toContain("这不是拒绝");
    // The controls are shown but inert: a person can see what answering would
    // be, and cannot answer from a connection that cannot deliver.
    expect(markup).toContain("data-testid=\"approval-approve\" disabled");
    expect(markup).toContain("data-testid=\"approval-reject\" disabled");
  });

  it("keeps the Host's decision apart from this page's answer, in every state", () => {
    const approved = renderToStaticMarkup(
      panel({
        approval: { status: "approved", canRespond: false },
        canRespond: false,
        waiter: null,
        reply: { state: "sent", approvalId: "approval-1", executionId: "exec-1", decision: "approve" },
      }),
    );
    expect(approved).toContain("Host：已批准");
    expect(approved).toContain("不等于工具已经执行");
    // The local half is still only about the answer that left this page.
    expect(approved).toContain("答复已发出");

    const denied = renderToStaticMarkup(
      panel({
        approval: { status: "denied", canRespond: false },
        canRespond: false,
        waiter: null,
        reply: { state: "closed", approvalId: "approval-1", executionId: "exec-1" },
      }),
    );
    expect(denied).toContain("Host：已拒绝");
    expect(denied).toContain("不会被派发");

    const expired = renderToStaticMarkup(
      panel({
        approval: { status: "expired", canRespond: false },
        canRespond: false,
        waiter: null,
        reply: { state: "closed", approvalId: "approval-1", executionId: "exec-1" },
      }),
    );
    expect(expired).toContain("Host：已过期");
    expect(expired).toContain("不可再回答");
    expect(expired).not.toContain("data-testid=\"approval-approve\"");
  });

  it("never turns this page's own answer into the Host's decision", () => {
    // The Host is still deciding; this page has sent its answer. What the card
    // may say is what this page did — never a business state it invented.
    const sent = renderToStaticMarkup(
      panel({
        waiter: { token: 1, approvalId: "approval-1", executionId: "exec-1", decision: "approve" },
      }),
    );
    expect(sent, "the local answer is not the Host's decision").toContain("Host：等待答复");
    expect(sent, "the local answer is not the Host's decision").not.toContain("Host：已批准");
    expect(sent).toContain("已提交批准");
    expect(sent).toContain("尚未答复");

    const rejected = renderToStaticMarkup(
      panel({
        waiter: { token: 1, approvalId: "approval-1", executionId: "exec-1", decision: "reject" },
      }),
    );
    expect(rejected).toContain("Host：等待答复");
    expect(rejected).not.toContain("Host：已拒绝");
  });

  it("renders nothing at all when the Host holds no approval", () => {
    expect(renderToStaticMarkup(panel({ approval: null }))).toBe("");
  });
});

function focusedFixture() {
  return {
    hostInstanceId: INSTANCE,
    storageId: DURABLE_STORAGE.storageId,
    sessionId: "session-1",
    focusVersion: 1,
    summary: session(),
    confirmed: true,
    recentRun: null,
  };
}

function plugins0(): PluginSummary {
  return summary({ id: "p", name: "p", version: "0", status: "disabled" });
}

/** One plugin summary, with the fields a plugin's own state derives. */
function summary(overrides: Partial<PluginSummary> & { readonly id: string; readonly status: PluginSummary["status"] }): PluginSummary {
  const configRevision = overrides.configRevision ?? null;
  const effectiveConfigRevision = overrides.effectiveConfigRevision ?? configRevision;
  const desiredEnabled = overrides.desiredEnabled ?? false;
  return {
    name: overrides.id,
    version: "1.0.0",
    permissions: [],
    desiredEnabled,
    configRevision,
    effectiveConfigRevision,
    restartRequired: configRevision !== null && configRevision !== effectiveConfigRevision,
    unavailable: overrides.status === "error" || (desiredEnabled && overrides.status !== "enabled"),
    ...overrides,
  };
}
