import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EMULATOR_CAPTURE_ENV,
  emulatorCaptureLaunch,
  readEmulatorCapture,
} from "../emulator-capture";

describe("readEmulatorCapture", () => {
  test("is off when the variable is unset or empty", () => {
    expect(readEmulatorCapture({}, "darwin", "arm64")).toBeNull();
    expect(readEmulatorCapture({ [EMULATOR_CAPTURE_ENV]: "" }, "darwin", "arm64")).toBeNull();
  });

  test("returns the agent and the shared socket directory", () => {
    const directory = mkdtempSync(join(tmpdir(), "hub-capture-"));
    try {
      const library = join(directory, "libexpo_emulator_capture.dylib");
      writeFileSync(library, "");
      expect(readEmulatorCapture({ [EMULATOR_CAPTURE_ENV]: library }, "darwin", "arm64")).toEqual({
        library,
        socketDirectory: join(tmpdir(), "expo-emulator-capture"),
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("refuses hosts other than macOS on Apple silicon", () => {
    const env = { [EMULATOR_CAPTURE_ENV]: "/opt/capture/libexpo_emulator_capture.dylib" };
    expect(() => readEmulatorCapture(env, "linux", "x64")).toThrow("Apple silicon");
    expect(() => readEmulatorCapture(env, "darwin", "x64")).toThrow("Apple silicon");
  });

  test("refuses a relative or missing agent path", () => {
    for (const library of [
      "libexpo_emulator_capture.dylib",
      "/missing/libexpo_emulator_capture.dylib",
    ]) {
      expect(() =>
        readEmulatorCapture({ [EMULATOR_CAPTURE_ENV]: library }, "darwin", "arm64"),
      ).toThrow("absolute path");
    }
  });
});

test("emulatorCaptureLaunch names the socket by serial", () => {
  expect(
    emulatorCaptureLaunch(
      { library: "/lib.dylib", socketDirectory: "/tmp/capture" },
      "emulator-5556",
    ),
  ).toEqual({
    args: ["-gpu", "host"],
    env: {
      DYLD_INSERT_LIBRARIES: "/lib.dylib",
      EXPO_EMULATOR_CAPTURE_SOCKET: "/tmp/capture/emulator-5556.sock",
    },
  });
});
