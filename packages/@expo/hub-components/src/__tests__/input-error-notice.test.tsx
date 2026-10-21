import { expect, test } from "bun:test";
import { type DeviceClient } from "@expo/hub-client";
import { renderToStaticMarkup } from "react-dom/server";

import { PhoneFrame } from "../dashboard/PhoneFrame";
import { type Device } from "../dashboard/data";
import { bg, text } from "../theme/tokens";

function renderFrame(
  platform: Device["platform"],
  inputError: string | null,
  status = "streaming",
) {
  const device: Device = {
    id: platform,
    name: platform === "ios" ? "iPhone" : "Pixel",
    platform,
    version: "test",
    booted: true,
    physical: false,
    deviceFrame: null,
    supported: true,
  };
  return renderToStaticMarkup(
    <PhoneFrame
      device={device}
      client={{ status, inputError, framePresented: status === "streaming" } as DeviceClient}
      DeviceScreen={() => <video data-testid="live-media" />}
      displayScreen={() => null}
    />,
  );
}

for (const platform of ["ios", "android"] as const) {
  test(`${platform} consumer announces input refusal without replacing live media`, () => {
    const markup = renderFrame(platform, "Input busy <retry>");
    expect(markup).toContain('data-testid="live-media"');
    expect(markup).toContain('role="status" aria-live="polite"');
    expect(markup).toContain("Input busy &lt;retry&gt;");
    expect(markup).toContain(`background-color:${bg.danger}`);
    expect(markup).toContain(`color:${text.danger}`);
    const notice = markup.slice(markup.indexOf('role="status"'), markup.indexOf("Input busy"));
    expect(notice).toContain("pointer-events:none");
  });
  test(`${platform} recovered input removes the notice while media remains`, () => {
    const markup = renderFrame(platform, null);
    expect(markup).toContain('data-testid="live-media"');
    expect(markup).not.toContain('role="status"');
  });
}
test("an idle frame does not show a stale input notice", () => {
  expect(renderFrame("ios", "Old connection failed", "idle")).not.toContain(
    "Old connection failed",
  );
});
