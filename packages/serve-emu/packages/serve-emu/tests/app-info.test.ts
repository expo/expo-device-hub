import { describe, expect, test } from "bun:test";
import { getForegroundApp } from "../src/app-info.ts";
import type { execText } from "../src/exec.ts";

type TextResultOptions = {
  status?: number | null;
  stderr?: string;
  error?: Error | null;
};

function textResult(
  stdout = "",
  { status = 0, stderr = "", error = null }: TextResultOptions = {},
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

function shellCommand(args: string[]): string {
  return args.slice(3).join(" ");
}

describe("getForegroundApp", () => {
  test("reads the focused component, package metadata, and first process id", async () => {
    const calls: Array<{ args: string[]; timeout: number | undefined }> = [];
    const runExec = (async (command, args, options) => {
      expect(command).toBe("adb");
      calls.push({ args, timeout: options?.timeout });
      switch (shellCommand(args)) {
        case "dumpsys window":
          return textResult(
            "mCurrentFocus=Window{42 u0 com.example.app/.MainActivity}",
          );
        case "dumpsys package com.example.app":
          return textResult(`
            versionCode=42 minSdk=23 targetSdk=35
            versionName=1.2.3
            application-label-en:'Example App'
            pkgFlags=[ HAS_CODE DEBUGGABLE ]
          `);
        case "pidof com.example.app":
          return textResult("123 456\n");
        default:
          throw new Error(`unexpected command: ${shellCommand(args)}`);
      }
    }) as typeof execText;

    await expect(getForegroundApp("emulator-5554", runExec)).resolves.toEqual({
      packageName: "com.example.app",
      activity: "com.example.app.MainActivity",
      pid: 123,
      label: "Example App",
      versionName: "1.2.3",
      versionCode: "42",
      minSdk: 23,
      debuggable: true,
    });
    expect(calls).toHaveLength(3);
    expect(calls.every(({ args }) => args.slice(0, 3).join(" ") === "-s emulator-5554 shell")).toBe(true);
    expect(calls.find(({ args }) => shellCommand(args).startsWith("pidof"))?.timeout).toBe(2_000);
    expect(calls.filter(({ args }) => shellCommand(args).startsWith("dumpsys")).map(({ timeout }) => timeout)).toEqual([
      5_000,
      5_000,
    ]);
  });

  test("falls back to resumed activities and non-localized labels", async () => {
    const commands: string[] = [];
    const runExec = (async (_command, args) => {
      const command = shellCommand(args);
      commands.push(command);
      if (command === "dumpsys window") return textResult("mCurrentFocus=null\n");
      if (command === "dumpsys activity activities") {
        return textResult(
          "mResumedActivity: ActivityRecord{abc u0 com.alternate/com.alternate.Home t15}",
        );
      }
      if (command === "dumpsys package com.alternate") {
        return textResult(`
          versionCode=7
          versionName=7.0-beta
          labelRes=0x7f010001 nonLocalizedLabel=Alternate App
          pkgFlags=[ HAS_CODE ]
        `);
      }
      if (command === "pidof com.alternate") return textResult("not-a-pid\n");
      throw new Error(`unexpected command: ${command}`);
    }) as typeof execText;

    await expect(getForegroundApp("device-1", runExec)).resolves.toEqual({
      packageName: "com.alternate",
      activity: "com.alternate.Home",
      pid: null,
      label: "Alternate App",
      versionName: "7.0-beta",
      versionCode: "7",
      minSdk: null,
      debuggable: false,
    });
    expect(commands.slice(0, 2)).toEqual([
      "dumpsys window",
      "dumpsys activity activities",
    ]);
  });

  test("returns an empty snapshot when neither window nor activity dumps identify an app", async () => {
    const commands: string[] = [];
    const runExec = (async (_command, args) => {
      commands.push(shellCommand(args));
      return textResult("no foreground component\n");
    }) as typeof execText;

    await expect(getForegroundApp("device-1", runExec)).resolves.toEqual({
      packageName: null,
      activity: null,
      pid: null,
      label: null,
      versionName: null,
      versionCode: null,
      minSdk: null,
      debuggable: null,
    });
    expect(commands).toEqual([
      "dumpsys window",
      "dumpsys activity activities",
    ]);
  });

  test("keeps foreground identity when optional package and pid probes fail", async () => {
    const runExec = (async (_command, args) => {
      const command = shellCommand(args);
      if (command === "dumpsys window") {
        return textResult(
          "mInputMethodTarget=Window{77 u0 com.example/.KeyboardActivity}",
        );
      }
      return textResult("", {
        status: 1,
        stderr: command.startsWith("pidof") ? "pid unavailable" : "package unavailable",
      });
    }) as typeof execText;

    await expect(getForegroundApp("device-1", runExec)).resolves.toEqual({
      packageName: "com.example",
      activity: "com.example.KeyboardActivity",
      pid: null,
      label: null,
      versionName: null,
      versionCode: null,
      minSdk: null,
      debuggable: null,
    });
  });

  test("supports alternate focus and resumed-activity dump formats", async () => {
    const cases = [
      "mFocusedApp=ActivityRecord{1 u0 com.one/.OneActivity t1}",
      "mInputMethodTarget=Window{1 u0 com.two/.TwoActivity}",
      "topResumedActivity=ActivityRecord{1 u0 com.three/.ThreeActivity t1}",
      "ResumedActivity: ActivityRecord{1 u0 com.four/.FourActivity t1}",
    ];

    for (const dump of cases) {
      const expectedPackage = dump.match(/(com\.[a-z]+)/)?.[1] ?? null;
      const runExec = (async (_command, args) => {
        const command = shellCommand(args);
        if (command === "dumpsys window") {
          return textResult(dump.startsWith("m") ? dump : "no window match");
        }
        if (command === "dumpsys activity activities") return textResult(dump);
        if (command.startsWith("pidof")) return textResult("");
        if (command.startsWith("dumpsys package")) return textResult("");
        throw new Error(`unexpected command: ${command}`);
      }) as typeof execText;

      expect((await getForegroundApp("device-1", runExec)).packageName).toBe(
        expectedPackage,
      );
    }
  });

  test("reports the most useful adb failure message and preserves its cause", async () => {
    const spawnError = new Error("spawn failed");
    const cases = [
      {
        result: textResult("stdout detail", {
          status: 1,
          stderr: " stderr detail ",
          error: spawnError,
        }),
        message: "stderr detail",
        cause: spawnError,
      },
      {
        result: textResult("stdout detail", { status: null, error: spawnError }),
        message: "spawn failed",
        cause: spawnError,
      },
      {
        result: textResult(" stdout detail ", { status: 1 }),
        message: "stdout detail",
        cause: undefined,
      },
      {
        result: textResult("", { status: 1 }),
        message: "adb shell dumpsys window failed",
        cause: undefined,
      },
    ];

    for (const entry of cases) {
      const runExec = (async () => entry.result) as typeof execText;
      try {
        await getForegroundApp("device-1", runExec);
        throw new Error("expected getForegroundApp to reject");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(entry.message);
        expect((error as Error).cause).toBe(entry.cause);
      }
    }
  });
});
