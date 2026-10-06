import { type DeviceSettingKey, type DeviceSettings } from './types';

/**
 * Apply the authoritative value for one failed option write without replacing
 * unrelated optimistic values that may still be in flight.
 */
export function mergeAuthoritativeDeviceSetting(
  current: DeviceSettings | null,
  key: DeviceSettingKey,
  authoritative: DeviceSettings,
): DeviceSettings {
  const next = { ...(current ?? {}) };
  const value = authoritative[key];
  if (typeof value === 'string') next[key] = value;
  else delete next[key];
  return next;
}

/** Whether two settings snapshots hold the same keys and values. */
export function sameDeviceSettings(a: DeviceSettings | null, b: DeviceSettings): boolean {
  if (!a) return false;
  const keys = Object.keys(b) as DeviceSettingKey[];
  return Object.keys(a).length === keys.length && keys.every((key) => a[key] === b[key]);
}
