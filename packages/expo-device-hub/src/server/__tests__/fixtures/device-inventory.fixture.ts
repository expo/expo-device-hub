import { expect, mock, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
const realReadFile = fsPromises.readFile;
const realSimctl = await import("../../../../../@expo/hub-apple-utils/src/simctl");

const scope = process.env.HUB_TEST_SCOPE;
for (const key of Object.keys(process.env)) {
  if (key.startsWith("EXPO_DEVICE_HUB_")) delete process.env[key];
}
process.env.EXPO_DEVICE_HUB_BASE_PATH = "";
if (scope === "ios" || scope === "android") process.env.EXPO_DEVICE_HUB_PLATFORM = scope;
if (scope === "single") {
  process.env.EXPO_DEVICE_HUB_PLATFORM = "ios";
  process.env.EXPO_DEVICE_HUB_SINGLE_DEVICE = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
}

const device = (udid: string, state = "Shutdown", isAvailable = true) => ({
  udid,
  name: "Same name",
  state,
  isAvailable,
  dataPath: `/mock-inventory/${udid}/data`,
});
const xml = (body: string) =>
  `<?xml version="1.0"?><plist version="1.0"><dict>${body}</dict></plist>`;
// Exercise real simctl JSON parsing and plist enrichment, replacing only external I/O.
mock.module("../../../../../@expo/hub-apple-utils/src/simctl", () => ({
  ...realSimctl,
  runSimctl: async (args: string[]) => {
    expect(args).toEqual(["list", "devices", "--json"]);
    return {
      error: null,
      value: JSON.stringify({
        devices: {
          "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [
            device("AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA"),
            device("historical"),
            device("booted", "Booted"),
            device("malformed", "Booted"),
            device("unreadable"),
            device("unavailable", "Shutdown", false),
          ],
          "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [device("other-runtime")],
          "com.apple.CoreSimulator.SimRuntime.tvOS-27-0": [device("tv")],
        },
      }),
    };
  },
}));
mock.module("node:fs/promises", () => ({
  ...fsPromises,
  readFile: async (...args: Parameters<typeof realReadFile>) => {
    const path = String(args[0]);
    if (!path.startsWith("/mock-inventory/")) return realReadFile(...args);
    if (path.includes("/unreadable/")) throw new Error("fixture plist read failure");
    if (path.includes("/historical/")) {
      return xml("<key>lastUsedAt</key><date>2026-01-01T00:00:00Z</date>");
    }
    if (path.includes("/malformed/")) {
      return xml(
        "<key>lastUsedAt</key><string>invalid date</string><key>lastBootedAt</key><integer>42</integer>",
      );
    }
    return xml("");
  },
}));
const appleUtils = await import("../../../../../@expo/hub-apple-utils/src/index");
mock.module("@expo/hub-apple-utils", () => appleUtils);
const androidUtils = await import("../../../../../@expo/hub-android-utils/src/index");
mock.module("@expo/hub-android-utils", () => ({
  ...androidUtils,
  listDevices: async () => ({
    error: null,
    value: [
      {
        name: "android-fresh",
        type: "emulator",
        booted: false,
        lastBootedAt: null,
        config: {},
        properties: {},
      },
      {
        name: "android-used",
        type: "emulator",
        booted: false,
        lastBootedAt: 123,
        config: {},
        properties: {},
      },
      {
        name: "android-booted",
        type: "device",
        booted: true,
        lastBootedAt: null,
        config: {},
        properties: {},
      },
    ],
  }),
}));
mock.module("../../../../vendor/serve-sim/dist/middleware.js", () => ({
  simMiddleware: () => Object.assign(async () => undefined, { dispose: async () => {} }),
}));
mock.module("../../../../vendor/serve-emu/dist/middleware.js", () => ({
  cameraLaunchArgs: () => [],
  seedCameraFeeds: async () => {},
  fromWsSocket: (socket: unknown) => socket,
  SESSION_TOKEN_SUBPROTOCOL_PREFIX: "serve-emu.token.",
  createRouter: () => ({ handleRequest: async () => undefined, stopAll: async () => {} }),
}));
mock.module("../../device-list-websocket", () => ({
  deviceListWebSocketHandler() {},
  refreshDeviceList() {},
}));
const { listIosSimulators, listDevices } = await import("../../devices");
const { default: server } = await import("../../index");
const ids = (devices: { id: string }[]) => devices.map((device) => device.id);

if (scope === "all") {
  test("default recents excludes missing and malformed history regardless of boot state", async () => {
    expect(ids((await listIosSimulators()).devices)).toEqual(["historical"]);
    expect(ids((await listIosSimulators({ includeUnusedIos: false })).devices)).toEqual([
      "historical",
    ]);
  });
  test("opt-in includes fresh, booted, malformed and unreadable history across runtimes", async () => {
    const result = await listIosSimulators({ includeUnusedIos: true });
    expect(ids(result.devices)).toEqual([
      "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA",
      "historical",
      "booted",
      "malformed",
      "unreadable",
      "other-runtime",
    ]);
    expect(
      result.devices.find((device) => device.id === "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA")?.booted,
    ).toBe(false);
    expect(result.devices.find((device) => device.id === "booted")?.booted).toBe(true);
    for (const device of result.devices) {
      expect(device.lastUsedAt).toBe(
        device.id === "historical" ? Date.parse("2026-01-01T00:00:00Z") : undefined,
      );
    }
    expect(result.error?.message).toContain("Failed to read CoreSimulator plist");
  });
  test("Android recents are unchanged by the iOS option", async () => {
    const baseline = await listDevices();
    const optedIn = await listDevices(undefined, { includeUnusedIos: true });
    expect(optedIn.emulators).toEqual(baseline.emulators);
    expect(ids(optedIn.emulators)).toEqual(["android-used", "android-booted"]);
  });
}

for (const value of [undefined, "false", "0", "", "TRUE", "yes", "true", "1"]) {
  for (const booted of [undefined, "false", "true", "1"]) {
    test(`route includeUnusedIos=${value}, booted=${booted}`, async () => {
      const params = new URLSearchParams();
      if (value !== undefined) params.set("includeUnusedIos", value);
      if (booted !== undefined) params.set("booted", booted);
      const response = await server(new Request(`http://localhost/api/devices?${params}`));
      expect(response?.status).toBe(200);
      const result = await response!.json();
      const include = value === "true" || value === "1";
      const bootedOnly = booted === "true" || booted === "1";
      let expected = include
        ? [
            "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA",
            "historical",
            "booted",
            "malformed",
            "unreadable",
            "other-runtime",
          ]
        : ["historical"];
      if (bootedOnly) expected = expected.filter((id) => id === "booted" || id === "malformed");
      if (scope === "android") expected = [];
      if (scope === "single")
        expected = expected.filter((id) => id === "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA");
      expect(ids(result.simulators)).toEqual(expected);
      expect(ids(result.emulators)).toEqual(
        scope === "ios" || scope === "single"
          ? []
          : bootedOnly
            ? ["android-booted"]
            : ["android-used", "android-booted"],
      );
      if (scope !== "android")
        expect(result.errors[0].message).toContain("Failed to read CoreSimulator plist");
    });
  }
}
