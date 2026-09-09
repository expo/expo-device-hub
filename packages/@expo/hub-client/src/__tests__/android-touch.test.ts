import { describe, expect, test } from 'bun:test';

import { androidTouchMessage } from '../android-touch';

const A = { x: 0.25, y: 0.5 };

describe('serve-emu touch wire messages', () => {
  test('maps each gesture phase to its wire action', () => {
    expect(androidTouchMessage('begin', A, 0).action).toBe('down');
    expect(androidTouchMessage('move', A, 0).action).toBe('move');
    expect(androidTouchMessage('end', A, 0).action).toBe('up');
  });

  test('reproduces the payload the hook sent before this module existed', () => {
    expect(androidTouchMessage('begin', A, 0)).toEqual({
      type: 'touch',
      action: 'down',
      x: 0.25,
      y: 0.5,
      pointerId: 0,
    });
  });

  test('carries the pointer id it is given', () => {
    expect(androidTouchMessage('move', { x: 0.75, y: 0.5 }, 1)).toEqual({
      type: 'touch',
      action: 'move',
      x: 0.75,
      y: 0.5,
      pointerId: 1,
    });
  });

  test('passes unit coordinates through unrounded', () => {
    expect(androidTouchMessage('move', { x: 0.123, y: 0.877 }, 0)).toEqual({
      type: 'touch',
      action: 'move',
      x: 0.123,
      y: 0.877,
      pointerId: 0,
    });
  });
});
