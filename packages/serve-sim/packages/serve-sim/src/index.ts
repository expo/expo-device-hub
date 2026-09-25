#!/usr/bin/env node
import { Command, InvalidArgumentError } from "commander";
import { execFileSync, execSync, spawn as nodeSpawn, type ChildProcess } from "child_process";
import { existsSync, mkdirSync, openSync, closeSync, readSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { createHash, randomBytes } from "crypto";
import { networkInterfaces } from "os";
import { join, resolve } from "path";
import WebSocket from "ws";
import {
  stateDir,
  stateFileForDevice,
  listStateFiles,
  inProcessServeSimState,
  previewStartupPayload,
  writeServeSimState,
  clearServeSimState,
  type ServeSimDeviceState,
  type StreamSettings,
  type WebRtcIceServer,
} from "./state";
import { textToKeyEvents, UnsupportedCharacterError, sendKeyEventsToWs } from "./text-to-keys";
import { dirnameOf, sleepSync, isPortFree, servePreview } from "./runtime";
import { isLoopbackHost } from "./middleware-utils";
import { launchAppAsync } from "./launch-app";
import {
  assertKnownCapabilities,
  hasDefaultCapabilities,
} from "./capabilities";
import {
  applyDefaultCapabilities,
  armCapabilityLoader,
  devicesArmedHere,
  disarmStaleCapabilityLoader,
  releaseSessionSync,
  releaseSession,
  stopLaunchSession,
  waitForLaunchUpdates,
} from "./launch-manager";
import { killOwnListeners } from "./ports";
import { findBootedDevice, resolveDevice } from "./device";
import { openSimulatorHost } from "./simulator-host";
import { runStreamDebugLog, startStreamDebugLog } from "./stream-debug-log";
import { permissions } from "./permissions";
import { uiSettings } from "./ui-settings";
import { debugCli, debugHelper, debugState } from "./debug";
import type { EventLogEntry } from "./event-log";
import { formatEventLogLine } from "./event-log-format";
import {
  cameraStateDir as simcamStateDir,
  cameraHelperBundlesFile as helperBundlesFile,
  cameraHelperPidFile as helperPidFile,
  cameraHelperSocketFile as helperSocketFile,
  isCameraHelperAlive as isHelperAlive,
  readCameraStatus,
  readInjectedCameraBundles as readInjectedBundles,
  sendCameraHelperCommand as sendHelperCommand,
} from "./camera-helper";
import { parseIceUrlList, streamHelperArgs, streamSettingsEqual } from "./stream-runtime-args";
import { MAX_MJPEG_STREAM_FPS, MAX_VIDEO_STREAM_FPS } from "./stream-settings";
import { parseHingeAngle } from "./hinge-angle";
import { sendHingeAngleToWs } from "./hinge-command";

// `import.meta.dir` is Bun-only; resolve once via fileURLToPath so the bundled
// CLI works under plain `node` too.
const __dirname = dirnameOf(import.meta.url);

// Stamped in at build time (see build.ts), mirroring __PREVIEW_HTML_B64__. In
// the un-bundled dev run the define is absent, so fall back to reading the
// package.json that sits next to the source / dist bin.
declare const __SERVE_SIM_VERSION__: string | undefined;
function resolveVersion(): string {
  if (typeof __SERVE_SIM_VERSION__ === "string") return __SERVE_SIM_VERSION__;
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// Embed the Swift helper so `bun build --compile` produces a self-contained
// `serve-sim` binary. In dev / the un-compiled ESM bin the returned path is a
// real file on disk; inside a compiled binary it points at bun's virtual FS
// and we extract the bytes to a cached location on first use.

type ServerState = ServeSimDeviceState;

type StreamRuntimeOptions = StreamSettings;
function ensureStateDir() {
  mkdirSync(stateDir(), { recursive: true });
}

function readState(udid?: string): ServerState | null {
  if (udid) {
    return readStateFile(stateFileForDevice(udid));
  }
  // No udid: return the first live device state
  for (const file of listStateFiles()) {
    const state = readStateFile(file);
    if (state) return state;
  }
  return null;
}

/**
 * Snapshot simctl's boot state once per `readStateFile` batch. A full
 * `simctl list devices -j` is ~50ms; doing it per-state multiplied the cost
 * by the number of running helpers. We cache for 1 second so a flurry of
 * readStateFile() calls (e.g. readAllStates loop) shares one lookup.
 */
let bootedSnapshot: { at: number; booted: Set<string> | null } = { at: 0, booted: null };
function getBootedUdids(): Set<string> | null {
  const now = Date.now();
  if (bootedSnapshot.booted && now - bootedSnapshot.at < 1000) {
    return bootedSnapshot.booted;
  }
  try {
    const output = execSync("xcrun simctl list devices booted -j", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 3_000,
    });
    const data = JSON.parse(output) as {
      devices: Record<string, Array<{ udid: string; state: string }>>;
    };
    const booted = new Set<string>();
    for (const runtime of Object.values(data.devices)) {
      for (const device of runtime) {
        if (device.state === "Booted") booted.add(device.udid);
      }
    }
    bootedSnapshot = { at: now, booted };
    return booted;
  } catch {
    // simctl lookup failed (Xcode offline, etc.) — we can't prove the device
    // is shutdown, so don't treat as stale. Returns null so caller skips the
    // booted check for this invocation.
    return null;
  }
}

function readStateFile(file: string): ServerState | null {
  try {
    if (!existsSync(file)) {
      debugState("state file missing %s", file);
      return null;
    }
    const state = JSON.parse(readFileSync(file, "utf-8")) as ServerState;
    try {
      process.kill(state.pid, 0);
    } catch {
      // Helper process is gone — drop the file.
      debugState("helper pid %d dead, removing stale state %s", state.pid, file);
      unlinkSync(file);
      return null;
    }
    // The helper is alive, but the simulator it was bound to may have been
    // shut down (Simulator.app quit, machine slept, `simctl shutdown`, etc.).
    // When that happens the helper keeps accepting /stream.mjpeg connections
    // but never emits frames, so clients hang on "Connecting...". Detect and
    // recycle here so --detach / --list always return a working stream.
    const booted = getBootedUdids();
    if (booted && !booted.has(state.device)) {
      if (state.pid === process.pid) {
        // The state belongs to *this* process (an in-process/preview server
        // recorded its own pid via inProcessServeSimState). Never SIGTERM
        // ourselves — that would take the whole server down. Just drop the
        // stale file; the live server reaps its own sessions on grid polls.
        debugState("dropping own stale state for non-booted device %s", state.device);
        try { unlinkSync(file); } catch {}
        return null;
      }
      debugState(
        "helper pid %d bound to non-booted device %s — killing stale helper",
        state.pid,
        state.device,
      );
      console.error(
        `[serve-sim] Helper pid ${state.pid} is bound to device ${state.device} which is no longer booted — killing stale helper.`,
      );
      try { process.kill(state.pid, "SIGTERM"); } catch {}
      try { unlinkSync(file); } catch {}
      return null;
    }
    debugState("state ok pid=%d device=%s port=%d", state.pid, state.device, state.port);
    return state;
  } catch (err) {
    debugState("readStateFile threw for %s: %o", file, err);
    return null;
  }
}

function readAllStates(): ServerState[] {
  const states: ServerState[] = [];
  for (const file of listStateFiles()) {
    const state = readStateFile(file);
    if (state) states.push(state);
  }
  return states;
}

function writeState(state: ServerState) {
  ensureStateDir();
  writeServeSimState(state);
  debugState("wrote state pid=%d device=%s port=%d", state.pid, state.device, state.port);
}

// `ws` rather than the global WebSocket: the package supports Node 20, where the global is
// undefined, and a header keeps the token out of request URLs and proxy logs.
function openHelperSocket(state: ServerState): WebSocket {
  return new WebSocket(
    state.wsUrl,
    state.token ? { headers: { Authorization: `Bearer ${state.token}` } } : undefined,
  );
}

function clearState(udid?: string) {
  if (udid) {
    debugState("clearState device=%s", udid);
    try { unlinkSync(stateFileForDevice(udid)); } catch {}
  } else {
    debugState("clearState (all)");
    for (const file of listStateFiles()) {
      try { unlinkSync(file); } catch {}
    }
  }
}

// ─── Device helpers ───

/**
 * Pick a sensible default device to boot when the user runs `serve-sim` with
 * no booted simulator. Prefers an available iPhone on the newest iOS runtime.
 */
function pickDefaultDevice(): { udid: string; name: string } | null {
  try {
    const output = execSync("xcrun simctl list devices -j", { encoding: "utf-8" });
    const data = JSON.parse(output) as {
      devices: Record<string, Array<{ udid: string; name: string; state: string; isAvailable?: boolean }>>;
    };
    const iosRuntimes = Object.keys(data.devices)
      .filter((k) => /SimRuntime\.iOS-/i.test(k))
      .sort((a, b) => {
        const va = (a.match(/iOS-(\d+)-(\d+)/) ?? []).slice(1).map(Number);
        const vb = (b.match(/iOS-(\d+)-(\d+)/) ?? []).slice(1).map(Number);
        return (vb[0] ?? 0) - (va[0] ?? 0) || (vb[1] ?? 0) - (va[1] ?? 0);
      });
    for (const runtime of iosRuntimes) {
      const devices = data.devices[runtime] ?? [];
      const iphone = devices.find(
        (d) => d.isAvailable !== false && /^iPhone\b/i.test(d.name),
      );
      if (iphone) return { udid: iphone.udid, name: iphone.name };
    }
  } catch {}
  return null;
}

function getDeviceName(udid: string): string | null {
  return readDeviceNamesByUdid().get(udid) ?? null;
}

function readDeviceNamesByUdid(): Map<string, string> {
  const names = new Map<string, string>();
  try {
    const output = execSync("xcrun simctl list devices -j", { encoding: "utf-8" });
    const data = JSON.parse(output) as {
      devices: Record<string, Array<{ udid: string; name: string; state: string }>>;
    };
    for (const runtime of Object.values(data.devices)) {
      for (const device of runtime) {
        names.set(device.udid, device.name);
      }
    }
  } catch {}
  return names;
}

function isDeviceBooted(udid: string): boolean {
  try {
    const output = execSync("xcrun simctl list devices -j", { encoding: "utf-8" });
    const data = JSON.parse(output) as {
      devices: Record<string, Array<{ udid: string; state: string }>>;
    };
    for (const runtime of Object.values(data.devices)) {
      for (const device of runtime) {
        if (device.udid === udid) return device.state === "Booted";
      }
    }
  } catch {}
  return false;
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Kill a process and wait for it to actually exit. */
function stopProcess(pid: number): void {
  try { process.kill(pid, "SIGTERM"); } catch { return; }
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      sleepSync(25);
    } catch {
      return;
    }
  }
  try { process.kill(pid, "SIGKILL"); } catch {}
  const deadline2 = Date.now() + 500;
  while (Date.now() < deadline2) {
    try { process.kill(pid, 0); sleepSync(25); } catch { return; }
  }
}

function bootDevice(udid: string): void {
  if (!isDeviceBooted(udid)) {
    try {
      execSync(`xcrun simctl boot ${udid}`, { encoding: "utf-8", stdio: "pipe" });
    } catch (err: any) {
      const msg = (err.stderr ?? err.message ?? "").toLowerCase();
      if (!msg.includes("booted") && !msg.includes("current state")) {
        throw new Error(`Failed to boot device ${udid}: ${err.stderr || err.message}`);
      }
    }
  }
  // Open the selected Xcode's Simulator or Device Hub in the background.
  // Ignore failure: `open` can hang or miss a window server on headless hosts.
  try {
    openSimulatorHost(udid);
  } catch {}
}

function getLocalNetworkIP(): string | null {
  const interfaces = networkInterfaces();
  for (const ifaces of Object.values(interfaces)) {
    for (const iface of ifaces ?? []) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return null;
}

async function findAvailablePort(start: number): Promise<number> {
  const usedPorts = new Set(readAllStates().map((s) => s.port));
  for (let port = start; port < start + 100; port++) {
    if (usedPorts.has(port)) continue;
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No available port found in range ${start}-${start + 99}`);
}

async function ensureBooted(udid: string): Promise<void> {
  bootDevice(udid);
  // `simctl bootstatus -b` blocks until the device's services are actually ready
  // (not just flipped to "Booted"). Much more reliable than polling `simctl list`.
  try {
    execSync(`xcrun simctl bootstatus ${udid} -b`, {
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 60_000,
    });
  } catch (err: any) {
    if (!isDeviceBooted(udid)) {
      console.error(`Device ${udid} failed to reach booted state: ${err.stderr || err.message}`);
      process.exit(1);
    }
  }

  // Only clean up a capability loader an earlier session left behind. Arming belongs to
  // launchApp and enableCapabilities: this runs in the stream helper too, and a
  // helper arming after its parent disarmed would leave the insert set.
  await disarmStaleCapabilityLoader(udid);
}

/**
 * Clears only the simulators this process armed. The insert and the config are
 * shared by every serve-sim on a device, so a session that armed nothing must
 * leave another session's capabilities alone. Runs at most once per device.
 */
function disarmDevicesArmedHere(): void {
  for (const udid of devicesArmedHere()) {
    try {
      releaseSessionSync(udid, process.pid, (capability) => {
        if (capability.name === "camera") stopExistingHelper(udid);
      });
    } catch (error) {
      console.error(`Could not clean up capabilities on ${udid}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

let sessionStopping = false;
let releasingDevices: Promise<void> | undefined;

function disarmDevicesArmedHereAsync(): Promise<void> {
  return releasingDevices ??= (async () => {
    await waitForLaunchUpdates();
    for (const udid of devicesArmedHere()) {
      await releaseSession(udid, process.pid, (capability) => {
        if (capability.name === "camera") stopExistingHelper(udid);
      });
    }
  })();
}

// A stream helper outlives the session that spawned it, so it must not arm the
// device: arming after its parent disarmed would leave the insert set for good.
const STREAM_HELPER_ENV = "SERVE_SIM_STREAM_HELPER";

// ─── Preview server lifecycle ───

/** Resolve the command to re-exec this CLI (compiled binary or `node …js`). */
function reExecArgs(extra: string[]): { command: string; args: string[] } {
  // Compiled standalone binary: argv[0] is the serve-sim binary itself.
  if (process.argv[0] && /(^|\/)serve-sim$/.test(process.argv[0])) {
    return { command: process.argv[0], args: extra };
  }
  // Running the JS bundle: `node /path/to/serve-sim.js`.
  return { command: process.argv[0]!, args: [process.argv[1]!, ...extra] };
}

/** Poll for the state file a re-exec'd preview server writes once it's serving. */
async function waitForStateFile(udid: string, timeoutMs = 150_000): Promise<ServerState | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = readState(udid);
    if (state) return state;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

/**
 * Start a preview server that streams `udid` in-process — it re-execs this CLI
 * in `serve` mode rather than spawning the old Swift helper. Detached + unref'd
 * for daemon mode (`--detach`); attached otherwise so the caller can monitor it.
 */
async function startHelper(
  udid: string,
  port: number,
  opts: { detach: boolean; stream?: StreamSettings },
): Promise<{ pid: number; child?: ChildProcess }> {
  debugHelper("startHelper udid=%s port=%d detach=%s", udid, port, opts.detach);

  const host = "127.0.0.1";
  ensureStateDir();
  killOwnListeners(port);
  clearState(udid); // don't read a stale state file from a previous run

  const logFile = join(stateDir(), `server-${udid}.log`);
  const logFd = openSync(logFile, "w");
  const { command, args } = reExecArgs(streamHelperArgs(udid, port, host, opts.stream));
  const child = nodeSpawn(command, args, {
    detached: opts.detach,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, [STREAM_HELPER_ENV]: "1" },
  });
  closeSync(logFd);
  if (opts.detach) child.unref();

  // The child boots the sim then writes its state once it's bound + serving.
  const state = await waitForStateFile(udid);
  if (!state) {
    if (child.pid) stopProcess(child.pid);
    let log = "";
    try { log = readFileSync(logFile, "utf-8").trim(); } catch {}
    console.error(log ? `Preview server failed:\n${log}` : "Preview server failed to start");
    process.exit(1);
  }
  return opts.detach ? { pid: state.pid } : { pid: state.pid, child };
}

// ─── Commands ───

/** Foreground follow mode (default). Stays attached, cleans up on Ctrl+C. */
async function follow(
  devices: string[],
  startPort: number,
  quiet: boolean,
  stream?: StreamSettings,
  replaceMismatchedStream = false,
) {
  debugCli("follow devices=%o startPort=%d", devices, startPort);
  const udids = devices.length > 0
    ? devices.map(resolveDevice)
    : (() => {
        const booted = findBootedDevice();
        if (booted) return [booted];
        const fallback = pickDefaultDevice();
        if (!fallback) {
          console.error("No device specified and no available iOS simulator found.");
          process.exit(1);
        }
        if (!quiet) {
          console.log(`No booted simulator — booting ${fallback.name}...`);
        }
        return [fallback.udid];
      })();

  const children = new Map<string, ChildProcess>();
  const states: ServerState[] = [];
  let port = startPort;

  for (const udid of udids) {
    // Return existing server if already running
    const existing = readState(udid);
    if (existing) {
      if (replaceMismatchedStream && !streamSettingsEqual(existing.streamSettings, stream)) {
        stopProcess(existing.pid);
        clearState(udid);
      } else {
        if (!quiet) {
          const name = getDeviceName(udid) ?? udid;
          if (udids.length > 1) console.log(`\n==> ${name} (${udid}) <==`);
          console.log(`  Already running on port ${existing.port}`);
          console.log(`  Stream:    ${existing.streamUrl}`);
          console.log(`  WebSocket: ${existing.wsUrl}`);
        }
        states.push(existing);
        continue;
      }
    }

    port = await findAvailablePort(port);
    const { child } = await startHelper(udid, port, { detach: false, stream });

    if (child) {
      children.set(udid, child);
    }

    // The re-exec'd preview server wrote its own in-process state (same-origin
    // /helper URLs); reuse it rather than reconstructing helper-port URLs.
    const state = readState(udid) ?? inProcessServeSimState(udid, port, "/", "127.0.0.1");
    states.push(state);

    if (!quiet) {
      const name = getDeviceName(udid) ?? udid;
      if (udids.length > 1) console.log(`\n==> ${name} (${udid}) <==`);
      console.log(`  Stream:    ${state.streamUrl}`);
      console.log(`  WebSocket: ${state.wsUrl}`);
      console.log(`  Port:      ${port}`);
    }

    port++;
  }

  // Machine-readable JSON to stdout
  if (states.length === 1) {
    const s = states[0]!;
    console.log(JSON.stringify({
      url: s.url, streamUrl: s.streamUrl, wsUrl: s.wsUrl, port: s.port, device: s.device,
    }));
  } else {
    console.log(JSON.stringify({
      devices: states.map((s) => ({
        url: s.url, streamUrl: s.streamUrl, wsUrl: s.wsUrl, port: s.port, device: s.device,
      })),
    }));
  }

  // If no new children were spawned (all already running), exit
  if (children.size === 0) return;

  let shuttingDown = false;

  const cleanup = async (exitCode: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    sessionStopping = true;
    if (!quiet) console.log("\nShutting down...");
    for (const [udid, child] of children) {
      const pid = child.pid;
      if (pid) stopProcess(pid);
      clearState(udid);
    }
    await disarmDevicesArmedHereAsync();
    children.clear();
    process.exit(exitCode);
  };

  // Monitor children — exit when all die (helper crashed / exited on its own)
  for (const [udid, child] of children) {
    child.on("exit", (code) => {
      debugHelper("child exit udid=%s pid=%d code=%s", udid, child.pid, code);
      if (shuttingDown) return;
      if (!quiet) console.error(`[${udid}] Helper exited (code ${code})`);
      clearState(udid);
      children.delete(udid);
      if (children.size === 0) cleanup(code ?? 1);
    });
  }

  // Clean shutdown on signal
  process.on("SIGINT", () => cleanup(0));
  process.on("SIGTERM", () => cleanup(0));
  process.on("SIGHUP", () => cleanup(0));

  // Last-resort synchronous cleanup if something else exits the process
  process.on("exit", () => {
    for (const [udid, child] of children) {
      try { if (child.pid) process.kill(child.pid, "SIGTERM"); } catch {}
      try { clearState(udid); } catch {}
    }
  });

  // Block forever
  await new Promise(() => {});
}

/** Detach mode (--detach). Spawns helpers and returns their states. */
async function detach(
  devices: string[],
  startPort: number,
  stream?: StreamSettings,
  replaceMismatchedStream = false,
): Promise<ServerState[]> {
  debugCli("detach devices=%o startPort=%d", devices, startPort);
  const udids = devices.length > 0
    ? devices.map(resolveDevice)
    : (() => {
        const booted = findBootedDevice();
        if (booted) return [booted];
        const fallback = pickDefaultDevice();
        if (!fallback) {
          console.error("No device specified and no available iOS simulator found.");
          process.exit(1);
        }
        return [fallback.udid];
      })();

  const states: ServerState[] = [];
  let port = startPort;

  for (const udid of udids) {
    const existing = readState(udid);
    if (existing) {
      if (replaceMismatchedStream && !streamSettingsEqual(existing.streamSettings, stream)) {
        stopProcess(existing.pid);
        clearState(udid);
      } else {
        states.push(existing);
        continue;
      }
    }

    port = await findAvailablePort(port);
    await startHelper(udid, port, { detach: true, stream });

    // Reuse the detached server's own in-process state (same-origin /helper URLs).
    states.push(readState(udid) ?? inProcessServeSimState(udid, port, "/", "127.0.0.1"));

    port++;
  }

  return states;
}

function printStatesJSON(states: ServerState[]) {
  if (states.length === 1) {
    const s = states[0]!;
    console.log(JSON.stringify({
      url: s.url, streamUrl: s.streamUrl, wsUrl: s.wsUrl, port: s.port, device: s.device,
    }));
  } else {
    console.log(JSON.stringify({
      devices: states.map((s) => ({
        url: s.url, streamUrl: s.streamUrl, wsUrl: s.wsUrl, port: s.port, device: s.device,
      })),
    }));
  }
}

/** List running streams (--list). */
function listStreams(deviceArg?: string) {
  if (deviceArg) {
    const udid = resolveDevice(deviceArg);
    const state = readState(udid);
    if (!state) {
      console.log(JSON.stringify({ running: false, device: udid }));
    } else {
      console.log(JSON.stringify({
        running: true,
        url: state.url, streamUrl: state.streamUrl, wsUrl: state.wsUrl,
        port: state.port, device: state.device, pid: state.pid,
      }));
    }
    return;
  }

  const states = readAllStates();
  if (states.length === 0) {
    console.log(JSON.stringify({ running: false }));
  } else if (states.length === 1) {
    const s = states[0]!;
    console.log(JSON.stringify({
      running: true,
      url: s.url, streamUrl: s.streamUrl, wsUrl: s.wsUrl,
      port: s.port, device: s.device, pid: s.pid,
    }));
  } else {
    console.log(JSON.stringify({
      running: true,
      streams: states.map((s) => ({
        url: s.url, streamUrl: s.streamUrl, wsUrl: s.wsUrl,
        port: s.port, device: s.device, pid: s.pid,
      })),
    }));
  }
}

/** Kill running streams (--kill). */
async function killStreams(deviceArg?: string): Promise<void> {
  const udid = deviceArg ? resolveDevice(deviceArg) : undefined;
  const state = udid ? readState(udid) : null;
  const states = udid ? (state ? [state] : []) : readAllStates();
  for (const current of states) {
    await stopLaunchSession(current.device, current.pid, (capability) => {
      if (capability.name === "camera") stopExistingHelper(current.device);
    });
    clearServeSimState(current.device, current.pid);
  }
  console.log(JSON.stringify(udid
    ? { disconnected: true, device: udid }
    : { disconnected: true, devices: states.map((current) => current.device) }));
}

async function eventLog(
  deviceArg?: string,
  opts: { json?: boolean; limit?: string } = {},
) {
  const udid = deviceArg ? resolveDevice(deviceArg) : undefined;
  const state = readState(udid);
  if (!state) {
    console.error("No serve-sim server running. Run `serve-sim` first.");
    process.exit(1);
  }

  const url = new URL("/api/event-log", state.url);
  if (udid) url.searchParams.set("device", state.device);
  const limit = parseEventLogLimit(opts.limit);
  if (limit != null) url.searchParams.set("limit", String(limit));

  let payload: { events: EventLogEntry[] };
  try {
    const res = await fetch(url, {
      headers: state.token ? { Authorization: `Bearer ${state.token}` } : undefined,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    payload = await res.json() as { events: EventLogEntry[] };
  } catch (err) {
    console.error(`Failed to read event log: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (opts.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  if (payload.events.length === 0) {
    console.log("No events.");
    return;
  }
  const deviceLabels = deviceLabelsForEvents(payload.events);
  for (const entry of payload.events) {
    console.log(formatEventLogLine(entry, {
      deviceLabel: entry.device ? deviceLabels.get(entry.device) : null,
    }));
  }
}

function parseEventLogLimit(value: string | undefined): number | undefined {
  if (value == null) return undefined;
  const limit = Number(value);
  if (!Number.isFinite(limit) || limit <= 0) {
    console.error("event-log --limit must be a positive number");
    process.exit(1);
  }
  return Math.floor(limit);
}

function deviceLabelsForEvents(events: EventLogEntry[]): Map<string, string> {
  const devices = [...new Set(events.map((event) => event.device).filter((device): device is string => !!device))];
  const names = new Map<string, string>();
  const deviceNames = readDeviceNamesByUdid();
  for (const device of devices) {
    names.set(device, deviceNames.get(device) ?? device.slice(0, 8));
  }

  const counts = new Map<string, number>();
  for (const name of names.values()) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  const labels = new Map<string, string>();
  for (const [device, name] of names) {
    labels.set(device, counts.get(name)! > 1 ? `${name} (${device.slice(0, 8)})` : name);
  }
  return labels;
}

async function gesture(jsonStr: string, deviceArg?: string) {
  const state = readState(deviceArg);
  if (!state) {
    console.error("No serve-sim server running. Run `serve-sim` first.");
    process.exit(1);
  }

  let touch: { type: string; x: number; y: number };
  try {
    touch = JSON.parse(jsonStr);
  } catch {
    console.error("Invalid JSON:", jsonStr);
    process.exit(1);
  }

  return new Promise<void>((resolve, reject) => {
    const ws = openHelperSocket(state);
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      const json = new TextEncoder().encode(JSON.stringify(touch));
      const msg = new Uint8Array(1 + json.length);
      msg[0] = 0x03;
      msg.set(json, 1);
      ws.send(msg);
      setTimeout(() => { ws.close(); resolve(); }, 50);
    };

    ws.onerror = () => {
      console.error("Failed to connect to serve-sim server at", state.wsUrl);
      reject(new Error("WebSocket connection failed"));
    };
  });
}

async function tap(xArg: string, yArg: string, deviceArg?: string) {
  const x = Number(xArg);
  const y = Number(yArg);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
    console.error("Usage: serve-sim tap <x> <y> [-d udid]");
    console.error("  x, y are normalized 0..1 of the simulator screen");
    console.error("  Example: serve-sim tap 0.5 0.9   # near bottom-center");
    process.exit(1);
  }
  const state = readState(deviceArg);
  if (!state) {
    console.error("No serve-sim server running. Run `serve-sim` first.");
    process.exit(1);
  }
  return new Promise<void>((resolve, reject) => {
    const ws = openHelperSocket(state);
    ws.binaryType = "arraybuffer";
    const send = (type: "begin" | "end") => {
      const json = new TextEncoder().encode(JSON.stringify({ type, x, y }));
      const msg = new Uint8Array(1 + json.length);
      msg[0] = 0x03;
      msg.set(json, 1);
      ws.send(msg);
    };
    ws.onopen = () => {
      send("begin");
      setTimeout(() => {
        send("end");
        setTimeout(() => { ws.close(); resolve(); }, 50);
      }, 40);
    };
    ws.onerror = () => {
      console.error("Failed to connect to serve-sim server at", state.wsUrl);
      reject(new Error("WebSocket connection failed"));
    };
  });
}

async function typeText(
  positional: string[],
  opts: { device?: string; stdin?: boolean; file?: string },
) {
  const deviceArg = opts.device;
  const useStdin = opts.stdin ?? false;
  const inputFile = opts.file;

  const sourceCount = [positional.length > 0, useStdin, inputFile != null].filter(Boolean).length;
  if (sourceCount === 0 || sourceCount > 1) {
    console.error("Usage: serve-sim type <text> [-d udid]");
    console.error("       serve-sim type --stdin [-d udid]");
    console.error("       serve-sim type --file <path> [-d udid]");
    console.error("");
    console.error("Only US-keyboard ASCII characters are supported (A-Z, a-z, 0-9,");
    console.error("space, newline, tab, and standard punctuation).");
    process.exit(1);
  }

  let text: string;
  if (useStdin) {
    text = readFileSync(0, "utf8");
  } else if (inputFile) {
    try {
      text = readFileSync(inputFile, "utf8");
    } catch (err) {
      console.error(`Failed to read file '${inputFile}': ${(err as Error).message}`);
      process.exit(1);
    }
  } else {
    text = positional.join(" ");
  }

  let events;
  try {
    events = textToKeyEvents(text);
  } catch (err) {
    if (err instanceof UnsupportedCharacterError) {
      console.error(err.message);
      console.error("Supported: A-Z, a-z, 0-9, space, newline, tab, and standard punctuation.");
      process.exit(1);
    }
    throw err;
  }

  const state = readState(deviceArg);
  if (!state) {
    console.error("No serve-sim server running. Run `serve-sim` first.");
    process.exit(1);
  }

  await sendKeyEventsToWs(state.wsUrl, events, { token: state.token });
}

async function hinge(angle: number, deviceArg?: string) {
  const state = readState(deviceArg);
  if (!state) {
    console.error("No serve-sim server running. Run `serve-sim` first.");
    process.exit(1);
  }
  await sendHingeAngleToWs(state.wsUrl, angle, { token: state.token });
  console.log(JSON.stringify({ device: state.device, hingeAngle: angle }));
}

async function rotate(orientation: string, deviceArg?: string) {
  const state = readState(deviceArg);
  if (!state) {
    console.error("No serve-sim server running. Run `serve-sim` first.");
    process.exit(1);
  }

  const valid = new Set([
    "portrait",
    "portrait_upside_down",
    "landscape_left",
    "landscape_right",
  ]);
  if (!orientation || !valid.has(orientation)) {
    console.error(
      `Usage: serve-sim rotate <${[...valid].join("|")}> [-d udid]`,
    );
    process.exit(1);
  }

  return new Promise<void>((resolve, reject) => {
    const ws = openHelperSocket(state);
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      const json = new TextEncoder().encode(JSON.stringify({ orientation }));
      const msg = new Uint8Array(1 + json.length);
      msg[0] = 0x07;
      msg.set(json, 1);
      ws.send(msg);
      setTimeout(() => { ws.close(); resolve(); }, 50);
    };

    ws.onerror = () => {
      console.error("Failed to connect to serve-sim server at", state.wsUrl);
      reject(new Error("WebSocket connection failed"));
    };
  });
}

// HID (page, usage) codes for hardware buttons not backed by a named idb event
// source, mirroring DeviceKit chrome.json's per-input `usagePage`/`usage`. The
// helper injects these through IndigoHIDMessageForHIDArbitrary.
const HID_BUTTON_CODES: Record<string, { page: number; usage: number }> = {
  power: { page: 12, usage: 48 },
  "volume-up": { page: 12, usage: 233 },
  "volume-down": { page: 12, usage: 234 },
  action: { page: 11, usage: 45 },
  "side-button": { page: 12, usage: 149 },
  "digital-crown": { page: 12, usage: 64 },
  "left-side-button": { page: 65281, usage: 512 },
};

async function button(buttonName = "home", deviceArg?: string) {
  const state = readState(deviceArg);
  if (!state) {
    console.error("No serve-sim server running. Run `serve-sim` first.");
    process.exit(1);
  }

  const hid = HID_BUTTON_CODES[buttonName];
  const payload = hid ? { button: buttonName, ...hid } : { button: buttonName };

  return new Promise<void>((resolve, reject) => {
    const ws = openHelperSocket(state);
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      const json = new TextEncoder().encode(JSON.stringify(payload));
      const msg = new Uint8Array(1 + json.length);
      msg[0] = 0x04;
      msg.set(json, 1);
      ws.send(msg);
      setTimeout(() => { ws.close(); resolve(); }, 50);
    };

    ws.onerror = () => {
      console.error("Failed to connect to serve-sim server at", state.wsUrl);
      reject(new Error("WebSocket connection failed"));
    };
  });
}

// Send a CoreAnimation debug option toggle to the helper, which invokes
// -[SimDevice setCADebugOption:enabled:] (CoreSimulator private category).
// The known option strings are the ones Simulator.app uses: see Protocol.swift.
async function caDebug(option: string, stateRaw: string, deviceArg?: string) {
  const stateArg = (stateRaw ?? "").toLowerCase();
  const enabled = stateArg === "on" || stateArg === "1" || stateArg === "true";
  const aliases: Record<string, string> = {
    blended: "debug_color_blended",
    copies: "debug_color_copies",
    copied: "debug_color_copies",
    misaligned: "debug_color_misaligned",
    offscreen: "debug_color_offscreen",
    "slow-animations": "debug_slow_animations",
    slow: "debug_slow_animations",
  };
  const resolved = option ? (aliases[option] ?? option) : undefined;
  if (!resolved || !["on", "off", "1", "0", "true", "false"].includes(stateArg)) {
    console.error(
      `Usage: serve-sim ca-debug <option> <on|off> [-d udid]\n  option shortcuts: ${Object.keys(aliases).join(", ")}`,
    );
    process.exit(1);
  }

  const stateFile = readState(deviceArg);
  if (!stateFile) {
    console.error("No serve-sim server running. Run `serve-sim` first.");
    process.exit(1);
  }

  return new Promise<void>((resolve, reject) => {
    const ws = openHelperSocket(stateFile);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      const json = new TextEncoder().encode(JSON.stringify({ option: resolved, enabled }));
      const msg = new Uint8Array(1 + json.length);
      msg[0] = 0x08;
      msg.set(json, 1);
      ws.send(msg);
      setTimeout(() => { ws.close(); resolve(); }, 50);
    };
    ws.onerror = () => {
      console.error("Failed to connect to serve-sim server at", stateFile.wsUrl);
      reject(new Error("WebSocket connection failed"));
    };
  });
}

// Ask the helper to invoke -[SimDevice simulateMemoryWarning].
async function memoryWarning(deviceArg?: string) {
  const stateFile = readState(deviceArg);
  if (!stateFile) {
    console.error("No serve-sim server running. Run `serve-sim` first.");
    process.exit(1);
  }
  return new Promise<void>((resolve, reject) => {
    const ws = openHelperSocket(stateFile);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      ws.send(new Uint8Array([0x09]));
      setTimeout(() => { ws.close(); resolve(); }, 50);
    };
    ws.onerror = () => {
      console.error("Failed to connect to serve-sim server at", stateFile.wsUrl);
      reject(new Error("WebSocket connection failed"));
    };
  });
}

// ─── Camera injection ───

/**
 * Resolve the path to the SimCameraInjector dylib. The dev/source layout
 * places it under packages/serve-sim/dist/simcam/; the published npm tarball
 * ships the same file at <package>/dist/simcam/.
 */
function locateCameraDylib(): string | null {
  const candidates = [
    join(__dirname, "..", "dist", "simcam", "libSimCameraInjector.dylib"),
    join(__dirname, "simcam", "libSimCameraInjector.dylib"),
    join(__dirname, "..", "Sources", "SimCameraInjector", "build",
         "libSimCameraInjector.dylib"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return resolve(p);
  }
  return null;
}

function buildCameraDylib(): string {
  const buildScript = join(__dirname, "..", "Sources", "SimCameraInjector", "build.sh");
  if (!existsSync(buildScript)) {
    throw new Error(
      "SimCameraInjector source not found — this build of serve-sim does not " +
      "include camera support sources. Reinstall from a recent release.",
    );
  }
  console.error("[serve-sim] building libSimCameraInjector.dylib (one-time)…");
  execSync(`bash "${buildScript}"`, { stdio: "inherit" });
  const out = locateCameraDylib();
  if (!out) throw new Error("Build succeeded but dylib not found.");
  return out;
}

function locateCameraHelper(): string | null {
  const candidates = [
    join(__dirname, "..", "dist", "simcam", "serve-sim-camera-helper"),
    join(__dirname, "simcam", "serve-sim-camera-helper"),
  ];
  for (const p of candidates) if (existsSync(p)) return resolve(p);
  return null;
}

function buildCameraHelper(): string {
  const buildScript = join(__dirname, "..", "Sources", "SimCameraHelper", "build.sh");
  if (!existsSync(buildScript)) {
    throw new Error(
      "SimCameraHelper source not found — webcam support requires building " +
      "from a checkout that includes Sources/SimCameraHelper.",
    );
  }
  console.error("[serve-sim] building serve-sim-camera-helper (one-time)…");
  execSync(`bash "${buildScript}"`, { stdio: "inherit" });
  const out = locateCameraHelper();
  if (!out) throw new Error("Build succeeded but helper binary not found.");
  return out;
}

function shmNameForUdid(udid: string): string {
  // POSIX shm names on macOS have a 31-char limit. Hash the UDID short.
  const short = createHash("sha1").update(udid).digest("hex").slice(0, 8);
  return `/serve-sim-cam-${short}`;
}

function recordInjectedBundle(udid: string, bundleId: string, helperPid: number): void {
  const existing = readInjectedBundles(udid);
  const bundleIds = existing.includes(bundleId) ? existing : [...existing, bundleId];
  const next = { helperPid, bundleIds };
  mkdirSync(simcamStateDir(), { recursive: true });
  writeFileSync(helperBundlesFile(udid), JSON.stringify(next));
}

function clearInjectedBundles(udid: string): void {
  try { unlinkSync(helperBundlesFile(udid)); } catch {}
}

function stopExistingHelper(udid: string) {
  const pf = helperPidFile(udid);
  if (!existsSync(pf)) return;
  const pid = Number(readFileSync(pf, "utf-8").trim());
  if (Number.isFinite(pid) && isProcessAlive(pid)) {
    try { process.kill(pid, "SIGTERM"); } catch {}
    // Give it a moment to clean up the shm region.
    const start = Date.now();
    while (isProcessAlive(pid) && Date.now() - start < 1500) sleepSync(50);
  }
  try { unlinkSync(pf); } catch {}
  clearInjectedBundles(udid);
}

function spawnCameraHelper(args: {
  udid: string;
  helperBin: string;
  shmName: string;
  socketPath: string;
  source: CamSourceKind;
  arg?: string;
  width?: number;
  height?: number;
}): number {
  const camDir = simcamStateDir();
  mkdirSync(camDir, { recursive: true });
  const logPath = join(camDir, `${args.udid}.log`);
  const out = openSync(logPath, "a");
  const argv = [
    "--shm", args.shmName,
    "--socket", args.socketPath,
    "--source", args.source,
  ];
  if (args.arg) argv.push("--arg", args.arg);
  if (args.width) argv.push("--width", String(args.width));
  if (args.height) argv.push("--height", String(args.height));
  const child = nodeSpawn(args.helperBin, argv, {
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  closeSync(out);
  if (!child.pid) throw new Error("failed to spawn camera helper");
  writeFileSync(helperPidFile(args.udid), String(child.pid));
  clearInjectedBundles(args.udid);
  // Wait briefly until the helper has populated the shm header AND the
  // control socket is listening (proves it's healthy and ready for switch).
  const start = Date.now();
  while (Date.now() - start < 3000) {
    if (!isProcessAlive(child.pid)) {
      throw new Error(`camera helper exited early — see log at ${logPath}`);
    }
    if (existsSync(args.socketPath)) break;
    sleepSync(50);
  }
  return child.pid;
}

type CamSourceKind = "placeholder" | "webcam" | "image" | "video";

interface ResolvedSource { kind: CamSourceKind; arg?: string }

// Tell image/video apart from a path. We sniff the file's magic bytes
// rather than trusting the extension because:
//   1) the file may have arrived via the in-page drop zone, where it
//      lands at /tmp/<uuid> with no meaningful suffix; and
//   2) callers pass real-world paths like .heic / .mov / .gif that
//      shouldn't need a separate flag in the CLI surface.
const VIDEO_EXTS = new Set([
  "mp4", "m4v", "mov", "qt", "avi", "mkv", "webm", "mpg", "mpeg",
  "3gp", "3g2", "ts", "wmv",
]);
const IMAGE_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "heic", "heif", "webp", "bmp", "tif", "tiff",
]);

function detectMediaKind(filePath: string): "image" | "video" | null {
  const ext = filePath.toLowerCase().split(".").pop() ?? "";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (IMAGE_EXTS.has(ext)) return "image";

  // Magic-byte sniff — covers files renamed without an extension, plus
  // common containers we didn't enumerate above. Read a 16-byte header.
  let header: Buffer;
  try {
    const fd = openSync(filePath, "r");
    header = Buffer.alloc(16);
    readSync(fd, header, 0, header.length, 0);
    closeSync(fd);
  } catch {
    return null;
  }

  // ISO base media: bytes 4..8 are an "ftyp" box. Catches mp4/mov/m4v/3gp.
  if (header.length >= 8 && header.slice(4, 8).toString("ascii") === "ftyp") {
    return "video";
  }
  // RIFF (WebP / AVI). WEBP / AVI distinguishes via bytes 8..12.
  if (header.slice(0, 4).toString("ascii") === "RIFF" && header.length >= 12) {
    const tag = header.slice(8, 12).toString("ascii");
    if (tag === "AVI ") return "video";
    if (tag === "WEBP") return "image";
  }
  // Matroska / WebM EBML.
  if (header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3) {
    return "video";
  }
  // PNG.
  if (header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47) {
    return "image";
  }
  // JPEG.
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return "image";
  // GIF.
  if (header.slice(0, 6).toString("ascii").startsWith("GIF8")) return "image";
  // BMP.
  if (header[0] === 0x42 && header[1] === 0x4d) return "image";
  return null;
}

function resolveSourceArg(opts: {
  file?: string;
  webcam?: string | true;
}): ResolvedSource {
  if (opts.file) {
    const abs = resolve(opts.file);
    const kind = detectMediaKind(abs);
    if (!kind) {
      throw new Error(`Could not detect image/video type for: ${abs}`);
    }
    return { kind, arg: abs };
  }
  if (opts.webcam) {
    return { kind: "webcam", arg: typeof opts.webcam === "string" ? opts.webcam : undefined };
  }
  return { kind: "placeholder" };
}

async function ensureHelperWithSource(opts: {
  udid: string;
  source: ResolvedSource;
  forceBuild: boolean;
}): Promise<{ helperPid: number | null; shmName: string; relaunched: boolean }> {
  const shmName = shmNameForUdid(opts.udid);
  const sockPath = helperSocketFile(opts.udid);
  if (isHelperAlive(opts.udid)) {
    // Hot-swap source via control socket — no relaunch needed.
    const reply = await sendHelperCommand(opts.udid, {
      action: "switch",
      source: opts.source.kind,
      arg: opts.source.arg,
    });
    if (!reply.ok) throw new Error(reply.error || "helper rejected switch");
    return {
      helperPid: Number(readFileSync(helperPidFile(opts.udid), "utf-8").trim()),
      shmName,
      relaunched: false,
    };
  }
  // Need to start a fresh helper. Pre-emptively reap any stale state.
  stopExistingHelper(opts.udid);
  const helper = (!opts.forceBuild && locateCameraHelper()) || buildCameraHelper();
  const pid = spawnCameraHelper({
    udid: opts.udid,
    helperBin: helper,
    shmName,
    socketPath: sockPath,
    source: opts.source.kind,
    arg: opts.source.arg,
  });
  return { helperPid: pid, shmName, relaunched: true };
}

/**
 * `serve-sim camera <bundle-id> [-d udid] [source-options] [--build]`
 *
 * Launches a simulator app with SimCameraInjector loaded via
 * DYLD_INSERT_LIBRARIES. The host-side helper streams BGRA frames into a
 * POSIX shared-memory region the dylib mmaps; this function picks the source
 * (placeholder / webcam / image), spawns or reuses the helper, and then
 * launches the app. If the helper is already running, source changes are
 * hot-swapped through its control socket without relaunching the app.
 */
async function camera(args: string[]) {
  let deviceArg: string | undefined;
  let filePath: string | undefined;
  let webcam: string | true | undefined;
  let stopWebcam = false;
  let listWebcams = false;
  let forceBuild = false;
  let quiet = false;
  let mirror: "auto" | "on" | "off" = "auto";
  const filtered: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--device" || a === "-d") { deviceArg = args[++i]; continue; }
    if (a === "--file" || a === "-f" || a === "--image" || a === "-i" || a === "--video") {
      // --image / --video are kept as silent aliases so existing scripts
      // and the in-page client can land on `--file` without a flag day.
      filePath = args[++i];
      continue;
    }
    if (a === "--webcam") {
      const next = args[i + 1];
      if (next && !next.startsWith("-")) { webcam = next; i++; }
      else { webcam = true; }
      continue;
    }
    if (a === "--list-webcams") { listWebcams = true; continue; }
    if (a === "--stop-webcam") { stopWebcam = true; continue; }
    if (a === "--build") { forceBuild = true; continue; }
    if (a === "--quiet" || a === "-q") { quiet = true; continue; }
    if (a === "--mirror") {
      const next = args[i + 1];
      if (next === "on" || next === "off" || next === "auto") {
        mirror = next; i++;
      } else {
        mirror = "on";
      }
      continue;
    }
    if (a === "--no-mirror") { mirror = "off"; continue; }
    if (a === "--help" || a === "-h") {
      console.log(`Usage: serve-sim camera <bundle-id> [-d udid] [source-options] [--build]
       serve-sim camera switch <placeholder|webcam|file> [arg] [-d udid]
       serve-sim camera mirror <auto|on|off> [-d udid]
       serve-sim camera --list-webcams
       serve-sim camera --stop-webcam [-d udid]

Launches the simulator app with a synthetic camera feed injected. The
host helper streams BGRA frames (default: an animated placeholder) into
shared memory; the dylib swizzles AVFoundation so the app reads them.

If the helper is already running for the device, source flags hot-swap
the feed without relaunching the app.

Source options (pick one; default is placeholder):
  -f, --file <path>          Image or video file (kind auto-detected)
      --webcam [name]        Live host webcam (default: built-in front camera)

Other:
  -d, --device <udid|name>   Target a specific simulator (default: booted)
      --mirror [on|off|auto] Override preview mirroring (default: auto =
                             front mirrored, back not). Data-output buffers
                             are never auto-mirrored, matching AVF defaults.
      --no-mirror            Shortcut for --mirror off
      --build                Rebuild dylib + helper from source
      --list-webcams         List host camera devices (with --webcam values)
      --stop-webcam          Stop the running camera helper for the device
  -q, --quiet                JSON-only output

Examples:
  serve-sim camera com.acme.MyApp                            # placeholder feed
  serve-sim camera com.acme.MyApp --webcam                   # default webcam
  serve-sim camera com.acme.MyApp --webcam "MacBook Pro Camera"
  serve-sim camera com.acme.MyApp --file ~/Pictures/face.png # static image
  serve-sim camera com.acme.MyApp --file ~/Movies/loop.mp4   # looping video
  serve-sim camera switch webcam                             # hot-swap to webcam
  serve-sim camera switch placeholder                        # back to placeholder
  serve-sim camera switch ~/Movies/loop.mp4                  # hot-swap to file
  serve-sim camera --list-webcams
  serve-sim camera --stop-webcam`);
      return;
    }
    filtered.push(a!);
  }

  if (listWebcams) {
    const helper = locateCameraHelper() ?? buildCameraHelper();
    execSync(`"${helper}" --list`, { stdio: "inherit" });
    return;
  }

  if (stopWebcam) {
    const udid = deviceArg ? resolveDevice(deviceArg) : findBootedDevice();
    if (!udid) { console.error("No booted simulator."); process.exit(1); }
    const injectedBundles = readInjectedBundles(udid);
    const terminated: string[] = [];
    for (const b of injectedBundles) {
      try {
        execFileSync("xcrun", ["simctl", "terminate", udid, b], { stdio: "ignore" });
        terminated.push(b);
      } catch {}
    }
    stopExistingHelper(udid);
    if (quiet) console.log(JSON.stringify({ udid, stopped: true, terminated }));
    else {
      console.log(`Stopped camera helper for ${udid}`);
      if (terminated.length > 0) console.log(`Terminated injected apps: ${terminated.join(", ")}`);
    }
    return;
  }

  // `serve-sim camera mirror <auto|on|off> [-d udid]`
  // Hot-swap the preview-layer mirror mode without touching the app.
  if (filtered[0] === "mirror") {
    const udid = deviceArg ? resolveDevice(deviceArg) : findBootedDevice();
    if (!udid) { console.error("No booted simulator."); process.exit(1); }
    const mode = filtered[1];
    if (mode !== "auto" && mode !== "on" && mode !== "off") {
      console.error("Usage: serve-sim camera mirror <auto|on|off> [-d udid]");
      process.exit(1);
    }
    if (!isHelperAlive(udid)) {
      console.error("camera helper not running for this device — run `serve-sim camera <bundle-id>` first.");
      process.exit(1);
    }
    try {
      const reply = await sendHelperCommand(udid, { action: "setMirror", mode });
      if (!reply.ok) {
        console.error(`mirror failed: ${reply.error ?? "?"}`);
        process.exit(1);
      }
      if (quiet) console.log(JSON.stringify({ udid, mirror: mode, ok: true }));
      else console.log(`📷 Mirror → ${mode} on ${udid}`);
    } catch (e: any) {
      console.error(`mirror failed: ${e?.message ?? e}`);
      process.exit(1);
    }
    return;
  }

  // `serve-sim camera switch <source> [arg] [-d udid]`
  // Hot-swap the helper's source without touching the simulator app.
  if (filtered[0] === "switch") {
    const udid = deviceArg ? resolveDevice(deviceArg) : findBootedDevice();
    if (!udid) { console.error("No booted simulator."); process.exit(1); }
    let wanted = filtered[1];
    let arg: string | undefined = filtered[2];
    // `camera switch /path/to/clip.mov` — sniff the file and pick the kind.
    if (wanted && wanted !== "placeholder" && wanted !== "webcam"
        && wanted !== "image" && wanted !== "video"
        && wanted !== "file") {
      const candidate = resolve(wanted);
      if (existsSync(candidate)) { arg = candidate; wanted = "file"; }
    }
    if (wanted === "file") {
      if (!arg) {
        console.error("camera switch file <path>");
        process.exit(1);
      }
      arg = resolve(arg);
      const detected = detectMediaKind(arg);
      if (!detected) {
        console.error(`Could not detect image/video type for: ${arg}`);
        process.exit(1);
      }
      wanted = detected;
    }
    if (!wanted || (wanted !== "placeholder" && wanted !== "webcam" && wanted !== "image" && wanted !== "video")) {
      console.error("Usage: serve-sim camera switch <placeholder|webcam|file> [arg] [-d udid]");
      process.exit(1);
    }
    if ((wanted === "image" || wanted === "video") && arg) arg = resolve(arg);
    if (!isHelperAlive(udid)) {
      console.error("camera helper not running for this device — run `serve-sim camera <bundle-id>` first.");
      process.exit(1);
    }
    try {
      const reply = await sendHelperCommand(udid, { action: "switch", source: wanted, arg });
      if (!reply.ok) {
        console.error(`switch failed: ${reply.error ?? "?"}`);
        process.exit(1);
      }
      if (quiet) console.log(JSON.stringify({ udid, ...reply }));
      else console.log(`📷 Switched ${udid} → ${reply.source}${reply.arg ? ` (${reply.arg})` : ""}`);
    } catch (e: any) {
      console.error(`switch failed: ${e?.message ?? e}`);
      process.exit(1);
    }
    return;
  }

  // `serve-sim camera status [-d udid]` — JSON probe for scripts and humans.
  // The preview UI reads the same shared implementation through middleware.
  if (filtered[0] === "status") {
    const udid = deviceArg ? resolveDevice(deviceArg) : findBootedDevice();
    if (!udid) {
      console.log(JSON.stringify({ alive: false, error: "no booted simulator" }));
      return;
    }
    console.log(JSON.stringify(await readCameraStatus(udid)));
    return;
  }

  const bundleId = filtered[0];
  if (!bundleId) {
    console.error("Usage: serve-sim camera <bundle-id> [--image <path>] [-d udid]");
    process.exit(1);
  }

  const udid = deviceArg ? resolveDevice(deviceArg) : findBootedDevice();
  if (!udid) {
    console.error("No booted simulator. Boot one or pass -d <udid|name>.");
    process.exit(1);
  }

  let dylib = forceBuild ? null : locateCameraDylib();
  if (!dylib) {
    try { dylib = buildCameraDylib(); }
    catch (e: any) {
      console.error(`Failed to obtain camera dylib: ${e?.message ?? e}`);
      process.exit(1);
    }
  }

  if (filePath && webcam) {
    console.error("Pick one source: --file or --webcam, not both.");
    process.exit(1);
  }

  if (filePath) {
    filePath = resolve(filePath);
    if (!existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      process.exit(1);
    }
  }

  // Default source is the animated placeholder. The helper always runs so
  // the dylib reads from a single shm wire format regardless of source.
  let source: ResolvedSource;
  try {
    source = resolveSourceArg({ file: filePath, webcam });
  } catch (e: any) {
    console.error(e?.message ?? String(e));
    process.exit(1);
  }
  const helperRes = await ensureHelperWithSource({ udid, source, forceBuild });
  const shmName = helperRes.shmName;
  const helperPid = helperRes.helperPid;

  // Mirror lives in the shm header so it can hot-swap. Push every time —
  // the dylib watches the byte each frame and re-applies the layer
  // transform when it differs from the last seen value.
  if (mirror !== "auto" || !helperRes.relaunched) {
    try {
      await sendHelperCommand(udid, { action: "setMirror", mode: mirror });
    } catch {} // non-fatal; dylib falls back to env or default
  }

  // Always (re)launch the named bundle with the dylib. The helper feeds a
  // single shm region keyed by udid, so multiple apps on the same simulator
  // can attach to the same camera stream — but each one has to be launched
  // with DYLD_INSERT_LIBRARIES, which means a terminate+relaunch every time
  // we want to bring a new app into the set. Source-only hot-swaps go
  // through `camera switch`, not this path.
  try {
    execFileSync("xcrun", ["simctl", "privacy", udid, "grant", "camera", bundleId], {
      stdio: "ignore",
    });
  } catch {}
  try {
    execFileSync("xcrun", ["simctl", "terminate", udid, bundleId], { stdio: "ignore" });
  } catch {}

  const env = {
    ...process.env,
    SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: dylib,
    SIMCTL_CHILD_SIMCAM_SHM_NAME: shmName,
    ...(mirror !== "auto" ? { SIMCTL_CHILD_SIMCAM_MIRROR_MODE: mirror } : {}),
  };

  let stdoutBuf = "";
  try {
    stdoutBuf = execFileSync("xcrun", ["simctl", "launch", udid, bundleId], {
      env,
      encoding: "utf-8",
    });
  } catch (e: any) {
    console.error(`simctl launch failed: ${e?.stderr ?? e?.message ?? e}`);
    process.exit(1);
  }

  const pidMatch = stdoutBuf.trim().match(/:\s*(\d+)\s*$/);
  const pid = pidMatch ? Number(pidMatch[1]) : null;

  if (helperPid) recordInjectedBundle(udid, bundleId, helperPid);

  const result = {
    udid,
    bundleId,
    pid,
    dylib,
    source: source.kind,
    arg: source.arg ?? null,
    shm: shmName,
    helperPid,
    mirror,
    hotSwapped: false,
    helperRelaunched: helperRes.relaunched,
  };
  if (quiet) {
    console.log(JSON.stringify(result));
  } else {
    const verb = helperRes.relaunched ? "Injected" : "Attached";
    console.log(`📷 ${verb} camera into ${bundleId} (pid ${pid ?? "?"}) on ${udid}`);
    console.log(`   source: ${source.kind}${source.arg ? ` (${source.arg})` : ""}`);
    if (helperPid) console.log(`   helper pid: ${helperPid}  (shm ${shmName})`);
    console.log(`   dylib: ${dylib}`);
  }
}

// ─── Serve preview ───

/** Resolve which simulators to stream, without spawning anything. */
function resolveTargetDevices(devices: string[]): string[] {
  if (devices.length > 0) return devices.map(resolveDevice);
  const existing = readAllStates();
  if (existing.length > 0) return [existing[0]!.device];
  const booted = findBootedDevice();
  if (booted) return [booted];
  const fallback = pickDefaultDevice();
  if (!fallback) {
    throw new Error("No device specified and no available iOS simulator found.");
  }
  return [fallback.udid];
}

async function serve(
  servePort: number,
  devices: string[],
  portExplicit: boolean,
  host: string,
  options: {
    stream?: StreamRuntimeOptions;
    corsOrigins?: string[];
    frameAncestors?: string[];
    shareUrl?: string;
    debugStreamPath?: string;
    requireToken?: boolean;
    quiet?: boolean;
  } = {},
) {
  const quiet = !!options.quiet;
  // Under --quiet the caller parses stdout, so a failure must be a JSON line there, not bare stderr.
  const failStartup = (message: string): never => {
    if (quiet) console.log(JSON.stringify({ error: message }));
    else console.error(message);
    process.exit(1);
  };
  // Boot the target simulators; the preview server streams them in-process
  // (no spawned helper). Sessions are created lazily on the first stream request.
  let targetDevices: string[];
  try {
    targetDevices = resolveTargetDevices(devices);
    if (!quiet && devices.length === 0 && readAllStates().length === 0) {
      console.log("Starting simulator stream...");
    }
    for (const udid of targetDevices) await ensureBooted(udid);
  } catch (err) {
    return failStartup(err instanceof Error ? err.message : String(err));
  }
  const targetDevice = targetDevices[0];

  const { simMiddleware } = await import("./middleware");
  // Standalone serve-sim owns its HTTP server and wires WebSocket upgrades, so
  // it can route helper/DevTools sockets through the single preview port.
  // Minted here, not in the middleware, because the operator has to be told what it is.
  const requirePreviewToken = !!options.requireToken;
  const previewToken = randomBytes(32).toString("base64url");
  const middleware = simMiddleware({
    basePath: "/",
    device: targetDevice,
    streamSettings: options.stream,
    proxyHelpers: true,
    corsOrigins: options.corsOrigins ?? [],
    frameAncestors: options.frameAncestors ?? [],
    shareUrl: options.shareUrl,
    execToken: previewToken,
    requirePreviewToken,
  });

  // Try requested port; if busy and the user didn't pin it, scan forward.
  const maxScan = portExplicit ? 1 : 50;
  let boundPort = servePort;
  let lastErr: unknown;
  let bound = false;
  for (let i = 0; i < maxScan; i++) {
    const p = servePort + i;
    try {
      await bindPreviewServer(p, middleware, host);
      boundPort = p;
      bound = true;
      break;
    } catch (err: any) {
      lastErr = err;
      if (err?.code !== "EADDRINUSE") break;
    }
  }
  if (!bound) {
    if ((lastErr as any)?.code === "EADDRINUSE") {
      failStartup(
        portExplicit
          ? `Port ${servePort} is already in use. Pass a different --port or stop the other process.`
          : `No available port found in range ${servePort}-${servePort + maxScan - 1}.`,
      );
    } else {
      failStartup(`Failed to start preview server: ${(lastErr as any)?.message ?? lastErr}`);
    }
  }

  // Record in-process state so the preview/grid enumerate these devices and the
  // CLI input subcommands can reach the same-origin /helper ws.
  for (const udid of targetDevices) {
    const state = inProcessServeSimState(udid, boundPort, "/", host, options.stream);
    writeState(requirePreviewToken ? { ...state, token: previewToken } : state);
  }
  const clearAll = () => {
    for (const udid of targetDevices) {
      try { clearServeSimState(udid, process.pid); } catch {}
    }
    disarmDevicesArmedHere();
  };
  process.on("exit", clearAll);

  if (options.debugStreamPath) {
    const logger = startStreamDebugLog({
      path: options.debugStreamPath,
      statsUrl: (device) =>
        `http://127.0.0.1:${boundPort}/helper/${encodeURIComponent(device)}/webrtc/stats`,
      authToken: requirePreviewToken ? previewToken : undefined,
    });
    runStreamDebugLog(targetDevices, logger);
    if (!quiet) console.log(`  - Stream debug: recording to ${options.debugStreamPath}`);
  }

  const exposedToLan = !isLoopbackHost(host);
  const networkIP = getLocalNetworkIP();
  const tokenQuery = requirePreviewToken ? `/?token=${previewToken}` : "";
  if (quiet) {
    const states = targetDevices.map((udid) =>
      inProcessServeSimState(udid, boundPort, "/", host, options.stream),
    );
    console.log(
      JSON.stringify(previewStartupPayload(states, requirePreviewToken ? previewToken : undefined)),
    );
  } else {
    console.log("");
    console.log(`  - Local:   http://localhost:${boundPort}${tokenQuery}`);
    if (exposedToLan && networkIP) {
      console.log(`  - Network: http://${networkIP}:${boundPort}${tokenQuery}`);
      console.log("");
      console.log(
        requirePreviewToken
          ? "  This server is listening on the network. The links above carry a token because anyone who " +
            "has it can run commands on this machine."
          : "  This server is listening on the network with no token required. Anyone who can reach it can " +
            "run commands on this machine. Pass --require-token to gate it.",
      );
    } else if (networkIP) {
      console.log(`  - Network: \x1b[2muse --host 0.0.0.0 to expose on http://${networkIP}:${boundPort}\x1b[0m`);
    } else {
      console.log("  - Network: \x1b[2muse --host 0.0.0.0 to expose on the LAN\x1b[0m");
    }
    console.log("");
  }

  const shutdown = async () => {
    sessionStopping = true;
    await disarmDevicesArmedHereAsync();
    clearAll();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGHUP", shutdown);
  await new Promise(() => {});
}

function bindPreviewServer(port: number, middleware: ReturnType<typeof import("./middleware").simMiddleware>, host: string) {
  return servePreview({ port, middleware, host });
}

// ─── Main ───

function parseNumberInRange(
  value: string,
  option: string,
  min: number,
  max: number,
  integer = false,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (integer && !Number.isInteger(parsed)) || parsed < min || parsed > max) {
    const kind = integer ? "integer" : "number";
    throw new InvalidArgumentError(`${option} must be a ${kind} from ${min} to ${max}.`);
  }
  return parsed;
}

function parseShareUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") return url.href;
  } catch {}
  throw new InvalidArgumentError("--share-url must be an http(s) URL.");
}

const program = new Command();

program
  .name("serve-sim")
  .description("Stream iOS Simulator to the browser")
  .version(resolveVersion(), "-v, --version", "Output the serve-sim version")
  .helpOption("-h, --help", "Show this help")
  // The default command: start the preview server (or stream / list / kill).
  .argument("[devices...]", "Simulator(s) to target (udid or name; default: booted)")
  .option("-p, --port <port>", "Starting port (preview default: 3200; helper default: 3100)", (v) => parseInt(v, 10))
  .option(
    "--host <addr>",
    "Interface to bind the preview server to. Use 0.0.0.0 to expose on the " +
      "LAN — only on trusted networks: the preview exposes a token-gated " +
      "shell-exec route.",
    "127.0.0.1",
  )
  .option(
    "--require-token",
    "Require the session token to open the preview or call /api, and print it in the startup link. Use " +
      "it whenever the server is reachable from the network: the same token gates the route that runs " +
      "shell commands.",
  )
  .option("--detach", "Spawn helper and exit (daemon mode)")
  .option("-q, --quiet", "Suppress human-readable output, JSON only")
  .option("--no-preview", "Skip the web preview server; stream in foreground only")
  .option("--transport <http|webrtc>", "Stream transport", "http")
  .option(
    "--launch-app-identifier <id>",
    "Bundle identifier of an installed app to launch once the simulator boots",
  )
  .option(
    "--launch-arg <arg>",
    "Argument passed to the app when it launches. Repeat for multiple arguments.",
    (value: string, previous: string[] = []) => [...previous, value],
  )
  .option(
    "--enable <capability>",
    "Turn on a capability that is off by default. Repeat for multiple.",
    (value: string, previous: string[] = []) => [...previous, value],
  )
  .option(
    "--disable <capability>",
    "Turn off a capability that is on by default. Repeat for multiple.",
    (value: string, previous: string[] = []) => [...previous, value],
  )
  .option(
    "--open-url <url>",
    "URL to open in the app after it launches",
    (value) => {
      if (!URL.canParse(value)) {
        throw new InvalidArgumentError(`Invalid URL '${value}'. Pass a full URL, such as exp://127.0.0.1:8081.`);
      }
      return value;
    },
  )
  .option(
    "--codec <codec>",
    "Stream codec for the preview UI: 'auto', 'h264', 'mjpeg', or 'simstream' (the simstream video engine). Use --transport webrtc for WebRTC.",
    (value) => {
      const v = value.toLowerCase();
      const allowed = ["auto", "h264", "mjpeg", "simstream"];
      if (!allowed.includes(v)) {
        throw new InvalidArgumentError(`Unsupported codec '${value}'. Supported: ${allowed.join(", ")}.`);
      }
      return v;
    },
  )
  .option(
    "--webrtc-codec <vp8|vp9|h264>",
    "WebRTC video codec",
    (value) => {
      const codec = value.toLowerCase();
      if (codec !== "vp8" && codec !== "vp9" && codec !== "h264") {
        throw new InvalidArgumentError(`Unsupported WebRTC codec '${value}'. Supported: vp8, vp9, h264.`);
      }
      return codec;
    },
    "h264",
  )
  .option("--stun-url <url[,url...]>", "STUN URL(s) for WebRTC ICE", (value) => {
    try {
      return parseIceUrlList(value, "stun");
    } catch (error) {
      throw new InvalidArgumentError((error as Error).message);
    }
  })
  .option("--turn-url <url[,url...]>", "TURN URL(s) for WebRTC ICE", (value) => {
    try {
      return parseIceUrlList(value, "turn");
    } catch (error) {
      throw new InvalidArgumentError((error as Error).message);
    }
  })
  .option("--turn-username <username>", "TURN username")
  .option("--turn-credential <credential>", "TURN credential")
  .option(
    "--mjpeg-fps <fps>",
    `MJPEG frame rate (1-${MAX_MJPEG_STREAM_FPS})`,
    (value) => parseNumberInRange(value, "--mjpeg-fps", 1, MAX_MJPEG_STREAM_FPS, true),
  )
  .option(
    "--mjpeg-quality <quality>",
    "MJPEG quality (0.05-1)",
    (value) => parseNumberInRange(value, "--mjpeg-quality", 0.05, 1),
  )
  .option(
    "--max-dimension <pixels>",
    "Maximum captured width or height; 0 keeps native resolution (0-4096)",
    (value) => parseNumberInRange(value, "--max-dimension", 0, 4096, true),
  )
  .option(
    "--video-bitrate <bits-per-second>",
    "H.264/WebRTC target bitrate (100000-50000000)",
    (value) => parseNumberInRange(value, "--video-bitrate", 100_000, 50_000_000, true),
  )
  .option(
    "--video-fps <fps>",
    `H.264/WebRTC frame rate (1-${MAX_VIDEO_STREAM_FPS})`,
    (value) => parseNumberInRange(value, "--video-fps", 1, MAX_VIDEO_STREAM_FPS, true),
  )
  .option(
    "--debug-stream <path>",
    "Record sender-side stream statistics once a second to an NDJSON file. Needs the preview " +
      "server and --transport webrtc.",
  )
  .option(
    "--frame-ancestor <origin>",
    "Allow this origin to embed the preview in a frame (repeatable). Accepts a subdomain " +
      "wildcard, e.g. https://*.expo.dev. Only applies with --require-token; an ungated " +
      "preview sends no frame policy.",
    (value: string, prev: string[]) => [...prev, value],
    [] as string[],
  )
  .option(
    "--share-url <url>",
    "URL the Share button copies, instead of this preview's address.",
    parseShareUrl,
  )
  .option(
    "--cors-origin <origin>",
    "Allow this origin to read the preview cross-origin (repeatable). Accepts a subdomain " +
      "wildcard, e.g. https://*.expo.dev. Loopback origins are always allowed.",
    (value: string, prev: string[]) => [...prev, value],
    [] as string[],
  )
  .option(
    "--metrics-cors-origin <origin>",
    "Deprecated alias for --cors-origin.",
    (value: string, prev: string[]) => [...prev, value],
    [] as string[],
  )
  .option("-l, --list [device]", "List running streams")
  .option("-k, --kill [device]", "Kill running stream(s)")
  .addHelpText(
    "after",
    `
Examples:
  serve-sim                              Open simulator preview at localhost:3200
  serve-sim -p 8080                      Preview on a custom port
  serve-sim --transport webrtc           Stream over WebRTC
  serve-sim --codec mjpeg                Force MJPEG (e.g. on VMs without H.264 encode)
  serve-sim --no-preview                 Auto-detect booted sim, stream in foreground
  serve-sim --no-preview "iPhone 16 Pro" Stream a specific device (no preview)
  serve-sim --detach                     Start streaming in background (daemon)
  serve-sim --list                       Show all running streams
  serve-sim --kill                       Stop all streams
  serve-sim --launch-app-identifier host.exp.Exponent
                                         Launch an installed app, then start the stream`,
  )
  .action(async (devices: string[], opts) => {
    if (opts.list !== undefined) {
      listStreams(typeof opts.list === "string" ? opts.list : undefined);
      return;
    }
    if (opts.kill !== undefined) {
      await killStreams(typeof opts.kill === "string" ? opts.kill : undefined);
      return;
    }
    if (opts.transport !== "http" && opts.transport !== "webrtc") {
      console.error("--transport must be one of: http, webrtc.");
      process.exit(1);
    }
    const wasProvided = (name: string) => program.getOptionValueSource(name) === "cli";
    const webRtcOptionProvided = [
      "webrtcCodec",
      "stunUrl",
      "turnUrl",
      "turnUsername",
      "turnCredential",
    ].some(wasProvided);
    if (opts.transport === "http" && webRtcOptionProvided) {
      console.error("WebRTC options require --transport webrtc.");
      process.exit(1);
    }
    if (opts.transport === "webrtc" && wasProvided("codec")) {
      console.error("--codec configures HTTP streaming; use --webrtc-codec with --transport webrtc.");
      process.exit(1);
    }
    if ((opts.turnUsername === undefined) !== (opts.turnCredential === undefined)) {
      console.error("--turn-username and --turn-credential must be provided together.");
      process.exit(1);
    }
    if ((opts.turnUsername !== undefined || opts.turnCredential !== undefined) && !opts.turnUrl) {
      console.error("--turn-username and --turn-credential require --turn-url.");
      process.exit(1);
    }
    const stunUrls: string[] = opts.stunUrl ?? [];
    const webrtcIceServers: WebRtcIceServer[] = [];
    if (stunUrls.length) webrtcIceServers.push({ urls: stunUrls });
    if (opts.turnUrl) {
      webrtcIceServers.push({
        urls: opts.turnUrl,
        username: opts.turnUsername,
        credential: opts.turnCredential,
      });
    }
    const encoderOptionNames = [
      "mjpegFps",
      "mjpegQuality",
      "maxDimension",
      "videoBitrate",
      "videoFps",
    ];
    const encoderOptions = {
      ...(wasProvided("mjpegFps") ? { mjpegFps: opts.mjpegFps } : {}),
      ...(wasProvided("mjpegQuality") ? { mjpegQuality: opts.mjpegQuality } : {}),
      ...(wasProvided("maxDimension") ? { maxDimension: opts.maxDimension } : {}),
      ...(wasProvided("videoBitrate") ? { h264Bitrate: opts.videoBitrate } : {}),
      ...(wasProvided("videoFps") ? { h264Fps: opts.videoFps } : {}),
    };
    const stream: StreamRuntimeOptions = opts.transport === "webrtc"
      ? {
          transport: "webrtc",
          codec: opts.webrtcCodec,
          ...(webrtcIceServers.length ? { iceServers: webrtcIceServers } : {}),
          ...encoderOptions,
        }
      : {
          transport: "http",
          codec: opts.codec,
          ...encoderOptions,
        };
    const bundleId =
      typeof opts.launchAppIdentifier === "string" ? opts.launchAppIdentifier.trim() : "";
    if (opts.launchAppIdentifier !== undefined && !bundleId) {
      console.error("--launch-app-identifier needs an app bundle identifier, such as host.exp.Exponent.");
      process.exit(1);
    }
    const launchArgs: string[] = opts.launchArg ?? [];
    const openUrl: string | undefined = opts.openUrl;
    if (!bundleId && (launchArgs.length > 0 || openUrl)) {
      console.error(
        "--launch-arg and --open-url apply to an app launch. Pass --launch-app-identifier with the app to launch.",
      );
      process.exit(1);
    }
    const capabilities: { enable: string[]; disable: string[] } = {
      enable: (opts.enable as string[] | undefined) ?? [],
      disable: (opts.disable as string[] | undefined) ?? [],
    };
    try {
      assertKnownCapabilities([...capabilities.enable, ...capabilities.disable]);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
    // Only take over device selection when something has to happen before the
    // run mode starts. Otherwise follow and detach pick their own target, as
    // they did before this flag existed.
    const launchesBeforeStreaming =
      Boolean(bundleId) ||
      capabilities.enable.length > 0 ||
      capabilities.disable.length > 0 ||
      hasDefaultCapabilities();

    const startPort: number | undefined = opts.port;
    const streamOptionsProvided = wasProvided("transport")
      || wasProvided("codec")
      || webRtcOptionProvided
      || encoderOptionNames.some(wasProvided);
    const debugStreamPath = opts.debugStream?.trim();
    if (opts.debugStream !== undefined) {
      // Every run mode that would record nothing useful, rather than accepting the flag and
      // writing empty samples for the whole session.
      const unusable = !debugStreamPath
        ? "--debug-stream needs a file path, for example --debug-stream ./stream.ndjson"
        : opts.detach || opts.preview === false
          ? "--debug-stream needs the preview server, so drop --detach/--no-preview."
          : stream.transport !== "webrtc"
            ? "--debug-stream records sender statistics, which only exist on --transport webrtc."
            : null;
      if (unusable !== null) {
        console.error(unusable);
        process.exit(1);
      }
    }
    if (opts.requireToken && (opts.detach || opts.preview === false)) {
      console.error(
        "--require-token needs the preview server, so drop --detach/--no-preview. It gates the " +
          "network-exposed preview; those modes bind loopback only, where the token does nothing.",
      );
      process.exit(1);
    }
    if (opts.detach) {
      const unsupported = [
        ...(bundleId ? ["--launch-app-identifier"] : []),
        ...(launchArgs.length > 0 ? ["--launch-arg"] : []),
        ...(openUrl ? ["--open-url"] : []),
        ...(capabilities.enable.length > 0 ? ["--enable"] : []),
        ...(capabilities.disable.length > 0 ? ["--disable"] : []),
      ];
      if (unsupported.length > 0) {
        console.error(
          `${unsupported.join(", ")} ${unsupported.length === 1 ? "needs" : "need"} the foreground ` +
            "session, so drop --detach. A detached helper only streams: it does not arm the " +
            "capability loader or launch an app.",
        );
        process.exit(1);
      }
    }
    let targets = devices;
    if (!opts.detach) {
      try {
        targets = resolveTargetDevices(devices);
        // The capability loader is armed for the whole session, not when a capability
        // turns on: an app only carries it if it was inserted at launch, so
        // arming late means the app it was armed for cannot receive anything
        // until it restarts. It loads nothing on its own, so an app that never
        // gets a capability pays a libSystem-only dylib and nothing else.
        {
          process.on("exit", disarmDevicesArmedHere);
          for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
            process.on(signal, async () => {
              sessionStopping = true;
              await disarmDevicesArmedHereAsync();
              if (process.listenerCount(signal) > 1) return;
              process.exit(0);
            });
          }
        }
        for (const udid of targets) {
          await ensureBooted(udid);
          if (sessionStopping) return;
        }
        const isStreamHelper = process.env[STREAM_HELPER_ENV] === "1";
        if (!isStreamHelper) {
          for (const udid of targets) {
            await armCapabilityLoader(udid);
            if (sessionStopping) return;
          }
        }
        for (const udid of launchesBeforeStreaming && !isStreamHelper ? targets : []) {
          if (sessionStopping) return;
          if (bundleId) {
            await launchAppAsync(udid, { bundleId, launchArgs, openUrl, capabilities });
          } else {
            const applied = await applyDefaultCapabilities(udid, null, capabilities);
            const missing = capabilities.enable.filter((name) => !applied.includes(name));
            if (missing.length > 0) {
              console.error(
                `Requested ${missing.join(", ")} but ${missing.length === 1 ? "it" : "they"} ` +
                  `did not apply on ${udid}. See the message above for why.`,
              );
              process.exit(1);
            }
          }
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
      }
    }
    if (sessionStopping) return;
    if (opts.detach) {
      const states = await detach(targets, startPort ?? 3100, stream, streamOptionsProvided);
      printStatesJSON(states);
    } else if (opts.preview === false) {
      await follow(targets, startPort ?? 3100, !!opts.quiet, stream, streamOptionsProvided);
    } else {
      await serve(startPort ?? 3200, targets, startPort !== undefined, opts.host, {
        stream,
        corsOrigins: [...opts.corsOrigin, ...opts.metricsCorsOrigin],
        frameAncestors: opts.frameAncestor,
        shareUrl: opts.shareUrl,
        debugStreamPath,
        requireToken: !!opts.requireToken,
        quiet: !!opts.quiet,
      });
    }
  });

const deviceOpt = ["-d, --device <udid>", "Target a specific simulator (udid or name)"] as const;

program
  .command("gesture")
  .description("Send a touch gesture")
  .argument("<json>", 'Gesture JSON, e.g. \'{"type":"begin","x":0.5,"y":0.5}\'')
  .option(...deviceOpt)
  .action((json: string, opts) => gesture(json, opts.device));

program
  .command("tap")
  .description("Tap at normalized 0..1 coords")
  .argument("<x>", "X coord, normalized 0..1")
  .argument("<y>", "Y coord, normalized 0..1")
  .option(...deviceOpt)
  .action((x: string, y: string, opts) => tap(x, y, opts.device));

program
  .command("button")
  .description("Send a hardware button press")
  .argument("[name]", "Button name", "home")
  .option(...deviceOpt)
  .action((name: string, opts) => button(name, opts.device));

program
  .command("type")
  .description("Type text (US keyboard only)")
  .argument("[text...]", "Text to type")
  .option(...deviceOpt)
  .option("--stdin", "Read text from stdin")
  .option("--file <path>", "Read text from a file")
  .action((text: string[], opts) =>
    typeText(text, { device: opts.device, stdin: opts.stdin, file: opts.file }),
  );

program
  .command("rotate")
  .description(
    "Set device orientation " +
      "(portrait|portrait_upside_down|landscape_left|landscape_right)",
  )
  .argument("<orientation>")
  .option(...deviceOpt)
  .action((orientation: string, opts) => rotate(orientation, opts.device));

program
  .command("hinge")
  .description("Set a foldable simulator's hinge angle (0° folded, 90° half folded, 180° unfolded)")
  .argument("<position>", "fold|half|unfold or an angle from 0 to 180 degrees", (value: string) => {
    const angle = parseHingeAngle(value);
    if (angle === undefined) throw new InvalidArgumentError("Expected fold, half, unfold, or an angle from 0 to 180");
    return angle;
  })
  .option(...deviceOpt)
  .action((angle: number, opts) => hinge(angle, opts.device));

program
  .command("ca-debug")
  .description(
    "Toggle a CoreAnimation debug render flag " +
      "(blended|copies|misaligned|offscreen|slow-animations)",
  )
  .argument("<option>")
  .argument("<state>", "on|off")
  .option(...deviceOpt)
  .action((option: string, state: string, opts) => caDebug(option, state, opts.device));

program
  .command("memory-warning")
  .description("Simulate a memory warning on the device")
  .option(...deviceOpt)
  .action((opts) => memoryWarning(opts.device));

program
  .command("event-log")
  .description("Show recent simulator events")
  .option(...deviceOpt)
  .option("-j, --json", "Print JSON")
  .option("-n, --limit <count>", "Maximum number of events")
  .action((opts) => eventLog(opts.device, { json: opts.json, limit: opts.limit }));

// `camera` and `permissions` keep their own dedicated argument parsers (the
// camera verb has nested sub-verbs and source flags; permissions has a
// unit-tested parser module). Register them as passthrough commands so they
// still appear in `--help` and route to those parsers verbatim.
program
  .command("camera")
  .description("Inject a synthetic camera feed and launch an app (see `camera --help`)")
  .allowUnknownOption(true)
  .helpOption(false)
  .argument("[args...]")
  .action((args: string[]) => camera(args));

program
  .command("permissions")
  .description("Manage app permissions (see `permissions` with no args for usage)")
  .allowUnknownOption(true)
  .helpOption(false)
  .argument("[args...]")
  .action((args: string[]) => permissions(args));

program
  .command("ui")
  .description("Get or set simulator-wide UI options (see `ui --help`)")
  .allowUnknownOption(true)
  .helpOption(false)
  .argument("[args...]")
  .action((args: string[]) => uiSettings(args));


await program.parseAsync(process.argv);
