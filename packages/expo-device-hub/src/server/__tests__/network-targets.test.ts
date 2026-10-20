import { describe, expect, test } from "bun:test";

import {
  androidInspectorDeviceName,
  debuggerUrlOn,
  inspectorOrigins,
  iosInspectorDeviceNames,
  listInspectorTargets,
  matchTarget,
  MetroUrlError,
  metroOriginFor,
  type InspectorTarget,
  type TargetMatch,
} from "../network-targets";

const target = (
  id: string,
  deviceName: string,
  appId = "com.example",
  logicalDeviceId?: string,
): InspectorTarget => ({
  id,
  deviceName,
  appId,
  webSocketDebuggerUrl: `ws://localhost:8081/inspector/debug?device=d${id}&page=1`,
  ...(logicalDeviceId ? { logicalDeviceId } : {}),
});

const appIdOf = (match: TargetMatch) => (match.kind === "match" ? match.target.appId : match.kind);

describe("metroOriginFor", () => {
  test("uses the request's port on loopback, because the plugin runs inside Metro", () => {
    expect(metroOriginFor("http://192.168.4.35:8081/api/network/ws", {})).toBe(
      "http://127.0.0.1:8081",
    );
    expect(metroOriginFor("http://localhost:19000/x", {})).toBe("http://127.0.0.1:19000");
  });

  test("prefers EXPO_DEVICE_HUB_METRO_URL, for the standalone CLI", () => {
    expect(
      metroOriginFor("http://localhost:4040/x", {
        EXPO_DEVICE_HUB_METRO_URL: "http://127.0.0.1:8081/",
      }),
    ).toBe("http://127.0.0.1:8081");
  });

  test("throws for an unusable configured URL", () => {
    expect(() =>
      metroOriginFor("http://localhost:4040/x", { EXPO_DEVICE_HUB_METRO_URL: "not a url" }),
    ).toThrow(MetroUrlError);
  });

  test("accepts only a Metro server on this machine", () => {
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
      expect(
        metroOriginFor("http://localhost:4040/x", {
          EXPO_DEVICE_HUB_METRO_URL: `http://${host}:8081`,
        }),
      ).toBe(`http://${host}:8081`);
    }
    for (const url of ["http://192.168.1.2:8081", "https://metro.example.com"]) {
      expect(() =>
        metroOriginFor("http://localhost:4040/x", { EXPO_DEVICE_HUB_METRO_URL: url }),
      ).toThrow(/on this machine/);
    }
  });
});

describe("inspectorOrigins", () => {
  test("offers the Metro origin, then the loopback names, without repeats", () => {
    expect(inspectorOrigins("http://127.0.0.1:8081")).toEqual([
      "http://127.0.0.1:8081",
      "http://localhost:8081",
    ]);
    expect(inspectorOrigins("http://192.168.1.2:8081")).toEqual([
      "http://192.168.1.2:8081",
      "http://127.0.0.1:8081",
      "http://localhost:8081",
    ]);
  });
});

describe("device names", () => {
  test("iOS: the simulator's own name, then the name with its version", () => {
    expect(iosInspectorDeviceNames({ name: "iPhone 17 Pro", version: "iOS 27.1" })).toEqual([
      "iPhone 17 Pro",
      "iPhone 17 Pro (iOS 27.1)",
    ]);
  });

  test("Android: model, release and API level from getprop", () => {
    expect(
      androidInspectorDeviceName({
        "ro.product.model": "sdk_gphone16k_arm64",
        "ro.build.version.release": "17",
        "ro.build.version.sdk": "37",
      }),
    ).toBe("sdk_gphone16k_arm64 - 17 - API 37");
    expect(androidInspectorDeviceName({ "ro.product.model": "Pixel" })).toBeNull();
  });
});

describe("matchTarget", () => {
  test("matches the device name exactly and prefers the most recent app", () => {
    const targets = [
      target("1", "iPhone Duo (iOS 27.1)", "com.first"),
      target("2", "Pixel - 17 - API 37"),
      target("3", "iPhone Duo (iOS 27.1)", "com.second"),
    ];
    expect(appIdOf(matchTarget(targets, ["iPhone Duo (iOS 27.1)"]))).toBe("com.second");
    expect(matchTarget(targets, ["iPhone Duo (iOS 27.0)"])).toEqual({ kind: "none" });
  });

  test("refuses a name that apps on two devices share", () => {
    const targets = [
      target("1", "Pixel - 17 - API 37", "com.a", "device-a"),
      target("2", "Pixel - 17 - API 37", "com.b", "device-b"),
    ];
    expect(matchTarget(targets, ["Pixel - 17 - API 37"])).toEqual({
      kind: "ambiguous",
      deviceName: "Pixel - 17 - API 37",
    });
  });

  test("allows several apps on one device", () => {
    const targets = [
      target("1", "Pixel - 17 - API 37", "com.a", "device-a"),
      target("2", "Pixel - 17 - API 37", "com.b", "device-a"),
    ];
    expect(appIdOf(matchTarget(targets, ["Pixel - 17 - API 37"]))).toBe("com.b");
  });

  test("tries the device's names in order", () => {
    const targets = [
      target("1", "iPhone 17 Pro (iOS 27.1)", "com.versioned"),
      target("2", "iPhone 17 Pro", "com.plain"),
    ];
    expect(appIdOf(matchTarget(targets, ["iPhone 17 Pro", "iPhone 17 Pro (iOS 27.1)"]))).toBe(
      "com.plain",
    );
    expect(
      appIdOf(matchTarget(targets.slice(0, 1), ["iPhone 17 Pro", "iPhone 17 Pro (iOS 27.1)"])),
    ).toBe("com.versioned");
  });
});

describe("listInspectorTargets", () => {
  test("keeps the fields it needs and skips malformed pages", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify([
          { id: "1", deviceName: "iPhone", appId: "com.a", webSocketDebuggerUrl: "ws://h/x" },
          {
            id: "3",
            deviceName: "Pixel",
            appId: "com.b",
            webSocketDebuggerUrl: "ws://h/y",
            reactNative: { logicalDeviceId: "device-b" },
          },
          { id: 2 },
          null,
        ]),
      )) as unknown as typeof fetch;
    expect(await listInspectorTargets("http://127.0.0.1:8081", fetchImpl)).toEqual([
      { id: "1", deviceName: "iPhone", appId: "com.a", webSocketDebuggerUrl: "ws://h/x" },
      {
        id: "3",
        deviceName: "Pixel",
        appId: "com.b",
        webSocketDebuggerUrl: "ws://h/y",
        logicalDeviceId: "device-b",
      },
    ]);
  });

  test("throws when Metro does not answer with a list", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 404 })) as unknown as typeof fetch;
    await expect(listInspectorTargets("http://127.0.0.1:8081", fetchImpl)).rejects.toThrow();
  });
});

describe("debuggerUrlOn", () => {
  test("keeps the target's path and query on the Metro origin", () => {
    expect(debuggerUrlOn("http://127.0.0.1:8081", target("1", "x"))).toBe(
      "ws://127.0.0.1:8081/inspector/debug?device=d1&page=1",
    );
  });
});
