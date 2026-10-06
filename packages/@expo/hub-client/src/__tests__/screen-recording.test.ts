import { expect, test } from 'bun:test';

import { areRecordingControlsLocked, parseScreenRecordingStatus } from '../screen-recording';
import { testError, testFeature } from './feature-fixture';

test('a recording feature without a phase locks controls; an unsupported one does not', () => {
  expect(areRecordingControlsLocked(testFeature(undefined, 'resolving'))).toBe(true);
  expect(areRecordingControlsLocked(testFeature(undefined, 'loading'))).toBe(true);
  expect(
    areRecordingControlsLocked({
      status: 'error',
      data: undefined,
      error: testError('Metadata unavailable'),
      refresh() {},
    }),
  ).toBe(true);
  expect(areRecordingControlsLocked(testFeature(undefined, 'unsupported'))).toBe(false);
  expect(areRecordingControlsLocked(undefined)).toBe(false);
});

test.each(['waiting', 'recording', 'finalizing', 'complete', 'failed'] as const)(
  'reads the %s state without exposing writer internals to the UI', (status) => {
    expect(parseScreenRecordingStatus({ status, frames: 4, error: 'encoder error' })).toBe(status);
    expect(areRecordingControlsLocked(testFeature(status))).toBe(
      ['waiting', 'recording', 'finalizing'].includes(status),
    );
  },
);

test.each([null, undefined, {}, 'recording', { status: 'other' }, { status: 42 }])(
  'ignores missing or unsupported recording metadata: %j', (value) => {
    expect(parseScreenRecordingStatus(value)).toBeNull();
  },
);
