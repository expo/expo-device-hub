import { parseActivityHostCores, parseActivitySample } from "./activity";
import { type DeviceActivity, type DeviceActivitySample } from "./types";

export const ANDROID_ACTIVITY_STALE_MS = 8000;

export const EMPTY_ANDROID_ACTIVITY: DeviceActivity = {
  hostCores: null,
  samples: [],
  errored: false,
  stale: false,
};

export type AndroidActivityFrame =
  | { kind: "meta"; hostCores: number | null }
  | { kind: "sample"; sample: DeviceActivitySample };

export function parseAndroidActivityFrame(
  eventType: string,
  data: string,
): AndroidActivityFrame | null {
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return null;
  }
  if (eventType === "meta") return { kind: "meta", hostCores: parseActivityHostCores(payload) };
  if (eventType !== "message") return null;
  const sample = parseActivitySample(payload);
  return sample ? { kind: "sample", sample } : null;
}

export type AndroidActivityClock = {
  openedAt: number;
  lastSampleAt: number;
  now: number;
};

/**
 * A stream that connects but never yields a sample is a dead end: every probe
 * can fail while the heartbeat keeps the connection healthy, so `onerror`
 * never fires. Report that as errored rather than waiting forever.
 */
export function nextAndroidActivityAfterSilence(
  activity: DeviceActivity,
  clock: AndroidActivityClock,
): DeviceActivity | null {
  const since = clock.lastSampleAt > 0 ? clock.lastSampleAt : clock.openedAt;
  if (clock.now - since <= ANDROID_ACTIVITY_STALE_MS) return null;
  if (clock.lastSampleAt > 0) return activity.stale ? null : { ...activity, stale: true };
  return activity.errored ? null : { ...activity, errored: true };
}
