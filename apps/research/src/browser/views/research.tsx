/**
 * Research: the matrix, and what the run is doing about it.
 *
 * The evidence matrix is the subject of this page and is built to be read, not
 * scanned: every row is the question the dimension asks (a noun would not tell
 * a reader what was being settled), every cell states its standing in words and
 * carries the judgement behind it, and the vertical rules that would make it a
 * spreadsheet are gone. A cell is not a score — there is no score anywhere in
 * this product — so the cell says "有限支持 / 只有作者自报 / 2 条证据 · 1 条一手".
 *
 * While a stage runs, the page says what is being worked on, why, and what
 * happens next. It does not stream the model's thinking, and it does not invent
 * a percentage: a research run has steps, not progress bars.
 */

import { Button, Tooltip } from "@mantine/core";
import { ArrowRight, CircleDot, FileText, Gauge, Loader, MessageSquare, Search, Target } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { STATUS_LABELS, STATUS_MARKS, TOOL_LABELS, type TaskBundle } from "../api.js";
import { scopeSummary } from "../status.js";
import { DockSlot } from "../components/dock.js";
import { useApp } from "../store.js";
import { api } from "../api.js";
import { navigate, projectHash } from "../router.js";

/** What a running stage is doing, said as work rather than as a tool call. */
export function runningSummary(bundle: TaskBundle): {
  readonly doing: string;
  readonly why: string;
  readonly next: string;
  readonly stage: string;
} | null {
  const live = [...bundle.runs].reverse().find((run) => run.status === "running");
  if (live === undefined) return null;
  const last = [...live.activity].reverse().find((step) => step.ok !== false);
  const tool = last === undefined ? null : TOOL_LABELS[last.name] ?? null;

  const detail = last === undefined ? "" : trimDetail(last.detail);
  const gap = bundle.gaps[0];
  const gapQuestion = gap === undefined ? undefined : bundle.dimensions.find((entry) => entry.id === gap.dimensionId)?.question;

  // What is being worked on, in the reader's own terms: the question the run is
  // trying to answer, not the name of the tool it is calling. A stage that is
  // not chasing a specific cell says what it *is*.
  const doing =
    gap !== undefined && gapQuestion !== undefined && live.stage !== "ask" && live.stage !== "edit"
      ? `正在核对：${gapQuestion}`
      : tool === null
        ? live.note
        : last?.name === "read_source"
          ? "正在读取来源上下文"
          : last?.name === "search_sources"
            ? "正在检索候选来源"
            : last?.name === "assess_coverage"
              ? "正在核对证据覆盖"
              : last?.name === "save_report"
                ? "正在撰写报告章节"
                : tool;

  const why =
    live.stage === "research"
      ? `补齐矩阵中还没有依据的比较项${gap === undefined ? "" : `：${gap.subjectName} × ${gap.dimensionName}`}`
      : live.stage === "gap"
        ? `针对仍缺依据的单元格做定向补查${gap === undefined ? "" : `：${gap.subjectName} × ${gap.dimensionName}`}`
        : live.stage === "report" || live.stage === "synthesis"
          ? "把已核对的材料写成报告；没有依据的部分会在正文里标明"
          : live.stage === "ask"
            ? "只读材料回答问题，不写入任何数据"
            : live.stage === "edit"
              ? "针对目标章节起草修改建议；接受之前正文不变"
              : live.note;

  const next =
    live.stage === "research"
      ? "材料齐备后，由你决定是否开始撰写报告。"
      : live.stage === "gap"
        ? "补查结束后，报告正文保持当前版本，相关目标会被标记为待复核。"
        : live.stage === "report" || live.stage === "synthesis"
          ? "写完先做质量校验；报告保存后正文才会更新。"
          : live.stage === "edit"
            ? "建议会作为提案交给你接受或放弃。"
            : "完成后结果会出现在这里。";

  return { doing, why, next, stage: live.stage };
}

function trimDetail(detail: string): string {
  const clean = detail.replace(/\s+/g, " ").trim();
  return clean.length > 150 ? `${clean.slice(0, 150)}…` : clean;
}

function supportLine(bundle: TaskBundle, evidenceIds: readonly string[]): string {
  if (evidenceIds.length === 0) return "还没有证据";
  const primary = evidenceIds.filter((id) => {
    const evidence = bundle.evidence.find((item) => item.evidenceId === id);
    if (evidence === undefined) return false;
    const source = bundle.sources.find((candidate) => candidate.sourceId === evidence.sourceId);
    return source?.role === "primary" || source?.role === "official";
  }).length;
  const scope = new Set(
    evidenceIds.flatMap((id) => {
      const evidence = bundle.evidence.find((item) => item.evidenceId === id);
      return evidence === undefined ? [] : [evidence.readScope];
    }),
  );
  const body = scope.has("full_text") || scope.has("body_excerpt");
  return `${evidenceIds.length} 条证据${primary > 0 ? ` · ${primary} 条一手` : ""}${body ? "" : " · 仅摘要级"}`;
}

/**
 * The one line above the matrix that says what the project is waiting for.
 *
 * It is one line about the research and nothing else. What a run spent —
 * searches, reads, gap rounds — belongs beside the action that spends it, not
 * as a permanent scoreboard over the matrix: a reader looking at「已核对 1/15」
 * is not helped by knowing the agent has used four of its six searches.
 */
function ProjectHeadline({ bundle }: { readonly bundle: TaskBundle }) {
  const reviewed = bundle.matrix.filter((cell) => cell.status === "reviewed").length;
  const gaps = bundle.gaps.length;
  return (
    <div className="rp-research__head">
      <div>
        <div className="rp-kicker">研究</div>
        <h1 className="rp-title rp-title--clamp" style={{ marginBottom: 6, maxWidth: "58ch", fontSize: 22 }} title={bundle.task.topic}>
          {bundle.task.topic}
        </h1>
        <p className="rp-lede" style={{ fontSize: 13.5 }}>
          {bundle.matrix.length === 0
            ? "矩阵会在任务卡确认后建立。"
            : gaps === 0
              ? `全部 ${bundle.matrix.length} 个比较项都有直接依据；下面每一格都能点到具体片段。`
              : `已核对 ${reviewed}/${bundle.matrix.length} 个比较项，还有 ${gaps} 项没有直接依据。`}
        </p>
      </div>
      <div className="rp-research__scope">
        <div className="rp-fact__k">研究范围</div>
        <div style={{ fontSize: 13, color: "var(--rp-ink-2)", lineHeight: 1.6, marginTop: 2 }}>
          {scopeSummary(bundle)}
        </div>
        <button
          type="button"
          className="rp-nav__item"
          style={{ padding: "2px 0", fontSize: 12.5, color: "var(--rp-brand)" }}
          onClick={() => {
            navigate(projectHash(bundle.task.id, "brief"));
          }}
          data-testid="scope-from-research"
        >
          查看研究范围
        </button>
      </div>
    </div>
  );
}

function Matrix({ bundle }: { readonly bundle: TaskBundle }) {
  const { selection, setSelection, openDock } = useApp();
  const selectedCell = selection?.kind === "cell" ? selection : null;

  return (
    <div className="rp-matrix-wrap">
      <table className="rp-matrix" data-testid="evidence-matrix">
        <thead>
          <tr>
            <th scope="col">研究维度</th>
            {bundle.subjects.map((subject) => (
              <th key={subject.id} scope="col">
                {subject.name}
                {subject.note !== undefined && subject.note.length > 0 && (
                  <span className="rp-matrix__subject-note">{subject.note}</span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {bundle.dimensions.map((dimension) => (
            <tr key={dimension.id}>
              <th scope="row">
                <div className="rp-matrix__dimname">{dimension.name}</div>
                <div className="rp-matrix__dimq">{dimension.question}</div>
              </th>
              {bundle.subjects.map((subject) => {
                const cell = bundle.matrix.find(
                  (candidate) => candidate.subjectId === subject.id && candidate.dimensionId === dimension.id,
                );
                const status = cell?.status ?? "missing";
                const selected =
                  selectedCell !== null && selectedCell.subjectId === subject.id && selectedCell.dimensionId === dimension.id;
                return (
                  <td key={subject.id}>
                    <div className="rp-cellwrap">
                      <button
                        type="button"
                        className={`rp-cell${selected ? " rp-cell--selected" : ""}`}
                        aria-pressed={selected}
                        onClick={() => {
                          setSelection({ kind: "cell", subjectId: subject.id, dimensionId: dimension.id });
                          openDock({ kind: "cell", subjectId: subject.id, dimensionId: dimension.id });
                        }}
                        data-testid={`cell-${subject.id}-${dimension.id}`}
                      >
                        <span className={`rp-cell__status rp-cell__status--${status}`}>
                          <span aria-hidden="true">{STATUS_MARKS[status]}</span>
                          {STATUS_LABELS[status]}
                        </span>
                        <span className="rp-cell__judgment">
                          {cell === undefined || status === "missing"
                            ? "还没有针对这一项的材料"
                            : cell.status === "reviewed"
                              ? cell.note.length > 0
                                ? cell.note
                                : cell.reason
                              : cell.gap.length > 0
                                ? cell.gap
                                : cell.reason}
                        </span>
                        <span className="rp-cell__support">
                          {supportLine(bundle, cell?.evidenceIds ?? [])}
                          {status === "conflict" && <span className="rp-chip rp-chip--conflict">需并置说明</span>}
                        </span>
                      </button>
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="rp-matrix__foot">
        <span className="rp-legend">
          <span>
            <span aria-hidden="true">{STATUS_MARKS.reviewed}</span>
            {STATUS_LABELS.reviewed}
          </span>
          <span>
            <span aria-hidden="true">{STATUS_MARKS.limited}</span>
            {STATUS_LABELS.limited}
          </span>
          <span>
            <span aria-hidden="true">{STATUS_MARKS.unassessed}</span>
            {STATUS_LABELS.unassessed}
          </span>
          <span>
            <span aria-hidden="true">{STATUS_MARKS.conflict}</span>
            {STATUS_LABELS.conflict}
          </span>
          <span>
            <span aria-hidden="true">{STATUS_MARKS.missing}</span>
            {STATUS_LABELS.missing}
          </span>
        </span>
        <span style={{ marginLeft: "auto" }}>
          状态由真实证据与已保存的支持评估推导：读到片段不等于已核对，「已核对」也不表示结论已被证明为真。
        </span>
      </div>
    </div>
  );
}

function GapList({ bundle }: { readonly bundle: TaskBundle }) {
  const { act, busy, openDock, setSelection } = useApp();
  if (bundle.gaps.length === 0) return null;
  const roundsLeft = bundle.budget.maxGapRounds - bundle.usage.gapRounds;
  return (
    <div style={{ marginTop: 26 }}>
      <div className="rp-section-head">
        <h2>还缺什么</h2>
        <span>
          {bundle.gaps.length} 项 · 补查剩 {roundsLeft} 轮
        </span>
      </div>
      <div className="rp-lib" style={{ background: "var(--rp-surface)", border: "1px solid var(--rp-hairline)", borderRadius: "var(--rp-r-surface)" }}>
        {bundle.gaps.slice(0, 6).map((cell) => (
          <button
            key={`${cell.subjectId}-${cell.dimensionId}`}
            type="button"
            className="rp-lib__row"
            style={{ gridTemplateColumns: "minmax(0,1fr) 118px", paddingLeft: 16 }}
            onClick={() => {
              setSelection({ kind: "cell", subjectId: cell.subjectId, dimensionId: cell.dimensionId });
              openDock({ kind: "cell", subjectId: cell.subjectId, dimensionId: cell.dimensionId });
            }}
          >
            <span style={{ minWidth: 0 }}>
              <span className="rp-lib__title" style={{ fontWeight: 500 }}>
                {cell.subjectName} × {cell.dimensionName}
              </span>
              <span className="rp-lib__sub">{cell.gap.length > 0 ? cell.gap : cell.reason}</span>
            </span>
            <span className={`rp-chip rp-chip--${cell.status}`} style={{ justifySelf: "end" }}>
              {STATUS_LABELS[cell.status]}
            </span>
          </button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
        <Tooltip label={roundsLeft <= 0 ? "补查轮次已用完" : "围绕这些缺口做一轮定向补查"} withArrow={false}>
          <span>
            <Button
              variant="default"
              leftSection={<Target size={15} />}
              disabled={busy || roundsLeft <= 0 || !bundle.task.confirmed}
              onClick={() => {
                void act(() => api.gap(bundle.task.id), "定向补查");
              }}
              data-testid="gap-button"
            >
              定向补查
            </Button>
          </span>
        </Tooltip>
        <Tooltip label="先补查，再决定要不要写进报告" withArrow={false}>
          <span>
            <Button
              leftSection={<FileText size={15} />}
              disabled={busy || !bundle.task.confirmed || bundle.hasReport}
              onClick={() => {
                void act(() => api.report(bundle.task.id), "撰写报告");
              }}
              data-testid="report-button"
            >
              {bundle.hasReport ? "报告已生成" : "撰写报告"}
            </Button>
          </span>
        </Tooltip>
        {bundle.hasReport && (
          <Button
            variant="subtle"
            rightSection={<ArrowRight size={15} />}
            onClick={() => {
              navigate(projectHash(bundle.task.id, "report"));
            }}
          >
            打开报告
          </Button>
        )}
      </div>
    </div>
  );
}

export function ResearchView() {
  const { bundle, refresh } = useApp();
  const running = bundle === null ? null : runningSummary(bundle);

  // A cell that changed state gets one quiet flash: the matrix updated, and the
  // reader should be able to see where without watching the network.
  const previous = useRef<Map<string, string>>(new Map());
  const [flashed, setFlashed] = useState<string | null>(null);
  useEffect(() => {
    if (bundle === null) return;
    const next = new Map(bundle.matrix.map((cell) => [`${cell.subjectId}|${cell.dimensionId}`, cell.status]));
    if (previous.current.size > 0) {
      for (const [key, status] of next) {
        const before = previous.current.get(key);
        if (before !== undefined && before !== status) {
          setFlashed(key);
          window.setTimeout(() => {
            setFlashed(null);
          }, 600);
          break;
        }
      }
    }
    previous.current = next;
  }, [bundle]);

  const live = useMemo(() => running, [running]);

  if (bundle === null) return null;

  return (
    <div className="rp-split">
      <div className="rp-split__main">
        <div className="rp-research">
          <ProjectHeadline bundle={bundle} />

          {live !== null && (
        <div className="rp-runstate" aria-live="polite" data-testid="running-state">
          <span className="rp-runstate__icon" aria-hidden="true">
            <Loader size={14} color="ink" />
          </span>
          <div>
            <div className="rp-runstate__doing">{live.doing}</div>
            <div className="rp-runstate__why">{live.why}</div>
            <div className="rp-runstate__next">下一步：{live.next}内容以当前版本为准。</div>
          </div>
          <Button
            variant="subtle"
            size="xs"
            leftSection={<MessageSquare size={13} />}
            onClick={() => {
              void refresh();
            }}
          >
            刷新状态
          </Button>
        </div>
      )}

          <Matrix bundle={bundle} />
          <GapList bundle={bundle} />

          {bundle.task.reportNeedsReview !== null && (
        <div className="rp-note rp-note--warn" style={{ marginTop: 20 }}>
          <Gauge size={14} style={{ flex: "none", marginTop: 2 }} />
          <span>
            {bundle.task.reportNeedsReview.reason}（正文未改变；
            <button
              type="button"
              className="rp-nav__item"
              style={{ padding: "0 2px", fontSize: 13, color: "var(--rp-brand)" }}
              onClick={() => {
                navigate(projectHash(bundle.task.id, "report"));
              }}
            >
              去报告核对
            </button>
            ）
          </span>
        </div>
      )}

          {bundle.sources.length > 0 && (
        <p className="rp-meta" style={{ marginTop: 22 }} data-testid="research-sources-line">
          <Search size={13} />
          已读取 {bundle.sources.filter((source) => source.readStatus === "ok").length} 个来源
          <span className="rp-meta__sep">·</span>
          {bundle.evidence.length} 条证据
          <span className="rp-meta__sep">·</span>
          {/* The role line is the project's own readout: a source nobody
              classified is unclassified, which is not the same as a project
              with no primary material. */}
          {bundle.presentation.sourceRoles.userMessage}
          <button
            type="button"
            className="rp-nav__item"
            style={{ padding: "0 4px", fontSize: 12.5 }}
            onClick={() => {
              navigate(projectHash(bundle.task.id, "sources"));
            }}
          >
            查看来源工作区
          </button>
        </p>
      )}

          {bundle.task.error !== null && (
            <div className="rp-note rp-note--danger" style={{ marginTop: 20 }}>
              <CircleDot size={14} style={{ flex: "none", marginTop: 2 }} />
              <span>{bundle.task.error}</span>
            </div>
          )}
        </div>
      </div>
      <DockSlot />
    </div>
  );
}
