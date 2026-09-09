import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  LogcatHub,
  type LogcatClock,
} from "../src/logcat.ts";

class FakeLogcatChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly killSignals: string[] = [];

  kill(signal: string = "SIGTERM"): boolean {
    this.killSignals.push(signal);
    return true;
  }

  fail(error: Error): void {
    this.emit("error", error);
  }

  close(code: number | null = 0, signal: string | null = null): void {
    this.emit("close", code, signal);
  }
}

class ManualClock implements LogcatClock {
  #nextId = 1;
  readonly timeouts = new Map<number, () => void>();
  readonly intervals = new Map<number, () => void>();

  setTimeout(callback: () => void, _delayMs: number): number {
    const id = this.#nextId++;
    this.timeouts.set(id, callback);
    return id;
  }

  clearTimeout(timer: unknown): void {
    this.timeouts.delete(timer as number);
  }

  setInterval(callback: () => void, _delayMs: number): number {
    const id = this.#nextId++;
    this.intervals.set(id, callback);
    return id;
  }

  clearInterval(timer: unknown): void {
    this.intervals.delete(timer as number);
  }

  runTimeouts(): void {
    const callbacks = [...this.timeouts.values()];
    this.timeouts.clear();
    for (const callback of callbacks) callback();
  }

  runIntervals(): void {
    for (const callback of [...this.intervals.values()]) callback();
  }
}

type SseEvent = {
  event: string;
  data: unknown;
};

async function readEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<SseEvent> {
  const result = await reader.read();
  expect(result.done).toBe(false);
  const text = new TextDecoder().decode(result.value);
  const event = text.match(/^event: ([^\n]+)$/m)?.[1];
  const data = text.match(/^data: (.+)$/m)?.[1];
  if (!event || !data) throw new Error(`invalid SSE event: ${text}`);
  return { event, data: JSON.parse(data) };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function makeHub(
  options: ConstructorParameters<typeof LogcatHub>[1] = {},
): {
  hub: LogcatHub;
  clock: ManualClock;
  children: FakeLogcatChild[];
} {
  const clock = new ManualClock();
  const children: FakeLogcatChild[] = [];
  const hub = new LogcatHub("emulator-old", {
    ...options,
    dependencies: {
      ...options.dependencies,
      clock,
      now: () => new Date("2026-07-11T12:00:00.000Z"),
      spawn: () => {
        const child = new FakeLogcatChild();
        children.push(child);
        return child as never;
      },
    },
  });
  return { hub, clock, children };
}

describe("LogcatHub", () => {
  test("shares one child, limits subscribers, and escalates a stuck shutdown", async () => {
    const { hub, clock, children } = makeHub({ maxSubscribers: 2 });

    const first = hub.subscribe({});
    const second = hub.subscribe({ search: "warning" });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(children).toHaveLength(1);
    expect(hub.snapshot()).toMatchObject({
      childActive: true,
      subscribers: 2,
      totals: { childStarts: 1 },
    });

    const rejected = hub.subscribe({});
    expect(rejected.status).toBe(429);
    expect(await rejected.json()).toMatchObject({
      ok: false,
      code: "logcat-subscriber-limit",
    });
    expect(children).toHaveLength(1);

    const firstReader = first.body!.getReader();
    const secondReader = second.body!.getReader();
    await firstReader.cancel();
    expect(hub.snapshot()).toMatchObject({
      childActive: true,
      subscribers: 1,
    });
    expect(children[0]!.killSignals).toEqual([]);

    await secondReader.cancel();
    expect(hub.snapshot()).toMatchObject({
      childActive: false,
      childTerminating: true,
      childCount: 1,
      subscribers: 0,
    });
    expect(children[0]!.killSignals).toEqual(["SIGTERM"]);

    clock.runTimeouts();
    expect(children[0]!.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(hub.snapshot()).toMatchObject({
      childCount: 1,
      totals: { forcedKills: 1 },
    });
    children[0]!.close(null, "SIGKILL");
    expect(hub.snapshot()).toMatchObject({
      childActive: false,
      childTerminating: false,
      childCount: 0,
    });
  });

  test("keeps a slow subscriber bounded and reports oldest-line drops in one batch", async () => {
    const { hub, clock, children } = makeHub({
      maxQueueLines: 3,
      maxQueueBytes: 100,
    });
    const response = hub.subscribe({});
    const reader = response.body!.getReader();

    children[0]!.stdout.write(
      `${Array.from({ length: 10 }, (_, index) => `line-${index}`).join("\n")}\n`,
    );
    expect(hub.snapshot()).toMatchObject({
      queuedLines: 3,
      totals: { droppedLines: 7 },
    });
    expect(hub.snapshot().queuedBytes).toBeLessThanOrEqual(100);

    clock.runTimeouts();
    children[0]!.stdout.write("line-10\nline-11\nline-12\nline-13\n");
    expect(clock.timeouts.size).toBe(0);
    expect(hub.snapshot()).toMatchObject({
      queuedLines: 3,
      totals: { droppedLines: 11 },
    });
    expect(hub.snapshot().queuedBytes).toBeLessThanOrEqual(100);

    expect((await readEvent(reader)).event).toBe("ready");
    const batch = await readEvent(reader);
    expect(batch.event).toBe("logs");
    expect(batch.data).toEqual({
      lines: [
        { line: "line-11", at: "2026-07-11T12:00:00.000Z" },
        { line: "line-12", at: "2026-07-11T12:00:00.000Z" },
        { line: "line-13", at: "2026-07-11T12:00:00.000Z" },
      ],
      dropped: 11,
      totalDropped: 11,
      sourceDropped: 0,
    });
    expect(hub.snapshot()).toMatchObject({
      queuedLines: 0,
      queuedBytes: 0,
      totals: { batches: 1, deliveredLines: 3 },
    });

    await reader.cancel();
  });

  test("uses the captured serial for non-overlapping PID refreshes and filtering", async () => {
    type PendingLookup = {
      signal: AbortSignal;
      resolve(pids: Set<string>): void;
    };
    const calls: Array<{ serial: string; packageName: string }> = [];
    const pending: PendingLookup[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const { hub, clock, children } = makeHub({
      dependencies: {
        resolvePackagePids: (serial, packageName, signal) => {
          calls.push({ serial, packageName });
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          return new Promise((resolve) => {
            let settled = false;
            const lookup: PendingLookup = {
              signal,
              resolve: (pids) => {
                if (settled) return;
                settled = true;
                concurrent--;
                resolve(pids);
              },
            };
            signal.addEventListener(
              "abort",
              () => lookup.resolve(new Set()),
              { once: true },
            );
            pending.push(lookup);
          });
        },
      },
    });
    const response = hub.subscribe({
      packageName: "com.example.app",
      search: "needle",
    });
    const reader = response.body!.getReader();

    await flushMicrotasks();
    expect(calls).toEqual([
      { serial: "emulator-old", packageName: "com.example.app" },
    ]);
    clock.runIntervals();
    clock.runIntervals();
    await flushMicrotasks();
    expect(calls).toHaveLength(1);
    expect(maxConcurrent).toBe(1);

    pending.shift()!.resolve(new Set(["123"]));
    await flushMicrotasks();
    children[0]!.stdout.write(
      "07-11 12:00:00.000 999 456 I Tag: needle wrong pid\n" +
        "07-11 12:00:00.001 123 456 I Tag: missing search\n" +
        "07-11 12:00:00.002 123 456 I Tag: NEEDLE accepted\n",
    );
    clock.runTimeouts();

    const ready = await readEvent(reader);
    expect(ready).toEqual({
      event: "ready",
      data: {
        serial: "emulator-old",
        package: "com.example.app",
        search: "needle",
        batchIntervalMs: 75,
      },
    });
    const logs = await readEvent(reader);
    expect(logs.event).toBe("logs");
    expect(logs.data).toMatchObject({
      lines: [
        {
          line: "07-11 12:00:00.002 123 456 I Tag: NEEDLE accepted",
        },
      ],
    });

    clock.runIntervals();
    await flushMicrotasks();
    clock.runIntervals();
    await flushMicrotasks();
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.serial === "emulator-old")).toBe(true);
    expect(maxConcurrent).toBe(1);
    expect(hub.snapshot().activePidLookups).toBe(1);

    hub.close("device switched");
    hub.close("duplicate close");
    expect(clock.intervals.size).toBe(0);
    expect(clock.timeouts.size).toBe(1);
    expect(children[0]!.killSignals).toEqual(["SIGTERM"]);
    expect(hub.snapshot()).toMatchObject({
      closed: true,
      childActive: false,
      childTerminating: true,
      childCount: 1,
      subscribers: 0,
    });
    expect(pending[0]!.signal.aborted).toBe(true);
    await flushMicrotasks();
    expect(hub.snapshot().activePidLookups).toBe(0);
    expect((await readEvent(reader)).event).toBe("close");
    expect((await reader.read()).done).toBe(true);
    children[0]!.close(null, "SIGTERM");
    expect(clock.timeouts.size).toBe(0);
    expect(hub.snapshot().childCount).toBe(0);

    clock.runIntervals();
    await flushMicrotasks();
    expect(calls).toHaveLength(2);
    expect(hub.subscribe({}).status).toBe(409);
  });

  test("closes an aborted stream and resets decoding for a later child", async () => {
    const { hub, clock, children } = makeHub();
    const abort = new AbortController();
    const first = hub.subscribe({}, abort.signal);
    const firstReader = first.body!.getReader();
    expect((await readEvent(firstReader)).event).toBe("ready");

    abort.abort();
    expect((await firstReader.read()).done).toBe(true);
    expect(hub.snapshot()).toMatchObject({
      subscribers: 0,
      childActive: false,
      childTerminating: true,
      childCount: 1,
    });
    expect(children[0]!.killSignals).toEqual(["SIGTERM"]);

    const second = hub.subscribe({});
    const secondReader = second.body!.getReader();
    expect((await readEvent(secondReader)).event).toBe("ready");
    expect(children).toHaveLength(1);
    expect(hub.snapshot()).toMatchObject({
      subscribers: 1,
      childActive: false,
      childTerminating: true,
      childCount: 1,
    });

    children[0]!.close(null, "SIGTERM");
    expect(children).toHaveLength(2);
    expect(hub.snapshot()).toMatchObject({
      childActive: true,
      childTerminating: false,
      childCount: 1,
      totals: { childStarts: 2 },
    });
    const encoded = Buffer.from("emoji 😀 survives\n", "utf8");
    children[1]!.stdout.write(encoded.subarray(0, 8));
    children[1]!.stdout.write(encoded.subarray(8));
    clock.runTimeouts();
    expect(await readEvent(secondReader)).toMatchObject({
      event: "logs",
      data: {
        lines: [{ line: "emoji 😀 survives" }],
      },
    });

    await secondReader.cancel();
    expect(children[1]!.killSignals).toEqual(["SIGTERM"]);
    children[1]!.close(null, "SIGTERM");
    expect(hub.snapshot().childCount).toBe(0);
  });

  test("drops an oversized source line without retaining its continuation", async () => {
    const { hub, clock, children } = makeHub({
      maxSourceLineBytes: 16,
    });
    const response = hub.subscribe({});
    const reader = response.body!.getReader();
    expect((await readEvent(reader)).event).toBe("ready");

    children[0]!.stdout.write("x".repeat(100));
    expect(hub.snapshot()).toMatchObject({
      queuedLines: 0,
      totals: { sourceDroppedLines: 1 },
    });
    clock.runTimeouts();
    expect(await readEvent(reader)).toEqual({
      event: "logs",
      data: {
        lines: [],
        dropped: 0,
        totalDropped: 0,
        sourceDropped: 1,
      },
    });
    children[0]!.stdout.write("discarded tail\nok\n");
    clock.runTimeouts();
    expect(await readEvent(reader)).toEqual({
      event: "logs",
      data: {
        lines: [{ line: "ok", at: "2026-07-11T12:00:00.000Z" }],
        dropped: 0,
        totalDropped: 0,
        sourceDropped: 1,
      },
    });

    await reader.cancel();
  });

  test("reports child errors and cleans up once on close", async () => {
    const { hub, children } = makeHub();
    const response = hub.subscribe({});
    const reader = response.body!.getReader();
    expect((await readEvent(reader)).event).toBe("ready");

    children[0]!.fail(new Error("adb transport lost"));
    children[0]!.close(1, null);
    expect(await readEvent(reader)).toMatchObject({
      event: "error",
      data: { error: "adb transport lost" },
    });
    expect(await readEvent(reader)).toEqual({
      event: "close",
      data: { code: 1, signal: null },
    });
    expect((await reader.read()).done).toBe(true);
    expect(hub.snapshot()).toMatchObject({
      childActive: false,
      subscribers: 0,
      lastError: "adb transport lost",
    });
    expect(children[0]!.killSignals).toEqual([]);

    hub.close();
    hub.close();
    expect(children[0]!.killSignals).toEqual([]);
  });
});
