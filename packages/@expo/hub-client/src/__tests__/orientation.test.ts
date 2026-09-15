import { describe, expect, test } from 'bun:test';

import { HID_EDGE_BOTTOM, HOME_INDICATOR_BAND_NORM, homeIndicatorEdge } from '../orientation';

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
