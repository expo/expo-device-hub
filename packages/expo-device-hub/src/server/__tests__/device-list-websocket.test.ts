import { describe, expect, test } from 'bun:test';

import { DEVICE_LIST_MESSAGE_TYPE } from '../../device-list-protocol';
import {
  DeviceListBroadcaster,
  type DeviceListSocket,
  deviceListFingerprint,
} from '../device-list-websocket';
import { type HubDeviceList } from '../devices';

const IOS = {
  id: 'ios-1',
  name: 'iPhone',
  version: 'iOS 27.0',
  platform: 'ios' as const,
  booted: true,
  physical: false,
  supported: true,
  deviceFrame: 'iphone' as const,
  lastUsedAt: 123,
};

const ANDROID = {
  id: 'android-1',
  name: 'Pixel',
  version: 'Android 17.0',
  platform: 'android' as const,
  booted: false,
  physical: false,
  supported: true,
  deviceFrame: 'pixel' as const,
  lastUsedAt: 456,
};

const LIST: HubDeviceList = { simulators: [IOS], emulators: [ANDROID] };

class FakeSocket implements DeviceListSocket {
  sent: string[] = [];
  listeners = { close: [] as Array<() => void>, error: [] as Array<() => void> };

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.emit('close');
  }

  on(event: 'close' | 'error', listener: () => void): void {
    this.listeners[event].push(listener);
  }

  emit(event: 'close' | 'error'): void {
    for (const listener of this.listeners[event]) listener();
  }
}

function manualScheduler() {
  let callback: (() => void) | null = null;
  let cancelled = 0;
  return {
    schedule(next: () => void) {
      callback = next;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    cancelSchedule() {
      callback = null;
      cancelled++;
    },
    run() {
      const next = callback;
      callback = null;
      if (!next) throw new Error('No poll scheduled');
      next();
    },
    get cancelled() {
      return cancelled;
    },
  };
}

async function flushPoll(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function decoded(socket: FakeSocket): Array<{ type: string; devices: HubDeviceList }> {
  return socket.sent.map((message) => JSON.parse(message));
}

describe('DeviceListBroadcaster', () => {
  test('shares one poller and broadcasts only semantic changes', async () => {
    const scheduler = manualScheduler();
    let current = LIST;
    let loads = 0;
    const broadcaster = new DeviceListBroadcaster({
      load: async () => {
        loads++;
        return current;
      },
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancelSchedule,
    });
    const first = new FakeSocket();
    const second = new FakeSocket();

    broadcaster.subscribe(first);
    await flushPoll();
    expect(loads).toBe(1);
    expect(decoded(first)).toEqual([{ type: DEVICE_LIST_MESSAGE_TYPE, devices: LIST }]);

    broadcaster.subscribe(second);
    expect(loads).toBe(1);
    expect(decoded(second)).toEqual([{ type: DEVICE_LIST_MESSAGE_TYPE, devices: LIST }]);

    scheduler.run();
    await flushPoll();
    expect(loads).toBe(2);
    expect(first.sent).toHaveLength(1);
    expect(second.sent).toHaveLength(1);

    current = { ...LIST, simulators: [{ ...IOS, booted: false }] };
    scheduler.run();
    await flushPoll();
    expect(first.sent).toHaveLength(2);
    expect(second.sent).toHaveLength(2);

    first.emit('close');
    second.emit('close');
    expect(scheduler.cancelled).toBe(1);
  });

  test('keeps the last known snapshot when discovery throws', async () => {
    const scheduler = manualScheduler();
    const errors: unknown[] = [];
    let fail = false;
    const broadcaster = new DeviceListBroadcaster({
      load: async () => {
        if (fail) throw new Error('temporary failure');
        return LIST;
      },
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancelSchedule,
      onError: (error) => errors.push(error),
    });
    const socket = new FakeSocket();

    broadcaster.subscribe(socket);
    await flushPoll();
    fail = true;
    scheduler.run();
    await flushPoll();

    expect(socket.sent).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  test('coalesces a refresh requested during an in-flight poll', async () => {
    const scheduler = manualScheduler();
    let resolveFirst!: (list: HubDeviceList) => void;
    let loads = 0;
    const firstLoad = new Promise<HubDeviceList>((resolve) => {
      resolveFirst = resolve;
    });
    const broadcaster = new DeviceListBroadcaster({
      load: async () => (++loads === 1 ? firstLoad : LIST),
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancelSchedule,
    });

    broadcaster.subscribe(new FakeSocket());
    broadcaster.refresh();
    expect(loads).toBe(1);

    resolveFirst(LIST);
    await flushPoll();
    await flushPoll();
    expect(loads).toBe(2);
  });
});

test('deviceListFingerprint ignores discovery order', () => {
  const secondIos = { ...IOS, id: 'ios-2' };
  const a = { ...LIST, simulators: [IOS, secondIos] };
  const b = { ...LIST, simulators: [secondIos, IOS] };
  expect(deviceListFingerprint(a)).toBe(deviceListFingerprint(b));
});

test('deviceListFingerprint includes device-frame capability changes', () => {
  const changed = { ...LIST, simulators: [{ ...IOS, deviceFrame: null }] };

  expect(deviceListFingerprint(LIST)).not.toBe(deviceListFingerprint(changed));
});

test('deviceListFingerprint compares stable error ids instead of volatile details', () => {
  const error = {
    id: 'Error:spawn devicectl ENOENT',
    message: '[apple-utils] Failed to run `devicectl list devices`:',
    error: 'first temporary path',
  };
  const a = { ...LIST, errors: [error] };
  const b = { ...LIST, errors: [{ ...error, error: 'second temporary path' }] };
  const duplicated = { ...LIST, errors: [error, error] };
  const changed = { ...LIST, errors: [{ ...error, id: 'Error:spawn devicectl EACCES' }] };

  expect(deviceListFingerprint(a)).toBe(deviceListFingerprint(b));
  expect(deviceListFingerprint(a)).toBe(deviceListFingerprint(duplicated));
  expect(deviceListFingerprint(a)).not.toBe(deviceListFingerprint(changed));
});
