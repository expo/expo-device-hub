import { describe, expect, test } from "bun:test";
import type { CrashSummary } from "../crash/store";
import {
  applyCrashFrame,
  EMPTY_CRASH_LIST,
  parseCrashFrame,
  type CrashListState,
} from "../client/utils/crash-stream";

const BASE: CrashSummary = {
  id: "BASE",
  appName: "Demo",
  bundleId: "com.example.demo",
  procName: "Demo",
  deviceUdid: "UDID",
  incidentId: "BASE",
  pid: 1,
  capturedAt: null,
  capturedAtMs: null,
  exceptionType: "EXC_CRASH",
  signal: "SIGABRT",
  terminationIndicator: null,
  appVersion: "1.0.0",
  buildVersion: "1",
  faultingQueue: null,
  culpritFrame: null,
  signature: "sig",
  rawPath: "/tmp/BASE.ips",
  logTailSource: "none",
  logTailLines: 0,
  occurrenceCount: 1,
  occurrenceTimes: [],
  count: 1,
  firstSeen: 0,
  lastSeen: 0,
};

function crash(id: string, lastSeen: number): CrashSummary {
  return { ...BASE, id, incidentId: id, signature: `sig-${id}`, lastSeen };
}

function replay(state: CrashListState, ...frames: Parameters<typeof applyCrashFrame>[1][]) {
  return frames.reduce(applyCrashFrame, state);
}

describe("applyCrashFrame", () => {
  test("keeps the newest crash first", () => {
    const state = replay(
      EMPTY_CRASH_LIST,
      { type: "crash", record: crash("A", 1_000) },
      { type: "crash", record: crash("B", 3_000) },
      { type: "crash", record: crash("C", 2_000) }
    );

    expect(state.crashes.map((entry) => entry.id)).toEqual(["B", "C", "A"]);
  });

  test("replaces a repeat in place rather than listing it twice", () => {
    const state = replay(
      EMPTY_CRASH_LIST,
      { type: "crash", record: crash("A", 1_000) },
      { type: "recurred", record: { ...crash("A", 2_000), count: 2 } }
    );

    expect(state.crashes).toHaveLength(1);
    expect(state.crashes[0]?.count).toBe(2);
  });

  test("drops a crash the device evicted", () => {
    const state = replay(
      EMPTY_CRASH_LIST,
      { type: "crash", record: crash("A", 1_000) },
      { type: "crash", record: crash("B", 2_000) },
      { type: "evicted", id: "A" }
    );

    expect(state.crashes.map((entry) => entry.id)).toEqual(["B"]);
  });

  test("orders a reconnect's list the way live frames order it", () => {
    const live = replay(
      EMPTY_CRASH_LIST,
      { type: "crash", record: crash("A", 1_000) },
      { type: "crash", record: crash("B", 1_000) },
      { type: "crash", record: crash("C", 1_000) }
    );
    const reconnected = applyCrashFrame(EMPTY_CRASH_LIST, {
      type: "list",
      crashes: [crash("A", 1_000), crash("B", 1_000), crash("C", 1_000)],
    });

    expect(reconnected.crashes.map((entry) => entry.id)).toEqual(
      live.crashes.map((entry) => entry.id)
    );
  });

  test("a reconnect's list replaces rows the device no longer has", () => {
    const stale = replay(
      EMPTY_CRASH_LIST,
      { type: "crash", record: crash("gone", 1_000) },
      { type: "crash", record: crash("kept", 2_000) }
    );

    const reconnected = applyCrashFrame(stale, { type: "list", crashes: [crash("kept", 2_000)] });

    expect(reconnected.crashes.map((entry) => entry.id)).toEqual(["kept"]);
  });
});

describe("parseCrashFrame", () => {
  test("ignores anything that is not a frame", () => {
    expect(parseCrashFrame("not json")).toBeNull();
    expect(parseCrashFrame("null")).toBeNull();
    expect(parseCrashFrame(JSON.stringify({ nope: 1 }))).toBeNull();
    expect(parseCrashFrame(JSON.stringify({ type: "cleared" }))).toBeNull();
    expect(parseCrashFrame(JSON.stringify({ type: "list" }))).toBeNull();
  });

  test("reads a frame it knows", () => {
    expect(parseCrashFrame(JSON.stringify({ type: "evicted", id: "A" }))).toEqual({
      type: "evicted",
      id: "A",
    });
  });
});
