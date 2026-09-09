import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import type { Device } from "../src/adb.ts";
import { ControlInputQueue } from "../src/control-input-queue.ts";
import {
  createApp,
  createRouter,
  type AppOptions,
  type EmuApp,
  type RouterDependencies,
} from "../src/middleware.ts";
import type { RunningAvd } from "../src/emulator.ts";
import type { ScrcpySession } from "../src/scrcpy.ts";
import type {
  InputSource,
  StreamMode,
} from "../src/shared/api-contracts.ts";
import type { EmuSession } from "../src/stream-session.ts";

type JsonObject = Record<string, unknown>;

const SESSION_ID = "00000000-0000-4000-8000-000000000000";
const OTHER_SESSION_ID = "11111111-1111-4111-8111-111111111111";

async function responseJson(response: Response): Promise<JsonObject> {
  return (await response.json()) as JsonObject;
}

function post(path: string, body: JsonObject): Request {
  return new Request(`http://router.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function put(path: string, body: JsonObject): Request {
  return new Request(`http://router.test${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function fakeApp(
  serial: string,
  stopped: string[],
  mode: StreamMode = "scrcpy",
  statsSessionId = SESSION_ID,
  inputSource: InputSource = "scrcpy",
): EmuApp {
  return {
    session: { mode, inputSource, meta: { deviceName: `Device ${serial}` } },
    getInputSource: () => inputSource,
    isStreaming: () => true,
    health: () => ({ status: "streaming" }),
    webRtcStats: (sessionId: string) =>
      sessionId === statsSessionId
        ? {
            sampledAt: 42,
            source: {
              codec: "h264",
              width: 1080,
              height: 2400,
              frames: 100,
              fps: 30,
              configuredBitrateBps: 8_000_000,
            },
            sessions: [
              {
                sessionId,
                state: "connected",
                iceState: "connected",
                connected: true,
                submittedFrames: 80,
                publisherDroppedFrames: 10,
                payloadBytesSubmitted: 1_024,
                path: "direct",
                localCandidateType: "host",
                remoteCandidateType: "host",
                localCandidateTransport: "udp",
                remoteCandidateTransport: "udp",
              },
            ],
            capture: { offeredFrames: 90, forwardedFrames: 80 },
          }
        : null,
    handleRequest: async (request: Request) =>
      Response.json({ serial, path: new URL(request.url).pathname }),
    attachWebSocket: () => {},
    stop: async () => {
      stopped.push(serial);
    },
  } as unknown as EmuApp;
}

function routerDependencies(state: {
  devices: Device[];
  avds: string[];
  running: RunningAvd[];
  created: string[];
  stopped: string[];
  createdModes?: StreamMode[];
  createdInputSources?: InputSource[];
}): RouterDependencies {
  return {
    listDevices: async () =>
      state.devices.filter((device) => device.state === "device"),
    listAllDevices: async () => state.devices.map((device) => ({ ...device })),
    listAvds: async () => [...state.avds],
    listRunningAvds: async () =>
      state.running.map((running) => ({ ...running })),
    resolveRunningAvds: async (devices) => {
      const serials = new Set(devices.map((device) => device.serial));
      return state.running
        .filter((running) => serials.has(running.serial))
        .map((running) => ({ ...running }));
    },
    createApp: async ({ serial, streamMode, inputSource }) => {
      state.created.push(serial);
      const mode = streamMode ?? "scrcpy";
      state.createdModes?.push(mode);
      const source = inputSource ?? "scrcpy";
      state.createdInputSources?.push(source);
      return fakeApp(serial, state.stopped, mode, SESSION_ID, source);
    },
    startEmulator: async ({ avd }) => {
      const serial = "emulator-5556";
      state.devices.push({ serial, state: "device" });
      state.running.push({ serial, avd, state: "device" });
      return {
        serial,
        proc: null,
        ownsProcess: false,
        cameraFeed: false,
        stop: () => {},
      };
    },
    stopEmulator: async (serial) => {
      state.devices = state.devices.filter(
        (device) => device.serial !== serial,
      );
      state.running = state.running.filter(
        (running) => running.serial !== serial,
      );
    },
  };
}

describe("createRouter DevicePanel compatibility", () => {
  test("keeps WebRTC statistics observational and validates before device lookup", async () => {
    let deviceReads = 0;
    let appCreates = 0;
    const router = createRouter(
      { serial: "emulator-5554" },
      {
        listDevices: async () => {
          deviceReads++;
          return [{ serial: "emulator-5554", state: "device" }];
        },
        createApp: async ({ serial }) => {
          appCreates++;
          return fakeApp(serial, []);
        },
      },
    );

    const invalid = await router.handleRequest(
      new Request("http://router.test/webrtc/stats?sessionId=invalid"),
    );
    expect(invalid.status).toBe(400);
    expect(deviceReads).toBe(0);
    expect(appCreates).toBe(0);

    const missingSession = await router.handleRequest(
      new Request("http://router.test/webrtc/stats?device=emulator-5554"),
    );
    expect(missingSession.status).toBe(400);

    const invalidDevice = await router.handleRequest(
      new Request(
        `http://router.test/webrtc/stats?sessionId=${SESSION_ID}&device=${"x".repeat(257)}`,
      ),
    );
    expect(invalidDevice.status).toBe(400);

    const idle = await router.handleRequest(
      new Request(
        `http://router.test/webrtc/stats?device=emulator-5554&sessionId=${SESSION_ID}`,
      ),
    );
    expect(idle.status).toBe(503);
    expect(deviceReads).toBe(0);
    expect(appCreates).toBe(0);

    await router.getApp("emulator-5554");
    const active = await router.handleRequest(
      new Request(
        `http://router.test/webrtc/stats?device=emulator-5554&sessionId=${SESSION_ID}`,
      ),
    );
    expect(active.status).toBe(200);
    expect((await responseJson(active)).sessions).toEqual([
      expect.objectContaining({ sessionId: SESSION_ID }),
    ]);

    const unknownSession = await router.handleRequest(
      new Request(
        `http://router.test/webrtc/stats?device=emulator-5554&sessionId=${OTHER_SESSION_ID}`,
      ),
    );
    expect(unknownSession.status).toBe(503);
    expect(await responseJson(unknownSession)).toEqual({
      ok: false,
      error: "webrtc_stats_unavailable",
    });
    expect(deviceReads).toBe(0);
    expect(appCreates).toBe(1);
  });

  test("requires an explicit device when multiple apps are streaming", async () => {
    const router = createRouter(
      {},
      {
        createApp: async ({ serial }) =>
          fakeApp(
            serial,
            [],
            "scrcpy",
            serial === "emulator-5554" ? SESSION_ID : OTHER_SESSION_ID,
          ),
      },
    );
    await Promise.all([
      router.getApp("emulator-5554"),
      router.getApp("usb-1"),
    ]);

    const ambiguous = await router.handleRequest(
      new Request(`http://router.test/webrtc/stats?sessionId=${SESSION_ID}`),
    );
    expect(ambiguous.status).toBe(400);
    expect(await responseJson(ambiguous)).toMatchObject({
      ok: false,
      error: "ambiguous_device",
    });

    const selected = await router.handleRequest(
      new Request(
        `http://router.test/webrtc/stats?sessionId=${SESSION_ID}&device=emulator-5554`,
      ),
    );
    expect(selected.status).toBe(200);

    const wrongDevice = await router.handleRequest(
      new Request(
        `http://router.test/webrtc/stats?sessionId=${SESSION_ID}&device=usb-1`,
      ),
    );
    expect(wrongDevice.status).toBe(503);
    expect(await responseJson(wrongDevice)).not.toHaveProperty("source");
  });

  test("uses the selected streaming device when statistics omit device", async () => {
    const router = createRouter(
      { serial: "emulator-5554" },
      {
        createApp: async ({ serial }) =>
          fakeApp(
            serial,
            [],
            "scrcpy",
            serial === "emulator-5554" ? SESSION_ID : OTHER_SESSION_ID,
          ),
      },
    );
    await Promise.all([
      router.getApp("emulator-5554"),
      router.getApp("usb-1"),
    ]);

    const response = await router.handleRequest(
      new Request(`http://router.test/webrtc/stats?sessionId=${SESSION_ID}`),
    );

    expect(response.status).toBe(200);
    expect(await responseJson(response)).toMatchObject({
      sessions: [expect.objectContaining({ sessionId: SESSION_ID })],
    });
  });

  test("discovers the grid and persists UI selection without a device query", async () => {
    const state = {
      devices: [
        { serial: "emulator-5554", state: "device" },
        { serial: "usb-1", state: "device" },
      ],
      avds: ["Pixel_8", "Pixel_9"],
      running: [
        { serial: "emulator-5554", avd: "Pixel_8", state: "device" },
      ],
      created: [] as string[],
      stopped: [] as string[],
    };
    const router = createRouter(
      { serial: "emulator-5554" },
      routerDependencies(state),
    );

    const gridResponse = await router.handleRequest(
      new Request("http://router.test/api/device-grid"),
    );
    expect(gridResponse.status).toBe(200);
    const grid = await responseJson(gridResponse);
    expect(grid.currentSerial).toBe("emulator-5554");
    expect(grid.sessionStatus).toBe("streaming");
    expect(grid.devices).toEqual([
      {
        id: "emulator-5554",
        kind: "emulator",
        serial: "emulator-5554",
        avd: "Pixel_8",
        name: "Pixel_8",
        state: "device",
        current: true,
        canSelect: true,
        canStart: false,
        canStop: true,
      },
      {
        id: "usb-1",
        kind: "physical",
        serial: "usb-1",
        avd: null,
        name: "usb-1",
        state: "device",
        current: false,
        canSelect: true,
        canStart: false,
        canStop: false,
      },
      {
        id: "avd:Pixel_9",
        kind: "avd",
        serial: null,
        avd: "Pixel_9",
        name: "Pixel_9",
        state: "stopped",
        current: false,
        canSelect: false,
        canStart: true,
        canStop: false,
      },
    ]);

    const selectResponse = await router.handleRequest(
      post("/api/devices/select", { serial: "usb-1" }),
    );
    expect(selectResponse.status).toBe(200);
    expect(await responseJson(selectResponse)).toEqual({
      ok: true,
      serial: "usb-1",
      device: "Device usb-1",
    });

    const selected = await router.handleRequest(
      new Request("http://router.test/api/foreground"),
    );
    expect((await responseJson(selected)).serial).toBe("usb-1");

    const explicit = await router.handleRequest(
      new Request(
        "http://router.test/api/foreground?device=emulator-5554",
      ),
    );
    expect((await responseJson(explicit)).serial).toBe("emulator-5554");

    const stillSelected = await router.handleRequest(
      new Request("http://router.test/api/foreground"),
    );
    expect((await responseJson(stillSelected)).serial).toBe("usb-1");
    expect(state.created).toEqual(["usb-1", "emulator-5554"]);
  });

  test("starts, selects, discovers, and stops an AVD through UI routes", async () => {
    const state = {
      devices: [{ serial: "usb-1", state: "device" }],
      avds: ["Pixel_9"],
      running: [] as RunningAvd[],
      created: [] as string[],
      stopped: [] as string[],
    };
    const router = createRouter({}, routerDependencies(state));

    const startResponse = await router.handleRequest(
      post("/api/avds/start", { avd: "Pixel_9" }),
    );
    expect(startResponse.status).toBe(200);
    expect(await responseJson(startResponse)).toEqual({
      ok: true,
      serial: "emulator-5556",
      avd: "Pixel_9",
      device: "Device emulator-5556",
    });

    const selected = await router.handleRequest(
      new Request("http://router.test/api/foreground"),
    );
    expect((await responseJson(selected)).serial).toBe("emulator-5556");

    const gridResponse = await router.handleRequest(
      new Request("http://router.test/api/device-grid"),
    );
    const grid = await responseJson(gridResponse);
    expect(grid.currentSerial).toBe("emulator-5556");
    expect(
      (grid.devices as Array<JsonObject>).find(
        (device) => device.serial === "emulator-5556",
      ),
    ).toMatchObject({
      avd: "Pixel_9",
      current: true,
      canStop: true,
    });

    const stopResponse = await router.handleRequest(
      post("/api/avds/stop", { avd: "Pixel_9" }),
    );
    expect(stopResponse.status).toBe(200);
    expect(await responseJson(stopResponse)).toEqual({
      ok: true,
      serial: "emulator-5556",
    });
    expect(state.stopped).toEqual(["emulator-5556"]);

    const fallback = await router.handleRequest(
      new Request("http://router.test/api/foreground"),
    );
    expect((await responseJson(fallback)).serial).toBe("usb-1");
  });

  test("rejects an unavailable selection without replacing the current device", async () => {
    const state = {
      devices: [{ serial: "usb-1", state: "device" }],
      avds: [] as string[],
      running: [] as RunningAvd[],
      created: [] as string[],
      stopped: [] as string[],
    };
    const router = createRouter({}, routerDependencies(state));

    const response = await router.handleRequest(
      post("/api/devices/select", { serial: "missing" }),
    );
    expect(response.status).toBe(400);
    expect(await responseJson(response)).toEqual({
      ok: false,
      error: "device missing is not connected",
    });
    expect(await router.resolveSerial(null)).toBe("usb-1");
    expect(state.created).toEqual([]);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not reached");
}

function liveStreamSession(
  mode: StreamMode,
  onFatalListener?: (listener: Parameters<EmuSession["onFatal"]>[0]) => void,
): EmuSession {
  const frames = deferred<null>();
  const controls = new ControlInputQueue({
    writer: { async write() {} },
  });
  return {
    mode,
    inputSource: "scrcpy",
    serial: "emulator-5554",
    meta: {
      deviceName: `Pixel_8 (${mode})`,
      codecId: "h264",
      width: 1080,
      height: 1920,
    },
    controls,
    readFrame: () => frames.promise,
    onFatal(listener) {
      onFatalListener?.(listener);
      return () => {};
    },
    async close() {
      controls.close();
      frames.resolve(null);
    },
  };
}

describe("createApp session compatibility and cancellation", () => {
  test("keeps the raw scrcpy session public and exposes a neutral stream session", async () => {
    const proc = new EventEmitter();
    const controlSocket = new EventEmitter();
    const frame = deferred<null>();
    const raw = {
      proc,
      controlSocket,
      meta: {
        deviceName: "Pixel_8",
        codecId: "h264",
        width: 1080,
        height: 1920,
      },
    } as unknown as ScrcpySession;
    const stream = {
      mode: "scrcpy",
      serial: "emulator-5554",
      meta: raw.meta,
      rawScrcpy: raw,
      controls: {},
      readFrame: () => frame.promise,
      onFatal: () => () => {},
      close: async () => {
        frame.resolve(null);
      },
    } as unknown as EmuSession;

    const app = await createApp(
      { serial: "emulator-5554" },
      { startSession: async () => stream },
    );

    expect(app.session).toBe(raw);
    // This intentionally compiles through the default-scrcpy overload.
    expect(app.session.proc).toBe(raw.proc);
    expect(app.session.controlSocket).toBe(raw.controlSocket);
    expect(app.streamSession).toBe(stream);
    await app.stop();
  });

  test("passes cancellation through app startup", async () => {
    const controller = new AbortController();
    let startupSignal: AbortSignal | undefined;
    const starting = createApp(
      { serial: "emulator-5554", signal: controller.signal },
      {
        startSession: async (options) => {
          startupSignal = options.signal;
          return new Promise<EmuSession>((_resolve, reject) => {
            options.signal?.addEventListener(
              "abort",
              () => reject(options.signal?.reason),
              { once: true },
            );
          });
        },
      },
    );
    await waitFor(() => startupSignal !== undefined);

    controller.abort(new Error("test startup cancelled"));

    expect(startupSignal?.aborted).toBe(true);
    await expect(starting).rejects.toThrow("test startup cancelled");
  });

  test("retains structured fatal failure details on /health", async () => {
    const fatalListeners: Array<Parameters<EmuSession["onFatal"]>[0]> = [];
    const app = await createApp(
      { serial: "emulator-5554" },
      {
        startSession: async () =>
          liveStreamSession("scrcpy", (listener) => {
            fatalListeners.push(listener);
          }),
      },
    );

    const fatalListener = fatalListeners[0];
    if (!fatalListener) throw new Error("fatal listener was not registered");
    fatalListener({
      message: "encoder exited",
      code: "encoder-exit",
      meta: { exitCode: 23, phase: "encode" },
    });

    const response = await app.handleRequest(
      new Request("http://router.test/health"),
    );
    expect(response.status).toBe(503);
    expect(await responseJson(response)).toMatchObject({
      lastError: "encoder exited",
      lastErrorCode: "encoder-exit",
      lastErrorMeta: { exitCode: 23, phase: "encode" },
    });
    await app.stop();
  });
});

describe("createRouter stream mode", () => {
  test("rejects cross-origin browser mutations before starting a device", async () => {
    const state = {
      devices: [{ serial: "emulator-5554", state: "device" }],
      avds: [] as string[],
      running: [] as RunningAvd[],
      created: [] as string[],
      stopped: [] as string[],
    };
    const router = createRouter({}, routerDependencies(state));
    const response = await router.handleRequest(
      new Request("http://router.test/api/stream-mode", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://attacker.test",
        },
        body: JSON.stringify({ mode: "grpc-screenshot" }),
      }),
    );

    expect(response.status).toBe(403);
    expect(await responseJson(response)).toEqual({
      ok: false,
      error: {
        code: "forbidden",
        message: "Browser origin is not allowed to mutate serve-emu state",
      },
    });
    expect(state.created).toEqual([]);

    const otherMutation = await router.handleRequest(
      new Request("http://router.test/api/devices/select", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://attacker.test",
        },
        body: JSON.stringify({ serial: "emulator-5554" }),
      }),
    );
    expect(otherMutation.status).toBe(403);
    expect(state.created).toEqual([]);

    const mismatchedLoopbackOrigin = await router.handleRequest(
      new Request("http://127.0.0.1:3300/api/stream-mode", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:5173",
        },
        body: JSON.stringify({ mode: "grpc-screenshot" }),
      }),
    );
    expect(mismatchedLoopbackOrigin.status).toBe(403);
    expect(state.created).toEqual([]);
    await router.stopAll();
  });

  test("allows configured browser origins and origin-less agent mutations", async () => {
    const state = {
      devices: [{ serial: "emulator-5554", state: "device" }],
      avds: [] as string[],
      running: [] as RunningAvd[],
      created: [] as string[],
      stopped: [] as string[],
    };
    const router = createRouter(
      { allowedOrigins: ["https://trusted.test"] },
      routerDependencies(state),
    );

    const trusted = await router.handleRequest(
      new Request("http://router.test/api/stream-mode", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://trusted.test",
        },
        body: JSON.stringify({ mode: "scrcpy" }),
      }),
    );
    expect(trusted.status).toBe(200);
    expect(
      (
        await router.handleRequest(
          put("/api/stream-mode", { mode: "scrcpy" }),
        )
      ).status,
    ).toBe(200);
    await router.stopAll();
  });

  test("uses the shared stream mode request validation", async () => {
    const state = {
      devices: [{ serial: "emulator-5554", state: "device" }],
      avds: [] as string[],
      running: [] as RunningAvd[],
      created: [] as string[],
      stopped: [] as string[],
      createdModes: [] as StreamMode[],
      createdInputSources: [] as InputSource[],
    };
    const router = createRouter(
      { serial: "emulator-5554" },
      routerDependencies(state),
    );

    const response = await router.handleRequest(
      put("/api/stream-mode", { mode: "screen-copy" }),
    );
    expect(response.status).toBe(400);
    expect(await responseJson(response)).toEqual({
      ok: false,
      error: {
        code: "invalid_request",
        message: "stream mode request.mode is invalid",
      },
    });

    await router.stopAll();
  });

  test("reports the source and replaces it through the GET/PUT contract", async () => {
    const state = {
      devices: [{ serial: "emulator-5554", state: "device" }],
      avds: [] as string[],
      running: [] as RunningAvd[],
      created: [] as string[],
      stopped: [] as string[],
      createdModes: [] as StreamMode[],
      createdInputSources: [] as InputSource[],
    };
    const router = createRouter(
      { serial: "emulator-5554" },
      routerDependencies(state),
    );

    const initial = await router.handleRequest(
      new Request("http://router.test/api/stream-mode"),
    );
    expect(initial.status).toBe(200);
    expect(await responseJson(initial)).toEqual({
      ok: true,
      serial: "emulator-5554",
      mode: "scrcpy",
      grpcImageMode: "png",
      inputSource: "scrcpy",
      availableInputSources: ["scrcpy"],
      availableModes: ["scrcpy", "grpc-screenshot"],
      sessionGeneration: 0,
    });
    const methodNotAllowed = await router.handleRequest(
      new Request("http://router.test/api/stream-mode", { method: "POST" }),
    );
    expect(methodNotAllowed.status).toBe(405);
    expect(methodNotAllowed.headers.get("allow")).toBe("GET, PUT");
    expect(await responseJson(methodNotAllowed)).toEqual({
      ok: false,
      error: {
        code: "method_not_allowed",
        message: "Method must be GET or PUT",
      },
    });

    const switched = await router.handleRequest(
      put("/api/stream-mode", { mode: "grpc-screenshot" }),
    );
    expect(switched.status).toBe(200);
    expect(await responseJson(switched)).toEqual({
      ok: true,
      serial: "emulator-5554",
      mode: "grpc-screenshot",
      grpcImageMode: "png",
      inputSource: "scrcpy",
      availableInputSources: ["scrcpy", "grpc"],
      availableModes: ["scrcpy", "grpc-screenshot"],
      sessionGeneration: 1,
    });
    expect(state.createdModes).toEqual(["scrcpy", "grpc-screenshot"]);
    expect(state.createdInputSources).toEqual(["scrcpy", "scrcpy"]);
    expect(state.stopped).toEqual(["emulator-5554"]);

    const changedInput = await router.handleRequest(
      put("/api/stream-mode", {
        mode: "grpc-screenshot",
        inputSource: "grpc",
      }),
    );
    expect(changedInput.status).toBe(200);
    expect(await responseJson(changedInput)).toMatchObject({
      mode: "grpc-screenshot",
      inputSource: "grpc",
      sessionGeneration: 2,
    });
    expect(state.createdInputSources).toEqual([
      "scrcpy",
      "scrcpy",
      "grpc",
    ]);

    await router.stopAll();
    expect(state.stopped).toEqual([
      "emulator-5554",
      "emulator-5554",
      "emulator-5554",
    ]);
  });

  test("atomically replaces gRPC capture when its explicit image mode changes", async () => {
    const opened: Array<{ mode: StreamMode; grpcImageMode: string }> = [];
    const router = createRouter(
      { serial: "emulator-5554" },
      {
        listDevices: async () => [
          { serial: "emulator-5554", state: "device" },
        ],
        createApp: (options) =>
          createApp(options, {
            startSession: async ({ mode, grpcImageMode }) => {
              opened.push({ mode, grpcImageMode });
              return liveStreamSession(mode);
            },
          }),
      },
    );

    await router.handleRequest(
      new Request("http://router.test/api/stream-mode"),
    );
    const mmap = await router.handleRequest(
      put("/api/stream-mode", {
        mode: "grpc-screenshot",
        grpcImageMode: "mmap",
      }),
    );
    expect(await responseJson(mmap)).toMatchObject({
      mode: "grpc-screenshot",
      grpcImageMode: "mmap",
      sessionGeneration: 1,
    });

    const png = await router.handleRequest(
      put("/api/stream-mode", {
        mode: "grpc-screenshot",
        grpcImageMode: "png",
      }),
    );
    expect(await responseJson(png)).toMatchObject({
      mode: "grpc-screenshot",
      grpcImageMode: "png",
      sessionGeneration: 2,
    });
    expect(opened).toEqual([
      { mode: "scrcpy", grpcImageMode: "png" },
      { mode: "grpc-screenshot", grpcImageMode: "mmap" },
      { mode: "grpc-screenshot", grpcImageMode: "png" },
    ]);

    const invalid = await router.handleRequest(
      put("/api/stream-mode", {
        mode: "grpc-screenshot",
        grpcImageMode: "auto",
      }),
    );
    expect(invalid.status).toBe(400);
    expect(await responseJson(invalid)).toEqual({
      ok: false,
      error: {
        code: "invalid_request",
        message: "stream mode request.grpcImageMode is invalid",
      },
    });
    expect(opened).toHaveLength(3);

    await router.stopAll();
  });

  test("preserves authoritative encoder settings across source replacements", async () => {
    const opened: Array<{
      mode: StreamMode;
      maxSize: number | undefined;
      bitRate: number | undefined;
      maxFps: number | undefined;
    }> = [];
    const router = createRouter(
      { serial: "emulator-5554" },
      {
        listDevices: async () => [
          { serial: "emulator-5554", state: "device" },
        ],
        createApp: (options) =>
          createApp(options, {
            startSession: async (sessionOptions) => {
              opened.push({
                mode: sessionOptions.mode,
                maxSize: sessionOptions.maxSize,
                bitRate: sessionOptions.bitRate,
                maxFps: sessionOptions.maxFps,
              });
              return liveStreamSession(sessionOptions.mode);
            },
          }),
      },
    );

    await router.handleRequest(
      new Request("http://router.test/api/stream-mode"),
    );
    const settings = await router.handleRequest(
      new Request("http://router.test/api/stream-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          maxDimension: 640,
          h264Bitrate: 4_000_000,
          h264Fps: 48,
        }),
      }),
    );
    expect(settings.status).toBe(200);

    const switched = await router.handleRequest(
      put("/api/stream-mode", { mode: "grpc-screenshot" }),
    );
    expect(switched.status).toBe(200);
    expect(opened.at(-1)).toEqual({
      mode: "grpc-screenshot",
      maxSize: 640,
      bitRate: 4_000_000,
      maxFps: 48,
    });
    await router.stopAll();
  });

  test("serializes settings updates with source replacements", async () => {
    const releaseSettingsRestart = deferred<void>();
    let settingsRestartStarted = false;
    const opened: Array<{
      mode: StreamMode;
      maxSize: number | undefined;
      bitRate: number | undefined;
      maxFps: number | undefined;
    }> = [];
    const router = createRouter(
      { serial: "emulator-5554" },
      {
        listDevices: async () => [
          { serial: "emulator-5554", state: "device" },
        ],
        createApp: (options) =>
          createApp(options, {
            startSession: async (sessionOptions) => {
              opened.push({
                mode: sessionOptions.mode,
                maxSize: sessionOptions.maxSize,
                bitRate: sessionOptions.bitRate,
                maxFps: sessionOptions.maxFps,
              });
              if (
                sessionOptions.mode === "scrcpy" &&
                sessionOptions.maxSize === 640
              ) {
                settingsRestartStarted = true;
                await releaseSettingsRestart.promise;
              }
              return liveStreamSession(sessionOptions.mode);
            },
          }),
      },
    );

    await router.handleRequest(
      new Request("http://router.test/api/stream-mode"),
    );
    const settingsRequest = router.handleRequest(
      new Request("http://router.test/api/stream-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          maxDimension: 640,
          h264Bitrate: 4_000_000,
          h264Fps: 48,
        }),
      }),
    );
    await waitFor(() => settingsRestartStarted);
    const switchRequest = router.handleRequest(
      put("/api/stream-mode", { mode: "grpc-screenshot" }),
    );
    // Give an uncoordinated mode switch enough turns to snapshot stale values.
    for (let turn = 0; turn < 5; turn++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    releaseSettingsRestart.resolve();

    const [settings, switched] = await Promise.all([
      settingsRequest,
      switchRequest,
    ]);
    expect(settings.status).toBe(200);
    expect(switched.status).toBe(200);
    expect(opened.at(-1)).toEqual({
      mode: "grpc-screenshot",
      maxSize: 640,
      bitRate: 4_000_000,
      maxFps: 48,
    });
    await router.stopAll();
  });

  test("preserves recorded events when only the same device's source changes", async () => {
    const router = createRouter(
      { serial: "emulator-5554" },
      {
        listDevices: async () => [
          { serial: "emulator-5554", state: "device" },
        ],
        listAllDevices: async () => [
          { serial: "emulator-5554", state: "device" },
        ],
        createApp: (options) =>
          createApp(options, {
            startSession: async ({ mode }) => liveStreamSession(mode),
            setLocation: async () => {},
          }),
      },
    );

    const tap = await router.handleRequest(
      post("/api/tap", { x: 0.25, y: 0.75 }),
    );
    expect(tap.status).toBe(200);
    const location = await router.handleRequest(
      post("/api/location", {
        latitude: 52.3676,
        longitude: 4.9041,
      }),
    );
    expect(location.status).toBe(200);
    const route = await router.handleRequest(
      post("/api/route", {
        waypoints: [
          { latitude: 52.3676, longitude: 4.9041 },
          { latitude: 52.52, longitude: 13.405 },
        ],
        speedKph: 1,
        intervalMs: 60_000,
        loop: true,
      }),
    );
    expect(route.status).toBe(200);
    const before = await router.handleRequest(
      new Request("http://router.test/api/session"),
    );
    expect((await responseJson(before)).events).toHaveLength(2);
    const healthBefore = await responseJson(
      await router.handleRequest(
        new Request("http://router.test/health"),
      ),
    );
    expect((healthBefore.route as JsonObject).status).toBe("running");

    expect(
      (
        await router.handleRequest(
          put("/api/stream-mode", { mode: "grpc-screenshot" }),
        )
      ).status,
    ).toBe(200);

    const after = await router.handleRequest(
      new Request("http://router.test/api/session"),
    );
    expect((await responseJson(after)).events).toHaveLength(2);
    const healthAfter = await responseJson(
      await router.handleRequest(
        new Request("http://router.test/health"),
      ),
    );
    expect(healthAfter.location).toEqual(healthBefore.location);
    expect((healthAfter.route as JsonObject).status).toBe("running");
    await router.stopAll();
  });

  test("creates fresh device state when switching after a terminal failure", async () => {
    const fatalListeners = new Map<
      StreamMode,
      Parameters<EmuSession["onFatal"]>[0]
    >();
    const router = createRouter(
      { serial: "emulator-5554" },
      {
        listDevices: async () => [
          { serial: "emulator-5554", state: "device" },
        ],
        listAllDevices: async () => [
          { serial: "emulator-5554", state: "device" },
        ],
        createApp: (options) =>
          createApp(options, {
            startSession: async ({ mode }) =>
              liveStreamSession(mode, (listener) => {
                fatalListeners.set(mode, listener);
              }),
            setLocation: async () => {},
          }),
      },
    );

    const initial = await router.handleRequest(
      new Request("http://router.test/api/stream-mode"),
    );
    expect(initial.status).toBe(200);
    const failInitial = fatalListeners.get("scrcpy");
    if (!failInitial) throw new Error("fatal listener was not registered");
    failInitial({ message: "capture process exited" });

    const switched = await router.handleRequest(
      put("/api/stream-mode", { mode: "grpc-screenshot" }),
    );
    expect(switched.status).toBe(200);
    expect(await responseJson(switched)).toMatchObject({
      ok: true,
      mode: "grpc-screenshot",
      sessionGeneration: 1,
    });

    await router.stopAll();
  });

  test("retains device state when the old source fails during replacement startup", async () => {
    const fatalListeners = new Map<
      StreamMode,
      Parameters<EmuSession["onFatal"]>[0]
    >();
    const replacementStart = deferred<EmuSession>();
    const replacementRequested = deferred<void>();
    const router = createRouter(
      { serial: "emulator-5554" },
      {
        listDevices: async () => [
          { serial: "emulator-5554", state: "device" },
        ],
        listAllDevices: async () => [
          { serial: "emulator-5554", state: "device" },
        ],
        createApp: (options) =>
          createApp(options, {
            startSession: async ({ mode }) => {
              if (mode === "grpc-screenshot") {
                replacementRequested.resolve(undefined);
                return replacementStart.promise;
              }
              return liveStreamSession(mode, (listener) => {
                fatalListeners.set(mode, listener);
              });
            },
            setLocation: async () => {},
          }),
      },
    );

    expect(
      (
        await router.handleRequest(
          new Request("http://router.test/api/stream-mode"),
        )
      ).status,
    ).toBe(200);
    const failInitial = fatalListeners.get("scrcpy");
    if (!failInitial) throw new Error("fatal listener was not registered");

    const switching = router.handleRequest(
      put("/api/stream-mode", { mode: "grpc-screenshot" }),
    );
    await replacementRequested.promise;
    failInitial({
      message: "capture process exited during replacement startup",
    });
    replacementStart.resolve(liveStreamSession("grpc-screenshot"));

    const response = await switching;
    expect(response.status).toBe(200);
    expect(await responseJson(response)).toMatchObject({
      ok: true,
      mode: "grpc-screenshot",
      sessionGeneration: 1,
    });

    await router.stopAll();
  });

  test("stages replacements atomically and orders PUT/PUT/GET per device", async () => {
    const modesCreated: StreamMode[] = [];
    const stopped: string[] = [];
    const attachments: string[] = [];
    const grpcStart = deferred<EmuApp>();
    let appNumber = 0;

    const trackedApp = (mode: StreamMode): EmuApp => {
      const id = `${mode}:${++appNumber}`;
      let streaming = true;
      return {
        session: {
          mode,
          meta: { deviceName: "Pixel_8" },
        },
        isStreaming: () => streaming,
        health: () => ({ status: streaming ? "streaming" : "stopped" }),
        handleRequest: async () => Response.json({ id, mode }),
        attachWebSocket: () => {
          attachments.push(id);
        },
        stop: async () => {
          if (!streaming) return;
          streaming = false;
          stopped.push(id);
        },
      } as unknown as EmuApp;
    };

    const createDeviceApp = async (opts: AppOptions): Promise<EmuApp> => {
      const mode = opts.streamMode ?? "scrcpy";
      modesCreated.push(mode);
      if (mode === "grpc-screenshot") return grpcStart.promise;
      return trackedApp(mode);
    };
    const router = createRouter(
      { serial: "emulator-5554" },
      {
        listDevices: async () => [
          { serial: "emulator-5554", state: "device" },
        ],
        listAllDevices: async () => [
          { serial: "emulator-5554", state: "device" },
        ],
        createApp: createDeviceApp,
      },
    );

    await router.handleRequest(
      new Request("http://router.test/api/stream-mode"),
    );
    const grpcRequest = router.handleRequest(
      put("/api/stream-mode", { mode: "grpc-screenshot" }),
    );
    await waitFor(() => modesCreated.length === 2);

    router.attachWebSocket({} as never, {
      serial: "emulator-5554",
      frameMeta: true,
    });
    expect(attachments).toEqual(["scrcpy:1"]);

    const scrcpyRequest = router.handleRequest(
      put("/api/stream-mode", { mode: "scrcpy" }),
    );
    grpcStart.resolve(trackedApp("grpc-screenshot"));
    await waitFor(() => modesCreated.length === 3);
    const readAfterBoth = router.handleRequest(
      new Request("http://router.test/api/stream-mode"),
    );

    expect(await responseJson(await grpcRequest)).toMatchObject({
      mode: "grpc-screenshot",
      sessionGeneration: 1,
    });
    expect(await responseJson(await scrcpyRequest)).toMatchObject({
      mode: "scrcpy",
      sessionGeneration: 2,
    });
    expect(await responseJson(await readAfterBoth)).toMatchObject({
      mode: "scrcpy",
      sessionGeneration: 2,
    });
    expect(modesCreated).toEqual([
      "scrcpy",
      "grpc-screenshot",
      "scrcpy",
    ]);
    expect(stopped).toEqual(["scrcpy:1", "grpc-screenshot:2"]);
  });

  test("keeps the active source when replacement startup fails", async () => {
    const stopped: string[] = [];
    const router = createRouter(
      { serial: "emulator-5554" },
      {
        listDevices: async () => [
          { serial: "emulator-5554", state: "device" },
        ],
        listAllDevices: async () => [
          { serial: "emulator-5554", state: "device" },
        ],
        createApp: async ({ serial, streamMode }) => {
          if (streamMode === "grpc-screenshot") {
            throw new Error("gRPC startup failed");
          }
          return fakeApp(serial, stopped, "scrcpy");
        },
      },
    );
    await router.handleRequest(
      new Request("http://router.test/api/stream-mode"),
    );

    const failed = await router.handleRequest(
      put("/api/stream-mode", { mode: "grpc-screenshot" }),
    );
    expect(failed.status).toBe(503);
    expect(await responseJson(failed)).toEqual({
      ok: false,
      error: {
        code: "service_unavailable",
        message: "gRPC startup failed",
      },
    });

    const current = await router.handleRequest(
      new Request("http://router.test/api/stream-mode"),
    );
    expect(await responseJson(current)).toMatchObject({
      mode: "scrcpy",
      sessionGeneration: 0,
    });
    expect(stopped).toEqual([]);
  });

  test("keeps the active source when a staged replacement stops before publication", async () => {
    const stopped: string[] = [];
    const router = createRouter(
      { serial: "emulator-5554" },
      {
        listDevices: async () => [
          { serial: "emulator-5554", state: "device" },
        ],
        listAllDevices: async () => [
          { serial: "emulator-5554", state: "device" },
        ],
        createApp: async ({ serial, streamMode }) => {
          const app = fakeApp(serial, stopped, streamMode ?? "scrcpy");
          if (streamMode === "grpc-screenshot") {
            app.isStreaming = () => false;
          }
          return app;
        },
      },
    );
    await router.handleRequest(
      new Request("http://router.test/api/stream-mode"),
    );

    const failed = await router.handleRequest(
      put("/api/stream-mode", { mode: "grpc-screenshot" }),
    );
    expect(failed.status).toBe(503);
    expect(await responseJson(failed)).toEqual({
      ok: false,
      error: {
        code: "service_unavailable",
        message: "grpc-screenshot stopped before publication",
      },
    });

    const current = await router.handleRequest(
      new Request("http://router.test/api/stream-mode"),
    );
    expect(await responseJson(current)).toMatchObject({
      mode: "scrcpy",
      sessionGeneration: 0,
    });
    expect(stopped).toEqual(["emulator-5554"]);
    await router.stopAll();
  });

  test("rejects gRPC for physical devices before creating an app", async () => {
    const state = {
      devices: [{ serial: "usb-1", state: "device" }],
      avds: [] as string[],
      running: [] as RunningAvd[],
      created: [] as string[],
      stopped: [] as string[],
    };
    const router = createRouter({}, routerDependencies(state));

    const response = await router.handleRequest(
      put("/api/stream-mode", { mode: "grpc-screenshot" }),
    );
    expect(response.status).toBe(400);
    expect(await responseJson(response)).toEqual({
      ok: false,
      error: {
        code: "invalid_request",
        message:
          "grpc-screenshot is only available for Android Emulator devices",
      },
    });
    expect(state.created).toEqual([]);
  });

  test("stopAll aborts an initial app startup instead of waiting for its timeout", async () => {
    let startupSignal: AbortSignal | undefined;
    const router = createRouter(
      { serial: "emulator-5554" },
      {
        listDevices: async () => [
          { serial: "emulator-5554", state: "device" },
        ],
        listAllDevices: async () => [
          { serial: "emulator-5554", state: "device" },
        ],
        createApp: async (options) => {
          startupSignal = options.signal;
          return new Promise<EmuApp>((_resolve, reject) => {
            options.signal?.addEventListener(
              "abort",
              () => reject(options.signal?.reason),
              { once: true },
            );
          });
        },
      },
    );
    const request = router.handleRequest(
      new Request("http://router.test/api/foreground"),
    );
    await waitFor(() => startupSignal !== undefined);

    const stopping = router.stopAll();

    expect(startupSignal?.aborted).toBe(true);
    expect((await request).status).toBe(503);
    await stopping;
  });

  test("stopAll closes the live app while aborting a staged source", async () => {
    const events: string[] = [];
    let replacementSignal: AbortSignal | undefined;
    const router = createRouter(
      { serial: "emulator-5554" },
      {
        listDevices: async () => [
          { serial: "emulator-5554", state: "device" },
        ],
        listAllDevices: async () => [
          { serial: "emulator-5554", state: "device" },
        ],
        createApp: async ({ serial, streamMode, signal }) => {
          if (streamMode !== "grpc-screenshot") {
            const app = fakeApp(serial, [], "scrcpy");
            app.stop = async () => {
              events.push("stop-live");
            };
            return app;
          }
          replacementSignal = signal;
          return new Promise<EmuApp>((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => {
                events.push("abort-replacement");
                reject(signal.reason);
              },
              { once: true },
            );
          });
        },
      },
    );
    await router.handleRequest(
      new Request("http://router.test/api/stream-mode"),
    );
    const switching = router.handleRequest(
      put("/api/stream-mode", { mode: "grpc-screenshot" }),
    );
    await waitFor(() => replacementSignal !== undefined);

    const stopping = router.stopAll();

    expect(replacementSignal?.aborted).toBe(true);
    expect(events).toContain("abort-replacement");
    expect(events).toContain("stop-live");
    expect((await switching).status).toBe(503);
    await stopping;
  });

  test("stopping an AVD aborts its staged source before awaiting it", async () => {
    const events: string[] = [];
    const releaseReplacement = deferred<never>();
    let replacementSignal: AbortSignal | undefined;
    const router = createRouter(
      { serial: "emulator-5554" },
      {
        listDevices: async () => [
          { serial: "emulator-5554", state: "device" },
        ],
        listAllDevices: async () => [
          { serial: "emulator-5554", state: "device" },
        ],
        createApp: async ({ serial, streamMode, signal }) => {
          if (streamMode !== "grpc-screenshot") {
            const app = fakeApp(serial, [], "scrcpy");
            app.stop = async () => {
              events.push("stop-live");
            };
            return app;
          }
          replacementSignal = signal;
          signal?.addEventListener(
            "abort",
            () => events.push("abort-replacement"),
            { once: true },
          );
          return releaseReplacement.promise;
        },
        stopEmulator: async () => {
          events.push("stop-emulator");
        },
      },
    );
    await router.handleRequest(
      new Request("http://router.test/api/stream-mode"),
    );
    const switching = router.handleRequest(
      put("/api/stream-mode", { mode: "grpc-screenshot" }),
    );
    await waitFor(() => replacementSignal !== undefined);

    const stopping = router.handleRequest(
      post("/api/avds/stop", { serial: "emulator-5554" }),
    );
    await waitFor(() => replacementSignal?.aborted === true);

    expect(events).toContain("abort-replacement");
    expect(events).toContain("stop-live");
    expect(events).not.toContain("stop-emulator");
    releaseReplacement.reject(new Error("replacement cancelled"));

    expect((await switching).status).toBe(503);
    expect((await stopping).status).toBe(200);
    expect(events.at(-1)).toBe("stop-emulator");
  });
});
