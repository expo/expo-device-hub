import { describe, expect, test } from 'bun:test';
import {
  DEVICE_SCREEN_STATUS_LAYOUT_STYLE,
  DEVICE_SCREEN_SURFACE_LAYOUT_STYLE,
  deviceScreenMediaStyle,
  deviceScreenPresentsMedia,
  deviceScreenSurfaceStyle,
} from '../DeviceScreen';

describe('DeviceScreen layout', () => {
  for (const rotation of [-90, 90]) {
    test(`keeps ${rotation}-degree media synchronized with its responsive surface`, () => {
      const mediaStyle = deviceScreenMediaStyle(rotation);

      expect(DEVICE_SCREEN_SURFACE_LAYOUT_STYLE.containerType).toBe('size');
      expect(mediaStyle.width).toBe('100cqh');
      expect(mediaStyle.height).toBe('100cqw');
      expect(mediaStyle.width).not.toMatch(/px$/);
      expect(mediaStyle.height).not.toMatch(/px$/);
    });
  }

  test('keeps connection status layers inside the shared screen surface', () => {
    expect(DEVICE_SCREEN_SURFACE_LAYOUT_STYLE.position).toBe('absolute');
    expect(DEVICE_SCREEN_SURFACE_LAYOUT_STYLE.inset).toBe(0);
    expect(DEVICE_SCREEN_STATUS_LAYOUT_STYLE.position).toBe('absolute');
    expect(DEVICE_SCREEN_STATUS_LAYOUT_STYLE.inset).toBe(0);
    expect(DEVICE_SCREEN_STATUS_LAYOUT_STYLE.boxSizing).toBe('border-box');
  });

  test('leaves only the live stream surface background transparent', () => {
    expect(deviceScreenSurfaceStyle('streaming').backgroundColor).toBeUndefined();
    expect(deviceScreenSurfaceStyle('connecting').backgroundColor).toBe('#000');
    expect(deviceScreenSurfaceStyle('error').backgroundColor).toBe('#000');
  });

  test('keeps the last frame uncovered while a live stream reconnects', () => {
    // A capture-source switch or a short socket drop must not flash black or
    // cover the previous frame with a status message.
    expect(deviceScreenSurfaceStyle('reconnecting').backgroundColor).toBeUndefined();
    expect(deviceScreenPresentsMedia('reconnecting')).toBe(true);
    expect(deviceScreenPresentsMedia('streaming')).toBe(true);
    expect(deviceScreenPresentsMedia('connecting')).toBe(false);
    expect(deviceScreenPresentsMedia('error')).toBe(false);
    expect(deviceScreenPresentsMedia('idle')).toBe(false);
  });
});
