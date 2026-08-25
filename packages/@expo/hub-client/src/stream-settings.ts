import { type DeviceStreamEncoderSettings } from './types';

export const DEFAULT_DEVICE_STREAM_SETTINGS: DeviceStreamEncoderSettings = {
  mjpegFps: 60,
  mjpegQuality: 0.7,
  maxDimension: 0,
  h264Bitrate: 6_000_000,
  h264Fps: 60,
};

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function numberInRange(value: unknown, fallback: number, min: number, max: number): number {
  const number = finiteNumber(value);
  return number === null ? fallback : Math.min(max, Math.max(min, number));
}

function integerInRange(value: unknown, fallback: number, min: number, max: number): number {
  return Math.round(numberInRange(value, fallback, min, max));
}

/** Normalize the untrusted GET/PATCH response using serve-sim's documented ranges. */
export function normalizeDeviceStreamSettings(
  value: unknown,
  fallback: DeviceStreamEncoderSettings = DEFAULT_DEVICE_STREAM_SETTINGS,
): DeviceStreamEncoderSettings {
  const settings =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    mjpegFps: integerInRange(settings.mjpegFps, fallback.mjpegFps, 1, 120),
    mjpegQuality: numberInRange(settings.mjpegQuality, fallback.mjpegQuality, 0.05, 1),
    maxDimension: integerInRange(settings.maxDimension, fallback.maxDimension, 0, 4096),
    h264Bitrate: integerInRange(settings.h264Bitrate, fallback.h264Bitrate, 100_000, 50_000_000),
    h264Fps: integerInRange(settings.h264Fps, fallback.h264Fps, 1, 120),
  };
}
