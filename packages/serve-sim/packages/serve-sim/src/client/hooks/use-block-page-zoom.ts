import { useEffect } from "react";

const GESTURE_EVENTS = ["gesturestart", "gesturechange", "gestureend"] as const;

export function useBlockPageZoom(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const prevent = (event: Event) => event.preventDefault();
    for (const name of GESTURE_EVENTS) {
      document.addEventListener(name, prevent, { passive: false });
    }
    return () => {
      for (const name of GESTURE_EVENTS) document.removeEventListener(name, prevent);
    };
  }, [enabled]);
}
