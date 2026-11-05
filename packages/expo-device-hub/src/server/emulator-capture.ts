import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { EMULATOR_CAPTURE_PACKAGE, installEmulatorCapture } from "./emulator-capture-install";

/** Turns the experimental emulator capture on: `1`. The CLI flag sets it too. */
export const EMULATOR_CAPTURE_ENV = "EXPO_DEVICE_HUB_EXPERIMENTAL_EMULATOR_CAPTURE";
/** The absolute path of a locally built agent library, used instead of the installed package. */
export const EMULATOR_CAPTURE_LIBRARY_ENV = "EXPO_DEVICE_HUB_EMULATOR_CAPTURE_LIBRARY";
export const EMULATOR_CAPTURE_FLAG = "--experimental-emulator-capture";

/** Experimental capture for the emulators the Hub boots (macOS on Apple silicon). */
export type EmulatorCapture = {
  /**
   * The agent library preloaded into each emulator. Resolves once the package is installed;
   * rejects when it cannot be, and a later call tries again.
   */
  library(): Promise<string>;
  /** What keeps the agent from loading now, for display; null when nothing is known to. */
  problem(): string | null;
  /** Where each emulator's agent socket is created as `<serial>.sock`. */
  socketDirectory: string;
  /** The host the agent was built for: it picks the preload variable. */
  platform: "darwin";
};

const PRELOAD_VARIABLE = { darwin: "DYLD_INSERT_LIBRARIES" } as const;

function capturePlatform(
  platform: NodeJS.Platform,
  arch: string,
): EmulatorCapture["platform"] | null {
  return platform === "darwin" && arch === "arm64" ? "darwin" : null;
}

/** Whether the user turned the capture on, with the variable (`1`, `true`) or the old path form. */
export function emulatorCaptureRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[EMULATOR_CAPTURE_ENV]?.trim();
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase()) || isAbsolute(value);
}

/** Why the `emulator-capture` stream source is not available while the feature is off. */
export function emulatorCaptureOffReason(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  if (!capturePlatform(platform, arch)) return "Emulator capture needs macOS on Apple silicon.";
  return `Turned off. Restart the Hub with ${EMULATOR_CAPTURE_FLAG}, or set ${EMULATOR_CAPTURE_ENV}=1 for expo start.`;
}

/**
 * Reads the experiment's configuration, or null when it is off. Starts installing the agent
 * package in the background when no local library is named.
 * Throws when it is on but cannot work, so the Hub does not start half-configured.
 */
export function readEmulatorCapture(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  install: () => Promise<string> = () => installEmulatorCapture({ platform }),
): EmulatorCapture | null {
  if (!emulatorCaptureRequested(env)) return null;
  const host = capturePlatform(platform, arch);
  if (!host) throw new Error(`${EMULATOR_CAPTURE_ENV} requires macOS on Apple silicon`);
  // Before the on/off form, the variable held the library path.
  const legacyPath = env[EMULATOR_CAPTURE_ENV]?.trim();
  const localLibrary =
    env[EMULATOR_CAPTURE_LIBRARY_ENV]?.trim() ||
    (legacyPath && isAbsolute(legacyPath) ? legacyPath : undefined);
  if (localLibrary !== undefined && (!isAbsolute(localLibrary) || !existsSync(localLibrary))) {
    throw new Error(
      `${EMULATOR_CAPTURE_LIBRARY_ENV} must be the absolute path of libexpo_emulator_capture.dylib; ${localLibrary} does not exist`,
    );
  }
  let pending: Promise<string> | null = null;
  let problem: string | null = null;
  const library = (): Promise<string> => {
    if (localLibrary !== undefined) return Promise.resolve(localLibrary);
    pending ??= install().then(
      (path) => {
        problem = null;
        return path;
      },
      (error: unknown) => {
        // The install error names the package and npm's reason.
        problem =
          error instanceof Error
            ? error.message
            : `Installing ${EMULATOR_CAPTURE_PACKAGE} failed: ${String(error)}`;
        pending = null; // The next boot tries again.
        throw error;
      },
    );
    return pending;
  };
  if (localLibrary === undefined) {
    problem = `Installing ${EMULATOR_CAPTURE_PACKAGE}…`;
    library().catch((error: unknown) => {
      console.warn(`[emulator capture] ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  // The same default directory as `expo-emulator-capture launch`, so emulators
  // started either way are found by serial.
  return {
    library,
    problem: () => problem,
    socketDirectory: join(tmpdir(), "expo-emulator-capture"),
    platform: host,
  };
}

/**
 * Why an emulator has no agent socket: the install state when it is the cause, otherwise how to
 * get one. Shown below the stream source select.
 */
export function emulatorCaptureMissingAgentReason(capture: EmulatorCapture): string {
  return (
    capture.problem() ??
    "This emulator started without the capture agent. Stop it and start it again from the Hub."
  );
}

/**
 * Emulator flags and environment that load the capture agent for one emulator.
 * A library the Hub's own environment already preloads stays preloaded, after the agent.
 */
export function emulatorCaptureLaunch(
  capture: Pick<EmulatorCapture, "socketDirectory" | "platform"> & { library: string },
  serial: string,
  inherited: NodeJS.ProcessEnv = process.env,
): { args: string[]; env: Record<string, string> } {
  const variable = PRELOAD_VARIABLE[capture.platform];
  return {
    // @ref LLP 0017#frame-paths — the GPU frame path needs host rendering
    // `-gpu auto` picks a software renderer on a headless Mac.
    // EXPO_DEVICE_HUB_EMULATOR_EXTRA_ARGS comes later and can still override it.
    args: ["-gpu", "host"],
    env: {
      [variable]: [capture.library, inherited[variable]].filter(Boolean).join(":"),
      EXPO_EMULATOR_CAPTURE_SOCKET: join(capture.socketDirectory, `${serial}.sock`),
    },
  };
}
