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
    screen: { width: 390, height: 844, orientation: "portrait" },
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

test("the Orientation row stays while a report briefly disagrees with the frame, and goes with the capability", async () => {
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubGlobal("HTMLFormElement", class {});
  stubGlobal("window", {
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
  });
  const base = {
    platform: "android",
    status: "streaming",
    screenRecording: null,
    recordingControlsLocked: false,
    capabilities: { orientation: { orientations: ["portrait", "landscape_left"] } },
    orientationPending: false,
    orientationError: null,
    setOrientation: () => {},
    deviceSettings: null,
    deviceSettingsStatus: "idle",
    deviceSettingsPending: new Set(),
  };
  const client = (overrides: object) => ({ ...base, ...overrides }) as unknown as DeviceClient;
  const hasRow = () =>
    renderer!.root.findAll((node) => node.props.ariaLabel === "Orientation").length > 0;
  await act(async () => {
    renderer = create(
      <DeviceOptionsSection
        client={client({
          screen: { width: 390, height: 844, orientation: "portrait" },
          orientation: "portrait",
        })}
      />,
    );
  });
  expect(hasRow()).toBe(true);
  // The frame turned before the pose report: the client drops `screen.orientation` for a moment.
  await act(async () => {
    renderer!.update(
      <DeviceOptionsSection
        client={client({ screen: { width: 844, height: 390 }, orientation: "landscape_left" })}
      />,
    );
  });
  expect(hasRow()).toBe(true);
  await act(async () => {
    renderer!.update(
      <DeviceOptionsSection
        client={client({
          capabilities: { orientation: false },
          screen: { width: 844, height: 390 },
          orientation: "landscape_left",
        })}
      />,
    );
  });
  expect(hasRow()).toBe(false);
});
