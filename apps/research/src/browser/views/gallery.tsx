/**
 * Template gallery: two ways to print the same research.
 *
 * There is one blueprint in this build — the technical comparison — so the
 * gallery does not pretend to offer a second one. What it offers is the choice
 * a reader actually has: whether the document prints as a journal or as an
 * analytical publication.
 *
 * Both previews are the same real report: the same words, the same citation
 * numbers, the same evidence. Switching themes re-renders that content; it does
 * not re-decide any of it, and the page says so rather than leaving it to be
 * guessed.
 */

import { Button, Tooltip } from "@mantine/core";
import { Check, Info, Type } from "lucide-react";
import { useMemo } from "react";

import { currentReportOf, useApp } from "../store.js";
import { DocumentBlocks } from "../components/document.js";
import { api } from "../api.js";
import { navigate, projectHash } from "../router.js";
import { useEffect, useState } from "react";
import type { DocumentView } from "../api.js";

const THEMES: readonly {
  readonly id: string;
  readonly name: string;
  readonly claim: string;
  readonly description: string;
}[] = [
  {
    id: "editorial",
    name: "Editorial",
    claim: "研究期刊",
    description: "衬线标题与正文、更宽的行距、细分隔线、几乎不用框线；像一篇被编辑过的研究札记。",
  },
  {
    id: "swiss",
    name: "Swiss",
    claim: "分析出版",
    description: "无衬线、带编号的章节层级、可见的网格与紧致的比较表；适合把结论摊开来对着看。",
  },
];

export function GalleryView() {
  const { bundle, document, themeId, setThemeId, say, act } = useApp();
  const report = currentReportOf(bundle);
  const [preview, setPreview] = useState<DocumentView | null>(document);

  useEffect(() => {
    if (document !== null) {
      setPreview(document);
      return;
    }
    if (bundle === null || bundle.currentReportId === null) return;
    let cancelled = false;
    void api
      .document(bundle.currentReportId)
      .then((next) => {
        if (!cancelled) setPreview(next);
      })
      .catch(() => {
        if (!cancelled) setPreview(null);
      });
    return () => {
      cancelled = true;
    };
  }, [bundle, document]);

  const referenceCount = preview?.citations.references.length ?? 0;
  const claimCount = preview?.claims.length ?? 0;
  const sectionTitles = useMemo(() => preview?.sections.map((section) => section.title).join(" · ") ?? "", [preview]);

  if (bundle === null) return null;

  return (
    <div className="rp-gallery">
      <div className="rp-kicker">文档样式</div>
      <h1 className="rp-title" style={{ fontSize: 22, marginBottom: 8 }}>
        同一份报告，两种排版
      </h1>
      <p className="rp-lede" style={{ fontSize: 13.5 }}>
        这份构建只有一个 blueprint——技术比较；下面选择的不是内容结构，而是文档如何印刷。两版预览用的是同一份真实报告：
        {claimCount} 条论断、{referenceCount} 个引用来源、章节顺序完全相同。
      </p>

      <div className="rp-unchanged">
        <Info size={14} />
        切换样式只改变排版：文字、引用编号与证据编号都不会变化；PDF 样式随后续步骤接入，本页记录你选择的样式。
      </div>

      <div className="rp-themes">
        {THEMES.map((theme) => {
          const selected = themeId === theme.id;
          return (
            <button
              key={theme.id}
              type="button"
              className="rp-theme"
              aria-pressed={selected}
              onClick={() => {
                setThemeId(theme.id);
              }}
              data-testid={`theme-${theme.id}`}
            >
              <div className="rp-theme__frame">
                <div className="rp-theme__scale">
                  <div className="rp-theme__scale-inner">
                    {preview === null ? (
                      <p className="rp-doc__placeholder" style={{ padding: 40 }}>
                        还没有报告可以预览；先完成一次研究。
                      </p>
                    ) : (
                      <div className="rp-doc" data-theme={theme.id} data-mode="read" style={{ width: 1180, padding: "24px 48px" }}>
                        <header className="rp-doc__head">
                          <div className="rp-doc__kicker">{theme.name} · 预览</div>
                          <h1 className="rp-doc__title">{preview.title}</h1>
                        </header>
                        {preview.sections.slice(0, 3).map((section, index) => (
                          <section className="rp-doc__section" key={section.id}>
                            <h2 className="rp-doc__h2">
                              <span className="rp-doc__num">{String(index + 1).padStart(2, "0")}</span>
                              {section.title}
                            </h2>
                            <DocumentBlocks
                              blocks={section.blocks.slice(0, 4)}
                              claims={preview.claims}
                              document={preview}
                              compact
                            />
                          </section>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div className="rp-theme__fade" />
              </div>
              <div className="rp-theme__meta">
                <div>
                  <div className="rp-theme__name">
                    {theme.name} · {theme.claim}
                  </div>
                  <div className="rp-theme__desc">{theme.description}</div>
                </div>
                <div className="rp-theme__pick">
                  {selected ? (
                    <span className="rp-chip rp-chip--accent">
                      <Check size={12} />
                      当前样式
                    </span>
                  ) : (
                    <Button size="compact-xs" variant="default">
                      用这套排版
                    </Button>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      <div className="rp-section-head">
        <h2>内容未变</h2>
        <span>样式只影响排版</span>
      </div>
      <dl className="rp-kv" style={{ maxWidth: 720 }}>
        <dt>章节</dt>
        <dd>{sectionTitles.length > 0 ? sectionTitles : "—"}</dd>
        <dt>论断与引用</dt>
        <dd>
          {claimCount} 条论断 · {referenceCount} 个引用来源 · {preview?.citations.evidenceIndex.length ?? 0} 条证据编号
        </dd>
        <dt>报告版本</dt>
        <dd>{report === null ? "—" : bundle.currentReportFrozen ? "已有冻结版本" : "工作稿"}</dd>
      </dl>

      <div style={{ display: "flex", gap: 10, marginTop: 22, flexWrap: "wrap" }}>
        <Button
          variant="default"
          leftSection={<Type size={14} />}
          onClick={() => {
            navigate(projectHash(bundle.task.id, "report"));
          }}
        >
          回到报告工作台
        </Button>
        <Tooltip label="冻结时会把当前样式记录在版本里；PDF 版本随后续步骤接入" withArrow={false}>
          <span>
            <Button
              disabled={bundle.currentReportId === null}
              onClick={() => {
                void act(
                  () =>
                    api.freeze(bundle.task.id, {
                      themeId,
                      ...(bundle.currentReportHash === null ? {} : { expectedContentHash: bundle.currentReportHash }),
                    }),
                  "冻结版本",
                ).then((ok) => {
                  if (ok) say("success", `已按 ${themeId === "swiss" ? "Swiss" : "Editorial"} 样式冻结当前版本。`);
                });
              }}
            >
              以这套样式冻结当前版本
            </Button>
          </span>
        </Tooltip>
      </div>
    </div>
  );
}
