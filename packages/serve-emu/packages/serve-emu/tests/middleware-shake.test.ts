import { describe, expect, test } from "bun:test";
import { ControlInputQueue } from "../src/control-input-queue.ts";
import { createApp, type CreateAppDependencies, type EmuApp } from "../src/middleware.ts";
import { SHAKE_EMULATOR_ONLY_MESSAGE } from "../src/shake.ts";
import { readNoOrientation } from "./fixtures/orientation.ts";

// No test here reaches adb: emulator serials use an injected shake, and the default shake
// refuses a physical serial before it runs a command.
async function startApp(serial: string, dependencies: CreateAppDependencies = {}): Promise<EmuApp> {
  const controls = new ControlInputQueue({ writer: { async write() {} } });
  let end!: (value: null) => void;
  const frames = new Promise<null>((resolve) => {
    end = resolve;
  });
  return createApp(
    { serial },
    {
      readOrientation: readNoOrientation,
      startSession: async () => ({
        serial,
        mode: "scrcpy",
        inputSource: "scrcpy",
        meta: { deviceName: "test", codecId: "h264", width: 576, height: 1280 },
        controls,
        readFrame: () => frames,
        onFatal: () => () => {},
        async close() {
          controls.close();
          end(null);
        },
      }),
      ...dependencies,
    },
  );
}

function request(path: string, method = "GET"): Request {
  return new Request(`http://router.test${path}`, { method });
}

describe("middleware shake", () => {
  test("advertises shake for an emulator and shakes it", async () => {
    const shaken: string[] = [];
    const app = await startApp("emulator-5598", {
      shake: async (serial) => {
        shaken.push(serial);
      },
    });
    try {
      const info = await app.handleRequest(request("/api"));
      expect(((await info.json()) as { shake?: unknown }).shake).toBe(true);

      const response = await app.handleRequest(request("/api/shake", "POST"));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(shaken).toEqual(["emulator-5598"]);

      const wrongMethod = await app.handleRequest(request("/api/shake"));
      expect(wrongMethod.status).toBe(405);
      expect(shaken).toHaveLength(1);
    } finally {
      await app.stop();
    }
  });

  test("reports a failed shake as a structured error", async () => {
    const app = await startApp("emulator-5598", {
      shake: async () => {
        throw new Error("Emulator acceleration write failed: KO: console gone");
      },
    });
    try {
      const response = await app.handleRequest(request("/api/shake", "POST"));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        ok: false,
        error: "Emulator acceleration write failed: KO: console gone",
      });
    } finally {
      await app.stop();
    }
  });

  test("does not advertise or shake a physical device", async () => {
    const app = await startApp("R58M123ABC");
    try {
      const info = await app.handleRequest(request("/api"));
      expect(((await info.json()) as { shake?: unknown }).shake).toBe(false);

      const response = await app.handleRequest(request("/api/shake", "POST"));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ ok: false, error: SHAKE_EMULATOR_ONLY_MESSAGE });
    } finally {
      await app.stop();
    }
  });
});
