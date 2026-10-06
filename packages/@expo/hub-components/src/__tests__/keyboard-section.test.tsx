import { EMPTY_CLIENT, testFeature } from "../../../hub-client/src/__tests__/feature-fixture";
import { expect, test } from "bun:test";
import { type DeviceClient } from "@expo/hub-client";
import { renderToStaticMarkup } from "react-dom/server";

import { KeyboardSection } from "../dashboard/KeyboardSection";

function keyboardClient(keyboard: Partial<DeviceClient["keyboard"]>): DeviceClient {
  return {
    ...EMPTY_CLIENT,
    platform: "ios",
    keyboard: { ...EMPTY_CLIENT.keyboard, ...keyboard } as DeviceClient["keyboard"],
  };
}
const disabledButtons = (html: string) => html.match(/<button[^>]*disabled=""/g)?.length ?? 0;

test("keyboard controls stay disabled until the keyboard state is read", () => {
  const html = renderToStaticMarkup(
    <KeyboardSection client={keyboardClient(testFeature(undefined, "loading"))} />,
  );
  expect(disabledButtons(html)).toBe(2);
});

test("keyboard controls are enabled once ready, except a hardware toggle in flight", () => {
  const ready = keyboardClient(testFeature({ hardwareConnected: false }));
  expect(disabledButtons(renderToStaticMarkup(<KeyboardSection client={ready} />))).toBe(0);
  const writing = keyboardClient({
    ...testFeature({ hardwareConnected: false }),
    writes: { pending: new Set(["hardwareConnected"]), errors: new Map() },
  });
  expect(disabledButtons(renderToStaticMarkup(<KeyboardSection client={writing} />))).toBe(1);
});
