/**
 * The assistant: a workspace beside the document, not a panel attached to it.
 *
 * The right column is half the screen when it is open, and what it holds is the
 * collaboration itself — what the reader asked for, what came back, and the
 * actions that follow from it. Each turn is the reader's own sentence and the
 * assistant's own answer; a research action reports what it brought in and what
 * it left alone; an edit puts its proposal in the conversation rather than
 * replacing it. The technical log is a folded line at the bottom of a turn, and
 * it says what each step did in Chinese instead of printing a tool name or a
 * result payload.
 *
 * What the reader will spend is stated before they spend it: the mode line says
 * whether this instruction may search, this one says what a Research action's
 * own allowance is, and an allowance that ran out is said in the assistant's
 * own message rather than left for the reader to infer from a disabled button.
 */

import { Button, Menu, Select, Textarea, Tooltip } from "@mantine/core";
import { Check, ChevronRight, ListChecks, MessageSquare, Search, Send, Sparkles, SquarePen, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { api, type ActionBudgetView, type ProposalView, type TaskBundle } from "../api.js";
import {
  budgetExhausted,
  conversationOf,
  proposalFor,
  type Interaction,
} from "../conversation-logic.js";
import { deltaLine, interactionIdOf, researchOutcomeOf } from "../outcome.js";
import { currentReportOf, useApp, type AssistantIntent, type Selection } from "../store.js";
import { navigate, projectHash } from "../router.js";
import { runningSummary } from "../views/research.js";
import { RichMarkdown } from "./markdown.js";
import { ProposalPanel } from "./proposal.js";

const INTENTS: readonly { readonly value: AssistantIntent; readonly label: string }[] = [
  { value: "auto", label: "自动" },
  { value: "ask", label: "提问" },
  { value: "research", label: "补查" },
  { value: "edit", label: "修改" },
];

/** What this mode does, in one line, and what its button says. */
const INTENT_TEXT: Readonly<Record<AssistantIntent, { readonly help: string; readonly submit: string }>> = Object.freeze({
  auto: { help: "由助手判断这条指令是提问、补查还是修改。", submit: "执行" },
  ask: { help: "回答只使用这个项目已有的材料。", submit: "提问" },
  research: { help: "针对缺口检索并读取新来源。", submit: "补查材料" },
  edit: { help: "针对目标章节起草一份修改建议。", submit: "生成修改建议" },
});

/** What a submit writes — the one line the reader needs near the box (§27). */
const SCOPE_LINE: Readonly<Record<AssistantIntent, string>> = Object.freeze({
  auto: "写入之前会先说明这次动作会做什么。",
  ask: "只回答问题，不写入项目数据。",
  research: "补充材料，不自动修改报告。",
  edit: "生成修改建议，接受前正文不变。",
});

const PLACEHOLDERS: Readonly<Record<AssistantIntent, string>> = Object.freeze({
  auto: "写一条指令，或直接提问",
  ask: "问一个关于当前报告的问题",
  research: "告诉我还需要补查什么材料",
  edit: "告诉我希望怎样修改当前内容",
});

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

/** One turn the reader spoke. */
function UserTurn({ text }: { readonly text: string }) {
  return (
    <div className="rp-chat__turn rp-chat__turn--user" data-testid="assistant-msg-user">
      <div className="rp-chat__who">你</div>
      <div className="rp-chat__body">
        <p className="rp-chat__said">{text}</p>
      </div>
    </div>
  );
}

/** The steps a run took, named for a reader and folded away. */
function Steps({ interaction }: { readonly interaction: Interaction }) {
  if (interaction.steps.length === 0) return null;
  return (
    <details className="rp-action-card__log">
      <summary>这次动作做了什么</summary>
      <ul>
        {interaction.steps.map((step, index) => (
          <li key={`${step.label}-${String(index)}`}>
            {step.label}
            {step.failed && <span className="rp-danger">（被拒绝）</span>}
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * One interaction, as the assistant's reply to it.
 *
 * The reply's *shape* is the product's and its *words* are the model's where
 * there are any: an Ask answers in prose, anything else reports what it did.
 *
 * Exported because the turn is the product's most load-bearing sentence —「问题
 * 解决了吗」— and the markup it produces is checked as markup, not by eye.
 */
export function AssistantTurn({
  bundle,
  interaction,
  proposal,
  allowance,
  answerBudget,
  onInspect,
  onOpenProposal,
  onEditFromResearch,
  onRetryEdit,
  onRewrite,
}: {
  readonly bundle: TaskBundle;
  readonly interaction: Interaction;
  readonly proposal: ProposalView | null;
  readonly allowance: { readonly searches: number; readonly reads: number };
  readonly answerBudget: ActionBudgetView | null;
  readonly onInspect: () => void;
  readonly onOpenProposal: () => void;
  readonly onEditFromResearch: () => void;
  readonly onRetryEdit: () => void;
  readonly onRewrite: () => void;
}) {
  const running = interaction.status === "running";
  const exhausted = budgetExhausted(interaction, allowance);
  const outcome = researchOutcomeOf(bundle, interaction);
  // What an Edit ran into, in the words written for the person who asked for
  // the change. The tool's own refusal is the fallback for runs that predate
  // the sentence being recorded.
  const failureReason = interaction.outcome?.kind === "edit" ? interaction.outcome.userMessage : interaction.refusal;

  return (
    <div className="rp-chat__turn rp-chat__turn--assistant" data-testid={`action-${interaction.kind === "research" ? "gap" : interaction.kind}`}>
      <div className="rp-chat__who">助手</div>
      <div className="rp-chat__body">
        {interaction.kind === "ask" ? (
          running ? (
            <p className="rp-chat__said">正在读这个项目已有的材料…</p>
          ) : interaction.failure.length > 0 ? (
            <p className="rp-chat__said">这次提问没有完成：{interaction.failure}</p>
          ) : interaction.answer === null ? (
            <p className="rp-chat__said">这次回答不在会话历史里（提问本身不写入任何正式数据，回答只存在于会话记录中）。</p>
          ) : (
            <RichMarkdown text={interaction.answer} />
          )
        ) : interaction.kind === "research" ? (
          running ? (
            <>
              <p className="rp-chat__said">可以。我只补充材料，不会修改当前报告。</p>
              <p className="rp-chat__note">
                正在检索与读取…
                {answerBudget !== null && (
                  <>
                    {" "}
                    本次剩余：{answerBudget.searchesRemaining} 次检索 · {answerBudget.readsRemaining} 个来源
                  </>
                )}
              </p>
            </>
          ) : interaction.failure.length > 0 ? (
            <>
              <p className="rp-chat__said">这次补查没有完成：{interaction.failure}</p>
              <p className="rp-chat__note">报告正文没有变化；材料与证据都保留在这次动作之前的状态。</p>
            </>
          ) : (
            <>
              {/* The result answers whether the question was resolved. A count
                  of sources fetched is not that answer: two background papers
                  satisfy「找到 2 个可用来源」while leaving the question entirely
                  open. */}
              <div className="rp-outcome" data-testid="research-outcome" data-status={outcome.verdict}>
                <div className="rp-outcome__head" data-testid="research-verdict">
                  {outcome.headline}
                </div>
                <p className="rp-chat__said" data-testid="research-result">
                  {outcome.sentence}
                </p>
                {outcome.settled.length > 0 && (
                  <div className="rp-outcome__row">
                    <span className="rp-outcome__k">已解决</span>
                    <span>{outcome.settled.join("、")}</span>
                  </div>
                )}
                {outcome.missing.length > 0 && (
                  <div className="rp-outcome__row">
                    <span className="rp-outcome__k">仍缺少</span>
                    <span>
                      {outcome.missing
                        .map((target) => (target.reason.length > 0 ? `${target.label}（${target.reason}）` : target.label))
                        .join("；")}
                    </span>
                  </div>
                )}
                <div className="rp-outcome__row">
                  <span className="rp-outcome__k">本轮新增</span>
                  <span data-testid="research-delta">
                    {outcome.hasDelta ? deltaLine(outcome.delta) : "本轮没有找到新的材料。"}
                  </span>
                </div>
              </div>
              {exhausted && <p className="rp-chat__note">本轮的检索额度已经用完；可以再发一条指令，那会得到新的一次额度。</p>}
              <div className="rp-action-card__actions">
                {outcome.inspectable && (
                  <Button size="xs" variant="default" onClick={onInspect} data-testid="inspect-action-evidence">
                    查看本轮证据
                  </Button>
                )}
                <Button size="xs" variant="subtle" leftSection={<SquarePen size={13} />} onClick={onEditFromResearch}>
                  基于这些材料修改本节
                </Button>
              </div>
              {/* What the action spent is a secondary detail, and it stays
                  folded: 「问题解决了吗」is the result, the tool counts are not. */}
              <details className="rp-action-card__log" data-testid="research-activity">
                <summary>本轮活动</summary>
                <p>{outcome.activity}</p>
                <p className="rp-muted">报告正文没有改变：补查只增加材料与支持评估。</p>
              </details>
            </>
          )
        ) : running ? (
          <>
            <p className="rp-chat__said">可以。我会只针对选中的目标生成修改建议。</p>
            <p className="rp-chat__note">正在起草…提案写好之前，报告正文不会变化。</p>
          </>
        ) : interaction.drafted ? (
          <>
            <p className="rp-chat__said">我基于刚才的材料准备了一份修改建议，等你决定。</p>
            {proposal === null ? (
              <div className="rp-action-card__actions">
                <Button size="xs" onClick={onOpenProposal} data-testid="open-proposal">
                  查看修改建议
                </Button>
              </div>
            ) : null}
          </>
        ) : (
          <>
            {/* Nothing was drafted, so nothing is offered to accept: the turn
                says what the attempt ran into — in the application's own words,
                which name what the rewrite lost rather than a check id — and
                offers the two things the reader can do about it. */}
            <div className="rp-outcome" data-testid="edit-outcome" data-status="proposal_not_created">
              <div className="rp-outcome__head">这次改写没有形成可接受的修改建议</div>
              <p className="rp-chat__said" data-testid="edit-refusal-reason">
                {failureReason.length > 0 ? failureReason : "模型这一次没有起草提案。"}
              </p>
              {!failureReason.includes("正文") && <p className="rp-chat__note">报告正文没有变化。</p>}
            </div>
            <div className="rp-action-card__actions">
              <Button size="xs" variant="default" onClick={onRetryEdit} data-testid="retry-edit">
                重新尝试
              </Button>
              <Button size="xs" variant="subtle" onClick={onRewrite} data-testid="rewrite-edit">
                换一种修改方式
              </Button>
            </div>
          </>
        )}

        {interaction.kind === "edit" && proposal !== null && interaction.drafted && (
          <div className="rp-chat__embedded" data-testid="assistant-proposal">
            {/* Decided here, the proposal stays here: the turn keeps its record
                and the conversation is not replaced by the thing it produced. */}
            <ProposalPanel bundle={bundle} proposalId={proposal.proposalId} onSettled={() => undefined} />
          </div>
        )}

        <Steps interaction={interaction} />
      </div>
    </div>
  );
}

export function AssistantPanel({ bundle }: { readonly bundle: TaskBundle }) {
  const { assistant, answers, runtime, selection, setSelection, dock, openDock, prefillAssistant, updateAssistant, refresh, busy, say } =
    useApp();
  const composer = useRef<HTMLTextAreaElement | null>(null);
  const thread = useRef<HTMLDivElement | null>(null);
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

  const send = async (
    value: string,
    intentToUse: AssistantIntent = intent,
    sectionId: string | null = target.sectionId,
  ): Promise<void> => {
    if (value.length === 0) return;
    setSending(true);
    setError(null);
    try {
      await api.assistant(bundle.task.id, {
        text: value,
        intent: intentToUse,
        ...(intentToUse === "edit" && sectionId !== null ? { targetSectionId: sectionId } : {}),
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

  const interactions = conversationOf(bundle, answers);
  const allowance = runtime?.actionAllowance ?? { searches: 2, reads: 4 };

  // Following an action into its evidence is a move inside the conversation:
  // the reader returns to the turn they left, not to the top of the thread.
  const focus = dock?.kind === "assistant" ? dock.focus : undefined;
  const consumed = useRef<string | null>(null);
  useEffect(() => {
    if (focus === undefined || focus === consumed.current) return;
    consumed.current = focus;
    thread.current
      ?.querySelector(`[data-interaction-id="${CSS.escape(focus)}"]`)
      ?.scrollIntoView({ block: "center" });
  }, [focus]);

  /** Opens the evidence this one action brought in — and only that. */
  const inspect = (interaction: Interaction): void => {
    openDock({ kind: "action", interactionId: interaction.id });
  };

  /** Sends the same sentence again, for an Edit that produced nothing. */
  const retryEdit = (value: string): void => {
    updateAssistant({ intent: "edit", text: value });
    void send(value, "edit", target.sectionId);
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
    ? { help: "先选择要修改的章节：在报告里点一个标题，或用上方的下拉框选。", submit: INTENT_TEXT.edit.submit }
    : INTENT_TEXT[intent];

  const budgetLine =
    intent === "research"
      ? bundle.actionBudget === null
        ? `这次补查的额度独立计算：最多 ${String(allowance.searches)} 次检索 · ${String(allowance.reads)} 个来源读取。`
        : `本次剩余：${String(bundle.actionBudget.searchesRemaining)} 次检索 · ${String(bundle.actionBudget.readsRemaining)} 个来源。`
      : "";

  return (
    <div className="rp-assistant">
      <div className="rp-assistant__bar" data-testid="assistant-bar">
        <span className="rp-assistant__label">助手</span>
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
            w={150}
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

      <div className="rp-assistant__body" data-testid="assistant-thread" ref={thread}>
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

        {interactions.length === 0 && running === null && (
          <p className="rp-muted rp-assistant__empty" data-testid="assistant-empty">
            还没有对话。可以问一个关于材料的问题，也可以让助手补查某个缺口；需要改报告时，先在报告里选一个章节或一句话。
          </p>
        )}

        {interactions.map((interaction) => (
          <div className="rp-chat__exchange" key={interaction.id} data-interaction-id={interaction.id}>
            <UserTurn text={interaction.userText} />
            <AssistantTurn
              bundle={bundle}
              interaction={interaction}
              proposal={proposalFor(interaction, bundle.proposals, Date.now())}
              allowance={allowance}
              answerBudget={bundle.actionBudget}
              onInspect={() => {
                inspect(interaction);
              }}
              onOpenProposal={() => {
                void openProposal();
              }}
              onEditFromResearch={() => {
                prefillAssistant({
                  intent: "edit",
                  sectionId: target.sectionId,
                  text: target.sectionId === null ? "" : `基于刚才补查到的材料，修改「${target.label}」这一节。`,
                });
              }}
              onRetryEdit={() => {
                retryEdit(interaction.userText);
              }}
              onRewrite={() => {
                updateAssistant({ intent: "edit", text: "" });
                composer.current?.focus();
              }}
            />
          </div>
        ))}
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

        <Textarea
          ref={composer}
          className="rp-assistant__box"
          autosize
          minRows={3}
          maxRows={9}
          placeholder={PLACEHOLDERS[intent]}
          value={text}
          onChange={(event) => {
            updateAssistant({ text: event.currentTarget.value });
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void send(text.trim());
            }
          }}
          data-testid="assistant-input"
        />

        {error !== null && (
          <p className="rp-assistant__error" role="alert" data-testid="assistant-error">
            {error}
          </p>
        )}

        <div className="rp-assistant__toolbar">
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

          <span className="rp-assistant__help" data-testid="assistant-help">
            {budgetLine.length > 0 ? budgetLine : help.help}
          </span>

          <Tooltip label={help.help} disabled={needsSection} withArrow={false} multiline w={280}>
            <span>
              <Button
                size="sm"
                leftSection={<Send size={14} />}
                loading={sending}
                disabled={text.trim().length === 0 || busy || needsSection}
                onClick={() => {
                  void send(text.trim());
                }}
                data-testid="assistant-submit"
              >
                {help.submit}
              </Button>
            </span>
          </Tooltip>
        </div>

        <div className="rp-assistant__foot">
          <span className="rp-assistant__note" data-testid="assistant-scope">
            {SCOPE_LINE[intent]}
          </span>
          <Menu shadow="md" position="top-end" width={260}>
            <Menu.Target>
              <Button size="compact-xs" variant="subtle" rightSection={<ChevronRight size={12} />} aria-label="更多动作" px="xs">
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
              <Menu.Item
                leftSection={<MessageSquare size={13} />}
                onClick={() => {
                  updateAssistant({ intent: "ask" });
                }}
              >
                转为提问
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
