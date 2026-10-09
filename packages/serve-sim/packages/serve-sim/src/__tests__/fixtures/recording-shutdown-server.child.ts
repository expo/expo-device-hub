import { mock, spyOn } from "bun:test";
import * as childProcess from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Exercise the real CLI, DeviceSession recording lifecycle, and state/report files.
// Only the host/native boundaries and the 65-second timer are controlled here.
const directory = process.env.SERVE_SIM_STATE_DIR!;
const device = "00000000-0000-0000-0000-000000000288";
const events = join(directory, "events.ndjson");
const output = join(directory, "recording.mp4");
const manifest = join(directory, "session.json");
const event = (name: string) => appendFileSync(events, JSON.stringify({
  name,
  statePresent: existsSync(join(directory, `server-${device}.json`)),
  reportPresent: existsSync(join(directory, `recording-shutdown-failed-${process.pid}.json`)),
}) + "\n");
const completed = new Promise<void>(resolve => process.stdin.once("data", () => resolve()));

mock.module("child_process", () => ({
  ...childProcess,
  execSync: (command: string) => {
    if (command === "xcrun simctl list devices -j") {
      return JSON.stringify({ devices: { iOS: [{ udid: device, state: "Booted" }] } });
    }
    if (command === `xcrun simctl bootstatus ${device} -b`) return "";
    throw new Error(`Unexpected host command: ${command}`);
  },
  execFileSync: () => { throw new Error("Unexpected host executable"); },
}));
const simulatorHost = await import("../../simulator-host");
mock.module("../../simulator-host", () => ({ ...simulatorHost, openSimulatorHost: () => {} }));
const native = await import("../../native");
mock.module("../../native", () => ({
  ...native,
  NativeHid: class {},
  NativeCapture: class {
    async startRecording() { writeFileSync(output, "unfinished"); }
    async stopRecording() {
      event("writer-start");
      await completed;
      writeFileSync(output, "finished");
      event("writer-finish");
      if (process.env.RECORDING_SHUTDOWN_FAIL === "1") throw new Error("delayed native finish failed");
      writeFileSync(manifest, "{}");
      return manifest;
    }
  },
}));
const launchManager = await import("../../launch-manager");
let armed = false;
mock.module("../../launch-manager", () => ({
  ...launchManager,
  disarmStaleCapabilityLoader: async () => {},
  armCapabilityLoader: async () => { armed = true; },
  devicesArmedHere: () => armed ? [device] : [],
  waitForLaunchUpdates: async () => {},
  releaseSession: async () => { event("device-disarm"); armed = false; },
  releaseSessionSync: () => { event("device-disarm-sync"); armed = false; },
}));
const { captureRuntime } = await import("../../capture/runtime");
spyOn(captureRuntime, "disableAll").mockImplementation(async () => { event("capture-disable"); });
const { DeviceSession } = await import("../../device-session");
spyOn(DeviceSession.prototype, "start").mockImplementation(function (this: InstanceType<typeof DeviceSession>) {
  (this as any).phase = "running";
  return Promise.resolve();
});
const setTimeoutOriginal = globalThis.setTimeout;
globalThis.setTimeout = ((callback: TimerHandler, ms?: number, ...args: unknown[]) =>
  setTimeoutOriginal(callback, ms === 65_000 ? 50 : ms, ...args)) as typeof setTimeout;

const portReservation = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
const port = portReservation.port!;
await portReservation.stop(true);
process.argv = [process.execPath, "serve-sim", device, "--port", String(port), "--quiet"];
await import("../../index");
