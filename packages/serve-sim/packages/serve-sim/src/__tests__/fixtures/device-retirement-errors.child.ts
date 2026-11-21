import { expect, mock, spyOn, test } from "bun:test";
import * as native from "../../native";
import { useTempStateDir } from "../helpers";

// Exercise real session closure without loading the Simulator addon.
mock.module("../../native", () => ({ ...native, NativeHid: class {}, NativeCapture: class {} }));
const { DeviceSession, getDeviceSession, retireDeviceSession, finishDeviceRecordingsForShutdown } =
  await import("../../device-session");

test("retirement isolates device errors while server shutdown retains them", async () => {
  const state = useTempStateDir();
  const start = spyOn(DeviceSession.prototype, "start").mockResolvedValue(undefined);
  const failure = new Error("device A recording finalization failed");
  let stoppedB = false;
  try {
    const a = getDeviceSession("retirement-device-a") as any;
    a.phase = "running";
    a.recordingFailure = failure;
    a.capture = { stop: async () => {} };
    await expect(retireDeviceSession("retirement-device-a")).rejects.toThrow(failure.message);
    const b = getDeviceSession("retirement-device-b") as any;
    b.phase = "running";
    b.capture = {
      stop: async () => {
        stoppedB = true;
      },
    };
    await retireDeviceSession("retirement-device-b");
    expect(stoppedB).toBe(true);
    const failures: unknown[] = [];
    expect(await finishDeviceRecordingsForShutdown((error) => failures.push(error))).toBe(false);
    expect(failures).toContain(failure);
  } finally {
    start.mockRestore();
    await finishDeviceRecordingsForShutdown();
    state.restore();
  }
});
