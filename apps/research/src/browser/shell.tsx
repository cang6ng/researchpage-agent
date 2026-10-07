/**
 * The product shell: identity, the open project, the project's own navigation,
 * and the one status line the workspace is allowed to keep.
 *
 * The bar is deliberately thin. What a research tool must not do is turn every
 * panel it owns into a destination: the project has five views — what it is,
 * what it found, what it wrote, where it read, how it prints — and everything
 * else (evidence, history, proposals) is a consequence of something on one of
 * those five, so it belongs in the dock rather than in the navigation.
 */

import { ActionIcon, Menu, Tooltip } from "@mantine/core";
import {
  BookText,
  FolderOpen,
  GalleryVerticalEnd,
  LayoutList,
  Library,
  MessageSquare,
  Plus,
  ScrollText,
  Settings as SettingsIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import type { TaskBundle } from "./api.js";
import { navigate, projectHash, type Route, type View, VIEW_LABELS } from "./router.js";
import { useApp } from "./store.js";

const VIEW_ICONS: Readonly<Record<View, ReactNode>> = Object.freeze({
  brief: <ScrollText size={15} strokeWidth={1.75} />,
  research: <LayoutList size={15} strokeWidth={1.75} />,
  report: <BookText size={15} strokeWidth={1.75} />,
  sources: <Library size={15} strokeWidth={1.75} />,
  gallery: <GalleryVerticalEnd size={15} strokeWidth={1.75} />,
});

/**
 * One sentence about where this project stands, in the reader's words.
 *
 * It is read from the project's own readout rather than recomputed here: the
 * label used to say「报告就绪 · 无待查项」whenever no matrix cell was open,
 * which is a claim about material coverage being worn as a claim about the
 * report. The readout separates those facts, so the label can only say the one
 * it means — and a report whose material arrived after it was written says
 * 「待复核」instead of「无待查项」.
 */
export function projectState(bundle: TaskBundle): { readonly label: string; readonly tone: string } {
  const readout = bundle.presentation;
  const run = readout.runState.state;
  if (run === "failed") return { label: readout.runState.displayName, tone: "danger" };
  if (run === "editing") return { label: readout.runState.displayName, tone: "accent" };
  if (run === "preparing") return { label: "待确认任务卡", tone: "limited" };
  if (run === "researching") return { label: readout.runState.displayName, tone: "accent" };
  const open = readout.unresolvedResearch.unresolved + readout.unresolvedResearch.limited + readout.unresolvedResearch.incomparable;
  return {
    label:
      readout.reportReview.state === "needs_review"
        ? `报告待复核 · ${String(open)} 项未定论`
        : open === 0
          ? "报告就绪 · 比较项均已核对"
          : `报告就绪 · ${String(open)} 项未定论`,
    tone: readout.reportReview.state === "needs_review" || open > 0 ? "limited" : "reviewed",
  };
}

function StatusDot({ bundle }: { readonly bundle: TaskBundle }) {
  const running = bundle.busy || bundle.task.status === "researching";
  return <span className={running ? "rp-dot rp-dot--busy" : "rp-dot rp-dot--live"} />;
}

export function GlobalBar({ route }: { readonly route: Route }) {
  const { bundle, tasks, runtime, openTask, openStart } = useApp();
  const state = bundle === null ? null : projectState(bundle);

  return (
    <header className="rp-bar">
      <button className="rp-brand" type="button" onClick={openStart} title="返回起始页">
        <span className="rp-brand__mark" aria-hidden="true">
          研
        </span>
        <span className="rp-brand__name">研页</span>
        <span className="rp-brand__sub">ResearchPage</span>
      </button>

      {bundle !== null && (
        <div className="rp-bar__project">
          <Menu shadow="md" width={320} position="bottom-start">
            <Menu.Target>
              <button className="rp-brand" type="button" title="切换研究项目">
                <FolderOpen size={15} strokeWidth={1.75} />
                <span className="rp-bar__title">{bundle.task.topic}</span>
              </button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>当前项目</Menu.Label>
              <Menu.Item leftSection={<LayoutList size={14} />} onClick={() => navigate(projectHash(bundle.task.id, "research"))}>
                {bundle.task.topic}
              </Menu.Item>
              <Menu.Divider />
              <Menu.Label>其它项目（{Math.max(0, tasks.length - 1)}）</Menu.Label>
              {tasks
                .filter((task) => task.id !== bundle.task.id)
                .slice(0, 8)
                .map((task) => (
                  <Menu.Item
                    key={task.id}
                    onClick={() => {
                      openTask(task.id);
                      navigate(projectHash(task.id, "research"));
                    }}
                  >
                    {task.topic}
                  </Menu.Item>
                ))}
              {tasks.length <= 1 && <Menu.Item disabled>还没有其它项目</Menu.Item>}
              <Menu.Divider />
              <Menu.Item leftSection={<Plus size={14} />} onClick={openStart}>
                开始一项新研究
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
          {state !== null && <span className={`rp-chip rp-chip--${state.tone}`}>{state.label}</span>}
        </div>
      )}

      <div className="rp-bar__spacer" />

      {bundle !== null && (
        <span className="rp-bar__status">
          <StatusDot bundle={bundle} />
          {bundle.busy || bundle.task.status === "researching" ? "研究进行中" : "已同步"}
          <span className="rp-meta__sep">·</span>
          搜索 {bundle.usage.searches}/{bundle.budget.maxSearches}
          <span className="rp-meta__sep">·</span>
          读取 {bundle.usage.reads}/{bundle.budget.maxReads}
        </span>
      )}

      {bundle === null && runtime !== null && (
        <span className="rp-bar__status">
          <span className="rp-dot rp-dot--live" />
          服务在线
        </span>
      )}

      {bundle !== null && (
        <Tooltip label="打开助手" withArrow={false}>
          <ActionIcon
            variant="subtle"
            aria-label="打开助手"
            onClick={() => {
              navigate(projectHash(bundle.task.id, route.kind === "project" ? route.view : "research"));
            }}
          >
            <MessageSquare size={16} strokeWidth={1.75} />
          </ActionIcon>
        </Tooltip>
      )}

      <Tooltip label="设置" withArrow={false}>
        <ActionIcon
          variant={route.kind === "settings" ? "light" : "subtle"}
          aria-label="设置"
          onClick={() => {
            navigate("#/settings");
          }}
        >
          <SettingsIcon size={16} strokeWidth={1.75} />
        </ActionIcon>
      </Tooltip>
    </header>
  );
}

export function ProjectNav({ taskId, view }: { readonly taskId: string; readonly view: View }) {
  const { bundle } = useApp();
  const counts: Partial<Record<View, string>> = {};
  if (bundle !== null) {
    const gaps = bundle.gaps.length;
    if (bundle.hasReport && gaps > 0) counts.report = `${gaps} 项待查`;
    if (!bundle.hasReport && bundle.matrix.length > 0) totals(bundle, counts);
    if (bundle.sources.length > 0) counts.sources = String(bundle.sources.length);
  }

  return (
    <nav className="rp-nav" aria-label="项目视图">
      {(["research", "report", "sources", "brief", "gallery"] as const).map((candidate) => (
        <button
          key={candidate}
          type="button"
          className="rp-nav__item"
          aria-current={candidate === view}
          onClick={() => {
            navigate(projectHash(taskId, candidate));
          }}
        >
          {VIEW_ICONS[candidate]}
          {VIEW_LABELS[candidate]}
          {counts[candidate] !== undefined && <span className="rp-nav__count">{counts[candidate]}</span>}
        </button>
      ))}
      <div className="rp-nav__right">
        {bundle !== null && bundle.hasReport && <span className="rp-meta">报告随研究更新，正文版本由你冻结</span>}
      </div>
    </nav>
  );
}

function totals(bundle: TaskBundle, counts: Partial<Record<View, string>>): void {
  const reviewed = bundle.matrix.filter((cell) => cell.status === "reviewed").length;
  counts.research = `${reviewed}/${bundle.matrix.length}`;
}

