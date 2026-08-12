import { describe, expect, test } from 'bun:test';

import { deviceScreenClipPath } from '../dashboard/deviceScreenClipPath';

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
    expect(clipPath).toContain('9.552cqw 0 from start / 0 -9.552cqw from end');
    expect(superellipseParameter(clipPath, 14.066)).toBeCloseTo(1.3, 3);
    expect(clipPath).toEndWith('close)');
  });

  test('uses circular Bézier controls for Android corners', () => {
    const clipPath = deviceScreenClipPath(2.564, false);

    expect(clipPath).toContain('1.416cqw 0 from start / 0 -1.416cqw from end');
    expect(superellipseParameter(clipPath, 2.564)).toBeCloseTo(1, 3);
  });
});
