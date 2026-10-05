/**
 * The Research Workspace: three columns, one research task.
 *
 * The layout is the product's argument. On the left, the task card, the outline
 * and the coverage summary — what is being researched. In the middle, the run's
 * real progress and the evidence matrix — which comparison still lacks
 * support, and what the agent is doing about it. On the right, the inspector —
 * the actual excerpt, its location, its read scope, and the source it came
 * from. The report preview and the PDF are the same snapshot of the same
 * material, so clicking a claim leads to the passage that supports it rather
 * than to a second opinion.
 *
 * The page holds no research state of its own: everything it shows is a poll of
 * the application's API, which is why a refresh reopens a finished task exactly
 * where it was left.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  api,
  SCOPE_LABELS,
  STAGE_LABELS,
  STATUS_MARKS,
  type CellView,
  type EvidenceView,
  type SourceView,
  type TaskBundle,
  type TaskSummary,
} from "./api.js";

const POLL_MS = 1_500;

function when(iso: string | null): string {
  if (iso === null) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("zh-CN", { hour12: false });
}

function short(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export function Workspace() {
  const [taskId, setTaskId] = useState<string | null>(() => window.localStorage.getItem("researchpage.task"));
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [bundle, setBundle] = useState<TaskBundle | null>(null);
  const [tasks, setTasks] = useState<readonly TaskSummary[]>([]);
  const [tab, setTab] = useState<"progress" | "report">("progress");
  const [cell, setCell] = useState<{ readonly subjectId: string; readonly dimensionId: string } | null>(null);
  const [evidenceId, setEvidenceId] = useState<string | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [topic, setTopic] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [working, setWorking] = useState(false);
  const inFlight = useRef(false);
  // The last values the page rendered. Polling is how the workspace stays
  // current, but a poll that found nothing new must not re-render: React would
  // replace the very elements a reader is about to click, and a page that
  // redraws every second is worse to use than one that waits.
  const lastBundle = useRef("");
  const lastTasks = useRef("");

  const refresh = useCallback(async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      if (taskId !== null) {
        const next = await api.task(taskId);
        const serialized = JSON.stringify(next);
        if (serialized !== lastBundle.current) {
          lastBundle.current = serialized;
          setBundle(next);
        }
      } else if (sessionId !== null) {
        const state = await api.sessionState(sessionId);
        if (state.task !== null) {
          const serialized = JSON.stringify(state.task);
          lastBundle.current = serialized;
          setBundle(state.task);
          setTaskId(state.task.task.id);
          window.localStorage.setItem("researchpage.task", state.task.task.id);
          setSessionId(null);
        }
      }
      const listed = await api.listTasks();
      const serializedTasks = JSON.stringify(listed.tasks);
      if (serializedTasks !== lastTasks.current) {
        lastTasks.current = serializedTasks;
        setTasks(listed.tasks);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "读取研究状态失败");
    } finally {
      inFlight.current = false;
    }
  }, [taskId, sessionId]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, POLL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [refresh]);

  const act = async (action: () => Promise<unknown>, what: string): Promise<void> => {
    setWorking(true);
    setNotice(null);
    try {
      await action();
      setNotice(`${what}已启动`);
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : `${what}失败`);
    } finally {
      setWorking(false);
    }
  };

  const submitTopic = async (): Promise<void> => {
    const value = topic.trim();
    if (value.length < 2) {
      setNotice("请输入一个研究主题");
      return;
    }
    setWorking(true);
    setNotice(null);
    try {
      const started = await api.startTask(value);
      setSessionId(started.sessionId);
      setTaskId(null);
      setBundle(null);
      setTopic("");
      setNotice("已开始生成任务卡：Agent 会先确定比较对象与研究维度。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "提交主题失败");
    } finally {
      setWorking(false);
    }
  };

  const openTask = (id: string): void => {
    setTaskId(id);
    setSessionId(null);
    setBundle(null);
    lastBundle.current = "";
    setEvidenceId(null);
    setSourceId(null);
    setCell(null);
    window.localStorage.setItem("researchpage.task", id);
  };

  const exportPdf = async (): Promise<void> => {
    if (bundle === null) return;
    setWorking(true);
    setNotice(null);
    try {
      const result = await api.exportPdf(bundle.task.id);
      setNotice(result.ok ? "PDF 已导出，可下载打开" : `PDF 导出失败：${result.failure}`);
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "导出失败");
    } finally {
      setWorking(false);
    }
  };

  const currentReport = bundle?.reports.find((report) => report.isCurrent) ?? null;
  const currentExport =
    bundle?.exports.filter((artifact) => artifact.isCurrentReport && artifact.status === "exported").slice(-1)[0] ?? null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand__mark">研页</span>
          <span className="brand__sub">ResearchPage · 结构驱动的研究工作台</span>
        </div>
        <div className="topbar__task">
          {bundle === null ? (
            <form
              className="topic"
              onSubmit={(event) => {
                event.preventDefault();
                void submitTopic();
              }}
            >
              <input
                className="topic__input"
                value={topic}
                placeholder="输入研究主题，例如：GraphRAG 方法与代表工作"
                onChange={(event) => {
                  setTopic(event.target.value);
                }}
                data-testid="topic-input"
              />
              <button className="btn btn--primary" type="submit" disabled={working} data-testid="topic-submit">
                {sessionId === null ? "开始研究" : "生成任务卡中…"}
              </button>
            </form>
          ) : (
            <div className="topbar__current">
              <div className="topbar__title">{bundle.task.topic}</div>
              <div className="topbar__meta">
                <StatusPill bundle={bundle} />
                <span>搜索 {bundle.usage.searches}/{bundle.budget.maxSearches}</span>
                <span>读取 {bundle.usage.reads}/{bundle.budget.maxReads}</span>
                <span>补查 {bundle.usage.gapRounds}/{bundle.budget.maxGapRounds}</span>
              </div>
            </div>
          )}
        </div>
        <div className="topbar__actions">
          {bundle !== null && (
            <>
              <button
                className="btn"
                type="button"
                onClick={() => {
                  // A new topic is a new research task: the current one keeps
                  // its materials and stays reachable from the history list.
                  setTaskId(null);
                  setSessionId(null);
                  setBundle(null);
                  lastBundle.current = "";
                  window.localStorage.removeItem("researchpage.task");
                  setNotice("已回到新建研究：输入主题即可开始一项新研究，原任务仍保留在历史列表中。");
                }}
                data-testid="new-research"
              >
                新建研究
              </button>
              <button
                className="btn"
                type="button"
                onClick={() => {
                  setTab("report");
                }}
                disabled={currentReport === null}
                data-testid="open-preview"
              >
                报告预览
              </button>
              <button className="btn" type="button" onClick={() => void exportPdf()} disabled={working || currentReport === null} data-testid="export-pdf">
                导出 PDF
              </button>
              {currentExport !== null && (
                <a className="btn btn--primary" href={api.exportFileUrl(currentExport.exportId)} data-testid="download-pdf">
                  下载 PDF（{(currentExport.bytes / 1024).toFixed(0)} KB）
                </a>
              )}
            </>
          )}
        </div>
      </header>

      {notice !== null && (
        <div className="notice" role="status">
          {notice}
          <button
            className="notice__close"
            type="button"
            onClick={() => {
              setNotice(null);
            }}
          >
            ×
          </button>
        </div>
      )}

      <main className="workspace">
        <aside className="col col--left">
          <TaskCard bundle={bundle} working={working} onConfirm={() => void act(() => api.confirm(bundle!.task.id), "研究")} />
          <OutlinePanel bundle={bundle} />
          <CoveragePanel
            bundle={bundle}
            working={working}
            onGap={() => void act(() => api.gap(bundle!.task.id), "定向补查")}
            onReport={() => void act(() => api.report(bundle!.task.id), "报告生成")}
            onSelectCell={(next) => {
              setCell(next);
              setTab("progress");
            }}
          />
          <HistoryPanel tasks={tasks} activeId={bundle?.task.id ?? null} onOpen={openTask} />
        </aside>

        <section className="col col--center">
          <div className="tabs">
            <button
              type="button"
              className={tab === "progress" ? "tab tab--active" : "tab"}
              onClick={() => {
                setTab("progress");
              }}
              data-testid="tab-progress"
            >
              研究进度与证据矩阵
            </button>
            <button
              type="button"
              className={tab === "report" ? "tab tab--active" : "tab"}
              onClick={() => {
                setTab("report");
              }}
              disabled={currentReport === null}
              data-testid="tab-report"
            >
              报告预览{currentReport === null ? "（尚未生成）" : ""}
            </button>
          </div>
          {tab === "progress" ? (
            <ProgressPanel
              bundle={bundle}
              selectedCell={cell}
              onSelectCell={(next) => {
                setCell(next);
              }}
              onSelectEvidence={(id) => {
                setEvidenceId(id);
              }}
            />
          ) : currentReport === null ? (
            <p className="empty">报告尚未生成。</p>
          ) : (
            <div className="report">
              <iframe
                className="report__frame"
                title="报告预览"
                src={api.reportHtmlUrl(currentReport.reportId)}
                data-testid="report-frame"
              />
              <p className="hint">
                预览与 PDF 使用同一份报告快照：引用编号、参考来源、证据节选索引均由程序生成；点击引用可跳到本文档的参考来源与证据节选。
              </p>
            </div>
          )}
        </section>

        <aside className="col col--right">
          <InspectorPanel
            bundle={bundle}
            cell={cell}
            evidenceId={evidenceId}
            sourceId={sourceId}
            onSelectEvidence={(id) => {
              setEvidenceId(id);
            }}
            onSelectSource={(id) => {
              setSourceId(id);
            }}
          />
        </aside>
      </main>

      {bundle !== null && (
        <footer className="footer">
          <form
            className="followup"
            onSubmit={(event) => {
              event.preventDefault();
              const text = followUp.trim();
              if (text.length === 0) return;
              setFollowUp("");
              void act(() => api.followUp(bundle.task.id, text), "追加指令");
            }}
          >
            <input
              className="followup__input"
              value={followUp}
              placeholder="追加指令（例如：把部署成本维度补全；或：重写局限章节）"
              onChange={(event) => {
                setFollowUp(event.target.value);
              }}
              data-testid="followup-input"
            />
            <button className="btn" type="submit" disabled={working} data-testid="followup-submit">
              发送指令
            </button>
          </form>
        </footer>
      )}
    </div>
  );
}

function StatusPill({ bundle }: { readonly bundle: TaskBundle }) {
  const label =
    bundle.task.status === "draft"
      ? "待确认任务卡"
      : bundle.task.status === "confirmed"
        ? "已确认"
        : bundle.task.status === "researching"
          ? "研究中"
          : bundle.task.status === "ready"
            ? "报告就绪"
            : "失败";
  return (
    <span className={`pill pill--${bundle.task.status}`} data-testid="task-status">
      {label}
      {bundle.busy ? " · 运行中" : ""}
    </span>
  );
}

function TaskCard({
  bundle,
  working,
  onConfirm,
}: {
  readonly bundle: TaskBundle | null;
  readonly working: boolean;
  readonly onConfirm: () => void;
}) {
  if (bundle === null) {
    return (
      <section className="panel" data-testid="task-card">
        <h2 className="panel__title">研究任务</h2>
        <p className="hint">还没有研究任务。输入一个主题，Agent 会先给出任务卡供你确认。</p>
      </section>
    );
  }
  const { task } = bundle;
  return (
    <section className="panel" data-testid="task-card">
      <h2 className="panel__title">研究任务 · Task Card</h2>
      <dl className="card">
        <dt>主题</dt>
        <dd data-testid="card-topic">{task.topic}</dd>
        <dt>用途</dt>
        <dd>{task.purpose.length > 0 ? task.purpose : "—"}</dd>
        <dt>读者</dt>
        <dd>{task.audience.length > 0 ? task.audience : "—"}</dd>
        {task.focus.length > 0 && (
          <>
            <dt>关注点</dt>
            <dd>{task.focus.join("、")}</dd>
          </>
        )}
        <dt>比较对象</dt>
        <dd data-testid="card-subjects">{bundle.subjects.map((subject) => subject.name).join(" / ")}</dd>
        <dt>研究维度</dt>
        <dd data-testid="card-dimensions">{bundle.dimensions.map((dimension) => dimension.name).join(" / ")}</dd>
      </dl>
      {!task.confirmed ? (
        <button className="btn btn--primary" type="button" onClick={onConfirm} disabled={working} data-testid="confirm-card">
          确认任务卡并开始研究
        </button>
      ) : (
        <p className="hint">任务卡已于 {when(task.confirmedAt)} 确认；结构会驱动后续检索、矩阵与报告。</p>
      )}
      {task.error !== null && <p className="error">{task.error}</p>}
    </section>
  );
}

function OutlinePanel({ bundle }: { readonly bundle: TaskBundle | null }) {
  if (bundle === null) return null;
  const required = new Set(["overview", "representative", "comparison", "limitations"]);
  return (
    <section className="panel">
      <h2 className="panel__title">报告结构与发现的问题</h2>
      <ol className="outline">
        {bundle.structure.map((section) => (
          <li key={section.id}>
            <span className="outline__title">{section.title}</span>
            {required.has(section.id) && <span className="tag">必需</span>}
            <div className="outline__question">{section.question}</div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function CoveragePanel({
  bundle,
  working,
  onGap,
  onReport,
  onSelectCell,
}: {
  readonly bundle: TaskBundle | null;
  readonly working: boolean;
  readonly onGap: () => void;
  readonly onReport: () => void;
  readonly onSelectCell: (cell: { readonly subjectId: string; readonly dimensionId: string }) => void;
}) {
  if (bundle === null) return null;
  const counts = { sufficient: 0, partial: 0, missing: 0 };
  for (const cell of bundle.matrix) counts[cell.status === "evaluating" ? "missing" : cell.status] += 1;
  const gapRoundsLeft = bundle.budget.maxGapRounds - bundle.usage.gapRounds;
  const canGap = gapRoundsLeft > 0 && bundle.gaps.length > 0 && bundle.task.confirmed && !bundle.busy;
  return (
    <section className="panel">
      <h2 className="panel__title">证据覆盖</h2>
      <div className="coverage">
        <span className="mark mark--sufficient">● 充分 {counts.sufficient}</span>
        <span className="mark mark--partial">◐ 部分 {counts.partial}</span>
        <span className="mark mark--missing">○ 缺失 {counts.missing}</span>
      </div>
      {bundle.gaps.length > 0 ? (
        <ul className="gaps">
          {bundle.gaps.slice(0, 5).map((cell) => (
            <li key={`${cell.subjectId}-${cell.dimensionId}`}>
              <button
                className="linklike"
                type="button"
                onClick={() => {
                  onSelectCell({ subjectId: cell.subjectId, dimensionId: cell.dimensionId });
                }}
              >
                {cell.subjectName} × {cell.dimensionName}
              </button>
              <span className="gaps__status">{STATUS_MARKS[cell.status]}</span>
              <div className="gaps__why">{short(cell.gap.length > 0 ? cell.gap : cell.reason, 60)}</div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="hint">本次材料覆盖了全部比较项。</p>
      )}
      <div className="panel__actions">
        <button
          className="btn"
          type="button"
          onClick={onGap}
          disabled={!canGap || working}
          title={gapRoundsLeft <= 0 ? "补查轮次已用完" : "针对缺口做一轮定向补查"}
          data-testid="gap-button"
        >
          定向补查（剩 {gapRoundsLeft} 轮）
        </button>
        <button className="btn" type="button" onClick={onReport} disabled={!bundle.task.confirmed || bundle.busy || working} data-testid="report-button">
          生成报告
        </button>
      </div>
    </section>
  );
}

function HistoryPanel({
  tasks,
  activeId,
  onOpen,
}: {
  readonly tasks: readonly TaskSummary[];
  readonly activeId: string | null;
  readonly onOpen: (id: string) => void;
}) {
  if (tasks.length === 0) return null;
  return (
    <section className="panel">
      <h2 className="panel__title">历史研究（刷新后可重开）</h2>
      <ul className="history">
        {tasks.map((task) => (
          <li key={task.id}>
            <button
              className={task.id === activeId ? "linklike linklike--active" : "linklike"}
              type="button"
              onClick={() => {
                onOpen(task.id);
              }}
              data-testid={`history-${task.id}`}
            >
              {short(task.topic, 26)}
            </button>
            <span className="history__meta">
              {task.status}
              {task.hasReport ? " · 有报告" : ""}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ProgressPanel({
  bundle,
  selectedCell,
  onSelectCell,
  onSelectEvidence,
}: {
  readonly bundle: TaskBundle | null;
  readonly selectedCell: { readonly subjectId: string; readonly dimensionId: string } | null;
  readonly onSelectCell: (cell: { readonly subjectId: string; readonly dimensionId: string }) => void;
  readonly onSelectEvidence: (id: string) => void;
}) {
  if (bundle === null) {
    return <p className="empty">输入主题后，这里会显示真实检索、读取与覆盖评估的过程。</p>;
  }
  const latestRuns = [...bundle.runs].reverse().slice(0, 6);
  return (
    <div className="progress">
      <section className="panel">
        <h2 className="panel__title">运行阶段</h2>
        {latestRuns.length === 0 ? (
          <p className="hint">还没有运行记录。</p>
        ) : (
          <ol className="runs">
            {latestRuns.map((run) => (
              <li key={`${run.stage}-${run.startedAt}`} className={`run run--${run.status}`}>
                <div className="run__head">
                  <b>{STAGE_LABELS[run.stage]}</b>
                  <span className={`run__status run__status--${run.status}`}>{run.status}</span>
                  <span className="run__time">{when(run.startedAt)}</span>
                </div>
                <div className="run__note">{run.note}</div>
                {run.activity.length > 0 && (
                  <ul className="run__steps">
                    {run.activity.map((step, index) => (
                      <li key={`${step.name}-${index}`}>
                        <code>{step.name}</code>
                        {step.ok === false && <span className="run__failed"> 失败</span>}
                        <span className="run__detail">{short(step.detail, 110)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="panel panel--matrix">
        <h2 className="panel__title">证据矩阵 · Evidence Matrix（行=研究维度，列=比较对象）</h2>
        <table className="matrix" data-testid="evidence-matrix">
          <thead>
            <tr>
              <th>研究维度</th>
              {bundle.subjects.map((subject) => (
                <th key={subject.id}>{subject.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {bundle.dimensions.map((dimension) => (
              <tr key={dimension.id}>
                <th scope="row" title={dimension.question}>
                  {dimension.name}
                </th>
                {bundle.subjects.map((subject) => {
                  const cell = bundle.matrix.find(
                    (candidate) => candidate.subjectId === subject.id && candidate.dimensionId === dimension.id,
                  );
                  const selected = selectedCell?.subjectId === subject.id && selectedCell?.dimensionId === dimension.id;
                  return (
                    <td key={subject.id}>
                      <button
                        type="button"
                        className={`cell cell--${cell?.status ?? "missing"}${selected ? " cell--selected" : ""}`}
                        title={cell === undefined ? "" : `${cell.reason}${cell.gap.length > 0 ? `｜缺口：${cell.gap}` : ""}`}
                        onClick={() => {
                          onSelectCell({ subjectId: subject.id, dimensionId: dimension.id });
                          const first = cell?.evidenceIds[0];
                          if (first !== undefined) onSelectEvidence(first);
                        }}
                        data-testid={`cell-${subject.id}-${dimension.id}`}
                      >
                        <span className="cell__mark">{STATUS_MARKS[cell?.status ?? "missing"]}</span>
                        <span className="cell__count">{cell === undefined ? 0 : cell.evidenceIds.length}</span>
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="legend">
          ● 有正文级证据（sufficient）｜◐ 仅摘要或部分依据（partial）｜○ 无依据（missing）｜数字为该单元格的证据条数。状态由真实读取范围推导。
        </p>
      </section>

      {bundle.reports.length > 0 && (
        <section className="panel">
          <h2 className="panel__title">报告引文（Claim → Evidence）</h2>
          <ul className="claims">
            {bundle.reports
              .filter((report) => report.isCurrent)
              .flatMap((report) => report.claims.map((claim) => (
                <li key={claim.id}>
                  <span className={`tag tag--${claim.kind}`}>{claim.kind === "inference" ? "综合判断" : claim.kind === "comparison" ? "比较" : "事实"}</span>
                  <span className="claims__text">{short(claim.text, 120)}</span>
                  <span className="claims__evidence">
                    {claim.evidenceIds.map((id) => (
                      <button
                        key={id}
                        className="linklike"
                        type="button"
                        onClick={() => {
                          onSelectEvidence(id);
                        }}
                      >
                        {id.slice(0, 10)}
                      </button>
                    ))}
                  </span>
                </li>
              )))}
          </ul>
        </section>
      )}
    </div>
  );
}

function InspectorPanel({
  bundle,
  cell,
  evidenceId,
  sourceId,
  onSelectEvidence,
  onSelectSource,
}: {
  readonly bundle: TaskBundle | null;
  readonly cell: { readonly subjectId: string; readonly dimensionId: string } | null;
  readonly evidenceId: string | null;
  readonly sourceId: string | null;
  readonly onSelectEvidence: (id: string) => void;
  readonly onSelectSource: (id: string) => void;
}) {
  if (bundle === null) {
    return (
      <section className="panel" data-testid="inspector">
        <h2 className="panel__title">Sources / Evidence</h2>
        <p className="hint">尚无研究材料。</p>
      </section>
    );
  }

  const subjects = new Map(bundle.subjects.map((subject) => [subject.id, subject.name]));
  const dimensions = new Map(bundle.dimensions.map((dimension) => [dimension.id, dimension.name]));
  const cellView: CellView | null =
    cell === null
      ? null
      : bundle.matrix.find((candidate) => candidate.subjectId === cell.subjectId && candidate.dimensionId === cell.dimensionId) ?? null;

  const cellEvidence: readonly EvidenceView[] =
    cellView === null
      ? []
      : bundle.evidence.filter((item) => item.cells.some((ref) => ref.subjectId === cellView.subjectId && ref.dimensionId === cellView.dimensionId));
  const selectedEvidence =
    evidenceId === null ? cellEvidence[0] ?? null : bundle.evidence.find((item) => item.evidenceId === evidenceId) ?? null;
  const selectedSource: SourceView | null =
    sourceId !== null
      ? bundle.sources.find((source) => source.sourceId === sourceId) ?? null
      : selectedEvidence === null
        ? null
        : bundle.sources.find((source) => source.sourceId === selectedEvidence.sourceId) ?? null;

  return (
    <div data-testid="inspector">
      <section className="panel">
        <h2 className="panel__title">证据检查器 · Evidence Inspector</h2>
        {cellView === null ? (
          <p className="hint">点击矩阵中的一个单元格，查看该比较项已有的片段与缺口。</p>
        ) : (
          <>
            <div className="inspect__cell">
              <b>
                {subjects.get(cellView.subjectId)} × {dimensions.get(cellView.dimensionId)}
              </b>
              <span className={`pill pill--${cellView.status}`}>{STATUS_MARKS[cellView.status]} {cellView.reason}</span>
              {cellView.gap.length > 0 && <p className="hint">缺口：{cellView.gap}</p>}
              {cellView.note.length > 0 && <p className="hint">Agent 说明：{cellView.note}</p>}
            </div>
            {cellEvidence.length === 0 ? (
              <p className="hint">该单元格还没有绑定证据。</p>
            ) : (
              <ul className="evidence">
                {cellEvidence.map((item) => (
                  <li
                    key={item.evidenceId}
                    className={selectedEvidence?.evidenceId === item.evidenceId ? "evidence__item evidence__item--active" : "evidence__item"}
                  >
                    <button
                      className="linklike"
                      type="button"
                      onClick={() => {
                        onSelectEvidence(item.evidenceId);
                      }}
                    >
                      {item.evidenceId}
                    </button>
                    <span className="tag">{SCOPE_LABELS[item.readScope] ?? item.readScope}</span>
                    <div className="evidence__excerpt">{item.excerpt}</div>
                    <div className="evidence__locator">
                      位置：{item.locator.headingPath.join(" > ") || "—"}（第 {item.locator.paragraphIndex + 1} 段，字符 {item.locator.charStart}–{item.locator.charEnd}）
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      <section className="panel">
        <h2 className="panel__title">来源 · Sources（{bundle.sources.length}）</h2>
        <ul className="sources">
          {bundle.sources.map((source) => (
            <li key={source.sourceId} className={selectedSource?.sourceId === source.sourceId ? "sources__item sources__item--active" : "sources__item"}>
              <button
                className="linklike"
                type="button"
                onClick={() => {
                  onSelectSource(source.sourceId);
                }}
                data-testid={`source-${source.sourceId}`}
              >
                {short(source.title, 64)}
              </button>
              <div className="sources__meta">
                <span className={`readstate readstate--${source.readStatus}`}>
                  {source.readStatus === "ok"
                    ? `已读取 · ${SCOPE_LABELS[source.readScope ?? ""] ?? "—"}`
                    : source.readStatus === "failed"
                      ? "读取失败"
                      : "未读取（候选）"}
                </span>
                {source.publishedAt !== null && <span>{(source.publishedAt ?? "").slice(0, 10)}</span>}
              </div>
            </li>
          ))}
        </ul>
      </section>

      {selectedSource !== null && (
        <section className="panel" data-testid="source-detail">
          <h2 className="panel__title">来源详情</h2>
          <h3 className="source__title">{selectedSource.title}</h3>
          <div className="source__meta">
            {selectedSource.authors.slice(0, 6).join(", ")} · {selectedSource.venue}
            {selectedSource.publishedAt !== null ? ` · ${(selectedSource.publishedAt ?? "").slice(0, 10)}` : ""}
          </div>
          <div className="source__links">
            <a href={selectedSource.url} target="_blank" rel="noreferrer">
              原文链接
            </a>
            {selectedSource.readUrl !== null && selectedSource.readUrl !== selectedSource.url && (
              <a href={selectedSource.readUrl} target="_blank" rel="noreferrer">
                实际读取地址
              </a>
            )}
            {selectedSource.doi !== null && <span>DOI: {selectedSource.doi}</span>}
          </div>
          <div className="source__facts">
            <div>发现方式：{selectedSource.discovery.provider} · 查询「{selectedSource.discovery.query}」 · {when(selectedSource.discovery.queriedAt)}</div>
            <div>读取状态：{selectedSource.readStatus}｜范围：{SCOPE_LABELS[selectedSource.readScope ?? ""] ?? "—"}｜时间：{when(selectedSource.readAt)}</div>
            {selectedSource.retrievalNote.length > 0 && <div>读取说明：{selectedSource.retrievalNote}</div>}
            {selectedSource.failure !== null && <div className="error">失败原因：{selectedSource.failure}</div>}
          </div>
          {selectedSource.abstract.length > 0 && <p className="source__abstract">{selectedSource.abstract}</p>}
        </section>
      )}
    </div>
  );
}
