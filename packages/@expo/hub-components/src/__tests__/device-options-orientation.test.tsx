import { afterEach, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { type DeviceClient, type DeviceOrientation } from "@expo/hub-client";
import {
  DeviceOptionsSection,
  ORIENTATION_UNKNOWN_REASON,
  SHAKE_HOLD_DESCRIPTION,
} from "../dashboard/DeviceOptionsSection";
import { createGlobalStubs } from "./test-globals";

const { stubGlobal, restoreGlobals } = createGlobalStubs();

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreGlobals();
});

/** The Shake button. `Button` wraps its label in a span, so the button is the span's parent. */
function shakeButton() {
  return renderer!.root.find((node) => node.type === "span" && node.props.children === "Shake")
    .parent!;
}

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

test("the Orientation row follows the client's pose, not the frame, and locks without the capability", async () => {
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubGlobal("HTMLFormElement", class {});
  // The tooltip of a locked control listens for the pointer on the document.
  stubGlobal("document", { addEventListener() {}, removeEventListener() {} });
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
  const rows = () => renderer!.root.findAll((node) => node.props.ariaLabel === "Orientation");
  const hasRow = () => rows().length > 0;
  const select = () =>
    rows()[0]!.props as { value: string; disabled: boolean; disabledReason?: string };
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
  expect(select()).toMatchObject({ value: "portrait", disabled: false });
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
  // A device that offers no poses keeps the row, so the section does not change its rows. The
  // select locks and says why.
  expect(hasRow()).toBe(true);
  expect(select()).toMatchObject({
    disabled: true,
    disabledReason: ORIENTATION_UNKNOWN_REASON,
  });
  // Before the first pose report, the row is there too, locked, with the placeholder.
  await act(async () => {
    renderer!.update(<DeviceOptionsSection client={client({ orientation: null })} />);
  });
  expect(select()).toMatchObject({
    value: "",
    disabled: true,
    disabledReason: ORIENTATION_UNKNOWN_REASON,
  });
});

test("Shake starts the shake on press and stops it on release, and tells the dashboard both", async () => {
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubGlobal("HTMLFormElement", class {});
  // The tooltip of a locked control listens for the pointer on the document.
  stubGlobal("document", { addEventListener() {}, removeEventListener() {} });
  stubGlobal("window", {
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
  });
  const calls: string[] = [];
  const client = {
    platform: "android",
    status: "streaming",
    recordingControlsLocked: false,
    orientationUnavailable: null,
    capabilities: { orientation: false, shake: true },
    orientation: null,
    shake: () => calls.push("client.shake"),
    startShake: () => calls.push("client.startShake"),
    stopShake: () => calls.push("client.stopShake"),
    deviceSettings: null,
    deviceSettingsStatus: "idle",
    deviceSettingsPending: new Set(),
  } as unknown as DeviceClient;
  await act(async () => {
    renderer = create(
      <DeviceOptionsSection
        client={client}
        platform="android"
        onShake={() => calls.push("onShake")}
        onShakeEnd={() => calls.push("onShakeEnd")}
      />,
    );
  });
  const button = () => shakeButton();
  const pointer = { button: 0, pointerId: 1, currentTarget: { setPointerCapture() {} } };

  await act(async () => button().props.onPointerDown(pointer));
  // A second down while held, and the click after the release, do nothing more.
  await act(async () => button().props.onPointerDown(pointer));
  expect(calls).toEqual(["client.startShake", "onShake"]);
  await act(async () => button().props.onPointerUp(pointer));
  await act(async () => button().props.onClick?.());
  await act(async () => button().props.onLostPointerCapture(pointer));
  expect(calls).toEqual(["client.startShake", "onShake", "client.stopShake", "onShakeEnd"]);

  calls.length = 0;
  await act(async () => button().props.onPointerDown({ ...pointer, button: 2 }));
  expect(calls).toEqual([]);

  const key = (key: string, repeat = false) => ({ key, repeat, preventDefault() {} });
  await act(async () => button().props.onKeyDown(key(" ")));
  await act(async () => button().props.onKeyDown(key(" ", true)));
  await act(async () => button().props.onKeyUp(key(" ")));
  expect(calls).toEqual(["client.startShake", "onShake", "client.stopShake", "onShakeEnd"]);

  calls.length = 0;
  await act(async () => button().props.onKeyDown(key("Enter")));
  await act(async () => renderer!.unmount());
  renderer = undefined;
  expect(calls).toEqual(["client.startShake", "onShake", "client.stopShake", "onShakeEnd"]);
});

test("a failed shake shows its error under the Shake row", async () => {
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubGlobal("HTMLFormElement", class {});
  // The tooltip of a locked control listens for the pointer on the document.
  stubGlobal("document", { addEventListener() {}, removeEventListener() {} });
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
    startShake: () => {},
    stopShake: () => {},
    shakeError: "Emulator shake failed: setPhysicalModel: grpc-status 14",
    deviceSettings: null,
    deviceSettingsStatus: "idle",
    deviceSettingsPending: new Set(),
  } as unknown as DeviceClient;
  await act(async () => {
    renderer = create(<DeviceOptionsSection client={client} platform="android" />);
  });
  const row = renderer!.root.find(
    (node) => node.props.label === "Shake device" && "description" in node.props,
  );
  expect(row.props.description).toBe("Emulator shake failed: setPhysicalModel: grpc-status 14");
  const button = shakeButton();
  expect(button.props["aria-describedby"]).toBe(row.props.descriptionId);
});

test("an Android Shake row says to hold for a longer shake; an iOS row, whose shake is one event, does not", async () => {
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubGlobal("HTMLFormElement", class {});
  // The tooltip of a locked control listens for the pointer on the document.
  stubGlobal("document", { addEventListener() {}, removeEventListener() {} });
  stubGlobal("window", {
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
  });
  const client = (platform: "android" | "ios") =>
    ({
      platform,
      status: "streaming",
      recordingControlsLocked: false,
      orientationUnavailable: null,
      capabilities: { orientation: false, shake: true },
      orientation: null,
      shake: () => {},
      startShake: () => {},
      stopShake: () => {},
      shakeError: null,
      deviceSettings: null,
      deviceSettingsStatus: "idle",
      deviceSettingsPending: new Set(),
    }) as unknown as DeviceClient;
  const shakeRow = () =>
    renderer!.root.find(
      (node) => node.props.label === "Shake device" && "description" in node.props,
    );
  const button = () => shakeButton();

  await act(async () => {
    renderer = create(<DeviceOptionsSection client={client("android")} platform="android" />);
  });
  expect(shakeRow().props.description).toBe(SHAKE_HOLD_DESCRIPTION);
  expect(button().props["aria-describedby"]).toBe(shakeRow().props.descriptionId);

  await act(async () => {
    renderer!.update(<DeviceOptionsSection client={client("ios")} platform="ios" />);
  });
  expect(shakeRow().props.description).toBeUndefined();
  expect(button().props["aria-describedby"]).toBeUndefined();
});

test("a Shake press ends when the window loses focus, and a click alone is a short shake", async () => {
  const listeners = new Map<string, Set<() => void>>();
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubGlobal("HTMLFormElement", class {});
  // The tooltip of a locked control listens for the pointer on the document.
  stubGlobal("document", { addEventListener() {}, removeEventListener() {} });
  stubGlobal("window", {
    addEventListener(type: string, listener: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type: string, listener: () => void) {
      listeners.get(type)?.delete(listener);
    },
    setTimeout,
    clearTimeout,
  });
  const calls: string[] = [];
  const client = {
    platform: "android",
    status: "streaming",
    recordingControlsLocked: false,
    orientationUnavailable: null,
    capabilities: { orientation: false, shake: true },
    orientation: null,
    shake: () => calls.push("client.shake"),
    startShake: () => calls.push("start"),
    stopShake: () => calls.push("stop"),
    deviceSettings: null,
    deviceSettingsStatus: "idle",
    deviceSettingsPending: new Set(),
  } as unknown as DeviceClient;
  await act(async () => {
    renderer = create(<DeviceOptionsSection client={client} platform="android" />);
  });
  const button = () => shakeButton();

  // Enter goes down, then the window loses focus and the key-up never comes.
  await act(async () => button().props.onKeyDown({ key: "Enter", repeat: false }));
  expect(listeners.get("blur")?.size).toBe(1);
  await act(async () => [...listeners.get("blur")!].forEach((listener) => listener()));
  expect(calls).toEqual(["start", "stop"]);
  expect(listeners.get("blur")?.size).toBe(0);
  // The click that followed the key press does not shake again.
  await act(async () => button().props.onClick());
  expect(calls).toEqual(["start", "stop"]);

  // Clicks with no pointer or key press before them, as a screen reader sends, each shake.
  await act(async () => button().props.onClick());
  await act(async () => button().props.onClick());
  expect(calls).toEqual(["start", "stop", "start", "stop", "start", "stop"]);
  expect(calls).not.toContain("client.shake");
});
