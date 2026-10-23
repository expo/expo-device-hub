import { expect, test } from "bun:test";
import { type DeviceClient } from "@expo/hub-client";
import { renderToStaticMarkup } from "react-dom/server";

import { DEVICE_TITLE_HEIGHT } from "../dashboard/DeviceTitle";
import { STREAM_CONTROLS_HEIGHT } from "../dashboard/StreamControls";
import { StreamPanel } from "../dashboard/StreamPanel";

function render(error: string | null) {
  const client = {
    platform: "ios",
    status: "streaming",
    screen: { width: 1398, height: 2034, display: "cover" },
    fold: { angle: 0, pending: false, error, setControl: () => {} },
    displays: [
      { id: "cover", active: true, attachVideo: () => {} },
      { id: "inner", active: false, attachVideo: () => {} },
    ],
    deviceModelUrl: "https://hub.test/grid/api/devicekit-model",
    screenRecording: null,
    displayCorners: null,
    capabilities: { clipboard: false },
  } as unknown as DeviceClient;
  return renderToStaticMarkup(
    <StreamPanel
      device={{
        id: "duo",
        name: "iPhone Duo",
        platform: "ios",
        version: "iOS 27.1",
        booted: true,
        physical: false,
        supported: true,
        deviceFrame: null,
      }}
      client={client}
      DeviceScreen={() => <div data-testid="flat-screen" />}
      FoldableDeviceScreen={() => <div data-testid="model-screen" />}
      foldPreview={{ mode: "3d", sizeMode: "fill" }}
      displayScreen={(screen) => screen ?? null}
    />,
  );
}

test("the 3D stage fills the stream area between the reserved title and controls", () => {
  const markup = render(null);
  expect(markup).toContain('data-testid="model-screen"');
  // The viewport's content box is what remains after the title and the
  // controls with their gaps; the stage takes all of it and nothing more, so
  // the title above and the controls below never overlap the model.
  const viewport = markup.match(/data-testid="device-frame-viewport" style="([^"]*)"/)?.[1];
  expect(viewport).toContain(
    `padding:${DEVICE_TITLE_HEIGHT + 32}px 0 ${STREAM_CONTROLS_HEIGHT + 32}px`,
  );
  expect(viewport).toContain("container-type:size");
  const stage = markup.match(/data-device-frame-kind="duo-model"[^>]*style="([^"]*)"/)?.[1];
  expect(stage).toStartWith("width:100cqw;height:100cqh;");
});

test("a fold error stays inside the measured controls block below the 3D stage", () => {
  const markup = render("Simulator rejected this pose.");
  // The controls block is measured as a whole, so its error line adds to the
  // reserved space instead of covering the stage.
  const controls = markup.slice(markup.indexOf("top:calc(100% + 32px)"));
  expect(controls.indexOf('role="alert"')).toBeGreaterThan(0);
  expect(controls.indexOf("Simulator rejected this pose.")).toBeGreaterThan(0);
});

test("the loading layer covers the whole 3D stage", () => {
  // Before the model draws, the screen shows its first-load spinner.
  const markup = render(null);
  const stage = markup.indexOf('data-device-frame-kind="duo-model"');
  const loading = markup.indexOf('data-testid="device-screen-loading"');
  const title = markup.indexOf("bottom:calc(100% + 32px)");
  expect(stage).toBeGreaterThan(-1);
  // Inside the stage, before the title and the controls that follow it.
  expect(loading).toBeGreaterThan(stage);
  expect(loading).toBeLessThan(title);
  // The stage's clip spans it edge to edge, and the layer spans the clip.
  const clip = markup.slice(stage).match(/data-testid="device-screen-clip" style="([^"]*)"/)?.[1];
  expect(clip).toBe("position:absolute;inset:0");
  expect(markup.slice(loading).match(/style="([^"]*)"/)?.[1]).toStartWith(
    "position:absolute;inset:0;",
  );
});
