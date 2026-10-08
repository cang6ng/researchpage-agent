/**
 * The read scheduler, tested against the failures it exists to prevent.
 *
 * Every case here is a race that really happens in a browser: a request that
 * belongs to the project the reader has left, a poll that starts while the
 * previous one is still in flight, a refresh asked for in the middle of a read,
 * a page that comes back from a hidden tab. They are driven with deferred
 * promises and fake timers rather than by sleeping, because a test that waits
 * for a race is a test that passes when the race does not happen.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ResourcePoller } from "../src/browser/polling.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
  readonly signal: AbortSignal | null;
}

/** A read the test decides when to finish. */
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject, signal: null };
}

describe("the read scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads one resource once per period, not on two overlapping clocks", async () => {
    const poller = new ResourcePoller();
    let reads = 0;
    poller.add<number>({
      key: "a",
      periodMs: 2_000,
      read: async () => {
        reads += 1;
        return reads;
      },
      apply: () => undefined,
    });
    poller.start("a");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reads).toBe(2);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(reads).toBe(4);
    poller.dispose();
  });

  it("never lets a retired resource write state for the one that replaced it", async () => {
    // The scope change, which is the whole reason this class exists: a read
    // started for project A must not be able to set the page's state once B is
    // open.
    const poller = new ResourcePoller();
    const applied: string[] = [];
    const first = deferred<string>();
    poller.add<string>({ key: "task", read: () => first.promise, apply: (value) => applied.push(value) });
    poller.start("task");
    await vi.advanceTimersByTimeAsync(0);

    const second = deferred<string>();
    poller.add<string>({ key: "task", read: () => second.promise, apply: (value) => applied.push(value) });
    poller.start("task");
    first.resolve("A");
    await vi.advanceTimersByTimeAsync(0);
    second.resolve("B");
    await vi.advanceTimersByTimeAsync(0);

    expect(applied).toEqual(["B"]);
    poller.dispose();
  });

  it("drops an answer that arrives after the entry is gone", async () => {
    const poller = new ResourcePoller();
    const applied: string[] = [];
    const read = deferred<string>();
    poller.add<string>({ key: "intent", read: () => read.promise, apply: (value) => applied.push(value) });
    poller.start("intent");
    await vi.advanceTimersByTimeAsync(0);
    poller.remove("intent");
    read.resolve("late");
    await vi.advanceTimersByTimeAsync(0);
    expect(applied).toEqual([]);
    poller.dispose();
  });

  it("re-reads a resource whose refresh arrived while it was being read", async () => {
    // A mutation that lands right after a poll started would otherwise stay
    // invisible until the next tick — and the caller that asked for the refresh
    // would be told it was done.
    const poller = new ResourcePoller();
    const applied: string[] = [];
    const reads: Deferred<string>[] = [];
    poller.add<string>({
      key: "library",
      read: () => {
        const next = deferred<string>();
        reads.push(next);
        return next.promise;
      },
      apply: (value) => applied.push(value),
    });
    poller.start("library");
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toHaveLength(1);

    const refreshed = poller.refresh("library");
    reads[0]?.resolve("stale");
    await vi.advanceTimersByTimeAsync(0);
    // The wait is not over: the dirty flag started a second read.
    expect(applied).toEqual([]);
    expect(reads).toHaveLength(2);
    reads[1]?.resolve("fresh");
    await refreshed;
    expect(applied).toEqual(["fresh"]);
    poller.dispose();
  });

  it("backs off while reads fail and comes back to the period when one succeeds", async () => {
    const poller = new ResourcePoller();
    let reads = 0;
    let fail = true;
    poller.add<number>({
      key: "job",
      periodMs: 2_000,
      read: async () => {
        reads += 1;
        if (fail) throw new Error("offline");
        return reads;
      },
      apply: () => undefined,
      fail: () => undefined,
    });
    poller.start("job");
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reads).toBe(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reads).toBe(3);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reads).toBe(4);
    // A successful read puts it back on its own period.
    fail = false;
    await vi.advanceTimersByTimeAsync(10_000);
    const settled = reads;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reads).toBe(settled + 1);
    poller.dispose();
  });

  it("reports a failure instead of an empty value, and keeps the last one", async () => {
    const poller = new ResourcePoller();
    const applied: string[] = [];
    const failures: unknown[] = [];
    let fail = false;
    poller.add<string>({
      key: "report",
      read: async () => {
        if (fail) throw new Error("the connection dropped");
        return "a report";
      },
      apply: (value) => applied.push(value),
      fail: (error) => failures.push(error),
    });
    poller.start("report");
    await vi.advanceTimersByTimeAsync(0);
    fail = true;
    await poller.refresh("report");
    expect(applied).toEqual(["a report"]);
    expect(failures).toHaveLength(1);
    poller.dispose();
  });

  it("stops reading a hidden page and reads immediately when it is shown again", async () => {
    const poller = new ResourcePoller();
    let reads = 0;
    poller.add<number>({
      key: "tasks",
      periodMs: 2_000,
      read: async () => {
        reads += 1;
        return reads;
      },
      apply: () => undefined,
    });
    poller.start("tasks");
    await vi.advanceTimersByTimeAsync(2_000);
    const before = reads;
    poller.setVisible(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reads).toBe(before);
    poller.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toBe(before + 1);
    poller.dispose();
  });

  it("settles a caller whose resource was retired, rather than hanging", async () => {
    const poller = new ResourcePoller();
    const read = deferred<string>();
    poller.add<string>({ key: "intent", read: () => read.promise, apply: () => undefined });
    poller.start("intent");
    await vi.advanceTimersByTimeAsync(0);
    const waiting = poller.refresh("intent");
    poller.clear();
    await waiting;
    poller.dispose();
    expect(poller.keys()).toEqual([]);
  });
});
