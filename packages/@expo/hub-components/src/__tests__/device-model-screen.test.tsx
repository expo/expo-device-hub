import { describe, expect, test } from "bun:test";
import { type DeviceClient } from "@expo/hub-client";
import { renderToStaticMarkup } from "react-dom/server";

import { DEVICE_MODELS, type DeviceModelDescription } from "../foldable/device-models";
import { canMoveModelHinge, DeviceModelScreen } from "../foldable/DeviceModelScreen";
import { DUO_FOLD_CONTROLS } from "./duo-fixtures";

function client(overrides: Partial<DeviceClient>): DeviceClient {
  return {
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
    ...overrides,
  } as unknown as DeviceClient;
}

// Server rendering runs no effects, so the scene never starts and needs no WebGL.
function render(model: DeviceModelDescription, current: DeviceClient) {
  return renderToStaticMarkup(
    <DeviceModelScreen client={current} model={model} modelUrl="https://hub.test/model.glb" />,
  );
}

describe("DeviceModelScreen", () => {
  test("shows a phone's model over its flat stream, with no hinge handles", () => {
    const markup = render(DEVICE_MODELS["android:pixel-9-pro"], client({}));
    expect(markup).toContain('aria-label="Interactive Pixel 9 Pro.');
    expect(markup).toContain('aria-label="Pixel 9 Pro 3D preview"');
    // The flat stream's own element feeds the texture; no per-display panels.
    expect(markup).toContain("<canvas");
    expect(markup).not.toContain("data-duo-panel");
    expect(markup).not.toContain("Fold device");
  });

  test("shows the Pixel 9 Pro Fold at the posture its stream shows while Android reports no fold", () => {
    const fold = DEVICE_MODELS["android:pixel-9-pro-fold"];
    const closed = render(fold, client({ screen: { width: 1080, height: 2424 } }));
    expect(closed).toContain("Pixel 9 Pro Fold 3D preview, closed pose, 0 degrees");
    const open = render(fold, client({ screen: { width: 2076, height: 2152 } }));
    expect(open).toContain("Pixel 9 Pro Fold 3D preview, open pose, 180 degrees");
    // Without a fold the client cannot move the hinge, so the handles take no input.
    expect(open).toContain('aria-disabled="true"');
  });

  test("folds the Pixel 9 Pro Fold to Android's hinge angle, with handles that stop while recording", () => {
    const model = DEVICE_MODELS["android:pixel-9-pro-fold"];
    const android = client({
      screen: { width: 2076, height: 2152 },
      fold: { angle: 90, pose: "book", pending: false, error: null, setControl: () => {} },
      capabilities: {
        fold: {
          angle: { min: 0, max: 180 },
          poses: { closed: { angle: 0 }, book: { angle: 90 }, open: { angle: 180 } },
          tableMode: false,
        },
        clipboard: false,
      } as DeviceClient["capabilities"],
      recordingLock: null,
    });
    const markup = render(model, android);
    expect(markup).toContain("Pixel 9 Pro Fold 3D preview, book pose, 90 degrees");
    expect(markup).toContain('aria-label="Fold device"');
    // The handles take input only once the model loads, which server rendering
    // never does, so the gate is checked on its own.
    expect(canMoveModelHinge(model, android)).toBe(true);
    expect(canMoveModelHinge(model, { ...android, recordingLock: "recording" })).toBe(false);
    expect(canMoveModelHinge(model, { ...android, recordingLock: "status-unknown" })).toBe(false);
    expect(canMoveModelHinge(model, { ...android, fold: null })).toBe(false);
    expect(canMoveModelHinge(DEVICE_MODELS["android:pixel-9-pro"], android)).toBe(false);
  });

  test("keeps the iPhone Duo's displays, fold, and hinge handles", () => {
    const duo = DEVICE_MODELS["ios:iphone-duo"];
    const displays = [
      { id: "cover", active: true, attachVideo: () => {} },
      { id: "inner", active: false, attachVideo: () => {} },
    ];
    const ios = {
      platform: "ios" as const,
      videoKind: "img" as const,
      screen: { width: 1398, height: 2034, display: "cover" as const },
    };
    // Before the helper reports its hinge and displays, the Duo has no 3D preview.
    expect(render(duo, client(ios))).toBe("");
    const markup = render(
      duo,
      client({
        ...ios,
        fold: { angle: 0, pose: "closed", pending: false, error: null, setControl: () => {} },
        displays: displays as DeviceClient["displays"],
        capabilities: { fold: DUO_FOLD_CONTROLS, clipboard: false } as DeviceClient["capabilities"],
      }),
    );
    expect(markup).toContain('aria-label="Interactive iPhone Duo.');
    expect(markup).toContain('data-duo-panel="1"');
    expect(markup).toContain('data-duo-panel="3"');
    expect(markup).toContain("iPhone Duo 3D preview, closed pose, 0 degrees");
    expect(markup).toContain('aria-label="Fold device"');
  });
});
