import { describe, expect, test } from "bun:test";
import {
  clearSessionReplayResponse,
  sessionReplayErrorResponse,
  startSessionReplayResponse,
  stopSessionReplayResponse,
} from "../src/session-replay-api.ts";
import {
  SessionRecorder,
  SessionReplayConflictError,
  SessionReplayValidationError,
  type ReplayHandlers,
  type SessionReplayClock,
} from "../src/session-recorder.ts";

const handlers: ReplayHandlers = {
  dispatchGesture: () => {},
  setLocation: () => {},
};

function immediateClock(now = 1_000): SessionReplayClock {
  return {
    now: () => now,
    delay: async (_ms, signal) => {
      if (signal.aborted) throw signal.reason;
    },
  };
}

type ReplayController = Parameters<typeof startSessionReplayResponse>[0];

function throwingController(error: unknown): ReplayController {
  return {
    startReplay: () => {
      throw error;
    },
    cancelAndWait: async () => {
      throw error;
    },
    clear: () => {
      throw error;
    },
  };
}

describe("session replay API responses", () => {
  test("serializes typed and untyped errors with the expected status", async () => {
    const cases = [
      {
        error: new SessionReplayValidationError("invalid replay"),
        status: 400,
        message: "invalid replay",
      },
      {
        error: new SessionReplayConflictError("replay conflict"),
        status: 409,
        message: "replay conflict",
      },
      { error: new Error("unexpected"), status: 500, message: "unexpected" },
      { error: "string failure", status: 500, message: "string failure" },
    ];

    for (const entry of cases) {
      const response = sessionReplayErrorResponse(entry.error);
      expect(response.status).toBe(entry.status);
      expect(await response.json()).toEqual({
        ok: false,
        error: entry.message,
      });
    }

    const overridden = sessionReplayErrorResponse(new Error("bad body"), 422);
    expect(overridden.status).toBe(422);
    expect(await overridden.json()).toEqual({
      ok: false,
      error: "bad body",
    });
  });

  test("starts a replay and returns its running snapshot", async () => {
    const recorder = new SessionRecorder(immediateClock());
    recorder.recordGesture({ type: "home" }, "test");

    const response = startSessionReplayResponse(recorder, handlers, 2);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      session: {
        replaying: true,
        replayStatus: "running",
        replayStartedAt: new Date(1_000).toISOString(),
        replayCompletedAt: null,
        replayCancelledAt: null,
        lastError: null,
      },
    });
    await recorder.cancelAndWait();
  });

  test("rejects a stale device session before admitting the replay", async () => {
    const recorder = new SessionRecorder(immediateClock());
    recorder.recordGesture({ type: "home" }, "test");

    const response = startSessionReplayResponse(
      recorder,
      handlers,
      1,
      () => false,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error: "device session changed before session replay start",
    });
    expect(recorder.isReplaying).toBe(false);
  });

  test("maps start validation and unexpected failures", async () => {
    const empty = new SessionRecorder(immediateClock());
    const invalid = startSessionReplayResponse(empty, handlers, 1);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      ok: false,
      error: "session has no recorded events",
    });

    const failed = startSessionReplayResponse(
      throwingController("start exploded"),
      handlers,
      1,
    );
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({
      ok: false,
      error: "start exploded",
    });
  });

  test("stops an active replay only after cancellation has settled", async () => {
    let delayStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      delayStarted = resolve;
    });
    const recorder = new SessionRecorder({
      now: () => 2_000,
      delay: (_ms, signal) =>
        new Promise<void>((_resolve, reject) => {
          delayStarted();
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    });
    recorder.recordGesture({ type: "home" }, "test");
    recorder.startReplay(handlers);
    await started;

    const response = await stopSessionReplayResponse(recorder);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      session: {
        replaying: false,
        replayStatus: "cancelled",
        replayCompletedAt: null,
        replayCancelledAt: new Date(2_000).toISOString(),
      },
    });
  });

  test("maps stop failures without leaking a rejected promise", async () => {
    const response = await stopSessionReplayResponse(
      throwingController(new SessionReplayConflictError("stop failed")),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error: "stop failed",
    });
  });

  test("clears an idle session and maps clear conflicts", async () => {
    const recorder = new SessionRecorder(immediateClock());
    recorder.recordGesture({ type: "home" }, "test");

    const cleared = clearSessionReplayResponse(recorder);
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({
      ok: true,
      session: { eventCount: 0, droppedEvents: 0 },
    });

    const failed = clearSessionReplayResponse(
      throwingController(
        new SessionReplayConflictError("cannot clear active replay"),
      ),
    );
    expect(failed.status).toBe(409);
    expect(await failed.json()).toEqual({
      ok: false,
      error: "cannot clear active replay",
    });
  });
});
