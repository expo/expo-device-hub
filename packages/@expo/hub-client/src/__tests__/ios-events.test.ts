import { describe, expect, test } from 'bun:test';

import {
  MAX_IOS_DEVICE_EVENTS,
  clearIosEventLogState,
  createIosEventLogState,
  mapIosEventLogEntry,
  mergeIosEventLogPayload,
  parseIosEventLogPayload,
  type IosEventLogEntry,
} from '../ios-events';

function entry(id: number, overrides: Partial<IosEventLogEntry> = {}): IosEventLogEntry {
  return {
    id,
    timestamp: `2026-08-25T10:00:${String(id % 60).padStart(2, '0')}.000Z`,
    source: 'hid',
    kind: 'button',
    action: 'home',
    summary: 'Home',
    ...overrides,
  };
}

describe('serve-sim event-log parsing', () => {
  test('parses snapshots and single updates while skipping malformed snapshot rows', () => {
    expect(
      parseIosEventLogPayload(
        JSON.stringify({
          events: [entry(1), { id: 'bad' }, null],
        }),
      ),
    ).toEqual({ events: [entry(1)] });

    expect(parseIosEventLogPayload({ event: entry(2) })).toEqual({ event: entry(2) });
  });

  test('ignores malformed payloads without throwing', () => {
    for (const payload of ['{', null, [], {}, { events: 'wrong' }, { event: { id: 1 } }]) {
      expect(() => parseIosEventLogPayload(payload)).not.toThrow();
      expect(parseIosEventLogPayload(payload)).toBeNull();
    }
  });
});

describe('serve-sim event mapping', () => {
  test('namespaces IDs by encoded UDID and carries timestamp, status, and details', () => {
    const event = entry(7, {
      source: 'ui',
      kind: 'ui-setting',
      action: 'increase-contrast',
      status: 'ok',
      details: { option: 'increase-contrast', value: 'on' },
    });

    expect(mapIosEventLogEntry(event, 'device:one')).toEqual({
      id: 'ios:device%3Aone:7',
      timestamp: event.timestamp,
      source: 'ui',
      kind: 'settings',
      action: 'increase-contrast',
      message: 'Set Increase contrast to On',
      status: 'ok',
      details: { option: 'increase-contrast', value: 'on' },
    });
  });

  test('maps tap and drag coordinates into privacy-safe touch rows', () => {
    expect(
      mapIosEventLogEntry(
        entry(1, {
          kind: 'tap',
          action: 'tap',
          details: { start: { x: 0.123, y: 0.876 }, current: { x: 0.123, y: 0.876 } },
        }),
        'UDID',
      ),
    ).toMatchObject({
      kind: 'touch',
      action: 'tap',
      message: 'Tap at 0.12, 0.88',
    });

    expect(
      mapIosEventLogEntry(
        entry(2, {
          kind: 'drag',
          action: 'drag',
          details: { start: { x: 0.1, y: 0.2 }, current: { x: 0.7, y: 0.8 } },
        }),
        'UDID',
      ),
    ).toMatchObject({
      kind: 'touch',
      action: 'drag',
      message: 'Drag from 0.10, 0.20 to 0.70, 0.80',
    });
  });

  test('does not expose raw summaries, typed keys, commands, paths, or tokens', () => {
    const secret = 'hunter2';
    const mapped = mapIosEventLogEntry(
      entry(4, {
        kind: 'key',
        action: 'down',
        msg: `Typed ${secret}`,
        summary: `Typed ${secret}`,
        details: {
          key: secret,
          usage: 11,
          text: secret,
          command: `send ${secret}`,
          path: `/Users/me/${secret}`,
          token: secret,
        },
      }),
      'UDID',
    );

    expect(mapped).toMatchObject({
      kind: 'keyboard',
      action: 'down',
      message: 'Key down character',
      details: {
        key: 'character',
        redacted: true,
        text: '[redacted]',
        command: '[redacted]',
        path: '[redacted]',
        token: '[redacted]',
      },
    });
    expect(mapped.details).not.toHaveProperty('usage');
    expect(JSON.stringify(mapped)).not.toContain(secret);
  });

  test('uses kind/action mapping instead of an untrusted message for future events', () => {
    const mapped = mapIosEventLogEntry(
      entry(10, {
        source: 'exec',
        kind: 'future-event',
        action: 'start',
        msg: 'token=should-not-appear',
        summary: 'token=should-not-appear',
      }),
      'UDID',
    );
    expect(mapped).toMatchObject({
      source: 'exec',
      kind: 'future-event',
      action: 'start',
      message: 'Event future event',
    });
    expect(JSON.stringify(mapped)).not.toContain('should-not-appear');
  });
});

describe('serve-sim event history', () => {
  test('merges snapshots and updates by ID in oldest-to-newest order', () => {
    let state = createIosEventLogState();
    state = mergeIosEventLogPayload(
      state,
      { events: [entry(3), entry(1), entry(2, { action: 'lock' })] },
      'UDID',
    );
    state = mergeIosEventLogPayload(
      state,
      { event: entry(2, { action: 'volume-up', status: 'error' }) },
      'UDID',
    );

    expect(state.events.map((event) => event.id)).toEqual([
      'ios:UDID:1',
      'ios:UDID:2',
      'ios:UDID:3',
    ]);
    expect(state.events[1]).toMatchObject({
      action: 'volume-up',
      message: 'Button Volume up',
      status: 'error',
    });
  });

  test('retains only the latest 500 rows', () => {
    const events = Array.from({ length: MAX_IOS_DEVICE_EVENTS + 5 }, (_, index) =>
      entry(index + 1),
    );
    const state = mergeIosEventLogPayload(createIosEventLogState(), { events }, 'UDID');

    expect(state.events).toHaveLength(MAX_IOS_DEVICE_EVENTS);
    expect(state.events[0]?.id).toBe('ios:UDID:6');
    expect(state.events.at(-1)?.id).toBe('ios:UDID:505');
  });

  test('keeps Clear durable across reconnect snapshots using a numeric ID watermark', () => {
    let state = mergeIosEventLogPayload(
      createIosEventLogState(),
      { events: [entry(1), entry(2), entry(3)] },
      'UDID',
    );
    state = clearIosEventLogState(state, 'UDID');
    expect(state).toEqual({
      events: [],
      clearedThroughId: 3,
      latestId: 3,
      hasSnapshot: true,
      clearPending: false,
    });

    state = mergeIosEventLogPayload(
      state,
      { events: [entry(1), entry(2), entry(3), entry(4)] },
      'UDID',
    );
    expect(state.events.map((event) => event.id)).toEqual(['ios:UDID:4']);

    const unchanged = mergeIosEventLogPayload(state, { event: entry(2) }, 'UDID');
    expect(unchanged.events.map((event) => event.id)).toEqual(['ios:UDID:4']);

    state = mergeIosEventLogPayload(unchanged, { event: entry(5) }, 'UDID');
    expect(state.events.map((event) => event.id)).toEqual(['ios:UDID:4', 'ios:UDID:5']);
  });

  test('keeps Clear durable when it runs before the initial SSE snapshot', () => {
    let state = clearIosEventLogState(createIosEventLogState(), 'UDID');
    expect(state).toEqual({
      events: [],
      clearedThroughId: 0,
      latestId: 0,
      hasSnapshot: false,
      clearPending: true,
    });

    state = mergeIosEventLogPayload(
      state,
      { events: [entry(1), entry(2), entry(3)] },
      'UDID',
    );
    expect(state).toEqual({
      events: [],
      clearedThroughId: 3,
      latestId: 3,
      hasSnapshot: true,
      clearPending: false,
    });

    state = mergeIosEventLogPayload(state, { event: entry(4) }, 'UDID');
    expect(state.events.map((event) => event.id)).toEqual(['ios:UDID:4']);
  });

  test('resets retained rows and the Clear watermark after serve-sim restarts IDs', () => {
    let state = mergeIosEventLogPayload(
      createIosEventLogState(),
      { events: [entry(100), entry(101)] },
      'UDID',
    );
    state = clearIosEventLogState(state, 'UDID');
    expect(state.clearedThroughId).toBe(101);

    state = mergeIosEventLogPayload(state, { events: [entry(1), entry(2)] }, 'UDID');
    expect(state).toMatchObject({
      clearedThroughId: 0,
      latestId: 2,
      hasSnapshot: true,
      clearPending: false,
    });
    expect(state.events.map((event) => event.id)).toEqual(['ios:UDID:1', 'ios:UDID:2']);
  });

  test('leaves state unchanged for malformed frames', () => {
    const state = mergeIosEventLogPayload(createIosEventLogState(), { event: entry(1) }, 'UDID');
    expect(mergeIosEventLogPayload(state, '{', 'UDID')).toBe(state);
    expect(mergeIosEventLogPayload(state, { event: { nope: true } }, 'UDID')).toBe(state);
  });
});
