import { describe, expect, test } from "bun:test";

import {
  LADDER_SETTLED_MS,
  createLadderBackoff,
  webRtcFallbackDecision,
} from "../client/webrtc-codec-fallback";

describe("restarting the codec ladder", () => {
  test("backs off to a cap and never below the floor", () => {
    const backoff = createLadderBackoff();
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      backoff.noteFailure(i * 1_000);
      delays.push(backoff.takeRestartDelayMs());
    }
    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000, 30_000]);
    expect(Math.min(...delays)).toBeGreaterThanOrEqual(2_000);
  });

  test("the last codec still reports the ladder as exhausted", () => {
    expect(webRtcFallbackDecision("h264", "vp9", { kind: "codec", codec: "vp9" }))
      .toEqual({ type: "switch-to-http" });
    expect(webRtcFallbackDecision("h264", "h264", { kind: "codec", codec: "h264" }))
      .toEqual({ type: "retry-codec", codec: "vp8" });
  });

  /// A dead sender, walked repeatedly: the wait between walks must not read as recovery.
  test("the backoff holds at its cap while nothing works", () => {
    const backoff = createLadderBackoff();
    let now = 0;
    const delays: number[] = [];
    for (let cycle = 0; cycle < 6; cycle++) {
      backoff.noteFailure(now);
      const delay = backoff.takeRestartDelayMs();
      delays.push(delay);
      now += delay;
      // Each codec in turn fails slowly, the way a first-frame timeout or a stall verdict does.
      for (let rung = 0; rung < 3; rung++) {
        now += 14_000;
        backoff.noteFailure(now);
      }
    }
    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  });

  test("failures close together escalate", () => {
    const backoff = createLadderBackoff();
    let now = 0;
    const delays: number[] = [];
    for (let cycle = 0; cycle < 5; cycle++) {
      backoff.noteFailure(now);
      delays.push(backoff.takeRestartDelayMs());
      for (let rung = 0; rung < 3; rung++) {
        now += 15_000;
        backoff.noteFailure(now);
      }
    }
    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000, 30_000]);
  });

  test("a failure clear of the previous one starts the backoff over", () => {
    const backoff = createLadderBackoff();
    for (let i = 0; i < 4; i++) {
      backoff.noteFailure(i * 1_000);
      backoff.takeRestartDelayMs();
    }
    backoff.noteFailure(4_000);
    expect(backoff.takeRestartDelayMs()).toBe(30_000);
    backoff.noteFailure(4_000 + LADDER_SETTLED_MS);
    expect(backoff.takeRestartDelayMs()).toBe(2_000);
  });

  test("the settle window boundary is inclusive", () => {
    const short = createLadderBackoff();
    short.noteFailure(0);
    short.takeRestartDelayMs();
    short.noteFailure(LADDER_SETTLED_MS - 1);
    expect(short.takeRestartDelayMs()).toBe(4_000);

    const exact = createLadderBackoff();
    exact.noteFailure(0);
    exact.takeRestartDelayMs();
    exact.noteFailure(LADDER_SETTLED_MS);
    expect(exact.takeRestartDelayMs()).toBe(2_000);
  });

  test("the first failure of a session starts at the floor", () => {
    const backoff = createLadderBackoff();
    backoff.noteFailure(0);
    expect(backoff.takeRestartDelayMs()).toBe(2_000);
  });
});
