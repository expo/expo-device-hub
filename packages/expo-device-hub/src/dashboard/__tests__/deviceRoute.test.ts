import { afterEach, describe, expect, test } from 'bun:test';

import {
  readDeviceRoute,
  selectDeviceRoute,
  selectedDeviceRoute,
  subscribeToDeviceRoute,
} from '../deviceRoute';

const PLUGIN_MOUNT = '/_expo/plugins/expo-device-hub';

function stubBrowser(
  path: string,
  options: { mountPath?: string; dev?: boolean } = { mountPath: '' }
) {
  const events = new EventTarget();
  const entries = [new URL(path, 'http://localhost:8081')];
  let index = 0;
  const browser = {
    __DEV__: options.dev,
    __EXPO_DEVICE_HUB_BASE_PATH__: options.mountPath,
    get location() {
      return entries[index];
    },
    history: {
      state: { preserved: true },
      get length() {
        return entries.length;
      },
      pushState(_state: unknown, _unused: string, url: string) {
        entries.splice(index + 1, entries.length, new URL(url, entries[index]));
        index++;
      },
      replaceState(_state: unknown, _unused: string, url: string) {
        entries[index] = new URL(url, entries[index]);
      },
      back() {
        if (index === 0) return;
        index--;
        events.dispatchEvent(new Event('popstate'));
      },
      forward() {
        if (index === entries.length - 1) return;
        index++;
        events.dispatchEvent(new Event('popstate'));
      },
    },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
  };
  (globalThis as any).window = browser;
  return browser;
}

afterEach(() => {
  delete (globalThis as any).window;
});

describe('device route', () => {
  test('reads iOS UDIDs and Android serials, including escaped characters', () => {
    expect(readDeviceRoute('/device/A05B3DB4-425C-40EC-96F1-5F05AD5FB660')).toBe(
      'A05B3DB4-425C-40EC-96F1-5F05AD5FB660'
    );
    expect(readDeviceRoute('/device/emulator-5554')).toBe('emulator-5554');
    expect(readDeviceRoute('/device/192.168.1.10%3A5555')).toBe('192.168.1.10:5555');
    expect(readDeviceRoute('/device/serial%2Fwith%20spaces%25/')).toBe('serial/with spaces%');
  });

  test('matches only device routes beneath the exact mount', () => {
    expect(readDeviceRoute(`${PLUGIN_MOUNT}/device/ios-id`, `${PLUGIN_MOUNT}/`)).toBe('ios-id');
    expect(readDeviceRoute('/device/ios-id', PLUGIN_MOUNT)).toBe('');
    expect(readDeviceRoute('/hub-other/device/ios-id', '/hub')).toBe('');
    for (const path of ['/', '/index.html', '/device/', '/device/ios-id/extra', '/device/%bad']) {
      expect(readDeviceRoute(path)).toBe('');
    }
  });

  test('initializes from a deep link before devices arrive', () => {
    stubBrowser(`${PLUGIN_MOUNT}/device/offline-ios-id`, { mountPath: PLUGIN_MOUNT });
    expect(selectedDeviceRoute()).toBe('offline-ios-id');
  });

  test('updates selection immediately and follows browser back and forward', () => {
    const browser = stubBrowser('/?transport=h264#details');
    const selections: string[] = [];
    const unsubscribe = subscribeToDeviceRoute(() => selections.push(selectedDeviceRoute()));

    selectDeviceRoute('ios-id', { replace: true });
    expect(browser.history.length).toBe(1);
    selectDeviceRoute('192.168.1.10:5555');
    expect(browser.location.pathname).toBe('/device/192.168.1.10%3A5555');
    expect(browser.location.search).toBe('?transport=h264');
    expect(browser.location.hash).toBe('#details');
    expect(browser.history.length).toBe(2);
    selectDeviceRoute('192.168.1.10:5555');
    expect(browser.history.length).toBe(2);
    browser.history.back();
    browser.history.forward();

    expect(selections).toEqual(['ios-id', '192.168.1.10:5555', 'ios-id', '192.168.1.10:5555']);
    unsubscribe();
    browser.history.back();
    expect(selections).toHaveLength(4);
  });

  test('keeps selection and deselection inside the mounted dashboard', () => {
    const browser = stubBrowser(`${PLUGIN_MOUNT}/`, { mountPath: `${PLUGIN_MOUNT}/` });
    selectDeviceRoute('emulator-5554');
    expect(browser.location.pathname).toBe(`${PLUGIN_MOUNT}/device/emulator-5554`);
    expect(selectedDeviceRoute()).toBe('emulator-5554');
    selectDeviceRoute('');
    expect(browser.location.pathname).toBe(`${PLUGIN_MOUNT}/`);
    expect(selectedDeviceRoute()).toBe('');
  });

  test('navigates the Metro web app at the root while its API uses the plugin mount', () => {
    const browser = stubBrowser('/', { dev: true });
    selectDeviceRoute('ios-id');
    expect(browser.location.pathname).toBe('/device/ios-id');
    expect(selectedDeviceRoute()).toBe('ios-id');
  });

  test('uses an explicit shell mount even when development is enabled', () => {
    const browser = stubBrowser('/hub/', { dev: true, mountPath: '/hub' });
    selectDeviceRoute('ios-id');
    expect(browser.location.pathname).toBe('/hub/device/ios-id');
  });
});
