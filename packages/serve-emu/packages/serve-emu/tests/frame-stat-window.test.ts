import { describe, expect, test } from "bun:test";
import { FrameStatWindow } from "../src/frame-stat-window.ts";

describe("FrameStatWindow", () => {
  test("summary is null before any frame", () => {
    expect(new FrameStatWindow(4).summary()).toBeNull();
  });

  test("computes interval percentiles and per-kind average sizes", () => {
    const window = new FrameStatWindow(240);
    let now = 1000;
    window.record(30_000, true, now);
    for (const interval of [10, 10, 10, 10, 10, 10, 10, 10, 10, 100]) {
      now += interval;
      window.record(1_000, false, now);
    }

    const summary = window.summary()!;
    expect(summary.windowFrames).toBe(11);
    expect(summary.keyFramesInWindow).toBe(1);
    expect(summary.avgKeyFrameBytes).toBe(30_000);
    expect(summary.avgDeltaFrameBytes).toBe(1_000);
    expect(summary.intervalMs!.p50).toBe(10);
    expect(summary.intervalMs!.p95).toBe(100);
    expect(summary.intervalMs!.max).toBe(100);
  });

  test("first frame contributes no interval", () => {
    const window = new FrameStatWindow(8);
    window.record(500, false, 100);
    const summary = window.summary()!;
    expect(summary.windowFrames).toBe(1);
    expect(summary.intervalMs).toBeNull();
  });

  test("wraps around its capacity keeping only the most recent frames", () => {
    const window = new FrameStatWindow(3);
    window.record(1, true, 0);
    window.record(2, false, 10);
    window.record(3, false, 20);
    window.record(4, false, 30);

    const summary = window.summary()!;
    expect(summary.windowFrames).toBe(3);
    expect(summary.keyFramesInWindow).toBe(0);
    expect(summary.avgDeltaFrameBytes).toBe(3);
  });

  test("reset clears the window and the interval baseline", () => {
    const window = new FrameStatWindow(4);
    window.record(10, false, 100);
    window.record(10, false, 110);
    window.reset();
    expect(window.summary()).toBeNull();

    window.record(10, false, 500);
    expect(window.summary()!.intervalMs).toBeNull();
  });
});
