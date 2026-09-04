import { describe, expect, test } from "bun:test";
import type { AndroidDevice } from "../types";
import { waitForAdbOffline } from "../wait-for-adb-offline";

const device = (serial: string | null): AndroidDevice => ({
  name: serial ?? "Pixel_8a_big",
  type: "emulator",
  booted: serial !== null,
  serial,
  path: null,
  lastBootedAt: null,
  properties: {},
  config: {},
});

const listed = (value: AndroidDevice[]) => ({ value, error: null });

describe("waitForAdbOffline", () => {
  test("resolves true on the first poll when the serial is already gone", async () => {
    let calls = 0;
    const listDevicesFn = async () => {
      calls++;
      return listed([device(null), device("emulator-5556")]);
    };
    expect((await waitForAdbOffline("emulator-5554", 1000, { listDevicesFn })).value).toBe(true);
    expect(calls).toBe(1);
  });

  test("keeps polling until the serial leaves adb", async () => {
    let calls = 0;
    const listDevicesFn = async () => {
      calls++;
      return listed(calls >= 3 ? [device(null)] : [device("emulator-5554")]);
    };
    const offline = await waitForAdbOffline("emulator-5554", 1000, {
      listDevicesFn,
      pollIntervalMs: 1,
    });
    expect(offline.value).toBe(true);
    expect(calls).toBe(3);
  });

  test("treats a failed listing as still attached, then resolves true once it succeeds", async () => {
    let calls = 0;
    const error = {
      message: "Failed to read getprop for emulator-5554:",
      error: new Error("closed"),
    };
    const listDevicesFn = async () => {
      calls++;
      return calls >= 3 ? listed([device(null)]) : { value: [], error };
    };
    const offline = await waitForAdbOffline("emulator-5554", 1000, {
      listDevicesFn,
      pollIntervalMs: 1,
    });
    expect(offline).toEqual({ value: true, error: null });
    expect(calls).toBe(3);
  });

  test("resolves false once the timeout elapses while the serial is still listed", async () => {
    let calls = 0;
    const listDevicesFn = async () => {
      calls++;
      return listed([device("emulator-5554")]);
    };
    const offline = await waitForAdbOffline("emulator-5554", 30, {
      listDevicesFn,
      pollIntervalMs: 10,
    });
    expect(offline.value).toBe(false);
    expect(calls).toBeGreaterThanOrEqual(1);
  });

  test("reports the last listing failure alongside false on timeout", async () => {
    const error = {
      message: "Failed to read getprop for emulator-5554:",
      error: new Error("closed"),
    };
    const listDevicesFn = async () => ({ value: [], error });
    const offline = await waitForAdbOffline("emulator-5554", 30, {
      listDevicesFn,
      pollIntervalMs: 10,
    });
    expect(offline).toEqual({ value: false, error });
  });

  test("reports a thrown lister failure alongside false on timeout", async () => {
    let calls = 0;
    const listDevicesFn = async () => {
      calls++;
      throw new Error("adb unavailable");
    };
    const offline = await waitForAdbOffline("emulator-5554", 30, {
      listDevicesFn,
      pollIntervalMs: 10,
    });
    expect(offline.value).toBe(false);
    expect(offline.error).not.toBeNull();
    expect(calls).toBeGreaterThanOrEqual(1);
  });

  test("ignores other serials still attached to adb", async () => {
    const listDevicesFn = async () => listed([device("emulator-5556"), device("emulator-5558")]);
    const offline = await waitForAdbOffline("emulator-5554", 30, {
      listDevicesFn,
      pollIntervalMs: 10,
    });
    expect(offline.value).toBe(true);
  });

  test("resolves false without polling when the signal is already aborted", async () => {
    let calls = 0;
    const listDevicesFn = async () => {
      calls++;
      return listed([device(null)]);
    };
    const offline = await waitForAdbOffline("emulator-5554", 1000, {
      listDevicesFn,
      pollIntervalMs: 1,
      signal: AbortSignal.abort(),
    });
    expect(offline.value).toBe(false);
    expect(calls).toBe(0);
  });

  test("stops polling once the signal aborts", async () => {
    const controller = new AbortController();
    let calls = 0;
    const listDevicesFn = async () => {
      calls++;
      controller.abort();
      return listed([device("emulator-5554")]);
    };
    const offline = await waitForAdbOffline("emulator-5554", 1000, {
      listDevicesFn,
      pollIntervalMs: 1,
      signal: controller.signal,
    });
    expect(offline.value).toBe(false);
    expect(calls).toBe(1);
  });
});
