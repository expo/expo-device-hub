import { afterEach, describe, expect, test } from 'bun:test';

import { DEVICE_LIST_MESSAGE_TYPE } from '../../device-list-protocol';
import {
  devicesWebSocketUrl,
  parseDeviceListMessage,
  splitDeviceList,
  type DeviceList,
} from '../useDevices';

const list: DeviceList = {
  simulators: [
    {
      id: 'booted-ios',
      name: 'iPhone',
      version: 'iOS 27.0',
      platform: 'ios',
      booted: true,
      physical: false,
      supported: true,
      deviceFrame: 'iphone',
    },
  ],
  emulators: [
    {
      id: 'idle-android',
      name: 'Pixel',
      version: 'Android 17.0',
      platform: 'android',
      booted: false,
      physical: false,
      supported: true,
      deviceFrame: 'pixel',
    },
  ],
};

afterEach(() => {
  delete (globalThis as any).window;
});

describe('device-list WebSocket client helpers', () => {
  test('builds ws and wss URLs under the configured mount', () => {
    (globalThis as any).window = { __EXPO_DEVICE_HUB_BASE_PATH__: '/hub/' };
    expect(devicesWebSocketUrl('http://localhost:3400/dashboard')).toBe(
      'ws://localhost:3400/hub/api/devices/ws'
    );
    expect(devicesWebSocketUrl('https://example.com/dashboard')).toBe(
      'wss://example.com/hub/api/devices/ws'
    );
  });

  test('accepts device-list messages and ignores other payloads', () => {
    expect(
      parseDeviceListMessage(JSON.stringify({ type: DEVICE_LIST_MESSAGE_TYPE, devices: list }))
    ).toEqual(list);
    expect(parseDeviceListMessage(JSON.stringify({ type: 'other', devices: list }))).toBeNull();
    expect(parseDeviceListMessage('not json')).toBeNull();
    expect(
      parseDeviceListMessage(
        JSON.stringify({ type: DEVICE_LIST_MESSAGE_TYPE, devices: { ...list, errors: {} } })
      )
    ).toBeNull();
  });

  test('preserves captured utility errors for the browser console', () => {
    const errors = [
      {
        id: 'Error:spawn avdmanager ENOENT',
        message: '[android-utils] Failed to run `avdmanager list avd`:',
        error: 'Error: spawn avdmanager ENOENT',
      },
    ];

    expect(
      parseDeviceListMessage(
        JSON.stringify({ type: DEVICE_LIST_MESSAGE_TYPE, devices: { ...list, errors } })
      )
    ).toEqual({ ...list, errors });
  });

  test('derives booted and recent devices from one snapshot', () => {
    expect(splitDeviceList(list)).toEqual({
      booted: { simulators: [list.simulators[0]], emulators: [] },
      recent: { simulators: [], emulators: [list.emulators[0]] },
    });
  });
});
