import {
  DEFAULT_DEVICE_STREAM_SETTINGS,
  normalizeDeviceStreamSettings,
} from './stream-settings';
import { type DeviceStreamEncoderSettings } from './types';

export type AndroidStreamSettingsPatch = Pick<DeviceStreamEncoderSettings, 'maxDimension'>;

/** Restrict the shared encoder patch API to the setting serve-emu can change at runtime. */
export function androidStreamSettingsPatch(
  patch: Partial<DeviceStreamEncoderSettings>,
): AndroidStreamSettingsPatch | null {
  if (
    typeof patch.maxDimension !== 'number' ||
    !Number.isInteger(patch.maxDimension) ||
    patch.maxDimension < 0 ||
    patch.maxDimension > 4096
  ) {
    return null;
  }
  return { maxDimension: patch.maxDimension };
}

/** Parse the authoritative serve-emu response without inventing a resolution. */
export function parseAndroidStreamSettings(
  value: unknown,
  fallback: DeviceStreamEncoderSettings = DEFAULT_DEVICE_STREAM_SETTINGS,
): DeviceStreamEncoderSettings | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const maxDimension = (value as Record<string, unknown>).maxDimension;
  if (
    typeof maxDimension !== 'number' ||
    !Number.isInteger(maxDimension) ||
    maxDimension < 0 ||
    maxDimension > 4096
  ) {
    return null;
  }
  return normalizeDeviceStreamSettings(value, fallback);
}
