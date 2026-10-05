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

/** What a claim's contract type is called in the workspace. */
const CLAIM_TYPE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  fact: "事实",
  mechanism: "机制",
  comparison: "比较",
  performance: "性能",
  cost: "成本",
  synthesis: "综合判断",
  implication: "条件化建议",
});

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
  // The assistant's entry: which intent the user is asking for, and — for an
  // Edit — which section it targets. The application turns these into the
  // action grant the run acts under; the text never carries the permission.
  const [intent, setIntent] = useState<"auto" | "ask" | "research" | "edit">("auto");
  const [targetSectionId, setTargetSectionId] = useState<string>("");
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
              {currentReport.frame === null ? null : (
                <p className="hint" data-testid="report-frame-question">
                  研究问题：{currentReport.frame.question}｜范围：{currentReport.frame.scope}
                </p>
              )}
              {currentReport.validation.warnings.length === 0 ? null : (
                <details className="hint hint--warn" data-testid="report-warnings">
                  <summary>质量检查提醒 {currentReport.validation.warnings.length} 条（不阻止发布）</summary>
                  <ul>
                    {currentReport.validation.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </details>
              )}
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
          <ProposalPanel
            bundle={bundle}
            working={working}
            onAccept={(proposalId) => void act(() => api.acceptProposal(proposalId), "接受提案")}
            onDiscard={(proposalId) => void act(() => api.discardProposal(proposalId), "放弃提案")}
          />
          <RevisionPanel
            bundle={bundle}
            working={working}
            onFreeze={() => void act(() => api.freeze(bundle!.task.id), "冻结版本")}
            onExport={(revisionId) => void act(() => api.exportRevision(revisionId), "导出冻结版本")}
          />
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
          <div className="followup">
            <select
              className="followup__intent"
              value={intent}
              onChange={(event) => {
                setIntent(event.target.value as "auto" | "ask" | "research" | "edit");
              }}
              data-testid="intent-select"
            >
              <option value="auto">Auto</option>
              <option value="ask">Ask</option>
              <option value="research">Research</option>
              <option value="edit">Edit</option>
            </select>
            {intent === "edit" && (
              <select
                className="followup__intent"
                value={targetSectionId}
                onChange={(event) => {
                  setTargetSectionId(event.target.value);
                }}
                data-testid="target-select"
              >
                <option value="">选择目标章节…</option>
                {(bundle.reports.find((report) => report.isCurrent)?.sections ?? []).map((section) => (
                  <option key={section.id} value={section.id}>
                    {section.title}
                  </option>
                ))}
              </select>
            )}
            <form
              className="followup__form"
              onSubmit={(event) => {
                event.preventDefault();
                const text = followUp.trim();
                if (text.length === 0) return;
                setFollowUp("");
                void act(
                  () =>
                    api.assistant(bundle.task.id, {
                      text,
                      intent,
                      ...(intent === "edit" && targetSectionId.length > 0 ? { targetSectionId } : {}),
                    }),
                  intent === "ask" ? "提问" : intent === "edit" ? "修改提案" : intent === "research" ? "补查" : "指令",
                );
              }}
            >
              <input
                className="followup__input"
                value={followUp}
                placeholder={
                  intent === "ask"
                    ? "问一个问题（例如：这份材料里 GraphRAG 的检索机制是什么？）"
                    : intent === "edit"
                      ? "说明要怎么改这个章节（例如：给本科生讲清楚，简化术语）"
                      : "追加指令（例如：把部署成本维度补全）"
                }
                onChange={(event) => {
                  setFollowUp(event.target.value);
                }}
                data-testid="followup-input"
              />
              <button className="btn" type="submit" disabled={working} data-testid="followup-submit">
                {intent === "ask" ? "提问" : intent === "edit" ? "生成修改建议" : intent === "research" ? "补查" : "发送指令"}
              </button>
            </form>
          </div>
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
  const counts = { reviewed: 0, limited: 0, unassessed: 0, conflict: 0, missing: 0 };
  for (const cell of bundle.matrix) counts[cell.status] += 1;
  const gapRoundsLeft = bundle.budget.maxGapRounds - bundle.usage.gapRounds;
  const canGap = gapRoundsLeft > 0 && bundle.gaps.length > 0 && bundle.task.confirmed && !bundle.busy;
  return (
    <section className="panel">
      <h2 className="panel__title">证据覆盖</h2>
      <div className="coverage">
        <span className="mark mark--sufficient">● 已核对 {counts.reviewed}</span>
        <span className="mark mark--partial">◐ 有限支持 {counts.limited}</span>
        <span className="mark mark--partial">◑ 待核对 {counts.unassessed}</span>
        {counts.conflict > 0 && <span className="mark mark--partial">◆ 冲突 {counts.conflict}</span>}
        <span className="mark mark--missing">○ 待查 {counts.missing}</span>
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
          ● 已核对（reviewed，有直接支持该问题的正文级评估）｜◐ 有限支持（limited）｜◑ 有片段待核对（unassessed）｜◆ 冲突/不可比（conflict）｜○
          待查（missing）｜数字为该单元格的证据条数。状态由真实证据与已保存的支持评估推导：有片段不等于已核对，reviewed 也不表示结论已被证明为真。
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
                  <span className={`tag tag--${claim.claimType === "fact" ? claim.kind : claim.claimType}`}>
                    {CLAIM_TYPE_LABELS[claim.claimType] ?? "事实"}
                  </span>
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

/**
 * The pending modification proposal, if there is one.
 *
 * Deliberately small: this round's job is to make the editing contract
 * reachable from the page — see the proposal, see its target and reason, accept
 * or discard it. The Report Studio that surrounds it is a later step.
 */
function ProposalPanel({
  bundle,
  working,
  onAccept,
  onDiscard,
}: {
  readonly bundle: TaskBundle | null;
  readonly working: boolean;
  readonly onAccept: (proposalId: string) => void;
  readonly onDiscard: (proposalId: string) => void;
}) {
  if (bundle === null) return null;
  const pending = bundle.proposals.filter((proposal) => proposal.status === "pending");
  if (bundle.proposals.length === 0) return null;
  return (
    <section className="panel">
      <h2 className="panel__title">修改提案</h2>
      {pending.length === 0 ? (
        <p className="hint">
          没有待处理的提案；最近一次：
          {bundle.proposals.slice(-1)[0]?.status ?? "-"}（{bundle.proposals.slice(-1)[0]?.targets.join("、") ?? "-"}）
        </p>
      ) : (
        pending.map((proposal) => (
          <div key={proposal.proposalId} className="proposal" data-testid="proposal">
            <div className="proposal__head">
              待接受 · 目标 {proposal.sections.map((section) => section.title).join("、") || proposal.targets.join("、")}
            </div>
            <p className="hint">{proposal.reason}</p>
            <p className="hint">
              基线 {proposal.baseReportId}（hash {proposal.baseContentHash.slice(7, 15)}…）· 引用 {proposal.evidenceIds.length} 条证据
            </p>
            <div className="proposal__actions">
              <button
                className="btn btn--primary"
                type="button"
                disabled={working}
                onClick={() => {
                  onAccept(proposal.proposalId);
                }}
                data-testid="accept-proposal"
              >
                接受修改
              </button>
              <button
                className="btn"
                type="button"
                disabled={working}
                onClick={() => {
                  onDiscard(proposal.proposalId);
                }}
                data-testid="discard-proposal"
              >
                放弃
              </button>
            </div>
            <p className="hint">接受只改变上面列出的目标；已获取的来源与证据不会因为放弃而删除。</p>
          </div>
        ))
      )}
    </section>
  );
}

/**
 * Frozen revisions: the exportable versions of this report.
 *
 * A frozen revision is the only thing an export may be rendered from, so the
 * panel's job is to say which versions exist and hand out their files.
 */
function RevisionPanel({
  bundle,
  working,
  onFreeze,
  onExport,
}: {
  readonly bundle: TaskBundle | null;
  readonly working: boolean;
  readonly onFreeze: () => void;
  readonly onExport: (revisionId: string) => void;
}) {
  if (bundle === null || bundle.currentReportId === null) return null;
  const forCurrent = bundle.revisions.filter((revision) => revision.isCurrentReport);
  return (
    <section className="panel">
      <h2 className="panel__title">报告版本</h2>
      <p className="hint">
        当前报告 {bundle.currentReportId}
        {bundle.currentReportHash === null ? "" : `（hash ${bundle.currentReportHash.slice(7, 15)}…）`}
        {bundle.currentReportFrozen ? " · 已冻结" : " · 尚未冻结"}
      </p>
      {bundle.task.reportNeedsReview !== null && (
        <p className="hint hint--warn">{bundle.task.reportNeedsReview.reason}（正文未改变）</p>
      )}
      <button
        className="btn"
        type="button"
        disabled={working}
        onClick={() => {
          onFreeze();
        }}
        data-testid="freeze-revision"
      >
        冻结当前版本
      </button>
      <ul className="gaps">
        {forCurrent.map((revision) => (
          <li key={revision.revisionId}>
            R{revision.revision} · {revision.evidenceCount} 条证据 · 主题 {revision.themeId}
            {revision.gapsCaptured ? "" : " · 未记录缺口快照"}{" "}
            <button
              className="linklike"
              type="button"
              disabled={working}
              onClick={() => {
                onExport(revision.revisionId);
              }}
              data-testid={`export-revision-${revision.revision}`}
            >
              导出 PDF
            </button>{" "}
            <a className="linklike" href={api.revisionHtmlUrl(revision.revisionId)} target="_blank" rel="noreferrer">
              查看冻结版本
            </a>
          </li>
        ))}
      </ul>
    </section>
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
