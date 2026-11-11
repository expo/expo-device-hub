import { afterEach, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { type DeviceClient } from "@expo/hub-client";
import { type Device } from "../dashboard/data";
import { PhoneFrame } from "../dashboard/PhoneFrame";
import { SHAKE_WOBBLE_MS, shakeWobbleKeyframes } from "../dashboard/shakeWobble";
import { createGlobalStubs } from "./test-globals";

const { stubGlobal, restoreGlobals } = createGlobalStubs();

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreGlobals();
});

const IPHONE: Device = {
  id: "iphone",
  name: "iPhone 17",
  version: "iOS 26.5",
  platform: "ios",
  booted: true,
  physical: false,
  supported: true,
};

const CLIENT = {
  status: "streaming",
  screen: { width: 1206, height: 2622 },
  displayCorners: null,
  fold: null,
  displays: null,
  deviceModelUrl: null,
  inputError: null,
} as unknown as DeviceClient;

const Screen = () => null;

type Played = {
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
  animation: { playState: AnimationPlayState; cancel(): void };
};

/** Mount a PhoneFrame whose frame element records the animations it is asked to play. */
async function mount({ reducedMotion = false } = {}) {
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubGlobal("window", {
    matchMedia: () => ({ matches: reducedMotion, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {},
    removeEventListener() {},
  });
  const played: Played[] = [];
  const frame = {
    animate(keyframes: Keyframe[], options: KeyframeAnimationOptions) {
      const animation = {
        playState: "running" as AnimationPlayState,
        cancel() {
          animation.playState = "idle";
        },
      };
      played.push({ keyframes, options, animation });
      return animation;
    },
  };
  const element = (shakeNonce: number) => (
    <PhoneFrame
      device={IPHONE}
      client={CLIENT}
      DeviceScreen={Screen}
      displayScreen={(screen) => screen ?? null}
      shakeNonce={shakeNonce}
    />
  );
  await act(async () => {
    renderer = create(element(3), {
      createNodeMock: (node) =>
        (node.props as { "data-testid"?: string })["data-testid"] === "device-screen-frame"
          ? frame
          : {},
    });
  });
  return {
    played,
    shake: (shakeNonce: number) => act(async () => renderer!.update(element(shakeNonce))),
  };
}

test("a shake wobbles the device frame once; mounting with an earlier shake does not", async () => {
  const { played, shake } = await mount();
  expect(played).toHaveLength(0);

  await shake(4);

  expect(played).toHaveLength(1);
  expect(played[0]!.options.duration).toBe(SHAKE_WOBBLE_MS);
  expect(played[0]!.keyframes).toEqual(shakeWobbleKeyframes());
});

test("a shake while the wobble runs does not restart it; the next one after it ends does", async () => {
  const { played, shake } = await mount();
  await shake(4);
  await shake(5);
  expect(played).toHaveLength(1);

  played[0]!.animation.playState = "finished";
  await shake(6);
  expect(played).toHaveLength(2);
});

test("with reduced motion a shake does not move the device", async () => {
  const { played, shake } = await mount({ reducedMotion: true });
  await shake(4);
  expect(played).toHaveLength(0);
});

test("the wobble tilts up to 2 degrees around a point near the bottom and ends at rest", () => {
  const frames = shakeWobbleKeyframes();
  const degrees = frames.map((frame) => Number.parseFloat(String(frame.rotate)));
  const slides = frames.map((frame) => Number.parseFloat(String(frame.translate)));

  expect(frames[0]).toMatchObject({ offset: 0 });
  expect(degrees[0]).toBe(0);
  expect(frames.at(-1)).toMatchObject({ offset: 1, rotate: "0deg", translate: "0px 0px" });
  expect(Math.max(...degrees.map(Math.abs))).toBeGreaterThan(1);
  expect(Math.max(...degrees.map(Math.abs))).toBeLessThanOrEqual(2);
  expect(Math.max(...slides.map(Math.abs))).toBeLessThanOrEqual(3);
  expect(new Set(frames.map((frame) => frame.transformOrigin))).toEqual(new Set(["50% 88%"]));
  for (let index = 1; index < frames.length; index++) {
    expect(frames[index]!.offset!).toBeGreaterThan(frames[index - 1]!.offset!);
  }
});
