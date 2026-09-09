import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import { startServer } from "../src/server.ts";
import type { EmulatorLaunch } from "../src/emulator.ts";
import type { GeoFix } from "../src/location.ts";
import type { ScrcpySession, VideoPacket } from "../src/scrcpy.ts";

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
            signal.addEventListener(
              "abort",
              () => reject(signal.reason),
              { once: true },
            );
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
});
