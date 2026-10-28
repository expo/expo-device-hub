import { expect, mock, test } from "bun:test";
import * as native from "../../native";
import * as ui from "../../ui-settings";
import { DEFAULT_STREAM_ENCODER_SETTINGS, type StreamEncoderSettings } from "../../stream-settings";
import { UDID, useTempStateDir } from "../helpers";

const updates: StreamEncoderSettings[] = [];
const starts: string[] = [];
const stops: string[] = [];
let blockedDevice: string | undefined;
let startGate: Promise<void> | undefined;
let startEntered = () => {};
let stopGate: Promise<void> | undefined;
let stopEntered = () => {};
class Capture {
  constructor(readonly udid: string) {}
  async start() {
    starts.push(this.udid);
    if (this.udid === blockedDevice) {
      startEntered();
      await startGate;
    }
  }
  async startRecording() {
    expect(updates.at(-1)).toMatchObject({ h264Fps: 30, h264Bitrate: 2300000 });
  }
  async stopRecording() {
    return "/tmp/adopt-video/session.json";
  }
  async stop() {
    stops.push(this.udid);
    if (this.udid === blockedDevice) {
      stopEntered();
      await stopGate;
    }
  }
  async subscribeScreenChanges() {
    return async () => {};
  }
  async subscribeDeviceState() {
    return async () => {};
  }
  async screenSize() {
    return { width: 390, height: 844, screenId: 0, orientation: "portrait" };
  }
  async updateStreamSettings(settings: StreamEncoderSettings) {
    updates.push(settings);
  }
}
class Hid {
  async setScreen() {}
  async supportsHingeAngle() {
    return false;
  }
  async supportsPhysicalOrientation() {
    return false;
  }
}
mock.module("../../native", () => ({ ...native, NativeCapture: Capture, NativeHid: Hid }));
mock.module("../../ui-settings", () => ({ ...ui, refreshDeviceOptionState: async () => {} }));
const { simMiddleware } = await import("../../middleware");
const { getDeviceSession, closeDeviceSession, startDeviceSession } =
  await import("../../device-session");

test("adoption changes the already running native encoder and future viewer settings", async () => {
  const state = useTempStateDir();
  const stream = {
    transport: "webrtc" as const,
    codec: "h264" as const,
    h264Fps: 24,
    h264Bitrate: 1000000,
  };
  try {
    await getDeviceSession(UDID, stream).start();
    const middleware = simMiddleware({
      device: UDID,
      basePath: "/",
      execToken: "owner-token",
      requirePreviewToken: true,
      loopbackOnly: true,
      streamSettings: stream,
      configureResources: async () => {},
    });
    await middleware.configureSession({
      stream: {
        transport: "webrtc",
        codec: "vp8",
        ...DEFAULT_STREAM_ENCODER_SETTINGS,
        h264Fps: 30,
        h264Bitrate: 2300000,
        maxDimension: 720,
      },
      videoRecording: { output: "/tmp/adopt-video", recordingId: "job" },
      networkCapture: false,
      networkCaptureFields: [],
      corsOrigins: [],
      frameAncestors: [],
      disableShare: true,
    });
    expect(updates).toEqual([
      { ...DEFAULT_STREAM_ENCODER_SETTINGS, h264Fps: 30, h264Bitrate: 2300000, maxDimension: 720 },
    ]);
    expect(stream).toMatchObject({
      codec: "vp8",
      h264Fps: 30,
      h264Bitrate: 2300000,
      maxDimension: 720,
    });
  } finally {
    closeDeviceSession(UDID);
    state.restore();
  }
});

test("an unclaimed orphan admits only read-only probes, not streams or device work", async () => {
  const stream = { transport: "webrtc" as const, codec: "h264" as const };
  const middleware = simMiddleware({
    basePath: "/",
    device: UDID,
    prepareForAdoption: true,
    execToken: "owner-token",
    requirePreviewToken: true,
    streamSettings: stream,
    configureResources: async () => {},
  });
  for (const [path, method] of [
    ["/ax", "GET"],
    ["/metrics", "GET"],
    ["/api/event-log/events", "GET"],
    [`/helper/${UDID}/ax`, "GET"],
    [`/helper/${UDID}/foreground`, "GET"],
    ["/grid/api/start", "POST"],
    ["/grid/api/shutdown", "POST"],
  ]) {
    const response = await middleware(
      new Request(`http://127.0.0.1${path}`, {
        method,
        headers: { Authorization: "Bearer owner-token" },
        ...(method === "POST" ? { body: JSON.stringify({ udid: UDID }) } : {}),
      }),
    );
    expect(response?.status, path).toBe(503);
  }
  const health = await middleware(new Request("http://127.0.0.1/healthz"));
  expect(health?.status).toBe(200);
});

test("cancelling pending native capture waits for confirmed stop", async () => {
  const udid = "CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC";
  blockedDevice = udid;
  let releaseStart!: () => void, releaseStop!: () => void;
  startGate = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  stopGate = new Promise<void>((resolve) => {
    releaseStop = resolve;
  });
  const entering = new Promise<void>((resolve) => {
    startEntered = resolve;
  });
  const stopping = new Promise<void>((resolve) => {
    stopEntered = resolve;
  });
  const cancellation = new AbortController();
  let finished = false;
  const starting = startDeviceSession(
    udid,
    { transport: "webrtc", codec: "h264" },
    cancellation.signal,
  )
    .catch((error: unknown) => error)
    .finally(() => {
      finished = true;
    });
  try {
    await entering;
    cancellation.abort(new Error("job cancelled"));
    await stopping;
    expect(finished).toBe(false);
    releaseStart();
    releaseStop();
    expect(await starting).toMatchObject({ message: "job cancelled" });
    expect(stops).toContain(udid);
  } finally {
    releaseStart();
    releaseStop();
    await starting;
    closeDeviceSession(udid);
    blockedDevice = undefined;
    startGate = undefined;
    stopGate = undefined;
    startEntered = () => {};
    stopEntered = () => {};
  }
});
