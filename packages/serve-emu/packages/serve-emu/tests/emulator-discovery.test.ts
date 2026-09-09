import { afterEach, describe, expect, test } from "bun:test";
import {
  clearEmulatorResolutionCache,
  resolveEmulator,
  resolveRunningAvds,
} from "../src/emulator.ts";
import type { execText } from "../src/exec.ts";

function result(
  status: number | null,
  stdout = "",
  error: Error | null = null,
) {
  return {
    status,
    signal: null,
    stdout,
    stderr: "",
    timedOut: false,
    error,
  };
}

afterEach(() => clearEmulatorResolutionCache());

describe("emulator discovery", () => {
  test("caches the static PATH probe and keys it by environment", async () => {
    let probes = 0;
    const runExec = (async () => {
      probes++;
      await Promise.resolve();
      return result(0, "Android emulator version\n");
    }) as typeof execText;
    const firstEnvironment = {
      PATH: "/tools/one",
      HOME: "/home/test",
    } as NodeJS.ProcessEnv;

    expect(
      await Promise.all([
        resolveEmulator(undefined, { execText: runExec, env: firstEnvironment }),
        resolveEmulator(undefined, { execText: runExec, env: firstEnvironment }),
      ]),
    ).toEqual(["emulator", "emulator"]);
    expect(await resolveEmulator(undefined, {
      execText: runExec,
      env: firstEnvironment,
    })).toBe("emulator");
    expect(probes).toBe(1);

    expect(
      await resolveEmulator(undefined, {
        execText: runExec,
        env: { ...firstEnvironment, PATH: "/tools/two" },
      }),
    ).toBe("emulator");
    expect(probes).toBe(2);

    expect(await resolveEmulator("/custom/emulator", {
      execText: runExec,
      env: firstEnvironment,
    })).toBe("/custom/emulator");
    expect(probes).toBe(2);

    clearEmulatorResolutionCache();
    expect(
      await resolveEmulator(undefined, {
        execText: runExec,
        env: firstEnvironment,
      }),
    ).toBe("emulator");
    expect(probes).toBe(3);
  });

  test("evicts failed resolutions so an installed emulator can be retried", async () => {
    let probes = 0;
    const runExec = (async () => {
      probes++;
      return result(null, "", new Error("spawn ENOENT"));
    }) as typeof execText;
    const dependencies = {
      execText: runExec,
      existsSync: () => false,
      env: { PATH: "/missing", HOME: "/none" } as NodeJS.ProcessEnv,
    };

    await expect(resolveEmulator(undefined, dependencies)).rejects.toThrow(
      "Could not find Android Emulator",
    );
    await expect(resolveEmulator(undefined, dependencies)).rejects.toThrow(
      "Could not find Android Emulator",
    );
    expect(probes).toBe(2);
  });

  test("resolves running AVD names from a provided device snapshot", async () => {
    const calls: string[][] = [];
    const runExec = (async (_cmd, args) => {
      calls.push(args);
      const serial = args[1];
      const consoleProbe = args.includes("emu");
      if (serial === "emulator-5554") {
        return result(0, "Pixel_A\nOK\n");
      }
      if (consoleProbe) return result(1, "KO: unavailable\n");
      return result(0, "Pixel_B\n");
    }) as typeof execText;

    const running = await resolveRunningAvds(
      [
        { serial: "emulator-5554", state: "device" },
        { serial: "physical-1", state: "device" },
        { serial: "emulator-5556", state: "offline" },
      ],
      runExec,
    );

    expect(running).toEqual([
      { serial: "emulator-5554", avd: "Pixel_A", state: "device" },
      { serial: "emulator-5556", avd: "Pixel_B", state: "offline" },
    ]);
    expect(calls).toHaveLength(3);
    expect(calls.every((args) => args[0] === "-s")).toBe(true);
  });
});
