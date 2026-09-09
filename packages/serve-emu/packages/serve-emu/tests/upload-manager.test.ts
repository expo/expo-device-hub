import { describe, expect, test } from "bun:test";
import {
  MAX_UPLOAD_QUEUE_TIMEOUT_MS,
  UploadManager,
  type UploadManagerClock,
  type UploadManagerErrorCode,
} from "../src/upload-manager.ts";

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Timer = {
  callback: () => void;
  dueMs: number;
  active: boolean;
};

class ManualClock implements UploadManagerClock {
  nowMs = 0;
  readonly timers: Timer[] = [];

  now(): number {
    return this.nowMs;
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const timer = {
      callback,
      dueMs: this.nowMs + delayMs,
      active: true,
    };
    this.timers.push(timer);
    return timer;
  }

  clearTimeout(value: unknown): void {
    (value as Timer).active = false;
  }

  advance(ms: number): void {
    this.nowMs += ms;
  }

  fireDue(): void {
    for (const timer of this.timers) {
      if (!timer.active || timer.dueMs > this.nowMs) continue;
      timer.active = false;
      timer.callback();
    }
  }
}

const context = (generation: number, serial = `device-${generation}`) => ({
  serial,
  generation,
});

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function rejectsWithCode(
  promise: Promise<unknown>,
  code: UploadManagerErrorCode,
): Promise<void> {
  const error = await promise.then(
    () => {
      throw new Error(`expected ${code} rejection`);
    },
    (reason) => reason,
  );
  expect(error).toMatchObject({
    name: "UploadManagerError",
    code,
  });
}

describe("UploadManager", () => {
  test("rejects queue deadlines above the platform timer range", () => {
    expect(
      () =>
        new UploadManager({
          queueTimeoutMs: MAX_UPLOAD_QUEUE_TIMEOUT_MS + 1,
        }),
    ).toThrow(`queueTimeoutMs must be at most ${MAX_UPLOAD_QUEUE_TIMEOUT_MS}`);
    expect(
      new UploadManager({
        queueTimeoutMs: MAX_UPLOAD_QUEUE_TIMEOUT_MS,
      }).snapshot().limits.queueTimeoutMs,
    ).toBe(MAX_UPLOAD_QUEUE_TIMEOUT_MS);
  });

  test("bounds active and queued work, preserves FIFO, and releases permits", async () => {
    const clock = new ManualClock();
    const manager = new UploadManager({
      maxActive: 2,
      maxQueued: 2,
      queueTimeoutMs: 1_000,
      clock,
    });
    const gates = [
      deferred<string>(),
      deferred<string>(),
      deferred<string>(),
      deferred<string>(),
    ];
    const started: number[] = [];
    const runs = gates.map((gate, index) =>
      manager.run({ context: context(index) }, () => {
        started.push(index);
        return gate.promise;
      }),
    );
    const overflow = manager.run({ context: context(99) }, () => "never");
    const overflowRejected = rejectsWithCode(overflow, "queue-full");
    await flush();

    expect(started).toEqual([0, 1]);
    clock.advance(100);
    expect(manager.snapshot()).toEqual({
      closed: false,
      active: 2,
      queued: 2,
      oldestQueuedAgeMs: 100,
      limits: { active: 2, queued: 2, queueTimeoutMs: 1_000 },
      totals: {
        accepted: 4,
        started: 2,
        completed: 0,
        failed: 0,
        cancelled: 0,
        rejected: 1,
        timedOut: 0,
      },
    });
    await overflowRejected;

    gates[0]!.resolve("zero");
    expect(await runs[0]).toBe("zero");
    await flush();
    expect(started).toEqual([0, 1, 2]);
    expect(manager.snapshot()).toMatchObject({ active: 2, queued: 1 });

    gates[1]!.resolve("one");
    expect(await runs[1]).toBe("one");
    await flush();
    expect(started).toEqual([0, 1, 2, 3]);

    gates[2]!.resolve("two");
    gates[3]!.resolve("three");
    expect(await Promise.all([runs[2], runs[3]])).toEqual(["two", "three"]);
    expect(manager.snapshot()).toMatchObject({
      active: 0,
      queued: 0,
      oldestQueuedAgeMs: null,
      totals: {
        accepted: 4,
        started: 4,
        completed: 4,
        failed: 0,
        cancelled: 0,
        rejected: 1,
        timedOut: 0,
      },
    });
  });

  test("times out queued work and ignores a stale deadline after activation", async () => {
    const clock = new ManualClock();
    const manager = new UploadManager({
      maxActive: 1,
      maxQueued: 1,
      queueTimeoutMs: 1_000,
      clock,
    });
    const firstGate = deferred<string>();
    const secondGate = deferred<string>();
    const first = manager.run({ context: context(1) }, () => firstGate.promise);
    const second = manager.run(
      { context: context(2) },
      () => secondGate.promise,
    );
    const staleTimer = clock.timers[0]!;

    firstGate.resolve("first");
    expect(await first).toBe("first");
    await flush();
    staleTimer.callback();
    secondGate.resolve("second");
    expect(await second).toBe("second");

    const activeGate = deferred<string>();
    const active = manager.run(
      { context: context(3) },
      () => activeGate.promise,
    );
    let timedOutStarted = false;
    const timedOut = manager.run({ context: context(4) }, () => {
      timedOutStarted = true;
      return "never";
    });
    const timedOutRejected = rejectsWithCode(timedOut, "queue-timeout");
    clock.advance(1_000);
    clock.fireDue();

    await timedOutRejected;
    expect(timedOutStarted).toBe(false);
    expect(manager.snapshot()).toMatchObject({
      active: 1,
      queued: 0,
      totals: { completed: 2, timedOut: 1 },
    });
    activeGate.resolve("active");
    expect(await active).toBe("active");
  });

  test("handles synchronous deadlines and abort-timeout races exactly once", async () => {
    const immediateClock: UploadManagerClock = {
      now: () => 0,
      setTimeout(callback) {
        callback();
        return { synchronous: true };
      },
      clearTimeout() {},
    };
    const immediateManager = new UploadManager({
      maxActive: 1,
      maxQueued: 1,
      queueTimeoutMs: 0,
      clock: immediateClock,
    });
    const blocker = deferred<void>();
    const active = immediateManager.run(
      { context: context(1) },
      () => blocker.promise,
    );
    let invoked = false;
    const synchronousTimeout = immediateManager.run(
      { context: context(2) },
      () => {
        invoked = true;
      },
    );
    await rejectsWithCode(synchronousTimeout, "queue-timeout");
    expect(invoked).toBe(false);
    expect(immediateManager.snapshot()).toMatchObject({
      active: 1,
      queued: 0,
      totals: { timedOut: 1 },
    });
    blocker.resolve();
    await active;

    const clock = new ManualClock();
    const manager = new UploadManager({
      maxActive: 1,
      maxQueued: 2,
      queueTimeoutMs: 100,
      clock,
    });
    const activeGate = deferred<void>();
    const blocking = manager.run(
      { context: context(3) },
      () => activeGate.promise,
    );
    const requestFirst = new AbortController();
    const cancelled = manager.run(
      { context: context(4), requestSignal: requestFirst.signal },
      () => "never",
    );
    const cancelledResult = rejectsWithCode(cancelled, "upload-cancelled");
    requestFirst.abort();
    clock.advance(100);
    clock.fireDue();
    await cancelledResult;

    const timeoutFirst = new AbortController();
    const timedOut = manager.run(
      { context: context(5), requestSignal: timeoutFirst.signal },
      () => "never",
    );
    const timedOutResult = rejectsWithCode(timedOut, "queue-timeout");
    clock.advance(100);
    clock.fireDue();
    timeoutFirst.abort();
    await timedOutResult;
    expect(manager.snapshot()).toMatchObject({
      active: 1,
      queued: 0,
      totals: { cancelled: 1, timedOut: 1 },
    });
    activeGate.resolve();
    await blocking;
  });

  test("combines request and session aborts and holds the slot through cleanup", async () => {
    const manager = new UploadManager({ maxActive: 1, maxQueued: 2 });
    const request = new AbortController();
    const activeCleanup = deferred<void>();
    let activeSignal: AbortSignal | null = null;
    const active = manager.run(
      { context: context(1), requestSignal: request.signal },
      ({ signal }) => {
        activeSignal = signal;
        return new Promise<string>((resolve) => {
          signal.addEventListener(
            "abort",
            () => void activeCleanup.promise.then(() => resolve("ignored")),
            { once: true },
          );
        });
      },
    );
    const activeRejected = rejectsWithCode(active, "upload-cancelled");
    await flush();

    request.abort(new Error("client disconnected"));
    expect((activeSignal!.reason as { code: string }).code).toBe(
      "upload-cancelled",
    );
    expect(manager.snapshot().active).toBe(1);
    let settled = false;
    void active.finally(() => {
      settled = true;
    }).catch(() => {});
    await flush();
    expect(settled).toBe(false);

    activeCleanup.resolve();
    await activeRejected;
    expect(manager.snapshot().active).toBe(0);

    const blocker = deferred<void>();
    const blocking = manager.run({ context: context(2) }, () => blocker.promise);
    const queuedRequest = new AbortController();
    let queuedStarted = false;
    const queued = manager.run(
      { context: context(3), requestSignal: queuedRequest.signal },
      () => {
        queuedStarted = true;
      },
    );
    const queuedRejected = rejectsWithCode(queued, "upload-cancelled");
    queuedRequest.abort();
    await queuedRejected;
    expect(queuedStarted).toBe(false);

    const session = new AbortController();
    const sessionQueued = manager.run(
      { context: context(4), sessionSignal: session.signal },
      () => "never",
    );
    const sessionRejected = rejectsWithCode(
      sessionQueued,
      "device-session-changed",
    );
    session.abort();
    await sessionRejected;
    blocker.resolve();
    await blocking;
  });

  test("cancelGeneration rejects queued work and waits for active cleanup", async () => {
    const manager = new UploadManager({ maxActive: 1, maxQueued: 3 });
    const cleanup = deferred<void>();
    let observedSignal: AbortSignal | null = null;
    const active = manager.run({ context: context(7, "old") }, ({ signal }) => {
      observedSignal = signal;
      return new Promise<string>((resolve) => {
        signal.addEventListener(
          "abort",
          () => void cleanup.promise.then(() => resolve("ignored")),
          { once: true },
        );
      });
    });
    const activeRejected = rejectsWithCode(active, "device-session-changed");
    const oldQueued = manager.run(
      { context: context(7, "old") },
      () => "old queued",
    );
    const oldQueuedRejected = rejectsWithCode(
      oldQueued,
      "device-session-changed",
    );
    let nextStarted = false;
    const next = manager.run({ context: context(8, "new") }, () => {
      nextStarted = true;
      return "new";
    });
    await flush();

    let cancellationFinished = false;
    const cancellation = manager.cancelGeneration(7).then(() => {
      cancellationFinished = true;
    });
    expect((observedSignal!.reason as { code: string }).code).toBe(
      "device-session-changed",
    );
    await oldQueuedRejected;
    await flush();
    expect(cancellationFinished).toBe(false);
    expect(nextStarted).toBe(false);
    expect(manager.snapshot()).toMatchObject({ active: 1, queued: 1 });

    cleanup.resolve();
    await activeRejected;
    await cancellation;
    expect(await next).toBe("new");
    expect(nextStarted).toBe(true);

    const stale = manager.run({ context: context(7, "old") }, () => "never");
    await rejectsWithCode(stale, "device-session-changed");
    expect(manager.snapshot()).toMatchObject({
      active: 0,
      queued: 0,
      totals: {
        accepted: 3,
        started: 2,
        completed: 1,
        failed: 0,
        cancelled: 2,
        rejected: 1,
        timedOut: 0,
      },
    });
  });

  test("close is reentrant, idempotent, and awaits every active cleanup", async () => {
    const manager = new UploadManager({ maxActive: 1, maxQueued: 1 });
    const cleanup = deferred<void>();
    let nestedClose: Promise<void> | null = null;
    const active = manager.run({ context: context(1) }, ({ signal }) =>
      new Promise<string>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            nestedClose = manager.close();
            void cleanup.promise.then(() => resolve("ignored"));
          },
          { once: true },
        );
      }),
    );
    const activeRejected = rejectsWithCode(active, "closed");
    const queued = manager.run({ context: context(2) }, () => "never");
    const queuedRejected = rejectsWithCode(queued, "closed");
    await flush();

    const firstClose = manager.close(new Error("server stopping"));
    const secondClose = manager.close();
    expect(secondClose).toBe(firstClose);
    expect(nestedClose).toBe(firstClose);
    await queuedRejected;
    expect(manager.snapshot()).toMatchObject({
      closed: true,
      active: 1,
      queued: 0,
    });

    const afterClose = manager.run({ context: context(3) }, () => "never");
    await rejectsWithCode(afterClose, "closed");
    let closeFinished = false;
    void firstClose.then(() => {
      closeFinished = true;
    });
    await flush();
    expect(closeFinished).toBe(false);

    cleanup.resolve();
    await activeRejected;
    await firstClose;
    expect(manager.snapshot()).toMatchObject({
      closed: true,
      active: 0,
      queued: 0,
      totals: {
        accepted: 2,
        started: 1,
        completed: 0,
        failed: 0,
        cancelled: 2,
        rejected: 1,
        timedOut: 0,
      },
    });
  });

  test("releases permits after synchronous and undefined rejections", async () => {
    const manager = new UploadManager({ maxActive: 1, maxQueued: 1 });
    const syncFailure = manager.run({ context: context(1) }, () => {
      throw new Error("sync failure");
    });
    const syncRejected = expect(syncFailure).rejects.toThrow("sync failure");
    const next = manager.run({ context: context(2) }, () => "next");
    await syncRejected;
    expect(await next).toBe("next");

    const undefinedFailure = manager.run(
      { context: context(3) },
      () => Promise.reject(undefined),
    );
    await expect(undefinedFailure).rejects.toBeUndefined();
    expect(manager.snapshot()).toMatchObject({
      active: 0,
      queued: 0,
      totals: { completed: 1, failed: 2 },
    });
  });

  test("cancellation wins a completion race and releases exactly one permit", async () => {
    const manager = new UploadManager({ maxActive: 1, maxQueued: 1 });
    const gate = deferred<string>();
    const racing = manager.run({ context: context(9) }, () => gate.promise);
    const racingRejected = rejectsWithCode(
      racing,
      "device-session-changed",
    );
    await flush();

    gate.resolve("too late");
    const cancelling = manager.cancelGeneration(9);
    await racingRejected;
    await cancelling;

    expect(manager.snapshot()).toMatchObject({
      active: 0,
      queued: 0,
      totals: {
        accepted: 1,
        started: 1,
        completed: 0,
        failed: 0,
        cancelled: 1,
        rejected: 0,
        timedOut: 0,
      },
    });
  });

  test.each(["upload-cleanup-failed", "adb-cleanup-failed"])(
    "surfaces %s errors that happen after cancellation",
    async (cleanupCode) => {
      const manager = new UploadManager({ maxActive: 1, maxQueued: 1 });
      const request = new AbortController();
      const cleanupFailure = Object.assign(
        new Error("failed to remove staging directory"),
        { code: cleanupCode },
      );
      let operationStarted = false;
      const run = manager.run(
        { context: context(10), requestSignal: request.signal },
        ({ signal }) =>
          new Promise<never>((_resolve, reject) => {
            operationStarted = true;
            signal.addEventListener(
              "abort",
              () => reject(cleanupFailure),
              { once: true },
            );
          }),
      );
      await flush();
      expect(operationStarted).toBe(true);

      request.abort(new Error("client disconnected"));
      const observed = await run.then(
        () => new Error("expected cleanup failure"),
        (error) => error,
      );

      expect(observed).toBe(cleanupFailure);
      expect(manager.snapshot()).toMatchObject({
        active: 0,
        queued: 0,
        totals: { failed: 1, cancelled: 0 },
      });
    },
  );

  test("rejects pre-aborted and closed contexts without invoking work", async () => {
    const manager = new UploadManager();
    const request = new AbortController();
    const session = new AbortController();
    request.abort(new Error("request gone"));
    session.abort(new Error("session gone"));
    let invoked = false;
    const preAborted = manager.run(
      {
        context: context(5),
        requestSignal: request.signal,
        sessionSignal: session.signal,
      },
      () => {
        invoked = true;
      },
    );
    await rejectsWithCode(preAborted, "device-session-changed");
    expect(invoked).toBe(false);
    expect(manager.snapshot()).toMatchObject({
      active: 0,
      queued: 0,
      totals: { accepted: 0, rejected: 1 },
    });
  });
});
