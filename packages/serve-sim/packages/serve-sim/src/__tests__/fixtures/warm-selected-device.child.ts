import { mock, spyOn } from "bun:test";
import * as childProcess from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "../../state";

const hostExecFileSync = childProcess.execFileSync;
const first = "00000000-0000-0000-0000-000000000601";
const extra = "00000000-0000-0000-0000-000000000602";
const fresh = "00000000-0000-0000-0000-000000000603";
const devices = new Map([
  [first, "Booted"],
  [extra, "Booted"],
  [fresh, "Shutdown"],
]);
const environments = new Map<string, Record<string, string>>();
const callsFile = join(stateDir(), "warm-selected-native.jsonl");
const assets = join(stateDir(), "warm-selected-assets");
mkdirSync(assets, { recursive: true });
const loader = join(assets, "libServeSimCapabilityLoader.dylib");
writeFileSync(loader, "");
writeFileSync(join(assets, "libSimPasteboardReader.dylib"), "");

const listing = () =>
  JSON.stringify({
    devices: {
      iOS: [...devices].map(([udid, state]) => ({ udid, state, name: udid })),
    },
  });

// Native launchd is an in-memory boundary. The real manager writes and reads its actual files.
const nativeCommand = (args: string[]): string => {
  appendFileSync(callsFile, JSON.stringify(args) + "\n");
  const [command, udid] = args;
  if (command === "list" && args[1] === "devices") return listing();
  if (!udid || !devices.has(udid)) throw new Error(`Unexpected native command: ${args.join(" ")}`);
  if (command === "boot") {
    devices.set(udid, "Booted");
    return "";
  }
  if (command === "bootstatus" && devices.get(udid) === "Booted") return "";
  if (command === "shutdown") {
    devices.set(udid, "Shutdown");
    environments.delete(udid);
    return "";
  }
  if (command === "spawn" && args[2] === "launchctl") {
    if (devices.get(udid) !== "Booted")
      throw new Error("Process spawn via launchd failed because device is not booted.");
    const [, , , action, name, value] = args;
    const environment = environments.get(udid) ?? {};
    environments.set(udid, environment);
    if (action === "getenv" && name) return environment[name] ?? "";
    if (action === "setenv" && name && value !== undefined) {
      environment[name] = value;
      return "";
    }
    if (action === "unsetenv" && name) {
      delete environment[name];
      return "";
    }
  }
  throw new Error(`Unexpected native command: ${args.join(" ")}`);
};

mock.module("child_process", () => ({
  ...childProcess,
  execSync: (command: string) => {
    if (/^xcrun simctl list devices(?: booted)? -j$/.test(command)) return listing();
    throw new Error(`Unexpected host command: ${command}`);
  },
  execFileSync: (command: string, args: string[], options: unknown) => {
    if (command === "/usr/sbin/sysctl" && args.join(" ") === "-n kern.bootsessionuuid")
      return hostExecFileSync(command, args, options as any);
    throw new Error(`Unexpected host executable: ${command}`);
  },
}));
const simctlModule = await import("../../simctl");
mock.module("../../simctl", () => ({
  ...simctlModule,
  simctl: async (args: string[]) => nativeCommand(args),
  simctlRaw: async (args: string[]) => nativeCommand(args),
  simctlSync: nativeCommand,
}));
const assetModule = await import("../../capabilities/runtime/assets");
mock.module("../../capabilities/runtime/assets", () => ({
  ...assetModule,
  capabilityLoaderPath: () => loader,
  capabilityLoaderDir: () => assets,
}));
const simulatorHost = await import("../../simulator-host");
mock.module("../../simulator-host", () => ({ ...simulatorHost, openSimulatorHost: () => {} }));
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

// No manager, registry, Clipboard definition/session, adoption or cleanup operation is mocked.
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
  "--orphan",
];
await import("../../index");
