import { describe, expect, test } from "bun:test";
import type { AndroidDevice } from "../types";
import { waitForAdbOnline } from "../wait-for-adb-online";

const device = (serial: string, overrides: Partial<AndroidDevice> = {}): AndroidDevice => ({
  name: serial,
  type: "emulator",
  booted: true,
  serial,
  path: null,
  properties: {},
  config: {},
  ...overrides,
});

describe("waitForAdbOnline", () => {
  test("resolves true on the first poll when the serial is already booted", async () => {
    let calls = 0;
    const listDevicesFn = async () => {
      calls++;
      return [device("emulator-5554")];
    };
    expect(await waitForAdbOnline("emulator-5554", 1000, { listDevicesFn })).toBe(true);
    expect(calls).toBe(1);
  });

  test("keeps polling until the serial comes online", async () => {
    let calls = 0;
    const listDevicesFn = async () => {
      calls++;
      return [device("emulator-5554", { booted: calls >= 3 })];
    };
    const online = await waitForAdbOnline("emulator-5554", 1000, {
      listDevicesFn,
      pollIntervalMs: 1,
    });
    expect(online).toBe(true);
    expect(calls).toBe(3);
  });

  test("resolves false once the timeout elapses", async () => {
    let calls = 0;
    const listDevicesFn = async () => {
      calls++;
      return [device("emulator-5554", { booted: false })];
    };
    const online = await waitForAdbOnline("emulator-5554", 30, {
      listDevicesFn,
      pollIntervalMs: 10,
    });
    expect(online).toBe(false);
    expect(calls).toBeGreaterThanOrEqual(1);
  });

  test("only matches a device that is both the right serial and booted", async () => {
    const listDevicesFn = async () => [
      device("emulator-5554", { booted: false }),
      device("emulator-5556", { booted: true }),
    ];
    const online = await waitForAdbOnline("emulator-5554", 30, {
      listDevicesFn,
      pollIntervalMs: 10,
    });
    expect(online).toBe(false);
  });

  test("swallows lister errors and keeps polling until timeout", async () => {
    const listDevicesFn = async () => {
      throw new Error("adb unavailable");
    };
    const online = await waitForAdbOnline("emulator-5554", 30, {
      listDevicesFn,
      pollIntervalMs: 10,
    });
    expect(online).toBe(false);
  });

  test("recovers after a transient lister error", async () => {
    let calls = 0;
    const listDevicesFn = async () => {
      calls++;
      if (calls === 1) throw new Error("adb starting");
      return [device("emulator-5554")];
    };
    const online = await waitForAdbOnline("emulator-5554", 1000, {
      listDevicesFn,
      pollIntervalMs: 1,
    });
    expect(online).toBe(true);
    expect(calls).toBe(2);
  });
});
