/**
 * The session rail: the bounded directory the client has read, and the two
 * writes a session supports.
 *
 * A session is a title, a creation time, a last-changed time and a status, and
 * the panel shows exactly that — including how much of the directory it is
 * holding. A bounded window says so rather than looking like the whole
 * collection, and a range the client cannot vouch for is never presented as
 * complete.
 *
 * The two writes are inline and explicit. Rename keeps its draft when the host
 * refuses — a conflict is something the user resolves, not something this page
 * retries. Delete asks for a confirmation that names the session and the
 * revision it was given for: if the session has moved since, the confirmation
 * is stale and is asked for again, because the thing being confirmed was
 * "delete *this* state", not "delete whatever is there now".
 */

import { useState } from "react";

import type { ClientSnapshot } from "@every-dagent/client";
import type { SessionSummary } from "@every-dagent/protocol";

import { directoryOf, formatClock, shortId } from "./presentation.js";
import type { ShellUiState } from "./controller.js";

export interface SessionsPanelProps {
  readonly snapshot: ClientSnapshot;
  readonly ui: ShellUiState;
  readonly selected: SessionSummary | null;
  /** Whether the connection is current enough to offer any write. */
  readonly canWrite: boolean;
  /** Whether this session has been confirmed on the current connection. */
  readonly sessionWritable: boolean;
  readonly durable: boolean;
  onCreate(): void;
  onSelect(sessionId: string): void;
  onLoadOlder(): void;
  onRefreshDirectory(): void;
  /** Opens a rename draft for one session: the shell captures the revision it is based on. */
  onBeginRename(sessionId: string): void;
  /** Discards the open rename draft. */
  onCancelRename(): void;
  /** Resolves `true` when the rename left the client (accepted, or unanswered). */
  onRename(sessionId: string, title: string): Promise<boolean>;
  /** Resolves `true` when the host confirmed the deletion, or its answer was lost. */
  onDelete(sessionId: string): Promise<boolean>;
}

/** What one open delete confirmation was given for: the facts it is a decision about. */
interface DeleteConfirmation {
  readonly sessionId: string;
  readonly metadataRevision: number;
  readonly activeRunId: string | null;
  readonly hostInstanceId: string;
}

function stillSame(session: SessionSummary, hostInstanceId: string, confirmation: DeleteConfirmation): boolean {
  return (
    confirmation.sessionId === session.sessionId &&
    confirmation.metadataRevision === session.metadataRevision &&
    confirmation.activeRunId === session.activeRunId &&
    confirmation.hostInstanceId === hostInstanceId
  );
}

export function SessionsPanel(props: SessionsPanelProps) {
  const { snapshot, ui } = props;
  const view = directoryOf(snapshot);
  const sessions = view.items;
  const hostInstanceId = snapshot.presentation?.hostInstanceId ?? "";

  const [renaming, setRenaming] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [deleting, setDeleting] = useState<DeleteConfirmation | null>(null);

  const maxTitleChars = snapshot.description?.limits.maxTitleChars ?? 200;
  const writeInFlight = ui.sessionWrite !== null;

  function openRename(session: SessionSummary): void {
    setDeleting(null);
    // The shell opens the draft, and *it* captures the revision the rename will
    // compare against: the text is this panel's, the authority is not.
    props.onBeginRename(session.sessionId);
    setRenaming(session.sessionId);
    setTitleDraft(session.title);
  }

  function closeRename(): void {
    props.onCancelRename();
    setRenaming(null);
    setTitleDraft("");
  }

  function openDelete(session: SessionSummary): void {
    setRenaming(null);
    setDeleting({
      sessionId: session.sessionId,
      metadataRevision: session.metadataRevision,
      activeRunId: session.activeRunId,
      hostInstanceId,
    });
  }

  const selectedId = props.selected === null ? null : props.selected.sessionId;

  return (
    <section className="panel" data-testid="sessions-panel">
      <header className="panel__head">
        <h2>会话</h2>
        <button
          type="button"
          className="button button--small"
          data-testid="new-session"
          disabled={!props.canWrite || ui.creatingSession}
          onClick={props.onCreate}
        >
          {ui.creatingSession ? "创建中…" : "新建会话"}
        </button>
      </header>

      {sessions.length === 0 ? (
        <p className="empty" data-testid="sessions-empty">
          没有会话。新建一个即可开始。
        </p>
      ) : (
        <ul className="sessions">
          {sessions.map((session) => {
            const selected = selectedId === session.sessionId;
            const isRenaming = renaming === session.sessionId;
            const isDeleting = deleting !== null && deleting.sessionId === session.sessionId;
            return (
              <li key={session.sessionId} data-testid="session-entry">
                <button
                  type="button"
                  className={selected ? "session session--selected" : "session"}
                  data-testid="session-item"
                  data-session-id={session.sessionId}
                  data-selected={selected ? "true" : "false"}
                  onClick={() => props.onSelect(session.sessionId)}
                >
                  <span className="session__label">{session.title}</span>
                  <span className="session__meta">
                    {formatClock(session.updatedAt)}
                    {session.status === "blocked" ? " · 已阻塞" : ""}
                    {session.activeRunId !== null ? " · 运行中" : ""}
                  </span>
                </button>

                {selected && !isRenaming && !isDeleting && (
                  <div className="session__actions">
                    <button
                      type="button"
                      className="button button--small"
                      data-testid="rename-start"
                      disabled={!props.sessionWritable || writeInFlight}
                      onClick={() => props.selected !== null && openRename(props.selected)}
                    >
                      重命名
                    </button>
                    <button
                      type="button"
                      className="button button--small button--warn"
                      data-testid="delete-start"
                      disabled={!props.sessionWritable || writeInFlight}
                      onClick={() => props.selected !== null && openDelete(props.selected)}
                    >
                      删除…
                    </button>
                  </div>
                )}

                {selected && !props.sessionWritable && !isRenaming && !isDeleting && (
                  <p className="panel__note" data-testid="session-unconfirmed">
                    该会话尚未在当前连接上确认（可能来自更早的会话页或重连之前）：可以先查看，但重命名与删除要等确认完成后才能使用。
                  </p>
                )}

                {isRenaming && (
                  <form
                    className="session__form"
                    data-testid="rename-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const target = session.sessionId;
                      void props.onRename(target, titleDraft).then((left) => {
                        // A rename that left the client closes the form; a
                        // refusal — a conflict, an empty title — keeps the
                        // draft so the user decides what to do with it.
                        if (left) {
                          props.onCancelRename();
                          setRenaming(null);
                          setTitleDraft("");
                        }
                      });
                    }}
                  >
                    <label className="session__label-text" htmlFor="session-title-input">
                      新标题（≤ {maxTitleChars} 字符，不会自动裁剪）
                    </label>
                    {ui.renameDraft !== null && ui.renameDraft.sessionId === session.sessionId && (
                      <p className="panel__note" data-testid="rename-base">
                        草稿基于会话版本 {ui.renameDraft.expectedRevision}；保存会以该版本做比较并替换（Host 上的版本若已前进会被拒绝）。
                        {ui.renameDraft.expectedRevision !== session.metadataRevision
                          ? ` Host 上的版本现在是 ${session.metadataRevision}：保存会被拒绝，请取消后重新打开重命名。`
                          : ""}
                      </p>
                    )}
                    <input
                      id="session-title-input"
                      className="session__input"
                      data-testid="rename-input"
                      value={titleDraft}
                      maxLength={maxTitleChars}
                      onChange={(event) => {
                        setTitleDraft(event.target.value);
                      }}
                    />
                    <div className="session__actions">
                      <button
                        type="submit"
                        className="button button--small button--primary"
                        data-testid="rename-submit"
                        disabled={writeInFlight || titleDraft.trim() === ""}
                      >
                        {writeInFlight ? "保存中…" : "保存标题"}
                      </button>
                      <button
                        type="button"
                        className="button button--small"
                        data-testid="rename-cancel"
                        onClick={() => {
                          closeRename();
                        }}
                      >
                        取消
                      </button>
                    </div>
                    <p className="panel__note">
                      只改标题，不改变历史。冲突时不会自动重试：请刷新后再决定。
                    </p>
                  </form>
                )}

                {isDeleting && deleting !== null && (
                  <div className="session__form session__form--danger" data-testid="delete-form">
                    <p className="session__danger" data-testid="delete-warning">
                      将永久删除会话「{session.title}」（{shortId(session.sessionId)}）。
                      没有回收站，无法撤销；这不会撤销已经发生的外部工具副作用。
                    </p>
                    {session.activeRunId !== null && (
                      <p className="panel__note" data-testid="delete-busy-note">
                        该会话仍有运行（{shortId(session.activeRunId)}）：Host 会拒绝这次删除，本页不会自动取消运行，也不会在取消后自动删除。
                      </p>
                    )}
                    {!stillSame(session, hostInstanceId, deleting) && (
                      <p className="panel__note" data-testid="delete-stale">
                        该会话的状态在确认之后已经变化：请重新确认（当前 metadata revision {session.metadataRevision}）。
                      </p>
                    )}
                    <div className="session__actions">
                      <button
                        type="button"
                        className="button button--small button--warn"
                        data-testid="delete-confirm"
                        disabled={writeInFlight || !stillSame(session, hostInstanceId, deleting)}
                        onClick={() => {
                          const target = session.sessionId;
                          void props.onDelete(target).then((done) => {
                            // The form closes on a confirmed deletion and on an
                            // unanswered one alike: in the second case the
                            // unconfirmed record owns the question now, and
                            // asking again here would be a second delete.
                            if (done) setDeleting(null);
                          });
                        }}
                      >
                        {writeInFlight ? "删除中…" : "永久删除这个会话"}
                      </button>
                      <button
                        type="button"
                        className="button button--small"
                        data-testid="delete-cancel"
                        onClick={() => {
                          setDeleting(null);
                        }}
                      >
                        取消
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="panel__actions">
        {view.nextCursor !== null && !view.stale && (
          <button
            type="button"
            className="button button--small"
            data-testid="load-older-sessions"
            disabled={ui.directoryLoading || !props.canWrite}
            onClick={props.onLoadOlder}
          >
            {ui.directoryLoading ? "读取中…" : "加载更早会话"}
          </button>
        )}
        {view.stale && (
          <button
            type="button"
            className="button button--small"
            data-testid="refresh-directory"
            disabled={ui.directoryRefreshing || !props.canWrite}
            onClick={props.onRefreshDirectory}
          >
            {ui.directoryRefreshing ? "读取中…" : "重新读取目录"}
          </button>
        )}
      </div>

      <p className="panel__note" data-testid="sessions-window">
        {view.stale
          ? `目录版本已变化：已加载 ${String(view.items.length)} 个会话，需要重新读取目录才能继续加载更早的会话。`
          : view.complete
            ? `已加载全部 ${String(view.items.length)} 个会话（${props.durable ? "durable 存储" : "本次进程内存中"}）。`
            : view.nextCursor === null && !view.hasMore
              ? `已经读到最早的会话：显示 ${String(view.items.length)} 个，其中窗口与保留页之间有一段已读取但不再保留的范围（共读到 ${
                  props.durable ? "durable 存储" : "本次进程内存中"
                }里的最后一条）。`
              : `已加载 ${String(view.items.length)} 个会话：仅覆盖已读取的窗口，更早的会话仍在 Host 上（${
                  props.durable ? "durable 存储" : "本次进程内存中"
                }）。`}
        {view.loadedPages > 0 ? ` 其中更早的页面 ${String(view.loadedPages)} 页。` : ""}
        {view.evicted ? " 缓存已到上限：继续加载会推进遍历，但不再保留更靠前的已读页面（遍历进度不会倒退）。" : ""}
        {view.gap ? " 注意：窗口与已保留的更早页面之间有一段已读取但不再保留的范围；因此已加载的范围不算完整。" : ""}
      </p>
    </section>
  );
}
