import { afterEach, describe, expect, test } from 'bun:test';

import { createDashboardStore } from '../dashboardStore';

afterEach(() => {
  delete (globalThis as any).window;
});

describe('dashboard store', () => {
  test('falls back to MJPEG when the selected stream mode is unavailable', () => {
    const store = createDashboardStore({ streamMode: 'webrtc' });

    store.getState().chooseStreamMode('webrtc', { mjpeg: true, h264: false, webrtc: false });

    expect(store.getState().streamMode).toBe('mjpeg');
  });

  test('shows supported device frames by default and keeps the viewer toggle', () => {
    const store = createDashboardStore();

    expect(store.getState().showDeviceFrame).toBe(true);
    store.getState().setShowDeviceFrame(false);
    expect(store.getState().showDeviceFrame).toBe(false);
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

  test('uses the standalone shell preference for the initial left sidebar state', () => {
    (globalThis as any).window = { __EXPO_DEVICE_HUB_HIDE_SIDEBAR__: true };

    const store = createDashboardStore();

    expect(store.getState().sidebarPreferences).toEqual({ left: 'hidden', right: 'auto' });
  });
});
