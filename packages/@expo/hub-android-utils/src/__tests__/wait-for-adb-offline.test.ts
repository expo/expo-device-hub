import { describe, expect, test } from "bun:test";
import { waitForAdbOffline } from "../wait-for-adb-offline";

const listed = (value: string[]) => ({ value, error: null });

describe("waitForAdbOffline", () => {
  test("resolves true on the first poll when the serial is already gone", async () => {
    let calls = 0;
    const listSerialsFn = async () => {
      calls++;
      return listed(["emulator-5556"]);
    };
    expect((await waitForAdbOffline("emulator-5554", 1000, { listSerialsFn })).value).toBe(true);
    expect(calls).toBe(1);
  });

  test("keeps polling until the serial leaves adb", async () => {
    let calls = 0;
    const listSerialsFn = async () => {
      calls++;
      return listed(calls >= 3 ? [] : ["emulator-5554"]);
    };
    const offline = await waitForAdbOffline("emulator-5554", 1000, {
      listSerialsFn,
      pollIntervalMs: 1,
    });
    expect(offline.value).toBe(true);
    expect(calls).toBe(3);
  });

  test("a failed listing does not count as gone, then resolves true once it succeeds", async () => {
    let calls = 0;
    const error = {
      message: "[android-utils] Failed to run `adb devices -l`:",
      error: new Error("adb server killed"),
    };
    const listSerialsFn = async () => {
      calls++;
      return calls >= 3 ? listed([]) : { value: [], error };
    };
    const offline = await waitForAdbOffline("emulator-5554", 1000, {
      listSerialsFn,
      pollIntervalMs: 1,
    });
    expect(offline).toEqual({ value: true, error: null });
    expect(calls).toBe(3);
  });

  test("resolves false once the timeout elapses while the serial is still listed", async () => {
    let calls = 0;
    const listSerialsFn = async () => {
      calls++;
      return listed(["emulator-5554"]);
    };
    const offline = await waitForAdbOffline("emulator-5554", 30, {
      listSerialsFn,
      pollIntervalMs: 10,
    });
    expect(offline.value).toBe(false);
    expect(calls).toBeGreaterThanOrEqual(1);
  });

  test("reports the last listing failure alongside false on timeout", async () => {
    const error = {
      message: "[android-utils] Failed to run `adb devices -l`:",
      error: new Error("adb server killed"),
    };
    const listSerialsFn = async () => ({ value: [], error });
    const offline = await waitForAdbOffline("emulator-5554", 30, {
      listSerialsFn,
      pollIntervalMs: 10,
    });
    expect(offline).toEqual({ value: false, error });
  });

  test("reports a thrown lister failure alongside false on timeout", async () => {
    let calls = 0;
    const listSerialsFn = async () => {
      calls++;
      throw new Error("adb unavailable");
    };
    const offline = await waitForAdbOffline("emulator-5554", 30, {
      listSerialsFn,
      pollIntervalMs: 10,
    });
    expect(offline.value).toBe(false);
    expect(offline.error).not.toBeNull();
    expect(calls).toBeGreaterThanOrEqual(1);
  });

  test("ignores other serials still attached to adb", async () => {
    const listSerialsFn = async () => listed(["emulator-5556", "27151JEGR11854"]);
    const offline = await waitForAdbOffline("emulator-5554", 30, {
      listSerialsFn,
      pollIntervalMs: 10,
    });
    expect(offline.value).toBe(true);
  });

  test("resolves false without polling when the signal is already aborted", async () => {
    let calls = 0;
    const listSerialsFn = async () => {
      calls++;
      return listed([]);
    };
    const offline = await waitForAdbOffline("emulator-5554", 1000, {
      listSerialsFn,
      pollIntervalMs: 1,
      signal: AbortSignal.abort(),
    });
    expect(offline.value).toBe(false);
    expect(calls).toBe(0);
  });

  test("stops polling once the signal aborts", async () => {
    const controller = new AbortController();
    let calls = 0;
    const listSerialsFn = async () => {
      calls++;
      controller.abort();
      return listed(["emulator-5554"]);
    };
    const offline = await waitForAdbOffline("emulator-5554", 1000, {
      listSerialsFn,
      pollIntervalMs: 1,
      signal: controller.signal,
    });
    expect(offline.value).toBe(false);
    expect(calls).toBe(1);
  });
});
