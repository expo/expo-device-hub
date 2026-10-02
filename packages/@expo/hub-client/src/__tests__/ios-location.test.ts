import { describe, expect, test } from 'bun:test';

import { type HostActionParams, type HostActionResult } from '../exec-ws.js';
import { clearIosLocation, setIosLocation, simctlFailureMessage } from '../ios-location.js';

const UDID = 'ABC-123';
const FIX = { latitude: 37.3349, longitude: -122.009 };

const ok: HostActionResult = { stdout: '', stderr: '', exitCode: 0 };
const failed = (stderr: string): HostActionResult => ({ stdout: '', stderr, exitCode: 1 });

function fakeRun(result: HostActionResult) {
  const calls: Array<{ action: string; params?: HostActionParams }> = [];
  const run = async (action: string, params?: HostActionParams): Promise<HostActionResult> => {
    calls.push({ action, params });
    return result;
  };
  return { run, calls };
}

describe('setIosLocation', () => {
  test('runs the location.set action with the udid and raw coordinates', async () => {
    const { run, calls } = fakeRun(ok);

    expect(await setIosLocation(run, UDID, FIX)).toEqual(FIX);
    expect(calls).toEqual([
      { action: 'location.set', params: { udid: UDID, lat: 37.3349, lng: -122.009 } },
    ]);
  });

  test('rejects on a non-zero exit even though the action resolved', async () => {
    const { run } = fakeRun(
      failed('An error was encountered processing the command.\nReason: device not booted\n'),
    );

    await expect(setIosLocation(run, UDID, FIX)).rejects.toThrow('device not booted');
  });
});

describe('clearIosLocation', () => {
  test('runs the location.clear action with the udid', async () => {
    const { run, calls } = fakeRun(ok);

    await clearIosLocation(run, UDID);
    expect(calls).toEqual([{ action: 'location.clear', params: { udid: UDID } }]);
  });

  test('rejects on a non-zero exit even though the action resolved', async () => {
    const { run } = fakeRun(failed('Invalid device: ABC-123'));

    await expect(clearIosLocation(run, UDID)).rejects.toThrow('Invalid device: ABC-123');
  });
});

describe('simctlFailureMessage', () => {
  test('prefers the Reason line over the rest of stderr', () => {
    expect(
      simctlFailureMessage(failed('noise\nReason: Unable to lookup in current state\ntrailing\n')),
    ).toBe('Unable to lookup in current state');
  });

  test('falls back to the last non-empty stderr line', () => {
    expect(simctlFailureMessage(failed('first line\nInvalid device type\n\n'))).toBe(
      'Invalid device type',
    );
  });

  test('falls back to a fixed message when stderr says nothing', () => {
    expect(simctlFailureMessage(failed(''))).toBe('simctl location failed');
    expect(simctlFailureMessage(failed('  \n\n'))).toBe('simctl location failed');
  });
});
