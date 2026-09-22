import { describe, expect, test } from 'bun:test';

import { WHEEL_LINE_HEIGHT_PX, wheelDeltaToPixels } from '../scroll-wheel';

describe('wheelDeltaToPixels', () => {
  test('passes pixel-mode deltas through', () => {
    expect(wheelDeltaToPixels(12.5, 0, 400)).toBe(12.5);
    expect(wheelDeltaToPixels(-3, 0, 400)).toBe(-3);
  });

  test('scales line- and page-mode deltas', () => {
    expect(wheelDeltaToPixels(2, 1, 400)).toBe(2 * WHEEL_LINE_HEIGHT_PX);
    expect(wheelDeltaToPixels(0.5, 2, 400)).toBe(200);
  });

  test('is defensive about bad inputs', () => {
    expect(wheelDeltaToPixels(Number.NaN, 0, 400)).toBe(0);
    // A zero-height axis must not zero out (or NaN) a page-mode delta.
    expect(wheelDeltaToPixels(1, 2, 0)).toBe(1);
  });
});
