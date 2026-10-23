import { describe, expect, test } from "bun:test";
import { type DeviceClient, type DeviceHinge } from "@expo/hub-client";
import { renderToStaticMarkup } from "react-dom/server";

import { PhoneFrame } from "../dashboard/PhoneFrame";
import { type Device } from "../dashboard/data";

const device: Device = {
  id: "duo-1",
  name: "iPhone Duo",
  version: "iOS 27.1",
  platform: "ios",
  booted: true,
  physical: false,
  supported: true,
  deviceFrame: null,
};

function client(
  hinge: Partial<DeviceHinge> | null,
  displayCorners: DeviceClient["displayCorners"] = null,
  { model = true }: { model?: boolean } = {},
): DeviceClient {
  return {
    status: "streaming",
    screen: { width: 1398, height: 2034, orientation: "portrait", screenId: 1 },
    displayCorners,
    hinge: hinge && {
      faceDown: false,
      pending: false,
      error: null,
      setControl: () => {},
      ...hinge,
    },
    // A device without separate display streams or Xcode's model, such as an
    // Android foldable, has a hinge but cannot feed the 3D model.
    displays:
      hinge && model
        ? [
            { id: 1, active: true, attachVideo: () => {} },
            { id: 3, active: false, attachVideo: () => {} },
          ]
        : null,
    deviceModelUrl: hinge && model ? "https://hub.test/grid/api/devicekit-model" : null,
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
  test("uses serve-sim sizing for the flat cover and landscape inner display, with an animated handoff", () => {
    const render = (width: number, height: number) =>
      renderToStaticMarkup(
        <PhoneFrame
          device={device}
          client={{ ...client({}), screen: { width, height } }}
          DeviceScreen={FlatScreen}
          displayScreen={(screen) => screen ?? null}
        />,
      );
    expect(render(1398, 2034)).toContain("width:min(320px,");
    expect(render(2853, 2007)).toContain("width:min(620px,");
    expect(render(2853, 2007)).toContain("aspect-ratio 250ms ease");
  });
  test("renders the injected 3D screen on a square stage without a screen clip", () => {
    const markup = renderToStaticMarkup(
      <PhoneFrame
        device={device}
        client={client({})}
        DeviceScreen={FlatScreen}
        FoldableDeviceScreen={ModelScreen}
        foldPreview={MODEL_PREVIEW}
        displayScreen={(screen) => screen ?? null}
      />,
    );
    expect(markup).toContain('data-device-frame-kind="duo-model"');
    expect(markup).toContain('data-testid="model-screen"');
    expect(markup).toContain('data-size-mode="physical"');
    // The preview mode is the frame's choice, not a prop of the model.
    expect(markup).not.toContain("data-mode");
    expect(markup).not.toContain('data-testid="flat-screen"');
    expect(markup).not.toContain("clip-path");
    expect(markup).toContain("aspect-ratio:1");
  });

  test("keeps the flat screen for the 2D preview, for consumers without the model, and for clients that cannot feed it", () => {
    for (const props of [
      {
        client: client({}),
        FoldableDeviceScreen: ModelScreen,
        foldPreview: { ...MODEL_PREVIEW, mode: "2d" as const },
      },
      { client: client({}), FoldableDeviceScreen: undefined, foldPreview: MODEL_PREVIEW },
      { client: client({}), FoldableDeviceScreen: ModelScreen, foldPreview: undefined },
      { client: client(null), FoldableDeviceScreen: ModelScreen, foldPreview: MODEL_PREVIEW },
      {
        client: client({}, null, { model: false }),
        FoldableDeviceScreen: ModelScreen,
        foldPreview: MODEL_PREVIEW,
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
      expect(markup).not.toContain("duo-model");
      // The cover's own aspect ratio sizes the flat frame.
      expect(markup).toContain(`aspect-ratio:${1398 / 2034}`);
    }
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

  test("keeps the generic shape when the client describes no corners", () => {
    const markup = renderToStaticMarkup(
      <PhoneFrame
        device={device}
        client={client(null)}
        DeviceScreen={FlatScreen}
        displayScreen={(screen) => screen ?? null}
      />,
    );
    expect(markup).not.toContain("data-display-corners");
    expect(markup).toContain("shape(from 14.066cqw -0.5px");
  });
});
