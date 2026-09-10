import { describe, expect, test } from "bun:test";
import {
  listPermissions,
  parseRuntimePermissions,
  resetPermissions,
} from "../src/app-permissions.ts";
import type { ExecOpts, ExecResult, execText } from "../src/exec.ts";

const DUMP = `
    install permissions:
      android.permission.INTERNET: granted=true
    User 0: ceDataInode=0 installed=true
      runtime permissions:
        android.permission.CAMERA: granted=false, flags=[ USER_SENSITIVE_WHEN_GRANTED|USER_SENSITIVE_WHEN_DENIED]
        android.permission.ACCESS_FINE_LOCATION: granted=true, flags=[ GRANTED_BY_DEFAULT|USER_SENSITIVE_WHEN_GRANTED]
      enabledComponents:
        org.example.Widget

      runtime permissions:
        android.permission.CAMERA: granted=true, flags=[ USER_SET]
`;

function recordingExec(
  calls: string[][],
  stdout = DUMP,
): typeof execText {
  return async (_cmd, args, _opts: ExecOpts = {}) => {
    calls.push(args);
    const result: ExecResult<string> = {
      status: 0,
      signal: null,
      stdout,
      stderr: "",
      timedOut: false,
      error: null,
    };
    return result;
  };
}

describe("runtime permission parsing", () => {
  test("reads only the runtime block and keeps the first entry per name", () => {
    expect(parseRuntimePermissions(DUMP)).toEqual([
      {
        name: "android.permission.CAMERA",
        granted: false,
        flags: ["USER_SENSITIVE_WHEN_GRANTED", "USER_SENSITIVE_WHEN_DENIED"],
      },
      {
        name: "android.permission.ACCESS_FINE_LOCATION",
        granted: true,
        flags: ["GRANTED_BY_DEFAULT", "USER_SENSITIVE_WHEN_GRANTED"],
      },
    ]);
  });

  test("returns no permissions when the block is absent", () => {
    expect(parseRuntimePermissions("Packages:\n  Package [x]\n")).toEqual([]);
  });
});

describe("listPermissions", () => {
  test("dumps the validated package and parses the result", async () => {
    const calls: string[][] = [];
    const result = await listPermissions("emulator-5554", " com.example.app ", {
      execText: recordingExec(calls),
    });
    expect(calls).toEqual([
      ["-s", "emulator-5554", "shell", "dumpsys", "package", "com.example.app"],
    ]);
    expect(result.packageName).toBe("com.example.app");
    expect(result.permissions.map((permission) => permission.name)).toEqual([
      "android.permission.CAMERA",
      "android.permission.ACCESS_FINE_LOCATION",
    ]);
  });

  test("rejects an invalid package name before running adb", async () => {
    const calls: string[][] = [];
    await expect(
      listPermissions("emulator-5554", "bad name", { execText: recordingExec(calls) }),
    ).rejects.toThrow("packageName is invalid");
    expect(calls).toEqual([]);
  });
});

describe("resetPermissions", () => {
  test("restores manifest defaults, clears user flags, and resets app ops in one shell", async () => {
    const calls: string[][] = [];
    await resetPermissions("emulator-5554", "com.example.app", {
      execText: recordingExec(calls),
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual([
      "-s",
      "emulator-5554",
      "shell",
      [
        "pm revoke com.example.app android.permission.CAMERA",
        "pm clear-permission-flags com.example.app android.permission.CAMERA user-set user-fixed",
        "pm grant com.example.app android.permission.ACCESS_FINE_LOCATION",
        "pm clear-permission-flags com.example.app android.permission.ACCESS_FINE_LOCATION user-set user-fixed",
        "appops reset com.example.app",
      ]
        .map((command) => `${command} || echo 'PERMISSION_RESET_FAILED: ${command}'`)
        .join("; "),
    ]);
  });

  test("fails when any command in the chain fails", async () => {
    const calls: string[][] = [];
    const list = recordingExec(calls);
    const chain = recordingExec(
      calls,
      "PERMISSION_RESET_FAILED: pm revoke com.example.app android.permission.CAMERA\n",
    );
    const execText: typeof list = (cmd, args, opts) =>
      (calls.length === 0 ? list : chain)(cmd, args, opts);
    await expect(
      resetPermissions("emulator-5554", "com.example.app", { execText }),
    ).rejects.toThrow("pm revoke com.example.app android.permission.CAMERA");
  });
});
