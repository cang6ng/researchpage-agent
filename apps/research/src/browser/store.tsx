/**
 * The workspace's own state: which project is open, what is selected, what the
 * dock is showing, and what the application said the last time it was asked.
 *
 * Nothing here decides anything about the research. The page holds a replica of
 * the application's own JSON, refreshes it by polling, and keeps a small amount
 * of view state — the open project, the selected object, the dock's target.
 * That split is why a refresh reopens a finished task exactly where it was left.
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
  type AnswerView,
  type CellView,
  type DocumentView,
  type RuntimeView,
  type TaskBundle,
  type TaskSummary,
} from "./api.js";

const POLL_MS = 2_000;

/** What the Context Dock is currently about. One dock, several subjects. */
export type DockTarget =
  | { readonly kind: "cell"; readonly subjectId: string; readonly dimensionId: string }
  | { readonly kind: "evidence"; readonly evidenceId: string }
  | { readonly kind: "source"; readonly sourceId: string }
  | { readonly kind: "claim"; readonly claimId: string }
  | { readonly kind: "section"; readonly sectionId: string }
  | { readonly kind: "proposal"; readonly proposalId: string }
  | { readonly kind: "assistant" };

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

interface AppState {
  /* data */
  readonly tasks: readonly TaskSummary[];
  readonly bundle: TaskBundle | null;
  readonly pendingSessionId: string | null;
  readonly runtime: RuntimeView | null;
  readonly document: DocumentView | null;
  readonly answers: readonly AnswerView[];
  readonly loading: boolean;
  readonly notice: Notice | null;
  readonly busy: boolean;

  /* view state */
  readonly taskId: string | null;
  readonly selection: Selection;
  readonly dock: DockTarget | null;
  readonly assistant: AssistantDraft;
  readonly themeId: string;

  /* actions */
  openStart(): void;
  openTask(taskId: string): void;
  startTopic(topic: string): Promise<void>;
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
}

const AppContext = createContext<AppState | null>(null);

/** The reading position of the selected cell, for the dock's own header. */
export function cellKey(cell: { readonly subjectId: string; readonly dimensionId: string }): string {
  return `${cell.subjectId}|${cell.dimensionId}`;
}

const THEME_KEY = "researchpage.theme";

export function AppProvider({ children }: { readonly children: ReactNode }) {
  const [tasks, setTasks] = useState<readonly TaskSummary[]>([]);
  const [bundle, setBundle] = useState<TaskBundle | null>(null);
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<RuntimeView | null>(null);
  const [document, setDocument] = useState<DocumentView | null>(null);
  const [answers, setAnswers] = useState<readonly AnswerView[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [working, setWorking] = useState(false);
  const [taskId, setTaskId] = useState<string | null>(() => window.localStorage.getItem("researchpage.task"));
  const [selection, setSelection] = useState<Selection>(null);
  const [dock, setDock] = useState<DockTarget | null>(null);
  const [assistant, setAssistant] = useState<AssistantDraft>({ intent: "auto", sectionId: null, text: "", token: 0 });
  const [themeId, setThemeIdState] = useState<string>(
    () => window.localStorage.getItem(THEME_KEY) ?? "editorial",
  );

  const inFlight = useRef(false);
  // A poll that found nothing new must not re-render: React would replace the
  // elements a reader is about to click, and a page that redraws every two
  // seconds is worse to use than one that waits.
  const lastBundle = useRef("");
  const lastTasks = useRef("");
  const lastReportId = useRef("");
  // The answers read is a second request per cycle; setting state from it
  // unconditionally would re-render the page every poll and swap the elements
  // a reader is about to click.
  const lastAnswers = useRef("");

  const say = useCallback((kind: Notice["kind"], text: string): void => {
    setNotice({ kind, text });
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      if (taskId !== null) {
        const next = await api.task(taskId);
        const serialized = JSON.stringify(next);
        if (serialized !== lastBundle.current) {
          lastBundle.current = serialized;
          setBundle(next);
        }
        if (next.currentReportId !== null && lastReportId.current !== next.currentReportId) {
          lastReportId.current = next.currentReportId;
          const fetched = await api.document(next.currentReportId);
          setDocument(fetched);
        }
        const asked = await api.answers(taskId);
        const serializedAnswers = JSON.stringify(asked.answers);
        if (serializedAnswers !== lastAnswers.current) {
          lastAnswers.current = serializedAnswers;
          setAnswers(asked.answers);
        }
      } else if (pendingSessionId !== null) {
        const state = await api.sessionState(pendingSessionId);
        if (state.task !== null) {
          lastBundle.current = JSON.stringify(state.task);
          setBundle(state.task);
          setTaskId(state.task.task.id);
          window.localStorage.setItem("researchpage.task", state.task.task.id);
          setPendingSessionId(null);
          window.location.hash = `#/p/${state.task.task.id}/brief`;
        } else if (!state.pending) {
          setPendingSessionId(null);
          say("error", "任务卡没有生成成功，请重新提交主题。");
        }
      }
      const listed = await api.listTasks();
      const serializedTasks = JSON.stringify(listed.tasks);
      if (serializedTasks !== lastTasks.current) {
        lastTasks.current = serializedTasks;
        setTasks(listed.tasks);
      }
    } catch (error) {
      say("error", error instanceof Error ? error.message : "读取研究状态失败");
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [taskId, pendingSessionId, say]);

  useEffect(() => {
    void api
      .runtime()
      .then(setRuntime)
      .catch(() => {
        setRuntime(null);
      });
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, POLL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [refresh]);

  const act = useCallback(
    async (action: () => Promise<unknown>, what: string): Promise<boolean> => {
      setWorking(true);
      try {
        await action();
        await refresh();
        return true;
      } catch (error) {
        say("error", error instanceof Error ? error.message : `${what}失败`);
        return false;
      } finally {
        setWorking(false);
      }
    },
    [refresh, say],
  );

  const openStart = useCallback((): void => {
    setTaskId(null);
    setPendingSessionId(null);
    setBundle(null);
    setDocument(null);
    setAnswers([]);
    setSelection(null);
    setDock(null);
    setAssistant({ intent: "auto", sectionId: null, text: "", token: 0 });
    lastBundle.current = "";
    lastReportId.current = "";
    lastAnswers.current = "";
    window.localStorage.removeItem("researchpage.task");
    if (window.location.hash !== "#/") window.location.hash = "#/";
  }, []);

  const openTask = useCallback((id: string): void => {
    setTaskId(id);
    setPendingSessionId(null);
    setBundle(null);
    setDocument(null);
    setAnswers([]);
    setSelection(null);
    setDock(null);
    // A composer aimed at one project must not follow the reader into another.
    setAssistant({ intent: "auto", sectionId: null, text: "", token: 0 });
    lastBundle.current = "";
    lastReportId.current = "";
    window.localStorage.setItem("researchpage.task", id);
  }, []);

  const startTopic = useCallback(
    async (topic: string): Promise<void> => {
      setWorking(true);
      try {
        const started = await api.startTask(topic);
        setPendingSessionId(started.sessionId);
        setTaskId(null);
        setBundle(null);
        setDocument(null);
        setSelection(null);
        setDock(null);
        lastBundle.current = "";
        say("info", "正在建立任务卡：助手先确定比较对象与研究维度。");
      } catch (error) {
        say("error", error instanceof Error ? error.message : "提交主题失败");
      } finally {
        setWorking(false);
      }
    },
    [say],
  );

  const prefillAssistant = useCallback(
    (next: { readonly intent: AssistantIntent; readonly sectionId: string | null; readonly text?: string }): void => {
      setAssistant((current) => ({
        intent: next.intent,
        sectionId: next.sectionId,
        text: next.text ?? current.text,
        token: current.token + 1,
      }));
      setDock({ kind: "assistant" });
    },
    [],
  );

  const updateAssistant = useCallback(
    (next: { readonly intent?: AssistantIntent; readonly sectionId?: string | null; readonly text?: string }): void => {
      setAssistant((current) => ({
        intent: next.intent ?? current.intent,
        sectionId: next.sectionId === undefined ? current.sectionId : next.sectionId,
        text: next.text ?? current.text,
        token: current.token,
      }));
    },
    [],
  );

  const setThemeId = useCallback((next: string): void => {
    setThemeIdState(next);
    window.localStorage.setItem(THEME_KEY, next);
  }, []);

  const value = useMemo<AppState>(
    () => ({
      tasks,
      bundle,
      pendingSessionId,
      runtime,
      document,
      answers,
      loading,
      notice,
      busy: working || (bundle?.busy ?? false),
      taskId,
      selection,
      dock,
      assistant,
      themeId,
      openStart,
      openTask,
      startTopic,
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
      pendingSessionId,
      runtime,
      document,
      answers,
      loading,
      notice,
      working,
      taskId,
      selection,
      dock,
      assistant,
      themeId,
      openStart,
      openTask,
      startTopic,
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

export function useApp(): AppState {
  const value = useContext(AppContext);
  if (value === null) throw new Error("useApp must be used inside AppProvider");
  return value;
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
