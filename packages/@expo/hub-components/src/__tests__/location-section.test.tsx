import { describe, expect, test } from "bun:test";
import { type DeviceClient, type DeviceLocationCapabilities } from "@expo/hub-client";
import { renderToStaticMarkup } from "react-dom/server";

import { LocationSection } from "../dashboard/LocationSection";

const BASE_CLIENT: DeviceClient = {
  platform: "android",
  status: "streaming",
  error: null,
  screen: { width: 1080, height: 2400 },
  fps: 60,
  devices: [],
  logs: [],
  logsEnabled: false,
  attachLogs: () => {},
  detachLogs: () => {},
  clearLogs: () => {},
  events: [],
  eventsEnabled: false,
  attachEvents: () => {},
  detachEvents: () => {},
  clearEvents: () => {},
  activity: null,
  deviceSettings: null,
  deviceSettingsPending: new Set(),
  setDeviceSetting: () => {},
  displayWidthDp: null,
  camera: null,
  cameraPending: new Set(),
  cameraError: null,
  setCameraImage: () => {},
  clearCameraImage: () => {},
  accessibility: null,
  accessibilityPending: false,
  accessibilityError: null,
  refreshAccessibility: () => {},
  location: null,
  locationPending: false,
  locationError: null,
  setLocation: () => {},
  clearLocation: () => {},
  permissions: null,
  permissionsPending: new Set<string>(),
  permissionsError: null,
  setPermission: () => {},
  resetPermissions: () => {},
  refreshPermissions: () => {},
  streamCapabilities: null,
  streamSettings: null,
  streamSettingsPending: false,
  updateStreamSettings: () => {},
  streamSource: null,
  streamSourcePending: false,
  streamSourceError: null,
  setStreamSource: () => {},
  setGrpcImageMode: () => {},
  setGrpcEncoder: () => {},
  setGrpcInputSource: () => {},
  streamStats: null,
  setStreamStatsEnabled: () => {},
  webRtcCodec: "h264",
  setWebRtcCodec: () => {},
  capabilities: {
    deviceSettings: false,
    activity: false,
    events: false,
    camera: false,
    accessibility: false,
    streamSettings: {},
    location: {},
    permissions: false,
  },
  foregroundApp: null,
  videoKind: "img",
  attachVideo: () => {},
  sendTouch: () => {},
  sendKey: () => false,
  pressButton: () => {},
  reload: () => {},
  rotate: () => {},
  screenshot: async () => null,
  appearance: "light",
  setAppearance: () => {},
  hardwareKeyboardConnected: null,
  setHardwareKeyboardConnected: () => {},
  toggleSoftwareKeyboard: () => {},
};

function locationClient(
  overrides: Partial<DeviceClient> = {},
  location: DeviceLocationCapabilities = {},
): DeviceClient {
  return {
    ...BASE_CLIENT,
    ...overrides,
    capabilities: { ...BASE_CLIENT.capabilities, location },
  };
}

function render(client: DeviceClient) {
  return renderToStaticMarkup(<LocationSection client={client} defaultOpen />);
}

function inputTag(html: string, label: string) {
  const labelIndex = html.indexOf(`aria-label="${label}"`);
  expect(labelIndex).toBeGreaterThanOrEqual(0);

  const start = html.lastIndexOf("<input", labelIndex);
  return html.slice(start, html.indexOf(">", labelIndex) + 1);
}

function buttonTag(html: string, label: string) {
  const labelIndex = html.indexOf(`>${label}</span>`);
  expect(labelIndex).toBeGreaterThanOrEqual(0);

  const start = html.lastIndexOf("<button", labelIndex);
  return html.slice(start, html.indexOf(">", start) + 1);
}

describe("LocationSection", () => {
  test("renders nothing for a backend that offers no location control", () => {
    expect(renderToStaticMarkup(<LocationSection client={locationClient({}, false)} />)).toBe("");
  });

  test("seeds both boxes from the confirmed fix and names it in the closing note", () => {
    const html = render(locationClient({ location: { latitude: 37.3349, longitude: -122.009 } }));

    expect(inputTag(html, "Latitude")).toContain('value="37.3349"');
    expect(inputTag(html, "Longitude")).toContain('value="-122.009"');
    expect(html).toContain("Last set: 37.3349, -122.0090");
    expect(html).not.toContain("No fix set in this session.");
  });

  test("says no fix is known before the first confirmed write", () => {
    const html = render(locationClient());

    expect(inputTag(html, "Latitude")).toContain('value=""');
    expect(html).toContain("No fix set in this session.");
  });

  test("shows the preset whose coordinates the boxes hold", () => {
    const selected = (client: DeviceClient) =>
      render(client).replace(/ data-test-options="[^"]*"/g, "");

    expect(
      selected(locationClient({ location: { latitude: 37.3349, longitude: -122.009 } })),
    ).toContain(">Apple Park</span>");
    expect(selected(locationClient({ location: { latitude: 1, longitude: 2 } }))).toContain(
      ">Custom</span>",
    );
    expect(selected(locationClient({ location: { latitude: 1, longitude: 2 } }))).not.toContain(
      ">Apple Park</span>",
    );
  });

  test("offers Clear only to a backend that can remove a fix", () => {
    expect(render(locationClient())).not.toContain(">Clear</span>");
    expect(render(locationClient({}, { clear: true }))).toContain(">Clear</span>");
  });

  test("disables every control and posts a status note while a write is in flight", () => {
    const html = render(locationClient({ locationPending: true }, { clear: true }));

    expect(html).toContain("Updating location…");
    expect(inputTag(html, "Latitude")).toContain('disabled=""');
    expect(inputTag(html, "Longitude")).toContain('disabled=""');
    expect(buttonTag(html, "Set location")).toContain('disabled=""');
    expect(buttonTag(html, "Clear")).toContain('disabled=""');
  });

  test("reports a refused write as an alert", () => {
    const html = render(locationClient({ locationError: "latitude out of range" }));

    const alert = html.match(/<span role="alert"[^>]*>([^<]*)<\/span>/);
    expect(alert?.[1]).toBe("latitude out of range");
  });

  test("lists Custom first, then every preset", () => {
    const html = render(locationClient());
    const options = html.match(/data-test-options="([^"]*)"/);

    expect(options?.[1].split("\n")).toEqual(["Custom", "Apple Park", "Googleplex", "London", "Tokyo", "Sydney"]);
  });
});
