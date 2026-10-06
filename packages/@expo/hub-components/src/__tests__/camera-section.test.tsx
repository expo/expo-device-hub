import {
  EMPTY_CLIENT,
  testFeature,
  testError,
} from "../../../hub-client/src/__tests__/feature-fixture";
import { describe, expect, test } from "bun:test";
import { type DeviceCameraStatus, type DeviceClient } from "@expo/hub-client";
import { renderToStaticMarkup } from "react-dom/server";

import { CameraSection } from "../dashboard/CameraSection";

const BASE_CLIENT: DeviceClient = {
  ...EMPTY_CLIENT,
  platform: "android",
  camera: { ...EMPTY_CLIENT.camera, ...testFeature(undefined) },
};

function cameraClient(overrides: Partial<DeviceClient> = {}): DeviceClient {
  return { ...BASE_CLIENT, ...overrides };
}

function cameraStatus(wiredAtLaunch: boolean): DeviceCameraStatus {
  return {
    wiredAtLaunch,
    feeds: [
      {
        facing: "back",
        placeholder: false,
        width: 1280,
        height: 960,
        bytes: 204_800,
        imageUrl: "/camera/back.png",
      },
      {
        facing: "front",
        placeholder: true,
        width: 640,
        height: 480,
        bytes: 1_024,
        imageUrl: "/camera/front.png",
      },
    ],
  };
}

const FEED_LABELS = ["Back camera", "Front camera"];

function feedMarkup(html: string, label: string) {
  const start = html.indexOf(`>${label}<`);
  expect(start).toBeGreaterThanOrEqual(0);

  const following = FEED_LABELS.filter((other) => other !== label)
    .map((other) => html.indexOf(`>${other}<`, start + 1))
    .filter((index) => index > start);
  return html.slice(start, following.length > 0 ? Math.min(...following) : html.length);
}

function buttonTag(markup: string, label: string) {
  const labelIndex = markup.indexOf(`>${label}</span>`);
  expect(labelIndex).toBeGreaterThanOrEqual(0);

  const start = markup.lastIndexOf("<button", labelIndex);
  return markup.slice(start, markup.indexOf(">", start) + 1);
}

function render(client: DeviceClient) {
  return renderToStaticMarkup(<CameraSection client={client} defaultOpen />);
}

describe("CameraSection", () => {
  test("shows both feeds and keeps Reset available only for a replaced image", () => {
    const html = render(
      cameraClient({
        camera: { ...BASE_CLIENT.camera, ...testFeature(cameraStatus(true) ?? undefined) },
      }),
    );

    const back = feedMarkup(html, "Back camera");
    const front = feedMarkup(html, "Front camera");
    expect(back).toContain('src="/camera/back.png"');
    expect(back).toContain("1280×960 · 200.0 KB");
    expect(front).toContain("640×480 · Test card");
    expect(buttonTag(back, "Reset")).not.toContain("disabled");
    expect(buttonTag(front, "Reset")).toContain('disabled=""');
  });

  test("explains an emulator booted without camera feeds and disables every control", () => {
    const html = render(
      cameraClient({
        camera: { ...BASE_CLIENT.camera, ...testFeature(cameraStatus(false) ?? undefined) },
      }),
    );

    expect(html).toContain(
      "This emulator started without camera feeds. Shut it down and boot it from Hub to attach them.",
    );
    for (const label of FEED_LABELS) {
      const feed = feedMarkup(html, label);
      expect(buttonTag(feed, "Choose PNG…")).toContain('disabled=""');
      expect(buttonTag(feed, "Reset")).toContain('disabled=""');
      expect(feed).toContain('aria-disabled="true"');
    }
  });

  test("reports a failed write as an alert", () => {
    const html = render(
      cameraClient({
        camera: {
          ...BASE_CLIENT.camera,
          ...testFeature(cameraStatus(true) ?? undefined),
          writes: {
            ...BASE_CLIENT.camera.writes,
            errors: new Map([["back", testError("The emulator rejected the image.")]]),
          },
        },
      }),
    );

    const alert = html.match(/<span role="alert"[^>]*>([^<]*)<\/span>/);
    expect(alert?.[1]).toBe("The emulator rejected the image.");
  });
});
