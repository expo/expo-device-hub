import { beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";
import { createCrashRuntime } from "../crash/runtime";
import { createLogBufferCache } from "../log-buffer";
import type { CrashEvent } from "../crash/store";

const UDID_A = "CD26E7DF-F2CE-4DCB-B950-2F062DE3FBB3";
const UDID_B = "11111111-2222-3333-4444-555555555555";

type Emit = (eventType: string, filename: string | null) => void;

function bundleRoot(udid: string): string {
  return (
    `/Users/USER/Library/Developer/CoreSimulator/Devices/${udid}` +
    "/data/Containers/Bundle/Application/9E92F5F8/Demo.app"
  );
}

function ips({
  udid = UDID_A,
  bundleID = "com.example.demo",
  platform = 7,
  bugType = "309",
  symbol = "AppDelegate.boot()",
  pid = 1,
  capturedAt = "2026-08-04 23:14:07.8433 -0700",
}: {
  udid?: string;
  bundleID?: string;
  platform?: number;
  bugType?: string;
  symbol?: string;
  pid?: number;
  capturedAt?: string;
} = {}): string {
  const root = bundleRoot(udid);
  const header = {
    app_name: "Demo",
    timestamp: "2026-08-04 23:14:11.00 -0700",
    app_version: "1.0.0",
    build_version: "1",
    platform,
    bundleID,
    bug_type: bugType,
    incident_id: `INC-${symbol}-${pid}`,
  };
  const body = {
    procName: "Demo",
    procPath: `${root}/Demo`,
    pid,
    captureTime: capturedAt,
    exception: { type: "EXC_CRASH", signal: "SIGABRT" },
    termination: { indicator: "Abort trap: 6" },
    faultingThread: 0,
    legacyInfo: { threadTriggered: { queue: "com.apple.main-thread" } },
    usedImages: [{ name: "Demo", path: `${root}/Demo` }],
    threads: [{ triggered: true, frames: [{ imageIndex: 0, imageOffset: 1, symbol }] }],
  };
  return `${JSON.stringify(header)}\n${JSON.stringify(body)}\n`;
}

let emit: Emit;
let failWatch: (error: unknown) => void;
let closed: number;
let files: Map<string, string>;
let inodes: Map<string, number>;
let errors: string[];
let clock: number;

function makeRuntime(
  options: { failRead?: boolean; dirEntries?: string[]; mtimes?: Record<string, number> } = {}
) {
  return createCrashRuntime({
    reportsDir: "/reports",
    retryDelayMs: 10_000,
    readDir: async () => {
      if (options.dirEntries) return options.dirEntries;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    statFile: async (path) => {
      const name = path.replace("/reports/", "");
      const mtimeMs = options.mtimes?.[name] ?? (files.has(name) ? 1_500 : undefined);
      if (mtimeMs === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { mtimeMs, ino: inodes.get(name) ?? 1 };
    },
    ensureDir: () => {},
    watchDir: (_dir, listener, onWatchError) => {
      emit = listener;
      failWatch = onWatchError;
      return {
        close: () => {
          closed += 1;
        },
      };
    },
    readReport: async (path) => {
      if (options.failRead) throw new Error("EACCES");
      const name = path.replace("/reports/", "");
      const contents = files.get(name);
      if (contents === undefined) {
        const error: NodeJS.ErrnoException = new Error("ENOENT");
        error.code = "ENOENT";
        throw error;
      }
      return contents;
    },
    now: () => clock,
    onError: (message) => {
      errors.push(message);
    },
  });
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  emit = () => {};
  failWatch = () => {};
  closed = 0;
  files = new Map();
  inodes = new Map();
  errors = [];
  clock = 1_000;
});

describe("createCrashRuntime", () => {
  test("records a finished .ips for its device", async () => {
    const runtime = makeRuntime();
    runtime.start();
    files.set("Demo-1.ips", ips());

    emit("rename", "Demo-1.ips");
    await flush();

    const crashes = runtime.listFor(UDID_A);
    expect(crashes).toHaveLength(1);
    expect(crashes[0]?.bundleId).toBe("com.example.demo");
    expect(crashes[0]?.culpritFrame).toBe("Demo AppDelegate.boot()");
    runtime.stop();
  });

  test("ignores the dot-prefixed temp file ReportCrash writes first", async () => {
    const runtime = makeRuntime();
    runtime.start();
    files.set(".Demo-1.ips", ips());

    emit("rename", ".Demo-1.ips");
    await flush();

    expect(runtime.listFor(UDID_A)).toHaveLength(0);
    runtime.stop();
  });

  test("ignores files that are not crash reports", async () => {
    const runtime = makeRuntime();
    runtime.start();
    files.set("something.diag", ips());

    emit("rename", "something.diag");
    emit("rename", null);
    await flush();

    expect(runtime.listFor(UDID_A)).toHaveLength(0);
    runtime.stop();
  });

  test("reads each report once even when fs.watch repeats the name", async () => {
    const runtime = makeRuntime({ mtimes: { "Demo-1.ips": 1_500 } });
    runtime.start();
    files.set("Demo-1.ips", ips());

    emit("rename", "Demo-1.ips");
    emit("change", "Demo-1.ips");
    emit("rename", "Demo-1.ips");
    await flush();

    expect(runtime.listFor(UDID_A)[0]?.count).toBe(1);
    runtime.stop();
  });

  test("forgets a report once the watcher sees it leave the directory", async () => {
    const runtime = makeRuntime();
    runtime.start();
    files.set("Demo-1.ips", ips());
    emit("rename", "Demo-1.ips");
    await flush();
    emit("rename", "Demo-1.ips");
    await flush();
    expect(runtime.listFor(UDID_A)[0]?.count).toBe(1);

    files.delete("Demo-1.ips");
    emit("rename", "Demo-1.ips");
    await flush();
    files.set("Demo-1.ips", ips());
    emit("rename", "Demo-1.ips");
    await flush();

    expect(runtime.listFor(UDID_A)[0]?.count).toBe(2);
    runtime.stop();
  });

  test("counts a new file that replaces a report under the same name", async () => {
    const runtime = makeRuntime();
    runtime.start();
    files.set("Demo-1.ips", ips());
    emit("rename", "Demo-1.ips");
    await flush();

    inodes.set("Demo-1.ips", 2);
    emit("rename", "Demo-1.ips");
    await flush();
    emit("rename", "Demo-1.ips");
    await flush();

    expect(runtime.listFor(UDID_A)[0]?.count).toBe(2);
    runtime.stop();
  });

  test("a stale removal check does not drop the claim of the file that replaced it", async () => {
    let holdNextStat = false;
    let releaseHeld: (() => void) | null = null;
    const runtime = createCrashRuntime({
      reportsDir: "/reports",
      ensureDir: () => {},
      watchDir: (_dir, listener) => {
        emit = listener;
        return { close: () => {} };
      },
      readReport: async (path) => files.get(path.replace("/reports/", "")) ?? "",
      readDir: async () => [],
      statFile: (path) => {
        const name = path.replace("/reports/", "");
        const found = files.has(name) ? { mtimeMs: 1_500, ino: inodes.get(name) ?? 1 } : null;
        const answer = () =>
          found
            ? Promise.resolve(found)
            : Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
        if (!holdNextStat) return answer();
        holdNextStat = false;
        return new Promise((resolve, reject) => {
          releaseHeld = () => void answer().then(resolve, reject);
        });
      },
      now: () => clock,
    });
    runtime.start();
    files.set("Demo-1.ips", ips());
    emit("rename", "Demo-1.ips");
    await flush();

    files.delete("Demo-1.ips");
    holdNextStat = true;
    emit("rename", "Demo-1.ips");
    await flush();
    files.set("Demo-1.ips", ips());
    inodes.set("Demo-1.ips", 2);
    emit("rename", "Demo-1.ips");
    await flush();
    expect(runtime.listFor(UDID_A)[0]?.count).toBe(2);

    releaseHeld!();
    await flush();
    emit("rename", "Demo-1.ips");
    await flush();

    expect(runtime.listFor(UDID_A)[0]?.count).toBe(2);
    runtime.stop();
  });

  test("a back-scan cleanup does not drop a claim made while it listed the directory", async () => {
    let failWatcher: (error: unknown) => void = () => {};
    let listing: { promise: Promise<string[]>; resolve: (names: string[]) => void } | null = null;
    const runtime = createCrashRuntime({
      reportsDir: "/reports",
      ensureDir: () => {},
      watchDir: (_dir, listener, onWatchError) => {
        emit = listener;
        failWatcher = onWatchError;
        return { close: () => {} };
      },
      readReport: async (path) => files.get(path.replace("/reports/", "")) ?? "",
      readDir: () => (listing ? listing.promise : Promise.resolve([])),
      statFile: async (path) => {
        const name = path.replace("/reports/", "");
        if (!files.has(name)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return { mtimeMs: 1_500, ino: inodes.get(name) ?? 1 };
      },
      retryDelayMs: 10_000,
      now: () => clock,
      onError: () => {},
    });
    await runtime.start();
    files.set("Demo-1.ips", ips());
    emit("rename", "Demo-1.ips");
    await flush();

    failWatcher(new Error("ENOENT"));
    listing = Promise.withResolvers<string[]>();
    const restarted = runtime.start();
    inodes.set("Demo-1.ips", 2);
    emit("rename", "Demo-1.ips");
    await flush();
    expect(runtime.listFor(UDID_A)[0]?.count).toBe(2);

    listing.resolve([]);
    await restarted;
    emit("rename", "Demo-1.ips");
    await flush();

    expect(runtime.listFor(UDID_A)[0]?.count).toBe(2);
    runtime.stop();
  });

  test("skips a crash from a device build rather than a simulator", async () => {
    const runtime = makeRuntime();
    runtime.start();
    files.set("Demo-1.ips", ips({ platform: 2 }));

    emit("rename", "Demo-1.ips");
    await flush();

    expect(runtime.listFor(UDID_A)).toHaveLength(0);
    runtime.stop();
  });

  test("skips reports that are not crashes", async () => {
    const runtime = makeRuntime();
    runtime.start();
    files.set("Demo-1.ips", ips({ bugType: "288" }));

    emit("rename", "Demo-1.ips");
    await flush();

    expect(runtime.listFor(UDID_A)).toHaveLength(0);
    runtime.stop();
  });

  test("keeps two simulators' crashes apart", async () => {
    const runtime = makeRuntime();
    runtime.start();
    files.set("A.ips", ips({ udid: UDID_A }));
    files.set("B.ips", ips({ udid: UDID_B, symbol: "Other.boom()" }));

    emit("rename", "A.ips");
    emit("rename", "B.ips");
    await flush();

    expect(runtime.listFor(UDID_A)).toHaveLength(1);
    expect(runtime.listFor(UDID_B)).toHaveLength(1);
    expect(runtime.listFor(UDID_B)[0]?.culpritFrame).toBe("Demo Other.boom()");
    runtime.stop();
  });

  test("collapses a crash loop into one record with a count", async () => {
    const runtime = makeRuntime();
    runtime.start();
    files.set("Demo-1.ips", ips({ pid: 1 }));
    files.set("Demo-2.ips", ips({ pid: 2 }));

    emit("rename", "Demo-1.ips");
    await flush();
    clock = 2_000;
    emit("rename", "Demo-2.ips");
    await flush();

    const crashes = runtime.listFor(UDID_A);
    expect(crashes).toHaveLength(1);
    expect(crashes[0]?.count).toBe(2);
    expect(crashes[0]?.pid).toBe(2);
    runtime.stop();
  });

  test("tolerates a report that was retired before it could be read", async () => {
    const runtime = makeRuntime();
    runtime.start();

    emit("rename", "Vanished.ips");
    await flush();

    expect(runtime.listFor(UDID_A)).toHaveLength(0);
    expect(errors).toHaveLength(0);
    runtime.stop();
  });

  test("reports a read failure that is not a missing file", async () => {
    const runtime = makeRuntime({ failRead: true });
    runtime.start();
    files.set("Demo-1.ips", ips());

    emit("rename", "Demo-1.ips");
    await flush();

    expect(errors).toHaveLength(1);
    runtime.stop();
  });

  test("tolerates a report whose contents do not parse", async () => {
    const runtime = makeRuntime();
    runtime.start();
    files.set("Demo-1.ips", "not an ips");

    emit("rename", "Demo-1.ips");
    await flush();

    expect(runtime.listFor(UDID_A)).toHaveLength(0);
    runtime.stop();
  });

  test("delivers events to a subscriber for that device", async () => {
    const runtime = makeRuntime();
    runtime.start();
    const events: CrashEvent[] = [];
    const { unsubscribe } = runtime.subscribe(UDID_A, (event) => events.push(event));

    files.set("Demo-1.ips", ips({ pid: 1 }));
    files.set("Demo-2.ips", ips({ pid: 2 }));
    emit("rename", "Demo-1.ips");
    await flush();
    emit("rename", "Demo-2.ips");
    await flush();

    expect(events.map((event) => event.type)).toEqual(["crash", "recurred"]);
    unsubscribe();
    runtime.stop();
  });

  test("returns an empty list for a device that has not crashed", () => {
    const runtime = makeRuntime();
    runtime.start();
    expect(runtime.listFor(UDID_B)).toEqual([]);
    runtime.stop();
  });

  test("closes the watcher on stop and does not ingest afterwards", async () => {
    const runtime = makeRuntime();
    runtime.start();
    runtime.stop();
    expect(closed).toBe(1);

    files.set("Demo-1.ips", ips());
    emit("rename", "Demo-1.ips");
    await flush();

    expect(runtime.listFor(UDID_A)).toHaveLength(0);
  });

  test("start is idempotent", () => {
    const runtime = makeRuntime();
    runtime.start();
    runtime.start();
    runtime.stop();
    expect(closed).toBe(1);
  });

  test("reports a watch failure as unavailable with the cause", async () => {
    const runtime = createCrashRuntime({
      reportsDir: "/reports",
      ensureDir: () => {},
      watchDir: () => {
        throw new Error("EPERM");
      },
      onError: (message) => errors.push(message),
    });
    await runtime.start();
    expect(errors).toHaveLength(1);
    expect(runtime.meta().status).toBe("unavailable");
    expect(runtime.meta().statusError).toContain("EPERM");
  });
});

describe("createCrashRuntime back-scan", () => {
  test("picks up a report the watcher never announced", async () => {
    const runtime = makeRuntime({
      dirEntries: ["Missed.ips"],
      mtimes: { "Missed.ips": 1_500 },
    });
    files.set("Missed.ips", ips());

    await runtime.start();

    expect(runtime.listFor(UDID_A)).toHaveLength(1);
    runtime.stop();
  });

  test("records reports oldest first, so the newest ones survive the cap", async () => {
    const names = Array.from({ length: 21 }, (_, index) => `Demo-${index}.ips`);
    const mtimes = Object.fromEntries(names.map((name, index) => [name, 5_000 - index]));
    for (const [index, name] of names.entries()) files.set(name, ips({ symbol: `crash${index}()` }));
    const runtime = makeRuntime({ dirEntries: names, mtimes });

    await runtime.start();

    const kept = runtime.listFor(UDID_A).map((crash) => crash.culpritFrame);
    expect(kept).toHaveLength(20);
    expect(kept).toContain("Demo crash0()");
    expect(kept).not.toContain("Demo crash20()");
    runtime.stop();
  });

  test("skips reports written before the runtime started", async () => {
    const runtime = makeRuntime({
      dirEntries: ["Stale.ips"],
      mtimes: { "Stale.ips": 900 },
    });
    files.set("Stale.ips", ips());

    await runtime.start();

    expect(runtime.listFor(UDID_A)).toHaveLength(0);
    runtime.stop();
  });

  test("takes a report written exactly at the start instant", async () => {
    const runtime = makeRuntime({
      dirEntries: ["Edge.ips"],
      mtimes: { "Edge.ips": 1_000 },
    });
    files.set("Edge.ips", ips());

    await runtime.start();

    expect(runtime.listFor(UDID_A)).toHaveLength(1);
    runtime.stop();
  });

  test("skips the dot-prefixed temp file", async () => {
    const runtime = makeRuntime({
      dirEntries: [".Temp.ips"],
      mtimes: { ".Temp.ips": 1_500 },
    });
    files.set(".Temp.ips", ips());

    await runtime.start();

    expect(runtime.listFor(UDID_A)).toHaveLength(0);
    runtime.stop();
  });

  test("ignores the Retired subdirectory and other non-report entries", async () => {
    const runtime = makeRuntime({
      dirEntries: ["Retired", "something.diag"],
      mtimes: { Retired: 1_500, "something.diag": 1_500 },
    });

    await runtime.start();

    expect(runtime.listFor(UDID_A)).toHaveLength(0);
    expect(errors).toHaveLength(0);
    runtime.stop();
  });

  test("does not double-count a report the watcher already took", async () => {
    const runtime = makeRuntime({
      dirEntries: ["Demo-1.ips"],
      mtimes: { "Demo-1.ips": 1_500 },
    });
    files.set("Demo-1.ips", ips());

    runtime.start();
    emit("rename", "Demo-1.ips");
    await flush();
    await flush();

    const crashes = runtime.listFor(UDID_A);
    expect(crashes).toHaveLength(1);
    expect(crashes[0]?.count).toBe(1);
    runtime.stop();
  });

  test("keeps going when one report cannot be stat'd", async () => {
    const runtime = makeRuntime({
      dirEntries: ["Gone.ips", "Good.ips"],
      mtimes: { "Good.ips": 1_500 },
    });
    files.set("Good.ips", ips());

    await runtime.start();

    expect(runtime.listFor(UDID_A)).toHaveLength(1);
    runtime.stop();
  });

  test("tolerates a reports directory that cannot be listed", async () => {
    const runtime = createCrashRuntime({
      reportsDir: "/reports",
      ensureDir: () => {},
      watchDir: () => ({ close: () => {} }),
      readDir: async () => {
        throw new Error("EACCES");
      },
      onError: (message) => errors.push(message),
    });

    await runtime.start();

    expect(errors).toHaveLength(1);
    expect(runtime.meta().status).toBe("watching");
  });

  test("covers the gap after a failure and restart", async () => {
    const runtime = makeRuntime({
      dirEntries: ["DuringOutage.ips"],
      mtimes: { "DuringOutage.ips": 1_400 },
    });
    await runtime.start();
    failWatch(new Error("ENOENT"));
    expect(runtime.meta().status).toBe("unavailable");

    files.set("DuringOutage.ips", ips());
    clock = 5_000;
    await runtime.start();

    expect(runtime.meta().status).toBe("watching");
    expect(runtime.listFor(UDID_A)).toHaveLength(1);
    runtime.stop();
  });

  test("does not count a report again when a restart re-scans more than 500 of them", async () => {
    const names = Array.from({ length: 501 }, (_, index) => `Demo-${index}.ips`);
    const mtimes: Record<string, number> = { "DuringOutage.ips": 4_000 };
    const runtime = makeRuntime({ dirEntries: [...names, "DuringOutage.ips"], mtimes });
    await runtime.start();
    for (const [index, name] of names.entries()) {
      clock = 1_000 + index;
      mtimes[name] = clock;
      files.set(name, ips({ pid: index }));
      emit("rename", name);
      await flush();
    }
    const total = () => runtime.listFor(UDID_A).reduce((sum, crash) => sum + crash.count, 0);
    expect(total()).toBe(501);

    failWatch(new Error("ENOENT"));
    files.set("DuringOutage.ips", ips({ pid: 999 }));
    clock = 5_000;
    await runtime.start();

    expect(runtime.meta().status).toBe("watching");
    expect(total()).toBe(502);
    runtime.stop();
  });

  test("collects every report from an outage with more than 500 of them", async () => {
    const dirEntries: string[] = [];
    const mtimes: Record<string, number> = {};
    const runtime = makeRuntime({ dirEntries, mtimes });
    await runtime.start();
    failWatch(new Error("ENOENT"));
    for (let index = 0; index < 600; index++) {
      const name = `Outage-${index}.ips`;
      dirEntries.push(name);
      mtimes[name] = 2_000 + index;
      files.set(name, ips({ pid: index }));
    }
    clock = 5_000;
    await runtime.start();

    expect(runtime.listFor(UDID_A).reduce((sum, crash) => sum + crash.count, 0)).toBe(600);
    runtime.stop();
  });

  test("does not scan when the watch could not be established", async () => {
    const runtime = createCrashRuntime({
      reportsDir: "/reports",
      ensureDir: () => {
        throw new Error("EPERM");
      },
      watchDir: () => ({ close: () => {} }),
      readDir: async () => ["Demo-1.ips"],
      statFile: async () => ({ mtimeMs: 9_999, ino: 1 }),
      readReport: async () => ips(),
      onError: () => {},
    });

    await runtime.start();

    expect(runtime.listFor(UDID_A)).toHaveLength(0);
    expect(runtime.meta().status).toBe("unavailable");
  });
});

describe("createCrashRuntime cancellation", () => {
  function gatedRuntime(dirEntries: string[] = []) {
    let release: (() => void) | null = null;
    let gated = true;
    const runtime = createCrashRuntime({
      reportsDir: "/reports",
      ensureDir: () => {},
      watchDir: (_dir, listener, onWatchError) => {
        emit = listener;
        failWatch = onWatchError;
        return { close: () => (closed += 1) };
      },
      readReport: (path) => {
        const contents = files.get(path.replace("/reports/", "")) ?? "";
        if (!gated) return Promise.resolve(contents);
        gated = false;
        return new Promise<string>((resolve) => {
          release = () => resolve(contents);
        });
      },
      readDir: async () => [...dirEntries],
      statFile: async () => ({ mtimeMs: 1_500, ino: 1 }),
      now: () => clock,
      onError: (message) => errors.push(message),
    });
    return { runtime, release: () => release?.() };
  }

  test("re-scans a report whose read was dropped by stop", async () => {
    files.set("Demo-1.ips", ips());
    const dirEntries: string[] = [];
    const { runtime, release } = gatedRuntime(dirEntries);
    await runtime.start();

    emit("rename", "Demo-1.ips");
    await flush();
    runtime.stop();
    release();
    await flush();
    expect(runtime.listFor(UDID_A)).toHaveLength(0);

    dirEntries.push("Demo-1.ips");
    clock = 2_000;
    await runtime.start();
    await flush();

    expect(runtime.listFor(UDID_A)).toHaveLength(1);
    runtime.stop();
  });

  test("does not record a read that resolves after stop", async () => {
    files.set("Demo-1.ips", ips());
    const { runtime, release } = gatedRuntime();
    await runtime.start();

    emit("rename", "Demo-1.ips");
    await flush();
    runtime.stop();
    release();
    await flush();

    expect(runtime.listFor(UDID_A)).toHaveLength(0);
  });

  test("does not record a read that resolves after the watcher failed", async () => {
    files.set("Demo-1.ips", ips());
    const { runtime, release } = gatedRuntime();
    await runtime.start();

    emit("rename", "Demo-1.ips");
    await flush();
    failWatch(new Error("ENOENT"));
    release();
    await flush();

    expect(runtime.listFor(UDID_A)).toHaveLength(0);
    expect(runtime.meta().status).toBe("unavailable");
    runtime.stop();
  });

  test("a cancelled back-scan does not resume after restart", async () => {
    const statted: string[] = [];
    const gate: { release: (() => void) | null } = { release: null };
    const runtime = createCrashRuntime({
      reportsDir: "/reports",
      ensureDir: () => {},
      watchDir: (_dir, listener) => {
        emit = listener;
        return { close: () => (closed += 1) };
      },
      readReport: async () => "",
      readDir: async () => ["a.ips", "b.ips", "c.ips"],
      statFile: (path) => {
        const name = path.replace("/reports/", "");
        statted.push(name);
        if (name === "a.ips" && !gate.release) {
          return new Promise<{ mtimeMs: number; ino: number }>((resolve) => {
            gate.release = () => resolve({ mtimeMs: 500, ino: 1 });
          });
        }
        return Promise.resolve({ mtimeMs: 500, ino: 1 });
      },
      now: () => clock,
      onError: () => {},
    });

    const cancelled = runtime.start();
    await flush();
    runtime.stop();
    const replacement = runtime.start();
    gate.release?.();
    await Promise.all([cancelled, replacement]);
    await flush();

    expect(statted.filter((name) => name === "b.ips")).toHaveLength(1);
    runtime.stop();
  });

  test("a synchronous watch failure still allows a later start to recover", async () => {
    let failNext = true;
    const runtime = createCrashRuntime({
      reportsDir: "/reports",
      ensureDir: () => {},
      watchDir: (_dir, _listener, onWatchError) => {
        if (failNext) {
          failNext = false;
          onWatchError(new Error("EPERM"));
        }
        return { close: () => (closed += 1) };
      },
      readReport: async () => ips(),
      readDir: async () => [],
      now: () => clock,
      onError: () => {},
    });

    await runtime.start();
    expect(runtime.meta().status).toBe("unavailable");

    await runtime.start();
    expect(runtime.meta().status).toBe("watching");
    runtime.stop();
  });
});

describe("createCrashRuntime prune", () => {
  test("drops stores for devices that are gone and keeps the live ones", async () => {
    const runtime = makeRuntime();
    await runtime.start();
    files.set("A.ips", ips({ udid: UDID_A }));
    files.set("B.ips", ips({ udid: UDID_B, symbol: "Other.boom()" }));
    emit("rename", "A.ips");
    emit("rename", "B.ips");
    await flush();

    runtime.prune([UDID_B]);

    expect(runtime.listFor(UDID_A)).toHaveLength(0);
    expect(runtime.listFor(UDID_B)).toHaveLength(1);
    runtime.stop();
  });

  test("keeps dedupe for the devices it keeps", async () => {
    const runtime = makeRuntime();
    await runtime.start();
    files.set("A.ips", ips({ udid: UDID_A }));
    files.set("B.ips", ips({ udid: UDID_B, symbol: "Other.boom()" }));
    emit("rename", "A.ips");
    emit("rename", "B.ips");
    await flush();

    runtime.prune([UDID_B]);
    emit("rename", "B.ips");
    await flush();

    expect(runtime.listFor(UDID_B).map((record) => record.count)).toEqual([1]);
    runtime.stop();
  });

  test("rereads every report of a returning device, including occurrences it had evicted", async () => {
    const runtime = makeRuntime();
    await runtime.start();
    const names = Array.from({ length: 7 }, (_, i) => `A-${i + 1}.ips`);
    names.forEach((name, i) => files.set(name, ips({ udid: UDID_A, pid: i + 1 })));
    files.set("B.ips", ips({ udid: UDID_B, symbol: "Other.boom()" }));
    for (const name of names) {
      emit("rename", name);
      await flush();
    }
    emit("rename", "B.ips");
    await flush();
    expect(runtime.listFor(UDID_A)[0]?.count).toBe(7);

    runtime.prune([UDID_B]);
    for (const name of names) {
      emit("rename", name);
      await flush();
    }

    expect(runtime.listFor(UDID_A)[0]?.count).toBe(7);
    runtime.stop();
  });

  test("lets a pruned device's reports be read again when it returns", async () => {
    const runtime = makeRuntime();
    await runtime.start();
    files.set("A.ips", ips({ udid: UDID_A }));
    files.set("B.ips", ips({ udid: UDID_B, symbol: "Other.boom()" }));
    emit("rename", "A.ips");
    emit("rename", "B.ips");
    await flush();

    runtime.prune([UDID_B]);
    emit("rename", "A.ips");
    await flush();

    expect(runtime.listFor(UDID_A)).toHaveLength(1);
    runtime.stop();
  });

  test("ignores an empty device list", async () => {
    const runtime = makeRuntime();
    await runtime.start();
    files.set("A.ips", ips({ udid: UDID_A }));
    emit("rename", "A.ips");
    await flush();

    runtime.prune([]);

    expect(runtime.listFor(UDID_A)).toHaveLength(1);
    runtime.stop();
  });
});

describe("createCrashRuntime meta", () => {
  test("reports idle before start, with no error", () => {
    const runtime = makeRuntime();
    const meta = runtime.meta();
    expect(meta.status).toBe("idle");
    expect(meta.statusError).toBeNull();
    expect(meta.reportsDir).toBe("/reports");
    expect(meta.reportDelaySeconds).toBeGreaterThan(0);
  });

  test("reports watching once started", () => {
    const runtime = makeRuntime();
    runtime.start();
    expect(runtime.meta().status).toBe("watching");
    expect(runtime.meta().statusError).toBeNull();
    runtime.stop();
  });

  test("names the directory and the cause in the unavailable error", () => {
    const runtime = createCrashRuntime({
      reportsDir: "/reports",
      ensureDir: () => {
        throw new Error("EPERM");
      },
      watchDir: () => ({ close: () => {} }),
      onError: () => {},
    });
    runtime.start();

    const meta = runtime.meta();
    expect(meta.status).toBe("unavailable");
    expect(meta.statusError).toContain("/reports");
    expect(meta.statusError).toContain("EPERM");
    expect(meta.statusError).toContain("crash reporting is enabled");
  });

  test("goes unavailable when the watcher errors after starting", () => {
    const runtime = makeRuntime();
    runtime.start();
    expect(runtime.meta().status).toBe("watching");

    failWatch(new Error("ENOENT: directory removed"));

    expect(runtime.meta().status).toBe("unavailable");
    expect(runtime.meta().statusError).toContain("directory removed");
    expect(closed).toBe(1);
    expect(errors).toHaveLength(1);
  });

  test("stops ingesting after the watcher errors", async () => {
    const runtime = makeRuntime();
    runtime.start();
    failWatch(new Error("ENOENT"));

    files.set("Demo-1.ips", ips());
    emit("rename", "Demo-1.ips");
    await flush();

    expect(runtime.listFor(UDID_A)).toHaveLength(0);
  });

  test("keeps already-collected crashes readable after going unavailable", async () => {
    const runtime = makeRuntime();
    runtime.start();
    files.set("Demo-1.ips", ips());
    emit("rename", "Demo-1.ips");
    await flush();

    failWatch(new Error("ENOENT"));

    expect(runtime.meta().status).toBe("unavailable");
    expect(runtime.listFor(UDID_A)).toHaveLength(1);
  });

  test("says so when a simulator crash report will not parse", async () => {
    const runtime = makeRuntime();
    runtime.start();
    files.set("Demo-1.ips", `${JSON.stringify({ app_name: "Demo", platform: 7, bundleID: "com.example.demo", bug_type: "309" })}\nnot json\n`);

    emit("rename", "Demo-1.ips");
    await flush();

    expect(runtime.listFor(UDID_A)).toHaveLength(0);
    expect(errors.join(" ")).toContain("could not read the crash out of Demo-1.ips");
    runtime.stop();
  });

  test("gives up after repeated watch failures instead of retrying forever", async () => {
    let attempts = 0;
    const runtime = createCrashRuntime({
      reportsDir: "/reports",
      retryDelayMs: 1,
      ensureDir: () => {},
      watchDir: () => {
        attempts += 1;
        throw new Error("EPERM");
      },
      readReport: async () => "",
      readDir: async () => [],
      statFile: async () => ({ mtimeMs: 0, ino: 1 }),
      now: () => clock,
      onError: () => {},
    });

    await runtime.start();
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(attempts).toBe(7);
    expect(runtime.meta().status).toBe("unavailable");
    expect(runtime.meta().statusError).toContain("Retries are exhausted");
    runtime.stop();
  });

  test("keeps backing off when each new watcher errors as soon as it comes up", async () => {
    let attempts = 0;
    const runtime = createCrashRuntime({
      reportsDir: "/reports",
      retryDelayMs: 1,
      ensureDir: () => {},
      watchDir: (_dir, _listener, onWatchError) => {
        attempts += 1;
        queueMicrotask(() => onWatchError(new Error("EIO")));
        return { close: () => {} };
      },
      readReport: async () => "",
      readDir: async () => [],
      statFile: async () => ({ mtimeMs: 0, ino: 1 }),
      now: () => clock,
      onError: () => {},
    });

    await runtime.start();
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(attempts).toBe(7);
    expect(runtime.meta().statusError).toContain("Retries are exhausted");
    runtime.stop();
  });

  test("makes a second caller wait for the backfill already running", async () => {
    files.set("A.ips", ips({ udid: UDID_A, symbol: "One.boom()" }));
    files.set("B.ips", ips({ udid: UDID_A, symbol: "Two.boom()" }));
    const runtime = makeRuntime({ dirEntries: ["A.ips", "B.ips"], mtimes: { "A.ips": 2_000, "B.ips": 2_000 } });

    const first = runtime.start();
    await runtime.start();

    expect(runtime.listFor(UDID_A)).toHaveLength(2);
    await first;
    runtime.stop();
  });

  test("holds a request-driven start to the backoff after a failure", async () => {
    let attempts = 0;
    const runtime = createCrashRuntime({
      reportsDir: "/reports",
      retryDelayMs: 10_000,
      ensureDir: () => {},
      watchDir: () => {
        attempts += 1;
        throw new Error("EPERM");
      },
      readReport: async () => "",
      readDir: async () => [],
      statFile: async () => ({ mtimeMs: 0, ino: 1 }),
      now: () => clock,
      onError: () => {},
    });

    await runtime.start();
    for (let i = 0; i < 5; i++) await runtime.start({ deferToRetry: true });

    expect(attempts).toBe(1);
    runtime.stop();
  });

  test("clears the retry debt once a watcher comes up", async () => {
    let attempts = 0;
    let fail = true;
    let onError: ((error: unknown) => void) | undefined;
    const runtime = createCrashRuntime({
      reportsDir: "/reports",
      retryDelayMs: 1,
      ensureDir: () => {},
      watchDir: (_dir, _listener, onWatchError) => {
        attempts += 1;
        onError = onWatchError;
        if (fail) throw new Error("EPERM");
        return { close: () => {} };
      },
      readReport: async () => "",
      readDir: async () => [],
      statFile: async () => ({ mtimeMs: 0, ino: 1 }),
      now: () => clock,
      onError: () => {},
    });

    await runtime.start();
    await new Promise((resolve) => setTimeout(resolve, 60));
    fail = false;
    await runtime.start();
    expect(runtime.meta().status).toBe("watching");

    clock += 10 * 60_000;
    const attemptsBefore = attempts;
    onError!(new Error("ENOENT"));
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(attempts).toBeGreaterThan(attemptsBefore);
    expect(runtime.meta().statusError ?? "").not.toContain("Retries are exhausted");
    runtime.stop();
  });

  test("recovers on a restart after a failure", () => {
    const runtime = makeRuntime();
    runtime.start();
    failWatch(new Error("ENOENT"));
    expect(runtime.meta().status).toBe("unavailable");

    runtime.start();
    expect(runtime.meta().status).toBe("watching");
    expect(runtime.meta().statusError).toBeNull();
    runtime.stop();
  });
});

describe("createCrashRuntime arm", () => {
  test("arm fixes the cutoff before start", async () => {
    let touchedFilesystem = false;
    const runtime = createCrashRuntime({
      reportsDir: "/reports",
      retryDelayMs: 10_000,
      ensureDir: () => {
        touchedFilesystem = true;
      },
      watchDir: (_dir, listener) => {
        touchedFilesystem = true;
        emit = listener;
        return { close: () => {} };
      },
      readReport: async (path) => files.get(path.replace("/reports/", "")) ?? "",
      readDir: async () => ["Demo-1.ips"],
      statFile: async () => ({ mtimeMs: 1_200, ino: 1 }),
      now: () => clock,
      onError: () => {},
    });
    files.set("Demo-1.ips", ips());

    clock = 1_000;
    runtime.arm();
    expect(touchedFilesystem).toBe(false);
    expect(runtime.meta().status).toBe("idle");

    clock = 5_000;
    await runtime.start();
    await flush();

    expect(runtime.listFor(UDID_A)).toHaveLength(1);
    runtime.stop();
  });
});

describe("createCrashRuntime log tail", () => {
  const CRASH_AT = "2026-08-04 23:14:07.8433 -0700";
  const crashMs = Date.parse(CRASH_AT);
  const appLine = (message: string, processID = 1): string =>
    JSON.stringify({ processImagePath: "/x/Demo.app/Demo", processID, m: message });
  const daemonLine = (message: string): string =>
    JSON.stringify({ processImagePath: "/usr/libexec/SpringBoard", m: message });

  class FakeLogChild extends EventEmitter {
    readonly stdout = new EventEmitter() as EventEmitter & { destroy: () => void };
    readonly stderr = new EventEmitter();
    constructor() {
      super();
      this.stdout.destroy = () => {};
    }
    kill(): boolean {
      return true;
    }
    emitLines(text: string): void {
      this.stdout.emit("data", Buffer.from(text));
    }
  }

  function warmRing(lines: { at: number; raw: string }[]) {
    let child: FakeLogChild | undefined;
    let ringClock = 0;
    const cache = createLogBufferCache({
      spawnLogStream: () => {
        child = new FakeLogChild();
        return child as unknown as ChildProcess;
      },
      maxBytes: 1 << 20,
      restartDelayMs: 1000,
      now: () => ringClock,
    });
    cache.ensure(UDID_A);
    for (const line of lines) {
      ringClock = line.at;
      child?.emitLines(line.raw + "\n");
    }
    return cache;
  }

  function runtimeWithRing(cache: ReturnType<typeof createLogBufferCache>) {
    return createCrashRuntime({
      reportsDir: "/reports",
      ensureDir: () => {},
      watchDir: (_dir, listener) => {
        emit = listener;
        return { close: () => {} };
      },
      readReport: async () => files.get("Demo-1.ips") ?? "",
      readDir: async () => [],
      statFile: async () => ({ mtimeMs: 0, ino: 1 }),
      now: () => clock,
      onError: (message) => errors.push(message),
      logBuffers: cache,
    });
  }

  test("leaves out another running instance of the same app", async () => {
    const cache = warmRing([
      { at: crashMs - 1_500, raw: appLine("earlier launch still running", 2) },
      { at: crashMs - 500, raw: appLine("about to abort") },
    ]);
    const runtime = runtimeWithRing(cache);
    await runtime.start();
    files.set("Demo-1.ips", ips({ capturedAt: CRASH_AT }));

    emit("rename", "Demo-1.ips");
    await flush();

    const tail = runtime.listFor(UDID_A)[0]!;
    const detail = runtime.getFor(UDID_A, tail.id)!;
    expect(detail.occurrences[0]!.logTail.map((raw) => JSON.parse(raw).m)).toEqual(["about to abort"]);
    runtime.stop();
  });

  test("keeps the crashed app's lines from before the crash, not the teardown after", async () => {
    const cache = warmRing([
      { at: crashMs - 2_000, raw: appLine("hermes bytecode mismatch") },
      { at: crashMs - 1_000, raw: daemonLine("scene for /x/Demo.app/Demo") },
      { at: crashMs - 500, raw: appLine("about to abort") },
      { at: crashMs + 4_000, raw: appLine("teardown after the crash") },
    ]);
    const runtime = runtimeWithRing(cache);
    await runtime.start();
    files.set("Demo-1.ips", ips({ capturedAt: CRASH_AT }));

    emit("rename", "Demo-1.ips");
    await flush();

    const record = runtime.listFor(UDID_A)[0];
    expect(record?.logTailSource).toBe("app-windowed");
    expect(record?.occurrences.at(-1)?.logTail).toEqual([
      appLine("hermes bytecode mismatch"),
      appLine("about to abort"),
    ]);
    runtime.stop();
    cache.stopAll();
  });

  test("reports that the ring had rolled past a crash it cannot cover", async () => {
    const cache = warmRing([{ at: crashMs + 9_000, raw: appLine("later") }]);
    const runtime = runtimeWithRing(cache);
    await runtime.start();
    files.set("Demo-1.ips", ips({ capturedAt: CRASH_AT }));

    emit("rename", "Demo-1.ips");
    await flush();

    const record = runtime.listFor(UDID_A)[0];
    expect(record?.occurrences.at(-1)?.logTail).toEqual([]);
    expect(record?.logTailSource).toBe("buffer-rolled-past");
    runtime.stop();
    cache.stopAll();
  });

  test("records no tail rather than teardown chatter when the crash time will not parse", async () => {
    const cache = warmRing([{ at: 1, raw: appLine("newest") }]);
    const runtime = runtimeWithRing(cache);
    await runtime.start();
    files.set("Demo-1.ips", ips({ capturedAt: "not a date" }));

    emit("rename", "Demo-1.ips");
    await flush();

    expect(runtime.listFor(UDID_A)[0]?.occurrences.at(-1)?.logTail).toEqual([]);
    expect(runtime.listFor(UDID_A)[0]?.logTailSource).toBe("none");
    runtime.stop();
    cache.stopAll();
  });

  test("records no tail when nothing warmed a buffer for the device", async () => {
    const runtime = runtimeWithRing(createLogBufferCache());
    await runtime.start();
    files.set("Demo-1.ips", ips());

    emit("rename", "Demo-1.ips");
    await flush();

    expect(runtime.listFor(UDID_A)[0]?.logTailSource).toBe("none");
    runtime.stop();
  });
});


test("a report read from a stopped generation cannot enter the replacement store", async () => {
  const pending = Promise.withResolvers<string>();
  let emit: Emit = () => {};
  let reads = 0;
  const runtime = createCrashRuntime({
    ensureDir: () => {},
    watchDir: (_dir, listener) => { emit = listener; return { close: () => {} }; },
    readDir: async () => [],
    readReport: () => ++reads === 1 ? pending.promise : Promise.resolve(ips()),
    statFile: async () => ({ mtimeMs: 0, ino: 1 }),
    onError: () => {},
  });
  try {
    await runtime.start();
    emit("rename", "generation-test.ips");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reads).toBe(1);
    runtime.stop();
    await runtime.start();
    pending.resolve(ips());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.listFor(UDID_A)).toEqual([]);
    emit("rename", "generation-test.ips");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.listFor(UDID_A)).toHaveLength(1);
  } finally { runtime.stop(); }
});
