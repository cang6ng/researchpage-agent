/**
 * Start: a calm place to begin, and the projects already in progress.
 *
 * The first thing on the page is one thing: the research composer. There are no
 * metrics, no feature cards and no evidence summary here — a reader who has not
 * chosen a question yet cannot be helped by statistics about the last one.
 *
 * The library below is rows rather than a card wall, because the useful facts
 * about a research project are a title, where it stands, and when it moved.
 */

import { ArrowRight, FileText, Plus, Sparkles } from "lucide-react";
import { useState } from "react";

import { useApp } from "../store.js";
import { navigate, projectHash } from "../router.js";
import { Button, Loader } from "@mantine/core";

const SUGGESTIONS: readonly string[] = [
  "GraphRAG 与向量检索在检索质量与成本上的取舍",
  "LoRA / QLoRA / DoRA 的微调机制与代价",
  "Agent 记忆系统的实现路径比较",
];

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

export function StartView() {
  const { tasks, pendingSessionId, startTopic, busy, bundle, openTask } = useApp();
  const [topic, setTopic] = useState("");

  const submit = (): void => {
    const value = topic.trim();
    if (value.length < 2) return;
    setTopic("");
    void startTopic(value);
  };

  return (
    <div className="rp-start">
      <div className="rp-start__intro">
        <div className="rp-kicker">研究工具</div>
        <h1 className="rp-title" style={{ fontSize: 30 }}>
          输入一个值得认真对待的问题
        </h1>
        <p className="rp-lede">
          研页先确定比较对象与研究维度，再检索、读取，把每条结论绑在真实来源上；报告写完并不等于结束——缺口会留在正文里，直到有材料为止。
        </p>
      </div>

      <form
        className="rp-composer"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
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
              submit();
            }
          }}
          data-testid="topic-input"
        />
        <div className="rp-composer__side">
          <Button
            type="submit"
            size="md"
            rightSection={pendingSessionId === null ? <ArrowRight size={15} /> : <Loader size={14} color="white" />}
            disabled={busy || topic.trim().length < 2}
            data-testid="topic-submit"
          >
            {pendingSessionId === null ? "开始研究" : "建立任务卡中"}
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
            title: "先有结构，再有材料",
            body: "任务卡确定比较对象与研究维度，检索与矩阵都围绕它展开，而不是先搜一堆再想办法。",
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
