import { describe, expect, test } from 'bun:test';

import { parseArgentInteractionLogLine } from '../argent-interaction-parser';

function line(name: string, args: Record<string, unknown>): string {
  return JSON.stringify({
    ts: '2026-08-10T13:59:21.315Z',
    event: 'tool_called',
    name,
    args: { udid: 'device-1', ...args },
  });
}

describe('parseArgentInteractionLogLine', () => {
  test('parses tap and timed swipe geometry', () => {
    expect(parseArgentInteractionLogLine(line('gesture-tap', { x: 0.2, y: 0.8 }))).toMatchObject({
      deviceId: 'device-1',
      segments: [{ frames: [{ atMs: 0, points: [{ x: 0.2, y: 0.8 }] }] }],
    });

    expect(
      parseArgentInteractionLogLine(
        line('gesture-swipe', {
          fromX: 0.8,
          fromY: 0.5,
          toX: 0.2,
          toY: 0.5,
          durationMs: 450,
          settle: true,
        })
      )
    ).toMatchObject({
      segments: [
        {
          easing: 'ease-out',
          frames: [
            { atMs: 0, points: [{ x: 0.8, y: 0.5 }] },
            { atMs: 450, points: [{ x: 0.2, y: 0.5 }] },
          ],
        },
      ],
    });
  });

  test('parses custom and two-finger gestures', () => {
    const custom = parseArgentInteractionLogLine(
      line('gesture-custom', {
        events: [
          { type: 'Down', x: 0.4, y: 0.5, x2: 0.6, y2: 0.5 },
          { type: 'Up', x: 0.2, y: 0.5, x2: 0.8, y2: 0.5, delayMs: 320 },
        ],
        interpolate: 10,
      })
    );
    expect(custom?.segments[0]?.frames).toEqual([
      {
        atMs: 0,
        points: [
          { x: 0.4, y: 0.5 },
          { x: 0.6, y: 0.5 },
        ],
      },
      {
        atMs: 320,
        points: [
          { x: 0.2, y: 0.5 },
          { x: 0.8, y: 0.5 },
        ],
      },
    ]);

    const pinch = parseArgentInteractionLogLine(
      line('gesture-pinch', {
        centerX: 0.5,
        centerY: 0.5,
        startDistance: 0.2,
        endDistance: 0.6,
        durationMs: 300,
      })
    );
    expect(pinch?.segments[0]?.frames).toEqual([
      {
        atMs: 0,
        points: [
          { x: 0.4, y: 0.5 },
          { x: 0.6, y: 0.5 },
        ],
      },
      {
        atMs: 300,
        points: [
          { x: 0.2, y: 0.5 },
          { x: 0.8, y: 0.5 },
        ],
      },
    ]);
  });

  test('preserves gesture timing inside run-sequence', () => {
    const interaction = parseArgentInteractionLogLine(
      line('run-sequence', {
        steps: [
          { tool: 'gesture-tap', args: { x: 0.1, y: 0.2 }, delayMs: 300 },
          {
            tool: 'gesture-swipe',
            args: { fromX: 0.8, fromY: 0.5, toX: 0.2, toY: 0.5, durationMs: 400 },
          },
          { tool: 'gesture-tap', args: { x: 0.7, y: 0.9 } },
        ],
      })
    );

    expect(
      interaction?.segments.map(({ startMs, frames }) => ({ startMs, end: frames.at(-1)?.atMs }))
    ).toEqual([
      { startMs: 0, end: 0 },
      { startMs: 300, end: 400 },
      { startMs: 800, end: 0 },
    ]);
  });

  test('ignores malformed, non-call, and non-visual records', () => {
    expect(parseArgentInteractionLogLine('not json')).toBeNull();
    expect(parseArgentInteractionLogLine(JSON.stringify({ event: 'tool_result' }))).toBeNull();
    expect(parseArgentInteractionLogLine(line('keyboard', { text: 'secret' }))).toBeNull();
    expect(parseArgentInteractionLogLine(line('gesture-tap', { x: '0.5', y: 0.5 }))).toBeNull();
  });
});
