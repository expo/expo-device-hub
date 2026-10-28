import { mock, spyOn } from "bun:test";
import * as childProcess from "node:child_process";

const device = "00000000-0000-0000-0000-000000000288";
// Keep the real CLI, middleware and private owner channel; deny native work.
mock.module("child_process", () => ({
  ...childProcess,
  execSync: (command: string) => {
    if (command === "xcrun simctl list devices -j")
      return JSON.stringify({ devices: { iOS: [{ udid: device, state: "Booted" }] } });
    throw new Error(`Unexpected host command: ${command}`);
  },
}));
const simctlModule = await import("../../simctl");
mock.module("../../simctl", () => ({
  ...simctlModule,
  simctl: async (args: string[]) => {
    if (args.join(" ") === "list devices -j")
      return JSON.stringify({ devices: { iOS: [{ udid: device, state: "Booted" }] } });
    if (args.join(" ") === `bootstatus ${device} -b`) return "";
    throw new Error(`Unexpected native command: ${args.join(" ")}`);
  },
}));
const simulatorHost = await import("../../simulator-host");
mock.module("../../simulator-host", () => ({ ...simulatorHost, openSimulatorHost: () => {} }));
const launchManager = await import("../../launch-manager");
mock.module("../../launch-manager", () => ({
  ...launchManager,
  applyDefaultCapabilities: async () => [],
  disarmStaleCapabilityLoader: async () => {},
  armCapabilityLoader: async () => {},
  devicesArmedHere: () => [],
  waitForLaunchUpdates: async () => {},
}));
const native = await import("../../native");
mock.module("../../native", () => ({
  ...native,
  NativeHid: class {},
  NativeCapture: class {
    async updateStreamSettings() {}
  },
}));
const { DeviceSession } = await import("../../device-session");
spyOn(DeviceSession.prototype, "start").mockImplementation(
  function (this: InstanceType<typeof DeviceSession>) {
    (this as any).phase = "running";
    return Promise.resolve();
  },
);
const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const port = reservation.port!;
await reservation.stop(true);
process.argv = [
  process.execPath,
  "serve-sim",
  device,
  "--port",
  String(port),
  "--quiet",
  "--require-token",
  "--transport",
  "webrtc",
  "--disable",
  "clipboard",
  ...(process.env.ORPHAN_TEST === "1" ? ["--orphan"] : []),
];
await import("../../index");
