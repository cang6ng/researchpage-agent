/**
 * The product shell: identity, the open project, the project's own navigation,
 * and the one status line the workspace is allowed to keep.
 *
 * The bar is deliberately thin, and it got thinner: what a research tool must
 * not do is narrate its own bookkeeping. Searches, reads and gap rounds are
 * what a specific action spends, so they are stated beside that action when it
 * runs; the bar answers the question a reader actually has — what is happening
 * with this project — with one sentence and a way to see the facts behind it.
 *
 * The project has three workspaces: what it wrote, what it found, where it
 * read. The research scope is a property of the project and is reached from its
 * title; the print theme is a property of the document and is reached from the
 * report's own toolbar. Neither is a destination.
 */

import { ActionIcon, Menu, Popover, Tooltip } from "@mantine/core";
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
import { navigate, projectHash, PRIMARY_NAV, type Route, type View, VIEW_LABELS } from "./router.js";
import { primaryStatusOf, scopeEntryLabel, scopeSummary, statusDetails } from "./status.js";
import { useApp } from "./store.js";

const VIEW_ICONS: Readonly<Record<View, ReactNode>> = Object.freeze({
  report: <BookText size={15} strokeWidth={1.75} />,
  research: <LayoutList size={15} strokeWidth={1.75} />,
  sources: <Library size={15} strokeWidth={1.75} />,
  brief: <ScrollText size={15} strokeWidth={1.75} />,
  gallery: <GalleryVerticalEnd size={15} strokeWidth={1.75} />,
});

/** What each workspace is holding, as the count beside its name. */
function navCounts(bundle: TaskBundle): Partial<Record<View, string>> {
  const counts: Partial<Record<View, string>> = {};
  if (bundle.hasReport && bundle.gaps.length > 0) counts.report = `${String(bundle.gaps.length)} 项待查`;
  if (!bundle.hasReport && bundle.matrix.length > 0) {
    const reviewed = bundle.matrix.filter((cell) => cell.status === "reviewed").length;
    counts.research = `${String(reviewed)}/${String(bundle.matrix.length)}`;
  }
  if (bundle.sources.length > 0) counts.sources = String(bundle.sources.length);
  return counts;
}

/**
 * The project's status, and the facts it stands on.
 *
 * Clicking it is the whole gesture: the label is what is happening now, and the
 * panel behind it keeps the six answers the project has about itself side by
 * side — material coverage, unresolved research, the report's review flag, its
 * content contract and the source roles — each in its own sentence, because
 * they answer different questions and a reader checking one must not be handed
 * another.
 */
export function ProjectStatus({ bundle }: { readonly bundle: TaskBundle }) {
  const status = primaryStatusOf(bundle);
  return (
    <Popover shadow="md" width={392} position="bottom-start" withinPortal>
      <Popover.Target>
        <button
          type="button"
          className={`rp-chip rp-chip--${status.tone} rp-bar__state`}
          data-testid="project-status"
          data-state={status.kind}
        >
          {status.label}
        </button>
      </Popover.Target>
      <Popover.Dropdown data-testid="status-detail">
        <div className="rp-block__label" style={{ marginBottom: 10 }}>
          这个项目的状态
        </div>
        <dl className="rp-kv rp-kv--stack">
          {statusDetails(bundle).map((row) => (
            <div key={row.label} style={{ display: "contents" }}>
              <dt>{row.label}</dt>
              <dd>{row.text}</dd>
            </div>
          ))}
        </dl>
        <p className="rp-status__note">
          这些是并列的事实，不会互相覆盖：有材料不等于有结论，报告通过自己的内容检查也不等于结论已被独立复核。
        </p>
      </Popover.Dropdown>
    </Popover>
  );
}

export function GlobalBar({ route }: { readonly route: Route }) {
  const { bundle, tasks, runtime, openTask, openStart } = useApp();

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
              <Menu.Item
                leftSection={<LayoutList size={14} />}
                onClick={() => {
                  navigate(projectHash(bundle.task.id, "research"));
                }}
              >
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

          <Tooltip label={scopeSummary(bundle)} withArrow={false}>
            <button
              type="button"
              className="rp-bar__scope"
              onClick={() => {
                navigate(projectHash(bundle.task.id, "brief"));
              }}
              data-testid="scope-entry"
            >
              {scopeEntryLabel(bundle)}
              <span className="rp-bar__scope-view">查看</span>
            </button>
          </Tooltip>

          <ProjectStatus bundle={bundle} />
        </div>
      )}

      <div className="rp-bar__spacer" />

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
              navigate(projectHash(bundle.task.id, route.kind === "project" ? route.view ?? "report" : "report"));
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

/**
 * The project's three workspaces, and the scope while it is still undecided.
 *
 * An unconfirmed project has exactly one place to work, so the scope appears
 * beside the workspaces instead of being something the reader has to go and
 * find; once it is confirmed it leaves the row and lives beside the project's
 * title, with the rest of what the project *is* rather than what it contains.
 */
export function ProjectNav({ taskId, view }: { readonly taskId: string; readonly view: View }) {
  const { bundle } = useApp();
  const counts = bundle === null ? {} : navCounts(bundle);
  const deciding = bundle !== null && !bundle.task.confirmed;

  return (
    <nav className="rp-nav" aria-label="项目视图" data-testid="project-nav">
      {deciding && (
        <button
          key="brief"
          type="button"
          className="rp-nav__item"
          aria-current={view === "brief"}
          onClick={() => {
            navigate(projectHash(taskId, "brief"));
          }}
          data-testid="nav-brief"
        >
          {VIEW_ICONS.brief}
          研究范围
          <span className="rp-nav__count">待确认</span>
        </button>
      )}
      {PRIMARY_NAV.map((candidate) => (
        <button
          key={candidate}
          type="button"
          className="rp-nav__item"
          aria-current={candidate === view}
          onClick={() => {
            navigate(projectHash(taskId, candidate));
          }}
          data-testid={`nav-${candidate}`}
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
