import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EMULATOR_CAPTURE_ENV,
  EMULATOR_CAPTURE_LIBRARY_ENV,
  emulatorCaptureArgs,
  emulatorCaptureEncoderProblem,
  emulatorCaptureEnv,
  emulatorCaptureMissingAgentReason,
  emulatorCaptureOffReason,
  emulatorCaptureRequested,
  ensurePrivateDirectory,
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
  test("is on for 1 or true", () => {
    expect(emulatorCaptureRequested({ [EMULATOR_CAPTURE_ENV]: "1" })).toBe(true);
    expect(emulatorCaptureRequested({ [EMULATOR_CAPTURE_ENV]: "TRUE" })).toBe(true);
    expect(emulatorCaptureRequested({ [EMULATOR_CAPTURE_ENV]: "/opt/lib.dylib" })).toBe(false);
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
    expect(emulatorCaptureMissingAgentReason(capture, "emulator-5554")).toBe(
      "Installing expo-emulator-capture…",
    );
    finish("/cache/agent.dylib");
    expect(await capture.library()).toBe("/cache/agent.dylib");
    expect(capture.problem()).toBeNull();
    expect(installs).toBe(1);
    expect(emulatorCaptureMissingAgentReason(capture, "emulator-5554", () => "")).toContain(
      "started without the capture agent",
    );
  });

  test("gives the agent's own reason when it turned itself off", () => {
    const capture = readEmulatorCapture(
      { [EMULATOR_CAPTURE_ENV]: "1" },
      "darwin",
      "arm64",
      async () => "/cache/agent.dylib",
    )!;
    const logs: string[] = [];
    const log = [
      "[expo-emulator-capture] GPU frame path disabled: renderer symbols are missing",
      "[expo-emulator-capture] capture disabled: could not hook the renderer's display post",
      "",
    ].join("\n");
    return capture.library().then(() => {
      expect(
        emulatorCaptureMissingAgentReason(capture, "emulator-5556", (path) => {
          logs.push(path);
          return log;
        }),
      ).toBe(
        "The capture agent turned itself off in this emulator: could not hook the renderer's display post.",
      );
      expect(logs).toEqual([join(SOCKETS, "emulator-5556.log")]);
    });
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

  test("stays off on hosts other than macOS on Apple silicon and Linux x86-64", () => {
    const env = { [EMULATOR_CAPTURE_ENV]: "1" };
    for (const [platform, arch] of [
      ["linux", "arm64"],
      ["darwin", "x64"],
      ["win32", "x64"],
    ] as const) {
      expect(readEmulatorCapture(env, platform, arch, never)).toBeNull();
    }
  });

  test("on Linux, refuses to boot with the agent while x264 build 165 is missing", async () => {
    let encoder: string | null = "x264 build 165 (libx264.so.165) is missing.";
    let installs = 0;
    const capture = readEmulatorCapture(
      { [EMULATOR_CAPTURE_ENV]: "1" },
      "linux",
      "x64",
      async () => {
        installs++;
        return "/cache/agent.so";
      },
      () => encoder,
    )!;
    expect(capture.platform).toBe("linux");
    // The package still installs in the background.
    expect(installs).toBe(1);
    await expect(capture.library()).rejects.toThrow("libx264.so.165");
    expect(capture.problem()).toBe("x264 build 165 (libx264.so.165) is missing.");
    expect(emulatorCaptureMissingAgentReason(capture, "emulator-5554", () => "")).toBe(
      "x264 build 165 (libx264.so.165) is missing.",
    );
    // The user installs x264: the next boot loads the agent.
    encoder = null;
    expect(await capture.library()).toBe("/cache/agent.so");
    expect(capture.problem()).toBeNull();
    expect(installs).toBe(1);
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
  expect(emulatorCaptureOffReason("linux", "x64")).toContain("Turned off.");
  expect(emulatorCaptureOffReason("win32", "x64")).toBe(
    "Emulator capture needs macOS on Apple silicon or Linux x86-64.",
  );
});

test("emulatorCaptureEncoderProblem looks for x264 build 165 where the loader does", () => {
  const found = (paths: string[]) => (path: string) => paths.includes(path);
  expect(emulatorCaptureEncoderProblem("darwin", {}, found([]))).toBeNull();
  expect(emulatorCaptureEncoderProblem("linux", {}, found([]), () => "")).toBe(
    "x264 build 165 (libx264.so.165) is missing. Install it with: sudo apt install libx264-165 (Ubuntu 26.04 or later), then start the emulator again from the Hub.",
  );
  expect(
    emulatorCaptureEncoderProblem("linux", {}, found(["/usr/lib/x86_64-linux-gnu/libx264.so.165"])),
  ).toBeNull();
  expect(
    emulatorCaptureEncoderProblem(
      "linux",
      { LD_LIBRARY_PATH: "relative:/opt/x264/lib" },
      found(["/opt/x264/lib/libx264.so.165"]),
    ),
  ).toBeNull();
  // Relative entries depend on the emulator's directory, so the agent decides.
  expect(
    emulatorCaptureEncoderProblem(
      "linux",
      { LD_LIBRARY_PATH: "relative" },
      found(["relative/libx264.so.165"]),
    ),
  ).toBeNull();
});

test("x264 preflight accepts custom loader-cache directories and defers inconclusive probes", () => {
  const cache = "  libx264.so.165 (libc6,x86-64) => /opt/x264/lib/libx264.so.165\n";
  const found = (path: string) => path === "/opt/x264/lib/libx264.so.165";
  expect(emulatorCaptureEncoderProblem("linux", {}, found, () => cache)).toBeNull();
  expect(
    emulatorCaptureEncoderProblem(
      "linux",
      {},
      () => false,
      () => null,
    ),
  ).toBeNull();
  expect(
    emulatorCaptureEncoderProblem("linux", {}, found, () => cache.replace("x86-64", "AArch64")),
  ).not.toBeNull();
  expect(
    emulatorCaptureEncoderProblem(
      "linux",
      {},
      () => false,
      () => cache,
    ),
  ).not.toBeNull();
});

test("emulatorCaptureEnv names the socket and log by serial and keeps an inherited preload", () => {
  const capture = {
    library: "/lib.dylib",
    socketDirectory: "/tmp/capture",
    platform: "darwin" as const,
  };
  expect(emulatorCaptureArgs("darwin")).toEqual(["-gpu", "host"]);
  expect(emulatorCaptureEnv(capture, "emulator-5556", {})).toEqual({
    DYLD_INSERT_LIBRARIES: "/lib.dylib",
    EXPO_EMULATOR_CAPTURE_SOCKET: "/tmp/capture/emulator-5556.sock",
    EXPO_EMULATOR_CAPTURE_LOG: "/tmp/capture/emulator-5556.log",
  });
  expect(
    emulatorCaptureEnv(capture, "emulator-5556", { DYLD_INSERT_LIBRARIES: "/other.dylib" })
      .DYLD_INSERT_LIBRARIES,
  ).toBe("/lib.dylib:/other.dylib");
});

test("ensurePrivateDirectory creates a private directory and refuses one that others can use", async () => {
  const root = mkdtempSync(join(tmpdir(), "hub-capture-dir-"));
  try {
    const fresh = join(root, "fresh");
    await ensurePrivateDirectory(fresh);
    expect(statSync(fresh).mode & 0o777).toBe(0o700);
    const shared = join(root, "shared");
    await ensurePrivateDirectory(shared);
    chmodSync(shared, 0o755);
    await expect(ensurePrivateDirectory(shared)).rejects.toThrow("only this user can access");
    const link = join(root, "link");
    symlinkSync(fresh, link);
    await expect(ensurePrivateDirectory(link)).rejects.toThrow("only this user can access");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("on Linux, the agent loads with LD_PRELOAD and the emulator renders with lavapipe", () => {
  const capture = {
    library: "/lib.so",
    socketDirectory: "/tmp/capture",
    platform: "linux" as const,
  };
  expect(emulatorCaptureArgs("linux")).toEqual(["-gpu", "lavapipe"]);
  expect(emulatorCaptureEnv(capture, "emulator-5554", { LD_PRELOAD: "/other.so" })).toEqual({
    LD_PRELOAD: "/lib.so:/other.so",
    EXPO_EMULATOR_CAPTURE_SOCKET: "/tmp/capture/emulator-5554.sock",
    EXPO_EMULATOR_CAPTURE_LOG: "/tmp/capture/emulator-5554.log",
  });
});
