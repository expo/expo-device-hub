import { type RefObject, useLayoutEffect, useState } from "react";

/**
 * The rendered height of an element in px, kept current as it resizes. It is
 * `initial` until the element is measured, and while `enabled` is false.
 */
export function useElementHeight(
  ref: RefObject<HTMLElement | null>,
  initial: number,
  enabled = true,
): number {
  const [height, setHeight] = useState(initial);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!enabled || !element || typeof ResizeObserver === "undefined") return;
    const measure = () => setHeight(element.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, enabled]);
  return height;
}
