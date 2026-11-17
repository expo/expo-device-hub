import { type Device, type Platform } from "./data";

/** The characters that `avdmanager` accepts in the name of an Android virtual device. */
export const ANDROID_AVD_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
export const ANDROID_AVD_NAME_HINT = "Allowed: a-z A-Z 0-9 . _ -";

/** Whether a device of the platform can have this name. */
export function isValidDeviceName(name: string, platform: Platform): boolean {
  const trimmed = name.trim();
  return trimmed.length > 0 && (platform !== "android" || ANDROID_AVD_NAME_PATTERN.test(trimmed));
}

/** Default name for a new device: the model, with the next free integer suffix. */
export function suggestDeviceName(model: string, existing: Device[], platform: Platform): string {
  const base =
    platform === "android"
      ? model
          .trim()
          .replace(/[^A-Za-z0-9._-]+/g, "_")
          .replace(/^_+|_+$/g, "")
      : model;
  if (!base) return "";
  const taken = new Set(existing.map((device) => device.name));
  if (!taken.has(base)) return base;
  let n = 2;
  const separator = platform === "android" ? "_" : " ";
  while (taken.has(`${base}${separator}${n}`)) n++;
  return `${base}${separator}${n}`;
}

/** The devices of a list, most recently used first. */
export function byLastUsed(devices: Device[]): Device[] {
  return [...devices].sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0));
}
