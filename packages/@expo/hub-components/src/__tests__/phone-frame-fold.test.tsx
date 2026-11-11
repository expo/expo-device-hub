import { describe, expect, test } from "bun:test";
import { type DeviceClient, type DeviceFold } from "@expo/hub-client";
import { renderToStaticMarkup } from "react-dom/server";

import { PhoneFrame } from "../dashboard/PhoneFrame";
import { type Device } from "../dashboard/data";
import { type DeviceModelAssets } from "../foldable/device-models";

const device: Device = {
  id: "duo-1",
  name: "iPhone Duo",
  version: "iOS 27.1",
  platform: "ios",
  booted: true,
  physical: false,
  supported: true,
  deviceModel: "ios:iphone-duo",
};

const MODEL_ASSETS: DeviceModelAssets = {
  "ios:iphone-duo": "https://hub.test/assets/iphone-duo.glb",
  "ios:iphone-18-pro": "https://hub.test/assets/iphone-18-pro.glb",
  "android:pixel-9-pro-fold": "https://hub.test/assets/pixel-9-pro-fold.glb",
};

function client(
  fold: Partial<DeviceFold> | null,
  displayCorners: DeviceClient["displayCorners"] = null,
  { model = true }: { model?: boolean } = {},
): DeviceClient {
  return {
    status: "streaming",
    framePresented: true,
    screen: { width: 1398, height: 2034, orientation: "portrait", display: "cover" },
    displayCorners,
    fold: fold && {
      pending: false,
      error: null,
      setControl: () => {},
      ...fold,
    },
    // An iPhone Duo client without separate display streams cannot feed its model.
    displays:
      fold && model
        ? [
            { id: "cover", active: true, attachVideo: () => {} },
            { id: "inner", active: false, attachVideo: () => {} },
          ]
        : null,
  } as unknown as DeviceClient;
}

const MODEL_PREVIEW = {
  mode: "3d",
  cacheScreenOnFold: false,
  sizeMode: "physical",
  onUnavailable: () => {},
} as const;

const FlatScreen = () => <div data-testid="flat-screen" />;
const ModelScreen = (props: { sizeMode?: string }) => (
  <div
    data-testid="model-screen"
    data-size-mode={props.sizeMode}
    data-mode={(props as { mode?: string }).mode}
  />
);

describe("PhoneFrame with an iPhone Duo", () => {
  test("sizes the flat cover and landscape inner display like other devices, with an animated handoff", () => {
    const render = (width: number, height: number) =>
      renderToStaticMarkup(
        <PhoneFrame
          device={device}
          client={{ ...client({}), screen: { width, height } }}
          DeviceScreen={FlatScreen}
          displayScreen={(screen) => screen ?? null}
        />,
      );
    expect(render(1398, 2034)).toContain("width:min(480px,");
    expect(render(2853, 2007)).toContain("width:min(682.3318385650225px,");
    expect(render(2853, 2007)).toContain("aspect-ratio 250ms ease");
  });
  test("renders the injected 3D screen on a stage capped at the flat Duo's size, without a screen clip", () => {
    const markup = renderToStaticMarkup(
      <PhoneFrame
        device={device}
        client={client({})}
        DeviceScreen={FlatScreen}
        DeviceModelScreen={ModelScreen}
        foldPreview={MODEL_PREVIEW}
        displayScreen={(screen) => screen ?? null}
        deviceModelAssets={MODEL_ASSETS}
      />,
    );
    expect(markup).toContain('data-device-frame-kind="device-model"');
    expect(markup).toContain('data-device-model="ios:iphone-duo"');
    expect(markup).toContain('data-testid="model-screen"');
    expect(markup).toContain('data-size-mode="physical"');
    // The preview mode is the frame's choice, not a prop of the model.
    expect(markup).not.toContain("data-mode");
    expect(markup).not.toContain('data-testid="flat-screen"');
    expect(markup).not.toContain("clip-path");
    // The flat cover's long side at the 480 px short-side cap, plus the 32 px
    // fill inset on each side, on both axes; below that, the content box of
    // the panel's viewport, which StreamPanel keeps clear of the title and the
    // controls. No aspect ratio, so any pose or rotation fits.
    expect(markup).toContain("width:min(762.369px, 100cqw);height:min(762.369px, 100cqh)");
    expect(markup).not.toContain("aspect-ratio");
  });

  test("never resizes the 3D stage while the device folds, rotates, or changes displays", () => {
    const stageStyle = (screen: DeviceClient["screen"], angle: number) =>
      renderToStaticMarkup(
        <PhoneFrame
          device={device}
          client={{ ...client({ angle }), screen }}
          DeviceScreen={FlatScreen}
          DeviceModelScreen={ModelScreen}
          foldPreview={{ ...MODEL_PREVIEW, sizeMode: "fill" }}
          deviceModelAssets={MODEL_ASSETS}
          displayScreen={(next) =>
            next && next.orientation?.startsWith("landscape")
              ? { ...next, width: next.height, height: next.width }
              : (next ?? null)
          }
        />,
      ).match(/data-device-frame-kind="device-model"[^>]*style="([^"]*)"/)?.[1];
    const closed = stageStyle({ width: 1398, height: 2034, display: "cover" }, 0);
    expect(closed).toBeTruthy();
    for (const [screen, angle] of [
      [{ width: 2007, height: 2853, display: "inner" }, 180],
      [{ width: 2007, height: 2853, display: "inner", orientation: "landscape_left" }, 90],
      [{ width: 1398, height: 2034, display: "cover", orientation: "landscape_right" }, 80],
      [null, 120],
    ] as const) {
      expect(stageStyle(screen, angle)).toBe(closed);
    }
  });

  test("keeps the flat screen for the 2D preview, for consumers without the model, and for clients that cannot feed it", () => {
    const shown = { DeviceModelScreen: ModelScreen, deviceModelAssets: MODEL_ASSETS };
    for (const props of [
      { ...shown, client: client({}), foldPreview: { ...MODEL_PREVIEW, mode: "2d" as const } },
      { ...shown, client: client({}), DeviceModelScreen: undefined, foldPreview: MODEL_PREVIEW },
      { ...shown, client: client({}), foldPreview: undefined },
      { ...shown, client: client(null), foldPreview: MODEL_PREVIEW },
      { ...shown, client: client({}, null, { model: false }), foldPreview: MODEL_PREVIEW },
      // A consumer that serves no file for the model, and a device without a model.
      { ...shown, client: client({}), foldPreview: MODEL_PREVIEW, deviceModelAssets: {} },
      {
        ...shown,
        client: client({}),
        foldPreview: MODEL_PREVIEW,
        device: { ...device, deviceModel: null },
      },
    ]) {
      const markup = renderToStaticMarkup(
        <PhoneFrame
          device={device}
          DeviceScreen={FlatScreen}
          displayScreen={(screen) => screen ?? null}
          {...props}
        />,
      );
      expect(markup).toContain('data-testid="flat-screen"');
      expect(markup).not.toContain("device-model");
      // The cover's own aspect ratio sizes the flat frame.
      expect(markup).toContain(`aspect-ratio:${1398 / 2034}`);
    }
  });
});

describe("PhoneFrame with a model whose client streams one screen", () => {
  const screenClient = (screen: DeviceClient["screen"]) =>
    ({
      status: "streaming",
      framePresented: true,
      screen,
      fold: null,
      displays: null,
    }) as unknown as DeviceClient;

  test("shows a phone's model without fold state, on a stage capped at its flat size", () => {
    const markup = renderToStaticMarkup(
      <PhoneFrame
        device={{ ...device, id: "iphone-18-pro", deviceModel: "ios:iphone-18-pro" }}
        client={screenClient({ width: 1206, height: 2622, orientation: "portrait" })}
        DeviceScreen={FlatScreen}
        DeviceModelScreen={ModelScreen}
        foldPreview={MODEL_PREVIEW}
        displayScreen={(screen) => screen ?? null}
        deviceModelAssets={MODEL_ASSETS}
      />,
    );
    expect(markup).toContain('data-device-model="ios:iphone-18-pro"');
    expect(markup).toContain('data-testid="model-screen"');
    // 480 px wide at the cap, so 2622 / 1206 of that tall, plus the 32 px insets.
    const side = ((480 * 2622) / 1206 + 64).toFixed(3);
    expect(markup).toContain(`width:min(${side}px, 100cqw);height:min(${side}px, 100cqh)`);
  });

  test("shows the Pixel 9 Pro Fold's model while Android reports no fold", () => {
    const markup = renderToStaticMarkup(
      <PhoneFrame
        device={{
          ...device,
          id: "emulator-5556",
          deviceModel: "android:pixel-9-pro-fold",
          platform: "android",
        }}
        client={screenClient({ width: 2076, height: 2152, orientation: "portrait" })}
        DeviceScreen={FlatScreen}
        DeviceModelScreen={ModelScreen}
        foldPreview={MODEL_PREVIEW}
        displayScreen={(screen) => screen ?? null}
        deviceModelAssets={MODEL_ASSETS}
      />,
    );
    expect(markup).toContain('data-device-model="android:pixel-9-pro-fold"');
    expect(markup).not.toContain('data-testid="flat-screen"');
  });
});

describe("PhoneFrame with a display that describes its own glass", () => {
  test("clips the flat Duo cover to its DeviceKit corners instead of the generic iPhone squircle", () => {
    const corners = {
      topLeft: 8 / 466,
      topRight: 59 / 466,
      bottomRight: 59 / 466,
      bottomLeft: 8 / 466,
    };
    const markup = renderToStaticMarkup(
      <PhoneFrame
        device={device}
        client={client({}, corners)}
        DeviceScreen={FlatScreen}
        displayScreen={(screen) => screen ?? null}
      />,
    );
    expect(markup).toContain('data-display-corners="device"');
    // Hinge-side corners nearly square, outer corners round, all in container-width units.
    expect(markup).toContain("shape(from 1.717cqw -0.5px");
    expect(markup).toContain("calc(100% - 12.661cqw)");
    expect(markup).toContain("border-radius:1.717cqw 12.661cqw 12.661cqw 1.717cqw");
    // Circular corners: the control points are the circle's (0.5523 of the
    // radius), not the iOS superellipse's.
    expect(markup).toContain("with 6.992cqw 0 from start / 0 -6.992cqw from end");
    expect(markup).not.toContain("with 7.556cqw");
  });

  test("shows the whole stream rectangle when the client describes no corners", () => {
    const markup = renderToStaticMarkup(
      <PhoneFrame
        device={device}
        client={client(null)}
        DeviceScreen={FlatScreen}
        displayScreen={(screen) => screen ?? null}
      />,
    );
    expect(markup).not.toContain("data-display-corners");
    expect(markup).not.toContain("clip-path");
    const frame = markup.match(/data-testid="device-screen-frame"[^>]*style="([^"]*)"/)?.[1];
    expect(frame).not.toContain("border-radius");
  });
});
