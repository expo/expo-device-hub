import { type FocusEvent } from 'react';

/**
 * Whether a focus event should show a visible focus ring. Mirrors the
 * `:focus-visible` heuristic, so a pointer click does not leave a control
 * looking pressed while keyboard focus still gets its ring.
 */
export function isFocusVisible(event: FocusEvent<HTMLElement>): boolean {
  try {
    return event.currentTarget.matches(':focus-visible');
  } catch {
    return true;
  }
}
