import { execFileSync, spawn as nodeSpawn } from "child_process";
import { existsSync, mkdirSync, openSync, closeSync, unlinkSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { join, resolve } from "path";
import { dirnameOf, sleepSync } from "./runtime";
import { hasProcessExited } from "./process-utils";
import type { CapabilityDefinition } from "./capabilities";
import type { CamSourceKind, ResolvedSource } from "./camera-media";
import {
  cameraStateDir as simcamStateDir,
  cameraHelperBundlesFile as helperBundlesFile,
  cameraHelperPidFile as helperPidFile,
  cameraHelperSocketFile as helperSocketFile,
  isCameraHelperAlive as isHelperAlive,
  readCameraHelperPid,
  sendCameraHelperCommand as sendHelperCommand,
} from "./camera-helper";

const __dirname = dirnameOf(import.meta.url);

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
  execFileSync("bash", [buildScript], { stdio: "inherit" });
  const out = locateCameraDylib();
  if (!out) throw new Error("Build succeeded but dylib not found.");
  return out;
}

export function locateCameraHelper(): string | null {
  const candidates = [
    join(__dirname, "..", "dist", "simcam", "serve-sim-camera-helper"),
    join(__dirname, "simcam", "serve-sim-camera-helper"),
  ];
  for (const p of candidates) if (existsSync(p)) return resolve(p);
  return null;
}

export function buildCameraHelper(): string {
  const buildScript = join(__dirname, "..", "Sources", "SimCameraHelper", "build.sh");
  if (!existsSync(buildScript)) {
    throw new Error(
      "SimCameraHelper source not found — webcam support requires building " +
      "from a checkout that includes Sources/SimCameraHelper.",
    );
  }
  console.error("[serve-sim] building serve-sim-camera-helper (one-time)…");
  execFileSync("bash", [buildScript], { stdio: "inherit" });
  const out = locateCameraHelper();
  if (!out) throw new Error("Build succeeded but helper binary not found.");
  return out;
}

export function shmNameForUdid(udid: string): string {
  // POSIX shm names on macOS have a 31-char limit. Hash the UDID short.
  const short = createHash("sha1").update(udid).digest("hex").slice(0, 8);
  return `/serve-sim-cam-${short}`;
}

function clearInjectedBundles(udid: string): void {
  try { unlinkSync(helperBundlesFile(udid)); } catch {}
}

function waitForExit(pid: number, budgetMs: number): boolean {
  const start = Date.now();
  // Each check forks ps.
  while (!hasProcessExited(pid) && Date.now() - start < budgetMs) sleepSync(100);
  return hasProcessExited(pid);
}

export function stopExistingHelper(udid: string) {
  const pf = helperPidFile(udid);
  if (!existsSync(pf)) return;
  const pid = readCameraHelperPid(udid);
  if (pid !== null && !hasProcessExited(pid)) {
    try { process.kill(pid, "SIGTERM"); } catch {}
    // Give it a moment to clean up the shm region.
    if (!waitForExit(pid, 1500)) {
      try { process.kill(pid, "SIGKILL"); } catch {}
      // Keep the pid file: dropping it would hide a helper that still holds the shm.
      if (!waitForExit(pid, 1500)) {
        throw new Error(
          `The camera helper (pid ${pid}) on ${udid} did not exit, so apps may still be ` +
            `receiving its frames. Stop it with \`kill -9 ${pid}\`, then retry.`,
        );
      }
    }
  }
  try { unlinkSync(pf); } catch {}
  // A socket left by a killed helper would make the next start look instantly healthy.
  try { unlinkSync(helperSocketFile(udid)); } catch {}
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
}): void {
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
    if (hasProcessExited(child.pid)) {
      throw new Error(`camera helper exited early — see log at ${logPath}`);
    }
    if (existsSync(args.socketPath)) return;
    sleepSync(50);
  }
  // Keep the socket error: it names the log.
  try { stopExistingHelper(args.udid); } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
  }
  throw new Error(
    `camera helper did not open its control socket within 3s — see log at ${logPath}`,
  );
}

async function ensureHelperWithSource(opts: {
  udid: string;
  source: ResolvedSource | null;
  forceBuild: boolean;
}): Promise<string> {
  const shmName = shmNameForUdid(opts.udid);
  const sockPath = helperSocketFile(opts.udid);
  if (isHelperAlive(opts.udid)) {
    let source = opts.source;
    // Enabling without a source joins the feed another session picked, unless a failed switch left none.
    if (!source) {
      const status = await sendHelperCommand(opts.udid, { action: "status" });
      if (status.source !== "none") return shmName;
      source = { kind: "placeholder" };
    }
    // Hot-swap source via control socket — no relaunch needed.
    const reply = await sendHelperCommand(opts.udid, {
      action: "switch",
      source: source.kind,
      arg: source.arg,
    });
    if (!reply.ok) throw new Error(reply.error || "helper rejected switch");
    return shmName;
  }
  // Need to start a fresh helper. Pre-emptively reap any stale state.
  stopExistingHelper(opts.udid);
  const helper = (!opts.forceBuild && locateCameraHelper()) || buildCameraHelper();
  const source = opts.source ?? { kind: "placeholder" };
  spawnCameraHelper({
    udid: opts.udid,
    helperBin: helper,
    shmName,
    socketPath: sockPath,
    source: source.kind,
    arg: source.arg,
  });
  return shmName;
}

export const cameraCapability: CapabilityDefinition = {
  name: "camera",
  defaultEnabled: false,
  scope: "allApps",
  loadDelayMs: 0,
  async setEnabled({ udid, options, enabled }) {
    if (!enabled) {
      stopExistingHelper(udid);
      return null;
    }
    const forceBuild = options.forceBuild === "1";
    const dylib = (forceBuild ? null : locateCameraDylib()) ?? buildCameraDylib();
    const kind = (options.kind ?? "placeholder") as CamSourceKind;
    const source: ResolvedSource | null = options.arg
      ? { kind, arg: options.arg }
      : options.kind ? { kind } : null;
    const shmName = await ensureHelperWithSource({ udid, source, forceBuild });
    return {
      dylib,
      env: {
        SIMCAM_SHM_NAME: shmName,
        ...(options.mirror && options.mirror !== "auto"
          ? { SIMCAM_MIRROR_MODE: options.mirror }
          : {}),
      },
    };
  },
};
