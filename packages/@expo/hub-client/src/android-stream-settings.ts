import {
  DEFAULT_DEVICE_STREAM_SETTINGS,
  DEVICE_STREAM_SETTING_BOUNDS,
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
  for (const key of ['maxDimension', 'h264Fps', 'h264Bitrate'] as const) {
    const [min, max] = DEVICE_STREAM_SETTING_BOUNDS[key];
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
  const [min, max] = DEVICE_STREAM_SETTING_BOUNDS.maxDimension;
  if (
    typeof maxDimension !== 'number' ||
    !Number.isInteger(maxDimension) ||
    maxDimension < min ||
    maxDimension > max
  ) {
    return null;
  }
  return normalizeDeviceStreamSettings(value, fallback);
}
