import { afterEach, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { type DeviceClient, type DeviceOrientation } from "@expo/hub-client";
import { DeviceOptionsSection } from "../dashboard/DeviceOptionsSection";
import { createGlobalStubs } from "./test-globals";

const { stubGlobal, restoreGlobals } = createGlobalStubs();

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreGlobals();
});

test("a pick in the Orientation select calls client.setOrientation", async () => {
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // Radix Select checks for a form in an effect; the test renderer has no DOM.
  stubGlobal("HTMLFormElement", class {});
  stubGlobal("window", {
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
  });
  const picks: DeviceOrientation[] = [];
  const client = {
    platform: "ios",
    status: "streaming",
    screenRecording: null,
    recordingControlsLocked: false,
    capabilities: { orientation: { orientations: ["portrait", "landscape_left"] } },
    orientation: "portrait",
    orientationPending: false,
    orientationError: null,
    setOrientation: (orientation: DeviceOrientation) => picks.push(orientation),
    deviceSettings: null,
    deviceSettingsStatus: "idle",
    deviceSettingsPending: new Set(),
  } as unknown as DeviceClient;
  await act(async () => {
    renderer = create(<DeviceOptionsSection client={client} />);
  });
  const select = renderer!.root.find(
    (node) => node.props.ariaLabel === "Orientation" && typeof node.props.onChange === "function",
  );
  await act(async () => select.props.onChange("landscape_left"));
  expect(picks).toEqual(["landscape_left"]);
});
