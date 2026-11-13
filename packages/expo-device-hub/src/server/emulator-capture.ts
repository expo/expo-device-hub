import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { lstat, mkdir } from "node:fs/promises";
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

/** Whether the user turned the capture on with the variable (`1`, `true`, `yes`, `on`). */
export function emulatorCaptureRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[EMULATOR_CAPTURE_ENV]?.trim().toLowerCase();
  return !!value && ["1", "true", "yes", "on"].includes(value);
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
 * Reads the experiment's configuration, or null when it is off or the host cannot run it (the
 * off reason then says why). Starts installing the agent package in the background when no
 * local library is named. Throws for a local library path that does not exist.
 */
export function readEmulatorCapture(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  install: () => Promise<string> = () => installEmulatorCapture({ platform }),
): EmulatorCapture | null {
  if (!emulatorCaptureRequested(env)) return null;
  const host = capturePlatform(platform, arch);
  if (!host) {
    // A shared environment file can turn it on for every machine; the Hub still starts.
    console.warn(`[emulator capture] ${emulatorCaptureOffReason(platform, arch)}`);
    return null;
  }
  const localLibrary = env[EMULATOR_CAPTURE_LIBRARY_ENV]?.trim() || undefined;
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
 * Creates the socket directory, or checks the one that exists: it holds the sockets and logs,
 * so only this user may own or write it. On a shared `/tmp`, another user could otherwise
 * create it first and replace a socket.
 */
export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  const uid = process.getuid?.();
  if (!info.isDirectory() || (uid !== undefined && info.uid !== uid) || (info.mode & 0o077) !== 0) {
    throw new Error(`${path} must be a directory that only this user can access (mode 0700)`);
  }
}

/** The agent's log for one emulator that the Hub boots, next to its socket. */
export function emulatorCaptureLogPath(socketDirectory: string, serial: string): string {
  return join(socketDirectory, `${serial}.log`);
}

const MAX_LOG_TAIL_BYTES = 64 * 1024;

/** The end of a file, or an empty string when it cannot be read. */
function readTail(path: string): string {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, "r");
    const size = fstatSync(descriptor).size;
    const length = Math.min(size, MAX_LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(descriptor, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

// @ref LLP 0020#integration — the agent's own reason when it turned itself off
/**
 * Why an emulator has no agent socket, shown below the stream source select: the install state
 * when it is the cause; else the reason from the agent's log when the agent turned itself off,
 * for example after an emulator update; otherwise how to get the agent.
 */
export function emulatorCaptureMissingAgentReason(
  capture: EmulatorCapture,
  serial: string,
  readLog: (path: string) => string = readTail,
): string {
  const problem = capture.problem();
  if (problem) return problem;
  const disabled = readLog(emulatorCaptureLogPath(capture.socketDirectory, serial))
    .split("\n")
    .map((line) => /capture disabled: (.+)$/.exec(line)?.[1]?.trim())
    .filter(Boolean)
    .at(-1);
  if (disabled) return `The capture agent turned itself off in this emulator: ${disabled}.`;
  return "This emulator started without the capture agent. Stop it and start it again from the Hub.";
}

/**
 * The renderer flags for every emulator the Hub boots while the capture is on, also when the
 * agent cannot load, so the renderer does not depend on the install.
 * EXPO_DEVICE_HUB_EMULATOR_EXTRA_ARGS comes later and can still override them.
 */
export function emulatorCaptureArgs(platform: EmulatorCapture["platform"]): string[] {
  // @ref LLP 0020#frame-paths — the GPU frame path needs host rendering
  // `-gpu auto` picks a software renderer on a headless Mac.
  return platform === "darwin" ? ["-gpu", "host"] : [];
}

/**
 * The environment that loads the capture agent into one emulator: the preload, the socket and
 * the log. A library the Hub's own environment already preloads stays preloaded, after the agent.
 */
export function emulatorCaptureEnv(
  capture: Pick<EmulatorCapture, "socketDirectory" | "platform"> & { library: string },
  serial: string,
  inherited: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const variable = PRELOAD_VARIABLE[capture.platform];
  return {
    [variable]: [capture.library, inherited[variable]].filter(Boolean).join(":"),
    EXPO_EMULATOR_CAPTURE_SOCKET: join(capture.socketDirectory, `${serial}.sock`),
    EXPO_EMULATOR_CAPTURE_LOG: emulatorCaptureLogPath(capture.socketDirectory, serial),
  };
}
