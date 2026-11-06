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

/** Experimental capture for the emulators the Hub boots (macOS on Apple silicon, Linux x86-64). */
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
  /** The host the agent was built for: it picks the preload variable and the renderer. */
  platform: "darwin" | "linux";
};

const PRELOAD_VARIABLE = { darwin: "DYLD_INSERT_LIBRARIES", linux: "LD_PRELOAD" } as const;

const SUPPORTED_HOSTS = "macOS on Apple silicon or Linux x86-64";

function capturePlatform(
  platform: NodeJS.Platform,
  arch: string,
): EmulatorCapture["platform"] | null {
  if (platform === "darwin" && arch === "arm64") return "darwin";
  if (platform === "linux" && arch === "x64") return "linux";
  return null;
}

/** The x264 library that the Linux agent encodes with. The agent supports this build only. */
export const X264_LIBRARY = "libx264.so.165";

// Where the dynamic loader finds libraries on common distributions, after LD_LIBRARY_PATH.
const LIBRARY_DIRECTORIES = [
  "/lib/x86_64-linux-gnu",
  "/usr/lib/x86_64-linux-gnu",
  "/usr/local/lib",
  "/lib64",
  "/usr/lib64",
  "/lib",
  "/usr/lib",
];

// @ref LLP 0018#encoder — the system's x264 build 165; the Hub checks for it before a boot
/**
 * Why the agent cannot encode on this host, or null. The Linux agent loads x264 from the
 * system and reports a missing library itself; this check lets the Hub say so before it boots
 * an emulator with the agent.
 */
export function emulatorCaptureEncoderProblem(
  platform: EmulatorCapture["platform"],
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string | null {
  if (platform !== "linux") return null;
  const directories = [
    ...(env.LD_LIBRARY_PATH ?? "").split(":").filter(isAbsolute),
    ...LIBRARY_DIRECTORIES,
  ];
  if (directories.some((directory) => exists(join(directory, X264_LIBRARY)))) return null;
  return `x264 build 165 (${X264_LIBRARY}) is missing. Install it with: sudo apt install libx264-165 (Ubuntu 26.04 or later), then start the emulator again from the Hub.`;
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
  if (!capturePlatform(platform, arch)) return `Emulator capture needs ${SUPPORTED_HOSTS}.`;
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
  encoderProblem: (host: EmulatorCapture["platform"]) => string | null = (host) =>
    emulatorCaptureEncoderProblem(host, env),
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
      `${EMULATOR_CAPTURE_LIBRARY_ENV} must be the absolute path of the agent library (libexpo_emulator_capture.dylib or .so); ${localLibrary} does not exist`,
    );
  }
  let pending: Promise<string> | null = null;
  let problem: string | null = null;
  /** Installs the package once; after a failure, the next call tries again. */
  const installed = (): Promise<string> => {
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
  const library = (): Promise<string> => {
    // Checked at every boot, so an encoder that the user installs meanwhile counts.
    const encoder = encoderProblem(host);
    if (encoder !== null) return Promise.reject(new Error(encoder));
    return localLibrary !== undefined ? Promise.resolve(localLibrary) : installed();
  };
  if (localLibrary === undefined) {
    problem = `Installing ${EMULATOR_CAPTURE_PACKAGE}…`;
    // In the background, also while the encoder is missing: a boot after the user installs
    // it does not wait for npm.
    installed().catch((error: unknown) => {
      console.warn(`[emulator capture] ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  const startupProblem = encoderProblem(host);
  if (startupProblem !== null) console.warn(`[emulator capture] ${startupProblem}`);
  // The same default directory as `expo-emulator-capture launch`, so emulators
  // started either way are found by serial.
  return {
    library,
    // An encoder problem needs the user, so it comes before the install state.
    problem: () => encoderProblem(host) ?? problem,
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

// @ref LLP 0017#integration — the agent's own reason when it turned itself off
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
  return platform === "darwin"
    ? // @ref LLP 0017#frame-paths — the GPU frame path needs host rendering
      // `-gpu auto` picks a software renderer on a headless Mac.
      ["-gpu", "host"]
    : // @ref LLP 0018#renderer — lavapipe kept 60 fps with the readback on the render thread
      ["-gpu", "lavapipe"];
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
