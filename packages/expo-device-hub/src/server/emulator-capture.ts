import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

/** Path of the expo-emulator-capture agent; setting it turns the experiment on. */
export const EMULATOR_CAPTURE_ENV = "EXPO_DEVICE_HUB_EXPERIMENTAL_EMULATOR_CAPTURE";

/** Experimental GPU capture for the emulators the Hub boots (macOS on Apple silicon). */
export type EmulatorCapture = {
  /** The agent dylib preloaded into each emulator. */
  library: string;
  /** Where each emulator's agent socket is created as `<serial>.sock`. */
  socketDirectory: string;
};

/**
 * Reads the experiment's configuration, or null when it is off.
 * Throws when it is on but cannot work, so the Hub does not start half-configured.
 */
export function readEmulatorCapture(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): EmulatorCapture | null {
  const library = env[EMULATOR_CAPTURE_ENV];
  if (!library) return null;
  if (platform !== "darwin" || arch !== "arm64") {
    throw new Error(`${EMULATOR_CAPTURE_ENV} requires macOS on Apple silicon`);
  }
  if (!isAbsolute(library) || !existsSync(library)) {
    throw new Error(
      `${EMULATOR_CAPTURE_ENV} must be the absolute path of libexpo_emulator_capture.dylib; ${library} does not exist`,
    );
  }
  // The same default directory as `expo-emulator-capture launch`, so emulators
  // started either way are found by serial.
  return { library, socketDirectory: join(tmpdir(), "expo-emulator-capture") };
}

/** Emulator flags and environment that load the capture agent for one emulator. */
export function emulatorCaptureLaunch(
  capture: EmulatorCapture,
  serial: string,
): { args: string[]; env: Record<string, string> } {
  return {
    // @ref LLP 0017#frame-paths — the GPU frame path needs host rendering
    // `-gpu auto` picks a software renderer on a headless Mac.
    // EXPO_DEVICE_HUB_EMULATOR_EXTRA_ARGS comes later and can still override it.
    args: ["-gpu", "host"],
    env: {
      DYLD_INSERT_LIBRARIES: capture.library,
      EXPO_EMULATOR_CAPTURE_SOCKET: join(capture.socketDirectory, `${serial}.sock`),
    },
  };
}
