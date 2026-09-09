import { describe, expect, test } from "bun:test";
import {
  RoutePlayback,
  RoutePlaybackConflictError,
  type RoutePlaybackClock,
  type RoutePlaybackRequest,
} from "../src/route-playback.ts";
import {
  routePlaybackErrorResponse,
  startRoutePlaybackResponse,
} from "../src/route-playback-api.ts";
import { createSessionRoutePlayback } from "../src/route-playback-session.ts";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class ManualClock implements RoutePlaybackClock {
  nowMs = Date.UTC(2026, 0, 1);
  active = new Map<number, () => void>();
  cleared: Array<() => void> = [];
  maxActive = 0;
  #nextHandle = 1;

  now = () => this.nowMs;

  setInterval = (callback: () => void): number => {
    const handle = this.#nextHandle++;
    this.active.set(handle, callback);
    this.maxActive = Math.max(this.maxActive, this.active.size);
    return handle;
  };

  clearInterval = (handle: unknown): void => {
    const callback = this.active.get(handle as number);
    if (callback) this.cleared.push(callback);
    this.active.delete(handle as number);
  };

  advance(ms: number): void {
    this.nowMs += ms;
  }

  fireActive(): void {
    for (const callback of [...this.active.values()]) callback();
  }

  fireCleared(): void {
    for (const callback of this.cleared.splice(0)) callback();
  }
}

const request: RoutePlaybackRequest = {
  waypoints: [
    { latitude: 51.5, longitude: -0.12 },
    { latitude: 51.51, longitude: -0.11 },
  ],
  speedKph: 30,
  multiplier: 1,
  intervalMs: 250,
};

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("RoutePlayback lifecycle", () => {
  test("close during the initial apply aborts the run without a callback or timer", async () => {
    const clock = new ManualClock();
    const applying = deferred<void>();
    const locations: unknown[] = [];
    let signal: AbortSignal | undefined;
    const playback = new RoutePlayback({
      clock,
      applyLocation: (_fix, runSignal) => {
        signal = runSignal;
        return applying.promise;
      },
      onLocation: (fix) => locations.push(fix),
    });

    const starting = playback.start(request);
    expect(signal?.aborted).toBe(false);
    expect(playback.close().status).toBe("closed");
    expect(playback.close().status).toBe("closed");
    expect(signal?.aborted).toBe(true);

    applying.resolve();
    await expect(starting).rejects.toBeInstanceOf(RoutePlaybackConflictError);
    expect(locations).toHaveLength(0);
    expect(clock.active.size).toBe(0);
    expect(playback.snapshot()).toMatchObject({
      status: "closed",
      waypointCount: 0,
      speedKph: 30,
      multiplier: 1,
      intervalMs: 1000,
      loop: false,
      currentLocation: null,
    });
  });

  test("rejects a concurrent start and owns at most one timer", async () => {
    const clock = new ManualClock();
    const applying = deferred<void>();
    const playback = new RoutePlayback({
      clock,
      applyLocation: () => applying.promise,
      onLocation: () => {},
    });

    const first = playback.start(request);
    const second = playback.start(request);
    await expect(second).rejects.toBeInstanceOf(RoutePlaybackConflictError);
    await expect(second).rejects.toMatchObject({
      message: "route playback start is already in progress",
    });

    applying.resolve();
    expect((await first).status).toBe("running");
    expect(clock.active.size).toBe(1);
    expect(clock.maxActive).toBe(1);
    expect(playback.stop().status).toBe("idle");
    expect(playback.stop().status).toBe("idle");
    expect(clock.active.size).toBe(0);
  });

  test("stop is reusable while close is terminal", async () => {
    const clock = new ManualClock();
    const playback = new RoutePlayback({
      clock,
      applyLocation: () => {},
      onLocation: () => {},
    });

    await playback.start(request);
    expect(clock.active.size).toBe(1);
    expect(playback.pause().status).toBe("paused");
    expect(clock.active.size).toBe(0);
    expect(playback.resume().status).toBe("running");
    expect(playback.resume().status).toBe("running");
    expect(clock.active.size).toBe(1);
    playback.stop();
    playback.stop();
    expect(clock.active.size).toBe(0);

    await playback.start(request);
    expect(clock.active.size).toBe(1);
    playback.close();
    playback.resume();
    clock.fireCleared();
    expect(clock.active.size).toBe(0);
    expect(playback.snapshot().status).toBe("closed");
    await expect(playback.start(request)).rejects.toBeInstanceOf(
      RoutePlaybackConflictError,
    );
  });

  test("stop during the initial apply invalidates the run and remains reusable", async () => {
    const clock = new ManualClock();
    const firstApply = deferred<void>();
    let calls = 0;
    let firstSignal: AbortSignal | undefined;
    const playback = new RoutePlayback({
      clock,
      applyLocation: (_fix, signal) => {
        calls++;
        if (calls === 1) {
          firstSignal = signal;
          return firstApply.promise;
        }
      },
      onLocation: () => {},
    });

    const firstStart = playback.start(request);
    expect(playback.stop().status).toBe("idle");
    expect(playback.stop().status).toBe("idle");
    expect(firstSignal?.aborted).toBe(true);
    const secondStart = playback.start(request);
    expect((await secondStart).status).toBe("running");
    expect(clock.active.size).toBe(1);
    firstApply.resolve();
    await expect(firstStart).rejects.toBeInstanceOf(RoutePlaybackConflictError);
    expect(playback.snapshot().status).toBe("running");
    expect(clock.active.size).toBe(1);
    playback.close();
  });

  test("pause and resume during startup defer timer ownership to start", async () => {
    const clock = new ManualClock();
    const applying = deferred<void>();
    const playback = new RoutePlayback({
      clock,
      applyLocation: () => applying.promise,
      onLocation: () => {},
    });

    const starting = playback.start(request);
    expect(playback.pause().status).toBe("paused");
    expect(playback.resume().status).toBe("running");
    expect(clock.active.size).toBe(0);
    applying.resolve();
    expect((await starting).status).toBe("running");
    expect(clock.active.size).toBe(1);
    expect(clock.maxActive).toBe(1);
    playback.close();
  });

  test("initial apply failures reject and map to a non-success API status", async () => {
    const playback = new RoutePlayback({
      clock: new ManualClock(),
      applyLocation: () => {
        throw new Error("geo fix failed");
      },
      onLocation: () => {},
    });

    const response = await startRoutePlaybackResponse(playback, request);
    expect(response.ok).toBe(false);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      ok: false,
      error: "geo fix failed",
    });
    expect(playback.snapshot()).toMatchObject({
      status: "error",
      lastError: "geo fix failed",
    });
  });

  test("successful starts return the running route API response", async () => {
    const playback = new RoutePlayback({
      clock: new ManualClock(),
      applyLocation: () => {},
      onLocation: () => {},
    });

    const response = await startRoutePlaybackResponse(playback, request);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      route: { status: "running", waypointCount: 2 },
    });
    playback.close();
  });

  test("route request validation errors remain bad requests", async () => {
    const response = routePlaybackErrorResponse(
      new Error("route must include at least one waypoint"),
      400,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: "route must include at least one waypoint",
    });
  });

  test("concurrent and disposed starts map to conflict responses", async () => {
    const applying = deferred<void>();
    const playback = new RoutePlayback({
      clock: new ManualClock(),
      applyLocation: () => applying.promise,
      onLocation: () => {},
    });
    const first = playback.start(request);

    const response = await startRoutePlaybackResponse(playback, request);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error: "route playback start is already in progress",
    });

    playback.close();
    applying.resolve();
    await expect(first).rejects.toBeInstanceOf(RoutePlaybackConflictError);

    const disposedResponse = await startRoutePlaybackResponse(
      playback,
      request,
    );
    expect(disposedResponse.status).toBe(409);
    expect(await disposedResponse.json()).toEqual({
      ok: false,
      error: "route playback is closed",
    });
  });

  test("a stale request generation returns conflict before starting a route", async () => {
    let applies = 0;
    const playback = new RoutePlayback({
      clock: new ManualClock(),
      applyLocation: () => {
        applies++;
      },
      onLocation: () => {},
    });

    const response = await startRoutePlaybackResponse(
      playback,
      request,
      () => false,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error: "device session changed before route playback start",
    });
    expect(applies).toBe(0);
    expect(playback.snapshot().status).toBe("idle");
  });

  test("unexpected start failures map to server errors", async () => {
    const response = await startRoutePlaybackResponse(
      {
        start: async () => {
          throw new Error("unexpected route failure");
        },
      },
      request,
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      ok: false,
      error: "unexpected route failure",
    });
  });

  test("periodic apply failure stops the owned timer", async () => {
    const clock = new ManualClock();
    let applyCount = 0;
    const playback = new RoutePlayback({
      clock,
      applyLocation: () => {
        applyCount++;
        if (applyCount === 2) throw new Error("periodic geo fix failed");
      },
      onLocation: () => {},
    });

    await playback.start(request);
    clock.advance(250);
    clock.fireActive();
    await flushMicrotasks();

    expect(playback.snapshot()).toMatchObject({
      status: "error",
      lastError: "periodic geo fix failed",
    });
    expect(clock.active.size).toBe(0);
  });

  test("close during a periodic apply suppresses the late location callback", async () => {
    const clock = new ManualClock();
    const periodicApply = deferred<void>();
    const published: unknown[] = [];
    let applyCount = 0;
    let periodicSignal: AbortSignal | undefined;
    const playback = new RoutePlayback({
      clock,
      applyLocation: (_fix, signal) => {
        applyCount++;
        if (applyCount === 2) {
          periodicSignal = signal;
          return periodicApply.promise;
        }
      },
      onLocation: (fix) => published.push(fix),
    });

    await playback.start(request);
    clock.advance(250);
    clock.fireActive();
    expect(applyCount).toBe(2);
    playback.close();
    expect(periodicSignal?.aborted).toBe(true);
    periodicApply.resolve();
    await flushMicrotasks();

    expect(published).toHaveLength(1);
    expect(playback.snapshot().status).toBe("closed");
    expect(clock.active.size).toBe(0);
  });

  test("a disposed device player cannot publish a late location", async () => {
    const oldClock = new ManualClock();
    const oldApply = deferred<void>();
    const published: string[] = [];
    let oldSignal: AbortSignal | undefined;
    const oldPlayback = new RoutePlayback({
      clock: oldClock,
      applyLocation: (_fix, signal) => {
        oldSignal = signal;
        return oldApply.promise;
      },
      onLocation: () => published.push("old"),
    });
    const oldStart = oldPlayback.start(request);

    oldPlayback.close();
    const newPlayback = new RoutePlayback({
      clock: new ManualClock(),
      applyLocation: () => {},
      onLocation: () => published.push("new"),
    });
    await newPlayback.start(request);
    oldApply.resolve();
    await expect(oldStart).rejects.toBeInstanceOf(RoutePlaybackConflictError);

    expect(oldSignal?.aborted).toBe(true);
    expect(published).toEqual(["new"]);
    expect(oldClock.active.size).toBe(0);
    oldPlayback.close();
    oldClock.fireCleared();
    expect(published).toEqual(["new"]);
    newPlayback.close();
  });

  test("session playback binds its serial and suppresses stale generation updates", async () => {
    const clock = new ManualClock();
    const applying = deferred<void>();
    const appliedSerials: string[] = [];
    const published: unknown[] = [];
    let generation = 3;
    const playback = createSessionRoutePlayback({
      serial: "emulator-5554",
      generation,
      getGeneration: () => generation,
      clock,
      applyLocation: (serial) => {
        appliedSerials.push(serial);
        return applying.promise;
      },
      onLocation: (fix) => published.push(fix),
    });

    const starting = startRoutePlaybackResponse(playback, request);
    generation++;
    applying.resolve();
    const response = await starting;
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error: "device session changed during route playback",
    });
    expect(appliedSerials).toEqual(["emulator-5554"]);
    expect(published).toHaveLength(0);
    expect(playback.snapshot().status).toBe("closed");
    expect(clock.active.size).toBe(0);
  });
});
