import { describe, expect, test } from "bun:test";
import {
  SessionRecorder,
  SessionReplayConflictError,
  SessionReplayValidationError,
  parseSessionReplayMultiplier,
  sessionReplayErrorStatus,
  type ReplayHandlers,
  type SessionReplayClock,
} from "../src/session-recorder.ts";

const noopHandlers: ReplayHandlers = {
  dispatchGesture: () => {},
  setLocation: () => {},
};

function immediateClock(
  now: () => number,
  delays: number[] = [],
): SessionReplayClock {
  return {
    now,
    delay: async (ms, signal) => {
      delays.push(ms);
      if (signal.aborted) throw signal.reason;
    },
  };
}

function pendingClock(now: () => number): {
  clock: SessionReplayClock;
  started: Promise<void>;
} {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  return {
    started,
    clock: {
      now,
      delay: (_ms, signal) =>
        new Promise<void>((_resolve, reject) => {
          markStarted();
          const onAbort = () => reject(signal.reason);
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener("abort", onAbort, { once: true });
        }),
    },
  };
}

describe("session replay input validation", () => {
  test("parses the default and all supported multiplier boundaries", () => {
    expect(parseSessionReplayMultiplier({})).toBe(1);
    expect(parseSessionReplayMultiplier({ multiplier: 0.25 })).toBe(0.25);
    expect(parseSessionReplayMultiplier({ multiplier: 100 })).toBe(100);
  });

  test("rejects non-object payloads and non-number multipliers", () => {
    for (const value of [undefined, null, [], "fast", 2]) {
      expect(() => parseSessionReplayMultiplier(value)).toThrow(
        "session replay payload must be an object",
      );
    }
    expect(() => parseSessionReplayMultiplier({ multiplier: "2" })).toThrow(
      "multiplier must be a number",
    );
  });

  test("rejects non-finite and out-of-range multipliers", () => {
    for (const multiplier of [
      Number.NaN,
      -1,
      0,
      100.01,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(() => parseSessionReplayMultiplier({ multiplier })).toThrow(
        SessionReplayValidationError,
      );
    }
  });

  test("maps validation, conflict, and unexpected errors to HTTP statuses", () => {
    expect(
      sessionReplayErrorStatus(new SessionReplayValidationError("bad input")),
    ).toBe(400);
    expect(
      sessionReplayErrorStatus(new SessionReplayConflictError("busy")),
    ).toBe(409);
    expect(sessionReplayErrorStatus(new Error("unexpected"))).toBe(500);
    expect(sessionReplayErrorStatus("unexpected")).toBe(500);
  });
});

describe("SessionRecorder asynchronous replay lifecycle", () => {
  test("replays a stable gesture/location copy with scaled delays", async () => {
    let now = 100;
    const delays: number[] = [];
    const recorder = new SessionRecorder(immediateClock(() => now, delays));
    const gesture = { type: "tap", x: 0.2, y: 0.3 } as const;
    const location = { latitude: 51.5, longitude: -0.1 };
    recorder.recordGesture(gesture, "rest");
    now = 300;
    recorder.recordLocation(location, "rest");
    now = 1_000;

    const calls: string[] = [];
    const signals: AbortSignal[] = [];
    const run = recorder.startReplay(
      {
        dispatchGesture: (replayed, signal) => {
          calls.push(replayed.type);
          signals.push(signal);
          if (replayed.type === "tap") replayed.x = 0.9;
          recorder.recordGesture({ type: "power" }, "during-replay");
        },
        setLocation: (replayed, signal) => {
          calls.push(`location:${replayed.latitude}`);
          signals.push(signal);
          replayed.latitude = 0;
          now = 1_500;
        },
      },
      2,
    );

    expect(recorder.isReplaying).toBe(true);
    expect(run.snapshot).toMatchObject({
      replaying: true,
      replayStatus: "running",
      replayStartedAt: new Date(1_000).toISOString(),
      replayCompletedAt: null,
      replayCancelledAt: null,
      lastError: null,
    });

    const completed = await run.completion;

    expect(delays).toEqual([0, 100]);
    expect(calls).toEqual(["tap", "location:51.5"]);
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    expect(completed).toMatchObject({
      replaying: false,
      replayStatus: "completed",
      replayStartedAt: new Date(1_000).toISOString(),
      replayCompletedAt: new Date(1_500).toISOString(),
      replayCancelledAt: null,
      lastError: null,
    });
    expect(completed.events).toHaveLength(2);
    const replayedTap = completed.events[0];
    const replayedLocation = completed.events[1];
    expect(
      replayedTap?.kind === "gesture" && replayedTap.gesture.type === "tap"
        ? replayedTap.gesture.x
        : null,
    ).toBe(0.2);
    expect(
      replayedLocation?.kind === "location"
        ? replayedLocation.location.latitude
        : null,
    ).toBe(51.5);
    expect(recorder.isReplaying).toBe(false);
  });

  test("rejects empty, duplicate, invalid, and clear-while-active requests", async () => {
    const { clock, started } = pendingClock(() => 500);
    const recorder = new SessionRecorder({ clock });

    expect(() => recorder.startReplay(noopHandlers)).toThrow(
      "session has no recorded events",
    );
    recorder.recordGesture({ type: "home" }, "test");
    for (const multiplier of [0, 101, Number.NaN]) {
      expect(() => recorder.startReplay(noopHandlers, multiplier)).toThrow(
        SessionReplayValidationError,
      );
    }

    const run = recorder.startReplay(noopHandlers);
    expect(() => recorder.startReplay(noopHandlers)).toThrow(
      "session replay is already running",
    );
    expect(() => recorder.clear()).toThrow(
      "cannot clear session while replay is running",
    );
    await started;
    expect(recorder.snapshot().events).toHaveLength(1);
    recorder.recordLocation({ latitude: 1, longitude: 2 }, "during-replay");
    expect(recorder.snapshot().events).toHaveLength(1);

    expect(recorder.stopReplay()).toMatchObject({ replaying: true });
    const cancelled = await run.completion;
    expect(cancelled).toMatchObject({
      replaying: false,
      replayStatus: "cancelled",
      replayCompletedAt: null,
      replayCancelledAt: new Date(500).toISOString(),
      lastError: null,
    });
  });

  test("cancelAndWait aborts pending work and advances admission epochs", async () => {
    const { clock, started } = pendingClock(() => 750);
    const recorder = new SessionRecorder(clock);
    recorder.recordGesture({ type: "back" }, "test");
    const run = recorder.startReplay(noopHandlers);
    await started;

    expect(recorder.replayAdmissionEpoch).toBe(0);
    const cancelled = await recorder.cancelAndWait();

    expect(cancelled).toMatchObject({
      replaying: false,
      replayStatus: "cancelled",
      replayCancelledAt: new Date(750).toISOString(),
    });
    expect(await run.completion).toEqual(cancelled);
    expect(recorder.replayAdmissionEpoch).toBe(1);

    const idle = await recorder.cancelAndWait();
    expect(idle.replayStatus).toBe("cancelled");
    expect(recorder.replayAdmissionEpoch).toBe(2);
    recorder.clear();
    expect(recorder.replayAdmissionEpoch).toBe(3);
    expect(recorder.snapshot().replayStatus).toBe("idle");
  });

  test("dispose cancels replay, disables recording, and closes all replay APIs", async () => {
    const { clock, started } = pendingClock(() => 900);
    const recorder = new SessionRecorder({ clock });
    recorder.recordGesture({ type: "home" }, "test");
    recorder.startReplay(noopHandlers);
    await started;

    const disposed = await recorder.dispose();

    expect(disposed).toMatchObject({
      recording: false,
      replaying: false,
      replayStatus: "cancelled",
      replayCancelledAt: new Date(900).toISOString(),
    });
    expect(recorder.replayAdmissionEpoch).toBe(1);
    recorder.recordGesture({ type: "power" }, "after-dispose");
    recorder.recordLocation({ latitude: 0, longitude: 0 }, "after-dispose");
    expect(recorder.snapshot().events).toHaveLength(1);
    expect(() => recorder.clear()).toThrow("session recorder is closed");
    expect(() => recorder.startReplay(noopHandlers)).toThrow(
      "session recorder is closed",
    );
    await expect(
      recorder.replay({
        dispatchGesture: () => {},
        setLocation: () => {},
      }),
    ).rejects.toThrow("session recorder is closed");

    const disposedAgain = await recorder.dispose();
    expect(disposedAgain.recording).toBe(false);
    expect(recorder.replayAdmissionEpoch).toBe(2);
  });

  test("records Error and non-Error replay failures and permits a later replay", async () => {
    let now = 1_000;
    const recorder = new SessionRecorder({
      clock: immediateClock(() => now),
    });
    recorder.recordGesture({ type: "home" }, "test");

    const first = await recorder.startReplay({
      dispatchGesture: () => {
        throw new Error("gesture failed");
      },
      setLocation: () => {},
    }).completion;
    expect(first).toMatchObject({
      replayStatus: "error",
      replayCompletedAt: null,
      replayCancelledAt: null,
      lastError: "gesture failed",
    });

    now = 2_000;
    const second = await recorder.startReplay({
      dispatchGesture: () => {
        throw "string failure";
      },
      setLocation: () => {},
    }).completion;
    expect(second).toMatchObject({
      replayStatus: "error",
      replayStartedAt: new Date(2_000).toISOString(),
      lastError: "string failure",
    });

    now = 3_000;
    const recovered = await recorder.startReplay(noopHandlers).completion;
    expect(recovered).toMatchObject({
      replayStatus: "completed",
      replayCompletedAt: new Date(3_000).toISOString(),
      lastError: null,
    });
  });

  test("uses the default abortable clock when only now is overridden", async () => {
    let now = 0;
    const recorder = new SessionRecorder({ now: () => now });
    recorder.recordGesture({ type: "home" }, "test");
    now = 25;
    recorder.recordGesture({ type: "back" }, "test");

    let cancelScheduled = false;
    const run = recorder.startReplay({
      dispatchGesture: () => {
        if (!cancelScheduled) {
          cancelScheduled = true;
          setTimeout(() => recorder.stopReplay(), 0);
        }
      },
      setLocation: () => {},
    });
    const cancelled = await run.completion;

    expect(cancelled).toMatchObject({
      replaying: false,
      replayStatus: "cancelled",
      replayCompletedAt: null,
    });
  });

  test("checks cancellation again after a legacy sleep override settles", async () => {
    let resolveSleep!: () => void;
    let sleepStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      sleepStarted = resolve;
    });
    const recorder = new SessionRecorder({
      now: () => 0,
      sleep: () =>
        new Promise<void>((resolve) => {
          resolveSleep = resolve;
          sleepStarted();
        }),
    });
    recorder.recordGesture({ type: "home" }, "test");
    const run = recorder.startReplay(noopHandlers);
    await started;

    recorder.stopReplay();
    resolveSleep();
    const cancelled = await run.completion;

    expect(cancelled.replayStatus).toBe("cancelled");
  });
});

describe("SessionRecorder legacy replay validation", () => {
  test("uses the built-in timer when no legacy sleep override is provided", async () => {
    const recorder = new SessionRecorder(immediateClock(() => 50));
    recorder.recordGesture({ type: "home" }, "test");
    const calls: string[] = [];

    const summary = await recorder.replay({
      dispatchGesture: (gesture) => {
        calls.push(gesture.type);
      },
      setLocation: () => {},
    });

    expect(calls).toEqual(["home"]);
    expect(summary).toMatchObject({
      replaying: false,
      replayStartedAt: new Date(50).toISOString(),
      replayCompletedAt: new Date(50).toISOString(),
    });
  });

  test("rejects empty, invalid, and concurrent legacy replays", async () => {
    let releaseSleep!: () => void;
    let sleepStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      sleepStarted = resolve;
    });
    const recorder = new SessionRecorder({
      now: () => 0,
      sleep: () =>
        new Promise<void>((resolve) => {
          releaseSleep = resolve;
          sleepStarted();
        }),
    });

    await expect(
      recorder.replay({
        dispatchGesture: () => {},
        setLocation: () => {},
      }),
    ).rejects.toThrow("session has no recorded events");
    recorder.recordGesture({ type: "home" }, "test");
    await expect(
      recorder.replay(
        { dispatchGesture: () => {}, setLocation: () => {} },
        0,
      ),
    ).rejects.toBeInstanceOf(SessionReplayValidationError);

    const active = recorder.replay({
      dispatchGesture: () => {},
      setLocation: () => {},
    });
    await started;
    await expect(
      recorder.replay({
        dispatchGesture: () => {},
        setLocation: () => {},
      }),
    ).rejects.toThrow("session replay is already running");
    recorder.stopReplay();
    releaseSleep();
    await active;
  });

  test("stringifies a non-Error legacy replay failure", async () => {
    const recorder = new SessionRecorder({
      now: () => 0,
      sleep: async () => {},
    });
    recorder.recordGesture({ type: "home" }, "test");

    await expect(
      recorder.replay({
        dispatchGesture: () => {
          throw "legacy string failure";
        },
        setLocation: () => {},
      }),
    ).rejects.toBe("legacy string failure");
    expect(recorder.summary().lastError).toBe("legacy string failure");
  });
});
