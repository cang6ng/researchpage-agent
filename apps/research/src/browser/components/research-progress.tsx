/**
 * Where the research actually is, summary first.
 *
 * A reader watching a project run needs one thing immediately and one thing on
 * demand. The one thing is the summary: which stage is running, what has been
 * found, how much material has really been read, what is still open, how long
 * it has been going, and when anything last happened. The other is the full
 * record, which is thirty lines of provider names and retry counts and is
 * exactly right for a diagnosis and exactly wrong as a default.
 *
 * There is no percentage anywhere and no estimate of the remaining time.
 * Research does not complete a fixed amount of work per second, so a bar or an
 * ETA would be a picture of a guess; what the page can say truthfully is what
 * has happened and what is happening. The research deadline is a budget for
 * research *actions*, not a completion promise for the report, and the page
 * says so where it shows it.
 *
 * Nothing here is private model reasoning: every word comes from the stored
 * activity record, and the one action is a retry the server has already agreed
 * to accept.
 */

import { Alert, Badge, Button, Loader } from "@mantine/core";
import { AlertTriangle, CheckCircle2, Clock, History, Radio, RotateCcw } from "lucide-react";
import { useState } from "react";

import type { ActivityEventView, ProgressView, SourceView, TaskBundle } from "../api.js";

const LEVEL_LABELS: Readonly<Record<string, string>> = Object.freeze({
  info: "信息",
  warn: "注意",
  error: "错误",
});

/**
 * Which reader-facing group an activity line belongs to.
 *
 * The stored record keeps the product's own stage vocabulary — `searching`,
 * `waiting_retry`, `provider_skipped`, `stage_completed` — because that is what
 * a diagnosis needs. What a reader wants is five headings, so the mapping is
 * here, once, rather than in the reader's head.
 */
export const ACTIVITY_GROUPS: readonly { readonly id: string; readonly label: string; readonly match: RegExp }[] = Object.freeze([
  { id: "searching", label: "检索", match: /search|discovery|provider/ },
  { id: "reading", label: "读取", match: /read|fetch|source/ },
  { id: "gap", label: "补查", match: /gap|retry|waiting/ },
  { id: "assessment", label: "评估", match: /assess|coverage|matrix/ },
  { id: "reporting", label: "报告", match: /report|synthesis|section|draft/ },
  { id: "validation", label: "校验", match: /valid|quality|propos/ },
]);

export function groupOf(event: ActivityEventView): string {
  const haystack = `${event.kind} ${event.stage}`.toLowerCase();
  for (const group of ACTIVITY_GROUPS) {
    if (group.match.test(haystack)) return group.id;
  }
  return "other";
}

function when(iso: string | null): string {
  if (iso === null) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return `${String(date.getMonth() + 1)}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** How long something has been running, in words rather than in a fraction. */
function elapsed(from: string | null, until: string | null = null): string {
  if (from === null) return "—";
  const start = Date.parse(from);
  if (Number.isNaN(start)) return "—";
  const end = until === null ? Date.now() : Date.parse(until);
  if (Number.isNaN(end)) return "—";
  const minutes = Math.max(0, Math.round((end - start) / 60_000));
  if (minutes < 1) return "不到 1 分钟";
  if (minutes < 60) return `${String(minutes)} 分钟`;
  return `${String(Math.floor(minutes / 60))} 小时 ${String(minutes % 60)} 分钟`;
}

function Fact({ label, value, tone, testId }: { readonly label: string; readonly value: string; readonly tone?: string; readonly testId?: string }): React.ReactElement {
  return (
    <div className="rp-fact">
      <span className="rp-fact__k">{label}</span>
      <span className="rp-fact__v" style={tone === undefined ? undefined : { color: tone }} data-testid={testId}>
        {value}
      </span>
    </div>
  );
}

/**
 * The full record, as the reader asked for it.
 *
 * It is a component rather than an inlined branch so that what it renders can
 * be checked directly: the default is *not* to render it, and a test that could
 * only reach the collapsed state would have no way to say whether the whole
 * history is still available at all.
 */
export function ActivityDetails({
  events,
  grouped,
}: {
  readonly events: readonly ActivityEventView[];
  readonly grouped: boolean;
}): React.ReactElement {
  if (grouped) {
    const byGroup = new Map<string, ActivityEventView[]>();
    for (const event of events) {
      const key = groupOf(event);
      const list = byGroup.get(key) ?? [];
      list.push(event);
      byGroup.set(key, list);
    }
    return (
      <div data-testid="activity-log-grouped">
        {ACTIVITY_GROUPS.filter((group) => (byGroup.get(group.id)?.length ?? 0) > 0).map((group) => (
          <div key={group.id} style={{ marginBottom: 14 }}>
            <div className="rp-kicker" style={{ marginBottom: 6 }}>
              {group.label} · {(byGroup.get(group.id) ?? []).length} 条
            </div>
            {(byGroup.get(group.id) ?? []).map((event) => (
              <div key={event.id} className="rp-file__fact" style={{ display: "block", lineHeight: 1.7 }}>
                {when(event.at)} · {event.message}
                {event.level !== "info" ? `（${LEVEL_LABELS[event.level] ?? event.level}）` : ""}
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div data-testid="activity-log">
      {events.map((event) => (
        <div key={event.id} className="rp-file__fact" style={{ display: "block", lineHeight: 1.8 }}>
          {when(event.at)} · {event.stage} · {event.message}
          {event.provider === undefined ? "" : ` · ${event.provider}`}
          {event.level !== "info" ? `（${LEVEL_LABELS[event.level] ?? event.level}）` : ""}
        </div>
      ))}
    </div>
  );
}

/**
 * The diagnostic counts, shown only when the reader opened the details.
 *
 * Provider successes and failures, the read-state breakdown and the stages the
 * project has been through are what a diagnosis needs and what a reader waiting
 * does not. Keeping them out of the summary is the difference between a status
 * and a log; keeping them *available* is the difference between simplifying and
 * hiding.
 */
export function ResearchDetailFacts({
  progress,
  discovery,
  sources,
}: {
  readonly progress: ProgressView;
  readonly discovery: TaskBundle["discovery"];
  readonly sources: readonly SourceView[];
}): React.ReactElement {
  const readCounts = sources.reduce<Record<string, number>>((counts, source) => {
    counts[source.readStatus] = (counts[source.readStatus] ?? 0) + 1;
    return counts;
  }, {});
  return (
    <div style={{ display: "flex", gap: 26, flexWrap: "wrap", marginTop: 12 }} data-testid="research-detail-facts">
      {discovery !== null && (
        <>
          <Fact
            label="发现请求"
            value={`成功 ${String(discovery.successfulRequests)} / 尝试 ${String(discovery.attemptedRequests)} / 失败 ${String(discovery.failedRequests)}`}
          />
          <Fact label="最近使用服务" value={discovery.lastProvider ?? "—"} />
          <Fact label="最近一次耗时" value={discovery.lastElapsedMs === null ? "—" : `${String(Math.round(discovery.lastElapsedMs / 100) / 10)} 秒`} />
        </>
      )}
      <Fact
        label="来源读取状态"
        value={`已读 ${String(readCounts["ok"] ?? 0)} · 失败 ${String(readCounts["failed"] ?? 0)} · 未读 ${String(readCounts["not_read"] ?? 0)}`}
      />
      {progress.completedStages.length > 0 && <Fact label="已完成过的阶段" value={progress.completedStages.join(" → ")} />}
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
  readonly budget: TaskBundle["budget"];
  readonly status: TaskBundle["task"]["status"];
  readonly confirmed: boolean;
  readonly error: string | null;
  readonly busy: boolean;
  readonly retrying: boolean;
  readonly retryMessage: string | null;
  readonly unresolved: number;
  readonly onRetry: () => void;
}

export function ResearchProgress(props: ResearchProgressProps): React.ReactElement {
  const { progress, attempt, discovery, activityLog } = props;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [grouped, setGrouped] = useState(false);
  const failure = props.error;
  const historical = failure === null && discovery?.lastFailure != null && props.status !== "failed";
  const canRetry = props.confirmed && props.status === "failed" && !props.busy && !props.retrying;
  const running = props.busy || progress.currentStage === "searching" || progress.currentStage === "reading";

  return (
    <section className="rp-research" data-testid="research-progress">
      <div className="rp-research__head">
        <div>
          <div className="rp-kicker">研究进度</div>
          <div className="rp-runstate">
            {props.status === "failed" ? (
              <AlertTriangle size={15} strokeWidth={1.75} />
            ) : running ? (
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

      {/*
        The summary. Four numbers and three times, all of them facts the server
        keeps: what was found, what was really read, what is still open, and how
        long it has been. Nothing here is a fraction of a whole.
      */}
      <div className="rp-facts" style={{ display: "flex", gap: 26, flexWrap: "wrap", marginTop: 14 }}>
        <Fact label="找到候选" value={`${String(progress.candidatesFound)} 个来源`} testId="summary-candidates" />
        <Fact label="已读来源" value={`${String(progress.sourcesRead)} 个`} testId="summary-read" />
        <Fact
          label="尚未解决"
          value={props.unresolved === 0 ? "没有待查项" : `${String(props.unresolved)} 项`}
          tone={props.unresolved === 0 ? undefined : "var(--rp-ink)"}
          testId="summary-unresolved"
        />
        <Fact label="研究轮次" value={attempt === null ? "尚未开始" : `第 ${String(attempt.number)} 轮`} testId="summary-round" />
        <Fact label="已用时" value={attempt === null ? "—" : elapsed(attempt.startedAt, props.status === "failed" || props.status === "ready" ? null : null)} testId="summary-elapsed" />
        <Fact label="最近活动" value={when(progress.lastActivityAt)} testId="summary-last-activity" />
      </div>

      {/*
        What the deadline is, and what it is not. It bounds the *research
        actions* of this project; it is not an arrival time for the report, and
        saying so here is cheaper than a reader waiting for a clock that was
        never counting the thing they were waiting for.
      */}
      <p className="rp-research__budget" data-testid="research-budget">
        研究动作时间预算约 {Math.round(props.budget.deadlineMs / 60_000)} 分钟（已用 {String(props.usage.searches)} 次检索 ·{" "}
        {String(props.usage.reads)} 次读取 · 补查 {String(props.usage.gapRounds)}/{String(props.budget.maxGapRounds)} 轮）。
        这是研究动作的预算，不是报告完成时间；完成时间目前无法准确预估。
      </p>

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
              {/*
                The recovery first. A failed report does not mean the material
                is gone, and the action that reuses it is the one offered
                prominently; starting the research over is described for what
                it is — a second pass over the sources — and kept secondary.
              */}
              <Button
                size="xs"
                variant="light"
                disabled={!canRetry}
                loading={props.retrying}
                leftSection={<RotateCcw size={13} />}
                onClick={props.onRetry}
                data-testid="research-retry"
              >
                重新研究（会重新检索与读取）
              </Button>
              <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--rp-ink-3)" }}>
                已经有的来源、证据、评估、报告和冻结版本都会保留。若只是报告没有写出来，优先用项目页的「使用现有资料恢复报告」，
                它不会重新检索。
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

      {/*
        The full record, closed by default. What a reader needs while waiting is
        the summary above; what a diagnosis needs is every provider attempt, and
        that is one click away rather than in the way.
      */}
      <div className="rp-section-head" style={{ marginTop: 20 }}>
        <h2>
          <History size={13} strokeWidth={1.75} aria-hidden="true" /> 活动详情
        </h2>
        <span>
          {activityLog.length === 0 ? "还没有记录" : `共 ${String(activityLog.length)} 条`}
          {activityLog.length > 0 && (
            <button
              type="button"
              className="rp-inline"
              style={{ marginLeft: 10 }}
              onClick={() => {
                setDetailsOpen((open) => !open);
              }}
              data-testid="activity-log-toggle"
            >
              {detailsOpen ? "收起" : "查看活动详情"}
            </button>
          )}
        </span>
      </div>

      {detailsOpen && activityLog.length > 0 && (
        <>
          <div style={{ display: "flex", gap: 9, marginBottom: 10 }}>
            <button
              type="button"
              className="rp-inline"
              aria-pressed={!grouped}
              onClick={() => {
                setGrouped(false);
              }}
              data-testid="activity-mode-flat"
            >
              按时间
            </button>
            <button
              type="button"
              className="rp-inline"
              aria-pressed={grouped}
              onClick={() => {
                setGrouped(true);
              }}
              data-testid="activity-mode-grouped"
            >
              按类型
            </button>
          </div>
          <ResearchDetailFacts progress={progress} discovery={discovery} sources={props.sources} />
          <ActivityDetails events={activityLog} grouped={grouped} />
        </>
      )}

      {!detailsOpen && activityLog.length > 0 && (
        <p className="rp-empty" style={{ marginTop: 4 }}>
          默认不展开：完整记录包含每一次服务请求与重试，需要诊断时再打开。
        </p>
      )}
      {activityLog.length === 0 && (
        <p className="rp-empty">研究开始之后，这里会按时间记录每一次检索、读取与重试。</p>
      )}
    </section>
  );
}
