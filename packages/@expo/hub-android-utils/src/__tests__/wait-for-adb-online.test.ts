import { describe, expect, test } from "bun:test";
import type { AndroidDevice } from "../types";
import { waitForAdbOnline } from "../wait-for-adb-online";

const device = (serial: string, overrides: Partial<AndroidDevice> = {}): AndroidDevice => ({
  name: serial,
  type: "emulator",
  booted: true,
  serial,
  path: null,
  lastBootedAt: null,
  properties: {},
  config: {},
  ...overrides,
});

const listed = (value: AndroidDevice[]) => ({ value, error: null });

describe("waitForAdbOnline", () => {
  test("resolves on the first poll when the serial is already booted", async () => {
    let calls = 0;
    const listDevicesFn = async () => {
      calls++;
      return listed([device("emulator-5554", { name: "Pixel_9" })]);
    };
    expect((await waitForAdbOnline("emulator-5554", 1000, { listDevicesFn })).value).toBe(
      "Pixel_9",
    );
    expect(calls).toBe(1);
  });

  test("reports which AVD is online at the serial, whichever it is", async () => {
    const listDevicesFn = async () =>
      listed([
        device("emulator-5554", { name: "j5-tester-1" }),
        device("emulator-5556", { name: "j5-tester-2" }),
      ]);
    const online = await waitForAdbOnline("emulator-5554", 1000, { listDevicesFn });
    expect(online).toEqual({ value: "j5-tester-1", error: null });
  });

  test("keeps polling until the serial comes online", async () => {
    let calls = 0;
    const listDevicesFn = async () => {
      calls++;
      return listed([device("emulator-5554", { booted: calls >= 3 })]);
    };
    const online = await waitForAdbOnline("emulator-5554", 1000, {
      listDevicesFn,
      pollIntervalMs: 1,
    });
    expect(online.value).toBe("emulator-5554");
    expect(calls).toBe(3);
  });

  test("resolves null once the timeout elapses", async () => {
    let calls = 0;
    const listDevicesFn = async () => {
      calls++;
      return listed([device("emulator-5554", { booted: false })]);
    };
    const online = await waitForAdbOnline("emulator-5554", 30, {
      listDevicesFn,
      pollIntervalMs: 10,
    });
    expect(online.value).toBeNull();
    expect(calls).toBeGreaterThanOrEqual(1);
  });

  test("only matches a device that is both the right serial and booted", async () => {
    const listDevicesFn = async () =>
      listed([
        device("emulator-5554", { booted: false }),
        device("emulator-5556", { booted: true }),
      ]);
    const online = await waitForAdbOnline("emulator-5554", 30, {
      listDevicesFn,
      pollIntervalMs: 10,
    });
    expect(online.value).toBeNull();
  });

  test("returns a thrown lister error on the first poll", async () => {
    let calls = 0;
    const listDevicesFn = async () => {
      calls++;
      throw new Error("adb unavailable");
    };
    const online = await waitForAdbOnline("emulator-5554", 1000, {
      listDevicesFn,
      pollIntervalMs: 10,
    });
    expect(online.value).toBeNull();
    expect(online.error).not.toBeNull();
    expect(calls).toBe(1);
  });

  test("resolves null without polling when the signal is already aborted", async () => {
    let calls = 0;
    const listDevicesFn = async () => {
      calls++;
      return listed([device("emulator-5554")]);
    };
    const online = await waitForAdbOnline("emulator-5554", 1000, {
      listDevicesFn,
      pollIntervalMs: 1,
      signal: AbortSignal.abort(),
    });
    expect(online.value).toBeNull();
    expect(calls).toBe(0);
  });

  test("stops polling once the signal aborts", async () => {
    const controller = new AbortController();
    let calls = 0;
    const listDevicesFn = async () => {
      calls++;
      controller.abort();
      return listed([device("emulator-5554", { booted: false })]);
    };
    const online = await waitForAdbOnline("emulator-5554", 1000, {
      listDevicesFn,
      pollIntervalMs: 1,
      signal: controller.signal,
    });
    expect(online.value).toBeNull();
    expect(calls).toBe(1);
  });

  test("returns a lister result error on the first poll", async () => {
    let calls = 0;
    const error = { message: "adb starting", error: new Error("not ready") };
    const listDevicesFn = async () => {
      calls++;
      return { value: [], error };
    };
    const online = await waitForAdbOnline("emulator-5554", 1000, {
      listDevicesFn,
      pollIntervalMs: 1,
    });
    expect(online).toEqual({ value: null, error });
    expect(calls).toBe(1);
  });
});
