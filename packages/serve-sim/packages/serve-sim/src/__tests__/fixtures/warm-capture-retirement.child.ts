import { expect, mock, test } from "bun:test";
import { capabilityHarness } from "../../capabilities/network-capture/__tests__/capability-harness";
import { createCaptureRuntime } from "../../capabilities/network-capture/runtime";

const events: string[] = [];
let closeProxy = async () => {};
const runtime = createCaptureRuntime({
  startProxy: async () => ({
    address: "127.0.0.1:9123",
    portFile: "/tmp/warm-capture-retirement-proxy-port",
    caPem: async () => "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n",
    setFields: () => {},
    close: async () => {
      events.push("proxy-close-start");
      await closeProxy();
      events.push("proxy-close-done");
    },
  }),
  trustCa: async () => {},
  dylib: () => "/fake/libSimNetProxy.dylib",
  configure: capabilityHarness({ remove: async () => void events.push("capture-withdrawn") }),
  isInjected: async () => true,
  checkIntervalMs: 0,
  writeDiskArtifacts: false,
});
const capture = await import("../../capabilities/network-capture");
mock.module("../../capabilities/network-capture", () => ({ ...capture, captureRuntime: runtime }));
mock.module("../../device", () => ({
  bootDevice: async () => {},
  confirmDeviceBooted: async () => {},
  shutdownDevice: async () => {
    throw new Error("adoption must use ownership-checked release");
  },
}));
mock.module("../../device-session", () => ({
  retireDeviceSession: async () => void events.push("native-session-retired"),
}));
mock.module("../../capabilities/runtime/manager", () => ({
  releaseSession: async (_udid: string, owner: number, _cleanup: unknown, options: unknown) => {
    expect(owner).toBe(4242);
    expect(options).toEqual({ shutdown: true });
    events.push("owner-released");
  },
}));
mock.module("../../capabilities/camera", () => ({ stopCameraHelper: () => {} }));
mock.module("../../state", () => ({
  clearServeSimState: (_udid: string, owner: number) => {
    expect(owner).toBe(4242);
    events.push("state-cleared");
  },
  gridDeviceState: () => ({}),
  writeServeSimState: () => {},
}));
const { stopDeviceInProcess } = await import("../../device-lifecycle");

function gate() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("warm retirement waits for actual Capture cleanup before releasing its owner", async () => {
  const udid = "00000000-0000-0000-0000-000000000701";
  const closing = gate();
  const started = gate();
  closeProxy = async () => {
    started.resolve();
    await closing.promise;
  };
  await runtime.enableForDevice(udid);
  events.length = 0;
  let settled = false;
  const stop = stopDeviceInProcess(udid, 4242).then(() => {
    settled = true;
  });
  try {
    await started.promise;
    expect(events).toEqual(["native-session-retired", "capture-withdrawn", "proxy-close-start"]);
    expect(settled).toBe(false);
  } finally {
    closing.resolve();
    await stop;
  }
  expect(events).toEqual([
    "native-session-retired",
    "capture-withdrawn",
    "proxy-close-start",
    "proxy-close-done",
    "owner-released",
    "state-cleared",
  ]);
  expect(runtime.metaFor(udid).attachment).toBe("not-enabled");
});

test("failed Capture cleanup retains ownership and can be retried before warm shutdown", async () => {
  const udid = "00000000-0000-0000-0000-000000000702";
  closeProxy = async () => {
    throw new Error("proxy close refused");
  };
  await runtime.enableForDevice(udid);
  events.length = 0;
  try {
    await expect(stopDeviceInProcess(udid, 4242)).rejects.toThrow("proxy close refused");
    expect(events).toEqual(["native-session-retired", "capture-withdrawn", "proxy-close-start"]);
  } finally {
    closeProxy = async () => {};
    events.length = 0;
    await stopDeviceInProcess(udid, 4242);
  }
  expect(events).toEqual([
    "native-session-retired",
    "capture-withdrawn",
    "proxy-close-start",
    "proxy-close-done",
    "owner-released",
    "state-cleared",
  ]);
  expect(runtime.metaFor(udid).attachment).toBe("not-enabled");
});
