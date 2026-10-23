import { expect, test } from "bun:test";
import { type DeviceClient } from "@expo/hub-client";
import { renderToStaticMarkup } from "react-dom/server";

import { type Device } from "../dashboard/data";
import { type DeviceFrameAssets } from "../dashboard/deviceFrame";
import { PhoneFrame } from "../dashboard/PhoneFrame";

const FRAME_ASSETS: DeviceFrameAssets = {
  "android:pixel-9": {
    src: "/pixel-9.png",
    width: 1935,
    height: 4096,
    screen: { x: 95, y: 94, width: 1737, height: 3907 },
    screenRadius: 236,
  },
  "android:pixel-10-pro": {
    src: "/pixel.png",
    width: 1250,
    height: 2631,
    screen: { x: 50, y: 48, width: 1138, height: 2532 },
    screenRadius: 150,
  },
  "ios:iphone-17-pro": {
    src: "/iphone.png",
    width: 2620,
    height: 5420,
    screen: { x: 104, y: 88, width: 2412, height: 5244 },
    screenRadius: 340,
  },
};

const DUO: Device = {
  id: "duo",
  name: "iPhone Duo",
  version: "iOS 27.1",
  platform: "ios",
  booted: true,
  physical: false,
  supported: true,
  deviceFrame: null,
};
const IPHONE: Device = {
  ...DUO,
  id: "iphone",
  name: "iPhone 17 Pro",
  deviceFrame: "ios:iphone-17-pro",
};
const PIXEL: Device = {
  ...DUO,
  id: "pixel",
  name: "Pixel 10 Pro",
  platform: "android",
  deviceFrame: "android:pixel-10-pro",
};

function client(
  screen: DeviceClient["screen"],
  { fold = false, model = false }: { fold?: boolean; model?: boolean } = {},
): DeviceClient {
  return {
    status: "streaming",
    screen,
    displayCorners: null,
    fold: fold ? { pending: false, error: null, setControl: () => {} } : null,
    displays: model
      ? [
          { id: "cover", active: true, attachVideo: () => {} },
          { id: "inner", active: false, attachVideo: () => {} },
        ]
      : null,
    deviceModelUrl: model ? "https://hub.test/grid/api/devicekit-model" : null,
  } as unknown as DeviceClient;
}

/** The size and layout styles of the frame, its screen clip, and the stream inside it. */
function layout(markup: string) {
  const style = (testId: string) =>
    markup.match(new RegExp(`data-testid="${testId}"[^>]*style="([^"]*)"`))?.[1] ?? null;
  return {
    frame: style("device-screen-frame"),
    clip: style("device-screen-clip"),
    stream: style("device-frame-stream-cover"),
  };
}

// The unframed clip: the generic iOS squircle at the portrait and landscape
// radius, and Android's rounded rectangle. Captured on #435 (c4b445a1), which
// added the background shown before the first frame.
const IOS_PORTRAIT_CLIP =
  "position:absolute;inset:0;background-color:var(--expo-theme-background-element);clip-path:shape(from 14.066cqw -0.5px, hline to calc(100% - 14.066cqw), curve to 100% calc(14.066cqw - 0.5px) with 8.392cqw 0 from start / 0 -8.392cqw from end, vline to calc(100% - 14.066cqw + 0.5px), curve to calc(100% - 14.066cqw) calc(100% + 0.5px) with 0 8.392cqw from start / 8.392cqw 0 from end, hline to 14.066cqw, curve to 0 calc(100% - 14.066cqw + 0.5px) with -8.392cqw 0 from start / 0 8.392cqw from end, vline to calc(14.066cqw - 0.5px), curve to 14.066cqw -0.5px with 0 -8.392cqw from start / -8.392cqw 0 from end, close)";
const IOS_LANDSCAPE_CLIP =
  "position:absolute;inset:0;background-color:var(--expo-theme-background-element);clip-path:shape(from 9.895cqw -0.5px, hline to calc(100% - 9.895cqw), curve to 100% calc(9.895cqw - 0.5px) with 5.903cqw 0 from start / 0 -5.903cqw from end, vline to calc(100% - 9.895cqw + 0.5px), curve to calc(100% - 9.895cqw) calc(100% + 0.5px) with 0 5.903cqw from start / 5.903cqw 0 from end, hline to 9.895cqw, curve to 0 calc(100% - 9.895cqw + 0.5px) with -5.903cqw 0 from start / 0 5.903cqw from end, vline to calc(9.895cqw - 0.5px), curve to 9.895cqw -0.5px with 0 -5.903cqw from start / -5.903cqw 0 from end, close)";
const ANDROID_CLIP =
  "position:absolute;inset:0;background-color:var(--expo-theme-background-element);clip-path:shape(from 2.564cqw -0.5px, hline to calc(100% - 2.564cqw), curve to 100% calc(2.564cqw - 0.5px) with 1.416cqw 0 from start / 0 -1.416cqw from end, vline to calc(100% - 2.564cqw + 0.5px), curve to calc(100% - 2.564cqw) calc(100% + 0.5px) with 0 1.416cqw from start / 1.416cqw 0 from end, hline to 2.564cqw, curve to 0 calc(100% - 2.564cqw + 0.5px) with -1.416cqw 0 from start / 0 1.416cqw from end, vline to calc(2.564cqw - 0.5px), curve to 2.564cqw -0.5px with 0 -1.416cqw from start / -1.416cqw 0 from end, close)";

// Captured from the 2D preview before the 3D stage filled the stream area:
// the frame, stream, and framed clip styles on #248 (fbe2fe54), the unframed
// clips on #435 (c4b445a1). The 3D stage must not change any of them.
const CASES: {
  name: string;
  device: Device;
  client: DeviceClient;
  frame?: boolean;
  expected: { frame: string; clip: string; stream: string };
}[] = [
  {
    name: "Duo cover",
    device: DUO,
    client: client({ width: 1398, height: 2034 }, { fold: true }),
    expected: {
      frame:
        "width:min(320px, 100cqw, 68.731563cqh);aspect-ratio:0.6873156342182891;flex-shrink:0;position:relative;isolation:isolate;transition:width 250ms ease, aspect-ratio 250ms ease;container-type:inline-size;border-radius:14.066cqw",
      clip: IOS_PORTRAIT_CLIP,
      stream: "position:absolute;inset:0",
    },
  },
  {
    name: "Duo inner display, landscape",
    device: DUO,
    client: client({ width: 2853, height: 2007 }, { fold: true }),
    expected: {
      frame:
        "width:min(620px, 100cqw, 142.152466cqh);aspect-ratio:1.4215246636771302;flex-shrink:0;position:relative;isolation:isolate;transition:width 250ms ease, aspect-ratio 250ms ease;container-type:inline-size;border-radius:9.895cqw",
      clip: IOS_LANDSCAPE_CLIP,
      stream: "position:absolute;inset:0",
    },
  },
  {
    name: "Duo inner display, portrait",
    device: DUO,
    client: client({ width: 2007, height: 2853 }, { fold: true }),
    expected: {
      frame:
        "width:min(320px, 100cqw, 70.347003cqh);aspect-ratio:0.7034700315457413;flex-shrink:0;position:relative;isolation:isolate;transition:width 250ms ease, aspect-ratio 250ms ease;container-type:inline-size;border-radius:14.066cqw",
      clip: IOS_PORTRAIT_CLIP,
      stream: "position:absolute;inset:0",
    },
  },
  {
    name: "Duo in 2D while the 3D model is available",
    device: DUO,
    client: client({ width: 2853, height: 2007 }, { fold: true, model: true }),
    expected: {
      frame:
        "width:min(620px, 100cqw, 142.152466cqh);aspect-ratio:1.4215246636771302;flex-shrink:0;position:relative;isolation:isolate;transition:width 250ms ease, aspect-ratio 250ms ease;container-type:inline-size;border-radius:9.895cqw",
      clip: IOS_LANDSCAPE_CLIP,
      stream: "position:absolute;inset:0",
    },
  },
  {
    name: "iPhone",
    device: IPHONE,
    client: client({ width: 1206, height: 2622 }),
    expected: {
      frame:
        "width:min(480px, 100cqw, 45.995423cqh);aspect-ratio:0.459954233409611;flex-shrink:0;position:relative;isolation:isolate;container-type:inline-size;border-radius:14.066cqw",
      clip: IOS_PORTRAIT_CLIP,
      stream: "position:absolute;inset:0",
    },
  },
  {
    name: "iPhone in its frame",
    device: IPHONE,
    client: client({ width: 1206, height: 2622 }),
    frame: true,
    expected: {
      frame:
        "width:min(521.3930348258707px, 100cqw, 48.339483cqh);aspect-ratio:0.4833948339483395;flex-shrink:0;position:relative;isolation:isolate;container-type:size",
      clip: "position:absolute;left:calc(3.9695% - 1px);top:calc(1.6236% - 1px);width:calc(92.0611% + 2px);height:calc(96.7528% + 2px);container-type:size;z-index:1;overflow:hidden;border-radius:calc(12.9771cqw + 1px) / calc(6.2731cqh + 1px);background-color:var(--expo-theme-background-element)",
      stream:
        "position:absolute;top:50%;left:50%;width:max(100cqw, 45.995423cqh);height:max(100cqh, 217.412935cqw);aspect-ratio:0.459954233409611;transform:translate(-50%, -50%)",
    },
  },
  {
    name: "iPhone in its frame, landscape",
    device: IPHONE,
    client: client({ width: 2622, height: 1206, orientation: "landscape_left" }),
    frame: true,
    expected: {
      frame:
        "width:min(1078.6069651741295px, 100cqw, 206.870229cqh);aspect-ratio:2.068702290076336;flex-shrink:0;position:relative;isolation:isolate;container-type:size",
      clip: "position:absolute;left:calc(1.6236% - 1px);top:calc(3.9695% - 1px);width:calc(96.7528% + 2px);height:calc(92.0611% + 2px);container-type:size;z-index:1;overflow:hidden;border-radius:calc(6.2731cqw + 1px) / calc(12.9771cqh + 1px);background-color:var(--expo-theme-background-element)",
      stream:
        "position:absolute;top:50%;left:50%;width:max(100cqw, 217.412935cqh);height:max(100cqh, 45.995423cqw);aspect-ratio:2.174129353233831;transform:translate(-50%, -50%)",
    },
  },
  {
    name: "Pixel",
    device: PIXEL,
    client: client({ width: 1080, height: 2424 }),
    expected: {
      frame:
        "width:min(480px, 100cqw, 44.554455cqh);aspect-ratio:0.44554455445544555;flex-shrink:0;position:relative;isolation:isolate;container-type:inline-size;border-radius:2.564cqw",
      clip: ANDROID_CLIP,
      stream: "position:absolute;inset:0",
    },
  },
  {
    name: "Pixel in its frame",
    device: PIXEL,
    client: client({ width: 1080, height: 2424 }),
    frame: true,
    expected: {
      frame:
        "width:min(527.2407732864675px, 100cqw, 47.510452cqh);aspect-ratio:0.4751045229950589;flex-shrink:0;position:relative;isolation:isolate;container-type:size",
      clip: "position:absolute;left:calc(4.0000% - 1px);top:calc(1.8244% - 1px);width:calc(91.0400% + 2px);height:calc(96.2372% + 2px);container-type:size;z-index:1;overflow:hidden;border-radius:calc(12.0000cqw + 1px) / calc(5.7013cqh + 1px);background-color:var(--expo-theme-background-element)",
      stream:
        "position:absolute;top:50%;left:50%;width:max(100cqw, 44.554455cqh);height:max(100cqh, 224.444444cqw);aspect-ratio:0.44554455445544555;transform:translate(-50%, -50%)",
    },
  },
];

test.each(CASES)("the 2D preview keeps its size and layout: $name", (entry) => {
  const sizes = layout(
    renderToStaticMarkup(
      <PhoneFrame
        device={entry.device}
        client={entry.client}
        DeviceScreen={() => <div />}
        FoldableDeviceScreen={() => <div data-testid="model-screen" />}
        foldPreview={{ mode: "2d", sizeMode: "fill" }}
        displayScreen={(screen) => screen ?? null}
        showDeviceFrame={!!entry.frame}
        deviceFrameAssets={FRAME_ASSETS}
      />,
    ),
  );
  expect(sizes.frame).toBe(entry.expected.frame);
  expect(sizes.stream).toBe(entry.expected.stream);
  expect(sizes.clip).toBe(entry.expected.clip);
});
