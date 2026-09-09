import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess, spawn } from "node:child_process";
import {
  clearEmulatorResolutionCache,
  listAvds,
  listRunningAvds,
  resolveEmulator,
  resolveRunningAvds,
  startEmulator,
  stopEmulator,
  type EmulatorRuntimeDependencies,
} from "../src/emulator.ts";
import type { execText } from "../src/exec.ts";

type ResultOptions = {
  status?: number | null;
  stderr?: string;
  error?: Error | null;
};

function result(
  stdout = "",
  { status = 0, stderr = "", error = null }: ResultOptions = {},
) {
  return {
    status,
    signal: null,
    stdout,
    stderr,
    timedOut: false,
    error,
  };
}

function fakeProcess(options: {
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
  throwOnKill?: boolean;
} = {}) {
  const killSignals: Array<NodeJS.Signals | number | undefined> = [];
  const proc = Object.assign(new EventEmitter(), {
    exitCode: options.exitCode ?? null,
    signalCode: options.signalCode ?? null,
    kill(signal?: NodeJS.Signals | number) {
      killSignals.push(signal);
      if (options.throwOnKill) throw new Error("kill failed");
      return true;
    },
  }) as unknown as ChildProcess;
  return { proc, killSignals };
}

function spawnWith(proc: ChildProcess, calls: unknown[][] = []) {
  return ((command: string, args: string[], options: unknown) => {
    calls.push([command, args, options]);
    return proc;
  }) as unknown as typeof spawn;
}

afterEach(() => clearEmulatorResolutionCache());

describe("emulator resolution and listing", () => {
  test("accepts an EPIPE PATH probe and searches unique SDK candidates in order", async () => {
    const epipe = (async () =>
      result("", { status: null, error: new Error("write EPIPE") })) as typeof execText;
    await expect(
      resolveEmulator(undefined, {
        execText: epipe,
        env: { PATH: "/bin" } as NodeJS.ProcessEnv,
      }),
    ).resolves.toBe("emulator");

    clearEmulatorResolutionCache();
    const checked: string[] = [];
    const missing = (async () =>
      result("", { status: null, error: new Error("ENOENT") })) as typeof execText;
    await expect(
      resolveEmulator(undefined, {
        execText: missing,
        env: {
          PATH: "/bin",
          ANDROID_HOME: "/sdk",
          ANDROID_SDK_ROOT: "/sdk",
          HOME: "/home/test",
        } as NodeJS.ProcessEnv,
        existsSync: (candidate) => {
          checked.push(candidate.toString());
          return candidate === "/sdk/tools/emulator";
        },
      }),
    ).resolves.toBe("/sdk/tools/emulator");
    expect(checked).toEqual([
      "/sdk/emulator/emulator",
      "/sdk/tools/emulator",
    ]);
  });

  test("lists trimmed AVD names and surfaces every useful failure detail", async () => {
    const calls: unknown[][] = [];
    const successful = (async (command, args, options) => {
      calls.push([command, args, options]);
      return result(" Pixel_8 \r\n\r\nTablet\n");
    }) as typeof execText;
    await expect(
      listAvds("/sdk/emulator", { execText: successful }),
    ).resolves.toEqual(["Pixel_8", "Tablet"]);
    expect(calls).toEqual([
      [
        "/sdk/emulator",
        ["-list-avds"],
        { timeout: 5_000, maxBuffer: 1024 * 1024 },
      ],
    ]);

    const processError = new Error("spawn failed");
    const failures = [
      [result("stdout", { status: 1, stderr: "stderr" }), "stderr"],
      [result("stdout", { status: null, error: processError }), "spawn failed"],
      [result(" stdout ", { status: 1 }), "stdout"],
      [result("", { status: 1 }), "unknown error"],
    ] as const;
    for (const [failedResult, detail] of failures) {
      const failed = (async () => failedResult) as typeof execText;
      await expect(
        listAvds("/sdk/emulator", { execText: failed }),
      ).rejects.toThrow(`emulator -list-avds failed: ${detail}`);
    }
  });

  test("omits emulators whose console and boot property expose no AVD name", async () => {
    const runExec = (async (_command, args) =>
      args.includes("emu")
        ? result("OK\nKO: unavailable\n")
        : result("   \n")) as typeof execText;
    const devices = [
      { serial: "physical-1", state: "device" },
      { serial: "emulator-5554", state: "offline" },
    ];
    await expect(resolveRunningAvds(devices, runExec)).resolves.toEqual([]);
    await expect(
      listRunningAvds(undefined, {
        execText: runExec,
        listAllDevices: async () => devices,
      }),
    ).resolves.toEqual([]);
  });
});

describe("emulator lifecycle", () => {
  test("reuses an already-running matching AVD without spawning a process", async () => {
    const runExec = (async (command, args) => {
      if (command === "/sdk/emulator") return result("Pixel_8\n");
      if (args.includes("emu")) return result("Pixel_8\nOK\n");
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    }) as typeof execText;
    let spawns = 0;
    const dependencies: EmulatorRuntimeDependencies = {
      execText: runExec,
      listAllDevices: async () => [
        { serial: "emulator-5554", state: "device" },
      ],
      spawn: (() => {
        spawns++;
        throw new Error("should not spawn");
      }) as unknown as typeof spawn,
    };

    const launch = await startEmulator(
      { avd: "@Pixel_8", emulatorPath: "/sdk/emulator" },
      dependencies,
    );
    expect(launch.serial).toBe("emulator-5554");
    expect(launch.proc).toBeNull();
    expect(launch.ownsProcess).toBe(false);
    launch.stop();
    expect(spawns).toBe(0);
  });

  test("chooses a free even port, boots with GPU arguments, and stops idempotently", async () => {
    const adbCalls: string[] = [];
    const runExec = (async (command, args) => {
      if (command === "/sdk/emulator") return result("Pixel_8\n");
      const adbCommand = args.slice(2).join(" ");
      adbCalls.push(adbCommand);
      if (adbCommand === "get-state") return result("device\n");
      if (adbCommand === "shell getprop sys.boot_completed") return result("1\n");
      if (adbCommand === "emu kill") return result("");
      throw new Error(`unexpected adb command: ${adbCommand}`);
    }) as typeof execText;
    let deviceReads = 0;
    const readDevices = async () => {
      deviceReads++;
      return deviceReads === 1
        ? [{ serial: "physical-1", state: "device" }]
        : [
            { serial: "emulator-5554", state: "device" },
            { serial: "emulator-5556", state: "offline" },
          ];
    };
    const { proc, killSignals } = fakeProcess();
    const spawnCalls: unknown[][] = [];
    const launch = await startEmulator(
      { avd: "Pixel_8", emulatorPath: "/sdk/emulator", gpu: "host" },
      {
        execText: runExec,
        listAllDevices: readDevices,
        spawn: spawnWith(proc, spawnCalls),
      },
    );

    expect(launch.serial).toBe("emulator-5558");
    expect(launch.proc).toBe(proc);
    expect(launch.ownsProcess).toBe(true);
    expect(spawnCalls).toEqual([
      [
        "/sdk/emulator",
        ["@Pixel_8", "-port", "5558", "-gpu", "host"],
        { stdio: ["ignore", "inherit", "inherit"] },
      ],
    ]);
    launch.stop();
    launch.stop();
    await Promise.resolve();
    expect(adbCalls.filter((call) => call === "emu kill")).toHaveLength(1);
    expect(killSignals).toEqual(["SIGTERM"]);
  });

  test("restarts an existing AVD after it exits", async () => {
    const commands: string[] = [];
    const runExec = (async (command, args) => {
      if (command === "/sdk/emulator") return result("Pixel_8\n");
      const adbCommand = args.slice(2).join(" ");
      commands.push(`${args[1]} ${adbCommand}`);
      if (adbCommand === "emu avd name") return result("Pixel_8\nOK\n");
      if (adbCommand === "emu kill") return result("");
      if (adbCommand === "get-state") return result("device\n");
      if (adbCommand === "shell getprop sys.boot_completed") return result("1\n");
      throw new Error(`unexpected adb command: ${adbCommand}`);
    }) as typeof execText;
    let deviceReads = 0;
    const { proc } = fakeProcess();
    const launch = await startEmulator(
      {
        avd: "Pixel_8",
        emulatorPath: "/sdk/emulator",
        port: 5560,
        restartAvd: true,
      },
      {
        execText: runExec,
        listAllDevices: async () => {
          deviceReads++;
          return deviceReads === 1
            ? [{ serial: "emulator-5554", state: "device" }]
            : [];
        },
        spawn: spawnWith(proc),
      },
    );
    expect(launch.serial).toBe("emulator-5560");
    expect(commands).toContain("emulator-5554 emu kill");
    expect(deviceReads).toBe(2);
  });

  test("does not spawn a replacement while the old emulator is still registered", async () => {
    const runExec = (async (command, args) => {
      if (command === "/sdk/emulator") return result("Pixel_8\n");
      if (args.includes("name")) return result("Pixel_8\nOK\n");
      return result("");
    }) as typeof execText;
    let now = 0;
    let spawns = 0;

    await expect(
      startEmulator(
        {
          avd: "Pixel_8",
          emulatorPath: "/sdk/emulator",
          restartAvd: true,
        },
        {
          execText: runExec,
          listAllDevices: async () => [
            { serial: "emulator-5554", state: "device" },
          ],
          now: () => now,
          sleep: async (delay) => {
            now += delay;
          },
          spawn: (() => {
            spawns++;
            throw new Error("should not spawn");
          }) as unknown as typeof spawn,
        },
      ),
    ).rejects.toThrow("Timed out waiting for emulator-5554 to stop.");
    expect(spawns).toBe(0);
  });

  test("rejects unknown AVDs, invalid ports, and exhausted port ranges", async () => {
    const listOnly = (async (command) =>
      command === "/sdk/emulator" ? result("Pixel_8\n") : result("")) as typeof execText;
    await expect(
      startEmulator(
        { avd: "Missing", emulatorPath: "/sdk/emulator" },
        { execText: listOnly },
      ),
    ).rejects.toThrow('Unknown AVD "Missing". Available AVDs: Pixel_8');

    const emptyList = (async () => result("\n")) as typeof execText;
    await expect(
      startEmulator(
        { avd: "Missing", emulatorPath: "/sdk/emulator" },
        { execText: emptyList },
      ),
    ).rejects.toThrow('Available AVDs: (none)');

    for (const port of [5553, 5555, 5684, 5554.5]) {
      await expect(
        startEmulator(
          { avd: "Pixel_8", emulatorPath: "/sdk/emulator", port },
          {
            execText: listOnly,
            listAllDevices: async () => [],
          },
        ),
      ).rejects.toThrow(
        "--emulator-port must be an even integer from 5554 through 5682.",
      );
    }

    let deviceReads = 0;
    await expect(
      startEmulator(
        { avd: "Pixel_8", emulatorPath: "/sdk/emulator" },
        {
          execText: listOnly,
          listAllDevices: async () => {
            deviceReads++;
            return deviceReads === 1
              ? []
              : Array.from({ length: 65 }, (_, index) => ({
                  serial: `emulator-${5554 + index * 2}`,
                  state: "device",
                }));
          },
        },
      ),
    ).rejects.toThrow("No available emulator console ports");
  });

  test("cleans up when boot times out or the emulator exits early", async () => {
    const runFailure = async (proc: ChildProcess, runExec: typeof execText) => {
      let now = 0;
      return startEmulator(
        {
          avd: "Pixel_8",
          emulatorPath: "/sdk/emulator",
          port: 5554,
          bootTimeoutMs: 2,
        },
        {
          execText: runExec,
          listAllDevices: async () => [],
          spawn: spawnWith(proc),
          now: () => now,
          sleep: async (delay) => {
            now += delay;
          },
        },
      );
    };

    const timeoutProcess = fakeProcess();
    const timeoutExec = (async (command, args) => {
      if (command === "/sdk/emulator") return result("Pixel_8\n");
      if (args.includes("get-state")) return result("offline\n");
      return result("", { status: 1 });
    }) as typeof execText;
    await expect(runFailure(timeoutProcess.proc, timeoutExec)).rejects.toThrow(
      "Timed out waiting for emulator-5554 to boot.",
    );
    expect(timeoutProcess.killSignals).toEqual(["SIGTERM"]);

    const exitedProcess = fakeProcess({ exitCode: 9, throwOnKill: true });
    const exitExec = (async (command) =>
      command === "/sdk/emulator"
        ? result("Pixel_8\n")
        : result("", { status: 1 })) as typeof execText;
    await expect(runFailure(exitedProcess.proc, exitExec)).rejects.toThrow(
      "emulator exited before boot completed (code 9)",
    );
  });

  test("reports stop failures", async () => {
    const successful = (async () => result("")) as typeof execText;
    await expect(stopEmulator("emulator-5554", successful)).resolves.toBeUndefined();

    const failed = (async () =>
      result("", { status: 1, stderr: "console unavailable" })) as typeof execText;
    await expect(stopEmulator("emulator-5554", failed)).rejects.toThrow(
      "Failed to stop emulator-5554: console unavailable",
    );
  });
});
