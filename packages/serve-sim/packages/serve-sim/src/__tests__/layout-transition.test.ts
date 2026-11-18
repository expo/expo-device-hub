import { describe, expect, test } from "bun:test";
import {
  animateLayoutTransition,
  type LayoutTransitionState,
} from "../client/utils/layout-transition";

function fixture() {
  let bounds = { left: 50, top: 100, width: 100, height: 200 };
  let progress: number | null = 0;
  let canceled = 0;
  const frames: Keyframe[][] = [];
  const animations: Animation[] = [];
  const element = {
    getBoundingClientRect: () => ({ ...bounds }),
    animate: (keyframes: Keyframe[]) => {
      frames.push(keyframes);
      const animation = {
        effect: { getComputedTiming: () => ({ progress }) },
        playState: "running",
        cancel: () => canceled++,
        onfinish: null,
      } as unknown as Animation;
      animations.push(animation);
      return animation;
    },
  } as unknown as HTMLElement;
  const state: LayoutTransitionState = { bounds: null, active: null };
  return {
    element,
    state,
    frames,
    animations,
    move: () => {
      bounds = { left: 0, top: 0, width: 200, height: 400 };
    },
    restore: () => {
      bounds = { left: 50, top: 100, width: 100, height: 200 };
    },
    progress: (value: number | null) => {
      progress = value;
    },
    canceled: () => canceled,
  };
}

describe("mobile layout transitions", () => {
  test("starts at the previous geometry and keeps one animation owner", () => {
    const f = fixture();
    animateLayoutTransition(f.element, f.state, false);
    expect(f.frames).toHaveLength(0);
    f.move();
    animateLayoutTransition(f.element, f.state, false);
    expect(f.frames[0]?.[0]).toEqual({
      transformOrigin: "0 0",
      transform: "translate(50px, 100px) scale(0.5, 0.5)",
    });
  });

  test("reverses from its visible intermediate bounds instead of its old target", () => {
    const f = fixture();
    animateLayoutTransition(f.element, f.state, false);
    f.move();
    animateLayoutTransition(f.element, f.state, false);
    f.progress(0.4);
    f.restore();
    animateLayoutTransition(f.element, f.state, false);
    expect(f.canceled()).toBe(1);
    expect(f.frames[1]?.[0]).toEqual({
      transformOrigin: "0 0",
      transform: "translate(-20px, -40px) scale(1.4, 1.4)",
    });
  });

  test("retargets an unpainted animation from the same starting bounds", () => {
    const f = fixture();
    animateLayoutTransition(f.element, f.state, false);
    f.move();
    animateLayoutTransition(f.element, f.state, false);
    f.progress(null);
    f.restore();
    animateLayoutTransition(f.element, f.state, false);
    expect(f.frames).toHaveLength(1);
    expect(f.state.active).toBeNull();
  });

  test("fits initial layout and reduced motion directly, canceling any running animation", () => {
    const f = fixture();
    animateLayoutTransition(f.element, f.state, true);
    f.move();
    animateLayoutTransition(f.element, f.state, true);
    expect(f.frames).toHaveLength(0);
    f.restore();
    animateLayoutTransition(f.element, f.state, false);
    f.move();
    animateLayoutTransition(f.element, f.state, true);
    expect(f.canceled()).toBe(1);
    expect(f.state.active).toBeNull();
  });
});
