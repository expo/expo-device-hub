import { describe, expect, test } from "bun:test";

import { describeCaptureCounts, type CaptureSample } from "../client/utils/capture-window";
import type { CaptureCounts } from "../webrtc-sender-stats";

function sampleAt(atMs: number, overrides: Partial<CaptureCounts> = {}): CaptureSample {
  return {
    atMs,
    counts: {
      pickCount: 0, pickSumMs: 0, pickMaxMs: 0,
      screenFrames: 0, idleFrames: 0, offeredFrames: 0, forwardedFrames: 0,
      pumpRestarts: 0, cpuFallbacks: 0, attempts: 0, stalls: 0, gapSumMs: 0,
      stallSumMs: 0, pollTicks: 0, pollLateSumMs: 0,
      ...overrides,
    },
  };
}

describe("describeCaptureCounts", () => {
  test("reports no rate for the first sample, which has no window behind it", () => {
    const only = describeCaptureCounts(null, sampleAt(1_000, { screenFrames: 900 }));
    expect(only.screenFps).toBeNull();
    expect(only.deliveredFps).toBeNull();
  });

  test("still reports the session totals without a window, since one event matters", () => {
    const only = describeCaptureCounts(null, sampleAt(1_000, { stalls: 3, stallSumMs: 420 }));
    expect(only.stalls).toBe(3);
    expect(only.stallSumMs).toBe(420);
  });

  test("reads the flow counters as rates over the window", () => {
    const window = describeCaptureCounts(
      sampleAt(1_000, { screenFrames: 100, offeredFrames: 100, forwardedFrames: 100 }),
      sampleAt(2_000, { screenFrames: 160, offeredFrames: 160, forwardedFrames: 160 }),
    );
    expect(window.screenFps).toBeCloseTo(60, 3);
    expect(window.deliveredFps).toBeCloseTo(60, 3);
    expect(window.submittedFps).toBeCloseTo(60, 3);
  });

  test("separates a repeated frame from a captured one", () => {
    const window = describeCaptureCounts(
      sampleAt(1_000, { screenFrames: 100, offeredFrames: 100, forwardedFrames: 100 }),
      sampleAt(2_000, { screenFrames: 100, offeredFrames: 105, forwardedFrames: 160 }),
    );
    expect(window.screenFps).toBeCloseTo(0, 3);
    expect(window.deliveredFps).toBeCloseTo(5, 3);
    expect(window.submittedFps).toBeCloseTo(60, 3);
  });

  test("averages the surface pick over the window, so a transition spike is visible", () => {
    const window = describeCaptureCounts(
      sampleAt(1_000, { pickCount: 1_000, pickSumMs: 10 }),
      sampleAt(2_000, { pickCount: 1_120, pickSumMs: 34 }),
    );
    expect(window.pickMs).toBeCloseTo(0.2, 3);
  });

  test("averages the capture interval over the window, not over the session", () => {
    const window = describeCaptureCounts(
      sampleAt(1_000, { attempts: 1_000, gapSumMs: 8_300 }),
      sampleAt(2_000, { attempts: 1_120, gapSumMs: 10_300 }),
    );
    expect(window.intervalMs).toBeCloseTo(16.67, 2);
  });

  test("reports nothing rather than a negative rate when the capture was replaced", () => {
    const window = describeCaptureCounts(
      sampleAt(1_000, { screenFrames: 900 }),
      sampleAt(2_000, { screenFrames: 12 }),
    );
    expect(window.screenFps).toBeNull();
  });

  test("rejects a window longer than the panel claims, which a backgrounded tab produces", () => {
    const window = describeCaptureCounts(
      sampleAt(1_000, { screenFrames: 100 }),
      sampleAt(61_000, { screenFrames: 3_700 }),
    );
    expect(window.screenFps).toBeNull();
  });

  test("rejects a window too short to divide by", () => {
    const window = describeCaptureCounts(
      sampleAt(1_000, { screenFrames: 100 }),
      sampleAt(1_020, { screenFrames: 101 }),
    );
    expect(window.screenFps).toBeNull();
  });

  test("keeps a rate the payload did not carry out of the panel", () => {
    const window = describeCaptureCounts(
      sampleAt(1_000, { offeredFrames: null }),
      sampleAt(2_000, { offeredFrames: null }),
    );
    expect(window.deliveredFps).toBeNull();
  });
});
