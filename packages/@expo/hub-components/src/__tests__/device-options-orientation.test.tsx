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
    orientationUnavailable: null,
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

test("the Orientation row follows the client's pose, not the frame, and goes with the capability", async () => {
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
    orientationUnavailable: null,
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

test("Shake sends the shake and then tells the dashboard, which wobbles the stream", async () => {
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubGlobal("HTMLFormElement", class {});
  stubGlobal("window", {
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
  });
  const calls: string[] = [];
  const client = {
    platform: "ios",
    status: "streaming",
    recordingControlsLocked: false,
    orientationUnavailable: null,
    capabilities: { orientation: false, shake: true },
    orientation: null,
    shake: () => calls.push("client.shake"),
    deviceSettings: null,
    deviceSettingsStatus: "idle",
    deviceSettingsPending: new Set(),
  } as unknown as DeviceClient;
  await act(async () => {
    renderer = create(
      <DeviceOptionsSection
        client={client}
        showDeviceSettings={false}
        onShake={() => calls.push("onShake")}
      />,
    );
  });
  const button = renderer!.root.find(
    (node) => node.type === "button" && node.props.children === "Shake",
  );
  await act(async () => button.props.onClick());
  expect(calls).toEqual(["client.shake", "onShake"]);
});

test("a failed shake shows its error under the Shake row", async () => {
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubGlobal("HTMLFormElement", class {});
  stubGlobal("window", {
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
  });
  const client = {
    platform: "android",
    status: "streaming",
    recordingControlsLocked: false,
    orientationUnavailable: null,
    capabilities: { orientation: false, shake: true },
    orientation: null,
    shake: () => {},
    shakeError: "Emulator acceleration write failed: KO: busy",
    deviceSettings: null,
    deviceSettingsStatus: "idle",
    deviceSettingsPending: new Set(),
  } as unknown as DeviceClient;
  await act(async () => {
    renderer = create(<DeviceOptionsSection client={client} showDeviceSettings={false} />);
  });
  const row = renderer!.root.find(
    (node) => node.props.label === "Shake device" && "description" in node.props,
  );
  expect(row.props.description).toBe("Emulator acceleration write failed: KO: busy");
  const button = renderer!.root.find(
    (node) => node.type === "button" && node.props.children === "Shake",
  );
  expect(button.props["aria-describedby"]).toBe(row.props.descriptionId);
});
