/**
 * Start: a calm place to begin, and the projects already in progress.
 *
 * The first thing on the page is one thing: the research composer. There are no
 * metrics, no feature cards and no evidence summary here — a reader who has not
 * chosen a question yet cannot be helped by statistics about the last one.
 *
 * What the composer does is *start an exploration*, not a project. The topic and
 * any Markdown the reader attaches go to the conversation that decides what the
 * research will be; a PDF or DOCX is offered beside them, unchecked, because
 * converting one sends the reader's file to a service on the network and that
 * is their decision to make before anything moves. Nothing here creates a task
 * card: the direction has to be confirmed first.
 *
 * The library below is rows rather than a card wall, because the useful facts
 * about a research project are a title, where it stands, and when it moved.
 */

import { Alert, Badge, Button, Checkbox, FileInput, Loader } from "@mantine/core";
import { ArrowRight, FileText, FileUp, Plus, Sparkles, Trash2 } from "lucide-react";
import { useState } from "react";

import { useApp } from "../store.js";
import { navigate, intentHash, projectHash } from "../router.js";
import {
  CONVERSION_CONSENT_TEXT,
  MAX_CONVERSION_BYTES,
  MAX_MARKDOWN_BYTES,
  readUtf8Text,
  uploadKindOf,
} from "../upload-logic.js";

const SUGGESTIONS: readonly string[] = [
  "GraphRAG 与向量检索在检索质量与成本上的取舍",
  "LoRA / QLoRA / DoRA 的微调机制与代价",
  "Agent 记忆系统的实现路径比较",
];

interface Staged {
  readonly id: string;
  readonly filename: string;
  readonly bytes: ArrayBuffer;
  readonly kind: "markdown" | "pdf" | "docx";
  readonly problem: string | null;
  consent: boolean;
}

function when(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const minutes = Math.round((Date.now() - date.getTime()) / 60_000);
  if (minutes < 2) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  return days === 1 ? "昨天" : `${days} 天前`;
}

/** What a project has to say for itself in the library, in one line of facts. */
function describe(state: {
  readonly status: string;
  readonly hasReport: boolean;
  readonly subjects: readonly string[];
}): string {
  const subjects = state.subjects.slice(0, 3).join(" · ");
  if (state.hasReport) return subjects.length > 0 ? `报告就绪 · ${subjects}` : "报告就绪";
  if (state.status === "researching") return subjects.length > 0 ? `研究中 · ${subjects}` : "研究中";
  if (state.status === "draft") return "待确认任务卡";
  if (state.status === "failed") return "运行失败，可重开";
  return subjects.length > 0 ? subjects : "材料就绪";
}

function bytes(value: number): string {
  if (value < 1024) return `${String(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function StartView() {
  const { tasks, startIntent, busy, bundle, openTask, openIntent, intentPointer } = useApp();
  const [topic, setTopic] = useState("");
  const [staged, setStaged] = useState<readonly Staged[]>([]);
  const [counter, setCounter] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  const stage = async (files: readonly File[]): Promise<void> => {
    const next: Staged[] = [];
    let index = counter;
    for (const file of files) {
      const content = await file.arrayBuffer();
      const kind = uploadKindOf(file.name);
      let problem: string | null = null;
      if (kind === "unsupported") problem = "只支持 Markdown（.md / .markdown / .txt）与 PDF / DOCX。";
      else if (kind === "markdown" && content.byteLength > MAX_MARKDOWN_BYTES) {
        problem = `超过单文件上限 ${Math.round(MAX_MARKDOWN_BYTES / 1024)} KB，请拆分后再上传。`;
      } else if (kind !== "markdown" && content.byteLength > MAX_CONVERSION_BYTES) {
        problem = `超过转换上限 ${String(Math.round(MAX_CONVERSION_BYTES / 1024 / 1024))} MB，MinerU 无法处理。`;
      } else if (kind === "markdown") {
        const reading = readUtf8Text(content);
        if (!reading.ok) problem = reading.problem;
      }
      index += 1;
      next.push({
        id: `s${String(index)}`,
        filename: file.name,
        bytes: content,
        kind: kind === "unsupported" ? "markdown" : kind,
        problem,
        consent: false,
      });
    }
    setCounter(index);
    setStaged((current) => [...current, ...next]);
  };

  const usable = staged.filter((entry) => entry.problem === null);
  const markdown = usable.filter((entry) => entry.kind === "markdown");
  const conversions = usable.filter((entry) => entry.kind !== "markdown" && entry.consent);
  const blocked = staged.filter((entry) => entry.problem !== null);

  const submit = async (): Promise<void> => {
    const value = topic.trim();
    if (value.length < 2 || submitting || busy) return;
    setSubmitting(true);
    const ok = await startIntent(value, {
      markdown: markdown.map((entry) => ({ filename: entry.filename, bytes: entry.bytes })),
      conversions: conversions.map((entry) => ({
        filename: entry.filename,
        bytes: entry.bytes,
        kind: entry.kind === "pdf" ? ("pdf" as const) : ("docx" as const),
      })),
    });
    setSubmitting(false);
    // Only a receipt clears the draft: a failure has to leave the topic and the
    // files exactly where the reader put them.
    if (ok) {
      setTopic("");
      setStaged([]);
    }
  };

  return (
    <div className="rp-start">
      <div className="rp-start__intro">
        <div className="rp-kicker">研究工具</div>
        <h1 className="rp-title" style={{ fontSize: 30 }}>
          输入一个值得认真对待的问题
        </h1>
        <p className="rp-lede">
          研页先和你把研究方向问清楚，确认之后才建立任务卡、开始检索；每条结论都绑在真实来源上，报告写完并不等于结束——缺口会留在正文里，直到有材料为止。
        </p>
      </div>

      {intentPointer !== null && (
        <div className="rp-note rp-note--quiet" style={{ marginBottom: 14 }} data-testid="continue-intent">
          <span style={{ flex: 1 }}>
            上一次的方向探索还没有结束：「{intentPointer.seedTopic.length > 0 ? intentPointer.seedTopic : "未命名主题"}」
          </span>
          <Button
            size="xs"
            variant="light"
            onClick={() => {
              openIntent(intentPointer.intentId);
              navigate(intentHash(intentPointer.intentId));
            }}
            data-testid="continue-intent-open"
          >
            继续意图探索
          </Button>
        </div>
      )}

      <form
        className="rp-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="rp-visually-hidden" htmlFor="rp-topic">
          研究主题
        </label>
        <textarea
          id="rp-topic"
          className="rp-composer__field"
          value={topic}
          rows={1}
          placeholder="例如：GraphRAG 方法与代表工作在检索质量、构建成本上的取舍"
          onChange={(event) => {
            setTopic(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
          data-testid="topic-input"
        />
        <div className="rp-composer__side">
          <Button
            type="submit"
            size="md"
            rightSection={submitting ? <Loader size={14} color="white" /> : <ArrowRight size={15} />}
            disabled={busy || submitting || topic.trim().length < 2}
            data-testid="topic-submit"
          >
            {submitting ? "正在开始" : "开始澄清方向"}
          </Button>
        </div>
      </form>

      <div className="rp-suggest">
        <Sparkles size={13} strokeWidth={1.75} aria-hidden="true" />
        <span>试试：</span>
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => {
              setTopic(suggestion);
            }}
          >
            {suggestion}
          </button>
        ))}
      </div>

      {/* ---------------------------------------------------------- 附件 -- */}
      <div className="rp-section-head">
        <h2>带上已有材料（可选）</h2>
        <span>Markdown 会随主题一起提交；PDF / DOCX 需要转换</span>
      </div>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <FileInput
          multiple
          clearable
          size="xs"
          leftSection={<FileUp size={14} />}
          placeholder="选择 Markdown / PDF / DOCX"
          accept=".md,.markdown,.txt,.pdf,.docx"
          style={{ minWidth: 300 }}
          onChange={(files) => {
            const list = Array.isArray(files) ? files : files === null ? [] : [files];
            if (list.length === 0) return;
            void stage(list);
          }}
          data-testid="start-file-input"
        />
        <span className="rp-file__fact">
          Markdown 单份 ≤ {Math.round(MAX_MARKDOWN_BYTES / 1024)} KB；PDF / DOCX 单份 ≤{" "}
          {String(Math.round(MAX_CONVERSION_BYTES / 1024 / 1024))} MB
        </span>
      </div>

      {staged.length > 0 && (
        <div className="rp-files" style={{ marginTop: 12 }} data-testid="start-staged">
          {staged.map((entry) => (
            <div className="rp-file" key={entry.id} data-testid={`start-staged-${entry.id}`}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span className="rp-file__title">{entry.filename}</span>
                  <Badge size="xs" variant="light" color="gray">
                    {entry.kind === "markdown" ? "Markdown" : entry.kind.toUpperCase()}
                  </Badge>
                  <span className="rp-file__fact">{bytes(entry.bytes.byteLength)}</span>
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    leftSection={<Trash2 size={11} />}
                    onClick={() => {
                      setStaged((current) => current.filter((candidate) => candidate.id !== entry.id));
                    }}
                    data-testid={`start-staged-remove-${entry.id}`}
                  >
                    移除
                  </Button>
                </div>
                {entry.problem !== null && <p className="rp-file__warn">{entry.problem}</p>}
                {entry.problem === null && entry.kind !== "markdown" && (
                  <Checkbox
                    size="xs"
                    style={{ marginTop: 8 }}
                    checked={entry.consent}
                    onChange={(event) => {
                      const on = event.currentTarget.checked;
                      setStaged((current) =>
                        current.map((candidate) => (candidate.id === entry.id ? { ...candidate, consent: on } : candidate)),
                      );
                    }}
                    label={CONVERSION_CONSENT_TEXT}
                    data-testid={`start-consent-${entry.id}`}
                  />
                )}
              </div>
            </div>
          ))}
          <p className="rp-chat__note">
            提交主题之后才会开始转换：转换需要一段探索作为归属，而探索要到这一刻才存在。没有勾选同意的文件不会被发送。
          </p>
        </div>
      )}

      {blocked.length > 0 && (
        <Alert variant="light" color="yellow" icon={<FileText size={14} />} style={{ marginTop: 12 }} data-testid="start-blocked">
          有 {blocked.length} 份文件不能提交；它们在列表里标明了原因，移除或替换后可以继续。主题不受影响。
        </Alert>
      )}

      {/* -------------------------------------------------------- 项目 -- */}
      <div className="rp-section-head">
        <h2>研究项目</h2>
        <span>{tasks.length === 0 ? "还没有项目" : `共 ${tasks.length} 个`}</span>
      </div>

      <div className="rp-lib">
        {tasks.length === 0 ? (
          <p className="rp-empty">第一个项目会出现在这里；刷新页面后它仍然可以重开。</p>
        ) : (
          tasks.map((task) => (
            <button
              key={task.id}
              type="button"
              className={`rp-lib__row${bundle?.task.id === task.id ? " rp-lib__row--active" : ""}`}
              onClick={() => {
                openTask(task.id);
                navigate(projectHash(task.id, "research"));
              }}
              data-testid={`task-row-${task.id}`}
            >
              <span style={{ minWidth: 0 }}>
                <span className="rp-lib__title">{task.topic}</span>
                <span className="rp-lib__sub">{describe(task)}</span>
              </span>
              <span className="rp-lib__col rp-lib__col--optional">
                {task.hasReport ? "报告就绪" : task.status === "researching" ? "研究中" : task.status === "draft" ? "待确认" : "材料就绪"}
              </span>
              <span className="rp-lib__col rp-lib__col--optional" style={{ color: "var(--rp-ink-3)" }}>
                {task.subjects.slice(0, 2).join(" · ") || "—"}
              </span>
              <span className="rp-lib__when">{when(task.updatedAt)}</span>
            </button>
          ))
        )}
      </div>

      <div className="rp-section-head">
        <h2>它怎么工作</h2>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 28 }}>
        {[
          {
            icon: <FileText size={15} strokeWidth={1.75} />,
            title: "先确认方向，再动手",
            body: "助手会先问清楚对象、范围与读者；你确认的研究方向才会变成任务卡，确认之前不会调用检索或撰写。",
          },
          {
            icon: <Sparkles size={15} strokeWidth={1.75} />,
            title: "每条结论都绑在来源上",
            body: "报告里的每个论断都引用真实读过的片段，附定位与读取范围；材料不足的单元格在正文里明说。",
          },
          {
            icon: <Plus size={15} strokeWidth={1.75} />,
            title: "改写要有你的同意",
            body: "助手可以补查、可以提修改建议；正文只在指定章节被接受之后才变，冻结的版本永不改动。",
          },
        ].map((item) => (
          <div key={item.title}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--rp-brand)", marginBottom: 8 }}>
              {item.icon}
              <span style={{ fontSize: 13.5, fontWeight: 550, color: "var(--rp-ink)" }}>{item.title}</span>
            </div>
            <p style={{ fontSize: 13, color: "var(--rp-ink-2)", margin: 0, lineHeight: 1.65 }}>{item.body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
