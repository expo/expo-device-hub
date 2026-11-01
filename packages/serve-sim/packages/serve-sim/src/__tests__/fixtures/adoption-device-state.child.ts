import { expect, mock, test } from "bun:test";
import * as childProcess from "child_process";
import * as native from "../../native";
import * as ui from "../../ui-settings";
import { existsSync } from "fs";
import { DEFAULT_STREAM_ENCODER_SETTINGS } from "../../stream-settings";
import {
  clearServeSimState,
  inProcessServeSimState,
  stateFileForDevice,
  writeServeSimState,
} from "../../state";
import { UDID, useTempStateDir } from "../helpers";

const SELECTED = "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB";
const execFile = childProcess.execFile;
let releaseOldList = () => {};
let listEntered = () => {};
let calls = 0;
mock.module("child_process", () => ({
  ...childProcess,
  execFile(file: string, args: string[], options: unknown, done: (...args: unknown[]) => void) {
    if (file === "xcrun" && args.join(" ") === "simctl list devices booted -j") {
      const respond = (device: string) =>
        done(
          null,
          JSON.stringify({ devices: { iOS: [{ udid: device, name: device, state: "Booted" }] } }),
          "",
        );
      if (++calls === 1) {
        releaseOldList = () => respond(UDID);
        listEntered();
      } else queueMicrotask(() => respond(SELECTED));
      return {};
    }
    return execFile(file, args, options as never, done as never);
  },
}));
class Capture {
  async start() {}
  async stop() {}
  async updateStreamSettings() {}
  async subscribeScreenChanges() {
    return async () => {};
  }
  async subscribeDeviceState() {
    return async () => {};
  }
  async screenSize() {
    return { width: 390, height: 844, screenId: 0, orientation: "portrait" };
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
const { closeDeviceSession } = await import("../../device-session");

test("a delayed preclaim boot list cannot reap the adopted device", async () => {
  const state = useTempStateDir();
  const entered = new Promise<void>((resolve) => {
    listEntered = resolve;
  });
  const stream = { transport: "webrtc" as const, codec: "h264" as const };
  writeServeSimState({ ...inProcessServeSimState(UDID, 3200), token: "token" });
  const middleware = simMiddleware({
    basePath: "/",
    device: UDID,
    prepareForAdoption: true,
    clipboard: "unmanaged",
    streamSettings: stream,
    execToken: "token",
    requirePreviewToken: true,
    configureResources: async () => {
      clearServeSimState(UDID, process.pid);
      writeServeSimState({ ...inProcessServeSimState(SELECTED, 3200), token: "token" });
    },
  });
  const probe = middleware(
    new Request("http://127.0.0.1/api", { headers: { Authorization: "Bearer token" } }),
  );
  try {
    await entered;
    await middleware.configureSession({
      device: SELECTED,
      singleDevice: SELECTED,
      stream: { ...stream, ...DEFAULT_STREAM_ENCODER_SETTINGS },
      corsOrigins: [],
      frameAncestors: [],
      disableShare: true,
      networkCapture: false,
      networkCaptureFields: [],
    });
    releaseOldList();
    await probe;
    const response = await middleware(
      new Request("http://127.0.0.1/api", { headers: { Authorization: "Bearer token" } }),
    );
    expect(await response?.json()).toMatchObject({ device: SELECTED, port: 3200 });
    expect(existsSync(stateFileForDevice(SELECTED))).toBe(true);
    expect(calls).toBeGreaterThan(1);
  } finally {
    releaseOldList();
    await probe;
    closeDeviceSession(SELECTED);
    state.restore();
  }
});
