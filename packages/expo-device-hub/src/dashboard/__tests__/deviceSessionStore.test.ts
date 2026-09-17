import { describe, expect, test } from 'bun:test';
import { type Device } from '@expo/hub-components';

import { createDeviceSessionStore } from '../deviceSessionStore';
import { reconcileDeviceList, splitDeviceList, type DeviceList } from '../useDevices';

const iphone: Device = {
  id: 'F20A59AF-5BD8-492F-A613-E2DBA76D4DDD',
  name: 'iPhone',
  version: 'iOS 27',
  platform: 'ios',
  booted: true,
  physical: false,
  supported: true,
  deviceFrame: 'ios:iphone-17-pro',
};
const pixel: Device = {
  ...iphone,
  id: 'emulator-5554',
  name: 'Pixel',
  version: 'Android 17',
  platform: 'android',
  deviceFrame: 'android:pixel-10-pro',
};
const empty: DeviceList = { simulators: [], emulators: [] };

describe('device selection from discovery and the URL', () => {
  test('retains a missing selected device until navigating to another device', () => {
    const store = createDeviceSessionStore();
    store.getState().update({
      booted: { simulators: [iphone], emulators: [pixel] },
      recent: empty,
      selectedId: iphone.id,
    });
    store.getState().update({
      booted: { simulators: [], emulators: [pixel] },
      recent: empty,
      selectedId: iphone.id,
    });
    expect(store.getState().selectedDevice).toBe(iphone);
    expect(store.getState().selectedAvailable).toBe(false);
    expect(store.getState().simulators).toEqual([iphone]);

    store.getState().update({
      booted: { simulators: [], emulators: [pixel] },
      recent: empty,
      selectedId: pixel.id,
    });
    expect(store.getState().selectedDevice).toBe(pixel);
    expect(store.getState().selectedAvailable).toBe(true);
    expect(store.getState().simulators).toEqual([]);
  });

  test('stays on the requested ID before discovery and reconnects when it returns', () => {
    const store = createDeviceSessionStore();
    store.getState().update({
      booted: { simulators: [iphone], emulators: [] },
      recent: empty,
      selectedId: pixel.id,
    });
    expect(store.getState().selectedDevice?.id).toBe(pixel.id);
    expect(store.getState().selectedAvailable).toBe(false);
    store.getState().update({
      booted: { simulators: [iphone], emulators: [pixel] },
      recent: empty,
      selectedId: pixel.id,
    });
    expect(store.getState().selectedDevice).toBe(pixel);
    expect(store.getState().selectedAvailable).toBe(true);
    expect(store.getState().emulators).toEqual([pixel]);
  });

  test('uses known metadata for an offline deep link and for devices that shut down', () => {
    const store = createDeviceSessionStore();
    const stopped = { ...iphone, booted: false };
    store.getState().update({
      booted: empty,
      recent: { simulators: [stopped], emulators: [] },
      selectedId: iphone.id,
    });
    expect(store.getState().selectedDevice).toBe(stopped);
    expect(store.getState().selectedAvailable).toBe(false);
    expect(store.getState().simulators).toEqual([stopped]);
  });

  test('unrelated add, update and remove snapshots leave viewer selector values untouched', () => {
    const store = createDeviceSessionStore();
    let snapshot = { simulators: [iphone], emulators: [pixel] };
    let lists = splitDeviceList(snapshot);
    store.getState().update({ ...lists, selectedId: iphone.id });
    let viewerChanges = 0;
    let iosListChanges = 0;
    const unsubscribe = store.subscribe((next, previous) => {
      if (
        next.selectedDevice !== previous.selectedDevice ||
        next.selectedAvailable !== previous.selectedAvailable ||
        next.connectionStatus !== previous.connectionStatus
      )
        viewerChanges++;
      if (next.simulators !== previous.simulators) iosListChanges++;
    });
    for (const emulators of [
      [{ ...pixel, name: 'Renamed Pixel' }],
      [pixel, { ...pixel, id: 'emulator-5556' }],
      [],
    ]) {
      snapshot = reconcileDeviceList(
        snapshot,
        JSON.parse(JSON.stringify({ simulators: [iphone], emulators }))
      );
      lists = splitDeviceList(snapshot, lists);
      store.getState().update({ ...lists, selectedId: iphone.id });
    }
    expect(viewerChanges).toBe(0);
    expect(iosListChanges).toBe(0);
    expect(store.getState().emulators).toEqual([]);
    unsubscribe();
  });
});
