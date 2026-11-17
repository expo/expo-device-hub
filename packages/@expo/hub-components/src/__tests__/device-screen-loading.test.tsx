import { afterEach, describe, expect, test } from "bun:test";
import { type DeviceClient } from "@expo/hub-client";
import { useEffect } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { ActivityIndicator, LOADING_LABEL } from "../components/ActivityIndicator";
import { deviceScreenStage, screenShapeBorderRadius } from "../dashboard/DeviceScreenStage";
import { deviceScreenLoading } from "../dashboard/DeviceScreenStatus";
import { DeviceTitle } from "../dashboard/DeviceTitle";
import { type Device } from "../dashboard/data";
import { PhoneFrame } from "../dashboard/PhoneFrame";
import { StreamPanel } from "../dashboard/StreamPanel";
import {
  FoldableDeviceScreen,
  type FoldableDeviceScreenProps,
} from "../foldable/FoldableDeviceScreen";
import { useLingering } from "../dashboard/useLingering";
import { screenOff } from "../theme/tokens";
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
    // The toolbar's tooltips keep their open delay on window timers.
    setTimeout,
    clearTimeout,
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
    expect(deviceScreenLoading({ status: "connecting" })).toBe(true);
    expect(deviceScreenLoading({ status: "streaming" })).toBe(false);
    expect(deviceScreenLoading({ status: "reconnecting" })).toBe(false);
    expect(deviceScreenLoading({ status: "error" })).toBe(false);
    expect(deviceScreenLoading({ status: "idle" })).toBe(false);
    // A consumer's own preview, such as the 3D model, can extend the first load.
    expect(deviceScreenLoading({ status: "streaming" }, false)).toBe(true);
    expect(deviceScreenLoading({ status: "error" }, false)).toBe(false);
  });
});

describe("deviceScreenStage", () => {
  test("follows the session's first frame", () => {
    expect(deviceScreenStage(null)).toBe("off");
    expect(deviceScreenStage({ status: "idle", framePresented: false })).toBe("off");
    expect(deviceScreenStage({ status: "connecting", framePresented: false })).toBe("connecting");
    expect(deviceScreenStage({ status: "streaming", framePresented: true })).toBe("live");
    // A loaded screen never returns to the glow: its last frame stays.
    expect(deviceScreenStage({ status: "reconnecting", framePresented: true })).toBe("live");
    expect(deviceScreenStage({ status: "error", framePresented: true })).toBe("live");
    expect(deviceScreenStage({ status: "error", framePresented: false })).toBe("unavailable");
  });

  test("gives the glow the corners of the screen shape", () => {
    const corner = { n: 2, size: 40 };
    const circle = {
      width: 400,
      height: 800,
      topLeft: corner,
      topRight: corner,
      bottomRight: corner,
      bottomLeft: corner,
    };
    // A superellipse with exponent 2 is a circle: its radius is its size.
    expect(screenShapeBorderRadius(circle)).toBe("10.000cqw 10.000cqw 10.000cqw 10.000cqw");
    // A higher exponent is closer to a square corner, so its nearest circle is smaller.
    const squircle = { ...circle, topLeft: { n: 2.59, size: 77.43 } };
    expect(screenShapeBorderRadius(squircle).split(" ")[0]).toBe("15.518cqw");
  });
});

describe("useLingering", () => {
  test("stays on for the linger time after it ends, and comes back at once", async () => {
    stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const seen: boolean[] = [];
    function Probe({ active }: { active: boolean }) {
      seen.push(useLingering(active, 20));
      return null;
    }
    await act(async () => {
      renderer = create(<Probe active />);
    });
    await act(async () => renderer!.update(<Probe active={false} />));
    expect(seen.at(-1)).toBe(true);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(seen.at(-1)).toBe(false);
    await act(async () => renderer!.update(<Probe active />));
    expect(seen.at(-1)).toBe(true);
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

  test("glows on the black screen until the first frame, and the picture fades in above the glow", async () => {
    const { render, reported } = await frame(client("connecting", false));
    const glow = renderer!.root.findByProps({ "data-testid": "device-screen-loading" });
    expect(glow.props.className).toBe("hub-screen-glow");
    // A status region announces its text: the one loading label, hidden inside it.
    expect(glow.props.role).toBe("status");
    expect(glow.findByType("span").children).toEqual([LOADING_LABEL]);
    const clip = renderer!.root.findByProps({ "data-testid": "device-screen-clip" });
    // The glow is its own layer, not a background under the stream.
    expect(clip.props.style.backgroundColor).toBeUndefined();
    const stream = () => renderer!.root.findByProps({ "data-testid": "device-screen-stream" });
    expect(stream().props["data-presented"]).toBeUndefined();
    expect(renderer!.root.findAllByProps({ role: "alert" })).toHaveLength(0);
    expect(reported.at(-1)).toBe(true);

    await render(client("streaming", true));
    expect(testIds(renderer!)).not.toContain("device-screen-loading");
    expect(reported.at(-1)).toBe(false);
    expect(stream().props.className).toBe("hub-screen-stream");
    expect(stream().props["data-presented"]).toBe("true");
    // The glow stays under the picture while that fades in. It announces nothing then.
    const leaving = renderer!.root.findByProps({ "data-testid": "device-screen-glow-leaving" });
    expect(leaving.props["data-leaving"]).toBe("true");
    expect(leaving.props.role).toBeUndefined();
    expect(leaving.props["aria-hidden"]).toBe(true);
  });

  test("an input error shows over the glow, because input can work before the video", async () => {
    await frame(client("connecting", false, { inputError: "Input is not connected." }));
    expect(testIds(renderer!)).toContain("device-screen-loading");
    const notice = renderer!.root.findByProps({ "aria-live": "polite" });
    expect(notice.children).toEqual(["Input is not connected."]);
  });

  test("an idle device shows a black screen, with no glow and no stream", async () => {
    await frame(client("idle", false));
    const surface = renderer!.root.findByProps({ "data-testid": "device-screen-surface" });
    expect(surface.props.style.backgroundColor).toBe(screenOff);
    expect(testIds(renderer!)).not.toContain("device-screen-loading");
    expect(testIds(renderer!)).not.toContain("live-screen");
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

  test("an error replaces the glow: the screen says why before the first frame, and a notice covers the picture after it", async () => {
    const { render } = await frame(client("connecting", false));
    await render(client("error", false));
    expect(testIds(renderer!)).not.toContain("device-screen-loading");
    const unavailable = renderer!.root.findByProps({ "data-testid": "device-screen-unavailable" });
    const alert = unavailable.findByProps({ role: "alert" });
    expect(alert.findAllByType("p").map((line) => line.children.join(""))).toEqual([
      "Device screen unavailable",
      "WebRTC offer failed: HTTP 403.",
    ]);
    expect(renderer!.root.findAllByProps({ role: "alert" })).toHaveLength(1);

    await render(client("error", true));
    expect(testIds(renderer!)).not.toContain("device-screen-unavailable");
    expect(renderer!.root.findByProps({ role: "alert" }).children).toEqual([
      "WebRTC offer failed: HTTP 403.",
    ]);
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
  let markModelSettled: (settled: boolean) => void = () => {};
  function Model({ onModelSettledChange }: FoldableDeviceScreenProps) {
    useEffect(() => {
      markModelSettled = (settled) => onModelSettledChange?.(settled);
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
    // The label is inside the live region, in the element that animates when the status changes.
    const pill = () =>
      renderer!.root
        .findAll((node) => node.props["aria-live"] === "polite")
        .map((node) => node.findAllByProps({ className: "hub-status-label" }))
        .map(([label]) => label?.children.join("") ?? "");
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

    await act(async () => markModelSettled(true));
    expect(testIds(renderer!)).not.toContain("device-screen-loading");
    expect(pill()).toContain("Live");

    // A panel handoff or reconnect after that keeps the model without a spinner.
    await render(duo("reconnecting", true));
    expect(testIds(renderer!)).not.toContain("device-screen-loading");
    expect(pill()).toContain("Reconnecting");
  });

  test("a 3D model that fails ends the spinner over the flat fallback without onUnavailable", async () => {
    browserGlobals();
    const reported: boolean[] = [];
    const duoClient = client("streaming", true, {
      fold: { pending: false, error: null, setControl() {} },
      displays: [
        { id: "cover", active: true, attachVideo() {} },
        { id: "inner", active: false, attachVideo() {} },
      ],
      deviceModelUrl: "https://hub.test/grid/api/devicekit-model",
      capabilities: { clipboard: false, fold: false },
      videoKind: "img",
    } as unknown as Partial<DeviceClient>);
    // With mounted elements the scene starts, and WebGL fails without a browser canvas.
    await act(async () => {
      renderer = create(
        <PhoneFrame
          device={device("duo")}
          client={duoClient}
          DeviceScreen={Screen}
          FoldableDeviceScreen={FoldableDeviceScreen}
          foldPreview={{ mode: "3d" }}
          displayScreen={(screen) => screen ?? null}
          onLoadingChange={(loading) => reported.push(loading)}
        />,
        { createNodeMock: () => ({ contains: () => false, focus() {} }) },
      );
    });
    expect(renderer!.root.findByProps({ "data-duo-model": "unavailable" })).toBeDefined();
    expect(testIds(renderer!)).not.toContain("device-screen-loading");
    expect(reported.at(-1)).toBe(false);
  });
});

test("a flat fallback stays hidden and inert until the session's first frame, though the model has settled", async () => {
  browserGlobals();
  const settled: boolean[] = [];
  const duo = (status: DeviceClient["status"], framePresented: boolean) =>
    client(status, framePresented, {
      fold: { pending: false, error: null, setControl() {} },
      displays: [
        { id: "cover", active: true, attachVideo() {} },
        { id: "inner", active: false, attachVideo() {} },
      ],
      deviceModelUrl: "https://hub.test/grid/api/devicekit-model",
      capabilities: { clipboard: false, fold: false },
      videoKind: "img",
    } as unknown as Partial<DeviceClient>);
  const render = (current: DeviceClient) => (
    <FoldableDeviceScreen client={current} onModelSettledChange={(value) => settled.push(value)} />
  );
  // Without onUnavailable, WebGL fails and the preview shows its own flat fallback.
  await act(async () => {
    renderer = create(render(duo("connecting", false)), {
      createNodeMock: () => ({ contains: () => false, focus() {} }),
    });
  });
  expect(renderer!.root.findByProps({ "data-duo-model": "unavailable" })).toBeDefined();
  expect(settled.at(-1)).toBe(true);
  const host = () => renderer!.root.findByProps({ role: "application" }).props;
  // The session has no frame yet: a retained canvas may still hold old pixels.
  expect(host().tabIndex).toBe(-1);
  expect(host()["aria-hidden"]).toBe(true);
  expect(host().inert).toBe(true);
  await act(async () => renderer!.update(render(duo("streaming", true))));
  expect(host().tabIndex).toBe(0);
  expect(host()["aria-hidden"]).toBeUndefined();
});

test("the status pill names the first load with the loading label", () => {
  const markup = renderToStaticMarkup(
    <DeviceTitle device={{ id: "a", name: "iPhone" }} status="connecting" />,
  );
  expect(markup).toContain(`>${LOADING_LABEL}<`);
  expect(markup).not.toContain("Starting<");
});

test("a loading 3D preview takes no keyboard focus and is not announced", () => {
  // Server rendering runs no effects, so the model is still loading.
  const markup = renderToStaticMarkup(
    <FoldableDeviceScreen
      client={client("streaming", true, {
        fold: { pending: false, error: null, setControl() {} },
        displays: [
          { id: "cover", active: true, attachVideo() {} },
          { id: "inner", active: false, attachVideo() {} },
        ],
        deviceModelUrl: "https://hub.test/grid/api/devicekit-model",
        capabilities: { clipboard: false, fold: false },
        videoKind: "img",
      } as unknown as Partial<DeviceClient>)}
    />,
  );
  const host = markup.slice(markup.indexOf('role="application"'), markup.indexOf(">"));
  expect(host).toContain('tabindex="-1"');
  expect(host).toContain('aria-hidden="true"');
  // The hinge handles inside keep tabIndex 0, so the whole subtree is inert.
  expect(host).toContain('inert=""');
});
