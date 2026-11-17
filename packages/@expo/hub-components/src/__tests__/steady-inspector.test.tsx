import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";

import { type DeviceClient } from "@expo/hub-client";
import { CollapsibleSection } from "../dashboard/CollapsibleSection";
import { type Device } from "../dashboard/data";
import {
  DeviceOptionsSection,
  SETTING_UNSUPPORTED_REASON,
  SETTINGS_UNAVAILABLE_REASON,
} from "../dashboard/DeviceOptionsSection";
import { InspectorSections, SECTION_UNAVAILABLE_NOTE } from "../dashboard/InspectorSections";
import { useSteadyClient } from "../dashboard/useSteadyClient";
import { createGlobalStubs } from "./test-globals";

const { stubGlobal, restoreGlobals } = createGlobalStubs();
let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubGlobal("HTMLFormElement", class {});
  stubGlobal("window", {
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
  });
  // The tooltip of a locked control listens for the pointer on the document.
  stubGlobal("document", { addEventListener() {}, removeEventListener() {} });
});

afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreGlobals();
});

const NO_CAPABILITIES = {
  deviceSettings: false,
  activity: false,
  events: false,
  camera: false,
  accessibility: false,
  streamSettings: false,
  location: false,
  permissions: false,
  clipboard: false,
  orientation: false,
  fold: false,
} satisfies DeviceClient["capabilities"];

/** A client that has reported nothing yet: what a device shows while it connects. */
const CONNECTING = {
  platform: "ios",
  status: "connecting",
  capabilities: NO_CAPABILITIES,
  streamCapabilities: null,
  deviceSettings: null,
  deviceSettingsStatus: "loading",
  deviceSettingsPending: new Set(),
  streamSettings: null,
  streamSettingsPending: false,
  streamSource: null,
  streamSourcePending: false,
  streamStats: null,
  setStreamStatsEnabled: () => {},
  orientation: null,
  orientationUnavailable: null,
  orientationError: null,
  fold: null,
  displayWidthDp: null,
  recordingLock: null,
  hardwareKeyboardConnected: null,
  foregroundApp: null,
  logs: [],
  webRtcCodec: "h264",
} as unknown as DeviceClient;

/** The same device once it streams. */
const STREAMING = {
  ...CONNECTING,
  status: "streaming",
  capabilities: {
    ...NO_CAPABILITIES,
    deviceSettings: true,
    location: { clear: true },
    orientation: { orientations: ["portrait", "landscape_left"] },
    streamSettings: { maxDimension: true },
  },
  streamCapabilities: {
    modeAvailability: { mjpeg: true, h264: true, webrtc: true },
    httpCodecs: ["auto", "h264", "mjpeg"],
    webRtcCodecs: ["h264"],
  },
  deviceSettings: { appearance: "dark", "text-size": "large", "reduce-motion": "on" },
  deviceSettingsStatus: "ready",
  streamSettings: {
    mjpegFps: 30,
    mjpegQuality: 0.7,
    maxDimension: 1280,
    h264Bitrate: 6e6,
    h264Fps: 30,
  },
  orientation: "landscape_left",
} as unknown as DeviceClient;

const IPHONE: Device = {
  id: "iphone",
  name: "iPhone 17 Pro",
  version: "iOS 26.5",
  platform: "ios",
  booted: true,
  physical: false,
  supported: true,
};

const sectionTitles = (markup: string) =>
  [...markup.matchAll(/<section aria-label="([^"]+)"/g)].map((match) => match[1]);

/** The row labels of the Device options section, in order. */
const rowLabels = () =>
  renderer!.root
    .findAll((node) => typeof node.type === "function" && node.type.name === "SidebarRow")
    .map((node) => node.props.label as string);

describe("useSteadyClient", () => {
  function Probe({ client, device }: { client: DeviceClient; device: Device }) {
    const steady = useSteadyClient(client, device);
    return (
      <output
        data-settings={JSON.stringify(steady?.client.deviceSettings)}
        data-location={JSON.stringify(steady?.client.capabilities.location)}
        data-stale={[...(steady?.stale ?? [])].sort().join(",")}
      />
    );
  }
  const probe = () => renderer!.root.findByType("output").props;

  test("keeps the last reported values while the client reports none, and marks them stale", async () => {
    await act(async () => {
      renderer = create(<Probe client={STREAMING} device={IPHONE} />);
    });
    expect(probe()["data-stale"]).toBe("");

    // A reconnect: the client reports its capabilities and settings as absent again.
    await act(async () => renderer!.update(<Probe client={CONNECTING} device={IPHONE} />));
    expect(JSON.parse(probe()["data-settings"])).toEqual(STREAMING.deviceSettings);
    expect(JSON.parse(probe()["data-location"])).toEqual({ clear: true });
    expect(probe()["data-stale"]).toBe(
      "deviceSettings,orientation,streamCapabilities,streamSettings",
    );

    // The next report replaces the kept values.
    const changed = {
      ...STREAMING,
      deviceSettings: { appearance: "light" },
    } as unknown as DeviceClient;
    await act(async () => renderer!.update(<Probe client={changed} device={IPHONE} />));
    expect(JSON.parse(probe()["data-settings"])).toEqual({ appearance: "light" });
    expect(probe()["data-stale"]).toBe("");
  });

  test("does not pass one device's values to another device, only its platform's capabilities", async () => {
    await act(async () => {
      renderer = create(<Probe client={STREAMING} device={IPHONE} />);
    });
    const other: Device = { ...IPHONE, id: "other" };
    await act(async () => renderer!.update(<Probe client={CONNECTING} device={other} />));

    expect(probe()["data-settings"]).toBe("null");
    // The sections of the platform are in place before the new device connects.
    expect(JSON.parse(probe()["data-location"])).toEqual({ clear: true });
  });

  test("settles when a client builds an equal object again on each render", async () => {
    // hub-client's iOS adapter creates `streamCapabilities` anew on each render.
    const rebuilt = () =>
      ({
        ...STREAMING,
        streamCapabilities: structuredClone(STREAMING.streamCapabilities),
      }) as DeviceClient;
    await act(async () => {
      renderer = create(<Probe client={rebuilt()} device={IPHONE} />);
    });
    await act(async () => renderer!.update(<Probe client={rebuilt()} device={IPHONE} />));
    expect(probe()["data-stale"]).toBe("");
  });
});

describe("InspectorSections", () => {
  test("shows the same sections while a device connects as once it streams", () => {
    const connecting = sectionTitles(
      renderToStaticMarkup(<InspectorSections client={CONNECTING} device={IPHONE} />),
    );
    expect(connecting).toEqual([
      "Current app",
      "Device options",
      "Stream options",
      "Accessibility",
      "Location",
      "Clipboard",
      "Events",
      "Logs",
    ]);
    const android = sectionTitles(
      renderToStaticMarkup(
        <InspectorSections
          client={{ ...CONNECTING, platform: "android" } as DeviceClient}
          device={{ ...IPHONE, platform: "android" }}
        />,
      ),
    );
    expect(android).toEqual([
      "Current app",
      "Device options",
      "Stream options",
      "Camera",
      "Accessibility",
      "Location",
      "Permissions",
      "Events",
      "Logs",
    ]);
  });

  test("a section whose capability is absent says so in place of its controls", async () => {
    await act(async () => {
      renderer = create(<InspectorSections client={CONNECTING} device={IPHONE} />);
    });
    const location = renderer!.root.find(
      (node) => node.type === CollapsibleSection && node.props.title === "Location",
    );
    await act(async () => location.props.onOpenChange(true));
    expect(JSON.stringify(renderer!.toJSON())).toContain(SECTION_UNAVAILABLE_NOTE);
  });

  test("gives the sibling sections that are keyed by the device distinct keys", async () => {
    // With equal keys, React repeats a section on update and reports the keys.
    const errors: string[] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
    try {
      const client = {
        ...STREAMING,
        capabilities: {
          ...STREAMING.capabilities,
          location: { clear: true },
          clipboard: { paste: true, copy: true },
        },
      } as DeviceClient;
      await act(async () => {
        renderer = create(<InspectorSections client={client} device={IPHONE} />);
      });
      await act(async () =>
        renderer!.update(<InspectorSections client={client} device={{ ...IPHONE, id: "other" }} />),
      );
    } finally {
      console.error = consoleError;
    }
    expect(errors.filter((message) => message.includes("same key"))).toEqual([]);
  });

  test("keeps only the app and the logs without a selected device", () => {
    expect(sectionTitles(renderToStaticMarkup(<InspectorSections client={CONNECTING} />))).toEqual([
      "Current app",
      "Logs",
    ]);
  });
});

describe("DeviceOptionsSection rows", () => {
  const IOS_ROWS = [
    "Appearance",
    "Liquid glass",
    "Color filter",
    "Text size",
    "Reduce motion",
    "Increase contrast",
    "Show borders",
    "Reduce transparency",
    "VoiceOver",
    "Orientation",
    "Hardware keyboard",
    "Software keyboard",
  ];

  test("an iOS device has the same rows while it connects, streams, and reconnects", async () => {
    await act(async () => {
      renderer = create(<DeviceOptionsSection client={CONNECTING} platform="ios" />);
    });
    expect(rowLabels()).toEqual(IOS_ROWS);
    await act(async () =>
      renderer!.update(<DeviceOptionsSection client={STREAMING} platform="ios" />),
    );
    expect(rowLabels()).toEqual(IOS_ROWS);
    await act(async () =>
      renderer!.update(
        <DeviceOptionsSection
          client={{ ...CONNECTING, deviceSettingsStatus: "error" } as DeviceClient}
          platform="ios"
        />,
      ),
    );
    expect(rowLabels()).toEqual(IOS_ROWS);
  });

  test("an Android device has its own rows", async () => {
    await act(async () => {
      renderer = create(
        <DeviceOptionsSection
          client={{ ...CONNECTING, platform: "android" } as DeviceClient}
          platform="android"
        />,
      );
    });
    expect(rowLabels()).toEqual([
      "Appearance",
      "Network",
      "Text size",
      "Display size",
      "Reduce motion",
      "Bold text",
      "Increase contrast",
      "Force on-screen keyboard",
      "Orientation",
      "Back button",
      "Recents button",
      "Dismiss on-screen keyboard",
    ]);
  });

  test("a row shows its value when known, and locks with a reason when it cannot change", async () => {
    const control = (label: string) =>
      renderer!.root.find(
        (node) =>
          typeof node.type === "function" &&
          (node.props.ariaLabel === label || node.props.label === label) &&
          "disabled" in node.props,
      ).props as { value?: string; checked?: boolean; disabled: boolean; disabledReason?: string };

    // Loading: locked, no value, and no reason yet.
    await act(async () => {
      renderer = create(<DeviceOptionsSection client={CONNECTING} platform="ios" />);
    });
    expect(control("Appearance")).toMatchObject({ value: "", disabled: true });
    expect(control("Appearance").disabledReason).toBeUndefined();

    // Ready: values show. A setting that the device does not report is locked and says so.
    await act(async () =>
      renderer!.update(<DeviceOptionsSection client={STREAMING} platform="ios" />),
    );
    expect(control("Appearance")).toMatchObject({ value: "dark", disabled: false });
    expect(control("Reduce motion")).toMatchObject({ checked: true, disabled: false });
    expect(control("Liquid glass")).toMatchObject({
      value: "",
      disabled: true,
      disabledReason: SETTING_UNSUPPORTED_REASON,
    });

    // A kept value while the settings cannot be read: the row stays, with its value, locked.
    await act(async () =>
      renderer!.update(
        <DeviceOptionsSection
          client={{ ...STREAMING, deviceSettingsStatus: "error" } as DeviceClient}
          platform="ios"
          stale={new Set(["deviceSettings"])}
        />,
      ),
    );
    expect(control("Appearance")).toMatchObject({
      value: "dark",
      disabled: true,
      disabledReason: SETTINGS_UNAVAILABLE_REASON,
    });
  });
});
