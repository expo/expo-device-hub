import { expect, mock, test } from "bun:test";
import * as native from "../../native";
import * as ui from "../../ui-settings";
import { DEFAULT_STREAM_ENCODER_SETTINGS, type StreamEncoderSettings } from "../../stream-settings";
import { UDID, useTempStateDir } from "../helpers";

const updates: StreamEncoderSettings[] = [];
class Capture {
  async start() {}
  async startRecording() {
    expect(updates.at(-1)).toMatchObject({ h264Fps: 30, h264Bitrate: 2300000 });
  }
  async stopRecording() {
    return "/tmp/adopt-video/session.json";
  }
  async stop() {}
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
const { getDeviceSession, closeDeviceSession } = await import("../../device-session");

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
