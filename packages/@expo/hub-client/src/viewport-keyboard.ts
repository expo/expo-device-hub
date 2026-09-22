/**
 * Phone-keyboard detection via the visual viewport, ported from serve-sim's
 * `utils/simulator-resize.ts`. Mobile browsers shrink `visualViewport.height`
 * (but not `window.innerHeight`) while the soft keyboard is raised.
 */

/** Minimum viewport shrink that counts as a raised soft keyboard. */
export const KEYBOARD_VIEWPORT_SHRINK_PX = 120;

export function isVisualViewportKeyboardRaised(
  windowInnerHeight: number,
  visualViewportHeight: number,
): boolean {
  return (
    windowInnerHeight > 0 &&
    visualViewportHeight > 0 &&
    windowInnerHeight - visualViewportHeight >= KEYBOARD_VIEWPORT_SHRINK_PX
  );
}

export function readNativeKeyboardRaised(): boolean {
  if (typeof window === 'undefined') return false;
  const vv = window.visualViewport;
  return isVisualViewportKeyboardRaised(window.innerHeight, vv?.height ?? window.innerHeight);
}
