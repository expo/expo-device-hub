/**
 * Phone-keyboard detection via the visual viewport, ported from serve-sim's
 * `utils/simulator-resize.ts`. Mobile browsers shrink `visualViewport.height`
 * (but not `window.innerHeight`) while the soft keyboard is raised.
 */

// Compare heights at the same zoom scale: pinch zoom alone also reduces visual height.

/** Minimum viewport shrink that counts as a raised soft keyboard. */
export const KEYBOARD_VIEWPORT_SHRINK_PX = 120;

export function isVisualViewportKeyboardRaised(
  windowInnerHeight: number,
  visualViewportHeight: number,
  visualViewportScale = 1,
): boolean {
  return (
    windowInnerHeight > 0 &&
    visualViewportHeight > 0 &&
    visualViewportScale > 0 &&
    windowInnerHeight - visualViewportHeight * visualViewportScale >= KEYBOARD_VIEWPORT_SHRINK_PX
  );
}

export function readNativeKeyboardRaised(): boolean {
  if (typeof window === "undefined") return false;
  const vv = window.visualViewport;
  return isVisualViewportKeyboardRaised(
    window.innerHeight,
    vv?.height ?? window.innerHeight,
    vv?.scale ?? 1,
  );
}
