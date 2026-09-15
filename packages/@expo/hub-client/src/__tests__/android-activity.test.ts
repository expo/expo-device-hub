import { describe, expect, test } from "bun:test";

import {
  EMPTY_ANDROID_ACTIVITY,
  nextAndroidActivityAfterSilence,
  parseAndroidActivityFrame,
} from "../android-activity";

const SAMPLE = {
  t: 2004,
  bundleId: "com.android.chrome",
  cpuPct: 37.5,
  memBytes: 210784256,
  netInBytesPerSec: 1200,
  netOutBytesPerSec: 300,
};

describe("parseAndroidActivityFrame", () => {
  test("reads hostCores from a meta event", () => {
    expect(
      parseAndroidActivityFrame(
        "meta",
        JSON.stringify({
          schemaVersion: 1,
          udid: "emulator-5554",
          hostCores: 4,
          sampleIntervalMs: 1000,
        }),
      ),
    ).toEqual({ kind: "meta", hostCores: 4 });
  });

  test("a meta event without a usable core count still resets errored state", () => {
    expect(parseAndroidActivityFrame("meta", "{}")).toEqual({ kind: "meta", hostCores: null });
  });

  test("reads a sample from an unnamed message event", () => {
    expect(parseAndroidActivityFrame("message", JSON.stringify(SAMPLE))).toEqual({
      kind: "sample",
      sample: SAMPLE,
    });
  });

  test("drops malformed samples, unknown events and bad JSON", () => {
    expect(
      parseAndroidActivityFrame("message", JSON.stringify({ ...SAMPLE, cpuPct: "high" })),
    ).toBeNull();
    expect(parseAndroidActivityFrame("log", JSON.stringify(SAMPLE))).toBeNull();
    expect(parseAndroidActivityFrame("message", "{not json")).toBeNull();
  });
});

describe("nextAndroidActivityAfterSilence", () => {
  const withSample = { ...EMPTY_ANDROID_ACTIVITY, samples: [SAMPLE] };

  test("holds until the deadline passes", () => {
    expect(
      nextAndroidActivityAfterSilence(EMPTY_ANDROID_ACTIVITY, {
        openedAt: 0,
        lastSampleAt: 0,
        now: 8000,
      }),
    ).toBeNull();
  });

  test("a stream that never yields a sample reports errored, not waiting", () => {
    expect(
      nextAndroidActivityAfterSilence(EMPTY_ANDROID_ACTIVITY, {
        openedAt: 0,
        lastSampleAt: 0,
        now: 9000,
      }),
    ).toEqual({ ...EMPTY_ANDROID_ACTIVITY, errored: true });
  });

  test("a stream that stops after a sample reports stale", () => {
    expect(
      nextAndroidActivityAfterSilence(withSample, {
        openedAt: 0,
        lastSampleAt: 1000,
        now: 10_000,
      }),
    ).toEqual({ ...withSample, stale: true });
  });

  test("reports nothing once the flag is already set", () => {
    const clock = { openedAt: 0, lastSampleAt: 0, now: 9000 };
    const errored = { ...EMPTY_ANDROID_ACTIVITY, errored: true };
    expect(nextAndroidActivityAfterSilence(errored, clock)).toBeNull();
    const stale = { ...withSample, stale: true };
    expect(
      nextAndroidActivityAfterSilence(stale, { openedAt: 0, lastSampleAt: 1, now: 10_000 }),
    ).toBeNull();
  });
});
