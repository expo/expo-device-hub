import { expect, mock, test } from "bun:test";
import { createServer } from "node:http";
import * as native from "../../native";
import * as ui from "../../ui-settings";
let starts = 0;
let stops = 0;
let captureStartGate: Promise<void> | undefined;
let captureEntered = () => {};
class Hid {
  async setScreen() {}
  async supportsHingeAngle() { return false; }
  async supportsPhysicalOrientation() { return false; }
}
class Capture {
  async start() { captureEntered(); await captureStartGate; }
  async stop() {}
  async suspendForReboot() {}
  async resumeAfterReboot() {}
  async subscribeScreenChanges() { return async () => {}; }
  async screenSize() { return { width: 120, height: 240, screenId: 0 }; }
  async startRecording() { starts++; }
  async stopRecording() { stops++; return "/owned/session.json"; }
}
mock.module("../../native", () => ({ ...native, NativeHid: Hid, NativeCapture: Capture }));
mock.module("../../ui-settings", () => ({ ...ui, refreshDeviceOptionState: async () => {} }));
const { DeviceSession, getDeviceSession, closeDeviceSession, finishDeviceRecordingsForShutdown } = await import("../../device-session");
for (const alreadyRecording of [false, true]) {
  test(`reboot blocks new recording starts and preserves existing control: active=${alreadyRecording}`, async () => {
    starts = stops = 0;
    const session = new DeviceSession("owned-recording-admission");
    await session.start();
    const server = createServer((req, res) => void session.handleVideoRecording(req, res));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const start = (id: string) => fetch(base, { method: "POST", body: JSON.stringify({ start: true, output: "/owned", recordingId: id }) });
    try {
      if (alreadyRecording) expect((await start("original")).status).toBe(200);
      await session.suspendForReboot();
      const blocked = await start("during-reboot");
      expect(blocked.status).toBe(503);
      expect((await blocked.json()).error).toBe("capture_rebooting");
      expect(starts).toBe(alreadyRecording ? 1 : 0);
      if (alreadyRecording) {
        expect((await fetch(base, { method: "PUT", headers: { "x-recording-id": "original" } })).status).toBe(200);
        expect((await fetch(base, { method: "DELETE", headers: { "x-recording-id": "original" } })).status).toBe(200);
        expect(stops).toBe(1);
      }
      await session.resumeAfterReboot();
      expect((await start("after-reboot")).status).toBe(200);
      expect(starts).toBe(alreadyRecording ? 2 : 1);
    } finally {
      server.closeAllConnections(); server.close(); session.close();
    }
  });
}

test("a start refused before writer creation does not fail concurrent shutdown", async () => {
  starts = stops = 0;
  let release = () => {};
  captureStartGate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { captureEntered = resolve; });
  const session = getDeviceSession("owned-recording-reboot-shutdown");
  const server = createServer((req, res) => void session.handleVideoRecording(req, res));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const starting = fetch(base, { method: "POST", body: JSON.stringify({ start: true, output: "/owned", recordingId: "pending" }) });
    await entered;
    for (let i = 0; i < 100 && !(session as any).recordingStarting; i++) await Bun.sleep(1);
    expect((session as any).recordingStarting).toBe(true);
    const suspension = session.suspendForReboot();
    const finishing = finishDeviceRecordingsForShutdown();
    release();
    expect((await starting).status).toBe(503);
    await suspension;
    expect(await finishing).toBe(true);
    expect(starts).toBe(0);
    expect(stops).toBe(0);
  } finally {
    captureStartGate = undefined;
    server.closeAllConnections(); server.close(); closeDeviceSession("owned-recording-reboot-shutdown");
  }
});
