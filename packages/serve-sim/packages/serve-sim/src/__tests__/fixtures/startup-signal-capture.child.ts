import { mock, spyOn } from "bun:test";
import * as childProcess from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
const directory = process.env.SERVE_SIM_STATE_DIR!;
const phase = process.env.REPRO_PHASE ?? "enable";
const device = "00000000-0000-0000-0000-000000000288";
let armed = false;
let capturing = false;
let keepAlive: ReturnType<typeof setInterval> | undefined;
const event = (name: string) => appendFileSync(join(directory, "events.ndjson"), JSON.stringify({ name, armed, capturing, listeners: process.listenerCount("SIGTERM") }) + "\n");
const completed = new Promise<void>(resolve => process.stdin.once("data", () => resolve()));
mock.module("child_process", () => ({
  ...childProcess,
  execSync: (command: string) => {
    if (command === "xcrun simctl list devices -j") return JSON.stringify({ devices: { iOS: [{ udid: device, state: "Booted" }] } });
    if (command === `xcrun simctl bootstatus ${device} -b`) return "";
    throw new Error(`Unexpected host command: ${command}`);
  },
  execFileSync: () => { throw new Error("Unexpected host executable"); },
}));
const simctlModule = await import("../../simctl");
mock.module("../../simctl", () => ({
  ...simctlModule,
  simctl: async (args: string[]) => {
    if (args.join(" ") === `bootstatus ${device} -b`) return "";
    throw new Error(`Unexpected host command: ${args.join(" ")}`);
  },
}));
const simulatorHost = await import("../../simulator-host");
mock.module("../../simulator-host", () => ({ ...simulatorHost, openSimulatorHost: () => {} }));
const launchManager = await import("../../launch-manager");
mock.module("../../launch-manager", () => ({
  ...launchManager,
  applyDefaultCapabilities: async () => {},
  disarmStaleCapabilityLoader: async () => {},
  armCapabilityLoader: async () => { armed = true; event("armed"); },
  devicesArmedHere: () => armed ? [device] : [],
  waitForLaunchUpdates: async () => {},
  releaseSession: async () => { event("disarm"); armed = false; },
  releaseSessionSync: () => { event("disarm-sync"); armed = false; },
}));
const { captureReapersForTest } = await import("../../capture/mitm-engine");
const { captureRuntime } = await import("../../capture/runtime");
const captureMetaForOriginal = captureRuntime.metaFor;
spyOn(captureRuntime, "metaFor").mockImplementation((udid: string) => ({ ...captureMetaForOriginal(udid), attachment: capturing ? "capturing" : "off" }) as any);
const reap = () => { event("proxy-reaped"); capturing = false; clearInterval(keepAlive); };
spyOn(captureRuntime, "enableForDevice").mockImplementation(async () => {
  capturing = true;
  keepAlive = setInterval(() => {}, 1000);
  // Registration uses the shipped capture reaper, with the actual CLI startup listener already present.
  captureReapersForTest.add(reap);
  if (phase === "enable") {
    event("startup-ready");
    console.log("startup-ready");
    await completed;
  }
  event("enable-complete");
  return { proxyAddress: "127.0.0.1:1" } as any;
});
spyOn(captureRuntime, "disableAll").mockImplementation(async () => {
  event("disable-requested");
  if (phase === "enable") await completed;
  capturing = false;
  clearInterval(keepAlive);
  captureReapersForTest.remove(reap);
  event("disable-complete");
});
const launchApp = await import("../../launch-app");
spyOn(launchApp, "launchAppAsync").mockImplementation(async () => {
  event("startup-ready");
  console.log("startup-ready");
  await completed;
  event("launch-complete");
});
const runtime = await import("../../runtime");
const servePreviewOriginal = runtime.servePreview;
if (phase === "bind") {
  spyOn(runtime, "servePreview").mockImplementation(async (opts: Parameters<typeof import("../../runtime").servePreview>[0]) => {
    event("startup-ready");
    console.log("startup-ready");
    await completed;
    event("bind-resume");
    const server = await servePreviewOriginal(opts);
    event("bound");
    return server;
  });
}
process.on("exit", () => event("exit"));
const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const port = reservation.port!;
await reservation.stop(true);
process.argv = [process.execPath, "serve-sim", device, "--network-capture", "--quiet", "--port", String(port), ...(phase === "launch" ? ["--launch-app-identifier", "com.example.app"] : [])];
await import("../../index");
event("cli-returned");
console.log("cli-returned");
