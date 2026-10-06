/**
 * The assistant: a command surface over the project, and a log of what it did.
 *
 * This is not a chat window and must not look like one. The reader chooses what
 * the instruction is about — the project, a section, a sentence — and what it
 * is for (ask, bring material in, propose a change), and the answer comes back
 * as either prose or an account of an action: what was searched, what the run
 * found, whether the report moved.
 *
 * The workspace is wide because an answer is text a reader has to read. What is
 * never wide is the claim about what a submit will do: the target, the mode and
 * the verb are on one line above the box, and an Edit says before it runs that
 * the document will not move until the proposal is accepted.
 */

import { Button, Menu, Select, Textarea } from "@mantine/core";
import { ChevronRight, ListChecks, MessageSquare, Search, Send, Sparkles, SquarePen, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { api, type AnswerView, type RunView, type TaskBundle } from "../api.js";
import { currentReportOf, useApp, type AssistantIntent, type Selection } from "../store.js";
import { navigate, projectHash } from "../router.js";
import { runningSummary } from "../views/research.js";
import { RichMarkdown } from "./markdown.js";

const INTENTS: readonly { readonly value: AssistantIntent; readonly label: string }[] = [
  { value: "auto", label: "自动" },
  { value: "ask", label: "提问" },
  { value: "research", label: "补查" },
  { value: "edit", label: "修改" },
];

/** What this mode does, in one line, and what its button says. */
const INTENT_TEXT: Readonly<Record<AssistantIntent, { readonly help: string; readonly submit: string }>> = Object.freeze({
  auto: { help: "由助手判断这条指令是提问、补查还是修改。", submit: "执行" },
  ask: { help: "只读现有材料回答问题，不写入任何数据。", submit: "提问" },
  research: { help: "针对缺口检索并读取新来源；报告正文保持不变。", submit: "补查材料" },
  edit: { help: "针对目标章节生成修改建议；接受之前正文不变。", submit: "生成修改建议" },
});

/**
 * Why a proposal was refused, in the tool's own words.
 *
 * The refusal arrives as the tool's answer — a sentence the model was meant to
 * read and act on. A reader who asked for a change and did not get one deserves
 * the same sentence, not a shrug.
 */
function refusalOf(detail: string): string {
  const match = /\{"ok":false,"problems":\[(.*?)\]/.exec(detail);
  if (match === null) return detail.length > 0 ? detail.slice(0, 160) : "这次动作没有产生提案。";
  return match[1]
    .split(",")
    .map((part) => part.trim().replace(/^"|"$/g, ""))
    .filter((part) => part.length > 0)
    .join("；");
}

function countTools(run: RunView, name: string): number {
  return run.activity.filter((step) => step.name === name && step.ok !== false).length;
}

/**
 * What an instruction will act on.
 *
 * The selection is the target when there is one, because selecting something in
 * the document is how a reader points at it; the composer's own choice is the
 * fallback, so an instruction with nothing selected still has a subject and the
 * page can always say which one.
 */
function targetOf(
  bundle: TaskBundle,
  selection: Selection,
  chosenSectionId: string | null,
): { readonly label: string; readonly kicker: string; readonly sectionId: string | null } {
  const sections = currentReportOf(bundle)?.sections ?? [];
  const titleOf = (sectionId: string): string => sections.find((section) => section.id === sectionId)?.title ?? "选中的章节";
  if (selection !== null && selection.kind === "section") {
    return { kicker: "章节", label: titleOf(selection.sectionId), sectionId: selection.sectionId };
  }
  if (selection !== null && selection.kind === "claim") {
    const claim = bundle.reports.find((report) => report.isCurrent)?.claims.find((entry) => entry.id === selection.claimId);
    return {
      kicker: "论断",
      label: claim === undefined ? titleOf(selection.sectionId) : `${claim.text.slice(0, 44)}${claim.text.length > 44 ? "…" : ""}`,
      sectionId: selection.sectionId,
    };
  }
  if (selection !== null && selection.kind === "comparison") {
    return { kicker: "比较表", label: titleOf(selection.sectionId), sectionId: selection.sectionId };
  }
  if (selection !== null && selection.kind === "cell") {
    const cell = bundle.matrix.find((entry) => entry.subjectId === selection.subjectId && entry.dimensionId === selection.dimensionId);
    return {
      kicker: "比较项",
      label: cell === undefined ? "选中的比较项" : `${cell.subjectName} × ${cell.dimensionName}`,
      sectionId: null,
    };
  }
  if (chosenSectionId !== null) return { kicker: "章节", label: titleOf(chosenSectionId), sectionId: chosenSectionId };
  return { kicker: "项目", label: bundle.task.topic, sectionId: null };
}

/** One finished action, as an account of what happened rather than a message. */
function ActionCard({
  run,
  answer,
  onInspect,
  onEdit,
  onOpenAssistant,
}: {
  readonly run: RunView;
  readonly answer: AnswerView | undefined;
  readonly onInspect: (run: RunView) => void;
  readonly onEdit: () => void;
  readonly onOpenAssistant: () => void;
}) {
  const stage = run.stage;
  /** What this run did with the proposal tool, read from the run's own record. */
  const proposalCall = run.activity.filter((step) => step.name === "propose_section_edit").slice(-1)[0];
  // `ok` is null while the call is still in flight: a proposal is not drafted
  // until the tool has actually answered.
  const drafted = proposalCall !== undefined && proposalCall.ok === true;
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
        <div className="rp-answerblock">
          {answer === undefined || answer.text === null ? (
            <p className="rp-muted">
              这次回答不在会话历史里（提问本身不写入任何正式数据，回答只存在于会话记录中）。
            </p>
          ) : (
            <>
              {answer.question.length > 0 && <div className="rp-answer__q">{answer.question}</div>}
              <RichMarkdown text={answer.text} />
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
          <div className="rp-action-card__body">
            <span>正在起草针对目标章节的修改建议…</span>
            <span className="rp-muted">提案写好之前，报告正文不会变化。</span>
          </div>
        ) : drafted ? (
          <>
            <div className="rp-action-card__body">
              <span>已针对目标章节起草修改建议，等待你接受或放弃。</span>
              <span className="rp-muted">接受之前，报告正文没有变化。</span>
            </div>
            <div className="rp-action-card__actions">
              <Button size="xs" onClick={onEdit} data-testid="open-proposal">
                查看修改建议
              </Button>
            </div>
          </>
        ) : (
          // A run can end without a proposal — the instruction may have been
          // answered instead of acted on. Saying "a proposal is ready" then
          // would be the page inventing a change nobody made.
          <>
            <div className="rp-action-card__body">
              <span>这次没有产生修改建议，报告正文没有变化。</span>
              <span className="rp-muted">
                {proposalCall !== undefined
                  ? refusalOf(proposalCall.detail)
                  : "模型这一次没有起草提案；可以改一下说法再试。"}
              </span>
            </div>
            <div className="rp-action-card__actions">
              <Button
                size="xs"
                variant="default"
                onClick={() => {
                  onOpenAssistant();
                }}
              >
                改写指令再试
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
            <span className="rp-muted">报告正文未改变：补查只增加材料与支持评估。</span>
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
        <details className="rp-action-card__log">
          <summary>这次动作做了什么</summary>
          <ul>
            {run.activity.slice(-8).map((step, index) => (
              <li key={`${step.name}-${String(index)}`}>
                {step.detail.length > 0 ? step.detail : step.name}
                {step.ok === false && <span className="rp-danger">（失败）</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export function AssistantPanel({ bundle }: { readonly bundle: TaskBundle }) {
  const { assistant, answers, selection, setSelection, openDock, prefillAssistant, updateAssistant, refresh, busy, say } =
    useApp();
  const composer = useRef<HTMLTextAreaElement | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const report = currentReportOf(bundle);
  const sections = report?.sections ?? [];
  const running = runningSummary(bundle);

  const target = targetOf(bundle, selection, assistant.sectionId);
  const intent = assistant.intent;
  const text = assistant.text;

  // An action taken from the document arrives as a prefill and wants the cursor.
  useEffect(() => {
    if (assistant.token > 0 && assistant.text.length > 0) composer.current?.focus();
  }, [assistant.token, assistant.text]);

  const send = async (): Promise<void> => {
    const value = text.trim();
    if (value.length === 0) return;
    setSending(true);
    setError(null);
    try {
      await api.assistant(bundle.task.id, {
        text: value,
        intent,
        ...(intent === "edit" && target.sectionId !== null ? { targetSectionId: target.sectionId } : {}),
      });
      updateAssistant({ text: "" });
      await refresh();
    } catch (caught) {
      // The instruction stays in the box: a refusal must not cost the reader
      // the sentence they just wrote.
      setError(caught instanceof Error ? caught.message : "指令没有开始");
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
   * The answer reads the project again rather than trusting the last poll: a run
   * can finish between two refreshes, and a button that says "view the proposal"
   * has to show the proposal rather than fall back to an empty composer because
   * the page was two seconds behind.
   */
  const openProposal = async (): Promise<void> => {
    const fresh = await api.task(bundle.task.id).catch(() => null);
    const proposals = fresh?.proposals ?? bundle.proposals;
    const pending = proposals.filter((proposal) => proposal.status === "pending").slice(-1)[0];
    if (pending !== undefined) {
      openDock({ kind: "proposal", proposalId: pending.proposalId });
      return;
    }
    // A settled proposal is still worth reading — it is the record of what was
    // proposed and what was decided. Only when there is none at all is there
    // nothing to open, and then the composer is where the reader goes next.
    const latest = proposals.slice(-1)[0];
    if (latest !== undefined) {
      openDock({ kind: "proposal", proposalId: latest.proposalId });
      return;
    }
    updateAssistant({ intent: "edit" });
    say("info", "这次动作没有产生修改建议，正文没有变化；可以改一下说法再试。");
  };

  // An Edit with nothing chosen is a request that cannot be aimed: the
  // composer says so before it is submitted rather than after it is refused.
  const needsSection = intent === "edit" && target.sectionId === null;
  const help = needsSection
    ? { help: "先选择要修改的章节：在报告里点一个标题，或用右边的下拉框选。", submit: INTENT_TEXT.edit.submit }
    : INTENT_TEXT[intent];

  return (
    <div className="rp-assistant">
      <div className="rp-assistant__bar">
        <span className={`rp-assistant__kicker rp-assistant__kicker--${target.kicker === "项目" ? "project" : "object"}`}>
          {target.kicker}
        </span>
        <span className="rp-assistant__target" title={target.label} data-testid="assistant-target">
          {target.label}
        </span>
        {selection !== null && (
          <button
            type="button"
            className="rp-assistant__clear"
            aria-label="改为作用于整个项目"
            onClick={() => {
              setSelection(null);
              updateAssistant({ sectionId: null });
            }}
          >
            <X size={12} />
          </button>
        )}
        {intent === "edit" && sections.length > 0 && (
          <Select
            size="xs"
            w={168}
            ml="auto"
            placeholder="选择章节"
            value={target.sectionId}
            onChange={(value) => {
              updateAssistant({ sectionId: value });
              setSelection(null);
            }}
            data={sections.map((section) => ({ value: section.id, label: section.title }))}
            data-testid="target-select"
          />
        )}
      </div>

      <div className="rp-assistant__body">
        {running !== null && (
          <div className="rp-note rp-note--quiet rp-assistant__running">
            <Sparkles size={14} style={{ flex: "none", marginTop: 2 }} />
            <span>
              <b>{running.doing}</b>
              {running.why.length > 0 && (
                <>
                  <br />
                  {running.why}
                </>
              )}
              <br />
              <span className="rp-muted">下一步：{running.next}</span>
            </span>
          </div>
        )}

        <div className="rp-log">
          {actions.length === 0 && running === null && (
            <p className="rp-muted rp-assistant__empty">
              还没有动作。可以问一个关于材料的问题，也可以让助手补查某个缺口；需要改报告时，先在报告里选一个章节或一句话。
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
              onOpenAssistant={() => {
                updateAssistant({ intent: "edit" });
              }}
            />
          ))}
        </div>
      </div>

      <div className="rp-assistant__composer" data-testid="assistant-composer">
        {intent === "edit" && (
          <div className="rp-preview" data-testid="action-preview">
            <div className="rp-preview__row">
              <span className="rp-preview__k">将修改</span>
              <span className={`rp-preview__v${needsSection ? " rp-preview__v--missing" : ""}`}>
                {needsSection ? "还没有选择章节" : target.label}
              </span>
            </div>
            <div className="rp-preview__row">
              <span className="rp-preview__k">可能</span>
              <span className="rp-preview__v">补查相关证据后再起草</span>
            </div>
            <div className="rp-preview__row">
              <span className="rp-preview__k">正文</span>
              <span className="rp-preview__v">接受提案之前不会变化</span>
            </div>
          </div>
        )}

        <div className="rp-assistant__modes" role="group" aria-label="指令方式" data-testid="assistant-intent">
          {INTENTS.map((entry) => (
            <button
              key={entry.value}
              type="button"
              aria-pressed={intent === entry.value}
              onClick={() => {
                updateAssistant({ intent: entry.value });
              }}
            >
              {entry.label}
            </button>
          ))}
        </div>

        <Textarea
          ref={composer}
          size="sm"
          autosize
          minRows={2}
          maxRows={8}
          placeholder={
            intent === "ask"
              ? `问一个关于${target.kicker === "项目" ? "当前材料" : `「${target.label}」`}的问题`
              : intent === "edit"
                ? "说明这一处要怎么改"
                : intent === "research"
                  ? "说明要补查什么"
                  : "写一条指令，或直接提问"
          }
          value={text}
          onChange={(event) => {
            updateAssistant({ text: event.currentTarget.value });
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
          <p className="rp-assistant__error" role="alert" data-testid="assistant-error">
            {error}
          </p>
        )}

        <div className="rp-assistant__submit">
          <Button
            size="sm"
            leftSection={<Send size={14} />}
            loading={sending}
            disabled={text.trim().length === 0 || busy || needsSection}
            onClick={() => {
              void send();
            }}
            data-testid="assistant-submit"
          >
            {help.submit}
          </Button>
          <span className="rp-assistant__help">{help.help}</span>
          <Menu shadow="md" position="top-end" width={260}>
            <Menu.Target>
              <Button size="sm" variant="subtle" rightSection={<ChevronRight size={13} />} aria-label="更多动作" px="sm">
                更多
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>把这条指令换个用法</Menu.Label>
              <Menu.Item
                leftSection={<Search size={13} />}
                onClick={() => {
                  updateAssistant({ intent: "research" });
                }}
              >
                转为补查材料
              </Menu.Item>
              <Menu.Item
                leftSection={<SquarePen size={13} />}
                disabled={sections.length === 0}
                onClick={() => {
                  updateAssistant({ intent: "edit", sectionId: target.sectionId ?? sections[0]?.id ?? null });
                }}
              >
                转为生成修改建议
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
    </div>
  );
}
