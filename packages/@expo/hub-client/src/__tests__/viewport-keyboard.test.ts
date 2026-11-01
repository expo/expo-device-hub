import { describe, expect, test } from "bun:test";

import { isVisualViewportKeyboardRaised, KEYBOARD_VIEWPORT_SHRINK_PX } from "../viewport-keyboard";

describe("isVisualViewportKeyboardRaised", () => {
  test("treats a large visual-viewport shrink as a raised soft keyboard", () => {
    expect(isVisualViewportKeyboardRaised(800, 800 - KEYBOARD_VIEWPORT_SHRINK_PX)).toBe(true);
    expect(isVisualViewportKeyboardRaised(800, 500)).toBe(true);
  });

  test("distinguishes pinch zoom from a keyboard at the same scale", () => {
    expect(isVisualViewportKeyboardRaised(800, 400, 2)).toBe(false);
    expect(isVisualViewportKeyboardRaised(800, 800 / 1.5, 1.5)).toBe(false);
    expect(isVisualViewportKeyboardRaised(800, 250, 2)).toBe(true);
    expect(isVisualViewportKeyboardRaised(800, 340, 2)).toBe(true);
    expect(isVisualViewportKeyboardRaised(800, 341, 2)).toBe(false);
  });

  test("ignores small shrinks (browser chrome) and missing measurements", () => {
    expect(isVisualViewportKeyboardRaised(800, 800 - KEYBOARD_VIEWPORT_SHRINK_PX + 1)).toBe(false);
    expect(isVisualViewportKeyboardRaised(0, 500)).toBe(false);
    expect(isVisualViewportKeyboardRaised(800, 0)).toBe(false);
  });
});
