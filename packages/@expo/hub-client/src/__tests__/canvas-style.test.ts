import { describe, expect, it } from 'bun:test';

import { withCanvasSeamOvershoot } from '../canvas-style';

describe('withCanvasSeamOvershoot', () => {
  it('overshoots a canvas without changing its base media style', () => {
    const style = { width: '100%', height: '100%' } as const;

    expect(withCanvasSeamOvershoot(style)).toEqual({
      ...style,
      transform: ' scale(1.004)',
    });
    expect(style).not.toHaveProperty('transform');
  });

  it('composes the overshoot with a rotated canvas transform', () => {
    const transform = 'translate(-50%, -50%) rotate(90deg)';

    expect(withCanvasSeamOvershoot({ transform }).transform).toBe(`${transform} scale(1.004)`);
  });
});
