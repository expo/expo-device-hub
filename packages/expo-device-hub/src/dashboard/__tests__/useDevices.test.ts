import { afterEach, describe, expect, test } from 'bun:test';

import { DEVICE_LIST_MESSAGE_TYPE, HEARTBEAT_MESSAGE_TYPE } from '../../device-list-protocol';
import {
  devicesWebSocketUrl,
  parseDeviceListMessage,
  parseDeviceListSocketMessage,
  reconcileDeviceList,
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
      supported: true,
      deviceFrame: 'ios:iphone-17-pro',
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
      deviceFrame: 'android:pixel-10-pro',
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
        JSON.stringify({
          type: DEVICE_LIST_MESSAGE_TYPE,
          devices: { ...list, errors: {} },
        })
      )
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
        })
      )
    ).toEqual({ ...list, errors });
  });

  test('derives booted and recent devices from one snapshot', () => {
    expect(splitDeviceList(list)).toEqual({
      booted: { simulators: [list.simulators[0]], emulators: [] },
      recent: { simulators: [], emulators: [list.emulators[0]] },
    });
  });

  test('retains the running lists when only a recent device changes', () => {
    const previous = splitDeviceList(list);
    const next = splitDeviceList(
      {
        ...list,
        emulators: [{ ...list.emulators[0], name: 'Renamed Pixel' }],
      },
      previous
    );

    expect(next.booted).toBe(previous.booted);
    expect(next.recent.simulators).toBe(previous.recent.simulators);
    expect(next.recent.emulators[0].name).toBe('Renamed Pixel');
  });

  test('retains every reference for identical JSON snapshots and utility-error changes', () => {
    const snapshot = {
      ...structuredClone(list),
      errors: [{ id: 'discovery-error', message: 'Discovery failed', error: 'Error: unavailable' }],
    };

    expect(reconcileDeviceList(list, snapshot)).toBe(list);
    const previous = splitDeviceList(list);
    expect(splitDeviceList(structuredClone(list), previous)).toBe(previous);
  });

  test('updates only changed devices while retaining the other platform and siblings', () => {
    const previous: DeviceList = {
      ...list,
      simulators: [...list.simulators, { ...list.simulators[0], id: 'second-ios' }],
    };
    const snapshot = structuredClone(previous);
    snapshot.simulators[1].name = 'Renamed iPhone';
    snapshot.simulators[1].lastUsedAt = 1_000;
    const next = reconcileDeviceList(previous, snapshot);

    expect(next.simulators[0]).toBe(previous.simulators[0]);
    expect(next.simulators[1]).toEqual(snapshot.simulators[1]);
    expect(next.simulators[1]).not.toBe(previous.simulators[1]);
    expect(next.emulators).toBe(previous.emulators);
  });

  test('keeps device identities through additions, removals, and reordered snapshots', () => {
    const second = { ...list.simulators[0], id: 'second-ios' };
    const third = { ...list.simulators[0], id: 'third-ios' };
    const added = reconcileDeviceList(list, {
      ...structuredClone(list),
      simulators: [{ ...second }, { ...list.simulators[0] }, { ...third }],
    });
    const next = reconcileDeviceList(added, {
      ...structuredClone(added),
      simulators: [{ ...added.simulators[2] }, { ...added.simulators[1] }],
    });

    expect(added.simulators[1]).toBe(list.simulators[0]);
    expect(next.simulators).toHaveLength(2);
    expect(next.simulators[0]).toBe(added.simulators[2]);
    expect(next.simulators[1]).toBe(list.simulators[0]);
    expect(next.emulators).toBe(list.emulators);
  });

  test('moves a booted device between sections while preserving the unaffected platform', () => {
    const previous = splitDeviceList(list);
    const snapshot = structuredClone(list);
    snapshot.emulators[0].booted = true;
    const next = splitDeviceList(reconcileDeviceList(list, snapshot), previous);

    expect(next.booted.simulators).toBe(previous.booted.simulators);
    expect(next.recent.simulators).toBe(previous.recent.simulators);
    expect(next.booted.emulators).toEqual(snapshot.emulators);
    expect(next.recent.emulators).toEqual([]);
  });

  test('does not retain a removed optional device field', () => {
    const previous: DeviceList = {
      ...list,
      simulators: [{ ...list.simulators[0], lastUsedAt: 1_000 }],
    };
    const next = reconcileDeviceList(previous, structuredClone(list));

    expect(next.simulators[0]).not.toBe(previous.simulators[0]);
    expect(next.simulators[0]).not.toHaveProperty('lastUsedAt');
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
