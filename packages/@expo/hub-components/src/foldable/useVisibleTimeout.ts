import { useEffect, useRef } from "react";

/**
 * Call `onTimeout` once `active` has lasted `ms` in a visible tab. A hidden
 * tab stops the wait, and the wait starts again when the tab is visible, as
 * hub-client's screen load timeout does.
 */
export function useVisibleTimeout(active: boolean, ms: number, onTimeout: () => void): void {
  const callback = useRef(onTimeout);
  callback.current = onTimeout;
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (typeof document !== "undefined" && document.hidden) return;
      timer = setTimeout(() => callback.current(), ms);
    };
    arm();
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", arm);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", arm);
    };
  }, [active, ms]);
}
