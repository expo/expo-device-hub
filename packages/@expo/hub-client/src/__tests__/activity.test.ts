import { describe, expect, test } from 'bun:test';

import {
  appendActivitySample,
  MAX_ACTIVITY_SAMPLES,
  parseActivityHostCores,
  parseActivitySample,
} from '../activity';
import { type DeviceActivity, type DeviceActivitySample } from '../types';

const sample = (t: number, bundleId: string | null = 'dev.expo.app'): DeviceActivitySample => ({
  t,
  bundleId,
  cpuPct: t,
  memBytes: t * 1024,
  netInBytesPerSec: t * 2,
  netOutBytesPerSec: t * 3,
});

describe('activity metrics', () => {
  test('parses valid samples and rejects malformed values', () => {
    expect(parseActivitySample(sample(1))).toEqual(sample(1));
    expect(parseActivitySample({ ...sample(1), cpuPct: 'high' })).toBeNull();
    expect(parseActivityHostCores({ hostCores: 12 })).toBe(12);
    expect(parseActivityHostCores({ hostCores: 0 })).toBeNull();
  });

  test('keeps the latest minute and clears error/stale flags', () => {
    let activity: DeviceActivity = { hostCores: 8, samples: [], errored: true, stale: true };
    for (let index = 0; index < MAX_ACTIVITY_SAMPLES + 4; index++) {
      activity = appendActivitySample(activity, sample(index));
    }
    expect(activity.samples).toHaveLength(MAX_ACTIVITY_SAMPLES);
    expect(activity.samples[0]?.t).toBe(4);
    expect(activity).toMatchObject({ errored: false, stale: false });
  });

  test('resets on a real app switch but not on a temporary null bundle', () => {
    let activity: DeviceActivity = { hostCores: null, samples: [], errored: false, stale: false };
    activity = appendActivitySample(activity, sample(1, 'app.one'));
    activity = appendActivitySample(activity, sample(2, null));
    activity = appendActivitySample(activity, sample(3, 'app.two'));
    expect(activity.samples.map((entry) => entry.t)).toEqual([3]);
  });
});
