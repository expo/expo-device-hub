import { expect, test, spyOn } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHostActionAsync } from "../host-actions";
import { withActionTimeoutAsync } from "./helpers";

// Advance only queue-wait timers; real subprocess startup and completion stay real.
function waitTimers() {
  const set = globalThis.setTimeout;
  const clear = globalThis.clearTimeout;
  const pending = new Map<unknown, () => void>();
  const schedule = spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    const timer = set(callback, delay, ...args);
    if (delay === 10_000) pending.set(timer, callback as () => void);
    return timer;
  }) as typeof setTimeout);
  const cancel = spyOn(globalThis, "clearTimeout").mockImplementation((timer) => {
    pending.delete(timer!);
    clear(timer as ReturnType<typeof setTimeout>);
  });
  return {
    pending,
    restore() {
      schedule.mockRestore();
      cancel.mockRestore();
    },
  };
}

async function eventually(check: () => boolean) {
  for (let attempt = 0; attempt < 300 && !check(); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(check()).toBe(true);
}

test("an expired queued write never runs, while a read still waits for the active write", async () => {
  const timers = waitTimers();
  const directory = mkdtempSync(join(tmpdir(), "permission-wait-"));
  const script = join(directory, "serve-sim.js");
  cpSync(join(import.meta.dir, "fixtures/permission-order.child.cjs"), script);
  const params = { udid: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", bundleId: "test.expiry" };
  const events = join(directory, "events");
  const reset = runHostActionAsync({ action: "permissions.resetAll", params }, script);
  let grant: Promise<unknown> | undefined;
  let read: Promise<unknown> | undefined;
  try {
    await eventually(() => existsSync(events));
    expect(timers.pending.size).toBe(0); // A started write has no queue-wait timer.
    grant = runHostActionAsync(
      { action: "permissions.set", params: { ...params, action: "grant", service: "camera" } },
      script,
    );
    const outcome = grant.then(
      () => null,
      (error: Error) => error,
    );
    let readFinished = false;
    read = runHostActionAsync({ action: "permissions.list", params }, script).then(() => {
      readFinished = true;
    });
    expect(timers.pending.size).toBe(1); // Reads have no queue-wait deadline.
    for (const expire of timers.pending.values()) expire(); // Includes an early timer firing.
    expect((await outcome)?.message).toContain("it was not started");
    expect(readFinished).toBe(false);
    expect(readFileSync(events, "utf8").trim()).toBe("reset");
    writeFileSync(join(directory, "release"), "");
    await Promise.all([reset, read]);
    expect(readFileSync(events, "utf8").trim().split("\n")).toEqual(["reset", "list"]);
    expect(timers.pending.size).toBe(0);
  } finally {
    writeFileSync(join(directory, "release"), "");
    await Promise.allSettled([reset, grant, read]);
    timers.restore();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a write that expires during name resolution never starts after resolution completes", async () => {
  const device = await import("../device");
  const directory = mkdtempSync(join(tmpdir(), "permission-alias-expiry-"));
  const script = join(directory, "serve-sim.js");
  cpSync(join(import.meta.dir, "fixtures/permission-order.child.cjs"), script);
  let entered = false;
  let resolveName!: (udid: string) => void;
  const identity = new Promise<string>((resolve) => {
    resolveName = resolve;
  });
  const lookup = spyOn(device, "resolveBootedDeviceAsync").mockImplementation(() => {
    entered = true;
    return identity;
  });
  const timers = waitTimers();
  const request = runHostActionAsync(
    { action: "permissions.resetAll", params: { udid: "slow name", bundleId: "test.expiry" } },
    script,
  );
  let read: Promise<unknown> | undefined;
  try {
    const outcome = request.then(
      () => null,
      (error: Error) => error,
    );
    await eventually(() => entered);
    for (const expire of timers.pending.values()) expire();
    expect((await outcome)?.message).toContain("it was not started");
    resolveName("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE");
    read = runHostActionAsync(
      {
        action: "permissions.list",
        params: { udid: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", bundleId: "test.expiry" },
      },
      script,
    );
    await eventually(() => existsSync(join(directory, "events")));
    expect(readFileSync(join(directory, "events"), "utf8").trim()).toBe("list");
    await read;
    expect(timers.pending.size).toBe(0);
  } finally {
    resolveName("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE");
    lookup.mockRestore();
    timers.restore();
    // Unblock a reset if a regression allowed it to run.
    writeFileSync(join(directory, "release"), "");
    await Promise.allSettled([request, read]);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a queued write checks elapsed time even when its wait timer is delayed", async () => {
  const device = await import("../device");
  let admit!: (udid: string) => void;
  const identity = new Promise<string>((resolve) => {
    admit = resolve;
  });
  const lookup = spyOn(device, "resolveBootedDeviceAsync").mockReturnValue(identity);
  let now = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  try {
    const request = runHostActionAsync(
      {
        action: "permissions.resetAll",
        params: {
          udid: "slow name",
          bundleId: "test.late-timer",
        },
      },
      "missing-command-that-must-not-run",
    );
    const outcome = request.then(
      () => null,
      (error: Error) => error,
    );
    now = 10_001;
    admit("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE");
    expect((await outcome)?.message).toContain("it was not started");
  } finally {
    admit("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE");
    lookup.mockRestore();
    clock.mockRestore();
  }
});

test("a CLI execution timeout releases its queue for the next permission write", async () => {
  const directory = mkdtempSync(join(tmpdir(), "permission-execution-timeout-"));
  const script = join(directory, "serve-sim.js");
  cpSync(join(import.meta.dir, "fixtures/permission-order.child.cjs"), script);
  const params = { udid: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", bundleId: "test.timeout" };
  try {
    await withActionTimeoutAsync(1000, async () => {
      const reset = runHostActionAsync({ action: "permissions.resetAll", params }, script);
      const grant = runHostActionAsync(
        {
          action: "permissions.set",
          params: {
            ...params,
            action: "grant",
            service: "camera",
          },
        },
        script,
      );
      const [failed, granted] = await Promise.all([reset, grant]);
      expect(failed.exitCode).toBe(1);
      expect(failed.stderr).toContain("did not finish within");
      expect(granted.exitCode).toBe(0);
      expect(readFileSync(join(directory, "events"), "utf8").trim().split("\n")).toEqual([
        "reset",
        "grant",
      ]);
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
