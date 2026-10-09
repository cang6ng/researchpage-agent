/**
 * Settings: small, complete, and honest.
 *
 * Everything here is either a real preference this build reads or a fact about
 * the instance the reader should not have to guess at. Two rules hold the page
 * together.
 *
 * A control that does nothing is not offered. The research defaults are saved
 * on the server and are read when a *new* project is created; the retrieval
 * order is saved and read by the next search; and the page says which of those
 * two facts each field is, because a number a reader can edit and the pipeline
 * ignores is a claim about the product that is not true.
 *
 * A capability is described at its real status. "已实现 / 已配置 / 已探测" are
 * different facts, and the third one has a time attached; an integration nobody
 * has probed reads as「尚未检查」rather than as available. The two static
 * sentences this page used to carry —「本地上传未接入」and「PDF 解析未接入」— were
 * true of an earlier build and false of this one, which is why they are gone.
 */

import { Alert, Button, NumberInput, SegmentedControl, Switch } from "@mantine/core";
import { BookText, Cpu, Download, FlaskConical, Plug, RefreshCw, Save, Settings2 } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { api, COMPARABILITY_LABELS, type CapabilityView, type SettingsBundle } from "../api.js";
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

/** How a capability's status is worded, and how it looks. */
const CAPABILITY: Readonly<Record<CapabilityView["status"], { readonly label: string; readonly chip: string }>> = Object.freeze({
  integrated: { label: "已实现并可用", chip: "rp-chip--reviewed" },
  reachable: { label: "已探测可用", chip: "rp-chip--reviewed" },
  unreachable: { label: "服务不可达", chip: "rp-chip--conflict" },
  not_configured: { label: "已实现但未配置", chip: "rp-chip--limited" },
  not_checked: { label: "尚未检查", chip: "rp-chip--quiet" },
  not_implemented: { label: "暂未实现", chip: "rp-chip--quiet" },
});

/** The research defaults, as a form that saves what it shows. */
function ResearchForm({
  settings,
  onSaved,
}: {
  readonly settings: SettingsBundle;
  readonly onSaved: (next: SettingsBundle) => void;
}) {
  const { act, busy } = useApp();
  const [draft, setDraft] = useState(settings.research.value);
  const [dirty, setDirty] = useState(false);
  // A save that lands while the reader is editing must not silently discard
  // what they typed: the server's answer replaces the form only when the form
  // has nothing unsaved.
  useEffect(() => {
    if (!dirty) setDraft(settings.research.value);
  }, [settings.research.value, dirty]);

  const fields = [
    { key: "maxSearches" as const, label: "检索次数", help: "一次研究最多发起多少次检索请求。" },
    { key: "maxCandidatesPerSearch" as const, label: "每次候选数", help: "每次检索最多取回多少个候选来源。" },
    { key: "maxReads" as const, label: "读取次数", help: "最多真实读取多少个来源；只有读过的来源才产生证据。" },
    { key: "maxGapRounds" as const, label: "定向补查轮数", help: "围绕缺口最多补查几轮。" },
    { key: "deadlineMs" as const, label: "研究动作时间预算（分钟）", help: "研究动作的时间上限，不是整份报告的完成时间。" },
  ];

  return (
    <div className="rp-set-group">
      <h2>研究</h2>
      <p>
        这些是<b>新项目默认</b>：项目创建时会把当时的数值冻结下来，此后修改默认值不会改动已有项目。
        失败重试也保留该项目自己的预算。
      </p>
      {settings.research.source === "product-default" && (
        <p style={{ color: "var(--rp-ink-3)", fontSize: 12.5 }}>当前显示的是产品默认值，尚未保存过自定义设置。</p>
      )}
      {fields.map((field) => {
        const limits = settings.research.limits[field.key];
        const value = field.key === "deadlineMs" ? Math.round(draft.deadlineMs / 60_000) : draft[field.key];
        const min = field.key === "deadlineMs" ? Math.round(limits.min / 60_000) : limits.min;
        const max = field.key === "deadlineMs" ? Math.round(limits.max / 60_000) : limits.max;
        return (
          <Row key={field.key} k={field.label} help={`${field.help}（允许 ${String(min)}–${String(max)}）`}>
            <NumberInput
              value={value}
              min={min}
              max={max}
              allowDecimal={false}
              clampBehavior="none"
              style={{ maxWidth: 140 }}
              onChange={(next) => {
                const parsed = typeof next === "number" ? next : Number(next);
                if (!Number.isFinite(parsed)) return;
                setDirty(true);
                setDraft((current) => ({
                  ...current,
                  [field.key]: field.key === "deadlineMs" ? Math.round(parsed) * 60_000 : Math.round(parsed),
                }));
              }}
              data-testid={`setting-${field.key}`}
            />
          </Row>
        );
      })}
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 14 }}>
        <Button
          leftSection={<Save size={15} />}
          disabled={busy || !dirty}
          onClick={() => {
            void act(
              async () => {
                const next = await api.updateSettings({ expectedRevision: settings.revision, research: draft });
                setDirty(false);
                onSaved(next);
              },
              "保存研究预算",
            );
          }}
          data-testid="save-research"
        >
          保存为新项目默认
        </Button>
        {dirty && <span style={{ fontSize: 12.5, color: "var(--rp-ink-3)" }}>有未保存的改动</span>}
      </div>
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
  );
}

/** The retrieval order, as a switch per provider with a floor of one. */
function RetrievalForm({
  settings,
  onSaved,
}: {
  readonly settings: SettingsBundle;
  readonly onSaved: (next: SettingsBundle) => void;
}) {
  const { act, busy } = useApp();
  const [enabled, setEnabled] = useState<readonly string[]>(settings.retrieval.order);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) setEnabled(settings.retrieval.order);
  }, [settings.retrieval.order, dirty]);

  return (
    <div className="rp-set-group">
      <h2>检索来源</h2>
      <p>{settings.retrieval.note}</p>
      {settings.retrieval.providers.map((provider) => {
        const on = enabled.includes(provider.id);
        const last = enabled.length === 1 && on;
        return (
          <Row
            key={provider.id}
            k={provider.name}
            help={provider.id === "arxiv" ? "优先来源；读取时优先抽取 HTML 正文，必要时退回摘要页。" : "备用来源：前一个没有结果或不可用时才使用。"}
          >
            <span className="rp-factline">
              <Switch
                checked={on}
                disabled={last || busy}
                aria-label={provider.name}
                data-testid={`provider-${provider.id}`}
                onChange={(event) => {
                  setDirty(true);
                  setEnabled((current) =>
                    event.currentTarget.checked ? [...current, provider.id] : current.filter((entry) => entry !== provider.id),
                  );
                }}
              />
              <span className={`rp-chip ${last ? "rp-chip--limited" : "rp-chip--reviewed"}`}>{last ? "最后一个，不能关闭" : "已启用"}</span>
            </span>
          </Row>
        );
      })}
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 14 }}>
        <Button
          leftSection={<Save size={15} />}
          disabled={busy || !dirty}
          onClick={() => {
            void act(
              async () => {
                const next = await api.updateSettings({ expectedRevision: settings.revision, providers: enabled });
                setDirty(false);
                onSaved(next);
              },
              "保存检索来源",
            );
          }}
          data-testid="save-providers"
        >
          保存
        </Button>
        {dirty && <span style={{ fontSize: 12.5, color: "var(--rp-ink-3)" }}>有未保存的改动</span>}
      </div>
    </div>
  );
}

/** MinerU's real state, its real limits, and the consent it requires. */
function MineruPanel({ settings }: { readonly settings: SettingsBundle }) {
  const { mineru, mineruChecked, checkMineru, busy } = useApp();
  const limits = settings.mineru.limits;
  return (
    <div className="rp-set-group">
      <h2>文档解析（MinerU）</h2>
      <p>{settings.mineru.thirdParty}</p>
      <Row k="当前模式" help="模式由服务端启动配置决定；Token 只注入转换子进程，不经过页面。">
        <span className="rp-factline">
          <span className={`rp-chip ${settings.mineru.mode === "token" ? "rp-chip--reviewed" : "rp-chip--limited"}`}>
            {settings.mineru.mode === "token" ? "Token 模式" : "Flash 模式"}
          </span>
          {!settings.mineru.tokenEditable && <span style={{ fontSize: 12.5, color: "var(--rp-ink-3)" }}>页面暂不支持修改</span>}
        </span>
      </Row>
      <Row k="在线服务" help="tools/list 成功只说明 MCP 服务器可用，不代表账户 Token 或解析额度已验证。">
        <span className="rp-factline">
          <span className={mineru === null ? "rp-chip rp-chip--quiet" : mineru.ok ? "rp-chip rp-chip--reviewed" : "rp-chip rp-chip--conflict"}>
            {mineru === null ? (mineruChecked ? "不可用" : "尚未检查") : mineru.ok ? "已探测可用" : "服务不可达"}
          </span>
          <Button
            variant="subtle"
            size="compact-xs"
            leftSection={<RefreshCw size={13} />}
            disabled={busy}
            onClick={() => {
              void checkMineru();
            }}
            data-testid="check-mineru"
          >
            检查
          </Button>
        </span>
      </Row>
      <Row k="上传限制" help={`本产品对所有模式强制同一上限：${String(limits.maxUploadMiB)} MiB。配置 Token 不会提高它。`}>
        {limits.maxUploadMiB} MiB · 仅 {limits.formats.join(" / ")}
      </Row>
      <Row k="页数限制" help={`Flash 模式的页数上限为 ${String(limits.flashMaxPages)} 页；Token 模式按服务响应，本产品尚未验证具体上限。`}>
        Flash {limits.flashMaxPages} 页 · Token 未验证
      </Row>
      <Row
        k="OCR"
        help="由 MinerU 服务端自行决定：带文字层的 PDF 走文字提取，纯图像扫描件会走识别。本产品不传 enable_ocr / language，也不提供 OCR 开关，因此不承诺任何扫描件都能识别。"
      >
        <span className="rp-chip rp-chip--limited">服务端自动 · 无开关</span>
      </Row>
      <Row k="文件格式" help="本轮只开放 PDF 与 DOCX 两个入口；MinerU 自身还能处理图片与 Office 表格，但产品没有开放。">
        {limits.formats.join(" / ")}（其它扩展名会被拒绝）
      </Row>
      <Row k="MCP 适配器" help="使用官方 MinerU MCP 服务器，按次启动子进程，不长期驻留。">
        <span className="rp-mono" style={{ fontSize: 12.5, wordBreak: "break-all" }}>
          {settings.mineru.package ?? "未检测到 uvx"}
        </span>
      </Row>
    </div>
  );
}

export function SettingsView() {
  const { runtime, themeId, setThemeId, bundle, act, busy } = useApp();
  const [section, setSection] = useState<Section>("general");
  const [settings, setSettings] = useState<SettingsBundle | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSettings(await api.settings());
      setFailure(null);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "设置读取失败");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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
        {failure !== null && (
          <Alert color="yellow" title="设置没有读到" style={{ marginBottom: 16 }} data-testid="settings-failure">
            {failure}
            <div style={{ marginTop: 8 }}>
              <Button variant="subtle" size="compact-xs" onClick={() => void load()}>
                重新读取
              </Button>
            </div>
          </Alert>
        )}

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
            <p>{settings?.model.note ?? "模型与凭据由服务端启动时决定，页面既不读取也不显示凭据本身。"}</p>
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
            <Row k="网页配置" help="模型配置界面尚未实现：当前版本只能通过服务端启动配置与环境变量切换模型。">
              <span className="rp-chip rp-chip--quiet">暂未实现</span>
            </Row>
            <Row k="当前状态">
              <span className="rp-factline">
                <span className={runtime?.busy === true ? "rp-dot rp-dot--busy" : "rp-dot rp-dot--live"} />
                {runtime?.busy === true ? "有研究正在运行" : "空闲"}
              </span>
            </Row>
          </div>
        )}

        {section === "research" &&
          (settings === null ? (
            <div className="rp-set-group">
              <h2>研究</h2>
              <p>正在读取设置…</p>
            </div>
          ) : (
            <ResearchForm settings={settings} onSaved={setSettings} />
          ))}

        {section === "sources" && (
          <>
            {settings === null ? (
              <div className="rp-set-group">
                <h2>来源与集成</h2>
                <p>正在读取设置…</p>
              </div>
            ) : (
              <>
                <RetrievalForm settings={settings} onSaved={setSettings} />
                <div className="rp-set-group">
                  <h2>能力清单</h2>
                  <p>每一条都写明它现在的真实状态：已实现、已配置、已探测、不可达、尚未检查，或尚未实现。</p>
                  {settings.capabilities.map((capability) => (
                    <Row key={capability.id} k={capability.name} help={capability.detail}>
                      <span className={`rp-chip ${CAPABILITY[capability.status].chip}`}>{CAPABILITY[capability.status].label}</span>
                    </Row>
                  ))}
                  <Row k="数据位置" help="项目数据保存在本机；报告与导出文件也在同一个数据目录下。">
                    <span className="rp-mono" style={{ fontSize: 12.5, wordBreak: "break-all" }}>
                      {runtime?.dataDir ?? "—"}
                    </span>
                  </Row>
                </div>
                <MineruPanel settings={settings} />
              </>
            )}
          </>
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
                  <span className="rp-mono" style={{ fontSize: 12 }}>{runtime.pdfRenderer}</span>
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
            <Row k="当前项目" help="导出针对的是当前打开的项目；没有打开项目时按钮不会出现。">
              {bundle === null ? "未打开项目" : bundle.hasReport ? "可导出当前报告" : "当前项目还没有正式报告"}
            </Row>
          </div>
        )}
      </div>
    </div>
  );
}
