/**
 * Physical screen corner radii for the Hub device list.
 *
 * The device list is rebuilt about twice a second, so every lookup is cached. A model
 * with radii, and a model with no DeviceKit profile, are both kept for the life of the
 * server: Apple's data does not change. A lookup that failed is only remembered for a
 * short time, so a transient failure does not hide a model's radii until a restart, and
 * a lasting failure is not retried on every refresh. Android devices do not report
 * radii yet, so they keep the generic platform radius.
 */

import { readCornerRadii as readAppleCornerRadii } from "@expo/hub-apple-utils";

import { type ScreenCornerRadii } from "@expo/hub-components";

/** How long a failed lookup is remembered before the next refresh asks again. */
const RETRY_AFTER_FAILURE_MS = 10_000;

type Reader = (deviceTypeIdentifier: string | null) => Promise<{
  value: ScreenCornerRadii | null;
  /** Set when the profile could not be read, as opposed to there being none. */
  error?: unknown;
}>;

interface CacheEntry {
  /** Shared by refreshes that overlap the read. */
  radii: Promise<ScreenCornerRadii | null>;
  readAt: number;
  failed: boolean;
}

const appleCache = new Map<string, CacheEntry>();

/**
 * Corner radii for an iOS simulator model. `null` means DeviceKit has no profile for it,
 * or the profile could not be read yet.
 */
export function appleCornerRadii(
  deviceTypeIdentifier: string | null,
  read: Reader = readAppleCornerRadii,
  now: number = Date.now(),
): Promise<ScreenCornerRadii | null> {
  if (!deviceTypeIdentifier) return Promise.resolve(null);

  const cached = appleCache.get(deviceTypeIdentifier);
  if (cached && !(cached.failed && now - cached.readAt >= RETRY_AFTER_FAILURE_MS)) {
    return cached.radii;
  }

  const entry: CacheEntry = { radii: Promise.resolve(null), readAt: now, failed: false };
  entry.radii = read(deviceTypeIdentifier).then(
    ({ value, error }) => {
      entry.failed = error != null;
      return value;
    },
    () => {
      entry.failed = true;
      return null;
    },
  );
  appleCache.set(deviceTypeIdentifier, entry);
  return entry.radii;
}

/** Forget every cached radius, for tests. */
export function clearCornerRadiiCache(): void {
  appleCache.clear();
}
