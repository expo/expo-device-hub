import { describe, expect, test } from "bun:test";
import {
  SessionRecoveryWatchdog,
  type RecoveryClientState,
  type RecoveryWatchdogClock,
} from "../src/session-recovery-watchdog.ts";

type Timer = {
  callback: () => void;
  active: boolean;
};

class ManualClock implements RecoveryWatchdogClock {
  nowMs = 0;
  readonly timers: Timer[] = [];

  now(): number {
    return this.nowMs;
  }

  setInterval(callback: () => void): unknown {
    const timer = { callback, active: true };
    this.timers.push(timer);
    return timer;
  }

  clearInterval(value: unknown): void {
    (value as Timer).active = false;
  }

  advance(ms: number): void {
    this.nowMs += ms;
  }

  fireActive(): void {
    for (const timer of this.timers) {
      if (timer.active) timer.callback();
    }
  }

  get activeTimers(): number {
    return this.timers.filter((timer) => timer.active).length;
  }
}

const client = (
  overrides: Partial<RecoveryClientState> = {},
): RecoveryClientState => ({
  awaitingKeyFrame: false,
  awaitingKeyFrameSinceMs: null,
  lastKeyFrameRequestMs: null,
  ...overrides,
});

function harness(options: {
  clients?: RecoveryClientState[];
  requestReset?: (reason: string, nowMs: number) => boolean;
} = {}) {
  const clock = new ManualClock();
  const clients = options.clients ?? [];
  const resets: Array<{ reason: string; nowMs: number }> = [];
  const watchdog = new SessionRecoveryWatchdog({
    clock,
    clients: () => clients,
    requestReset:
      options.requestReset ??
      ((reason, nowMs) => {
        resets.push({ reason, nowMs });
        return true;
      }),
  });
  return { clock, clients, resets, watchdog };
}

describe("SessionRecoveryWatchdog", () => {
  test("retries across three windows while continuous delta frames arrive", () => {
    const waiting = client();
    const { clock, clients, resets, watchdog } = harness();
    clients.push(waiting);
    watchdog.markAwaiting(waiting);

    expect(watchdog.requestVideoReset("client opened")).toBe(true);
    expect(waiting.awaitingKeyFrameSinceMs).toBe(0);
    expect(waiting.lastKeyFrameRequestMs).toBe(0);

    for (let step = 0; step < 15; step++) {
      clock.advance(500);
      watchdog.recordFrame();
      watchdog.tick();
    }

    expect(resets).toEqual([
      { reason: "client opened", nowMs: 0 },
      { reason: "client awaiting keyframe", nowMs: 2_500 },
      { reason: "client awaiting keyframe", nowMs: 5_000 },
      { reason: "client awaiting keyframe", nowMs: 7_500 },
    ]);
    expect(waiting.awaitingKeyFrameSinceMs).toBe(0);
    expect(waiting.lastKeyFrameRequestMs).toBe(7_500);
    expect(watchdog.snapshot().sourceFrameAgeMs).toBe(0);
  });

  test("one admitted reset covers all waiting clients and rate-limits retries", () => {
    const first = client();
    const second = client();
    const { clock, clients, resets, watchdog } = harness({
      clients: [first, second],
    });
    watchdog.markAwaiting(first);
    watchdog.markAwaiting(second);

    expect(watchdog.requestVideoReset("first client")).toBe(true);
    expect(watchdog.requestVideoReset("second client")).toBe(false);
    expect(first.lastKeyFrameRequestMs).toBe(0);
    expect(second.lastKeyFrameRequestMs).toBe(0);

    clock.advance(2_499);
    watchdog.tick();
    expect(resets).toHaveLength(1);
    clock.advance(1);
    watchdog.tick();
    expect(resets).toHaveLength(2);
    expect(resets[1]).toEqual({
      reason: "client awaiting keyframe",
      nowMs: 2_500,
    });
    expect(clients).toHaveLength(2);
  });

  test("a staggered client reset refreshes every waiting client cooldown", () => {
    const first = client();
    const second = client();
    const { clock, resets, watchdog } = harness({ clients: [first, second] });
    watchdog.markAwaiting(first);
    expect(watchdog.requestVideoReset("first client")).toBe(true);

    clock.advance(600);
    watchdog.markAwaiting(second);
    expect(watchdog.requestVideoReset("staggered client")).toBe(true);
    expect(first.lastKeyFrameRequestMs).toBe(600);
    expect(second.lastKeyFrameRequestMs).toBe(600);

    clock.advance(1_900);
    watchdog.tick();
    expect(resets).toHaveLength(2);
    clock.advance(599);
    watchdog.tick();
    expect(resets).toHaveLength(2);
    clock.advance(1);
    watchdog.tick();

    expect(resets).toEqual([
      { reason: "first client", nowMs: 0 },
      { reason: "staggered client", nowMs: 600 },
      { reason: "client awaiting keyframe", nowMs: 3_100 },
    ]);
    expect(first.lastKeyFrameRequestMs).toBe(3_100);
    expect(second.lastKeyFrameRequestMs).toBe(3_100);
  });

  test("simultaneous source stall and client retry emit at most one reset", () => {
    const waiting = client();
    const { clock, resets, watchdog } = harness({ clients: [waiting] });
    watchdog.markAwaiting(waiting);
    watchdog.recordFrame();
    expect(watchdog.requestVideoReset("client opened")).toBe(true);

    clock.advance(2_500);
    watchdog.tick();

    expect(resets).toEqual([
      { reason: "client opened", nowMs: 0 },
      { reason: "video source stalled", nowMs: 2_500 },
    ]);
    expect(waiting.lastKeyFrameRequestMs).toBe(2_500);
  });

  test("clears both waiting timestamps only when a keyframe is accepted", () => {
    const waiting = client();
    const { clock, watchdog } = harness({ clients: [waiting] });
    watchdog.markAwaiting(waiting);
    watchdog.requestVideoReset("client opened");
    clock.advance(100);

    watchdog.keyFrameAccepted(waiting);

    expect(waiting).toEqual({
      awaitingKeyFrame: false,
      awaitingKeyFrameSinceMs: null,
      lastKeyFrameRequestMs: null,
    });
    watchdog.markAwaiting(waiting);
    expect(waiting.awaitingKeyFrameSinceMs).toBe(100);
  });

  test("preserves an existing wait start and repairs a missing one", () => {
    const waiting = client({
      awaitingKeyFrame: true,
      awaitingKeyFrameSinceMs: 10,
      lastKeyFrameRequestMs: 20,
    });
    const { clock, watchdog } = harness({ clients: [waiting] });
    clock.advance(50);
    watchdog.markAwaiting(waiting);
    expect(waiting.awaitingKeyFrameSinceMs).toBe(10);
    expect(waiting.lastKeyFrameRequestMs).toBe(20);

    waiting.awaitingKeyFrameSinceMs = null;
    watchdog.markAwaiting(waiting);
    expect(waiting.awaitingKeyFrameSinceMs).toBe(50);
    expect(waiting.lastKeyFrameRequestMs).toBe(20);
  });

  test("normalizes FPS by actual elapsed callback time", () => {
    const { clock, watchdog } = harness();
    for (let i = 0; i < 50; i++) watchdog.recordFrame();
    clock.advance(2_500);

    watchdog.tick();

    expect(watchdog.snapshot().sourceFps).toBe(20);
  });

  test("stopped and superseded interval callbacks are inert", () => {
    const waiting = client();
    const { clock, clients, resets, watchdog } = harness();
    clients.push(waiting);
    watchdog.markAwaiting(waiting);
    watchdog.start();
    watchdog.start();
    expect(clock.activeTimers).toBe(1);
    const oldTimer = clock.timers[0]!;

    watchdog.stop();
    expect(clock.activeTimers).toBe(0);
    clock.advance(5_000);
    oldTimer.callback();
    expect(resets).toHaveLength(0);

    watchdog.start();
    expect(clock.activeTimers).toBe(1);
    oldTimer.callback();
    expect(resets).toHaveLength(0);
    clock.fireActive();
    expect(resets).toEqual([
      { reason: "first video frame not received", nowMs: 5_000 },
    ]);
  });

  test("a synchronous reset failure consumes cooldown without marking clients", () => {
    const waiting = client();
    let attempts = 0;
    const { clock, watchdog } = harness({
      clients: [waiting],
      requestReset: () => {
        attempts++;
        throw new Error("socket closed");
      },
    });
    watchdog.markAwaiting(waiting);

    expect(watchdog.requestVideoReset("first")).toBe(false);
    expect(watchdog.requestVideoReset("same tick")).toBe(false);
    expect(attempts).toBe(1);
    expect(waiting.lastKeyFrameRequestMs).toBeNull();
    clock.advance(499);
    expect(watchdog.requestVideoReset("too soon")).toBe(false);
    expect(attempts).toBe(1);
    clock.advance(1);
    expect(watchdog.requestVideoReset("retry")).toBe(false);
    expect(attempts).toBe(2);
  });

  test("reports source and keyframe recovery ages independently", () => {
    const waiting = client();
    const { clock, watchdog } = harness({ clients: [waiting] });
    watchdog.markAwaiting(waiting);
    clock.advance(2_000);
    watchdog.recordFrame();
    clock.advance(100);

    expect(watchdog.snapshot()).toMatchObject({
      sourceFrameAgeMs: 100,
      awaitingClients: 1,
      oldestAwaitingAgeMs: 2_100,
    });
  });
});
