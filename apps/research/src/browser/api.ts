/**
 * The workspace's view of the application API, and nothing else.
 *
 * The page talks to the same origin it was served from: the application's
 * routes are the only door, and there is no host, protocol or model client in
 * this bundle. Every type here mirrors what the routes really return, so a
 * change on the server side shows up as a compile error in the page rather than
 * as a blank panel.
 */

export interface CellView {
  readonly sectionId: string;
  readonly subjectId: string;
  readonly dimensionId: string;
  readonly subjectName: string;
  readonly dimensionName: string;
  readonly status: "sufficient" | "partial" | "missing" | "evaluating";
  readonly reason: string;
  readonly gap: string;
  readonly evidenceIds: readonly string[];
  readonly note: string;
}

export interface SourceView {
  readonly sourceId: string;
  readonly title: string;
  readonly authors: readonly string[];
  readonly venue: string;
  readonly publishedAt: string | null;
  readonly url: string;
  readonly doi: string | null;
  readonly abstract: string;
  readonly readStatus: "not_read" | "ok" | "failed";
  readonly readScope: "metadata" | "abstract" | "body_excerpt" | "full_text" | null;
  readonly readAt: string | null;
  readonly readUrl: string | null;
  readonly retrievalNote: string;
  readonly failure: string | null;
  readonly discovery: {
    readonly provider: string;
    readonly query: string;
    readonly queriedAt: string;
    readonly target: { readonly sectionId: string; readonly subjectId: string; readonly dimensionId: string } | null;
  };
}

export interface EvidenceView {
  readonly evidenceId: string;
  readonly sourceId: string;
  readonly excerpt: string;
  readonly locator: {
    readonly paragraphIndex: number;
    readonly headingPath: readonly string[];
    readonly charStart: number;
    readonly charEnd: number;
  };
  readonly readScope: "metadata" | "abstract" | "body_excerpt" | "full_text";
  readonly pickedBecause: string;
  readonly cells: readonly { readonly sectionId: string; readonly subjectId: string; readonly dimensionId: string }[];
}

export interface RunStepView {
  readonly name: string;
  readonly detail: string;
  readonly ok: boolean | null;
  readonly at: string;
}

export interface RunView {
  readonly runId: string | null;
  readonly stage: "card" | "research" | "gap" | "report" | "followup";
  readonly status: "running" | "completed" | "failed" | "interrupted";
  readonly note: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly activity: readonly RunStepView[];
}

export interface ReportView {
  readonly reportId: string;
  readonly title: string;
  readonly summary: string;
  readonly createdAt: string;
  readonly validation: { readonly ok: boolean; readonly problems: readonly string[]; readonly checkedAt: string };
  readonly isCurrent: boolean;
  readonly sections: readonly { readonly id: string; readonly title: string }[];
  readonly claims: readonly {
    readonly id: string;
    readonly text: string;
    readonly kind: "fact" | "comparison" | "inference";
    readonly evidenceIds: readonly string[];
  }[];
}

export interface ExportView {
  readonly exportId: string;
  readonly reportId: string;
  readonly status: "not_exported" | "exporting" | "exported" | "failed";
  readonly bytes: number;
  readonly failure: string | null;
  readonly createdAt: string;
  readonly isCurrentReport: boolean;
}

export interface TaskBundle {
  readonly task: {
    readonly id: string;
    readonly sessionId: string;
    readonly topic: string;
    readonly purpose: string;
    readonly audience: string;
    readonly focus: readonly string[];
    readonly exclusions: string;
    readonly lengthTarget: string;
    readonly status: "draft" | "confirmed" | "researching" | "ready" | "failed";
    readonly confirmed: boolean;
    readonly confirmedAt: string | null;
    readonly error: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
  };
  readonly structure: readonly { readonly id: string; readonly title: string; readonly question: string }[];
  readonly subjects: readonly { readonly id: string; readonly name: string; readonly note?: string }[];
  readonly dimensions: readonly { readonly id: string; readonly name: string; readonly question: string }[];
  readonly matrix: readonly CellView[];
  readonly gaps: readonly CellView[];
  readonly sources: readonly SourceView[];
  readonly evidence: readonly EvidenceView[];
  readonly reports: readonly ReportView[];
  readonly exports: readonly ExportView[];
  readonly runs: readonly RunView[];
  readonly budget: {
    readonly maxSearches: number;
    readonly maxCandidatesPerSearch: number;
    readonly maxReads: number;
    readonly maxGapRounds: number;
    readonly deadlineMs: number;
  };
  readonly usage: { readonly searches: number; readonly reads: number; readonly gapRounds: number; readonly startedAt?: string };
  readonly currentReportId: string | null;
  readonly hasReport: boolean;
  readonly busy: boolean;
}

export type SessionState =
  | { readonly kind: "pending"; readonly sessionId: string; readonly busy: boolean }
  | { readonly kind: "task"; readonly sessionId: string; readonly bundle: TaskBundle };

export interface TaskSummary {
  readonly id: string;
  readonly sessionId: string;
  readonly topic: string;
  readonly status: string;
  readonly subjects: readonly string[];
  readonly updatedAt: string;
  readonly hasReport: boolean;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  const value = text.length === 0 ? {} : (JSON.parse(text) as unknown);
  if (!response.ok) {
    const message = (value as { error?: string }).error ?? `HTTP ${response.status}`;
    throw new Error(message);
  }
  return value as T;
}

export const api = {
  listTasks: (): Promise<{ readonly tasks: readonly TaskSummary[] }> => request("/api/research/tasks"),
  startTask: (topic: string): Promise<{ readonly sessionId: string }> =>
    request("/api/research/tasks", { method: "POST", body: JSON.stringify({ topic }) }),
  sessionState: (sessionId: string): Promise<{ readonly pending: boolean; readonly task: TaskBundle | null }> =>
    request(`/api/research/sessions/${encodeURIComponent(sessionId)}`),
  task: (taskId: string): Promise<TaskBundle> => request(`/api/research/tasks/${encodeURIComponent(taskId)}`),
  confirm: (taskId: string): Promise<unknown> =>
    request(`/api/research/tasks/${encodeURIComponent(taskId)}/confirm`, { method: "POST", body: "{}" }),
  gap: (taskId: string): Promise<unknown> =>
    request(`/api/research/tasks/${encodeURIComponent(taskId)}/gap`, { method: "POST", body: "{}" }),
  report: (taskId: string): Promise<unknown> =>
    request(`/api/research/tasks/${encodeURIComponent(taskId)}/report`, { method: "POST", body: "{}" }),
  followUp: (taskId: string, text: string): Promise<unknown> =>
    request(`/api/research/tasks/${encodeURIComponent(taskId)}/followup`, {
      method: "POST",
      body: JSON.stringify({ text }),
    }),
  exportPdf: (taskId: string): Promise<{ readonly ok: boolean; readonly failure: string; readonly exportId?: string }> =>
    request(`/api/research/tasks/${encodeURIComponent(taskId)}/export`, { method: "POST", body: "{}" }),
  reportHtmlUrl: (reportId: string): string => `/api/research/reports/${encodeURIComponent(reportId)}/html`,
  exportFileUrl: (exportId: string): string => `/api/research/exports/${encodeURIComponent(exportId)}/file`,
};

export const SCOPE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  metadata: "仅元数据",
  abstract: "仅摘要",
  body_excerpt: "正文节选",
  full_text: "完整正文",
});

export const STATUS_MARKS: Readonly<Record<string, string>> = Object.freeze({
  sufficient: "●",
  partial: "◐",
  missing: "○",
  evaluating: "…",
});

export const STAGE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  card: "任务卡",
  research: "检索与读取",
  gap: "定向补查",
  report: "报告生成",
  followup: "追加指令",
});
