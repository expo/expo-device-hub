import { describe, expect, test } from "bun:test";
import type { AccessibilitySnapshot } from "../src/accessibility.ts";
import {
  ActiveDeviceSession,
  DeviceSessionManager,
  SessionChangedError,
  type DisposeDeviceSessionOpts,
  type ManagedDeviceSession,
} from "../src/device-session-context.ts";
import { ControlInputQueue } from "../src/control-input-queue.ts";
import type { EmuSession } from "../src/stream-session.ts";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function snapshot(capturedAt: string): AccessibilitySnapshot {
  return { ok: true, capturedAt, nodes: [] };
}

function fakeStream(serial: string, onClose: () => void = () => {}): EmuSession {
  const controls = new ControlInputQueue({
    writer: {
      async write() {},
    },
  });
  return {
    mode: "scrcpy",
    serial,
    meta: {
      deviceName: serial,
      codecId: "h264",
      width: 1080,
      height: 1920,
    },
    controls,
    async readFrame() {
      return null;
    },
    onFatal() {
      return () => {};
    },
    async close() {
      controls.close();
      onClose();
    },
  };
}

function activeSession(
  serial: string,
  generation: number,
  onClose: () => void = () => {},
): ActiveDeviceSession {
  return new ActiveDeviceSession({
    serial,
    generation,
    stream: fakeStream(serial, onClose),
    applyLocation: async () => {},
  });
}

type TestManagedSession = ManagedDeviceSession & {
  disposeCalls: Array<{ reason: string; opts?: DisposeDeviceSessionOpts }>;
};

function managedSession(
  serial: string,
  generation: number,
  disposeGate?: Deferred<void>,
): TestManagedSession {
  const controller = new AbortController();
  const disposeCalls: TestManagedSession["disposeCalls"] = [];
  let disposeTask: Promise<void> | null = null;

  return {
    serial,
    generation,
    signal: controller.signal,
    disposeCalls,
    dispose(reason, opts) {
      disposeCalls.push({ reason, opts });
      if (disposeTask) return disposeTask;
      controller.abort();
      disposeTask = disposeGate?.promise ?? Promise.resolve();
      return disposeTask;
    },
  };
}

describe("ActiveDeviceSession accessibility ownership", () => {
  test("a stale generation cannot cache over the active generation", async () => {
    const staleLoad = deferred<AccessibilitySnapshot>();
    const activeLoad = deferred<AccessibilitySnapshot>();
    const stale = activeSession("device-a", 1);
    const active = activeSession("device-b", 2);
    const loadCalls: Array<{ serial: string; signal: AbortSignal }> = [];

    const staleRequest = stale.readAccessibilitySnapshot((serial, signal) => {
      loadCalls.push({ serial, signal });
      return staleLoad.promise;
    });
    const activeRequest = active.readAccessibilitySnapshot((serial, signal) => {
      loadCalls.push({ serial, signal });
      return activeLoad.promise;
    });

    const staleDispose = stale.dispose("device switched");
    expect(loadCalls.map(({ serial }) => serial)).toEqual(["device-a", "device-b"]);
    expect(loadCalls[0]?.signal.aborted).toBe(true);
    expect(loadCalls[1]?.signal.aborted).toBe(false);

    const activeSnapshot = snapshot("active");
    activeLoad.resolve(activeSnapshot);
    await expect(activeRequest).resolves.toBe(activeSnapshot);

    staleLoad.resolve(snapshot("stale"));
    await expect(staleRequest).rejects.toBeInstanceOf(SessionChangedError);
    await staleDispose;
    expect(stale.accessibilitySnapshotInFlight).toBe(false);

    let unexpectedReloads = 0;
    await expect(
      active.readAccessibilitySnapshot(async () => {
        unexpectedReloads += 1;
        return snapshot("unexpected");
      }),
    ).resolves.toBe(activeSnapshot);
    expect(unexpectedReloads).toBe(0);

    await active.dispose("test complete");
  });
});

describe("ActiveDeviceSession disposal", () => {
  test("returns one promise, runs cleanup once, and waits for tracked drains", async () => {
    const cleanupGate = deferred<void>();
    const drainGate = deferred<void>();
    const scrcpyClosed = deferred<void>();
    let cleanupCalls = 0;
    let scrcpyCloseCalls = 0;
    let clientCloseCalls = 0;
    const context = new ActiveDeviceSession({
      serial: "device-a",
      generation: 7,
      stream: fakeStream("device-a", () => {
        scrcpyCloseCalls += 1;
        scrcpyClosed.resolve();
      }),
      applyLocation: async () => {},
      closeClient: () => {
        clientCloseCalls += 1;
      },
    });
    context.clients.add({ ws: { close: () => {} } });
    context.registerCleanup(async () => {
      cleanupCalls += 1;
      await cleanupGate.promise;
    });
    context.trackDrain(drainGate.promise);

    const first = context.dispose("server stopped");
    const second = context.dispose("ignored second reason");

    expect(second).toBe(first);
    expect(context.signal.aborted).toBe(true);
    expect(context.disposed).toBe(true);
    expect(context.status).toBe("stopped");
    expect(context.lastError).toBe("server stopped");
    expect(clientCloseCalls).toBe(1);
    expect(context.clients.size).toBe(0);

    cleanupGate.resolve();
    await scrcpyClosed.promise;
    expect(cleanupCalls).toBe(1);
    expect(scrcpyCloseCalls).toBe(1);

    const outcomeBeforeDrain = await Promise.race([
      first.then(() => "disposed" as const),
      Promise.resolve("pending" as const),
    ]);
    expect(outcomeBeforeDrain).toBe("pending");

    drainGate.resolve();
    await first;
    expect(context.dispose("ignored third reason")).toBe(first);
    expect(cleanupCalls).toBe(1);
    expect(scrcpyCloseCalls).toBe(1);
    expect(clientCloseCalls).toBe(1);
  });

  test("publishes its dispose promise before abort listeners can re-enter", async () => {
    let closeCalls = 0;
    const context = activeSession("device-a", 8, () => {
      closeCalls += 1;
    });
    let nested: Promise<void> | null = null;
    context.signal.addEventListener("abort", () => {
      nested = context.dispose("abort listener");
    });

    const first = context.dispose("terminal failure");
    expect(nested).toBe(first);
    await first;
    expect(closeCalls).toBe(1);
  });
});

describe("DeviceSessionManager", () => {
  test("serializes concurrent switches and publishes only complete contexts", async () => {
    const initialDisposeGate = deferred<void>();
    const initial = managedSession("device-a", 1, initialDisposeGate);
    const manager = new DeviceSessionManager(initial);
    const bCandidate = managedSession("device-b", 2);
    const cCandidate = managedSession("device-c", 3);
    const bPrepareGate = deferred<TestManagedSession>();
    const cPrepareGate = deferred<TestManagedSession>();
    const bPrepareStarted = deferred<void>();
    const cPrepareStarted = deferred<void>();
    const preparations: Array<{ serial: string; generation: number }> = [];

    const switchToB = manager.switch("device-b", async (serial, generation) => {
      preparations.push({ serial, generation });
      bPrepareStarted.resolve();
      return bPrepareGate.promise;
    });
    const switchToC = manager.switch("device-c", async (serial, generation) => {
      preparations.push({ serial, generation });
      cPrepareStarted.resolve();
      return cPrepareGate.promise;
    });

    await bPrepareStarted.promise;
    expect(preparations).toEqual([{ serial: "device-b", generation: 2 }]);
    expect(manager.current).toBe(initial);

    bPrepareGate.resolve(bCandidate);
    while (initial.disposeCalls.length === 0) await Promise.resolve();
    expect(manager.current).toBe(bCandidate);
    expect(preparations).toHaveLength(1);

    initialDisposeGate.resolve();
    await expect(switchToB).resolves.toBe(bCandidate);
    await cPrepareStarted.promise;
    expect(preparations).toEqual([
      { serial: "device-b", generation: 2 },
      { serial: "device-c", generation: 3 },
    ]);
    expect(manager.current).toBe(bCandidate);

    cPrepareGate.resolve(cCandidate);
    await expect(switchToC).resolves.toBe(cCandidate);
    expect(manager.current).toBe(cCandidate);
    expect(initial.disposeCalls).toEqual([
      { reason: "device switched", opts: { clientCode: 1012 } },
    ]);
    expect(bCandidate.disposeCalls).toEqual([
      { reason: "device switched", opts: { clientCode: 1012 } },
    ]);
    expect(cCandidate.disposeCalls).toEqual([]);
  });

  test("keeps the current context after preparation fails and continues the queue", async () => {
    const initial = managedSession("device-a", 4);
    const manager = new DeviceSessionManager(initial);

    await expect(
      manager.switch("broken-device", async (_serial, generation) => {
        expect(generation).toBe(5);
        throw new Error("prepare failed");
      }),
    ).rejects.toThrow("prepare failed");
    expect(manager.current).toBe(initial);
    expect(initial.signal.aborted).toBe(false);
    expect(initial.disposeCalls).toEqual([]);

    const recovered = managedSession("device-b", 5);
    await expect(
      manager.switch("device-b", async (serial, generation) => {
        expect({ serial, generation }).toEqual({ serial: "device-b", generation: 5 });
        return recovered;
      }),
    ).resolves.toBe(recovered);
    expect(manager.current).toBe(recovered);
    expect(initial.disposeCalls).toHaveLength(1);
  });

  test("atomically replaces a generation for the same device serial", async () => {
    const initial = managedSession("device-a", 4);
    const replacement = managedSession("device-a", 5);
    const manager = new DeviceSessionManager(initial);
    const prepareGate = deferred<TestManagedSession>();
    const prepareStarted = deferred<void>();

    const replacing = manager.replace(
      async (current, generation) => {
        expect(current).toBe(initial);
        expect(generation).toBe(5);
        prepareStarted.resolve();
        return prepareGate.promise;
      },
      undefined,
      "stream source switched",
    );

    await prepareStarted.promise;
    expect(manager.current).toBe(initial);
    prepareGate.resolve(replacement);
    await expect(replacing).resolves.toBe(replacement);
    expect(manager.current).toBe(replacement);
    expect(initial.disposeCalls).toEqual([
      { reason: "stream source switched", opts: { clientCode: 1012 } },
    ]);
  });

  test("shutdown aborts an in-flight preparation and never publishes its candidate", async () => {
    const initial = managedSession("device-a", 1);
    const manager = new DeviceSessionManager(initial);
    const prepareGate = deferred<TestManagedSession>();
    const prepareStarted = deferred<AbortSignal>();
    const candidate = managedSession("device-b", 2);

    const switching = manager.switch(
      "device-b",
      async (_serial, _generation, signal) => {
        prepareStarted.resolve(signal);
        return prepareGate.promise;
      },
    );
    const signal = await prepareStarted.promise;
    const closing = manager.close("server stopping");
    expect(signal.aborted).toBe(true);
    expect(manager.current).toBe(initial);

    prepareGate.resolve(candidate);
    await expect(switching).rejects.toThrow("manager is closed");
    await closing;
    expect(manager.current).toBe(initial);
    expect(candidate.disposeCalls).toEqual([
      { reason: "server stopped during device switch", opts: undefined },
    ]);
    expect(initial.disposeCalls).toEqual([
      { reason: "server stopping", opts: { clientCode: 1001 } },
    ]);
  });

  test("a queued stop cannot dispose the generation installed ahead of it", async () => {
    const initial = managedSession("device-a", 1);
    const manager = new DeviceSessionManager(initial);
    const prepareGate = deferred<TestManagedSession>();
    const prepareStarted = deferred<void>();
    const next = managedSession("device-b", 2);

    const switching = manager.switch("device-b", async () => {
      prepareStarted.resolve();
      return prepareGate.promise;
    });
    await prepareStarted.promise;
    const stoppingOld = manager.stop(initial, "old emulator stopped");
    prepareGate.resolve(next);

    await expect(switching).resolves.toBe(next);
    await expect(stoppingOld).rejects.toBeInstanceOf(SessionChangedError);
    expect(manager.current).toBe(next);
    expect(next.disposeCalls).toEqual([]);
  });

  test("shutdown disposes the published session while an older drain is pending", async () => {
    const oldDrain = deferred<void>();
    const initial = managedSession("device-a", 1, oldDrain);
    const manager = new DeviceSessionManager(initial);
    const next = managedSession("device-b", 2);
    const switching = manager.switch("device-b", async () => next);

    while (manager.current !== next) await Promise.resolve();
    const closing = manager.close("server stopping");
    expect(next.signal.aborted).toBe(true);
    expect(next.disposeCalls).toEqual([
      { reason: "server stopping", opts: { clientCode: 1001 } },
    ]);

    oldDrain.resolve();
    await switching;
    await closing;
  });

  test("rolls back a candidate whose activation fails", async () => {
    const initial = managedSession("device-a", 1);
    const candidate = managedSession("device-b", 2);
    const manager = new DeviceSessionManager(initial);

    await expect(
      manager.switch(
        "device-b",
        async () => candidate,
        () => {
          throw new Error("activation failed");
        },
      ),
    ).rejects.toThrow("activation failed");
    expect(manager.current).toBe(initial);
    expect(initial.disposeCalls).toEqual([]);
    expect(candidate.disposeCalls).toEqual([
      { reason: "device session activation failed", opts: undefined },
    ]);
  });
});
