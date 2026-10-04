/**
 * The shell, assembled.
 *
 * Everything a panel shows is derived here, from the two stores, in one place:
 * the snapshot is read once, the derived facts (selected session, its loaded
 * history coverage, the live run, the latest run, whether writes are allowed)
 * are computed once, and the panels below take them as props. No panel holds a
 * second copy of a host fact; what the controller keeps is only what the user
 * did.
 */

import { useEffect, useState } from "react";

import { ApprovalPanel } from "./ApprovalPanel.js";
import type { ShellController } from "./controller.js";
import { Composer } from "./Composer.js";
import { ConnectionPanel } from "./ConnectionPanel.js";
import { ConnectionStatus } from "./ConnectionStatus.js";
import { Conversation } from "./Conversation.js";
import { HostPanel } from "./HostPanel.js";
import { NoticesPanel } from "./NoticesPanel.js";
import { PluginsPanel } from "./PluginsPanel.js";
import { RunStrip } from "./RunStrip.js";
import { SessionsPanel } from "./SessionsPanel.js";
import { SettingsPanel } from "./SettingsPanel.js";
import { useClientSnapshot, useShellState } from "./use-shell.js";
import {
  activeRunCount,
  activeRunOf,
  focusedPin,
  focusedWritesAllowed,
  historyOf,
  latestRunOf,
  selectedSession,
  writesAllowed,
} from "./presentation.js";

export interface AppProps {
  readonly controller: ShellController;
}

/**
 * Which of the two sidebar panes the left rail is showing.
 *
 * It is page state and nothing else: no host fact, no session fact, no stored
 * preference. The session list can be arbitrarily long, so the two entries sit
 * above the pane that scrolls rather than in one column with it — that is what
 * keeps the settings reachable however many sessions exist. A reload starts
 * back at the sessions, which is the pane a reader comes back for.
 */
type SidebarPane = "sessions" | "settings";

export function App(props: AppProps) {
  const { controller } = props;
  const snapshot = useClientSnapshot(controller.client);
  const ui = useShellState(controller);
  const [pane, setPane] = useState<SidebarPane>("sessions");

  const session = selectedSession(snapshot, ui.selection);
  const sessionId = session === null ? null : session.sessionId;
  const coverage = sessionId === null ? null : historyOf(snapshot, sessionId);
  const activeRun = session === null ? null : activeRunOf(snapshot, session);
  const latestRun = session === null ? null : latestRunOf(snapshot, session.sessionId);
  const canWrite = writesAllowed(snapshot);
  // A session write — a rename, a delete, and the composer — needs more than a
  // current connection: the session itself has to have been confirmed on it.
  const sessionWritable = focusedWritesAllowed(snapshot, sessionId);
  const pin = focusedPin(snapshot, ui.selection);
  const running = activeRunCount(snapshot);
  const maxActiveRuns = snapshot.description?.limits.maxActiveRuns ?? 1;
  const atRunLimit = running >= maxActiveRuns;
  const durable = snapshot.description?.storage.retention === "durable";
  const windowRun =
    latestRun !== null && latestRun.status !== "accepted" && latestRun.status !== "running" ? latestRun : null;
  // The strip is the live draft, or the last run the *shell* can see: the
  // window when it holds one, and otherwise the run the client pinned for the
  // focused session — which is how a session outside the bounded run window
  // still shows what it last did.
  const strip = activeRun ?? windowRun ?? (pin === null ? null : pin.recentRun);

  const behind = coverage?.behind ?? false;
  const loadingHistory = ui.historyLoading;
  const ready = snapshot.status === "ready";

  // Loading history is a read, and reads are safe: a session the user is looking
  // at should show what is on the host without them having to ask. The effect
  // re-runs when the selection changes or when the loaded coverage falls behind
  // the committed high-water. A blocked session is read too: it refuses new
  // work, not reading.
  useEffect(() => {
    if (sessionId === null) return;
    if (!ready) return;
    void controller.ensureHistory(sessionId);
  }, [controller, sessionId, ready, behind]);

  // The selection survives a reload and a reconnect; the confirmation does not.
  // When the connection becomes current again, the client re-reads the selected
  // session — which is what a write for it will be gated on.
  useEffect(() => {
    if (ui.selection === null) return;
    if (!ready) return;
    void controller.ensureFocus();
  }, [controller, ui.selection, ready]);

  return (
    <div className="shell">
      <header className="shell__header">
        <div className="shell__brand">
          Every-DAgent <span className="shell__sub">generic web shell</span>
        </div>
        <ConnectionStatus snapshot={snapshot} />
      </header>

      <NoticesPanel
        ui={ui}
        snapshot={snapshot}
        canWrite={canWrite}
        onCheck={(unknownId) => {
          void controller.checkUnknown(unknownId);
        }}
        onResubmit={(unknownId) => {
          void controller.resubmitUnknownStart(unknownId);
        }}
        onRefresh={() => {
          void controller.refresh();
        }}
        onDismiss={(unknownId) => {
          controller.dismissUnknown(unknownId);
        }}
        onDismissNotice={(noticeId) => {
          controller.dismissNotice(noticeId);
        }}
      />

      <div className="shell__body">
        <aside className="shell__rail">
          <ConnectionPanel
            snapshot={snapshot}
            ui={ui}
            onConnectTo={(origin) => {
              void controller.connectTo(origin);
            }}
            onReconnect={() => {
              void controller.reconnect();
            }}
            onDisconnect={() => {
              controller.disconnect();
            }}
          />
          <div className="sidebar">
            <div className="sidebar__tabs" role="tablist" aria-label="侧栏">
              <button
                type="button"
                role="tab"
                id="sidebar-tab-sessions"
                className={pane === "sessions" ? "sidebar__tab sidebar__tab--active" : "sidebar__tab"}
                aria-selected={pane === "sessions"}
                aria-controls="sidebar-pane"
                data-testid="sidebar-tab-sessions"
                onClick={() => {
                  setPane("sessions");
                }}
              >
                会话
              </button>
              <button
                type="button"
                role="tab"
                id="sidebar-tab-settings"
                className={pane === "settings" ? "sidebar__tab sidebar__tab--active" : "sidebar__tab"}
                aria-selected={pane === "settings"}
                aria-controls="sidebar-pane"
                data-testid="sidebar-tab-settings"
                onClick={() => {
                  setPane("settings");
                }}
              >
                设置
              </button>
            </div>
            <div
              className="sidebar__pane"
              id="sidebar-pane"
              role="tabpanel"
              aria-labelledby={pane === "sessions" ? "sidebar-tab-sessions" : "sidebar-tab-settings"}
              data-testid="sidebar-pane"
              data-pane={pane}
            >
              {pane === "sessions" ? (
                <SessionsPanel
                  snapshot={snapshot}
                  ui={ui}
                  selected={session}
                  canWrite={canWrite}
                  sessionWritable={sessionWritable}
                  durable={durable}
                  onCreate={() => {
                    void controller.createSession();
                  }}
                  onSelect={(selectedId) => {
                    controller.selectSession(selectedId);
                  }}
                  onLoadOlder={() => {
                    void controller.loadOlderSessions();
                  }}
                  onRefreshDirectory={() => {
                    void controller.refreshDirectory();
                  }}
                  onBeginRename={(target) => {
                    controller.beginRename(target);
                  }}
                  onCancelRename={() => {
                    controller.cancelRename();
                  }}
                  onRename={(target, title) => controller.renameSession(target, title)}
                  onDelete={(target) => controller.deleteSession(target)}
                />
              ) : (
                <SettingsPanel
                  snapshot={snapshot}
                  ui={ui}
                  canWrite={canWrite}
                  onRead={(namespace) => {
                    void controller.readSettings(namespace);
                  }}
                  onSave={(namespace, value, expectedRevision) =>
                    controller.saveSettings(namespace, value, expectedRevision)
                  }
                />
              )}
            </div>
          </div>
        </aside>

        <main className="shell__main">
          {session === null ? (
            <p className="empty empty--main" data-testid="no-session">
              {snapshot.presentation === null
                ? "尚未从 Host 取得内容：连接成功后可以创建或选择会话。"
                : "请选择一个会话，或新建一个。"}
            </p>
          ) : (
            <>
              <ApprovalPanel
                snapshot={snapshot}
                ui={ui}
                onRespond={(decision) => {
                  controller.respondApproval(decision);
                }}
              />
              <Conversation
                snapshot={snapshot}
                session={session}
                coverage={coverage}
                activeRun={activeRun}
                loading={loadingHistory}
                onLoadOlder={() => {
                  void controller.loadOlderHistory(session.sessionId);
                }}
                onLoadNewer={() => {
                  void controller.reloadHistory(session.sessionId);
                }}
              />
              {strip !== null && (
                <RunStrip
                  run={strip}
                  cancelling={ui.cancellingRunId === strip.runId}
                  canWrite={canWrite}
                  onCancel={(runId) => {
                    void controller.cancelRun(runId);
                  }}
                />
              )}
              <Composer
                key={session.sessionId}
                blocked={session.status === "blocked"}
                canWrite={sessionWritable}
                atRunLimit={atRunLimit}
                startingRun={ui.startingRun}
                onSend={async (text) => await controller.startRun(session.sessionId, text)}
              />
            </>
          )}
        </main>

        <aside className="shell__rail">
          <HostPanel snapshot={snapshot} />
          <PluginsPanel
            snapshot={snapshot}
            ui={ui}
            canWrite={canWrite}
            hostBusy={running > 0}
            onSetEnabled={(pluginId, enabled) => {
              void controller.setPluginEnabled(pluginId, enabled);
            }}
          />
        </aside>
      </div>
    </div>
  );
}
