import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { CaptureRecordingSourceOptions } from "../src/capture-recording-source.ts";
import { DeviceSessionState } from "../src/device-session-state.ts";
import { GpuCaptureUnavailableError } from "../src/gpu-session.ts";
import {
  createRouter,
  type AppOptions,
  type EmuApp,
  type RouterDependencies,
} from "../src/middleware.ts";
import type { RecordingOptions } from "../src/screen-recording.ts";
import type { ScreenOrientation, StreamMode } from "../src/shared/api-contracts.ts";
import { watchNoOrientationEvents } from "./fixtures/orientation.ts";

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
const agentListeners: ReturnType<typeof Bun.listen>[] = [];
afterEach(async () => {
  for (const listener of agentListeners.splice(0)) listener.stop(true);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(
  startCaptureRecording: NonNullable<RouterDependencies["startCaptureRecording"]>,
  overrides: RouterDependencies = {},
) {
  const root = await mkdtemp(join(tmpdir(), "router-independent-recording-"));
  roots.push(root);
  const socketDirectory = join(root, "sockets");
  await mkdir(socketDirectory, { mode: 0o700 });
  agentListeners.push(
    Bun.listen({ unix: join(socketDirectory, "emulator-5554.sock"), socket: { data() {} } }),
  );
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
      readShownOrientation: async () => ({ orientation: "portrait", settling: false }),
      watchOrientationEvents: watchNoOrientationEvents,
      openHingeSensor: async () => {
        throw new Error("no hinge in this test");
      },
      ...overrides,
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

type AgentRecorder = CaptureRecordingSourceOptions["recorder"];

/** One frame from the agent, captured now. Returns its capture time. */
function agentFrame(recorder: AgentRecorder): bigint {
  const pts = recorder.monotonicUs();
  recorder.accept(
    { type: "frame", pts, data: KEYFRAME, isKey: true, isConfig: false },
    { width: 1080, height: 2424 },
    "capture-recording",
    { width: 1080, height: 2424, contentRect: { x: 0, y: 0, width: 1080, height: 2424 } },
  );
  return pts;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the recording's orientation timeline", () => {
  test("names the pose that the display shows, not a Hub rotation that the top app refuses", async () => {
    let recorder!: AgentRecorder;
    let firstPts = 0n;
    // What Android's display shows: the launcher keeps portrait under a landscape lock.
    let shown: ScreenOrientation = "portrait";
    const states: DeviceSessionState[] = [];
    const { router, created, options, manifest } = await setup(
      async (source) => {
        recorder = source.recorder;
        firstPts = agentFrame(recorder);
        return { canvas: { width: 1080, height: 2424 }, close: () => {} };
      },
      {
        readShownOrientation: async () => ({ orientation: shown, settling: false }),
        // An app with the device state of a real one, whose lock reports the requested pose.
        createApp: async (appOptions) => {
          created.push(appOptions);
          const deviceState = new DeviceSessionState({
            serial: appOptions.serial,
            applyLocation: async () => {},
            readOrientation: async () => shown,
            applyRotation: async () => ({
              mode: "lock",
              rotation: 3,
              orientation: "landscape",
              pose: "landscape_left",
              raw: "lock 3",
            }),
          });
          states.push(deviceState);
          return Object.assign(fakeApp(appOptions.serial, "scrcpy", []), { deviceState });
        },
      },
    );
    // What the app's `POST /api/orientation` does.
    const rotate = async () => {
      await states[0]!.setOrientation("landscape");
      created[0]!.onDisplayChanged?.();
    };
    try {
      await router.startScreenRecording(options);
      await router.ensure("emulator-5554");

      // Rotate on the launcher: the lock holds, the picture stays upright in portrait.
      await rotate();
      await wait(30);
      const launcherPts = agentFrame(recorder);

      // Rotate in an app that turns: the display follows the lock.
      await wait(5);
      shown = "landscape_left";
      await rotate();
      await wait(30);
      const appPts = agentFrame(recorder);

      await router.finishScreenRecording();
      const written = await manifest();
      expect(
        written.deviceStates.map(
          (entry: { state: { orientation?: string } }) => entry.state.orientation,
        ),
      ).toEqual(["portrait", "landscape_left"]);
      // The landscape entry starts at the app's frame; the launcher's frame stayed portrait.
      const msAfterFirst = (pts: bigint) => Number(pts - firstPts) / 1000;
      expect(written.deviceStates[1].timeMs).toBeGreaterThan(msAfterFirst(launcherPts) + 1);
      expect(Math.abs(written.deviceStates[1].timeMs - msAfterFirst(appPts))).toBeLessThanOrEqual(
        1,
      );
    } finally {
      await router.stopAll();
    }
  });

  test("an app's own turn reaches the next frame through the device event stream", async () => {
    let recorder!: AgentRecorder;
    let shown: ScreenOrientation = "portrait";
    const stream: { changed?: () => void; signal?: AbortSignal } = {};
    const { router, options, manifest } = await setup(
      async (source) => {
        recorder = source.recorder;
        agentFrame(recorder);
        return { canvas: { width: 1080, height: 2424 }, close: () => {} };
      },
      {
        readShownOrientation: async () => ({ orientation: shown, settling: false }),
        watchOrientationEvents: (_serial, onChange, signal) => {
          stream.changed = onChange;
          stream.signal = signal;
          return new Promise((resolve) => signal.addEventListener("abort", () => resolve()));
        },
      },
    );
    try {
      await router.startScreenRecording(options);
      await wait(5);
      // The app turns to landscape under the user's lock; the Hub sent nothing. The display
      // reports it well within the one-second fallback read.
      shown = "landscape_left";
      stream.changed?.();
      await wait(30);
      agentFrame(recorder);

      await router.finishScreenRecording();
      const written = await manifest();
      expect(
        written.deviceStates.map(
          (entry: { state: { orientation?: string } }) => entry.state.orientation,
        ),
      ).toEqual(["portrait", "landscape_left"]);
      // The finished recording closes the change stream.
      expect(stream.signal?.aborted).toBe(true);
    } finally {
      await router.stopAll();
    }
  });
});
