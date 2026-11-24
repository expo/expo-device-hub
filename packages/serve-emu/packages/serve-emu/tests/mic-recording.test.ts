import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { ExecResult } from "../src/exec.ts";
import {
  isMicRecording,
  parseMicRecordingClients,
  readMicRecordingClients,
} from "../src/mic-recording.ts";

// `adb shell dumpsys media.audio_policy` on API 37 (emulator 37.2.13), captured 2026-11-24
// before and while CoinFlip recorded with expo-audio.
const fixture = (name: string) =>
  readFileSync(join(import.meta.dir, "fixtures", "audio-policy", name), "utf8");
const IDLE = fixture("api37-idle.txt");
const RECORDING = fixture("api37-recording.txt");

function inputs(clients: string): string {
  return [
    " Inputs (1):",
    "  1. Port ID: 92; 0x0000 (AUDIO_INPUT_FLAG_NONE); I/O handle: 190",
    "     Devices: AUDIO_DEVICE_IN_BUILTIN_MIC, @:bottom",
    "     AudioRecord Clients (1):",
    clients,
    "",
    " Total Effects CPU: 0.000000 MIPS",
  ].join("\n");
}

describe("parseMicRecordingClients", () => {
  test("finds no client while nothing records", () => {
    expect(parseMicRecordingClients(IDLE)).toEqual([]);
    expect(isMicRecording(parseMicRecordingClients(IDLE))).toBe(false);
  });

  test("finds the active MIC client of a recording app", () => {
    const clients = parseMicRecordingClients(RECORDING);
    expect(clients).toEqual([
      { uid: 10235, sessionId: 225, state: "Active", source: "AUDIO_SOURCE_MIC" },
    ]);
    expect(isMicRecording(clients)).toBe(true);
  });

  test("ignores clients outside the Inputs section", () => {
    // The real dump also lists playback clients ("uid 1000; State: Inactive") before Inputs.
    expect(IDLE).toContain("uid 1000; State: Inactive");
    expect(parseMicRecordingClients(IDLE)).toEqual([]);
  });

  test("needs an Active client with a source that reads the microphone", () => {
    const client = (state: string, source: string) =>
      inputs(
        [
          `      1. Port ID: 93; Session ID: 7; uid 10200; State: ${state}`,
          `         Attributes: { Content type: AUDIO_CONTENT_TYPE_UNKNOWN Source: ${source} Flags: 0x0 Tags:  }`,
          "         Source: 1; Flags: 00000000; is soundtrigger: 0",
        ].join("\n"),
      );
    expect(
      isMicRecording(
        parseMicRecordingClients(client("Active", "AUDIO_SOURCE_VOICE_COMMUNICATION")),
      ),
    ).toBe(true);
    expect(isMicRecording(parseMicRecordingClients(client("Silenced", "AUDIO_SOURCE_MIC")))).toBe(
      false,
    );
    expect(
      isMicRecording(parseMicRecordingClients(client("Active", "AUDIO_SOURCE_REMOTE_SUBMIX"))),
    ).toBe(false);
    // The numeric "Source: 1" line must not replace the named source.
    expect(parseMicRecordingClients(client("Active", "AUDIO_SOURCE_MIC"))[0]?.source).toBe(
      "AUDIO_SOURCE_MIC",
    );
  });

  test("returns no clients for output without an Inputs section", () => {
    expect(parseMicRecordingClients("")).toEqual([]);
    expect(parseMicRecordingClients("Can't find service: media.audio_policy")).toEqual([]);
  });
});

describe("readMicRecordingClients", () => {
  const result = (overrides: Partial<ExecResult<string>>): ExecResult<string> => ({
    status: 0,
    signal: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    error: null,
    ...overrides,
  });

  test("runs dumpsys on the serial in the background lane", async () => {
    const calls: Array<{ args: string[]; lane: unknown }> = [];
    const clients = await readMicRecordingClients("emulator-5554", {
      runExec: (async (_command: string, args: string[], options: { lane?: unknown }) => {
        calls.push({ args, lane: options.lane });
        return result({ stdout: RECORDING });
      }) as never,
    });
    expect(calls).toEqual([
      {
        args: ["-s", "emulator-5554", "shell", "dumpsys", "media.audio_policy"],
        lane: "background",
      },
    ]);
    expect(isMicRecording(clients)).toBe(true);
  });

  test("throws when dumpsys fails or times out", async () => {
    const run = (overrides: Partial<ExecResult<string>>) =>
      readMicRecordingClients("emulator-5554", {
        runExec: (async () => result(overrides)) as never,
      });
    await expect(run({ status: 1, stderr: "device offline" })).rejects.toThrow(
      "dumpsys media.audio_policy failed on emulator-5554: device offline",
    );
    await expect(run({ status: null, timedOut: true })).rejects.toThrow("timed out");
  });
});
