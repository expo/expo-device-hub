import { describe, expect, test } from 'bun:test';

import {
  IDLE_STREAM_SWITCH,
  isStreamSwitchPending,
  reduceStreamSwitch,
  STREAM_SWITCH_FRAME_TIMEOUT_MS,
  STREAM_SWITCH_INTERRUPTION_TIMEOUT_MS,
  type StreamSwitchEvent,
  type StreamSwitchState,
  streamSwitchTimeoutMs,
} from '../stream-switch';

function run(events: StreamSwitchEvent[], from: StreamSwitchState = IDLE_STREAM_SWITCH) {
  return events.reduce(reduceStreamSwitch, from);
}

describe('stream switch tracker', () => {
  test('ignores stream events while no switch is in progress', () => {
    expect(reduceStreamSwitch(IDLE_STREAM_SWITCH, { type: 'stream-interrupted' })).toBe(
      IDLE_STREAM_SWITCH,
    );
    expect(reduceStreamSwitch(IDLE_STREAM_SWITCH, { type: 'stream-live' })).toBe(IDLE_STREAM_SWITCH);
    expect(reduceStreamSwitch(IDLE_STREAM_SWITCH, { type: 'timeout' })).toBe(IDLE_STREAM_SWITCH);
    expect(isStreamSwitchPending(IDLE_STREAM_SWITCH)).toBe(false);
  });

  test('a failed request ends the switch without waiting on the stream', () => {
    const requesting = run([{ type: 'request-start' }]);
    expect(isStreamSwitchPending(requesting)).toBe(true);
    expect(reduceStreamSwitch(requesting, { type: 'request-failure' })).toBe(IDLE_STREAM_SWITCH);
  });

  test('a request that did not replace the session ends immediately', () => {
    expect(
      run([{ type: 'request-start' }, { type: 'request-success', replaced: false }]),
    ).toBe(IDLE_STREAM_SWITCH);
  });

  test('waits for the replacement frame when the stream dropped before the response', () => {
    // serve-emu closes the old viewer sockets right before it answers.
    const awaitingFrame = run([
      { type: 'request-start' },
      { type: 'stream-interrupted' },
      { type: 'request-success', replaced: true },
    ]);
    expect(awaitingFrame.phase).toBe('awaiting-frame');
    expect(isStreamSwitchPending(awaitingFrame)).toBe(true);
    expect(reduceStreamSwitch(awaitingFrame, { type: 'stream-interrupted' })).toBe(awaitingFrame);
    expect(reduceStreamSwitch(awaitingFrame, { type: 'stream-live' })).toBe(IDLE_STREAM_SWITCH);
  });

  test('ends at once when the stream already recovered while the request was in flight', () => {
    expect(
      run([
        { type: 'request-start' },
        { type: 'stream-interrupted' },
        { type: 'stream-live' },
        { type: 'request-success', replaced: true },
      ]),
    ).toBe(IDLE_STREAM_SWITCH);
  });

  test('waits for the interruption when the response arrives before the old stream drops', () => {
    const awaitingInterruption = run([
      { type: 'request-start' },
      { type: 'request-success', replaced: true },
    ]);
    expect(awaitingInterruption.phase).toBe('awaiting-interruption');
    // A stale "live" from the old socket must not end the switch early.
    expect(reduceStreamSwitch(awaitingInterruption, { type: 'stream-live' })).toBe(
      awaitingInterruption,
    );

    const awaitingFrame = reduceStreamSwitch(awaitingInterruption, {
      type: 'stream-interrupted',
    });
    expect(awaitingFrame.phase).toBe('awaiting-frame');
    expect(reduceStreamSwitch(awaitingFrame, { type: 'stream-live' })).toBe(IDLE_STREAM_SWITCH);
  });

  test('a new request supersedes whatever was being awaited', () => {
    const awaitingFrame = run([
      { type: 'request-start' },
      { type: 'stream-interrupted' },
      { type: 'request-success', replaced: true },
    ]);
    const restarted = reduceStreamSwitch(awaitingFrame, { type: 'request-start' });
    expect(restarted).toEqual({ phase: 'requesting', interrupted: false, recovered: false });
  });

  test('safety timeouts release the pending state', () => {
    expect(streamSwitchTimeoutMs('idle')).toBeNull();
    expect(streamSwitchTimeoutMs('requesting')).toBeNull();
    expect(streamSwitchTimeoutMs('awaiting-interruption')).toBe(
      STREAM_SWITCH_INTERRUPTION_TIMEOUT_MS,
    );
    expect(streamSwitchTimeoutMs('awaiting-frame')).toBe(STREAM_SWITCH_FRAME_TIMEOUT_MS);

    const awaitingInterruption = run([
      { type: 'request-start' },
      { type: 'request-success', replaced: true },
    ]);
    expect(reduceStreamSwitch(awaitingInterruption, { type: 'timeout' })).toBe(IDLE_STREAM_SWITCH);
    const awaitingFrame = reduceStreamSwitch(awaitingInterruption, { type: 'stream-interrupted' });
    expect(reduceStreamSwitch(awaitingFrame, { type: 'timeout' })).toBe(IDLE_STREAM_SWITCH);
  });

  test('returns the same object when nothing changes', () => {
    const requesting = run([{ type: 'request-start' }]);
    expect(reduceStreamSwitch(requesting, { type: 'stream-live' })).toBe(requesting);
    expect(reduceStreamSwitch(requesting, { type: 'timeout' })).toBe(requesting);
    const interrupted = reduceStreamSwitch(requesting, { type: 'stream-interrupted' });
    expect(reduceStreamSwitch(interrupted, { type: 'stream-interrupted' })).toBe(interrupted);
  });
});
