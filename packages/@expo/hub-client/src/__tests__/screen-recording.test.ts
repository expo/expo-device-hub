import { expect, test } from 'bun:test';

import { areRecordingControlsLocked, parseScreenRecordingStatus } from '../screen-recording.js';

test('unknown recording status locks controls while confirmed absence unlocks them', () => {
  expect(areRecordingControlsLocked('unknown')).toBe(true);
  expect(areRecordingControlsLocked(null)).toBe(false);
});

test.each(['waiting', 'recording', 'finalizing', 'complete', 'failed'] as const)(
  'reads the %s state without exposing writer internals to the UI', (status) => {
    expect(parseScreenRecordingStatus({ status, frames: 4, error: 'encoder error' })).toBe(status);
    expect(areRecordingControlsLocked(status)).toBe(['waiting', 'recording', 'finalizing'].includes(status));
  },
);

test.each([null, undefined, {}, 'recording', { status: 'other' }, { status: 42 }])(
  'ignores missing or unsupported recording metadata: %j', (value) => {
    expect(parseScreenRecordingStatus(value)).toBeNull();
  },
);
