import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Device } from "../src/adb.ts";
import { cameraFeedPath, placeholderCameraImage } from "../src/camera.ts";
import type { RunningAvd } from "../src/emulator.ts";
import {
  createRouter,
  type EmuApp,
  type RouterDependencies,
} from "../src/middleware.ts";
import {
  parseCameraStatusResponse,
  type CameraFacing,
  type CameraFeedStatus,
  type CameraStatus,
} from "../src/shared/api-contracts.ts";
import { solidPng } from "./fixtures/png.ts";

type JsonObject = Record<string, unknown>;

const SERIAL = "emulator-5554";
const LAUNCHED = "emulator-5556";

async function responseJson(response: Response): Promise<JsonObject> {
  return (await response.json()) as JsonObject;
}

function get(path: string): Request {
  return new Request(`http://router.test${path}`);
}

function post(path: string, body: JsonObject): Request {
  return new Request(`http://router.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function postImage(path: string, png: Uint8Array): Request {
  return new Request(`http://router.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "image/png" },
    body: Uint8Array.from(png),
  });
}

function del(path: string): Request {
  return new Request(`http://router.test${path}`, { method: "DELETE" });
}

function fakeApp(serial: string, stopped: string[]): EmuApp {
  return {
    session: { mode: "scrcpy", meta: { deviceName: `Device ${serial}` } },
    isStreaming: () => true,
    health: () => ({ status: "streaming" }),
    handleRequest: async (request: Request) =>
      Response.json({ serial, path: new URL(request.url).pathname }),
    attachWebSocket: () => {},
    stop: async () => {
      stopped.push(serial);
    },
  } as unknown as EmuApp;
}

type FakeState = {
  devices: Device[];
  avds: string[];
  running: RunningAvd[];
  created: string[];
  stopped: string[];
  launches: number;
  cameraFeed: boolean;
  cameraWired: boolean;
};

function fakeState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    devices: [],
    avds: [],
    running: [],
    created: [],
    stopped: [],
    launches: 0,
    cameraFeed: false,
    cameraWired: false,
    ...overrides,
  };
}

function routerDependencies(state: FakeState): RouterDependencies {
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
    createApp: async ({ serial }) => {
      state.created.push(serial);
      return fakeApp(serial, state.stopped);
    },
    startEmulator: async ({ avd }) => {
      state.launches += 1;
      const running = state.running.find((entry) => entry.avd === avd);
      if (running) {
        return {
          serial: running.serial,
          proc: null,
          ownsProcess: false,
          cameraFeed: false,
          stop: () => {},
        };
      }
      state.devices.push({ serial: LAUNCHED, state: "device" });
      state.running.push({ serial: LAUNCHED, avd, state: "device" });
      return {
        serial: LAUNCHED,
        proc: null,
        ownsProcess: true,
        cameraFeed: state.cameraFeed,
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
    readCameraWiring: async () => state.cameraWired,
  };
}

function onlineState(overrides: Partial<FakeState> = {}): FakeState {
  return fakeState({ devices: [{ serial: SERIAL, state: "device" }], ...overrides });
}

function runningAvdState(
  avd: string,
  overrides: Partial<FakeState> = {},
): FakeState {
  return fakeState({
    avds: [avd],
    devices: [
      { serial: SERIAL, state: "device" },
      { serial: LAUNCHED, state: "device" },
    ],
    running: [{ serial: LAUNCHED, avd, state: "device" }],
    ...overrides,
  });
}

async function cameraStatus(response: Response): Promise<CameraStatus> {
  return parseCameraStatusResponse(await response.json()).camera;
}

function feed(status: CameraStatus, facing: CameraFacing): CameraFeedStatus {
  const found = status.feeds.find((entry) => entry.facing === facing);
  if (!found) throw new Error(`status has no ${facing} feed`);
  return found;
}

function digestOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

let root: string;
const previousRoot = process.env.SERVE_EMU_CAMERA_DIR;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "serve-emu-middleware-camera-"));
  process.env.SERVE_EMU_CAMERA_DIR = root;
});

afterEach(async () => {
  if (previousRoot === undefined) delete process.env.SERVE_EMU_CAMERA_DIR;
  else process.env.SERVE_EMU_CAMERA_DIR = previousRoot;
  await rm(root, { recursive: true, force: true });
});

describe("createRouter camera routes", () => {
  test("reports an unwired serial and still names the flags that would wire it", async () => {
    const router = createRouter({}, routerDependencies(onlineState()));

    const status = await cameraStatus(
      await router.handleRequest(get("/api/camera")),
    );

    expect(status).toMatchObject({
      serial: SERIAL,
      supported: true,
      wiredAtLaunch: false,
    });
    expect(status.launchArgs).toEqual([
      "-camera-back",
      `imagefile:${cameraFeedPath(SERIAL, "back")}`,
      "-camera-front",
      `imagefile:${cameraFeedPath(SERIAL, "front")}`,
    ]);
  });

  test("reports the wiring the running emulator's config yields", async () => {
    const readWired = async (state: FakeState) => {
      const router = createRouter({}, routerDependencies(state));
      return (
        await cameraStatus(await router.handleRequest(get("/api/camera")))
      ).wiredAtLaunch;
    };

    expect(await readWired(onlineState({ cameraWired: true }))).toBe(true);
    expect(await readWired(onlineState())).toBe(false);
  });

  test("a posted PNG becomes the reported feed for its facing", async () => {
    const router = createRouter({}, routerDependencies(onlineState()));
    const png = solidPng(64, 48, [1, 2, 3]);

    const posted = await router.handleRequest(
      postImage("/api/camera/image?facing=front", png),
    );
    expect(posted.status).toBe(200);

    const status = await cameraStatus(
      await router.handleRequest(get("/api/camera")),
    );
    expect(feed(status, "front")).toMatchObject({
      present: true,
      placeholder: false,
      width: 64,
      height: 48,
      bytes: png.byteLength,
      digest: digestOf(png),
    });
    expect(feed(status, "back").present).toBe(false);
  });

  test("serves the stored PNG back byte for byte and 404s before a feed exists", async () => {
    const router = createRouter({}, routerDependencies(onlineState()));
    const png = solidPng(48, 36, [9, 8, 7]);

    const missing = await router.handleRequest(
      get("/api/camera/image?facing=front"),
    );
    expect(missing.status).toBe(404);
    expect(await responseJson(missing)).toMatchObject({
      ok: false,
      code: "not_found",
      error: expect.stringContaining("no camera image is set"),
    });

    expect(
      (
        await router.handleRequest(
          postImage("/api/camera/image?facing=front", png),
        )
      ).status,
    ).toBe(200);

    const served = await router.handleRequest(
      get("/api/camera/image?facing=front"),
    );
    expect(served.status).toBe(200);
    expect(served.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(
      Uint8Array.from(png),
    );
  });

  test("DELETE restores the placeholder image", async () => {
    const router = createRouter({}, routerDependencies(onlineState()));
    const png = solidPng(32, 24, [4, 5, 6]);

    expect(
      (
        await router.handleRequest(
          postImage("/api/camera/image?facing=back", png),
        )
      ).status,
    ).toBe(200);

    const cleared = await cameraStatus(
      await router.handleRequest(del("/api/camera/image?facing=back")),
    );
    expect(feed(cleared, "back")).toMatchObject({
      placeholder: true,
      digest: placeholderCameraImage().digest,
    });
  });

  test("rejects a JPEG body and leaves the live feed alone", async () => {
    const router = createRouter({}, routerDependencies(onlineState()));
    const png = solidPng(40, 30, [2, 2, 2]);
    expect(
      (
        await router.handleRequest(
          postImage("/api/camera/image?facing=back", png),
        )
      ).status,
    ).toBe(200);

    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(64).fill(0)]);
    const response = await router.handleRequest(
      postImage("/api/camera/image?facing=back", jpeg),
    );
    expect(response.status).toBe(400);
    expect(await responseJson(response)).toMatchObject({
      ok: false,
      error: expect.stringContaining("PNG only"),
    });

    const status = await cameraStatus(
      await router.handleRequest(get("/api/camera")),
    );
    expect(feed(status, "back").digest).toBe(digestOf(png));
  });

  test("rejects an unknown facing", async () => {
    const router = createRouter({}, routerDependencies(onlineState()));

    const response = await router.handleRequest(
      postImage("/api/camera/image?facing=selfie", solidPng(16, 16, [0, 0, 0])),
    );

    expect(response.status).toBe(400);
    expect(await responseJson(response)).toMatchObject({
      ok: false,
      error: expect.stringContaining("facing must be one of"),
    });
  });

  test("refuses a non-boolean camera flag instead of launching without feeds", async () => {
    const state = onlineState({ avds: ["Pixel_9"], cameraFeed: true });
    const router = createRouter({}, routerDependencies(state));

    const response = await router.handleRequest(
      post("/api/avds/start", { avd: "Pixel_9", camera: "yes" }),
    );

    expect(response.status).toBe(400);
    expect(await responseJson(response)).toMatchObject({
      ok: false,
      error: expect.stringContaining("camera must be a boolean"),
    });
    expect(state.launches).toBe(0);
  });

  test("refuses a camera launch that reused an unwired running AVD", async () => {
    const state = runningAvdState("Pixel_9");
    const router = createRouter({}, routerDependencies(state));

    const response = await router.handleRequest(
      post("/api/avds/start", { avd: "Pixel_9", camera: true, select: false }),
    );

    expect(response.status).toBe(400);
    expect(await responseJson(response)).toMatchObject({
      ok: false,
      error: expect.stringContaining("already running"),
    });
  });

  test("accepts a camera launch that reused an already wired running AVD", async () => {
    const state = runningAvdState("Pixel_9", { cameraWired: true });
    const router = createRouter({}, routerDependencies(state));

    const response = await router.handleRequest(
      post("/api/avds/start", { avd: "Pixel_9", camera: true, select: false }),
    );

    expect(response.status).toBe(200);
    expect(await responseJson(response)).toEqual({
      ok: true,
      serial: LAUNCHED,
      avd: "Pixel_9",
    });
  });

  test("camera routes never start a stream session", async () => {
    const state = onlineState();
    const router = createRouter({}, routerDependencies(state));
    const png = solidPng(24, 24, [6, 6, 6]);

    expect((await router.handleRequest(get("/api/camera"))).status).toBe(200);
    expect(
      (
        await router.handleRequest(
          postImage("/api/camera/image?facing=front", png),
        )
      ).status,
    ).toBe(200);
    expect(
      (await router.handleRequest(get("/api/camera/image?facing=front"))).status,
    ).toBe(200);
    expect(
      (await router.handleRequest(del("/api/camera/image?facing=front"))).status,
    ).toBe(200);

    expect(state.created).toEqual([]);
  });

  test("rejects a cross-origin browser upload before touching the feed", async () => {
    const state = onlineState();
    const router = createRouter({}, routerDependencies(state));

    const response = await router.handleRequest(
      new Request("http://router.test/api/camera/image?facing=back", {
        method: "POST",
        headers: {
          "Content-Type": "image/png",
          Origin: "https://attacker.test",
        },
        body: Uint8Array.from(solidPng(16, 16, [1, 1, 1])),
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

    const status = await cameraStatus(
      await router.handleRequest(get("/api/camera")),
    );
    expect(feed(status, "back").present).toBe(false);
  });
});
