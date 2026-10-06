/**
 * Guided planning: one decision at a time.
 *
 * This is not a conversation and must not become one. There is no transcript to
 * scroll and no assistant to greet you: there is one question the application
 * decided is worth asking, the reason it is worth asking, and the answers it
 * already knows how to apply. Answering it writes to the same brief the
 * structured editor writes to, which is why the panel can say what the decision
 * changed instead of describing a chat turn.
 *
 * A question that is not there yet is shown as not there yet — the application
 * writes it in a bounded run, and a panel that invented a placeholder question
 * would be answering on the application's behalf.
 */

import { Button, Loader, Textarea } from "@mantine/core";
import { ArrowRight, Check, Info, MessageSquareQuote, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";

import type { GuideDecisionView, GuideQuestionView } from "../api.js";
import { BRIEF_FIELD_LABELS } from "../api.js";

/** What the reader just decided, said back before the panel moves on. */
export interface GuideApplied {
  readonly label: string;
  readonly field: string;
}

export function GuidePanel({
  question,
  complete,
  reason,
  decisions,
  limit,
  waiting,
  applied,
  staleNote,
  busy,
  onAsk,
  onAnswer,
  onViewStructured,
  onConfirm,
}: {
  readonly question: GuideQuestionView | null;
  readonly complete: boolean;
  readonly reason: string;
  readonly decisions: readonly GuideDecisionView[];
  readonly limit: number;
  readonly waiting: boolean;
  readonly applied: GuideApplied | null;
  readonly staleNote: string | null;
  readonly busy: boolean;
  readonly onAsk: () => void;
  readonly onAnswer: (input: { readonly optionIds: readonly string[]; readonly freeText: string }) => void;
  readonly onViewStructured: () => void;
  readonly onConfirm: () => void;
}) {
  const [choice, setChoice] = useState<string | null>(null);
  const [freeText, setFreeText] = useState("");

  // A new question is a new decision: keeping the previous answer selected
  // would let a reader submit one question's answer to the next one.
  useEffect(() => {
    setChoice(null);
    setFreeText("");
  }, [question?.questionId]);

  const field = question?.fieldTargets[0];
  const canSubmit = question !== null && (choice !== null || freeText.trim().length > 0) && !busy;

  return (
    <div className="rp-guide" data-testid="guide-panel">
      <div className="rp-guide__head">
        <div>
          <div className="rp-kicker">智能引导</div>
          <p className="rp-guide__lede">一次只处理一个关键决策；答案直接写进同一份研究简报。</p>
        </div>
        <div className="rp-guide__count">
          关键决策 <b>{decisions.length}</b> / 最多 {limit}
        </div>
      </div>

      {staleNote !== null && (
        <div className="rp-note rp-note--warn" data-testid="guide-stale">
          <Info size={14} style={{ flex: "none", marginTop: 2 }} />
          <span>{staleNote}</span>
        </div>
      )}

      {applied !== null && (
        <div className="rp-guide__applied" data-testid="guide-applied">
          <Check size={14} strokeWidth={2.2} />
          <span>
            <b>{applied.field}</b> 已更新：{applied.label} → 已写入 Research Brief
          </span>
          <button type="button" className="rp-guide__link" onClick={onViewStructured}>
            查看结构化 Brief
          </button>
        </div>
      )}

      {question !== null ? (
        <div className="rp-guide__card" data-testid={`question-${question.questionId}`}>
          <h2 className="rp-guide__question">{question.question}</h2>
          {question.whyThisMatters.length > 0 && (
            <p className="rp-guide__why" data-testid="guide-why">
              {question.whyThisMatters}
            </p>
          )}
          {field !== undefined && (
            <p className="rp-guide__field">
              这一问决定：{BRIEF_FIELD_LABELS[field]}
              <span className="rp-guide__field-note">（也可以在结构化编辑里直接改）</span>
            </p>
          )}

          <div className="rp-choices" role="radiogroup" aria-label={question.question} data-testid="guide-options">
            {question.options.map((option) => (
              <label
                key={option.optionId}
                className={`rp-choice${choice === option.optionId ? " rp-choice--on" : ""}`}
                data-testid={`option-${option.optionId}`}
              >
                <input
                  type="radio"
                  name={`guide-${question.questionId}`}
                  value={option.optionId}
                  checked={choice === option.optionId}
                  onChange={() => {
                    setChoice(option.optionId);
                  }}
                />
                <span className="rp-choice__body">
                  <span className="rp-choice__label">
                    {option.label}
                    {option.recommended === true && <span className="rp-choice__rec">推荐</span>}
                  </span>
                  {option.description !== undefined && option.description.length > 0 && (
                    <span className="rp-choice__desc">{option.description}</span>
                  )}
                </span>
              </label>
            ))}
          </div>

          {question.allowFreeText && (
            <div className="rp-guide__free">
              <label className="rp-guide__free-label" htmlFor={`free-${question.questionId}`}>
                或者自己回答
              </label>
              <Textarea
                id={`free-${question.questionId}`}
                size="sm"
                autosize
                minRows={2}
                maxRows={5}
                placeholder="用你自己的说法写下来；这会直接写入这一项。"
                value={freeText}
                onChange={(event) => {
                  setFreeText(event.currentTarget.value);
                }}
                data-testid="guide-free-text"
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && canSubmit) {
                    event.preventDefault();
                    onAnswer({ optionIds: choice === null ? [] : [choice], freeText });
                  }
                }}
              />
            </div>
          )}

          <div className="rp-guide__actions">
            <Button
              disabled={!canSubmit}
              onClick={() => {
                onAnswer({ optionIds: choice === null ? [] : [choice], freeText });
              }}
              data-testid="guide-submit"
            >
              提交这个决定
            </Button>
            <span className="rp-guide__hint">一次只能提交一个决定。</span>
          </div>
        </div>
      ) : complete ? (
        <div className="rp-guide__done" data-testid="guide-complete">
          <MessageSquareQuote size={18} strokeWidth={1.7} />
          <div>
            <h2>研究方案已经足够明确。</h2>
            <p>{reason.length > 0 ? reason : "没有更值得追问的决策了。"}</p>
          </div>
          <div className="rp-guide__done-actions">
            <Button variant="default" onClick={onViewStructured}>
              查看研究方案
            </Button>
            <Button
              disabled={busy}
              onClick={onConfirm}
              data-testid="guide-confirm"
            >
              确认并开始研究
            </Button>
          </div>
        </div>
      ) : waiting ? (
        <div className="rp-guide__waiting" data-testid="guide-waiting">
          <Loader size="xs" color="ink" />
          <div>
            <b>正在准备下一个问题…</b>
            <span>
              应用会先看这份简报里还有哪一项最值得确定，再写成一个问题。这一步不检索、不改报告。
            </span>
          </div>
        </div>
      ) : (
        <div className="rp-guide__idle" data-testid="guide-idle">
          <Sparkles size={18} strokeWidth={1.7} />
          <div>
            <h2>从一个决策开始。</h2>
            <p>
              应用会按「研究目标 → 读者 → 比较对象 → 维度 → 关注点」的顺序，挑出当前最值得确定的一项来问；
              已经由你改过的字段不会重复问。
            </p>
          </div>
          <Button
            onClick={onAsk}
            rightSection={<ArrowRight size={14} />}
            data-testid="guide-start"
          >
            开始引导
          </Button>
        </div>
      )}

      {decisions.length > 0 && (
        <details className="rp-guide__record" data-testid="guide-record">
          <summary>已经做过的决定（{decisions.length}）</summary>
          <ul>
            {decisions.map((decision) => (
              <li key={decision.questionId}>
                <span className="rp-guide__record-q">{decision.question}</span>
                <span className="rp-guide__record-a">
                  {decision.optionIds.length > 0 || decision.freeText.length > 0 ? (
                    <>
                      {decision.optionIds.length > 0 ? `选项 ${decision.optionIds.join("、")}` : ""}
                      {decision.optionIds.length > 0 && decision.freeText.length > 0 ? " · " : ""}
                      {decision.freeText}
                    </>
                  ) : (
                    "已应用"
                  )}
                  <span className="rp-guide__record-field">
                    {decision.appliedFields.map((name) => BRIEF_FIELD_LABELS[name]).join("、")}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
