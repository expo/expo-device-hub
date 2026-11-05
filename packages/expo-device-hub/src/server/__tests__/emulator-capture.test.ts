import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EMULATOR_CAPTURE_ENV,
  EMULATOR_CAPTURE_LIBRARY_ENV,
  emulatorCaptureLaunch,
  emulatorCaptureMissingAgentReason,
  emulatorCaptureOffReason,
  emulatorCaptureRequested,
  readEmulatorCapture,
} from "../emulator-capture";

const SOCKETS = join(tmpdir(), "expo-emulator-capture");

function withLibrary(run: (library: string) => void | Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "hub-capture-"));
  const library = join(directory, "libexpo_emulator_capture.dylib");
  writeFileSync(library, "");
  return Promise.resolve(run(library)).finally(() =>
    rmSync(directory, { recursive: true, force: true }),
  );
}

describe("emulatorCaptureRequested", () => {
  test("is on for 1 or true, and for the old library path form", () => {
    expect(emulatorCaptureRequested({ [EMULATOR_CAPTURE_ENV]: "1" })).toBe(true);
    expect(emulatorCaptureRequested({ [EMULATOR_CAPTURE_ENV]: "TRUE" })).toBe(true);
    expect(emulatorCaptureRequested({ [EMULATOR_CAPTURE_ENV]: "/opt/lib.dylib" })).toBe(true);
    expect(emulatorCaptureRequested({})).toBe(false);
    expect(emulatorCaptureRequested({ [EMULATOR_CAPTURE_ENV]: "" })).toBe(false);
    expect(emulatorCaptureRequested({ [EMULATOR_CAPTURE_ENV]: "0" })).toBe(false);
  });
});

describe("readEmulatorCapture", () => {
  const never = async (): Promise<string> => {
    throw new Error("install must not run");
  };

  test("is off when the variable is unset or empty", () => {
    expect(readEmulatorCapture({}, "darwin", "arm64", never)).toBeNull();
    expect(
      readEmulatorCapture({ [EMULATOR_CAPTURE_ENV]: "" }, "darwin", "arm64", never),
    ).toBeNull();
  });

  test("installs the agent package in the background and reports the install", async () => {
    let installs = 0;
    let finish!: (path: string) => void;
    const capture = readEmulatorCapture({ [EMULATOR_CAPTURE_ENV]: "1" }, "darwin", "arm64", () => {
      installs++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    })!;
    expect(capture.socketDirectory).toBe(SOCKETS);
    expect(capture.platform).toBe("darwin");
    expect(installs).toBe(1);
    expect(capture.problem()).toBe("Installing expo-emulator-capture…");
    expect(emulatorCaptureMissingAgentReason(capture)).toBe("Installing expo-emulator-capture…");
    finish("/cache/agent.dylib");
    expect(await capture.library()).toBe("/cache/agent.dylib");
    expect(capture.problem()).toBeNull();
    expect(installs).toBe(1);
    expect(emulatorCaptureMissingAgentReason(capture)).toContain(
      "started without the capture agent",
    );
  });

  test("reports a failed install, and tries again on the next boot", async () => {
    let installs = 0;
    const capture = readEmulatorCapture(
      { [EMULATOR_CAPTURE_ENV]: "1" },
      "darwin",
      "arm64",
      async () => {
        installs++;
        if (installs === 1) throw new Error("npm ERR! 404");
        return "/cache/agent.dylib";
      },
    )!;
    await expect(capture.library()).rejects.toThrow("npm ERR! 404");
    expect(capture.problem()).toBe("npm ERR! 404");
    expect(await capture.library()).toBe("/cache/agent.dylib");
    expect(installs).toBe(2);
    expect(capture.problem()).toBeNull();
  });

  test("uses a locally built library without installing", () =>
    withLibrary(async (library) => {
      const capture = readEmulatorCapture(
        { [EMULATOR_CAPTURE_ENV]: "1", [EMULATOR_CAPTURE_LIBRARY_ENV]: library },
        "darwin",
        "arm64",
        never,
      )!;
      expect(await capture.library()).toBe(library);
      expect(capture.problem()).toBeNull();
    }));

  test("accepts the old form, where the variable held the library path", () =>
    withLibrary(async (library) => {
      const capture = readEmulatorCapture(
        { [EMULATOR_CAPTURE_ENV]: library },
        "darwin",
        "arm64",
        never,
      )!;
      expect(await capture.library()).toBe(library);
    }));

  test("refuses hosts other than macOS on Apple silicon", () => {
    const env = { [EMULATOR_CAPTURE_ENV]: "1" };
    expect(() => readEmulatorCapture(env, "linux", "x64", never)).toThrow("Apple silicon");
    expect(() => readEmulatorCapture(env, "darwin", "x64", never)).toThrow("Apple silicon");
  });

  test("refuses a relative or missing library path", () => {
    for (const library of [
      "libexpo_emulator_capture.dylib",
      "/missing/libexpo_emulator_capture.dylib",
    ]) {
      expect(() =>
        readEmulatorCapture(
          { [EMULATOR_CAPTURE_ENV]: "1", [EMULATOR_CAPTURE_LIBRARY_ENV]: library },
          "darwin",
          "arm64",
          never,
        ),
      ).toThrow("absolute path");
    }
  });
});

test("the off reason says how to turn the capture on, or why the host cannot", () => {
  expect(emulatorCaptureOffReason("darwin", "arm64")).toBe(
    `Turned off. Restart the Hub with --experimental-emulator-capture, or set ${EMULATOR_CAPTURE_ENV}=1 for expo start.`,
  );
  expect(emulatorCaptureOffReason("linux", "x64")).toBe(
    "Emulator capture needs macOS on Apple silicon.",
  );
});

test("emulatorCaptureLaunch names the socket by serial and keeps an inherited preload", () => {
  const capture = {
    library: "/lib.dylib",
    socketDirectory: "/tmp/capture",
    platform: "darwin" as const,
  };
  expect(emulatorCaptureLaunch(capture, "emulator-5556", {})).toEqual({
    args: ["-gpu", "host"],
    env: {
      DYLD_INSERT_LIBRARIES: "/lib.dylib",
      EXPO_EMULATOR_CAPTURE_SOCKET: "/tmp/capture/emulator-5556.sock",
    },
  });
  expect(
    emulatorCaptureLaunch(capture, "emulator-5556", { DYLD_INSERT_LIBRARIES: "/other.dylib" }).env
      .DYLD_INSERT_LIBRARIES,
  ).toBe("/lib.dylib:/other.dylib");
});
