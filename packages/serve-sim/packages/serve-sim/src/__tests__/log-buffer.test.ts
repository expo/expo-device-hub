import { beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";
import { createLogBufferCache, DeviceLogBuffer } from "../log-buffer";
import type { LogLine } from "../log-buffer";
import { findUserAppProcesses } from "../metrics-sampler";

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter() as EventEmitter & { destroy: () => void };
  readonly stderr = new EventEmitter();
  killed = false;

  constructor() {
    super();
    this.stdout.destroy = () => {};
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }

  emitLines(text: string): void {
    this.stdout.emit("data", Buffer.from(text));
  }

  emitBytes(bytes: Buffer): void {
    this.stdout.emit("data", bytes);
  }
}

let spawned: FakeChild[] = [];
let clock = 0;

function makeBuffer(maxBytes = 1024, idleAfterMs = 0): DeviceLogBuffer {
  return new DeviceLogBuffer("UDID-1", {
    spawnLogStream: () => {
      const child = new FakeChild();
      spawned.push(child);
      return child as unknown as ChildProcess;
    },
    maxBytes,
    restartDelayMs: 5,
    now: () => clock,
    idleAfterMs,
  });
}

function line(seq: number): string {
  return JSON.stringify({ eventMessage: `msg-${seq}` });
}

beforeEach(() => {
  spawned = [];
  clock = 1_000;
});

describe("DeviceLogBuffer", () => {
  test("uses the CPU metrics user-app classification without foreground narrowing", () => {
    const child = new FakeChild();
    const cache = createLogBufferCache({
      idleAfterMs: 0,
      spawnLogStream: () => child as unknown as ChildProcess,
    });
    const base = "/x/Devices/UDID-1/data/Containers/Bundle/Application";
    const paths = [
      `${base}/AAA/MyApp.app/MyApp`,
      `${base}/AAA/MyApp.app/PlugIns/Share.appex/Share`,
      `${base}/BBB/Two Words.app/Two Words`,
      "/Runtime/RuntimeRoot/usr/libexec/runningboardd",
    ];
    const ps = paths.map((path, pid) => `${pid + 1} 0:01.00 1000 ${path}`).join("\n");
    const buffer = cache.ensure("UDID-1", "user-apps");
    child.emitLines(paths.map((processImagePath, pid) =>
      JSON.stringify({ processImagePath, processID: pid + 1 })
    ).join("\n") + "\n");
    const retainedPids = buffer.read().map((line) => JSON.parse(line.raw).processID);
    expect(retainedPids).toEqual([1, 2, 3]);
    expect(retainedPids).toEqual(findUserAppProcesses(ps, "UDID-1")?.pids ?? []);
    cache.stopAll();
  });

  test("user-app scope identifies emitting app containers, including extensions and later apps", () => {
    const child = new FakeChild();
    const cache = createLogBufferCache({
      idleAfterMs: 0,
      spawnLogStream: () => child as unknown as ChildProcess,
    });
    const buffer = cache.ensure("UDID-1", "user-apps");
    const paths = [
      "/private/var/containers/Bundle/Application/UUID/My App.app/My App",
      "/Users/test/Library/Developer/CoreSimulator/Devices/UDID-1/data/Containers/Bundle/Application/UUID/App.app/PlugIns/Widget.appex/Widget",
      "/private/var/containers/Bundle/Application/OTHER/Expo Go.app/Expo Go",
    ];
    const accepted = paths.map((processImagePath) => JSON.stringify({ processImagePath }));
    child.emitLines(accepted.join("\n") + "\n");
    child.emitLines([
      "not json", "null", "{}",
      JSON.stringify({ processImagePath: 123 }),
      JSON.stringify({ processImagePath: "/Applications/MobileSafari.app/MobileSafari" }),
      JSON.stringify({ processImagePath: "/usr/libexec/runningboardd", eventMessage: paths[0] }),
    ].join("\n") + "\n");
    expect(buffer.read().map((line) => line.raw)).toEqual(accepted);
    cache.prune(["another-device"]);
    expect(child.killed).toBe(true);
    expect(cache.peek("UDID-1", "user-apps")).toBeNull();
  });

  test("user-app retention excludes system noise without changing the default buffer", () => {
    const children: FakeChild[] = [];
    const cache = createLogBufferCache({
      maxBytes: 512,
      idleAfterMs: 0,
      spawnLogStream: () => {
        const child = new FakeChild();
        children.push(child);
        return child as unknown as ChildProcess;
      },
    });
    const all = cache.ensure("UDID-1");
    const apps = cache.ensure("UDID-1", "user-apps");
    const app = JSON.stringify({ processImagePath: "/private/var/containers/Bundle/Application/UUID/My App.app/My App", processID: 1, eventMessage: "APP_MARKER" });
    const system = JSON.stringify({ processImagePath: "/usr/libexec/runningboardd", eventMessage: app });
    const observed: LogLine[] = [];
    apps.subscribeBatch((lines) => observed.push(...lines));
    for (const child of children) child.emitLines(app + "\n" + (system + "\n").repeat(20));
    expect(apps.read().map((line) => line.raw)).toEqual([app]);
    expect(all.read().at(-1)?.raw).toBe(system);
    expect(observed.map((line) => line.raw)).toEqual([app]);
    const restartedApp = app.replace('"processID":1', '"processID":2');
    children[1]!.emitLines(restartedApp + "\n");
    expect(apps.read({ since: 1 }).map((line) => line.raw)).toEqual([restartedApp]);
    expect(cache.peek("UDID-1", "user-apps")).toBe(apps);
    cache.stopAll();
    expect(children.every((child) => child.killed)).toBe(true);
  });

  test("assembles whole lines across chunk boundaries", () => {
    const buffer = makeBuffer();
    buffer.start();
    const child = spawned[0]!;

    child.emitLines('{"a":1}\n{"b":');
    child.emitLines('2}\n');

    expect(buffer.read().map((l) => l.raw)).toEqual(['{"a":1}', '{"b":2}']);
    buffer.stop();
  });

  test("ignores blank lines and assigns increasing cursors", () => {
    const buffer = makeBuffer();
    buffer.start();
    spawned[0]!.emitLines("\n\n" + line(1) + "\n" + line(2) + "\n");

    const lines = buffer.read();
    expect(lines).toHaveLength(2);
    expect(lines[0]!.seq).toBe(1);
    expect(lines[1]!.seq).toBe(2);
    expect(buffer.latestSeq).toBe(2);
    buffer.stop();
  });

  test("returns only lines after a cursor", () => {
    const buffer = makeBuffer();
    buffer.start();
    spawned[0]!.emitLines([line(1), line(2), line(3)].join("\n") + "\n");

    expect(buffer.read({ since: 1 }).map((l) => l.seq)).toEqual([2, 3]);
    expect(buffer.read({ since: 3 })).toEqual([]);
    buffer.stop();
  });

  test("keeps the newest lines when a limit caps the result", () => {
    const buffer = makeBuffer();
    buffer.start();
    spawned[0]!.emitLines([line(1), line(2), line(3)].join("\n") + "\n");

    expect(buffer.read({ limit: 2 }).map((l) => l.seq)).toEqual([2, 3]);
    buffer.stop();
  });

  test("evicts the oldest lines once past the byte cap", () => {
    const buffer = makeBuffer(60);
    buffer.start();
    const child = spawned[0]!;
    for (let i = 1; i <= 20; i++) child.emitLines(line(i) + "\n");

    expect(buffer.byteLength).toBeLessThanOrEqual(60);
    const lines = buffer.read();
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[lines.length - 1]!.seq).toBe(20);
    expect(lines[0]!.seq).toBeGreaterThan(1);
    buffer.stop();
  });

  test("counts the UTF-8 bytes of non-ASCII lines against the cap", () => {
    const buffer = makeBuffer(120);
    buffer.start();
    const child = spawned[0]!;
    for (let i = 1; i <= 20; i++) {
      child.emitLines(JSON.stringify({ eventMessage: `日本語のログ ${i} 🚀` }) + "\n");
    }

    const lines = buffer.read();
    const utf8 = lines.reduce((sum, entry) => sum + Buffer.byteLength(entry.raw), 0);
    expect(buffer.byteLength).toBe(utf8);
    expect(utf8).toBeLessThanOrEqual(120);
    buffer.stop();
  });

  test("keeps a single line that is larger than the whole cap", () => {
    const buffer = makeBuffer(10);
    buffer.start();
    spawned[0]!.emitLines("x".repeat(500) + "\n");

    expect(buffer.read()).toHaveLength(1);
    buffer.stop();
  });

  test("notifies batch subscribers once per stdout burst", () => {
    const buffer = makeBuffer();
    buffer.start();
    const bursts: number[][] = [];
    buffer.subscribeBatch((lines) => bursts.push(lines.map((l) => l.seq)));

    spawned[0]!.emitLines([line(1), line(2), line(3)].join("\n") + "\n");

    expect(bursts).toEqual([[1, 2, 3]]);
    buffer.stop();
  });

  test("evicts a full ring without shifting one line at a time", () => {
    const buffer = makeBuffer(80);
    buffer.start();
    let payload = "";
    for (let i = 1; i <= 4000; i++) payload += line(i) + "\n";
    spawned[0]!.emitLines(payload);

    expect(buffer.byteLength).toBeLessThanOrEqual(80);
    expect(buffer.read().at(-1)?.seq).toBe(4000);
    buffer.stop();
  });

  test("notifies subscribers of new lines and stops on unsubscribe", () => {
    const buffer = makeBuffer();
    buffer.start();
    const seen: LogLine[] = [];
    const unsubscribe = buffer.subscribeBatch((batch) => seen.push(...batch));

    spawned[0]!.emitLines(line(1) + "\n");
    unsubscribe();
    spawned[0]!.emitLines(line(2) + "\n");

    expect(seen).toHaveLength(1);
    buffer.stop();
  });

  test("stops the simctl child an idle window after the last reader unsubscribes", async () => {
    const buffer = makeBuffer(1024, 15);
    buffer.start();
    buffer.subscribeBatch(() => {})();
    expect(buffer.status).toBe("streaming");

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(spawned[0]!.killed).toBe(true);
    expect(buffer.status).toBe("stopped");
    buffer.stop();
  });

  test("keeps buffering when a subscriber throws", () => {
    const buffer = makeBuffer();
    buffer.start();
    buffer.subscribeBatch(() => {
      throw new Error("closed socket");
    });
    const seen: LogLine[] = [];
    buffer.subscribeBatch((batch) => seen.push(...batch));

    spawned[0]!.emitLines(line(1) + "\n");
    expect(seen).toHaveLength(1);
    expect(buffer.read()).toHaveLength(1);
    buffer.stop();
  });

  test("returns the lines ingested at or before an instant", () => {
    const buffer = makeBuffer();
    buffer.start();
    const child = spawned[0]!;
    const emit = (n: number): void =>
      child.emitLines(JSON.stringify({ processImagePath: "/x/Demo", n }) + "\n");
    clock = 1_000;
    emit(1);
    clock = 2_000;
    emit(2);
    clock = 3_000;
    emit(3);

    const named = { count: 10, processName: "Demo" };
    expect(buffer.tailBefore({ ...named, at: 2_000 }).lines.map((l) => l.seq)).toEqual([1, 2]);
    expect(buffer.tailBefore({ at: 3_000, count: 1, processName: "Demo" }).lines).toHaveLength(1);
    expect(buffer.tailBefore({ ...named, at: 500 }).reason).toBe("buffer-rolled-past");
    expect(buffer.tailBefore({ at: 3_000, count: 10, processName: "Other" }).reason).toBe(
      "no-app-lines"
    );
    buffer.stop();
  });

  test("reports a rolled-past tail when the stream was not running near the crash", () => {
    const buffer = makeBuffer();
    buffer.start();
    const child = spawned[0]!;
    clock = 1_000;
    child.emitLines(JSON.stringify({ processImagePath: "/x/Demo", m: "before the gap" }) + "\n");

    const named = { count: 10, processName: "Demo", maxGapMs: 10_000 };
    expect(buffer.tailBefore({ ...named, at: 5_000 }).reason).toBe("app-windowed");
    const stale = buffer.tailBefore({ ...named, at: 40_000 });
    expect(stale.reason).toBe("buffer-rolled-past");
    expect(stale.lines).toEqual([]);
    buffer.stop();
  });

  test("still reports a gap when a line arrives after the crash it is asked about", () => {
    const buffer = makeBuffer();
    buffer.start();
    const child = spawned[0]!;
    clock = 1_000;
    child.emitLines(JSON.stringify({ processImagePath: "/x/Demo", m: "long before" }) + "\n");
    clock = 600_000;
    child.emitLines(JSON.stringify({ processImagePath: "/x/Demo", m: "after the crash" }) + "\n");

    const tail = buffer.tailBefore({
      at: 500_000,
      count: 10,
      processName: "Demo",
      maxGapMs: 10_000,
    });

    expect(tail.reason).toBe("buffer-rolled-past");
    expect(tail.lines).toEqual([]);
    buffer.stop();
  });

  test("narrows the tail to the emitting process, not lines that merely name it", () => {
    const buffer = makeBuffer();
    buffer.start();
    const child = spawned[0]!;
    clock = 1_000;
    const appLine = JSON.stringify({ processImagePath: "/x/Demo.app/Demo", m: "from the app" });
    const aboutApp = JSON.stringify({
      processImagePath: "/usr/libexec/SpringBoard",
      m: "scene for /x/Demo.app/Demo",
    });
    child.emitLines(appLine + "\n" + aboutApp + "\n");

    const tail = buffer.tailBefore({ at: 1_000, count: 10, processName: "Demo" });
    expect(tail.lines.map((l) => l.raw)).toEqual([appLine]);
    expect(tail.reason).toBe("app-windowed");
    buffer.stop();
  });

  test("keeps two processes with the same name apart by pid", () => {
    const buffer = makeBuffer();
    buffer.start();
    clock = 1_000;
    spawned[0]!.emitLines(
      JSON.stringify({ processImagePath: "/a/Demo.app/Demo", processID: 11, eventMessage: "other app" }) +
        "\n" +
        JSON.stringify({ processImagePath: "/b/Demo.app/Demo", processID: 22, eventMessage: "crashed app" }) +
        "\n"
    );

    const tail = buffer.tailBefore({ at: 1_000, count: 10, processName: "Demo", processId: 22 });
    expect(tail.lines.map((line) => JSON.parse(line.raw).eventMessage)).toEqual(["crashed app"]);
    buffer.stop();
  });

  test("caps the tail by bytes as well as line count", () => {
    const buffer = makeBuffer();
    buffer.start();
    const child = spawned[0]!;
    clock = 1_000;
    for (let index = 0; index < 10; index++) {
      child.emitLines(JSON.stringify({ processImagePath: "/x/Demo", m: "y".repeat(80) }) + "\n");
    }

    const tail = buffer.tailBefore({ at: 1_000, count: 10, processName: "Demo", maxBytes: 250 });
    expect(tail.lines.length).toBeLessThanOrEqual(3);
    expect(tail.lines.length).toBeGreaterThan(0);
    buffer.stop();
  });

  test("trims a single line that alone exceeds the tail's byte cap, keeping it valid JSON", () => {
    const buffer = makeBuffer(1_000_000);
    buffer.start();
    clock = 1_000;
    spawned[0]!.emitLines(
      JSON.stringify({ processImagePath: "/x/Demo", eventMessage: "\u00e9\n\"".repeat(2_000) }) + "\n"
    );

    const tail = buffer.tailBefore({ at: 1_000, count: 10, processName: "Demo", maxBytes: 250 });
    expect(tail.reason).toBe("app-windowed");
    expect(tail.lines).toHaveLength(1);
    const raw = tail.lines[0]!.raw;
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(250);
    const entry = JSON.parse(raw) as { processImagePath: string; eventMessage: string };
    expect(entry.processImagePath).toBe("/x/Demo");
    expect(entry.eventMessage.length).toBeGreaterThan(0);
    expect(entry.eventMessage).not.toContain("\uFFFD");
    buffer.stop();
  });

  test("drops a line whose metadata alone exceeds the tail's byte cap instead of cutting its JSON", () => {
    const buffer = makeBuffer(1_000_000);
    buffer.start();
    clock = 1_000;
    spawned[0]!.emitLines(
      JSON.stringify({ processImagePath: "/x/Demo", subsystem: "s".repeat(400), eventMessage: "hi" }) +
        "\n" +
        JSON.stringify({ processImagePath: "/x/Demo", eventMessage: { text: "x".repeat(400) } }) +
        "\n"
    );

    const tail = buffer.tailBefore({ at: 1_000, count: 1, processName: "Demo", maxBytes: 250 });
    expect(tail).toEqual({ lines: [], reason: "app-windowed" });
    const both = buffer.tailBefore({ at: 1_000, count: 2, processName: "Demo", maxBytes: 250 });
    expect(both).toEqual({ lines: [], reason: "app-windowed" });
    buffer.stop();
  });

  test("fills the line count from older lines when the newest one cannot fit", () => {
    const buffer = makeBuffer(1_000_000);
    buffer.start();
    clock = 1_000;
    spawned[0]!.emitLines(
      JSON.stringify({ processImagePath: "/x/Demo", eventMessage: "older" }) +
        "\n" +
        JSON.stringify({ processImagePath: "/x/Demo", subsystem: "s".repeat(400), eventMessage: "hi" }) +
        "\n"
    );

    const tail = buffer.tailBefore({ at: 1_000, count: 1, processName: "Demo", maxBytes: 250 });
    expect(tail.lines.map((line) => JSON.parse(line.raw).eventMessage)).toEqual(["older"]);
    buffer.stop();
  });

  test("respawns the tail when it dies, without a listener keeping it alive", async () => {
    const buffer = makeBuffer();
    buffer.start();
    expect(spawned).toHaveLength(1);

    spawned[0]!.emit("exit");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(spawned).toHaveLength(2);
    expect(buffer.status).toBe("streaming");
    buffer.stop();
  });

  test("does not respawn after stop", async () => {
    const buffer = makeBuffer();
    buffer.start();
    buffer.stop();
    spawned[0]!.emit("exit");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.killed).toBe(true);
  });

  test("drops a runaway line and its remainder, keeping the next whole line", () => {
    const buffer = makeBuffer();
    buffer.start();
    spawned[0]!.emitLines("x".repeat(2 * 1024 * 1024));
    spawned[0]!.emitLines("tail-of-runaway\n" + line(1) + "\n");

    expect(buffer.read().map((l) => l.raw)).toEqual([line(1)]);
    buffer.stop();
  });

  test("reassembles a multi-byte character split across chunks", () => {
    const buffer = makeBuffer();
    buffer.start();
    const payload = JSON.stringify({ m: "café 🎉" });
    const bytes = Buffer.from(payload + "\n", "utf8");
    const cut = payload.indexOf("é") + 5;
    spawned[0]!.emitBytes(bytes.subarray(0, cut));
    spawned[0]!.emitBytes(bytes.subarray(cut));

    expect(buffer.read()[0]?.raw).toBe(payload);
    buffer.stop();
  });

  test("backs off instead of respawning once per interval forever", async () => {
    const buffer = makeBuffer();
    buffer.start();
    for (let attempt = 0; attempt < 6; attempt++) {
      spawned[spawned.length - 1]!.emit("exit");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(spawned.length).toBeLessThan(7);
    buffer.stop();
  });

  test("ignores events from a child it already replaced", async () => {
    const buffer = makeBuffer();
    buffer.start();
    const first = spawned[0]!;
    first.emit("exit");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(spawned).toHaveLength(2);

    first.emit("error", new Error("late"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(spawned).toHaveLength(2);
    expect(buffer.status).toBe("streaming");
    buffer.stop();
  });
});

describe("createLogBufferCache", () => {
  function makeCache(idleAfterMs = 0) {
    return createLogBufferCache({
      spawnLogStream: () => {
        const child = new FakeChild();
        spawned.push(child);
        return child as unknown as ChildProcess;
      },
      maxBytes: 1024,
      restartDelayMs: 5,
      now: () => clock,
      idleAfterMs,
    });
  }

  test("starts one buffer per device and reuses it", () => {
    const cache = makeCache();
    const first = cache.ensure("UDID-1");
    const second = cache.ensure("UDID-1");

    expect(first).toBe(second);
    expect(spawned).toHaveLength(1);
    cache.stopAll();
  });

  test("ensure restarts a stream that went idle after the last reader left", async () => {
    const cache = makeCache(15);
    const buffer = cache.ensure("UDID-1");
    buffer.subscribeBatch(() => {})();
    expect(spawned[0]!.killed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(spawned[0]!.killed).toBe(true);

    cache.ensure("UDID-1");
    expect(spawned).toHaveLength(2);
    expect(buffer.status).toBe("streaming");
    cache.stopAll();
  });

  test("a leaving stream reader does not cut a snapshot poller off mid-poll", async () => {
    const cache = makeCache(30);
    const buffer = cache.ensure("UDID-1");
    const unsubscribe = buffer.subscribeBatch(() => {});
    unsubscribe();
    await new Promise((resolve) => setTimeout(resolve, 15));
    cache.ensure("UDID-1");
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.killed).toBe(false);
    cache.stopAll();
  });

  test("keeps buffering with nobody subscribed", () => {
    const cache = makeCache();
    cache.ensure("UDID-1");
    spawned[0]!.emitLines(line(1) + "\n");

    expect(cache.peek("UDID-1")?.read()).toHaveLength(1);
    cache.stopAll();
  });

  test("peek returns null for a device nothing has warmed", () => {
    const cache = makeCache();
    expect(cache.peek("UDID-9")).toBeNull();
  });

  test("prune stops buffers for devices that are gone and keeps the live ones", () => {
    const cache = makeCache();
    cache.ensure("UDID-1");
    cache.ensure("UDID-2");

    cache.prune(["UDID-2"]);

    expect(cache.peek("UDID-1")).toBeNull();
    expect(cache.peek("UDID-2")).not.toBeNull();
    expect(spawned[0]!.killed).toBe(true);
    expect(spawned[1]!.killed).toBe(false);
    cache.stopAll();
  });

  test("ignores an empty device list rather than wiping every ring", () => {
    const cache = makeCache();
    cache.ensure("UDID-1");
    spawned[0]!.emitLines(line(1) + "\n");

    cache.prune([]);

    expect(cache.peek("UDID-1")?.read()).toHaveLength(1);
    cache.stopAll();
  });

  test("stopAll stops every buffer", () => {
    const cache = makeCache();
    cache.ensure("UDID-1");
    cache.ensure("UDID-2");

    cache.stopAll();

    expect(cache.peek("UDID-1")).toBeNull();
    expect(spawned.every((child) => child.killed)).toBe(true);
  });

  test("idles the simctl child when nobody polls or subscribes", async () => {
    const cache = makeCache(15);
    cache.ensure("UDID-1");
    expect(spawned[0]!.killed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(spawned[0]!.killed).toBe(true);
    expect(cache.peek("UDID-1")?.status).toBe("stopped");
    cache.stopAll();
  });

  test("releases a child that keeps dying once the readers are gone", async () => {
    const cache = makeCache(15);
    const buffer = cache.ensure("UDID-1");
    buffer.subscribeBatch(() => {})();

    for (let i = 0; i < 3; i++) {
      spawned.at(-1)!.emit("exit");
      await new Promise((resolve) => setTimeout(resolve, 12));
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
    const spawnsAfterRelease = spawned.length;
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(buffer.status).toBe("stopped");
    expect(spawned).toHaveLength(spawnsAfterRelease);
    cache.stopAll();
  });

  test("a later ensure keeps a poll-only stream from idling", async () => {
    const cache = makeCache(30);
    cache.ensure("UDID-1");
    await new Promise((resolve) => setTimeout(resolve, 15));
    cache.ensure("UDID-1");
    await new Promise((resolve) => setTimeout(resolve, 15));

    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.killed).toBe(false);
    cache.stopAll();
  });

  test("does not idle while a subscriber is still reading", async () => {
    const cache = makeCache(15);
    const buffer = cache.ensure("UDID-1");
    const unsubscribe = buffer.subscribeBatch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(spawned[0]!.killed).toBe(false);
    expect(buffer.status).toBe("streaming");
    unsubscribe();
    cache.stopAll();
  });
});
