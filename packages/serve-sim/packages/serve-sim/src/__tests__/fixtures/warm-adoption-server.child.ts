import { mock, spyOn } from "bun:test";
import * as childProcess from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "../../state";
import { withLaunchStateLock } from "../../launch-state-lock";

// Two warm devices in one orphan: the default (first) and an extra one that warms in the
// background. WARM_FAILURE selects a failure on the extra device: "none", "retire", "warmup"
// (its warmup cleanup fails after the adoption) or "warmup-during" (it fails during adoption).
const first = "00000000-0000-0000-0000-000000000501";
const extra = "00000000-0000-0000-0000-000000000502";
const failure = process.env.WARM_FAILURE ?? "none";
if (failure === "cancel-reservation") {
  void withLaunchStateLock(extra, async () => {
    while (!existsSync(join(stateDir(), "release-extra-lock"))) await Bun.sleep(10);
  }).then(() => console.error("reservation lock released"));
}
const listing = JSON.stringify({
  devices: { iOS: [first, extra].map((udid) => ({ udid, state: "Booted" })) },
});
mock.module("child_process", () => ({
  ...childProcess,
  execSync: (command: string) => {
    if (command === "xcrun simctl list devices -j") return listing;
    throw new Error(`Unexpected host command: ${command}`);
  },
}));
const simctlModule = await import("../../simctl");
mock.module("../../simctl", () => ({
  ...simctlModule,
  simctl: async (args: string[]) => {
    const [command, udid, flag] = args;
    if (udid === extra) console.error(`native ${extra}: ${args.join(" ")}`);
    if (command === "boot") throw new Error("Unable to boot device in current state: Booted");
    if (args.join(" ") === "list devices -j") return listing;
    if (command === "bootstatus" && [first, extra].includes(udid!) && (!flag || flag === "-b"))
      return "";
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
  releaseSession: async (udid: string) => {
    if (failure === "retire") throw new Error("shutdown refused");
    console.error(`released ${udid}`);
  },
}));
const native = await import("../../native");
mock.module("../../native", () => ({
  ...native,
  NativeHid: class {},
  NativeCapture: class {
    async updateStreamSettings() {}
    async stop() {}
  },
}));
const deviceSession = await import("../../device-session");
spyOn(deviceSession.DeviceSession.prototype, "start").mockImplementation(
  function (this: InstanceType<typeof deviceSession.DeviceSession>) {
    (this as any).phase = "running";
    return Promise.resolve();
  },
);
const startDeviceSession = deviceSession.startDeviceSession;
mock.module("../../device-session", () => ({
  ...deviceSession,
  // The extra device's warmup reaches its capture start, then fails to close once claimed.
  startDeviceSession: async (udid: string, settings: unknown, signal?: AbortSignal) => {
    if (udid === extra && failure.startsWith("warmup")) {
      console.error(`warmup waiting ${udid}`);
      if (!signal!.aborted)
        await new Promise((resolve) => signal!.addEventListener("abort", resolve, { once: true }));
      if (failure === "warmup") await Bun.sleep(500);
      throw new AggregateError(
        [new Error("close failed")],
        "Simulator capture startup and cleanup failed",
      );
    }
    return startDeviceSession(udid, settings as never, signal);
  },
}));
const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const port = reservation.port!;
await reservation.stop(true);
process.argv = [
  process.execPath,
  "serve-sim",
  first,
  extra,
  "--port",
  String(port),
  "--quiet",
  "--require-token",
  "--transport",
  "webrtc",
  "--disable",
  "clipboard",
  "--orphan",
];
await import("../../index");
