import { afterEach, describe, expect, test } from 'bun:test';

import { DEVICE_LIST_MESSAGE_TYPE, HEARTBEAT_MESSAGE_TYPE } from '../../device-list-protocol';
import {
  devicesWebSocketUrl,
  parseDeviceListMessage,
  parseDeviceListSocketMessage,
  splitDeviceList,
  subscribeToDeviceList,
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
      'ws://localhost:3400/hub/api/devices/ws',
    );
    expect(devicesWebSocketUrl('https://example.com/dashboard')).toBe(
      'wss://example.com/hub/api/devices/ws',
    );
  });

  test('accepts device-list messages and ignores other payloads', () => {
    expect(
      parseDeviceListMessage(JSON.stringify({ type: DEVICE_LIST_MESSAGE_TYPE, devices: list })),
    ).toEqual(list);
    expect(parseDeviceListMessage(JSON.stringify({ type: 'other', devices: list }))).toBeNull();
    expect(parseDeviceListMessage('not json')).toBeNull();
    expect(
      parseDeviceListMessage(
        JSON.stringify({
          type: DEVICE_LIST_MESSAGE_TYPE,
          devices: { ...list, errors: {} },
        }),
      ),
    ).toBeNull();
  });

  test('accepts heartbeat messages without treating them as device lists', () => {
    const heartbeat = JSON.stringify({ type: HEARTBEAT_MESSAGE_TYPE });
    expect(parseDeviceListSocketMessage(heartbeat)).toEqual({
      type: HEARTBEAT_MESSAGE_TYPE,
    });
    expect(parseDeviceListMessage(heartbeat)).toBeNull();
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
        JSON.stringify({
          type: DEVICE_LIST_MESSAGE_TYPE,
          devices: { ...list, errors },
        }),
      ),
    ).toEqual({ ...list, errors });
  });

  test('derives booted and recent devices from one snapshot', () => {
    expect(splitDeviceList(list)).toEqual({
      booted: { simulators: [list.simulators[0]], emulators: [] },
      recent: { simulators: [], emulators: [list.emulators[0]] },
    });
  });
});

class FakeSocket {
  closed = false;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  close(): void {
    this.closed = true;
  }

  message(data: unknown): void {
    this.onmessage?.({ data });
  }
}

function manualTimers() {
  let nextId = 1;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  return {
    schedule(callback: () => void, delay: number) {
      const id = nextId++;
      timers.set(id, { callback, delay });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    cancelSchedule(timer: ReturnType<typeof setTimeout>) {
      timers.delete(timer as unknown as number);
    },
    runDelay(delay: number) {
      const entry = [...timers.entries()].find(([, timer]) => timer.delay === delay);
      if (!entry) throw new Error(`No ${delay}ms timer scheduled`);
      timers.delete(entry[0]);
      entry[1].callback();
    },
  };
}

describe('device-list WebSocket subscription', () => {
  test('reports a closed server immediately after a live connection', () => {
    const timers = manualTimers();
    const socket = new FakeSocket();
    const statuses: string[] = [];
    const unsubscribe = subscribeToDeviceList({
      url: 'ws://localhost/devices',
      createSocket: () => socket,
      schedule: timers.schedule,
      cancelSchedule: timers.cancelSchedule,
      reconnectMinMs: 5,
      reconnectMaxMs: 20,
      heartbeatTimeoutMs: 60,
      onSnapshot: () => {},
      onStatus: (status) => statuses.push(status),
    });

    socket.message(JSON.stringify({ type: HEARTBEAT_MESSAGE_TYPE }));
    socket.onclose?.();

    expect(statuses).toEqual(['connecting', 'connected', 'disconnected']);
    unsubscribe();
  });

  test('times out when the server never sends a valid protocol message', () => {
    const timers = manualTimers();
    const socket = new FakeSocket();
    const statuses: string[] = [];
    const unsubscribe = subscribeToDeviceList({
      url: 'ws://localhost/devices',
      createSocket: () => socket,
      schedule: timers.schedule,
      cancelSchedule: timers.cancelSchedule,
      reconnectMinMs: 5,
      reconnectMaxMs: 20,
      heartbeatTimeoutMs: 60,
      onSnapshot: () => {},
      onStatus: (status) => statuses.push(status),
    });

    socket.message('not json');
    timers.runDelay(60);

    expect(socket.closed).toBe(true);
    expect(statuses).toEqual(['connecting', 'disconnected']);
    unsubscribe();
  });

  test('requires valid messages, detects a missed heartbeat, and reconnects', () => {
    const timers = manualTimers();
    const sockets: FakeSocket[] = [];
    const statuses: string[] = [];
    const snapshots: unknown[] = [];
    const unsubscribe = subscribeToDeviceList({
      url: 'ws://localhost/devices',
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      schedule: timers.schedule,
      cancelSchedule: timers.cancelSchedule,
      reconnectMinMs: 5,
      reconnectMaxMs: 20,
      heartbeatTimeoutMs: 60,
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      onStatus: (status) => statuses.push(status),
    });

    expect(statuses).toEqual(['connecting']);
    sockets[0].message('not json');
    expect(statuses).toEqual(['connecting']);

    sockets[0].message(JSON.stringify({ type: HEARTBEAT_MESSAGE_TYPE }));
    expect(statuses).toEqual(['connecting', 'connected']);

    timers.runDelay(60);
    expect(sockets[0].closed).toBe(true);
    expect(statuses).toEqual(['connecting', 'connected', 'disconnected']);

    timers.runDelay(5);
    expect(sockets).toHaveLength(2);
    sockets[1].message(JSON.stringify({ type: DEVICE_LIST_MESSAGE_TYPE, devices: list }));
    expect(statuses).toEqual(['connecting', 'connected', 'disconnected', 'connected']);
    expect(snapshots).toEqual([list]);

    unsubscribe();
    expect(sockets[1].closed).toBe(true);
  });

  test('marks connection failures as disconnected and retries with backoff', () => {
    const timers = manualTimers();
    let attempts = 0;
    const statuses: string[] = [];
    const unsubscribe = subscribeToDeviceList({
      url: 'ws://localhost/devices',
      createSocket: () => {
        attempts++;
        throw new Error('server unavailable');
      },
      schedule: timers.schedule,
      cancelSchedule: timers.cancelSchedule,
      reconnectMinMs: 5,
      reconnectMaxMs: 20,
      heartbeatTimeoutMs: 60,
      onSnapshot: () => {},
      onStatus: (status) => statuses.push(status),
    });

    expect(attempts).toBe(1);
    expect(statuses).toEqual(['connecting', 'disconnected']);
    timers.runDelay(5);
    timers.runDelay(10);
    expect(attempts).toBe(3);
    expect(statuses).toEqual(['connecting', 'disconnected']);

    unsubscribe();
  });
});
