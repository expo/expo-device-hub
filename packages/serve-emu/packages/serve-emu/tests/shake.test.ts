import { describe, expect, test } from "bun:test";
import type { ExecResult, execText } from "../src/exec.ts";
import {
  SHAKE_ACCELERATION,
  SHAKE_EMULATOR_ONLY_MESSAGE,
  SHAKE_INTERVAL_MS,
  SHAKE_WRITES,
  ShakeUnsupportedError,
  shakeEmulator,
} from "../src/shake.ts";

function result(stdout: string, status = 0): ExecResult<string> {
  return { status, stdout, stderr: "", signal: null, timedOut: false, error: null };
}

type Call = { args: string[]; lane: string | undefined };

/** A console that answers `sensor get acceleration` with `rest` and accepts every write. */
function fakeConsole(
  rest = "0:9.77631:0.812349",
  answer: (args: string[]) => ExecResult<string> | undefined = () => undefined,
) {
  const calls: Call[] = [];
  const runExec = (async (_cmd: string, args: string[], opts?: { lane?: string }) => {
    calls.push({ args, lane: opts?.lane });
    const custom = answer(args);
    if (custom) return custom;
    if (args.includes("get")) return result(`acceleration = ${rest}\r\nOK\r\n`);
    return result("OK\r\n");
  }) as unknown as typeof execText;
  return { calls, runExec };
}

/** The values written with `sensor set acceleration`, in order. */
function writes(calls: Call[]): string[] {
  return calls
    .filter((call) => call.args.includes("set"))
    .map((call) => call.args[call.args.length - 1]!);
}

const noWait = async () => {};

describe("shakeEmulator", () => {
  test("alternates the x acceleration around the resting y and z, then restores the resting value", async () => {
    const { calls, runExec } = fakeConsole();
    const waits: number[] = [];

    await shakeEmulator("emulator-5554", runExec, async (ms) => {
      waits.push(ms);
    });

    expect(calls[0]!.args).toEqual(["-s", "emulator-5554", "emu", "sensor", "get", "acceleration"]);
    const plus = String(SHAKE_ACCELERATION);
    const minus = String(-SHAKE_ACCELERATION);
    expect(writes(calls)).toEqual([
      `${plus}:9.77631:0.812349`,
      `${minus}:9.77631:0.812349`,
      `${plus}:9.77631:0.812349`,
      `${minus}:9.77631:0.812349`,
      `${plus}:9.77631:0.812349`,
      "0:9.77631:0.812349",
    ]);
    expect(SHAKE_WRITES).toBe(5);
    expect(waits).toEqual(Array(SHAKE_WRITES).fill(SHAKE_INTERVAL_MS));
    expect(calls.every((call) => call.lane === "interactive")).toBe(true);
    // Each detector needs more than 1.33 g on one axis.
    expect(SHAKE_ACCELERATION).toBeGreaterThan(9.80665 * 1.33);
  });

  test("restores the exact resting tokens, including exponent notation", async () => {
    const { calls, runExec } = fakeConsole("-9.81:1e-05:0");

    await shakeEmulator("emulator-5556", runExec, noWait);

    expect(writes(calls).at(-1)).toBe("-9.81:1e-05:0");
  });

  test("refuses a physical device without running adb", async () => {
    const { calls, runExec } = fakeConsole();

    const shake = shakeEmulator("R58M123ABC", runExec, noWait);

    await expect(shake).rejects.toBeInstanceOf(ShakeUnsupportedError);
    await expect(shake).rejects.toThrow(SHAKE_EMULATOR_ONLY_MESSAGE);
    expect(calls).toEqual([]);
  });

  test("fails clearly when the resting value cannot be parsed, and writes nothing", async () => {
    const { calls, runExec } = fakeConsole("not-a-vector");

    await expect(shakeEmulator("emulator-5558", runExec, noWait)).rejects.toThrow(
      /unexpected acceleration response/i,
    );
    expect(writes(calls)).toEqual([]);
  });

  test("fails when the console refuses the read", async () => {
    const { calls, runExec } = fakeConsole(undefined, (args) =>
      args.includes("get") ? result("KO: unknown sensor name: acceleration\r\n") : undefined,
    );

    await expect(shakeEmulator("emulator-5560", runExec, noWait)).rejects.toThrow(
      /unknown sensor name/,
    );
    expect(writes(calls)).toEqual([]);
  });

  test("restores the resting value after a refused burst write and reports the write", async () => {
    let setCalls = 0;
    const { calls, runExec } = fakeConsole(undefined, (args) => {
      if (!args.includes("set")) return undefined;
      setCalls += 1;
      return setCalls === 2 ? result("KO: bad value\r\n") : undefined;
    });

    await expect(shakeEmulator("emulator-5562", runExec, noWait)).rejects.toThrow(/bad value/);
    expect(writes(calls).at(-1)).toBe("0:9.77631:0.812349");
    expect(writes(calls)).toHaveLength(3);
  });

  test("reports a failed restore", async () => {
    const { runExec } = fakeConsole(undefined, (args) =>
      args.at(-1) === "0:9.77631:0.812349" ? result("", 1) : undefined,
    );

    await expect(shakeEmulator("emulator-5564", runExec, noWait)).rejects.toThrow(/restore/i);
  });

  test("reports both errors when the burst and the restore fail", async () => {
    const { runExec } = fakeConsole(undefined, (args) =>
      args.includes("set") ? result("KO: console gone\r\n") : undefined,
    );

    const error = await shakeEmulator("emulator-5566", runExec, noWait).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/console gone/);
    expect((error as Error).message).toMatch(/restor/i);
  });

  test("a request during a running shake joins it instead of starting another burst", async () => {
    const { calls, runExec } = fakeConsole();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstWait = true;
    const wait = async () => {
      if (firstWait) {
        firstWait = false;
        await gate;
      }
    };

    const first = shakeEmulator("emulator-5568", runExec, wait);
    const second = shakeEmulator("emulator-5568", runExec, wait);
    expect(second).toBe(first);
    release();
    await Promise.all([first, second]);

    expect(calls.filter((call) => call.args.includes("get"))).toHaveLength(1);
    expect(writes(calls)).toHaveLength(SHAKE_WRITES + 1);

    // A later request starts its own shake.
    await shakeEmulator("emulator-5568", runExec, noWait);
    expect(calls.filter((call) => call.args.includes("get"))).toHaveLength(2);
  });

  test("a failed shake does not block the next one", async () => {
    let fail = true;
    const { calls, runExec } = fakeConsole(undefined, (args) =>
      fail && args.includes("get") ? result("", 1) : undefined,
    );

    await expect(shakeEmulator("emulator-5570", runExec, noWait)).rejects.toThrow();
    fail = false;
    await shakeEmulator("emulator-5570", runExec, noWait);
    expect(writes(calls)).toHaveLength(SHAKE_WRITES + 1);
  });
});
