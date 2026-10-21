import { afterEach, describe, expect, test } from "bun:test";
import { type DeviceClient } from "@expo/hub-client";
import { useEffect } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { ActivityIndicator, LOADING_LABEL } from "../components/ActivityIndicator";
import { deviceScreenLoading } from "../dashboard/DeviceScreenStatus";
import { DeviceTitle } from "../dashboard/DeviceTitle";
import { type Device } from "../dashboard/data";
import { PhoneFrame } from "../dashboard/PhoneFrame";
import { StreamPanel } from "../dashboard/StreamPanel";
import { type FoldableDeviceScreenProps } from "../foldable/FoldableDeviceScreen";
import { bg } from "../theme/tokens";
import { createGlobalStubs } from "./test-globals";

const { stubGlobal, restoreGlobals } = createGlobalStubs();
let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreGlobals();
});

function device(id: string): Device {
  return {
    id,
    name: id === "duo" ? "iPhone Duo" : "iPhone 17 Pro",
    version: "iOS 27.1",
    platform: "ios",
    booted: true,
    physical: false,
    supported: true,
    deviceFrame: null,
  };
}

function client(
  status: DeviceClient["status"],
  framePresented: boolean,
  extra: Partial<DeviceClient> = {},
): DeviceClient {
  return {
    platform: "ios",
    status,
    framePresented,
    error: status === "error" ? "WebRTC offer failed: HTTP 403." : null,
    inputError: null,
    screen: { width: 1206, height: 2622 },
    fold: null,
    displays: null,
    deviceModelUrl: null,
    displayCorners: null,
    screenRecording: null,
    deviceSettings: null,
    deviceSettingsStatus: "idle",
    deviceSettingsPending: new Set(),
    capabilities: { clipboard: false },
    ...extra,
  } as unknown as DeviceClient;
}

/** What the spinner's motion query and the panel's toasters read in a browser. */
function browserGlobals() {
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const media = { matches: false, addEventListener() {}, removeEventListener() {} };
  stubGlobal("window", {
    matchMedia: () => media,
    getComputedStyle: () => ({ direction: "ltr" }),
    addEventListener() {},
    removeEventListener() {},
  });
  stubGlobal("document", {
    hidden: false,
    documentElement: { getAttribute: () => null },
    addEventListener() {},
    removeEventListener() {},
  });
  stubGlobal("requestAnimationFrame", (callback: () => void) => setTimeout(callback, 0));
}

const Screen = () => <div data-testid="live-screen" />;
const testIds = (root: ReactTestRenderer) =>
  root.root
    .findAll((node) => typeof node.props["data-testid"] === "string")
    .map((node) => node.props["data-testid"] as string);

describe("ActivityIndicator", () => {
  test("announces the one loading label and turns unless motion is reduced", () => {
    const markup = renderToStaticMarkup(<ActivityIndicator />);
    expect(LOADING_LABEL).toBe("Loading");
    // A status region announces its text, not an aria-label: the label is hidden text inside it.
    const region = markup.slice(markup.indexOf('role="status"'), markup.indexOf("<svg"));
    expect(region).toContain(`>${LOADING_LABEL}</span>`);
    expect(markup).not.toContain("aria-label");
    expect(markup).toContain("animateTransform");

    stubGlobal("window", {
      matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    });
    expect(renderToStaticMarkup(<ActivityIndicator />)).not.toContain("animateTransform");
  });
});

describe("deviceScreenLoading", () => {
  test("only a session without a frame loads; errors and idle never spin", () => {
    expect(deviceScreenLoading({ status: "connecting", framePresented: false })).toBe(true);
    expect(deviceScreenLoading({ status: "streaming", framePresented: true })).toBe(false);
    expect(deviceScreenLoading({ status: "reconnecting", framePresented: true })).toBe(false);
    expect(deviceScreenLoading({ status: "error", framePresented: false })).toBe(false);
    expect(deviceScreenLoading({ status: "idle", framePresented: false })).toBe(false);
    // A consumer's own preview, such as the 3D model, can extend the first load.
    expect(deviceScreenLoading({ status: "streaming", framePresented: true }, false)).toBe(true);
    expect(deviceScreenLoading({ status: "error", framePresented: true }, false)).toBe(false);
  });
});

describe("PhoneFrame first load", () => {
  async function frame(initial: DeviceClient, id = "iphone") {
    browserGlobals();
    const reported: boolean[] = [];
    const render = async (next: DeviceClient, nextId = id) => {
      const element = (
        <PhoneFrame
          device={device(nextId)}
          client={next}
          DeviceScreen={Screen}
          displayScreen={(screen) => screen ?? null}
          onLoadingChange={(loading) => reported.push(loading)}
        />
      );
      await act(async () => {
        if (renderer) renderer.update(element);
        else renderer = create(element);
      });
    };
    await render(initial);
    return { render, reported };
  }

  test("shows one spinner on the device surface, never black, until the first frame", async () => {
    const { render, reported } = await frame(client("connecting", false));
    expect(testIds(renderer!)).toContain("device-screen-loading");
    const clip = renderer!.root.findByProps({ "data-testid": "device-screen-clip" });
    expect(clip.props.style.backgroundColor).toBe(bg.element);
    expect(renderer!.root.findAllByProps({ role: "alert" })).toHaveLength(0);
    expect(reported.at(-1)).toBe(true);

    await render(client("streaming", true));
    expect(testIds(renderer!)).not.toContain("device-screen-loading");
    expect(reported.at(-1)).toBe(false);
  });

  test("a drop after the first frame shows neither a spinner nor a notice", async () => {
    await frame(client("streaming", true));
    const { render } = await frame(client("reconnecting", true));
    await render(client("reconnecting", true));
    expect(testIds(renderer!)).not.toContain("device-screen-loading");
    expect(renderer!.root.findAllByProps({ role: "alert" })).toHaveLength(0);
    expect(testIds(renderer!)).toContain("live-screen");
  });

  test("another device shows the spinner again", async () => {
    const { render } = await frame(client("streaming", true));
    await render(client("connecting", false), "other");
    expect(testIds(renderer!)).toContain("device-screen-loading");
  });

  test("an error replaces the spinner, before and after the first frame", async () => {
    const { render } = await frame(client("connecting", false));
    await render(client("error", false));
    expect(testIds(renderer!)).not.toContain("device-screen-loading");
    expect(renderer!.root.findByProps({ role: "alert" }).children).toEqual([
      "WebRTC offer failed: HTTP 403.",
    ]);
    await render(client("error", true));
    expect(renderer!.root.findByProps({ role: "alert" })).toBeDefined();
    expect(testIds(renderer!)).toContain("live-screen");
  });
});

describe("the iPhone Duo 3D preview", () => {
  const duo = (status: DeviceClient["status"], framePresented: boolean) =>
    client(status, framePresented, {
      fold: { pending: false, error: null, setControl() {} },
      displays: [
        { id: "cover", active: true, attachVideo() {} },
        { id: "inner", active: false, attachVideo() {} },
      ],
      deviceModelUrl: "https://hub.test/grid/api/devicekit-model",
    } as Partial<DeviceClient>);
  let markModelReady: (ready: boolean) => void = () => {};
  function Model({ onModelReadyChange }: FoldableDeviceScreenProps) {
    useEffect(() => {
      markModelReady = (ready) => onModelReadyChange?.(ready);
    });
    return <div data-testid="model" />;
  }

  async function panel(initial: DeviceClient) {
    browserGlobals();
    const render = async (next: DeviceClient) => {
      const element = (
        <StreamPanel
          device={device("duo")}
          client={next}
          DeviceScreen={Screen}
          FoldableDeviceScreen={Model}
          foldPreview={{ mode: "3d" }}
          displayScreen={(screen) => screen ?? null}
        />
      );
      await act(async () => {
        if (renderer) renderer.update(element);
        else renderer = create(element);
      });
    };
    await render(initial);
    const pill = () =>
      renderer!.root
        .findAll((node) => node.props["aria-live"] === "polite")
        .map((node) => node.children.join(""));
    return { render, pill };
  }

  test("spins and says Loading until the model is loaded and the active display has a frame", async () => {
    const { render, pill } = await panel(duo("connecting", false));
    expect(testIds(renderer!)).toContain("device-screen-loading");
    expect(pill()).toContain(LOADING_LABEL);

    // The panel streams, but the model has not loaded: still one loading state, not Live.
    await render(duo("streaming", true));
    expect(testIds(renderer!)).toContain("device-screen-loading");
    expect(pill()).toContain(LOADING_LABEL);
    expect(pill()).not.toContain("Live");

    await act(async () => markModelReady(true));
    expect(testIds(renderer!)).not.toContain("device-screen-loading");
    expect(pill()).toContain("Live");

    // A panel handoff or reconnect after that keeps the model without a spinner.
    await render(duo("reconnecting", true));
    expect(testIds(renderer!)).not.toContain("device-screen-loading");
    expect(pill()).toContain("Reconnecting");
  });
});

test("the status pill names the first load with the spinner's label", () => {
  const markup = renderToStaticMarkup(
    <DeviceTitle device={{ id: "a", name: "iPhone" }} status="connecting" />,
  );
  expect(markup).toContain(`>${LOADING_LABEL}<`);
  expect(markup).not.toContain("Starting<");
});
