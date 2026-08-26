import { describe, expect, test } from 'bun:test';

import {
  MAX_ANDROID_DEVICE_EVENTS,
  clearAndroidEventCursor,
  createAndroidEventCursor,
  mapAndroidSessionEvent,
  mapAndroidSessionEvents,
  mergeAndroidEventSnapshotCursor,
  reconcileAndroidSessionEvents,
  type AndroidSessionEvent,
} from '../android-events';

function gesture(
  value: NonNullable<AndroidSessionEvent['gesture']>,
  overrides: Partial<AndroidSessionEvent> = {}
): AndroidSessionEvent {
  return {
    id: 7,
    at: '2026-08-25T10:00:00.000Z',
    delayMs: 32,
    source: 'ws',
    kind: 'gesture',
    gesture: value,
    ...overrides,
  };
}

describe('serve-emu session event mapping', () => {
  test('maps touch samples with stable device-scoped IDs', () => {
    expect(
      mapAndroidSessionEvent(
        gesture({ type: 'touch', action: 'down', x: 0.251, y: 0.504, pointerId: 3 }),
        'emulator-5554'
      )
    ).toEqual({
      id: 'android:emulator-5554:7',
      timestamp: '2026-08-25T10:00:00.000Z',
      source: 'ws',
      kind: 'touch',
      action: 'down',
      message: 'Touch down at 25%, 50%',
      details: {
        delayMs: 32,
        gesture: { type: 'touch', action: 'down', x: 0.251, y: 0.504, pointerId: 3 },
      },
    });

    expect(mapAndroidSessionEvent(gesture({ type: 'tap', x: 0.1, y: 0.9 }), 'device:one')).toMatchObject({
      id: 'android:device%3Aone:7',
      kind: 'touch',
      action: 'tap',
      message: 'Tap at 10%, 90%',
    });
  });

  test('maps swipes including their duration', () => {
    expect(
      mapAndroidSessionEvent(
        gesture({ type: 'swipe', x1: 0.1, y1: 0.2, x2: 0.8, y2: 0.9, durationMs: 249.6 }),
        'emulator-5554'
      )
    ).toMatchObject({
      kind: 'touch',
      action: 'swipe',
      message: 'Swipe 10%, 20% → 80%, 90% (250 ms)',
    });
  });

  test('maps keycodes and redacts typed text', () => {
    expect(
      mapAndroidSessionEvent(gesture({ type: 'key', keycode: 66 }), 'emulator-5554')
    ).toMatchObject({
      kind: 'keyboard',
      action: 'key',
      message: 'Keycode 66',
    });

    const secret = 'hunter2🔑';
    const mapped = mapAndroidSessionEvent(gesture({ type: 'text', text: secret }), 'emulator-5554');
    expect(mapped).toMatchObject({
      kind: 'keyboard',
      action: 'text',
      message: 'Text input (8 characters, redacted)',
      details: { gesture: { type: 'text', textLength: 8, redacted: true } },
    });
    expect(JSON.stringify(mapped)).not.toContain(secret);
  });

  test('maps Android hardware buttons', () => {
    for (const type of ['back', 'home', 'recents', 'power'] as const) {
      expect(mapAndroidSessionEvent(gesture({ type }), 'emulator-5554')).toMatchObject({
        kind: 'button',
        action: type,
        message: `Button ${type[0].toUpperCase()}${type.slice(1)}`,
      });
    }
  });

  test('maps location fixes and preserves optional structured fields', () => {
    const event: AndroidSessionEvent = {
      id: 9,
      at: '2026-08-25T10:01:00.000Z',
      delayMs: 1_000,
      source: 'rest:location',
      kind: 'location',
      location: { latitude: 52.3676, longitude: 4.9041, altitude: 12 },
    };
    expect(mapAndroidSessionEvent(event, 'emulator-5554')).toEqual({
      id: 'android:emulator-5554:9',
      timestamp: event.at,
      source: 'rest:location',
      kind: 'location',
      action: 'set',
      message: 'Location 52.36760, 4.90410',
      details: { delayMs: 1_000, location: event.location },
    });
  });

  test('keeps future gesture and event kinds visible', () => {
    expect(
      mapAndroidSessionEvent(gesture({ type: 'pinch', scale: 1.5 }), 'emulator-5554')
    ).toMatchObject({
      kind: 'gesture',
      action: 'pinch',
      message: 'Gesture pinch',
    });

    expect(
      mapAndroidSessionEvent(
        { ...gesture({ type: 'ignored' }), kind: 'device-ui', gesture: undefined },
        'emulator-5554'
      )
    ).toMatchObject({
      kind: 'device-ui',
      message: 'Event device-ui',
    });
  });

  test('retains only the latest 500 events in server order', () => {
    const events = Array.from({ length: MAX_ANDROID_DEVICE_EVENTS + 5 }, (_, index) =>
      gesture({ type: 'home' }, { id: index + 1 })
    );
    const mapped = mapAndroidSessionEvents(events, 'emulator-5554');

    expect(mapped).toHaveLength(MAX_ANDROID_DEVICE_EVENTS);
    expect(mapped[0]?.id).toBe('android:emulator-5554:6');
    expect(mapped.at(-1)?.id).toBe('android:emulator-5554:505');
  });

  test('preserves mapped array identity for an unchanged polling snapshot', () => {
    const snapshot = [
      gesture({ type: 'tap', x: 0.25, y: 0.75 }, { id: 1 }),
      gesture({ type: 'home' }, { id: 2 }),
    ];
    const previous = mapAndroidSessionEvents(snapshot, 'emulator-5554');

    expect(reconcileAndroidSessionEvents(previous, snapshot, 'emulator-5554')).toBe(previous);
    expect(
      reconcileAndroidSessionEvents(
        previous,
        [snapshot[0]!, gesture({ type: 'power' }, { id: 2 })],
        'emulator-5554',
      ),
    ).not.toBe(previous);
  });
});

describe('serve-emu session event cursor', () => {
  test('keeps Clear durable when it runs before the first snapshot', () => {
    let cursor = clearAndroidEventCursor(createAndroidEventCursor());
    expect(cursor.clearPending).toBe(true);

    const history = [
      gesture({ type: 'tap' }, { id: 1 }),
      gesture({ type: 'home' }, { id: 2 }),
    ];
    cursor = mergeAndroidEventSnapshotCursor(cursor, history);
    expect(cursor).toEqual({
      latestId: 2,
      clearedThroughId: 2,
      hasSnapshot: true,
      clearPending: false,
    });
    expect(history.filter((event) => event.id > cursor.clearedThroughId)).toEqual([]);

    cursor = mergeAndroidEventSnapshotCursor(cursor, [
      ...history,
      gesture({ type: 'power' }, { id: 3 }),
    ]);
    expect(cursor.clearedThroughId).toBe(2);
  });

  test('recognizes a serve-emu restart that resets numeric IDs', () => {
    let cursor = mergeAndroidEventSnapshotCursor(createAndroidEventCursor(), [
      gesture({ type: 'home' }, { id: 20 }),
    ]);
    cursor = clearAndroidEventCursor(cursor);
    expect(cursor.clearedThroughId).toBe(20);

    cursor = mergeAndroidEventSnapshotCursor(cursor, []);
    expect(cursor).toMatchObject({ latestId: 0, clearedThroughId: 0 });
    cursor = mergeAndroidEventSnapshotCursor(cursor, [
      gesture({ type: 'tap' }, { id: 1 }),
    ]);
    expect(cursor.clearedThroughId).toBe(0);
  });
});
