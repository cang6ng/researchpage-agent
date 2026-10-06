/**
 * Report Studio: the document, and only what a reader needs around it.
 *
 * The default state is the document itself. Nothing is permanently bolted to
 * the side — no sources list, no history, no task card, no run log, no matrix —
 * because the report is the thing being read, and a reader who wants the
 * evidence behind a sentence selects that sentence and gets it in the dock.
 *
 * The toolbar is deliberately thin: where to go, whether the citations are
 * showing, which version, which theme, the assistant, and publishing. Every
 * other capability is a consequence of a selected object, and appears as the
 * small rail on that object rather than as another button in the header.
 */

import { Button, Menu, Popover, Tooltip } from "@mantine/core";
import {
  ArrowLeft,
  BookOpen,
  CheckCheck,
  Download,
  Eye,
  FileText,
  GitBranch,
  Layers,
  ListTree,
  MessageSquare,
  MoreHorizontal,
  Palette,
  ScrollText,
  Search,
  Snowflake,
  SquarePen,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { api, type DocumentView } from "../api.js";
import { coverageKey, DocumentCanvas, type CanvasSelection, type DocMode } from "../components/document.js";
import { DockSlot } from "../components/dock.js";
import { boundarySummary, boundariesOf, nameMaps, warningSummary } from "../document-logic.js";
import { useApp } from "../store.js";
import { currentReportOf } from "../store.js";

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-CN", { hour12: false });
}

export function StudioView() {
  const {
    bundle,
    document,
    selection,
    setSelection,
    dock,
    openDock,
    prefillAssistant,
    themeId,
    setThemeId,
    act,
    say,
    refresh,
    busy,
  } = useApp();
  const [mode, setMode] = useState<DocMode>("verify");
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const [frozen, setFrozen] = useState<DocumentView | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const report = currentReportOf(bundle);
  const currentReportId = bundle?.currentReportId ?? null;

  // A frozen revision is read from its own bundle: the working document may
  // move on, and a version that changes under the reader is not a version.
  useEffect(() => {
    if (revisionId === null) {
      setFrozen(null);
      return;
    }
    let cancelled = false;
    void api
      .revisionDocument(revisionId)
      .then((next) => {
        if (!cancelled) setFrozen(next);
      })
      .catch((error: unknown) => {
        if (!cancelled) say("error", error instanceof Error ? error.message : "读取冻结版本失败");
      });
    return () => {
      cancelled = true;
    };
  }, [revisionId, say]);

  // The working draft is refetched when the report changes underneath.
  const shown = revisionId === null ? document : frozen;
  const revisions = bundle?.revisions ?? [];
  const currentRevisions = revisions.filter((revision) => revision.isCurrentReport);
  const latestExport = bundle?.exports.filter((artifact) => artifact.status === "exported").slice(-1)[0] ?? null;

  const sections = useMemo(() => shown?.sections.map((section, index) => ({ ...section, number: index + 1 })) ?? [], [shown]);

  // The dock's selection is shared with other views; the canvas only accepts
  // objects that live on the document itself.
  const documentSelection: CanvasSelection | null =
    selection !== null && (selection.kind === "section" || selection.kind === "claim" || selection.kind === "comparison")
      ? selection
      : null;

  const warnings = warningSummary(shown);

  if (bundle === null) return null;

  // The document's own names, and the research's open questions. A frozen
  // revision is a snapshot of a moment; it gets neither, because its matrix and
  // its names are the ones it was frozen with, not today's.
  const names = nameMaps(bundle);
  const boundaries = revisionId === null ? boundariesOf(bundle) : [];
  // The matrix knows how each subject × dimension stands, which is what a
  // comparison cell the report left empty has to say for itself.
  const coverage = new Map(bundle.matrix.map((cell) => [coverageKey(cell.subjectId, cell.dimensionId), cell.status]));
  const openCount = bundle.matrix.filter(
    (cell) => cell.status === "missing" || cell.status === "unassessed" || cell.status === "limited" || cell.status === "conflict",
  ).length;

  const select = (next: CanvasSelection): void => {
    setSelection(next);
    if (next.kind === "claim") openDock({ kind: "claim", claimId: next.claimId });
  };

  // The selected object's actions live in the toolbar rather than floating over
  // the section: a rail anchored inside the document scrolls out of view exactly
  // when the reader is working on it.
  const selectedLabel =
    selection === null || selection.kind === "cell" || selection.kind === "source" || revisionId !== null
      ? null
      : selection.kind === "claim"
        ? "论断"
        : selection.kind === "comparison"
          ? "比较表"
          : "章节";

  const sectionAction = (action: "inspect" | "research" | "edit" | "more", sectionId: string): void => {
    const title = sections.find((section) => section.id === sectionId)?.title ?? sectionId;
    switch (action) {
      case "inspect":
      case "more":
        openDock({ kind: "section", sectionId });
        break;
      case "research":
        prefillAssistant({
          intent: "research",
          sectionId,
          text: `补查「${title}」这一节需要的材料：只补充证据与支持评估，不要修改正文。`,
        });
        break;
      case "edit":
        prefillAssistant({ intent: "edit", sectionId, text: "" });
        break;
    }
  };

  const selectedSectionId =
    selection !== null && selection.kind !== "cell" && selection.kind !== "source" ? selection.sectionId : null;

  const freeze = async (): Promise<void> => {
    const ok = await act(
      () =>
        api.freeze(bundle.task.id, {
          themeId,
          ...(bundle.currentReportHash === null ? {} : { expectedContentHash: bundle.currentReportHash }),
        }),
      "冻结版本",
    );
    if (ok) say("success", `已冻结当前版本（${themeId === "swiss" ? "Swiss" : "Editorial"} 主题）。`);
  };

  const publish = async (): Promise<void> => {
    const ok = await act(() => api.exportPdf(bundle.task.id), "导出 PDF");
    if (ok) say("success", "已按当前版本导出 PDF：导出前会自动冻结，文件只依赖冻结时的材料。");
  };

  const assistantOpen = dock !== null && dock.kind === "assistant";
  const toggleAssistant = (): void => {
    if (assistantOpen) {
      openDock(null);
      return;
    }
    // Opening it keeps whatever the reader had typed and aims it at whatever
    // they have selected: closing the panel to read must not cost them the
    // sentence they were in the middle of writing.
    prefillAssistant({
      intent: "ask",
      sectionId: selection !== null && selection.kind !== "cell" && selection.kind !== "source" ? selection.sectionId : null,
    });
  };

  return (
    <div className="rp-studio" data-layout={dock === null ? "reading" : "coedit"} data-testid="studio">
      <div className="rp-studio__main">
        <div className="rp-toolbar" data-testid="studio-toolbar">
          <div className="rp-toolbar__group">
            <Popover shadow="md" width={320} position="bottom-start" withinPortal>
              <Popover.Target>
                <Button size="compact-sm" variant="subtle" leftSection={<ListTree size={14} />}>
                  目录
                </Button>
              </Popover.Target>
              <Popover.Dropdown>
                <div className="rp-block__label">章节</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  {sections.map((section) => (
                    <button
                      key={section.id}
                      type="button"
                      className="rp-nav__item"
                      style={{ justifyContent: "flex-start" }}
                      onClick={() => {
                        const target = window.document.querySelector(`[data-section-id="${section.id}"]`);
                        target?.scrollIntoView({ behavior: "smooth", block: "start" });
                        if (revisionId === null) setSelection({ kind: "section", sectionId: section.id });
                      }}
                    >
                      <span className="rp-mono" style={{ fontSize: 11, color: "var(--rp-ink-3)", width: 20 }}>
                        {String(section.number).padStart(2, "0")}
                      </span>
                      {section.title}
                    </button>
                  ))}
                </div>
              </Popover.Dropdown>
            </Popover>

            <div className="rp-seg" role="group" aria-label="阅读模式">
              <button
                type="button"
                aria-pressed={mode === "read"}
                onClick={() => {
                  setMode("read");
                }}
              >
                <BookOpen size={13} />
                阅读
              </button>
              <button
                type="button"
                aria-pressed={mode === "verify"}
                onClick={() => {
                  setMode("verify");
                }}
                data-testid="mode-verify"
              >
                <CheckCheck size={13} />
                核验
              </button>
            </div>
            {openCount > 0 && (
              <button
                type="button"
                className="rp-toolbar__alert"
                onClick={() => {
                  window.document.querySelector("#research-boundaries")?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
                data-testid="open-boundaries"
              >
                <span>{boundarySummary(bundle)}</span>
                <span className="rp-toolbar__long rp-brief-field__count">研究边界</span>
              </button>
            )}
          </div>

          <div className="rp-toolbar__group">
            <Menu shadow="md" width={330} position="bottom-start">
              <Menu.Target>
                <Button
                  size="compact-sm"
                  variant="subtle"
                  leftSection={<GitBranch size={14} />}
                  data-testid="revision-menu"
                >
                  {revisionId === null
                    ? bundle.currentReportFrozen
                      ? (
                          <>
                            工作稿
                            <span className="rp-toolbar__long"> · 已有冻结版本</span>
                          </>
                        )
                      : "工作稿 · Working Draft"
                    : `R${frozen?.revision ?? "?"} · 已冻结`}
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>工作稿</Menu.Label>
                <Menu.Item
                  leftSection={<FileText size={14} />}
                  onClick={() => {
                    setRevisionId(null);
                  }}
                >
                  回到工作稿{revisionId === null ? "（当前）" : ""}
                </Menu.Item>
                <Menu.Item
                  leftSection={<Snowflake size={14} />}
                  disabled={busy || revisionId !== null}
                  onClick={() => {
                    void freeze();
                  }}
                >
                  冻结当前版本
                </Menu.Item>
                <Menu.Divider />
                <Menu.Label>冻结版本（{currentRevisions.length}）</Menu.Label>
                {currentRevisions.length === 0 && <Menu.Item disabled>还没有冻结版本</Menu.Item>}
                {currentRevisions.map((revision) => (
                  <Menu.Item
                    key={revision.revisionId}
                    leftSection={<Layers size={14} />}
                    onClick={() => {
                      setRevisionId(revision.revisionId);
                    }}
                  >
                    R{revision.revision} · {revision.themeId} · {when(revision.createdAt).slice(0, 16)}
                  </Menu.Item>
                ))}
              </Menu.Dropdown>
            </Menu>

            <Menu shadow="md" width={280} position="bottom-start">
              <Menu.Target>
                <Button size="compact-sm" variant="subtle" leftSection={<Palette size={14} />} data-testid="theme-menu">
                  {themeId === "swiss" ? "Swiss" : "Editorial"}
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>文档主题 · 只改变排版</Menu.Label>
                <Menu.Item
                  onClick={() => {
                    setThemeId("editorial");
                  }}
                >
                  Editorial · 期刊排版{themeId === "editorial" ? "（当前）" : ""}
                </Menu.Item>
                <Menu.Item
                  onClick={() => {
                    setThemeId("swiss");
                  }}
                >
                  Swiss · 分析出版{themeId === "swiss" ? "（当前）" : ""}
                </Menu.Item>
                <Menu.Divider />
                <Menu.Label>文字、引用编号与证据编号不随主题变化</Menu.Label>
                <Menu.Item
                  leftSection={<Eye size={14} />}
                  onClick={() => {
                    window.location.hash = `#/p/${bundle.task.id}/gallery`;
                  }}
                >
                  并排比较两种主题
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </div>

          {selectedLabel !== null && selectedSectionId !== null && (
            <div className="rp-toolbar__group rp-toolbar__group--selection" data-testid="object-rail" role="toolbar" aria-label="选中对象的操作">
              <span className="rp-rail__label">{selectedLabel}</span>
              <Tooltip label="查看这一节/这条论断的证据" withArrow={false}>
                <Button
                  size="compact-xs"
                  variant="subtle"
                  leftSection={<Eye size={12} />}
                  onClick={() => {
                    sectionAction("inspect", selectedSectionId);
                  }}
                >
                  检查
                </Button>
              </Tooltip>
              <Tooltip label="让助手针对这里补查材料" withArrow={false}>
                <Button
                  size="compact-xs"
                  variant="subtle"
                  leftSection={<Search size={12} />}
                  onClick={() => {
                    sectionAction("research", selectedSectionId);
                  }}
                >
                  补查
                </Button>
              </Tooltip>
              <Tooltip label="让助手提出修改（接受前正文不变）" withArrow={false}>
                <Button
                  size="compact-xs"
                  variant="subtle"
                  leftSection={<SquarePen size={12} />}
                  onClick={() => {
                    sectionAction("edit", selectedSectionId);
                  }}
                >
                  修改
                </Button>
              </Tooltip>
              <Menu shadow="md" position="bottom-end">
                <Menu.Target>
                  <Button size="compact-xs" variant="subtle" aria-label="更多操作" px={6}>
                    <MoreHorizontal size={13} />
                  </Button>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Item
                    onClick={() => {
                      sectionAction("more", selectedSectionId);
                    }}
                  >
                    打开这一节的证据
                  </Menu.Item>
                  <Menu.Item
                    onClick={() => {
                      const firstClaim = shown?.citations.evidenceIndex[0];
                      if (firstClaim !== undefined) openDock({ kind: "source", sourceId: firstClaim.sourceId });
                    }}
                    disabled={(shown?.citations.evidenceIndex.length ?? 0) === 0}
                  >
                    看第一个引用来源
                  </Menu.Item>
                </Menu.Dropdown>
              </Menu>
            </div>
          )}

          <div className="rp-toolbar__spacer" />

          {bundle.task.reportNeedsReview !== null && (
            <Tooltip label={bundle.task.reportNeedsReview.reason} withArrow={false}>
              <span className="rp-chip rp-chip--limited" data-testid="needs-review">
                1 处待复核 · 正文未变
              </span>
            </Tooltip>
          )}

          <Tooltip label={assistantOpen ? "关闭助手，回到只读文档" : "打开助手工作区，与文档并排"} withArrow={false}>
            <Button
              size="compact-sm"
              variant={assistantOpen ? "light" : "subtle"}
              leftSection={<MessageSquare size={14} />}
              onClick={toggleAssistant}
              data-testid="open-assistant"
            >
              助手
            </Button>
          </Tooltip>

          <Menu shadow="md" width={300} position="bottom-end">
            <Menu.Target>
              <Button
                size="compact-sm"
                leftSection={<Download size={14} />}
                disabled={report === null || revisionId !== null}
                data-testid="publish-menu"
              >
                发布
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>发布当前工作稿</Menu.Label>
              <Menu.Item
                leftSection={<Download size={14} />}
                onClick={() => {
                  void publish();
                }}
              >
                导出一份 PDF（先冻结）
              </Menu.Item>
              <Menu.Item
                leftSection={<Eye size={14} />}
                component="a"
                href={currentReportId === null ? "#" : api.reportHtmlUrl(currentReportId)}
                target="_blank"
                rel="noreferrer"
              >
                打开打印视图
              </Menu.Item>
              {latestExport !== null && (
                <Menu.Item
                  leftSection={<ScrollText size={14} />}
                  component="a"
                  href={api.exportFileUrl(latestExport.exportId)}
                >
                  下载最近导出（{(latestExport.bytes / 1024).toFixed(0)} KB）
                </Menu.Item>
              )}
              {currentRevisions.length > 0 && (
                <>
                  <Menu.Divider />
                  <Menu.Label>按冻结版本导出</Menu.Label>
                  {currentRevisions.slice(-3).map((revision) => (
                    <Menu.Item
                      key={revision.revisionId}
                      onClick={() => {
                        void act(() => api.exportRevision(revision.revisionId), "按版本导出").then((ok) => {
                          if (ok) say("success", `已导出 R${revision.revision} 的 PDF。`);
                        });
                      }}
                    >
                      R{revision.revision} · {revision.evidenceCount} 条证据
                    </Menu.Item>
                  ))}
                </>
              )}
            </Menu.Dropdown>
          </Menu>
        </div>

        <div className="rp-canvas-scroll" ref={scrollRef}>
          <div className="rp-canvas">
            {shown === null ? (
              <div className="rp-canvas__sheet">
                <p className="rp-doc__placeholder">
                  {report === null
                    ? "这份研究还没有报告。回到研究视图，材料够用之后由你决定开始撰写。"
                    : "正在读取报告…"}
                </p>
              </div>
            ) : (
              <>
                {revisionId !== null && (
                  <div className="rp-note rp-note--quiet" style={{ marginBottom: 18, maxWidth: 920 }} data-testid="frozen-banner">
                    <Snowflake size={14} style={{ flex: "none", marginTop: 2 }} />
                    <span style={{ flex: 1 }}>
                      这是冻结于 {when(revisions.find((revision) => revision.revisionId === revisionId)?.createdAt ?? "")} 的 R
                      {shown.revision}：只依赖那时的证据与来源，之后的研究不会改动它。
                    </span>
                    <Button
                      size="compact-xs"
                      variant="default"
                      leftSection={<ArrowLeft size={13} />}
                      onClick={() => {
                        setRevisionId(null);
                      }}
                    >
                      回到工作稿
                    </Button>
                  </div>
                )}
                <div className="rp-canvas__sheet">
                  <DocumentCanvas
                    key={`${shown.reportId}-${shown.themeId ?? themeId}`}
                    document={shown}
                    mode={revisionId === null ? mode : "read"}
                    themeId={shown.themeId ?? themeId}
                    selection={revisionId === null ? documentSelection : null}
                    names={names}
                    boundaries={boundaries}
                    coverage={coverage}
                    checks={
                      warnings === null && openCount === 0 ? undefined : (
                        <>
                          {warnings !== null && (
                            <Tooltip label="这些义务在正文里已如实写出，不阻止发布" withArrow={false}>
                              <span className="rp-chip rp-chip--limited">{warnings.headline}</span>
                            </Tooltip>
                          )}
                          {openCount > 0 && (
                            <button
                              type="button"
                              className="rp-doc__checks__jump"
                              onClick={() => {
                                window.document.querySelector("#research-boundaries")?.scrollIntoView({ behavior: "smooth", block: "start" });
                              }}
                            >
                              {boundarySummary(bundle)} →
                            </button>
                          )}
                        </>
                      )
                    }
                    onSelect={select}
                    onOpenCell={(subjectId, dimensionId) => {
                      setSelection({ kind: "cell", subjectId, dimensionId });
                      openDock({ kind: "cell", subjectId, dimensionId });
                    }}
                    onOpenReference={(sourceId) => {
                      openDock({ kind: "source", sourceId });
                    }}
                    footerNote={
                      <p className="rp-doc__ref__meta" style={{ marginTop: 22 }}>
                        引用编号与证据编号由程序生成，屏幕、打印视图与 PDF 使用同一份编号；本页{revisionId === null ? "是工作稿" : "是冻结版本"}。
                      </p>
                    }
                  />
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      <DockSlot />
    </div>
  );
}
