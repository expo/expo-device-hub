import { describe, expect, test } from "bun:test";

import { captureRuntime } from "../capture/runtime";
import { startCaptureForDevice } from "../capture/start";

import {
  disableNetworkCaptureForStoppedDevice,
  enableNetworkCaptureForStartedDevice,
  retryPendingCaptureCleanup,
} from "../middleware";

describe("enableNetworkCaptureForStartedDevice", () => {
  test("does nothing when network capture is off", async () => {
    let called = false;
    await enableNetworkCaptureForStartedDevice("UDID", false, {
      enable: async () => {
        called = true;
        return { proxyAddress: "127.0.0.1:1" };
      },
    });
    expect(called).toBe(false);
  });

  test("enables capture and logs success for a device started from the sidebar", async () => {
    const logs: string[] = [];
    await enableNetworkCaptureForStartedDevice("UDID-1", true, {
      enable: async (udid) => {
        expect(udid).toBe("UDID-1");
        return { proxyAddress: "127.0.0.1:5555" };
      },
      log: (message) => logs.push(message),
      error: (message) => logs.push(`err:${message}`),
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("Network capture on for UDID-1");
    expect(logs[0]).toContain("127.0.0.1:5555");
  });

  test("preserves an explicit off choice when the startup default is on", async () => {
    captureRuntime.setDeviceCaptureEnabled("EXPLICIT-OFF", false);
    let called = false;
    await enableNetworkCaptureForStartedDevice("EXPLICIT-OFF", true, {
      enable: async () => { called = true; return { proxyAddress: null }; },
    });
    expect(called).toBe(false);
  });

  test("preserves an explicit on choice without the startup flag", async () => {
    captureRuntime.setDeviceCaptureEnabled("EXPLICIT-ON", true);
    let called = false;
    await enableNetworkCaptureForStartedDevice("EXPLICIT-ON", false, {
      enable: async () => { called = true; return { proxyAddress: null }; },
      log: () => {},
    });
    expect(called).toBe(true);
  });

  test("logs the attach error when enable fails", async () => {
    const errors: string[] = [];
    await enableNetworkCaptureForStartedDevice("UDID-2", true, {
      enable: async () => {
        throw new Error("mitmproxy is not installed");
      },
      log: () => {},
      error: (message) => errors.push(message),
    });
    expect(errors[0]).toContain("UDID-2");
    expect(errors[0]).toContain("mitmproxy is not installed");
  });
});

describe("stopped-device capture cleanup retries", () => {
  test("retries the failed session until it is gone, even after the device boots with capture off", async () => {
    const sessions = new Map<string, object | null>([["RETRY-1", { id: "old-1" }]]);
    const attempts: string[] = [];
    let fail = true;
    const deps = {
      session: (udid: string) => sessions.get(udid) ?? null,
      disable: async (udid: string) => {
        attempts.push(udid);
        if (fail) throw new Error("capability state is locked");
        sessions.set(udid, null);
      },
    };
    expect(await disableNetworkCaptureForStoppedDevice("RETRY-1", deps)).toBe(false);
    await retryPendingCaptureCleanup(deps);
    expect(attempts).toEqual(["RETRY-1", "RETRY-1"]);

    fail = false;
    await retryPendingCaptureCleanup(deps);
    await retryPendingCaptureCleanup(deps);
    expect(attempts).toEqual(["RETRY-1", "RETRY-1", "RETRY-1"]);
  });

  test("leaves a newer session alone when the device restarted with capture on", async () => {
    const sessions = new Map<string, object | null>([["RETRY-2", { id: "old-2" }]]);
    const attempts: string[] = [];
    const deps = {
      session: (udid: string) => sessions.get(udid) ?? null,
      disable: async (udid: string) => {
        attempts.push(udid);
        throw new Error("capability state is locked");
      },
    };
    expect(await disableNetworkCaptureForStoppedDevice("RETRY-2", deps)).toBe(false);
    sessions.set("RETRY-2", { id: "new-2" });
    await retryPendingCaptureCleanup(deps);
    expect(attempts).toEqual(["RETRY-2"]);
  });
});

describe("overlapping cleanup retries", () => {
  test("runs one retry per device while an earlier one is still going", async () => {
    let release!: () => void;
    const gate = new Promise<void>((done) => (release = done));
    let attempts = 0;
    const session = { id: "overlap" };
    const base = { session: () => session };
    expect(
      await disableNetworkCaptureForStoppedDevice("OVERLAP-1", { ...base, disable: async () => { throw new Error("locked"); } }),
    ).toBe(false);
    const slow = { ...base, disable: async () => { attempts++; await gate; throw new Error("still locked"); } };
    const first = retryPendingCaptureCleanup(slow);
    const second = retryPendingCaptureCleanup(slow);
    await second;
    expect(attempts).toBe(1);
    release();
    await first;
    await retryPendingCaptureCleanup({ session: () => null });
  });
});

describe("disableNetworkCaptureForStoppedDevice", () => {
  test("cleans up UI-enabled capture without a startup flag", async () => {
    let called = false;
    await disableNetworkCaptureForStoppedDevice("UDID", {
      disable: async () => {
        called = true;
      },
    });
    expect(called).toBe(true);
  });

  test("disables capture when a captured device is shut down from the grid", async () => {
    const disabled: string[] = [];
    await disableNetworkCaptureForStoppedDevice("UDID-3", {
      disable: async (udid) => void disabled.push(udid),
    });
    expect(disabled).toEqual(["UDID-3"]);
  });
});

describe("capture startup cancellation", () => {
  test("does not arm another device after an in-flight start is cancelled", async () => {
    let stopping = false;
    let cancel!: (error: Error) => void;
    const pending = new Promise<never>((_resolve, reject) => { cancel = reject; });
    const enabled: string[] = [];
    const start = async () => {
      for (const udid of ["FIRST", "SECOND"]) {
        await startCaptureForDevice(udid, {
          shouldStop: () => stopping,
          enable: async (device) => {
            enabled.push(device);
            return pending;
          },
        });
      }
    };
    const starting = start();
    expect(enabled).toEqual(["FIRST"]);
    stopping = true;
    cancel(new Error("capture was cancelled"));
    await starting;
    expect(enabled).toEqual(["FIRST"]);
  });

  test("does not announce a start that finished after shutdown began", async () => {
    let stopping = false;
    const started: string[] = [];
    await startCaptureForDevice("DEVICE", {
      shouldStop: () => stopping,
      enable: async () => {
        stopping = true;
        return { proxyAddress: "127.0.0.1:1" };
      },
      onStarted: (meta) => void started.push(meta.proxyAddress ?? ""),
    });
    expect(started).toEqual([]);
  });

  test("does not enable capture when shutdown has already begun", async () => {
    let enabled = false;
    await startCaptureForDevice("DEVICE", {
      shouldStop: () => true,
      enable: async () => {
        enabled = true;
        return { proxyAddress: "127.0.0.1:1" };
      },
    });
    expect(enabled).toBe(false);
  });
});
