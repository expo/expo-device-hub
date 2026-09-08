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
