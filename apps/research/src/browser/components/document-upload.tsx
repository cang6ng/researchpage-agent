/**
 * Uploading material, and watching a PDF or DOCX become one.
 *
 * Two very different things are called 上传 here and the panel keeps them
 * apart. A Markdown file is text the reader already has; it goes into the
 * library and that is the end of it. A PDF or DOCX is *converted*, which means
 * the file leaves this machine, goes to a third-party service, costs quota and
 * takes tens of seconds — so it needs the reader's own consent, unchecked by
 * default, given for the file in front of them.
 *
 * The conversion is a job rather than a request, and this panel shows the job
 * as the server describes it: queued, converting, importing, succeeded or
 * failed, with the attempt count and, on failure, the server's own sentence and
 * guidance. A retry is offered only when the server says the job is retryable,
 * it warns that it costs quota again, and it waits for the reader to say yes —
 * nothing here retries by itself.
 */

import { Alert, Badge, Button, Checkbox, FileInput, Loader, Progress, Tooltip } from "@mantine/core";
import { AlertTriangle, FileUp, HardDriveUpload, Info, RefreshCw, Trash2 } from "lucide-react";
import { useRef, useState } from "react";

import {
  CONVERSION_STATUS_LABELS,
  type ConversionJobView,
  type MineruReadinessView,
} from "../api.js";
import {
  CONVERSION_CONSENT_TEXT,
  MAX_CONVERSION_BYTES,
  MAX_MARKDOWN_BYTES,
  failureSummaryOf,
  isActiveJob,
  isTerminalJob,
  readUtf8Text,
  retryWarningOf,
  uploadKindOf,
  type ConsentedFile,
  type PendingFile,
} from "../upload-logic.js";

/** One file the reader has staged, before anything has been sent. */
interface Staged {
  readonly id: string;
  readonly filename: string;
  readonly bytes: ArrayBuffer;
  readonly kind: "markdown" | "pdf" | "docx";
  readonly problem: string | null;
  consent: boolean;
}

function bytes(value: number): string {
  if (value < 1024) return `${String(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

/** Whether the conversion service is reachable, and what it can take. */
function ConverterStatus({
  mineru,
  checked,
  onCheck,
}: {
  readonly mineru: MineruReadinessView | null;
  readonly checked: boolean;
  readonly onCheck: () => void;
}): React.ReactElement {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <Button
        size="compact-xs"
        variant="default"
        leftSection={<RefreshCw size={11} />}
        onClick={onCheck}
        data-testid="converter-check"
      >
        检查转换服务
      </Button>
      {checked && mineru === null && <span className="rp-file__fact">转换服务状态未知。</span>}
      {mineru !== null && (
        <span className="rp-file__fact" data-testid="converter-status">
          {mineru.ok ? "转换服务可用" : `转换服务不可用：${mineru.problem ?? "原因未知"}`}
          {mineru.limits.maxBytes > 0 && ` · 单文件上限 ${bytes(mineru.limits.maxBytes)} · 最多 ${String(mineru.limits.maxPages)} 页`}
        </span>
      )}
    </div>
  );
}

function JobRow({
  job,
  gone,
  retrying,
  onRetry,
}: {
  readonly job: ConversionJobView;
  readonly gone: boolean;
  readonly retrying: boolean;
  readonly onRetry: DocumentUploadProps["onRetry"];
}): React.ReactElement {
  const [confirming, setConfirming] = useState(false);
  const failure = job.failure === null ? null : failureSummaryOf(job);
  const done = job.status === "succeeded";
  return (
    <div className="rp-file" data-testid={`conversion-job-${job.jobId}`}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span className="rp-file__title">{job.filename}</span>
          <Badge size="xs" variant="light" color={job.status === "failed" ? "red" : done ? "teal" : "gray"} data-testid={`conversion-status-${job.jobId}`}>
            {gone ? "任务已失效" : (CONVERSION_STATUS_LABELS[job.status] ?? job.status)}
          </Badge>
          <span className="rp-file__fact">
            第 {String(job.attempts)}/{String(job.maxAttempts)} 次尝试 · {bytes(job.sizeBytes)} · {job.format.toUpperCase()}
          </span>
        </div>
        {isActiveJob(job.status) && !gone && <Progress value={100} animated size="xs" color="gray" style={{ marginTop: 8 }} />}
        {failure !== null && (
          <Alert
            variant="light"
            color="red"
            icon={<AlertTriangle size={14} />}
            title={failure.title}
            style={{ marginTop: 10 }}
            data-testid={`conversion-failure-${job.jobId}`}
          >
            <p style={{ margin: 0, fontSize: 12.5 }}>{failure.body}</p>
            <p style={{ margin: "6px 0 0", fontSize: 11.5, color: "var(--rp-ink-3)" }}>错误代码：{failure.code}</p>
            {job.retryable ? (
              <div style={{ marginTop: 10 }}>
                {!confirming ? (
                  <Button size="xs" variant="light" onClick={() => { setConfirming(true); }} data-testid={`conversion-retry-${job.jobId}`}>
                    重试这次转换
                  </Button>
                ) : (
                  <div>
                    <p style={{ margin: "0 0 8px", fontSize: 12.5, color: "var(--rp-ink)" }}>{retryWarningOf(job)}</p>
                    <div style={{ display: "flex", gap: 8 }}>
                      <Button
                        size="xs"
                        loading={retrying}
                        onClick={() => {
                          setConfirming(false);
                          onRetry(job.jobId, true);
                        }}
                        data-testid={`conversion-retry-confirm-${job.jobId}`}
                      >
                        确认重试并再次消耗额度
                      </Button>
                      <Button size="xs" variant="subtle" onClick={() => { setConfirming(false); }}>
                        取消
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <p style={{ margin: "8px 0 0", fontSize: 12 }}>这次失败不能重试：可以重新选择文件，或换一份重新上传。</p>
            )}
          </Alert>
        )}
        {done && job.document !== null && (
          <p className="rp-chat__note" data-testid={`conversion-done-${job.jobId}`}>
            转换完成，已经入库。{job.document.duplicate ? "文档库里已有内容相同的文件，这次只复用了已有记录（转换已经发生并消耗了额度）。" : ""}
          </p>
        )}
        {gone && (
          <p className="rp-chat__note">
            服务端已经不记得这次转换了（转换任务只保存在内存里，服务重启后会消失）。已经转换成功的文档仍然在文档库里。
          </p>
        )}
      </div>
    </div>
  );
}

export interface DocumentUploadProps {
  readonly jobs: readonly ConversionJobView[];
  readonly gone: readonly string[];
  readonly mineru: MineruReadinessView | null;
  readonly mineruChecked: boolean;
  readonly onCheckMineru: () => void;
  readonly uploading: boolean;
  readonly converting: boolean;
  readonly retrying: boolean;
  /** Whether Markdown may be uploaded right now (an exploration or project is open). */
  readonly canUpload: boolean;
  readonly onUploadMarkdown: (file: PendingFile) => void;
  readonly onSubmitConversion: (file: ConsentedFile) => void;
  readonly onRetry: (jobId: string, accepted: boolean) => void;
  /** The hash of files already sent in this session, for the cost warning. */
  readonly knownHashes?: readonly { readonly filename: string; readonly sha256: string | null }[];
}

export function DocumentUpload(props: DocumentUploadProps): React.ReactElement {
  const [staged, setStaged] = useState<readonly Staged[]>([]);
  const [picking, setPicking] = useState(true);
  const counter = useRef(0);

  const stage = async (files: readonly File[]): Promise<void> => {
    const next: Staged[] = [];
    for (const file of files) {
      const bytesOfFile = await file.arrayBuffer();
      const kind = uploadKindOf(file.name);
      let problem: string | null = null;
      if (kind === "unsupported") problem = "只支持 Markdown（.md / .markdown / .txt）与 PDF / DOCX。";
      else if (kind === "markdown" && bytesOfFile.byteLength > MAX_MARKDOWN_BYTES) {
        problem = `超过单文件上限 ${Math.round(MAX_MARKDOWN_BYTES / 1024)} KB，请拆分后再上传。`;
      } else if (kind !== "markdown" && bytesOfFile.byteLength > MAX_CONVERSION_BYTES) {
        problem = `超过转换上限 ${String(Math.round(MAX_CONVERSION_BYTES / 1024 / 1024))} MB，MinerU 无法处理。`;
      } else if (kind === "markdown") {
        const reading = readUtf8Text(bytesOfFile);
        if (!reading.ok) problem = reading.problem;
      }
      counter.current += 1;
      next.push({
        id: `f${String(counter.current)}`,
        filename: file.name,
        bytes: bytesOfFile,
        kind: kind === "unsupported" ? "markdown" : kind,
        problem,
        consent: false,
      });
    }
    setStaged((current) => [...current, ...next]);
  };

  const usable = staged.filter((entry) => entry.problem === null);
  const markdown = usable.filter((entry) => entry.kind === "markdown");
  const conversions = usable.filter((entry) => entry.kind !== "markdown");
  const consented = conversions.filter((entry) => entry.consent);

  return (
    <section style={{ marginTop: 18 }} data-testid="document-upload">
      <div className="rp-section-head">
        <h2>添加材料</h2>
        <span>Markdown 直接入库；PDF / DOCX 需要先转换</span>
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
        <FileInput
          multiple
          clearable
          size="xs"
          leftSection={<FileUp size={14} />}
          placeholder="选择 Markdown / PDF / DOCX 文件"
          accept=".md,.markdown,.txt,.pdf,.docx"
          style={{ minWidth: 300 }}
          onChange={(files) => {
            const list = Array.isArray(files) ? files : files === null ? [] : [files];
            if (list.length === 0) return;
            void stage(list);
          }}
          data-testid="document-file-input"
        />
        <ConverterStatus mineru={props.mineru} checked={props.mineruChecked} onCheck={props.onCheckMineru} />
      </div>

      {!props.canUpload && (
        <p className="rp-chat__note" style={{ marginTop: 8 }}>
          上传需要先有一次探索或一个项目：文档归属在会话上，页面还不知道该把它交给谁。
        </p>
      )}

      {staged.length > 0 && (
        <div className="rp-files" style={{ marginTop: 12 }} data-testid="staged-files">
          {staged.map((entry) => (
            <div className="rp-file" key={entry.id} data-testid={`staged-${entry.id}`}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span className="rp-file__title">{entry.filename}</span>
                  <Badge size="xs" variant="light" color="gray">
                    {entry.kind === "markdown" ? "Markdown" : entry.kind.toUpperCase()}
                  </Badge>
                  <span className="rp-file__fact">{bytes(entry.bytes.byteLength)}</span>
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    leftSection={<Trash2 size={11} />}
                    onClick={() => {
                      setStaged((current) => current.filter((candidate) => candidate.id !== entry.id));
                    }}
                    data-testid={`staged-remove-${entry.id}`}
                  >
                    移除
                  </Button>
                </div>
                {entry.problem !== null ? (
                  <p className="rp-file__warn">{entry.problem}</p>
                ) : entry.kind === "markdown" ? (
                  <div style={{ marginTop: 8 }}>
                    <Button
                      size="xs"
                      variant="light"
                      loading={props.uploading}
                      disabled={!props.canUpload}
                      onClick={() => {
                        props.onUploadMarkdown({ filename: entry.filename, bytes: entry.bytes });
                        setStaged((current) => current.filter((candidate) => candidate.id !== entry.id));
                      }}
                      data-testid={`staged-upload-${entry.id}`}
                    >
                      加入文档库
                    </Button>
                  </div>
                ) : (
                  <div style={{ marginTop: 8 }}>
                    <Checkbox
                      size="xs"
                      checked={entry.consent}
                      onChange={(event) => {
                        const on = event.currentTarget.checked;
                        setStaged((current) =>
                          current.map((candidate) => (candidate.id === entry.id ? { ...candidate, consent: on } : candidate)),
                        );
                      }}
                      label={CONVERSION_CONSENT_TEXT}
                      data-testid={`conversion-consent-${entry.id}`}
                    />
                    <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center" }}>
                      <Tooltip
                        withArrow={false}
                        label={entry.consent ? "" : "需要先勾选上面的同意：文件会发送到 MinerU 在线服务。"}
                      >
                        <span>
                          <Button
                            size="xs"
                            leftSection={<HardDriveUpload size={13} />}
                            disabled={!entry.consent || !props.canUpload}
                            loading={props.converting}
                            onClick={() => {
                              props.onSubmitConversion({
                                filename: entry.filename,
                                bytes: entry.bytes,
                                kind: entry.kind === "pdf" ? "pdf" : "docx",
                              } satisfies ConsentedFile);
                              setStaged((current) => current.filter((candidate) => candidate.id !== entry.id));
                            }}
                            data-testid={`conversion-submit-${entry.id}`}
                          >
                            开始转换
                          </Button>
                        </span>
                      </Tooltip>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}
          {markdown.length > 1 && (
            <p className="rp-chat__note">多份 Markdown 请逐份加入：一次只提交一份，服务端才说得清是哪一份出了问题。</p>
          )}
          {consented.length === 0 && conversions.length > 0 && (
            <p className="rp-chat__note">
              <Info size={12} strokeWidth={1.75} aria-hidden="true" /> 没有勾选同意的文件不会被发送，也不会被上传到任何地方。
            </p>
          )}
        </div>
      )}

      {props.jobs.length > 0 && (
        <>
          <div className="rp-section-head" style={{ marginTop: 18 }}>
            <h2>转换任务</h2>
            <span>任务只保存在服务端内存里，服务重启后会失效</span>
          </div>
          <div className="rp-files" data-testid="conversion-jobs">
            {props.jobs.map((job) => (
              <JobRow
                key={job.jobId}
                job={job}
                gone={props.gone.includes(job.jobId)}
                retrying={props.retrying}
                onRetry={props.onRetry}
              />
            ))}
          </div>
        </>
      )}

      {props.jobs.some((job) => isActiveJob(job.status)) && (
        <p className="rp-chat__note" style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10 }}>
          <Loader size="xs" color="ink" /> 转换由 MinerU 在线服务执行，通常需要几十秒；页面会自动读取状态。
        </p>
      )}
      {props.jobs.length > 0 && props.jobs.every((job) => isTerminalJob(job.status)) && (
        <p className="rp-chat__note" style={{ marginTop: 10 }}>
          所有任务都已经结束。重复提交同一份文件会再次调用 MinerU 并再次消耗额度，服务端没有转换缓存。
        </p>
      )}
    </section>
  );
}
