/**
 * Physical screen corner radii for the Hub device list.
 *
 * The device list is rebuilt about twice a second, so every lookup is cached.
 * Apple radii come from static DeviceKit data and are kept for the life of the
 * server. Android devices do not report radii yet, so they keep the generic
 * platform radius.
 */

import { readCornerRadii as readAppleCornerRadii } from "@expo/hub-apple-utils";

import { type ScreenCornerRadii } from "@expo/hub-components";

type Reader = (deviceTypeIdentifier: string | null) => Promise<{
  value: ScreenCornerRadii | null;
}>;

const appleCache = new Map<string, Promise<ScreenCornerRadii | null>>();

/** Corner radii for an iOS simulator model, or null when DeviceKit has no profile for it. */
export function appleCornerRadii(
  deviceTypeIdentifier: string | null,
  read: Reader = readAppleCornerRadii,
): Promise<ScreenCornerRadii | null> {
  if (!deviceTypeIdentifier) return Promise.resolve(null);

  let radii = appleCache.get(deviceTypeIdentifier);
  if (!radii) {
    radii = read(deviceTypeIdentifier).then(({ value }) => value);
    appleCache.set(deviceTypeIdentifier, radii);
  }
  return radii;
}

/** Forget every cached radius, for tests. */
export function clearCornerRadiiCache(): void {
  appleCache.clear();
}
