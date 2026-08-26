import { describe, expect, test } from 'bun:test';

import {
  DeviceSettingWriteTracker,
  mergeAuthoritativeDeviceSetting,
} from '../device-setting-writes';

describe('DeviceSettingWriteTracker', () => {
  test('allows different options concurrently while rejecting a repeated write to the same option', () => {
    const tracker = new DeviceSettingWriteTracker();

    const appearance = tracker.start('appearance');
    const textSize = tracker.start('text-size');

    expect(appearance).not.toBeNull();
    expect(textSize).not.toBeNull();
    expect(tracker.start('appearance')).toBeNull();
    expect(tracker.pending).toEqual(new Set(['appearance', 'text-size']));

    expect(tracker.finish(appearance!)).toBeTrue();
    expect(tracker.pending).toEqual(new Set(['text-size']));
    expect(tracker.finish(textSize!)).toBeTrue();
    expect(tracker.pending).toEqual(new Set());
  });

  test('invalidates stale completions when the active device changes', () => {
    const tracker = new DeviceSettingWriteTracker();
    const oldDeviceRequest = tracker.start('appearance')!;

    tracker.reset();
    const newDeviceRequest = tracker.start('appearance')!;

    expect(tracker.isCurrent(oldDeviceRequest)).toBeFalse();
    expect(tracker.finish(oldDeviceRequest)).toBeFalse();
    expect(tracker.pending).toEqual(new Set(['appearance']));
    expect(tracker.isCurrent(newDeviceRequest)).toBeTrue();
  });
});

describe('mergeAuthoritativeDeviceSetting', () => {
  test('rolls back only the failed option without clobbering another optimistic write', () => {
    const optimistic = {
      appearance: 'dark',
      'text-size': 'xxx-large',
      'reduce-motion': 'on',
    } as const;

    expect(
      mergeAuthoritativeDeviceSetting(optimistic, 'appearance', {
        appearance: 'light',
        'text-size': 'large',
        'reduce-motion': 'off',
      }),
    ).toEqual({
      appearance: 'light',
      'text-size': 'xxx-large',
      'reduce-motion': 'on',
    });
  });

  test('removes a failed optimistic option when the authoritative status omits it', () => {
    expect(
      mergeAuthoritativeDeviceSetting(
        { appearance: 'dark', 'liquid-glass': 'on' },
        'liquid-glass',
        { appearance: 'dark' },
      ),
    ).toEqual({ appearance: 'dark' });
  });
});
