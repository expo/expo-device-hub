import { spawnSync } from "node:child_process";

/** Values accepted by `adb shell cmd uimode night` (system dark-theme setting). */
export const NIGHT_MODES = ["yes", "no", "auto"] as const;
export type NightMode = (typeof NIGHT_MODES)[number];

export function isNightMode(value: unknown): value is NightMode {
  return typeof value === "string" && (NIGHT_MODES as readonly string[]).includes(value);
}

function uimodeNight(serial: string, arg?: NightMode): string {
  const args = ["-s", serial, "shell", "cmd", "uimode", "night"];
  if (arg) args.push(arg);
  const result = spawnSync("adb", args, { encoding: "utf8", timeout: 4_000 });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "adb cmd uimode night failed").trim());
  }
  return result.stdout;
}

/**
 * Current system night (dark) mode — typically `yes`, `no`, or `auto`. Reads via
 * `adb shell cmd uimode night`, which prints `Night mode: <value>`.
 */
export function getNightMode(serial: string): string {
  const out = uimodeNight(serial);
  const match = out.match(/Night mode:\s*(\w+)/i);
  if (!match) throw new Error(`Could not parse uimode output: ${out.trim()}`);
  return match[1].toLowerCase();
}

/**
 * Set the system night (dark) mode. The set command's stdout wording varies by
 * Android version, so we treat a zero exit as success and echo back the applied
 * mode rather than parsing it.
 */
export function setNightMode(serial: string, mode: NightMode): NightMode {
  uimodeNight(serial, mode);
  return mode;
}
