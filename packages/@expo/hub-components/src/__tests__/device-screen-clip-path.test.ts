import { describe, expect, test } from 'bun:test';

import { deviceFrameLayout, deviceFrameRotation } from '../dashboard/deviceFrame';
import { deviceFrameScreenClipPath, deviceScreenClipPath } from '../dashboard/deviceScreenClipPath';

function superellipseParameter(clipPath: string, radius: number): number {
  const match = clipPath.match(/with ([\d.]+)cqw/);
  if (!match) throw new Error('Missing cubic control point');
  const halfCorner = 0.5 + 0.375 * (Number(match[1]) / radius);
  return Math.log2(Math.log(0.5) / Math.log(halfCorner));
}

describe('deviceScreenClipPath', () => {
  test('builds a responsive iOS superellipse', () => {
    const clipPath = deviceScreenClipPath(14.066, true);

    expect(clipPath).toStartWith('shape(from 14.066cqw -0.5px');
    expect(clipPath).toContain('calc(100% - 14.066cqw)');
    expect(clipPath).toContain('calc(14.066cqw - 0.5px)');
    expect(clipPath).toContain('calc(100% - 14.066cqw + 0.5px)');
    expect(clipPath).toContain('calc(100% + 0.5px)');
    expect(clipPath).toContain('8.391cqw 0 from start / 0 -8.391cqw from end');
    expect(superellipseParameter(clipPath, 14.066)).toBeCloseTo(1.1, 3);
    expect(clipPath).toEndWith('close)');
  });

  test('uses circular Bézier controls for Android corners', () => {
    const clipPath = deviceScreenClipPath(2.564, false);

    expect(clipPath).toContain('1.416cqw 0 from start / 0 -1.416cqw from end');
    expect(superellipseParameter(clipPath, 2.564)).toBeCloseTo(1, 3);
  });

  test('uses the artwork-specific iPhone superellipse for a framed opening', () => {
    const clipPath = deviceFrameScreenClipPath(21.227, 9.764, 1.57);

    expect(clipPath).toStartWith('shape(from 21.227% -0.5px');
    expect(clipPath).toContain('calc(100% - 21.227%)');
    expect(clipPath).toContain('calc(9.764% - 0.5px)');
    expect(clipPath).toEndWith('close)');
  });
});

describe('device frame layout', () => {
  const pixel = {
    width: 1250,
    height: 2631,
    screen: { x: 50, y: 48, width: 1138, height: 2532 },
  };

  test('maps asymmetric Pixel insets through every quarter turn', () => {
    expect(deviceFrameLayout(pixel, 0)).toEqual({ ...pixel, rotation: 0 });
    expect(deviceFrameLayout(pixel, 90)).toEqual({
      width: 2631,
      height: 1250,
      rotation: 90,
      screen: { x: 51, y: 50, width: 2532, height: 1138 },
    });
    expect(deviceFrameLayout(pixel, -90)).toEqual({
      width: 2631,
      height: 1250,
      rotation: -90,
      screen: { x: 48, y: 62, width: 2532, height: 1138 },
    });
    expect(deviceFrameLayout(pixel, 180)).toEqual({
      width: 1250,
      height: 2631,
      rotation: 180,
      screen: { x: 62, y: 51, width: 1138, height: 2532 },
    });
  });

  test('follows reported orientation and falls back to display aspect', () => {
    expect(deviceFrameRotation('landscape_left', 0.45)).toBe(90);
    expect(deviceFrameRotation('landscape_right', 0.45)).toBe(-90);
    expect(deviceFrameRotation('portrait_upside_down', 0.45)).toBe(180);
    expect(deviceFrameRotation(undefined, 2)).toBe(90);
    expect(deviceFrameRotation(undefined, 0.45)).toBe(0);
  });
});
