import { afterEach, expect, test } from "bun:test";
import { DeviceScreen, type DeviceClient, type DevicePlayback } from "@expo/hub-client";
import { act, create, type ReactTestRenderer, type ReactTestInstance } from "react-test-renderer";

import { PhoneFrame } from "../dashboard/PhoneFrame";
import { type Device } from "../dashboard/data";
import { FoldableDeviceScreen } from "../foldable/FoldableDeviceScreen";
import { createGlobalStubs } from "./test-globals";

const { stubGlobal, restoreGlobals } = createGlobalStubs();
let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreGlobals();
});
const device: Device = {
  id: "duo",
  name: "iPhone Duo",
  platform: "ios",
  version: "27.1",
  booted: true,
  physical: false,
  supported: true,
  deviceFrame: null,
};
function setup() {
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubGlobal("window", {
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  stubGlobal("document", {
    hidden: false,
    addEventListener() {},
    removeEventListener() {},
    documentElement: { getAttribute: () => null },
  });
}
function fixture(playback?: DevicePlayback): DeviceClient {
  return {
    platform: "ios",
    status: "connecting",
    framePresented: false,
    screen: { width: 1398, height: 2034 },
    videoKind: "video",
    error: null,
    inputError: null,
    playback,
    capabilities: { clipboard: false, fold: false },
    fold: { pending: false, error: null, setControl() {} },
    displays: [
      { id: "cover", active: true, attachVideo() {} },
      { id: "inner", active: false, attachVideo() {} },
    ],
    deviceModelUrl: "https://hub.test/model",
    attachVideo() {},
    sendTouch() {
      throw Error("unexpected input");
    },
    sendKey() {
      throw Error("unexpected input");
    },
  } as unknown as DeviceClient;
}
async function render(client: DeviceClient, mode: "2d" | "3d") {
  await act(async () => {
    const element = (
      <PhoneFrame
        device={device}
        client={client}
        DeviceScreen={DeviceScreen}
        FoldableDeviceScreen={FoldableDeviceScreen}
        foldPreview={{ mode }}
        displayScreen={(screen) => screen ?? null}
      />
    );
    // No host refs: the actual 3D renderer remains in its first-load path without starting WebGL.
    if (renderer) renderer.update(element);
    else renderer = create(element);
  });
}
const hosts = (type: string) => renderer!.root.findAll((node) => node.type === type);
function assertExposed(button: ReactTestInstance) {
  for (let node: ReactTestInstance | null = button; node; node = node.parent) {
    expect(node.props.inert).not.toBe(true);
    expect(node.props["aria-hidden"]).not.toBe(true);
    expect(node.props.style?.opacity).not.toBe(0);
    expect(node.props.style?.visibility).not.toBe("hidden");
    expect(node.props.style?.display).not.toBe("none");
  }
}
for (const mode of ["2d", "3d"] as const) {
  test(`${mode}: first-frame recovery stays exposed and resumes synchronously without replacing media`, async () => {
    setup();
    let clicked = false;
    let resumed = false;
    const playback: DevicePlayback = {
      state: "blocked",
      error: null,
      resume: () => {
        expect(clicked).toBe(true);
        resumed = true;
        return Promise.resolve();
      },
    };
    const client = fixture(playback);
    await render(client, mode);
    const video = hosts("video")[0];
    expect(video).toBeDefined();
    if (mode === "3d") {
      const application = renderer!.root.findByProps({ role: "application" });
      expect(application.props.inert).toBe(true);
      expect(application.props["aria-hidden"]).toBe(true);
      expect(application.props.style.opacity).toBe(0);
    } else expect(video.props.style.opacity).toBe(0);
    const button = hosts("button").find((node) =>
      node.findAllByType("span").some((span) => span.children.includes("Start live view")),
    )!;
    assertExposed(button);
    expect(renderer!.root.findAllByProps({ "data-testid": "device-screen-loading" })).toHaveLength(
      0,
    );
    clicked = true;
    button.props.onClick();
    expect(resumed).toBe(true);
    await render({ ...client, playback: { ...playback, state: "playing" } }, mode);
    expect(hosts("video")[0]).toBe(video);
    expect(renderer!.root.findAllByProps({ "data-testid": "playback-recovery" })).toHaveLength(0);
    expect(renderer!.root.findAllByProps({ "data-testid": "device-screen-loading" })).toHaveLength(
      1,
    );
    await render(
      { ...client, playback: { ...playback, state: "error", error: "Playback failed" } },
      mode,
    );
    expect(renderer!.root.findByProps({ role: "status" }).children).toEqual(["Playback failed"]);
    await render({ ...client, status: "error", error: "Connection failed" }, mode);
    expect(renderer!.root.findAllByProps({ "data-testid": "playback-recovery" })).toHaveLength(0);
    expect(renderer!.root.findByProps({ role: "alert" }).children).toEqual(["Connection failed"]);
    await render({ ...client, status: "idle" }, mode);
    expect(renderer!.root.findAllByProps({ "data-testid": "playback-recovery" })).toHaveLength(0);
  });
  test(`${mode}: clients without playback retain one loading presentation`, async () => {
    setup();
    await render(fixture(), mode);
    expect(renderer!.root.findAllByProps({ "data-testid": "playback-recovery" })).toHaveLength(0);
    expect(renderer!.root.findAllByProps({ "data-testid": "device-screen-loading" })).toHaveLength(
      1,
    );
  });
}
