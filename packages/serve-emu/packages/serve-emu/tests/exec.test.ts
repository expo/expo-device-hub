import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  ExecError,
  MAX_EXEC_TIMEOUT_MS,
  ProcessExecutor,
  type ExecClock,
  type ExecSpawner,
} from "../src/exec.ts";

type Timer = {
  callback: () => void;
  dueMs: number;
  active: boolean;
};

class ManualClock implements ExecClock {
  nowMs = 0;
  readonly timers: Timer[] = [];

  now(): number {
    return this.nowMs;
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const timer = {
      callback,
      dueMs: this.nowMs + delayMs,
      active: true,
    };
    this.timers.push(timer);
    return timer;
  }

  clearTimeout(value: unknown): void {
    (value as Timer).active = false;
  }

  advance(ms: number): void {
    this.nowMs += ms;
    for (const timer of this.timers) {
      if (!timer.active || timer.dueMs > this.nowMs) continue;
      timer.active = false;
      timer.callback();
    }
  }
}

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly killSignals: NodeJS.Signals[] = [];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killSignals.push(signal);
    return true;
  }

  close(
    status: number | null = 0,
    signal: NodeJS.Signals | null = null,
  ): void {
    this.exitCode = status;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", status, signal);
  }
}

function harness(options: {
  maxActive?: number;
  maxQueued?: number;
  interactiveActiveReserve?: number;
  interactiveQueueReserve?: number;
  clock?: ExecClock;
} = {}) {
  const children: Array<{ cmd: string; args: string[]; child: FakeChild }> = [];
  const spawn: ExecSpawner = (cmd, args) => {
    const child = new FakeChild();
    children.push({ cmd, args, child });
    return child as never;
  };
  return {
    children,
    executor: new ProcessExecutor({ ...options, spawn }),
  };
}

function errorCode(error: Error | null): string | undefined {
  return error instanceof ExecError ? error.code : undefined;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("ProcessExecutor", () => {
  test("handles synchronous deadlines and validates timer range", async () => {
    let cleared = 0;
    const clock: ExecClock = {
      now: () => 0,
      setTimeout(callback) {
        callback();
        return { immediate: true };
      },
      clearTimeout() {
        cleared++;
      },
    };
    const { executor, children } = harness({ clock });

    const result = await executor.execText("immediate", [], { timeout: 1 });
    expect(errorCode(result.error)).toBe("deadline-exceeded");
    expect(result.timedOut).toBe(true);
    expect(children).toHaveLength(0);
    expect(cleared).toBe(1);
    expect(() =>
      executor.execText("invalid", [], {
        timeout: MAX_EXEC_TIMEOUT_MS + 1,
      }),
    ).toThrow(`timeout must be an integer from 0 through ${MAX_EXEC_TIMEOUT_MS}`);
  });

  test("bounds active and queued commands and prioritizes interactive work", async () => {
    const { executor, children } = harness({ maxActive: 1, maxQueued: 2 });
    const active = executor.execText("active", []);
    const background = executor.execText("background", [], {
      lane: "background",
    });
    const interactive = executor.execText("interactive", [], {
      lane: "interactive",
    });
    const overflow = await executor.execText("overflow", []);

    expect(children.map(({ cmd }) => cmd)).toEqual(["active"]);
    expect(errorCode(overflow.error)).toBe("queue-full");
    expect(executor.snapshot()).toMatchObject({
      active: 1,
      queued: 2,
      lanes: {
        interactive: { active: 0, queued: 1 },
        default: { active: 1, queued: 0 },
        background: { active: 0, queued: 1 },
      },
      totals: { rejected: 1 },
    });

    children[0]!.child.close();
    expect((await active).status).toBe(0);
    expect(children.map(({ cmd }) => cmd)).toEqual([
      "active",
      "interactive",
    ]);
    children[1]!.child.close();
    expect((await interactive).status).toBe(0);
    expect(children.map(({ cmd }) => cmd)).toEqual([
      "active",
      "interactive",
      "background",
    ]);
    children[2]!.child.close();
    expect((await background).status).toBe(0);
    expect(executor.snapshot()).toMatchObject({
      active: 0,
      queued: 0,
      totals: {
        submitted: 4,
        started: 3,
        settled: 4,
        succeeded: 3,
        failed: 1,
        rejected: 1,
      },
    });
  });

  test("reserves active capacity from long-running background work", async () => {
    const { executor, children } = harness({
      maxActive: 4,
      maxQueued: 4,
      interactiveActiveReserve: 1,
      interactiveQueueReserve: 1,
    });
    const background = Array.from({ length: 4 }, (_, index) =>
      executor.execText(`background-${index}`, [], { lane: "background" }),
    );

    expect(children.map(({ cmd }) => cmd)).toEqual([
      "background-0",
      "background-1",
      "background-2",
    ]);
    expect(executor.snapshot()).toMatchObject({
      active: 3,
      queued: 1,
      lanes: {
        interactive: { active: 0, queued: 0 },
        background: { active: 3, queued: 1 },
      },
    });

    const interactive = executor.execText("interactive", [], {
      lane: "interactive",
    });
    expect(children.map(({ cmd }) => cmd)).toEqual([
      "background-0",
      "background-1",
      "background-2",
      "interactive",
    ]);
    children[3]!.child.close();
    await interactive;
    expect(children).toHaveLength(4);

    children[0]!.child.close();
    await background[0];
    expect(children[4]!.cmd).toBe("background-3");
    children[1]!.child.close();
    children[2]!.child.close();
    children[4]!.child.close();
    await Promise.all(background);
  });

  test("reserves queue capacity for interactive work", async () => {
    const { executor, children } = harness({
      maxActive: 1,
      maxQueued: 4,
      interactiveActiveReserve: 0,
      interactiveQueueReserve: 1,
    });
    const active = executor.execText("active", []);
    const queued = [0, 1, 2].map((index) =>
      executor.execText(`default-${index}`, []),
    );
    const rejected = await executor.execText("default-rejected", []);
    const interactive = executor.execText("interactive", [], {
      lane: "interactive",
    });

    expect(errorCode(rejected.error)).toBe("queue-full");
    expect(executor.snapshot()).toMatchObject({
      active: 1,
      queued: 4,
      lanes: {
        interactive: { active: 0, queued: 1 },
        default: { active: 1, queued: 3 },
      },
    });
    children[0]!.child.close();
    await active;
    expect(children[1]!.cmd).toBe("interactive");
    children[1]!.child.close();
    await interactive;

    for (let index = 0; index < queued.length; index++) {
      expect(children[index + 2]!.cmd).toBe(`default-${index}`);
      children[index + 2]!.child.close();
      await queued[index];
    }
  });

  test("includes queue wait in the command deadline", async () => {
    const clock = new ManualClock();
    const { executor, children } = harness({
      maxActive: 1,
      maxQueued: 1,
      clock,
    });
    const active = executor.execText("active", []);
    const queued = executor.execText("queued", [], { timeout: 100 });

    clock.advance(99);
    expect(executor.snapshot()).toMatchObject({ active: 1, queued: 1 });
    clock.advance(1);
    const result = await queued;

    expect(result.timedOut).toBe(true);
    expect(errorCode(result.error)).toBe("deadline-exceeded");
    expect(children.map(({ cmd }) => cmd)).toEqual(["active"]);
    expect(executor.snapshot()).toMatchObject({
      active: 1,
      queued: 0,
      totals: { timedOut: 1 },
    });
    children[0]!.child.close();
    await active;
  });

  test("holds the active permit until a timed-out child closes", async () => {
    const clock = new ManualClock();
    const { executor, children } = harness({
      maxActive: 1,
      maxQueued: 1,
      clock,
    });
    const timed = executor.execText("timed", [], { timeout: 100 });
    const next = executor.execText("next", []);
    let settled = false;
    void timed.then(() => {
      settled = true;
    });

    clock.advance(100);
    await flush();
    expect(children[0]!.child.killSignals).toEqual(["SIGKILL"]);
    expect(settled).toBe(false);
    expect(children).toHaveLength(1);
    expect(executor.snapshot()).toMatchObject({ active: 1, queued: 1 });

    children[0]!.child.close(null, "SIGKILL");
    const result = await timed;
    expect(result.timedOut).toBe(true);
    expect(errorCode(result.error)).toBe("deadline-exceeded");
    expect(children.map(({ cmd }) => cmd)).toEqual(["timed", "next"]);
    children[1]!.child.close();
    expect((await next).status).toBe(0);
  });

  test("removes queued aborts and waits for active abort termination", async () => {
    const { executor, children } = harness({ maxActive: 1, maxQueued: 2 });
    const activeController = new AbortController();
    const active = executor.execText("active", [], {
      signal: activeController.signal,
    });
    const queuedController = new AbortController();
    const queued = executor.execText("queued", [], {
      signal: queuedController.signal,
    });

    queuedController.abort(new Error("queued request gone"));
    const queuedResult = await queued;
    expect(errorCode(queuedResult.error)).toBe("aborted");
    expect(executor.snapshot()).toMatchObject({ active: 1, queued: 0 });

    let activeSettled = false;
    void active.then(() => {
      activeSettled = true;
    });
    activeController.abort(new Error("active request gone"));
    await flush();
    expect(children[0]!.child.killSignals).toEqual(["SIGKILL"]);
    expect(activeSettled).toBe(false);
    children[0]!.child.close(null, "SIGKILL");

    const activeResult = await active;
    expect(errorCode(activeResult.error)).toBe("aborted");
    expect(executor.snapshot()).toMatchObject({
      active: 0,
      queued: 0,
      totals: { aborted: 2 },
    });
  });

  test("settles abort and deadline races exactly once", async () => {
    const clock = new ManualClock();
    const { executor, children } = harness({
      maxActive: 1,
      maxQueued: 1,
      clock,
    });
    const abortFirstController = new AbortController();
    const abortFirst = executor.execText("abort-first", [], {
      timeout: 100,
      signal: abortFirstController.signal,
    });
    abortFirstController.abort(new Error("request gone"));
    clock.advance(100);
    expect(children[0]!.child.killSignals).toEqual(["SIGKILL"]);
    children[0]!.child.close(null, "SIGKILL");
    const abortResult = await abortFirst;
    expect(errorCode(abortResult.error)).toBe("aborted");
    expect(abortResult.timedOut).toBe(false);

    const deadlineFirstController = new AbortController();
    const deadlineFirst = executor.execText("deadline-first", [], {
      timeout: 100,
      signal: deadlineFirstController.signal,
    });
    clock.advance(100);
    deadlineFirstController.abort(new Error("too late"));
    expect(children[1]!.child.killSignals).toEqual(["SIGKILL"]);
    children[1]!.child.close(null, "SIGKILL");
    const deadlineResult = await deadlineFirst;
    expect(errorCode(deadlineResult.error)).toBe("deadline-exceeded");
    expect(deadlineResult.timedOut).toBe(true);
    expect(executor.snapshot().totals).toMatchObject({
      submitted: 2,
      settled: 2,
      failed: 2,
      aborted: 1,
      timedOut: 1,
    });
  });

  test("enforces one combined stdout and stderr budget until close", async () => {
    const { executor, children } = harness({ maxActive: 1, maxQueued: 1 });
    const limited = executor.execText("noisy", [], { maxBuffer: 6 });
    let settled = false;
    void limited.then(() => {
      settled = true;
    });

    children[0]!.child.stdout.write("1234");
    children[0]!.child.stderr.write("abc");
    children[0]!.child.stderr.write("ignored-after-overflow");
    await flush();

    expect(children[0]!.child.killSignals).toEqual(["SIGKILL"]);
    expect(settled).toBe(false);
    expect(executor.snapshot()).toMatchObject({
      active: 1,
      totals: { outputLimited: 1 },
    });
    children[0]!.child.close(null, "SIGKILL");
    const result = await limited;

    expect(errorCode(result.error)).toBe("output-limit");
    expect(result.stdout).toBe("1234");
    expect(result.stderr).toBe("");
    expect(executor.snapshot()).toMatchObject({ active: 0, queued: 0 });
  });

  test("does not release a slot on child error before close", async () => {
    const { executor, children } = harness({ maxActive: 1, maxQueued: 1 });
    const failed = executor.execText("missing", []);
    const next = executor.execText("next", []);
    const spawnError = new Error("spawn ENOENT");

    children[0]!.child.emit("error", spawnError);
    await flush();
    expect(children).toHaveLength(1);
    expect(executor.snapshot()).toMatchObject({ active: 1, queued: 1 });
    children[0]!.child.close(null, null);

    expect((await failed).error).toBe(spawnError);
    expect(children.map(({ cmd }) => cmd)).toEqual(["missing", "next"]);
    children[1]!.child.close();
    await next;
  });
});
