/**
 * The document canvas: the report, drawn natively from its structured content.
 *
 * This is not a rendered page shown inside a frame. The report arrives as
 * sections and blocks — paragraphs with the claims they carry, comparison
 * matrices that declare which question each column answers, mechanisms with
 * their own input/steps/trade-off shape, callouts for the questions that stayed
 * open — and each kind is drawn as what it is. A mechanism is not a paragraph;
 * a synthesis is not a source fact; a comparison is a matrix, not a table of
 * prose.
 *
 * Three things this file is careful about. A comparison is drawn in the
 * orientation a reader can compare in, using the dimension and object names the
 * project actually has — never an identifier, and never a column header that is
 * only a mapping. What a cell cannot support is said in the cell ("不可直接比较",
 * "待查") rather than left blank. And what is still unknown is collected into one
 * projection of the research's boundaries instead of being scattered through
 * the text as a list of coverage states.
 *
 * The canvas serves both themes and both modes. The theme changes typography,
 * numbering and grid and nothing else; Read mode is the document as it would
 * print, and Verify mode makes the objects on it selectable — which claim sits
 * in this sentence, which evidence supports it, and whether that evidence is
 * actually enough.
 */

import { Tooltip } from "@mantine/core";
import type { ReactNode } from "react";

import type { DocumentClaim, DocumentView, ReportBlock } from "../api.js";
import { blockIsSynthesis, citationNumbersFor, firstClaimByNumber } from "../claims.js";
import {
  boundaryCounts,
  carriesOwnNumber,
  nameOf,
  readerText,
  type BoundaryItem,
  type DocumentNames,
} from "../document-logic.js";
import { RichInline } from "./markdown.js";
import { STATUS_LABELS } from "../api.js";

export type DocMode = "read" | "verify";

interface BlockContext {
  readonly document: DocumentView | null;
  readonly claimsById: ReadonlyMap<string, DocumentClaim>;
  readonly names: DocumentNames;
  readonly mode: DocMode;
  /** The project's coverage of each subject × dimension, by cell key. */
  readonly coverage: ReadonlyMap<string, string>;
  readonly onSelectClaim: (claimId: string) => void;
  readonly onSelectBlock: (blockKey: string) => void;
  readonly selectedBlock: string | null;
  readonly onOpenCell: (subjectId: string, dimensionId: string) => void;
  readonly onOpenReference: (sourceId: string) => void;
}

/** The key a cell is addressed by, the same one the matrix uses. */
export function coverageKey(subjectId: string, dimensionId: string): string {
  return `${subjectId}|${dimensionId}`;
}

/** The citation markers a block carries, minted by the program, not by layout. */
function Citations({ claimIds, context }: { readonly claimIds: readonly string[]; readonly context: BlockContext }) {
  if (claimIds.length === 0) return null;
  const numbersByClaim = context.document?.citations.numbersByClaim ?? {};
  const numbers = citationNumbersFor(claimIds, numbersByClaim);
  const claimIdsByNumber = firstClaimByNumber(claimIds, numbersByClaim);
  const synthesis = blockIsSynthesis(claimIds, context.claimsById);
  if (numbers.length === 0 && !synthesis) return null;
  return (
    <span className="rp-cite-group">
      {numbers.map((number) => (
        <Tooltip
          key={number}
          withArrow={false}
          label={context.document?.citations.references.find((reference) => reference.number === number)?.title ?? `引用 ${number}`}
        >
          <button
            type="button"
            className="rp-cite"
            onClick={(event) => {
              event.stopPropagation();
              const claimId = claimIdsByNumber.get(number);
              if (claimId !== undefined) context.onSelectClaim(claimId);
            }}
          >
            {number}
          </button>
        </Tooltip>
      ))}
    </span>
  );
}

/** A block's claims, selectable in Verify mode; plain text in Read mode. */
function ClaimTarget({
  claimIds,
  context,
  children,
  className,
  as = "span",
}: {
  readonly claimIds: readonly string[];
  readonly context: BlockContext;
  readonly children: ReactNode;
  readonly className?: string;
  readonly as?: "span" | "div";
}) {
  const interactive = context.mode === "verify" && claimIds.length > 0;
  const first = claimIds[0];
  const Tag = as;
  return (
    <Tag
      className={`${className ?? ""}${interactive ? " rp-claim" : ""}`.trim()}
      {...(interactive
        ? {
            role: "button",
            tabIndex: 0,
            onClick: () => {
              if (first !== undefined) context.onSelectClaim(first);
            },
            onKeyDown: (event: React.KeyboardEvent) => {
              if (event.key === "Enter" && first !== undefined) context.onSelectClaim(first);
            },
            title: "查看这条论断的证据",
          }
        : {})}
    >
      {children}
      <Citations claimIds={claimIds} context={context} />
    </Tag>
  );
}

/* -------------------------------------------------------------- comparison -- */

/**
 * How a cell's own claims say it may be compared.
 *
 * A comparison the sources did not run on the same terms is stated in the cell
 * rather than hidden behind a tidy ranking: "不可直接比较" where the claim says
 * so, "有限可比" where it partly does. Both are read from the claim contract,
 * not guessed from wording.
 */
function comparabilityOf(claimIds: readonly string[], claimsById: ReadonlyMap<string, DocumentClaim>): string | null {
  const states = claimIds
    .map((claimId) => claimsById.get(claimId)?.conditions?.comparability)
    .filter((state): state is string => typeof state === "string" && state.length > 0);
  if (states.includes("not-directly-comparable")) return "not-directly-comparable";
  if (states.includes("partially-comparable")) return "partially-comparable";
  return null;
}

const COMPARABILITY_MARK: Readonly<Record<string, string>> = Object.freeze({
  "not-directly-comparable": "不可直接比较",
  "partially-comparable": "有限可比",
});

interface ComparisonShape {
  readonly dimensionColumns: readonly { readonly column: number; readonly dimensionId: string }[];
  readonly rows: readonly { readonly row: number; readonly subjectId: string | null }[];
}

/**
 * Read the table's own mapping: which columns answer which question, and which
 * rows are which object.
 *
 * Only a table that declared both is drawn as a matrix. A table that did not is
 * drawn as it was written, because guessing which column is a dimension from
 * its heading would be the page inventing a research frame.
 */
function comparisonShape(block: Extract<ReportBlock, { kind: "table" }>, names: DocumentNames): ComparisonShape | null {
  const mappings = block.columnDimensions;
  const rowSubjects = block.rowSubjects;
  if (mappings === undefined || rowSubjects === undefined) return null;
  const dimensionColumns: { column: number; dimensionId: string }[] = [];
  mappings.forEach((dimensionId, column) => {
    if (dimensionId === null) return;
    if (names.dimensions.has(dimensionId)) dimensionColumns.push({ column, dimensionId });
  });
  if (dimensionColumns.length < 2) return null;
  const rows = block.rows.map((_, index) => ({ row: index, subjectId: rowSubjects[index] ?? null }));
  if (rows.filter((entry) => entry.subjectId !== null && names.subjects.has(entry.subjectId)).length < 2) return null;
  return { dimensionColumns, rows };
}

/**
 * One cell: the judgement, or the reason there is none.
 *
 * A cell is not a link — the sentence inside it is what a reader selects, and
 * selecting it is what opens the evidence and the conditions behind it. Where a
 * comparison could not be made on the same terms, the cell says so in words;
 * where no material was found, it says that too, because a blank cell in a
 * comparison is a conclusion the report never drew.
 */
function CellBody({
  cell,
  context,
  subjectId,
  dimensionId,
  testId,
}: {
  readonly cell: { readonly text: string; readonly claimIds: readonly string[] };
  readonly context: BlockContext;
  readonly subjectId?: string;
  readonly dimensionId?: string;
  readonly testId?: string;
}) {
  const mark = comparabilityOf(cell.claimIds, context.claimsById);
  const text = cell.text.trim();
  if (text.length > 0) {
    return (
      <td data-empty="false" data-testid={testId}>
        <ClaimTarget claimIds={cell.claimIds} context={context}>
          <RichInline text={text} />
        </ClaimTarget>
        {mark !== null && (
          <Tooltip label="点开这一句，看依据与成立条件" withArrow={false}>
            <span className={`rp-doc__cellmark rp-doc__cellmark--${mark === "not-directly-comparable" ? "none" : "part"}`}>
              {COMPARABILITY_MARK[mark]}
            </span>
          </Tooltip>
        )}
      </td>
    );
  }
  // No judgement was written here. The cell is not blank, because a blank cell
  // in a comparison reads as "nothing to say" — and what the project actually
  // knows about this pair is one coverage lookup away.
  const state = subjectId === undefined || dimensionId === undefined ? undefined : context.coverage.get(coverageKey(subjectId, dimensionId));
  const label = state === undefined ? "未填写" : STATUS_LABELS[state] ?? state;
  const openable = context.mode === "verify" && subjectId !== undefined && dimensionId !== undefined;
  return (
    <td data-empty="true" data-testid={testId}>
      {openable ? (
        <button
          type="button"
          className="rp-doc__cellfill rp-doc__cellfill--open"
          onClick={() => {
            context.onOpenCell(subjectId, dimensionId);
          }}
          title="这一格还没有写判断；打开它看现有证据"
        >
          {label}
        </button>
      ) : (
        <span className="rp-doc__cellfill">{label}</span>
      )}
    </td>
  );
}

/**
 * The comparison, as a matrix a reader can actually compare in.
 *
 * The report writes its table with a row per object and a column per question;
 * that is a fine way to write and a poor way to read, because six questions
 * give six narrow columns of prose. Flipped — the questions down the side, the
 * objects across — each cell stays one bounded judgement and the frame the
 * comparison claims to hold in is visible at a glance: every row asks the same
 * question of every object.
 */
function ComparisonMatrix({ block, context }: { readonly block: Extract<ReportBlock, { kind: "table" }>; readonly context: BlockContext }) {
  const shape = comparisonShape(block, context.names);
  if (shape === null) return null;
  return (
    <div className="rp-doc__compare__matrix" data-testid="comparison-matrix">
      <table className="rp-doc__table rp-doc__table--matrix">
        <thead>
          <tr>
            <th scope="col" className="rp-doc__corner">
              研究维度
            </th>
            {shape.rows.map((entry) => {
              const name = nameOf(context.names.subjects, entry.subjectId);
              if (name === undefined) return null;
              return (
                <th key={entry.row} scope="col" data-testid={`compare-col-${String(entry.row)}`}>
                  {name}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {shape.dimensionColumns.map((entry) => {
            const label = nameOf(context.names.dimensions, entry.dimensionId);
            if (label === undefined) return null;
            const question = nameOf(context.names.dimensionQuestions, entry.dimensionId);
            return (
              <tr key={entry.dimensionId} data-testid={`compare-row-${entry.dimensionId}`}>
                <th scope="row">
                  <span className="rp-doc__rowname">{label}</span>
                  {question !== undefined && <span className="rp-doc__rowq">{question}</span>}
                </th>
                {shape.rows.map((rowEntry) => {
                  const authored = block.rows[rowEntry.row];
                  const cell = authored?.cells[entry.column];
                  if (cell === undefined) return <td key={rowEntry.row} data-empty="true" />;
                  return (
                    <CellBody
                      key={`${String(rowEntry.row)}-${String(entry.column)}`}
                      cell={cell}
                      context={context}
                      {...(rowEntry.subjectId === null ? {} : { subjectId: rowEntry.subjectId })}
                      dimensionId={entry.dimensionId}
                      testId={`compare-cell-${entry.dimensionId}-${rowEntry.subjectId ?? String(rowEntry.row)}`}
                    />
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The table as it was written, for a comparison that declared no frame. */
function PlainTable({ block, context }: { readonly block: Extract<ReportBlock, { kind: "table" }>; readonly context: BlockContext }) {
  return (
    <div className="rp-doc__compare__matrix">
      <table className="rp-doc__table">
        <thead>
          <tr>
            {block.columns.map((column, columnIndex) => {
              const dimensionId = block.columnDimensions?.[columnIndex] ?? null;
              const label = nameOf(context.names.dimensions, dimensionId);
              const heading = readerText(column);
              return (
                <th key={columnIndex} scope="col">
                  {heading}
                  {label !== undefined && label !== heading && <span className="rp-doc__dimhint">{label}</span>}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.cells.map((cell, cellIndex) => (
                <CellBody key={cellIndex} cell={cell} context={context} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------------------------------------------------------- mechanism -- */

/**
 * A mechanism, drawn as the sequence it is.
 *
 * Input, the stages it goes through, the output, and then the two things a
 * reader has to know before believing it: what it costs and when it stops
 * working. No diagram — a diagram would be Step 4's Mermaid — but the shape of
 * the explanation is visible without reading it as prose.
 */
function MechanismBlock({ block, context }: { readonly block: Extract<ReportBlock, { kind: "mechanism" }>; readonly context: BlockContext }) {
  return (
    <div className="rp-doc__mech" data-testid="mechanism-block">
      <div className="rp-doc__mech__title">{block.title ?? "机制"}</div>

      <div className="rp-doc__mech__stage">
        <div className="rp-doc__mech__stage-k">
          <b>输入</b>
        </div>
        <div className="rp-doc__mech__stage-v">
          <ClaimTarget claimIds={block.claimIds} context={context}>
            <RichInline text={block.input} />
          </ClaimTarget>
        </div>
        <div className="rp-doc__mech__stage-k">
          <b>中间产物</b>
        </div>
        <div className="rp-doc__mech__stage-v">
          <ClaimTarget claimIds={block.claimIds} context={context}>
            <RichInline text={block.intermediate} />
          </ClaimTarget>
        </div>
      </div>

      <div className="rp-doc__mech__flow" aria-hidden="true">
        ↓
      </div>

      <ol className="rp-doc__mech__steps">
        {block.steps.map((step, stepIndex) => (
          <li key={stepIndex} className={carriesOwnNumber(step.text) ? "rp-doc__step--self" : undefined}>
            <ClaimTarget claimIds={step.claimIds} context={context}>
              <RichInline text={step.text} />
            </ClaimTarget>
          </li>
        ))}
      </ol>

      <div className="rp-doc__mech__flow" aria-hidden="true">
        ↓
      </div>

      <div className="rp-doc__mech__stage rp-doc__mech__stage--out">
        <div className="rp-doc__mech__stage-k">
          <b>输出</b>
        </div>
        <div className="rp-doc__mech__stage-v">
          <ClaimTarget claimIds={block.claimIds} context={context}>
            <RichInline text={block.output} />
          </ClaimTarget>
        </div>
      </div>

      <div className="rp-doc__mech__terms">
        <div className="rp-doc__mech__term">
          <b>代价与权衡</b>
          <ClaimTarget claimIds={block.claimIds} context={context}>
            <RichInline text={block.tradeoff} />
          </ClaimTarget>
        </div>
        <div className="rp-doc__mech__term rp-doc__mech__term--failure">
          <b>什么时候不成立</b>
          <ClaimTarget claimIds={block.claimIds} context={context}>
            <RichInline text={block.failure} />
          </ClaimTarget>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ blocks -- */

function renderBlock(block: ReportBlock, context: BlockContext, index: number): ReactNode {
  switch (block.kind) {
    case "paragraph": {
      const isSynthesis = blockIsSynthesis(block.claimIds, context.claimsById);
      return (
        <ClaimTarget
          key={index}
          as="div"
          className={`rp-doc__p${isSynthesis ? " rp-doc__synthesis" : ""}`}
          claimIds={block.claimIds}
          context={context}
        >
          <RichInline text={block.text} />
        </ClaimTarget>
      );
    }
    case "list":
      return (
        <ul className="rp-doc__list" key={index}>
          {block.items.map((item, itemIndex) => {
            // A judgement of ours stays marked wherever it is printed: a list
            // item carrying a synthesis says so just as a paragraph does.
            const isSynthesis = blockIsSynthesis(item.claimIds, context.claimsById);
            const selfNumbered = carriesOwnNumber(item.text);
            return (
              <li
                key={itemIndex}
                className={
                  isSynthesis
                    ? "rp-doc__synthesis rp-doc__synthesis--inline"
                    : selfNumbered
                      ? "rp-doc__li--self"
                      : undefined
                }
              >
                <ClaimTarget claimIds={item.claimIds} context={context}>
                  <RichInline text={item.text} />
                </ClaimTarget>
              </li>
            );
          })}
        </ul>
      );
    case "table": {
      // A table that declared its frame is drawn as a matrix; one that did not
      // is drawn as written, because choosing an orientation for it would be
      // the page inventing a comparison frame the report never claimed.
      const framed = comparisonShape(block, context.names) !== null;
      return (
        <div className="rp-doc__compare" key={index} data-selected={context.selectedBlock === `comparison-${String(index)}`}>
          <button
            type="button"
            className="rp-doc__compare__label"
            onClick={() => {
              context.onSelectBlock(`comparison-${String(index)}`);
            }}
          >
            {framed ? "比较 · 同一组问题，同一组对象" : "比较表"}
          </button>
          {framed ? <ComparisonMatrix block={block} context={context} /> : <PlainTable block={block} context={context} />}
          <p className="rp-doc__compare__foot">
            {framed
              ? "每一行是同一个研究问题，每一列是同一个对象；点开任意一句可以看到它依据的证据与成立条件。"
              : "这张表没有声明每一列对应哪个研究维度、每一行对应哪个对象，因此按报告写下的样子呈现。"}
          </p>
        </div>
      );
    }
    case "callout": {
      const names = (block.dimensionIds ?? [])
        .map((dimensionId) => nameOf(context.names.dimensions, dimensionId))
        .filter((name): name is string => name !== undefined);
      return (
        <div className={`rp-doc__callout${block.tone === "note" ? " rp-doc__callout--note" : ""}`} key={index}>
          <div className="rp-doc__callout__text">
            <RichInline text={block.text} />
          </div>
          {names.length > 0 && <span className="rp-doc__callout__dims">涉及：{names.join(" · ")}</span>}
        </div>
      );
    }
    case "mechanism":
      return <MechanismBlock block={block} context={context} key={index} />;
  }
}

/** The blocks of one section, rendered with the same rules everywhere. */
export function DocumentBlocks({
  blocks,
  claims,
  document,
  names,
  mode = "verify",
  compact = false,
  onSelectClaim = () => undefined,
  onOpenReference = () => undefined,
}: {
  readonly blocks: readonly ReportBlock[];
  readonly claims: readonly DocumentClaim[];
  readonly document: DocumentView | null;
  readonly names?: DocumentNames;
  readonly mode?: DocMode;
  readonly compact?: boolean;
  readonly onSelectClaim?: (claimId: string) => void;
  readonly onOpenReference?: (sourceId: string) => void;
}) {
  const context: BlockContext = {
    document,
    claimsById: new Map(claims.map((claim) => [claim.id, claim])),
    names: names ?? { subjects: new Map(), dimensions: new Map(), dimensionQuestions: new Map() },
    mode: compact ? "read" : mode,
    coverage: new Map(),
    onSelectClaim,
    onSelectBlock: () => undefined,
    selectedBlock: null,
    onOpenCell: () => undefined,
    onOpenReference,
  };
  return <>{blocks.map((block, index) => renderBlock(block, context, index))}</>;
}

/* -------------------------------------------------------------- boundaries -- */

/**
 * What this research does not know, in one place.
 *
 * The matrix knows every cell that is not established; the report says so where
 * it matters. Neither is a place to read them all at once, so they are
 * collected here: one item per research question, the sentence that says why it
 * is open, the objects it is open for, and — one disclosure away — the cells
 * themselves. Nothing is summarised away: the full list is exactly the cells.
 */
function Boundaries({ items, testId }: { readonly items: readonly BoundaryItem[]; readonly testId: string }) {
  const cells = items.reduce((sum, item) => sum + item.cells.length, 0);
  return (
    <section className="rp-doc__boundaries" id="research-boundaries" data-testid={testId}>
      <h2 className="rp-doc__h2">
        <span className="rp-doc__num">※</span>
        研究边界 · 我们不知道什么
      </h2>
      <p className="rp-doc__boundary__lede">
        以下 {String(items.length)} 个问题还没有充分证据；每一条都写明了它缺什么。它们不是结论的反面，而是结论成立的条件。
      </p>
      <div className="rp-doc__boundary__list">
        {items.map((item) => (
          <div className="rp-doc__boundary__item" key={item.dimensionId} data-testid={`boundary-${item.dimensionId}`}>
            <div className="rp-doc__boundary__head">
              <span className="rp-doc__boundary__name">{item.dimensionName}</span>
              <span className="rp-doc__boundary__counts">{boundaryCounts(item)}</span>
            </div>
            <p className="rp-doc__boundary__q">{item.question}</p>
            <p className="rp-doc__boundary__sentence">{item.sentence}</p>
            <p className="rp-doc__boundary__subjects">
              涉及对象：{item.subjects.join("、")}
            </p>
          </div>
        ))}
      </div>
      <details className="rp-doc__boundary__all">
        <summary>查看全部缺口（{String(cells)} 个比较项）</summary>
        <ul>
          {items.flatMap((item) =>
            item.cells.map((cell) => (
              <li key={`${item.dimensionId}-${cell.subjectId}`}>
                <span className="rp-doc__boundary__cell-subject">{cell.subjectName}</span>
                <span className="rp-doc__boundary__cell-dim">{item.dimensionName}</span>
                <span className="rp-doc__boundary__cell-state">{cell.reason}</span>
              </li>
            )),
          )}
        </ul>
      </details>
    </section>
  );
}

/** What a reader can select on the document itself. */
export type CanvasSelection =
  | { readonly kind: "section"; readonly sectionId: string }
  | { readonly kind: "claim"; readonly sectionId: string; readonly claimId: string }
  | { readonly kind: "comparison"; readonly sectionId: string };

export function DocumentCanvas({
  document,
  mode,
  themeId,
  selection,
  names,
  boundaries,
  coverage,
  checks,
  onSelect,
  onOpenCell,
  onOpenReference,
  footerNote,
}: {
  readonly document: DocumentView;
  readonly mode: DocMode;
  readonly themeId: string;
  readonly selection: CanvasSelection | null;
  readonly names: DocumentNames;
  /** The project's own open cells; empty for a frozen revision, which is a snapshot. */
  readonly boundaries: readonly BoundaryItem[];
  /** How the project currently stands on each subject × dimension. */
  readonly coverage: ReadonlyMap<string, string>;
  /** The one line the top of the document may carry about its own checks. */
  readonly checks?: ReactNode;
  readonly onSelect: (next: CanvasSelection) => void;
  readonly onOpenCell?: (subjectId: string, dimensionId: string) => void;
  readonly onOpenReference: (sourceId: string) => void;
  readonly footerNote?: ReactNode;
}) {
  const claimsById = new Map(document.claims.map((claim) => [claim.id, claim]));
  const warnings = document.validation?.warnings ?? [];

  return (
    <article className="rp-doc" data-theme={themeId} data-mode={mode} data-testid="document-canvas">
      <header className="rp-doc__head">
        <div className="rp-doc__kicker">
          {document.revision === null ? "工作稿 · Working Draft" : `R${String(document.revision)} · 已冻结`}
        </div>
        <h1 className="rp-doc__title">{document.title}</h1>
        <p className="rp-doc__summary">{document.summary}</p>
        {document.frame !== null && (
          <div className="rp-doc__frame">
            <div>
              <b>研究问题</b>
              {document.frame.question}
            </div>
            <div>
              <b>读者</b>
              {document.frame.audience}
            </div>
            <div>
              <b>范围</b>
              {document.frame.scope}
            </div>
          </div>
        )}
      </header>

      {/* What the reader can act on, in their words. The validator's own
          sentences stay available, but one disclosure down: they are a
          technician's reading of the report, not the report. */}
      {mode === "verify" && (checks !== undefined || warnings.length > 0) && (
        <div className="rp-doc__checks" data-testid="document-checks">
          {checks}
          {warnings.length > 0 && (
            <details className="rp-doc__checks__detail">
              <summary>校验明细（{String(warnings.length)} 条）</summary>
              <ul>
                {warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {document.sections.map((section, index) => {
        const selectedSection = selection?.kind === "section" && selection.sectionId === section.id;
        const selectedClaim = selection?.kind === "claim" && selection.sectionId === section.id ? selection.claimId : undefined;
        return (
          <section
            key={section.id}
            className="rp-doc__section rp-sel--section"
            data-selected={selectedSection || selectedClaim !== undefined}
            data-section-id={section.id}
            data-testid={`section-${section.id}`}
          >
            <h2 className="rp-doc__h2">
              <span className="rp-doc__num">{String(index + 1).padStart(2, "0")}</span>
              <button
                type="button"
                className="rp-doc__h2-btn"
                onClick={() => {
                  onSelect({ kind: "section", sectionId: section.id });
                }}
                title="选中这一节"
              >
                {section.title}
              </button>
            </h2>
            {section.blocks.map((block, blockIndex) =>
              renderBlock(
                block,
                {
                  document,
                  claimsById,
                  names,
                  mode,
                  coverage,
                  onOpenCell: onOpenCell ?? (() => undefined),
                  onOpenReference,
                  selectedBlock: selection?.kind === "comparison" && selection.sectionId === section.id ? `comparison-${String(blockIndex)}` : null,
                  onSelectBlock: () => {
                    onSelect({ kind: "comparison", sectionId: section.id });
                  },
                  onSelectClaim: (claimId) => {
                    onSelect({ kind: "claim", sectionId: section.id, claimId });
                  },
                },
                blockIndex,
              ),
            )}
          </section>
        );
      })}

      {boundaries.length > 0 && <Boundaries items={boundaries} testId="research-boundaries" />}

      <div className="rp-doc__back">
        <h3>参考来源</h3>
        {document.citations.references.length === 0 ? (
          <p className="rp-doc__empty">这份报告没有引用任何来源。</p>
        ) : (
          document.citations.references.map((reference) => (
            <div className="rp-doc__ref" key={reference.number}>
              <span className="rp-doc__ref__num">{reference.number}</span>
              <span>
                <span className="rp-doc__ref__title">{reference.title}</span>
                <span className="rp-doc__ref__meta">
                  {reference.authors.slice(0, 5).join("、")}
                  {reference.venue.length > 0 ? ` · ${reference.venue}` : ""}
                  {reference.publishedAt !== null ? ` · ${reference.publishedAt.slice(0, 10)}` : ""}
                  {reference.doi !== null ? ` · DOI ${reference.doi}` : ""}
                </span>
                <button
                  type="button"
                  className="rp-doc__ref__link"
                  onClick={() => {
                    onOpenReference(reference.sourceId);
                  }}
                >
                  查看证据链
                </button>
              </span>
            </div>
          ))
        )}
        {document.citations.evidenceIndex.length > 0 && (
          <>
            <h3 className="rp-doc__back__sub">核验索引</h3>
            {document.citations.evidenceIndex.map((entry) => (
              <div className="rp-doc__ref" key={entry.evidenceId}>
                <span className="rp-doc__ref__num">{entry.number}</span>
                <span>
                  <span className="rp-doc__ref__meta">
                    {entry.headingPath.slice(-2).join(" › ") || "正文"} · 第 {entry.paragraphIndex + 1} 段 ·{" "}
                    {entry.scope === "full_text"
                      ? "完整正文"
                      : entry.scope === "body_excerpt"
                        ? "正文节选"
                        : entry.scope === "abstract"
                          ? "仅摘要"
                          : "仅元数据"}
                  </span>
                  <button
                    type="button"
                    className="rp-doc__ref__link"
                    onClick={() => {
                      onOpenReference(entry.sourceId);
                    }}
                  >
                    核验片段
                  </button>
                </span>
              </div>
            ))}
          </>
        )}
        {footerNote}
      </div>
    </article>
  );
}
