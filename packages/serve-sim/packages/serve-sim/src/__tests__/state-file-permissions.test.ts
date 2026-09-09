import { afterEach, describe, expect, test } from "bun:test";
import { statSync, unlinkSync } from "fs";
import {
  stateFileForDevice,
  writeServeSimState,
  type ServeSimDeviceState,
} from "../state";

const device = `PERMISSIONS-${process.pid}`;
const file = stateFileForDevice(device);

afterEach(() => {
  try { unlinkSync(file); } catch {}
});

describe("writeServeSimState", () => {
  test("keeps TURN credentials private to the current user", () => {
    const state: ServeSimDeviceState = {
      pid: process.pid,
      port: 3200,
      device,
      url: "http://127.0.0.1:3200",
      streamUrl: "http://127.0.0.1:3200/helper/device/stream.mjpeg",
      wsUrl: "ws://127.0.0.1:3200/helper/device/ws",
      streamSettings: {
        transport: "webrtc",
        codec: "vp8",
        iceServers: [{ urls: ["turn:example.test"], username: "user", credential: "secret" }],
      },
    };

    writeServeSimState(state);

    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
