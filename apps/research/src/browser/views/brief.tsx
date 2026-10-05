/**
 * The research brief: the task card as the object the conversation is about.
 *
 * The page is not a chat with a form beside it. The card is the subject — what
 * is compared, what will be answered, for whom — and the assistant appears only
 * as a marked contribution to it: which fields it proposed, why, and what will
 * happen once the reader confirms. Everything the page states about the coming
 * research is read from the project's own budget, so the numbers are the ones
 * the run will actually be held to.
 */

import { Button, Textarea } from "@mantine/core";
import { Check, ChevronRight, Info, RefreshCw, Sparkles } from "lucide-react";
import { useState } from "react";

import { useApp } from "../store.js";
import { navigate, projectHash } from "../router.js";
import { api } from "../api.js";

/** The card fields, in the order a reader would ask about them. */
function Field({
  label,
  children,
  ai,
  hint,
  lead,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
  readonly ai?: boolean;
  readonly hint?: string;
  readonly lead?: boolean;
}) {
  return (
    <div className={`rp-field${ai === true ? " rp-field--ai" : ""}`}>
      <div className="rp-field__label">
        {label}
        {ai === true && <span className="rp-mark-ai">助手建议</span>}
      </div>
      <div className={`rp-field__value${lead === true ? " rp-field__value--lead" : ""}`}>{children}</div>
      {hint !== undefined && <div className="rp-field__hint">{hint}</div>}
    </div>
  );
}

export function BriefView() {
  const { bundle, busy, act, say, openStart, startTopic } = useApp();
  const [regenerating, setRegenerating] = useState(false);
  const [revisedTopic, setRevisedTopic] = useState("");
  if (bundle === null) return null;
  const { task } = bundle;

  const confirm = async (): Promise<void> => {
    await act(() => api.confirm(task.id), "确认任务卡");
    navigate(projectHash(task.id, "research"));
  };

  const regenerate = async (): Promise<void> => {
    const value = revisedTopic.trim();
    if (value.length < 2) return;
    setRegenerating(false);
    setRevisedTopic("");
    openStart();
    await startTopic(value);
    say("info", "已用新主题重新建立任务卡；原项目仍保留在起始页的列表里。");
  };

  return (
    <div className="rp-page" style={{ maxWidth: 1120 }}>
      <div className="rp-kicker">研究任务</div>
      <h1 className="rp-title rp-title--clamp" title={task.topic} style={{ maxWidth: "42ch" }}>
        {task.topic}
      </h1>
      <p className="rp-lede">
        {task.confirmed
          ? "任务卡已确认。它决定了检索的方向、证据矩阵的坐标，以及报告必须回答的问题。"
          : "这份任务卡由助手根据你的主题提出。确认之前不会开始检索；确认之后，它就是矩阵与报告的结构。"}
      </p>

      <div className="rp-brief" style={{ marginTop: 34 }}>
        <div className="rp-brief__fields">
          <Field label="报告要回答的问题" ai lead>
            {task.purpose.length > 0 ? task.purpose : "—"}
          </Field>

          <Field label="用途与读者" ai hint="读者决定了报告的深度与术语密度。">
            {task.audience.length > 0 ? task.audience : "—"}
          </Field>

          <Field label="比较对象" ai hint="同一问题在这些对象上分别是什么情况——矩阵的列。">
            <div>
              {bundle.subjects.map((subject) => (
                <div key={subject.id} className="rp-subject">
                  <div className="rp-subject__name">{subject.name}</div>
                  <div className="rp-subject__note">
                    {subject.note !== undefined && subject.note.length > 0 ? subject.note : "—"}
                  </div>
                </div>
              ))}
            </div>
          </Field>

          <Field label="研究维度" ai hint="每个维度是一个要回答的问题，而不是一个名词——矩阵的行。">
            <div className="rp-qlist">
              {bundle.dimensions.map((dimension) => (
                <div key={dimension.id} className="rp-q">
                  <div>
                    {dimension.name}
                    <div className="rp-q__note">{dimension.question}</div>
                  </div>
                </div>
              ))}
            </div>
          </Field>

          {task.focus.length > 0 && (
            <Field label="关注点">
              <div className="rp-chips">
                {task.focus.map((item) => (
                  <span key={item} className="rp-chipped">
                    {item}
                  </span>
                ))}
              </div>
            </Field>
          )}

          {task.exclusions.length > 0 && <Field label="不纳入的范围">{task.exclusions}</Field>}

          <Field label="报告结构" hint="报告会按这条认知路线写：先讲清楚每个对象是什么，再在相同条件下比较。">
            <div className="rp-qlist">
              {bundle.structure.map((section) => (
                <div key={section.id} className="rp-q">
                  <div>
                    {section.title}
                    <div className="rp-q__note">{section.question}</div>
                  </div>
                </div>
              ))}
            </div>
          </Field>
        </div>

        <aside className="rp-brief__aside">
          {!task.confirmed ? (
            <div className="rp-aside-card">
              <h3>助手说明</h3>
              <div className="rp-ask__from">依据你给出的主题</div>
              <p style={{ fontSize: 13.5, color: "var(--rp-ink-2)", margin: "0 0 12px", lineHeight: 1.6 }}>
                比较对象取「{bundle.subjects.map((subject) => subject.name).join(" / ")}」，共{" "}
                {bundle.dimensions.length} 个维度。这一轮的研究预算：检索最多 {bundle.budget.maxSearches} 次、读取最多{" "}
                {bundle.budget.maxReads} 次、定向补查最多 {bundle.budget.maxGapRounds} 轮。
              </p>
              <p style={{ fontSize: 13, color: "var(--rp-ink-3)", margin: 0, lineHeight: 1.6 }}>
                任务卡由助手提出，结构一经确认就不再自动改写：后续的变化都发生在报告上，并由你逐次接受。
              </p>
              <Button
                fullWidth
                mt="md"
                disabled={busy}
                onClick={() => {
                  void confirm();
                }}
                data-testid="confirm-card"
              >
                确认任务卡并开始研究
              </Button>
              <Button
                fullWidth
                mt="xs"
                variant="subtle"
                leftSection={<RefreshCw size={14} />}
                onClick={() => {
                  setRegenerating((open) => !open);
                }}
              >
                换个说法重新生成
              </Button>
              {regenerating && (
                <>
                  <Textarea
                    mt="sm"
                    size="sm"
                    autosize
                    minRows={2}
                    placeholder="把主题写得更具体，例如指定要比较的对象或场景"
                    value={revisedTopic}
                    onChange={(event) => {
                      setRevisedTopic(event.currentTarget.value);
                    }}
                  />
                  <Button
                    fullWidth
                    mt="xs"
                    variant="light"
                    disabled={revisedTopic.trim().length < 2}
                    onClick={() => {
                      void regenerate();
                    }}
                  >
                    用新主题建立新的任务卡
                  </Button>
                  <p style={{ fontSize: 12, color: "var(--rp-ink-3)", marginTop: 8, marginBottom: 0, lineHeight: 1.55 }}>
                    这会产生一个新项目；当前这份任务卡保持不动，仍留在起始页的列表里。
                  </p>
                </>
              )}
            </div>
          ) : (
            <div className="rp-aside-card" data-testid="card-confirmed">
              <h3>任务卡已确认</h3>
              <div className="rp-factline" style={{ marginBottom: 10 }}>
                <Check size={15} color="var(--rp-verified)" />
                <span>结构已锁定为检索与报告的依据</span>
              </div>
              <Button
                fullWidth
                variant="light"
                rightSection={<ChevronRight size={14} />}
                onClick={() => {
                  navigate(projectHash(task.id, "research"));
                }}
              >
                去看证据矩阵
              </Button>
            </div>
          )}

          <div className="rp-aside-card">
            <h3>项目</h3>
            <dl className="rp-kv">
              <dt>建立时间</dt>
              <dd>{new Date(task.createdAt).toLocaleString("zh-CN", { hour12: false })}</dd>
              <dt>最近更新</dt>
              <dd>{new Date(task.updatedAt).toLocaleString("zh-CN", { hour12: false })}</dd>
              <dt>篇幅目标</dt>
              <dd>{task.lengthTarget.length > 0 ? task.lengthTarget : "—"}</dd>
              <dt>状态</dt>
              <dd>{task.confirmed ? "已确认" : "待确认"}</dd>
            </dl>
          </div>

          <div className="rp-note rp-note--quiet">
            <Info size={14} style={{ flex: "none", marginTop: 2 }} />
            <span>
              <Sparkles size={12} style={{ verticalAlign: -1, marginRight: 4 }} />
              标记为「助手建议」的字段是助手根据主题提出的；确认后它们就是这次研究的正式结构。
            </span>
          </div>

        </aside>
      </div>
    </div>
  );
}
