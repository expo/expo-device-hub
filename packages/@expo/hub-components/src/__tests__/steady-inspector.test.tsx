import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { useEffect, useState } from "react";
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
import {
  STREAM_SETTING_UNKNOWN_REASON,
  StreamOptionsSection,
  TRANSPORT_UNAVAILABLE_REASON,
} from "../dashboard/StreamOptionsSection";
import { GUESS_GRACE_MS, useSteadyClient } from "../dashboard/useSteadyClient";
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

test("hides the Keychain inspector when the current device disables it", async () => {
  const access = {
    ...STREAMING,
    capabilities: { ...STREAMING.capabilities, keychain: true },
    listKeychainKeys: async () => [],
    setKeychainValues: async () => ({ applied: false }) as const,
    deleteKeychainValues: async () => ({ applied: false }) as const,
  };
  await act(async () => {
    renderer = create(<InspectorSections client={access} device={IPHONE} />);
  });
  const visible = () => renderer!.root.findAllByProps({ "aria-label": "Keychain" }).length > 0;
  expect(visible()).toBe(true);
  const off = { ...access, capabilities: { ...access.capabilities, keychain: false } };
  await act(async () => renderer!.update(<InspectorSections client={off} device={IPHONE} />));
  expect(visible()).toBe(false);
});

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

  test("a device switch does not file the last device's reports under the next device", async () => {
    // Like hub-client's adapters: the settings are state, and an effect clears them for another device.
    let report: (settings: DeviceClient["deviceSettings"]) => void = () => {};
    function Adapter({ device }: { device: Device }) {
      const [settings, setSettings] = useState<DeviceClient["deviceSettings"]>(null);
      useEffect(() => {
        setSettings(null);
        report = setSettings;
      }, [device.id]);
      const client = { ...STREAMING, deviceSettings: settings } as DeviceClient;
      return <Probe client={client} device={device} />;
    }
    await act(async () => {
      renderer = create(<Adapter device={IPHONE} />);
    });
    await act(async () => report(STREAMING.deviceSettings));
    expect(JSON.parse(probe()["data-settings"])).toEqual(STREAMING.deviceSettings);

    // The render that selects the other device still holds the iPhone's settings.
    const other: Device = { ...IPHONE, id: "other" };
    await act(async () => renderer!.update(<Adapter device={other} />));
    expect(probe()["data-settings"]).toBe("null");
    expect(probe()["data-stale"]).toBe("");

    // The iPhone has its own settings again when it is selected again.
    await act(async () => renderer!.update(<Adapter device={IPHONE} />));
    expect(JSON.parse(probe()["data-settings"])).toEqual(STREAMING.deviceSettings);
    expect(probe()["data-stale"]).toBe("deviceSettings");
  });

  test("a physical device does not take the capabilities of a simulator or an emulator", async () => {
    await act(async () => {
      renderer = create(<Probe client={STREAMING} device={IPHONE} />);
    });
    const phone: Device = { ...IPHONE, id: "phone", physical: true };
    await act(async () => renderer!.update(<Probe client={CONNECTING} device={phone} />));
    expect(probe()["data-location"]).toBe("false");
  });

  test("a guess ends after the device has streamed for the grace time, so an unsupported control goes", async () => {
    jest.useFakeTimers();
    try {
      await act(async () => {
        renderer = create(<Probe client={STREAMING} device={IPHONE} />);
      });
      // Another simulator streams, and it reports no location support.
      const other: Device = { ...IPHONE, id: "other" };
      const withoutLocation = {
        ...STREAMING,
        capabilities: { ...STREAMING.capabilities, location: false },
      } as unknown as DeviceClient;
      await act(async () => renderer!.update(<Probe client={withoutLocation} device={other} />));
      // The client may not have read the capability yet, so the guess holds at first.
      expect(JSON.parse(probe()["data-location"])).toEqual({ clear: true });

      await act(async () => {
        jest.advanceTimersByTime(GUESS_GRACE_MS);
      });
      expect(probe()["data-location"]).toBe("false");

      // The device's own reports stay over its reconnects, as before.
      await act(async () => renderer!.update(<Probe client={CONNECTING} device={other} />));
      expect(probe()["data-location"]).toBe("false");
      expect(JSON.parse(probe()["data-settings"])).toEqual(STREAMING.deviceSettings);
    } finally {
      jest.useRealTimers();
    }
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

describe("StreamOptionsSection rows", () => {
  const ENCODER_ROWS = {
    ios: ["Max size", "MJPEG FPS", "MJPEG quality", "Video FPS", "Video bitrate"],
    android: ["Max size", "Video FPS", "Video bitrate"],
  };
  const encoderRows = () => rowLabels().filter((label) => ENCODER_ROWS.ios.includes(label));
  const select = (label: string) =>
    renderer!.root.find(
      (node) =>
        typeof node.type === "function" &&
        node.type.name === "Select" &&
        node.props.ariaLabel === label,
    ).props;

  test.each(["ios", "android"] as const)(
    "an %s device has its encoder rows before the client reports what it can change",
    async (platform) => {
      // The first device of a session: no other device has given a guess.
      const connecting = { ...CONNECTING, platform } as DeviceClient;
      await act(async () => {
        renderer = create(<StreamOptionsSection client={connecting} defaultOpen />);
      });
      expect(encoderRows()).toEqual(ENCODER_ROWS[platform]);
      // A row without a value is locked, with the placeholder and a reason.
      expect(select("Max size").value).toBe("");
      expect(select("Max size").disabled).toBe(true);
      expect(select("Max size").disabledReason).toBe(STREAM_SETTING_UNKNOWN_REASON);

      const streaming = {
        ...STREAMING,
        platform,
        capabilities: {
          ...STREAMING.capabilities,
          streamSettings: { maxDimension: true, h264Fps: true, h264Bitrate: true },
        },
      } as unknown as DeviceClient;
      await act(async () =>
        renderer!.update(<StreamOptionsSection client={streaming} defaultOpen />),
      );
      expect(encoderRows()).toEqual(ENCODER_ROWS[platform]);
      expect(select("Max size").value).toBe("1280");
      expect(select("Max size").disabled).toBe(false);
    },
  );

  test("the codec rows and the Android source row stay when the server offers nothing for them", async () => {
    // serve-sim on HTTP has no WebRTC codecs, and a WebRTC server has no HTTP codecs.
    const httpOnly = {
      ...STREAMING,
      streamCapabilities: {
        modeAvailability: { mjpeg: true, h264: true, webrtc: false },
        httpCodecs: ["auto", "h264", "mjpeg"],
        webRtcCodecs: [],
      },
    } as unknown as DeviceClient;
    await act(async () => {
      renderer = create(<StreamOptionsSection client={httpOnly} defaultOpen />);
    });
    expect(rowLabels().slice(0, 3)).toEqual(["Transport", "HTTP codec", "WebRTC codec"]);
    expect(select("WebRTC codec").disabled).toBe(true);
    expect(select("WebRTC codec").disabledReason).toBe(TRANSPORT_UNAVAILABLE_REASON);

    // An Android device has the Source row before its client reports the sources.
    const android = { ...CONNECTING, platform: "android" } as DeviceClient;
    await act(async () => renderer!.update(<StreamOptionsSection client={android} defaultOpen />));
    expect(rowLabels().slice(0, 4)).toEqual([
      "Source",
      "Transport",
      "WebSocket codec",
      "WebRTC codec",
    ]);
    expect(select("Stream source").disabled).toBe(true);
    expect(select("Stream source").disabledReason).toBe(STREAM_SETTING_UNKNOWN_REASON);
  });

  test("a setting that the backend cannot change stays as a locked row", async () => {
    // serve-sim reports no stream settings for a server that is locked to WebRTC.
    const locked = {
      ...STREAMING,
      capabilities: { ...STREAMING.capabilities, streamSettings: false },
    } as unknown as DeviceClient;
    await act(async () => {
      renderer = create(<StreamOptionsSection client={locked} defaultOpen />);
    });
    expect(encoderRows()).toEqual(ENCODER_ROWS.ios);
    expect(select("Video bitrate").disabled).toBe(true);
    expect(select("Video bitrate").disabledReason).toBe(STREAM_SETTING_UNKNOWN_REASON);
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
