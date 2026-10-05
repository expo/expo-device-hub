import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { type DeviceClient } from "@expo/hub-client";

import { StreamPanel } from "../dashboard/StreamPanel";

test("a hinge error is visible beside the stream without mounting the sidebar", () => {
  const client = {
    platform: "ios",
    status: "streaming",
    screen: { width: 1398, height: 2034 },
    hinge: { modelActive: false, error: "Simulator rejected this pose." },
    screenRecording: null,
    appearance: "light",
    displayCorners: null,
  } as unknown as DeviceClient;
  const markup = renderToStaticMarkup(
    <StreamPanel
      device={{
        id: "duo",
        name: "iPhone Duo",
        platform: "ios",
        version: "iOS",
        booted: true,
        physical: false,
        supported: true,
        deviceFrame: null,
      }}
      client={client}
      DeviceScreen={() => <div />}
      displayScreen={(screen) => screen ?? null}
    />,
  );
  expect(markup).toContain('role="alert"');
  expect(markup).toContain("Simulator rejected this pose.");
  expect(markup).not.toContain("Device options");
});
