import { describe, expect, test } from 'bun:test';

import {
  ANDROID_DEVICE_SETTING_KEYS,
  ANDROID_POLLED_DEVICE_SETTING_KEYS,
  androidDeviceSettingRequest,
  androidDisplayWidthDpFromPayload,
  androidFontScaleForTextSize,
  androidTextSizeForFontScale,
  createAndroidDeviceSettingVersions,
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

  test('builds display-size payloads from the shared size steps', () => {
    expect(androidDeviceSettingRequest('display-size', 'small')).toEqual({
      path: '/api/display-density',
      body: { scale: 0.85 },
    });
    expect(androidDeviceSettingRequest('display-size', 'extra-large')).toEqual({
      path: '/api/display-density',
      body: { scale: 1.3 },
    });
    expect(androidDeviceSettingRequest('display-size', 'gigantic')).toBeNull();
  });

  test('snaps reported display densities onto the nearest step', () => {
    expect(
      parseAndroidDeviceSetting('display-size', { ok: true, displayDensity: { scale: 1 } }),
    ).toBe('medium');
    expect(
      parseAndroidDeviceSetting('display-size', { ok: true, displayDensity: { scale: 1.3 } }),
    ).toBe('extra-large');
    expect(
      parseAndroidDeviceSetting('display-size', { ok: true, displayDensity: { scale: 1.143 } }),
    ).toBe('large');
    expect(parseAndroidDeviceSetting('display-size', { ok: true })).toBeNull();
  });

  test('reads the smallest-width dp out of a display-density payload', () => {
    expect(
      androidDisplayWidthDpFromPayload({
        ok: true,
        displayDensity: { scale: 1, widthDp: 411, raw: 'Physical density: 420' },
      }),
    ).toBe(411);
  });

  test('reports no smallest-width dp when the payload cannot supply one', () => {
    expect(androidDisplayWidthDpFromPayload({ ok: true })).toBeNull();
    expect(androidDisplayWidthDpFromPayload({ ok: true, displayDensity: { scale: 1 } })).toBeNull();
    expect(
      androidDisplayWidthDpFromPayload({ ok: true, displayDensity: { widthDp: 0 } }),
    ).toBeNull();
    expect(
      androidDisplayWidthDpFromPayload({ ok: true, displayDensity: { widthDp: -411 } }),
    ).toBeNull();
    expect(
      androidDisplayWidthDpFromPayload({ ok: true, displayDensity: { widthDp: '411' } }),
    ).toBeNull();
    expect(androidDisplayWidthDpFromPayload('411')).toBeNull();
    expect(
      androidDisplayWidthDpFromPayload({ ok: false, displayDensity: { widthDp: 411 } }),
    ).toBeNull();
  });

  test('builds accessibility toggle payloads in both directions', () => {
    expect(androidDeviceSettingRequest('reduce-motion', 'on')).toEqual({
      path: '/api/reduce-motion',
      body: { enabled: true },
    });
    expect(androidDeviceSettingRequest('reduce-motion', 'off')).toEqual({
      path: '/api/reduce-motion',
      body: { enabled: false },
    });
    expect(androidDeviceSettingRequest('increase-contrast', 'on')).toEqual({
      path: '/api/high-text-contrast',
      body: { enabled: true },
    });
    expect(androidDeviceSettingRequest('increase-contrast', 'off')).toEqual({
      path: '/api/high-text-contrast',
      body: { enabled: false },
    });
    expect(androidDeviceSettingRequest('bold-text', 'on')).toEqual({
      path: '/api/font-weight',
      body: { enabled: true },
    });
    expect(androidDeviceSettingRequest('bold-text', 'off')).toEqual({
      path: '/api/font-weight',
      body: { enabled: false },
    });
    expect(androidDeviceSettingRequest('reduce-motion', 'unknown')).toBeNull();
    expect(androidDeviceSettingRequest('increase-contrast', 'unknown')).toBeNull();
    expect(androidDeviceSettingRequest('bold-text', 'unknown')).toBeNull();
  });

  test('normalizes accessibility responses into on/off', () => {
    expect(
      parseAndroidDeviceSetting('reduce-motion', { ok: true, reduceMotion: { enabled: true } }),
    ).toBe('on');
    expect(
      parseAndroidDeviceSetting('reduce-motion', { ok: true, reduceMotion: { enabled: false } }),
    ).toBe('off');
    expect(
      parseAndroidDeviceSetting('increase-contrast', {
        ok: true,
        highTextContrast: { enabled: true },
      }),
    ).toBe('on');
    expect(
      parseAndroidDeviceSetting('increase-contrast', {
        ok: true,
        highTextContrast: { enabled: false },
      }),
    ).toBe('off');
    expect(parseAndroidDeviceSetting('bold-text', { ok: true, fontWeight: { enabled: true } })).toBe(
      'on',
    );
    expect(
      parseAndroidDeviceSetting('bold-text', { ok: true, fontWeight: { enabled: false } }),
    ).toBe('off');
  });

  test('rejects accessibility responses it cannot read', () => {
    expect(parseAndroidDeviceSetting('reduce-motion', { ok: false })).toBeNull();
    expect(parseAndroidDeviceSetting('reduce-motion', { ok: true })).toBeNull();
    expect(
      parseAndroidDeviceSetting('reduce-motion', { ok: true, reduceMotion: 'on' }),
    ).toBeNull();
    expect(
      parseAndroidDeviceSetting('reduce-motion', { ok: true, reduceMotion: { enabled: 1 } }),
    ).toBeNull();
    expect(parseAndroidDeviceSetting('increase-contrast', { ok: false })).toBeNull();
    expect(parseAndroidDeviceSetting('increase-contrast', { ok: true })).toBeNull();
    expect(
      parseAndroidDeviceSetting('increase-contrast', { ok: true, highTextContrast: [] }),
    ).toBeNull();
    expect(
      parseAndroidDeviceSetting('increase-contrast', {
        ok: true,
        highTextContrast: { enabled: 'yes' },
      }),
    ).toBeNull();
    expect(parseAndroidDeviceSetting('bold-text', { ok: false })).toBeNull();
    expect(parseAndroidDeviceSetting('bold-text', { ok: true })).toBeNull();
    expect(parseAndroidDeviceSetting('bold-text', { ok: true, fontWeight: 300 })).toBeNull();
    expect(
      parseAndroidDeviceSetting('bold-text', { ok: true, fontWeight: { adjustment: 300 } }),
    ).toBeNull();
  });

  /** Only `network` has an unknown state; a copy-pasted decoder would regress here. */
  test('never reports unknown for the accessibility keys', () => {
    expect(
      parseAndroidDeviceSetting('reduce-motion', { ok: true, reduceMotion: { enabled: null } }),
    ).toBeNull();
    expect(
      parseAndroidDeviceSetting('increase-contrast', {
        ok: true,
        highTextContrast: { enabled: null },
      }),
    ).toBeNull();
    expect(
      parseAndroidDeviceSetting('bold-text', { ok: true, fontWeight: { enabled: null } }),
    ).toBeNull();
  });
});

describe('Android device setting table', () => {
  test('derives the full and polled key lists in table order', () => {
    expect(ANDROID_DEVICE_SETTING_KEYS).toEqual([
      'appearance',
      'network',
      'text-size',
      'display-size',
      'reduce-motion',
      'bold-text',
      'increase-contrast',
    ]);
    expect(ANDROID_POLLED_DEVICE_SETTING_KEYS).toEqual([
      'network',
      'text-size',
      'display-size',
      'reduce-motion',
      'bold-text',
      'increase-contrast',
    ]);
  });

  test('hands every device session its own zeroed poll versions', () => {
    const versions = createAndroidDeviceSettingVersions();
    expect(versions).toEqual({
      appearance: 0,
      network: 0,
      'text-size': 0,
      'display-size': 0,
      'reduce-motion': 0,
      'bold-text': 0,
      'increase-contrast': 0,
    });
    expect(createAndroidDeviceSettingVersions()).not.toBe(versions);
  });
});
