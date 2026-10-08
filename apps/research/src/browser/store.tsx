/**
 * The workspace's own state: which project is open, what is selected, what the
 * dock is showing, and what the application said the last time it was asked.
 *
 * Nothing here decides anything about the research. The page holds a replica of
 * the application's own JSON, refreshes it on a clock, and keeps a small amount
 * of view state — the open project, the selected object, the dock's target.
 * That split is why a refresh reopens a finished task exactly where it was left.
 *
 * Two things are added by this round and both are about *whose* state it is.
 * A **scope** is the exploration or the project the page is currently about,
 * and every read and every action captures it: a request that was sent for one
 * project can never write the state of another, and an action that resolves
 * after the reader has moved on does not act at all. A **receipt** is the small
 * record of something the server owns and the page can only ask about — a
 * conversion job — kept per session so that a reload can pick a real job back
 * up instead of showing a spinner for one that no longer exists.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  api,
  ApiError,
  type AnswerView,
  type CellView,
  type ConversionJobView,
  type DirectionPatch,
  type DocumentScope,
  type DocumentUsage,
  type DocumentView,
  type IntentView,
  type LibraryDocumentView,
  type MineruReadinessView,
  type RuntimeView,
  type TaskBundle,
  type TaskSummary,
} from "./api.js";
import { navigate, intentHash, projectHash } from "./router.js";
import { ResourcePoller } from "./polling.js";
import {
  INTENT_POINTER_KEY,
  RECEIPTS_KEY,
  base64Of,
  envelopeBytesOf,
  isTerminalJob,
  markdownProblemsOf,
  parseIntentPointer,
  parseReceipts,
  receiptsForSession,
  sha256Of,
  uploadKindOf,
  withReceipt,
  withReceiptDocument,
  MAX_ENVELOPE_BYTES,
  type ConsentedFile,
  type ConversionReceipt,
  type IntentPointer,
  type PendingFile,
} from "./upload-logic.js";
import { confirmGateOf } from "./intent-logic.js";
import { THIRD_PARTY_UPLOAD_CONSENT } from "./api.js";

/** How often the library of the open project is read; it changes rarely. */
const LIBRARY_PERIOD_MS = 10_000;

/** What the Context Dock is currently about. One dock, several subjects. */
export type DockTarget =
  | { readonly kind: "cell"; readonly subjectId: string; readonly dimensionId: string }
  | { readonly kind: "evidence"; readonly evidenceId: string }
  | { readonly kind: "source"; readonly sourceId: string }
  | { readonly kind: "claim"; readonly claimId: string }
  | { readonly kind: "section"; readonly sectionId: string }
  | { readonly kind: "proposal"; readonly proposalId: string }
  /**
   * What one action brought in, and nothing else.
   *
   * A 补查's own evidence is a different subject from the matrix cell it was
   * about: the reader asked "what did this find", and showing them the whole
   * project's material — or making them find the three new excerpts inside it —
   * answers a question they did not ask. The turn is named, not the ids: the
   * ids are the application's, and they are already on the run.
   */
  | { readonly kind: "action"; readonly interactionId: string }
  /**
   * The conversation, optionally scrolled back to one turn of it.
   *
   * `focus` is how "back to the conversation" means "back to what I was
   * reading" rather than "back to the top": a reader who followed a research
   * action into its evidence returns to that turn, not to the oldest one on
   * screen.
   */
  | { readonly kind: "assistant"; readonly focus?: string };

/** The document object the reader selected, and the actions that follow it. */
export type Selection =
  | { readonly kind: "cell"; readonly subjectId: string; readonly dimensionId: string }
  | { readonly kind: "section"; readonly sectionId: string }
  | { readonly kind: "claim"; readonly claimId: string; readonly sectionId: string }
  | { readonly kind: "comparison"; readonly sectionId: string }
  | { readonly kind: "source"; readonly sourceId: string }
  | null;

export type AssistantIntent = "auto" | "ask" | "research" | "edit";

export interface AssistantDraft {
  readonly intent: AssistantIntent;
  readonly sectionId: string | null;
  readonly text: string;
  /** Bumped so the composer can prefill itself when an action asks for it. */
  readonly token: number;
}

/**
 * What the page is about right now.
 *
 * `sessionId` is carried beside the id because it is the binding the server
 * checks: a document request names a session, and the page must name the same
 * one the exploration or the project belongs to rather than letting the server
 * infer the caller from the resource it is touching.
 */
export type Scope =
  | { readonly kind: "start" }
  | { readonly kind: "intent"; readonly intentId: string; readonly sessionId: string }
  | { readonly kind: "task"; readonly taskId: string; readonly sessionId: string };

export function scopeKeyOf(scope: Scope): string {
  if (scope.kind === "intent") return `intent:${scope.intentId}`;
  if (scope.kind === "task") return `task:${scope.taskId}`;
  return "start";
}

/** One conversion the reader has confirmed they want. */
export type { ConsentedFile };

interface AppState {
  /* data */
  readonly tasks: readonly TaskSummary[];
  readonly bundle: TaskBundle | null;
  readonly runtime: RuntimeView | null;
  readonly document: DocumentView | null;
  readonly answers: readonly AnswerView[];
  readonly loading: boolean;
  readonly notice: Notice | null;
  readonly busy: boolean;
  readonly connectionLost: boolean;

  /* intent */
  readonly scope: Scope;
  readonly sessionId: string | null;
  readonly intent: IntentView | null;
  readonly intentBusy: boolean;
  readonly intentPointer: IntentPointer | null;
  /** Local ms when this page confirmed a direction; the wait message reads it. */
  readonly confirmedAt: number | null;

  /* library and conversions */
  readonly library: readonly LibraryDocumentView[] | null;
  readonly libraryBusy: boolean;
  readonly jobs: readonly ConversionJobView[];
  readonly receipts: readonly ConversionReceipt[];
  readonly mineru: MineruReadinessView | null;
  readonly mineruChecked: boolean;
  readonly uploading: boolean;
  readonly converting: boolean;
  readonly savingUsage: boolean;
  readonly retryingConversion: boolean;
  /** The document an explicit 加入研究来源 is running for, if one is. */
  readonly promotingDocument: string | null;
  readonly jobGone: readonly string[];

  /* view state */
  readonly taskId: string | null;
  readonly selection: Selection;
  readonly dock: DockTarget | null;
  readonly assistant: AssistantDraft;
  readonly themeId: string;

  /* actions */
  openStart(): void;
  openTask(taskId: string): void;
  openIntent(intentId: string): void;
  startIntent(
    seedTopic: string,
    input: { readonly markdown?: readonly PendingFile[]; readonly conversions?: readonly ConsentedFile[] },
  ): Promise<boolean>;
  sendIntentMessage(text: string, documentIds?: readonly string[]): Promise<boolean>;
  saveIntentDirection(patch: DirectionPatch): Promise<boolean>;
  confirmIntent(draft?: DirectionPatch | null, options?: { readonly attachmentsBusy?: boolean }): Promise<boolean>;
  refreshIntent(): Promise<void>;
  refreshLibrary(): Promise<void>;
  uploadMarkdown(file: PendingFile): Promise<boolean>;
  submitConversion(file: ConsentedFile): Promise<boolean>;
  retryConversion(jobId: string, warningAccepted: boolean): Promise<boolean>;
  setDocumentUsage(documentId: string, usage: readonly DocumentUsage[], expectedRevision: number): Promise<boolean>;
  promoteDocument(documentId: string): Promise<boolean>;
  checkMineru(): Promise<void>;
  refresh(): Promise<void>;
  setSelection(next: Selection): void;
  openDock(target: DockTarget | null): void;
  prefillAssistant(next: { readonly intent: AssistantIntent; readonly sectionId: string | null; readonly text?: string }): void;
  /** What the reader has typed so far, kept while they look something up. */
  updateAssistant(next: { readonly intent?: AssistantIntent; readonly sectionId?: string | null; readonly text?: string }): void;
  setThemeId(next: string): void;
  act(action: () => Promise<unknown>, what: string): Promise<boolean>;
  say(kind: Notice["kind"], text: string): void;
  dismissNotice(): void;
}

export interface Notice {
  readonly kind: "info" | "success" | "warn" | "error";
  readonly text: string;
  /** The scope the sentence was said in; it does not follow the reader. */
  readonly scope: string;
}

const AppContext = createContext<AppState | null>(null);

/** The reading position of the selected cell, for the dock's own header. */
export function cellKey(cell: { readonly subjectId: string; readonly dimensionId: string }): string {
  return `${cell.subjectId}|${cell.dimensionId}`;
}

const THEME_KEY = "researchpage.theme";

function readPointer(): IntentPointer | null {
  try {
    return parseIntentPointer(window.localStorage.getItem(INTENT_POINTER_KEY));
  } catch {
    return null;
  }
}

function readReceipts(): readonly ConversionReceipt[] {
  try {
    return parseReceipts(window.localStorage.getItem(RECEIPTS_KEY));
  } catch {
    return [];
  }
}

/** The kind of file the reader chose, as the library names it. */
export function AppProvider({ children }: { readonly children: ReactNode }) {
  const [tasks, setTasks] = useState<readonly TaskSummary[]>([]);
  const [bundle, setBundle] = useState<TaskBundle | null>(null);
  const [runtime, setRuntime] = useState<RuntimeView | null>(null);
  const [document, setDocument] = useState<DocumentView | null>(null);
  const [answers, setAnswers] = useState<readonly AnswerView[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [working, setWorking] = useState(false);
  const [connectionLost, setConnectionLost] = useState(false);

  const [scope, setScope] = useState<Scope>({ kind: "start" });
  const [intent, setIntent] = useState<IntentView | null>(null);
  const [intentBusy, setIntentBusy] = useState(false);
  const [intentPointer, setIntentPointer] = useState<IntentPointer | null>(() => readPointer());
  const [confirmedAt, setConfirmedAt] = useState<number | null>(null);

  const [libraryState, setLibraryState] = useState<readonly LibraryDocumentView[] | null>(null);
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [jobs, setJobs] = useState<readonly ConversionJobView[]>([]);
  const [receipts, setReceipts] = useState<readonly ConversionReceipt[]>(() => readReceipts());
  const [mineru, setMineru] = useState<MineruReadinessView | null>(null);
  const [mineruChecked, setMineruChecked] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [converting, setConverting] = useState(false);
  const [savingUsage, setSavingUsage] = useState(false);
  const [retryingConversion, setRetryingConversion] = useState(false);
  const [promotingDocument, setPromotingDocument] = useState<string | null>(null);
  const [jobGone, setJobGone] = useState<readonly string[]>([]);

  const [selection, setSelection] = useState<Selection>(null);
  const [dock, setDock] = useState<DockTarget | null>(null);
  const [assistant, setAssistant] = useState<AssistantDraft>({ intent: "auto", sectionId: null, text: "", token: 0 });
  const [themeId, setThemeIdState] = useState<string>(
    () => window.localStorage.getItem(THEME_KEY) ?? "editorial",
  );

  const scopeRef = useRef<Scope>({ kind: "start" });
  const pollerRef = useRef<ResourcePoller | null>(null);
  const receiptsRef = useRef(receipts);
  const intentRef = useRef<IntentView | null>(null);
  const bundleRef = useRef<TaskBundle | null>(null);
  const workingRef = useRef(false);
  const intentBusyRef = useRef(false);
  // A poll that found nothing new must not re-render: React would replace the
  // elements a reader is about to click, and a page that redraws every two
  // seconds is worse to use than one that waits.
  const lastBundle = useRef("");
  const lastTasks = useRef("");
  const lastReportId = useRef("");
  const lastIntent = useRef("");
  const lastLibrary = useRef("");
  const lastAnswers = useRef("");
  const lastJobs = useRef("");

  if (pollerRef.current === null) pollerRef.current = new ResourcePoller();
  const poller = pollerRef.current;

  const say = useCallback((kind: Notice["kind"], text: string): void => {
    setNotice({ kind, text, scope: scopeKeyOf(scopeRef.current) });
  }, []);

  /**
   * Whether an answer still belongs to the scope the caller started in.
   *
   * Every await in this file is followed by this check. It is what makes
   * "switch project while something is in flight" a non-event: the request is
   * allowed to finish, its answer is simply not applied.
   */
  const current = useCallback((captured: Scope): boolean => scopeKeyOf(scopeRef.current) === scopeKeyOf(captured), []);

  const persistReceipts = useCallback((next: readonly ConversionReceipt[]): void => {
    receiptsRef.current = next;
    setReceipts(next);
    try {
      window.localStorage.setItem(RECEIPTS_KEY, JSON.stringify(next));
    } catch {
      // A browser that will not store the receipt is still a browser that can
      // show the job while the page stays open; losing the record is not a
      // reason to fail the upload that produced it.
    }
  }, []);

  /* ------------------------------------------------------------- resources -- */

  const registerTasks = useCallback((): void => {
    poller.add<{ readonly tasks: readonly TaskSummary[] }>({
      key: "tasks",
      read: (signal) => api.listTasks({ signal }),
      apply: (value) => {
        const serialized = JSON.stringify(value.tasks);
        if (serialized === lastTasks.current) return;
        lastTasks.current = serialized;
        setTasks(value.tasks);
      },
    });
  }, [poller]);

  const registerIntent = useCallback(
    (intentId: string): void => {
      poller.add<{ readonly view: IntentView; readonly busy: boolean; readonly taskId: string | null }>({
        key: `intent:${intentId}`,
        read: async (signal) => {
          const view = await api.intent(intentId, { signal });
          let found = view.intent.taskId;
          // A confirmed direction whose card is still being built has no task id
          // on the exploration yet, and the session is the other place the same
          // fact appears. Asking it is a *read* of what the server already
          // decided — it does not start anything, and it stops as soon as the
          // task is found.
          if (found === null && view.intent.status === "confirmed" && view.intent.sessionId.length > 0) {
            const state = await api.sessionState(view.intent.sessionId);
            if (state.task !== null && state.task.task.sessionId === view.intent.sessionId) found = state.task.task.id;
          }
          return { view: view.intent, busy: view.busy, taskId: found };
        },
        apply: (value) => {
          const serialized = JSON.stringify(value.view);
          if (serialized !== lastIntent.current) {
            lastIntent.current = serialized;
            intentRef.current = value.view;
            setIntent(value.view);
          }
          intentBusyRef.current = value.busy;
          setIntentBusy(value.busy);
          setConnectionLost(false);
          if (value.taskId !== null) adoptTask(intentId, value.view, value.taskId);
        },
        fail: (error) => {
          setConnectionLost(true);
          say("error", error instanceof Error ? error.message : "读取探索状态失败");
        },
      });
    },
    // `adoptTask` is defined below and stable; see its own comment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [poller, say],
  );

  const registerTask = useCallback(
    (id: string): void => {
      poller.add<TaskBundle>({
        key: `task:${id}`,
        read: async (signal) => {
          const next = await api.task(id, { signal });
          const asked = await api.answers(id, { signal });
          const serializedAnswers = JSON.stringify(asked.answers);
          if (serializedAnswers !== lastAnswers.current) {
            lastAnswers.current = serializedAnswers;
            setAnswers(asked.answers);
          }
          return next;
        },
        apply: (next) => {
          const serialized = JSON.stringify(next);
          if (serialized !== lastBundle.current) {
            lastBundle.current = serialized;
            bundleRef.current = next;
            setBundle(next);
          }
          setConnectionLost(false);
          const reportId = next.currentReportId;
          if (reportId !== null && reportId !== lastReportId.current) {
            lastReportId.current = reportId;
            void api
              .document(reportId)
              .then((fetched) => {
                if (scopeRef.current.kind === "task" && scopeRef.current.taskId === id) setDocument(fetched);
              })
              .catch(() => {
                // The report is a second read; failing it must not blank the
                // bundle that already arrived.
              });
          }
          if (next.busy) setConnectionLost(false);
        },
        fail: (error) => {
          setConnectionLost(true);
          say("error", error instanceof Error ? error.message : "读取研究状态失败");
        },
      });
    },
    [poller, say],
  );

  const registerLibrary = useCallback(
    (documentScope: DocumentScope): void => {
      poller.add<{ readonly documents: readonly LibraryDocumentView[] }>({
        key: "library",
        periodMs: LIBRARY_PERIOD_MS,
        read: (signal) => api.documents(documentScope, { signal }),
        apply: (value) => {
          const serialized = JSON.stringify(value.documents);
          if (serialized === lastLibrary.current) return;
          lastLibrary.current = serialized;
          setLibraryState(value.documents);
        },
        fail: (error) => {
          say("error", error instanceof Error ? error.message : "读取文档库失败");
        },
      });
    },
    [poller, say],
  );

  /**
   * Asks about one conversion job, and stops asking once it is over.
   *
   * A terminal job, or one the server no longer knows (a restart forgets jobs,
   * because a job lives in memory), stops its own clock: there is nothing left
   * to learn, and a page that kept asking would keep a reader's attention on a
   * thing that is finished.
   */
  const registerJob = useCallback(
    (receipt: ConversionReceipt): void => {
      const key = `job:${receipt.jobId}`;
      poller.add<{ readonly job: ConversionJobView }>({
        key,
        read: (signal) => api.conversionJob(receipt.jobId, receipt.sessionId, { signal }),
        apply: (value) => {
          setJobs((current_) => {
            const next = current_.filter((entry) => entry.jobId !== value.job.jobId).concat(value.job);
            const serialized = JSON.stringify(next);
            if (serialized === lastJobs.current) return current_;
            lastJobs.current = serialized;
            return next;
          });
          if (value.job.status === "succeeded" && value.job.document !== null) {
            const documentId = value.job.document.documentId;
            const next = withReceiptDocument(receiptsRef.current, value.job.jobId, documentId);
            if (JSON.stringify(next) !== JSON.stringify(receiptsRef.current)) persistReceipts(next);
          }
          if (isTerminalJob(value.job.status)) {
            poller.remove(key);
            void refreshDocumentsAfterConversion(receipt.sessionId);
          }
        },
        fail: (error) => {
          if (error instanceof ApiError && (error.status === 404 || error.code === "job_not_found")) {
            setJobGone((current_) => (current_.includes(receipt.jobId) ? current_ : [...current_, receipt.jobId]));
            poller.remove(key);
          }
        },
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [poller, persistReceipts],
  );

  /* --------------------------------------------------------------- scopes -- */

  const resetForScope = useCallback((): void => {
    poller.clear();
    lastBundle.current = "";
    lastReportId.current = "";
    lastAnswers.current = "";
    lastIntent.current = "";
    lastLibrary.current = "";
    lastJobs.current = "";
  }, [poller]);

  const enterScope = useCallback(
    (next: Scope): void => {
      scopeRef.current = next;
      setScope(next);
      resetForScope();
      setIntent(null);
      intentRef.current = null;
      setIntentBusy(false);
      setBundle(null);
      bundleRef.current = null;
      setDocument(null);
      setAnswers([]);
      setLibraryState(null);
      setJobs([]);
      setJobGone([]);
      setSelection(null);
      setDock(null);
      // A composer aimed at one project must not follow the reader into another.
      setAssistant({ intent: "auto", sectionId: null, text: "", token: 0 });
      // The previous scope's sentence — including a failure — belongs to what is
      // no longer on screen.
      setNotice((current_) => (current_ === null || current_.scope === scopeKeyOf(next) ? current_ : null));
      registerTasks();
      if (next.kind === "intent") {
        registerIntent(next.intentId);
        setConfirmedAt(null);
      }
      if (next.kind === "task") {
        registerTask(next.taskId);
        registerLibrary({ taskId: next.taskId });
      }
      poller.start();
    },
    [poller, registerIntent, registerLibrary, registerTask, registerTasks, resetForScope],
  );

  /**
   * Switches the page to a task the server built for a confirmation.
   *
   * This is the *only* way a confirmation becomes a project: the 202 the route
   * answers with carries no task id on the normal path, so the page navigates
   * when — and only when — the task really exists.
   *
   * It goes through `enterScope` rather than setting the scope itself, because
   * a scope is not just a name: it is the set of resources being read, and a
   * page that adopted a task without re-registering them would sit on a blank
   * project forever, waiting for a bundle nobody was asking for.
   */
  const adoptTask = useCallback(
    (intentId: string, from: IntentView, id: string): void => {
      const captured = scopeRef.current;
      if (captured.kind !== "intent" || captured.intentId !== intentId) return;
      setConfirmedAt(null);
      window.localStorage.setItem("researchpage.task", id);
      enterScope({ kind: "task", taskId: id, sessionId: from.sessionId });
      navigate(projectHash(id, "brief"));
    },
    [enterScope],
  );

  /* ---------------------------------------------------------------- actions -- */

  const openStart = useCallback((): void => {
    window.localStorage.removeItem("researchpage.task");
    enterScope({ kind: "start" });
    if (window.location.hash !== "#/") window.location.hash = "#/";
  }, [enterScope]);

  const openTask = useCallback(
    (id: string): void => {
      if (scopeRef.current.kind === "task" && scopeRef.current.taskId === id) {
        window.localStorage.setItem("researchpage.task", id);
        return;
      }
      const from = bundleRef.current;
      const sessionId = from !== null && from.task.id === id ? from.task.sessionId : "";
      window.localStorage.setItem("researchpage.task", id);
      enterScope({ kind: "task", taskId: id, sessionId });
    },
    [enterScope],
  );

  const openIntent = useCallback(
    (intentId: string): void => {
      const pointer = intentPointer;
      const sessionId =
        pointer !== null && pointer.intentId === intentId
          ? pointer.sessionId
          : intentRef.current !== null && intentRef.current.intentId === intentId
            ? intentRef.current.sessionId
            : "";
      enterScope({ kind: "intent", intentId, sessionId });
    },
    [enterScope, intentPointer],
  );

  /** Remembers an exploration so the front page can offer to continue it. */
  const rememberIntent = useCallback((pointer: IntentPointer): void => {
    setIntentPointer(pointer);
    try {
      window.localStorage.setItem(INTENT_POINTER_KEY, JSON.stringify(pointer));
    } catch {
      // Same reasoning as the receipts: a pointer that will not persist costs a
      // convenience on the next visit, not the work already done.
    }
  }, []);

  const registerJobsFor = useCallback(
    (sessionId: string): void => {
      for (const receipt of receiptsForSession(receiptsRef.current, sessionId)) {
        registerJob(receipt);
        poller.start(`job:${receipt.jobId}`);
      }
    },
    [poller, registerJob],
  );

  const refreshIntent = useCallback(async (): Promise<void> => {
    const captured = scopeRef.current;
    if (captured.kind !== "intent") return;
    await poller.refresh(`intent:${captured.intentId}`);
  }, [poller]);

  const refreshLibrary = useCallback(async (): Promise<void> => {
    const captured = scopeRef.current;
    setLibraryBusy(true);
    try {
      if (captured.kind === "task") await poller.refresh("library");
      else if (captured.kind === "intent") await poller.refresh(`intent:${captured.intentId}`);
    } finally {
      setLibraryBusy(false);
    }
  }, [poller]);

  const refresh = useCallback(async (): Promise<void> => {
    await poller.refresh();
  }, [poller]);

  const startIntent = useCallback(
    async (
      seedTopic: string,
      input: { readonly markdown?: readonly PendingFile[]; readonly conversions?: readonly ConsentedFile[] },
    ): Promise<boolean> => {
      const markdown = input.markdown ?? [];
      const conversions = input.conversions ?? [];
      const problems = markdownProblemsOf(markdown);
      if (problems.length > 0) {
        const first = problems[0];
        say("error", first === undefined ? "有文件不能上传。" : `${first.filename}：${first.problem}`);
        return false;
      }
      const documents = markdown.map((file) => ({
        filename: file.filename,
        contentBase64: base64Of(new Uint8Array(file.bytes)),
      }));
      const envelope = { seedTopic, ...(documents.length === 0 ? {} : { documents }) };
      if (envelopeBytesOf(envelope) > MAX_ENVELOPE_BYTES) {
        say(
          "error",
          `这些附件一起提交超过了一次请求的上限（${Math.round(MAX_ENVELOPE_BYTES / 1024)} KB）。请先只提交主题，进入探索后再逐份上传。`,
        );
        return false;
      }
      setWorking(true);
      workingRef.current = true;
      try {
        const created = await api.createIntent(envelope);
        rememberIntent({ intentId: created.intentId, sessionId: created.sessionId, seedTopic });
        enterScope({ kind: "intent", intentId: created.intentId, sessionId: created.sessionId });
        navigate(intentHash(created.intentId));
        say("info", "已开始方向澄清：助手会先问清楚研究范围，确认之后才会建立任务卡。");
        // The PDF/DOCX files go up *after* the exploration exists, because a
        // conversion belongs to a session and the session only exists now. The
        // consent they carry was given for these files, on the front page.
        for (const file of conversions) {
          await submitConversionIn({ kind: "intent", intentId: created.intentId, sessionId: created.sessionId }, file, {
            announce: false,
          });
        }
        return true;
      } catch (error) {
        say("error", error instanceof Error ? error.message : "提交主题失败");
        return false;
      } finally {
        setWorking(false);
        workingRef.current = false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [enterScope, rememberIntent, say],
  );

  /**
   * One conversion, submitted under a scope the caller names.
   *
   * The scope is passed in rather than read from the store because the front
   * page starts conversions for the exploration it *just* created, and the
   * store's own scope at that moment may still be the old one. Every receipt is
   * filed under its own session, so the jobs of two projects never mix.
   */
  const submitConversionIn = useCallback(
    async (inScope: Scope, file: ConsentedFile, options: { readonly announce: boolean }): Promise<boolean> => {
      const sessionId = inScope.kind === "start" ? "" : inScope.sessionId;
      if (sessionId.length === 0) {
        say("error", "还没有可用的会话，无法提交转换。");
        return false;
      }
      const documentScope = documentScopeOf_(inScope);
      if (documentScope === null) {
        say("error", "这次转换没有可以归属的探索或项目。");
        return false;
      }
      setConverting(true);
      try {
        const digest = await sha256Of(file.bytes);
        const job = await api.submitConversion({
          scope: documentScope,
          filename: file.filename,
          usage: ["intent_context"],
          bytes: file.bytes,
          consent: THIRD_PARTY_UPLOAD_CONSENT,
        });
        const receipt: ConversionReceipt = {
          jobId: job.job.jobId,
          sessionId,
          filename: job.job.filename,
          kind: file.kind,
          sha256: digest ?? job.job.sha256,
          documentId: null,
          at: new Date().toISOString(),
        };
        persistReceipts(withReceipt(receiptsRef.current, receipt));
        registerJob(receipt);
        poller.start(`job:${receipt.jobId}`);
        if (options.announce) say("info", `已提交转换：${job.job.filename}。转换会调用 MinerU 在线服务。`);
        return true;
      } catch (error) {
        say("error", conversionProblemOf(error, `提交转换失败：${file.filename}`));
        return false;
      } finally {
        setConverting(false);
      }
    },
    [persistReceipts, poller, registerJob, say],
  );

  const submitConversion = useCallback(
    async (file: ConsentedFile): Promise<boolean> => submitConversionIn(scopeRef.current, file, { announce: true }),
    [submitConversionIn],
  );

  const retryConversion = useCallback(
    async (jobId: string, warningAccepted: boolean): Promise<boolean> => {
      if (!warningAccepted) return false;
      const receipt = receiptsRef.current.find((entry) => entry.jobId === jobId);
      if (receipt === undefined) {
        say("error", "页面没有这次转换的记录，无法重试。");
        return false;
      }
      setRetryingConversion(true);
      try {
        const retried = await api.retryConversion(jobId, receipt.sessionId);
        const next = retried.job;
        setJobs((current_) => current_.filter((entry) => entry.jobId !== next.jobId).concat(next));
        setJobGone((current_) => current_.filter((id) => id !== jobId));
        registerJob(receipt);
        poller.start(`job:${jobId}`);
        say("info", "已重新排队：这次转换会再次调用 MinerU，并再次消耗额度。");
        return true;
      } catch (error) {
        say("error", conversionProblemOf(error, "重试转换失败"));
        return false;
      } finally {
        setRetryingConversion(false);
      }
    },
    [poller, registerJob, say],
  );

  const refreshDocumentsAfterConversion = useCallback(
    async (sessionId: string): Promise<void> => {
      const captured = scopeRef.current;
      if (captured.kind === "task" && captured.sessionId === sessionId) await poller.refresh("library");
      if (captured.kind === "intent" && captured.sessionId === sessionId) await poller.refresh(`intent:${captured.intentId}`);
    },
    [poller],
  );

  /** The scope a document write names, or null when there is nothing to name. */
  const documentScopeOf_ = useCallback((captured: Scope): DocumentScope | null => {
    if (captured.kind === "intent") return { intentId: captured.intentId };
    if (captured.kind === "task") return { taskId: captured.taskId };
    return null;
  }, []);

  const uploadMarkdown = useCallback(
    async (file: PendingFile): Promise<boolean> => {
      const captured = scopeRef.current;
      const scopeDeclaration = documentScopeOf_(captured);
      if (scopeDeclaration === null) {
        say("error", "先进入一次探索或一个项目，再上传文档。");
        return false;
      }
      const problems = markdownProblemsOf([file]);
      if (problems.length > 0) {
        const first = problems[0];
        say("error", first === undefined ? "这份文件不能上传。" : `${first.filename}：${first.problem}`);
        return false;
      }
      setUploading(true);
      try {
        const uploaded = await api.uploadDocument({
          filename: file.filename,
          contentBase64: base64Of(new Uint8Array(file.bytes)),
          usage: ["intent_context"],
          scope: scopeDeclaration,
        });
        if (!current(captured)) return true;
        await refreshDocumentsAfterConversion(captured.kind === "start" ? "" : captured.sessionId);
        say(
          "info",
          uploaded.duplicate
            ? `文档库里已经有内容相同的文件，这次只复用了已有记录：${uploaded.document.title}。`
            : `已加入文档库：${uploaded.document.title}。它目前的用途是「澄清方向时参考」。`,
        );
        return true;
      } catch (error) {
        say("error", error instanceof Error ? error.message : "上传 Markdown 失败");
        return false;
      } finally {
        setUploading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [current, documentScopeOf_, refreshDocumentsAfterConversion, say],
  );

  const setDocumentUsage = useCallback(
    async (documentId: string, usage: readonly DocumentUsage[], expectedRevision: number): Promise<boolean> => {
      const captured = scopeRef.current;
      const scopeDeclaration = documentScopeOf_(captured);
      if (scopeDeclaration === null) return false;
      setSavingUsage(true);
      try {
        await api.setDocumentUsage(documentId, { usage, expectedRevision, scope: scopeDeclaration });
        if (!current(captured)) return true;
        await refreshDocumentsAfterConversion(captured.kind === "start" ? "" : captured.sessionId);
        say("info", usage.length === 0 ? "已清空用途。" : "已更新这份文档的用途。");
        return true;
      } catch (error) {
        if (!current(captured)) return false;
        if (error instanceof ApiError && error.conflict) {
          // The revision moved: re-read the list and keep what the user chose,
          // so the retry is one click against the new revision rather than a
          // re-decision.
          await refreshDocumentsAfterConversion(captured.kind === "start" ? "" : captured.sessionId);
          const latest = (intentRef.current?.documents ?? libraryState)?.find((entry) => entry.documentId === documentId);
          say(
            "warn",
            `这份文档已经被改过（当前版本 ${String(latest?.revision ?? "未知")}），页面已重新读取；请确认后再次提交。`,
          );
          return false;
        }
        say("error", error instanceof Error ? error.message : "更新文档用途失败");
        return false;
      } finally {
        setSavingUsage(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [current, documentScopeOf_, libraryState, refreshDocumentsAfterConversion, say],
  );

  const promoteDocument = useCallback(
    async (documentId: string): Promise<boolean> => {
      const captured = scopeRef.current;
      if (captured.kind !== "task") {
        say("error", "加入研究来源要在任务卡建立之后。");
        return false;
      }
      setPromotingDocument(documentId);
      try {
        const result = await api.promoteDocumentToSource(documentId, {
          taskId: captured.taskId,
          scope: { taskId: captured.taskId },
        });
        if (!current(captured)) return true;
        await Promise.all([poller.refresh("library"), poller.refresh(`task:${captured.taskId}`)]);
        say(
          "info",
          result.created
            ? "已加入研究来源：身份是「用户提供」，读取状态是「尚未读取」；它不会自动变成证据。"
            : "这份文档已经是研究来源，没有重复加入。",
        );
        return true;
      } catch (error) {
        say("error", error instanceof Error ? error.message : "加入研究来源失败");
        return false;
      } finally {
        setPromotingDocument(null);
      }
    },
    [current, poller, say],
  );

  const checkMineru = useCallback(async (): Promise<void> => {
    try {
      const status = await api.mineru();
      setMineru(status);
      setMineruChecked(true);
    } catch (error) {
      setMineruChecked(true);
      if (error instanceof ApiError && error.status === 503) {
        // A 503 here is an answer, not a failure of the page: it is the server
        // saying the converter is not reachable, with its own problem sentence.
        const body = error.body as Partial<MineruReadinessView>;
        setMineru({
          ok: false,
          mineru: body.mineru ?? { transport: "", command: "", package: "", mode: "", parseDocuments: false, durationMs: 0 },
          limits: body.limits ?? { maxBytes: 0, maxPages: 0, formats: [], online: true, dataHandling: "" },
          problem: typeof body.problem === "string" ? body.problem : error.message,
        });
        return;
      }
      setMineru(null);
      say("error", error instanceof Error ? error.message : "检查转换服务失败");
    }
  }, [say]);

  const sendIntentMessage = useCallback(
    async (text: string, documentIds: readonly string[] = []): Promise<boolean> => {
      const captured = scopeRef.current;
      if (captured.kind !== "intent") return false;
      const view = intentRef.current;
      if (view === null) return false;
      setWorking(true);
      workingRef.current = true;
      try {
        await api.sendIntentMessage(captured.intentId, {
          text,
          ...(documentIds.length === 0 ? {} : { documentIds }),
          expectedVersion: view.version,
        });
        if (current(captured)) await poller.refresh(`intent:${captured.intentId}`);
        return true;
      } catch (error) {
        if (!current(captured)) return false;
        if (error instanceof ApiError && error.status === 409) {
          // Two conflicts share this status and they have two different fixes.
          // The stale one carries the exploration the page is out of date
          // against; the running one does not, and means wait rather than
          // re-read.
          if (error.intent !== undefined) {
            lastIntent.current = JSON.stringify(error.intent);
            intentRef.current = error.intent;
            setIntent(error.intent);
            say("warn", "这段对话在另一处被修改过，页面已重新读取；请确认后再发送一次。");
          } else {
            say("warn", error.guidance ?? "上一轮还在处理中，请等待它结束后再发送。");
          }
          await poller.refresh(`intent:${captured.intentId}`);
          return false;
        }
        say("error", error instanceof Error ? error.message : "发送消息失败");
        return false;
      } finally {
        setWorking(false);
        workingRef.current = false;
      }
    },
    [current, poller, say],
  );

  const saveIntentDirection = useCallback(
    async (patch: DirectionPatch): Promise<boolean> => {
      const captured = scopeRef.current;
      if (captured.kind !== "intent") return false;
      const view = intentRef.current;
      if (view === null) return false;
      setWorking(true);
      workingRef.current = true;
      try {
        await api.saveIntentDirection(captured.intentId, { expectedVersion: view.version, direction: patch });
        if (current(captured)) {
          await poller.refresh(`intent:${captured.intentId}`);
          say("success", "已保存你的修改；方向在你确认之前仍然只是建议。");
        }
        return true;
      } catch (error) {
        if (!current(captured)) return false;
        if (error instanceof ApiError && error.status === 409) {
          if (error.intent !== undefined) {
            lastIntent.current = JSON.stringify(error.intent);
            intentRef.current = error.intent;
            setIntent(error.intent);
          }
          say("warn", "方向已经被改过，页面已重新读取；你的改动还在编辑器里，请确认后再保存。");
          await poller.refresh(`intent:${captured.intentId}`);
          return false;
        }
        say("error", error instanceof Error ? error.message : "保存方向失败");
        return false;
      } finally {
        setWorking(false);
        workingRef.current = false;
      }
    },
    [current, poller, say],
  );

  /**
   * Confirms the direction — once, and only when the page can see the draft.
   *
   * The order is the product's: an unsaved edit is saved first and the
   * confirmation is sent against the version that save produced, so what is
   * confirmed is what the user was looking at. A 202 is not a project: the page
   * waits for the task to exist (see the exploration resource) instead of
   * navigating to a card that has not been written yet.
   */
  const confirmIntent = useCallback(
    async (draft: DirectionPatch | null = null, options: { readonly attachmentsBusy?: boolean } = {}): Promise<boolean> => {
      const captured = scopeRef.current;
      if (captured.kind !== "intent") return false;
      const view = intentRef.current;
      if (view === null) return false;
      const gate = confirmGateOf({
        status: view.status,
        canConfirm: view.canConfirm,
        serverBusy: intentBusyRef.current,
        working: workingRef.current,
        dirty: false,
        attachmentsBusy: options.attachmentsBusy === true,
      });
      if (!gate.allowed) {
        say("warn", gate.reason);
        return false;
      }
      setWorking(true);
      workingRef.current = true;
      try {
        // What the user looked at is what gets confirmed: an edit still in the
        // editor is saved first, and the confirmation is sent against the
        // version that save produced. A confirmation against the older version
        // would confirm a direction nobody saw.
        let version = view.version;
        if (draft !== null && Object.keys(draft).length > 0) {
          const saved = await api.saveIntentDirection(captured.intentId, { expectedVersion: version, direction: draft });
          version = saved.intent.version;
          lastIntent.current = JSON.stringify(saved.intent);
          intentRef.current = saved.intent;
          if (current(captured)) setIntent(saved.intent);
        }
        if (!current(captured)) return true;
        const result = await api.confirmIntent(captured.intentId, { expectedVersion: version });
        if (!current(captured)) return true;
        setConfirmedAt(Date.now());
        say("info", "方向已确认，正在等待任务卡；任务卡出现后会自动打开研究范围。");
        if (result.taskId !== null) adoptTask(captured.intentId, view, result.taskId);
        else await poller.refresh(`intent:${captured.intentId}`);
        return true;
      } catch (error) {
        if (!current(captured)) return false;
        if (error instanceof ApiError && error.status === 409 && error.intent !== undefined) {
          lastIntent.current = JSON.stringify(error.intent);
          intentRef.current = error.intent;
          setIntent(error.intent);
          say("warn", "方向已经被修改过，页面已重新读取；请再次审阅后确认。你的改动仍在编辑器里。");
          return false;
        }
        say("error", error instanceof Error ? error.message : "确认方向失败");
        return false;
      } finally {
        setWorking(false);
        workingRef.current = false;
      }
    },
    [adoptTask, current, poller, say],
  );

  /* ------------------------------------------------------------- lifecycle -- */

  useEffect(() => {
    void api
      .runtime()
      .then(setRuntime)
      .catch(() => {
        setRuntime(null);
      });
  }, []);

  // The address is the page's state, and the first render has to agree with it:
  // a URL that names a project or an exploration opens that one, and `#/` opens
  // the front page rather than redirecting to whatever was open last time.
  useEffect(() => {
    registerTasks();
    poller.start("tasks");
    const hash = window.location.hash;
    const project = /^#\/p\/([^/]+)/.exec(hash);
    const exploration = /^#\/i\/([^/]+)/.exec(hash);
    if (exploration !== null) openIntent(decodeURIComponent(exploration[1] ?? ""));
    else if (project !== null) openTask(decodeURIComponent(project[1] ?? ""));
    else enterScope({ kind: "start" });
    setLoading(false);
    return () => {
      // Every read belongs to the scope that started it, so retiring them is
      // what an unmount does — the requests are aborted and no answer can land.
      poller.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A hidden page stops reading; coming back reads immediately.
  useEffect(() => {
    const onVisibility = (): void => {
      poller.setVisible(window.document.visibilityState === "visible");
    };
    window.document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [poller]);

  // A failed read is a statement about the connection, and stopping saying so is
  // a statement about a later success.
  useEffect(() => {
    if (connectionLost && bundle !== null) setConnectionLost(false);
  }, [connectionLost, bundle]);

  // A job receipt survives a reload, which is the whole reason it is kept: the
  // page can ask about a conversion that was started before it was reopened.
  const scopeSession = scope.kind === "start" ? null : scope.sessionId;
  useEffect(() => {
    if (scopeSession === null) return;
    registerJobsFor(scopeSession);
  }, [registerJobsFor, scopeSession]);

  const act = useCallback(
    async (action: () => Promise<unknown>, what: string): Promise<boolean> => {
      const captured = scopeRef.current;
      setWorking(true);
      workingRef.current = true;
      try {
        await action();
        if (current(captured)) await poller.refresh();
        return true;
      } catch (error) {
        if (current(captured)) say("error", error instanceof Error ? error.message : `${what}失败`);
        return false;
      } finally {
        setWorking(false);
        workingRef.current = false;
      }
    },
    [current, poller, say],
  );

  const prefillAssistant = useCallback(
    (next: { readonly intent: AssistantIntent; readonly sectionId: string | null; readonly text?: string }): void => {
      setAssistant((current_) => ({
        intent: next.intent,
        sectionId: next.sectionId,
        text: next.text ?? current_.text,
        token: current_.token + 1,
      }));
      setDock({ kind: "assistant" });
    },
    [],
  );

  const updateAssistant = useCallback(
    (next: { readonly intent?: AssistantIntent; readonly sectionId?: string | null; readonly text?: string }): void => {
      setAssistant((current_) => ({
        intent: next.intent ?? current_.intent,
        sectionId: next.sectionId === undefined ? current_.sectionId : next.sectionId,
        text: next.text ?? current_.text,
        token: current_.token,
      }));
    },
    [],
  );

  const setThemeId = useCallback((next: string): void => {
    setThemeIdState(next);
    window.localStorage.setItem(THEME_KEY, next);
  }, []);

  /**
   * The library the page shows, whichever scope it is in.
   *
   * An exploration carries its own documents inside the envelope it is polled
   * by, so that is the full list — reading the same documents a second time
   * every two seconds would be two answers to one question. A project has no
   * such envelope, so its library is the one read on its own clock.
   */
  const library = useMemo<readonly LibraryDocumentView[] | null>(() => {
    if (scope.kind === "intent") return intent?.documents ?? null;
    if (scope.kind === "task") return libraryState;
    return null;
  }, [scope.kind, intent, libraryState]);

  /** The open project's id, which is a property of the scope rather than state. */
  const taskId = scope.kind === "task" ? scope.taskId : null;

  /** The session the page's own writes belong to, for a component that asks. */
  const sessionId = scope.kind === "start" ? null : scope.sessionId;

  const value = useMemo<AppState>(
    () => ({
      tasks,
      bundle,
      runtime,
      document,
      answers,
      loading,
      notice,
      busy: working || (bundle?.busy ?? false),
      connectionLost: connectionLost && scope.kind !== "start",
      scope,
      sessionId,
      intent,
      intentBusy,
      intentPointer,
      confirmedAt,
      library,
      libraryBusy,
      jobs,
      receipts,
      mineru,
      mineruChecked,
      uploading,
      converting,
      savingUsage,
      retryingConversion,
      promotingDocument,
      jobGone,
      taskId,
      selection,
      dock,
      assistant,
      themeId,
      openStart,
      openTask,
      openIntent,
      startIntent,
      sendIntentMessage,
      saveIntentDirection,
      confirmIntent,
      refreshIntent,
      refreshLibrary,
      uploadMarkdown,
      submitConversion,
      retryConversion,
      setDocumentUsage,
      promoteDocument,
      checkMineru,
      refresh,
      setSelection,
      openDock: setDock,
      prefillAssistant,
      updateAssistant,
      setThemeId,
      act,
      say,
      dismissNotice: () => {
        setNotice(null);
      },
    }),
    [
      tasks,
      bundle,
      runtime,
      document,
      answers,
      loading,
      notice,
      working,
      connectionLost,
      scope,
      sessionId,
      intent,
      intentBusy,
      intentPointer,
      confirmedAt,
      library,
      libraryBusy,
      jobs,
      receipts,
      mineru,
      mineruChecked,
      uploading,
      converting,
      savingUsage,
      retryingConversion,
      promotingDocument,
      jobGone,
      taskId,
      selection,
      dock,
      assistant,
      themeId,
      openStart,
      openTask,
      openIntent,
      startIntent,
      sendIntentMessage,
      saveIntentDirection,
      confirmIntent,
      refreshIntent,
      refreshLibrary,
      uploadMarkdown,
      submitConversion,
      retryConversion,
      setDocumentUsage,
      promoteDocument,
      checkMineru,
      refresh,
      prefillAssistant,
      updateAssistant,
      setThemeId,
      act,
      say,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

/** One project's cell, by its coordinates. */
export function findCell(bundle: TaskBundle, target: { readonly subjectId: string; readonly dimensionId: string }): CellView | undefined {
  return bundle.matrix.find((cell) => cell.subjectId === target.subjectId && cell.dimensionId === target.dimensionId);
}

/** The current report's sections as the workspace shows them in lists. */
export function currentReportOf(bundle: TaskBundle | null): TaskBundle["reports"][number] | null {
  if (bundle === null) return null;
  return bundle.reports.find((report) => report.isCurrent) ?? null;
}

/** The sentence a conversion refusal is shown with, problem first. */
function conversionProblemOf(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    const guidance = error.guidance;
    return guidance === undefined ? error.message : `${error.message}${error.message.endsWith("。") ? "" : "。"}${guidance}`;
  }
  return error instanceof Error ? error.message : fallback;
}

export function useApp(): AppState {
  const value = useContext(AppContext);
  if (value === null) throw new Error("useApp must be used inside AppProvider");
  return value;
}
