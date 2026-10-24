import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { parseCliOptions } from "../cli/options";
import { configureClientShell } from "../client-shell";
import type { HubDevice } from "../devices";
import {
  allowsSessionDeviceAction,
  filterSessionDevices,
  isSessionDevice,
  parseSingleDevice,
  readSingleDevice,
  scopeEmuRequest,
  refuseSingleDeviceSocket,
} from "../single-device";

const ID = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";

describe("single-device sessions", () => {
  test("an omitted policy preserves multi-device discovery", () => {
    expect(isSessionDevice(undefined, "ios", ID)).toBe(true);
    expect(isSessionDevice(undefined, "android", "emulator-5554")).toBe(true);
  });
  test("standalone-only environment options do not affect plugin mode", () => {
    const env = { EXPO_DEVICE_HUB_SINGLE_DEVICE: ID, EXPO_DEVICE_HUB_PLATFORM: "ios" };
    expect(readSingleDevice(env)).toBeUndefined();
    expect(readSingleDevice({ ...env, EXPO_DEVICE_HUB_BASE_PATH: "/plugin" })).toBeUndefined();
    expect(readSingleDevice({ ...env, EXPO_DEVICE_HUB_BASE_PATH: "" })).toEqual({
      platform: "ios",
      id: ID,
    });
  });

  test("lifecycle actions share the session policy", () => {
    const cases = [
      ["ios", "boot", true],
      ["ios", "shutdown", true],
      ["ios", "remove", false],
      ["android", "boot", false],
      ["android", "shutdown", true],
      ["android", "remove", false],
    ] as const;
    for (const [platform, action, allowed] of cases) {
      const policy = { platform, id: ID };
      const device = { platform, id: platform === "ios" ? ID.toLowerCase() : ID };
      expect(allowsSessionDeviceAction(undefined, action, device)).toBe(true);
      expect(allowsSessionDeviceAction(policy, action, device)).toBe(allowed);
      expect(allowsSessionDeviceAction(policy, action, { ...device, id: "other" })).toBe(false);
      expect(
        allowsSessionDeviceAction(policy, action, {
          ...device,
          platform: platform === "ios" ? "android" : "ios",
        }),
      ).toBe(false);
    }
  });

  test("a refused socket cannot crash the host with a late protocol error", () => {
    const socket = new EventEmitter() as EventEmitter & { close(): void };
    let closed = false;
    socket.close = () => {
      closed = true;
    };
    refuseSingleDeviceSocket(socket);
    expect(closed).toBe(true);
    expect(() => socket.emit("error", new Error("Invalid WebSocket frame"))).not.toThrow();
  });
  test("requires an explicit platform and concrete device ID", () => {
    expect(() => parseCliOptions(["--single-device", ID])).toThrow("--platform");
    expect(() => parseCliOptions(["--platform", "ios", "--single-device", "booted"])).toThrow(
      "UDID",
    );
    expect(
      parseCliOptions(["--platform", "ios", "--single-device", ID.toLowerCase()]).singleDevice,
    ).toBe(ID);
    expect(
      parseCliOptions(["--platform", "android", "--single-device", "emulator-5554"]).singleDevice,
    ).toBe("emulator-5554");
  });

  test("discovery and shell use only the startup identity", () => {
    const policy = parseSingleDevice(ID, "ios")!;
    const device: HubDevice = {
      platform: "ios",
      id: ID,
      name: "Pinned Simulator",
      version: "26.5",
      booted: true,
      physical: false,
      supported: true,
      deviceFrame: null,
    };
    const filtered = filterSessionDevices(
      {
        simulators: [device, { ...device, id: "other" }],
        emulators: [{ ...device, platform: "android" }],
      },
      policy,
    );
    expect(filtered.simulators).toEqual([device]);
    expect(filtered.emulators).toEqual([]);
    expect(isSessionDevice(policy, "android", ID)).toBe(false);
    expect(configureClientShell("{{singleDevice}}", "", "ios", undefined, false, false, ID)).toBe(
      ID,
    );
  });

  test("Android query defaults cannot select another device or call fleet actions", () => {
    const policy = parseSingleDevice("emulator-5554", "android")!;
    const scoped = scopeEmuRequest(
      new Request("http://localhost/vendor/serve-emu/api/screenshot"),
      policy,
    )!;
    expect(new URL(scoped.url).searchParams.get("device")).toBe("emulator-5554");
    for (const path of [
      "/api/devices",
      "/api/devices/select",
      "/api/device-grid",
      "/api/avds/start",
      "/api/avds/stop",
      "/api?device=other",
      "/api?device=emulator-5554&device=other",
    ]) {
      expect(
        scopeEmuRequest(new Request(`http://localhost/vendor/serve-emu${path}`), policy),
      ).toBeNull();
    }
    expect(
      scopeEmuRequest(new Request("http://localhost/api"), parseSingleDevice(ID, "ios")),
    ).toBeNull();
  });
});
