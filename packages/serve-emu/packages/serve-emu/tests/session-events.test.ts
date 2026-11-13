import { describe, expect, test } from "bun:test";
import {
  appSessionAction,
  replayPlan,
  sessionRecordMode,
  SessionRecorder,
  SessionReplayValidationError,
  strongerRecordMode,
  type RecordedEvent,
  type SessionAction,
} from "../src/session-recorder.ts";
import { parseSessionSnapshot } from "../src/shared/api-contracts.ts";

function immediateClock(start = 0, step = 100) {
  let now = start;
  const delays: number[] = [];
  return {
    delays,
    clock: {
      now: () => {
        const current = now;
        now += step;
        return current;
      },
      delay: async (ms: number) => {
        delays.push(ms);
      },
    },
  };
}

async function waitForReplay(recorder: SessionRecorder): Promise<void> {
  for (let attempt = 0; attempt < 100 && recorder.isReplaying; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(recorder.isReplaying).toBe(false);
}

describe("session record modes", () => {
  test("only `record: false` makes an input activity-only", () => {
    expect(sessionRecordMode({ record: false })).toBe("activity");
    expect(sessionRecordMode({ record: true })).toBe("replay");
    expect(sessionRecordMode({})).toBe("replay");
    expect(sessionRecordMode(null)).toBe("replay");
    expect(sessionRecordMode([{ record: false }])).toBe("replay");
  });

  test("a touch cycle keeps the mode that records the most", () => {
    expect(strongerRecordMode("none", "activity")).toBe("activity");
    expect(strongerRecordMode("activity", "replay")).toBe("replay");
    expect(strongerRecordMode("replay", "none")).toBe("replay");
    expect(strongerRecordMode("none", "none")).toBe("none");
  });
});

describe("SessionRecorder activity entries", () => {
  test("records actions and activity-only input with `replay: false`", () => {
    const { clock } = immediateClock();
    const recorder = new SessionRecorder(clock);
    recorder.recordGesture({ type: "tap", x: 0.5, y: 0.5 }, "rest:tap");
    recorder.recordGesture({ type: "key", keycode: 46 }, "ws", "activity");
    recorder.recordAction({ type: "screenshot" }, "rest:screenshot");
    recorder.recordAction({ type: "orientation", orientation: "landscape" }, "rest:orientation");

    const { events } = recorder.snapshot();
    expect(events).toEqual([
      {
        id: 1,
        at: new Date(0).toISOString(),
        delayMs: 0,
        source: "rest:tap",
        kind: "gesture",
        gesture: { type: "tap", x: 0.5, y: 0.5 },
      },
      {
        id: 2,
        at: new Date(100).toISOString(),
        delayMs: 100,
        source: "ws",
        replay: false,
        kind: "gesture",
        gesture: { type: "key", keycode: 46 },
      },
      {
        id: 3,
        at: new Date(200).toISOString(),
        delayMs: 100,
        source: "rest:screenshot",
        kind: "action",
        replay: false,
        action: { type: "screenshot" },
      },
      {
        id: 4,
        at: new Date(300).toISOString(),
        delayMs: 100,
        source: "rest:orientation",
        kind: "action",
        replay: false,
        action: { type: "orientation", orientation: "landscape" },
      },
    ]);
    // Replayable entries keep the shape they had before activity entries existed.
    expect("replay" in events[0]!).toBe(false);
    expect(recorder.page({ limit: 1 })).toMatchObject({
      session: { eventCount: 4, newestEventId: 4, newestEventAt: new Date(300).toISOString() },
      events: [{ id: 4, kind: "action" }],
    });
  });

  test("stores a copy of the action", () => {
    const recorder = new SessionRecorder(immediateClock().clock);
    const action: SessionAction = { type: "app", action: "launch", packageName: "com.example" };
    recorder.recordAction(action, "rest:apps/launch");
    (action as { packageName?: string }).packageName = "changed";
    const [event] = recorder.snapshot().events;
    expect(event).toMatchObject({ action: { packageName: "com.example" } });
    (event as Extract<RecordedEvent, { kind: "action" }>).action.type = "screenshot";
    expect(recorder.snapshot().events[0]).toMatchObject({ action: { type: "app" } });
  });

  test("records nothing while a replay runs, as for input", async () => {
    const { clock } = immediateClock();
    const recorder = new SessionRecorder(clock);
    recorder.recordGesture({ type: "home" }, "rest:key");
    const replay = recorder.startReplay({
      dispatchGesture: () => {
        recorder.recordAction({ type: "screenshot" }, "rest:screenshot");
        recorder.recordGesture({ type: "back" }, "ws", "activity");
      },
      setLocation: () => {},
    });
    await replay.completion;
    expect(recorder.snapshot().events.map((event) => event.id)).toEqual([1]);
  });
});

describe("session replay of activity entries", () => {
  const at = (id: number) => new Date(id * 1_000).toISOString();
  const tap = (id: number, delayMs: number, replay?: false): RecordedEvent => ({
    id,
    at: at(id),
    delayMs,
    source: "rest:tap",
    ...(replay === false ? { replay } : {}),
    kind: "gesture",
    gesture: { type: "tap", x: 0.5, y: 0.5 },
  });
  const shot = (id: number, delayMs: number): RecordedEvent => ({
    id,
    at: at(id),
    delayMs,
    source: "rest:screenshot",
    kind: "action",
    replay: false,
    action: { type: "screenshot" },
  });

  test("the plan skips activity entries but keeps the time between replayed inputs", () => {
    const plan = replayPlan([
      shot(1, 0),
      tap(2, 700),
      shot(3, 100),
      tap(4, 200, false),
      tap(5, 300),
      shot(6, 5_000),
    ]);
    expect(plan.map(({ event, delayMs }) => [event.id, delayMs])).toEqual([
      // Skipped entries before the first input add no wait.
      [2, 700],
      // 100 ms to the screenshot, 200 ms to the activity-only tap, 300 ms to this tap.
      [5, 600],
      // The trailing screenshot adds no wait.
    ]);
  });

  test("replay sends only the replayable inputs, with the moved delays", async () => {
    const { clock, delays } = immediateClock();
    const recorder = new SessionRecorder(clock);
    recorder.recordGesture({ type: "home" }, "rest:key");
    recorder.recordAction({ type: "screenshot" }, "rest:screenshot");
    recorder.recordGesture({ type: "key", keycode: 46 }, "ws", "activity");
    recorder.recordGesture({ type: "back" }, "rest:key");
    recorder.recordAction({ type: "orientation", orientation: "portrait" }, "rest:orientation");

    const sent: string[] = [];
    const replay = recorder.startReplay(
      {
        dispatchGesture: (gesture) => {
          sent.push(gesture.type);
        },
        setLocation: () => {},
      },
      2,
    );
    expect((await replay.completion).replayStatus).toBe("completed");
    expect(sent).toEqual(["home", "back"]);
    expect(delays).toEqual([0, 150]);
  });

  test("the legacy replay path skips them too", async () => {
    const sleeps: number[] = [];
    let now = 0;
    const recorder = new SessionRecorder({
      now: () => now,
      sleep: async (ms) => void sleeps.push(ms),
    });
    recorder.recordGesture({ type: "home" }, "rest:key");
    now = 50;
    recorder.recordAction({ type: "screenshot" }, "rest:screenshot");
    now = 80;
    recorder.recordGesture({ type: "back" }, "rest:key");
    const sent: string[] = [];
    await recorder.replay({
      dispatchGesture: (gesture) => void sent.push(gesture.type),
      setLocation: () => {},
    });
    expect(sent).toEqual(["home", "back"]);
    expect(sleeps).toEqual([0, 80]);
  });

  test("a session with only activity entries has nothing to replay", async () => {
    const recorder = new SessionRecorder(immediateClock().clock);
    recorder.recordAction({ type: "screenshot" }, "rest:screenshot");
    recorder.recordGesture({ type: "key", keycode: 46 }, "ws", "activity");
    expect(() =>
      recorder.startReplay({ dispatchGesture: () => {}, setLocation: () => {} }),
    ).toThrow(new SessionReplayValidationError("session has no replayable events"));
    await waitForReplay(recorder);
    expect(recorder.snapshot()).toMatchObject({ replaying: false, replayStartedAt: null });
  });
});

describe("session snapshot contract", () => {
  const base = {
    recording: true,
    replaying: false,
    replayStartedAt: null,
    replayCompletedAt: null,
    lastError: null,
  };

  test("parses action entries and activity-only input", () => {
    const recorder = new SessionRecorder(immediateClock().clock);
    recorder.recordGesture({ type: "key", keycode: 46 }, "ws", "activity");
    recorder.recordAction({ type: "fold", hingeAngle: 90 }, "rest:fold");
    recorder.recordAction({ type: "setting", setting: "network", value: false }, "rest:network");
    const parsed = parseSessionSnapshot(JSON.parse(JSON.stringify(recorder.snapshot())));
    expect(parsed.events).toEqual(recorder.snapshot().events);
  });

  test("accepts future action types but rejects malformed entries", () => {
    const event = { id: 1, at: new Date(0).toISOString(), delayMs: 0, source: "rest:x" };
    expect(
      parseSessionSnapshot({
        ...base,
        events: [{ ...event, kind: "action", replay: false, action: { type: "new", n: 1 } }],
      }).events as unknown[],
    ).toEqual([{ ...event, kind: "action", replay: false, action: { type: "new", n: 1 } }]);
    for (const invalid of [
      { ...event, kind: "action", action: { type: "" } },
      { ...event, kind: "action", action: { type: "x", nested: {} } },
      { ...event, kind: "gesture", replay: true, gesture: { type: "home" } },
    ]) {
      expect(() => parseSessionSnapshot({ ...base, events: [invalid] })).toThrow();
    }
  });
});

describe("appSessionAction", () => {
  test("copies the package and permission the route accepted", () => {
    expect(
      appSessionAction("grant", {
        packageName: " com.example.app ",
        permission: "android.permission.CAMERA",
        other: "ignored",
      }),
    ).toEqual({
      type: "app",
      action: "grant",
      packageName: "com.example.app",
      permission: "android.permission.CAMERA",
    });
    expect(appSessionAction("launch", { packageName: "", permission: 7 })).toEqual({
      type: "app",
      action: "launch",
    });
  });
});
