/**
 * Physical screen corner radii for the Hub device list.
 *
 * The device list is rebuilt about twice a second, so every lookup is cached.
 * Apple radii come from static DeviceKit data and are kept for the life of the
 * server. Android radii need a booted device, so a miss is retried after a short
 * delay instead of on every poll.
 */

import { readCornerRadii as readAndroidCornerRadii } from "@expo/hub-android-utils";
import { readCornerRadii as readAppleCornerRadii } from "@expo/hub-apple-utils";

import { type ScreenCornerRadii } from "@expo/hub-components";

/** How long to wait before asking a device that reported no radii again. */
const ANDROID_RETRY_MS = 10_000;

type Reader<Key> = (key: Key) => Promise<{ value: ScreenCornerRadii | null }>;

const appleCache = new Map<string, Promise<ScreenCornerRadii | null>>();
interface AndroidCacheEntry {
  radii: Promise<ScreenCornerRadii | null>;
  readAt: number;
  /** True once a read finished with no radii, which makes the entry eligible for a retry. */
  settled: boolean;
}

const androidCache = new Map<string, AndroidCacheEntry>();

/** Corner radii for an iOS simulator model, or null when DeviceKit has no profile for it. */
export function appleCornerRadii(
  deviceTypeIdentifier: string | null,
  read: Reader<string | null> = readAppleCornerRadii,
): Promise<ScreenCornerRadii | null> {
  if (!deviceTypeIdentifier) return Promise.resolve(null);

  let radii = appleCache.get(deviceTypeIdentifier);
  if (!radii) {
    radii = read(deviceTypeIdentifier).then(({ value }) => value);
    appleCache.set(deviceTypeIdentifier, radii);
  }
  return radii;
}

/** Corner radii for a booted Android device, or null until the device reports them. */
export function androidCornerRadii(
  device: { serial: string | null; name: string; booted: boolean },
  read: Reader<string> = readAndroidCornerRadii,
  now: number = Date.now(),
): Promise<ScreenCornerRadii | null> {
  if (!device.booted || !device.serial) return Promise.resolve(null);

  // An emulator serial can be reused by another AVD, so the name is part of the key.
  const key = `${device.serial}\0${device.name}`;
  const cached = androidCache.get(key);
  if (cached && !(cached.settled && now - cached.readAt >= ANDROID_RETRY_MS)) {
    return cached.radii;
  }

  const entry: AndroidCacheEntry = { radii: Promise.resolve(null), readAt: now, settled: false };
  // Keep a found value; a miss expires so that the next poll after the delay asks again.
  entry.radii = read(device.serial).then(
    ({ value }) => {
      entry.settled = value === null;
      return value;
    },
    () => {
      entry.settled = true;
      return null;
    },
  );
  androidCache.set(key, entry);
  return entry.radii;
}

/** Forget every cached radius, for tests. */
export function clearCornerRadiiCache(): void {
  appleCache.clear();
  androidCache.clear();
}
