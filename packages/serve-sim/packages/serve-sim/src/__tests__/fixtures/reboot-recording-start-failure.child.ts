import { expect, mock, test } from "bun:test";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import * as native from "../../native";
import * as ui from "../../ui-settings";
let rejectRecording: (e: Error) => void = () => {};
let recordingEntered: () => void = () => {};
let suspends = 0;
class Hid {
  inputUnavailable = false;
  async setScreen() {}
  async supportsHingeAngle() { return false; }
  async supportsPhysicalOrientation() { return false; }
}
class Capture {
  async start() {}
  async stop() {}
  async suspendForReboot() { suspends++; }
  async resumeAfterReboot() {}
  async subscribeScreenChanges() { return async () => {}; }
  async screenSize() { return { width: 120, height: 240, screenId: 0 }; }
  async startRecording() {
    recordingEntered();
    await new Promise<void>((_, reject) => { rejectRecording = reject; });
  }
}
mock.module("../../native", () => ({ ...native, NativeHid: Hid, NativeCapture: Capture }));
mock.module("../../ui-settings", () => ({ ...ui, refreshDeviceOptionState: async () => {} }));
const { getDeviceSession, closeDeviceSession } = await import("../../device-session");
const { rebootWithCapture } = await import("../../capture/reboot");
class Socket extends EventEmitter {
  code?: number;
  send() {}
  close(code?: number) { this.code = code; this.emit("close"); }
}
test("failed in-flight recording start still permits reboot and fresh input", async () => {
  const udid = "owned-review-start-reject";
  const session = getDeviceSession(udid);
  await session.start();
  const server = createServer((req, res) => void session.handleVideoRecording(req, res));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  let shutdowns = 0;
  let boots = 0;
  const entered = new Promise<void>(resolve => { recordingEntered = resolve; });
  try {
    const starting = fetch(`http://127.0.0.1:${port}/recording/video`, {
      method: "POST", body: JSON.stringify({ start: true, output: "/tmp/unused-review-output", recordingId: "review" }),
    });
    await entered;
    const reboot = rebootWithCapture(udid, false, {
      runtime: {
        setDeviceCaptureEnabled() {}, disableForDevice: async () => {}, defaultFields: () => [],
        metaFor: () => ({ attachment: "off" }),
      } as never,
      shutdown: async () => { shutdowns++; }, boot: async () => { boots++; }, rearm: async () => {},
    });
    void reboot.catch(() => {});
    await Bun.sleep(10);
    rejectRecording(new Error("Hardware H.264 recording encoder could not start"));
    expect((await starting).status).toBe(500);
    await expect(reboot).resolves.toMatchObject({ attachment: "off" });
    const socket = new Socket();
    session.attachHidSocket(socket as never);
    await Bun.sleep(10);
    expect(socket.code).toBeUndefined();
    expect(getDeviceSession(udid)).toBe(session);
    expect(suspends).toBe(1);
    expect(shutdowns).toBe(1);
    expect(boots).toBe(1);
  } finally {
    server.closeAllConnections(); server.close(); closeDeviceSession(udid);
  }
});
