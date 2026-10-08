/**
 * The library and the converter, as markup.
 *
 * The sentences these two panels are allowed to say are the whole point of
 * them, because each one is a claim about a third party: that a conversion
 * really happened here (and not that some caller said it did), that a file is
 * about to leave the machine, that a retry costs quota again, that a document
 * is material rather than evidence. The cases check the claims and the controls
 * that gate them — including the one that must start unchecked.
 */

import { MantineProvider } from "@mantine/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ConversionJobView, LibraryDocumentView } from "../src/browser/api.js";
import { DocumentLibrary, type DocumentLibraryProps } from "../src/browser/components/document-library.js";
import { DocumentUpload, type DocumentUploadProps } from "../src/browser/components/document-upload.js";
import { MAX_CONVERSION_BYTES } from "../src/browser/upload-logic.js";

function document(overrides: Partial<LibraryDocumentView> & { readonly documentId: string }): LibraryDocumentView {
  return {
    sessionId: "sess_1",
    taskId: null,
    originalFilename: "notes.md",
    title: "长上下文部署笔记",
    sizeBytes: 2048,
    contentHash: "hash",
    createdAt: "2026-10-09T10:30:00.000Z",
    origin: "direct_upload",
    conversionProvider: null,
    conversion: null,
    status: "ready",
    usage: ["intent_context"],
    outline: [],
    outlineTotal: 0,
    outlineTruncated: false,
    revision: 3,
    note: "",
    failure: null,
    linkedSourceId: null,
    chars: 2048,
    paragraphs: 3,
    truncated: false,
    ...overrides,
  };
}

function converted(): LibraryDocumentView {
  return document({
    documentId: "doc_pdf",
    originalFilename: "paper.pdf",
    title: "Long-context deployment notes",
    origin: "converted",
    conversionProvider: "mineru",
    conversion: {
      provider: "mineru",
      version: "1.0.22",
      originalFilename: "paper.pdf",
      originalFormat: "pdf",
      status: "succeeded",
      convertedAt: "2026-10-09T10:31:00.000Z",
      pageMap: [],
      sourceRef: "ref",
      trust: "server_verified",
    },
    usage: ["intent_context", "research_source"],
    revision: 1,
  });
}

function job(overrides: Partial<ConversionJobView> = {}): ConversionJobView {
  return {
    jobId: "job_1",
    status: "converting",
    filename: "paper.pdf",
    format: "pdf",
    sizeBytes: 2048,
    sha256: "abc",
    usage: ["intent_context"],
    sessionId: "sess_1",
    taskId: null,
    attempts: 1,
    maxAttempts: 3,
    createdAt: "2026-10-09T10:30:00.000Z",
    startedAt: "2026-10-09T10:30:01.000Z",
    finishedAt: null,
    retryable: false,
    document: null,
    conversion: null,
    toolCall: null,
    failure: null,
    note: "",
    limits: { maxBytes: MAX_CONVERSION_BYTES, maxPages: 20, mode: "flash", transports: ["stdio"] },
    ...overrides,
  };
}

function renderLibrary(overrides: Partial<DocumentLibraryProps> = {}): string {
  const props: DocumentLibraryProps = {
    documents: [],
    busy: false,
    saving: false,
    onRefresh: () => undefined,
    onSetUsage: () => undefined,
    ...overrides,
  };
  return renderToStaticMarkup(createElement(MantineProvider, null, createElement(DocumentLibrary, props)));
}

function renderUpload(overrides: Partial<DocumentUploadProps> = {}): string {
  const props: DocumentUploadProps = {
    jobs: [],
    gone: [],
    mineru: null,
    mineruChecked: false,
    onCheckMineru: () => undefined,
    uploading: false,
    converting: false,
    retrying: false,
    canUpload: true,
    onUploadMarkdown: () => undefined,
    onSubmitConversion: () => undefined,
    onRetry: () => undefined,
    ...overrides,
  };
  return renderToStaticMarkup(createElement(MantineProvider, null, createElement(DocumentUpload, props)));
}

describe("the document library", () => {
  it("says what a document is before it says anything about the files", () => {
    const markup = renderLibrary();
    expect(markup).toContain("还没有文档");
    expect(markup).toContain("它们只是材料");
    expect(markup).toContain("不会自动变成证据");
  });

  it("shows a converted document with the trust the server recorded", () => {
    const markup = renderLibrary({ documents: [converted()] });
    expect(markup).toContain("Long-context deployment notes");
    expect(markup).toContain("转换入库");
    expect(markup).toContain("服务端已执行转换");
    expect(markup).toContain("v1");
    expect(markup).toContain("paper.pdf");
  });

  it("tells a claimed conversion apart from a verified one", () => {
    const claimed = document({
      documentId: "doc_claimed",
      origin: "converted",
      conversion: {
        provider: "mineru",
        version: null,
        originalFilename: "other.pdf",
        originalFormat: "pdf",
        status: "succeeded",
        convertedAt: null,
        pageMap: [],
        sourceRef: null,
        trust: "client_claimed",
      },
    });
    const markup = renderLibrary({ documents: [claimed] });
    expect(markup).toContain("调用方自报");
    expect(markup).not.toContain("服务端已执行转换");
  });

  it("offers the two uses, and a way to change them", () => {
    const markup = renderLibrary({ documents: [document({ documentId: "doc_1" })] });
    expect(markup).toContain("澄清方向时参考");
    expect(markup).toContain("研究来源");
    expect(markup).toContain('data-testid="document-usage-doc_1-intent_context"');
  });

  it("says a document already became a source, and offers to open it", () => {
    const markup = renderLibrary({
      documents: [document({ documentId: "doc_1", linkedSourceId: "src_1" })],
      onOpenSource: () => undefined,
    });
    expect(markup).toContain("已是研究来源，查看");
    expect(markup).toContain("取消勾选「研究来源」只会改用途");
  });

  it("does not offer to promote anything without a project", () => {
    const markup = renderLibrary({ documents: [converted()] });
    expect(markup).not.toContain('data-testid="document-promote-doc_pdf"');
  });

  it("offers promotion once there is a project and the document is marked as material", () => {
    const markup = renderLibrary({
      documents: [converted()],
      taskId: "task_1",
      onPromote: () => undefined,
    });
    expect(markup).toContain('data-testid="document-promote-doc_pdf"');
  });
});

describe("the uploader", () => {
  it("says what each kind of file does before anything is chosen", () => {
    const markup = renderUpload();
    expect(markup).toContain("Markdown 直接入库；PDF / DOCX 需要先转换");
    expect(markup).toContain('data-testid="document-file-input"');
  });

  it("explains that uploading needs somewhere to belong", () => {
    const markup = renderUpload({ canUpload: false });
    expect(markup).toContain("上传需要先有一次探索或一个项目");
  });

  it("reports the converter's own state instead of assuming it works", () => {
    expect(renderUpload({ mineruChecked: true })).toContain("转换服务状态未知");
    const failed = renderUpload({
      mineruChecked: true,
      mineru: {
        ok: false,
        mineru: { transport: "stdio", command: "uvx", package: "mineru-open-mcp", mode: "flash", parseDocuments: true, durationMs: 10 },
        limits: { maxBytes: MAX_CONVERSION_BYTES, maxPages: 20, formats: ["pdf", "docx"], online: true, dataHandling: "上传到 MinerU" },
        problem: "服务端没有找到启动 MinerU 转换所需的 uvx。",
      },
    });
    expect(failed).toContain("转换服务不可用");
    expect(failed).toContain("uvx");
  });

  it("shows a running job with its attempt count and nothing invented", () => {
    const markup = renderUpload({ jobs: [job()] });
    expect(markup).toContain('data-testid="conversion-job-job_1"');
    expect(markup).toContain("解析中");
    expect(markup).toContain("第 1/3 次尝试");
  });

  it("shows a failed job's own sentence, its code, and a warning before a retry", () => {
    const markup = renderUpload({
      jobs: [
        job({
          status: "failed",
          retryable: true,
          finishedAt: "2026-10-09T10:31:00.000Z",
          failure: { code: "flash_page_limit", problem: "文档页数超过 Flash 模式上限。", guidance: "请拆分文件后重新上传。" },
        }),
      ],
    });
    expect(markup).toContain("文档页数超过 Flash 模式上限");
    expect(markup).toContain("请拆分文件后重新上传");
    expect(markup).toContain("flash_page_limit");
    expect(markup).toContain("重试这次转换");
    // The quota warning is not shown until the reader presses retry.
    expect(markup).not.toContain("确认重试并再次消耗额度");
  });

  it("offers no retry for a failure the server says cannot be retried", () => {
    const markup = renderUpload({
      jobs: [
        job({
          status: "failed",
          retryable: false,
          failure: { code: "unsupported_format", problem: "这不是支持的格式。", guidance: "请换一份文件。" },
        }),
      ],
    });
    expect(markup).toContain("这次失败不能重试");
    expect(markup).not.toContain('data-testid="conversion-retry-job_1"');
  });

  it("says a job the server no longer knows is gone, and where the document went", () => {
    const markup = renderUpload({ jobs: [job({ status: "failed" })], gone: ["job_1"] });
    expect(markup).toContain("任务已失效");
    expect(markup).toContain("服务重启后会消失");
    expect(markup).toContain("已经转换成功的文档仍然在文档库里");
  });

  it("says a duplicate conversion still cost quota", () => {
    const markup = renderUpload({
      jobs: [
        job({
          status: "succeeded",
          document: { documentId: "doc_1", filename: "paper.pdf", duplicate: true },
          finishedAt: "2026-10-09T10:31:00.000Z",
        }),
      ],
    });
    expect(markup).toContain("这次只复用了已有记录（转换已经发生并消耗了额度）");
  });
});
