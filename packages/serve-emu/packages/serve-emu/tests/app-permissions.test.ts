import { describe, expect, test } from "bun:test";
import {
  listPermissions,
  parseRuntimePermissions,
  resetPermissions,
} from "../src/app-permissions.ts";
import { grantPermission, revokePermission } from "../src/app-management.ts";
import { DEFAULT_EXEC_MAX_QUEUED } from "../src/exec.ts";
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

function recordingExec(calls: string[][], stdout = DUMP): typeof execText {
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

const RESET_DUMP = `
      runtime permissions:
        android.permission.CAMERA: granted=false, flags=[ USER_SET]
        android.permission.ACCESS_FINE_LOCATION: granted=true, flags=[ GRANTED_BY_DEFAULT]
        android.permission.RECORD_AUDIO: granted=true, flags=[ USER_SET]
        android.permission.POST_NOTIFICATIONS: granted=false, flags=[ GRANTED_BY_DEFAULT|USER_FIXED]
`;

describe("resetPermissions", () => {
  test("changes only permissions off their default, clears user flags, and resets app ops in one shell", async () => {
    const calls: string[][] = [];
    await resetPermissions("emulator-5554", "com.example.app", {
      execText: recordingExec(calls, RESET_DUMP),
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual([
      "-s",
      "emulator-5554",
      "shell",
      [
        "pm clear-permission-flags com.example.app android.permission.CAMERA user-set user-fixed",
        "pm clear-permission-flags com.example.app android.permission.ACCESS_FINE_LOCATION user-set user-fixed",
        "pm revoke com.example.app android.permission.RECORD_AUDIO",
        "pm clear-permission-flags com.example.app android.permission.RECORD_AUDIO user-set user-fixed",
        "pm grant com.example.app android.permission.POST_NOTIFICATIONS",
        "pm clear-permission-flags com.example.app android.permission.POST_NOTIFICATIONS user-set user-fixed",
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

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("permission request ordering", () => {
  test("readback waits for an unfinished write before a later revoke", async () => {
    const blocked = gate();
    const calls: string[] = [];
    let granted = false;
    const exec: typeof execText = async (_cmd, args) => {
      const action = args[3] === "pm" ? args[4]! : args[3]!;
      calls.push(action);
      if (action === "grant") {
        await blocked.promise;
        granted = true;
      }
      if (action === "revoke") granted = false;
      return recordingExec(
        [],
        `runtime permissions:
  android.permission.CAMERA: granted=${granted}`,
      )(_cmd, args);
    };
    // Dropping the HTTP response does not cancel the server's mutation promise.
    const write = grantPermission(
      "ordered-device",
      "com.example.app",
      "android.permission.CAMERA",
      { execText: exec },
    );
    await Bun.sleep(0);
    const read = listPermissions("ordered-device", "com.example.app", { execText: exec });
    const revoke = revokePermission(
      "ordered-device",
      "com.example.app",
      "android.permission.CAMERA",
      { execText: exec },
    );
    try {
      await Bun.sleep(0);
      expect(calls).toEqual(["grant"]);
    } finally {
      blocked.release();
    }
    await write;
    expect((await read).permissions[0]?.granted).toBe(true);
    await revoke;
    expect(calls).toEqual(["grant", "dumpsys", "revoke"]);
  });

  test("an HTTP disconnect does not let recovery read ahead of native work", async () => {
    const started = gate();
    const blocked = gate();
    let granted = false;
    const deps = {
      execText: (async (cmd, args) => {
        if (args[4] === "grant") {
          started.release();
          await blocked.promise;
          granted = true;
        }
        return recordingExec(
          [],
          `runtime permissions:\n  android.permission.CAMERA: granted=${granted}`,
        )(cmd, args);
      }) as typeof execText,
    };
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const result =
          request.method === "POST"
            ? await grantPermission(
                "http-device",
                "com.example.app",
                "android.permission.CAMERA",
                deps,
              )
            : await listPermissions("http-device", "com.example.app", deps);
        return Response.json(result);
      },
    });
    try {
      const controller = new AbortController();
      const write = fetch(server.url, { method: "POST", signal: controller.signal }).catch(
        () => null,
      );
      await started.promise;
      controller.abort();
      expect(await write).toBeNull();
      let readCompleted = false;
      const recovery = fetch(server.url).then(async (response) => {
        readCompleted = true;
        return response.json();
      });
      await Bun.sleep(10);
      expect(readCompleted).toBe(false);
      blocked.release();
      expect((await recovery).permissions[0].granted).toBe(true);
    } finally {
      blocked.release();
      server.stop(true);
    }
  });

  test("reset holds ownership through its initial list and final mutation", async () => {
    const initialRead = gate();
    const mutation = gate();
    const calls: string[] = [];
    const exec: typeof execText = async (cmd, args) => {
      calls.push(args[3]!);
      if (calls.length === 1) await initialRead.promise;
      else if (args[3]!.startsWith("pm ")) await mutation.promise;
      return recordingExec([], RESET_DUMP)(cmd, args);
    };
    const reset = resetPermissions("reset-device", "com.example.app", { execText: exec });
    await Bun.sleep(0);
    const read = listPermissions("reset-device", "com.example.app", { execText: exec });
    try {
      await Bun.sleep(0);
      expect(calls).toEqual(["dumpsys"]);
      initialRead.release();
      await Bun.sleep(0);
      expect(calls).toHaveLength(2);
      expect(calls[1]).toContain("appops reset");
    } finally {
      initialRead.release();
      mutation.release();
    }
    await Promise.all([reset, read]);
    expect(calls).toHaveLength(3);
    expect(calls[2]).toBe("dumpsys");
  });

  test("failed writes release the queue so a recovery read can complete", async () => {
    const failed = grantPermission(
      "failed-device",
      "com.example.app",
      "android.permission.CAMERA",
      {
        execText: async () => {
          throw new Error("adb unavailable");
        },
      },
    ).catch((error: Error) => error);
    const read = listPermissions("failed-device", "com.example.app", {
      execText: recordingExec([]),
    });
    expect(await failed).toBeInstanceOf(Error);
    expect((await read).ok).toBe(true);
  });

  test("different devices and packages do not wait for each other", async () => {
    const blocked = gate();
    const write = grantPermission(
      "parallel-device",
      "com.example.app",
      "android.permission.CAMERA",
      {
        execText: async (cmd, args) => {
          await blocked.promise;
          return recordingExec([])(cmd, args);
        },
      },
    );
    try {
      const deps = { execText: recordingExec([]) };
      const reads = Promise.all([
        listPermissions("parallel-device", "com.other.app", deps),
        listPermissions("other-device", "com.example.app", deps),
      ]);
      expect(
        await Promise.race([reads.then(() => "read"), Bun.sleep(100).then(() => "timeout")]),
      ).toBe("read");
    } finally {
      blocked.release();
      await write;
    }
  });
  test("rejects overload without retaining slots after completion", async () => {
    const blocked = gate();
    const deps = {
      execText: async (cmd: string, args: string[]) => {
        await blocked.promise;
        return recordingExec([])(cmd, args);
      },
    };
    const writes = Array.from({ length: DEFAULT_EXEC_MAX_QUEUED }, () =>
      grantPermission("capacity-device", "com.example.app", "android.permission.CAMERA", deps),
    );
    try {
      await expect(listPermissions("capacity-device", "com.example.app", deps)).rejects.toThrow(
        "permission request queue is full",
      );
    } finally {
      blocked.release();
      await Promise.all(writes);
    }
    expect(
      (await listPermissions("capacity-device", "com.example.app", { execText: recordingExec([]) }))
        .ok,
    ).toBe(true);
  });
});
