import { type Device, type NewDeviceOptions } from '@expo/hub-components';
import { describe, expect, test } from 'bun:test';

import {
  HIDE_UNSUPPORTED_DEVICES_STORAGE_KEY,
  persistHideUnsupportedDevicesDefault,
  readHideUnsupportedDevices,
  visibleDevices,
  visibleNewDeviceOptions,
} from '../deviceVisibility';

describe('unsupported device visibility flag', () => {
  test('defaults to true and persists the browser-visible default', () => {
    const storage = memoryStorage();

    expect(readHideUnsupportedDevices(storage)).toBe(true);
    persistHideUnsupportedDevicesDefault(storage);
    expect(storage.getItem(HIDE_UNSUPPORTED_DEVICES_STORAGE_KEY)).toBe('true');
  });

  test('accepts a false browser override without replacing it', () => {
    const storage = memoryStorage({ [HIDE_UNSUPPORTED_DEVICES_STORAGE_KEY]: 'false' });

    persistHideUnsupportedDevicesDefault(storage);
    expect(readHideUnsupportedDevices(storage)).toBe(false);
    expect(storage.getItem(HIDE_UNSUPPORTED_DEVICES_STORAGE_KEY)).toBe('false');
  });

  test('falls back to hiding devices for malformed or inaccessible storage', () => {
    expect(
      readHideUnsupportedDevices({
        getItem() {
          return 'not-a-boolean';
        },
      })
    ).toBe(true);
    expect(
      readHideUnsupportedDevices({
        getItem() {
          throw new Error('blocked');
        },
      })
    ).toBe(true);
  });
});

describe('device visibility policy', () => {
  const supported = device('supported', true);
  const unsupported = device('unsupported', false);

  test('filters untested recent devices when enabled', () => {
    expect(visibleDevices([supported, unsupported], true)).toEqual([supported]);
    expect(visibleDevices([supported, unsupported], false)).toEqual([supported, unsupported]);
  });

  test('filters model dropdowns and removes empty runtimes when enabled', () => {
    const options: NewDeviceOptions = {
      runtimes: [
        {
          value: 'current',
          label: 'Current OS',
          models: [
            { value: 'phone', label: 'Phone', supported: true, deviceFrame: 'iphone' },
            { value: 'tablet', label: 'Tablet', supported: false, deviceFrame: null },
          ],
        },
        {
          value: 'unsupported-only',
          label: 'Unsupported OS',
          models: [{ value: 'tv', label: 'TV', supported: false, deviceFrame: null }],
        },
      ],
    };

    expect(visibleNewDeviceOptions(options, true)).toEqual({
      runtimes: [
        {
          value: 'current',
          label: 'Current OS',
          models: [
            { value: 'phone', label: 'Phone', supported: true, deviceFrame: 'iphone' },
          ],
        },
      ],
    });
    expect(visibleNewDeviceOptions(options, false)).toBe(options);
  });
});

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

function device(id: string, supported: boolean): Device {
  return {
    id,
    name: id,
    version: 'OS 1.0',
    platform: 'ios',
    booted: false,
    physical: false,
    supported,
    deviceFrame: supported ? 'iphone' : null,
  };
}
