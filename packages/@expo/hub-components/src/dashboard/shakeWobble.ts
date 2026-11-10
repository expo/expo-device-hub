import { useEffect, useRef, type RefObject } from "react";

import { usePrefersReducedMotion } from "../components/usePrefersReducedMotion";

/** How long one wobble lasts. Most of the motion is over after about 300 ms. */
export const SHAKE_WOBBLE_MS = 460;

const PEAK_DEGREES = 2;
/** The slide that goes with each degree of tilt, so the frame swings, not only turns. */
const SLIDE_PX_PER_DEGREE = 1.5;
const FREQUENCY_HZ = 5;
const DECAY_MS = 130;
/** A pivot near the bottom edge, where a hand holds a phone. */
const PIVOT = "50% 88%";
const SAMPLE_MS = 1000 / 120;

/**
 * The keyframes of one wobble: the motion of a spring that is hit once, a sine that decays,
 * sampled at 120 Hz so that linear timing between samples follows the curve. It starts at
 * rest at full speed, so the motion answers the click at once, and it ends at rest.
 */
export function shakeWobbleKeyframes(): Keyframe[] {
  const frames: Keyframe[] = [];
  for (let t = 0; t < SHAKE_WOBBLE_MS; t += SAMPLE_MS) {
    const degrees =
      PEAK_DEGREES * Math.exp(-t / DECAY_MS) * Math.sin((2 * Math.PI * FREQUENCY_HZ * t) / 1000);
    frames.push({
      offset: t / SHAKE_WOBBLE_MS,
      rotate: `${degrees.toFixed(3)}deg`,
      translate: `${(degrees * SLIDE_PX_PER_DEGREE).toFixed(2)}px 0px`,
      transformOrigin: PIVOT,
    });
  }
  frames.push({ offset: 1, rotate: "0deg", translate: "0px 0px", transformOrigin: PIVOT });
  return frames;
}

const KEYFRAMES = shakeWobbleKeyframes();

/**
 * Wobble the element once each time `shakeNonce` changes after mount. The animation uses the
 * individual `rotate` and `translate` properties, so it adds to any `transform` the element
 * has instead of replacing it. A change while a wobble runs does not restart it, because a
 * restart from rest would jump. With reduced motion the element does not move.
 */
// @ref LLP 0013#shake — reduced motion turns the wobble off with no substitute, by product choice
export function useShakeWobble(target: RefObject<HTMLElement | null>, shakeNonce?: number): void {
  const reducedMotion = usePrefersReducedMotion();
  const seen = useRef(shakeNonce);
  const running = useRef<Animation | null>(null);

  useEffect(() => {
    if (shakeNonce === seen.current) return;
    seen.current = shakeNonce;
    const element = target.current;
    if (reducedMotion || typeof element?.animate !== "function") return;
    if (running.current?.playState === "running") return;
    running.current = element.animate(KEYFRAMES, { duration: SHAKE_WOBBLE_MS, easing: "linear" });
  }, [shakeNonce, reducedMotion, target]);

  useEffect(() => () => running.current?.cancel(), []);
}
