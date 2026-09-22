import { describe, expect, test } from 'bun:test';

import { recordingLimitsFromEnv } from '../recording-limits';

describe('recordingLimitsFromEnv', () => {
  test('returns only the variables that are set', () => {
    expect(recordingLimitsFromEnv({})).toEqual({});
    expect(
      recordingLimitsFromEnv({
        EXPO_DEVICE_HUB_RECORDING_MAX_BYTES: '65536',
        EXPO_DEVICE_HUB_RECORDING_MIN_FREE_BYTES: '0',
      })
    ).toEqual({ maxFileBytes: 65536, minFreeBytes: 0 });
  });

  test.each([
    ['EXPO_DEVICE_HUB_RECORDING_MAX_BYTES', ''],
    ['EXPO_DEVICE_HUB_RECORDING_MAX_BYTES', 'abc'],
    ['EXPO_DEVICE_HUB_RECORDING_MAX_BYTES', '0'],
    ['EXPO_DEVICE_HUB_RECORDING_MAX_BYTES', '1.5'],
    ['EXPO_DEVICE_HUB_RECORDING_MAX_DURATION_MS', '-1'],
    ['EXPO_DEVICE_HUB_RECORDING_MAX_DURATION_MS', '86400001'],
    ['EXPO_DEVICE_HUB_RECORDING_MIN_FREE_BYTES', '-1'],
  ])('names the variable in the error: %s=%j', (name, value) => {
    expect(() => recordingLimitsFromEnv({ [name]: value })).toThrow(name);
  });
});
