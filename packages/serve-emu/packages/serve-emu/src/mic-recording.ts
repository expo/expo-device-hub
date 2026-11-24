import { execText } from "./exec.ts";

/**
 * Detect when an app on the device records from the microphone.
 *
 * serve-emu must open its `injectAudio` stream only while an app records, because a stream that
 * opens with no recording can crash the emulator (LLP 0026, Android rules). The audio policy
 * service is the source of truth: each open `AudioRecord` is a client of an input, with its
 * state and its requested source.
 */

/** One `AudioRecord Clients` entry of `dumpsys media.audio_policy`. */
export type MicRecordingClient = {
  uid: number | null;
  sessionId: number | null;
  /** `Active` while the client records. */
  state: string;
  /** The requested source, for example `AUDIO_SOURCE_MIC`, or null if the dump omits it. */
  source: string | null;
};

/**
 * Sources that read the device microphone, which `injectAudio` feeds. Call audio, the remote
 * submix, echo reference, hotword, and FM tuner sources do not read it.
 */
const MIC_SOURCES = new Set([
  "AUDIO_SOURCE_DEFAULT",
  "AUDIO_SOURCE_MIC",
  "AUDIO_SOURCE_CAMCORDER",
  "AUDIO_SOURCE_VOICE_RECOGNITION",
  "AUDIO_SOURCE_VOICE_COMMUNICATION",
  "AUDIO_SOURCE_UNPROCESSED",
  "AUDIO_SOURCE_VOICE_PERFORMANCE",
]);

const DUMPSYS_TIMEOUT_MS = 2_000;
// A dump is about 40 KB on API 37. Leave room for devices with many ports and effects.
const DUMPSYS_MAX_BYTES = 1024 * 1024;

/** The `Inputs (N):` section of `dumpsys media.audio_policy`, or null if it has none. */
function inputsSection(dump: string): string | null {
  const header = /^[ \t]*Inputs \(\d+\):[ \t]*$/m.exec(dump);
  if (!header) return null;
  const rest = dump.slice(header.index + header[0].length);
  // The section ends at the next line that is indented by one space or less, such as
  // " Total Effects CPU: …" or " Audio Patches (2):".
  const end = rest.search(/^[ \t]?\S/m);
  return end === -1 ? rest : rest.slice(0, end);
}

export function parseMicRecordingClients(dump: string): MicRecordingClient[] {
  const section = inputsSection(dump);
  if (!section) return [];
  const clients: MicRecordingClient[] = [];
  let current: MicRecordingClient | null = null;
  for (const line of section.split(/\r?\n/)) {
    const state = /\bState:\s*(\w+)/.exec(line);
    if (state && /\bPort ID:/.test(line)) {
      current = {
        uid: Number(/\buid (\d+)/.exec(line)?.[1] ?? NaN),
        sessionId: Number(/\bSession ID: (\d+)/.exec(line)?.[1] ?? NaN),
        state: state[1]!,
        source: null,
      };
      if (Number.isNaN(current.uid)) current.uid = null;
      if (Number.isNaN(current.sessionId)) current.sessionId = null;
      clients.push(current);
      continue;
    }
    const source = /\bSource: (AUDIO_SOURCE_\w+)/.exec(line);
    if (current && current.source === null && source) current.source = source[1]!;
  }
  return clients;
}

/** True when an app records from the microphone, so the emulator reads injected audio. */
export function isMicRecording(clients: readonly MicRecordingClient[]): boolean {
  return clients.some(
    (client) =>
      client.state === "Active" && client.source !== null && MIC_SOURCES.has(client.source),
  );
}

export type ReadMicRecordingOptions = {
  signal?: AbortSignal;
  runExec?: typeof execText;
};

/** Reads the device's recording clients. Throws when `dumpsys` fails. */
export async function readMicRecordingClients(
  serial: string,
  options: ReadMicRecordingOptions = {},
): Promise<MicRecordingClient[]> {
  const runExec = options.runExec ?? execText;
  const result = await runExec("adb", ["-s", serial, "shell", "dumpsys", "media.audio_policy"], {
    timeout: DUMPSYS_TIMEOUT_MS,
    maxBuffer: DUMPSYS_MAX_BYTES,
    signal: options.signal,
    lane: "background",
  });
  if (result.error || result.status !== 0 || result.timedOut) {
    const detail =
      result.stderr.trim() ||
      result.error?.message ||
      (result.timedOut ? "timed out" : `exit status ${result.status ?? "none"}`);
    throw new Error(`dumpsys media.audio_policy failed on ${serial}: ${detail}`);
  }
  return parseMicRecordingClients(result.stdout);
}
