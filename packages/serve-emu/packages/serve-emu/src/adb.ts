import { spawn, spawnSync } from "node:child_process";

export type Device = { serial: string; state: string };
export type OrientationMode = "auto" | "portrait" | "landscape";
export type OrientationStatus = {
  mode: "free" | "lock" | "unknown";
  rotation: number | null;
  orientation: OrientationMode | "unknown";
  raw: string;
};

export function listAllDevices(): Device[] {
  const r = spawnSync("adb", ["devices"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`adb devices failed: ${r.stderr}`);
  return r.stdout
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [serial, state] = l.split(/\s+/);
      return { serial, state };
    });
}

export function listDevices(): Device[] {
  return listAllDevices().filter((d) => d.state === "device");
}

export function pickDevice(explicit?: string): string {
  if (explicit) return explicit;
  const devices = listDevices();
  if (devices.length === 0) throw new Error("No booted Android device found. Start an emulator or attach a device.");
  if (devices.length > 1)
    throw new Error(
      `Multiple devices online (${devices.map((d) => d.serial).join(", ")}). Pass -s <serial>.`,
    );
  return devices[0].serial;
}

export function screencapPng(serial: string): Buffer {
  const r = spawnSync("adb", ["-s", serial, "exec-out", "screencap", "-p"], {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`screencap failed: ${r.stderr.toString()}`);
  return r.stdout;
}

export function shell(serial: string, cmd: string[]): void {
  const r = spawnSync("adb", ["-s", serial, "shell", ...cmd], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`adb shell ${cmd.join(" ")} failed: ${r.stderr}`);
}

export function shellSpawn(serial: string, cmd: string[]) {
  return spawn("adb", ["-s", serial, "shell", ...cmd]);
}

function orientationFromRotation(mode: "free" | "lock" | "unknown", rotation: number | null): OrientationStatus["orientation"] {
  if (mode === "free") return "auto";
  if (rotation === 0 || rotation === 2) return "portrait";
  if (rotation === 1 || rotation === 3) return "landscape";
  return "unknown";
}

export function getUserRotation(serial: string): OrientationStatus {
  const r = spawnSync("adb", ["-s", serial, "shell", "cmd", "window", "user-rotation"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`cmd window user-rotation failed: ${r.stderr}`);
  const raw = r.stdout.trim();
  const match = raw.match(/^(free|lock)(?:\s+(\d+))?$/);
  if (!match) {
    return { mode: "unknown", rotation: null, orientation: "unknown", raw };
  }
  const mode = match[1] as "free" | "lock";
  const rotation = match[2] === undefined ? null : Number(match[2]);
  return { mode, rotation, orientation: orientationFromRotation(mode, rotation), raw };
}

export function setUserRotation(serial: string, orientation: OrientationMode): OrientationStatus {
  const args =
    orientation === "auto"
      ? ["cmd", "window", "user-rotation", "free"]
      : ["cmd", "window", "user-rotation", "lock", orientation === "portrait" ? "0" : "1"];
  const r = spawnSync("adb", ["-s", serial, "shell", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`adb shell ${args.join(" ")} failed: ${r.stderr}`);
  return getUserRotation(serial);
}

export function getDeviceSize(serial: string): { width: number; height: number } {
  const r = spawnSync("adb", ["-s", serial, "shell", "wm", "size"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`wm size failed: ${r.stderr}`);
  const m = r.stdout.match(/(\d+)x(\d+)/);
  if (!m) throw new Error(`Could not parse wm size output: ${r.stdout}`);
  return { width: Number(m[1]), height: Number(m[2]) };
}
