import { useLayoutEffect, useRef, type RefObject } from "react";
import { SIMULATOR_RESIZE_PRESENTATION_TRANSITION } from "../utils/simulator-resize";

export function useFlipLayout(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
  layoutWidth: number,
  layoutHeight: number,
  viewportHeight: number,
  phoneKeyboardRaised: boolean,
  scaling: boolean,
) {
  const prevRef = useRef<DOMRectReadOnly | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const next = el.getBoundingClientRect();
    const prev = prevRef.current;
    prevRef.current = next;
    if (!enabled || prev == null) return;
    if (prev.width < 1 || next.width < 1 || prev.height < 1 || next.height < 1) return;

    const dx = prev.left - next.left;
    const dy = prev.top - next.top;
    const sx = prev.width / next.width;
    const sy = prev.height / next.height;
    if (
      Math.abs(dx) < 0.5 &&
      Math.abs(dy) < 0.5 &&
      Math.abs(sx - 1) < 0.002 &&
      Math.abs(sy - 1) < 0.002
    ) {
      return;
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    el.style.transition = "none";
    el.style.transformOrigin = "0 0";
    el.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
    void el.getBoundingClientRect();

    const raf = requestAnimationFrame(() => {
      el.style.transition = SIMULATOR_RESIZE_PRESENTATION_TRANSITION;
      el.style.transform = "translate(0px, 0px) scale(1, 1)";
    });

    const clear = () => {
      el.style.transition = "";
      el.style.transform = "";
      el.style.transformOrigin = "";
    };
    const onEnd = (event: TransitionEvent) => {
      if (event.target !== el || event.propertyName !== "transform") return;
      el.removeEventListener("transitionend", onEnd);
      clear();
    };
    el.addEventListener("transitionend", onEnd);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("transitionend", onEnd);
      clear();
    };
  }, [enabled, layoutHeight, layoutWidth, phoneKeyboardRaised, ref, scaling, viewportHeight]);
}
