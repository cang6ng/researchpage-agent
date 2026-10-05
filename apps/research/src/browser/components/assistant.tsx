/**
 * The assistant: a command surface over the project, and a log of what it did.
 *
 * This is not a chat window and must not look like one. The reader chooses a
 * target (a section, or the project) and an intent — Ask reads, Research brings
 * material in, Edit proposes a change — and what comes back is an account of an
 * action: what was searched, what the run found, whether the report moved. Only
 * an Ask answers in prose, because only an Ask *is* a question; the other two
 * produce material or a proposal, and those are shown as they are.
 *
 * A running action says what it is working on, why, and what happens next.
 * There is no percentage, no step counter and no streamed reasoning.
 */

import { Button, Menu, SegmentedControl, Select, Textarea } from "@mantine/core";
import { ChevronRight, ListChecks, MessageSquare, Search, Send, Sparkles, SquarePen } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { api, TOOL_LABELS, type AnswerView, type RunView, type TaskBundle } from "../api.js";
import { currentReportOf, useApp } from "../store.js";
import { navigate, projectHash } from "../router.js";
import { runningSummary } from "../views/research.js";

const INTENTS = [
  { value: "auto", label: "Auto" },
  { value: "ask", label: "Ask" },
  { value: "research", label: "Research" },
  { value: "edit", label: "Edit" },
] as const;

/** What this action will do, said before it is taken. */
const INTENT_HELP: Readonly<Record<string, string>> = Object.freeze({
  auto: "由助手判断：提问、补查还是修改章节。",
  ask: "只读材料回答问题，不写入任何数据。",
  research: "针对缺口检索并读取新来源；报告正文保持不变。",
  edit: "针对目标章节生成修改建议；接受之前正文不变。",
});

function countTools(run: RunView, name: string): number {
  return run.activity.filter((step) => step.name === name && step.ok !== false).length;
}

/** The account of one finished action, in the shape of an action card. */
function ActionCard({
  run,
  answer,
  onInspect,
  onEdit,
}: {
  readonly run: RunView;
  readonly answer: AnswerView | undefined;
  readonly onInspect: (run: RunView) => void;
  readonly onEdit: () => void;
}) {
  const stage = run.stage;
  const title =
    stage === "ask"
      ? "提问完成"
      : stage === "gap" || stage === "research"
        ? run.status === "completed"
          ? "定向补查完成"
          : "补查未完成"
        : stage === "edit"
          ? "修改建议已就绪"
          : run.note;

  const searches = countTools(run, "search_sources");
  const reads = countTools(run, "read_source");
  const assessments = countTools(run, "assess_coverage");

  return (
    <div className="rp-action-card" data-testid={`action-${stage}`}>
      <div className="rp-action-card__head">
        {stage === "ask" ? (
          <MessageSquare size={14} strokeWidth={1.75} />
        ) : stage === "edit" ? (
          <SquarePen size={14} strokeWidth={1.75} />
        ) : (
          <Search size={14} strokeWidth={1.75} />
        )}
        {title}
        {run.status === "failed" && <span className="rp-chip rp-chip--danger">未完成</span>}
      </div>

      {stage === "ask" ? (
        <div style={{ marginTop: 10 }}>
          {answer === undefined || answer.text === null ? (
            <p style={{ fontSize: 13, color: "var(--rp-ink-3)", margin: 0 }}>
              这次回答不在会话历史里（提问本身不写入任何正式数据，回答只存在于会话记录中）。
            </p>
          ) : (
            <>
              {answer.question.length > 0 && (
                <div className="rp-answer__q">{answer.question}</div>
              )}
              <div className="rp-answer">{answer.text}</div>
            </>
          )}
          <div className="rp-action-card__actions">
            <Button size="xs" variant="default" onClick={() => onInspect(run)}>
              看相关材料
            </Button>
          </div>
        </div>
      ) : stage === "edit" ? (
        run.status === "running" ? (
          <>
            <div className="rp-action-card__body">
              <span>正在起草针对目标章节的修改建议…</span>
              <span style={{ color: "var(--rp-ink-3)" }}>提案写好之前，报告正文不会变化。</span>
            </div>
          </>
        ) : (
          <>
            <div className="rp-action-card__body">
              <span>已针对目标章节起草修改建议，等待你接受或放弃。</span>
              <span style={{ color: "var(--rp-ink-3)" }}>接受之前，报告正文没有变化。</span>
            </div>
            <div className="rp-action-card__actions">
              <Button size="xs" onClick={onEdit} data-testid="open-proposal">
                查看修改建议
              </Button>
            </div>
          </>
        )
      ) : (
        <>
          <div className="rp-action-card__body">
            <span>
              本轮：检索 <b className="rp-action-card__num">{searches}</b> 次 · 读取{" "}
              <b className="rp-action-card__num">{reads}</b> 次 · 覆盖评估 <b className="rp-action-card__num">{assessments}</b> 格
            </span>
            <span style={{ color: "var(--rp-ink-3)" }}>报告正文未改变：补查只增加材料与支持评估。</span>
          </div>
          <div className="rp-action-card__actions">
            <Button size="xs" variant="default" onClick={() => onInspect(run)}>
              检查证据
            </Button>
            <Button size="xs" variant="subtle" leftSection={<SquarePen size={13} />} onClick={onEdit}>
              创建修改建议
            </Button>
          </div>
        </>
      )}

      {run.activity.length > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary style={{ fontSize: 12, color: "var(--rp-ink-3)", cursor: "pointer" }}>这次动作做了什么</summary>
          <ul style={{ margin: "8px 0 0", paddingLeft: 16, fontSize: 12.5, color: "var(--rp-ink-2)", lineHeight: 1.7 }}>
            {run.activity.slice(-8).map((step, index) => (
              <li key={`${step.name}-${index}`}>
                {TOOL_LABELS[step.name] ?? step.name}
                {step.ok === false && <span style={{ color: "var(--rp-danger)" }}>（失败）</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export function AssistantPanel({ bundle }: { readonly bundle: TaskBundle }) {
  const { assistant, answers, setSelection, openDock, prefillAssistant, refresh } = useApp();
  const [intent, setIntent] = useState<string>(assistant.intent);
  const [sectionId, setSectionId] = useState<string | null>(assistant.sectionId);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const composer = useRef<HTMLTextAreaElement | null>(null);

  const report = currentReportOf(bundle);
  const sections = report?.sections ?? [];
  const running = runningSummary(bundle);

  // An action taken from the document ("补查这一节") arrives here as a prefill.
  useEffect(() => {
    setIntent(assistant.intent);
    setSectionId(assistant.sectionId);
    if (assistant.text.length > 0) setText(assistant.text);
  }, [assistant.token, assistant.intent, assistant.sectionId, assistant.text]);

  useEffect(() => {
    if (assistant.text.length > 0) composer.current?.focus();
  }, [assistant.token, assistant.text]);

  const targetLabel =
    sectionId === null
      ? "整个项目"
      : sections.find((section) => section.id === sectionId)?.title ?? "整个项目";

  const send = async (): Promise<void> => {
    const value = text.trim();
    if (value.length === 0) return;
    setSending(true);
    setError(null);
    try {
      await api.assistant(bundle.task.id, {
        text: value,
        intent,
        ...(intent === "edit" && sectionId !== null ? { targetSectionId: sectionId } : {}),
      });
      setText("");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "动作没有开始");
    } finally {
      setSending(false);
    }
  };

  const actions = [...bundle.runs]
    .filter((run) => run.stage === "ask" || run.stage === "gap" || run.stage === "research" || run.stage === "edit")
    .slice(-6)
    .reverse();

  const inspect = (): void => {
    const gap = bundle.gaps[0];
    if (gap !== undefined) {
      setSelection({ kind: "cell", subjectId: gap.subjectId, dimensionId: gap.dimensionId });
      openDock({ kind: "cell", subjectId: gap.subjectId, dimensionId: gap.dimensionId });
      return;
    }
    navigate(projectHash(bundle.task.id, "research"));
  };

  /**
   * Opens the proposal this action produced.
   *
   * The answer reads the project again rather than trusting the last poll: a
   * run can finish between two refreshes, and a button that says "view the
   * proposal" has to show the proposal rather than fall back to an empty
   * composer because the page was two seconds behind.
   */
  const openProposal = async (): Promise<void> => {
    const fresh = await api.task(bundle.task.id).catch(() => null);
    const proposals = fresh?.proposals ?? bundle.proposals;
    const pending = proposals.filter((proposal) => proposal.status === "pending").slice(-1)[0];
    if (pending !== undefined) {
      openDock({ kind: "proposal", proposalId: pending.proposalId });
      return;
    }
    const latest = proposals.slice(-1)[0];
    if (latest !== undefined) {
      openDock({ kind: "proposal", proposalId: latest.proposalId });
      return;
    }
    if (report !== null && sections.length > 0) {
      prefillAssistant({ intent: "edit", sectionId: sections[0]?.id ?? null });
    }
  };

  return (
    <>
      <div className="rp-assistant__target">
        <span className="rp-assistant__target-label">目标</span>
        <span style={{ fontSize: 13.5, fontWeight: 500 }}>{targetLabel}</span>
        {intent === "edit" && sections.length > 0 && (
          <Select
            size="xs"
            ml="auto"
            w={150}
            placeholder="选择章节"
            value={sectionId}
            onChange={setSectionId}
            data={sections.map((section) => ({ value: section.id, label: section.title }))}
            data-testid="target-select"
          />
        )}
      </div>

      <div className="rp-dock__body">
        {running !== null && (
          <div className="rp-note rp-note--quiet" style={{ marginBottom: 14 }}>
            <Sparkles size={14} style={{ flex: "none", marginTop: 2 }} />
            <span>
              <b style={{ fontWeight: 550 }}>{running.doing}</b>
              <br />
              {running.why}
              <br />
              <span style={{ color: "var(--rp-ink-3)" }}>下一步：{running.next}</span>
            </span>
          </div>
        )}

        <div className="rp-log">
          {actions.length === 0 && running === null && (
            <p style={{ fontSize: 13, color: "var(--rp-ink-3)", margin: 0, lineHeight: 1.7 }}>
              还没有动作。可以问一个关于材料的问题，也可以让助手补查某个缺口；需要改报告时，选一个章节再说。
            </p>
          )}
          {actions.map((run) => (
            <ActionCard
              key={run.runId ?? `${run.stage}-${run.startedAt}`}
              run={run}
              answer={answers.find((entry) => entry.runId === run.runId)}
              onInspect={inspect}
              onEdit={() => {
                void openProposal();
              }}
            />
          ))}
        </div>
      </div>

      <div className="rp-dock__foot">
        <SegmentedControl
          fullWidth
          size="xs"
          mb="xs"
          value={intent}
          onChange={setIntent}
          data={INTENTS.map((entry) => ({ value: entry.value, label: entry.label }))}
        />
        <p style={{ fontSize: 11.5, color: "var(--rp-ink-3)", margin: "0 0 8px", lineHeight: 1.5 }}>
          {INTENT_HELP[intent]}
        </p>
        <Textarea
          ref={composer}
          size="sm"
          autosize
          minRows={2}
          maxRows={6}
          placeholder={
            intent === "ask"
              ? "问一个关于当前材料的问题"
              : intent === "edit"
                ? "说明这一节要怎么改"
                : "说明要补查什么，或直接提问"
          }
          value={text}
          onChange={(event) => {
            setText(event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void send();
            }
          }}
          data-testid="assistant-input"
        />
        {error !== null && (
          <p style={{ fontSize: 12, color: "var(--rp-danger)", margin: "8px 0 0" }}>{error}</p>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
          <Button
            size="xs"
            leftSection={<Send size={13} />}
            loading={sending}
            disabled={text.trim().length === 0}
            onClick={() => {
              void send();
            }}
            data-testid="assistant-submit"
          >
            {intent === "ask" ? "提问" : intent === "edit" ? "生成修改建议" : intent === "research" ? "开始补查" : "执行"}
          </Button>
          <Menu shadow="md" position="top-start" width={240}>
            <Menu.Target>
              <Button size="xs" variant="subtle" rightSection={<ChevronRight size={13} />}>
                更多动作
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>把回答当起点</Menu.Label>
              <Menu.Item
                leftSection={<Search size={13} />}
                onClick={() => {
                  prefillAssistant({ intent: "research", sectionId, text: "围绕上面这个问题补查来源，只补充材料，不改正文。" });
                }}
              >
                转为定向补查
              </Menu.Item>
              <Menu.Item
                leftSection={<SquarePen size={13} />}
                disabled={sections.length === 0}
                onClick={() => {
                  prefillAssistant({ intent: "edit", sectionId: sectionId ?? sections[0]?.id ?? null, text: "" });
                }}
              >
                针对章节提出修改
              </Menu.Item>
              <Menu.Divider />
              <Menu.Item
                leftSection={<ListChecks size={13} />}
                onClick={() => {
                  navigate(projectHash(bundle.task.id, "research"));
                }}
              >
                打开证据矩阵
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </div>
      </div>
    </>
  );
}
