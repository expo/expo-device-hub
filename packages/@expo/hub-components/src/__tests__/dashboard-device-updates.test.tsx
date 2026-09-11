import '../../../../expo-device-hub/types.d.ts';

import { expect, spyOn, test } from 'bun:test';
import * as hubClient from '@expo/hub-client';
import { act, type ReactPortal } from 'react';
import * as ReactDOM from 'react-dom';
import { create, type ReactTestRenderer } from 'react-test-renderer';

import Dashboard from '../../../../expo-device-hub/src/Dashboard';
import { DEVICE_LIST_MESSAGE_TYPE } from '../../../../expo-device-hub/src/device-list-protocol';
import { useDashboardStore } from '../../../../expo-device-hub/src/dashboard/dashboardStore';
import { useDeviceSessionStore } from '../../../../expo-device-hub/src/dashboard/deviceSessionStore';
import { type DeviceList } from '../../../../expo-device-hub/src/dashboard/useDevices';
import { NOOP_DEVICE_CLIENT } from '../../../hub-client/src/useNoopDeviceClient';
import { type Device } from '../dashboard/data';

const IPHONE: Device = {
  id: 'A671E25C-3A15-4738-8B49-8FACD3AE5ACD',
  name: 'Opened iPhone',
  version: 'iOS 27.0',
  platform: 'ios',
  booted: true,
  physical: false,
  supported: true,
  deviceFrame: 'ios:iphone-17-pro',
};

class FakeWebSocket {
  static sockets: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.sockets.push(this);
  }

  close() {}

  snapshot(devices: DeviceList) {
    this.onmessage?.({ data: JSON.stringify({ type: DEVICE_LIST_MESSAGE_TYPE, devices }) });
  }
}

function browserEnvironment(path: string) {
  const events = new EventTarget();
  let location = new URL(path, 'http://localhost:8081');
  const browser = {
    __EXPO_DEVICE_HUB_BASE_PATH__: '',
    innerWidth: 1440,
    isSecureContext: true,
    localStorage: { getItem: () => null, setItem: () => {} },
    get location() {
      return location;
    },
    history: {
      state: null,
      pushState(_state: unknown, _unused: string, url: string) {
        location = new URL(url, location);
      },
      replaceState(_state: unknown, _unused: string, url: string) {
        location = new URL(url, location);
      },
    },
    matchMedia: (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      addEventListener() {},
      removeEventListener() {},
    }),
    setTimeout,
    clearTimeout,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
  };
  const replacements = {
    window: browser,
    document: {
      body: {},
      documentElement: { classList: { toggle() {}, remove() {} } },
    },
    WebSocket: FakeWebSocket,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const descriptors = new Map(
    Object.keys(replacements).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
  );
  for (const [key, value] of Object.entries(replacements)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  return {
    browser,
    restore() {
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test('dashboard isolates device-list updates and retains the selected offline frame', async () => {
  const environment = browserEnvironment(`/device/${IPHONE.id}`);
  const previousSession = useDeviceSessionStore.getState();
  const previousDashboard = useDashboardStore.getState();
  useDeviceSessionStore.setState(useDeviceSessionStore.getInitialState(), true);
  useDashboardStore.setState(useDashboardStore.getInitialState(), true);
  FakeWebSocket.sockets = [];

  // Count the actual DashboardLayout render through its viewer hook. The fake
  // client avoids opening device transports while discovery and UI stay real.
  const connectedClient = {
    ...NOOP_DEVICE_CLIENT,
    screen: { width: 2400, height: 1080, orientation: 'landscape_right' as const },
  };
  const viewer = spyOn(hubClient, 'useActiveDeviceClient').mockImplementation((target) =>
    target ? connectedClient : NOOP_DEVICE_CLIENT
  );
  const portal = spyOn(ReactDOM, 'createPortal').mockImplementation(
    (children) => children as ReactPortal
  );
  const fetchOptions = spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({ ios: { runtimes: [] }, android: { runtimes: [] } })
  );
  let renderer: ReactTestRenderer | undefined;

  const row = (name: string) =>
    renderer!.root.find(
      (element) =>
        element.type === 'button' && String(element.props['aria-label']).startsWith(`${name}, `)
    );
  const frame = () => renderer!.root.findByProps({ 'data-testid': 'device-screen-frame' });
  const emit = async (devices: DeviceList) => {
    const socket = FakeWebSocket.sockets.find((socket) => socket.url.endsWith('/api/devices/ws'));
    expect(socket).toBeDefined();
    await act(() => socket!.snapshot(devices));
  };

  try {
    await act(async () => {
      renderer = create(<Dashboard />);
    });
    const other: Device = { ...IPHONE, id: 'other-ios', name: 'Other iPhone' };
    await emit({ simulators: [IPHONE, other], emulators: [] });
    expect(row(IPHONE.name).props['aria-pressed']).toBe(true);
    expect(environment.browser.location.pathname).toBe(`/device/${IPHONE.id}`);
    const initialRenders = viewer.mock.calls.length;
    const openedFrame = frame();
    const frameStyle = openedFrame.props.style;
    const deviceOptions = renderer!.root.findByProps({ 'aria-label': 'Device options' });
    const optionCount = deviceOptions.findAllByType('button').length;

    await emit({ simulators: structuredClone([IPHONE, other]), emulators: [] });
    expect(viewer.mock.calls.length).toBe(initialRenders);

    const renamed = { ...other, name: 'Renamed iPhone' };
    await emit({ simulators: structuredClone([IPHONE, renamed]), emulators: [] });
    expect(row('Renamed iPhone')).toBeDefined();
    expect(viewer.mock.calls.length).toBe(initialRenders);

    const android: Device = {
      ...IPHONE,
      id: '192.168.1.10:5555',
      name: 'Pixel',
      platform: 'android',
      version: 'Android 17.0',
      deviceFrame: 'android:pixel-10-pro',
    };
    await emit({ simulators: structuredClone([IPHONE, renamed]), emulators: [android] });
    expect(row('Pixel')).toBeDefined();
    expect(viewer.mock.calls.length).toBe(initialRenders);
    await emit({ simulators: [{ ...IPHONE }], emulators: [{ ...android }] });
    expect(viewer.mock.calls.length).toBe(initialRenders);
    expect(frame()).toBe(openedFrame);

    await emit({ simulators: [], emulators: [{ ...android }] });
    expect(environment.browser.location.pathname).toBe(`/device/${IPHONE.id}`);
    expect(row(IPHONE.name).props['aria-label']).toContain('Offline');
    expect(
      renderer!.root.findByProps({ 'data-testid': 'device-unavailable-screen' })
    ).toBeDefined();
    expect(frame()).toBe(openedFrame);
    expect(frame().props.style).toEqual(frameStyle);
    expect(renderer!.root.findByProps({ 'aria-label': 'Device options' })).toBe(deviceOptions);
    expect(deviceOptions.findAllByType('button')).toHaveLength(optionCount);
    expect(viewer.mock.calls.at(-1)?.[0]).toBeNull();

    await act(() => row('Pixel').props.onClick());
    expect(environment.browser.location.pathname).toBe('/device/192.168.1.10%3A5555');
    expect(row('Pixel').props['aria-pressed']).toBe(true);
    expect(
      renderer!.root.findAll(
        (element) =>
          element.type === 'button' &&
          String(element.props['aria-label']).startsWith(`${IPHONE.name}, `)
      )
    ).toHaveLength(0);
    expect(
      renderer!.root.findAllByProps({ 'data-testid': 'device-unavailable-screen' })
    ).toHaveLength(0);
    expect(viewer.mock.calls.at(-1)?.[0]).toMatchObject({
      platform: 'android',
      device: android.id,
    });
  } finally {
    await act(() => renderer?.unmount());
    viewer.mockRestore();
    portal.mockRestore();
    fetchOptions.mockRestore();
    useDeviceSessionStore.setState(previousSession, true);
    useDashboardStore.setState(previousDashboard, true);
    environment.restore();
  }
});
