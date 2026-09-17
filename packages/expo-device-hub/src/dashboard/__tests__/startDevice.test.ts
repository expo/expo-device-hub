import { describe, expect, mock, test } from 'bun:test';
import { type Device, type NewDeviceRequest } from '@expo/hub-components';

import { type StartDeviceOutcome } from '../deviceActions';
import { createDeviceSessionStore } from '../deviceSessionStore';
import { createDeviceStarter } from '../startDevice';

const iphone: Device = {
  id: 'ios-udid',
  name: 'iPhone',
  version: 'iOS 27',
  platform: 'ios',
  booted: false,
  physical: false,
  supported: true,
  deviceFrame: 'ios:iphone-17-pro',
};
const newIphone: NewDeviceRequest = {
  name: iphone.name,
  version: iphone.version,
  platform: 'ios',
  supported: true,
  deviceFrame: iphone.deviceFrame,
  runtime: 'ios-27',
  deviceType: 'iphone-17-pro',
};
const empty = { simulators: [], emulators: [] };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup() {
  const store = createDeviceSessionStore();
  const created = deferred<StartDeviceOutcome>();
  const booted = deferred<StartDeviceOutcome>();
  const create = mock(
    async (_device: NewDeviceRequest, _options?: { boot?: boolean }) => created.promise
  );
  const boot = mock(async (_device: Device) => booted.promise);
  let route = '';
  let nextId = 0;
  const navigate = mock((id: string, _options?: { replace?: boolean }) => {
    route = id;
    store.getState().update({ ...store.getState().discovery, selectedId: id });
  });
  const start = createDeviceStarter({
    store,
    boot,
    create,
    navigate,
    currentRoute: () => route,
    newRequestId: () => `request-${++nextId}`,
  });
  const snapshot = (simulators: Device[], emulators: Device[] = []) =>
    store
      .getState()
      .update({ booted: { simulators, emulators }, recent: empty, selectedId: route });
  return { store, created, booted, create, boot, navigate, start, snapshot, route: () => route };
}

describe('background device startup', () => {
  test('adds a booting device immediately and retains its failure after navigating away', async () => {
    const s = setup();
    const request = s.start({ kind: 'recent', device: iphone });
    expect(s.store.getState().simulators).toHaveLength(1);
    expect(s.store.getState().selectedDevice?.startup).toEqual({ phase: 'booting' });
    expect(s.store.getState().selectedAvailable).toBe(false);
    expect(s.boot).toHaveBeenCalledTimes(1);
    const other = { ...iphone, id: 'other', name: 'Other', booted: true };
    s.snapshot([other]);
    s.navigate(other.id);
    const selected = s.store.getState().selectedDevice;
    expect(s.store.getState().simulators.map((device) => device.id)).toEqual(['other', iphone.id]);
    s.booted.resolve({ id: null, error: 'Emulator exited with code 1' });
    expect(await request).toEqual({ ok: false, error: 'Emulator exited with code 1' });
    expect(s.route()).toBe('other');
    expect(s.store.getState().selectedDevice).toBe(selected);
    s.navigate(iphone.id);
    expect(s.store.getState().selectedDevice?.startup).toEqual({
      phase: 'failed',
      action: 'boot',
      message: 'Emulator exited with code 1',
    });
  });

  test('reports real creation and boot phases, then hands the device over to discovery', async () => {
    const s = setup();
    const request = s.start({ kind: 'new', device: newIphone });
    const temporaryId = s.route();
    expect(s.store.getState().selectedDevice?.startup).toEqual({ phase: 'creating' });
    expect(s.store.getState().simulators[0].name).toBe('iPhone');
    expect(s.create).toHaveBeenCalledWith(newIphone, { boot: false });
    expect(s.boot).not.toHaveBeenCalled();
    s.created.resolve({ id: iphone.id, error: null });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(s.store.getState().selectedDevice?.startup).toEqual({ phase: 'booting' });
    expect(s.navigate).toHaveBeenLastCalledWith(iphone.id, { replace: true });
    expect(s.store.getState().resolveDeviceId(temporaryId)).toBe(iphone.id);
    const online = { ...iphone, booted: true };
    s.snapshot([online]);
    expect(s.store.getState().simulators).toHaveLength(1);
    expect(s.store.getState().selectedAvailable).toBe(false);
    s.booted.resolve({ id: iphone.id, error: null });
    expect(await request).toEqual({ ok: true });
    expect(s.store.getState().selectedDevice).toBe(online);
    expect(s.store.getState().selectedAvailable).toBe(true);
    expect(s.store.getState().startups).toEqual({});
  });

  test('keeps boot progress after HTTP success until discovery catches up', async () => {
    const s = setup();
    const request = s.start({ kind: 'recent', device: iphone });
    s.booted.resolve({ id: iphone.id, error: null });
    await request;
    s.snapshot([]);
    expect(s.store.getState().simulators).toHaveLength(1);
    expect(s.store.getState().selectedDevice?.startup?.phase).toBe('booting');
    s.snapshot([{ ...iphone, booted: true }]);
    expect(s.store.getState().selectedDevice?.startup).toBeUndefined();
    expect(s.store.getState().selectedAvailable).toBe(true);
    s.snapshot([]);
    expect(s.store.getState().selectedAvailable).toBe(false);
    expect(s.store.getState().selectedDevice?.startup).toBeUndefined();
  });

  test('deduplicates Android AVD names and serials without stealing selection', async () => {
    const s = setup();
    const android: Device = { ...iphone, id: 'Pixel_9', name: 'Pixel_9', platform: 'android' };
    const request = s.start({ kind: 'recent', device: android });
    s.navigate(iphone.id);
    const online = { ...android, id: 'emulator-5556', booted: true };
    s.snapshot([{ ...iphone, booted: true }], [online]);
    expect(s.store.getState().emulators).toHaveLength(1);
    s.booted.resolve({ id: online.id, error: null });
    await request;
    expect(s.route()).toBe(iphone.id);
    expect(s.store.getState().resolveDeviceId(android.id)).toBe(online.id);
    expect(s.store.getState().emulators).toEqual([online]);
  });

  test('a retry of failed creation replaces its placeholder', async () => {
    const s = setup();
    s.created.resolve({ id: null, error: 'No disk space' });
    await s.start({ kind: 'new', device: newIphone });
    const failedId = s.route();
    expect(s.store.getState().selectedDevice?.startup).toEqual({
      phase: 'failed',
      action: 'create',
      message: 'No disk space',
    });
    const retry = s.start({ kind: 'new', device: newIphone });
    expect(s.store.getState().simulators).toHaveLength(1);
    expect(Object.keys(s.store.getState().startups)).toHaveLength(1);
    expect(s.store.getState().resolveDeviceId(failedId)).toBe(s.route());
    await retry;
  });

  test('retries boot without creating another device after creation succeeded', async () => {
    const s = setup();
    s.created.resolve({ id: iphone.id, error: null });
    s.booted.resolve({ id: null, error: 'Boot failed' });
    await s.start({ kind: 'new', device: newIphone });
    const failure = Object.values(s.store.getState().startups)[0];
    expect(failure.target.kind).toBe('recent');
    await s.start(failure.target);
    expect(s.create).toHaveBeenCalledTimes(1);
    expect(s.boot).toHaveBeenCalledTimes(2);
    expect(s.store.getState().simulators).toHaveLength(1);
  });

  test('prevents duplicate starts while a request is running', async () => {
    const s = setup();
    const first = s.start({ kind: 'recent', device: iphone });
    expect(await s.start({ kind: 'recent', device: iphone })).toMatchObject({ ok: false });
    expect(s.boot).toHaveBeenCalledTimes(1);
    s.booted.resolve({ id: iphone.id, error: null });
    await first;
  });

  test('records unexpected failures in the local device state', async () => {
    const s = setup();
    s.boot.mockRejectedValueOnce(new Error('Connection lost'));
    await s.start({ kind: 'recent', device: iphone });
    expect(s.store.getState().selectedDevice?.startup).toEqual({
      phase: 'failed',
      action: 'boot',
      message: 'Connection lost',
    });
  });
});

test('waits for the returned Android serial instead of accepting a stale discovery entry', async () => {
  const s = setup();
  const android: Device = { ...iphone, platform: 'android', id: 'Pixel', name: 'Pixel' };
  const request = s.start({ kind: 'recent', device: android });
  s.snapshot([], [{ ...android, id: 'emulator-5554', booted: true }]);
  s.booted.resolve({ id: 'emulator-5556', error: null });
  await request;
  expect(s.store.getState().selectedDevice?.id).toBe('emulator-5556');
  expect(s.store.getState().selectedDevice?.startup?.phase).toBe('booting');
  expect(s.store.getState().emulators).toHaveLength(1);
  s.snapshot([], [{ ...android, id: 'emulator-5556', booted: true }]);
  expect(s.store.getState().selectedAvailable).toBe(true);
});

test('starting an AVD again clears its old name-to-serial redirect', async () => {
  const s = setup();
  const android: Device = { ...iphone, platform: 'android', id: 'Pixel', name: 'Pixel' };
  s.booted.resolve({ id: 'emulator-5554', error: null });
  await s.start({ kind: 'recent', device: android });
  s.snapshot([], [{ ...android, id: 'emulator-5554', booted: true }]);
  expect(s.store.getState().resolveDeviceId('Pixel')).toBe('emulator-5554');
  s.snapshot([]);
  const nextBoot = deferred<StartDeviceOutcome>();
  s.boot.mockImplementationOnce(() => nextBoot.promise);
  const request = s.start({ kind: 'recent', device: android });
  expect(s.store.getState().resolveDeviceId('Pixel')).toBe('Pixel');
  expect(s.store.getState().selectedDevice?.startup?.phase).toBe('booting');
  nextBoot.resolve({ id: 'emulator-5556', error: null });
  await request;
  expect(s.route()).toBe('emulator-5556');
  expect(s.store.getState().resolveDeviceId('Pixel')).toBe('emulator-5556');
});
