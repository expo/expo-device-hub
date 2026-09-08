import { beforeEach, describe, expect, mock, test } from 'bun:test';

import type {
  AndroidUtilsResult,
  BootDeviceOptions,
  BootedDevice,
  EmulatorExit,
} from '@expo/hub-android-utils';

import { bootHubDevice, shutdownHubDevice, type EmulatorCameraFeeds } from '../device-actions';

const calls: string[] = [];

function pending<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

function feedArgs(serial: string): string[] {
  return ['-camera-back', `imagefile:/feeds/${serial}-back.png`];
}

interface Scenario {
  port: number | null;
  spawned: BootDeviceOptions | null;
  exited: Promise<EmulatorExit>;
  online: Promise<AndroidUtilsResult<boolean>>;
  shutdownOk: boolean;
}

const scenario: Scenario = {
  port: 5560,
  spawned: null,
  exited: pending(),
  online: Promise.resolve({ value: true, error: null }),
  shutdownOk: true,
};

const androidUtils = await import('@expo/hub-android-utils');

mock.module('@expo/hub-android-utils', () => ({
  ...androidUtils,
  freeEmulatorPort: async () => {
    calls.push('freeEmulatorPort');
    return { value: scenario.port, error: null };
  },
  bootDevice: async (options: BootDeviceOptions) => {
    calls.push(`spawn ${options.name}`);
    scenario.spawned = options;
    const booted: BootedDevice = {
      serial: `emulator-${options.port}`,
      pid: 4242,
      command: `emulator -avd ${options.name}`,
      exited: scenario.exited,
    };
    return { value: booted, error: null };
  },
  waitForAdbOnline: (serial: string) => {
    calls.push(`waitForAdbOnline ${serial}`);
    return scenario.online;
  },
  shutdownDevice: async ({ serial }: { serial: string }) => {
    calls.push(`shutdownDevice ${serial}`);
    return { value: scenario.shutdownOk, error: null };
  },
  waitForAdbOffline: async (serial: string) => {
    calls.push(`waitForAdbOffline ${serial}`);
    return { value: true, error: null };
  },
  removeDevice: async ({ name }: { name: string }) => {
    calls.push(`removeDevice ${name}`);
    return { value: true, error: null };
  },
  createDevice: async () => ({ value: true, error: null }),
}));

function cameraFeeds(seedFailure?: Error): EmulatorCameraFeeds {
  return {
    launchArgs(serial) {
      calls.push(`launchArgs ${serial}`);
      return feedArgs(serial);
    },
    async seedPlaceholders(serial) {
      calls.push(`seedPlaceholders ${serial}`);
      if (seedFailure) throw seedFailure;
    },
  };
}

function bootRequest() {
  return { platform: 'android' as const, id: '', name: 'Pixel_9' };
}

beforeEach(() => {
  calls.length = 0;
  scenario.port = 5560;
  scenario.spawned = null;
  scenario.exited = pending();
  scenario.online = Promise.resolve({ value: true, error: null });
  scenario.shutdownOk = true;
});

describe('bootHubDevice camera feeds', () => {
  test('seeds the allocated serial before it spawns the emulator', async () => {
    const result = await bootHubDevice(bootRequest(), cameraFeeds());

    expect(calls).toEqual([
      'freeEmulatorPort',
      'seedPlaceholders emulator-5560',
      'launchArgs emulator-5560',
      'spawn Pixel_9',
      'waitForAdbOnline emulator-5560',
    ]);
    expect(result).toEqual({
      ok: true,
      id: 'emulator-5560',
      serial: 'emulator-5560',
      errors: [],
    });
  });

  test('spawns with the launch args for the allocated serial', async () => {
    scenario.port = 5570;

    await bootHubDevice(bootRequest(), cameraFeeds());

    expect(scenario.spawned).toEqual({
      name: 'Pixel_9',
      port: 5570,
      extraArgs: feedArgs('emulator-5570'),
    });
  });

  test('boots without camera feeds when seeding fails', async () => {
    const result = await bootHubDevice(bootRequest(), cameraFeeds(new Error('disk full')));

    expect(calls).toEqual([
      'freeEmulatorPort',
      'seedPlaceholders emulator-5560',
      'spawn Pixel_9',
      'waitForAdbOnline emulator-5560',
    ]);
    expect(scenario.spawned?.extraArgs).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.errors[0]?.message).toBe('Failed to prepare camera feeds for Pixel_9');
  });
});

describe('shutdownHubDevice', () => {
  test('waits for the emulator to go offline after the shutdown', async () => {
    const result = await shutdownHubDevice({
      platform: 'android',
      id: 'emulator-5560',
      name: 'Pixel_9',
    });

    expect(calls).toEqual(['shutdownDevice emulator-5560', 'waitForAdbOffline emulator-5560']);
    expect(result).toEqual({ ok: true, errors: [] });
  });

  test('does not wait for adb when the shutdown itself fails', async () => {
    scenario.shutdownOk = false;

    const result = await shutdownHubDevice({
      platform: 'android',
      id: 'emulator-5560',
      name: 'Pixel_9',
    });

    expect(calls).toEqual(['shutdownDevice emulator-5560']);
    expect(result.ok).toBe(false);
  });
});
