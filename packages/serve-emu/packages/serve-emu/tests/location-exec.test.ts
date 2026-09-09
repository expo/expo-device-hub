import { describe, expect, test } from "bun:test";
import { setEmulatorLocationAsync } from "../src/location.ts";
import type { execText } from "../src/exec.ts";

describe("setEmulatorLocationAsync", () => {
  test("uses the shared interactive executor lane", async () => {
    const calls: Array<{
      cmd: string;
      args: string[];
      options: Record<string, unknown>;
    }> = [];
    const runExec = (async (cmd, args, options) => {
      calls.push({ cmd, args, options: options ?? {} });
      return {
        status: 0,
        signal: null,
        stdout: "OK\n",
        stderr: "",
        timedOut: false,
        error: null,
      };
    }) as typeof execText;

    await setEmulatorLocationAsync(
      "emulator-5554",
      {
        latitude: 51.5007292,
        longitude: -0.1246254,
        altitude: 15,
        satellites: 8,
        velocity: 1.25,
      },
      runExec,
    );

    expect(calls).toEqual([
      {
        cmd: "adb",
        args: [
          "-s",
          "emulator-5554",
          "emu",
          "geo",
          "fix",
          "-0.1246254",
          "51.5007292",
          "15",
          "8",
          "1.25",
        ],
        options: {
          timeout: 5_000,
          maxBuffer: 64 * 1024,
          lane: "interactive",
        },
      },
    ]);
  });

  test("preserves timeout and emulator KO failures", async () => {
    const timedOut = (async () => ({
      status: null,
      signal: "SIGKILL" as const,
      stdout: "",
      stderr: "",
      timedOut: true,
      error: new Error("deadline"),
    })) as typeof execText;
    await expect(
      setEmulatorLocationAsync(
        "emulator-5554",
        { latitude: 0, longitude: 0 },
        timedOut,
      ),
    ).rejects.toThrow("adb emu geo fix timed out");

    const rejected = (async () => ({
      status: 1,
      signal: null,
      stdout: "KO: bad coordinates\n",
      stderr: "",
      timedOut: false,
      error: null,
    })) as typeof execText;
    await expect(
      setEmulatorLocationAsync(
        "emulator-5554",
        { latitude: 0, longitude: 0 },
        rejected,
      ),
    ).rejects.toThrow("adb emu geo fix failed: KO: bad coordinates");
  });
});
