import { describe, expect, test } from 'bun:test';

import { screenConfigsEqual } from '../screen-config';

describe('screenConfigsEqual', () => {
  const inner = { width: 2007, height: 2853, orientation: 'portrait' as const, screenId: 3 };

  test('treats a missing previous config as a change', () => {
    expect(screenConfigsEqual(null, inner)).toBe(false);
    expect(screenConfigsEqual(inner, { ...inner })).toBe(true);
  });

  test('reports a display switch even when both screens have the same dimensions', () => {
    expect(screenConfigsEqual({ ...inner, screenId: 1 }, inner)).toBe(false);
  });

  test('reports hinge movement, a pose change, and Table Mode at the same geometry', () => {
    const open = { ...inner, supportsHingeAngle: true, hingeAngle: 180, hingePose: 'open' as const };
    expect(screenConfigsEqual(open, { ...open, hingeAngle: 90 })).toBe(false);
    expect(screenConfigsEqual(open, { ...open, hingePose: null })).toBe(false);
    expect(screenConfigsEqual(open, { ...open, tableMode: true })).toBe(false);
    expect(screenConfigsEqual(open, { ...open, tableModeAvailable: true })).toBe(false);
  });

  test('reports capability, physical orientation, and input availability changes', () => {
    expect(screenConfigsEqual(inner, { ...inner, supportsHingeAngle: true })).toBe(false);
    expect(screenConfigsEqual(inner, { ...inner, supportsPhysicalOrientation: true })).toBe(false);
    expect(screenConfigsEqual(inner, { ...inner, physicalOrientation: 'facedown' })).toBe(false);
    expect(screenConfigsEqual(inner, { ...inner, inputUnavailable: true })).toBe(false);
  });
});
