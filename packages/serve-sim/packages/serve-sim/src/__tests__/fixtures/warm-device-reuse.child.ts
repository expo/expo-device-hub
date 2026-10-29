import { expect, mock, test } from "bun:test";

const calls: string[] = [];
let failStop: string | undefined;
let releaseStop = () => {};
mock.module("../../device", () => ({
  bootDevice: async () => {},
  shutdownDevice: async () => {},
  confirmDeviceBooted: async (udid: string) => {
    calls.push(`bootstatus ${udid}`);
  },
}));
mock.module("../../device-session", () => ({
  retireDeviceSession: async (udid: string) => {
    calls.push(`retire ${udid}`);
    await new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
  },
}));
mock.module("../../capture", () => ({ captureRuntime: { disableForDevice: async () => {} } }));
mock.module("../../launch-manager", () => ({
  releaseSession: async (udid: string) => {
    if (udid === failStop) throw new Error("shutdown failed");
    calls.push(`shutdown ${udid}`);
  },
}));
mock.module("../../camera-helper", () => ({ stopCameraHelper: () => {} }));
mock.module("../../state", () => ({
  clearServeSimState: (udid: string) => calls.push(`unpublish ${udid}`),
  gridDeviceState: () => ({}),
  writeServeSimState: () => {},
}));
const { prepareDeviceOnce, retireDevicesInBackground } = await import("../../device-lifecycle");

test("a prepared device only passes the boot check again", async () => {
  calls.length = 0;
  const prepared = new Set(["AAAA"]);
  const prepare = mock(async () => {});
  await prepareDeviceOnce("aaaa", prepared, prepare);
  expect(prepare).not.toHaveBeenCalled();
  expect(calls).toEqual(["bootstatus aaaa"]);
});

test("a device is prepared until one preparation succeeds", async () => {
  calls.length = 0;
  const prepared = new Set<string>();
  const failing = mock(async () => {
    throw new Error("loader failed");
  });
  await expect(prepareDeviceOnce("BBBB", prepared, failing)).rejects.toThrow("loader failed");
  expect(prepared.has("BBBB")).toBe(false);
  const prepare = mock(async () => {});
  await prepareDeviceOnce("BBBB", prepared, prepare);
  await prepareDeviceOnce("BBBB", prepared, prepare);
  expect(prepare).toHaveBeenCalledTimes(1);
});

test("other devices are unpublished at once and shut down in the background", async () => {
  calls.length = 0;
  failStop = "CCCC";
  const errors: string[] = [];
  const error = console.error;
  console.error = (message: string) => errors.push(message);
  try {
    const prepared = new Set(["CCCC", "DDDD"]);
    const retirement = retireDevicesInBackground(["CCCC", "DDDD"], 1, prepared);
    expect(calls).toEqual(["unpublish CCCC", "unpublish DDDD", "retire CCCC"]);
    expect([...prepared]).toEqual([]);
    releaseStop();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseStop();
    await retirement;
    expect(calls).toContain("shutdown DDDD");
    expect(errors.join("\n")).toContain("Could not shut down Simulator CCCC: shutdown failed");
  } finally {
    console.error = error;
    failStop = undefined;
  }
});
