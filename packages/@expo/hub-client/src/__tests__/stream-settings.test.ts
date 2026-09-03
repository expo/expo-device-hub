import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_DEVICE_STREAM_SETTINGS,
  normalizeDeviceStreamSettings,
  sameDeviceStreamSettings,
} from '../stream-settings';

describe('device stream settings', () => {
  test('uses backend defaults for malformed input', () => {
    expect(normalizeDeviceStreamSettings(null)).toEqual(DEFAULT_DEVICE_STREAM_SETTINGS);
  });

  test('clamps every setting to the serve-sim runtime ranges', () => {
    expect(
      normalizeDeviceStreamSettings({
        mjpegFps: 999,
        mjpegQuality: 0,
        maxDimension: -1,
        h264Bitrate: 99,
        h264Fps: 3.6,
      }),
    ).toEqual({
      mjpegFps: 120,
      mjpegQuality: 0.05,
      maxDimension: 0,
      h264Bitrate: 100_000,
      h264Fps: 4,
    });
  });

  test('compares every normalized setting before publishing a refresh', () => {
    expect(
      sameDeviceStreamSettings(DEFAULT_DEVICE_STREAM_SETTINGS, {
        ...DEFAULT_DEVICE_STREAM_SETTINGS,
      }),
    ).toBe(true);
    expect(
      sameDeviceStreamSettings(DEFAULT_DEVICE_STREAM_SETTINGS, {
        ...DEFAULT_DEVICE_STREAM_SETTINGS,
        maxDimension: 720,
      }),
    ).toBe(false);
    expect(sameDeviceStreamSettings(null, DEFAULT_DEVICE_STREAM_SETTINGS)).toBe(false);
  });
});
