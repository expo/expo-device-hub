import { describe, expect, test } from "bun:test";
import { DEFAULT_EXEC_MAX_QUEUED, ExecError, type ExecClock } from "../src/exec.ts";
import {
  grantPermission,
  revokePermission,
  type AppManagementDependencies,
} from "../src/app-management.ts";
import { listPermissions, resetPermissions } from "../src/app-permissions.ts";
import { createPermissionRequestQueue } from "../src/permission-requests.ts";

class ManualClock implements ExecClock {
  nowMs = 0;
  timers: Array<{ callback: () => void; active: boolean; due: number }> = [];
  now() {
    return this.nowMs;
  }
  setTimeout(callback: () => void, delayMs: number) {
    const timer = { callback, active: true, due: this.nowMs + delayMs };
    this.timers.push(timer);
    return timer;
  }
  clearTimeout(timer: unknown) {
    (timer as { active: boolean }).active = false;
  }
  advance(ms: number) {
    this.nowMs += ms;
    for (const timer of this.timers) {
      if (!timer.active || timer.due > this.nowMs) continue;
      timer.active = false;
      timer.callback();
    }
  }
  fire(index: number) {
    const timer = this.timers[index]!;
    if (!timer.active) throw new Error("timer is no longer active");
    timer.active = false;
    timer.callback();
  }
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("permission request queue", () => {
  test("an early wait timer irrevocably expires a queued write and preserves its barrier", async () => {
    const clock = new ManualClock();
    const run = createPermissionRequestQueue(clock);
    const blocked = gate();
    const calls: string[] = [];
    const active = run("device", "app", async () => {
      calls.push("active");
      await blocked.promise;
    });
    await flush();
    const queued = run("device", "app", async () => {
      calls.push("expired");
    }).catch((e: unknown) => e);
    clock.nowMs = 9_999.5;
    clock.fire(1);
    const error = await queued;
    expect(error).toBeInstanceOf(ExecError);
    expect((error as ExecError).code).toBe("deadline-exceeded");
    const recovery = run("device", "app", async () => {
      calls.push("read");
    });
    await flush();
    expect(calls).toEqual(["active"]);
    blocked.release();
    await Promise.all([active, recovery]);
    expect(calls).toEqual(["active", "read"]);
    await run("device", "app", async () => {
      calls.push("next");
    });
    expect(calls.at(-1)).toBe("next");
  });

  test("a delayed timer cannot admit a write after its deadline", async () => {
    const clock = new ManualClock();
    const run = createPermissionRequestQueue(clock);
    const blocked = gate();
    const active = run("device", "app", () => blocked.promise);
    await flush();
    let ran = false;
    const queued = run("device", "app", async () => {
      ran = true;
    }).catch((e: unknown) => e);
    clock.nowMs = 10_001;
    blocked.release();
    await active;
    expect(((await queued) as ExecError).code).toBe("deadline-exceeded");
    expect(ran).toBe(false);
  });

  test("a started write outlives the waiting deadline and releases a failed tail", async () => {
    const clock = new ManualClock();
    const run = createPermissionRequestQueue(clock);
    const blocked = gate();
    const active = run("device", "app", async () => {
      await blocked.promise;
      throw new Error("write failed");
    }).catch((e: unknown) => e);
    await flush();
    clock.nowMs = 15_000;
    expect(clock.timers[0]!.active).toBe(false);
    blocked.release();
    expect(((await active) as Error).message).toBe("write failed");
    expect(await run("device", "app", async () => "read")).toBe("read");
  });

  test("expired callers retain bounded slots until the active operation finishes", async () => {
    const clock = new ManualClock();
    const run = createPermissionRequestQueue(clock);
    const blocked = gate();
    const active = run("device", "app", () => blocked.promise);
    await flush();
    const queued = Array.from({ length: DEFAULT_EXEC_MAX_QUEUED - 1 }, () =>
      run("device", "app", async () => {
        throw new Error("expired operation ran");
      }).catch((e: unknown) => e),
    );
    for (let i = 1; i < DEFAULT_EXEC_MAX_QUEUED; i++) clock.fire(i);
    expect((await Promise.all(queued)).every((e) => e instanceof ExecError)).toBe(true);
    await expect(run("other", "app", async () => {})).rejects.toThrow("queue is full");
    blocked.release();
    await active;
    await flush();
    expect(await run("device", "app", async () => "available")).toBe("available");
  });
});

test("queued reads keep their bounded slots while waiting beyond ten seconds for a mutation", async () => {
  const clock = new ManualClock();
  const run = createPermissionRequestQueue(clock);
  const blocked = gate();
  const active = run("device", "app", () => blocked.promise);
  await flush();
  let reads = 0;
  const waiting = Array.from({ length: DEFAULT_EXEC_MAX_QUEUED - 1 }, () =>
    run(
      "device",
      "app",
      async () => {
        reads++;
      },
      "read",
    ),
  );
  clock.nowMs = 15_000;
  expect(clock.timers).toHaveLength(1); // Only the mutation had a wait timer; it cleared on admission.
  expect(clock.timers[0]!.active).toBe(false);
  expect(reads).toBe(0);
  await expect(run("other", "app", async () => {})).rejects.toThrow("queue is full");
  blocked.release();
  await Promise.all([active, ...waiting]);
  expect(reads).toBe(DEFAULT_EXEC_MAX_QUEUED - 1);
  expect(await run("device", "app", async () => "available", "read")).toBe("available");
});

test("production permission lists wait for earlier work without a mutation deadline", async () => {
  const clock = new ManualClock();
  const run = createPermissionRequestQueue(clock);
  const blocked = gate();
  const active = run("device", "com.example.app", () => blocked.promise);
  await flush();
  let calls = 0;
  const dependencies: AppManagementDependencies = {
    runPermissionRequest: run,
    execText: async () => {
      calls++;
      return { status: 0, signal: null, stdout: "", stderr: "", timedOut: false, error: null };
    },
  };
  let result: unknown;
  const read = listPermissions("device", "com.example.app", dependencies).then(
    (value) => {
      result = value;
    },
    (error) => {
      result = error;
    },
  );
  try {
    clock.advance(15_000);
    await flush();
    expect(result).toBeUndefined();
    expect(calls).toBe(0);
  } finally {
    blocked.release();
    await Promise.all([active, read]);
  }
  expect(result).toMatchObject({ ok: true, permissions: [] });
  expect(calls).toBe(1);
});

test.each(["grant", "revoke", "reset"] as const)(
  "production %s expires while queued and never runs later",
  async (action) => {
    const clock = new ManualClock();
    const run = createPermissionRequestQueue(clock);
    const blocked = gate();
    const active = run("device", "com.example.app", () => blocked.promise);
    await flush();
    let calls = 0;
    const dependencies: AppManagementDependencies = {
      runPermissionRequest: run,
      execText: async () => {
        calls++;
        return { status: 0, signal: null, stdout: "", stderr: "", timedOut: false, error: null };
      },
    };
    let result: unknown;
    const mutation =
      action === "reset"
        ? resetPermissions("device", "com.example.app", dependencies)
        : (action === "grant" ? grantPermission : revokePermission)(
            "device",
            "com.example.app",
            "android.permission.CAMERA",
            dependencies,
          );
    const settled = mutation.then(
      (value) => {
        result = value;
      },
      (error) => {
        result = error;
      },
    );
    try {
      clock.advance(10_001);
      await flush();
      expect(result).toBeInstanceOf(ExecError);
      expect((result as ExecError).code).toBe("deadline-exceeded");
      expect(calls).toBe(0);
    } finally {
      blocked.release();
      await Promise.all([active, settled]);
    }
    expect(calls).toBe(0);
  },
);
