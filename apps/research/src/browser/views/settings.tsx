/**
 * Settings: small, complete, and honest.
 *
 * Everything here is either a real preference this build reads or a fact about
 * the instance the reader should not have to guess at — which model is running,
 * what the research budget is, whether a PDF can be rendered on this machine.
 * Where a capability does not exist yet, the page says so; it does not offer a
 * control that would do nothing.
 */

import { SegmentedControl } from "@mantine/core";
import { BookText, Cpu, Download, FlaskConical, Plug, Settings2 } from "lucide-react";
import { useState, type ReactNode } from "react";

import { COMPARABILITY_LABELS } from "../api.js";
import { useApp } from "../store.js";

type Section = "general" | "model" | "research" | "sources" | "export";

const SECTIONS: readonly { readonly id: Section; readonly label: string; readonly icon: ReactNode }[] = [
  { id: "general", label: "通用", icon: <Settings2 size={14} strokeWidth={1.75} /> },
  { id: "model", label: "模型", icon: <Cpu size={14} strokeWidth={1.75} /> },
  { id: "research", label: "研究", icon: <FlaskConical size={14} strokeWidth={1.75} /> },
  { id: "sources", label: "来源与集成", icon: <Plug size={14} strokeWidth={1.75} /> },
  { id: "export", label: "导出", icon: <Download size={14} strokeWidth={1.75} /> },
];

function Row({ k, help, children }: { readonly k: string; readonly help?: string; readonly children: ReactNode }) {
  return (
    <div className="rp-set-row">
      <div>
        <div className="rp-set-row__k">{k}</div>
        {help !== undefined && <div className="rp-set-row__help">{help}</div>}
      </div>
      <div className="rp-set-row__v">{children}</div>
    </div>
  );
}

export function SettingsView() {
  const { runtime, themeId, setThemeId, bundle } = useApp();
  const [section, setSection] = useState<Section>("general");

  return (
    <div className="rp-settings">
      <nav className="rp-settings__nav" aria-label="设置分组">
        {SECTIONS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            aria-current={section === entry.id}
            onClick={() => {
              setSection(entry.id);
            }}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 9 }}>
              {entry.icon}
              {entry.label}
            </span>
          </button>
        ))}
      </nav>

      <div>
        {section === "general" && (
          <div className="rp-set-group">
            <h2>通用</h2>
            <p>界面语言与文档主题。文档主题只改变排版：文字、引用编号与证据编号不随主题变化。</p>
            <Row k="界面语言" help="本版本只提供中文界面。">
              简体中文
            </Row>
            <Row k="默认文档主题" help="冻结报告与导出 PDF 会记录这个主题；工作台内切换主题不会改动正文。">
              <SegmentedControl
                value={themeId}
                onChange={setThemeId}
                data={[
                  { value: "editorial", label: "Editorial · 期刊" },
                  { value: "swiss", label: "Swiss · 分析出版" },
                ]}
              />
            </Row>
            <Row k="动效" help="动效遵循系统设置：系统开启「减少动态效果」后，界面动画会自动关闭。">
              跟随系统
            </Row>
          </div>
        )}

        {section === "model" && (
          <div className="rp-set-group">
            <h2>模型</h2>
            <p>模型与凭据由服务端启动时决定，页面既不读取也不显示凭据本身。</p>
            <Row k="运行中的模型">
              {runtime?.model == null ? (
                "未连接到服务端"
              ) : (
                <span className="rp-factline">
                  <span className="rp-mono">{`${runtime.model.provider}/${runtime.model.model}`}</span>
                  <span className="rp-chip rp-chip--quiet">服务端配置</span>
                </span>
              )}
            </Row>
            <Row k="凭据" help="凭据来自服务端环境变量，不会写入数据库、日志或页面。">
              由服务端持有
            </Row>
            <Row k="当前状态">
              <span className="rp-factline">
                <span className={runtime?.busy === true ? "rp-dot rp-dot--busy" : "rp-dot rp-dot--live"} />
                {runtime?.busy === true ? "有研究正在运行" : "空闲"}
              </span>
            </Row>
          </div>
        )}

        {section === "research" && (
          <div className="rp-set-group">
            <h2>研究</h2>
            <p>每个项目的预算在开始时固定，运行期间不会扩大；预算用完时，报告必须如实写出缺口。</p>
            <Row k="检索" help={`每次检索最多返回 ${runtime?.budget.maxCandidatesPerSearch ?? 6} 个候选。`}>
              最多 {runtime?.budget.maxSearches ?? bundle?.budget.maxSearches ?? 6} 次
            </Row>
            <Row k="读取" help="只有真正读取过的来源才会产生可引用证据。">
              最多 {runtime?.budget.maxReads ?? bundle?.budget.maxReads ?? 10} 次
            </Row>
            <Row k="定向补查" help="补查围绕具体缺口进行，不重新做一遍检索。">
              最多 {runtime?.budget.maxGapRounds ?? bundle?.budget.maxGapRounds ?? 2} 轮
            </Row>
            <Row k="单次运行时限">约 {Math.round((runtime?.budget.deadlineMs ?? 8 * 60_000) / 60_000)} 分钟</Row>
            <Row k="矩阵状态的判据" help="状态由证据与支持评估推导，不按数量评分。">
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span>待查 · 有材料待核对 · 有限支持 · 已核对 · 冲突 / 不可比</span>
                <span style={{ color: "var(--rp-ink-3)", fontSize: 12.5 }}>
                  「已核对」表示存在正文级、直接相关的支持评估，不表示结论已被证明为真。可比性用词：
                  {Object.values(COMPARABILITY_LABELS).join(" / ")}。
                </span>
              </div>
            </Row>
          </div>
        )}

        {section === "sources" && (
          <div className="rp-set-group">
            <h2>来源与集成</h2>
            <p>本版本只接入了一个真实来源域；未接入的能力在这里如实标注，不提供假开关。</p>
            <Row k="arXiv" help="检索候选来自 arXiv API；正文读取覆盖 arXiv 的 HTML 全文与摘要页。">
              <span className="rp-factline">
                <span className="rp-chip rp-chip--reviewed">已启用</span>
                <span style={{ fontSize: 12.5, color: "var(--rp-ink-3)" }}>无需配置</span>
              </span>
            </Row>
            <Row k="PDF 文档解析" help="PDF 正文暂不解析；读取范围会如实标注为元数据、摘要或正文节选。">
              <span className="rp-chip rp-chip--quiet">未接入</span>
            </Row>
            <Row k="本地文件上传">
              <span className="rp-chip rp-chip--quiet">未接入</span>
            </Row>
            <Row k="MCP / 外部工具">
              <span className="rp-chip rp-chip--quiet">未接入</span>
            </Row>
            <Row k="数据位置" help="项目数据保存在本机；报告与导出文件也在同一个数据目录下。">
              <span className="rp-mono" style={{ fontSize: 12.5, wordBreak: "break-all" }}>
                {runtime?.dataDir ?? "—"}
              </span>
            </Row>
          </div>
        )}

        {section === "export" && (
          <div className="rp-set-group">
            <h2>导出</h2>
            <p>导出的是冻结版本：文件只依赖冻结时保存的证据与来源，之后的研究不会改动它。</p>
            <Row k="PDF 渲染" help="PDF 由本机 Chrome / Edge 渲染，中文字体依赖系统字体。">
              {runtime?.pdfRenderer == null ? (
                <span className="rp-factline">
                  <span className="rp-chip rp-chip--quiet">未检测到浏览器</span>
                  <span style={{ fontSize: 12.5, color: "var(--rp-ink-3)" }}>导出会失败并给出原因</span>
                </span>
              ) : (
                <span className="rp-factline">
                  <span className="rp-chip rp-chip--reviewed">可导出</span>
                  <span className="rp-mono" style={{ fontSize: 12 }}>
                    {runtime.pdfRenderer}
                  </span>
                </span>
              )}
            </Row>
            <Row k="默认主题">
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <BookText size={14} />
                {themeId === "swiss" ? "Swiss · 分析出版" : "Editorial · 期刊"}
              </span>
            </Row>
            <Row k="主题与 PDF" help="工作台内两套主题都由同一份结构化报告渲染；PDF 目前固定使用 Editorial 版式。">
              <span className="rp-chip rp-chip--limited">PDF 双主题待后续步骤</span>
            </Row>
          </div>
        )}
      </div>
    </div>
  );
}
