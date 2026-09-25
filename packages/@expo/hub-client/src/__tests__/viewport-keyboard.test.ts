import { describe, expect, test } from 'bun:test';

import { isVisualViewportKeyboardRaised, KEYBOARD_VIEWPORT_SHRINK_PX } from '../viewport-keyboard.js';

describe('isVisualViewportKeyboardRaised', () => {
  test('treats a large visual-viewport shrink as a raised soft keyboard', () => {
    expect(isVisualViewportKeyboardRaised(800, 800 - KEYBOARD_VIEWPORT_SHRINK_PX)).toBe(true);
    expect(isVisualViewportKeyboardRaised(800, 500)).toBe(true);
  });

  test('ignores small shrinks (browser chrome) and missing measurements', () => {
    expect(isVisualViewportKeyboardRaised(800, 800 - KEYBOARD_VIEWPORT_SHRINK_PX + 1)).toBe(false);
    expect(isVisualViewportKeyboardRaised(0, 500)).toBe(false);
    expect(isVisualViewportKeyboardRaised(800, 0)).toBe(false);
  });
});
