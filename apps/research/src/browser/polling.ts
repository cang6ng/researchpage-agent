/**
 * The page's read scheduler.
 *
 * Several things about the open project are read on a clock: its own bundle, its
 * library, the conversion jobs the user started. What this file exists for is
 * the part that is easy to get wrong — that a read started against the project
 * the reader has just left can never write state for the one they are on now,
 * that one resource has at most one read in flight, and that a refresh asked
 * for while a read is running is not a no-op but a re-read as soon as that read
 * finishes.
 *
 * It is deliberately not an event system: there is no queue, no priority and no
 * dependency graph. A resource is a key, a function, a period, and a rule for
 * what to do with the answer. Every entry is replaced when the scope changes,
 * which is what retires the reads that belonged to the old one.
 */

/** How often a healthy resource is read. */
export const DEFAULT_PERIOD_MS = 2_000;

/** How long one read is given before it is abandoned as unreachable. */
export const READ_TIMEOUT_MS = 15_000;

/**
 * What a failing resource waits before its next try.
 *
 * The ladder is short on purpose: a page that is briefly unreachable should come
 * back on its own, and one that is really down should stop hammering. A timeout
 * here is a statement about the *connection*, never about the work: a job that
 * takes a minute to convert is not failed because a read of it timed out.
 */
export const BACKOFF_MS: readonly number[] = [2_000, 5_000, 10_000];

export interface PollEntry<T> {
  readonly key: string;
  readonly read: (signal: AbortSignal) => Promise<T>;
  readonly apply: (value: T) => void;
  /** Called instead of `apply` when the read failed. */
  readonly fail?: (error: unknown) => void;
  readonly periodMs?: number;
  /** `false` keeps the resource off the clock; it is then read only on request. */
  readonly polled?: boolean;
}

interface Entry {
  readonly spec: PollEntry<unknown>;
  token: number;
  controller: AbortController | null;
  inFlight: boolean;
  dirty: boolean;
  /**
   * Whether the read in flight has already been overtaken.
   *
   * A mutation that lands mid-read makes the answer already coming back older
   * than what the page is about to be told, so it is dropped rather than
   * applied and immediately overwritten: a snapshot that rolls state backwards
   * for one frame is a page that flickers between two truths.
   */
  superseded: boolean;
  failures: number;
  timer: ReturnType<typeof setTimeout> | null;
  waiting: (() => void)[];
}

export class ResourcePoller {
  private readonly entries = new Map<string, Entry>();
  private visible = true;
  private disposed = false;

  /**
   * Registers a resource, replacing any resource of the same key.
   *
   * Replacing is the mechanism the scope change uses: the entry that belonged
   * to the old project is retired, its request is aborted, and its answer — if
   * it arrives anyway — finds that it is no longer the entry the key holds.
   */
  add<T>(spec: PollEntry<T>): void {
    this.remove(spec.key);
    this.entries.set(spec.key, {
      spec: spec as PollEntry<unknown>,
      token: 0,
      controller: null,
      inFlight: false,
      dirty: false,
      superseded: false,
      failures: 0,
      timer: null,
      waiting: [],
    });
  }

  remove(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.entries.delete(key);
    this.abandon(entry);
  }

  /** Starts a resource's clock. Registering one does not read it by itself. */
  start(key?: string): void {
    if (key !== undefined) {
      const entry = this.entries.get(key);
      if (entry !== undefined && this.visible) void this.run(entry);
      return;
    }
    for (const entry of this.entries.values()) {
      if (this.visible) void this.run(entry);
    }
  }

  /** Retires every resource: what a scope change and an unmount both do. */
  clear(): void {
    for (const key of [...this.entries.keys()]) this.remove(key);
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }

  /**
   * Whether the page is being looked at.
   *
   * A hidden page stops reading — there is nobody to show the answer to — and
   * coming back reads immediately rather than waiting out the rest of a period.
   */
  setVisible(next: boolean): void {
    if (this.visible === next) return;
    this.visible = next;
    if (!next) {
      // The timer that is already scheduled is part of the clock being stopped,
      // not an exception to it: a hidden page must not keep reading.
      for (const entry of this.entries.values()) this.stopClock(entry);
      return;
    }
    for (const entry of this.entries.values()) void this.run(entry);
  }

  /**
   * Reads one resource now; the caller can wait for the answer to be applied.
   *
   * A refresh that arrives while the same key is already being read is not
   * dropped: the entry is marked dirty, the read is repeated the moment the
   * current one finishes, and the caller's promise settles with *that* read.
   * Returning early here would mean a mutation that landed right after a poll
   * started stayed invisible until the next tick.
   */
  async refresh(key?: string): Promise<void> {
    const targets = key === undefined ? [...this.entries.values()] : [this.entries.get(key)].filter((entry) => entry !== undefined);
    await Promise.all(targets.map((entry) => this.read(entry as Entry)));
  }

  /** The keys currently registered, for a page that needs to reason about them. */
  keys(): readonly string[] {
    return [...this.entries.keys()];
  }

  private read(entry: Entry): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (entry.inFlight) {
      entry.dirty = true;
      entry.superseded = true;
      return new Promise<void>((resolve) => entry.waiting.push(resolve));
    }
    return this.run(entry);
  }

  private async run(entry: Entry): Promise<void> {
    const token = (entry.token += 1);
    entry.dirty = false;
    entry.superseded = false;
    entry.inFlight = true;
    const controller = new AbortController();
    entry.controller = controller;
    const timeout = setTimeout(() => {
      // The read is abandoned; the resource itself is untouched. A list that
      // did not arrive is not a list that is empty.
      controller.abort();
    }, READ_TIMEOUT_MS);
    let ok = false;
    try {
      const value = await entry.spec.read(controller.signal);
      if (this.current(entry, token)) {
        entry.spec.apply(value);
        ok = true;
      }
    } catch (error) {
      if (this.current(entry, token)) entry.spec.fail?.(error);
    } finally {
      clearTimeout(timeout);
      if (entry.token === token) {
        entry.controller = null;
        entry.inFlight = false;
        entry.failures = ok ? 0 : entry.failures + 1;
        if (!this.disposed && (this.visible || entry.dirty)) {
          entry.timer = setTimeout(
            () => {
              entry.timer = null;
              void this.run(entry);
            },
            entry.dirty ? 0 : this.periodOf(entry),
          );
        }
        if (!entry.dirty) this.settle(entry);
      }
    }
  }

  /** Whether this answer still belongs to the resource the key names today. */
  private current(entry: Entry, token: number): boolean {
    if (this.disposed) return false;
    if (this.entries.get(entry.spec.key) !== entry) return false;
    if (entry.token !== token) return false;
    return !entry.superseded;
  }

  /** Takes an entry off its clock without ending it. */
  private stopClock(entry: Entry): void {
    if (entry.timer === null) return;
    clearTimeout(entry.timer);
    entry.timer = null;
  }

  private periodOf(entry: Entry): number {
    if (entry.failures === 0) return entry.spec.periodMs ?? DEFAULT_PERIOD_MS;
    const step = BACKOFF_MS[Math.min(entry.failures - 1, BACKOFF_MS.length - 1)];
    return step ?? DEFAULT_PERIOD_MS;
  }

  private settle(entry: Entry): void {
    const waiting = entry.waiting;
    entry.waiting = [];
    for (const resolve of waiting) resolve();
  }

  /** Stops an entry completely: no timer, no request, and no waiting callers. */
  private abandon(entry: Entry): void {
    entry.token += 1;
    this.stopClock(entry);
    entry.controller?.abort();
    entry.controller = null;
    entry.inFlight = false;
    this.settle(entry);
  }
}
