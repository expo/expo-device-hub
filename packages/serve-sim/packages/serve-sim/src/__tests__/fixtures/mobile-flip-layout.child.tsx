import { strict as assert } from "node:assert";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useFlipLayout } from "../../client/hooks/use-flip-layout";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let frame: FrameRequestCallback | undefined;
Object.assign(globalThis, {
  window: { matchMedia: () => ({ matches: false }) },
  requestAnimationFrame: (callback: FrameRequestCallback) => {
    frame = callback;
    return 1;
  },
  cancelAnimationFrame: () => {},
});
let bounds = { left: 100, top: 100, width: 200, height: 400 };
const keyframes: Keyframe[][] = [];
const ref = {
  current: {
    getBoundingClientRect: () => ({ ...bounds }),
    animate: (frames: Keyframe[]) => {
      keyframes.push(frames);
      return {
        cancel() {},
        effect: { getComputedTiming: () => ({ progress: 0 }) },
        onfinish: null,
      };
    },
  } as unknown as HTMLElement,
};
function Probe({ viewportWidth = 400, width = 200, height = 400, full = false }) {
  useFlipLayout(ref, true, width, height, 700, false, full, true, viewportWidth);
  return null;
}
let renderer: ReactTestRenderer;
await act(async () => {
  renderer = create(<Probe />);
});
frame?.(0);
bounds = { left: 150, top: 100, width: 200, height: 400 };
await act(async () => {
  renderer.update(<Probe viewportWidth={500} />);
});
assert.equal(keyframes.length, 0, "width-only recentering should update bounds without animating");
bounds = { left: 100, top: 0, width: 300, height: 600 };
await act(async () => {
  renderer.update(<Probe viewportWidth={500} width={300} height={600} full />);
});
assert.equal(
  keyframes[0]?.[0]?.transform,
  "translate(50px, 100px) scale(0.6666666666666666, 0.6666666666666666)",
  "start presentation at the current centered position, not the position before resize",
);
await act(async () => {
  renderer.unmount();
});
console.log("mobile presentation bounds passed");
