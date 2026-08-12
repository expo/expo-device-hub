import { describe, expect, test } from 'bun:test';

import { deviceScreenClipPath } from '../dashboard/deviceScreenClipPath';

describe('deviceScreenClipPath', () => {
  test('builds a responsive iOS superellipse', () => {
    const clipPath = deviceScreenClipPath(14.066, true);

    expect(clipPath).toStartWith('shape(from 14.066cqw 0');
    expect(clipPath).toContain('calc(100% - 14.066cqw)');
    expect(clipPath).toContain('9.613cqw 0 from start / 0 -9.613cqw from end');
    expect(clipPath).toEndWith('close)');
  });

  test('uses circular Bézier controls for Android corners', () => {
    const clipPath = deviceScreenClipPath(2.564, false);

    expect(clipPath).toContain('1.416cqw 0 from start / 0 -1.416cqw from end');
  });
});
