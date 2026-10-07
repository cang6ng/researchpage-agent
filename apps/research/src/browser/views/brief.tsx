/**
 * The research brief: the plan, before there is a research.
 *
 * The page has one subject — the brief — and two ways to work on it. Structured
 * Mode edits the plan the agent proposed, field by field, in place: the question
 * it will answer, who it is for, what is being compared, which questions the
 * comparison has to answer. Guided Mode asks one decision at a time, the way a
 * planning session does, and writes the answer to the same brief.
 *
 * There is deliberately no second model. Both modes post to the same draft, the
 * page reads from the same one, and switching modes is a re-read rather than a
 * copy — so a field a guided answer changed is already there when the structured
 * editor is opened, and what the next guided question is asked against is what
 * the reader last typed.
 *
 * Two rules run through the page. Nothing is sent until the reader is done with
 * a field, and every send carries the version it was made against: if the brief
 * moved underneath, the page says so, keeps the reader's words on screen, and
 * asks them to decide again instead of overwriting either side.
 */

import { Button, Menu, SegmentedControl, Tooltip } from "@mantine/core";
import { ArrowRight, Check, Info, MoreHorizontal, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  BRIEF_FIELD_LABELS,
  ApiError,
  api,
  type BriefFieldName,
  type BriefPatch,
  type BriefView,
} from "../api.js";
import {
  confirmSummary,
  dimensionRowsOf,
  dimensionsCommittable,
  dimensionsPatch,
  moved,
  problemsByField,
  sameDimensions,
  sameSubjects,
  subjectRowsOf,
  subjectsCommittable,
  subjectsPatch,
  type DimensionRow,
  type SubjectRow,
} from "../brief-logic.js";
import { GuidePanel } from "../components/brief-guide.js";
import {
  AddRow,
  DimensionRowView,
  FieldShell,
  FocusField,
  SubjectRowView,
  TextField,
  type SaveState,
} from "../components/brief-fields.js";
import { navigate, projectHash } from "../router.js";
import { useApp } from "../store.js";

type Mode = "structured" | "guided";

/** The plain-text fields, named so a patch can be built without guessing. */
type TextFieldName = "topic" | "purpose" | "audience" | "exclusions" | "lengthTarget";

const TEXT_FIELDS: readonly TextFieldName[] = ["topic", "purpose", "audience", "exclusions", "lengthTarget"];

function isTextField(field: BriefFieldName): field is TextFieldName {
  return (TEXT_FIELDS as readonly string[]).includes(field);
}

function textValueOf(brief: BriefView, field: TextFieldName): string {
  switch (field) {
    case "topic":
      return brief.topic;
    case "purpose":
      return brief.purpose;
    case "audience":
      return brief.audience;
    case "exclusions":
      return brief.exclusions;
    case "lengthTarget":
      return brief.lengthTarget;
  }
}

function textPatchOf(field: TextFieldName, value: string): BriefPatch {
  switch (field) {
    case "topic":
      return { topic: value };
    case "purpose":
      return { purpose: value };
    case "audience":
      return { audience: value };
    case "exclusions":
      return { exclusions: value };
    case "lengthTarget":
      return { lengthTarget: value };
  }
}

/** The reader's own uncommitted words, per field. */
interface Drafts {
  readonly topic?: string;
  readonly purpose?: string;
  readonly audience?: string;
  readonly exclusions?: string;
  readonly lengthTarget?: string;
  readonly focus?: readonly string[];
  readonly subjects?: readonly SubjectRow[];
  readonly dimensions?: readonly DimensionRow[];
}

function draftOr<T>(draft: T | undefined, server: T): T {
  return draft === undefined ? server : draft;
}

const LENGTH_SUGGESTIONS: readonly string[] = ["约 3 页", "4–6 页", "8 页以上"];
const SAVED_NOTE_MS = 2200;

export function BriefView() {
  const { bundle, busy, say, openStart, startTopic, refresh } = useApp();
  const [mode, setMode] = useState<Mode>("structured");
  const [drafts, setDrafts] = useState<Drafts>({});
  const [saveStates, setSaveStates] = useState<Readonly<Partial<Record<BriefFieldName, SaveState>>>>({});
  const [saveNotes, setSaveNotes] = useState<Readonly<Partial<Record<BriefFieldName, string>>>>({});
  const [regenerating, setRegenerating] = useState(false);
  const [revisedTopic, setRevisedTopic] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [guideStale, setGuideStale] = useState<string | null>(null);
  const timers = useRef<number[]>([]);

  useEffect(
    () => () => {
      for (const timer of timers.current) window.clearTimeout(timer);
    },
    [],
  );

  const brief: BriefView | undefined = bundle?.brief;
  const taskId = bundle?.task.id ?? "";

  const markFields = useCallback((fields: readonly BriefFieldName[], state: SaveState | null, note = ""): void => {
    setSaveStates((current) => {
      const next = { ...current };
      for (const field of fields) {
        if (state === null) delete next[field];
        else next[field] = state;
      }
      return next;
    });
    if (note.length > 0) {
      setSaveNotes((current) => {
        const next = { ...current };
        for (const field of fields) next[field] = note;
        return next;
      });
    }
  }, []);

  const dropDrafts = useCallback((fields: readonly BriefFieldName[]): void => {
    setDrafts((current) => {
      const next = { ...current };
      for (const field of fields) delete next[field];
      return next;
    });
  }, []);

  const guide = brief?.guide;
  const activeQuestionId = guide?.active?.questionId ?? null;
  const guideComplete = guide?.complete ?? false;

  // A question the application is still writing arrives with the next poll; a
  // session it decided was over ends instead of waiting for a question that is
  // never coming.
  useEffect(() => {
    if (activeQuestionId !== null || guideComplete) setWaiting(false);
  }, [activeQuestionId, guideComplete]);

  const problems = useMemo(() => problemsByField(brief?.validation.problems ?? []), [brief?.validation.problems]);
  const problemsFor = useCallback(
    (field: BriefFieldName): readonly string[] => problems.find((entry) => entry.field === field)?.problems ?? [],
    [problems],
  );
  const draftProblems = problems.find((entry) => entry.field === null)?.problems ?? [];

  /**
   * One edit, committed against the version it was read from.
   *
   * The reader's draft is dropped only once the server has answered and the
   * project has been re-read, so the field never flickers back to a value the
   * application already replaced.
   */
  const save = useCallback(
    async (patch: BriefPatch, fields: readonly BriefFieldName[]): Promise<boolean> => {
      if (brief === undefined) return false;
      markFields(fields, "saving", "");
      try {
        await api.patchBrief(taskId, { expectedVersion: brief.version, patch });
        await refresh();
        dropDrafts(fields);
        markFields(fields, "saved");
        const timer = window.setTimeout(() => {
          markFields(fields, null);
        }, SAVED_NOTE_MS);
        timers.current.push(timer);
        return true;
      } catch (error) {
        if (error instanceof ApiError && error.stale === true) {
          markFields(fields, "stale", "研究任务刚刚发生了变化，请重新确认这一项。");
          await refresh();
          return false;
        }
        markFields(fields, "error", error instanceof Error ? error.message : "没有保存");
        await refresh();
        return false;
      }
    },
    [brief, dropDrafts, markFields, refresh, taskId],
  );

  const focusTo = useCallback((field: BriefFieldName | null): void => {
    if (field === null) return;
    const node = window.document.querySelector(`[data-brief-field="${field}"]`);
    node?.scrollIntoView({ behavior: "smooth", block: "center" });
    const inside = node?.querySelector("input, textarea, button");
    if (inside instanceof HTMLElement) inside.focus();
  }, []);

  if (bundle === null || brief === undefined) return null;

  const readonly = brief.readonly;
  const subjectRows = draftOr(drafts.subjects, subjectRowsOf(brief));
  const dimensionRows = draftOr(drafts.dimensions, dimensionRowsOf(brief));
  const focusValues = draftOr(drafts.focus, brief.focus);

  const commitText = (field: TextFieldName, value: string): void => {
    if (value === textValueOf(brief, field)) {
      dropDrafts([field]);
      return;
    }
    setDrafts((current) => {
      switch (field) {
        case "topic":
          return { ...current, topic: value };
        case "purpose":
          return { ...current, purpose: value };
        case "audience":
          return { ...current, audience: value };
        case "exclusions":
          return { ...current, exclusions: value };
        case "lengthTarget":
          return { ...current, lengthTarget: value };
      }
    });
    void save(textPatchOf(field, value), [field]);
  };

  const commitSubjects = (rows: readonly SubjectRow[]): void => {
    setDrafts((current) => ({ ...current, subjects: rows }));
    if (!subjectsCommittable(rows) || sameSubjects(rows, brief)) return;
    void save(subjectsPatch(rows), ["subjects"]);
  };

  const commitDimensions = (rows: readonly DimensionRow[]): void => {
    setDrafts((current) => ({ ...current, dimensions: rows }));
    if (!dimensionsCommittable(rows) || sameDimensions(rows, brief)) return;
    void save(dimensionsPatch(rows), ["dimensions"]);
  };

  /** Send the reader's pinned words again, against the version that is current now. */
  const retry = (field: BriefFieldName): void => {
    const pinned = drafts;
    switch (field) {
      case "subjects":
        if (pinned.subjects !== undefined) void save(subjectsPatch(pinned.subjects), ["subjects"]);
        return;
      case "dimensions":
        if (pinned.dimensions !== undefined) void save(dimensionsPatch(pinned.dimensions), ["dimensions"]);
        return;
      case "focus":
        if (pinned.focus !== undefined) void save({ focus: pinned.focus }, ["focus"]);
        return;
      default: {
        if (!isTextField(field)) return;
        const value = pinned[field];
        if (value !== undefined) void save(textPatchOf(field, value), [field]);
      }
    }
  };

  const confirm = async (): Promise<void> => {
    if (!brief.validation.valid) {
      say("warn", "这份简报还有没补齐的地方；补上之后才能开始研究。");
      focusTo(problemsByField(brief.validation.problems)[0]?.field ?? null);
      return;
    }
    try {
      await api.confirm(bundle.task.id, { expectedVersion: brief.version });
      await refresh();
      navigate(projectHash(bundle.task.id, "research"));
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        say("warn", error.message.length > 0 ? error.message : "确认被拒绝：简报还不完整。");
        await refresh();
        focusTo(problemsByField(error.problems)[0]?.field ?? null);
        return;
      }
      say("error", error instanceof Error ? error.message : "确认失败");
    }
  };

  const startGuide = async (): Promise<void> => {
    setGuideStale(null);
    try {
      const result = await api.guideNext(bundle.task.id);
      // A question run is started asynchronously; re-reading now is what shows
      // the conversation its own next turn as soon as it exists, and it is also
      // what stops the panel's own recovery from firing while a run is alive.
      await refresh();
      if (result.complete || result.question !== undefined) return;
      setWaiting(true);
    } catch (error) {
      say("error", error instanceof Error ? error.message : "没有拿到引导问题");
    }
  };

  const answer = async ({
    optionIds,
    freeText,
  }: {
    readonly optionIds: readonly string[];
    readonly freeText: string;
  }): Promise<void> => {
    const question = guide?.active;
    if (question === undefined || question === null) return;
    setGuideStale(null);
    try {
      const result = await api.guideAnswer(bundle.task.id, {
        questionId: question.questionId,
        expectedVersion: brief.version,
        ...(optionIds.length === 0 ? {} : { optionIds }),
        ...(freeText.trim().length === 0 ? {} : { freeText }),
      });
      await refresh();
      if (!result.complete) setWaiting(true);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setGuideStale(
          error.stale
            ? "研究任务刚刚发生了变化，请重新确认这一项。"
            : error.message.length > 0
              ? error.message
              : "这个问题已经不再适用，请重新获取。",
        );
        await refresh();
        return;
      }
      say("error", error instanceof Error ? error.message : "没有提交成功");
    }
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

  const staleField =
    (Object.keys(saveStates) as BriefFieldName[]).find((field) => saveStates[field] === "stale") ?? null;

  return (
    <div className="rp-page">
      <header className="rp-brief__head">
        <div className="rp-kicker">研究任务</div>
        <h1 className="rp-title rp-title--clamp" title={brief.topic} style={{ maxWidth: "44ch" }}>
          {brief.topic}
        </h1>
        <p className="rp-lede" style={{ maxWidth: "70ch" }}>
          {readonly
            ? "这份简报已经确认：它决定了检索的方向、证据矩阵的坐标，以及报告必须回答的问题。之后的变化都发生在报告上，并由你逐次接受。"
            : "助手先给出一个完整的研究方案，你在此基础上直接修改，也可以让它一次只问一个关键决策。两种方式改的是同一份简报，确认之前不会开始检索。"}
        </p>
      </header>

      {readonly ? (
        <ConfirmedBrief brief={brief} taskId={bundle.task.id} hasReport={bundle.hasReport} />
      ) : (
        <>
          <div className="rp-brief__modes">
            <SegmentedControl
              size="sm"
              value={mode}
              onChange={(value) => {
                setMode(value === "guided" ? "guided" : "structured");
                // Switching modes re-reads: the two modes are two ways of
                // working on one draft, never two copies of it.
                void refresh();
              }}
              data={[
                { value: "structured", label: "结构化编辑" },
                { value: "guided", label: "智能引导" },
              ]}
              data-testid="brief-mode"
            />
            <div className="rp-brief__meta">
              {staleField !== null && (
                <span className="rp-chip rp-chip--limited">「{BRIEF_FIELD_LABELS[staleField]}」待重新确认</span>
              )}
              <span className="rp-meta" data-testid="brief-version">
                简报 v{brief.version}
              </span>
            </div>
          </div>

          {draftProblems.length > 0 && (
            <div className="rp-note rp-note--warn" data-testid="brief-draft-problems">
              <Info size={14} style={{ flex: "none", marginTop: 2 }} />
              <span>{draftProblems.join("；")}</span>
            </div>
          )}

          {staleField !== null && (
            <div className="rp-note rp-note--warn" data-testid="brief-stale">
              <Info size={14} style={{ flex: "none", marginTop: 2 }} />
              <span style={{ flex: 1 }}>
                {saveNotes[staleField] ?? "研究任务刚刚发生了变化，请重新确认这一项。"}
                「{BRIEF_FIELD_LABELS[staleField]}」还没有写入，页面不会用你的输入覆盖这次变化。
              </span>
              <Button
                size="compact-xs"
                variant="default"
                onClick={() => {
                  retry(staleField);
                }}
                data-testid="retry-stale"
              >
                用最新版本重试
              </Button>
              <Button
                size="compact-xs"
                variant="subtle"
                onClick={() => {
                  dropDrafts([staleField]);
                  markFields([staleField], null);
                }}
              >
                放弃我的修改
              </Button>
            </div>
          )}

          {mode === "guided" ? (
            <GuidePanel
              brief={brief}
              busy={busy}
              waiting={waiting}
              settledGuideRuns={
                bundle.runs.filter((run) => run.stage === "guide" && run.status !== "running").length
              }
              staleNote={guideStale}
              onAsk={() => {
                void startGuide();
              }}
              onAnswer={(input) => {
                void answer(input);
              }}
              onViewStructured={() => {
                setMode("structured");
                void refresh();
              }}
              onConfirm={() => {
                void confirm();
              }}
            />
          ) : (
            <div className="rp-brief__fields">
              <TextField
                field="purpose"
                label="报告要回答的问题"
                hint="这是这份研究的唯一依据：报告、矩阵与补查都以它为准。"
                value={draftOr(drafts.purpose, brief.purpose)}
                placeholder="写成一个可以回答的问题"
                state={brief.fieldStates.purpose}
                saveState={saveStates.purpose ?? "idle"}
                saveNote={saveNotes.purpose ?? ""}
                problems={problemsFor("purpose")}
                multiline
                commit={(next) => {
                  commitText("purpose", next);
                }}
              />

              <TextField
                field="audience"
                label="用途与读者"
                hint="读者决定了报告的深度与术语密度。"
                value={draftOr(drafts.audience, brief.audience)}
                placeholder="例如：给组会做技术选型汇报"
                state={brief.fieldStates.audience}
                saveState={saveStates.audience ?? "idle"}
                saveNote={saveNotes.audience ?? ""}
                problems={problemsFor("audience")}
                commit={(next) => {
                  commitText("audience", next);
                }}
              />

              <FieldShell
                field="subjects"
                label="比较对象"
                hint="同一问题在这些对象上分别是什么情况——矩阵的列。改一个名字不会丢掉它已经积累的材料。"
                state={brief.fieldStates.subjects}
                saveState={saveStates.subjects ?? "idle"}
                saveNote={saveNotes.subjects ?? ""}
                problems={problemsFor("subjects")}
                invalid={problemsFor("subjects").length > 0}
                wide
                actions={
                  <span className="rp-brief-field__count">
                    推荐 {brief.blueprint.recommendedSubjects[0]}–{brief.blueprint.recommendedSubjects[1]} 个
                  </span>
                }
              >
                <div className="rp-rows" data-testid="subject-rows">
                  {subjectRows.length === 0 && <p className="rp-muted">还没有比较对象；这份研究至少要有一个。</p>}
                  {subjectRows.map((row, index) => (
                    <SubjectRowView
                      key={row.id ?? `new-${String(index)}`}
                      row={row}
                      index={index}
                      count={subjectRows.length}
                      readOnly={false}
                      onChange={(next) => {
                        setDrafts((current) => ({
                          ...current,
                          subjects: subjectRows.map((candidate, at) => (at === index ? next : candidate)),
                        }));
                      }}
                      onCommit={() => {
                        commitSubjects(subjectRows);
                      }}
                      onMove={(direction) => {
                        commitSubjects(moved(subjectRows, index, index + direction));
                      }}
                      onRemove={() => {
                        commitSubjects(subjectRows.filter((_, at) => at !== index));
                      }}
                    />
                  ))}
                </div>
                <div className="rp-rows__foot">
                  <AddRow
                    label="加一个比较对象"
                    testId="add-subject"
                    onClick={() => {
                      setDrafts((current) => ({ ...current, subjects: [...subjectRows, { name: "", note: "" }] }));
                    }}
                  />
                  <ApplyChanges
                    testId="apply-subjects"
                    pending={!sameSubjects(subjectRows, brief)}
                    ready={subjectsCommittable(subjectRows)}
                    onApply={() => {
                      commitSubjects(subjectRows);
                    }}
                  />
                </div>
              </FieldShell>

              <FieldShell
                field="dimensions"
                label="研究维度"
                hint="每个维度是一个要回答的问题，而不是一个名词——矩阵的行。"
                state={brief.fieldStates.dimensions}
                saveState={saveStates.dimensions ?? "idle"}
                saveNote={saveNotes.dimensions ?? ""}
                problems={problemsFor("dimensions")}
                invalid={problemsFor("dimensions").length > 0}
                wide
                actions={
                  <span className="rp-brief-field__count">
                    至少 {brief.blueprint.minimumDimensions} · 推荐 {brief.blueprint.recommendedDimensions[0]}–
                    {brief.blueprint.recommendedDimensions[1]}
                  </span>
                }
              >
                <div className="rp-rows" data-testid="dimension-rows">
                  {dimensionRows.length === 0 && (
                    <p className="rp-muted">还没有研究维度；这份比较至少要 {brief.blueprint.minimumDimensions} 个。</p>
                  )}
                  {dimensionRows.map((row, index) => (
                    <DimensionRowView
                      key={row.id ?? `new-${String(index)}`}
                      row={row}
                      index={index}
                      count={dimensionRows.length}
                      readOnly={false}
                      onChange={(next) => {
                        setDrafts((current) => ({
                          ...current,
                          dimensions: dimensionRows.map((candidate, at) => (at === index ? next : candidate)),
                        }));
                      }}
                      onCommit={() => {
                        commitDimensions(dimensionRows);
                      }}
                      onMove={(direction) => {
                        commitDimensions(moved(dimensionRows, index, index + direction));
                      }}
                      onRemove={() => {
                        commitDimensions(dimensionRows.filter((_, at) => at !== index));
                      }}
                    />
                  ))}
                </div>
                <div className="rp-rows__foot">
                  <AddRow
                    label="加一个研究维度"
                    testId="add-dimension"
                    onClick={() => {
                      setDrafts((current) => ({ ...current, dimensions: [...dimensionRows, { name: "", question: "" }] }));
                    }}
                  />
                  <ApplyChanges
                    testId="apply-dimensions"
                    pending={!sameDimensions(dimensionRows, brief)}
                    ready={dimensionsCommittable(dimensionRows)}
                    onApply={() => {
                      commitDimensions(dimensionRows);
                    }}
                  />
                </div>
              </FieldShell>

              <FocusField
                field="focus"
                label="关注点"
                hint="这次比较要特别盯住的地方；它写进阶段指令，但不改变报告结构。"
                values={focusValues}
                state={brief.fieldStates.focus}
                saveState={saveStates.focus ?? "idle"}
                saveNote={saveNotes.focus ?? ""}
                problems={problemsFor("focus")}
                commit={(next) => {
                  setDrafts((current) => ({ ...current, focus: next }));
                  void save({ focus: next }, ["focus"]);
                }}
              />

              <TextField
                field="exclusions"
                label="不研究的内容"
                hint="写明不做什么，比写清做什么更能收窄检索范围。"
                value={draftOr(drafts.exclusions, brief.exclusions)}
                placeholder="例如：不讨论具体实现代码，不比较私有产品"
                state={brief.fieldStates.exclusions}
                saveState={saveStates.exclusions ?? "idle"}
                saveNote={saveNotes.exclusions ?? ""}
                problems={problemsFor("exclusions")}
                commit={(next) => {
                  commitText("exclusions", next);
                }}
              />

              <TextField
                field="lengthTarget"
                label="篇幅目标"
                hint="写作预算，不是硬性校验；它会作为阶段指令交给撰写报告的步骤。"
                value={draftOr(drafts.lengthTarget, brief.lengthTarget)}
                placeholder="例如：约 4 页"
                state={brief.fieldStates.lengthTarget}
                saveState={saveStates.lengthTarget ?? "idle"}
                saveNote={saveNotes.lengthTarget ?? ""}
                problems={problemsFor("lengthTarget")}
                suggestions={LENGTH_SUGGESTIONS}
                commit={(next) => {
                  commitText("lengthTarget", next);
                }}
              />

              <section className="rp-brief-field" data-brief-field="structure">
                <div className="rp-brief-field__head">
                  <h3 className="rp-brief-field__label">报告结构</h3>
                  <span className="rp-brief-field__count">由研究蓝图派生 · 只读</span>
                </div>
                <div className="rp-structure">
                  {brief.reportStructure.map((section, index) => (
                    <div key={section.id} className="rp-structure__row">
                      <span className="rp-structure__num">{String(index + 1).padStart(2, "0")}</span>
                      <span>
                        <b>{section.title}</b>
                        <span className="rp-structure__q">{section.question}</span>
                      </span>
                      {section.required && <span className="rp-chip rp-chip--quiet">必需</span>}
                    </div>
                  ))}
                </div>
                <p className="rp-brief-field__hint">
                  报告的认知路线由所选的比较蓝图决定，不随简报改写：你改的是要研究什么，不是报告的章节。
                </p>
              </section>
            </div>
          )}

          <ConfirmBar
            brief={brief}
            busy={busy}
            onConfirm={() => {
              void confirm();
            }}
            regenerating={regenerating}
            setRegenerating={setRegenerating}
            revisedTopic={revisedTopic}
            setRevisedTopic={setRevisedTopic}
            onRegenerate={() => {
              void regenerate();
            }}
          />
        </>
      )}
    </div>
  );
}

/** A list field's explicit commit, for a reader who changed several rows at once. */
function ApplyChanges({
  testId,
  pending,
  ready,
  onApply,
}: {
  readonly testId: string;
  readonly pending: boolean;
  readonly ready: boolean;
  readonly onApply: () => void;
}) {
  return (
    <span className="rp-rows__apply">
      <span className="rp-muted">
        {!ready ? "新加的一项还没有名字" : pending ? "有还没写入的改动" : "与简报一致"}
      </span>
      <Button
        size="compact-xs"
        variant="light"
        disabled={!pending || !ready}
        onClick={onApply}
        data-testid={testId}
      >
        应用修改
      </Button>
    </span>
  );
}

const FIELD_ORDER: readonly BriefFieldName[] = [
  "purpose",
  "audience",
  "subjects",
  "dimensions",
  "focus",
  "exclusions",
  "lengthTarget",
];

/**
 * The draft's own summary and the one action that matters.
 *
 * The sentence and the button read the same brief the request is posted with,
 * so what the reader agreed to and what they asked for cannot drift apart.
 */
function ConfirmBar({
  brief,
  busy,
  onConfirm,
  regenerating,
  setRegenerating,
  revisedTopic,
  setRevisedTopic,
  onRegenerate,
}: {
  readonly brief: BriefView;
  readonly busy: boolean;
  readonly onConfirm: () => void;
  readonly regenerating: boolean;
  readonly setRegenerating: (next: boolean) => void;
  readonly revisedTopic: string;
  readonly setRevisedTopic: (next: string) => void;
  readonly onRegenerate: () => void;
}) {
  const ready = brief.validation.valid;
  return (
    <div className="rp-confirmbar" data-testid="brief-confirm-bar">
      <div className="rp-confirmbar__what">
        <div className="rp-kicker">确认之后</div>
        <p data-testid="confirm-summary">
          这次研究将围绕 <b>{confirmSummary(brief)}</b> 进行；确认后简报即锁定，检索、矩阵与报告都以它为准。
        </p>
      </div>
      <div className="rp-confirmbar__actions">
        <Menu shadow="md" position="top-end" width={300}>
          <Menu.Target>
            <Button variant="subtle" leftSection={<MoreHorizontal size={15} />} aria-label="更多" px="sm">
              更多
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Label>跳到某一项</Menu.Label>
            {FIELD_ORDER.map((field) => (
              <Menu.Item
                key={field}
                onClick={() => {
                  window.document
                    .querySelector(`[data-brief-field="${field}"]`)
                    ?.scrollIntoView({ behavior: "smooth", block: "center" });
                }}
              >
                {BRIEF_FIELD_LABELS[field]}
              </Menu.Item>
            ))}
            <Menu.Divider />
            <Menu.Item
              leftSection={<RefreshCw size={14} />}
              onClick={() => {
                setRegenerating(!regenerating);
              }}
            >
              换一个主题重新建立任务卡
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
        <Tooltip
          label={
            ready
              ? "用当前简报开始检索与读取；确认后方向不能再改"
              : "先补上提示里缺的项，再开始研究"
          }
          withArrow={false}
        >
          <Button
            size="md"
            loading={busy}
            leftSection={ready ? <ArrowRight size={15} /> : <Info size={15} />}
            variant={ready ? "filled" : "default"}
            onClick={onConfirm}
            data-testid="confirm-card"
          >
            {ready ? "确认任务并开始研究" : "还有未补齐的项"}
          </Button>
        </Tooltip>
      </div>
      {regenerating && (
        <div className="rp-confirmbar__regen">
          <span className="rp-muted">
            用新的说法重新建立任务卡会产生一个新项目；当前这份简报保持不动，仍留在起始页的列表里。
          </span>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <input
              className="rp-input"
              placeholder="把主题写得更具体，例如指定要比较的对象或场景"
              value={revisedTopic}
              onChange={(event) => {
                setRevisedTopic(event.currentTarget.value);
              }}
            />
            <Button size="compact-sm" variant="light" disabled={revisedTopic.trim().length < 2} onClick={onRegenerate}>
              用新主题建立新的任务卡
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * A confirmed brief: the plan as it was agreed, and nowhere to change it.
 *
 * Editing a direction that research has already been aimed at is a different
 * feature with different consequences, and a page that left the inputs enabled
 * would be promising something the product does not do.
 */
function ConfirmedBrief({
  brief,
  taskId,
  hasReport,
}: {
  readonly brief: BriefView;
  readonly taskId: string;
  readonly hasReport: boolean;
}) {
  return (
    <div className="rp-brief__locked" data-testid="card-confirmed">
      <div className="rp-note rp-note--quiet">
        <Check size={15} color="var(--rp-verified)" style={{ flex: "none", marginTop: 2 }} />
        <span style={{ flex: 1 }} data-testid="confirmed-note">
          研究任务已确认。它已锁定为检索与报告的依据；要改方向，请在报告上发起修改，由你逐次接受。
        </span>
      </div>

      <div className="rp-brief__fields rp-brief__fields--locked">
        <div className="rp-brief-field" data-brief-field="purpose">
          <div className="rp-brief-field__head">
            <h3 className="rp-brief-field__label">报告要回答的问题</h3>
          </div>
          <div className="rp-brief-field__body rp-brief-field__body--lead">{brief.purpose}</div>
        </div>
        <div className="rp-brief-field" data-brief-field="audience">
          <div className="rp-brief-field__head">
            <h3 className="rp-brief-field__label">用途与读者</h3>
          </div>
          <div className="rp-brief-field__body">{brief.audience}</div>
        </div>
        <div className="rp-brief-field" data-brief-field="subjects">
          <div className="rp-brief-field__head">
            <h3 className="rp-brief-field__label">比较对象</h3>
          </div>
          <div className="rp-rows">
            {brief.subjects.map((subject, index) => (
              <div key={subject.id} className="rp-row">
                <div className="rp-row__index">{String(index + 1).padStart(2, "0")}</div>
                <div className="rp-row__fields">
                  <div className="rp-row__name rp-row__name--text">{subject.name}</div>
                  <div className="rp-row__note rp-row__note--text">{subject.note ?? "—"}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="rp-brief-field" data-brief-field="dimensions">
          <div className="rp-brief-field__head">
            <h3 className="rp-brief-field__label">研究维度</h3>
          </div>
          <div className="rp-rows">
            {brief.dimensions.map((dimension, index) => (
              <div key={dimension.id} className="rp-row rp-row--dimension">
                <div className="rp-row__index">{String(index + 1).padStart(2, "0")}</div>
                <div className="rp-row__fields">
                  <div className="rp-row__name rp-row__name--text">{dimension.name}</div>
                  <div className="rp-row__question rp-row__question--text">{dimension.question}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
        {(brief.focus.length > 0 || brief.exclusions.length > 0 || brief.lengthTarget.length > 0) && (
          <div className="rp-brief-field" data-brief-field="range">
            <div className="rp-brief-field__head">
              <h3 className="rp-brief-field__label">关注点与范围</h3>
            </div>
            <div className="rp-brief-field__body">
              {brief.focus.length > 0 && (
                <div className="rp-chips" style={{ marginBottom: 10 }}>
                  {brief.focus.map((item) => (
                    <span key={item} className="rp-chipped">
                      {item}
                    </span>
                  ))}
                </div>
              )}
              {brief.exclusions.length > 0 && (
                <p style={{ margin: "0 0 8px" }}>
                  <span className="rp-muted">不研究：</span>
                  {brief.exclusions}
                </p>
              )}
              {brief.lengthTarget.length > 0 && (
                <p style={{ margin: 0 }}>
                  <span className="rp-muted">篇幅目标：</span>
                  {brief.lengthTarget}
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="rp-confirmbar rp-confirmbar--settled">
        <div className="rp-confirmbar__what">
          <div className="rp-kicker">已确认的研究范围</div>
          <p>
            <b>{confirmSummary(brief)}</b>；简报 v{brief.version}，{brief.matrix.cells} 个待覆盖的比较项。
          </p>
        </div>
        <div className="rp-confirmbar__actions">
          <Button
            variant="light"
            onClick={() => {
              navigate(projectHash(taskId, "research"));
            }}
          >
            去研究矩阵
          </Button>
          {hasReport && (
            <Button
              variant="default"
              leftSection={<ArrowRight size={14} />}
              onClick={() => {
                navigate(projectHash(taskId, "report"));
              }}
            >
              打开报告
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
