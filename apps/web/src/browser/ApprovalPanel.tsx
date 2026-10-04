/**
 * The approval card: one prepared execution, waiting for a person to say yes or
 * no.
 *
 * Everything on the card is the Host's own state, read from the client's
 * snapshot: the tool, the exact arguments as the Host prepared them, the
 * business deadline, and where the approval stands. The card never derives an
 * argument from a live card or from what the run is showing — an approval a
 * reader cannot see in full is one they cannot honestly answer, and the client
 * has already refused to shorten it.
 *
 * The local half is kept visibly separate. A click says *this shell sent an
 * answer*; it never says the execution was approved, and the sentence under the
 * buttons says what is still unknown. The buttons are live only while both
 * halves hold at once: the Host can still decide (`canRespond`) *and* this
 * connection is holding a delivery it can answer with.
 */

import type { ClientSnapshot } from "@every-dagent/client";
import type { ApprovalSnapshot, ToolApprovalDecision } from "@every-dagent/protocol";

import { displayInputView, formatClock } from "./presentation.js";
import type { ShellUiState } from "./controller.js";

export interface ApprovalPanelProps {
  readonly snapshot: ClientSnapshot;
  readonly ui: ShellUiState;
  onRespond(decision: ToolApprovalDecision): void;
}

const STATUS_LABELS: Readonly<Record<ApprovalSnapshot["status"], string>> = Object.freeze({
  pending: "Host：等待答复",
  approved: "Host：已批准",
  denied: "Host：已拒绝",
  expired: "Host：已过期（未执行）",
  cancelled: "Host：已取消（未执行）",
});

export function ApprovalPanel(props: ApprovalPanelProps) {
  const approval = props.snapshot.presentation?.approval ?? null;
  if (approval === null) return null;

  const waiter = props.ui.approvalWaiter;
  const deliveryMatches =
    waiter !== null && waiter.approvalId === approval.approvalId && waiter.executionId === approval.executionId;
  const canRespond = props.snapshot.approvalCanRespond && deliveryMatches;
  const reply = props.snapshot.approvalReply;
  const input = displayInputView(approval.input);

  return (
    <section className="approval" data-testid="approval-panel" data-status={approval.status}>
      <header className="approval__head">
        <h2 className="approval__title">工具审批：{approval.name}</h2>
        <span className={`chip chip--${approval.status === "pending" ? "active" : approval.status === "approved" ? "ok" : "warn"}`} data-testid="approval-status">
          {STATUS_LABELS[approval.status]}
        </span>
      </header>

      <p className="approval__meta" data-testid="approval-identity">
        调用 {approval.callId === "" ? "（空）" : approval.callId} · 执行 {approval.executionId}
      </p>
      <p className="approval__meta" data-testid="approval-deadline">
        Host 业务截止时间：{formatClock(approval.deadlineAt)}（Host 的时钟为准；重连不会延长它）
      </p>

      <div className="approval__input">
        <p className="tool__label">将要执行的确切参数（只读）</p>
        <pre className="tool__json" data-testid="approval-input">
          {input.text}
        </pre>
      </div>

      <p className="approval__meta" data-testid="approval-can-respond">
        当前连接可以答复：{canRespond ? "是" : "否"}
      </p>

      {approval.status === "pending" && (
        <div className="approval__actions">
          <button
            type="button"
            className="button button--primary"
            data-testid="approval-approve"
            disabled={!canRespond || waiter?.decision !== null}
            onClick={() => {
              props.onRespond("approve");
            }}
          >
            {waiter?.decision === "approve" ? "已提交批准…" : "批准执行"}
          </button>
          <button
            type="button"
            className="button button--warn"
            data-testid="approval-reject"
            disabled={!canRespond || waiter?.decision !== null}
            onClick={() => {
              props.onRespond("reject");
            }}
          >
            {waiter?.decision === "reject" ? "已提交拒绝…" : "拒绝执行"}
          </button>
        </div>
      )}

      <p className="approval__state" data-testid="approval-reply-state" data-reply={reply.state}>
        {reply.state === "pending"
          ? "本地：已收到 Host 的审批请求，尚未答复。"
          : reply.state === "sent"
            ? "本地：答复已发出，等待 Host 确认（这不等于工具已经执行）。"
            : reply.state === "closed"
              ? "本地：这次投递已结束（断线、换流或取消）——它既不是批准也不是拒绝。Host 的审批状态仍以 Host 为准。"
              : reply.state === "failed"
                ? "本地：答复未能发出。"
                : "本地：当前没有正在答复的投递。"}
      </p>

      {approval.status === "pending" && !canRespond && (
        <p className="approval__note" data-testid="approval-waiting-note">
          Host 仍可能在等待这次审批，但当前连接无法答复（可能正在重连或投递已结束）。这不是拒绝，工具不会因此被拒绝执行。
        </p>
      )}
      {approval.status === "approved" && (
        <p className="approval__note" data-testid="approval-approved-note">
          Host 已批准这次执行。「已批准」只表示通过了本次授权：它不等于工具已经执行，更不等于工具成功。
        </p>
      )}
      {approval.status === "denied" && (
        <p className="approval__note" data-testid="approval-denied-note">
          Host 已拒绝这次执行：它不会被派发（not-executed）。拒绝不代表后续的工具调用获得批准。
        </p>
      )}
      {(approval.status === "expired" || approval.status === "cancelled") && (
        <p className="approval__note" data-testid="approval-closed-note">
          这次审批不可再回答（{approval.status === "expired" ? "已过期" : "已取消"}），工具不会被执行。
        </p>
      )}
    </section>
  );
}
