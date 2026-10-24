import { beforeEach, expect, mock, test } from "bun:test";
import type { NativeDeviceStateSnapshot } from "../../native";

let deliver: (json: string) => Promise<void>;
let unsubscribeCalls = 0;
let unsubscribeGate: Promise<void> | undefined;
const addon = {
  SimCapture: class {
    async subscribeDeviceState(callback: typeof deliver) {
      deliver = callback;
      return async () => {
        unsubscribeCalls++;
        await unsubscribeGate;
      };
    }
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
const { NativeCapture } = await import("../../native");

beforeEach(() => {
  unsubscribeCalls = 0;
  unsubscribeGate = undefined;
});

test("native JSON delivers complete snapshots including unknown fields", async () => {
  const received: NativeDeviceStateSnapshot[] = [];
  const capture = new NativeCapture("NATIVE-STATE-TEST");
  const unsubscribe = await capture.subscribeDeviceState(async (snapshot) => {
    received.push(snapshot);
  });
  await deliver('{"generation":3,"revision":1,"state":{"hingeAngle":90.25,"tableMode":false}}');
  await deliver('{"generation":3,"revision":2,"state":{}}');
  expect(received).toEqual([
    { generation: 3, revision: 1, state: { hingeAngle: 90.25, tableMode: false } },
    { generation: 3, revision: 2, state: {} },
  ]);
  await unsubscribe();
});

test("unsubscribe blocks queued callbacks before native cleanup completes", async () => {
  let calls = 0;
  let release!: () => void;
  unsubscribeGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const unsubscribe = await new NativeCapture("NATIVE-STATE-TEST").subscribeDeviceState(
    async () => {
      calls++;
    },
  );
  const stopping = unsubscribe();
  await deliver('{"generation":3,"revision":2,"state":{"hingeAngle":45}}');
  await unsubscribe();
  expect(calls).toBe(0);
  expect(unsubscribeCalls).toBe(1);
  release();
  await stopping;
});
