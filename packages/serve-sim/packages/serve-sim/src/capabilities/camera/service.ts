import { spawn as nodeSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { buildCameraHelper, locateCameraHelper } from "./assets";
import {
  cameraStateDir as simcamStateDir,
  cameraHelperBundlesFile as helperBundlesFile,
  cameraHelperPidFile as helperPidFile,
  cameraHelperSocketFile as helperSocketFile,
  isCameraHelperAlive as isHelperAlive,
  readInjectedCameraBundles as readInjectedBundles,
  sendCameraHelperCommand as sendHelperCommand,
  stopCameraHelper,
} from "./helper";
import type { CamSourceKind, ResolvedSource } from "./source";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function shmNameForUdid(udid: string): string {
  // POSIX shm names on macOS have a 31-char limit. Hash the UDID short.
  const short = createHash("sha1").update(udid).digest("hex").slice(0, 8);
  return `/serve-sim-cam-${short}`;
}

export function recordInjectedBundle(udid: string, bundleId: string, helperPid: number): void {
  const existing = readInjectedBundles(udid);
  const bundleIds = existing.includes(bundleId) ? existing : [...existing, bundleId];
  const next = { helperPid, bundleIds };
  mkdirSync(simcamStateDir(), { recursive: true });
  writeFileSync(helperBundlesFile(udid), JSON.stringify(next));
}

function clearInjectedBundles(udid: string): void {
  try {
    unlinkSync(helperBundlesFile(udid));
  } catch {}
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
  const argv = ["--shm", args.shmName, "--socket", args.socketPath, "--source", args.source];
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
  // Poll liveness/socket readiness briefly. Retain the existing return of
  // the PID after the deadline even if no socket appeared.
  const start = Date.now();
  while (Date.now() - start < 3000) {
    if (!isProcessAlive(child.pid)) {
      throw new Error(`camera helper exited early — see log at ${logPath}`);
    }
    if (existsSync(args.socketPath)) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return child.pid;
}

// @ref LLP 0007#camera-helper-startup — preserve helper reuse, PID/bundle ordering and the existing readiness deadline.
export async function ensureHelperWithSource(opts: {
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
  stopCameraHelper(opts.udid);
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
