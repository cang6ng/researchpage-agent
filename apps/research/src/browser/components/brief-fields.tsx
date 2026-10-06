/**
 * The editors the Brief is read and changed with.
 *
 * A brief is not a form, so these are not inputs sitting in a grid of labels.
 * Each field is prose the reader can put a cursor in: it reads as the document
 * it describes until someone decides to change it, and the change is committed
 * when they are done rather than on every keystroke. The two list-shaped fields
 * keep the shape of what they are — an object with a note is a row, a dimension
 * with the question it answers is a row — because flattening them into fields
 * would lose the thing that makes them editable at all.
 *
 * Nothing here talks to the server. A component reports what the reader did;
 * the page decides what that means.
 */

import { ActionIcon, Button, Textarea, TextInput, Tooltip } from "@mantine/core";
import { ArrowDown, ArrowUp, Plus, Sparkles, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { BriefFieldState } from "../api.js";
import type { DimensionRow, SubjectRow } from "../brief-logic.js";

/** Where a field's save stands, so the reader is never guessing. */
export type SaveState = "idle" | "saving" | "saved" | "stale" | "error";

/* ------------------------------------------------------------------ marks -- */

/**
 * What the agent contributed, marked as lightly as it can be.
 *
 * A suggestion is a hint and not a badge: the field belongs to the reader from
 * the moment they touch it, and a page that keeps stamping "AI" on a value
 * someone has already rewritten is telling them something untrue.
 */
export function FieldMark({ state }: { readonly state: BriefFieldState }) {
  if (state === "edited") return <span className="rp-mark-edited">已修改</span>;
  if (state === "suggested") {
    return (
      <Tooltip label="助手根据你的主题提出的；直接改就是你的决定" withArrow={false}>
        <span className="rp-mark-suggested" aria-label="助手建议" tabIndex={0}>
          <Sparkles size={11} strokeWidth={1.9} />
        </span>
      </Tooltip>
    );
  }
  return null;
}

/** The save state, said only while it is worth saying. */
export function SaveNote({ state, note }: { readonly state: SaveState; readonly note: string }) {
  if (state === "saving") return <span className="rp-savenote">保存中…</span>;
  if (state === "saved") return <span className="rp-savenote rp-savenote--done">已保存</span>;
  if (state === "error") return <span className="rp-savenote rp-savenote--bad">{note.length === 0 ? "没有保存" : note}</span>;
  if (state === "stale") return <span className="rp-savenote rp-savenote--stale">未保存 · 需要重新确认</span>;
  return null;
}

/* ------------------------------------------------------------------ field -- */

export interface FieldShellProps {
  readonly field: string;
  readonly label: string;
  readonly hint?: string;
  readonly state: BriefFieldState;
  readonly saveState: SaveState;
  readonly saveNote: string;
  /** The problems the server (or the page) reports about this field. */
  readonly problems: readonly string[];
  readonly invalid: boolean;
  readonly children: React.ReactNode;
  readonly lead?: boolean;
  /** A list of rows is not prose: it takes the page's whole width. */
  readonly wide?: boolean;
  readonly actions?: React.ReactNode;
}

/**
 * One field: its name, its mark, its content, and what is wrong with it.
 *
 * The anchor is the field's own name, which is how a refused confirm finds the
 * place to scroll to — the page points at the field it is about rather than
 * showing a sentence at the bottom and leaving the reader to hunt.
 */
export function FieldShell({
  field,
  label,
  hint,
  state,
  saveState,
  saveNote,
  problems,
  invalid,
  children,
  lead,
  wide,
  actions,
}: FieldShellProps) {
  return (
    <section className={`rp-brief-field${invalid ? " rp-brief-field--invalid" : ""}`} data-brief-field={field}>
      <div className="rp-brief-field__head">
        <h3 className="rp-brief-field__label">{label}</h3>
        <FieldMark state={state} />
        {actions}
        <div className="rp-brief-field__spacer" />
        <SaveNote state={saveState} note={saveNote} />
      </div>
      {/* A prose field's hint is a caption under the sentence it explains; a
          list's hint is what the list is for, so it comes before the list. */}
      {wide === true && hint !== undefined && <p className="rp-brief-field__hint">{hint}</p>}
      <div
        className={`rp-brief-field__body${lead === true ? " rp-brief-field__body--lead" : ""}${
          wide === true ? " rp-brief-field__body--wide" : ""
        }`}
      >
        {children}
      </div>
      {wide !== true && hint !== undefined && <p className="rp-brief-field__hint">{hint}</p>}
      {problems.length > 0 && (
        <ul className="rp-brief-field__problems" data-testid={`problems-${field}`}>
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
/* ------------------------------------------------------------- inline text -- */

/**
 * One piece of prose, editable where it is.
 *
 * The value is shown as the document shows it; clicking it puts a cursor in
 * place. Blur commits and Escape abandons, so an edit is one gesture and not a
 * round trip through a form.
 */
export function InlineText({
  value,
  placeholder,
  label,
  multiline = false,
  commit,
  disabled = false,
  testId,
}: {
  readonly value: string;
  readonly placeholder: string;
  readonly label: string;
  readonly multiline?: boolean;
  readonly commit: (next: string) => void;
  readonly disabled?: boolean;
  readonly testId?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  // The server is the authority: when the value changes underneath — a guided
  // answer, another tab, a refresh — the local text follows it, unless the
  // reader is in the middle of typing.
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);

  const finish = (save: boolean): void => {
    setEditing(false);
    if (save && draft !== value) commit(draft);
    if (!save) setDraft(value);
  };

  if (disabled) {
    return <span className="rp-prose">{value.length > 0 ? value : placeholder}</span>;
  }

  if (!editing) {
    return (
      <button
        type="button"
        className={`rp-inline${value.length === 0 ? " rp-inline--empty" : ""}`}
        onClick={() => {
          setEditing(true);
        }}
        aria-label={`修改${label}`}
        data-testid={testId}
      >
        {value.length > 0 ? value : placeholder}
      </button>
    );
  }

  return (
    <Textarea
      ref={ref}
      className="rp-inline__editor"
      size="sm"
      autosize
      minRows={multiline ? 2 : 1}
      maxRows={8}
      value={draft}
      aria-label={label}
      onChange={(event) => {
        setDraft(event.currentTarget.value);
      }}
      onBlur={() => {
        finish(true);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          finish(false);
        }
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          finish(true);
        }
      }}
    />
  );
}

/* -------------------------------------------------------------- text field -- */

export function TextField({
  field,
  label,
  hint,
  value,
  placeholder,
  state,
  saveState,
  saveNote,
  problems,
  multiline,
  suggestions,
  commit,
  readOnly = false,
}: {
  readonly field: string;
  readonly label: string;
  readonly hint?: string;
  readonly value: string;
  readonly placeholder: string;
  readonly state: BriefFieldState;
  readonly saveState: SaveState;
  readonly saveNote: string;
  readonly problems: readonly string[];
  readonly multiline?: boolean;
  readonly suggestions?: readonly string[];
  readonly commit: (next: string) => void;
  readonly readOnly?: boolean;
}) {
  return (
    <FieldShell
      field={field}
      label={label}
      hint={hint}
      state={state}
      saveState={saveState}
      saveNote={saveNote}
      problems={problems}
      invalid={problems.length > 0}
      lead={field === "purpose" || field === "topic"}
      {...(suggestions === undefined
        ? {}
        : {
            actions: (
              <span className="rp-suggest">
                {suggestions.map((suggestion, index) => (
                  <button
                    key={suggestion}
                    type="button"
                    className="rp-suggest__item"
                    onClick={() => {
                      commit(suggestion);
                    }}
                    data-testid={`suggest-${field}-${String(index)}`}
                  >
                    {suggestion}
                  </button>
                ))}
              </span>
            ),
          })}
    >
      <InlineText
        value={value}
        placeholder={placeholder}
        label={label}
        commit={commit}
        disabled={readOnly}
        {...(multiline === undefined ? {} : { multiline })}
        testId={`edit-${field}`}
      />
    </FieldShell>
  );
}

/* --------------------------------------------------------------- chip list -- */

export function FocusField({
  field,
  label,
  hint,
  values,
  state,
  saveState,
  saveNote,
  problems,
  commit,
  readOnly = false,
}: {
  readonly field: string;
  readonly label: string;
  readonly hint?: string;
  readonly values: readonly string[];
  readonly state: BriefFieldState;
  readonly saveState: SaveState;
  readonly saveNote: string;
  readonly problems: readonly string[];
  readonly commit: (next: readonly string[]) => void;
  readonly readOnly?: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");

  const add = (): void => {
    const value = draft.trim();
    setDraft("");
    setAdding(false);
    if (value.length === 0) return;
    commit([...values, value]);
  };

  return (
    <FieldShell
      field={field}
      label={label}
      hint={hint}
      state={state}
      saveState={saveState}
      saveNote={saveNote}
      problems={problems}
      invalid={problems.length > 0}
    >
      <div className="rp-chips" data-testid="focus-chips">
        {values.map((item) => (
          <span key={item} className="rp-chipped rp-chipped--editable">
            {item}
            {!readOnly && (
              <button
                type="button"
                className="rp-chipped__x"
                aria-label={`移除关注点 ${item}`}
                onClick={() => {
                  commit(values.filter((candidate) => candidate !== item));
                }}
              >
                <X size={11} strokeWidth={2} />
              </button>
            )}
          </span>
        ))}
        {values.length === 0 && <span className="rp-muted">这一项没有特别指定的关注点。</span>}
        {!readOnly &&
          (adding ? (
            <span className="rp-chipadd">
              <TextInput
                size="xs"
                autoFocus
                w={190}
                value={draft}
                placeholder="例如：成本口径"
                onChange={(event) => {
                  setDraft(event.currentTarget.value);
                }}
                onBlur={add}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    add();
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setDraft("");
                    setAdding(false);
                  }
                }}
                aria-label="新增关注点"
              />
            </span>
          ) : (
            <button
              type="button"
              className="rp-chipadd__button"
              onClick={() => {
                setAdding(true);
              }}
              data-testid="add-focus"
            >
              <Plus size={12} /> 加一项
            </button>
          ))}
      </div>
    </FieldShell>
  );
}

/* ------------------------------------------------------------- subject rows -- */

/**
 * One comparison object: its name, the note that says what it is, and its place
 * in the list.
 *
 * The order is not decoration — it is the column order of the matrix the
 * research will fill in — so a row can be moved, and moving it is a real edit
 * that keeps the object's id.
 */
export function SubjectRowView({
  row,
  index,
  count,
  readOnly,
  onChange,
  onCommit,
  onMove,
  onRemove,
}: {
  readonly row: SubjectRow;
  readonly index: number;
  readonly count: number;
  readonly readOnly: boolean;
  readonly onChange: (next: SubjectRow) => void;
  readonly onCommit: () => void;
  readonly onMove: (direction: -1 | 1) => void;
  readonly onRemove: () => void;
}) {
  const id = row.id ?? `new-${String(index)}`;
  return (
    <div className="rp-row" data-testid={`subject-row-${id}`}>
      <div className="rp-row__index">{String(index + 1).padStart(2, "0")}</div>
      <div className="rp-row__fields">
        <TextInput
          size="sm"
          variant="unstyled"
          className="rp-row__name"
          placeholder="对象名称，例如 LightRAG"
          value={row.name}
          disabled={readOnly}
          aria-label={`比较对象 ${String(index + 1)} 名称`}
          onChange={(event) => {
            onChange({ ...row, name: event.currentTarget.value });
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onCommit();
            }
          }}
        />
        <TextInput
          size="sm"
          variant="unstyled"
          className="rp-row__note"
          placeholder="一句话说明它是什么（可选）"
          value={row.note}
          disabled={readOnly}
          aria-label={`比较对象 ${String(index + 1)} 说明`}
          onChange={(event) => {
            onChange({ ...row, note: event.currentTarget.value });
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onCommit();
            }
          }}
        />
      </div>
      {!readOnly && (
        <div className="rp-row__tools">
          <Tooltip label="上移（矩阵里靠前的列）" withArrow={false}>
            <ActionIcon
              size="sm"
              variant="subtle"
              disabled={index === 0}
              aria-label="上移"
              onClick={() => {
                onMove(-1);
              }}
            >
              <ArrowUp size={13} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="下移" withArrow={false}>
            <ActionIcon
              size="sm"
              variant="subtle"
              disabled={index === count - 1}
              aria-label="下移"
              onClick={() => {
                onMove(1);
              }}
            >
              <ArrowDown size={13} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="移除这个对象" withArrow={false}>
            <ActionIcon size="sm" variant="subtle" aria-label="移除" onClick={onRemove} data-testid={`remove-subject-${id}`}>
              <Trash2 size={13} />
            </ActionIcon>
          </Tooltip>
        </div>
      )}
    </div>
  );
}

/** One research dimension: the question it answers is the row, not a subtitle. */
export function DimensionRowView({
  row,
  index,
  count,
  readOnly,
  onChange,
  onCommit,
  onMove,
  onRemove,
}: {
  readonly row: DimensionRow;
  readonly index: number;
  readonly count: number;
  readonly readOnly: boolean;
  readonly onChange: (next: DimensionRow) => void;
  readonly onCommit: () => void;
  readonly onMove: (direction: -1 | 1) => void;
  readonly onRemove: () => void;
}) {
  const id = row.id ?? `new-${String(index)}`;
  return (
    <div className="rp-row rp-row--dimension" data-testid={`dimension-row-${id}`}>
      <div className="rp-row__index">{String(index + 1).padStart(2, "0")}</div>
      <div className="rp-row__fields">
        <TextInput
          size="sm"
          variant="unstyled"
          className="rp-row__name"
          placeholder="维度名称，例如 构建成本"
          value={row.name}
          disabled={readOnly}
          aria-label={`研究维度 ${String(index + 1)} 名称`}
          onChange={(event) => {
            onChange({ ...row, name: event.currentTarget.value });
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onCommit();
            }
          }}
        />
        <Textarea
          size="sm"
          variant="unstyled"
          autosize
          minRows={1}
          maxRows={3}
          className="rp-row__question"
          placeholder="这个维度要回答的问题，写成一个问句"
          value={row.question}
          disabled={readOnly}
          aria-label={`研究维度 ${String(index + 1)} 要回答的问题`}
          onChange={(event) => {
            onChange({ ...row, question: event.currentTarget.value });
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              onCommit();
            }
          }}
        />
      </div>
      {!readOnly && (
        <div className="rp-row__tools">
          <Tooltip label="上移（矩阵里靠上的行）" withArrow={false}>
            <ActionIcon
              size="sm"
              variant="subtle"
              disabled={index === 0}
              aria-label="上移"
              onClick={() => {
                onMove(-1);
              }}
            >
              <ArrowUp size={13} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="下移" withArrow={false}>
            <ActionIcon
              size="sm"
              variant="subtle"
              disabled={index === count - 1}
              aria-label="下移"
              onClick={() => {
                onMove(1);
              }}
            >
              <ArrowDown size={13} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="移除这个维度" withArrow={false}>
            <ActionIcon size="sm" variant="subtle" aria-label="移除" onClick={onRemove} data-testid={`remove-dimension-${id}`}>
              <Trash2 size={13} />
            </ActionIcon>
          </Tooltip>
        </div>
      )}
    </div>
  );
}

/** The two list fields' "add" affordance: a row appears, the reader names it. */
export function AddRow({ label, onClick, testId }: { readonly label: string; readonly onClick: () => void; readonly testId: string }) {
  return (
    <Button
      size="compact-sm"
      variant="subtle"
      leftSection={<Plus size={13} />}
      onClick={onClick}
      data-testid={testId}
      mt={6}
    >
      {label}
    </Button>
  );
}
