/**
 * The document canvas: the report, drawn natively from its structured content.
 *
 * This is not a rendered page shown inside a frame. The report arrives as
 * sections and blocks — paragraphs with the claims they carry, comparison
 * tables that declare which dimension each column answers, mechanisms with
 * their own input/steps/trade-off shape, callouts for the gaps that stayed
 * open — and each kind is drawn as what it is. A mechanism is not a paragraph;
 * a synthesis is not a source fact; a gap is not a sentence to skim past.
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

export type DocMode = "read" | "verify";

interface BlockContext {
  readonly document: DocumentView | null;
  readonly claimsById: ReadonlyMap<string, DocumentClaim>;
  readonly mode: DocMode;
  readonly onSelectClaim: (claimId: string) => void;
  readonly onOpenReference: (sourceId: string) => void;
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
          {block.text}
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
            return (
              <li key={itemIndex} className={isSynthesis ? "rp-doc__synthesis rp-doc__synthesis--inline" : undefined}>
                <ClaimTarget claimIds={item.claimIds} context={context}>
                  {item.text}
                </ClaimTarget>
              </li>
            );
          })}
        </ul>
      );
    case "table":
      return (
        <div className="rp-doc__compare" key={index} data-selected={undefined}>
          <div className="rp-doc__compare__label">比较 · 同一组条件</div>
          <table className="rp-doc__table">
            <thead>
              <tr>
                {block.columns.map((column, columnIndex) => {
                  const dimensionId = block.columnDimensions?.[columnIndex] ?? null;
                  const dimension = context.document?.claims.flatMap((claim) => claim.dimensions).find((entry) => entry.id === dimensionId);
                  return (
                    <th key={columnIndex} scope="col">
                      {column}
                      {dimensionId !== null && (
                        <span className="rp-doc__dimhint">{dimension?.name ?? dimensionId}</span>
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.cells.map((cell, cellIndex) => (
                    <td key={cellIndex} data-empty={cell.text.trim().length === 0}>
                      <ClaimTarget claimIds={cell.claimIds} context={context}>
                        {cell.text.trim().length === 0 ? "—" : cell.text}
                      </ClaimTarget>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {block.columnDimensions !== undefined && (
            <p className="rp-doc__compare__label" style={{ marginTop: 10, marginBottom: 0, textTransform: "none", letterSpacing: 0, fontSize: 11.5 }}>
              每一列对应它自己的研究维度；空单元格表示该对象在这一维度上没有找到可引用材料。
            </p>
          )}
        </div>
      );
    case "callout":
      return (
        <div className={`rp-doc__callout${block.tone === "note" ? " rp-doc__callout--note" : ""}`} key={index}>
          <ClaimTarget claimIds={[]} context={context}>
            {block.text}
          </ClaimTarget>
          {block.dimensionIds !== undefined && block.dimensionIds.length > 0 && (
            <span className="rp-doc__callout__dims">涉及维度：{block.dimensionIds.length} 个</span>
          )}
        </div>
      );
    case "mechanism":
      return (
        <div className="rp-doc__mech" key={index}>
          <div className="rp-doc__mech__title">{block.title ?? "机制"}</div>
          <div className="rp-doc__mech__ends">
            <div className="rp-doc__mech__end">
              <b>输入</b>
              <ClaimTarget claimIds={block.claimIds} context={context}>
                {block.input}
              </ClaimTarget>
            </div>
            <div className="rp-doc__mech__end">
              <b>中间产物</b>
              <ClaimTarget claimIds={block.claimIds} context={context}>
                {block.intermediate}
              </ClaimTarget>
            </div>
          </div>
          <ol className="rp-doc__mech__steps">
            {block.steps.map((step, stepIndex) => (
              <li key={stepIndex}>
                <ClaimTarget claimIds={step.claimIds} context={context}>
                  {step.text}
                </ClaimTarget>
              </li>
            ))}
          </ol>
          <div className="rp-doc__mech__terms">
            <div className="rp-doc__mech__term">
              <b>输出</b>
              <ClaimTarget claimIds={block.claimIds} context={context}>
                {block.output}
              </ClaimTarget>
            </div>
            <div className="rp-doc__mech__term">
              <b>代价与权衡</b>
              <ClaimTarget claimIds={block.claimIds} context={context}>
                {block.tradeoff}
              </ClaimTarget>
            </div>
            <div className="rp-doc__mech__term rp-doc__mech__term--failure">
              <b>什么时候不成立</b>
              <ClaimTarget claimIds={block.claimIds} context={context}>
                {block.failure}
              </ClaimTarget>
            </div>
          </div>
        </div>
      );
  }
}

/** The blocks of one section, rendered with the same rules everywhere. */
export function DocumentBlocks({
  blocks,
  claims,
  document,
  mode = "verify",
  compact = false,
  onSelectClaim = () => undefined,
  onOpenReference = () => undefined,
}: {
  readonly blocks: readonly ReportBlock[];
  readonly claims: readonly DocumentClaim[];
  readonly document: DocumentView | null;
  readonly mode?: DocMode;
  readonly compact?: boolean;
  readonly onSelectClaim?: (claimId: string) => void;
  readonly onOpenReference?: (sourceId: string) => void;
}) {
  const context: BlockContext = {
    document,
    claimsById: new Map(claims.map((claim) => [claim.id, claim])),
    mode: compact ? "read" : mode,
    onSelectClaim,
    onOpenReference,
  };
  return <>{blocks.map((block, index) => renderBlock(block, context, index))}</>;
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
  onSelect,
  onOpenReference,
  footerNote,
}: {
  readonly document: DocumentView;
  readonly mode: DocMode;
  readonly themeId: string;
  readonly selection: CanvasSelection | null;
  readonly onSelect: (next: CanvasSelection) => void;
  readonly onOpenReference: (sourceId: string) => void;
  readonly footerNote?: ReactNode;
}) {
  const claimsById = new Map(document.claims.map((claim) => [claim.id, claim]));

  return (
    <article className="rp-doc" data-theme={themeId} data-mode={mode} data-testid="document-canvas">
      <header className="rp-doc__head">
        <div className="rp-doc__kicker">
          {document.revision === null ? "工作稿 · Working Draft" : `R${document.revision} · 已冻结`}
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

      {document.validation !== null && document.validation.warnings.length > 0 && mode === "verify" && (
        <div className="rp-doc__warn" data-testid="document-warnings">
          <b>质量校验提醒（{document.validation.warnings.length} 条，不阻止发布）</b>
          <ul>
            {document.validation.warnings.slice(0, 6).map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
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
            {section.blocks.map((block, blockIndex) => {
              if (block.kind === "table") {
                const comparisonSelected = selection?.kind === "comparison" && selection.sectionId === section.id;
                return (
                  <div
                    key={blockIndex}
                    data-selected={comparisonSelected}
                    onClick={(event) => {
                      if (mode === "verify" && event.target === event.currentTarget) {
                        onSelect({ kind: "comparison", sectionId: section.id });
                      }
                    }}
                  >
                    {renderBlock(block, {
                      document,
                      claimsById,
                      mode,
                      onOpenReference,
                      onSelectClaim: () => {
                        onSelect({ kind: "comparison", sectionId: section.id });
                      },
                    }, blockIndex)}
                  </div>
                );
              }
              return renderBlock(block, {
                document,
                claimsById,
                mode,
                onOpenReference,
                onSelectClaim: (claimId) => {
                  onSelect({ kind: "claim", sectionId: section.id, claimId });
                },
              }, blockIndex);
            })}
          </section>
        );
      })}

      <div className="rp-doc__back">
        <h3>参考来源</h3>
        {document.citations.references.length === 0 ? (
          <p style={{ fontSize: 13, color: "#8b9499", margin: 0 }}>这份报告没有引用任何来源。</p>
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
            <h3 style={{ marginTop: 26 }}>核验索引</h3>
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
