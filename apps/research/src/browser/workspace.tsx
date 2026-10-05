/**
 * The page: one shell, five views of one project, and the dock.
 *
 * The layout is the product's argument. The workspace never asks the reader to
 * hold a second screen in their head: whatever they select — a matrix cell, a
 * sentence in the report, a source row — opens in the same dock on the right,
 * so "look at this" and "check this" are the same gesture everywhere.
 */

import { Loader } from "@mantine/core";
import { X } from "lucide-react";
import { useEffect } from "react";

import { GlobalBar, ProjectNav } from "./shell.js";
import { useApp } from "./store.js";
import { useRoute, VIEW_LABELS, type View } from "./router.js";
import { BriefView } from "./views/brief.js";
import { GalleryView } from "./views/gallery.js";
import { ResearchView } from "./views/research.js";
import { SettingsView } from "./views/settings.js";
import { SourcesView } from "./views/sources.js";
import { StudioView } from "./views/studio.js";
import { StartView } from "./views/start.js";

function NoticeBar() {
  const { notice, dismissNotice } = useApp();
  if (notice === null) return null;
  const tone = notice.kind === "error" ? "danger" : notice.kind === "warn" ? "warn" : "quiet";
  return (
    <div style={{ padding: "14px 20px 0", maxWidth: 1440, margin: "0 auto", width: "100%" }}>
      <div className={`rp-note rp-note--${tone}`} role="status">
        <span style={{ flex: 1 }}>{notice.text}</span>
        <button
          type="button"
          onClick={dismissNotice}
          aria-label="关闭提示"
          style={{ border: 0, background: "none", cursor: "pointer", color: "inherit", padding: 0, lineHeight: 1 }}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

function PendingCard() {
  return (
    <div className="rp-loading" aria-live="polite">
      <div className="rp-kicker">正在建立任务卡</div>
      <h1 className="rp-title">助手正在确定比较对象与研究维度</h1>
      <p className="rp-lede">
        这一步会给出任务卡：研究对象、研究维度，以及报告将回答的问题。任务卡确认之前不会开始检索。
      </p>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12, color: "var(--rp-ink-3)" }}>
        <Loader size="xs" color="ink" />
        <span style={{ fontSize: 13 }}>通常需要十几秒</span>
      </div>
    </div>
  );
}

function ViewBody({ view }: { readonly view: View }) {
  switch (view) {
    case "brief":
      return <BriefView />;
    case "research":
      return <ResearchView />;
    case "report":
      return <StudioView />;
    case "sources":
      return <SourcesView />;
    case "gallery":
      return <GalleryView />;
  }
}

export function Workspace() {
  const route = useRoute();
  const { bundle, pendingSessionId, loading, taskId, openTask } = useApp();

  // The address is the page's own state: opening a project URL loads that
  // project, which is what makes a link to a report a link to a report.
  useEffect(() => {
    if (route.kind === "project" && route.taskId !== taskId) openTask(route.taskId);
  }, [route, taskId, openTask]);

  if (route.kind === "settings") {
    return (
      <div className="rp-shell">
        <GlobalBar route={route} />
        <NoticeBar />
        <main className="rp-main">
          <SettingsView />
        </main>
      </div>
    );
  }

  if (route.kind === "start") {
    if (loading && bundle === null && pendingSessionId === null) {
      return (
        <div className="rp-shell">
          <GlobalBar route={route} />
          <main className="rp-main">
            <div className="rp-loading">
              <div className="rp-kicker">研页 ResearchPage</div>
              <h1 className="rp-title">正在读取本地项目…</h1>
            </div>
          </main>
        </div>
      );
    }
    return (
      <div className="rp-shell">
        <GlobalBar route={route} />
        <NoticeBar />
        <main className="rp-main">
          <StartView />
        </main>
      </div>
    );
  }

  if (bundle === null) {
    return (
      <div className="rp-shell">
        <GlobalBar route={route} />
        <NoticeBar />
        <main className="rp-main">
          {pendingSessionId === null ? (
            <div className="rp-loading" aria-live="polite">
              <div className="rp-kicker">正在打开项目</div>
              <h1 className="rp-title">读取这份研究的材料与报告…</h1>
            </div>
          ) : (
            <PendingCard />
          )}
        </main>
      </div>
    );
  }

  const view: View = route.kind === "project" ? route.view : "research";

  return (
    <div className="rp-shell">
      <GlobalBar route={route} />
      <ProjectNav taskId={bundle.task.id} view={view} />
      <NoticeBar />
      <main className="rp-main">
        <span className="rp-visually-hidden">当前视图：{VIEW_LABELS[view]}</span>
        <ViewBody view={view} />
      </main>
    </div>
  );
}
