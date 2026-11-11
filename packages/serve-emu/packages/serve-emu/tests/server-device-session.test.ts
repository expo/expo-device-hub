import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import { startServer } from "../src/server.ts";
import type { EmulatorLaunch } from "../src/emulator.ts";
import type { GeoFix } from "../src/location.ts";
import type { ScrcpySession, VideoPacket } from "../src/scrcpy.ts";
import {
  SHAKE_DISTANCE_M,
  SHAKE_MIN_SWINGS,
  shakeEmulator,
  type PhysicalModelClient,
  type ShakeMotion,
} from "../src/shake.ts";
import { readNoOrientation } from "./fixtures/orientation.ts";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

type FakeScrcpy = {
  session: ScrcpySession;
  closeCalls: () => number;
  endStream: () => void;
};

function fakeScrcpy(serial: string): FakeScrcpy {
  const proc = new EventEmitter();
  const controlSocket = new EventEmitter() as EventEmitter & {
    write: () => boolean;
  };
  controlSocket.write = () => true;
  const frame = deferred<VideoPacket | null>();
  let closed = false;
  let closeCalls = 0;
  const session = {
    transport: "scrcpy",
    serial,
    protocol: 4,
    meta: {
      deviceName: `device-${serial}`,
      codecId: "h264",
      width: serial === "A" ? 1080 : 720,
      height: serial === "A" ? 1920 : 1280,
    },
    proc,
    controlSocket,
    readFrame: () => frame.promise,
    close: () => {
      closeCalls += 1;
      if (closed) return;
      closed = true;
      frame.resolve(null);
    },
  } as unknown as ScrcpySession;
  return {
    session,
    closeCalls: () => closeCalls,
    endStream: () => frame.resolve(null),
  };
}

type CapturedServer = {
  options: Record<string, unknown> | null;
  stopCalls: number;
};

function capturingServe(captured: CapturedServer): typeof Bun.serve {
  return ((options: Record<string, unknown>) => {
    captured.options = options;
    return {
      port: 3300,
      stop: () => {
        captured.stopCalls += 1;
      },
    };
  }) as unknown as typeof Bun.serve;
}

async function invokeFetch(
  captured: CapturedServer,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const fetchHandler = captured.options?.fetch as
    | ((request: Request, server: unknown) => Promise<Response>)
    | undefined;
  if (!fetchHandler) throw new Error("server fetch handler was not captured");
  return fetchHandler(new Request(`http://127.0.0.1:3300${path}`, init), {
    upgrade: () => false,
  });
}

describe("startServer device session lifecycle", () => {
  test("rolls back the initial scrcpy session when the HTTP bind fails", async () => {
    const initial = fakeScrcpy("A");

    await expect(
      startServer(
        { serial: "A", port: 3300 },
        {
          readOrientation: readNoOrientation,
          openScrcpy: async () => initial.session,
          serve: (() => {
            throw new Error("EADDRINUSE");
          }) as unknown as typeof Bun.serve,
        },
      ),
    ).rejects.toThrow("EADDRINUSE");
    expect(initial.closeCalls()).toBe(1);
  });

  test("returns 409 for an old location completion and exposes only the new session", async () => {
    const a = fakeScrcpy("A");
    const b = fakeScrcpy("B");
    const sessions = new Map([
      ["A", a],
      ["B", b],
    ]);
    const captured: CapturedServer = { options: null, stopCalls: 0 };
    const oldLocation = deferred<void>();
    const oldLocationStarted = deferred<void>();
    const locationCalls: Array<{ serial: string; fix: GeoFix }> = [];
    const started = await startServer(
      { serial: "A", port: 3300 },
      {
        readOrientation: readNoOrientation,
        openScrcpy: async (serial) => sessions.get(serial)!.session,
        listDevices: async () => [
          { serial: "A", state: "device" },
          { serial: "B", state: "device" },
        ],
        listRunningAvds: async () => [],
        listAvds: async () => [],
        setLocation: async (serial, fix) => {
          locationCalls.push({ serial, fix });
          if (serial === "A") {
            oldLocationStarted.resolve();
            await oldLocation.promise;
          }
        },
        serve: capturingServe(captured),
      },
    );

    expect(started.session).toBe(a.session);
    const oldRequest = invokeFetch(captured, "/api/location", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ latitude: 51.5, longitude: -0.1 }),
    });
    await oldLocationStarted.promise;

    const switchResponse = await invokeFetch(captured, "/api/devices/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serial: "B" }),
    });
    expect(switchResponse.status).toBe(200);
    expect(started.session).toBe(b.session);
    expect(started.getSession()).toBe(b.session);
    expect(a.closeCalls()).toBe(1);

    oldLocation.resolve();
    const staleResponse = await oldRequest;
    expect(staleResponse.status).toBe(409);
    expect(await staleResponse.json()).toMatchObject({
      ok: false,
      code: "session_changed",
    });
    expect(locationCalls).toEqual([
      {
        serial: "A",
        fix: {
          latitude: 51.5,
          longitude: -0.1,
          altitude: undefined,
          satellites: undefined,
          velocity: undefined,
        },
      },
    ]);

    const healthResponse = await invokeFetch(captured, "/health");
    expect(healthResponse.status).toBe(200);
    expect(await healthResponse.json()).toMatchObject({
      generation: 1,
      serial: "B",
      device: "device-B",
      size: { width: 720, height: 1280 },
      location: null,
    });
    const gridResponse = await invokeFetch(captured, "/api/device-grid");
    expect(gridResponse.status).toBe(200);
    expect(await gridResponse.json()).toMatchObject({
      currentSerial: "B",
      sessionStatus: "streaming",
    });

    await started.stop();
    expect(started.session).toBeNull();
    expect(b.closeCalls()).toBe(1);
    expect(captured.stopCalls).toBe(1);
  });

  test("cancels an old route start when the device session changes", async () => {
    const a = fakeScrcpy("A");
    const b = fakeScrcpy("B");
    const captured: CapturedServer = { options: null, stopCalls: 0 };
    const routeLocationStarted = deferred<void>();
    let routeSignal: AbortSignal | null = null;
    const started = await startServer(
      { serial: "A", port: 3300 },
      {
        readOrientation: readNoOrientation,
        openScrcpy: async (serial) => (serial === "A" ? a : b).session,
        listDevices: async () => [
          { serial: "A", state: "device" },
          { serial: "B", state: "device" },
        ],
        setLocation: async (serial, _fix, signal) => {
          if (serial !== "A") return;
          routeSignal = signal;
          routeLocationStarted.resolve();
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
        serve: capturingServe(captured),
      },
    );

    const oldRoute = invokeFetch(captured, "/api/route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        waypoints: [{ latitude: 51.5, longitude: -0.1 }],
      }),
    });
    await routeLocationStarted.promise;

    const switchResponse = await invokeFetch(captured, "/api/devices/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serial: "B" }),
    });
    expect(switchResponse.status).toBe(200);
    expect(routeSignal?.aborted).toBe(true);

    const staleResponse = await oldRoute;
    expect(staleResponse.status).toBe(409);
    expect(await staleResponse.json()).toMatchObject({ ok: false });
    const healthResponse = await invokeFetch(captured, "/health");
    expect(await healthResponse.json()).toMatchObject({
      generation: 1,
      serial: "B",
      route: { status: "idle" },
    });
    await started.stop();
  });

  test("rejects a request whose body finishes after the device changes", async () => {
    const a = fakeScrcpy("A");
    const b = fakeScrcpy("B");
    const captured: CapturedServer = { options: null, stopCalls: 0 };
    const bodyGate = deferred<string>();
    const locationCalls: string[] = [];
    const started = await startServer(
      { serial: "A", port: 3300 },
      {
        readOrientation: readNoOrientation,
        openScrcpy: async (serial) => (serial === "A" ? a : b).session,
        listDevices: async () => [
          { serial: "A", state: "device" },
          { serial: "B", state: "device" },
        ],
        setLocation: async (serial) => {
          locationCalls.push(serial);
        },
        serve: capturingServe(captured),
      },
    );
    const fetchHandler = captured.options?.fetch as (
      request: Request,
      server: unknown,
    ) => Promise<Response>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        void bodyGate.promise.then((value) => {
          controller.enqueue(new TextEncoder().encode(value));
          controller.close();
        });
      },
    });
    const slowRequest = fetchHandler(
      new Request("http://127.0.0.1:3300/api/location", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      }),
      { upgrade: () => false },
    );
    await Promise.resolve();

    const switchResponse = await invokeFetch(captured, "/api/devices/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serial: "B" }),
    });
    expect(switchResponse.status).toBe(200);
    bodyGate.resolve(JSON.stringify({ latitude: 51.5, longitude: -0.1 }));

    const response = await slowRequest;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "session_changed" });
    expect(locationCalls).toEqual([]);
    await started.stop();
  });

  test("a stale AVD boot cannot replace a newer selected device", async () => {
    const a = fakeScrcpy("A");
    const b = fakeScrcpy("B");
    const captured: CapturedServer = { options: null, stopCalls: 0 };
    const launchGate = deferred<EmulatorLaunch>();
    const launchStarted = deferred<void>();
    const openCalls: string[] = [];
    let launchStopCalls = 0;
    const started = await startServer(
      { serial: "A", port: 3300 },
      {
        readOrientation: readNoOrientation,
        openScrcpy: async (serial) => {
          openCalls.push(serial);
          if (serial === "A") return a.session;
          if (serial === "B") return b.session;
          throw new Error(`unexpected scrcpy open for ${serial}`);
        },
        listDevices: async () => [
          { serial: "A", state: "device" },
          { serial: "B", state: "device" },
          { serial: "C", state: "device" },
        ],
        startEmulator: async () => {
          launchStarted.resolve();
          return launchGate.promise;
        },
        serve: capturingServe(captured),
      },
    );
    const staleStart = invokeFetch(captured, "/api/avds/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ avd: "Pixel_API", select: true }),
    });
    await launchStarted.promise;

    const switchResponse = await invokeFetch(captured, "/api/devices/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serial: "B" }),
    });
    expect(switchResponse.status).toBe(200);
    launchGate.resolve({
      serial: "C",
      proc: null,
      ownsProcess: true,
      cameraFeed: false,
      stop: () => {
        launchStopCalls += 1;
      },
    });

    const staleResponse = await staleStart;
    expect(staleResponse.status).toBe(409);
    expect(await staleResponse.json()).toMatchObject({
      code: "session_changed",
    });
    expect(launchStopCalls).toBe(1);
    expect(openCalls).toEqual(["A", "B"]);
    expect(started.session).toBe(b.session);
    await started.stop();
  });

  test("device discovery and selection remain available after terminal EOF", async () => {
    const a = fakeScrcpy("A");
    const b = fakeScrcpy("B");
    const captured: CapturedServer = { options: null, stopCalls: 0 };
    const started = await startServer(
      { serial: "A", port: 3300 },
      {
        readOrientation: readNoOrientation,
        openScrcpy: async (serial) => (serial === "A" ? a : b).session,
        listDevices: async () => [
          { serial: "A", state: "device" },
          { serial: "B", state: "device" },
        ],
        serve: capturingServe(captured),
      },
    );

    a.endStream();
    for (let turn = 0; turn < 20 && started.session !== null; turn++) {
      await Promise.resolve();
    }
    expect(started.session).toBeNull();
    const devicesResponse = await invokeFetch(captured, "/api/devices");
    expect(devicesResponse.status).toBe(200);
    expect(await devicesResponse.json()).toMatchObject({ currentSerial: "A" });

    const switchResponse = await invokeFetch(captured, "/api/devices/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serial: "B" }),
    });
    expect(switchResponse.status).toBe(200);
    expect(started.session).toBe(b.session);
    await started.stop();
  });

  test("reports the display orientation in /api and /health and records the locked pose", async () => {
    const a = fakeScrcpy("A");
    const captured: CapturedServer = { options: null, stopCalls: 0 };
    const calls: string[] = [];
    const started = await startServer(
      { serial: "A", port: 3300 },
      {
        openScrcpy: async () => a.session,
        serve: capturingServe(captured),
        readOrientation: async (serial) => (calls.push(`read ${serial}`), "portrait"),
        applyRotation: async (serial, orientation) => {
          calls.push(`lock ${serial} ${orientation}`);
          return {
            mode: "lock",
            rotation: 1,
            orientation: "landscape",
            pose: "landscape_right",
            raw: "lock 1",
          };
        },
      },
    );

    try {
      const info = await invokeFetch(captured, "/api");
      expect(await info.json()).toMatchObject({ pose: "portrait" });
      const health = await invokeFetch(captured, "/health");
      expect(await health.json()).toMatchObject({ pose: "portrait" });

      const locked = await invokeFetch(captured, "/api/orientation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orientation: "landscape_right" }),
      });
      expect(await locked.json()).toMatchObject({
        ok: true,
        orientation: { pose: "landscape_right" },
      });
      // `/api` right after the lock reports the locked pose without another read.
      const after = await invokeFetch(captured, "/api");
      expect(await after.json()).toMatchObject({ pose: "landscape_right" });
      expect(calls).toEqual(["read A", "lock A landscape_right"]);
    } finally {
      await started.stop();
    }
  });
});

describe("startServer shake", () => {
  // No test here reaches an emulator: the emulator serial uses an injected shake, and the
  // default shake refuses a physical serial before it connects.
  async function startShakeServer(serial: string, shake?: ShakeMotion) {
    const captured: CapturedServer = { options: null, stopCalls: 0 };
    const started = await startServer(
      { serial, port: 3300 },
      {
        readOrientation: readNoOrientation,
        openScrcpy: async (target) => fakeScrcpy(target).session,
        listDevices: async () => [{ serial, state: "device" }],
        listRunningAvds: async () => [],
        listAvds: async () => [],
        ...(shake ? { shake } : {}),
        serve: capturingServe(captured),
      },
    );
    return { captured, started };
  }

  /** An emulator physical model that records each position and rests at 0,0,0. */
  function fakePhysicalModel() {
    const positions: number[][] = [];
    const client: PhysicalModelClient = {
      getPhysicalModel: async () => [0, 0, 0],
      setPhysicalModel: async (_target, data) => {
        positions.push([...data]);
      },
      close() {},
    };
    return { positions, connect: async () => client };
  }

  /** A shake that starts at once, swings while it is held, and reports how long it swung. */
  function holdingShake(shaken: string[]): ShakeMotion {
    return async (serial, control) => {
      shaken.push(serial);
      const start = Date.now();
      control.started?.();
      while (control.keepShaking(Date.now() - start)) await Bun.sleep(2);
      return Date.now() - start;
    };
  }

  const post = (captured: CapturedServer, body: unknown) =>
    invokeFetch(captured, "/api/shake", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  test("advertises shake for an emulator and shakes the current device", async () => {
    const shaken: string[] = [];
    const { captured, started } = await startShakeServer("emulator-5598", holdingShake(shaken));
    try {
      const info = await invokeFetch(captured, "/api");
      expect(((await info.json()) as { shake?: unknown }).shake).toBe(true);

      const response = await invokeFetch(captured, "/api/shake", { method: "POST" });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(shaken).toEqual(["emulator-5598"]);

      const wrongMethod = await invokeFetch(captured, "/api/shake");
      expect(wrongMethod.status).toBe(405);
      expect(shaken).toHaveLength(1);
    } finally {
      await started.stop();
    }
  });

  test("a held shake swings until it is released and records its duration", async () => {
    const shaken: string[] = [];
    const { captured, started } = await startShakeServer("emulator-5608", holdingShake(shaken));
    try {
      expect((await post(captured, { hold: true })).status).toBe(200);
      await Bun.sleep(40);
      expect((await post(captured, { hold: false })).status).toBe(200);
      expect(shaken).toEqual(["emulator-5608"]);

      const session = (await (await invokeFetch(captured, "/api/session")).json()) as {
        events: Array<{ kind: string; durationMs?: number }>;
      };
      expect(session.events).toHaveLength(1);
      expect(session.events[0]!.durationMs!).toBeGreaterThanOrEqual(35);
    } finally {
      await started.stop();
    }
  });

  test("stopping one server does not cut another server's shake short", async () => {
    const { positions, connect } = fakePhysicalModel();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstWait = true;
    // Another server's shake on another emulator, in the same process.
    const other = shakeEmulator(
      "emulator-5614",
      { keepShaking: () => false },
      {
        connect,
        wait: async () => {
          if (firstWait) {
            firstWait = false;
            await gate;
          }
        },
      },
    );
    while (positions.length === 0) await Bun.sleep(1);

    const { started } = await startShakeServer("emulator-5612", async () => 0);
    await started.stop();
    release();
    await other;
    expect(positions).toHaveLength(SHAKE_MIN_SWINGS + 1);
  });

  test("stop also settles a shake that a session replay started", async () => {
    const { positions, connect } = fakePhysicalModel();
    let armed = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { captured, started } = await startShakeServer("emulator-5618", (serial, control) =>
      shakeEmulator(serial, control, {
        connect,
        wait: async () => {
          if (armed) await gate;
        },
      }),
    );
    expect((await post(captured, {})).status).toBe(200);
    positions.length = 0;
    armed = true;
    expect(
      (
        await invokeFetch(captured, "/api/session/replay", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(200);
    while (positions.length === 0) await Bun.sleep(1);

    let stopped = false;
    const stopping = started.stop().then(() => {
      stopped = true;
    });
    await Bun.sleep(5);
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(positions).toEqual([
      [0, 0, SHAKE_DISTANCE_M],
      [0, 0, 0],
    ]);
  });

  test("records a shake unless asked not to", async () => {
    const shaken: string[] = [];
    const { captured, started } = await startShakeServer("emulator-5606", holdingShake(shaken));
    try {
      expect((await post(captured, {})).status).toBe(200);
      expect((await post(captured, { record: false })).status).toBe(200);
      expect((await post(captured, { record: "no" })).status).toBe(400);
      expect(shaken).toHaveLength(2);

      const session = (await (await invokeFetch(captured, "/api/session")).json()) as {
        events: unknown[];
      };
      expect(session.events).toMatchObject([{ kind: "shake", source: "rest:shake" }]);
    } finally {
      await started.stop();
    }
  });

  test("stop waits until a running shake moves the device back", async () => {
    const { positions, connect } = fakePhysicalModel();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { captured, started } = await startShakeServer("emulator-5602", (serial, control) =>
      shakeEmulator(serial, control, { connect, wait: () => gate }),
    );
    const response = invokeFetch(captured, "/api/shake", { method: "POST" });
    while (positions.length === 0) await Bun.sleep(1);

    let stopped = false;
    const stopping = started.stop().then(() => {
      stopped = true;
    });
    await Bun.sleep(5);
    expect(stopped).toBe(false);

    release();
    await stopping;
    expect(positions).toEqual([
      [0, 0, SHAKE_DISTANCE_M],
      [0, 0, 0],
    ]);
    await response;
  });

  test("does not advertise or shake a physical device", async () => {
    const { captured, started } = await startShakeServer("A");
    try {
      const info = await invokeFetch(captured, "/api");
      expect(((await info.json()) as { shake?: unknown }).shake).toBe(false);

      const response = await invokeFetch(captured, "/api/shake", { method: "POST" });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: "Shake is available only on Android Emulator devices",
      });
    } finally {
      await started.stop();
    }
  });
});
