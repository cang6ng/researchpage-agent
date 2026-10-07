/**
 * Guided planning: a conversation that ends in one decision at a time.
 *
 * This is a transcript, and the transcript is not kept here. Every turn is
 * derived from the decisions the application already recorded — the question it
 * wrote, the transition it wrote before asking it, and what the person answered
 * — so refreshing the page rebuilds the same conversation and the page can
 * never show a turn the brief does not have.
 *
 * The styling rule is the product's: this is a research planning conversation,
 * not a chat app. The assistant speaks on the left without a bubble, the person
 * answers slightly right of it with a light surface, and the choices stay
 * inside the message that asked for them instead of becoming a third kind of
 * card. What the answer changed is said once, in a small line under it.
 *
 * One state has to be recovered by the panel itself: the application asked for
 * another question and got none — a question run that ended without leaving a
 * question behind. That is retried once for the exact brief it was true for,
 * and then handed back to the reader, because a loop that keeps asking a model
 * to ask something is a loop with no floor.
 */

import { Button, Loader, Textarea, Tooltip } from "@mantine/core";
import { ArrowRight, MessageSquareQuote, RotateCw, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { BRIEF_FIELD_LABELS, type BriefView } from "../api.js";
import {
  guideConfirmState,
  guideIntro,
  guideProgress,
  guideStalled,
  guideSummaryItems,
  guideTranscript,
  type GuideMessage,
} from "../guide-logic.js";
import { RichMarkdown } from "./markdown.js";

/** How long the stalled state has to hold before the panel retries it once. */
const RECOVERY_GRACE_MS = 6_000;

/** What the reader just decided, for the receipt under their answer. */
export interface GuideApplied {
  readonly label: string;
  readonly field: string;
}

function fieldNames(fields: readonly string[]): string {
  return fields
    .map((field) => BRIEF_FIELD_LABELS[field as keyof typeof BRIEF_FIELD_LABELS] ?? field)
    .join("、");
}

/** One assistant turn: the transition, the question, and — if live — the choices. */
function AssistantTurn({
  message,
  choice,
  setChoice,
  freeText,
  setFreeText,
  canSubmit,
  onSubmit,
}: {
  readonly message: GuideMessage;
  readonly choice: string | null;
  readonly setChoice: (next: string | null) => void;
  readonly freeText: string;
  readonly setFreeText: (next: string) => void;
  readonly canSubmit: boolean;
  readonly onSubmit: () => void;
}) {
  return (
    <div className="rp-chat__turn rp-chat__turn--assistant" data-testid="guide-msg-assistant">
      <div className="rp-chat__who">助手</div>
      <div className="rp-chat__body">
        <RichMarkdown text={message.leadIn} className="rp-chat__lead" />
        <div className="rp-chat__ask" data-testid={message.answerable ? "guide-question" : undefined}>
          <RichMarkdown text={message.question} />
        </div>

        {message.answerable && (
          <>
            <div className="rp-choices" role="radiogroup" aria-label={message.question} data-testid="guide-options">
              {message.options.map((option) => (
                <label
                  key={option.optionId}
                  className={`rp-choice${choice === option.optionId ? " rp-choice--on" : ""}`}
                  data-testid={`option-${option.optionId}`}
                >
                  <input
                    type="radio"
                    name={`guide-${message.id}`}
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

            <div className="rp-chat__compose">
              <Textarea
                size="sm"
                autosize
                minRows={1}
                maxRows={5}
                placeholder="也可以直接用自己的说法回答"
                value={freeText}
                onChange={(event) => {
                  setFreeText(event.currentTarget.value);
                }}
                data-testid="guide-free-text"
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && canSubmit) {
                    event.preventDefault();
                    onSubmit();
                  }
                }}
              />
              <Button
                size="sm"
                variant={choice === null && freeText.trim().length === 0 ? "default" : "filled"}
                disabled={!canSubmit}
                onClick={onSubmit}
                rightSection={<ArrowRight size={14} />}
                data-testid="guide-submit"
              >
                发送
              </Button>
            </div>
            {message.fieldTargets.length > 0 && (
              <p className="rp-chat__decides">
                这一问决定：{fieldNames(message.fieldTargets)}
                <span className="rp-chat__note">（一次只决定一项；也可以切到结构化编辑直接改）</span>
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** One user turn, and the small line saying what it wrote. */
function UserTurn({ message, latest }: { readonly message: GuideMessage; readonly latest: boolean }) {
  return (
    <>
      <div className="rp-chat__turn rp-chat__turn--user" data-testid="guide-msg-user">
        <div className="rp-chat__who">你</div>
        <div className="rp-chat__body">
          <p className="rp-chat__said">{message.answerText}</p>
        </div>
      </div>
      {message.appliedFields.length > 0 && (
        <div className="rp-chat__receipt" data-testid="guide-receipt" data-latest={latest ? "true" : undefined}>
          已更新「{fieldNames(message.appliedFields)}」
        </div>
      )}
    </>
  );
}

export function GuidePanel({
  brief,
  busy,
  waiting,
  settledGuideRuns,
  staleNote,
  onAsk,
  onAnswer,
  onViewStructured,
  onConfirm,
}: {
  readonly brief: BriefView;
  readonly busy: boolean;
  readonly waiting: boolean;
  /** Question runs of this project that have already ended. */
  readonly settledGuideRuns: number;
  readonly staleNote: string | null;
  readonly onAsk: () => void;
  readonly onAnswer: (input: { readonly optionIds: readonly string[]; readonly freeText: string }) => void;
  readonly onViewStructured: () => void;
  readonly onConfirm: () => void;
}) {
  const [choice, setChoice] = useState<string | null>(null);
  const [freeText, setFreeText] = useState("");
  const activeId = brief.guide.active?.questionId ?? null;
  const progress = guideProgress(brief);
  const confirmState = guideConfirmState(brief);
  const transcript = guideTranscript(brief);
  const stalledKey = guideStalled(brief, busy, settledGuideRuns);

  // A new question is a new decision: keeping the previous answer selected would
  // let a reader submit one question's answer to the next one.
  useEffect(() => {
    setChoice(null);
    setFreeText("");
  }, [activeId]);

  // The one recovery the panel runs on its own. It is keyed to the exact brief
  // the situation was true for, so it happens once and then becomes the
  // reader's decision; the callback is held in a ref so a parent that re-renders
  // cannot keep restarting the timer.
  const recover = useRef(onAsk);
  recover.current = onAsk;
  const retried = useRef<string | null>(null);
  useEffect(() => {
    if (stalledKey === null || retried.current === stalledKey) return;
    const timer = window.setTimeout(() => {
      retried.current = stalledKey;
      recover.current();
    }, RECOVERY_GRACE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [stalledKey]);
  const stalled = stalledKey !== null && retried.current === stalledKey;

  const lastUserIndex = transcript.reduce((at, message, index) => (message.role === "user" ? index : at), -1);
  // A disabled control has to say why: a run finishing the previous turn is a
  // different reason from a draft that cannot be confirmed yet.
  const confirmBlocked = !confirmState.enabled
    ? confirmState.reason
    : busy
      ? "助手正在收尾上一步，等它停下来就可以确认。"
      : "";
  const canSubmit = activeId !== null && (choice !== null || freeText.trim().length > 0) && !busy;
  const submit = (): void => {
    onAnswer({ optionIds: choice === null ? [] : [choice], freeText });
  };

  const started = transcript.length > 0;

  return (
    <div className="rp-guide" data-testid="guide-panel">
      <div className="rp-guide__head" data-testid="guide-header">
        <div>
          <div className="rp-kicker">智能引导</div>
          <div className="rp-guide__count" data-testid="guide-progress">
            {progress.label}
          </div>
          <p className="rp-guide__lede">{progress.note}</p>
        </div>
        <div className="rp-guide__head-actions">
          <Button variant="subtle" size="compact-sm" onClick={onViewStructured} data-testid="guide-structured">
            查看结构化方案
          </Button>
          <Tooltip label={confirmState.reason} disabled={confirmState.enabled} withArrow={false} multiline w={280}>
            <span>
              <Button
                size="compact-sm"
                variant={progress.reached ? "light" : "default"}
                disabled={!confirmState.enabled || busy}
                onClick={onConfirm}
                data-testid="guide-confirm"
              >
                方案已经够清楚，确认并开始研究
              </Button>
            </span>
          </Tooltip>
          {confirmBlocked.length > 0 && (
            <span className="rp-guide__why-not" data-testid="guide-confirm-why">
              {confirmBlocked}
            </span>
          )}
        </div>
      </div>

      {staleNote !== null && (
        <div className="rp-note rp-note--warn" data-testid="guide-stale">
          <MessageSquareQuote size={14} style={{ flex: "none", marginTop: 2 }} />
          <span>{staleNote}</span>
        </div>
      )}

      {!started ? (
        <div className="rp-guide__idle" data-testid="guide-idle">
          <Sparkles size={18} strokeWidth={1.7} />
          <div>
            <h2>从一个决策开始。</h2>
            <p>{guideIntro(brief)}</p>
          </div>
          <Button onClick={onAsk} rightSection={<ArrowRight size={14} />} data-testid="guide-start">
            开始引导
          </Button>
        </div>
      ) : (
        <div className="rp-chat" data-testid="guide-transcript">
          {transcript.map((message, index) =>
            message.role === "assistant" ? (
              message.closing ? (
                <div className="rp-chat__turn rp-chat__turn--assistant" data-testid="guide-complete" key={message.id}>
                  <div className="rp-chat__who">助手</div>
                  <div className="rp-chat__body">
                    <div className="rp-chat__ask">
                      <RichMarkdown text={message.question} />
                    </div>
                    <ul className="rp-chat__summary" data-testid="guide-summary">
                      {guideSummaryItems(brief).map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                    <div className="rp-chat__done">
                      <Button
                        variant="default"
                        size="compact-sm"
                        onClick={onViewStructured}
                        data-testid="guide-done-structured"
                      >
                        查看结构化方案
                      </Button>
                      <Button
                        size="sm"
                        disabled={!confirmState.enabled || busy}
                        onClick={onConfirm}
                        data-testid="guide-confirm-done"
                      >
                        确认并开始研究
                      </Button>
                    </div>
                  </div>
                </div>
              ) : (
                <AssistantTurn
                  key={message.id}
                  message={message}
                  choice={choice}
                  setChoice={setChoice}
                  freeText={freeText}
                  setFreeText={setFreeText}
                  canSubmit={canSubmit}
                  onSubmit={submit}
                />
              )
            ) : (
              <UserTurn key={message.id} message={message} latest={index === lastUserIndex} />
            ),
          )}

          {waiting && !stalled && (
            <div className="rp-chat__turn rp-chat__turn--assistant rp-chat__turn--pending" data-testid="guide-waiting">
              <div className="rp-chat__who">助手</div>
              <div className="rp-chat__body">
                <span className="rp-chat__pending">
                  <Loader size={12} color="ink" />
                  正在准备下一个问题…
                </span>
              </div>
            </div>
          )}

          {stalled && (
            <div className="rp-chat__turn rp-chat__turn--assistant" data-testid="guide-stalled">
              <div className="rp-chat__who">助手</div>
              <div className="rp-chat__body">
                <p className="rp-chat__said">助手没有生成下一项决定。</p>
                <p className="rp-chat__note">
                  刚才那一步没有留下问题，简报没有变化；可以再让它试一次，也可以直接自己改。
                </p>
                <div className="rp-chat__done">
                  <Button size="compact-sm" variant="default" leftSection={<RotateCw size={13} />} onClick={onAsk} data-testid="guide-retry">
                    继续引导
                  </Button>
                  <Button size="compact-sm" variant="subtle" onClick={onViewStructured} data-testid="guide-stalled-structured">
                    自己改
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
