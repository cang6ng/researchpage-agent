/**
 * Sources: what this project read, and what each reading was worth.
 *
 * An editorial table rather than an admin grid: the title carries the row, the
 * facts that decide whether a source can carry a claim — its role, how much of
 * it was actually read, whether the read succeeded, how many passages came out
 * of it — sit beside it in one line each, and the five-colour badge wall an
 * admin table would grow is deliberately absent.
 *
 * Clicking a row opens the same dock the rest of the product uses; there is no
 * second inspector for sources.
 */

import { Button, Menu, Tooltip } from "@mantine/core";
import { ArrowRight, ExternalLink, Filter, Search } from "lucide-react";
import { useMemo, useState } from "react";

import { ROLE_LABELS, SCOPE_LABELS, type SourceView, type TaskBundle } from "../api.js";
import { DockSlot } from "../components/dock.js";
import { useApp } from "../store.js";
import { navigate, projectHash } from "../router.js";

type FilterKey = "all" | "read" | "primary" | "failed" | "unread";

const FILTERS: readonly { readonly key: FilterKey; readonly label: string }[] = [
  { key: "all", label: "全部" },
  { key: "read", label: "已读取" },
  { key: "primary", label: "一手材料" },
  { key: "unread", label: "仅候选" },
  { key: "failed", label: "读取失败" },
];

function matches(source: SourceView, filter: FilterKey): boolean {
  switch (filter) {
    case "all":
      return true;
    case "read":
      return source.readStatus === "ok";
    case "primary":
      return source.role === "primary" || source.role === "official";
    case "unread":
      return source.readStatus === "not_read";
    case "failed":
      return source.readStatus === "failed";
  }
}

function parserState(source: SourceView): { readonly label: string; readonly tone: string } {
  if (source.readStatus === "failed") return { label: "解析失败", tone: "danger" };
  if (source.readStatus === "not_read") return { label: "未解析（仅候选）", tone: "quiet" };
  if (source.readScope === "full_text") return { label: "正文全文", tone: "reviewed" };
  if (source.readScope === "body_excerpt") return { label: "正文节选", tone: "accent" };
  if (source.readScope === "abstract") return { label: "仅摘要", tone: "limited" };
  return { label: "仅元数据", tone: "quiet" };
}

function evidenceCount(bundle: TaskBundle, sourceId: string): { readonly total: number; readonly cited: number } {
  const cited = new Set(
    bundle.reports
      .filter((report) => report.isCurrent)
      .flatMap((report) => report.claims.flatMap((claim) => claim.evidenceIds)),
  );
  const items = bundle.evidence.filter((item) => item.sourceId === sourceId);
  return { total: items.length, cited: items.filter((item) => cited.has(item.evidenceId)).length };
}

export function SourcesView() {
  const { bundle, selection, setSelection, openDock } = useApp();
  const [filter, setFilter] = useState<FilterKey>("all");
  const [query, setQuery] = useState("");

  const sources = bundle?.sources ?? [];
  const shown = useMemo(
    () =>
      sources.filter(
        (source) =>
          matches(source, filter) &&
          (query.trim().length === 0 || source.title.toLowerCase().includes(query.trim().toLowerCase())),
      ),
    [sources, filter, query],
  );

  if (bundle === null) return null;

  const readCount = sources.filter((source) => source.readStatus === "ok").length;
  const primaryCount = sources.filter((source) => source.role === "primary" || source.role === "official").length;

  return (
    <div className="rp-split">
      <div className="rp-split__main">
        <div className="rp-sources">
          <div className="rp-kicker">来源</div>
          <h1 className="rp-title" style={{ fontSize: 22, marginBottom: 8 }}>
            读过什么，以及它算得上什么
          </h1>
          <p className="rp-lede" style={{ fontSize: 13.5 }}>
            共 {sources.length} 个来源，其中 {readCount} 个真正读取过、{primaryCount} 个是原始论文或官方材料。只有读取过的来源才会产生可引用证据；
            角色只用于判断结论能说多硬，不构成可信度评分。
          </p>

          <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "22px 0 10px", flexWrap: "wrap" }}>
            <div className="rp-seg" role="group" aria-label="来源筛选">
              {FILTERS.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  aria-pressed={filter === entry.key}
                  onClick={() => {
                    setFilter(entry.key);
                  }}
                >
                  {entry.label}
                  <span style={{ color: "var(--rp-ink-3)" }}>
                    {sources.filter((source) => matches(source, entry.key)).length}
                  </span>
                </button>
              ))}
            </div>
            <label className="rp-factline" style={{ marginLeft: "auto", gap: 8 }}>
              <Search size={14} style={{ color: "var(--rp-ink-3)" }} />
              <span className="rp-visually-hidden">搜索来源</span>
              <input
                value={query}
                onChange={(event) => {
                  setQuery(event.currentTarget.value);
                }}
                placeholder="按标题搜索"
                style={{
                  border: "1px solid var(--rp-hairline)",
                  background: "var(--rp-surface)",
                  borderRadius: 8,
                  padding: "5px 10px",
                  font: "inherit",
                  fontSize: 13,
                  width: 200,
                  outline: "none",
                }}
              />
            </label>
          </div>

          <table className="rp-stable" data-testid="source-table">
            <thead>
              <tr>
                <th style={{ width: "38%" }}>来源</th>
                <th>角色</th>
                <th>读取范围</th>
                <th>解析状态</th>
                <th style={{ textAlign: "right" }}>证据</th>
                <th style={{ textAlign: "right" }}>被引用</th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ color: "var(--rp-ink-3)", paddingTop: 22 }}>
                    {sources.length === 0 ? "这个项目还没有来源。" : "没有符合当前筛选的来源。"}
                  </td>
                </tr>
              )}
              {shown.map((source) => {
                const counts = evidenceCount(bundle, source.sourceId);
                const parser = parserState(source);
                const selected = selection?.kind === "source" && selection.sourceId === source.sourceId;
                return (
                  <tr
                    key={source.sourceId}
                    data-selected={selected}
                    onClick={() => {
                      setSelection({ kind: "source", sourceId: source.sourceId });
                      openDock({ kind: "source", sourceId: source.sourceId });
                    }}
                    data-testid={`source-row-${source.sourceId}`}
                  >
                    <td>
                      <div className="rp-src__title">{source.title}</div>
                      <div className="rp-src__origin">
                        {source.authors.slice(0, 4).join("、") || "作者未记录"}
                        {source.venue.length > 0 ? ` · ${source.venue}` : ""}
                        {source.publishedAt !== null ? ` · ${source.publishedAt.slice(0, 10)}` : ""}
                      </div>
                      <div className="rp-src__id rp-mono">{source.sourceId}</div>
                    </td>
                    <td>
                      {source.role === null ? (
                        <span style={{ color: "var(--rp-ink-3)" }}>未声明</span>
                      ) : (
                        <span className={`rp-chip rp-chip--${source.role === "primary" || source.role === "official" ? "accent" : "quiet"}`}>
                          {ROLE_LABELS[source.role] ?? source.role}
                        </span>
                      )}
                    </td>
                    <td>{source.readScope === null ? "—" : SCOPE_LABELS[source.readScope] ?? source.readScope}</td>
                    <td>
                      <span className={`rp-chip rp-chip--${parser.tone}`}>{parser.label}</span>
                    </td>
                    <td className="rp-num" style={{ textAlign: "right" }}>
                      {counts.total}
                    </td>
                    <td className="rp-num" style={{ textAlign: "right" }}>
                      {counts.cited > 0 ? counts.cited : <span style={{ color: "var(--rp-ink-3)" }}>—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 18 }}>
            <p className="rp-meta" style={{ margin: 0 }}>
              <Filter size={13} />
              点击任意一行，在右侧查看它的定位、读取说明与从它读到的片段。
            </p>
            <Menu shadow="md" position="bottom-start">
              <Menu.Target>
                <Button size="compact-sm" variant="subtle" rightSection={<ArrowRight size={13} />}>
                  去哪补材料
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item
                  onClick={() => {
                    navigate(projectHash(bundle.task.id, "research"));
                  }}
                >
                  回到研究视图看缺口
                </Menu.Item>
                <Menu.Item
                  onClick={() => {
                    const gap = bundle.gaps[0];
                    if (gap !== undefined) {
                      openDock({ kind: "cell", subjectId: gap.subjectId, dimensionId: gap.dimensionId });
                    }
                  }}
                  disabled={bundle.gaps.length === 0}
                >
                  打开第一个待查项
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
            <Tooltip label="来源由检索发现，读取由模型按问题挑选；两者都记录在案" withArrow={false}>
              <span className="rp-meta" style={{ marginLeft: "auto" }}>
                <ExternalLink size={12} />
                原文链接在来源详情里
              </span>
            </Tooltip>
          </div>
        </div>
      </div>
      <DockSlot />
    </div>
  );
}
