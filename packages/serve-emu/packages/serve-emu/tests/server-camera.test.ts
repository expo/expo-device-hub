import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlInputQueue } from "../src/control-input-queue.ts";
import {
  cameraFeedPath,
  placeholderCameraImage,
  readCameraFeed,
} from "../src/camera.ts";
import { solidPng } from "./fixtures/png.ts";
import { startServer, type ServerDependencies } from "../src/server.ts";
import { parseCameraStatusResponse } from "../src/shared/api-contracts.ts";
import type { EmuSession } from "../src/stream-session.ts";

const SERIAL = "emulator-5554";

function fakeSession(serial: string): EmuSession {
  let resolveEnd: (value: null) => void = () => {};
  const end = new Promise<null>((resolve) => {
    resolveEnd = resolve;
  });
  const controls = new ControlInputQueue({ writer: { async write() {} } });
  return {
    mode: "scrcpy",
    inputSource: "scrcpy",
    serial,
    meta: { deviceName: serial, codecId: "h264", width: 720, height: 1280 },
    controls,
    readFrame: () => end,
    onFatal: () => () => {},
    async close() {
      controls.close();
      resolveEnd(null);
    },
  };
}

type CapturedServer = { options: Record<string, unknown> | null };

function capturingServe(captured: CapturedServer): typeof Bun.serve {
  return ((options: Record<string, unknown>) => {
    captured.options = options;
    return { port: 3300, stop() {} };
  }) as unknown as typeof Bun.serve;
}

function request(
  captured: CapturedServer,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const fetch = captured.options?.fetch as
    | ((request: Request, server: unknown) => Promise<Response>)
    | undefined;
  if (!fetch) throw new Error("server fetch handler was not captured");
  return fetch(new Request(`http://127.0.0.1:3300${path}`, init), {
    upgrade: () => false,
  });
}

function postImage(
  captured: CapturedServer,
  body: BodyInit,
  query = "",
): Promise<Response> {
  return request(captured, `/api/camera/image${query}`, {
    method: "POST",
    headers: { "Content-Type": "image/png" },
    body,
  });
}

function reattachedLaunch() {
  return {
    serial: "emulator-5558",
    proc: null,
    ownsProcess: false,
    cameraFeed: false,
    stop: () => {},
  };
}

async function readWired(captured: CapturedServer): Promise<boolean> {
  return parseCameraStatusResponse(
    await (await request(captured, "/api/camera")).json(),
  ).camera.wiredAtLaunch;
}

async function withServer(
  run: (captured: CapturedServer) => Promise<void>,
  extra: ServerDependencies = {},
): Promise<void> {
  const captured: CapturedServer = { options: null };
  const started = await startServer(
    { serial: SERIAL, port: 3300 },
    {
      openSession: async (options) => fakeSession(options.serial),
      serve: capturingServe(captured),
      readCameraWiring: async () => false,
      ...extra,
    },
  );
  try {
    await run(captured);
  } finally {
    await started.stop();
  }
}

let root: string;
const previousRoot = process.env.SERVE_EMU_CAMERA_DIR;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "serve-emu-server-camera-"));
  process.env.SERVE_EMU_CAMERA_DIR = root;
});

afterEach(async () => {
  if (previousRoot === undefined) delete process.env.SERVE_EMU_CAMERA_DIR;
  else process.env.SERVE_EMU_CAMERA_DIR = previousRoot;
  await rm(root, { recursive: true, force: true });
});

describe("standalone server camera image API", () => {
  test("reports an unwired launch but still names the flags that would wire it", async () => {
    await withServer(async (captured) => {
      const status = parseCameraStatusResponse(
        await (await request(captured, "/api/camera")).json(),
      ).camera;
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
      expect(status.feeds.map((feed) => feed.present)).toEqual([false, false]);
    });
  });

  test("reports the wiring the running emulator's config yields", async () => {
    await withServer(
      async (captured) => {
        expect(await readWired(captured)).toBe(true);
      },
      { readCameraWiring: async () => true },
    );
    await withServer(async (captured) => {
      expect(await readWired(captured)).toBe(false);
    });
  });

  test("POST writes the PNG to the requested facing and DELETE restores the placeholder", async () => {
    await withServer(async (captured) => {
      const png = solidPng(640, 480, [3, 4, 5]);

      const posted = parseCameraStatusResponse(
        await (await postImage(captured, Uint8Array.from(png), "?facing=front")).json(),
      ).camera;
      expect(posted.feeds.find((feed) => feed.facing === "front")).toMatchObject({
        present: true,
        placeholder: false,
        width: 640,
        height: 480,
      });
      expect(posted.feeds.find((feed) => feed.facing === "back")?.present).toBe(false);

      const cleared = parseCameraStatusResponse(
        await (
          await request(captured, "/api/camera/image?facing=front", {
            method: "DELETE",
          })
        ).json(),
      ).camera;
      expect(cleared.feeds.find((feed) => feed.facing === "front")).toMatchObject({
        placeholder: true,
        width: 1280,
      });
    });
  });

  test("rejects a non-PNG body and leaves the live feed alone", async () => {
    await withServer(async (captured) => {
      const png = placeholderCameraImage().png;
      expect((await postImage(captured, Uint8Array.from(png))).status).toBe(200);

      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(64).fill(0)]);
      const response = await postImage(captured, Uint8Array.from(jpeg));
      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain("PNG only");
      expect((await readCameraFeed(SERIAL, "back")).digest).toBe(
        placeholderCameraImage().digest,
      );
    });
  });

  test("refuses a non-boolean camera flag instead of quietly disabling it", async () => {
    let launched = false;
    await withServer(
      async (captured) => {
        const response = await request(captured, "/api/avds/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ avd: "Pixel_8", camera: "true", select: false }),
        });
        expect(response.status).toBe(400);
        expect((await response.json()).error).toContain("camera must be a boolean");
        expect(launched).toBe(false);
      },
      {
        listDevices: async () => [{ serial: SERIAL, state: "device" }],
        startEmulator: async () => {
          launched = true;
          return {
            serial: "emulator-5558",
            proc: null,
            ownsProcess: true,
            cameraFeed: false,
            stop: () => {},
          };
        },
      },
    );
  });

  test("refuses a camera launch that reused an unwired running AVD", async () => {
    await withServer(
      async (captured) => {
        const response = await request(captured, "/api/avds/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ avd: "AlreadyUp", camera: true, select: false }),
        });
        expect(response.status).toBe(400);
        expect((await response.json()).error).toContain("already running");
      },
      {
        listDevices: async () => [{ serial: SERIAL, state: "device" }],
        startEmulator: async () => reattachedLaunch(),
      },
    );
  });

  test("accepts a camera launch that reused an already wired running AVD", async () => {
    await withServer(
      async (captured) => {
        const response = await request(captured, "/api/avds/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ avd: "AlreadyUp", camera: true, select: false }),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          ok: true,
          serial: "emulator-5558",
          avd: "AlreadyUp",
        });
      },
      {
        listDevices: async () => [{ serial: SERIAL, state: "device" }],
        startEmulator: async () => reattachedLaunch(),
        readCameraWiring: async () => true,
      },
    );
  });

  test("reports a feed directory it cannot write as a server failure", async () => {
    await withServer(async (captured) => {
      await chmod(root, 0o500);
      try {
        const response = await postImage(
          captured,
          Uint8Array.from(solidPng(16, 16, [7, 7, 7])),
        );
        expect(response.status).toBe(500);
        expect((await response.json()).error).toContain("EACCES");
      } finally {
        await chmod(root, 0o700);
      }
    });
  });

  test("rejects a body the emulator could not decode", async () => {
    await withServer(async (captured) => {
      const real = solidPng(32, 24, [5, 5, 5]);
      expect((await postImage(captured, Uint8Array.from(real))).status).toBe(200);

      const truncated = Uint8Array.from(real.subarray(0, real.length - 20));
      const response = await postImage(captured, truncated);
      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain("truncated");
      expect((await readCameraFeed(SERIAL, "back")).bytes).toBe(real.byteLength);
    });
  });

  test("serves the stored PNG back and rejects an unknown facing or method", async () => {
    await withServer(async (captured) => {
      const missing = await request(captured, "/api/camera/image?facing=front");
      expect(missing.status).toBe(404);

      const png = solidPng(48, 36, [9, 8, 7]);
      expect(
        (await postImage(captured, Uint8Array.from(png), "?facing=front")).status,
      ).toBe(200);

      const served = await request(captured, "/api/camera/image?facing=front");
      expect(served.status).toBe(200);
      expect(served.headers.get("Content-Type")).toBe("image/png");
      expect(new Uint8Array(await served.arrayBuffer())).toEqual(
        Uint8Array.from(png),
      );

      const bad = await postImage(captured, Uint8Array.from(placeholderCameraImage().png), "?facing=selfie");
      expect(bad.status).toBe(400);
      expect((await bad.json()).error).toContain("facing must be one of");

      expect((await request(captured, "/api/camera", { method: "POST" })).status).toBe(405);
      expect(
        (await request(captured, "/api/camera/image", { method: "PUT" })).status,
      ).toBe(405);
    });
  });
});
