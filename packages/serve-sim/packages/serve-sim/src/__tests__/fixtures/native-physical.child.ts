import { beforeEach, expect, mock, test } from "bun:test";

let constructed: unknown[][] = [];
let supportArguments: string[] = [];
let endJson = JSON.stringify({ reason: "device-disconnected", message: "iPhone disconnected" });
const addon = {
  SimHID: class {
    constructor(...args: unknown[]) {
      constructed.push(["SimHID", ...args]);
    }
  },
  SimCapture: class {
    constructor(...args: unknown[]) {
      constructed.push(["SimCapture", ...args]);
    }
    async subscribeEnd(onEnd: (json: string) => Promise<void>) {
      await onEnd(endJson);
      return async () => {};
    }
  },
  async physicalDeviceSupport(udid: string) {
    supportArguments.push(udid);
    return udid === "00008030-OLD"
      ? JSON.stringify({
          supported: false,
          reason: "needs-ios-27",
          message: "needs iOS 27",
          osVersion: "26.4",
          deviceFound: true,
        })
      : JSON.stringify({ supported: true, coreDeviceVersion: "651.32" });
  },
};
const moduleExports = await import("module");
const originalCreateRequire = moduleExports.createRequire;
mock.module("module", () => ({
  ...moduleExports,
  createRequire: (url: string | URL) => {
    const require = originalCreateRequire(url);
    return Object.assign(
      (path: string) => (path.endsWith("serve-sim-native.node") ? addon : require(path)),
      require,
    );
  },
}));
const fsExports = await import("fs");
mock.module("fs", () => ({ ...fsExports, existsSync: () => true }));
const { NativeCapture, NativeHid, physicalDeviceSupport } = await import("../../native");
const { DEFAULT_STREAM_ENCODER_SETTINGS } = await import("../../stream-settings");

beforeEach(() => {
  constructed = [];
  supportArguments = [];
  endJson = JSON.stringify({ reason: "device-disconnected", message: "iPhone disconnected" });
});

test("a physical capture and HID name their device kind; simulators stay the default", () => {
  new NativeCapture(
    "00008101-0016603236F0801E",
    DEFAULT_STREAM_ENCODER_SETTINGS,
    undefined,
    "physical",
  );
  new NativeHid("00008101-0016603236F0801E", "physical");
  new NativeCapture("SIM-UDID");
  new NativeHid("SIM-UDID");
  expect(constructed.map((args) => [args[0], args[1], args.at(-1)])).toEqual([
    ["SimCapture", "00008101-0016603236F0801E", "physical"],
    ["SimHID", "00008101-0016603236F0801E", "physical"],
    ["SimCapture", "SIM-UDID", "simulator"],
    ["SimHID", "SIM-UDID", "simulator"],
  ]);
  expect(constructed[0]?.at(-2)).toBe(0);
});

test("the end signal reaches JavaScript as a device-disconnected reason", async () => {
  const capture = new NativeCapture(
    "00008101-0016603236F0801E",
    DEFAULT_STREAM_ENCODER_SETTINGS,
    undefined,
    "physical",
  );
  const ends: unknown[] = [];
  await capture.subscribeEnd((end) => {
    ends.push(end);
  });
  expect(ends).toEqual([{ reason: "device-disconnected", message: "iPhone disconnected" }]);
});

test("physical support reports the host alone or one phone", async () => {
  expect(await physicalDeviceSupport()).toEqual({ supported: true, coreDeviceVersion: "651.32" });
  expect(await physicalDeviceSupport("00008030-OLD")).toEqual({
    supported: false,
    reason: "needs-ios-27",
    message: "needs iOS 27",
    osVersion: "26.4",
    deviceFound: true,
  });
  expect(supportArguments).toEqual(["", "00008030-OLD"]);
});
