import { describe, expect, test } from "bun:test";
import {
  VisibilityPoller,
  type VisibilityPollerClock,
} from "../src/ui/lib/visibility-poller.ts";

class ManualClock implements VisibilityPollerClock<number> {
  #nextId = 1;
  readonly timers = new Map<number, () => void>();

  setTimeout(callback: () => void, _delayMs: number): number {
    const id = this.#nextId++;
    this.timers.set(id, callback);
    return id;
  }

  clearTimeout(handle: number): void {
    this.timers.delete(handle);
  }

  runNext(): void {
    const entry = this.timers.entries().next().value as
      | [number, () => void]
      | undefined;
    if (!entry) throw new Error("no timer scheduled");
    this.timers.delete(entry[0]);
    entry[1]();
  }
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("VisibilityPoller", () => {
  test("polls immediately and then once per interval without overlap", async () => {
    const clock = new ManualClock();
    const requests: Deferred<number>[] = [];
    const results: number[] = [];
    let activeRequests = 0;
    let maxActiveRequests = 0;
    const poller = new VisibilityPoller<number, number>({
      intervalMs: 1_000,
      clock,
      poll: () => {
        activeRequests++;
        maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
        const request = deferred<number>();
        requests.push(request);
        return request.promise.finally(() => activeRequests--);
      },
      onResult: (value) => results.push(value),
    });

    poller.setActive(true);
    poller.pollNow();
    poller.pollNow();
    expect(requests).toHaveLength(1);
    expect(clock.timers.size).toBe(0);

    requests[0]!.resolve(1);
    await flushMicrotasks();
    // pollNow calls made during the first request coalesce into one immediate run.
    expect(requests).toHaveLength(2);
    expect(results).toEqual([1]);
    expect(maxActiveRequests).toBe(1);

    requests[1]!.resolve(2);
    await flushMicrotasks();
    expect(results).toEqual([1, 2]);
    expect(clock.timers.size).toBe(1);

    clock.runNext();
    expect(requests).toHaveLength(3);
    expect(maxActiveRequests).toBe(1);
    poller.dispose();
    expect(clock.timers.size).toBe(0);
  });

  test("aborts when hidden and ignores a stale completion before resuming", async () => {
    const clock = new ManualClock();
    const requests: Array<Deferred<string> & { signal: AbortSignal }> = [];
    const results: string[] = [];
    const errors: string[] = [];
    const poller = new VisibilityPoller<string, number>({
      intervalMs: 1_000,
      clock,
      poll: (signal) => {
        const request = deferred<string>();
        requests.push({ ...request, signal });
        // Deliberately ignore abort to prove generation-based stale suppression.
        return request.promise;
      },
      onResult: (value) => results.push(value),
      onError: (error) => errors.push(String(error)),
    });

    poller.setActive(true);
    expect(requests).toHaveLength(1);
    poller.setActive(false);
    expect(requests[0]!.signal.aborted).toBe(true);
    expect(clock.timers.size).toBe(0);

    poller.setActive(true);
    // The stale request still occupies the sole flight until it settles.
    expect(requests).toHaveLength(1);
    requests[0]!.resolve("stale");
    await flushMicrotasks();
    expect(results).toEqual([]);
    expect(requests).toHaveLength(2);

    requests[1]!.resolve("fresh");
    await flushMicrotasks();
    expect(results).toEqual(["fresh"]);
    expect(errors).toEqual([]);

    poller.dispose();
  });

  test("invalidate discards the current result and pollNow replaces it", async () => {
    const clock = new ManualClock();
    const requests: Array<Deferred<string> & { signal: AbortSignal }> = [];
    const results: string[] = [];
    const poller = new VisibilityPoller<string, number>({
      intervalMs: 1_000,
      clock,
      poll: (signal) => {
        const request = deferred<string>();
        requests.push({ ...request, signal });
        return request.promise;
      },
      onResult: (value) => results.push(value),
    });

    poller.setActive(true);
    poller.invalidate();
    poller.pollNow();
    expect(requests[0]!.signal.aborted).toBe(true);
    requests[0]!.resolve("before mutation");
    await flushMicrotasks();
    expect(results).toEqual([]);
    expect(requests).toHaveLength(2);

    requests[1]!.resolve("after mutation");
    await flushMicrotasks();
    expect(results).toEqual(["after mutation"]);
    poller.dispose();
  });
});
