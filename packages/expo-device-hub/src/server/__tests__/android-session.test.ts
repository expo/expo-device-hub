import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AndroidSession } from '../android-session';
import type { HubDevice } from '../devices';

const device: HubDevice = {
  id: 'emulator-5554',
  name: 'Pixel',
  version: 'Android 16',
  platform: 'android',
  booted: true,
  physical: false,
  supported: true,
  deviceFrame: null,
};
const directories: string[] = [];

async function setup(devices: readonly HubDevice[] = [device]) {
  const directory = await mkdtemp(join(tmpdir(), 'android-session-test-'));
  directories.push(directory);
  const result = {
    udid: device.id,
    deviceName: device.name,
    runtimeDisplayName: device.version,
    directory: join(directory, 'recording'),
  };
  const router = {
    startScreenRecording: mock(async () => {}),
    finishScreenRecording: mock(async () => result),
    stopAll: mock(async () => {}),
  };
  const session = new AndroidSession(router, async () => ({ devices: [...devices], error: null }));
  return { directory, result, router, session };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true })));
});

describe('Android session ownership', () => {
  test('publishes once before stopping capture; repeated finish and shutdown share tasks', async () => {
    const { directory, result, router, session } = await setup();
    await session.startRecording(directory);
    expect(JSON.parse(await readFile(join(directory, 'recordings.json'), 'utf8'))).toEqual([]);
    router.stopAll.mockImplementation(async () => {
      expect(JSON.parse(await readFile(join(directory, 'recordings.json'), 'utf8'))).toEqual([
        result,
      ]);
    });
    const finishing = session.finishRecording();
    expect(session.finishRecording()).toBe(finishing);
    const shutdown = session.shutdown();
    expect(session.shutdown()).toBe(shutdown);
    expect(await finishing).toEqual({ recorded: true });
    await shutdown;
    expect(router.finishScreenRecording).toHaveBeenCalledTimes(1);
    expect(router.stopAll).toHaveBeenCalledTimes(1);
    await expect(session.startRecording(directory)).rejects.toThrow('must start once');
  });

  test('shutdown waits for recording startup before publishing', async () => {
    const { directory, router, session } = await setup();
    const ready = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    router.startScreenRecording.mockImplementation(async () => {
      started.resolve();
      await ready.promise;
    });
    const starting = session.startRecording(directory);
    await started.promise;
    const shutdown = session.shutdown();
    expect(router.finishScreenRecording).not.toHaveBeenCalled();
    expect(router.stopAll).not.toHaveBeenCalled();
    ready.resolve();
    await Promise.all([starting, shutdown]);
    expect(router.finishScreenRecording).toHaveBeenCalledTimes(1);
    expect(router.stopAll).toHaveBeenCalledTimes(1);
  });

  test('failed startup still stops the router and never publishes a stale result', async () => {
    const { directory, router, session } = await setup();
    await writeFile(join(directory, 'recordings.json'), '["previous-session"]');
    await expect(session.startRecording(directory)).rejects.toThrow('EEXIST');
    await expect(session.shutdown()).rejects.toThrow('EEXIST');
    expect(router.startScreenRecording).not.toHaveBeenCalled();
    expect(router.stopAll).toHaveBeenCalledTimes(1);
    expect(await readFile(join(directory, 'recordings.json'), 'utf8')).toBe('["previous-session"]');
  });

  test('finalization failure still stops capture exactly once', async () => {
    const { directory, router, session } = await setup();
    await session.startRecording(directory);
    router.finishScreenRecording.mockRejectedValue(new Error('mux failure'));
    await expect(session.shutdown()).rejects.toThrow('mux failure');
    await expect(session.shutdown()).rejects.toThrow('mux failure');
    expect(router.stopAll).toHaveBeenCalledTimes(1);
    expect(await readFile(join(directory, 'recordings.json'), 'utf8')).toBe('[]');
  });

  test.each([
    { devices: [] },
    { devices: [device, { ...device, id: 'emulator-5556' }] },
    { devices: [{ ...device, physical: true }] },
  ])('starts without recording for unsupported device counts: %j', async ({ devices }) => {
    const { directory, router, session } = await setup(devices);
    const start = await session.startRecording(directory);
    expect(start).toEqual({
      started: false,
      reason: expect.stringContaining('exactly one booted emulator'),
    });
    expect(router.startScreenRecording).not.toHaveBeenCalled();
    expect(await readFile(join(directory, 'recordings.json'), 'utf8')).toBe('[]');
    expect(await session.finishRecording()).toEqual({
      recorded: false,
      reason: expect.stringContaining('exactly one booted emulator'),
    });
    await session.shutdown();
    expect(router.finishScreenRecording).not.toHaveBeenCalled();
    expect(router.stopAll).toHaveBeenCalledTimes(1);
    expect(await readFile(join(directory, 'recordings.json'), 'utf8')).toBe('[]');
  });

  test('a host without recording can shut down but cannot start recording afterward', async () => {
    const { directory, session } = await setup();
    expect(await session.finishRecording()).toEqual({
      recorded: false,
      reason: 'Android recording was not requested.',
    });
    await session.shutdown();
    await expect(session.startRecording(directory)).rejects.toThrow('must start once');
  });
});
