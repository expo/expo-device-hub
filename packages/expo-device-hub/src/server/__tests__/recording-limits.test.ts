import { describe, expect, test } from "bun:test";

import { recordingEncodingFromEnv, recordingLimitsFromEnv } from "../recording-limits";

describe("recordingLimitsFromEnv", () => {
  test("returns only the variables that are set", () => {
    expect(recordingLimitsFromEnv({})).toEqual({});
    expect(
      recordingLimitsFromEnv({
        EXPO_DEVICE_HUB_RECORDING_MAX_BYTES: "65536",
        EXPO_DEVICE_HUB_RECORDING_MIN_FREE_BYTES: "0",
      }),
    ).toEqual({ maxFileBytes: 65536, minFreeBytes: 0 });
  });

  test.each([
    ["EXPO_DEVICE_HUB_RECORDING_MAX_BYTES", ""],
    ["EXPO_DEVICE_HUB_RECORDING_MAX_BYTES", "abc"],
    ["EXPO_DEVICE_HUB_RECORDING_MAX_BYTES", "0"],
    ["EXPO_DEVICE_HUB_RECORDING_MAX_BYTES", "1.5"],
    ["EXPO_DEVICE_HUB_RECORDING_MAX_DURATION_MS", "-1"],
    ["EXPO_DEVICE_HUB_RECORDING_MAX_DURATION_MS", "86400001"],
    ["EXPO_DEVICE_HUB_RECORDING_MIN_FREE_BYTES", "-1"],
  ])("names the variable in the error: %s=%j", (name, value) => {
    expect(() => recordingLimitsFromEnv({ [name]: value })).toThrow(name);
  });
});

describe("recordingEncodingFromEnv", () => {
  test("returns only the variables that are set", () => {
    expect(recordingEncodingFromEnv({})).toEqual({});
    expect(
      recordingEncodingFromEnv({
        EXPO_DEVICE_HUB_RECORDING_MAX_DIMENSION: "0",
        EXPO_DEVICE_HUB_RECORDING_FPS: "120",
        EXPO_DEVICE_HUB_RECORDING_BITRATE: "100000",
      }),
    ).toEqual({ maxSize: 0, fps: 120, bitRate: 100_000 });
    expect(
      recordingEncodingFromEnv({
        EXPO_DEVICE_HUB_RECORDING_MAX_DIMENSION: "16",
        EXPO_DEVICE_HUB_RECORDING_BITRATE: "50000000",
      }),
    ).toEqual({ maxSize: 16, bitRate: 50_000_000 });
  });

  test.each([
    ["EXPO_DEVICE_HUB_RECORDING_MAX_DIMENSION", ""],
    ["EXPO_DEVICE_HUB_RECORDING_MAX_DIMENSION", "15"],
    ["EXPO_DEVICE_HUB_RECORDING_MAX_DIMENSION", "4097"],
    ["EXPO_DEVICE_HUB_RECORDING_MAX_DIMENSION", "-1"],
    ["EXPO_DEVICE_HUB_RECORDING_FPS", "0"],
    ["EXPO_DEVICE_HUB_RECORDING_FPS", "121"],
    ["EXPO_DEVICE_HUB_RECORDING_FPS", "29.97"],
    ["EXPO_DEVICE_HUB_RECORDING_BITRATE", "99999"],
    ["EXPO_DEVICE_HUB_RECORDING_BITRATE", "50000001"],
    ["EXPO_DEVICE_HUB_RECORDING_BITRATE", "8M"],
  ])("names the variable in the error: %s=%j", (name, value) => {
    expect(() => recordingEncodingFromEnv({ [name]: value })).toThrow(name);
  });
});
