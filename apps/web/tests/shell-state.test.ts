/**
 * The controller's own contract: what the shell does about writes, and what it
 * refuses to claim.
 *
 * The client here is a fake — the controller's job is bookkeeping and
 * phrasing, and both can be checked without a host. What must hold is the
 * honesty rule: only an `unknown` outcome becomes an "unconfirmed" record;
 * a refusal stays a refusal; and recovery is an explicit query or an explicit
 * resend of the same submission, never an automatic one.
 */

import { describe, expect, it } from "vitest";

import { ClientError, type Client, type ClientSnapshot } from "@every-dagent/client";
import type {
  ApprovalSnapshot,
  HostSnapshot,
  OperationMap,
  PluginSummary,
  ProtocolErrorCode,
  RunSnapshot,
  SessionSummary,
  ToolApprovalResponse,
} from "@every-dagent/protocol";

import { createShellControllerWith, explainError, normalizedOrigin } from "../src/browser/controller.js";
import { memorySelectionStorage } from "../src/browser/selection.js";

const INSTANCE = "host-instance-a";

const STORAGE = { storageId: "storage-1", retention: "ephemeral" as const, schemaVersion: 1 };

function sessionFixture(sessionId: string): SessionSummary {
  return {
    sessionId,
    generation: 1,
    title: `会话 ${sessionId}`,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    status: "ready",
    blockedReason: null,
    metadataRevision: 0,
    historyRevision: 0,
    committedSeq: 0,
    activeRunId: null,
  };
}

function pluginFixture(id: string, status: PluginSummary["status"] = "disabled"): PluginSummary {
  return {
    id,
    name: id,
    version: "1.0.0",
    permissions: [],
    status,
    desiredEnabled: false,
    configRevision: null,
    effectiveConfigRevision: null,
    restartRequired: false,
    unavailable: status === "error",
  };
}

function runFixture(runId: string, sessionId: string, status: RunSnapshot["status"] = "completed"): RunSnapshot {
  const base = {
    runId,
    submissionId: `sub-${runId}`,
    sessionId,
    text: "hi",
    turnId: null,
    cancelRequested: false,
    acceptedAt: 1_700_000_000_000,
    startedAt: null,
    endedAt: null,
  };
  switch (status) {
    case "accepted":
      return { ...base, status: "accepted", endReason: null, error: null, executionKnowledge: null, live: [], liveTruncated: false };
    case "running":
      return { ...base, status: "running", endReason: null, error: null, executionKnowledge: null, live: [], liveTruncated: false };
    case "completed":
      return { ...base, status: "completed", endReason: "completed", error: null, executionKnowledge: null, live: null };
    case "limited":
      return { ...base, status: "limited", endReason: "max_steps", error: null, executionKnowledge: null, live: null };
    case "cancelled":
      return { ...base, status: "cancelled", endReason: "cancelled", error: null, executionKnowledge: null, live: null };
    case "failed":
      return {
        ...base,
        status: "failed",
        endReason: "error",
        error: { code: "INTERNAL_ERROR", message: "it failed" },
        executionKnowledge: null,
        live: null,
      };
    case "interrupted":
      return {
        ...base,
        status: "interrupted",
        endReason: "interrupted",
        error: null,
        executionKnowledge: "unknown",
        live: null,
      };
  }
}

function presentationFixture(parts: Partial<HostSnapshot> = {}): HostSnapshot {
  return {
    hostInstanceId: INSTANCE,
    watermark: { streamId: "stream-1", sequence: 3 },
    storage: STORAGE,
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

function snapshotFixture(parts: Partial<ClientSnapshot> = {}): ClientSnapshot {
  const base: ClientSnapshot = {
    status: "ready",
    description: {
      protocolVersion: "2",
      hostInstanceId: INSTANCE,
      host: { name: "every-dagent-host", version: "0.1.0" },
      storage: STORAGE,
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
    presentation: presentationFixture(),
    presentationHost: "current",
    directory: {
      hostInstanceId: INSTANCE,
      storageId: STORAGE.storageId,
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

interface FakeCall {
  readonly method: string;
  readonly params: unknown;
}

class FakeClient implements Client {
  handlers = 0;
  handler: ((snapshot: ApprovalSnapshot, signal: AbortSignal) => Promise<ToolApprovalResponse>) | undefined;

  registerToolApprovalHandler(handler?: (snapshot: ApprovalSnapshot, signal: AbortSignal) => ToolApprovalResponse | Promise<ToolApprovalResponse>): void {
    this.handlers += 1;
    this.handler = handler === undefined ? undefined : async (snapshot, signal) => await handler(snapshot, signal);
  }

  readonly calls: FakeCall[] = [];
  onConnect: (() => Promise<void>) | undefined;
  onReconnect: (() => Promise<void>) | undefined;
  onResync: (() => Promise<void>) | undefined;
  onCreate: (() => Promise<OperationMap["sessions.create"]["result"]>) | undefined;
  onStart: ((params: OperationMap["runs.start"]["params"]) => Promise<OperationMap["runs.start"]["result"]>) | undefined;
  onRunGet: ((params: OperationMap["runs.get"]["params"]) => Promise<OperationMap["runs.get"]["result"]>) | undefined;
  onCancel: ((params: OperationMap["runs.cancel"]["params"]) => Promise<OperationMap["runs.cancel"]["result"]>) | undefined;
  onEnable: ((params: OperationMap["plugins.enable"]["params"]) => Promise<OperationMap["plugins.enable"]["result"]>) | undefined;
  onDisable: ((params: OperationMap["plugins.disable"]["params"]) => Promise<OperationMap["plugins.disable"]["result"]>) | undefined;
  onRename: ((params: OperationMap["sessions.rename"]["params"]) => Promise<OperationMap["sessions.rename"]["result"]>) | undefined;
  onDelete: ((params: OperationMap["sessions.delete"]["params"]) => Promise<OperationMap["sessions.delete"]["result"]>) | undefined;
  onSessionGet: ((params: OperationMap["sessions.get"]["params"]) => Promise<OperationMap["sessions.get"]["result"]>) | undefined;
  onSettingsGet: ((params: OperationMap["settings.get"]["params"]) => Promise<OperationMap["settings.get"]["result"]>) | undefined;
  onSettingsUpdate: ((params: OperationMap["settings.update"]["params"]) => Promise<OperationMap["settings.update"]["result"]>) | undefined;
  onFocus: ((sessionId: string) => Promise<void>) | undefined;
  onLoadOlder: (() => Promise<{ readonly loaded: boolean; readonly stale: boolean }>) | undefined;
  onRefreshHead: (() => Promise<{ readonly loaded: boolean; readonly stale: boolean }>) | undefined;

  private current: ClientSnapshot;
  private readonly listeners = new Set<() => void>();

  constructor(initial: ClientSnapshot) {
    this.current = initial;
  }

  setSnapshot(snapshot: ClientSnapshot): void {
    this.current = snapshot;
    for (const listener of [...this.listeners]) listener();
  }

  getSnapshot(): ClientSnapshot {
    return this.current;
  }

  getState(): ClientSnapshot {
    return this.current;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  async connect(): Promise<void> {
    this.calls.push({ method: "connect", params: {} });
    await this.onConnect?.();
  }

  async reconnect(): Promise<void> {
    this.calls.push({ method: "reconnect", params: {} });
    await this.onReconnect?.();
  }

  disconnect(): void {
    this.calls.push({ method: "disconnect", params: {} });
  }

  async resync(): Promise<void> {
    this.calls.push({ method: "resync", params: {} });
    await this.onResync?.();
  }

  async closeSubscription(): Promise<void> {
    this.calls.push({ method: "closeSubscription", params: {} });
  }

  readonly directory = {
    loadOlder: (): Promise<{ readonly loaded: boolean; readonly stale: boolean }> => {
      this.calls.push({ method: "directory.loadOlder", params: {} });
      return this.onLoadOlder === undefined
        ? Promise.resolve({ loaded: false, stale: false })
        : this.onLoadOlder();
    },
    refreshHead: (): Promise<{ readonly loaded: boolean; readonly stale: boolean }> => {
      this.calls.push({ method: "directory.refreshHead", params: {} });
      return this.onRefreshHead === undefined
        ? Promise.resolve({ loaded: false, stale: false })
        : this.onRefreshHead();
    },
    focus: (sessionId: string): Promise<void> => {
      this.calls.push({ method: "directory.focus", params: { sessionId } });
      return this.onFocus === undefined ? Promise.resolve() : this.onFocus(sessionId);
    },
    unfocus: (): void => {
      this.calls.push({ method: "directory.unfocus", params: {} });
    },
    clearFocusIf: (sessionId: string): void => {
      this.calls.push({ method: "directory.clearFocusIf", params: { sessionId } });
    },
  };

  readonly sessions = {
    list: (): Promise<OperationMap["sessions.list"]["result"]> => {
      this.calls.push({ method: "sessions.list", params: {} });
      return Promise.resolve({
        sessions: { items: [], collectionRevision: 1, nextCursor: null, hasMore: false },
      });
    },
    create: (): Promise<OperationMap["sessions.create"]["result"]> => {
      this.calls.push({ method: "sessions.create", params: {} });
      return this.onCreate === undefined
        ? Promise.reject(new Error("no create behaviour"))
        : this.onCreate();
    },
    get: (params: OperationMap["sessions.get"]["params"]): Promise<OperationMap["sessions.get"]["result"]> => {
      this.calls.push({ method: "sessions.get", params });
      return this.onSessionGet === undefined ? Promise.reject(new Error("not used")) : this.onSessionGet(params);
    },
    history: (params: OperationMap["sessions.history"]["params"]): Promise<OperationMap["sessions.history"]["result"]> => {
      this.calls.push({ method: "sessions.history", params });
      return Promise.reject(new Error("not used"));
    },
    rename: (params: OperationMap["sessions.rename"]["params"]): Promise<OperationMap["sessions.rename"]["result"]> => {
      this.calls.push({ method: "sessions.rename", params });
      return this.onRename === undefined ? Promise.reject(new Error("not used")) : this.onRename(params);
    },
    delete: (params: OperationMap["sessions.delete"]["params"]): Promise<OperationMap["sessions.delete"]["result"]> => {
      this.calls.push({ method: "sessions.delete", params });
      return this.onDelete === undefined ? Promise.reject(new Error("not used")) : this.onDelete(params);
    },
  };

  readonly runs = {
    start: (params: OperationMap["runs.start"]["params"]): Promise<OperationMap["runs.start"]["result"]> => {
      this.calls.push({ method: "runs.start", params });
      return this.onStart === undefined ? Promise.reject(new Error("no start behaviour")) : this.onStart(params);
    },
    get: (params: OperationMap["runs.get"]["params"]): Promise<OperationMap["runs.get"]["result"]> => {
      this.calls.push({ method: "runs.get", params });
      return this.onRunGet === undefined ? Promise.reject(new Error("no get behaviour")) : this.onRunGet(params);
    },
    list: (params: OperationMap["runs.list"]["params"]): Promise<OperationMap["runs.list"]["result"]> => {
      this.calls.push({ method: "runs.list", params });
      return Promise.resolve({ runs: { items: [], collectionRevision: 1, nextCursor: null, hasMore: false } });
    },
    cancel: (params: OperationMap["runs.cancel"]["params"]): Promise<OperationMap["runs.cancel"]["result"]> => {
      this.calls.push({ method: "runs.cancel", params });
      return this.onCancel === undefined ? Promise.reject(new Error("no cancel behaviour")) : this.onCancel(params);
    },
  };

  readonly settings = {
    get: (params: OperationMap["settings.get"]["params"]): Promise<OperationMap["settings.get"]["result"]> => {
      this.calls.push({ method: "settings.get", params });
      return this.onSettingsGet === undefined ? Promise.reject(new Error("not used")) : this.onSettingsGet(params);
    },
    update: (params: OperationMap["settings.update"]["params"]): Promise<OperationMap["settings.update"]["result"]> => {
      this.calls.push({ method: "settings.update", params });
      return this.onSettingsUpdate === undefined ? Promise.reject(new Error("not used")) : this.onSettingsUpdate(params);
    },
  };

  readonly plugins = {
    list: (): Promise<OperationMap["plugins.list"]["result"]> => {
      this.calls.push({ method: "plugins.list", params: {} });
      return Promise.resolve({ plugins: [] });
    },
    enable: (params: OperationMap["plugins.enable"]["params"]): Promise<OperationMap["plugins.enable"]["result"]> => {
      this.calls.push({ method: "plugins.enable", params });
      return this.onEnable === undefined ? Promise.reject(new Error("no enable behaviour")) : this.onEnable(params);
    },
    disable: (params: OperationMap["plugins.disable"]["params"]): Promise<OperationMap["plugins.disable"]["result"]> => {
      this.calls.push({ method: "plugins.disable", params });
      return this.onDisable === undefined ? Promise.reject(new Error("no disable behaviour")) : this.onDisable(params);
    },
  };
}


/** A pin as the client holds one: the facts a session write is gated on. */
function pinFixture(parts: {
  readonly sessionId?: string;
  readonly version?: number;
  readonly confirmed?: boolean;
  readonly metadataRevision?: number;
  readonly activeRunId?: string | null;
}) {
  const sessionId = parts.sessionId ?? "session-1";
  return {
    hostInstanceId: INSTANCE,
    storageId: STORAGE.storageId,
    sessionId,
    focusVersion: parts.version ?? 1,
    summary: {
      ...sessionFixture(sessionId),
      metadataRevision: parts.metadataRevision ?? 3,
      activeRunId: parts.activeRunId ?? null,
    },
    confirmed: parts.confirmed ?? true,
    recentRun: null,
  };
}

function settingsSnapshotFixture(namespace: string, desiredRevision = 1, effectiveRevision: number | null = 1) {
  return {
    namespace,
    desiredRevision,
    effectiveRevision,
    restartRequired: desiredRevision !== effectiveRevision,
    desiredValue: { provider: "test", model: "test-model" },
    effectiveValue: effectiveRevision === null ? null : { provider: "test", model: "test-model" },
  };
}

function unknownOutcome(): ClientError {
  return new ClientError({ kind: "connection", code: "CONNECTION_LOST", message: "lost", outcome: "unknown", reason: "channel-closed" });
}

function remoteError(code: ProtocolErrorCode, message = "no"): ClientError {
  return new ClientError({ kind: "remote", code, message });
}

function makeController(snapshot: ClientSnapshot = snapshotFixture(), initial: string | null = "http://127.0.0.1:4100") {
  const client = new FakeClient(snapshot);
  const storage = memorySelectionStorage();
  const controller = createShellControllerWith(client, {
    storage,
    initialBinding: initial,
    newId: (() => {
      let count = 0;
      return (): string => {
        count += 1;
        return `submission-${count}`;
      };
    })(),
    now: () => 1_700_000_000_000,
  });
  return { client, storage, controller };
}

describe("starting a run", () => {
  it("passes the submission through and clears the pending flag", async () => {
    const { client, controller } = makeController();
    let sawParams: OperationMap["runs.start"]["params"] | undefined;
    client.onStart = async (params) => {
      sawParams = params;
      return { run: runFixture("run-1", params.sessionId, "accepted") };
    };

    const submitted = await controller.startRun("session-1", "你好 ");

    expect(submitted).toBe(true);
    // The text is passed verbatim: the shell does not trim what the user sent.
    expect(sawParams).toEqual({ sessionId: "session-1", submissionId: "submission-1", text: "你好 " });
    expect(controller.getState().startingRun).toBe(false);
    expect(controller.getState().unknownWrites).toEqual([]);
  });

  it("refuses empty input without calling the client", async () => {
    const { client, controller } = makeController();
    const submitted = await controller.startRun("session-1", "   ");
    expect(submitted).toBe(false);
    expect(client.calls.filter((call) => call.method === "runs.start")).toEqual([]);
    expect(controller.getState().notices[0]?.text).toContain("不能为空");
  });

  it("guards against a second submit while one is in flight", async () => {
    const { client, controller } = makeController();
    let release: (() => void) | undefined;
    client.onStart = (params) =>
      new Promise((resolve) => {
        release = () => {
          resolve({ run: runFixture("run-1", params.sessionId, "accepted") });
        };
      });

    const first = controller.startRun("session-1", "one");
    await controller.startRun("session-1", "two");
    release?.();
    await first;

    const starts = client.calls.filter((call) => call.method === "runs.start");
    expect(starts).toHaveLength(1);
    expect((starts[0]?.params as { text: string }).text).toBe("one");
  });

  it("records an unknown outcome as unconfirmed, with the original identity", async () => {
    const { client, controller } = makeController();
    client.onStart = async () => {
      throw unknownOutcome();
    };

    const submitted = await controller.startRun("session-1", "hello");

    // The submission left the client; the draft may be cleared.
    expect(submitted).toBe(true);
    const [record] = controller.getState().unknownWrites;
    expect(record).toMatchObject({
      kind: "start",
      hostInstanceId: INSTANCE,
      sessionId: "session-1",
      submissionId: "submission-1",
      text: "hello",
    });
    expect(controller.getState().notices.at(-1)?.text).toContain("未确认");
  });

  it("keeps a definite refusal a refusal, not an unconfirmed write", async () => {
    const { client, controller } = makeController();
    client.onStart = async () => {
      throw remoteError("HOST_BUSY");
    };

    const submitted = await controller.startRun("session-1", "hello");

    expect(submitted).toBe(false);
    expect(controller.getState().unknownWrites).toEqual([]);
    expect(controller.getState().notices.at(-1)?.text).toContain("Host 正忙");
  });
});

describe("sessions and selection", () => {
  it("selects a created session under the described instance", async () => {
    const { client, storage, controller } = makeController();
    client.onCreate = async () => ({ session: sessionFixture("session-9") });

    await controller.createSession();

    expect(controller.getState().selection).toEqual({ hostInstanceId: INSTANCE, sessionId: "session-9" });
    expect(storage.read()).toEqual({ hostInstanceId: INSTANCE, sessionId: "session-9" });
  });

  it("records a lost create answer as unconfirmed", async () => {
    const { client, controller } = makeController();
    client.onCreate = async () => {
      throw unknownOutcome();
    };

    await controller.createSession();

    expect(controller.getState().unknownWrites[0]).toMatchObject({ kind: "create-session", hostInstanceId: INSTANCE });
    expect(controller.getState().creatingSession).toBe(false);
  });

  it("keeps a selection the user made while a create was still in flight", async () => {
    // The late answer belongs to a request from before the user picked another
    // session; selecting the new session here would take back that choice — and
    // with it the composer and whatever draft it was holding.
    const { client, storage, controller } = makeController();
    let release: (() => void) | undefined;
    client.onCreate = () =>
      new Promise((resolve) => {
        release = () => {
          resolve({ session: sessionFixture("session-9") });
        };
      });

    const creating = controller.createSession();
    controller.selectSession("session-4");
    release?.();
    await creating;

    expect(controller.getState().selection).toEqual({ hostInstanceId: INSTANCE, sessionId: "session-4" });
    expect(storage.read()).toEqual({ hostInstanceId: INSTANCE, sessionId: "session-4" });
    // Silence would leave the user wondering where the new session went.
    expect(controller.getState().notices.at(-1)?.text).toContain("未自动切换");
  });

  it("scopes a selection to the presentation's host", () => {
    const { controller } = makeController(
      snapshotFixture({ presentation: presentationFixture({ hostInstanceId: "another-host" }) }),
    );
    controller.selectSession("session-1");
    expect(controller.getState().selection).toEqual({ hostInstanceId: "another-host", sessionId: "session-1" });
  });
});

describe("cancel and plugin operations", () => {
  it("records a lost cancel answer without pretending the run stopped", async () => {
    const { client, controller } = makeController();
    client.onCancel = async () => {
      throw unknownOutcome();
    };

    await controller.cancelRun("run-7");

    expect(controller.getState().unknownWrites[0]).toMatchObject({ kind: "cancel", runId: "run-7" });
    expect(controller.getState().cancellingRunId).toBeNull();
  });

  it("records a lost plugin operation and reports a definite failure", async () => {
    const { client, controller } = makeController();
    client.onEnable = async () => {
      throw unknownOutcome();
    };
    await controller.setPluginEnabled("calculator", true);
    expect(controller.getState().unknownWrites[0]).toMatchObject({ kind: "plugin", pluginId: "calculator", operation: "enable" });

    client.onDisable = async () => {
      throw remoteError("PLUGIN_UNAVAILABLE");
    };
    await controller.setPluginEnabled("calculator", false);
    expect(controller.getState().unknownWrites).toHaveLength(1);
    expect(controller.getState().notices.at(-1)?.text).toContain("插件当前不可操作");
    expect(controller.getState().pluginPending).toEqual({});
  });

  it("treats a plugin id that names an inherited property like any other id", async () => {
    // `constructor` is a legal plugin id under the protocol's id grammar, and
    // the pending map is a plain record: an unguarded read finds
    // `Object.prototype.constructor` and the plugin is locked out of both
    // operations as if one were always in flight.
    const { client, controller } = makeController();
    let release: (() => void) | undefined;
    client.onEnable = () =>
      new Promise((resolve) => {
        release = () => {
          resolve({ plugin: pluginFixture("constructor", "enabled") });
        };
      });

    const enabling = controller.setPluginEnabled("constructor", true);
    // Own property, not the inherited one: the operation really started.
    expect(Object.hasOwn(controller.getState().pluginPending, "constructor")).toBe(true);
    release?.();
    await enabling;

    expect(client.calls.filter((call) => call.method === "plugins.enable")).toHaveLength(1);
    expect(controller.getState().pluginPending).toEqual({});
    // Not busy, and not a lost answer: an ordinary operation, correctly recorded.
    expect(controller.getState().notices.filter((notice) => notice.tone === "error")).toEqual([]);
    expect(controller.getState().unknownWrites).toEqual([]);
  });
});

describe("recovering an unconfirmed submission", () => {
  it("resolves the record when the host confirms it", async () => {
    const { client, controller } = makeController();
    client.onStart = async () => {
      throw unknownOutcome();
    };
    await controller.startRun("session-1", "hello");
    const record = controller.getState().unknownWrites[0];

    client.onRunGet = async (params) => {
      expect(params).toEqual({ submissionId: "submission-1" });
      return { run: runFixture("run-3", "session-1", "completed") };
    };
    await controller.checkUnknown(record?.id ?? "");

    expect(controller.getState().unknownWrites).toEqual([]);
    expect(controller.getState().notices.at(-1)?.text).toContain("已被 Host 接受");
  });

  it("keeps the record when the host does not know the submission", async () => {
    const { client, controller } = makeController();
    client.onStart = async () => {
      throw unknownOutcome();
    };
    await controller.startRun("session-1", "hello");
    const record = controller.getState().unknownWrites[0];

    client.onRunGet = async () => {
      throw remoteError("RUN_NOT_FOUND");
    };
    await controller.checkUnknown(record?.id ?? "");

    expect(controller.getState().unknownWrites).toHaveLength(1);
    expect(controller.getState().notices.at(-1)?.text).toContain("仍待确认");
  });

  it("refuses to confirm anything across a host change", async () => {
    const { client, controller } = makeController();
    client.onStart = async () => {
      throw unknownOutcome();
    };
    await controller.startRun("session-1", "hello");
    const record = controller.getState().unknownWrites[0];

    // The page reconnects to a different host.
    client.setSnapshot(
      snapshotFixture({
        description: { ...snapshotFixture().description!, hostInstanceId: "host-instance-b" },
        presentation: presentationFixture({ hostInstanceId: "host-instance-b" }),
      }),
    );

    let queried = false;
    client.onRunGet = async () => {
      queried = true;
      return { run: runFixture("run-3", "session-1", "completed") };
    };
    await controller.checkUnknown(record?.id ?? "");

    expect(queried).toBe(false);
    expect(controller.getState().unknownWrites).toHaveLength(1);
    expect(controller.getState().notices.at(-1)?.text).toContain("Host 已更换");
  });

  it("resends the same submission verbatim, on the same host", async () => {
    const { client, controller } = makeController();
    client.onStart = async () => {
      throw unknownOutcome();
    };
    await controller.startRun("session-1", "hello world");
    const record = controller.getState().unknownWrites[0];

    const resent: OperationMap["runs.start"]["params"][] = [];
    client.onStart = async (params) => {
      resent.push(params);
      return { run: runFixture("run-9", params.sessionId, "completed") };
    };
    await controller.resubmitUnknownStart(record?.id ?? "");

    expect(resent).toEqual([{ sessionId: "session-1", submissionId: "submission-1", text: "hello world" }]);
    expect(controller.getState().unknownWrites).toEqual([]);
  });
});

describe("connection controls and notices", () => {
  it("refuses to connect without an address, and normalizes a valid one", async () => {
    const bare = makeController(snapshotFixture(), null);
    await bare.controller.connect();
    expect(bare.controller.getState().notices.at(-1)?.text).toContain("尚未配置");

    await bare.controller.connectTo("not a url");
    expect(bare.controller.getState().notices.at(-1)?.text).toContain("不是有效的");

    await bare.controller.connectTo("http://127.0.0.1:4100/");
    expect(bare.controller.getState().bindingOrigin).toBe("http://127.0.0.1:4100");
    expect(bare.client.calls.some((call) => call.method === "connect")).toBe(true);
  });

  it("keeps only the newest notices", async () => {
    const { controller } = makeController();
    for (let index = 0; index < 12; index += 1) {
      await controller.startRun("session-1", "   ");
    }
    expect(controller.getState().notices).toHaveLength(8);
  });

  it("dismisses records and notices without touching anything else", async () => {
    const { client, controller } = makeController();
    client.onStart = async () => {
      throw unknownOutcome();
    };
    await controller.startRun("session-1", "hello");
    const record = controller.getState().unknownWrites[0];

    controller.dismissUnknown(record?.id ?? "");
    expect(controller.getState().unknownWrites).toEqual([]);

    const notice = controller.getState().notices[0];
    controller.dismissNotice(notice?.id ?? "");
    expect(controller.getState().notices.map((entry) => entry.id)).not.toContain(notice?.id);
  });
});


describe("renaming a session", () => {
  it("sends the revision the draft was opened at and reports the host's confirmation", async () => {
    const { client, controller } = makeController(snapshotFixture({ focusedSession: pinFixture({}) }));
    const sent: OperationMap["sessions.rename"]["params"][] = [];
    client.onRename = async (params) => {
      sent.push(params);
      return { session: { ...sessionFixture("session-1"), title: params.title, metadataRevision: 4 } };
    };

    controller.beginRename("session-1");
    const left = await controller.renameSession("session-1", "new title");

    expect(left).toBe(true);
    expect(sent).toEqual([{ sessionId: "session-1", expectedRevision: 3, title: "new title" }]);
    expect(controller.getState().notices.at(-1)?.text).toContain("已保存");
    expect(controller.getState().unknownWrites).toEqual([]);
  });

  it("refuses a blank title without calling the client", async () => {
    const { client, controller } = makeController(snapshotFixture({ focusedSession: pinFixture({}) }));
    controller.beginRename("session-1");
    expect(await controller.renameSession("session-1", "   ")).toBe(false);
    expect(client.calls.filter((call) => call.method === "sessions.rename")).toEqual([]);
  });

  it("treats a conflict as a refusal, keeps the draft, and never retries", async () => {
    const { client, controller } = makeController(snapshotFixture({ focusedSession: pinFixture({}) }));
    client.onRename = async () => {
      throw remoteError("REVISION_CONFLICT");
    };

    controller.beginRename("session-1");
    const left = await controller.renameSession("session-1", "new title");

    expect(left).toBe(false);
    expect(client.calls.filter((call) => call.method === "sessions.rename")).toHaveLength(1);
    expect(controller.getState().unknownWrites).toEqual([]);
    expect(controller.getState().notices.at(-1)?.text).toContain("不会自动重试");
  });

  it("records a lost rename answer as unconfirmed, with the revision it was aimed at", async () => {
    const { controller } = makeController(snapshotFixture({ focusedSession: pinFixture({}) }));
    const client = controller.client as unknown as FakeClient;
    client.onRename = async () => {
      throw unknownOutcome();
    };

    controller.beginRename("session-1");
    const left = await controller.renameSession("session-1", "new title");

    expect(left).toBe(true);
    expect(controller.getState().unknownWrites[0]).toMatchObject({
      kind: "rename-session",
      sessionId: "session-1",
      expectedRevision: 3,
      title: "new title",
      hostInstanceId: INSTANCE,
    });
    // Exactly one request crossed: an unconfirmed write is never resent.
    expect(
      client.calls.filter((call) => call.method === "sessions.rename"),
      "an unconfirmed rename is never resent",
    ).toHaveLength(1);
  });

  it("does not report success for a rename the reader has already moved away from", async () => {
    const { client, controller } = makeController(snapshotFixture({ focusedSession: pinFixture({}) }));
    let release: (() => void) | undefined;
    client.onRename = () =>
      new Promise((resolve) => {
        release = () => {
          resolve({ session: sessionFixture("session-1") });
        };
      });

    controller.beginRename("session-1");
    const renaming = controller.renameSession("session-1", "new title");
    client.setSnapshot(snapshotFixture({ focusedSession: pinFixture({ sessionId: "session-2", version: 2 }) }));
    release?.();
    await renaming;

    expect(controller.getState().notices.some((notice) => notice.text.includes("已保存"))).toBe(false);
  });

  it("keeps one report per session however often that session is renamed", async () => {
    const { client, controller } = makeController(snapshotFixture({ focusedSession: pinFixture({}) }));
    client.onRename = async (params) => ({
      session: { ...sessionFixture(params.sessionId), title: params.title, metadataRevision: 4 },
    });

    for (const title of ["第一版", "第二版", "第三版"]) {
      controller.beginRename("session-1");
      expect(await controller.renameSession("session-1", title)).toBe(true);
    }

    // Three renames, three answers to the same question: the newest one is what
    // the user is told, and it is told once — never as three identical rows.
    const reports = controller.getState().notices.filter((notice) => notice.text.includes("已保存"));
    expect(reports).toHaveLength(1);
    expect(reports[0]?.text).toContain("会话「第三版」");
  });

  it("keeps a second session's rename as its own report", async () => {
    const { client, controller } = makeController(snapshotFixture({ focusedSession: pinFixture({ sessionId: "session-1" }) }));
    client.onRename = async (params) => ({
      session: { ...sessionFixture(params.sessionId), title: params.title, metadataRevision: 4 },
    });

    controller.beginRename("session-1");
    await controller.renameSession("session-1", "一号");
    // Another session is another subject: its result is a result of its own and
    // gets its own row, named so the two cannot read as one repeated notice.
    client.setSnapshot(snapshotFixture({ focusedSession: pinFixture({ sessionId: "session-2" }) }));
    controller.beginRename("session-2");
    await controller.renameSession("session-2", "二号");

    const reports = controller.getState().notices.filter((notice) => notice.text.includes("已保存"));
    expect(reports.map((notice) => notice.text)).toEqual([
      expect.stringContaining("会话「一号」"),
      expect.stringContaining("会话「二号」"),
    ]);
  });
});

describe("deleting a session", () => {
  it("clears the selection on a confirmed deletion and never re-selects", async () => {
    const { client, controller } = makeController(snapshotFixture({ focusedSession: pinFixture({}) }));
    controller.selectSession("session-1");
    let sent: OperationMap["sessions.delete"]["params"] | undefined;
    client.onDelete = async (params) => {
      sent = params;
      return { sessionId: "session-1", generation: 1, deleted: true };
    };

    const done = await controller.deleteSession("session-1");

    expect(done).toBe(true);
    expect(sent).toEqual({ sessionId: "session-1", expectedRevision: 3 });
    expect(controller.getState().selection).toBeNull();
    // The focus is retired *for that session*: a completion is not allowed to
    // retire a focus the reader has moved on to.
    expect(client.calls.filter((call) => call.method === "directory.clearFocusIf")).toEqual([
      { method: "directory.clearFocusIf", params: { sessionId: "session-1" } },
    ]);
    expect(controller.getState().notices.at(-1)?.text).toContain("永久删除");
  });

  it("reports a busy host without cancelling anything", async () => {
    const { client, controller } = makeController(snapshotFixture({ focusedSession: pinFixture({}) }));
    client.onDelete = async () => {
      throw remoteError("HOST_BUSY");
    };

    const done = await controller.deleteSession("session-1");

    expect(done).toBe(false);
    expect(client.calls.filter((call) => call.method === "runs.cancel")).toEqual([]);
    expect(controller.getState().notices.at(-1)?.text).toContain("不会自动取消运行");
  });

  it("treats a conflict as a refusal and a missing session as news", async () => {
    const { client, controller } = makeController(snapshotFixture({ focusedSession: pinFixture({}) }));
    client.onDelete = async () => {
      throw remoteError("REVISION_CONFLICT");
    };
    expect(await controller.deleteSession("session-1")).toBe(false);
    expect(controller.getState().notices.at(-1)?.text).toContain("不会自动重试");

    client.onDelete = async () => {
      throw remoteError("SESSION_NOT_FOUND");
    };
    expect(await controller.deleteSession("session-1")).toBe(false);
    expect(controller.getState().notices.at(-1)?.text).toContain("已经不存在");
  });

  it("records a lost delete answer as unconfirmed and checks it against the host", async () => {
    const { client, controller } = makeController(snapshotFixture({ focusedSession: pinFixture({}) }));
    client.onDelete = async () => {
      throw unknownOutcome();
    };
    const done = await controller.deleteSession("session-1");
    expect(done).toBe(true);
    const record = controller.getState().unknownWrites[0];
    expect(record).toMatchObject({ kind: "delete-session", sessionId: "session-1", expectedRevision: 3 });
    // Exactly one delete crossed: an unconfirmed write is never resent.
    expect(
      client.calls.filter((call) => call.method === "sessions.delete"),
      "an unconfirmed delete is never resent",
    ).toHaveLength(1);

    let asked: OperationMap["sessions.get"]["params"] | undefined;
    client.onSessionGet = async (params) => {
      asked = params;
      return { session: sessionFixture("session-1") };
    };
    await controller.checkUnknown(record?.id ?? "");

    expect(asked).toEqual({ sessionId: "session-1" });
    expect(controller.getState().unknownWrites).toEqual([]);
    expect(controller.getState().notices.at(-1)?.text).toContain("仍然存在");
  });
});

describe("settings", () => {
  it("reads a namespace and reports no error for an answered read", async () => {
    const { client, controller } = makeController();
    client.onSettingsGet = async (params) => {
      expect(params).toEqual({ namespace: "model" });
      return { settings: settingsSnapshotFixture("model", 2, 1) };
    };

    await controller.readSettings("model");

    expect(controller.getState().settingsPending).toBeNull();
    expect(controller.getState().notices.filter((notice) => notice.tone === "error")).toEqual([]);
  });

  it("saves a full replacement against the revision it was read at, and says saved", async () => {
    const { client, controller } = makeController();
    let sent: OperationMap["settings.update"]["params"] | undefined;
    client.onSettingsUpdate = async (params) => {
      sent = params;
      return { settings: settingsSnapshotFixture("model", 2, 1) };
    };

    const answered = await controller.saveSettings("model", { provider: "test", model: "next" }, 1);

    // Confirmed is its own fact: the host took the write.
    expect(answered).toEqual({ kind: "confirmed" });
    expect(sent).toEqual({ namespace: "model", expectedRevision: 1, value: { provider: "test", model: "next" } });
    const text = controller.getState().notices.at(-1)?.text ?? "";
    expect(text).toContain("已保存");
    expect(text).toContain("重启");
    expect(text).not.toContain("已生效");
  });

  it("keeps one report per namespace however often that namespace is saved", async () => {
    const { client, controller } = makeController();
    client.onSettingsUpdate = async () => ({ settings: settingsSnapshotFixture("model", 2, 1) });

    await controller.saveSettings("model", { provider: "test", model: "a" }, 1);
    await controller.saveSettings("model", { provider: "test", model: "b" }, 2);
    await controller.saveSettings("model", { provider: "test", model: "c" }, 3);

    const reports = controller.getState().notices.filter((notice) => notice.text.includes("设置已保存"));
    expect(reports).toHaveLength(1);
    expect(reports[0]?.text).toContain("model");
  });

  it("treats a conflict as a refusal and never replays the save", async () => {
    const { client, controller } = makeController();
    client.onSettingsUpdate = async () => {
      throw remoteError("REVISION_CONFLICT");
    };

    expect(await controller.saveSettings("model", { provider: "test", model: "next" }, 1)).toEqual({
      kind: "refused",
      reason: "revision-conflict",
    });
    expect(client.calls.filter((call) => call.method === "settings.update")).toHaveLength(1);
    expect(controller.getState().unknownWrites).toEqual([]);
  });

  it("records a lost save as unconfirmed, and confirmation reads the current state", async () => {
    const { client, controller } = makeController();
    client.onSettingsUpdate = async () => {
      throw unknownOutcome();
    };
    expect(
      await controller.saveSettings(
        "host",
        { systemPrompt: "PROMPT-TEXT-THAT-MUST-NOT-BE-KEPT", loop: { maxSteps: 4, maxModelAttempts: 2 } },
        1,
      ),
    ).toEqual({ kind: "unknown" });
    const record = controller.getState().unknownWrites[0];
    expect(record).toMatchObject({ kind: "settings-update", namespace: "host", expectedRevision: 1 });
    // Exactly one save crossed: an unconfirmed write is never resent.
    expect(
      client.calls.filter((call) => call.method === "settings.update"),
      "an unconfirmed settings save is never resent",
    ).toHaveLength(1);
    // The record names the fields that were sent and keeps no values: a
    // configuration dump is not a note about a request.
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("PROMPT-TEXT-THAT-MUST-NOT-BE-KEPT");
    expect(serialized).not.toContain("maxSteps");

    client.onSettingsGet = async () => ({ settings: settingsSnapshotFixture("host", 2, 1) });
    await controller.checkUnknown(record?.id ?? "");
    expect(controller.getState().unknownWrites).toEqual([]);
    expect(controller.getState().notices.at(-1)?.text).toContain("原来的保存请求结果仍未确认");
  });
});

describe("the unconfirmed-write budget", () => {
  it("stops starting ordinary writes once sixteen are unresolved, but never blocks a cancel", async () => {
    const { client, controller } = makeController();
    client.onStart = async () => {
      throw unknownOutcome();
    };
    for (let index = 0; index < 16; index += 1) {
      await controller.startRun("session-1", "hello");
    }
    expect(controller.getState().unknownWrites).toHaveLength(16);

    expect(await controller.startRun("session-1", "seventeen")).toBe(false);
    expect(controller.getState().notices.at(-1)?.text).toContain("已达上限");
    expect(client.calls.filter((call) => call.method === "runs.start")).toHaveLength(16);

    client.onCancel = async () => ({ run: runFixture("run-1", "session-1", "cancelled") });
    await controller.cancelRun("run-1");
    expect(client.calls.filter((call) => call.method === "runs.cancel")).toHaveLength(1);
    expect(controller.getState().unknownWrites).toHaveLength(16);
  });
});

describe("the directory controls", () => {
  it("reports a stale traversal as something to re-read, not something to retry", async () => {
    const { client, controller } = makeController();
    client.onLoadOlder = async () => ({ loaded: false, stale: true });

    await controller.loadOlderSessions();

    expect(controller.getState().directoryLoading).toBe(false);
    expect(controller.getState().notices.at(-1)?.text).toContain("重新读取目录");
    expect(client.calls.filter((call) => call.method === "directory.loadOlder")).toHaveLength(1);
  });

  it("does not stack directory reads while one is in flight", async () => {
    const { client, controller } = makeController();
    let release: (() => void) | undefined;
    client.onLoadOlder = () =>
      new Promise((resolve) => {
        release = () => {
          resolve({ loaded: true, stale: false });
        };
      });

    const first = controller.loadOlderSessions();
    await controller.loadOlderSessions();
    release?.();
    await first;

    expect(client.calls.filter((call) => call.method === "directory.loadOlder")).toHaveLength(1);
  });

  it("asks the client to confirm a session when it is selected, and only when needed", async () => {
    const { client, controller } = makeController();
    controller.selectSession("session-1");
    expect(client.calls.filter((call) => call.method === "directory.focus")).toHaveLength(1);

    // Selecting another session asks for its confirmation.
    controller.selectSession("session-2");
    expect(client.calls.filter((call) => call.method === "directory.focus")).toHaveLength(2);

    // The shell re-confirms when the connection becomes current again — and
    // does not re-ask while the pin it already holds is confirmed.
    client.setSnapshot(snapshotFixture({ focusedSession: pinFixture({ sessionId: "session-2", version: 3 }) }));
    await controller.ensureFocus();
    expect(client.calls.filter((call) => call.method === "directory.focus")).toHaveLength(2);
  });
});


describe("the typed approval handler", () => {
  function approvalFixture(parts: Partial<ApprovalSnapshot> = {}): ApprovalSnapshot {
    return {
      approvalId: "approval-1",
      executionId: "exec-1",
      sessionId: "session-1",
      runId: "run-1",
      turnId: "turn-1",
      invocationId: "inv-1",
      callId: "call-1",
      name: "counter",
      input: { kind: "json", value: { n: 1 } },
      deadlineAt: 1_700_000_120_000,
      status: "pending",
      canRespond: true,
      ...parts,
    };
  }

  function approvalSnapshot(parts: Partial<ApprovalSnapshot> = {}): ClientSnapshot {
    return snapshotFixture({
      presentation: presentationFixture({ approval: approvalFixture(parts) }),
      approvalReply: { state: "pending", requestId: "h-1", approvalId: "approval-1", executionId: "exec-1" },
      approvalCanRespond: true,
    });
  }

  it("registers exactly one handler, at composition", async () => {
    const { client } = makeController();
    expect(client.handlers).toBe(1);
    await Promise.resolve();
    expect(client.handlers).toBe(1);
  });

  it("answers the approval on screen, once, and reports only that it sent it", async () => {
    const { client, controller } = makeController(approvalSnapshot());
    const controllerAbort = new AbortController();
    const answering = client.handler?.(approvalFixture(), controllerAbort.signal);
    await Promise.resolve();
    expect(controller.getState().approvalWaiter).toMatchObject({
      approvalId: "approval-1",
      executionId: "exec-1",
      decision: null,
    });

    controller.respondApproval("approve");
    expect(controller.getState().approvalWaiter?.decision).toBe("approve");
    // The shell's own state never claims what the Host decided: the answer is
    // the client's, and the Host's status is read from the snapshot.
    expect(JSON.stringify(controller.getState())).not.toContain("approved");
    await expect(answering).resolves.toEqual({ approvalId: "approval-1", executionId: "exec-1", decision: "approve" });

    // Consumed once: a second click answers nothing.
    controller.respondApproval("reject");
    expect(controller.getState().approvalWaiter?.decision).toBe("approve");
  });

  it("refuses a click the client can no longer deliver", async () => {
    const { client, controller } = makeController(
      snapshotFixture({
        presentation: presentationFixture({ approval: approvalFixture() }),
        approvalReply: { state: "none" },
        approvalCanRespond: false,
      }),
    );
    const abort = new AbortController();
    const answering = client.handler?.(approvalFixture(), abort.signal);
    await Promise.resolve();

    controller.respondApproval("approve");

    // Nothing was decided: the button was a stale click, and a stale click is
    // not an answer about anyone's execution.
    expect(controller.getState().approvalWaiter?.decision).toBeNull();
    abort.abort();
    await Promise.resolve();
    expect(controller.getState().approvalWaiter).toBeNull();
    void answering;
  });

  it("retires a delivery that ended, without turning it into a rejection", async () => {
    const { client, controller } = makeController(approvalSnapshot());
    const abort = new AbortController();
    const answering = client.handler?.(approvalFixture(), abort.signal);
    await Promise.resolve();
    expect(controller.getState().approvalWaiter).not.toBeNull();

    // Disconnect / replaced stream / deadline: the delivery is over.
    abort.abort();
    await Promise.resolve();
    expect(controller.getState().approvalWaiter).toBeNull();

    // The promise it answered is nobody's decision — and no click can send one.
    controller.respondApproval("reject");
    expect(controller.getState().approvalWaiter).toBeNull();
    void answering;
  });

  it("replaces a live delivery with the newer one, keeping only the newer token", async () => {
    const { client, controller } = makeController(approvalSnapshot());
    const first = new AbortController();
    const second = new AbortController();
    const firstAnswer = client.handler?.(approvalFixture(), first.signal);
    await Promise.resolve();
    const firstToken = controller.getState().approvalWaiter?.token;

    // The newer delivery is about the execution the Host has on screen now.
    client.setSnapshot(approvalSnapshot({ approvalId: "approval-2", executionId: "exec-2" }));
    const secondAnswer = client.handler?.(
      approvalFixture({ approvalId: "approval-2", executionId: "exec-2" }),
      second.signal,
    );
    await Promise.resolve();
    expect(controller.getState().approvalWaiter).toMatchObject({ approvalId: "approval-2" });
    expect(controller.getState().approvalWaiter?.token).not.toBe(firstToken);

    // The first delivery's own end cannot retire the delivery that replaced it.
    first.abort();
    await Promise.resolve();
    expect(controller.getState().approvalWaiter).toMatchObject({ approvalId: "approval-2" });

    controller.respondApproval("approve");
    await expect(secondAnswer).resolves.toEqual({
      approvalId: "approval-2",
      executionId: "exec-2",
      decision: "approve",
    });
    void firstAnswer;
  });
});

describe("phrasing", () => {
  it("maps every error kind to a sentence without parsing the wire message", () => {
    expect(explainError(remoteError("HOST_BUSY", "not parsable"))).toContain("Host 正忙");
    expect(explainError(unknownOutcome())).toContain("结果未知");
    expect(
      explainError(new ClientError({ kind: "client", code: "CLIENT_MISUSE", message: "no", outcome: "not-sent", reason: "sync-in-flight" })),
    ).toContain("未发送");
    expect(explainError(new ClientError({ kind: "protocol", code: "PROTOCOL_VIOLATION", message: "no", outcome: "unknown", reason: "invalid-frame" }))).toContain("协议错误");
    expect(explainError(new Error("raw"))).toContain("未预期");
  });

  it("accepts only real http origins", () => {
    expect(normalizedOrigin("http://127.0.0.1:4100")).toBe("http://127.0.0.1:4100");
    expect(normalizedOrigin("http://127.0.0.1:4100/")).toBe("http://127.0.0.1:4100");
    expect(normalizedOrigin("ftp://example.com")).toBeNull();
    expect(normalizedOrigin("http://user:pass@127.0.0.1:1")).toBeNull();
    expect(normalizedOrigin("")).toBeNull();
  });
});

describe("session write ownership", () => {
  it("sends the revision the draft captured, not the one on screen when it is submitted", async () => {
    const { client, controller } = makeController(snapshotFixture({ focusedSession: pinFixture({ metadataRevision: 3 }) }));
    const sent: OperationMap["sessions.rename"]["params"][] = [];
    client.onRename = async (params) => {
      sent.push(params);
      throw remoteError("REVISION_CONFLICT");
    };

    controller.beginRename("session-1");
    // The world moves on while the draft is open: the reader's client now sees
    // revision 4. The draft is still a rename against revision 3.
    client.setSnapshot(snapshotFixture({ focusedSession: pinFixture({ metadataRevision: 4 }) }));

    expect(await controller.renameSession("session-1", "draft title")).toBe(false);
    expect(sent, "a rename is aimed at the revision its draft captured, never at a later one").toEqual([
      { sessionId: "session-1", expectedRevision: 3, title: "draft title" },
    ]);
    // Refused, kept, and not retried.
    expect(client.calls.filter((call) => call.method === "sessions.rename")).toHaveLength(1);
    expect(controller.getState().notices.at(-1)?.text).toContain("草稿基于 3");
    expect(controller.getState().renameDraft).toEqual({ sessionId: "session-1", expectedRevision: 3 });
  });

  it("refuses a rename whose draft was never opened", async () => {
    const { client, controller } = makeController(snapshotFixture({ focusedSession: pinFixture({}) }));
    expect(await controller.renameSession("session-1", "no draft")).toBe(false);
    expect(client.calls.filter((call) => call.method === "sessions.rename")).toEqual([]);
    expect(controller.getState().notices.at(-1)?.text).toContain("草稿已失效");
  });

  it("refuses to open a rename draft for a session the connection has not confirmed", () => {
    const { controller } = makeController(snapshotFixture({ focusedSession: pinFixture({ confirmed: false }) }));
    controller.beginRename("session-1");
    expect(controller.getState().renameDraft).toBeNull();
    expect(controller.getState().notices.at(-1)?.text).toContain("尚未在当前连接上确认");
  });

  it("clears only its own target's focus when a deletion lands after the reader moved on", async () => {
    const { client, controller } = makeController(snapshotFixture({ focusedSession: pinFixture({}) }));
    controller.selectSession("session-1");
    let release: (() => void) | undefined;
    client.onDelete = () =>
      new Promise((resolve) => {
        release = () => {
          resolve({ sessionId: "session-1", generation: 1, deleted: true });
        };
      });

    const deleting = controller.deleteSession("session-1");
    // The reader selects another session while the deletion is in flight.
    controller.selectSession("session-2");
    release?.();
    await deleting;

    // The completion retired its own target and nothing else: no blanket
    // unfocus that would retire the session the reader is now looking at.
    expect(client.calls.filter((call) => call.method === "directory.unfocus"), "a completion may not retire a focus it does not own").toEqual([]);
    expect(client.calls.filter((call) => call.method === "directory.clearFocusIf")).toEqual([
      { method: "directory.clearFocusIf", params: { sessionId: "session-1" } },
    ]);
    expect(client.calls.filter((call) => call.method === "directory.focus")).toEqual([
      { method: "directory.focus", params: { sessionId: "session-1" } },
      { method: "directory.focus", params: { sessionId: "session-2" } },
    ]);
    // The reader's selection is untouched.
    expect(controller.getState().selection?.sessionId).toBe("session-2");
  });
});
