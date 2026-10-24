import { useLayoutEffect, useRef, type RefObject } from "react";
import { animateLayoutTransition, type LayoutTransitionState } from "../utils/layout-transition";
import { SIMULATOR_RESIZE_PRESENTATION_TRANSITION } from "../utils/simulator-resize";

export function useFlipLayout(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
  layoutWidth: number,
  layoutHeight: number,
  viewportHeight: number,
  phoneKeyboardRaised: boolean,
  scaling: boolean,
  continuous = false,
  viewportWidth = 0,
) {
  const prevRef = useRef<DOMRectReadOnly | null>(null);
  const mobileRef = useRef<LayoutTransitionState>({ bounds: null, active: null });
  const readyRef = useRef(false);
  const previousModeRef = useRef(scaling);
  const firstFrameRef = useRef<number | null>(null);
  useLayoutEffect(
    () => () => {
      mobileRef.current.active?.animation.cancel();
      if (firstFrameRef.current !== null) cancelAnimationFrame(firstFrameRef.current);
    },
    [],
  );

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (continuous) {
      const changingMode = previousModeRef.current !== scaling;
      previousModeRef.current = scaling;
      animateLayoutTransition(
        el,
        mobileRef.current,
        !enabled ||
          !readyRef.current ||
          (!changingMode && !mobileRef.current.active) ||
          window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      );
      // The initial measured fit may commit twice before paint. Fit it directly;
      // only presentation changes and their interruptions should animate.
      if (!readyRef.current && firstFrameRef.current === null) {
        firstFrameRef.current = requestAnimationFrame(() => {
          readyRef.current = true;
          firstFrameRef.current = null;
        });
      }
      prevRef.current = null;
      return;
    }
    previousModeRef.current = scaling;
    mobileRef.current.active?.animation.cancel();
    mobileRef.current.active = null;
    readyRef.current = false;
    if (firstFrameRef.current !== null) cancelAnimationFrame(firstFrameRef.current);
    firstFrameRef.current = null;
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
  }, [
    continuous,
    enabled,
    layoutHeight,
    layoutWidth,
    phoneKeyboardRaised,
    ref,
    scaling,
    viewportHeight,
    viewportWidth,
  ]);
}
