import {
  type DeviceActivity,
  type DeviceActivitySample,
} from './types';

export const MAX_ACTIVITY_SAMPLES = 60;

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Parse one untrusted serve-sim metrics sample. */
export function parseActivitySample(value: unknown): DeviceActivitySample | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const sample = value as Record<string, unknown>;
  const t = finiteNumber(sample.t);
  const cpuPct = finiteNumber(sample.cpuPct);
  const memBytes = finiteNumber(sample.memBytes);
  const netInBytesPerSec = finiteNumber(sample.netInBytesPerSec);
  const netOutBytesPerSec = finiteNumber(sample.netOutBytesPerSec);
  if (
    t === null ||
    cpuPct === null ||
    memBytes === null ||
    netInBytesPerSec === null ||
    netOutBytesPerSec === null ||
    (sample.bundleId !== null && typeof sample.bundleId !== 'string')
  ) {
    return null;
  }
  return {
    t,
    bundleId: sample.bundleId,
    cpuPct,
    memBytes,
    netInBytesPerSec,
    netOutBytesPerSec,
  };
}

/** Read the host-core count from a serve-sim `event: meta` frame. */
export function parseActivityHostCores(value: unknown): number | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const hostCores = finiteNumber((value as Record<string, unknown>).hostCores);
  return hostCores !== null && hostCores > 0 ? hostCores : null;
}

/** Append a sample, resetting history only when one real foreground app replaces another. */
export function appendActivitySample(
  activity: DeviceActivity,
  sample: DeviceActivitySample,
): DeviceActivity {
  const previousBundle = [...activity.samples]
    .reverse()
    .find((entry) => entry.bundleId !== null)?.bundleId;
  const appChanged =
    previousBundle !== undefined &&
    sample.bundleId !== null &&
    previousBundle !== sample.bundleId;
  return {
    ...activity,
    samples: [...(appChanged ? [] : activity.samples), sample].slice(-MAX_ACTIVITY_SAMPLES),
    errored: false,
    stale: false,
  };
}
