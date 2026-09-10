import {
  DEFAULT_DEVICE_STREAM_SETTINGS,
  normalizeDeviceStreamSettings,
} from './stream-settings';
import { type DeviceStreamEncoderSettings } from './types';

export type AndroidStreamSettingsPatch = Partial<
  Pick<DeviceStreamEncoderSettings, 'maxDimension' | 'h264Fps' | 'h264Bitrate'>
>;

/** Forward supported Android encoder settings with serve-emu's runtime bounds. */
export function androidStreamSettingsPatch(
  patch: Partial<DeviceStreamEncoderSettings>,
): AndroidStreamSettingsPatch | null {
  const result: AndroidStreamSettingsPatch = {};
  for (const [key, min, max] of [
    ['maxDimension', 0, 4096],
    ['h264Fps', 1, 120],
    ['h264Bitrate', 100_000, 50_000_000],
  ] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      return null;
    }
    result[key] = value;
  }
  return Object.keys(result).length > 0 ? result : null;
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
