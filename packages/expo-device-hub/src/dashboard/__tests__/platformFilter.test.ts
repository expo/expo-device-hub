import { afterEach, describe, expect, test } from 'bun:test';

import { dashboardPlatformFilter, parsePlatformFilter } from '../../platform-filter';

afterEach(() => {
  delete (globalThis as any).window;
});

describe('parsePlatformFilter', () => {
  test('accepts only iOS and Android', () => {
    expect(parsePlatformFilter('ios')).toBe('ios');
    expect(parsePlatformFilter('android')).toBe('android');
    expect(parsePlatformFilter('web')).toBeUndefined();
    expect(parsePlatformFilter(undefined)).toBeUndefined();
  });
});

describe('dashboardPlatformFilter', () => {
  test('reads the platform provided by the standalone shell', () => {
    (globalThis as any).window = { __EXPO_DEVICE_HUB_PLATFORM__: 'ios' };
    expect(dashboardPlatformFilter()).toBe('ios');
  });

  test('returns undefined when the shell provides no platform', () => {
    expect(dashboardPlatformFilter()).toBeUndefined();
  });
});
