/**
 * The exploration panel, as markup.
 *
 * A browser gate proves a reader can get through the flow; it cannot prove what
 * the panel says when the flow is *not* available. These cases are about those
 * sentences: the composer that explains why it cannot send, the editor that
 * refuses to confirm an unsaved draft, the panel that says a PDF landed after
 * the direction was written instead of pretending the direction considered it,
 * and the confirmed state that offers nothing to type into.
 */

import { MantineProvider } from "@mantine/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { IntentTurnView, IntentView, LibraryDocumentView, ResearchDirectionView } from "../src/browser/api.js";
import { IntentPanel, type IntentPanelProps } from "../src/browser/views/intent.js";

function direction(overrides: Partial<ResearchDirectionView> = {}): ResearchDirectionView {
  return {
    topic: "长文档问答的 RAG 选型",
    purpose: "在条件化差异下给出选型判断",
    scope: "只比较检索增强的几条路线",
    audience: "正在做技术选型的工程师",
    focus: ["成本口径"],
    exclusions: "不评价具体商业产品",
    lengthTarget: "4–6 页",
    subjects: [{ name: "GraphRAG" }],
    dimensions: [{ name: "成本", question: "三段成本分别如何报告？" }],
    summary: "我理解你的研究方向是……",
    at: "2026-10-09T00:00:00.000Z",
    source: "agent",
    ...overrides,
  };
}

function document(overrides: Partial<LibraryDocumentView> & { readonly documentId: string }): LibraryDocumentView {
  return {
    sessionId: "sess_1",
    taskId: null,
    originalFilename: "notes.md",
    title: "长上下文部署笔记",
    sizeBytes: 2048,
    contentHash: "hash",
    createdAt: "2026-10-09T00:00:00.000Z",
    origin: "direct_upload",
    conversionProvider: null,
    conversion: null,
    status: "ready",
    usage: ["intent_context"],
    outline: [],
    outlineTotal: 0,
    outlineTruncated: false,
    revision: 1,
    note: "",
    failure: null,
    linkedSourceId: null,
    chars: 2048,
    paragraphs: 3,
    truncated: false,
    ...overrides,
  };
}

function intent(overrides: Partial<IntentView> = {}): IntentView {
  const turns: readonly IntentTurnView[] = [
    { id: "trn_1", role: "assistant", at: "2026-10-09T00:00:01.000Z", text: "你这次最想弄清楚的核心问题是什么？", why: "这决定了报告以机制解释为主还是以选型建议为主。" },
  ];
  return {
    intentId: "itn_1",
    sessionId: "sess_1",
    seedTopic: "Agent 记忆系统的实现路径比较",
    status: "exploring",
    statusLabel: "了解中",
    version: 2,
    createdAt: "2026-10-09T00:00:00.000Z",
    updatedAt: "2026-10-09T00:00:01.000Z",
    taskId: null,
    turns,
    decisions: [],
    proposal: null,
    proposalSummary: null,
    confirmedDirection: null,
    confirmedAt: null,
    documents: [],
    pending: {
      turnId: "trn_1",
      text: "你这次最想弄清楚的核心问题是什么？",
      why: "这决定了报告以机制解释为主还是以选型建议为主。",
      options: ["机制优先：想搞清楚各条实现路径的底层机制", "选型优先：想知道该选哪条路径、代价与坑在哪"],
      proposesDirection: false,
    },
    canConfirm: false,
    confirmQuestion: "我理解你的研究方向是上面这些，是否准确？",
    openFields: [],
    userMessages: [],
    assistantQuestions: ["你这次最想弄清楚的核心问题是什么？"],
    ...overrides,
  };
}

function render(overrides: Partial<IntentPanelProps> = {}): string {
  const props: IntentPanelProps = {
    intent: intent(),
    busy: false,
    working: false,
    confirmedAt: null,
    now: 1_000_000,
    newerDocumentIds: [],
    onSend: () => undefined,
    onSaveDirection: () => undefined,
    onConfirm: () => undefined,
    onUseDocument: () => undefined,
    onRetryRead: () => undefined,
    onStartFresh: () => undefined,
    ...overrides,
  };
  return renderToStaticMarkup(createElement(MantineProvider, null, createElement(IntentPanel, props)));
}

describe("the exploration panel while it is still deciding", () => {
  it("shows the topic, the status and the assistant's question", () => {
    const markup = render();
    expect(markup).toContain("Agent 记忆系统的实现路径比较");
    expect(markup).toContain("了解中");
    expect(markup).toContain("你这次最想弄清楚的核心问题是什么？");
  });

  it("keeps the reasoning behind a question folded away", () => {
    const markup = render();
    // The question is what the reader answers; the reasoning is a disclosure,
    // and it is the question that gets the size and the weight.
    expect(markup).toContain('data-testid="intent-why-trn_1"');
    expect(markup).toContain("为什么这样问");
    expect(markup).toContain("<details");
    expect(markup).not.toMatch(/<details[^>]*\sopen/);
    expect(markup).toContain("这决定了报告以机制解释为主");
  });

  it("separates the conversation column from the direction decision", () => {
    const markup = render();
    expect(markup).toContain('class="rp-intent"');
    expect(markup).toContain('class="rp-intent__main"');
    expect(markup).toContain('class="rp-intent__aside"');
    // The composer lives in the conversation column, not after the decision.
    const composer = markup.indexOf("rp-intent__composer");
    const aside = markup.indexOf("rp-intent__aside");
    expect(composer).toBeGreaterThan(-1);
    expect(aside).toBeGreaterThan(-1);
    expect(composer).toBeLessThan(aside);
  });

  it("says what confirmation means before there is anything to confirm", () => {
    const markup = render();
    expect(markup).toContain("还没有可确认的方向");
    expect(markup).not.toContain('data-testid="intent-confirm"');
  });

  it("offers the assistant's ready-made answers, and says they are only text", () => {
    const markup = render();
    expect(markup).toContain("机制优先：想搞清楚各条实现路径的底层机制");
    expect(markup).toContain("点一下会填进下面的输入框");
  });

  it("disables the composer while a turn is running and says why", () => {
    const markup = render({ busy: true });
    expect(markup).toContain("正在处理上一轮");
    expect(markup).toContain("正在处理上一条消息");
  });
});

describe("the direction on the table", () => {
  const proposed = intent({
    status: "ready_to_confirm",
    statusLabel: "方向待确认",
    proposal: direction(),
    canConfirm: true,
    openFields: ["dimensions"],
  });

  it("shows the four fields the user edits and the suggestion behind them", () => {
    const markup = render({ intent: proposed });
    expect(markup).toContain('data-testid="intent-direction"');
    expect(markup).toContain("长文档问答的 RAG 选型");
    expect(markup).toContain("在条件化差异下给出选型判断");
    expect(markup).toContain("助手建议的比较对象、研究维度、关注点");
    expect(markup).toContain("这些建议会在任务卡里作为建议保留");
  });

  it("offers confirmation, and says which brief fields are still open", () => {
    const markup = render({ intent: proposed });
    expect(markup).toContain('data-testid="intent-confirm"');
    expect(markup).toContain("确认方向，建立任务卡");
    expect(markup).toContain("研究维度");
    expect(markup).toContain("这份方向还没有说清楚");
  });

  it("keeps confirmation available when an edit is on screen, and blocks the save until it is dirty", () => {
    const markup = render({ intent: proposed });
    // Nothing has been typed, so the save button is present but disabled.
    expect(markup).toContain('data-testid="intent-direction-save"');
    expect(markup).toContain('disabled=""');
  });
});

describe("documents that arrived after the direction was written", () => {
  it("says the proposal may not have read them, and offers to bring one into the next turn", () => {
    const withDocument = intent({
      status: "ready_to_confirm",
      statusLabel: "方向待确认",
      proposal: direction(),
      canConfirm: true,
      documents: [document({ documentId: "doc_new", title: "长上下文部署笔记", createdAt: "2026-10-09T02:00:00.000Z" })],
    });
    const markup = render({ intent: withDocument, newerDocumentIds: ["doc_new"] });
    expect(markup).toContain("有文档是在方向建议之后才入库的");
    expect(markup).toContain("建议里可能没有参考它们");
    expect(markup).toContain('data-testid="intent-use-document-doc_new"');
  });

  it("offers only documents that are in the library as attachments to a message", () => {
    const withDocuments = intent({
      documents: [
        document({ documentId: "doc_ready" }),
        document({ documentId: "doc_failed", status: "failed", title: "还没入库的文件" }),
      ],
    });
    const markup = render({ intent: withDocuments });
    expect(markup).toContain('data-testid="intent-attach-doc_ready"');
    expect(markup).not.toContain('data-testid="intent-attach-doc_failed"');
  });
});

describe("a confirmed direction", () => {
  const confirmed = intent({
    status: "confirmed",
    statusLabel: "方向已确认",
    proposal: direction(),
    confirmedDirection: direction({ source: "user" }),
    confirmedAt: "2026-10-09T03:00:00.000Z",
    canConfirm: false,
    taskId: null,
  });

  it("is read-only, and says the conversation is over", () => {
    const markup = render({ intent: confirmed, confirmedAt: 1_000_000 });
    expect(markup).toContain('data-testid="intent-confirmed"');
    expect(markup).toContain("已确认的研究方向");
    expect(markup).toContain("不能再改");
    expect(markup).not.toContain('data-testid="intent-message-input"');
    expect(markup).not.toContain('data-testid="intent-direction-save"');
  });

  it("waits for the task card without pretending the confirmation failed", () => {
    const markup = render({ intent: confirmed, confirmedAt: 1_000_000 });
    expect(markup).toContain('data-testid="intent-task-wait"');
    expect(markup).toContain("方向已确认，正在等待任务卡");
    expect(markup).not.toContain("尚未取得任务卡");
  });

  it("distinguishes a long wait from a failure once it has waited long enough", () => {
    const longWait = render({ intent: confirmed, confirmedAt: 0, now: 600_000 });
    expect(longWait).toContain("尚未取得任务卡");
    expect(longWait).toContain("重新读取");
    expect(longWait).toContain("用此方向新建探索");
  });
});
