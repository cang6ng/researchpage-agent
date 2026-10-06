/**
 * The Context Dock: one panel, one selected thing, everything the reader needs
 * to judge it.
 *
 * The product has exactly one dock, because "what is this and is it true?" is
 * one question. What changes is the subject: a matrix cell, a sentence in the
 * report, a source, a pending proposal, or the assistant working on one of
 * them. Keeping it single is what stops the workspace from becoming a set of
 * panels that all want to be open at once.
 *
 * It floats rather than sits: at wide windows it takes its place beside the
 * document and pushes it, and on a 1366 laptop it overlays instead of
 * squeezing the matrix into columns too narrow to read.
 */

import { ActionIcon, Button, Menu, Select, Textarea, Tooltip } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import {
  BookOpen,
  Check,
  ExternalLink,
  Eye,
  FileSearch,
  MessageSquare,
  MoreHorizontal,
  Quote,
  Search,
  SquarePen,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  ADEQUACY_LABELS,
  CLAIM_TYPE_LABELS,
  COMPARABILITY_LABELS,
  ROLE_LABELS,
  SCOPE_LABELS,
  STATUS_LABELS,
  STATUS_MARKS,
  api,
  type CellView,
  type DocumentClaim,
  type DocumentView,
  type EvidenceView,
  type SourceView,
  type TaskBundle,
} from "../api.js";
import { findCell, useApp, type DockTarget } from "../store.js";
import { navigate, projectHash } from "../router.js";
import { AssistantPanel } from "./assistant.js";
import { ProposalPanel } from "./proposal.js";

function tabLabel(target: DockTarget): { readonly primary: string; readonly kicker: string } {
  switch (target.kind) {
    case "cell":
      return { primary: "证据", kicker: "比较项" };
    case "evidence":
      return { primary: "证据", kicker: "证据片段" };
    case "source":
      return { primary: "来源", kicker: "来源" };
    case "claim":
      return { primary: "证据", kicker: "论断" };
    case "section":
      return { primary: "章节", kicker: "章节" };
    case "proposal":
      return { primary: "修改建议", kicker: "修改建议" };
    case "assistant":
      return { primary: "助手", kicker: "助手" };
  }
}

/* --------------------------------------------------------------- panels -- */

export function EvidenceItem({
  evidence,
  bundle,
  active,
  onSelect,
}: {
  readonly evidence: EvidenceView;
  readonly bundle: TaskBundle;
  readonly active: boolean;
  readonly onSelect: () => void;
}) {
  const source = bundle.sources.find((candidate) => candidate.sourceId === evidence.sourceId);
  const assessments = bundle.assessments.filter((entry) => entry.evidenceIds.includes(evidence.evidenceId));
  return (
    <button
      type="button"
      className={`rp-evitem${active ? " rp-evitem--active" : ""}`}
      onClick={onSelect}
      data-testid={`evidence-${evidence.evidenceId}`}
    >
      <span className="rp-evitem__top">
        <span className="rp-chip rp-chip--quiet">{SCOPE_LABELS[evidence.readScope] ?? evidence.readScope}</span>
        {source !== undefined && source.role !== null && (
          <span className="rp-chip rp-chip--quiet">{ROLE_LABELS[source.role] ?? source.role}</span>
        )}
        {assessments.some((entry) => entry.relationship === "supports" && entry.directness === "direct") && (
          <span className="rp-chip rp-chip--reviewed">直接支持</span>
        )}
        {assessments.some((entry) => entry.relationship === "contradicts") && (
          <span className="rp-chip rp-chip--conflict">有相反评估</span>
        )}
      </span>
      <span className="rp-evitem__excerpt">{evidence.excerpt}</span>
      <span className="rp-evitem__locator">
        {source === undefined ? "来源未知" : source.title}
        {" · "}
        {evidence.locator.headingPath.length > 0 ? `${evidence.locator.headingPath.slice(-2).join(" › ")} · ` : ""}
        第 {evidence.locator.paragraphIndex + 1} 段
      </span>
    </button>
  );
}

function UserAssessment({ bundle, cell }: { readonly bundle: TaskBundle; readonly cell: CellView }) {
  const { say, refresh } = useApp();
  const cellEvidence = bundle.evidence.filter((item) =>
    item.cells.some((ref) => ref.subjectId === cell.subjectId && ref.dimensionId === cell.dimensionId),
  );
  const [relationship, setRelationship] = useState("supports");
  const [directness, setDirectness] = useState("direct");
  const [rationale, setRationale] = useState("");
  const [evidenceId, setEvidenceId] = useState<string | null>(cellEvidence[0]?.evidenceId ?? null);
  const [saving, setSaving] = useState(false);

  const save = async (): Promise<void> => {
    if (evidenceId === null) return;
    setSaving(true);
    try {
      await api.assess(bundle.task.id, {
        cell: { sectionId: cell.sectionId, subjectId: cell.subjectId, dimensionId: cell.dimensionId },
        evidenceIds: [evidenceId],
        relationship,
        directness,
        rationale,
      });
      setRationale("");
      await refresh();
      say("success", "已保存你的判断；这一格的状态会按同一条判据重新推导。");
    } catch (error) {
      say("error", error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rp-block">
      <div className="rp-block__label">我的判断</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <Select
          size="xs"
          label="关系"
          value={relationship}
          onChange={(value) => {
            setRelationship(value ?? "supports");
          }}
          data={[
            { value: "supports", label: "支持这一项" },
            { value: "contradicts", label: "与这一项相反" },
            { value: "contextual", label: "只提供背景" },
          ]}
        />
        <Select
          size="xs"
          label="直接性"
          value={directness}
          onChange={(value) => {
            setDirectness(value ?? "direct");
          }}
          data={[
            { value: "direct", label: "正文级、直接相关" },
            { value: "indirect", label: "间接" },
            { value: "contextual", label: "仅背景" },
          ]}
        />
        <Select
          size="xs"
          label="针对哪条证据"
          value={evidenceId}
          onChange={setEvidenceId}
          data={cellEvidence.map((item) => ({ value: item.evidenceId, label: item.excerpt.slice(0, 42) }))}
          placeholder="选择证据"
        />
        <Textarea
          size="xs"
          autosize
          minRows={2}
          label="理由"
          value={rationale}
          onChange={(event) => {
            setRationale(event.currentTarget.value);
          }}
        />
        <Button
          size="xs"
          loading={saving}
          disabled={rationale.trim().length === 0 || evidenceId === null}
          onClick={() => {
            void save();
          }}
        >
          保存判断
        </Button>
        <p style={{ fontSize: 11.5, color: "var(--rp-ink-3)", margin: 0, lineHeight: 1.5 }}>
          你的判断与助手的评估用同一套判据：只有「支持 + 正文级 + 直接」才会把这一格升到「已核对」。
        </p>
      </div>
    </div>
  );
}

function CellPanel({ bundle, cell }: { readonly bundle: TaskBundle; readonly cell: CellView }) {
  const { setSelection, openDock, prefillAssistant } = useApp();
  const [showAssess, setShowAssess] = useState(false);
  const cellEvidence = bundle.evidence.filter((item) =>
    item.cells.some((ref) => ref.subjectId === cell.subjectId && ref.dimensionId === cell.dimensionId),
  );
  const assessments = bundle.assessments.filter(
    (entry) => entry.target.subjectId === cell.subjectId && entry.target.dimensionId === cell.dimensionId,
  );

  return (
    <div>
      <div className="rp-block">
        <div className="rp-block__label">状态</div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span className={`rp-chip rp-chip--${cell.status}`}>
            <span aria-hidden="true">{STATUS_MARKS[cell.status]}</span>
            {STATUS_LABELS[cell.status]}
          </span>
          <span style={{ fontSize: 13, color: "var(--rp-ink-2)" }}>{cell.reason}</span>
        </div>
        {cell.gap.length > 0 && (
          <div className="rp-note rp-note--warn" style={{ marginTop: 12 }}>
            <Search size={14} style={{ flex: "none", marginTop: 2 }} />
            <span>缺口：{cell.gap}</span>
          </div>
        )}
        {cell.note.length > 0 && <p className="rp-field__hint" style={{ marginTop: 10 }}>助手说明：{cell.note}</p>}
      </div>

      <div className="rp-block">
        <div className="rp-block__label">证据（{cellEvidence.length}）</div>
        {cellEvidence.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--rp-ink-3)", margin: 0, lineHeight: 1.6 }}>
            这一项还没有绑定证据。可以让助手针对它做一轮定向补查。
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {cellEvidence.map((item) => (
              <EvidenceItem
                key={item.evidenceId}
                evidence={item}
                bundle={bundle}
                active={false}
                onSelect={() => {
                  openDock({ kind: "evidence", evidenceId: item.evidenceId });
                }}
              />
            ))}
          </div>
        )}
      </div>

      <div className="rp-block">
        <div className="rp-block__label">支持评估（{assessments.length}）</div>
        {assessments.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--rp-ink-3)", margin: 0, lineHeight: 1.6 }}>
            还没有保存的评估。「已核对」要求存在直接、正文级的支持评估。
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {assessments.map((entry) => (
              <div key={entry.assessmentId} className="rp-quote" style={{ fontSize: 12.5 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6, flexWrap: "wrap" }}>
                  <span
                    className={`rp-chip rp-chip--${
                      entry.relationship === "supports"
                        ? "reviewed"
                        : entry.relationship === "contradicts"
                          ? "conflict"
                          : "quiet"
                    }`}
                  >
                    {entry.relationship === "supports" ? "支持" : entry.relationship === "contradicts" ? "相反" : "背景"}
                  </span>
                  <span className="rp-chip rp-chip--quiet">
                    {entry.directness === "direct"
                      ? "正文级 · 直接"
                      : entry.directness === "indirect"
                        ? "间接"
                        : entry.directness === "contextual"
                          ? "背景"
                          : "未评估"}
                  </span>
                  <span style={{ fontSize: 11.5, color: "var(--rp-ink-3)" }}>
                    {entry.assessor === "user" ? "你的判断" : "助手"} · {entry.evidenceIds.length} 条证据
                  </span>
                </div>
                {entry.rationale}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rp-block" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button
          size="xs"
          leftSection={<Search size={13} />}
          onClick={() => {
            prefillAssistant({
              intent: "research",
              sectionId: null,
              text: `围绕「${cell.subjectName} × ${cell.dimensionName}」补查：${cell.gap.length > 0 ? cell.gap : cell.reason}`,
            });
          }}
        >
          补查这一项
        </Button>
        <Button
          size="xs"
          variant="default"
          leftSection={<Check size={13} />}
          onClick={() => {
            setShowAssess((open) => !open);
          }}
        >
          记下我的判断
        </Button>
        <Menu shadow="md" position="bottom-start">
          <Menu.Target>
            <Button size="xs" variant="subtle" leftSection={<MoreHorizontal size={13} />}>
              更多
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item
              leftSection={<Eye size={13} />}
              onClick={() => {
                setSelection({ kind: "cell", subjectId: cell.subjectId, dimensionId: cell.dimensionId });
                navigate(projectHash(bundle.task.id, "research"));
              }}
            >
              在矩阵中定位
            </Menu.Item>
            <Menu.Item
              leftSection={<BookOpen size={13} />}
              disabled={cellEvidence.length === 0}
              onClick={() => {
                const first = cellEvidence[0];
                if (first !== undefined) openDock({ kind: "source", sourceId: first.sourceId });
              }}
            >
              打开证据来源
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </div>

      {showAssess && <UserAssessment bundle={bundle} cell={cell} />}
    </div>
  );
}

function EvidencePanel({
  bundle,
  evidenceId,
  document,
  onOpenSource,
}: {
  readonly bundle: TaskBundle;
  readonly evidenceId: string;
  readonly document: DocumentView | null;
  readonly onOpenSource: (sourceId: string) => void;
}) {
  const evidence = bundle.evidence.find((item) => item.evidenceId === evidenceId);
  if (evidence === undefined) {
    return <p style={{ fontSize: 13, color: "var(--rp-ink-3)" }}>这条证据不在当前项目里。</p>;
  }
  const source = bundle.sources.find((candidate) => candidate.sourceId === evidence.sourceId);
  const cited = document?.citations.evidenceIndex.filter((entry) => entry.evidenceId === evidence.evidenceId) ?? [];

  return (
    <div>
      <div className="rp-block">
        <div className="rp-block__label">
          <Quote size={13} /> 片段
        </div>
        <div className="rp-quote">{evidence.excerpt}</div>
      </div>

      <div className="rp-block">
        <div className="rp-block__label">定位与读取范围</div>
        <dl className="rp-kv">
          <dt>来源</dt>
          <dd>{source === undefined ? "未知" : source.title}</dd>
          <dt>位置</dt>
          <dd>
            {evidence.locator.headingPath.join(" › ") || "（无标题层级）"} · 第 {evidence.locator.paragraphIndex + 1} 段
          </dd>
          <dt>字符范围</dt>
          <dd className="rp-mono">
            {evidence.locator.charStart}–{evidence.locator.charEnd}
          </dd>
          <dt>读取范围</dt>
          <dd>{SCOPE_LABELS[evidence.readScope] ?? evidence.readScope}</dd>
          <dt>为什么选它</dt>
          <dd>{evidence.pickedBecause.length > 0 ? evidence.pickedBecause : "—"}</dd>
          {cited.length > 0 && (
            <>
              <dt>报告引用</dt>
              <dd>第 {cited.map((entry) => entry.number).join("、")} 号引用</dd>
            </>
          )}
        </dl>
      </div>

      <div className="rp-block" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {source !== undefined && (
          <Button
            size="xs"
            variant="default"
            leftSection={<BookOpen size={13} />}
            onClick={() => {
              onOpenSource(source.sourceId);
            }}
          >
            看来源详情
          </Button>
        )}
        {source !== undefined && (
          <Button
            size="xs"
            variant="subtle"
            component="a"
            href={source.readUrl ?? source.url}
            target="_blank"
            rel="noreferrer"
            rightSection={<ExternalLink size={12} />}
          >
            打开原文
          </Button>
        )}
      </div>
    </div>
  );
}

function ClaimPanel({
  bundle,
  claimId,
  document,
  onOpenEvidence,
}: {
  readonly bundle: TaskBundle;
  readonly claimId: string;
  readonly document: DocumentView | null;
  readonly onOpenEvidence: (evidenceId: string) => void;
}) {
  const claim = document?.claims.find((candidate) => candidate.id === claimId);
  if (claim === undefined) {
    return <p style={{ fontSize: 13, color: "var(--rp-ink-3)" }}>这条论断不在当前报告里。</p>;
  }
  const citedIds = claim.evidenceIds;
  const cited = citedIds
    .map((evidenceId) => bundle.evidence.find((item) => item.evidenceId === evidenceId))
    .filter((item): item is EvidenceView => item !== undefined);
  const conditions = claim.conditions ?? {};
  const relevant = bundle.assessments.filter((entry) => entry.evidenceIds.some((id) => citedIds.includes(id)));

  // Two different questions, answered separately: does the citation resolve to
  // the passage it claims, and is that passage enough to carry the statement.
  const referencesValid = cited.length === citedIds.length && cited.length > 0;

  return (
    <div>
      <div className="rp-block">
        <div className="rp-block__label">
          <FileSearch size={13} /> 论断
          <span className={`rp-chip rp-chip--${claim.synthesis ? "accent" : "quiet"}`}>
            {CLAIM_TYPE_LABELS[claim.claimType] ?? claim.claimType}
          </span>
        </div>
        <div className="rp-quote" style={{ fontSize: 14 }}>
          {claim.text}
        </div>
      </div>

      <div className="rp-block">
        <div className="rp-block__label">引用有效性</div>
        <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
          <span className={referencesValid ? "rp-chip rp-chip--reviewed" : "rp-chip rp-chip--danger"}>
            {referencesValid ? "引用有效" : "引用不完整"}
          </span>
          <span style={{ fontSize: 12.5, color: "var(--rp-ink-2)" }}>
            {cited.length} 条证据在报告保存时逐条校验过，仍与读取文本一致
          </span>
        </div>
      </div>

      <div className="rp-block">
        <div className="rp-block__label">证据是否足以支持</div>
        <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap", marginBottom: 8 }}>
          <span
            className={`rp-chip rp-chip--${
              claim.adequacy.state === "adequate"
                ? "reviewed"
                : claim.adequacy.state === "conflicted"
                  ? "conflict"
                  : claim.adequacy.state === "incomparable"
                    ? "accent"
                    : "limited"
            }`}
          >
            {ADEQUACY_LABELS[claim.adequacy.state] ?? claim.adequacy.state}
          </span>
        </div>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: "var(--rp-ink-2)", lineHeight: 1.65 }}>
          {claim.adequacy.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      </div>

      <ConditionList claim={claim} />

      {claim.subjects.length + claim.dimensions.length > 0 && (
        <div className="rp-block">
          <div className="rp-block__label">涉及对象</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {claim.subjects.map((subject) => (
              <span key={subject.id} className="rp-chip rp-chip--quiet">
                {subject.name}
              </span>
            ))}
            {claim.dimensions.map((dimension) => (
              <span key={dimension.id} className="rp-chip rp-chip--quiet">
                {dimension.name}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="rp-block">
        <div className="rp-block__label">支撑它的证据（{cited.length}）</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {cited.map((item) => (
            <EvidenceItem
              key={item.evidenceId}
              evidence={item}
              bundle={bundle}
              active={false}
              onSelect={() => {
                onOpenEvidence(item.evidenceId);
              }}
            />
          ))}
        </div>
      </div>

      {relevant.length > 0 && (
        <div className="rp-block">
          <div className="rp-block__label">支持评估</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {relevant.map((entry) => (
              <div key={entry.assessmentId} className="rp-quote" style={{ fontSize: 12.5 }}>
                <div style={{ marginBottom: 5, color: "var(--rp-ink-3)", fontSize: 11.5 }}>
                  {entry.relationship === "supports" ? "支持" : entry.relationship === "contradicts" ? "相反" : "背景"} ·{" "}
                  {entry.directness === "direct" ? "正文级直接" : entry.directness} ·{" "}
                  {entry.assessor === "user" ? "你的判断" : "助手"}
                </div>
                {entry.rationale}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ConditionList({ claim }: { readonly claim: DocumentClaim }) {
  const conditions = claim.conditions ?? {};
  const entries: [string, string][] = [];
  if (conditions.scope !== undefined) entries.push(["适用范围", conditions.scope]);
  if (conditions.basis !== undefined) entries.push(["依据类型", conditions.basis]);
  if (conditions.metric !== undefined) entries.push(["指标", conditions.metric]);
  if (conditions.baseline !== undefined) entries.push(["基线", conditions.baseline]);
  if (conditions.dataset !== undefined) entries.push(["数据 / 场景", conditions.dataset]);
  if (conditions.setting !== undefined) entries.push(["设置", conditions.setting]);
  if (conditions.costStage !== undefined) entries.push(["成本阶段", conditions.costStage]);
  if (conditions.comparability !== undefined)
    entries.push(["可比性", COMPARABILITY_LABELS[conditions.comparability] ?? conditions.comparability]);
  if (entries.length === 0) return null;
  return (
    <div className="rp-block">
      <div className="rp-block__label">条件</div>
      <dl className="rp-kv">
        {entries.map(([k, v]) => (
          <div key={k} style={{ display: "contents" }}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function SourcePanel({ bundle, source }: { readonly bundle: TaskBundle; readonly source: SourceView }) {
  const evidence = bundle.evidence.filter((item) => item.sourceId === source.sourceId);
  const citedInReport = new Set(
    bundle.reports
      .filter((report) => report.isCurrent)
      .flatMap((report) => report.claims.flatMap((claim) => claim.evidenceIds)),
  );
  return (
    <div>
      <div className="rp-block">
        <div className="rp-block__label">来源</div>
        <div style={{ fontSize: 14.5, fontWeight: 550, lineHeight: 1.45, marginBottom: 6 }}>{source.title}</div>
        <div style={{ fontSize: 12.5, color: "var(--rp-ink-3)", lineHeight: 1.6 }}>
          {source.authors.slice(0, 6).join("、") || "作者未记录"}
          {source.venue.length > 0 ? ` · ${source.venue}` : ""}
          {source.publishedAt !== null ? ` · ${source.publishedAt.slice(0, 10)}` : ""}
          {source.doi !== null ? ` · DOI ${source.doi}` : ""}
        </div>
      </div>

      <div className="rp-block">
        <div className="rp-block__label">读取情况</div>
        <dl className="rp-kv">
          <dt>状态</dt>
          <dd>{source.readStatus === "ok" ? "已读取" : source.readStatus === "failed" ? "读取失败" : "未读取（仅候选）"}</dd>
          <dt>读取范围</dt>
          <dd>{source.readScope === null ? "—" : SCOPE_LABELS[source.readScope] ?? source.readScope}</dd>
          <dt>来源角色</dt>
          <dd>{source.role === null ? "未声明" : ROLE_LABELS[source.role] ?? source.role}</dd>
          <dt>证据</dt>
          <dd>
            {evidence.length} 条
            {evidence.filter((item) => citedInReport.has(item.evidenceId)).length > 0 ? "（报告已引用）" : ""}
          </dd>
          <dt>发现方式</dt>
          <dd>
            {source.discovery.provider} · 查询「{source.discovery.query}」
          </dd>
        </dl>
        {source.retrievalNote.length > 0 && (
          <p style={{ fontSize: 12.5, color: "var(--rp-ink-2)", marginTop: 10, lineHeight: 1.6 }}>{source.retrievalNote}</p>
        )}
        {source.failure !== null && (
          <div className="rp-note rp-note--danger" style={{ marginTop: 10 }}>{source.failure}</div>
        )}
      </div>

      {source.abstract.length > 0 && (
        <div className="rp-block">
          <div className="rp-block__label">摘要</div>
          <p style={{ fontSize: 13, lineHeight: 1.65, color: "var(--rp-ink-2)", margin: 0 }}>{source.abstract}</p>
        </div>
      )}

      <div className="rp-block">
        <div className="rp-block__label">从它读到的片段（{evidence.length}）</div>
        {evidence.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--rp-ink-3)", margin: 0 }}>这个来源还没有产生可引用证据。</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {evidence.map((item) => (
              <EvidenceItem
                key={item.evidenceId}
                evidence={item}
                bundle={bundle}
                active={false}
                onSelect={() => {
                  /* the reader is already looking at the source this came from */
                }}
              />
            ))}
          </div>
        )}
      </div>

      <div className="rp-block" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button
          size="xs"
          variant="default"
          component="a"
          href={source.url}
          target="_blank"
          rel="noreferrer"
          rightSection={<ExternalLink size={12} />}
        >
          原文
        </Button>
        {source.readUrl !== null && source.readUrl !== source.url && (
          <Button
            size="xs"
            variant="subtle"
            component="a"
            href={source.readUrl}
            target="_blank"
            rel="noreferrer"
            rightSection={<ExternalLink size={12} />}
          >
            实际读取地址
          </Button>
        )}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- dock -- */

/**
 * How wide the one panel is, and why.
 *
 * There is still exactly one contextual workspace on the right, but its width is
 * a consequence of what is in it. A source or an evidence excerpt is something
 * to glance at beside the matrix, and stays a dock; an assistant answer, a
 * proposal's two versions of a section, and a claim's evidence chain are things
 * a reader reads, and take a column wide enough to read. Nothing here decides
 * *whether* the panel is open — only how much room it asks for.
 */
export type DockTab = "assistant" | "primary" | "proposal";

const TAB_WIDTH: Readonly<Record<DockTab, "narrow" | "wide">> = Object.freeze({
  primary: "narrow",
  assistant: "wide",
  proposal: "wide",
});

/** The two widths the panel is allowed to be, in the spec's own numbers. */
const WIDTHS: Readonly<Record<"narrow" | "wide", string>> = Object.freeze({
  narrow: "376px",
  wide: "clamp(420px, 32vw, 520px)",
});

export function ContextDock({ overlay }: { readonly overlay: boolean }) {
  const { bundle, document, dock, openDock, setSelection } = useApp();
  const [tab, setTab] = useState<DockTab>("primary");

  const pendingProposal = bundle?.proposals.filter((proposal) => proposal.status === "pending").slice(-1)[0] ?? null;
  const showProposalTab = pendingProposal !== null || dock?.kind === "proposal";
  const activeTab: DockTab = tab === "proposal" && !showProposalTab ? "primary" : tab;

  // The subject decides the tab it belongs in: selecting a sentence opens its
  // evidence, asking the assistant opens the assistant, and a proposal arrives
  // where proposals live rather than as a surprise in another panel.
  useEffect(() => {
    setTab(dock?.kind === "assistant" ? "assistant" : dock?.kind === "proposal" ? "proposal" : "primary");
  }, [dock]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") openDock(null);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [openDock]);

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const cell = dock?.kind === "cell" && bundle !== null ? findCell(bundle, dock) : undefined;

  // The panel's width is published as one variable, because two other things
  // read it: the layout that makes room for the panel, and the sticky chrome
  // that has to keep its controls clear of a floating one.
  useEffect(() => {
    const root = window.document.documentElement;
    root.style.setProperty("--rp-dock-w", WIDTHS[TAB_WIDTH[activeTab]]);
    if (overlay) root.style.setProperty("--rp-dock-offset", "var(--rp-dock-w)");
    return () => {
      root.style.removeProperty("--rp-dock-w");
      root.style.removeProperty("--rp-dock-offset");
    };
  }, [activeTab, overlay]);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
  }, [dock]);

  const header = useMemo(() => {
    if (bundle === null || dock === null) return { kicker: "", title: "", sub: "" };
    switch (dock.kind) {
      case "cell": {
        const target = findCell(bundle, dock);
        return {
          kicker: "比较项",
          title: target === undefined ? "未知比较项" : `${target.subjectName} × ${target.dimensionName}`,
          sub: target === undefined ? "" : target.reason,
        };
      }
      case "evidence": {
        const evidence = bundle.evidence.find((item) => item.evidenceId === dock.evidenceId);
        const source = bundle.sources.find((candidate) => candidate.sourceId === evidence?.sourceId);
        return {
          kicker: "证据片段",
          title: source === undefined ? "证据" : source.title,
          sub:
            evidence === undefined
              ? ""
              : `${SCOPE_LABELS[evidence.readScope] ?? evidence.readScope} · 第 ${evidence.locator.paragraphIndex + 1} 段`,
        };
      }
      case "source": {
        const source = bundle.sources.find((candidate) => candidate.sourceId === dock.sourceId);
        return {
          kicker: "来源",
          title: source?.title ?? "未知来源",
          sub: source?.authors.slice(0, 3).join("、") ?? "",
        };
      }
      case "claim": {
        const claim = document?.claims.find((candidate) => candidate.id === dock.claimId);
        return {
          kicker: "论断",
          title: claim === undefined ? "论断" : CLAIM_TYPE_LABELS[claim.claimType] ?? claim.claimType,
          sub: claim === undefined ? "" : claim.text.slice(0, 60),
        };
      }
      case "section": {
        const section =
          document?.sections.find((candidate) => candidate.id === dock.sectionId) ??
          bundle.structure.find((candidate) => candidate.id === dock.sectionId);
        return { kicker: "章节", title: section?.title ?? "章节", sub: "这一节的证据与操作" };
      }
      case "proposal": {
        const proposal = bundle.proposals.find((candidate) => candidate.proposalId === dock.proposalId);
        return {
          kicker: "修改建议",
          title: proposal?.sections.map((section) => section.title).join("、") ?? "修改建议",
          sub: proposal === undefined ? "" : proposal.reason,
        };
      }
      case "assistant":
        return { kicker: "助手", title: "与文档并排工作", sub: "" };
    }
  }, [bundle, document, dock]);

  if (bundle === null || dock === null) return null;

  const primaryLabel = tabLabel(dock).primary;
  // A panel that is the assistant has no "primary subject" to switch back to:
  // the tab that would say "助手" beside the assistant tab says nothing.
  const hasPrimary = dock.kind !== "assistant";

  return (
    <aside
      className={`rp-dock rp-dock--${TAB_WIDTH[activeTab]}${overlay ? " rp-dock--overlay" : ""}`}
      aria-label="上下文面板"
      data-testid="context-dock"
      data-width={TAB_WIDTH[activeTab]}
    >
      <div className="rp-dock__head">
        <div style={{ minWidth: 0 }}>
          <div className="rp-dock__kicker">{header.kicker}</div>
          <div className="rp-dock__title">{header.title}</div>
          {header.sub.length > 0 && <div className="rp-dock__sub">{header.sub}</div>}
        </div>
        <Tooltip label="关闭（Esc）" withArrow={false}>
          <ActionIcon
            className="rp-dock__close"
            variant="subtle"
            aria-label="关闭面板"
            onClick={() => {
              openDock(null);
            }}
          >
            <X size={16} />
          </ActionIcon>
        </Tooltip>
      </div>

      <div className="rp-dock__tabs" data-testid="dock-tabs">
        {hasPrimary && (
          <button
            type="button"
            className="rp-nav__item"
            aria-current={activeTab === "primary"}
            onClick={() => {
              setTab("primary");
            }}
          >
            {dock.kind === "source" ? (
              <BookOpen size={14} />
            ) : (
              <FileSearch size={14} />
            )}
            {primaryLabel}
          </button>
        )}
        <button
          type="button"
          className="rp-nav__item"
          aria-current={activeTab === "assistant"}
          onClick={() => {
            setTab("assistant");
          }}
        >
          <MessageSquare size={14} />
          助手
        </button>
        {showProposalTab && (
          <button
            type="button"
            className="rp-nav__item"
            aria-current={activeTab === "proposal"}
            onClick={() => {
              if (pendingProposal !== null) {
                openDock({ kind: "proposal", proposalId: pendingProposal.proposalId });
                return;
              }
              setTab("proposal");
            }}
            data-testid="dock-tab-proposal"
          >
            <SquarePen size={14} />
            修改建议
            {pendingProposal !== null && <span className="rp-nav__count">待接受</span>}
          </button>
        )}
      </div>

      {activeTab === "assistant" ? (
        <AssistantPanel bundle={bundle} />
      ) : activeTab === "proposal" ? (
        <div className="rp-dock__body" ref={bodyRef}>
          {pendingProposal !== null && dock.kind !== "proposal" ? (
            <ProposalPanel bundle={bundle} proposalId={pendingProposal.proposalId} />
          ) : dock.kind === "proposal" ? (
            <ProposalPanel bundle={bundle} proposalId={dock.proposalId} />
          ) : null}
        </div>
      ) : dock.kind === "cell" && cell !== undefined ? (
        <>
          <div className="rp-dock__body" ref={bodyRef}>
            <CellPanel bundle={bundle} cell={cell} />
          </div>
          <div className="rp-dock__foot">
            <Button
              fullWidth
              size="xs"
              variant="light"
              leftSection={<Eye size={13} />}
              onClick={() => {
                setSelection({ kind: "cell", subjectId: cell.subjectId, dimensionId: cell.dimensionId });
              }}
            >
              在矩阵中保持选中
            </Button>
          </div>
        </>
      ) : dock.kind === "evidence" ? (
        <div className="rp-dock__body" ref={bodyRef}>
          <EvidencePanel
            bundle={bundle}
            evidenceId={dock.evidenceId}
            document={document}
            onOpenSource={(sourceId) => {
              openDock({ kind: "source", sourceId });
            }}
          />
        </div>
      ) : dock.kind === "claim" ? (
        <div className="rp-dock__body" ref={bodyRef}>
          <ClaimPanel
            bundle={bundle}
            claimId={dock.claimId}
            document={document}
            onOpenEvidence={(evidenceId) => {
              openDock({ kind: "evidence", evidenceId });
            }}
          />
        </div>
      ) : dock.kind === "source" ? (
        <div className="rp-dock__body" ref={bodyRef}>
          {bundle.sources.find((candidate) => candidate.sourceId === dock.sourceId) === undefined ? (
            <p style={{ fontSize: 13, color: "var(--rp-ink-3)" }}>这个来源不在当前项目里。</p>
          ) : (
            <SourcePanel
              bundle={bundle}
              source={bundle.sources.find((candidate) => candidate.sourceId === dock.sourceId) as SourceView}
            />
          )}
        </div>
      ) : dock.kind === "proposal" ? (
        <div className="rp-dock__body" ref={bodyRef}>
          <ProposalPanel bundle={bundle} proposalId={dock.proposalId} />
        </div>
      ) : (
        <div className="rp-dock__body">
          <p style={{ fontSize: 13, color: "var(--rp-ink-3)", margin: 0, lineHeight: 1.7 }}>
            这一节还没有可选中的对象。打开报告，点击一句论断或一个比较表，这里会显示它的证据。
          </p>
        </div>
      )}
    </aside>
  );
}

/**
 * Where the dock goes in a view's own layout.
 *
 * A window with room takes the panel beside the content and lets it push; a
 * narrower one overlays, because a 1366 laptop must not have its matrix
 * squeezed into columns too narrow to read just to make room for a panel the
 * reader opened on purpose and can close again. The threshold is measured
 * rather than named: the panel needs its own width plus a document's worth of
 * space, so it pushes whenever that much room actually exists.
 */
export function DockSlot() {
  const { dock } = useApp();
  // The panel pushes when there is room for it *and* a document: a wide
  // assistant workspace plus a readable page. 1366 is the narrowest window this
  // product supports, and 376 + 900 fits inside it, so the threshold is that
  // width rather than a name for a device.
  const roomy = useMediaQuery("(min-width: 1350px)");
  if (dock === null) return null;
  return <ContextDock overlay={roomy !== true} />;
}

export { STATUS_LABELS };
