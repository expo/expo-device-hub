import { afterEach, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { type DeviceClient } from "@expo/hub-client";
import { DeviceOptionsSection } from "../dashboard/DeviceOptionsSection";
import { SidebarActionButton } from "../dashboard/SidebarActionButton";
import { createGlobalStubs } from "./test-globals";

const { stubGlobal, restoreGlobals } = createGlobalStubs();

const SETTINGS_REASON = "Simulator settings are not available on a physical device.";
const ROTATE_REASON = "Rotate is not available on a physical device.";

const SETTING_LABELS = [
  "Appearance",
  "Liquid glass",
  "Color filter",
  "Text size",
  "Reduce motion",
  "Increase contrast",
  "Show borders",
  "Reduce transparency",
  "VoiceOver",
];

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreGlobals();
});

function stubDom() {
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubGlobal("HTMLFormElement", class {});
  stubGlobal("document", { addEventListener() {}, removeEventListener() {} });
  stubGlobal("window", {
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
  });
}

function iosClient(overrides: object) {
  return {
    platform: "ios",
    status: "streaming",
    screenRecording: null,
    recordingControlsLocked: false,
    orientationUnavailable: null,
    capabilities: {
      deviceSettings: true,
      orientation: { orientations: ["portrait", "landscape_left"] },
    },
    orientation: "portrait",
    orientationPending: false,
    orientationError: null,
    setOrientation: () => {},
    deviceSettings: null,
    deviceSettingsStatus: "idle",
    deviceSettingsPending: new Set(),
    hardwareKeyboardConnected: null,
    ...overrides,
  } as unknown as DeviceClient;
}

type LockedControl = { disabled?: boolean; disabledReason?: string };

async function render(client: DeviceClient) {
  await act(async () => {
    renderer = create(
      <DeviceOptionsSection
        client={client}
        screenShape={{ available: true, visible: true, onVisibleChange: () => {} }}
      />,
    );
  });
  const control = (label: string): LockedControl =>
    renderer!.root.find(
      (node) =>
        (node.props.ariaLabel === label || node.props.label === label) &&
        "disabledReason" in node.props,
    ).props;
  const keyboardButtons = (): LockedControl[] =>
    renderer!.root.findAllByType(SidebarActionButton).map((node) => node.props);
  return { control, keyboardButtons };
}

test("a phone locks every simulator setting row and Orientation with serve-sim's reasons", async () => {
  stubDom();
  const { control, keyboardButtons } = await render(
    iosClient({
      capabilities: { deviceSettings: false, orientation: false },
      unavailableReasons: { deviceSettings: SETTINGS_REASON, orientation: ROTATE_REASON },
    }),
  );

  for (const label of SETTING_LABELS) {
    expect({ label, ...control(label) }).toMatchObject({
      label,
      disabled: true,
      disabledReason: SETTINGS_REASON,
    });
  }
  for (const button of keyboardButtons()) {
    expect(button).toMatchObject({ disabled: true, disabledReason: SETTINGS_REASON });
  }
  expect(control("Orientation")).toMatchObject({ disabled: true, disabledReason: ROTATE_REASON });
  const orientation = control("Orientation") as { value?: string; options?: unknown[] };
  expect(orientation.value).toBe("portrait");
  expect(orientation.options).toContainEqual({ value: "portrait", label: "Portrait" });
  const shape = renderer!.root.find(
    (node) => node.props.label === "Show device shape" && "checked" in node.props,
  );
  expect(shape.props.disabled).toBe(false);
});

test("a simulator's rows still lock without a reason while its settings load", async () => {
  stubDom();
  const { control, keyboardButtons } = await render(iosClient({}));

  for (const label of SETTING_LABELS) {
    expect({ label, ...control(label) }).toMatchObject({
      label,
      disabled: true,
      disabledReason: undefined,
    });
  }
  for (const button of keyboardButtons()) {
    expect(button.disabled).toBe(true);
    expect(button.disabledReason).toBeUndefined();
  }
  expect(control("Orientation")).toMatchObject({ disabled: false, disabledReason: undefined });
});
