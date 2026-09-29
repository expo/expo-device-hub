import { expect, test } from "bun:test";
import { replayTouchInput } from "../src/client-touch-state.ts";
import { ControlInputQueue, ControlInputRejectedError } from "../src/control-input-queue.ts";
import { DeviceSessionState } from "../src/device-session-state.ts";

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function harness(options: { blockDown?: boolean; twoPointers?: boolean } = {}) {
  const down = deferred();
  const downStarted = deferred();
  const up = deferred();
  const upStarted = deferred();
  const downs = new Set<number>();
  let upAttempts = 0;
  const queue = new ControlInputQueue({
    dispatcher: {
      async dispatchGesture(gesture) {
        if (gesture.type !== "touch") return;
        const id = gesture.pointerId ?? 0;
        if (gesture.action === "down") {
          downStarted.resolve();
          if (options.blockDown) await down.promise;
          downs.add(id);
        } else if (gesture.action === "up") {
          upAttempts++;
          // A source can reject one operation while its queue remains usable.
          if (options.twoPointers && upAttempts === 1) {
            throw new ControlInputRejectedError("first release rejected");
          }
          upStarted.resolve();
          await up.promise;
          downs.delete(id);
        }
      },
      async resetVideo() {},
    },
  });
  const state = new DeviceSessionState({ serial: "cleanup-test", async applyLocation() {} });
  const owner = {};
  const input = replayTouchInput(() => ({
    identity: queue,
    pointerNamespace: state,
    enqueue: (gesture) => queue.enqueue(gesture, { width: 576, height: 1280 }),
  }));
  state.acquire(owner);
  state.activate(owner, {
    dispatchGesture: async (gesture, signal) => {
      await input.enqueue(gesture, signal).completion;
    },
    finish: input.finish,
  });
  for (let pointerId = 0; pointerId < (options.twoPointers ? 2 : 1); pointerId++) {
    state.recorder.recordGesture(
      { type: "touch", action: "down", pointerId, x: 0.4, y: 0.6 },
      "ws",
    );
  }
  const run = state.recorder.startReplay(state.replayHandlers);
  let finished = false;
  void run.completion.then(() => {
    finished = true;
  });
  return {
    state,
    queue,
    downs,
    down,
    downStarted,
    up,
    upStarted,
    run,
    get finished() {
      return finished;
    },
    get upAttempts() {
      return upAttempts;
    },
    async stop() {
      down.resolve();
      up.resolve();
      await run.completion;
      queue.close();
      await state.release(owner, "test finished");
    },
  };
}

test("replay stays running until its final UP is written", async () => {
  const h = harness();
  try {
    await h.upStarted.promise;
    await flush();
    expect(h.finished).toBe(false);
    expect(h.state.recorder.snapshot()).toMatchObject({ replaying: true, replayStatus: "running" });
    expect(h.downs.size).toBe(1);
    h.up.resolve();
    expect(await h.run.completion).toMatchObject({
      replaying: false,
      replayStatus: "completed",
      lastError: null,
    });
    expect(h.downs.size).toBe(0);
  } finally {
    await h.stop();
  }
});

test("a failed final UP makes replay fail instead of reporting completion", async () => {
  const h = harness();
  try {
    await h.upStarted.promise;
    h.up.reject(new Error("UP transport failed"));
    const result = await h.run.completion;
    expect(result.replayStatus).toBe("error");
    expect(result.lastError).toContain("UP transport failed");
    expect(h.downs.size).toBe(1);
  } finally {
    await h.stop();
  }
});

test("cancel during final cleanup waits for UP and preserves cancellation", async () => {
  const h = harness();
  try {
    await h.upStarted.promise;
    const cancelled = h.state.recorder.cancelAndWait();
    await flush();
    expect(h.finished).toBe(false);
    expect(h.upAttempts).toBe(1);
    h.up.resolve();
    expect(await cancelled).toMatchObject({ replayStatus: "cancelled", lastError: null });
    expect(h.downs.size).toBe(0);
  } finally {
    await h.stop();
  }
});

test("finish awaits the same cleanup that abort already started", async () => {
  const h = harness({ blockDown: true });
  try {
    await h.downStarted.promise;
    const cancelled = h.state.recorder.cancelAndWait();
    h.down.resolve();
    await h.upStarted.promise;
    await flush();
    expect(h.finished).toBe(false);
    expect(h.upAttempts).toBe(1);
    h.up.resolve();
    expect(await cancelled).toMatchObject({ replayStatus: "cancelled", lastError: null });
    expect(h.downs.size).toBe(0);
  } finally {
    await h.stop();
  }
});

test("cancellation retains release failures in lastError", async () => {
  const h = harness({ blockDown: true });
  try {
    await h.downStarted.promise;
    const cancelled = h.state.recorder.cancelAndWait();
    h.down.resolve();
    await h.upStarted.promise;
    h.up.reject(new Error("cancel release failed"));
    const result = await cancelled;
    expect(result.replayStatus).toBe("cancelled");
    expect(result.lastError).toContain("cancel release failed");
  } finally {
    await h.stop();
  }
});

test("a failed release does not finish replay before its other release settles", async () => {
  const h = harness({ twoPointers: true });
  try {
    await h.upStarted.promise;
    await flush();
    expect(h.upAttempts).toBe(2);
    expect(h.finished).toBe(false);
    h.up.resolve();
    const result = await h.run.completion;
    expect(result.replayStatus).toBe("error");
    expect(result.lastError).toContain("first release rejected");
    expect(h.downs.size).toBe(1);
  } finally {
    await h.stop();
  }
});
