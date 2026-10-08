/**
 * The document library: what the reader put in, and what it is for.
 *
 * A document here is not evidence and not a source. It is material the user
 * supplied — a Markdown file they wrote, or a PDF a converter turned into
 * Markdown — and the only things this list decides are what it is called, what
 * produced it, and which of the two uses it has: something to read while
 * deciding what to research, or material a project may cite. Everything else
 * belongs to the server, and the page reads it rather than inferring it.
 *
 * The identity facts are shown as facts. A conversion this server performed and
 * a conversion some caller described are two different levels of proof, and a
 * list that showed the same word for both would be telling the reader something
 * nobody verified. Reading is not claiming either: a document that was never
 * read has no excerpts, and adding it as a source says exactly that.
 */

import { Badge, Button, Checkbox, Loader, Tooltip } from "@mantine/core";
import { ExternalLink, RefreshCw, ShieldCheck, ShieldQuestion, Upload } from "lucide-react";
import { useState } from "react";

import {
  CONVERSION_TRUST_LABELS,
  DOCUMENT_ORIGIN_LABELS,
  DOCUMENT_STATUS_LABELS,
  DOCUMENT_USAGE_LABELS,
  type DocumentUsage,
  type LibraryDocumentView,
} from "../api.js";

/**
 * What a document is, said once, because the reader will otherwise assume the
 * opposite: a file they handed over is not something the product found, and it
 * is not something the product has read.
 */
export const DOCUMENT_TRUST_NOTE =
  "文档库里的文件是你自己提供的材料：它们可以被读取和引用，但不会自动变成证据，也不会自动进入报告。加入研究来源之后，它仍然需要被真正读取，才会有可以引用的片段。";

const USAGES: readonly DocumentUsage[] = ["intent_context", "research_source"];

function when(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return `${String(date.getMonth() + 1)}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function bytes(value: number): string {
  if (value < 1024) return `${String(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export interface DocumentLibraryProps {
  readonly documents: readonly LibraryDocumentView[] | null;
  readonly busy: boolean;
  readonly saving: boolean;
  readonly onRefresh: () => void;
  readonly onSetUsage: (documentId: string, usage: readonly DocumentUsage[], expectedRevision: number) => void;
  /** Prefills a message that asks the assistant to consider this document. */
  readonly onUseDocument?: (document: LibraryDocumentView) => void;
  /**
   * Whether a document marked as research material can be turned into a source.
   * It needs a project, because a source belongs to one.
   */
  readonly taskId?: string | null;
  readonly onPromote?: (documentId: string) => void;
  readonly promoting?: string | null;
  /** Opens the source a document already became, in the existing dock. */
  readonly onOpenSource?: (sourceId: string) => void;
}

function TrustChip({ document }: { readonly document: LibraryDocumentView }): React.ReactElement | null {
  const conversion = document.conversion;
  if (conversion === null) return null;
  const verified = conversion.trust === "server_verified";
  return (
    <Tooltip
      withArrow={false}
      label={
        verified
          ? "这次转换由服务端自己执行：它记录了调用与结果。这证明转换发生过，不证明内容正确。"
          : "这条转换记录是调用方自报的，服务端没有执行也没有核验它。"
      }
    >
      <span className="rp-chip rp-chip--quiet" data-testid={`document-trust-${document.documentId}`}>
        {verified ? <ShieldCheck size={11} strokeWidth={1.75} /> : <ShieldQuestion size={11} strokeWidth={1.75} />}
        {CONVERSION_TRUST_LABELS[conversion.trust]}
      </span>
    </Tooltip>
  );
}

function DocumentRow({
  document,
  saving,
  onSetUsage,
  onUseDocument,
  canPromote,
  onPromote,
  promoting,
  onOpenSource,
}: {
  readonly document: LibraryDocumentView;
  readonly saving: boolean;
  readonly onSetUsage: DocumentLibraryProps["onSetUsage"];
  readonly onUseDocument?: DocumentLibraryProps["onUseDocument"];
  readonly canPromote: boolean;
  readonly onPromote?: DocumentLibraryProps["onPromote"];
  readonly promoting: boolean;
  readonly onOpenSource?: DocumentLibraryProps["onOpenSource"];
}): React.ReactElement {
  const [draft, setDraft] = useState<readonly DocumentUsage[]>(document.usage);
  const changed = draft.length !== document.usage.length || draft.some((usage) => !document.usage.includes(usage));
  const empty = draft.length === 0;
  const ready = document.status === "ready";
  const linked = document.linkedSourceId;
  return (
    <div className="rp-file" data-testid={`document-row-${document.documentId}`}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span className="rp-file__title">{document.title}</span>
          <Badge size="xs" variant="light" color="gray">
            {DOCUMENT_STATUS_LABELS[document.status] ?? document.status}
          </Badge>
          <Badge size="xs" variant="light" color="gray">
            {DOCUMENT_ORIGIN_LABELS[document.origin] ?? document.origin}
          </Badge>
          <TrustChip document={document} />
        </div>
        <div className="rp-file__facts">
          <span>{document.originalFilename}</span>
          <span>{bytes(document.sizeBytes)}</span>
          <span>{document.chars.toLocaleString("zh-CN")} 字</span>
          <span>v{document.revision}</span>
          <span>{when(document.createdAt)}</span>
          {document.conversion !== null && <span>原文格式 {document.conversion.originalFormat}</span>}
          {document.conversion !== null && document.conversion.provider.length > 0 && (
            <span>转换服务 {document.conversion.provider}</span>
          )}
        </div>
        {document.failure !== null && <p className="rp-chat__note">入库失败：{document.failure}</p>}
        <div style={{ display: "flex", gap: 16, marginTop: 8, flexWrap: "wrap" }}>
          {USAGES.map((usage) => (
            <Checkbox
              key={usage}
              size="xs"
              checked={draft.includes(usage)}
              disabled={!ready || saving}
              onChange={(event) => {
                const on = event.currentTarget.checked;
                setDraft((current) =>
                  on ? [...current, usage] : current.filter((entry) => entry !== usage),
                );
              }}
              label={DOCUMENT_USAGE_LABELS[usage]}
              data-testid={`document-usage-${document.documentId}-${usage}`}
            />
          ))}
          {changed && (
            <Button
              size="xs"
              variant="light"
              loading={saving}
              disabled={empty}
              onClick={() => {
                onSetUsage(document.documentId, draft, document.revision);
              }}
              data-testid={`document-usage-save-${document.documentId}`}
            >
              保存用途
            </Button>
          )}
          {changed && empty && <span className="rp-file__warn">至少保留一个用途</span>}
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
          {onUseDocument !== undefined && ready && (
            <Button
              size="xs"
              variant="subtle"
              onClick={() => {
                onUseDocument(document);
              }}
              data-testid={`document-use-${document.documentId}`}
            >
              用它继续澄清
            </Button>
          )}
          {canPromote && draft.includes("research_source") && linked === null && onPromote !== undefined && (
            <Button
              size="xs"
              variant="light"
              loading={promoting}
              onClick={() => {
                onPromote(document.documentId);
              }}
              data-testid={`document-promote-${document.documentId}`}
            >
              加入研究来源
            </Button>
          )}
          {linked !== null && onOpenSource !== undefined && (
            <Button
              size="xs"
              variant="subtle"
              rightSection={<ExternalLink size={13} />}
              onClick={() => {
                onOpenSource(linked);
              }}
              data-testid={`document-open-source-${document.documentId}`}
            >
              已是研究来源，查看
            </Button>
          )}
          {linked !== null && onOpenSource === undefined && (
            <span className="rp-file__fact" data-testid={`document-linked-${document.documentId}`}>
              已加入研究来源
            </span>
          )}
        </div>
        {linked !== null && (
          <p className="rp-chat__note">
            这份文档已经是研究来源。取消勾选「研究来源」只会改用途：已经建立的来源、快照和证据都仍然保留。
          </p>
        )}
      </div>
    </div>
  );
}

export function DocumentLibrary(props: DocumentLibraryProps): React.ReactElement | null {
  const documents = props.documents;
  if (documents === null) return null;
  const canPromote = props.taskId !== undefined && props.taskId !== null;
  return (
    <section style={{ marginTop: 22 }} data-testid="document-library">
      <div className="rp-section-head">
        <h2>文档库</h2>
        <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {documents.length === 0 ? "还没有文档" : `共 ${documents.length} 份`}
          <Button
            size="compact-xs"
            variant="subtle"
            leftSection={props.busy ? <Loader size={11} color="ink" /> : <RefreshCw size={11} />}
            onClick={props.onRefresh}
            data-testid="library-refresh"
          >
            刷新
          </Button>
        </span>
      </div>
      {documents.length === 0 ? (
        <p className="rp-empty">
          上传的 Markdown 与转换完成的 PDF / DOCX 会出现在这里。它们只是材料：要成为可引用的来源，需要你在这里明确标记。
        </p>
      ) : (
        <div className="rp-files">
          {documents.map((document) => (
            <DocumentRow
              key={document.documentId}
              document={document}
              saving={props.saving}
              onSetUsage={props.onSetUsage}
              {...(props.onUseDocument === undefined ? {} : { onUseDocument: props.onUseDocument })}
              canPromote={canPromote}
              {...(props.onPromote === undefined ? {} : { onPromote: props.onPromote })}
              promoting={props.promoting === document.documentId}
              {...(props.onOpenSource === undefined ? {} : { onOpenSource: props.onOpenSource })}
            />
          ))}
        </div>
      )}
      <p className="rp-chat__note" style={{ display: "flex", gap: 6, alignItems: "flex-start", marginTop: 10 }}>
        <Upload size={12} strokeWidth={1.75} aria-hidden="true" style={{ marginTop: 3 }} />
        {DOCUMENT_TRUST_NOTE}
      </p>
    </section>
  );
}
