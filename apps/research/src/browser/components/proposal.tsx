/**
 * A pending modification proposal: what would change, and what would not.
 *
 * The product's editing rule is that an agent proposes and a person decides, so
 * this panel is built around the decision rather than the text. It says which
 * target is in scope, why the change is proposed, which claims are new or
 * replaced, and what happens to the evidence — and it shows the current and the
 * proposed content side by side without pretending to be a character diff.
 *
 * The document behind the dock does not move while a proposal is pending. It
 * moves when, and only when, the reader accepts it.
 */

import { Button, Menu } from "@mantine/core";
import { Check, ChevronDown, Clock, FileText, Loader, Quote, X } from "lucide-react";
import { useEffect, useState } from "react";

import { api, CLAIM_TYPE_LABELS, type ProposalDetailView, type TaskBundle } from "../api.js";
import { claimChanges } from "../claims.js";
import { useApp } from "../store.js";
import { DocumentBlocks } from "./document.js";

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-CN", { hour12: false });
}

export function ProposalPanel({
  bundle,
  proposalId,
  onSettled,
}: {
  readonly bundle: TaskBundle;
  readonly proposalId: string;
  /**
   * What to do once the decision is made.
   *
   * A proposal shown inside the conversation must not close the workspace it is
   * part of; opened on its own, it closes the panel it filled.
   */
  readonly onSettled?: () => void;
}) {
  const { act, say, openDock, prefillAssistant, document } = useApp();
  const [proposal, setProposal] = useState<ProposalDetailView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pane, setPane] = useState<"proposed" | "current">("proposed");
  const [working, setWorking] = useState(false);
  const settle = onSettled ?? ((): void => openDock(null));

  // The panel is shown inside the conversation now, so it has to notice when
  // the project moves on: the decision that settles a proposal happens in the
  // same column, and a panel that kept the detail it read before the decision
  // would go on offering a button for something already decided.
  const summary = bundle.proposals.find((candidate) => candidate.proposalId === proposalId);
  const summaryStatus = summary?.status ?? "";
  useEffect(() => {
    let cancelled = false;
    void api
      .proposal(proposalId)
      .then((result) => {
        if (!cancelled) setProposal(result.proposal);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "读取提案失败");
      });
    return () => {
      cancelled = true;
    };
  }, [proposalId, summaryStatus]);

  if (error !== null) return <p style={{ fontSize: 13, color: "var(--rp-danger)" }}>{error}</p>;
  if (proposal === null) {
    return (
      <p style={{ fontSize: 13, color: "var(--rp-ink-3)", display: "flex", gap: 8, alignItems: "center" }}>
        <Loader size={13} /> 正在读取提案…
      </p>
    );
  }

  const pending = proposal.status === "pending";
  const currentSection =
    document?.sections.find((section) => section.id === proposal.sections[0]?.id) ?? document?.sections[0];

  // What the proposal does to the claims: a claim whose id already exists in the
  // base is a replacement, one that does not is an addition. Both are shown,
  // because "changed claims" is the part a reader has to agree with.
  const changedClaims = claimChanges(
    proposal.claims,
    (document?.claims ?? []).map((claim) => claim.id),
  );

  const accept = async (): Promise<void> => {
    setWorking(true);
    const ok = await act(
      () =>
        api.acceptProposal(proposalId, {
          ...(summary === undefined ? {} : { expectedBaseContentHash: summary.baseContentHash }),
        }),
      "接受提案",
    );
    setWorking(false);
    if (ok) {
      say("success", "已接受：只有这个目标章节发生变化，其它章节保持原样。");
      settle();
    }
  };

  const discard = async (): Promise<void> => {
    setWorking(true);
    const ok = await act(() => api.discardProposal(proposalId), "放弃提案");
    setWorking(false);
    if (ok) {
      say("info", "已放弃提案；补查得到的材料与证据都保留。");
      settle();
    }
  };

  return (
    <div>
      <div className={`rp-proposal${pending ? "" : " rp-proposal--settled"}`}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span className={`rp-chip rp-chip--${pending ? "accent" : proposal.status === "accepted" ? "reviewed" : "quiet"}`}>
            {pending
              ? "待接受"
              : proposal.status === "accepted"
                ? "已接受"
                : proposal.status === "discarded"
                  ? "已放弃"
                  : proposal.status === "stale"
                    ? "基线已变化"
                    : "内容未通过校验"}
          </span>
          <span style={{ fontSize: 12.5, color: "var(--rp-ink-3)" }} data-testid="proposal-target">
            目标：{proposal.sections.map((section) => section.title).join("、") || proposal.targets.map((target) => target.targetId).join("、")}
          </span>
        </div>

        <p style={{ fontSize: 13.5, color: "var(--rp-ink-2)", lineHeight: 1.65, margin: "12px 0 0" }}>{proposal.reason}</p>

        <div className="rp-proposal__toggle" role="group" aria-label="查看当前或修改后的内容">
          <button
            type="button"
            aria-pressed={pane === "current"}
            onClick={() => {
              setPane("current");
            }}
          >
            现在的正文
          </button>
          <button
            type="button"
            aria-pressed={pane === "proposed"}
            onClick={() => {
              setPane("proposed");
            }}
          >
            修改后
          </button>
        </div>

        <div className="rp-proposal__pane">
          {pane === "proposed" ? (
            proposal.sections.map((section) => (
              <div key={section.id}>
                <div className="rp-block__label" style={{ marginBottom: 6 }}>
                  <FileText size={13} /> {section.title}（修改后）
                </div>
                <div className="rp-doc" data-theme="editorial" data-mode="read" style={{ fontSize: 14 }}>
                  <DocumentBlocks
                    blocks={section.blocks}
                    claims={proposal.claims.map((claim) => ({
                      id: claim.id,
                      text: claim.text,
                      kind: claim.kind,
                      claimType: claim.claimType ?? "fact",
                      synthesis: claim.synthesis === true,
                      evidenceIds: claim.evidenceIds,
                      subjects: [],
                      dimensions: [],
                      conditions: null,
                      adequacy: { state: "unassessed", reasons: [] },
                    }))}
                    document={document}
                    compact
                    onSelectClaim={() => {
                      /* selecting inside a preview would leave the dock's subject behind */
                    }}
                  />
                </div>
              </div>
            ))
          ) : currentSection === undefined ? (
            <p style={{ fontSize: 13, color: "var(--rp-ink-3)", margin: 0 }}>当前正文里找不到这个目标章节。</p>
          ) : (
            <div>
              <div className="rp-block__label" style={{ marginBottom: 6 }}>
                <FileText size={13} /> {currentSection.title}（现在）
              </div>
              <div className="rp-doc" data-theme="editorial" data-mode="read" style={{ fontSize: 14 }}>
                <DocumentBlocks
                  blocks={currentSection.blocks}
                  claims={document?.claims ?? []}
                  document={document}
                  compact
                  onSelectClaim={() => {
                    /* see above */
                  }}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="rp-block" style={{ marginTop: 20 }}>
        <div className="rp-block__label">受影响的论断（{changedClaims.length}）</div>
        {changedClaims.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--rp-ink-3)", margin: 0 }}>这次修改没有新增或替换论断。</p>
        ) : (
          <div>
            {changedClaims.map(({ claim, replaced }) => (
              <div key={claim.id} className="rp-claimrow">
                <span className={`rp-claimrow__kind${claim.synthesis === true ? " rp-claimrow__kind--synthesis" : ""}`}>
                  {CLAIM_TYPE_LABELS[claim.claimType ?? "fact"] ?? claim.claimType}
                </span>
                <span style={{ minWidth: 0 }}>
                  {claim.text}
                  <div style={{ fontSize: 11.5, color: "var(--rp-ink-3)", marginTop: 3 }}>
                    {replaced ? "替换原有论断" : "新增论断"} · 引用 {claim.evidenceIds.length} 条证据
                  </div>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rp-block">
        <div className="rp-block__label">证据变化</div>
        <dl className="rp-kv">
          <dt>提案引用</dt>
          <dd>{proposal.evidenceIds.length} 条证据</dd>
          {summary !== undefined && (
            <>
              <dt>修改期间新增</dt>
              <dd>
                {summary.researchAdded.sources} 个来源 · {summary.researchAdded.evidence} 条证据 ·{" "}
                {summary.researchAdded.assessments} 条评估
              </dd>
            </>
          )}
          <dt>基线</dt>
          <dd className="rp-mono">{proposal.baseContentHash.slice(7, 19)}…</dd>
        </dl>
        <p style={{ fontSize: 12, color: "var(--rp-ink-3)", margin: "10px 0 0", lineHeight: 1.55 }}>
          接受只替换上面那个目标；其它章节、来源与证据都不会因为这次接受而改变。
        </p>
      </div>

      {pending ? (
        <div className="rp-block" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Button
            size="xs"
            leftSection={<Check size={13} />}
            loading={working}
            onClick={() => {
              void accept();
            }}
            data-testid="accept-proposal"
          >
            接受这一节修改
          </Button>
          <Button
            size="xs"
            variant="default"
            leftSection={<X size={13} />}
            disabled={working}
            onClick={() => {
              void discard();
            }}
            data-testid="discard-proposal"
          >
            放弃提案
          </Button>
          <Menu shadow="md" position="bottom-start">
            <Menu.Target>
              <Button size="xs" variant="subtle" rightSection={<ChevronDown size={13} />}>
                更多
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item
                leftSection={<Quote size={13} />}
                onClick={() => {
                  prefillAssistant({
                    intent: "ask",
                    sectionId: proposal.sections[0]?.id ?? null,
                    text: `这次修改依据了哪些材料？为什么这样改「${proposal.sections[0]?.title ?? ""}」？`,
                  });
                }}
              >
                让助手解释这次修改
              </Menu.Item>
              <Menu.Item
                leftSection={<Clock size={13} />}
                onClick={() => {
                  openDock({
                    kind: "section",
                    sectionId: proposal.sections[0]?.id ?? document?.sections[0]?.id ?? "",
                  });
                }}
              >
                看目标章节的上下文
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </div>
      ) : (
        <p style={{ fontSize: 12.5, color: "var(--rp-ink-3)", marginTop: 14, lineHeight: 1.6 }}>
          已结束于 {proposal.decidedAt === null ? "—" : when(proposal.decidedAt)}。
          {proposal.status === "stale" && " 报告在你接受之前已经变化，因此这份提案不能再被应用。"}
          {proposal.status === "accepted" && ` 由它产生的报告：${proposal.acceptedReportId ?? "—"}。`}
        </p>
      )}
    </div>
  );
}
