import { describe, expect, test } from "bun:test";
import type { Device } from "./adb.ts";
import {
  createRouter,
  type AppOptions,
  type EmuApp,
  type RouterDependencies,
} from "./middleware.ts";
import type { EmuBackend, EmuSession } from "./session.ts";

type FakeAppRecord = {
  app: EmuApp;
  crash: () => void;
  stopCount: () => number;
};

function fakeApp(serial: string, backend: EmuBackend, events: string[]): FakeAppRecord {
  let streaming = true;
  let stops = 0;
  const session: EmuSession = {
    transport: backend,
    serial,
    meta: {
      deviceName: backend === "grpc" ? "fake-emulator" : "fake-android",
      codecId: "h264",
      width: 576,
      height: 1280,
    },
    readFrame: async () => null,
    sendGesture: async () => {},
    resetVideo: () => {},
    onFatal: () => {},
    close: () => {},
  };
  const app = {
    session,
    isStreaming: () => streaming,
    health: () => ({ status: streaming ? "streaming" : "stopped" }),
    handleRequest: async () => Response.json({ ok: true }),
    attachWebSocket: () => {},
    stop: () => {
      events.push(`stop:${backend}`);
      stops++;
      streaming = false;
    },
  } as unknown as EmuApp;
  return {
    app,
    crash: () => {
      streaming = false;
    },
    stopCount: () => stops,
  };
}

function testRouter(serial = "emulator-5554", defaultBackend: EmuBackend = "grpc") {
  const devices: Device[] = [{ serial, state: "device" }];
  const calls: AppOptions[] = [];
  const created: FakeAppRecord[] = [];
  const events: string[] = [];
  let failingBackend: EmuBackend | null = null;
  let beforeCreate: ((opts: AppOptions) => Promise<void>) | null = null;
  const dependencies: RouterDependencies = {
    listAllDevices: () => devices,
    listDevices: () => devices,
    createApp: async (opts) => {
      calls.push({ ...opts });
      const backend = opts.backend ?? "scrcpy";
      events.push(`create:${backend}`);
      if (backend === failingBackend) throw new Error(`${backend} unavailable`);
      if (beforeCreate) await beforeCreate(opts);
      const record = fakeApp(opts.serial, backend, events);
      created.push(record);
      return record.app;
    },
  };
  return {
    router: createRouter({ serial, backend: defaultBackend }, dependencies),
    calls,
    created,
    events,
    failOn: (backend: EmuBackend | null) => {
      failingBackend = backend;
    },
    beforeEachCreate: (hook: ((opts: AppOptions) => Promise<void>) | null) => {
      beforeCreate = hook;
    },
  };
}

const streamModeRequest = (serial: string, init?: RequestInit) =>
  new Request(`http://serve-emu.test/api/stream-mode?device=${serial}`, init);

describe("runtime stream mode selection", () => {
  test("reports the active transport and treats the current mode as a no-op", async () => {
    const { router, calls, created } = testRouter();

    const initial = await router.handleRequest(streamModeRequest("emulator-5554"));
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({
      ok: true,
      mode: "grpc-screenshot",
      transport: "grpc",
      availableModes: ["scrcpy", "grpc-screenshot"],
    });

    const same = await router.handleRequest(
      streamModeRequest("emulator-5554", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "grpc-screenshot" }),
      }),
    );
    expect(same.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(created[0]?.stopCount()).toBe(0);
  });

  test("stages the requested backend before stopping and replacing the old app", async () => {
    const { router, calls, created, events } = testRouter();
    await router.ensure("emulator-5554");

    const response = await router.handleRequest(
      streamModeRequest("emulator-5554", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "scrcpy" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ mode: "scrcpy", transport: "scrcpy" });
    expect(events).toEqual(["create:grpc", "create:scrcpy", "stop:grpc"]);
    expect(calls[1]).toMatchObject({ backend: "scrcpy", strictBackend: true });
    expect(created[0]?.stopCount()).toBe(1);
    expect((await router.ensure("emulator-5554")).app).toBe(created[1]?.app);
  });

  test("keeps the existing stream when a replacement cannot start", async () => {
    const { router, created, failOn } = testRouter();
    const original = (await router.ensure("emulator-5554")).app;
    failOn("scrcpy");

    const response = await router.handleRequest(
      streamModeRequest("emulator-5554", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "scrcpy" }),
      }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, error: "scrcpy unavailable" });
    expect(created[0]?.stopCount()).toBe(0);
    expect((await router.ensure("emulator-5554")).app).toBe(original);
  });

  test("persists a successful selection when a dead app is recreated", async () => {
    const { router, calls, created } = testRouter();
    await router.ensure("emulator-5554");
    await router.handleRequest(
      streamModeRequest("emulator-5554", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "scrcpy" }),
      }),
    );

    created[1]?.crash();
    await router.ensure("emulator-5554");
    expect(calls[2]).toMatchObject({ backend: "scrcpy", strictBackend: true });
  });

  test("serializes conflicting requests in arrival order", async () => {
    const { router, beforeEachCreate } = testRouter("emulator-5554", "scrcpy");
    await router.ensure("emulator-5554");

    let releaseFirstGrpc!: () => void;
    let firstGrpcStarted!: () => void;
    const firstGrpcGate = new Promise<void>((resolve) => {
      releaseFirstGrpc = resolve;
    });
    const sawFirstGrpc = new Promise<void>((resolve) => {
      firstGrpcStarted = resolve;
    });
    let delayGrpc = true;
    beforeEachCreate(async (opts) => {
      if (opts.backend !== "grpc" || !delayGrpc) return;
      delayGrpc = false;
      firstGrpcStarted();
      await firstGrpcGate;
    });

    const first = router.handleRequest(
      streamModeRequest("emulator-5554", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "grpc-screenshot" }),
      }),
    );
    await sawFirstGrpc;
    const second = router.handleRequest(
      streamModeRequest("emulator-5554", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "scrcpy" }),
      }),
    );
    const third = router.handleRequest(
      streamModeRequest("emulator-5554", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "grpc-screenshot" }),
      }),
    );
    releaseFirstGrpc();

    const responses = await Promise.all([first, second, third]);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect((await router.ensure("emulator-5554")).app.session.transport).toBe("grpc");
  });

  test("stops a staged replacement that resolves after router shutdown", async () => {
    const { router, beforeEachCreate, created } = testRouter();
    await router.ensure("emulator-5554");

    let releaseReplacement!: () => void;
    let replacementStarted!: () => void;
    const replacementGate = new Promise<void>((resolve) => {
      releaseReplacement = resolve;
    });
    const sawReplacement = new Promise<void>((resolve) => {
      replacementStarted = resolve;
    });
    beforeEachCreate(async (opts) => {
      if (opts.backend !== "scrcpy") return;
      replacementStarted();
      await replacementGate;
    });

    const switching = router.handleRequest(
      streamModeRequest("emulator-5554", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "scrcpy" }),
      }),
    );
    await sawReplacement;
    router.stopAll();
    releaseReplacement();

    expect((await switching).status).toBe(503);
    expect(created.map((record) => record.stopCount())).toEqual([1, 1]);
    expect(router.getActiveApp("emulator-5554")).toBeUndefined();
  });

  test("rejects invalid modes and emulator-only gRPC on physical devices", async () => {
    const emulator = testRouter();
    await emulator.router.ensure("emulator-5554");
    const invalid = await emulator.router.handleRequest(
      streamModeRequest("emulator-5554", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "grpc" }),
      }),
    );
    expect(invalid.status).toBe(400);
    expect(emulator.calls).toHaveLength(1);

    const physical = testRouter("physical-device", "scrcpy");
    const initial = await physical.router.handleRequest(streamModeRequest("physical-device"));
    expect(await initial.json()).toMatchObject({ availableModes: ["scrcpy"] });
    const unsupported = await physical.router.handleRequest(
      streamModeRequest("physical-device", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "grpc-screenshot" }),
      }),
    );
    expect(unsupported.status).toBe(400);
    expect(physical.calls).toHaveLength(1);
    expect(physical.created[0]?.stopCount()).toBe(0);
  });
});
