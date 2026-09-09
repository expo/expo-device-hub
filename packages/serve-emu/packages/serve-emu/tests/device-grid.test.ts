import { expect, test } from "bun:test";
import {
  loadDeviceGrid,
  type DeviceGridDependencies,
} from "../src/device-grid.ts";
import type { Device } from "../src/adb.ts";

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("device grid performs one adb discovery and reuses its snapshot", async () => {
  const deviceGate = deferred<Device[]>();
  const devices = [
    { serial: "emulator-5554", state: "device" },
    { serial: "physical-1", state: "offline" },
  ];
  let deviceQueries = 0;
  let avdQueries = 0;
  let runningQueries = 0;
  let avdListStarted = false;
  let receivedSnapshot: readonly Device[] | null = null;
  const dependencies: DeviceGridDependencies = {
    listAllDevices: async () => {
      deviceQueries++;
      return deviceGate.promise;
    },
    listAvds: async () => {
      avdQueries++;
      avdListStarted = true;
      return ["Pixel_A", "Pixel_B"];
    },
    resolveRunningAvds: async (snapshot) => {
      runningQueries++;
      receivedSnapshot = snapshot;
      return [
        { serial: "emulator-5554", avd: "Pixel_A", state: "device" },
      ];
    },
  };

  const loading = loadDeviceGrid(
    "emulator-5554",
    "streaming",
    dependencies,
  );
  await Promise.resolve();
  expect(avdListStarted).toBe(true);
  expect(runningQueries).toBe(0);
  deviceGate.resolve(devices);

  expect(await loading).toEqual({
    ok: true,
    currentSerial: "emulator-5554",
    sessionStatus: "streaming",
    devices: [
      {
        id: "emulator-5554",
        kind: "emulator",
        serial: "emulator-5554",
        avd: "Pixel_A",
        name: "Pixel_A",
        state: "device",
        current: true,
        canSelect: true,
        canStart: false,
        canStop: true,
      },
      {
        id: "physical-1",
        kind: "physical",
        serial: "physical-1",
        avd: null,
        name: "physical-1",
        state: "offline",
        current: false,
        canSelect: false,
        canStart: false,
        canStop: false,
      },
      {
        id: "avd:Pixel_B",
        kind: "avd",
        serial: null,
        avd: "Pixel_B",
        name: "Pixel_B",
        state: "stopped",
        current: false,
        canSelect: false,
        canStart: true,
        canStop: false,
      },
    ],
  });
  expect(deviceQueries).toBe(1);
  expect(avdQueries).toBe(1);
  expect(runningQueries).toBe(1);
  expect(receivedSnapshot).toBe(devices);
});
