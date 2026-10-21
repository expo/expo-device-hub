import { expect, test } from "bun:test";
import { type DeviceChrome, type DeviceClient } from "@expo/hub-client";
import { renderToStaticMarkup } from "react-dom/server";

import { PhoneFrame } from "../dashboard/PhoneFrame";
import { type Device } from "../dashboard/data";
import { deviceFrameAvailable, type DeviceFrameAssets } from "../dashboard/deviceFrame";
import { deviceKitArtworkPieces } from "../dashboard/deviceKitFrame";

const IPHONE: Device = {
  id: "ios",
  name: "iPhone 17 Pro",
  platform: "ios",
  version: "27.0",
  booted: true,
  physical: false,
  deviceFrame: "ios:iphone-17-pro",
  supported: true,
};

const PNG_ASSETS = {
  "ios:iphone-17-pro": {
    src: "/iphone.png",
    width: 1000,
    height: 2000,
    screen: { x: 50, y: 50, width: 900, height: 1900 },
    screenRadius: 80,
  },
} as unknown as DeviceFrameAssets;

const power = {
  name: "power",
  image: "X_Power BTN",
  imageDown: null,
  onTop: false,
  frame: { x: 986, y: 500, width: 14, height: 200 },
  hover: { x: 0.3, y: 0 },
  usagePage: 12,
  usage: 48,
};

function chrome(overrides: Partial<DeviceChrome> = {}): DeviceChrome {
  return {
    identifier: "phone11",
    frame: { width: 1000, height: 2000 },
    body: { x: 10, y: 20, width: 980, height: 1960 },
    screen: { x: 60, y: 80, width: 880, height: 1840 },
    screenRadius: 100,
    screenCornerRadii: { topLeft: 100, topRight: 100, bottomRight: 120, bottomLeft: 120 },
    compositeImage: "PhoneComposite",
    slice: null,
    corner: null,
    buttons: [power],
    assetUrl: (image) => `/chrome?image=${encodeURIComponent(image)}`,
    ...overrides,
  };
}

function render(
  deviceChrome: DeviceChrome | null,
  { orientation, showDeviceFrame }: { orientation?: string; showDeviceFrame?: boolean } = {},
) {
  const client = {
    status: "streaming",
    inputError: null,
    screen: orientation ? { width: 2000, height: 1000, orientation } : null,
    deviceChrome,
  } as unknown as DeviceClient;
  return renderToStaticMarkup(
    <PhoneFrame
      device={IPHONE}
      client={client}
      DeviceScreen={() => <video data-testid="live-media" />}
      displayScreen={(screen) => screen ?? null}
      deviceFrameAssets={PNG_ASSETS}
      showDeviceFrame={showDeviceFrame}
    />,
  );
}

const styleOf = (markup: string, attribute: string) =>
  markup.match(new RegExp(`<[^>]*${attribute}[^>]*style="([^"]+)"`))?.[1] ?? "";

test("an iOS device with DeviceKit chrome draws Apple's bezel instead of the PNG frame", () => {
  const markup = render(chrome());
  expect(markup).toContain('data-device-frame-kind="devicekit:phone11"');
  expect(markup).not.toContain('data-testid="device-frame-artwork"');
  // The composite covers the body; the button sits behind it.
  const composite = markup.indexOf('src="/chrome?image=PhoneComposite"');
  const button = markup.indexOf('src="/chrome?image=X_Power%20BTN"');
  expect(composite).toBeGreaterThan(-1);
  expect(button).toBeGreaterThan(-1);
  expect(button).toBeLessThan(composite);
  expect(markup).toMatch(
    /src="\/chrome\?image=PhoneComposite"[^>]*style="[^"]*left:1\.0000%;top:1\.0000%;width:98\.0000%;height:98\.0000%/,
  );
  expect(markup).toContain('data-testid="live-media"');
});

test("the stream sits above the opaque bezel, exactly in the screen opening with Apple's corners", () => {
  const markup = render(chrome());
  const screen = styleOf(markup, 'data-testid="device-screen-clip"');
  expect(screen).toContain("left:6.0000%;top:4.0000%;width:88.0000%;height:92.0000%");
  expect(screen).toContain("z-index:2");
  expect(screen).toContain(
    "border-radius:10.0000cqw 10.0000cqw 12.0000cqw 12.0000cqw / 5.0000cqh 5.0000cqh 6.0000cqh 6.0000cqh",
  );
  expect(styleOf(markup, 'data-devicekit-artwork="back"')).toContain("z-index:1");
});

test("the screen opening and its corners turn with a landscape device", () => {
  const markup = render(chrome(), { orientation: "landscape_left" });
  const screen = styleOf(markup, 'data-testid="device-screen-clip"');
  expect(screen).toContain("left:4.0000%;top:6.0000%;width:92.0000%;height:88.0000%");
  // Portrait bottom-left becomes the top-left corner when the device turns left.
  expect(screen).toContain(
    "border-radius:6.0000cqw 5.0000cqw 5.0000cqw 6.0000cqw / 12.0000cqh 10.0000cqh 10.0000cqh 12.0000cqh",
  );
  expect(styleOf(markup, 'data-devicekit-artwork="back"')).toContain("rotate(90deg)");
});

test("a nine-slice chrome draws its eight pieces around the body", () => {
  const pieces = deviceKitArtworkPieces(
    chrome({
      compositeImage: null,
      corner: { width: 100, height: 120 },
      slice: {
        topLeft: "TL",
        top: "T",
        topRight: "TR",
        right: "R",
        bottomRight: "BR",
        bottom: "B",
        bottomLeft: "BL",
        left: "L",
      },
    }),
  );
  expect(pieces.filter((piece) => piece.layer === "bezel").map((piece) => piece.image)).toEqual([
    "TL",
    "TR",
    "BL",
    "BR",
    "T",
    "B",
    "L",
    "R",
  ]);
  expect(pieces.find((piece) => piece.image === "R")!.rect).toEqual({
    x: 890,
    y: 140,
    width: 100,
    height: 1720,
  });
  expect(pieces[0]).toMatchObject({ layer: "back", image: "X_Power BTN" });
});

test("nine-slice pieces overlap by a hair, so no seam shows between them", () => {
  const sliced = chrome({
    compositeImage: null,
    corner: { width: 100, height: 120 },
    slice: {
      topLeft: "TL",
      top: "T",
      topRight: "TR",
      right: "R",
      bottomRight: "BR",
      bottom: "B",
      bottomLeft: "BL",
      left: "L",
    },
  });
  const client = {
    status: "streaming",
    inputError: null,
    screen: null,
    deviceChrome: sliced,
  } as unknown as DeviceClient;
  const markup = renderToStaticMarkup(
    <PhoneFrame
      device={IPHONE}
      client={client}
      DeviceScreen={() => null}
      displayScreen={() => null}
    />,
  );
  expect(markup).toMatch(
    /src="\/chrome\?image=T"[^>]*style="[^"]*left:calc\(11\.0000% - 0\.5px\);top:calc\(1\.0000% - 0\.5px\);width:calc\(78\.0000% \+ 1px\);height:calc\(6\.0000% \+ 1px\)/,
  );
  // The one-pixel edge slices stretch without smoothing; corners stay smooth.
  expect(markup).toMatch(/src="\/chrome\?image=T"[^>]*image-rendering:pixelated/);
  expect(markup).not.toMatch(/src="\/chrome\?image=TL"[^>]*image-rendering/);
  // Buttons keep their exact rects.
  expect(markup).toMatch(/src="\/chrome\?image=X_Power%20BTN"[^>]*style="[^"]*left:98\.6000%/);
});

test("a multi-display device draws the chrome of the active display", () => {
  const inner = chrome({
    identifier: "phone15-inner",
    frame: { width: 2000, height: 2000 },
    screen: { x: 100, y: 100, width: 1800, height: 1800 },
  });
  const duo = chrome({ identifier: "phone15", screenId: 1, displayVariants: { 3: inner } });
  const client = (screenId: number | undefined) =>
    ({
      status: "streaming",
      inputError: null,
      screen: { width: 1000, height: 1000, screenId },
      deviceChrome: duo,
    }) as unknown as DeviceClient;
  const kind = (screenId: number | undefined) =>
    renderToStaticMarkup(
      <PhoneFrame
        device={IPHONE}
        client={client(screenId)}
        DeviceScreen={() => null}
        displayScreen={(screen) => screen ?? null}
      />,
    ).match(/data-device-frame-kind="([^"]+)"/)?.[1];
  expect(kind(3)).toBe("devicekit:phone15-inner");
  expect(kind(1)).toBe("devicekit:phone15");
  expect(kind(undefined)).toBe("devicekit:phone15");
});

test("hiding the frame or a missing chrome keeps today's behavior", () => {
  expect(render(chrome(), { showDeviceFrame: false })).toContain('data-device-frame-kind="none"');
  // Without chrome, the bundled iPhone 17 Pro PNG still frames the device.
  expect(render(null)).toContain('data-device-frame-kind="ios:iphone-17-pro"');
});

test("the frame option is available for a profile frame or DeviceKit chrome", () => {
  const client = (deviceChrome: DeviceChrome | null) =>
    ({ deviceChrome }) as unknown as DeviceClient;
  expect(deviceFrameAvailable({ ...IPHONE, deviceFrame: null }, client(chrome()))).toBe(true);
  expect(deviceFrameAvailable(IPHONE, client(null))).toBe(true);
  expect(deviceFrameAvailable({ ...IPHONE, deviceFrame: null }, client(null))).toBe(false);
  expect(deviceFrameAvailable({ ...IPHONE, deviceFrame: null }, undefined)).toBe(false);
});
