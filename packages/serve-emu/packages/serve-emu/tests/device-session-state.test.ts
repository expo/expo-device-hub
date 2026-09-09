import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "bun:test";
import { DeviceSessionState } from "../src/device-session-state.ts";
import { LogcatHub } from "../src/logcat.ts";
import { SessionRecorder } from "../src/session-recorder.ts";

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason: unknown): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fakeLogcatHub(serial: string): {
  hub: LogcatHub;
  killed: () => boolean;
} {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill(): boolean;
  };
  let wasKilled = false;
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = () => {
    wasKilled = true;
    return true;
  };
  return {
    hub: new LogcatHub(serial, {
      dependencies: {
        spawn: () => child as never,
      },
    }),
    killed: () => wasKilled,
  };
}

describe("DeviceSessionState source ownership", () => {
  test("keeps device resources and retargets active replay until the final source releases", async () => {
    const replayDelay = deferred<void>();
    const recorder = new SessionRecorder({
      clock: {
        now: () => 1_000,
        delay: (_ms, signal) =>
          new Promise<void>((resolve, reject) => {
            const onAbort = () => reject(signal.reason);
            signal.addEventListener("abort", onAbort, { once: true });
            replayDelay.promise.then(
              () => {
                signal.removeEventListener("abort", onAbort);
                resolve();
              },
              reject,
            );
          }),
      },
    });
    const logcat = fakeLogcatHub("emulator-5554");
    const appliedLocations: string[] = [];
    const state = new DeviceSessionState({
      serial: "emulator-5554",
      recorder,
      logcat: logcat.hub,
      applyLocation: async (_serial, fix) => {
        appliedLocations.push(`${fix.latitude},${fix.longitude}`);
      },
      now: () => 1_000,
    });
    const scrcpyOwner = {};
    const grpcOwner = {};
    const replayTargets: string[] = [];
    state.acquire(scrcpyOwner);
    state.activate(scrcpyOwner, {
      dispatchGesture: (gesture) => {
        replayTargets.push(`scrcpy:${gesture.type}`);
      },
    });
    state.recorder.recordGesture(
      { type: "tap", x: 0.25, y: 0.75 },
      "test",
    );
    const logResponse = state.logcat.subscribe({});
    expect(logResponse.status).toBe(200);
    await state.route.start({
      waypoints: [
        { latitude: 52.3676, longitude: 4.9041 },
        { latitude: 52.52, longitude: 13.405 },
      ],
      speedKph: 1,
      intervalMs: 60_000,
      loop: true,
    });
    const replay = state.recorder.startReplay(state.replayHandlers);
    expect(replay.snapshot.replaying).toBe(true);

    state.acquire(grpcOwner);
    state.activate(grpcOwner, {
      dispatchGesture: (gesture) => {
        replayTargets.push(`grpc:${gesture.type}`);
      },
    });
    await state.release(scrcpyOwner, "stream source switched");

    expect(state.disposed).toBe(false);
    expect(state.recorder.summary().eventCount).toBe(1);
    expect(state.recorder.snapshot().replaying).toBe(true);
    expect(state.route.snapshot().status).toBe("running");
    expect(state.lastLocation).toMatchObject({
      latitude: 52.3676,
      longitude: 4.9041,
    });
    expect(appliedLocations).toEqual(["52.3676,4.9041"]);
    expect(state.logcat.snapshot().subscribers).toBe(1);
    expect(logcat.killed()).toBe(false);

    replayDelay.resolve();
    await replay.completion;
    expect(replayTargets).toEqual(["grpc:tap"]);
    expect(state.recorder.snapshot().replayStatus).toBe("completed");

    await state.release(grpcOwner, "device session stopped");
    expect(state.disposed).toBe(true);
    expect(state.route.snapshot().status).toBe("closed");
    expect(state.logcat.snapshot()).toMatchObject({
      closed: true,
      subscribers: 0,
    });
    expect(logcat.killed()).toBe(true);
  });
});
