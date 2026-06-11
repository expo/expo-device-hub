import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { listAllDevices } from "./adb.ts";

export type EmulatorLaunch = {
  serial: string;
  proc: ChildProcess | null;
  ownsProcess: boolean;
  stop: () => void;
};

export type RunningAvd = {
  serial: string;
  avd: string;
  state: string;
};

export type StartEmulatorOpts = {
  avd: string;
  emulatorPath?: string;
  port?: number;
  restartAvd?: boolean;
  bootTimeoutMs?: number;
};

function sdkEmulatorCandidates(): string[] {
  const roots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.env.HOME ? join(process.env.HOME, "Library", "Android", "sdk") : undefined,
  ].filter((v): v is string => Boolean(v));
  return [...new Set(roots)].flatMap((root) => [
    join(root, "emulator", "emulator"),
    join(root, "tools", "emulator"),
  ]);
}

export function resolveEmulator(explicit?: string): string {
  if (explicit) return explicit;

  const pathProbe = spawnSync("emulator", ["-version"], { encoding: "utf8" });
  if (pathProbe.status === 0 || pathProbe.error?.message.includes("EPIPE")) return "emulator";

  for (const candidate of sdkEmulatorCandidates()) {
    if (existsSync(candidate)) return candidate;
  }

  throw new Error(
    "Could not find Android Emulator. Put `emulator` on PATH or set ANDROID_HOME / ANDROID_SDK_ROOT.",
  );
}

function listAvdsWithEmulator(emulator: string): string[] {
  const r = spawnSync(emulator, ["-list-avds"], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`emulator -list-avds failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function listAvds(emulatorPath?: string): string[] {
  return listAvdsWithEmulator(resolveEmulator(emulatorPath));
}

function avdName(avd: string): string {
  return avd.startsWith("@") ? avd.slice(1) : avd;
}

function emulatorAvdArg(avd: string): string {
  return avd.startsWith("@") ? avd : `@${avd}`;
}

function usedEmulatorPorts(): Set<number> {
  const ports = new Set<number>();
  for (const device of listAllDevices()) {
    const match = device.serial.match(/^emulator-(\d+)$/);
    if (match) ports.add(Number(match[1]));
  }
  return ports;
}

function pickEmulatorPort(): number {
  const used = usedEmulatorPorts();
  for (let port = 5554; port <= 5682; port += 2) {
    if (!used.has(port)) return port;
  }
  throw new Error("No available emulator console ports in the 5554-5682 range.");
}

function validateEmulatorPort(port: number): void {
  if (!Number.isInteger(port) || port < 5554 || port > 5682 || port % 2 !== 0) {
    throw new Error("--emulator-port must be an even integer from 5554 through 5682.");
  }
}

function adb(serial: string, args: string[]) {
  return spawnSync("adb", ["-s", serial, ...args], {
    encoding: "utf8",
    timeout: 5_000,
  });
}

function parseEmuAvdName(stdout: string): string | null {
  return (
    stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && line !== "OK" && !line.startsWith("KO:")) ?? null
  );
}

function runningAvdName(serial: string): string | null {
  const fromConsole = adb(serial, ["emu", "avd", "name"]);
  if (fromConsole.status === 0) {
    const name = parseEmuAvdName(fromConsole.stdout);
    if (name) return name;
  }

  const fromProp = adb(serial, ["shell", "getprop", "ro.boot.qemu.avd_name"]);
  if (fromProp.status === 0) {
    const name = fromProp.stdout.trim();
    if (name) return name;
  }

  return null;
}

export function listRunningAvds(): RunningAvd[] {
  return listAllDevices()
    .filter((device) => /^emulator-\d+$/.test(device.serial))
    .flatMap((device) => {
      const avd = runningAvdName(device.serial);
      return avd ? [{ serial: device.serial, avd, state: device.state }] : [];
    });
}

function findRunningAvd(name: string): RunningAvd | null {
  return listRunningAvds().find((running) => running.avd === name) ?? null;
}

function killEmulator(serial: string): void {
  const r = adb(serial, ["emu", "kill"]);
  if (r.status !== 0) {
    throw new Error(`Failed to stop ${serial}: ${r.stderr || r.stdout}`);
  }
}

async function waitForEmulatorExit(serial: string, timeoutMs = 30_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!listAllDevices().some((device) => device.serial === serial)) return;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${serial} to stop.`);
}

async function waitForBoot(serial: string, proc: ChildProcess, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(`emulator exited before boot completed (code ${proc.exitCode ?? "null"})`);
    }

    const state = adb(serial, ["get-state"]);
    if (state.status === 0 && state.stdout.trim() === "device") {
      const boot = adb(serial, ["shell", "getprop", "sys.boot_completed"]);
      if (boot.status === 0 && boot.stdout.trim() === "1") return;
    }

    await sleep(1_000);
  }

  throw new Error(`Timed out waiting for ${serial} to boot.`);
}

export async function startEmulator(opts: StartEmulatorOpts): Promise<EmulatorLaunch> {
  const emulator = resolveEmulator(opts.emulatorPath);
  const name = avdName(opts.avd);
  const avds = listAvdsWithEmulator(emulator);
  if (!avds.includes(name)) {
    const available = avds.length ? avds.join(", ") : "(none)";
    throw new Error(`Unknown AVD "${name}". Available AVDs: ${available}`);
  }

  const running = findRunningAvd(name);
  if (running) {
    if (!opts.restartAvd) {
      return { serial: running.serial, proc: null, ownsProcess: false, stop: () => {} };
    }
    killEmulator(running.serial);
    await waitForEmulatorExit(running.serial);
  }

  const port = opts.port ?? pickEmulatorPort();
  validateEmulatorPort(port);

  const args = [emulatorAvdArg(name), "-port", String(port)];

  const proc = spawn(emulator, args, { stdio: ["ignore", "inherit", "inherit"] });
  const spawnError = new Promise<never>((_, reject) => {
    proc.once("error", reject);
  });
  const serial = `emulator-${port}`;
  let stopped = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    try {
      adb(serial, ["emu", "kill"]);
    } catch {}
    try {
      proc.kill("SIGTERM");
    } catch {}
  };

  try {
    await Promise.race([waitForBoot(serial, proc, opts.bootTimeoutMs ?? 120_000), spawnError]);
    return { serial, proc, ownsProcess: true, stop };
  } catch (err) {
    stop();
    throw err;
  }
}
