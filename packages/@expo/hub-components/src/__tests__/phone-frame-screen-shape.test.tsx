import { afterEach, describe, expect, test } from "bun:test";
import { type DeviceClient, type DeviceScreenProps } from "@expo/hub-client";
import {
  DeviceShape,
  rotateScreenShape,
  SCREEN_SHAPES,
  screenShapeClipPath,
} from "@expo/hub-client/shapes";
import { useEffect } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { type Device } from "../dashboard/data";
import { PhoneFrame } from "../dashboard/PhoneFrame";
import { createGlobalStubs } from "./test-globals";

const { stubGlobal, restoreGlobals } = createGlobalStubs();
let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreGlobals();
});

const IPHONE: Device = {
  id: "iphone",
  name: "My iPhone",
  version: "iOS 27.1",
  platform: "ios",
  booted: true,
  physical: false,
  supported: true,
  model: "iPhone 17 Pro",
};
const PIXEL: Device = {
  ...IPHONE,
  id: "pixel",
  name: "Pixel_9_API_36",
  platform: "android",
  model: "pixel_9",
};

function client(screen: DeviceClient["screen"], platform: Device["platform"]): DeviceClient {
  return {
    platform,
    status: "streaming",
    screen,
    devices: [],
    displayCorners: null,
    fold: null,
    displays: null,
    deviceModelUrl: null,
  } as unknown as DeviceClient;
}

function Screen(_: DeviceScreenProps) {
  return null;
}

function render(
  device: Device,
  screen: DeviceClient["screen"],
  options: { showScreenShape?: boolean; shapes?: boolean } = {},
) {
  return renderToStaticMarkup(
    <PhoneFrame
      device={device}
      client={client(screen, device.platform)}
      DeviceScreen={Screen}
      DeviceShape={options.shapes === false ? undefined : DeviceShape}
      displayScreen={(value) => value ?? null}
      showScreenShape={options.showScreenShape}
    />,
  );
}

function clipStyle(markup: string) {
  return markup.match(/data-testid="device-screen-clip"[^>]*style="([^"]*)"/)?.[1] ?? "";
}

function frameStyle(markup: string) {
  return markup.match(/data-testid="device-screen-frame"[^>]*style="([^"]*)"/)?.[1] ?? "";
}

describe("PhoneFrame screen shape", () => {
  test("clips a known model to its own screen shape", () => {
    const markup = render(IPHONE, { width: 1206, height: 2622 });
    const expected = screenShapeClipPath(SCREEN_SHAPES.iPhone16Pro, {
      aspectRatio: 1206 / 2622,
      insetPx: 1,
    });
    expect(markup).toContain('data-screen-shape="device"');
    expect(clipStyle(markup)).toContain(`clip-path:${expected}`);
  });

  test("turns the shape with a sideways device", () => {
    const markup = render(PIXEL, { width: 2424, height: 1080, orientation: "landscape_left" });
    const turned = rotateScreenShape(SCREEN_SHAPES.pixel9, "landscape_left");
    expect(clipStyle(markup)).toContain(
      `clip-path:${screenShapeClipPath(turned, { aspectRatio: 2424 / 1080, insetPx: 1 })}`,
    );
  });

  test("follows the iPhone Duo display, over the DeviceKit corners of the client", () => {
    const duo: Device = {
      ...IPHONE,
      id: "duo",
      name: "iPhone Duo",
      model: "iPhone Duo",
    };
    const corners = { topLeft: 0.02, topRight: 0.15, bottomRight: 0.15, bottomLeft: 0.02 };
    const render = (screen: DeviceClient["screen"]) =>
      renderToStaticMarkup(
        <PhoneFrame
          device={duo}
          client={{ ...client(screen, "ios"), displayCorners: corners } as DeviceClient}
          DeviceScreen={Screen}
          DeviceShape={DeviceShape}
          displayScreen={(value) => value ?? null}
        />,
      );
    const cover = { width: 1398, height: 2034, display: "cover" } as const;
    const inner = { width: 2007, height: 2853, display: "inner" } as const;
    expect(clipStyle(render(cover))).toContain(
      `clip-path:${screenShapeClipPath(SCREEN_SHAPES.iPhoneDuoCover, { aspectRatio: 1398 / 2034, insetPx: 1 })}`,
    );
    expect(clipStyle(render(inner))).toContain(
      `clip-path:${screenShapeClipPath(SCREEN_SHAPES.iPhoneDuoInner, { aspectRatio: 2007 / 2853, insetPx: 1 })}`,
    );
  });

  test("draws no solid layer under a presented stream, only until the first frame", () => {
    const markup = (framePresented: boolean) =>
      renderToStaticMarkup(
        <PhoneFrame
          device={IPHONE}
          client={
            { ...client({ width: 1206, height: 2622 }, "ios"), framePresented } as DeviceClient
          }
          DeviceScreen={Screen}
          DeviceShape={DeviceShape}
          displayScreen={(value) => value ?? null}
        />,
      );
    expect(clipStyle(markup(false))).not.toContain("background-color");
    expect(markup(false)).toContain('data-testid="device-screen-surface"');
    expect(clipStyle(markup(true))).not.toContain("background-color");
    expect(markup(true)).not.toContain('data-testid="device-screen-surface"');
  });

  test("shows the whole stream rectangle for a model without a known shape", () => {
    const markup = render({ ...IPHONE, model: "iPhone SE (3rd generation)" }, null);
    expect(markup).not.toContain("data-screen-shape");
    expect(clipStyle(markup)).toBe("position:absolute;inset:0");
    expect(frameStyle(markup)).not.toContain("border-radius");
  });

  test("shows the whole stream rectangle when the consumer does not pass DeviceShape", () => {
    const markup = render(IPHONE, { width: 1206, height: 2622 }, { shapes: false });
    expect(markup).not.toContain("data-screen-shape");
    expect(clipStyle(markup)).toBe("position:absolute;inset:0");
    expect(frameStyle(markup)).not.toContain("border-radius");
  });

  test("keeps the live screen mounted when the screen shape is turned on and off", async () => {
    stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let mounts = 0;
    function CountingScreen(_: DeviceScreenProps) {
      useEffect(() => {
        mounts++;
      }, []);
      return null;
    }
    const frame = (showScreenShape: boolean) => (
      <PhoneFrame
        device={IPHONE}
        client={client({ width: 1206, height: 2622 }, "ios")}
        DeviceScreen={CountingScreen}
        DeviceShape={DeviceShape}
        displayScreen={(value) => value ?? null}
        showScreenShape={showScreenShape}
      />
    );
    await act(async () => {
      renderer = create(frame(true));
    });
    await act(async () => renderer!.update(frame(false)));
    await act(async () => renderer!.update(frame(true)));
    expect(mounts).toBe(1);
  });

  test("shows the plain video rectangle with the screen shape off", () => {
    for (const markup of [
      render(IPHONE, { width: 1206, height: 2622 }, { showScreenShape: false }),
      render({ ...IPHONE, model: "iPhone SE (3rd generation)" }, null, { showScreenShape: false }),
      render(IPHONE, { width: 1206, height: 2622 }, { showScreenShape: false, shapes: false }),
    ]) {
      expect(markup).not.toContain("data-screen-shape");
      expect(clipStyle(markup)).toBe("position:absolute;inset:0");
      expect(frameStyle(markup)).not.toContain("border-radius");
    }
  });

  test("shows the iPhone Duo as a plain rectangle too, without its DeviceKit corners", () => {
    const corners = { topLeft: 0.02, topRight: 0.15, bottomRight: 0.15, bottomLeft: 0.02 };
    const markup = renderToStaticMarkup(
      <PhoneFrame
        device={{ ...IPHONE, id: "duo", name: "iPhone Duo", model: "iPhone Duo" }}
        client={
          {
            ...client({ width: 1398, height: 2034, display: "cover" }, "ios"),
            displayCorners: corners,
          } as DeviceClient
        }
        DeviceScreen={Screen}
        DeviceShape={DeviceShape}
        displayScreen={(value) => value ?? null}
        showScreenShape={false}
      />,
    );
    expect(markup).not.toContain("data-screen-shape");
    expect(markup).not.toContain("data-display-corners");
    expect(clipStyle(markup)).toBe("position:absolute;inset:0");
    expect(frameStyle(markup)).not.toContain("border-radius");
  });
});
