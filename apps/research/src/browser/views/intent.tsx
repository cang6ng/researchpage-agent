/**
 * The exploration: a conversation that has to end in a decision.
 *
 * This page exists because a topic is not a research question. Before anything
 * is searched, the assistant asks what the reader actually wants compared, how
 * far the research should reach and who it is for — and the reader answers in
 * their own words, corrects what was misread, edits the direction and only then
 * confirms it. Nothing is a project until that confirmation, and the page says
 * so at every step.
 *
 * The panel is split from the container on purpose. `IntentPanel` takes the
 * record and a set of callbacks and decides nothing about the network; what it
 * draws is therefore answerable in a test, down to which buttons are disabled
 * and why. The container is the part that talks to the store.
 */

import { Alert, Button, Checkbox, Loader, Textarea, Tooltip } from "@mantine/core";
import { AlertTriangle, ArrowRight, Check, FileText, Pencil, Send } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useApp } from "../store.js";
import type { DirectionPatch, IntentTurnView, IntentView, LibraryDocumentView, ResearchDirectionView } from "../api.js";
import { RichMarkdown } from "../components/markdown.js";
import { DocumentLibrary } from "../components/document-library.js";
import { DocumentUpload } from "../components/document-upload.js";
import {
  TASK_WAIT_TEXTS,
  attachableDocumentsOf,
  confirmGateOf,
  directionDraftChanged,
  directionDraftOf,
  directionPatchOf,
  saveDirectionGateOf,
  sendGateOf,
  taskWaitPhaseOf,
  type DirectionDraft,
} from "../intent-logic.js";

const MAX_MESSAGE_CHARS = 4_000;

/** A short time, said the way a reader says it. */
function when(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export interface IntentPanelProps {
  readonly intent: IntentView;
  /** The server is running a turn for this exploration. */
  readonly busy: boolean;
  /** This page has an action of its own in flight. */
  readonly working: boolean;
  /** Local ms when a direction was confirmed on this page, if it was. */
  readonly confirmedAt: number | null;
  /** The clock the wait message is read against; passed in so a test can fix it. */
  readonly now: number;
  /** Documents that landed after the proposal was written. */
  readonly newerDocumentIds: readonly string[];
  readonly onSend: (text: string, documentIds: readonly string[]) => void;
  readonly onSaveDirection: (patch: DirectionPatch) => void;
  readonly onConfirm: (patch: DirectionPatch | null) => void;
  /** Prefills the composer with a sentence about one document. */
  readonly onUseDocument: (document: LibraryDocumentView) => void;
  readonly onRetryRead: () => void;
  readonly onStartFresh: () => void;
  /** A sentence the page wrote for the reader, which they may edit before sending. */
  readonly prefill?: { readonly text: string; readonly token: number } | null;
  /** The library and the uploader, which the container supplies. */
  readonly children?: React.ReactNode;
}

function Turn({ turn }: { readonly turn: IntentTurnView }): React.ReactElement {
  if (turn.role === "user") {
    return (
      <div className="rp-chat__turn rp-chat__turn--user" data-testid={`intent-turn-${turn.id}`}>
        <span className="rp-chat__who">你 · {when(turn.at)}</span>
        <div className="rp-chat__body">
          <p className="rp-chat__said">{turn.text}</p>
          {(turn.documentIds ?? []).length > 0 && (
            <p className="rp-chat__note">随这条消息附上了 {String(turn.documentIds?.length ?? 0)} 份已入库文档。</p>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="rp-chat__turn rp-chat__turn--assistant" data-testid={`intent-turn-${turn.id}`}>
      <span className="rp-chat__who">助手</span>
      <div className="rp-chat__body">
        {turn.proposesDirection === true && <p className="rp-chat__note">下面这条是研究方向建议，需要你确认。</p>}
        <RichMarkdown text={turn.text} className={turn.proposesDirection === true ? undefined : "rp-chat__ask"} />
        {turn.why !== undefined && turn.why.length > 0 && <p className="rp-chat__note">为什么问这个：{turn.why}</p>}
      </div>
    </div>
  );
}

/**
 * The direction on the table, editable in the four fields that decide it.
 *
 * `topic` / `purpose` / `scope` / `audience` are what a research direction
 * actually is; the objects, dimensions and focus the assistant suggested are
 * kept as they are, because they are proposals the card treats as proposals and
 * editing them here would make this page a second brief editor.
 */
function DirectionEditor({
  direction,
  disabled,
  dirty,
  draft,
  onChange,
  onSave,
  onConfirm,
  onDiscard,
  saveReason,
  confirmReason,
  canConfirm,
}: {
  readonly direction: ResearchDirectionView;
  readonly disabled: boolean;
  readonly dirty: boolean;
  readonly draft: DirectionDraft;
  readonly onChange: (next: DirectionDraft) => void;
  readonly onSave: () => void;
  readonly onConfirm: () => void;
  readonly onDiscard: () => void;
  readonly saveReason: string;
  readonly confirmReason: string;
  readonly canConfirm: boolean;
}): React.ReactElement {
  return (
    <div className="rp-chat__embedded" data-testid="intent-direction">
      <div className="rp-kicker" style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <Pencil size={12} strokeWidth={1.75} aria-hidden="true" />
        研究方向（{direction.source === "user" ? "你修改过的版本" : "助手建议"}）
      </div>
      {direction.source === "user" && <p className="rp-chat__note">这段文字里有你自己的修改；确认之后它就是任务卡的主题。</p>}
      <div className="rp-fields" style={{ marginTop: 10 }}>
        <Field
          label="主题"
          value={draft.topic}
          disabled={disabled}
          onChange={(value) => {
            onChange({ ...draft, topic: value });
          }}
        />
        <Field
          label="研究问题 / 用途"
          value={draft.purpose}
          disabled={disabled}
          onChange={(value) => {
            onChange({ ...draft, purpose: value });
          }}
        />
        <Field
          label="范围"
          value={draft.scope}
          disabled={disabled}
          rows={3}
          onChange={(value) => {
            onChange({ ...draft, scope: value });
          }}
        />
        <Field
          label="读者"
          value={draft.audience}
          disabled={disabled}
          onChange={(value) => {
            onChange({ ...draft, audience: value });
          }}
        />
      </div>
      {direction.summary.length > 0 && <p className="rp-chat__summary">{direction.summary}</p>}
      <details style={{ marginTop: 10 }}>
        <summary style={{ cursor: "pointer", fontSize: 12.5, color: "var(--rp-ink-3)" }}>
          助手建议的比较对象、研究维度、关注点（{direction.subjects.length} 个对象 · {direction.dimensions.length} 个维度）
        </summary>
        <ul className="rp-chat__summary">
          {direction.subjects.map((subject) => (
            <li key={`s-${subject.name}`}>
              比较对象：{subject.name}
              {subject.note === undefined ? "" : `（${subject.note}）`}
            </li>
          ))}
          {direction.dimensions.map((dimension) => (
            <li key={`d-${dimension.name}`}>
              研究维度：{dimension.name} — {dimension.question}
            </li>
          ))}
          {direction.focus.length > 0 && <li>关注点：{direction.focus.join("、")}</li>}
          {direction.exclusions.length > 0 && <li>不研究：{direction.exclusions}</li>}
          {direction.lengthTarget.length > 0 && <li>篇幅目标：{direction.lengthTarget}</li>}
        </ul>
        <p className="rp-chat__note">这些建议会在任务卡里作为建议保留；进入研究范围后仍可编辑。</p>
      </details>
      <div className="rp-chat__done">
        <Tooltip label={saveReason} disabled={!dirty && saveReason.length === 0} withArrow={false}>
          <Button size="xs" variant="light" disabled={disabled || !dirty} onClick={onSave} data-testid="intent-direction-save">
            保存修改
          </Button>
        </Tooltip>
        {dirty && (
          <Button size="xs" variant="subtle" onClick={onDiscard} data-testid="intent-direction-discard">
            放弃修改
          </Button>
        )}
        <Tooltip label={confirmReason} disabled={confirmReason.length === 0} withArrow={false}>
          <span>
            <Button
              size="xs"
              rightSection={<ArrowRight size={14} />}
              disabled={disabled || !canConfirm}
              onClick={onConfirm}
              data-testid="intent-confirm"
            >
              确认方向，建立任务卡
            </Button>
          </span>
        </Tooltip>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  disabled,
  rows,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly rows?: number;
  readonly onChange: (next: string) => void;
}): React.ReactElement {
  return (
    <label className="rp-field">
      <span className="rp-field__label">{label}</span>
      <Textarea
        autosize
        minRows={rows ?? 1}
        maxRows={6}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          onChange(event.currentTarget.value);
        }}
        data-testid={`intent-direction-${label}`}
      />
    </label>
  );
}

export function IntentPanel(props: IntentPanelProps): React.ReactElement {
  const { intent, busy, working, confirmedAt, now } = props;
  const direction = intent.confirmedDirection ?? intent.proposal;
  const [draft, setDraft] = useState<DirectionDraft>(() => directionDraftOf(direction));
  const [baseline, setBaseline] = useState<DirectionDraft | null>(() => (direction === null ? null : directionDraftOf(direction)));
  const [answer, setAnswer] = useState("");
  const [attached, setAttached] = useState<readonly string[]>([]);
  const [decisionsOpen, setDecisionsOpen] = useState(false);
  const textarea = useRef<HTMLTextAreaElement | null>(null);

  // A new proposal — or the same one after the user's own edit came back — is a
  // new baseline. Keeping a draft against a direction that has changed would
  // make the editor's text describe something that is no longer on the table.
  const signature = direction === null ? "" : `${direction.at}|${direction.source}|${direction.topic}|${direction.purpose}|${direction.scope}|${direction.audience}`;
  const lastSignature = useRef(signature);
  useEffect(() => {
    if (lastSignature.current === signature) return;
    lastSignature.current = signature;
    const next = directionDraftOf(direction);
    setDraft(next);
    setBaseline(direction === null ? null : next);
  }, [signature, direction]);

  const dirty = directionDraftChanged(baseline, draft);
  const patch = directionPatchOf(baseline, draft);
  const confirmed = intent.status === "confirmed";

  // A sentence the page wrote on the reader's behalf — "please look at the file
  // that just finished converting" — lands in the composer as text they can
  // edit or delete. It is never sent by itself: reading a document is a round
  // of the conversation, and rounds are the user's to start.
  const prefill = props.prefill ?? null;
  const lastPrefill = useRef(prefill?.token ?? 0);
  useEffect(() => {
    if (prefill === null) return;
    if (lastPrefill.current === prefill.token) return;
    lastPrefill.current = prefill.token;
    setAnswer(prefill.text);
    textarea.current?.focus();
  }, [prefill]);
  const sendGate = sendGateOf({ status: intent.status, serverBusy: busy, working, text: answer });
  const saveGate = saveDirectionGateOf({ status: intent.status, serverBusy: busy, working, dirty });
  const confirmGate = confirmGateOf({
    status: intent.status,
    canConfirm: intent.canConfirm,
    serverBusy: busy,
    working,
    dirty,
    attachmentsBusy: false,
  });
  const ready = intent.documents.filter((document) => document.status === "ready");
  const send = (): void => {
    if (!sendGate.allowed) return;
    const text = answer.trim();
    setAnswer("");
    setAttached([]);
    props.onSend(text, attachableDocumentsOf(intent, attached));
  };
  const waitPhase = taskWaitPhaseOf({ confirmedAt, now });
  const waitText = TASK_WAIT_TEXTS[waitPhase];
  const waiting = confirmed && intent.taskId === null && confirmedAt !== null;

  return (
    <div className="rp-page" data-testid="intent-view">
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <div className="rp-kicker">研究方向澄清</div>
          <h1 className="rp-title" style={{ fontSize: 26 }}>
            {intent.seedTopic}
          </h1>
        </div>
        <span className={`rp-chip ${confirmed ? "rp-chip--reviewed" : "rp-chip--accent"}`} data-testid="intent-status">
          {intent.statusLabel}
        </span>
        {busy && (
          <span className="rp-chat__pending" data-testid="intent-busy">
            <Loader size="xs" color="ink" /> 正在处理上一轮
          </span>
        )}
      </div>

      <p className="rp-lede" style={{ marginTop: 8 }}>
        这一段是「确定研究什么」：助手会问清楚对象、范围与读者，你确认方向之后才会建立任务卡并开始检索。确认之前不会调用检索或撰写。
      </p>

      {/* ------------------------------------------------------ conversation */}
      <div className="rp-chat" style={{ marginTop: 22 }}>
        {intent.turns.map((turn) => (
          <Turn key={turn.id} turn={turn} />
        ))}
        {busy && (
          <div className="rp-chat__turn rp-chat__turn--assistant rp-chat__turn--pending">
            <span className="rp-chat__who">助手</span>
            <div className="rp-chat__body">
              <span className="rp-chat__pending">
                <Loader size="xs" color="ink" /> 正在读你的回答并整理方向…
              </span>
            </div>
          </div>
        )}
        {!busy && intent.pending !== null && intent.pending.options.length > 0 && !confirmed && (
          <div className="rp-chat__turn rp-chat__turn--assistant">
            <span className="rp-chat__who">可选回答</span>
            <div className="rp-chat__body">
              <div className="rp-choices" data-testid="intent-options">
                {intent.pending.options.map((option) => (
                  <button
                    key={option}
                    type="button"
                    className="rp-choice"
                    onClick={() => {
                      setAnswer(option);
                      textarea.current?.focus();
                    }}
                  >
                    <span className="rp-choice__body">
                      <span className="rp-choice__label">{option}</span>
                    </span>
                  </button>
                ))}
              </div>
              <p className="rp-chat__note">点一下会填进下面的输入框，你可以改完再发送。</p>
            </div>
          </div>
        )}
      </div>

      {/* --------------------------------------------------------- decisions */}
      {intent.decisions.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <button
            type="button"
            className="rp-inline"
            aria-expanded={decisionsOpen}
            onClick={() => {
              setDecisionsOpen((open) => !open);
            }}
            data-testid="intent-decisions-toggle"
          >
            助手对回答的理解（{intent.decisions.length} 条）{decisionsOpen ? "收起" : "展开"}
          </button>
          {decisionsOpen && (
            <ul className="rp-chat__summary" data-testid="intent-decisions">
              {intent.decisions.map((decision) => (
                <li key={decision.id}>
                  <b>{decision.value}</b>
                  {decision.basedOn.length > 0 && <span className="rp-chat__note"> — 来自你说的「{decision.basedOn}」</span>}
                </li>
              ))}
            </ul>
          )}
          <p className="rp-chat__note">这些是助手的复述，不是正式字段；说错了直接在下面纠正即可。</p>
        </div>
      )}

      {/* -------------------------------------------------------- direction */}
      {confirmed && direction !== null ? (
        <div className="rp-chat__embedded" style={{ marginTop: 18 }} data-testid="intent-confirmed">
          <div className="rp-kicker" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Check size={12} strokeWidth={2} aria-hidden="true" />
            已确认的研究方向
          </div>
          <p className="rp-chat__said" style={{ marginTop: 8 }}>
            <b>{direction.topic}</b>
          </p>
          <ul className="rp-chat__summary">
            <li>研究问题：{direction.purpose}</li>
            <li>范围：{direction.scope}</li>
            {direction.audience.length > 0 && <li>读者：{direction.audience}</li>}
            {direction.exclusions.length > 0 && <li>不研究：{direction.exclusions}</li>}
          </ul>
          <p className="rp-chat__note">这是你确认过的版本；对话已经结束，不能再改。任务卡会以它为主题。</p>
        </div>
      ) : direction !== null ? (
        <div style={{ marginTop: 18 }}>
          <DirectionEditor
            direction={direction}
            disabled={working || busy}
            dirty={dirty}
            draft={draft}
            onChange={setDraft}
            onSave={() => {
              if (patch !== null && saveGate.allowed) props.onSaveDirection(patch);
            }}
            onConfirm={() => {
              if (confirmGate.allowed) props.onConfirm(dirty ? patch : null);
            }}
            onDiscard={() => {
              setDraft(directionDraftOf(direction));
            }}
            saveReason={saveGate.reason}
            confirmReason={confirmGate.reason}
            canConfirm={intent.canConfirm}
          />
          <p className="rp-chat__note" style={{ marginTop: 8 }}>
            {intent.confirmQuestion}
          </p>
          {intent.openFields.length > 0 && (
            <p className="rp-chat__note" data-testid="intent-open-fields">
              这份方向还没有说清楚：{intent.openFields.map((field) => BRIEF_FIELD_NAMES[field] ?? field).join("、")}；任务卡建立后可以在研究范围里继续完善。
            </p>
          )}
        </div>
      ) : (
        <p className="rp-empty" style={{ marginTop: 18 }} data-testid="intent-no-proposal">
          还没有可确认的方向：继续说你的想法，或者直接说「请给出正式研究方向」。
        </p>
      )}

      {/* ------------------------------------------------------------- wait */}
      {waiting && (
        <div className="rp-note rp-note--quiet" style={{ marginTop: 14 }} data-testid="intent-task-wait">
          <span style={{ flex: 1 }}>
            <b>{waitText.title}</b>
            <br />
            {waitText.body}
          </span>
          {waitPhase !== "waiting" && (
            <span style={{ display: "flex", gap: 8 }}>
              <Button size="xs" variant="light" onClick={props.onRetryRead} data-testid="intent-task-reread">
                重新读取
              </Button>
              <Button size="xs" variant="subtle" onClick={props.onStartFresh}>
                用此方向新建探索
              </Button>
            </span>
          )}
        </div>
      )}

      {/* --------------------------------------------------------- composer */}
      {!confirmed && (
        <div style={{ marginTop: 22, maxWidth: 880 }}>
          {ready.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div className="rp-chat__note" style={{ marginBottom: 6 }}>
                随这条消息附上已入库文档（可选，只有已经入库的文件才能被引用）：
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
                {ready.map((document) => (
                  <Checkbox
                    key={document.documentId}
                    size="xs"
                    checked={attached.includes(document.documentId)}
                    onChange={(event) => {
                      const on = event.currentTarget.checked;
                      setAttached((current) =>
                        on ? [...current, document.documentId] : current.filter((id) => id !== document.documentId),
                      );
                    }}
                    label={document.title}
                    data-testid={`intent-attach-${document.documentId}`}
                  />
                ))}
              </div>
            </div>
          )}
          <div className="rp-composer">
            <Textarea
              ref={textarea}
              className="rp-composer__field"
              autosize
              minRows={1}
              maxRows={6}
              maxLength={MAX_MESSAGE_CHARS}
              value={answer}
              placeholder="回答助手的问题，或者直接说明你要研究什么…"
              onChange={(event) => {
                setAnswer(event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  send();
                }
              }}
              data-testid="intent-message-input"
            />
            <div className="rp-composer__side">
              <Button
                size="md"
                rightSection={busy || working ? <Loader size={14} color="white" /> : <Send size={15} />}
                disabled={!sendGate.allowed}
                onClick={send}
                data-testid="intent-message-send"
                title={sendGate.reason}
              >
                发送
              </Button>
            </div>
          </div>
          {!sendGate.allowed && sendGate.reason.length > 0 && (
            <p className="rp-chat__note" data-testid="intent-send-reason">
              {sendGate.reason}
            </p>
          )}
        </div>
      )}

      {/* ------------------------------------------------------- newer files */}
      {props.newerDocumentIds.length > 0 && !confirmed && (
        <Alert
          variant="light"
          color="gray"
          icon={<AlertTriangle size={14} />}
          title="有文档是在方向建议之后才入库的"
          style={{ marginTop: 16 }}
          data-testid="intent-newer-documents"
        >
          助手写上面那份建议时，这些文档还没有转换完成，因此建议里可能没有参考它们。你可以把它们带进下一轮对话，再说一次要不要调整方向。
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
            {props.newerDocumentIds.map((id) => {
              const document = intent.documents.find((entry) => entry.documentId === id);
              if (document === undefined) return null;
              return (
                <Button
                  key={id}
                  size="xs"
                  variant="light"
                  leftSection={<FileText size={13} />}
                  onClick={() => {
                    props.onUseDocument(document);
                  }}
                  data-testid={`intent-use-document-${id}`}
                >
                  使用「{document.title}」继续澄清
                </Button>
              );
            })}
          </div>
        </Alert>
      )}

      {/* --------------------------------------------------------- 材料 -- */}
      {props.children}
    </div>
  );
}

/** The brief's own field names, for the sentence about what is still open. */
const BRIEF_FIELD_NAMES: Readonly<Record<string, string>> = Object.freeze({
  topic: "主题",
  purpose: "研究问题 / 用途",
  audience: "读者",
  subjects: "比较对象",
  dimensions: "研究维度",
  focus: "关注点",
  exclusions: "不研究的内容",
  lengthTarget: "篇幅目标",
});

/**
 * The exploration page, wired to the store.
 *
 * Everything the panel needs is derived from the record the server sent and
 * from what this page has done since; nothing here keeps a second copy of the
 * research state.
 */
export function IntentRouteView(): React.ReactElement {
  const {
    intent,
    intentBusy,
    confirmedAt,
    busy,
    scope,
    uploadMarkdown,
    submitConversion,
    retryConversion,
    jobs,
    library,
    libraryBusy,
    refreshLibrary,
    mineru,
    mineruChecked,
    checkMineru,
    uploading,
    converting,
    retryingConversion,
    savingUsage,
    jobGone,
    setDocumentUsage,
    sendIntentMessage,
    saveIntentDirection,
    confirmIntent,
    refreshIntent,
    openStart,
    say,
  } = useApp();
  const [now, setNow] = useState(() => Date.now());
  const [prefill, setPrefill] = useState<{ readonly text: string; readonly token: number } | null>(null);
  const prefillToken = useRef(0);
  const useDocument = (document: LibraryDocumentView): void => {
    const text = `我想让你参考文档「${document.title}」（文档 ID：${document.documentId}）重新审视研究方向，看看是否需要调整。`;
    prefillToken.current += 1;
    setPrefill({ text, token: prefillToken.current });
    say("info", "已经把这句提示写进输入框；发送之后助手才会读到这份文档，方向不会自动更改。");
  };

  // The wait message counts up, so it needs a clock — but only while it is
  // being shown, and only for the sentence itself.
  useEffect(() => {
    if (confirmedAt === null || intent?.taskId !== null) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 5_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [confirmedAt, intent?.taskId]);

  if (intent === null || scope.kind !== "intent") {
    return (
      <div className="rp-loading" aria-live="polite">
        <div className="rp-kicker">研究方向澄清</div>
        <h1 className="rp-title">正在读取这段探索…</h1>
      </div>
    );
  }

  return (
    <IntentPanel
      intent={intent}
      busy={intentBusy}
      working={busy}
      confirmedAt={confirmedAt}
      now={now}
      newerDocumentIds={
        intent.confirmedDirection === null && intent.proposal !== null
          ? intent.documents
              .filter(
                (document) =>
                  document.status === "ready" &&
                  Date.parse(document.createdAt) > Date.parse(intent.proposal?.at ?? ""),
              )
              .map((document) => document.documentId)
          : []
      }
      onSend={(text, documentIds) => {
        setPrefill(null);
        void sendIntentMessage(text, documentIds);
      }}
      onSaveDirection={(patch) => {
        void saveIntentDirection(patch);
      }}
      onConfirm={(patch) => {
        void confirmIntent(patch, { attachmentsBusy: converting });
      }}
      onUseDocument={useDocument}
      onRetryRead={() => {
        void refreshIntent();
      }}
      onStartFresh={() => {
        openStart();
        say("info", "上一段探索仍然保留；在首页用它作为主题可以再开一段新的探索。");
      }}
      prefill={prefill}
    >
      <div style={{ marginTop: 20 }}>
        <DocumentUpload
          jobs={jobs}
          gone={jobGone}
          mineru={mineru}
          mineruChecked={mineruChecked}
          onCheckMineru={() => {
            void checkMineru();
          }}
          uploading={uploading}
          converting={converting}
          retrying={retryingConversion}
          canUpload
          onUploadMarkdown={(file) => {
            void uploadMarkdown(file);
          }}
          onSubmitConversion={(file) => {
            void submitConversion(file);
          }}
          onRetry={(jobId, accepted) => {
            void retryConversion(jobId, accepted);
          }}
        />
        <DocumentLibrary
          documents={library}
          busy={libraryBusy}
          saving={savingUsage}
          onRefresh={() => {
            void refreshLibrary();
          }}
          onSetUsage={(documentId, usage, revision) => {
            void setDocumentUsage(documentId, usage, revision);
          }}
          onUseDocument={useDocument}
        />
      </div>
    </IntentPanel>
  );
}
