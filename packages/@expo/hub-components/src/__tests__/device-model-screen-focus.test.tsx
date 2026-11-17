import { afterEach, expect, mock, test } from "bun:test";
import { type DeviceClient } from "@expo/hub-client";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { DEVICE_MODELS } from "../foldable/device-models";
import * as scene from "../foldable/duo-scene";
import { createGlobalStubs } from "./test-globals";

// The real scene needs WebGL; this test only presses the model's host. The mock
// is shared with other test files, so it fakes the scene only for this test.
const realCreateDuoScene = scene.createDuoScene;
let fakeScene = false;
mock.module("../foldable/duo-scene", () => ({
  ...scene,
  createDuoScene: (...args: Parameters<typeof scene.createDuoScene>) =>
    fakeScene ? { dispose() {} } : realCreateDuoScene(...args),
}));
const { DeviceModelScreen } = await import("../foldable/DeviceModelScreen");

const { stubGlobal, restoreGlobals } = createGlobalStubs();
let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  fakeScene = false;
  restoreGlobals();
});

const client = {
  platform: "android",
  status: "streaming",
  framePresented: true,
  screen: { width: 1280, height: 2856, orientation: "portrait", framesUpright: true },
  fold: null,
  displays: null,
  orientation: "portrait",
  capabilities: { fold: false, clipboard: false },
  videoKind: "canvas",
  attachVideo: () => {},
  cancelInput: () => {},
  sendTouch: () => {},
  sendMultiTouch: () => {},
  sendScroll: () => {},
} as unknown as DeviceClient;

async function press(preserveKeyboardFocus: boolean) {
  fakeScene = true;
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubGlobal("document", {
    hidden: false,
    activeElement: null,
    addEventListener() {},
    removeEventListener() {},
  });
  let focused = 0;
  await act(async () => {
    renderer = create(
      <DeviceModelScreen
        client={client}
        model={DEVICE_MODELS["android:pixel-9-pro"]}
        modelUrl="https://hub.test/model.glb"
        preserveKeyboardFocus={preserveKeyboardFocus}
      />,
      {
        createNodeMock: () => ({
          focus: () => focused++,
          contains: () => false,
          addEventListener() {},
          removeEventListener() {},
        }),
      },
    );
  });
  const host = renderer!.root.findByProps({ role: "application" });
  await act(async () => host.props.onPointerDownCapture());
  return focused;
}

test("pressing the 3D screen takes the keyboard focus", async () => {
  expect(await press(false)).toBe(1);
});

test("pressing the 3D screen keeps an open mobile keyboard's focus, as the flat screen does", async () => {
  expect(await press(true)).toBe(0);
});
