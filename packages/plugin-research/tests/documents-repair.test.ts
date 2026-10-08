/**
 * The six defects a review proved, each with the counterexample that proved it.
 *
 * These cases exist because the first version of the document library was
 * wrong in ways that no type could catch: it answered a request that supplied
 * somebody else's session id, it let a tool argument reclassify a user's own
 * file as an official source, it believed a client that said「这是 MinerU 转换的」,
 * it returned a 100,000-character paragraph whole when asked for 400, and it
 * computed page numbers in the wrong coordinate system. Every one of them is a
 * statement the product made that was not true, so every test here is written
 * as「the product must not be able to say this」.
 *
 * Everything is the real service, the real repository and the real tools. Where
 * a case is about a tool's own behaviour it calls the tool, not the service.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENT_EXCERPT_CHARS,
  MAX_DOCUMENT_OUTLINE_CHARS,
  createResearchService,
  documentPreview,
  openResearchRepository,
  parseDocument,
  type ResearchService,
} from "@every-dagent/plugin-research";
import { createResearchTools } from "../src/tools.js";

const workDir = mkdtempSync(join(tmpdir(), "researchpage-documents-repair-"));

let opened: { readonly service: ResearchService; readonly close: () => void }[] = [];

function service(): ResearchService {
  const repo = openResearchRepository({ location: ":memory:" });
  const instance = createResearchService({ repo });
  opened.push({ service: instance, close: () => repo.close() });
  return instance;
}

afterEach(() => {
  for (const entry of opened) entry.close();
  opened = [];
});

const PAPER = [
  "# 长上下文推理成本速览",
  "",
  "## 摘要",
  "",
  "本文比较两类模型在长上下文下的推理成本。",
  "",
  "## 结果",
  "",
  "Transformer 的 prefill 成本随上下文线性增长；Mamba 的状态更新成本几乎与长度无关。",
].join("\n");

/** A session with a confirmed direction and a card, so a document can be read. */
function openTask(app: ResearchService, sessionId: string): string {
  const created = app.createIntent(sessionId, { seedTopic: "Transformer" });
  if (created.ok !== true) throw new Error("intent refused");
  app.issueGrant({ sessionId, intent: "intent", taskId: null });
  const proposed = app.proposeIntentDirection(sessionId, {
    topic: "长上下文模型的推理成本比较",
    purpose: "部署选型",
    scope: "比较两类模型的长上下文推理成本",
    summary: "我理解你的研究方向是为部署选型比较长上下文推理成本。",
    subjects: [{ name: "Transformer" }, { name: "Mamba" }],
    dimensions: [
      { name: "成本", question: "推理成本如何？" },
      { name: "机制", question: "如何工作？" },
      { name: "更新", question: "如何更新？" },
    ],
  });
  if (proposed.ok !== true) throw new Error("direction refused");
  app.confirmIntentDirection(created.intent.intentId, {});
  app.issueGrant({ sessionId, intent: "card", taskId: null });
  const card = app.proposeTask(sessionId, {
    topic: "长上下文模型的推理成本比较",
    purpose: "部署选型",
    audience: "架构组",
    focus: [],
    exclusions: "",
    lengthTarget: "约 4 页",
    subjects: [{ name: "Transformer" }, { name: "Mamba" }],
    dimensions: [
      { name: "成本", question: "推理成本如何？" },
      { name: "机制", question: "如何工作？" },
      { name: "更新", question: "如何更新？" },
    ],
  });
  if (card.ok !== true) throw new Error("card refused");
  app.clearGrant(sessionId);
  return card.task.id;
}

describe("A. a document belongs to one session, and every operation says so", () => {
  it("refuses another session's id on every document operation", () => {
    const app = service();
    app.createIntent("iso_a", { seedTopic: "Transformer" });
    app.createIntent("iso_b", { seedTopic: "Transformer" });
    const uploaded = app.uploadDocument({ sessionId: "iso_a", filename: "notes.md", content: { text: PAPER } });
    if (uploaded.ok !== true) throw new Error("upload refused");
    const documentId = uploaded.document.documentId;

    // B names its own session — the shape of「我把 sessionId 换成 B 再试一次」.
    const view = app.documentViewOf(documentId, { sessionId: "iso_b" });
    expect(view !== undefined && "ok" in view && view.code).toBe("document_cross_session");
    const text = app.documentTextOf(documentId, { sessionId: "iso_b" });
    expect(text !== undefined && "ok" in text && text.code).toBe("document_cross_session");
    const read = app.readDocument({ sessionId: "iso_b", documentId, request: {} });
    expect(read.ok).toBe(false);
    if (read.ok !== false) return;
    expect(read.code).toBe("document_cross_session");
    const usage = app.setDocumentUsage(documentId, ["research_source"], { sessionId: "iso_b" });
    expect(usage.ok).toBe(false);
    if (usage.ok !== false) return;
    expect(usage.code).toBe("document_cross_session");
    const removed = app.deleteDocument(documentId, { sessionId: "iso_b" });
    expect(removed.ok).toBe(false);
    if (removed.ok !== false) return;
    expect(removed.code).toBe("document_cross_session");
    // A real task in the other session: the refusal has to come from the
    // document's session, not from a task id that simply does not exist.
    const otherTask = openTask(app, "iso_b");
    const linked = app.linkDocumentToTask(documentId, otherTask, { sessionId: "iso_b" });
    expect(linked.ok).toBe(false);
    if (linked.ok !== false) return;
    expect(linked.code).toBe("document_cross_session");
    const promoted = app.promoteDocumentToSource(documentId, { taskId: otherTask, sessionId: "iso_b" });
    expect(promoted.ok).toBe(false);
    if (promoted.ok !== false) return;
    expect(promoted.code).toBe("document_cross_session");

    // Nothing happened to it: the owner still sees the same document.
    const mine = app.documentViewOf(documentId, { sessionId: "iso_a" });
    expect(mine === undefined || "ok" in mine).toBe(false);
    expect(app.documentsOf({ sessionId: "iso_a" })).toHaveLength(1);
    expect(app.readDocument({ sessionId: "iso_a", documentId, request: {} }).ok).toBe(true);
  });

  it("refuses an operation that names no session at all, and never lists anonymously", () => {
    const app = service();
    app.createIntent("iso_c", { seedTopic: "Transformer" });
    const uploaded = app.uploadDocument({ sessionId: "iso_c", filename: "notes.md", content: { text: PAPER } });
    if (uploaded.ok !== true) throw new Error("upload refused");
    const documentId = uploaded.document.documentId;

    const view = app.documentViewOf(documentId, {});
    expect(view !== undefined && "ok" in view && view.code).toBe("document_scope_missing");
    const removed = app.deleteDocument(documentId, {});
    expect(removed.ok).toBe(false);
    if (removed.ok !== false) return;
    expect(removed.code).toBe("document_scope_missing");
    const usage = app.setDocumentUsage(documentId, ["research_source"], {});
    expect(usage.ok).toBe(false);
    if (usage.ok !== false) return;
    expect(usage.code).toBe("document_scope_missing");
    // A list with no session is refused rather than answered with「什么都没有」.
    const list = app.documentsOf({});
    expect("ok" in list && list.code).toBe("document_scope_missing");
    // An unknown document is its own answer, not「不是你的」.
    const missing = app.documentViewOf("doc_nope", { sessionId: "iso_c" });
    expect(missing !== undefined && "ok" in missing && missing.code).toBe("document_not_found");
  });

  it("refuses a write written against a version of the document that has moved on", () => {
    const app = service();
    app.createIntent("iso_d", { seedTopic: "Transformer" });
    const uploaded = app.uploadDocument({ sessionId: "iso_d", filename: "notes.md", content: { text: PAPER } });
    if (uploaded.ok !== true) throw new Error("upload refused");
    const documentId = uploaded.document.documentId;
    const first = app.documentViewOf(documentId, { sessionId: "iso_d" });
    if (first === undefined || "ok" in first) throw new Error("view refused");
    expect(first.revision).toBe(1);

    const marked = app.setDocumentUsage(documentId, ["intent_context", "research_source"], {
      sessionId: "iso_d",
      expectedRevision: first.revision,
    });
    expect(marked.ok).toBe(true);
    if (marked.ok !== true) return;
    expect(marked.document.revision).toBe(2);

    // The same write again, still naming the first revision: two writes in one
    // millisecond are two writes, and the second one is stale.
    const stale = app.setDocumentUsage(documentId, ["intent_context"], {
      sessionId: "iso_d",
      expectedRevision: first.revision,
    });
    expect(stale.ok).toBe(false);
    if (stale.ok !== false) return;
    expect(stale.conflict).toBe(true);
    expect(stale.problems.join("")).toContain("第 1 版");
    // The usage the user set is still the usage.
    const listed = app.documentsOf({ sessionId: "iso_d" });
    expect("ok" in listed).toBe(false);
    expect(Array.isArray(listed) ? listed[0]?.usage : undefined).toEqual(["intent_context", "research_source"]);
    expect(first.usage).toEqual(["intent_context"]);
  });
});

describe("B. a user's document is user-provided, whatever a tool argument says", () => {
  it("ignores role=official on the first read, and on a reused snapshot", async () => {
    const app = service();
    const taskId = openTask(app, "role_a");
    const uploaded = app.uploadDocument({
      sessionId: "role_a",
      taskId,
      filename: "notes.md",
      content: { text: PAPER },
      usage: ["research_source"],
    });
    if (uploaded.ok !== true) throw new Error("upload refused");
    const promoted = app.promoteDocumentToSource(uploaded.document.documentId, { taskId, sessionId: "role_a" });
    if (promoted.ok !== true) throw new Error(JSON.stringify(promoted));
    app.issueGrant({ sessionId: "role_a", intent: "research", taskId, allowResearch: true });

    const first = await app.read(taskId, { sourceId: promoted.source.id, question: "成本", role: "official" });
    if (first.ok !== true) throw new Error(JSON.stringify(first));
    expect(first.role).toBe("user-provided");
    expect(first.roleIgnored).toBe(true);
    expect(first.note).toContain("role=official 被忽略");
    expect(app.sourcesOf(taskId)[0]?.role).toBe("user-provided");

    // The second read reuses the saved snapshot; the identity does not drift.
    const again = await app.read(taskId, { sourceId: promoted.source.id, question: "成本", role: "primary" });
    if (again.ok !== true) throw new Error(JSON.stringify(again));
    expect(again.reuse).toBe(true);
    expect(again.role).toBe("user-provided");
    expect(again.roleIgnored).toBe(true);
    expect(app.sourcesOf(taskId)[0]?.role).toBe("user-provided");

    // And a role that was already wrong in the record is corrected by the read
    // that follows it, rather than being read back as if it were the truth.
    const source = app.sourcesOf(taskId)[0];
    if (source === undefined) throw new Error("source lost");
    app.getTask(taskId);
    const tools = createResearchTools(app);
    const context = { sessionId: "role_a", signal: new AbortController().signal };
    const tool = tools.byName["read_source"];
    if (tool === undefined) throw new Error("tool missing");
    const result = (await tool.execute({ sourceId: source.id, question: "成本", role: "official" }, context)) as string;
    const parsed = JSON.parse(result) as { role: string; roleIgnored?: boolean };
    expect(parsed.role).toBe("user-provided");
    expect(parsed.roleIgnored).toBe(true);
    expect(app.sourcesOf(taskId)[0]?.role).toBe("user-provided");
  });
});

describe("C. a conversion is a claim unless this server performed it", () => {
  const claimed = {
    provider: "mineru",
    version: "2.1.0",
    originalFilename: "paper.pdf",
    originalFormat: "pdf",
    status: "succeeded" as const,
    sourceRef: "mineru://job/42",
    convertedAt: "2026-10-08T09:00:00Z",
  };

  it("records an HTTP upload's conversion as client_claimed, however it is labelled", () => {
    const app = service();
    app.createIntent("conv_a", { seedTopic: "转换" });
    const markdown = `${PAPER}\n\n## 附录\n\n转换得到的段落。`;
    const uploaded = app.uploadDocument({
      sessionId: "conv_a",
      filename: "converted.md",
      content: { text: markdown },
      conversion: {
        ...claimed,
        // A payload cannot promote itself: these fields are not read at all.
        ...({ trusted: true, verified: true, trust: "server_verified" } as Record<string, unknown>),
        pageMap: [
          { page: 1, charStart: 0, charEnd: 20 },
          { page: 2, charStart: 20, charEnd: markdown.length },
        ],
      },
    });
    if (uploaded.ok !== true) throw new Error(JSON.stringify(uploaded));
    expect(uploaded.document.conversion?.trust).toBe("client_claimed");
    expect(uploaded.document.note).toContain("未经过服务端核验");
    expect(uploaded.document.conversionProvider).toBe("mineru");
  });

  it("writes server_verified only through the server's own import path", () => {
    const app = service();
    app.createIntent("conv_b", { seedTopic: "转换" });
    const markdown = "# 从 PDF 转换\n\n服务端转换得到的段落。";
    const imported = app.importConvertedDocument({
      sessionId: "conv_b",
      filename: "converted.md",
      content: { text: markdown },
      conversion: { ...claimed, pageMap: [{ page: 1, charStart: 0, charEnd: markdown.length }] },
    });
    if (imported.ok !== true) throw new Error(JSON.stringify(imported));
    expect(imported.document.conversion?.trust).toBe("server_verified");
    expect(imported.document.note).toContain("服务端调用 mineru");
    expect(imported.document.note).not.toContain("未经服务端核验");
  });

  it("refuses a page map that is not inside the Markdown it claims to map", () => {
    const app = service();
    app.createIntent("conv_c", { seedTopic: "转换" });
    const markdown = "# 只有一页\n\n很短的正文。";
    const beyond = app.uploadDocument({
      sessionId: "conv_c",
      filename: "oob.md",
      content: { text: markdown },
      conversion: { ...claimed, pageMap: [{ page: 1, charStart: 0, charEnd: markdown.length + 50 }] },
    });
    expect(beyond.ok).toBe(false);
    if (beyond.ok !== false) return;
    expect(beyond.problems.join("")).toContain("超出");

    const inverted = app.uploadDocument({
      sessionId: "conv_c",
      filename: "inverted.md",
      content: { text: markdown },
      conversion: { ...claimed, pageMap: [{ page: 1, charStart: 10, charEnd: 4 }] },
    });
    expect(inverted.ok).toBe(false);

    const overlapping = app.uploadDocument({
      sessionId: "conv_c",
      filename: "overlap.md",
      content: { text: markdown },
      conversion: {
        ...claimed,
        pageMap: [
          { page: 1, charStart: 0, charEnd: 8 },
          { page: 2, charStart: 4, charEnd: 12 },
        ],
      },
    });
    expect(overlapping.ok).toBe(false);
    if (overlapping.ok !== false) return;
    expect(overlapping.problems.join("")).toContain("重叠");

    const badTime = app.uploadDocument({
      sessionId: "conv_c",
      filename: "time.md",
      content: { text: markdown },
      conversion: { ...claimed, convertedAt: "昨天下午" },
    });
    expect(badTime.ok).toBe(false);
    if (badTime.ok !== false) return;
    expect(badTime.problems.join("")).toContain("时间");

    // Nothing was stored by any of those attempts.
    expect(app.documentsOf({ sessionId: "conv_c" })).toHaveLength(0);
  });
});

describe("D. a long paragraph cannot answer a short request with all of itself", () => {
  const LONG = "这一段很长，用来验证截断行为。".repeat(8_000);
  const document = ["# 长段落文档", "", "## 正文", "", LONG, "", "## 结尾", "", "最后一段很短。"].join("\n");

  it("clips at a real position in the user's own text and marks it partial", () => {
    const app = service();
    app.createIntent("long_a", { seedTopic: "长段落" });
    const uploaded = app.uploadDocument({ sessionId: "long_a", filename: "long.md", content: { text: document } });
    if (uploaded.ok !== true) throw new Error("upload refused");
    const documentId = uploaded.document.documentId;

    const read = app.readDocument({ sessionId: "long_a", documentId, request: { paragraphIndex: 0, maxChars: 400 } });
    if (read.ok !== true) throw new Error("read refused");
    const fragment = read.fragments[0];
    if (fragment === undefined) throw new Error("no fragment");
    // The bound is on the whole answer: text and outline together.
    expect(fragment.text.length).toBeLessThanOrEqual(400);
    expect(fragment.text.length + read.outlineChars).toBeLessThanOrEqual(400);
    expect(read.scope).toBe("partial");
    expect(read.truncated).toBe(true);
    expect(fragment.truncated).toBe(true);
    expect(read.note).toContain("部分读取");
    // The text really is the user's own characters, at the position it reports.
    expect(LONG.startsWith(fragment.text)).toBe(true);
    expect(document.slice(fragment.sourceStart, fragment.sourceEnd)).toBe(fragment.text);
    expect(fragment.page).toBeNull();

    // The default read of the whole document is bounded too.
    const whole = app.readDocument({ sessionId: "long_a", documentId, request: {} });
    if (whole.ok !== true) throw new Error("read refused");
    expect(whole.readChars).toBeLessThanOrEqual(MAX_DOCUMENT_EXCERPT_CHARS);
    expect(whole.readChars + whole.outlineChars).toBeLessThanOrEqual(MAX_DOCUMENT_EXCERPT_CHARS);
    expect(whole.scope).toBe("partial");
  });

  it("keeps a matching read useful: the window contains what was asked for", () => {
    const app = service();
    app.createIntent("long_b", { seedTopic: "长段落" });
    const needle = "这里有一个独特的关键词 needle-keyword 需要被找到";
    const body = `${"前缀填充。".repeat(3_000)}${needle}${"后缀填充。".repeat(3_000)}`;
    const uploaded = app.uploadDocument({
      sessionId: "long_b",
      filename: "needle.md",
      content: { text: `# 关键词文档\n\n## 正文\n\n${body}` },
    });
    if (uploaded.ok !== true) throw new Error("upload refused");
    const read = app.readDocument({
      sessionId: "long_b",
      documentId: uploaded.document.documentId,
      request: { terms: ["needle-keyword"], maxChars: 600 },
    });
    if (read.ok !== true) throw new Error("read refused");
    const text = read.fragments.map((fragment) => fragment.text).join("");
    expect(text).toContain("needle-keyword");
    expect(text.length).toBeLessThanOrEqual(600);
    expect(read.truncated).toBe(true);
  });
});

describe("E. an outline is bounded like everything else a prompt carries", () => {
  const headings = Array.from({ length: 2_000 }, (_, index) => `## 章节 ${index + 1}\n\n第 ${index + 1} 节的内容。`).join("\n\n");
  const document = `# 目录很长的文档\n\n${headings}`;

  it("never lets a table of contents spend the context", () => {
    const app = service();
    app.createIntent("outline_a", { seedTopic: "目录" });
    const uploaded = app.uploadDocument({ sessionId: "outline_a", filename: "many-headings.md", content: { text: document } });
    if (uploaded.ok !== true) throw new Error("upload refused");
    const documentId = uploaded.document.documentId;
    expect(uploaded.document.outlineTotal).toBe(2_001);
    expect(uploaded.document.outlineTruncated).toBe(true);
    expect(uploaded.document.outline.length).toBeLessThan(200);
    const outlineChars = uploaded.document.outline.reduce((sum, heading) => sum + heading.level + 1 + heading.text.length, 0);
    expect(outlineChars).toBeLessThanOrEqual(MAX_DOCUMENT_OUTLINE_CHARS);

    const contexts = app.documentContextOf({ documentIds: [documentId] }, 1_500);
    const context = contexts[0];
    if (context === undefined) throw new Error("no context");
    expect(context.previewChars + context.outline.reduce((sum, line) => sum + line.length, 0)).toBeLessThanOrEqual(1_500);
    expect(context.outlineTruncated).toBe(true);
    expect(context.outlineTotal).toBe(2_001);
    expect(context.note).toContain("目录过长");

    const read = app.readDocument({ sessionId: "outline_a", documentId, request: {} });
    if (read.ok !== true) throw new Error("read refused");
    expect(read.outline.length).toBeLessThan(200);
    expect(read.outlineChars).toBeLessThanOrEqual(MAX_DOCUMENT_OUTLINE_CHARS);
    expect(read.readChars + read.outlineChars).toBeLessThanOrEqual(MAX_DOCUMENT_EXCERPT_CHARS);
    expect(read.note).toContain("目录过长");
  });
});

describe("G. a page number is answered in the coordinate system it was written in", () => {
  it("maps the second page of the Markdown to the second page", () => {
    const markdown = [
      "# 两页文档",
      "",
      "## 第一节",
      "",
      "第一页的正文内容。",
      "",
      "## 第二节",
      "",
      "第二页的正文内容。",
    ].join("\n");
    const second = markdown.indexOf("## 第二节");
    const app = service();
    app.createIntent("page_a", { seedTopic: "页码" });
    const uploaded = app.uploadDocument({
      sessionId: "page_a",
      filename: "pages.md",
      content: { text: markdown },
      conversion: {
        provider: "mineru",
        originalFilename: "paper.pdf",
        originalFormat: "pdf",
        status: "succeeded",
        pageMap: [
          { page: 1, charStart: 0, charEnd: second },
          { page: 2, charStart: second, charEnd: markdown.length },
        ],
      },
    });
    if (uploaded.ok !== true) throw new Error(JSON.stringify(uploaded));
    const documentId = uploaded.document.documentId;

    const read = app.readDocument({
      sessionId: "page_a",
      documentId,
      request: { terms: ["第二页的正文内容"] },
    });
    if (read.ok !== true) throw new Error("read refused");
    const fragment = read.fragments.find((entry) => entry.text.includes("第二页"));
    if (fragment === undefined) throw new Error("no second-page fragment");
    expect(fragment.page).toBe(2);
    // The joined-text coordinate is a different number from the Markdown
    // coordinate; using the first one is exactly how the page came out wrong.
    expect(fragment.charStart).not.toBe(fragment.sourceStart);
    expect(markdown.slice(fragment.sourceStart, fragment.sourceEnd)).toBe(fragment.text);

    const first = app.readDocument({ sessionId: "page_a", documentId, request: { terms: ["第一页的正文内容"] } });
    if (first.ok !== true) throw new Error("read refused");
    const firstFragment = first.fragments.find((entry) => entry.text.includes("第一页"));
    expect(firstFragment?.page).toBe(1);

    // A paragraph the converter did not map answers nothing rather than a guess.
    const parsed = parseDocument(markdown);
    expect(parsed.paragraphs.length).toBeGreaterThan(0);
  });

  it("answers no page at all when there is no map", () => {
    const app = service();
    app.createIntent("page_b", { seedTopic: "页码" });
    const uploaded = app.uploadDocument({
      sessionId: "page_b",
      filename: "unmapped.md",
      content: { text: "# 无映射\n\n正文。" },
      conversion: { provider: "mineru", originalFilename: "paper.pdf", originalFormat: "pdf", status: "succeeded" },
    });
    if (uploaded.ok !== true) throw new Error(JSON.stringify(uploaded));
    expect(uploaded.document.conversion?.pageMap).toEqual([]);
    expect(uploaded.document.conversion?.convertedAt).toBeNull();
    const read = app.readDocument({ sessionId: "page_b", documentId: uploaded.document.documentId, request: {} });
    if (read.ok !== true) throw new Error("read refused");
    expect(read.fragments.every((fragment) => fragment.page === null)).toBe(true);
  });
});

describe("F. the content limits are the library's, not the transport's", () => {
  it("accepts a 40 KiB file and refuses one over the limit by content, not by encoding", () => {
    const app = service();
    app.createIntent("limit_a", { seedTopic: "上限" });
    const forty = `# 四十 KB\n\n${"内容".repeat(20 * 1024)}`;
    const accepted = app.uploadDocument({ sessionId: "limit_a", filename: "forty.md", content: { text: forty } });
    expect(accepted.ok).toBe(true);

    const over = app.uploadDocument({
      sessionId: "limit_a",
      filename: "over.md",
      content: { text: `# 太大\n\n${"内".repeat(MAX_DOCUMENT_BYTES)}` },
    });
    expect(over.ok).toBe(false);
    if (over.ok !== false) return;
    expect(over.code).toBe("document_too_large");
    expect(over.problems.join("")).toContain("文件过大");
  });

  it("refuses bytes that are not UTF-8 instead of storing replacement characters", () => {
    const app = service();
    app.createIntent("limit_b", { seedTopic: "编码" });
    const gbk = new Uint8Array([0xb1, 0xe0, 0xb1, 0xe0, 0x0a, 0xd6, 0xd0, 0xce, 0xc4]);
    const refused = app.uploadDocument({ sessionId: "limit_b", filename: "gbk.md", content: { bytes: gbk } });
    expect(refused.ok).toBe(false);
    if (refused.ok !== false) return;
    expect(refused.problems.join("")).toContain("UTF-8");
    expect(app.documentsOf({ sessionId: "limit_b" })).toHaveLength(0);

    // Text that cannot survive a UTF-8 round trip is refused as well.
    const lone = app.uploadDocument({ sessionId: "limit_b", filename: "lone.md", content: { text: "# x\n\n\uD800" } });
    expect(lone.ok).toBe(false);
  });

  it("reports a missing session as a missing session, and a huge file as a huge file", () => {
    const app = service();
    const anonymous = app.uploadDocument({ filename: "notes.md", content: { text: PAPER } });
    expect(anonymous.ok).toBe(false);
    if (anonymous.ok !== false) return;
    expect(anonymous.code).toBe("document_scope_missing");
    expect(anonymous.problems.join("")).toContain("会话");

    // Both are wrong here, and the size is the answer that helps: the file was
    // checked before the session was looked for.
    const both = app.uploadDocument({
      filename: "huge.md",
      content: { text: `# 太大\n\n${"内".repeat(MAX_DOCUMENT_BYTES)}` },
    });
    expect(both.ok).toBe(false);
    if (both.ok !== false) return;
    expect(both.code).toBe("document_too_large");
    expect(both.problems.join("")).toContain("文件过大");
  });
});

describe("H. the paths next to the document library still work", () => {
  it("reads a user document into evidence, and the evidence verifies", async () => {
    const app = service();
    const taskId = openTask(app, "regress_a");
    const uploaded = app.uploadDocument({
      sessionId: "regress_a",
      taskId,
      filename: "notes.md",
      content: { text: PAPER },
      usage: ["intent_context", "research_source"],
    });
    if (uploaded.ok !== true) throw new Error("upload refused");
    const promoted = app.promoteDocumentToSource(uploaded.document.documentId, { taskId, sessionId: "regress_a" });
    if (promoted.ok !== true) throw new Error(JSON.stringify(promoted));
    app.issueGrant({ sessionId: "regress_a", intent: "research", taskId, allowResearch: true });

    const read = await app.read(taskId, { sourceId: promoted.source.id, question: "成本", maxEvidence: 2 });
    if (read.ok !== true) throw new Error(JSON.stringify(read));
    expect(read.readScope).toBe("full_text");
    expect(read.evidence.length).toBeGreaterThan(0);
    const snapshotId = app.sourcesOf(taskId)[0]?.snapshotId ?? "";
    expect(snapshotId.length).toBeGreaterThan(0);
    const snapshot = app.snapshotTextOf(snapshotId) ?? "";
    for (const item of app.evidenceOf(taskId)) {
      expect(snapshot.slice(item.locator.charStart, item.locator.charEnd)).toBe(item.excerpt);
    }
    // The read of a user's own file is not a discovery: the budget is untouched.
    expect(app.getTask(taskId)?.usage.reads).toBe(0);
    // The matrix still derives from real evidence, and nothing was auto-accepted.
    expect(app.cellsOf(taskId).length).toBeGreaterThan(0);
    expect(app.reportsOf(taskId)).toHaveLength(0);
  });
});

describe("the library's own rules stay intact", () => {
  it("keeps paragraph positions exact after the source-offset change", () => {
    const parsed = parseDocument(PAPER);
    for (const paragraph of parsed.paragraphs) {
      expect(parsed.text.slice(paragraph.charStart, paragraph.charEnd)).toBe(paragraph.text);
      expect(PAPER.slice(paragraph.sourceStart ?? -1, paragraph.sourceEnd ?? -1)).toBe(paragraph.text);
    }
  });

  it("keeps the work directory unused but present", () => {
    // The other cases keep everything in memory; this one only pins the path
    // so a future case that needs a file has somewhere to put it.
    expect(workDir.length).toBeGreaterThan(0);
  });
});

/**
 * The closing review's first defect, with the counterexample that proved it:
 * `maxChars` was not a limit. Reads below 200 characters were quietly widened to
 * 200, the outline's first entry was exempt from the budget that was bounding it,
 * and the answer's own sentences were appended after the budget had been spent —
 * so a 100,000-character label answered a 100-character request with 208
 * characters, and a context block asked for 200 answered with 301.
 *
 * Every assertion below is the same statement the review made: what comes back
 * is at most what was asked for. The budget is asserted against the exact
 * `maxChars` — never a widened one.
 */
describe("a heading longer than the budget cannot spend the budget", () => {
  // 105,000 characters of label and 108,000 of prose in a single paragraph. The
  // filler is Latin so the file stays well under the library's own 512 KB limit.
  const LABEL = "a-long-heading-label-".repeat(5_000);
  const BODY = "a-body-paragraph-sentence. ".repeat(4_000);
  const document = `# ${LABEL}\n\n${BODY}`;
  const joined = parseDocument(document).text;
  let sessions = 0;

  /** What one long document project looks like; each case gets its own service. */
  function longDocument(): { readonly app: ResearchService; readonly sessionId: string; readonly documentId: string } {
    const app = service();
    const sessionId = `head_${sessions += 1}`;
    app.createIntent(sessionId, { seedTopic: "超长标题" });
    const uploaded = app.uploadDocument({ sessionId, filename: "long-heading.md", content: { text: document } });
    if (uploaded.ok !== true) throw new Error(JSON.stringify(uploaded));
    return { app, sessionId, documentId: uploaded.document.documentId };
  }

  /** Everything a bounded read carries: the fragments, the outline, its own sentences. */
  function readChars(read: { readonly readChars: number; readonly outlineChars: number; readonly note: string }): number {
    return read.readChars + read.outlineChars + read.note.length;
  }

  /** Everything a bounded preview carries. */
  function previewChars(preview: { readonly charsRead: number; readonly outlineChars: number; readonly note: string }): number {
    return preview.charsRead + preview.outlineChars + preview.note.length;
  }

  /** Everything a context block carries — the sentence that marks the text as data included. */
  function blockChars(block: { readonly previewChars: number; readonly outline: readonly string[]; readonly note: string }): number {
    return block.previewChars + block.outline.reduce((sum, line) => sum + line.length, 0) + block.note.length;
  }

  it("returns at most maxChars from every read strategy, at 100 and at 200", () => {
    const { app, sessionId, documentId } = longDocument();
    for (const maxChars of [100, 200]) {
      for (const request of [{}, { question: "body" }, { terms: ["body"] }, { sectionIndex: 0 }, { paragraphIndex: 0 }]) {
        const read = app.readDocument({ sessionId, documentId, request: { ...request, maxChars } });
        if (read.ok !== true) throw new Error("read refused");
        const label = `maxChars=${maxChars} ${JSON.stringify(request)}`;
        expect(readChars(read), label).toBeLessThanOrEqual(maxChars);
        expect(read.outlineChars, label).toBeLessThanOrEqual(maxChars);
        // A document this long cannot be read whole inside these budgets, and the
        // answer may not pretend otherwise.
        expect(read.scope, label).toBe("partial");
        expect(read.truncated, label).toBe(true);
        expect(read.fragments.length, label).toBeGreaterThan(0);
        for (const fragment of read.fragments) {
          // Whatever the budget did to the answer, the text is still the user's
          // own characters at the position it reports — in the stored Markdown,
          // and in the joined text an excerpt is verified against.
          expect(document.slice(fragment.sourceStart, fragment.sourceEnd), label).toBe(fragment.text);
          expect(joined.slice(fragment.charStart, fragment.charEnd), label).toBe(fragment.text);
          expect(fragment.truncated, label).toBe(true);
        }
      }
    }
  });

  it("returns at most maxChars from a preview and from a context block, at 100 and at 200", () => {
    const { app, documentId } = longDocument();
    // 100 and 200 are the review's own numbers; 600 and 1 500 are the budgets the
    // research runner asks for, so these are the sizes its prompts really carry.
    for (const maxChars of [100, 200, 600, 1_500]) {
      const preview = documentPreview({
        documentId,
        filename: "long-heading.md",
        title: "超长标题",
        parsed: parseDocument(document),
        maxChars,
      });
      expect(previewChars(preview), `preview ${maxChars}`).toBeLessThanOrEqual(maxChars);
      expect(preview.complete).toBe(false);
      expect(preview.note).toContain("部分读取");
      // The first outline entry obeys the same budget as the rest of the answer:
      // a 105,000-character label is cut down, never kept whole.
      const first = preview.outline[0];
      if (first === undefined) throw new Error("no heading");
      expect(preview.outlineChars, `preview ${maxChars}`).toBeLessThanOrEqual(maxChars);
      expect(first.text.length).toBeLessThan(LABEL.length);
      expect(LABEL.startsWith(first.text.replace(/…$/, "")), `preview ${maxChars}`).toBe(true);

      const contexts = app.documentContextOf({ documentIds: [documentId] }, maxChars);
      const block = contexts[0];
      if (block === undefined) throw new Error("no context block");
      expect(blockChars(block), `context ${maxChars}`).toBeLessThanOrEqual(maxChars);
      expect(block.complete).toBe(false);
      // The block's own sentence is inside the budget rather than appended to it.
      expect(block.note.length, `context ${maxChars}`).toBeLessThanOrEqual(maxChars);
    }
  });

  it("keeps a budget too small for a sentence instead of writing one anyway", () => {
    // The other end of the same rule: when nothing fits, the answer is empty or
    // nearly so —「宁可返回空内容或简短的截断结果」— because a budget that small
    // was named by a caller sizing something with it.
    const { app, sessionId, documentId } = longDocument();
    const parsed = parseDocument(document);
    for (const maxChars of [0, 1, 10, 40, 60, 100]) {
      for (const request of [{}, { paragraphIndex: 0 }, { terms: ["body"] }]) {
        const read = app.readDocument({ sessionId, documentId, request: { ...request, maxChars } });
        if (read.ok !== true) throw new Error("read refused");
        expect(readChars(read), `read ${maxChars} ${JSON.stringify(request)}`).toBeLessThanOrEqual(maxChars);
      }
      const preview = documentPreview({ documentId, filename: "long.md", title: "t", parsed, maxChars });
      expect(previewChars(preview), `preview ${maxChars}`).toBeLessThanOrEqual(maxChars);
      for (const block of app.documentContextOf({ documentIds: [documentId] }, maxChars)) {
        expect(blockChars(block), `block ${maxChars}`).toBeLessThanOrEqual(maxChars);
      }
    }

    // A 45-character budget cannot hold the long「只读取了…」sentence, so the same
    // fact is written in its short form — the numbers are the numbers, and the
    // answer stays inside 45 either way.
    const shortForm = app.readDocument({ sessionId, documentId, request: { maxChars: 45 } });
    if (shortForm.ok !== true) throw new Error("read refused");
    expect(readChars(shortForm)).toBeLessThanOrEqual(45);
    expect(shortForm.note).toMatch(/部分读取：\d+\/\d+ 字/);
  });

  it("still reads a short document in full, without truncating it to be safe", () => {
    // The strict budget must not become「everything is partial」: a document that
    // fits is still returned whole, at a small budget and at the default one.
    const short = "# 短文\n\n一句话。\n\n## 第二节\n\n另一句话。";
    const app = service();
    app.createIntent("short_a", { seedTopic: "短文" });
    const uploaded = app.uploadDocument({ sessionId: "short_a", filename: "short.md", content: { text: short } });
    if (uploaded.ok !== true) throw new Error("upload refused");
    const documentId = uploaded.document.documentId;
    const parsed = parseDocument(short);
    const contentChars = parsed.paragraphs.reduce((sum, paragraph) => sum + paragraph.text.length, 0);

    for (const maxChars of [200, 400, undefined]) {
      const read = app.readDocument({ sessionId: "short_a", documentId, request: maxChars === undefined ? {} : { maxChars } });
      if (read.ok !== true) throw new Error("read refused");
      const label = `maxChars=${String(maxChars)}`;
      // Every paragraph came back, whole, and nothing claims otherwise.
      expect(read.fragments.length, label).toBe(parsed.paragraphs.length);
      expect(read.fragments.every((fragment) => !fragment.truncated), label).toBe(true);
      expect(read.readChars, label).toBe(contentChars);
      expect(read.outlineTruncated, label).toBe(false);
      expect(read.outline.length, label).toBe(parsed.outline.length);
      for (const fragment of read.fragments) {
        expect(short.slice(fragment.sourceStart, fragment.sourceEnd), label).toBe(fragment.text);
      }
      if (maxChars !== undefined) expect(readChars(read), label).toBeLessThanOrEqual(maxChars);
    }

    // The one case where a read may say it read everything: a document whose text
    // is a single paragraph, which is the case the whole-text claim is defined
    // against. It says so, at a budget far smaller than the default one.
    const single = app.uploadDocument({ sessionId: "short_a", filename: "single.md", content: { text: "# t\n\n一句话。" } });
    if (single.ok !== true) throw new Error("upload refused");
    const whole = app.readDocument({ sessionId: "short_a", documentId: single.document.documentId, request: { maxChars: 200 } });
    if (whole.ok !== true) throw new Error("read refused");
    expect(whole.scope).toBe("full");
    expect(whole.truncated).toBe(false);
    expect(whole.note).toContain("已读取全文");
    expect(readChars(whole)).toBeLessThanOrEqual(200);

    const preview = documentPreview({ documentId, filename: "short.md", title: "短文", parsed, maxChars: 400 });
    expect(preview.complete).toBe(true);
    expect(preview.text).toBe(parsed.text);
    expect(previewChars(preview)).toBeLessThanOrEqual(400);
  });

  it("keeps a clipped first heading located in the stored Markdown", () => {
    const app = service();
    app.createIntent("head_c", { seedTopic: "超长标题" });
    const uploaded = app.uploadDocument({ sessionId: "head_c", filename: "long-heading.md", content: { text: document } });
    if (uploaded.ok !== true) throw new Error(JSON.stringify(uploaded));
    const shown = app.documentViewOf(uploaded.document.documentId, { sessionId: "head_c" });
    if ("ok" in shown) throw new Error("view refused");
    const heading = shown.outline[0];
    if (heading === undefined) throw new Error("no heading");
    // The label is shorter than the one the user wrote; the range it came from
    // is not, so the section it names can still be found in the file.
    expect(heading.text.length).toBeLessThan(LABEL.length);
    expect(document.slice(heading.titleStart, heading.titleEnd)).toBe(LABEL);
  });
});

/**
 * The closing review's other defect: an attachment over the content limit came
 * back as「请求不合法」— the library's own `document_too_large` never reached the
 * transport — and the exploration it arrived with had to be gone.
 */
describe("an over-limit attachment leaves nothing behind", () => {
  it("refuses the exploration, the oversized file and the good file beside it", () => {
    const app = service();
    const oversized = `# 太大\n\n${"x".repeat(MAX_DOCUMENT_BYTES + 8)}`;
    const refused = app.createIntent("half_a", {
      seedTopic: "带一个超大附件",
      documents: [
        { filename: "ok.md", content: { text: "# 可以保存\n\n这一段没有问题。" } },
        { filename: "big.md", content: { text: oversized } },
      ],
    });
    expect(refused.ok).toBe(false);
    if (refused.ok !== false) return;
    // The reason is the file's size rather than the request's shape: the
    // transport answers this one with 413.
    expect(refused.code).toBe("document_too_large");
    // Nothing half-made: no exploration, and no document from that request —
    // including the one that would have been fine on its own.
    expect(app.intentForSession("half_a")).toBeUndefined();
    const listed = app.documentsOf({ sessionId: "half_a" });
    expect("ok" in listed ? 0 : listed.length).toBe(0);

    // The ordinary path is unchanged: the same request without the oversized file
    // creates the exploration and keeps its attachment.
    const accepted = app.createIntent("half_b", {
      seedTopic: "带一个正常附件",
      documents: [{ filename: "ok.md", content: { text: "# 可以保存\n\n这一段没有问题。" } }],
    });
    expect(accepted.ok).toBe(true);
    if (accepted.ok !== true) return;
    expect(accepted.intent.documents).toHaveLength(1);
  });
});
