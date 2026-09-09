import { describe, expect, test } from "bun:test";
import { parseGeoFix, setEmulatorLocationAsync } from "../src/location.ts";
import type { execText } from "../src/exec.ts";

describe("location payload boundaries", () => {
  test("accepts inclusive coordinate limits and nullable optional values", () => {
    expect(
      parseGeoFix({
        latitude: -90,
        longitude: 180,
        altitude: -1_000,
        satellites: 1,
        velocity: 0,
      }),
    ).toEqual({
      latitude: -90,
      longitude: 180,
      altitude: -1_000,
      satellites: 1,
      velocity: 0,
    });
    expect(
      parseGeoFix({ latitude: 90, longitude: -180, altitude: null, satellites: null }),
    ).toEqual({
      latitude: 90,
      longitude: -180,
      altitude: undefined,
      satellites: undefined,
      velocity: undefined,
    });
  });

  test("rejects malformed payloads and every bounded numeric field", () => {
    for (const value of [null, [], "location"] as const) {
      expect(() => parseGeoFix(value)).toThrow("location payload must be an object");
    }
    expect(() => parseGeoFix({ latitude: Number.NaN, longitude: 0 })).toThrow(
      "latitude must be a finite number",
    );
    expect(() => parseGeoFix({ latitude: 91, longitude: 0 })).toThrow(
      "latitude must be between -90 and 90",
    );
    expect(() => parseGeoFix({ latitude: 0, longitude: -181 })).toThrow(
      "longitude must be between -180 and 180",
    );
    expect(() => parseGeoFix({ latitude: 0, longitude: 0, altitude: 100_001 })).toThrow(
      "altitude must be between -1000 and 100000",
    );
    expect(() => parseGeoFix({ latitude: 0, longitude: 0, satellites: 1.5 })).toThrow(
      "satellites must be an integer",
    );
    expect(() => parseGeoFix({ latitude: 0, longitude: 0, satellites: 65 })).toThrow(
      "satellites must be between 1 and 64",
    );
    expect(() => parseGeoFix({ latitude: 0, longitude: 0, velocity: -1 })).toThrow(
      "velocity must be between 0 and 1000",
    );
  });
});

describe("asynchronous emulator location failures", () => {
  test("rejects physical-device serials before invoking adb", async () => {
    let calls = 0;
    const runExec = (async () => {
      calls += 1;
      throw new Error("must not run");
    }) as typeof execText;

    await expect(
      setEmulatorLocationAsync("device-123", { latitude: 0, longitude: 0 }, runExec),
    ).rejects.toThrow("Android Emulator serials only");
    expect(calls).toBe(0);
  });

  test("preserves executor failure output and cause", async () => {
    const failure = new Error("spawn failed");
    const runExec = (async () => ({
      status: null,
      signal: null,
      stdout: "",
      stderr: "adb unavailable\n",
      timedOut: false,
      error: failure,
    })) as typeof execText;

    try {
      await setEmulatorLocationAsync(
        "emulator-5554",
        { latitude: 1, longitude: 2 },
        runExec,
      );
      throw new Error("expected location update to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("adb emu geo fix failed: adb unavailable");
      expect((error as Error).cause).toBe(failure);
    }
  });

  test("rejects a non-Error abort reason after adb settles", async () => {
    const controller = new AbortController();
    const runExec = (async () => {
      controller.abort("cancelled");
      return {
        status: 0,
        signal: null,
        stdout: "OK\n",
        stderr: "",
        timedOut: false,
        error: null,
      };
    }) as typeof execText;

    await expect(
      setEmulatorLocationAsync(
        "emulator-5554",
        { latitude: 1, longitude: 2 },
        controller.signal,
        runExec,
      ),
    ).rejects.toThrow("location update aborted");
  });
});
