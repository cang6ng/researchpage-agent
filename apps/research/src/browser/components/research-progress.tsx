/**
 * Where the research actually is.
 *
 * A reader watching a project run needs four different things and they are not
 * the same question: what the product is doing right now, how far *this*
 * attempt has got, what the network has answered, and what happened while they
 * were away. The page draws all four from the record the server keeps —
 * `progress`, `attempt`, `discovery` and the stored activity log — and draws
 * nothing it computed itself. There is no percentage anywhere, because there is
 * no denominator: a research pass is not a file being copied, and a bar that
 * filled up while nothing was being read would be a picture of a guess.
 *
 * The retry button is the one action here, and it is offered only when the
 * server says the project really stopped: confirmed, failed, not busy, nothing
 * of this page's own in flight. A retry preserves everything the project has —
 * sources, evidence, assessments, reports, frozen revisions — and the page says
 * so before and after, because "start again" and "start over" are different
 * promises.
 */

import { Alert, Badge, Button, Loader, Timeline } from "@mantine/core";
import { AlertTriangle, CheckCircle2, Clock, History, Radio } from "lucide-react";
import { useState } from "react";

import type { ActivityEventView, ProgressView, SourceView, TaskBundle } from "../api.js";

const LEVEL_LABELS: Readonly<Record<string, string>> = Object.freeze({
  info: "信息",
  warn: "注意",
  error: "错误",
});

function when(iso: string | null): string {
  if (iso === null) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return `${String(date.getMonth() + 1)}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
}

function Fact({ label, value, tone }: { readonly label: string; readonly value: string; readonly tone?: string }): React.ReactElement {
  return (
    <div className="rp-fact">
      <span className="rp-fact__k">{label}</span>
      <span className="rp-fact__v" style={tone === undefined ? undefined : { color: tone }}>
        {value}
      </span>
    </div>
  );
}

export interface ResearchProgressProps {
  readonly progress: ProgressView;
  readonly attempt: TaskBundle["attempt"];
  readonly discovery: TaskBundle["discovery"];
  readonly activityLog: readonly ActivityEventView[];
  readonly sources: readonly SourceView[];
  readonly usage: TaskBundle["usage"];
  readonly status: TaskBundle["task"]["status"];
  readonly confirmed: boolean;
  readonly error: string | null;
  readonly busy: boolean;
  readonly retrying: boolean;
  readonly retryMessage: string | null;
  readonly onRetry: () => void;
}

export function ResearchProgress(props: ResearchProgressProps): React.ReactElement {
  const { progress, attempt, discovery, activityLog } = props;
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? activityLog : activityLog.slice(-10);
  const readCounts = props.sources.reduce<Record<string, number>>((counts, source) => {
    counts[source.readStatus] = (counts[source.readStatus] ?? 0) + 1;
    return counts;
  }, {});
  const failure = props.error;
  const historical = failure === null && discovery?.lastFailure != null && props.status !== "failed";
  const canRetry = props.confirmed && props.status === "failed" && !props.busy && !props.retrying;

  return (
    <section className="rp-research" data-testid="research-progress">
      <div className="rp-research__head">
        <div>
          <div className="rp-kicker">研究进度</div>
          <div className="rp-runstate">
            {props.status === "failed" ? (
              <AlertTriangle size={15} strokeWidth={1.75} />
            ) : props.busy ? (
              <Loader size="xs" color="ink" />
            ) : (
              <CheckCircle2 size={15} strokeWidth={1.75} />
            )}
            <span className="rp-runstate__doing" data-testid="research-stage">
              {progress.displayName}
            </span>
          </div>
          {progress.currentMessage.length > 0 && (
            <p className="rp-research__scope" data-testid="research-message">
              {progress.currentMessage}
            </p>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {progress.retrying && (
            <Badge size="xs" variant="light" color="yellow" data-testid="research-retrying">
              <Clock size={11} strokeWidth={1.75} /> 正在等待下一次尝试
            </Badge>
          )}
          {progress.currentProvider !== null && (
            <Badge size="xs" variant="light" color="gray" data-testid="research-provider">
              <Radio size={11} strokeWidth={1.75} /> {progress.currentProvider}
            </Badge>
          )}
        </div>
      </div>

      <div className="rp-facts" style={{ display: "flex", gap: 26, flexWrap: "wrap", marginTop: 12 }}>
        <Fact label="研究轮次" value={attempt === null ? "尚未开始" : `第 ${String(attempt.number)} 轮`} />
        <Fact label="本轮开始" value={attempt === null ? "—" : when(attempt.startedAt)} />
        <Fact label="最近活动" value={when(progress.lastActivityAt)} />
        <Fact label="检索请求" value={`${String(progress.searchAttempts)} 次（含失败）`} />
        <Fact label="候选来源" value={String(progress.candidatesFound)} />
        <Fact label="已读来源" value={String(progress.sourcesRead)} />
        <Fact label="本项目累计检索" value={`${String(props.usage.searches)} 次 · 读取 ${String(props.usage.reads)} 次 · 补查 ${String(props.usage.gapRounds)} 轮`} />
      </div>

      <div style={{ display: "flex", gap: 26, flexWrap: "wrap", marginTop: 12 }}>
        {discovery !== null && (
          <>
            <Fact label="发现请求" value={`成功 ${String(discovery.successfulRequests)} / 尝试 ${String(discovery.attemptedRequests)} / 失败 ${String(discovery.failedRequests)}`} />
            <Fact label="最近使用服务" value={discovery.lastProvider ?? "—"} />
            <Fact label="最近一次耗时" value={discovery.lastElapsedMs === null ? "—" : `${String(Math.round(discovery.lastElapsedMs / 100) / 10)} 秒`} />
          </>
        )}
        <Fact label="来源读取状态" value={`已读 ${String(readCounts["ok"] ?? 0)} · 失败 ${String(readCounts["failed"] ?? 0)} · 未读 ${String(readCounts["not_read"] ?? 0)}`} />
        {progress.completedStages.length > 0 && (
          <Fact label="已完成过的阶段" value={progress.completedStages.join(" → ")} />
        )}
      </div>

      {(failure !== null || historical) && (
        <Alert
          variant="light"
          color={failure === null ? "gray" : "red"}
          icon={<AlertTriangle size={14} />}
          title={failure === null ? "历史错误（当前状态不是失败）" : "当前失败"}
          style={{ marginTop: 14 }}
          data-testid="research-failure"
        >
          <p style={{ margin: 0, fontSize: 12.5 }}>{failure ?? discovery?.lastFailure?.userMessage ?? ""}</p>
          {historical && (
            <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--rp-ink-3)" }}>
              这条错误发生在 {when(discovery?.lastFailure?.at ?? null)}，之后的运行已经继续过，因此它不是当前状态。
            </p>
          )}
          {failure !== null && (
            <div style={{ marginTop: 10 }}>
              <Button
                size="xs"
                variant="light"
                disabled={!canRetry}
                loading={props.retrying}
                onClick={props.onRetry}
                data-testid="research-retry"
              >
                重开一轮研究
              </Button>
              <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--rp-ink-3)" }}>
                重开一轮会重新检索与读取；已经有的来源、证据、评估、报告和冻结版本都会保留。
              </p>
            </div>
          )}
        </Alert>
      )}

      {props.retryMessage !== null && (
        <Alert variant="light" color="gray" icon={<CheckCircle2 size={14} />} style={{ marginTop: 12 }} data-testid="research-retry-note">
          {props.retryMessage}
        </Alert>
      )}

      <div className="rp-section-head" style={{ marginTop: 20 }}>
        <h2>
          <History size={13} strokeWidth={1.75} aria-hidden="true" /> 活动记录
        </h2>
        <span>
          {activityLog.length === 0 ? "还没有记录" : `共 ${String(activityLog.length)} 条（最早的在前）`}
          {activityLog.length > 10 && (
            <button
              type="button"
              className="rp-inline"
              style={{ marginLeft: 10 }}
              onClick={() => {
                setExpanded((open) => !open);
              }}
              data-testid="activity-log-toggle"
            >
              {expanded ? "只看最近 10 条" : "展开全部"}
            </button>
          )}
        </span>
      </div>
      {shown.length === 0 ? (
        <p className="rp-empty">研究开始之后，这里会按时间记录每一次检索、读取与重试。</p>
      ) : (
        <Timeline active={shown.length} bulletSize={14} lineWidth={1} data-testid="activity-log">
          {shown.map((event) => (
            <Timeline.Item
              key={event.id}
              title={
                <span style={{ display: "inline-flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12.5, color: "var(--rp-ink)" }}>{event.message}</span>
                  {event.level !== "info" && (
                    <Badge size="xs" variant="light" color={event.level === "error" ? "red" : "yellow"}>
                      {LEVEL_LABELS[event.level] ?? event.level}
                    </Badge>
                  )}
                  {event.provider !== undefined && <span className="rp-file__fact">{event.provider}</span>}
                  {event.attempt !== undefined && <span className="rp-file__fact">第 {String(event.attempt)} 轮</span>}
                </span>
              }
            >
              <span className="rp-file__fact">
                {when(event.at)} · {event.stage}
                {event.nextRetryAt === undefined || event.nextRetryAt === null ? "" : ` · 计划重试 ${when(event.nextRetryAt)}`}
              </span>
            </Timeline.Item>
          ))}
        </Timeline>
      )}
    </section>
  );
}
