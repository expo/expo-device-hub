import { describe, expect, test } from 'bun:test';

import {
  androidDeviceSettingRequest,
  androidFontScaleForTextSize,
  androidTextSizeForFontScale,
  parseAndroidDeviceSetting,
} from '../android-device-settings';

describe('Android font-size mapping', () => {
  test('maps the S–XL UI values onto serve-emu numeric scales', () => {
    expect(androidFontScaleForTextSize('small')).toBe(0.85);
    expect(androidFontScaleForTextSize('medium')).toBe(1);
    expect(androidFontScaleForTextSize('large')).toBe(1.15);
    expect(androidFontScaleForTextSize('extra-large')).toBe(1.3);
    expect(androidFontScaleForTextSize('extra-extra-large')).toBeNull();
  });

  test('maps exact and externally-set scales onto the nearest visible option', () => {
    expect(androidTextSizeForFontScale(0.85)).toBe('small');
    expect(androidTextSizeForFontScale('1')).toBe('medium');
    expect(androidTextSizeForFontScale(1.13)).toBe('large');
    expect(androidTextSizeForFontScale(1.5)).toBe('extra-large');
    expect(androidTextSizeForFontScale('not-a-number')).toBeNull();
  });
});

describe('Android device setting contract', () => {
  test('builds device-scoped serve-emu request payloads', () => {
    expect(androidDeviceSettingRequest('appearance', 'dark')).toEqual({
      path: '/api/uimode',
      body: { night: 'yes' },
    });
    expect(androidDeviceSettingRequest('network', 'off')).toEqual({
      path: '/api/network',
      body: { enabled: false },
    });
    expect(androidDeviceSettingRequest('text-size', 'extra-large')).toEqual({
      path: '/api/font-scale',
      body: { scale: 1.3 },
    });
    expect(androidDeviceSettingRequest('voiceover', 'on')).toBeNull();
  });

  test('normalizes authoritative responses into shared Hub values', () => {
    expect(parseAndroidDeviceSetting('appearance', { ok: true, night: 'yes' })).toBe('dark');
    expect(parseAndroidDeviceSetting('network', { ok: true, network: { enabled: false } })).toBe(
      'off',
    );
    expect(
      parseAndroidDeviceSetting('text-size', { ok: true, fontScale: { scale: 1.15 } }),
    ).toBe('large');
    expect(parseAndroidDeviceSetting('network', { ok: true, network: { enabled: null } })).toBe(
      'unknown',
    );
    expect(parseAndroidDeviceSetting('text-size', { ok: false })).toBeNull();
  });
});
