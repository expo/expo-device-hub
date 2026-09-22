import { describe, expect, test } from 'bun:test';

import {
  HID_EDGE_BOTTOM,
  HOME_INDICATOR_BAND_NORM,
  homeIndicatorEdge,
  rawDeltaForDisplayDelta,
  rawPointForDisplayPoint,
} from '../orientation';

describe('homeIndicatorEdge', () => {
  test('tags a pointer begin inside the bottom band as the home-indicator edge', () => {
    expect(homeIndicatorEdge({ y: HOME_INDICATOR_BAND_NORM })).toBe(HID_EDGE_BOTTOM);
    expect(homeIndicatorEdge({ y: 0.99 })).toBe(HID_EDGE_BOTTOM);
  });

  test('leaves a begin above the band alone', () => {
    expect(homeIndicatorEdge({ y: 0.5 })).toBeUndefined();
    expect(homeIndicatorEdge({ y: HOME_INDICATOR_BAND_NORM - 0.001 })).toBeUndefined();
  });

  test('never tags a sample that opted out of edge gestures', () => {
    expect(homeIndicatorEdge({ y: 0.99, edgeGestures: false })).toBeUndefined();
  });
});

describe('rawDeltaForDisplayDelta', () => {
  test('is the linear part of the point mapping', () => {
    // Moving from (0.5, 0.5) by (dx, dy) in display space must land where the
    // point mapping puts (0.5 + dx, 0.5 + dy).
    const dx = 0.1;
    const dy = -0.2;
    for (const orientation of [
      'portrait',
      'landscape_left',
      'landscape_right',
      'portrait_upside_down',
    ] as const) {
      const origin = rawPointForDisplayPoint(orientation, 0.5, 0.5);
      const moved = rawPointForDisplayPoint(orientation, 0.5 + dx, 0.5 + dy);
      const delta = rawDeltaForDisplayDelta(orientation, dx, dy);
      expect(delta.dx).toBeCloseTo(moved.x - origin.x);
      expect(delta.dy).toBeCloseTo(moved.y - origin.y);
    }
  });

  test('leaves portrait deltas untouched', () => {
    expect(rawDeltaForDisplayDelta(undefined, 0.25, 0.5)).toEqual({ dx: 0.25, dy: 0.5 });
  });
});
