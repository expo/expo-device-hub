import { expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import * as native from "../../native";
import * as ui from "../../ui-settings";
import { inProcessServeSimState, stateFileForDevice, writeServeSimState } from "../../state";

const PHONE = "00008101-0016603236F0801E";
const SIMULATOR = "00000000-0000-0000-0000-000000000444";

const endListeners: Array<(json: string) => Promise<void>> = [];
let nativeStops = 0;
let deviceOptionReads: string[] = [];

class Hid {
  async setScreen() {}
  async supportsHingeAngle() {
    return false;
  }
  async supportsPhysicalOrientation() {
    return false;
  }
  async hingeState() {
    return {};
  }
}
class Capture {
  async start() {}
  async stop() {
    nativeStops++;
  }
  async subscribeScreenChanges() {
    return async () => {};
  }
  async subscribeDeviceState() {
    return async () => {};
  }
  async subscribeEnd(onEnd: (end: { reason: string }) => Promise<void>) {
    endListeners.push((json) => onEnd(JSON.parse(json)));
    return async () => {};
  }
  async screenSize() {
    return { width: 1170, height: 2532, screenId: 1, orientation: "portrait" };
  }
}
mock.module("../../native", () => ({ ...native, NativeHid: Hid, NativeCapture: Capture }));
mock.module("../../ui-settings", () => ({
  ...ui,
  refreshDeviceOptionState: async (udid: string) => {
    deviceOptionReads.push(udid);
  },
}));
const { getDeviceSession, peekDeviceSession } = await import("../../device-session");
const { deviceEndConfig } = await import("../../device-end");

class Socket extends EventEmitter {
  closed?: { code?: number; reason?: string };
  send() {}
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
    this.emit("close");
  }
}

async function settle() {
  for (let i = 0; i < 5; i++) await Bun.sleep(5);
}

test("a disconnected phone ends its session with the reason", async () => {
  writeServeSimState(inProcessServeSimState(PHONE, 3200));
  const session = getDeviceSession(PHONE);
  await session.start();
  const socket = new Socket();
  session.attachHidSocket(socket as never);
  await settle();
  expect(endListeners).toHaveLength(1);
  expect(deviceOptionReads).toEqual([]);

  await endListeners[0]!(JSON.stringify({ reason: "device-disconnected" }));
  await settle();

  expect(socket.closed).toEqual({ code: 4410, reason: "iPhone disconnected" });
  expect(peekDeviceSession(PHONE)).toBeUndefined();
  expect(existsSync(stateFileForDevice(PHONE))).toBe(false);
  expect(nativeStops).toBe(1);
  expect(deviceEndConfig(PHONE)).toEqual({
    device: PHONE,
    ended: { reason: "iPhone disconnected" },
  });
});

test("a simulator's session does not wait for a device end", async () => {
  endListeners.length = 0;
  deviceOptionReads = [];
  const session = getDeviceSession(SIMULATOR);
  await session.start();
  await settle();

  expect(endListeners).toHaveLength(0);
  expect(deviceOptionReads).toEqual([SIMULATOR]);
  await session.close();
});
