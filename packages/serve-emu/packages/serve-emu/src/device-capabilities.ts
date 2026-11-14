import { lstatSync } from "node:fs";
import { join } from "node:path";
import { STREAM_MODES, type StreamMode } from "./shared/api-contracts.ts";

const EMULATOR_SERIAL = /^emulator-(\d+)$/;

export type EmulatorSerial = {
  consolePort: string;
};

export function parseEmulatorSerial(serial: string): EmulatorSerial | null {
  const match = serial.match(EMULATOR_SERIAL);
  return match ? { consolePort: match[1]! } : null;
}

export function isEmulatorSerial(serial: string): boolean {
  return parseEmulatorSerial(serial) !== null;
}

/**
 * The stream modes a device can use. `emulator-capture` needs an emulator whose capture agent
 * serves a socket, which only the caller knows.
 */
export function availableStreamModesForSerial(
  serial: string,
  { emulatorCapture = false }: { emulatorCapture?: boolean } = {},
): StreamMode[] {
  if (!isEmulatorSerial(serial)) return ["scrcpy"];
  return STREAM_MODES.filter((mode) => mode !== "emulator-capture" || emulatorCapture);
}

/** How the embedding app offers the `emulator-capture` stream mode. */
export type EmulatorCaptureOptions = {
  /**
   * Directory of expo-emulator-capture agent sockets named `<serial>.sock`. An emulator with a
   * socket there can use the mode. Unset when the app has the feature turned off.
   */
  socketDirectory?: string;
  /** Why the mode is unavailable when there is no socket directory, shown to the user. */
  unavailableReason?: string;
  /**
   * Why an emulator without an agent socket cannot use the mode, shown to the user. A function
   * is read at every request, for a state that changes, such as an install in progress, and
   * gets the emulator's serial.
   */
  missingAgentReason?: string | ((serial: string) => string);
};

export const DEFAULT_MISSING_AGENT_REASON =
  "This emulator started without the capture agent. Stop it and start it again with the agent.";

/** The agent socket of an emulator, or null when it has none. */
export function emulatorCaptureSocketFor(
  serial: string,
  socketDirectory: string | undefined,
): string | null {
  if (!socketDirectory || !isEmulatorSerial(serial)) return null;
  const socket = join(socketDirectory, `${serial}.sock`);
  try {
    const directory = lstatSync(socketDirectory);
    const info = lstatSync(socket);
    // A socket that another user created, or a link, is not this user's agent.
    const uid = process.getuid?.();
    if (
      !directory.isDirectory() ||
      (directory.mode & 0o077) !== 0 ||
      !info.isSocket() ||
      (uid !== undefined && (directory.uid !== uid || info.uid !== uid))
    )
      return null;
    return socket;
  } catch {
    return null;
  }
}

/**
 * Whether a device can use `emulator-capture`, and if not, why. Without options, the app does
 * not offer the mode at all, so there is no reason to show.
 */
export function emulatorCaptureAvailability(
  serial: string,
  options: EmulatorCaptureOptions | undefined,
): { socket: string | null; reason?: string } {
  // A physical device never offers the mode, so it gets no reason and no disabled option.
  if (!options || !isEmulatorSerial(serial)) return { socket: null };
  if (!options.socketDirectory) {
    return { socket: null, reason: options.unavailableReason ?? "Emulator capture is turned off." };
  }
  const socket = emulatorCaptureSocketFor(serial, options.socketDirectory);
  return socket
    ? { socket }
    : { socket: null, reason: emulatorCaptureMissingAgent(serial, options) };
}

/** Why an emulator has no answering agent, for the user. */
export function emulatorCaptureMissingAgent(
  serial: string,
  options: EmulatorCaptureOptions | undefined,
): string {
  const reason = options?.missingAgentReason;
  return (typeof reason === "function" ? reason(serial) : reason) ?? DEFAULT_MISSING_AGENT_REASON;
}
