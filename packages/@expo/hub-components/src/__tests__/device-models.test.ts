import { describe, expect, test } from "bun:test";
import { type DeviceClient, streamGeometry } from "@expo/hub-client";

import { DEVICE_MODEL_IDS, isDeviceModelId } from "../dashboard/data";
import {
  DEVICE_MODELS,
  deviceModelFor,
  deviceModelPreview,
  type DeviceModelDisplay,
  modelDisplay,
} from "../foldable/device-models";
import { duoStreamConfig, streamedPanel } from "../foldable/duo-displays";
import { duoScreenMapping, modelFrameRotation, orientationDegrees } from "../foldable/duo-pose";
import { duoStageMaxSide, modelStageMaxSide } from "../foldable/duo-stage";
import { deviceModelView } from "../foldable/duo-view";

const ASSETS = Object.fromEntries(DEVICE_MODEL_IDS.map((id) => [id, `https://hub.test/${id}.glb`]));

describe("model descriptions", () => {
  test("describe every model id, and nothing else", () => {
    expect(Object.keys(DEVICE_MODELS).sort()).toEqual([...DEVICE_MODEL_IDS].sort());
    for (const id of DEVICE_MODEL_IDS) expect(DEVICE_MODELS[id].id).toBe(id);
    expect(isDeviceModelId("ios:iphone-duo")).toBe(true);
    expect(isDeviceModelId("ios:iphone-17-pro")).toBe(false);
    expect(deviceModelFor("ios:iphone-17-pro" as never)).toBeNull();
    expect(deviceModelFor(null)).toBeNull();
  });

  test("give each texture the shape of its glass", () => {
    const displays = Object.values(DEVICE_MODELS).flatMap((model) =>
      [model.displays.main, model.displays.cover].filter(
        (display): display is DeviceModelDisplay => !!display,
      ),
    );
    for (const { size, mount, texture } of displays) {
      // A display mounted on its side has a glass with the framebuffer's other aspect.
      const glass = mount ? size.height / size.width : size.width / size.height;
      expect(texture.width / texture.height).toBeCloseTo(glass, 2);
    }
  });

  test("keep the iPhone Duo's panels and stage as Xcode's model had them", () => {
    const duo = DEVICE_MODELS["ios:iphone-duo"];
    expect(duo.streams).toBe("displays");
    expect(duo.displays.main).toMatchObject({ mount: 1, texture: { width: 1600, height: 1125 } });
    expect(duo.displays.cover).toMatchObject({ mount: 0, texture: { width: 784, height: 1140 } });
    // The cover's long side at the 480 px cap plus two 32 px insets, as before.
    expect(duoStageMaxSide(480).toFixed(3)).toBe("762.369");
    // A phone's stage follows its own display.
    expect(modelStageMaxSide(DEVICE_MODELS["ios:iphone-18-pro"], 480)).toBeCloseTo(
      (480 * 2622) / 1206 + 64,
    );
  });
});

describe("which model display a stream shows", () => {
  const fold = DEVICE_MODELS["android:pixel-9-pro-fold"];

  test("a stream that names its display keeps the panel it names", () => {
    expect(duoStreamConfig({ width: 1398, height: 2034, display: "cover" })?.screenId).toBe(1);
    expect(duoStreamConfig({ width: 2007, height: 2853, display: "inner" })?.screenId).toBe(3);
  });

  test("the Pixel 9 Pro Fold's frame shape tells its cover from its inner display, in any orientation", () => {
    expect(streamedPanel(fold, { width: 1080, height: 2424 })).toBe(1);
    expect(streamedPanel(fold, { width: 2424, height: 1080 })).toBe(1);
    // serve-emu can scale frames down.
    expect(streamedPanel(fold, { width: 570, height: 1280 })).toBe(1);
    expect(streamedPanel(fold, { width: 2076, height: 2152 })).toBe(3);
    expect(streamedPanel(fold, { width: 2152, height: 2076 })).toBe(3);
    expect(duoStreamConfig({ width: 1080, height: 2424 }, fold)?.screenId).toBe(1);
  });

  test("a phone shows its one display, and the Duo waits for the display its stream names", () => {
    expect(streamedPanel(DEVICE_MODELS["android:pixel-9-pro"], { width: 2856, height: 1280 })).toBe(
      3,
    );
    const duo = DEVICE_MODELS["ios:iphone-duo"];
    expect(duoStreamConfig({ width: 1398, height: 2034 }, duo)?.screenId).toBeUndefined();
  });
});

describe("when a device gets the 3D preview", () => {
  const duoClient = {
    fold: { pending: false, error: null, setControl() {} },
    displays: [],
  } as unknown as DeviceClient;
  const flatClient = { fold: null, displays: null } as unknown as DeviceClient;

  test("a phone or an Android foldable needs only its model file", () => {
    for (const id of [
      "ios:iphone-18-pro",
      "android:pixel-9-pro",
      "android:pixel-9-pro-fold",
    ] as const) {
      expect(deviceModelPreview({ deviceModel: id }, flatClient, ASSETS)?.url).toBe(ASSETS[id]);
    }
  });

  test("the iPhone Duo also needs its fold state and both display streams", () => {
    expect(deviceModelPreview({ deviceModel: "ios:iphone-duo" }, flatClient, ASSETS)).toBeNull();
    expect(deviceModelPreview({ deviceModel: "ios:iphone-duo" }, duoClient, ASSETS)?.model.id).toBe(
      "ios:iphone-duo",
    );
  });

  test("a device without a model, or a consumer without its file, stays flat", () => {
    expect(deviceModelPreview({ deviceModel: null }, flatClient, ASSETS)).toBeNull();
    expect(deviceModelPreview({}, flatClient, ASSETS)).toBeNull();
    expect(deviceModelPreview({ deviceModel: "ios:iphone-18-pro" }, flatClient, {})).toBeNull();
    expect(deviceModelPreview({ deviceModel: "ios:iphone-18-pro" }, null, ASSETS)).toBeNull();
  });
});

describe("a turned device", () => {
  test("orientationDegrees is the turn the flat view gives a raw portrait frame", () => {
    for (const orientation of [
      "portrait",
      "landscape_left",
      "landscape_right",
      "portrait_upside_down",
    ] as const) {
      expect(streamGeometry({ width: 1206, height: 2622, orientation }).rotationDegrees).toBe(
        orientationDegrees(orientation),
      );
    }
  });

  test("the model rolls with the device, so an upright frame reads upright", () => {
    const roll = (mount: number, orientation: Parameters<typeof deviceModelView>[2]) => {
      const [, , z, w] = deviceModelView(180, mount, orientation).rotation;
      return Math.round((2 * Math.atan2(z, w) * 180) / Math.PI);
    };
    expect(roll(0, "portrait")).toBe(0);
    // The flat view turns a landscape-left frame 90° clockwise; the model turns the same way.
    expect(roll(0, "landscape_left")).toBe(-90);
    expect(roll(0, "landscape_right")).toBe(90);
    // The Duo's inner display is mounted on its side, so its portrait UI needs a quarter turn.
    expect(roll(1, "portrait")).toBe(90);
  });

  test("an upright frame of a turned phone is painted back onto its portrait glass", () => {
    // Android sends upright frames: a landscape-left frame is 2856 x 1280.
    const config = {
      width: 2856,
      height: 1280,
      orientation: "landscape_left" as const,
      framesUpright: true,
      screenId: 3,
    };
    const phone = DEVICE_MODELS["android:pixel-9-pro"];
    const rotation = modelFrameRotation(phone, config);
    const mapping = duoScreenMapping(config, 717, 1600, rotation);
    // Turned back by a quarter, the frame fills the portrait glass.
    expect(mapping.drawnWidth).toBeCloseTo(1600, 0);
    expect(mapping.drawnHeight).toBeCloseTo((1600 * 1280) / 2856, 0);
    // A raw portrait frame of the same device is already in the hardware's orientation.
    const raw = { ...config, width: 1280, height: 2856, framesUpright: false };
    expect(modelFrameRotation(phone, raw)).toBe(0);
  });

  test("an upright frame turns back against the device's turn, as the model rolls with it", () => {
    // These directions were checked in the Hub: Chrome in landscape on a Pixel 9
    // Pro lay on its side with its camera beside Android's cutout. A flipped
    // sign paints the frame upside down and sends taps to the wrong points.
    const phone = DEVICE_MODELS["android:pixel-9-pro"];
    const upright = (orientation: "portrait" | "landscape_left" | "landscape_right") => {
      const landscape = orientation !== "portrait";
      const size = landscape ? { width: 2856, height: 1280 } : { width: 1280, height: 2856 };
      const config = { ...size, orientation, framesUpright: true, screenId: 3 };
      return Math.round((modelFrameRotation(phone, config) * 180) / Math.PI);
    };
    expect(upright("portrait")).toBe(0);
    expect(upright("landscape_left")).toBe(-orientationDegrees("landscape_left"));
    expect(upright("landscape_right")).toBe(-orientationDegrees("landscape_right"));
    expect(upright("landscape_left")).toBe(-upright("landscape_right"));
    // The Duo streams each display on its own; only the inner display's mount turns it.
    const duo = DEVICE_MODELS["ios:iphone-duo"];
    const inner = {
      width: 2034,
      height: 1398,
      orientation: "landscape_left" as const,
      screenId: 3,
    };
    expect(Math.round((modelFrameRotation(duo, inner) * 180) / Math.PI)).toBe(
      (modelDisplay(duo, 3)?.mount ?? 0) * 90,
    );
  });
});
