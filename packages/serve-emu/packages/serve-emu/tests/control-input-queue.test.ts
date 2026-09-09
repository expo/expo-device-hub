import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import {
  ControlInputError,
  ControlInputQueue,
  SocketControlWriter,
  type ControlBinaryWriter,
  type ControlInputClock,
} from "../src/control-input-queue.ts";
import { parseGesture } from "../src/input.ts";

const SCREEN = { width: 1080, height: 1920 };

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason: unknown) => void;
};

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function abortable(gate: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    gate.then(
      () => finish(resolve),
      (reason) => finish(() => reject(reason)),
    );
  });
}

class FakeWriter implements ControlBinaryWriter {
  readonly writes: Buffer[] = [];
  readonly closeReasons: Error[] = [];
  #plans: Array<
    | { type: "deferred"; gate: Deferred }
    | { type: "reject"; reason: unknown }
  > = [];

  deferNext(): Deferred {
    const gate = deferred();
    this.#plans.push({ type: "deferred", gate });
    return gate;
  }

  rejectNext(reason: unknown): void {
    this.#plans.push({ type: "reject", reason });
  }

  write(packet: Buffer, signal: AbortSignal): Promise<void> {
    this.writes.push(Buffer.from(packet));
    const plan = this.#plans.shift();
    if (!plan) return Promise.resolve();
    if (plan.type === "reject") return Promise.reject(plan.reason);
    return abortable(plan.gate.promise, signal);
  }

  close(reason: Error): void {
    this.closeReasons.push(reason);
  }
}

class FakeSocket extends EventEmitter {
  writable = true;
  destroyed = false;
  readonly writes: Buffer[] = [];
  writeResult = true;
  writeError: unknown = null;
  errorAfterWrite: Error | null = null;

  write(packet: Buffer, callback?: (err?: Error | null) => void): boolean {
    if (this.writeError) throw this.writeError;
    this.writes.push(Buffer.from(packet));
    if (this.errorAfterWrite) {
      const failure = this.errorAfterWrite;
      queueMicrotask(() => this.emit("error", failure));
    }
    queueMicrotask(() => callback?.(null));
    return this.writeResult;
  }
}

type ClockWaiter = {
  ms: number;
  signal: AbortSignal;
  resolve: () => void;
  reject: (reason: unknown) => void;
  onAbort: () => void;
};

class ManualClock implements ControlInputClock {
  readonly waits: ClockWaiter[] = [];

  sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<void>((resolve, reject) => {
      const waiter: ClockWaiter = {
        ms,
        signal,
        resolve,
        reject,
        onAbort: () => {},
      };
      waiter.onAbort = () => {
        const index = this.waits.indexOf(waiter);
        if (index >= 0) this.waits.splice(index, 1);
        signal.removeEventListener("abort", waiter.onAbort);
        reject(signal.reason);
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      this.waits.push(waiter);
    });
  }

  get pendingDelays(): number[] {
    return this.waits.map((waiter) => waiter.ms);
  }

  async advanceNext(): Promise<void> {
    const waiter = this.waits.shift();
    if (!waiter) throw new Error("manual clock has no pending sleep");
    waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.resolve();
    await flushMicrotasks();
  }
}

function makeQueue(
  writer: FakeWriter,
  clock: ManualClock,
  options: { maxDepth?: number; maxBytes?: number } = {},
): ControlInputQueue {
  return new ControlInputQueue({
    writer,
    clock,
    maxDepth: options.maxDepth ?? 32,
    maxBytes: options.maxBytes ?? 4096,
  });
}

function expectOverloaded(callback: () => unknown): ControlInputError {
  try {
    callback();
  } catch (error) {
    expect(error).toBeInstanceOf(ControlInputError);
    expect((error as ControlInputError).code).toBe("control-queue-overloaded");
    return error as ControlInputError;
  }
  throw new Error("expected the control queue to reject an overloaded input");
}

describe("ControlInputQueue ordering and backpressure", () => {
  test("passes only normalized text through the semantic queue", async () => {
    const original = `${"a".repeat(300)}é`;
    const dispatched: string[] = [];
    const queue = new ControlInputQueue({
      dispatcher: {
        async dispatchGesture(gesture) {
          if (gesture.type === "text") {
            dispatched.push(gesture.text);
          }
        },
        async resetVideo() {},
      },
    });

    const input = queue.enqueue(
      parseGesture({ type: "text", text: original }),
      SCREEN,
    );
    expect(input.gesture).toEqual({
      type: "text",
      text: "a".repeat(300),
    });
    await input.completion;

    expect(dispatched).toEqual(["a".repeat(300)]);
  });

  test("keeps an overlapping swipe and tap atomic", async () => {
    const writer = new FakeWriter();
    const clock = new ManualClock();
    const queue = makeQueue(writer, clock);
    const swipe = queue.enqueue(
      {
        type: "swipe",
        x1: 0,
        y1: 0,
        x2: 1,
        y2: 1,
        durationMs: 80,
      },
      SCREEN,
    );
    const tap = queue.enqueue({ type: "tap", x: 0.25, y: 0.5 }, SCREEN);

    await flushMicrotasks();
    expect(writer.writes).toHaveLength(1);
    expect(writer.writes[0]![1]).toBe(0);
    expect(clock.pendingDelays).toEqual([10]);
    expect(queue.snapshot()).toMatchObject({
      depth: 2,
      bytes: 352,
      entries: 2,
      active: true,
      closed: false,
    });

    for (let i = 0; i < 8; i++) {
      expect(clock.pendingDelays).toEqual([10]);
      await clock.advanceNext();
    }

    expect(writer.writes.slice(0, 9).map((packet) => packet[1])).toEqual([
      0,
      2,
      2,
      2,
      2,
      2,
      2,
      2,
      1,
    ]);
    expect(await swipe.completion).toEqual({ status: "completed" });
    expect(writer.writes).toHaveLength(10);
    expect(writer.writes[9]![1]).toBe(0);
    expect(clock.pendingDelays).toEqual([20]);

    await clock.advanceNext();
    expect(await tap.completion).toEqual({ status: "completed" });
    expect(writer.writes).toHaveLength(11);
    expect(writer.writes[10]![1]).toBe(1);
    expect(queue.snapshot()).toMatchObject({
      depth: 0,
      bytes: 0,
      entries: 0,
      active: false,
    });
  });

  test("does not start the next packet until a deferred write completes", async () => {
    const writer = new FakeWriter();
    const clock = new ManualClock();
    const gate = writer.deferNext();
    const queue = makeQueue(writer, clock);
    const input = queue.enqueue({ type: "key", keycode: 66 }, SCREEN);
    let completed = false;
    void input.completion.then(() => {
      completed = true;
    });

    await flushMicrotasks();
    expect(writer.writes).toHaveLength(1);
    expect(writer.writes[0]![1]).toBe(0);
    expect(completed).toBe(false);

    gate.resolve();
    await flushMicrotasks();
    expect(writer.writes).toHaveLength(2);
    expect(writer.writes[1]![1]).toBe(1);
    expect(await input.completion).toEqual({ status: "completed" });
    expect(completed).toBe(true);
  });
});

describe("SocketControlWriter", () => {
  test("waits for drain when Socket.write returns false", async () => {
    const socket = new FakeSocket();
    socket.writeResult = false;
    const writer = new SocketControlWriter(socket as unknown as Socket);
    const controller = new AbortController();
    let settled = false;
    const write = writer
      .write(Buffer.from([1, 2, 3]), controller.signal)
      .then(() => {
        settled = true;
      });

    await flushMicrotasks();
    expect(socket.writes).toEqual([Buffer.from([1, 2, 3])]);
    expect(settled).toBe(false);
    socket.emit("drain");
    await write;
    expect(settled).toBe(true);
  });

  test("rejects a blocked write on error and remembers the fatal state", async () => {
    const socket = new FakeSocket();
    socket.writeResult = false;
    const writer = new SocketControlWriter(socket as unknown as Socket);
    const controller = new AbortController();
    const blocked = writer.write(Buffer.from([1]), controller.signal);
    const failure = new Error("socket failed");

    socket.emit("error", failure);
    await expect(blocked).rejects.toMatchObject({
      code: "control-writer-error",
    });
    await expect(
      writer.write(Buffer.from([2]), controller.signal),
    ).rejects.toMatchObject({ code: "control-writer-error" });
    expect(socket.writes).toHaveLength(1);
  });

  test("does not acknowledge a true-returning write that errors immediately", async () => {
    const socket = new FakeSocket();
    socket.errorAfterWrite = new Error("async write failed");
    const writer = new SocketControlWriter(socket as unknown as Socket);

    await expect(
      writer.write(Buffer.from([1]), new AbortController().signal),
    ).rejects.toMatchObject({
      code: "control-writer-error",
      message: expect.stringContaining("async write failed"),
    });
  });

  test("rejects a blocked write when the socket closes", async () => {
    const socket = new FakeSocket();
    socket.writeResult = false;
    const writer = new SocketControlWriter(socket as unknown as Socket);
    const blocked = writer.write(
      Buffer.from([1]),
      new AbortController().signal,
    );

    socket.emit("close");
    await expect(blocked).rejects.toMatchObject({
      code: "control-writer-closed",
    });
  });

  test("rejects a blocked write when the queue aborts", async () => {
    const socket = new FakeSocket();
    socket.writeResult = false;
    const writer = new SocketControlWriter(socket as unknown as Socket);
    const controller = new AbortController();
    const blocked = writer.write(Buffer.from([1]), controller.signal);
    const reason = new Error("device switched");

    controller.abort(reason);
    await expect(blocked).rejects.toBe(reason);
  });

  test("turns synchronous socket write failures into typed errors", async () => {
    const socket = new FakeSocket();
    socket.writeError = new Error("write exploded");
    const writer = new SocketControlWriter(socket as unknown as Socket);

    await expect(
      writer.write(Buffer.from([1]), new AbortController().signal),
    ).rejects.toMatchObject({
      code: "control-writer-error",
      message: expect.stringContaining("write exploded"),
    });
  });
});

describe("ControlInputQueue bounds and coalescing", () => {
  test("bounds active and pending input by depth", async () => {
    const writer = new FakeWriter();
    const clock = new ManualClock();
    const gate = writer.deferNext();
    const queue = makeQueue(writer, clock, { maxDepth: 2 });
    const first = queue.enqueue({ type: "text", text: "a" }, SCREEN);
    const second = queue.enqueue({ type: "text", text: "b" }, SCREEN);

    await flushMicrotasks();
    expect(queue.snapshot()).toMatchObject({
      depth: 2,
      bytes: 12,
      entries: 2,
      active: true,
    });
    const error = expectOverloaded(() =>
      queue.enqueue({ type: "text", text: "c" }, SCREEN),
    );
    expect(error.meta).toEqual({
      depth: 2,
      bytes: 12,
      maxDepth: 2,
      maxBytes: 4096,
    });
    expect(writer.writes).toHaveLength(1);

    gate.resolve();
    await expect(first.completion).resolves.toEqual({ status: "completed" });
    await expect(second.completion).resolves.toEqual({ status: "completed" });
    expect(writer.writes).toHaveLength(2);
    expect(queue.snapshot()).toMatchObject({ depth: 0, bytes: 0 });
  });

  test("bounds active and pending input by compiled packet bytes", async () => {
    const writer = new FakeWriter();
    const clock = new ManualClock();
    const gate = writer.deferNext();
    const queue = makeQueue(writer, clock, {
      maxDepth: 10,
      maxBytes: 11,
    });
    const first = queue.enqueue({ type: "text", text: "a" }, SCREEN);

    await flushMicrotasks();
    expect(queue.snapshot()).toMatchObject({ depth: 1, bytes: 6 });
    const error = expectOverloaded(() =>
      queue.enqueue({ type: "text", text: "b" }, SCREEN),
    );
    expect(error.meta).toEqual({
      depth: 1,
      bytes: 6,
      maxDepth: 10,
      maxBytes: 11,
    });

    gate.resolve();
    await expect(first.completion).resolves.toEqual({ status: "completed" });
    expect(queue.snapshot()).toMatchObject({ depth: 0, bytes: 0 });
  });

  test("coalesces only a same-pointer move at the pending tail", async () => {
    const writer = new FakeWriter();
    const clock = new ManualClock();
    const gate = writer.deferNext();
    const queue = makeQueue(writer, clock);
    const active = queue.enqueue({ type: "text", text: "hold" }, SCREEN);
    const firstMove = queue.enqueue(
      { type: "touch", action: "move", x: 0.1, y: 0.2, pointerId: 7 },
      SCREEN,
    );
    const latestMove = queue.enqueue(
      { type: "touch", action: "move", x: 0.9, y: 0.8, pointerId: 7 },
      SCREEN,
    );
    const completionOrder: string[] = [];
    void firstMove.completion.then(() => completionOrder.push("first"));
    void latestMove.completion.then(() => completionOrder.push("latest"));

    await flushMicrotasks();
    expect(queue.snapshot()).toMatchObject({
      depth: 3,
      bytes: 41,
      entries: 2,
      active: true,
    });

    gate.resolve();
    expect(await active.completion).toEqual({ status: "completed" });
    expect(await firstMove.completion).toEqual({ status: "coalesced" });
    expect(await latestMove.completion).toEqual({ status: "completed" });
    await flushMicrotasks();

    expect(completionOrder).toEqual(["first", "latest"]);
    expect(writer.writes).toHaveLength(2);
    expect(writer.writes[1]!.readBigUInt64BE(2)).toBe(7n);
    expect(writer.writes[1]!.readInt32BE(10)).toBe(972);
    expect(writer.writes[1]!.readInt32BE(14)).toBe(1536);
  });

  test("does not coalesce across a different pointer at the tail", async () => {
    const writer = new FakeWriter();
    const clock = new ManualClock();
    const gate = writer.deferNext();
    const queue = makeQueue(writer, clock);
    const active = queue.enqueue({ type: "text", text: "hold" }, SCREEN);
    const moves = [
      queue.enqueue(
        { type: "touch", action: "move", x: 0.1, y: 0.1, pointerId: 7 },
        SCREEN,
      ),
      queue.enqueue(
        { type: "touch", action: "move", x: 0.2, y: 0.2, pointerId: 8 },
        SCREEN,
      ),
      queue.enqueue(
        { type: "touch", action: "move", x: 0.3, y: 0.3, pointerId: 7 },
        SCREEN,
      ),
    ];

    await flushMicrotasks();
    expect(queue.snapshot()).toMatchObject({ depth: 4, entries: 4 });
    gate.resolve();
    await active.completion;
    expect(await Promise.all(moves.map((move) => move.completion))).toEqual([
      { status: "completed" },
      { status: "completed" },
      { status: "completed" },
    ]);

    expect(writer.writes.slice(1).map((packet) => packet.readBigUInt64BE(2))).toEqual([
      7n,
      8n,
      7n,
    ]);
    expect(writer.writes.slice(1).map((packet) => packet.readInt32BE(10))).toEqual([
      108,
      216,
      324,
    ]);
  });

  test("never removes touch down or up while coalescing moves", async () => {
    const writer = new FakeWriter();
    const clock = new ManualClock();
    const gate = writer.deferNext();
    const queue = makeQueue(writer, clock);
    const active = queue.enqueue({ type: "text", text: "hold" }, SCREEN);
    const down = queue.enqueue(
      { type: "touch", action: "down", x: 0.1, y: 0.1, pointerId: 5 },
      SCREEN,
    );
    const firstMove = queue.enqueue(
      { type: "touch", action: "move", x: 0.2, y: 0.2, pointerId: 5 },
      SCREEN,
    );
    const latestMove = queue.enqueue(
      { type: "touch", action: "move", x: 0.8, y: 0.8, pointerId: 5 },
      SCREEN,
    );
    const up = queue.enqueue(
      { type: "touch", action: "up", x: 0.8, y: 0.8, pointerId: 5 },
      SCREEN,
    );

    await flushMicrotasks();
    expect(queue.snapshot()).toMatchObject({ depth: 5, entries: 4 });
    gate.resolve();
    await active.completion;
    expect(await down.completion).toEqual({ status: "completed" });
    expect(await firstMove.completion).toEqual({ status: "coalesced" });
    expect(await latestMove.completion).toEqual({ status: "completed" });
    expect(await up.completion).toEqual({ status: "completed" });

    const touches = writer.writes.slice(1);
    expect(touches.map((packet) => packet[1])).toEqual([0, 2, 1]);
    expect(touches.map((packet) => packet.readBigUInt64BE(2))).toEqual([
      5n,
      5n,
      5n,
    ]);
    expect(touches[1]!.readInt32BE(10)).toBe(864);
  });

  test("reserves capacity for touch up while move events flood", async () => {
    const writer = new FakeWriter();
    const clock = new ManualClock();
    const gate = writer.deferNext();
    const queue = makeQueue(writer, clock, { maxDepth: 3 });
    const down = queue.enqueue(
      { type: "touch", action: "down", x: 0.1, y: 0.1, pointerId: 9 },
      SCREEN,
    );
    const move = queue.enqueue(
      { type: "touch", action: "move", x: 0.4, y: 0.4, pointerId: 9 },
      SCREEN,
    );
    expectOverloaded(() =>
      queue.enqueue(
        { type: "touch", action: "move", x: 0.8, y: 0.8, pointerId: 9 },
        SCREEN,
      ),
    );
    const up = queue.enqueue(
      { type: "touch", action: "up", x: 0.8, y: 0.8, pointerId: 9 },
      SCREEN,
    );

    await flushMicrotasks();
    expect(queue.snapshot()).toMatchObject({
      depth: 3,
      reservedReleases: 0,
    });
    gate.resolve();
    await Promise.all([down.completion, move.completion, up.completion]);

    expect(writer.writes.map((packet) => packet[1])).toEqual([0, 2, 1]);
    expect(queue.snapshot()).toMatchObject({
      depth: 0,
      bytes: 0,
      reservedReleases: 0,
    });
  });
});

describe("ControlInputQueue cancellation and failures", () => {
  test("the system clock preserves the queue-close error while aborting sleep", async () => {
    const writer = new FakeWriter();
    const queue = new ControlInputQueue({ writer });
    const tap = queue.enqueue({ type: "tap", x: 0.5, y: 0.5 }, SCREEN);

    await flushMicrotasks();
    expect(writer.writes).toHaveLength(1);
    queue.close(new Error("device switched"));

    await expect(tap.completion).rejects.toMatchObject({
      code: "control-queue-closed",
      message: "device switched",
    });
  });

  test("cancels sleeping and queued work without further writes", async () => {
    const writer = new FakeWriter();
    const clock = new ManualClock();
    const queue = makeQueue(writer, clock);
    const swipe = queue.enqueue(
      {
        type: "swipe",
        x1: 0,
        y1: 0,
        x2: 1,
        y2: 1,
        durationMs: 80,
      },
      SCREEN,
    );
    const tap = queue.enqueue({ type: "tap", x: 0.5, y: 0.5 }, SCREEN);
    const swipeError = swipe.completion.catch((error) => error);
    const tapError = tap.completion.catch((error) => error);

    await flushMicrotasks();
    expect(writer.writes).toHaveLength(1);
    expect(clock.pendingDelays).toEqual([10]);

    queue.close(new Error("device session changed"));
    queue.close(new Error("ignored second close"));
    const [activeError, pendingError] = await Promise.all([
      swipeError,
      tapError,
    ]);
    await flushMicrotasks();

    for (const error of [activeError, pendingError]) {
      expect(error).toBeInstanceOf(ControlInputError);
      expect(error.code).toBe("control-queue-closed");
      expect(error.message).toBe("device session changed");
    }
    expect(clock.pendingDelays).toEqual([]);
    expect(writer.writes).toHaveLength(1);
    expect(writer.closeReasons).toHaveLength(1);
    expect(queue.snapshot()).toMatchObject({
      closed: true,
      depth: 0,
      bytes: 0,
      entries: 0,
      active: false,
    });
    expect(() =>
      queue.enqueue({ type: "text", text: "late" }, SCREEN),
    ).toThrow("device session changed");
  });

  test("rejects active and queued work when the writer fails", async () => {
    const writer = new FakeWriter();
    const clock = new ManualClock();
    const failure = new Error("write failed");
    writer.rejectNext(failure);
    const queue = makeQueue(writer, clock);
    const first = queue.enqueue({ type: "home" }, SCREEN);
    const second = queue.enqueue({ type: "text", text: "never" }, SCREEN);
    const firstError = first.completion.catch((error) => error);
    const secondError = second.completion.catch((error) => error);

    const [activeError, pendingError] = await Promise.all([
      firstError,
      secondError,
    ]);
    await flushMicrotasks();

    for (const error of [activeError, pendingError]) {
      expect(error).toBeInstanceOf(ControlInputError);
      expect(error.code).toBe("control-dispatch-failed");
      expect(error.message).toContain("write failed");
    }
    expect((activeError as Error).cause).toBe(failure);
    expect(pendingError).toBe(activeError);
    expect(writer.writes).toHaveLength(1);
    expect(writer.closeReasons).toEqual([activeError]);
    expect(queue.snapshot()).toMatchObject({
      closed: true,
      depth: 0,
      bytes: 0,
      entries: 0,
      active: false,
    });
  });

  test("a close racing the final write cannot produce a completed result", async () => {
    let queue!: ControlInputQueue;
    const writer: ControlBinaryWriter = {
      write: async () => {
        queueMicrotask(() => queue.close(new Error("device switched")));
      },
    };
    queue = new ControlInputQueue({ writer });
    const input = queue.enqueue({ type: "text", text: "race" }, SCREEN);

    await expect(input.completion).rejects.toMatchObject({
      code: "control-queue-closed",
      message: "device switched",
    });
    expect(queue.snapshot()).toMatchObject({
      closed: true,
      depth: 0,
      bytes: 0,
      active: false,
    });
  });
});
