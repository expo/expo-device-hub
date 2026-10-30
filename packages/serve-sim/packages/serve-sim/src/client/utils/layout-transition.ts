import {
  SIMULATOR_RESIZE_PRESENTATION_EASING,
  SIMULATOR_RESIZE_PRESENTATION_TRANSITION_MS,
} from "./simulator-resize";

type Bounds = Pick<DOMRectReadOnly, "left" | "top" | "width" | "height">;
export type LayoutTransitionState = {
  bounds: Bounds | null;
  active: { animation: Animation; from: Bounds; to: Bounds } | null;
};

// @ref LLP 0000#mobile-serve-sim-layout — retarget a mobile transition from its visible geometry, never its previous target.
export function animateLayoutTransition(
  element: HTMLElement,
  state: LayoutTransitionState,
  skipAnimation: boolean,
) {
  let from = state.bounds;
  if (state.active) {
    const { animation, from: start, to } = state.active;
    const progress =
      animation.effect?.getComputedTiming().progress ??
      (animation.playState === "finished" ? 1 : 0);
    from = {
      left: start.left + (to.left - start.left) * progress,
      top: start.top + (to.top - start.top) * progress,
      width: start.width + (to.width - start.width) * progress,
      height: start.height + (to.height - start.height) * progress,
    };
    // React has already changed layout. Cancel before measuring the new target;
    // its bounding box must not include the old animation's transform.
    animation.cancel();
    state.active = null;
  }
  const next = element.getBoundingClientRect();
  state.bounds = next;
  if (
    skipAnimation ||
    !from ||
    from.width < 1 ||
    from.height < 1 ||
    next.width < 1 ||
    next.height < 1
  )
    return;
  const dx = from.left - next.left;
  const dy = from.top - next.top;
  const sx = from.width / next.width;
  const sy = from.height / next.height;
  if (
    Math.abs(dx) < 0.5 &&
    Math.abs(dy) < 0.5 &&
    Math.abs(sx - 1) < 0.002 &&
    Math.abs(sy - 1) < 0.002
  )
    return;
  const animation = element.animate(
    [
      { transformOrigin: "0 0", transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
      { transformOrigin: "0 0", transform: "translate(0px, 0px) scale(1, 1)" },
    ],
    {
      duration: SIMULATOR_RESIZE_PRESENTATION_TRANSITION_MS,
      easing: SIMULATOR_RESIZE_PRESENTATION_EASING,
    },
  );
  state.active = { animation, from, to: next };
  animation.onfinish = () => {
    if (state.active?.animation === animation) state.active = null;
  };
}
