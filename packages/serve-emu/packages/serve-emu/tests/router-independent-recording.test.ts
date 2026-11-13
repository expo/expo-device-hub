import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { CaptureRecordingSourceOptions } from "../src/capture-recording-source.ts";
import { GpuCaptureUnavailableError } from "../src/gpu-session.ts";
import {
  createRouter,
  type AppOptions,
  type EmuApp,
  type RouterDependencies,
} from "../src/middleware.ts";
import type { RecordingOptions } from "../src/screen-recording.ts";
import type { StreamMode } from "../src/shared/api-contracts.ts";

// SPS + PPS + IDR slice: one self-contained H.264 keyframe.
const KEYFRAME = Buffer.from(
  "000000016742c01fd9005005bb0110000003001000000303c0f18324800000000168cb83cb200000000165888421",
  "hex",
);

function fakeApp(serial: string, mode: StreamMode, stopped: string[]): EmuApp {
  return {
    session: { mode, inputSource: "scrcpy", meta: { deviceName: `Device ${serial}` } },
    getInputSource: () => "scrcpy",
    isStreaming: () => true,
    health: () => ({ status: "streaming" }),
    handleRequest: async () => Response.json({ ok: true }),
    attachWebSocket: () => {},
    stop: async () => {
      stopped.push(serial);
    },
  } as unknown as EmuApp;
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(
  startCaptureRecording: NonNullable<RouterDependencies["startCaptureRecording"]>,
) {
  const root = await mkdtemp(join(tmpdir(), "router-independent-recording-"));
  roots.push(root);
  const socketDirectory = join(root, "sockets");
  await Bun.write(join(socketDirectory, "emulator-5554.sock"), "");
  const created: AppOptions[] = [];
  const stopped: string[] = [];
  const router = createRouter(
    { streamMode: "scrcpy", emulatorCapture: { socketDirectory } },
    {
      listDevices: async () => [{ serial: "emulator-5554", state: "device" }],
      createApp: async (options) => {
        created.push(options);
        // A stream-fed recording takes the app's packets.
        if (options.screenRecording && !options.screenRecording.independent) {
          options.screenRecording.accept(
            { type: "frame", pts: 0n, data: KEYFRAME, isKey: true, isConfig: false },
            { width: 570, height: 1280 },
            "scrcpy",
          );
        }
        return fakeApp(options.serial, options.streamMode ?? "scrcpy", stopped);
      },
      startCaptureRecording,
      readHardwareConfig: async () => "hw.lcd.width = 1080\nhw.lcd.vsync = 90\n",
      readOrientation: async () => "portrait",
      openHingeSensor: async () => {
        throw new Error("no hinge in this test");
      },
    },
  );
  const options: RecordingOptions = {
    directory: join(root, "session"),
    udid: "emulator-5554",
    deviceName: "Pixel",
    runtimeDisplayName: "Android 37",
    createWriter: async ({ path }) => {
      await writeFile(path, "test-writer");
      return { add: async () => {}, finish: async () => {}, cancel: async () => {} };
    },
  };
  const manifest = async () =>
    JSON.parse(await readFile(join(options.directory, "session.json"), "utf8"));
  return { router, created, stopped, options, manifest };
}

const switchSource = (router: ReturnType<typeof createRouter>, mode: StreamMode) =>
  router.handleRequest(
    new Request("http://router.test/api/stream-mode?device=emulator-5554", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    }),
  );

describe("router recording with the capture agent", () => {
  test("gives the recording its own source, apart from every app", async () => {
    const sources: CaptureRecordingSourceOptions[] = [];
    let closes = 0;
    const { router, created, options, manifest } = await setup(async (source) => {
      sources.push(source);
      // The agent's first recorded frame.
      source.recorder.accept(
        {
          type: "frame",
          pts: source.recorder.monotonicUs(),
          data: KEYFRAME,
          isKey: true,
          isConfig: false,
        },
        { width: 1080, height: 2424 },
        "capture-recording",
        { width: 1080, height: 2424, contentRect: { x: 0, y: 0, width: 1080, height: 2424 } },
      );
      return {
        canvas: { width: 1080, height: 2424 },
        close: () => {
          closes++;
        },
      };
    });
    try {
      await router.startScreenRecording(options);
      // The recording needs no app; the stream starts with the first viewer.
      expect(created).toEqual([]);
      expect(sources).toHaveLength(1);
      expect(sources[0]!.socketPath.endsWith("emulator-5554.sock")).toBe(true);
      // Native size, the display's refresh rate from hw.lcd.vsync, and 8 Mbit/s.
      expect(sources[0]!.encoding).toEqual({ maxSize: 0, fps: 90, bitRate: 8_000_000 });
      expect(sources[0]!.displays).toBe(null);

      await router.ensure("emulator-5554");
      expect(created).toHaveLength(1);
      const recorder = created[0]!.screenRecording!;
      expect(recorder.independent).toBe(true);
      expect(recorder.snapshot()).toMatchObject({ status: "recording", independent: true });

      // A source switch does not reach the recording.
      const change = await switchSource(router, "grpc-screenshot");
      expect(change.status).toBe(200);
      expect(created.map((app) => app.streamMode)).toEqual(["scrcpy", "grpc-screenshot"]);
      expect(recorder.active).toBe(true);

      const result = await router.finishScreenRecording();
      expect(result?.directory).toBe(options.directory);
      expect(closes).toBe(1);
      const written = await manifest();
      expect(written.status).toBe("complete");
      // The orientation is read before the agent sends frames, so the first frame has it.
      expect(written.deviceStates[0]).toEqual({
        timeMs: 0,
        state: {
          width: 1080,
          height: 2424,
          contentRect: { x: 0, y: 0, width: 1080, height: 2424 },
          orientation: "portrait",
        },
      });
    } finally {
      await router.stopAll();
    }
  });

  test("passes the start's encode settings to the agent", async () => {
    const sources: CaptureRecordingSourceOptions[] = [];
    const { router, options } = await setup(async (source) => {
      sources.push(source);
      source.recorder.accept(
        {
          type: "frame",
          pts: source.recorder.monotonicUs(),
          data: KEYFRAME,
          isKey: true,
          isConfig: false,
        },
        { width: 540, height: 1212 },
        "capture-recording",
      );
      return { canvas: { width: 540, height: 1212 }, close: () => {} };
    });
    try {
      await router.startScreenRecording({
        ...options,
        encoding: { maxSize: 1212, fps: 30, bitRate: 4_000_000 },
      });
      expect(sources[0]!.encoding).toEqual({ maxSize: 1212, fps: 30, bitRate: 4_000_000 });
    } finally {
      await router.stopAll();
    }
  });

  test("records the stream's packets, with the lock, when the agent has no recording role", async () => {
    const { router, created, options } = await setup(async () => {
      throw new GpuCaptureUnavailableError("The emulator capture agent has no recording role");
    });
    try {
      await router.startScreenRecording(options);
      expect(created).toHaveLength(1);
      expect(created[0]!.screenRecording?.independent).toBe(false);
      expect(created[0]!.screenRecording?.snapshot()).not.toHaveProperty("independent");
      const change = await switchSource(router, "grpc-screenshot");
      expect(change.status).toBe(409);
    } finally {
      await router.stopAll();
    }
  });
});
