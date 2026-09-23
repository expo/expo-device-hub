import { describe, expect, test } from "bun:test";
import { openSimulatorHost, resolveSimulatorHost } from "../simulator-host";

const dev = "/Applications/Xcode Selected.app/Contents/Developer";
const simulator = `${dev}/Applications/Simulator.app`;
const hub = "/Applications/Xcode Selected.app/Contents/Applications/DeviceHub.app";

describe("simulator host selection", () => {
  test("resolves Simulator.app in the selected developer directory", () => {
    expect(resolveSimulatorHost(dev, path => path === simulator)).toEqual({
      kind: "simulator", path: simulator,
    });
  });

  test("resolves DeviceHub.app next to the selected developer directory", () => {
    expect(resolveSimulatorHost(dev, path => path === hub)).toEqual({
      kind: "device-hub", path: hub,
    });
  });

  test("accepts an app-bundle DEVELOPER_DIR with trailing whitespace and slash", () => {
    expect(resolveSimulatorHost("/Applications/Xcode Selected.app/\n", path => path === hub).path).toBe(hub);
  });

  test("prefers Device Hub when the selected Xcode contains both hosts", () => {
    expect(resolveSimulatorHost(dev, path => [hub, simulator].includes(path)).kind).toBe("device-hub");
  });

  test("does not fall back to a different installed Xcode", () => {
    expect(() => resolveSimulatorHost(dev, path => path === "/Applications/Xcode.app/Contents/Developer/Applications/Simulator.app"))
      .toThrow("Select a full Xcode installation");
  });
});

describe("opening the simulator host", () => {
  function launch(installed: string, udid = "device-id") {
    const calls: [string, string[]][] = [];
    openSimulatorHost(udid, {
      exists: path => path === installed,
      run: (file, args) => {
        calls.push([file, args]);
        return file === "/usr/bin/xcode-select" ? `${dev}\n` : "";
      },
    });
    expect(calls[0]).toEqual(["/usr/bin/xcode-select", ["-p"]]);
    return calls[1];
  }

  test("opens the selected Simulator in the background with its device argument", () => {
    expect(launch(simulator)).toEqual([
      "/usr/bin/open", ["-g", "-a", simulator, "--args", "-CurrentDeviceUDID", "device-id"],
    ]);
  });

  test("targets the selected Device Hub when opening its device URL", () => {
    expect(launch(hub)).toEqual([
      "/usr/bin/open", ["-g", "-a", hub, "devices://device/open?id=device-id"],
    ]);
  });

  test("encodes device identifiers as a single URL parameter", () => {
    expect(launch(hub, "id&other=value")?.[1].at(-1)).toBe("devices://device/open?id=id%26other%3Dvalue");
  });

  test("opens either host without device arguments when no device was supplied", () => {
    for (const host of [hub, simulator]) {
      expect(launch(host, "")).toEqual(["/usr/bin/open", ["-g", "-a", host]]);
    }
  });

  test("opens Device Hub when xcode-select names the app bundle", () => {
    const calls: [string, string[]][] = [];
    openSimulatorHost("device-id", {
      exists: path => path === hub,
      run: (file, args) => {
        calls.push([file, args]);
        return file === "/usr/bin/xcode-select" ? "/Applications/Xcode Selected.app\n" : "";
      },
    });
    expect(calls[1]).toEqual([
      "/usr/bin/open", ["-g", "-a", hub, "devices://device/open?id=device-id"],
    ]);
  });

  test("rejects empty xcode-select output before probing or opening an app", () => {
    expect(() => openSimulatorHost("id", {
      run: () => "\n",
      exists: () => { throw new Error("should not probe"); },
    })).toThrow("xcode-select returned no developer directory");
  });

  test("preserves launch errors for the caller's headless-host handling", () => {
    expect(() => openSimulatorHost("id", {
      exists: path => path === hub,
      run: file => {
        if (file === "/usr/bin/xcode-select") return dev;
        throw new Error("window server unavailable");
      },
    })).toThrow("window server unavailable");
  });
});
