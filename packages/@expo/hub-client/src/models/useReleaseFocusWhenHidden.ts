import { type RefObject, useEffect } from "react";

/**
 * Move focus out of `host` when it becomes hidden, for example when a token
 * or server change loads the same device's 3D preview again: a hidden control
 * must not keep the keyboard, and browsers refuse `aria-hidden` on focus.
 * The blur reaches the host's own `onBlur`, which releases held keys.
 */
export function useReleaseFocusWhenHidden(host: RefObject<HTMLElement | null>, hidden: boolean) {
  useEffect(() => {
    if (!hidden || typeof document === "undefined") return;
    const active = document.activeElement as HTMLElement | null;
    if (active && host.current?.contains(active)) active.blur();
  }, [host, hidden]);
}
