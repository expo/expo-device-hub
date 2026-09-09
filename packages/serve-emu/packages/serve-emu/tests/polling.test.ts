import { describe, expect, test } from "bun:test";
import {
  bindPollVisibility,
  createPollController,
  shouldApplyPollResult,
  type PollScheduler,
  type VisibilitySource,
} from "../src/ui/lib/polling.ts";
import { createDeviceSessionStore } from "../src/ui/lib/device-session-store.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

class FakeScheduler {
  now = 0;
  nextId = 1;
  tasks = new Map<number, { at: number; callback: () => void }>();

  readonly scheduler: PollScheduler = {
    setTimeout: (callback, delayMs) => {
      const id = this.nextId++;
      this.tasks.set(id, { at: this.now + delayMs, callback });
      return id;
    },
    clearTimeout: (handle) => {
      this.tasks.delete(handle as number);
    },
  };

  advance(delayMs: number) {
    const target = this.now + delayMs;
    while (true) {
      const next = Array.from(this.tasks.entries())
        .filter(([, task]) => task.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!next) break;
      const [id, task] = next;
      this.tasks.delete(id);
      this.now = task.at;
      task.callback();
    }
    this.now = target;
  }
}

class FakeVisibilitySource implements VisibilitySource {
  hidden = false;
  listeners = new Set<() => void>();

  addEventListener(_type: "visibilitychange", listener: () => void) {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "visibilitychange", listener: () => void) {
    this.listeners.delete(listener);
  }

  setHidden(hidden: boolean) {
    this.hidden = hidden;
    for (const listener of this.listeners) listener();
  }
}

describe("createPollController", () => {
  test("rejects a result as soon as render desires a new key or disables polling", () => {
    expect(shouldApplyPollResult(true, 2, 1)).toBe(false);
    expect(shouldApplyPollResult(false, 1, 1)).toBe(false);
    expect(shouldApplyPollResult(true, 1, 1)).toBe(true);
  });

  test("uses completion-based fake timers and never overlaps polls", async () => {
    const clock = new FakeScheduler();
    const runs = [deferred<number>(), deferred<number>()];
    let calls = 0;
    const results: number[] = [];
    const controller = createPollController({
      intervalMs: 1_000,
      scheduler: clock.scheduler,
      task: () => runs[calls++].promise,
      onResult: (result) => results.push(result),
    });

    controller.start("session-1");
    expect(calls).toBe(1);
    clock.advance(30_000);
    expect(calls).toBe(1);
    expect(clock.tasks.size).toBe(0);

    runs[0].resolve(1);
    await flushPromises();
    expect(results).toEqual([1]);
    expect(clock.tasks.size).toBe(1);
    clock.advance(999);
    expect(calls).toBe(1);
    clock.advance(1);
    expect(calls).toBe(2);
  });

  test("unmount-style stop aborts in-flight work and suppresses its late result", async () => {
    const pending = deferred<string>();
    let signal: AbortSignal | null = null;
    const results: string[] = [];
    const controller = createPollController({
      intervalMs: 100,
      task: (context) => {
        signal = context.signal;
        return pending.promise;
      },
      onResult: (result) => results.push(result),
    });

    controller.start("mounted");
    controller.stop();
    expect(signal?.aborted).toBe(true);
    pending.resolve("stale");
    await flushPromises();
    expect(results).toEqual([]);
    expect(controller.snapshot()).toMatchObject({ active: false, running: false, scheduled: false });
  });

  test("device-session generation changes abort and ignore the old deferred response", async () => {
    const oldRequest = deferred<string>();
    const newRequest = deferred<string>();
    const signals: AbortSignal[] = [];
    const results: Array<[string, string]> = [];
    const controller = createPollController({
      intervalMs: null,
      task: (context) => {
        signals.push(context.signal);
        return context.key.endsWith(":4") ? oldRequest.promise : newRequest.promise;
      },
      onResult: (result, context) => results.push([context.key, result]),
    });

    controller.start("emulator-5554:4");
    controller.restart("emulator-5554:5");
    expect(signals[0].aborted).toBe(true);
    expect(signals).toHaveLength(1);
    oldRequest.resolve("old device data");
    await flushPromises();
    expect(signals).toHaveLength(2);
    expect(signals[1].aborted).toBe(false);
    newRequest.resolve("new device data");
    await flushPromises();
    expect(results).toEqual([["emulator-5554:5", "new device data"]]);
  });

  test("reuses strict serialization across stop/restart effect replay", async () => {
    const oldRequest = deferred<number>();
    const newRequest = deferred<number>();
    let calls = 0;
    const signals: AbortSignal[] = [];
    const results: number[] = [];
    const controller = createPollController({
      intervalMs: null,
      task: ({ signal }) => {
        signals.push(signal);
        return calls++ === 0 ? oldRequest.promise : newRequest.promise;
      },
      onResult: (result) => results.push(result),
    });

    controller.start("first setup");
    controller.stop();
    controller.restart("strict-mode replay");
    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(true);
    oldRequest.resolve(1);
    await flushPromises();
    expect(signals).toHaveLength(2);
    newRequest.resolve(2);
    await flushPromises();
    expect(results).toEqual([2]);
  });

  test("visibility pauses timers, aborts work, and refreshes immediately on resume", async () => {
    const first = deferred<number>();
    const second = deferred<number>();
    const source = new FakeVisibilitySource();
    const signals: AbortSignal[] = [];
    let calls = 0;
    const controller = createPollController({
      intervalMs: 1_000,
      task: (context) => {
        signals.push(context.signal);
        return (calls++ === 0 ? first : second).promise;
      },
      onResult: () => {},
    });
    const unbind = bindPollVisibility(controller, source);

    controller.start("visible");
    expect(calls).toBe(1);
    source.setHidden(true);
    expect(signals[0].aborted).toBe(true);
    source.setHidden(false);
    expect(calls).toBe(1);
    first.resolve(1);
    await flushPromises();
    expect(calls).toBe(2);
    second.resolve(2);
    await flushPromises();
    source.setHidden(true);
    expect(controller.snapshot()).toMatchObject({ visible: false, scheduled: false });
    unbind();
    expect(source.listeners.size).toBe(0);
    controller.stop();
  });

  test("schedules the next attempt after a current error", async () => {
    const clock = new FakeScheduler();
    const errors: string[] = [];
    let calls = 0;
    const controller = createPollController({
      intervalMs: 250,
      scheduler: clock.scheduler,
      task: async () => {
        calls += 1;
        throw new Error("offline");
      },
      onResult: () => {},
      onError: (error) => errors.push((error as Error).message),
    });

    controller.start("errors");
    await flushPromises();
    expect(errors).toEqual(["offline"]);
    clock.advance(250);
    await flushPromises();
    expect(calls).toBe(2);
  });

  test("null interval performs a single request", async () => {
    const clock = new FakeScheduler();
    let calls = 0;
    const controller = createPollController({
      intervalMs: null,
      scheduler: clock.scheduler,
      task: async () => ++calls,
      onResult: () => {},
    });
    controller.start("once");
    await flushPromises();
    clock.advance(60_000);
    expect(calls).toBe(1);
    expect(clock.tasks.size).toBe(0);
  });

  test("accepts undefined as an explicit polling key", async () => {
    const keys: Array<undefined> = [];
    const controller = createPollController<number, undefined>({
      intervalMs: null,
      task: async (context) => {
        keys.push(context.key);
        return 1;
      },
      onResult: () => {},
    });
    controller.start(undefined);
    await flushPromises();
    expect(keys).toEqual([undefined]);
  });

  test("rejects invalid intervals", () => {
    const options = {
      task: async () => true,
      onResult: () => {},
    };
    expect(() => createPollController({ ...options, intervalMs: -1 })).toThrow();
    expect(() => createPollController({ ...options, intervalMs: Number.NaN })).toThrow();
  });
});

describe("device session store", () => {
  test("changes revision only when the serial or server generation changes", () => {
    const store = createDeviceSessionStore();
    const revisions: number[] = [];
    store.subscribe(() => revisions.push(store.getSnapshot().revision));

    expect(store.applyHealth({ serial: "emulator-5554", sessionGeneration: 3 })).toBe(true);
    expect(store.applyHealth({ serial: "emulator-5554", sessionGeneration: 3 })).toBe(true);
    expect(store.applyHealth({ serial: "emulator-5554", sessionGeneration: 4 })).toBe(true);
    expect(store.applyHealth({ serial: "device-usb", sessionGeneration: 5 })).toBe(true);

    expect(revisions).toEqual([1, 2, 3]);
    expect(store.getSnapshot()).toMatchObject({
      serial: "device-usb",
      sessionGeneration: 5,
      revision: 3,
      transitioning: false,
    });
  });

  test("a device action barrier rejects health started before the transition", () => {
    const store = createDeviceSessionStore();
    store.applyHealth({ serial: "old", sessionGeneration: 1 });
    const staleRequest = store.beginHealthRequest();
    store.beginTransition("new");

    expect(store.applyHealth({ serial: "old", sessionGeneration: 1 }, staleRequest)).toBe(false);
    expect(store.getSnapshot()).toMatchObject({ serial: "new", transitioning: true });
    const duringTransition = store.beginHealthRequest();
    expect(store.applyHealth({ serial: "old", sessionGeneration: 1 }, duringTransition)).toBe(false);

    store.endTransition();
    expect(store.applyHealth({ serial: "old", sessionGeneration: 1 }, duringTransition)).toBe(false);
    const currentRequest = store.beginHealthRequest();
    expect(store.applyHealth({ serial: "new", sessionGeneration: 2 }, currentRequest)).toBe(true);
    expect(store.getSnapshot()).toMatchObject({
      serial: "new",
      sessionGeneration: 2,
      transitioning: false,
    });
  });

  test("out-of-order health responses cannot roll the store backward", () => {
    const store = createDeviceSessionStore();
    const older = store.beginHealthRequest();
    const newer = store.beginHealthRequest();
    expect(store.applyHealth({ serial: "device", sessionGeneration: 7 }, newer)).toBe(true);
    expect(store.applyHealth({ serial: "device", sessionGeneration: 6 }, older)).toBe(false);
    expect(store.getSnapshot().sessionGeneration).toBe(7);
  });

  test("keeps polling paused until concurrent device actions both finish", () => {
    const store = createDeviceSessionStore();
    store.beginTransition("first");
    store.beginTransition("second");
    store.endTransition();
    expect(store.getSnapshot()).toMatchObject({ serial: "second", transitioning: true });
    store.endTransition();
    expect(store.getSnapshot()).toMatchObject({ serial: "second", transitioning: false });
  });
});
