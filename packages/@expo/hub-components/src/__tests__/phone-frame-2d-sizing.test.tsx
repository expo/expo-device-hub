import { expect, test } from "bun:test";
import { type DeviceClient } from "@expo/hub-client";
import { renderToStaticMarkup } from "react-dom/server";

import { type Device } from "../dashboard/data";
import { PhoneFrame } from "../dashboard/PhoneFrame";

const DUO: Device = {
  id: "duo",
  name: "iPhone Duo",
  version: "iOS 27.1",
  platform: "ios",
  booted: true,
  physical: false,
  supported: true,
};
const IPHONE: Device = {
  ...DUO,
  id: "iphone",
  name: "iPhone 17 Pro",
};
const PIXEL: Device = {
  ...DUO,
  id: "pixel",
  name: "Pixel 10 Pro",
  platform: "android",
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
    stream: style("device-screen-stream"),
  };
}

// The unframed clip: the generic iOS squircle at the portrait and landscape
// radius, and Android's rounded rectangle. Captured on #435 (c4b445a1), which
// added the background shown before the first frame.
const IOS_PORTRAIT_CLIP =
  "position:absolute;inset:0;clip-path:shape(from 14.066cqw -0.5px, hline to calc(100% - 14.066cqw), curve to 100% calc(14.066cqw - 0.5px) with 8.392cqw 0 from start / 0 -8.392cqw from end, vline to calc(100% - 14.066cqw + 0.5px), curve to calc(100% - 14.066cqw) calc(100% + 0.5px) with 0 8.392cqw from start / 8.392cqw 0 from end, hline to 14.066cqw, curve to 0 calc(100% - 14.066cqw + 0.5px) with -8.392cqw 0 from start / 0 8.392cqw from end, vline to calc(14.066cqw - 0.5px), curve to 14.066cqw -0.5px with 0 -8.392cqw from start / -8.392cqw 0 from end, close)";
const IOS_LANDSCAPE_CLIP =
  "position:absolute;inset:0;clip-path:shape(from 9.895cqw -0.5px, hline to calc(100% - 9.895cqw), curve to 100% calc(9.895cqw - 0.5px) with 5.903cqw 0 from start / 0 -5.903cqw from end, vline to calc(100% - 9.895cqw + 0.5px), curve to calc(100% - 9.895cqw) calc(100% + 0.5px) with 0 5.903cqw from start / 5.903cqw 0 from end, hline to 9.895cqw, curve to 0 calc(100% - 9.895cqw + 0.5px) with -5.903cqw 0 from start / 0 5.903cqw from end, vline to calc(9.895cqw - 0.5px), curve to 9.895cqw -0.5px with 0 -5.903cqw from start / -5.903cqw 0 from end, close)";
const ANDROID_CLIP =
  "position:absolute;inset:0;clip-path:shape(from 2.564cqw -0.5px, hline to calc(100% - 2.564cqw), curve to 100% calc(2.564cqw - 0.5px) with 1.416cqw 0 from start / 0 -1.416cqw from end, vline to calc(100% - 2.564cqw + 0.5px), curve to calc(100% - 2.564cqw) calc(100% + 0.5px) with 0 1.416cqw from start / 1.416cqw 0 from end, hline to 2.564cqw, curve to 0 calc(100% - 2.564cqw + 0.5px) with -1.416cqw 0 from start / 0 1.416cqw from end, vline to calc(2.564cqw - 0.5px), curve to 2.564cqw -0.5px with 0 -1.416cqw from start / -1.416cqw 0 from end, close)";

// Captured from the 2D preview before the 3D stage changed size:
// the frame and stream styles on #248 (fbe2fe54), the clips on #435
// (c4b445a1). The 3D stage must not change any of them. The Duo frames since
// use the other devices' 480px short side instead of serve-sim's 320px
// portrait and 620px landscape widths, so the flat Duo fills the same area.
// With the screen shape off, the same frame has no corners and no clip.
const CASES: {
  name: string;
  device: Device;
  client: DeviceClient;
  showScreenShape?: boolean;
  expected: { frame: string; clip: string; stream: string };
}[] = [
  {
    name: "Duo cover",
    device: DUO,
    client: client({ width: 1398, height: 2034 }, { fold: true }),
    expected: {
      frame:
        "width:min(480px, 100cqw, 68.731563cqh);aspect-ratio:0.6873156342182891;flex-shrink:0;position:relative;isolation:isolate;transition:width 250ms ease, aspect-ratio 250ms ease;container-type:inline-size;border-radius:14.066cqw",
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
        "width:min(682.3318385650225px, 100cqw, 142.152466cqh);aspect-ratio:1.4215246636771302;flex-shrink:0;position:relative;isolation:isolate;transition:width 250ms ease, aspect-ratio 250ms ease;container-type:inline-size;border-radius:9.895cqw",
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
        "width:min(480px, 100cqw, 70.347003cqh);aspect-ratio:0.7034700315457413;flex-shrink:0;position:relative;isolation:isolate;transition:width 250ms ease, aspect-ratio 250ms ease;container-type:inline-size;border-radius:14.066cqw",
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
        "width:min(682.3318385650225px, 100cqw, 142.152466cqh);aspect-ratio:1.4215246636771302;flex-shrink:0;position:relative;isolation:isolate;transition:width 250ms ease, aspect-ratio 250ms ease;container-type:inline-size;border-radius:9.895cqw",
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
    name: "iPhone with the screen shape off",
    device: IPHONE,
    client: client({ width: 1206, height: 2622 }),
    showScreenShape: false,
    expected: {
      frame:
        "width:min(480px, 100cqw, 45.995423cqh);aspect-ratio:0.459954233409611;flex-shrink:0;position:relative;isolation:isolate;container-type:inline-size",
      clip: "position:absolute;inset:0",
      stream: "position:absolute;inset:0",
    },
  },
  {
    name: "Duo cover with the screen shape off",
    device: DUO,
    client: client({ width: 1398, height: 2034 }, { fold: true }),
    showScreenShape: false,
    expected: {
      frame:
        "width:min(480px, 100cqw, 68.731563cqh);aspect-ratio:0.6873156342182891;flex-shrink:0;position:relative;isolation:isolate;transition:width 250ms ease, aspect-ratio 250ms ease;container-type:inline-size",
      clip: "position:absolute;inset:0",
      stream: "position:absolute;inset:0",
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
        showScreenShape={entry.showScreenShape}
      />,
    ),
  );
  expect(sizes.frame).toBe(entry.expected.frame);
  expect(sizes.stream).toBe(entry.expected.stream);
  expect(sizes.clip).toBe(entry.expected.clip);
});

test("the 3D stage is capped at the flat Duo's size, so both modes fill the stream area alike", () => {
  const render = (mode: "2d" | "3d", screen: DeviceClient["screen"]) =>
    layout(
      renderToStaticMarkup(
        <PhoneFrame
          device={DUO}
          client={client(screen, { fold: true, model: true })}
          DeviceScreen={() => <div />}
          FoldableDeviceScreen={() => <div data-testid="model-screen" />}
          foldPreview={{ mode, sizeMode: "fill" }}
          displayScreen={(next) => next ?? null}
        />,
      ),
    ).frame;
  const cover = { width: 1398, height: 2034 };
  // The flat cover: 480 px wide at the cap, so its long side is 480 / ratio.
  expect(render("2d", cover)).toStartWith("width:min(480px, 100cqw, 68.731563cqh);");
  const coverLongSide = (480 * cover.height) / cover.width;
  // The stage holds that long side on both axes, plus the model's 32 px fill inset on each side.
  const cap = `${(coverLongSide + 2 * 32).toFixed(3)}px`;
  for (const screen of [cover, { width: 2853, height: 2007 }, null]) {
    expect(render("3d", screen)).toStartWith(
      `width:min(${cap}, 100cqw);height:min(${cap}, 100cqh);`,
    );
  }
});
