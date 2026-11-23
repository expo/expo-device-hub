import { describe, expect, test } from "bun:test";
import { MAX_TEXT_BYTES } from "../src/input.ts";
import {
  DEFAULT_MAX_SESSION_BYTES,
  DEFAULT_MAX_SESSION_EVENTS,
  SessionRecorder,
  type RecordedEvent,
} from "../src/session-recorder.ts";

function arrayBytes(events: RecordedEvent[]): number {
  return Buffer.byteLength(JSON.stringify(events), "utf8");
}

function clock(start = 0, step = 10): () => number {
  let now = start;
  return () => {
    const current = now;
    now += step;
    return current;
  };
}

function recordTaps(recorder: SessionRecorder, count: number): void {
  for (let index = 0; index < count; index++) {
    recorder.recordGesture({ type: "tap", x: index / Math.max(1, count), y: 0.5 }, "test");
  }
}

describe("SessionRecorder retention", () => {
  test("starts with a compact empty summary and configured defaults", () => {
    const recorder = new SessionRecorder();

    expect(recorder.summary()).toEqual({
      eventCount: 0,
      retainedBytes: 2,
      limits: {
        maxEvents: DEFAULT_MAX_SESSION_EVENTS,
        maxBytes: DEFAULT_MAX_SESSION_BYTES,
      },
      droppedEvents: 0,
      oldestEventId: null,
      newestEventId: null,
      oldestEventAt: null,
      newestEventAt: null,
      recording: true,
      replaying: false,
      replayStartedAt: null,
      replayCompletedAt: null,
      lastError: null,
    });
    expect(recorder.export().events).toEqual([]);
  });

  test("evicts by count through ring wrap without losing chronological order", () => {
    const recorder = new SessionRecorder({
      maxEvents: 3,
      maxBytes: 100_000,
      now: clock(0, 10),
    });

    recordTaps(recorder, 8);

    const exported = recorder.export();
    expect(exported.events.map((event) => event.id)).toEqual([6, 7, 8]);
    expect(exported.events.map((event) => event.delayMs)).toEqual([10, 10, 10]);
    expect(exported.session).toMatchObject({
      eventCount: 3,
      droppedEvents: 5,
      oldestEventId: 6,
      newestEventId: 8,
      oldestEventAt: new Date(50).toISOString(),
      newestEventAt: new Date(70).toISOString(),
    });
    expect(exported.session.retainedBytes).toBe(arrayBytes(exported.events));
  });

  test("evicts by exact serialized JSON byte size including brackets and commas", () => {
    const inputs = ["one", "two", "three"];
    const probe = new SessionRecorder({
      maxEvents: 10,
      maxBytes: 100_000,
      now: clock(1_000, 25),
    });
    for (const text of inputs) {
      probe.recordGesture({ type: "text", text }, "rest:text");
    }
    const probeEvents = probe.export().events;
    const lastTwoBytes = arrayBytes(probeEvents.slice(1));
    expect(arrayBytes(probeEvents)).toBeGreaterThan(lastTwoBytes);

    const recorder = new SessionRecorder({
      maxEvents: 10,
      maxBytes: lastTwoBytes,
      now: clock(1_000, 25),
    });
    for (const text of inputs) {
      recorder.recordGesture({ type: "text", text }, "rest:text");
    }

    const exported = recorder.export();
    expect(exported.events.map((event) => event.id)).toEqual([2, 3]);
    expect(exported.session.retainedBytes).toBe(lastTwoBytes);
    expect(exported.session.retainedBytes).toBe(arrayBytes(exported.events));
    expect(exported.session.droppedEvents).toBe(1);
  });

  test("rejects an oversized singleton without evicting retained history", () => {
    const probe = new SessionRecorder({ now: () => 100 });
    probe.recordGesture({ type: "home" }, "test");
    const oneEventBytes = probe.summary().retainedBytes;
    const recorder = new SessionRecorder({
      maxEvents: 4,
      maxBytes: oneEventBytes,
      now: clock(100, 10),
    });

    recorder.recordGesture({ type: "home" }, "test");
    recorder.recordGesture({ type: "back" }, "x".repeat(oneEventBytes * 2));

    expect(recorder.export().events.map((event) => event.id)).toEqual([1]);
    expect(recorder.summary()).toMatchObject({
      eventCount: 1,
      retainedBytes: oneEventBytes,
      droppedEvents: 1,
      oldestEventId: 1,
      newestEventId: 1,
    });
  });

  test("clear resets retention diagnostics but keeps IDs monotonic", () => {
    const recorder = new SessionRecorder({
      maxEvents: 1,
      maxBytes: 10_000,
      now: clock(0, 10),
    });
    recordTaps(recorder, 2);
    expect(recorder.summary().droppedEvents).toBe(1);

    expect(recorder.clear()).toMatchObject({
      eventCount: 0,
      retainedBytes: 2,
      droppedEvents: 0,
      oldestEventId: null,
      newestEventId: null,
    });

    recorder.recordGesture({ type: "home" }, "test");
    expect(recorder.export().events.map((event) => event.id)).toEqual([3]);
    expect(recorder.export().events[0]!.delayMs).toBe(0);
  });

  test("defensively normalizes direct text recordings exactly like control input", () => {
    const recorder = new SessionRecorder({ now: () => 0 });
    const raw = `${"😀".repeat(80)}\ud800tail`;
    recorder.recordGesture({ type: "text", text: raw }, "test");

    const event = recorder.export().events[0]!;
    expect(event.kind).toBe("gesture");
    if (event.kind !== "gesture" || event.gesture.type !== "text") {
      throw new Error("expected a text gesture");
    }
    expect(Buffer.byteLength(event.gesture.text, "utf8")).toBeLessThanOrEqual(MAX_TEXT_BYTES);
    expect(event.gesture.text).toBe("😀".repeat(75));

    const surrogateRecorder = new SessionRecorder({ now: () => 0 });
    surrogateRecorder.recordGesture({ type: "text", text: "before\ud800after" }, "test");
    const surrogateEvent = surrogateRecorder.export().events[0]!;
    if (surrogateEvent.kind !== "gesture" || surrogateEvent.gesture.type !== "text") {
      throw new Error("expected a text gesture");
    }
    expect(surrogateEvent.gesture.text).toBe("before�after");
  });

  test("bounds 2,000 maximum text events by the default byte ceiling", () => {
    const recorder = new SessionRecorder({ now: clock(0, 1) });
    const rawText = "\0".repeat(MAX_TEXT_BYTES + 50);

    for (let index = 0; index < DEFAULT_MAX_SESSION_EVENTS; index++) {
      recorder.recordGesture({ type: "text", text: rawText }, "ws");
    }

    const exported = recorder.export();
    expect(exported.session.eventCount).toBeLessThan(DEFAULT_MAX_SESSION_EVENTS);
    expect(exported.session.droppedEvents).toBe(
      DEFAULT_MAX_SESSION_EVENTS - exported.session.eventCount,
    );
    expect(exported.session.newestEventId).toBe(DEFAULT_MAX_SESSION_EVENTS);
    expect(exported.session.retainedBytes).toBe(arrayBytes(exported.events));
    expect(exported.session.retainedBytes).toBeLessThanOrEqual(DEFAULT_MAX_SESSION_BYTES);
    for (const event of exported.events) {
      if (event.kind !== "gesture" || event.gesture.type !== "text") {
        throw new Error("expected only text gestures");
      }
      expect(Buffer.byteLength(event.gesture.text, "utf8")).toBe(MAX_TEXT_BYTES);
    }
  });

  test("copies input and output values so retained byte accounting cannot drift", () => {
    const recorder = new SessionRecorder({ now: () => 0 });
    const gesture = { type: "tap", x: 0.2, y: 0.4 } as const;
    recorder.recordGesture(gesture, "test");

    const firstExport = recorder.export();
    const first = firstExport.events[0]!;
    if (first.kind !== "gesture" || first.gesture.type !== "tap") {
      throw new Error("expected a tap gesture");
    }
    first.gesture.x = 0.9;

    const secondExport = recorder.export();
    const second = secondExport.events[0]!;
    if (second.kind !== "gesture" || second.gesture.type !== "tap") {
      throw new Error("expected a tap gesture");
    }
    expect(second.gesture.x).toBe(0.2);
    expect(recorder.summary().retainedBytes).toBe(arrayBytes(secondExport.events));
  });
});

describe("SessionRecorder paging", () => {
  test("returns newest pages chronologically with an exclusive before cursor", () => {
    const recorder = new SessionRecorder({
      maxEvents: 5,
      maxBytes: 100_000,
      now: clock(0, 10),
    });
    recordTaps(recorder, 8);

    const latest = recorder.page({ limit: 2 });
    expect(latest.events.map((event) => event.id)).toEqual([7, 8]);
    expect(latest.hasMore).toBe(true);
    expect(latest.nextBefore).toBe(7);

    const middle = recorder.page({ limit: 2, before: latest.nextBefore! });
    expect(middle.events.map((event) => event.id)).toEqual([5, 6]);
    expect(middle.hasMore).toBe(true);
    expect(middle.nextBefore).toBe(5);

    const oldest = recorder.page({ limit: 2, before: middle.nextBefore! });
    expect(oldest.events.map((event) => event.id)).toEqual([4]);
    expect(oldest.hasMore).toBe(false);
    expect(oldest.nextBefore).toBeNull();

    expect(recorder.page({ limit: 10, before: 4 }).events).toEqual([]);
    expect(recorder.page({ limit: 2, before: 100 }).events.map((event) => event.id)).toEqual([
      7, 8,
    ]);
    expect(recorder.export().events.map((event) => event.id)).toEqual([4, 5, 6, 7, 8]);
  });

  test("validates page arguments", () => {
    const recorder = new SessionRecorder();
    expect(() => recorder.page({ limit: 0 })).toThrow("limit");
    expect(() => recorder.page({ limit: 1.5 })).toThrow("limit");
    expect(() => recorder.page({ limit: 1, before: 0 })).toThrow("before");
  });
});

describe("SessionRecorder replay", () => {
  test("replays a stable ordered copy with scaled delays", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const recorder = new SessionRecorder({
      maxEvents: 3,
      maxBytes: 100_000,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    recorder.recordGesture({ type: "home" }, "test");
    now = 100;
    recorder.recordLocation({ latitude: 51.5, longitude: -0.1 }, "test");
    now = 300;
    recorder.recordGesture({ type: "text", text: "hello" }, "test");
    now = 600;
    recorder.recordGesture({ type: "back" }, "test");
    now = 1_000;

    const calls: string[] = [];
    const summary = await recorder.replay(
      {
        dispatchGesture: async (gesture) => {
          calls.push(gesture.type);
          recorder.recordGesture({ type: "power" }, "during-replay");
        },
        setLocation: async (fix) => {
          calls.push(`location:${fix.latitude}`);
          recorder.clear();
        },
      },
      2,
    );

    expect(sleeps).toEqual([50, 100, 150]);
    expect(calls).toEqual(["location:51.5", "text", "back"]);
    expect(summary).toMatchObject({
      eventCount: 0,
      replaying: false,
      replayStartedAt: new Date(1_000).toISOString(),
      replayCompletedAt: new Date(1_000).toISOString(),
      lastError: null,
    });
  });

  test("records replay errors and restores replay state", async () => {
    const recorder = new SessionRecorder({
      now: () => 100,
      sleep: async () => {},
    });
    recorder.recordGesture({ type: "home" }, "test");

    await expect(
      recorder.replay({
        dispatchGesture: async () => {
          throw new Error("dispatch failed");
        },
        setLocation: async () => {},
      }),
    ).rejects.toThrow("dispatch failed");
    expect(recorder.summary()).toMatchObject({
      replaying: false,
      replayStartedAt: new Date(100).toISOString(),
      replayCompletedAt: null,
      lastError: "dispatch failed",
    });
  });

  test("stopReplay can cancel while waiting without dispatching another event", async () => {
    const recorder = new SessionRecorder({
      now: clock(0, 10),
      sleep: async () => {
        recorder.stopReplay();
      },
    });
    recorder.recordGesture({ type: "home" }, "test");
    const calls: string[] = [];

    const summary = await recorder.replay({
      dispatchGesture: async (gesture) => {
        calls.push(gesture.type);
      },
      setLocation: async () => {},
    });

    expect(calls).toEqual([]);
    expect(summary.replaying).toBe(false);
    expect(summary.replayCompletedAt).not.toBeNull();
  });
});

describe("SessionRecorder configuration", () => {
  test("rejects invalid limits", () => {
    expect(() => new SessionRecorder({ maxEvents: 0 })).toThrow("maxEvents");
    expect(() => new SessionRecorder({ maxEvents: 1.5 })).toThrow("maxEvents");
    expect(() => new SessionRecorder({ maxBytes: 1 })).toThrow("maxBytes");
  });
});

describe("shake events", () => {
  test("records a shake, exports it, and replays it through the shake handler", async () => {
    const recorder = new SessionRecorder({ now: clock(0, 10) });
    recorder.recordShake("rest:shake");

    expect(recorder.snapshot().events).toMatchObject([
      { kind: "shake", source: "rest:shake", delayMs: 0 },
    ]);
    expect(recorder.export().events).toEqual(recorder.snapshot().events);

    const shakes: AbortSignal[] = [];
    const run = recorder.startReplay({
      dispatchGesture: () => {},
      setLocation: () => {},
      shake: (signal) => {
        shakes.push(signal);
      },
    });
    const finished = await run.completion;
    expect(shakes).toHaveLength(1);
    expect(finished.replayStatus).toBe("completed");
  });

  test("a shake gets its duration when it ends, keeps the byte count, and replays with it", async () => {
    const recorder = new SessionRecorder({ now: clock(0, 10) });
    const shake = recorder.recordShake("rest:shake")!;
    recorder.setShakeDuration(shake, 1_912.4);
    recorder.setShakeDuration(999, 50);

    const events = recorder.snapshot().events;
    expect(events).toMatchObject([{ kind: "shake", durationMs: 1_912 }]);
    expect(recorder.summary().retainedBytes).toBe(
      Buffer.byteLength(JSON.stringify(events), "utf8"),
    );

    const durations: Array<number | undefined> = [];
    const run = recorder.startReplay({
      dispatchGesture: () => {},
      setLocation: () => {},
      shake: (_signal, durationMs) => {
        durations.push(durationMs);
      },
    });
    await run.completion;
    expect(durations).toEqual([1_912]);
  });

  test("a duration that does not fit the byte limit drops the oldest events", () => {
    const recorder = new SessionRecorder({ now: clock(0, 10), maxBytes: 210 });
    recorder.recordGesture({ type: "home" }, "test");
    const shake = recorder.recordShake("rest:shake")!;
    const before = recorder.summary().droppedEvents;

    recorder.setShakeDuration(shake, 2_000);

    expect(recorder.summary().retainedBytes).toBeLessThanOrEqual(210);
    expect(recorder.summary().droppedEvents).toBe(before + 1);
    expect(recorder.snapshot().events).toMatchObject([{ kind: "shake", durationMs: 2_000 }]);
  });

  test("a running shake at the event limit costs no older event when it fails", () => {
    const recorder = new SessionRecorder({ now: clock(0, 10), maxEvents: 2 });
    recordTaps(recorder, 2);

    const failed = recorder.recordShake("rest:shake")!;
    expect(recorder.summary()).toMatchObject({ eventCount: 3, droppedEvents: 0 });
    recorder.discard(failed);
    expect(recorder.export().events.map((event) => event.id)).toEqual([1, 2]);
    expect(recorder.summary().droppedEvents).toBe(0);

    const shook = recorder.recordShake("rest:shake")!;
    recorder.setShakeDuration(shook, 1_000);
    const events = recorder.export().events;
    expect(events.map((event) => event.id)).toEqual([2, shook]);
    expect(recorder.summary().droppedEvents).toBe(1);
    expect(recorder.summary().retainedBytes).toBe(arrayBytes(events));
  });

  test("input during a running shake drops older input behind the shake and keeps its time", () => {
    let now = 0;
    const recorder = new SessionRecorder({ now: () => now, maxEvents: 1 });
    const shake = recorder.recordShake("rest:shake")!;
    now = 100;
    recorder.recordGesture({ type: "back" }, "test");
    now = 250;
    recorder.recordGesture({ type: "recents" }, "test");

    let events = recorder.export().events;
    expect(events.map((event) => [event.kind, event.delayMs])).toEqual([
      ["shake", 0],
      ["gesture", 250],
    ]);
    expect(recorder.summary().retainedBytes).toBe(arrayBytes(events));

    recorder.setShakeDuration(shake, 50);
    events = recorder.export().events;
    expect(events).toMatchObject([{ kind: "gesture", gesture: { type: "recents" } }]);
    expect(recorder.summary().droppedEvents).toBe(2);
    expect(recorder.summary().retainedBytes).toBe(arrayBytes(events));
  });

  test("a replayed shake swings while each input replays at its recorded time", async () => {
    let now = 0;
    const recorder = new SessionRecorder({
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    recorder.recordGesture({ type: "key", keycode: 66, action: "down" }, "test");
    now = 100;
    const shake = recorder.recordShake("rest:shake")!;
    now = 1_000; // a long press during the shake
    recorder.recordGesture({ type: "touch", action: "down", x: 0.5, y: 0.5 }, "test");
    now = 1_200; // the key pressed before the shake comes up during it
    recorder.recordGesture({ type: "key", keycode: 66, action: "up" }, "test");
    now = 1_800;
    recorder.recordGesture({ type: "touch", action: "up", x: 0.5, y: 0.5 }, "test");
    now = 4_000; // after the shake settled
    recorder.recordGesture({ type: "home" }, "test");
    recorder.setShakeDuration(shake, 3_000);

    const start = now;
    const replayed: Array<[string, number]> = [];
    let settle!: () => void;
    const run = recorder.startReplay({
      dispatchGesture: (gesture) => {
        const name =
          gesture.type === "touch" || gesture.type === "key"
            ? `${gesture.type} ${gesture.action}`
            : gesture.type;
        replayed.push([name, now - start]);
      },
      setLocation: () => {},
      shake: () => {
        replayed.push(["shake", now - start]);
        return new Promise<void>((resolve) => {
          settle = resolve;
        });
      },
    });

    while (replayed.length < 6) await Bun.sleep(1);
    expect(replayed).toEqual([
      ["key down", 0],
      ["shake", 100],
      ["touch down", 1_000],
      ["key up", 1_200],
      ["touch up", 1_800],
      ["home", 4_000],
    ]);
    // The replay ends when the shake has ended.
    expect(recorder.summary().replaying).toBe(true);
    settle();
    expect((await run.completion).replayStatus).toBe("completed");
  });

  test("a replayed shake that fails ends the replay with its error before the next input", async () => {
    const recorder = new SessionRecorder({ now: clock(0, 10), sleep: async () => {} });
    recorder.recordShake("rest:shake");
    recorder.recordGesture({ type: "home" }, "test");

    const gestures: string[] = [];
    const run = recorder.startReplay({
      dispatchGesture: (gesture) => {
        gestures.push(gesture.type);
      },
      setLocation: () => {},
      shake: async () => {
        throw new Error("setPhysicalModel failed");
      },
    });
    const finished = await run.completion;

    expect(finished.replayStatus).toBe("error");
    expect(recorder.summary().lastError).toBe("setPhysicalModel failed");
    expect(gestures).toEqual([]);
  });

  test("a shake that the replay reaches early waits for the one before it, and input keeps its time", async () => {
    let now = 0;
    const recorder = new SessionRecorder({
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    recorder.recordShake("rest:shake");
    now = 1_000;
    recorder.recordShake("rest:shake");
    now = 1_500;
    recorder.recordGesture({ type: "home" }, "test");

    const start = now;
    const replayed: Array<[string, number]> = [];
    const settles: Array<() => void> = [];
    const run = recorder.startReplay(
      {
        dispatchGesture: (gesture) => {
          replayed.push([gesture.type, now - start]);
        },
        setLocation: () => {},
        shake: () => {
          replayed.push(["shake", now - start]);
          return new Promise<void>((resolve) => {
            settles.push(resolve);
          });
        },
      },
      2,
    );

    // At 2x the second shake is due at 500 ms, while the first still swings.
    while (replayed.length < 2) await Bun.sleep(1);
    expect(replayed).toEqual([
      ["shake", 0],
      ["home", 750],
    ]);
    settles[0]!();
    while (replayed.length < 3) await Bun.sleep(1);
    expect(replayed[2]).toEqual(["shake", 750]);
    expect(recorder.summary().replaying).toBe(true);
    settles[1]!();
    expect((await run.completion).replayStatus).toBe("completed");
  });

  test("a discard that lengthens the next event's gap keeps the byte limit", () => {
    const probe = new SessionRecorder({ now: clock(0, 7) });
    probe.recordGesture({ type: "home" }, "test");
    probe.recordGesture({ type: "back" }, "test");
    const maxBytes = probe.summary().retainedBytes;

    let now = 0;
    const recorder = new SessionRecorder({ now: () => now, maxBytes });
    recorder.recordGesture({ type: "home" }, "test");
    now = 5;
    const shake = recorder.recordShake("rest:shake")!;
    now = 12;
    recorder.recordGesture({ type: "back" }, "test");
    expect(recorder.summary().droppedEvents).toBe(0);

    // The gap of Back grows from 7 to 12 ms, one byte more than the limit.
    recorder.discard(shake);
    const events = recorder.export().events;
    expect(events).toMatchObject([{ gesture: { type: "back" }, delayMs: 12 }]);
    expect(recorder.summary().droppedEvents).toBe(1);
    expect(recorder.summary().retainedBytes).toBe(arrayBytes(events));
    expect(recorder.summary().retainedBytes).toBeLessThanOrEqual(maxBytes);
  });
});

describe("discarding a failed action", () => {
  test("removes the event, gives its time gap to the next one, and keeps the byte count", () => {
    let now = 0;
    const recorder = new SessionRecorder({ now: () => now });
    recorder.recordGesture({ type: "home" }, "test");
    now = 100;
    const shake = recorder.recordShake("rest:shake");
    now = 250;
    recorder.recordGesture({ type: "back" }, "test");
    expect(shake).not.toBeNull();

    recorder.discard(shake!);

    const events = recorder.snapshot().events;
    expect(events.map((event) => [event.kind, event.delayMs])).toEqual([
      ["gesture", 0],
      ["gesture", 250],
    ]);
    expect(recorder.summary().retainedBytes).toBe(
      Buffer.byteLength(JSON.stringify(events), "utf8"),
    );
  });

  test("discarding the newest event times the next event from the one before", () => {
    let now = 0;
    const recorder = new SessionRecorder({ now: () => now });
    recorder.recordGesture({ type: "home" }, "test");
    now = 100;
    const shake = recorder.recordShake("rest:shake");
    recorder.discard(shake!);
    now = 400;
    recorder.recordGesture({ type: "back" }, "test");

    expect(recorder.snapshot().events.map((event) => event.delayMs)).toEqual([0, 400]);
  });
});
