import { describe, expect, test } from 'bun:test';

import { type Device } from '@expo/hub-components';

import { createDashboardStore } from '../dashboardStore';

const iosDevice: Device = {
  id: 'ios-new',
  name: 'iPhone 17',
  version: 'iOS 27',
  platform: 'ios',
  booted: true,
  physical: false,
  supported: true,
};

describe('dashboard store', () => {
  test('tracks a replacement device and selects it', () => {
    const store = createDashboardStore({
      addedDevices: [
        { ...iosDevice, id: 'old-id' },
        { ...iosDevice, id: 'keep-id' },
      ],
    });

    store.getState().trackAddedDevice(iosDevice, ['old-id', iosDevice.name]);

    expect(store.getState().addedDevices.map((device) => device.id)).toEqual([
      'keep-id',
      'ios-new',
    ]);
    expect(store.getState().selectedDeviceId).toBe('ios-new');
  });

  test('keeps a valid selection and falls back when it disappears', () => {
    const store = createDashboardStore({ selectedDeviceId: 'second' });

    store.getState().reconcileSelectedDevice(['first', 'second']);
    expect(store.getState().selectedDeviceId).toBe('second');

    store.getState().reconcileSelectedDevice(['first']);
    expect(store.getState().selectedDeviceId).toBe('first');
  });

  test('dismisses an optimistic device without clearing another selection', () => {
    const store = createDashboardStore({
      addedDevices: [iosDevice],
      selectedDeviceId: 'another-device',
    });

    store.getState().dismissDevice(iosDevice.id);

    expect(store.getState().addedDevices).toEqual([]);
    expect(store.getState().selectedDeviceId).toBe('another-device');
  });

  test('falls back to MJPEG when the selected stream mode is unavailable', () => {
    const store = createDashboardStore({ streamMode: 'webrtc' });

    store.getState().chooseStreamMode('webrtc', { mjpeg: true, h264: false, webrtc: false });

    expect(store.getState().streamMode).toBe('mjpeg');
  });

  test('owns sidebar sizing and explicit open/close intent', () => {
    const store = createDashboardStore();

    store.getState().resizeSidebar('left', 480);
    store.getState().openSidebar('left', false);
    expect(store.getState()).toMatchObject({
      sidebarWidths: { left: 480, right: 400 },
      sidebarPreferences: { left: 'open', right: 'auto' },
      lastOpenedSidebar: 'left',
    });

    store.getState().closeSidebar('left');
    expect(store.getState().sidebarPreferences.left).toBe('hidden');
  });
});
