import { describe, expect, test } from "bun:test";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";
import {
  createForegroundTrackerCache,
  frontmostAppFromRecentLogs,
  frontmostAppOf,
  isUserFacingBundle,
  parseForegroundAppLogMessage,
  type ForegroundApp,
} from "../foreground-tracker";
import { withShimsAsync } from "./helpers";

test("history lookup keeps the latest app after more than 16 MiB of logs", async () => {
  await withShimsAsync({
    xcrun: `#!/usr/bin/env bun
const old = JSON.stringify({ eventMessage: "[app<com.example.old>:10] Setting process visibility to: Foreground" }) + "\\n";
process.stdout.write(old.repeat(200000));
process.stdout.write(JSON.stringify({ eventMessage: "[app<com.example.current>:42] Setting process visibility to: Foreground" }) + "\\n");
`,
  }, async () => {
    expect(await frontmostAppFromRecentLogs("FAKE-DEVICE")).toEqual({ bundleId: "com.example.current", pid: 42 });
  });
});

test("history lookup reports no app when the latest visible app went to the background", async () => {
  await withShimsAsync({
    xcrun: `#!/usr/bin/env bun
for (const state of ["Foreground", "Background"]) {
  console.log(JSON.stringify({ eventMessage: "[app<com.example.app>:42] Setting process visibility to: " + state }));
}
`,
  }, async () => {
    expect(await frontmostAppFromRecentLogs("FAKE-DEVICE")).toBeNull();
  });
});

test("a helper app from AX falls back to the latest visible app in recent history", async () => {
  const app = await frontmostAppOf("FAKE-DEVICE", {
    viaAx: async () => ({ bundleId: "com.apple.iMessageAppsViewService", pid: 7 }),
    fromLogs: async () => ({ bundleId: "com.apple.MobileSMS", pid: 8 }),
  });
  expect(app).toEqual({ bundleId: "com.apple.MobileSMS", pid: 8 });
});

// A fake `log stream` child: an EventEmitter with a writable-looking stdout, driven by emitting
// `data` chunks. Lets the tracker run without a booted simulator.
function fakeChild() {
  const stdout = Object.assign(new EventEmitter(), { destroy() {} });
  return Object.assign(new EventEmitter(), {
    stdout,
    killed: false,
    kill() {
      this.killed = true;
      return true;
    },
  });
}

function logChunk(bundleId: string, pid: number, visibility = "Foreground"): Buffer {
  const eventMessage = `[app<${bundleId}>:${pid}] Setting process visibility to: ${visibility}`;
  return Buffer.from(JSON.stringify({ eventMessage }) + "\n");
}

function trackerWithFakeStream(restartDelayMs = 1000) {
  const children: ReturnType<typeof fakeChild>[] = [];
  const cache = createForegroundTrackerCache({
    spawnLogStream: () => {
      const child = fakeChild();
      children.push(child);
      return child as unknown as ChildProcess;
    },
    frontmostApp: async () => null, // no AX seed in tests; drive foreground purely from the feed
    restartDelayMs,
  });
  return { cache, children };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("parseForegroundAppLogMessage", () => {
  test("extracts the bundle id and pid from a foreground line", () => {
    expect(
      parseForegroundAppLogMessage(
        "[app<com.apple.mobilesafari>:43117] Setting process visibility to: Foreground",
      ),
    ).toEqual({ bundleId: "com.apple.mobilesafari", pid: 43117 });
  });

  test("returns null for non-foreground lines", () => {
    expect(parseForegroundAppLogMessage("Setting process visibility to: Background")).toBeNull();
  });
});

describe("isUserFacingBundle", () => {
  test("keeps regular apps, drops widgets/extensions/services", () => {
    expect(isUserFacingBundle("com.apple.mobilesafari")).toBe(true);
    expect(isUserFacingBundle("dev.expo.MyApp")).toBe(true);
    expect(isUserFacingBundle("com.apple.WidgetRenderer")).toBe(false);
    expect(isUserFacingBundle("dev.expo.MyApp.extension")).toBe(false);
    expect(isUserFacingBundle("com.apple.iMessageAppsViewService")).toBe(false);
    // Generic names only match as whole components, so real apps that merely contain them stay in.
    expect(isUserFacingBundle("com.example.CustomerService")).toBe(true);
    expect(isUserFacingBundle("com.acme.InCallUITest")).toBe(true);
    expect(isUserFacingBundle("com.apple.foo.Service")).toBe(false);
  });
});

describe("createForegroundTrackerCache", () => {
  test("tracks the latest user-facing app from the log feed", () => {
    const { cache, children } = trackerWithFakeStream();
    const seen: ForegroundApp[] = [];
    const sub = cache.subscribe("UDID", (app) => seen.push(app));

    children[0]!.stdout.emit("data", logChunk("dev.expo.A", 11));

    expect(cache.peek("UDID")).toEqual({ bundleId: "dev.expo.A", pid: 11 });
    expect(seen).toEqual([{ bundleId: "dev.expo.A", pid: 11 }]);
    sub.unsubscribe();
  });

  test("ignores non-user-facing bundles and exact repeats, but tracks a same-bundle relaunch", () => {
    const { cache, children } = trackerWithFakeStream();
    const seen: ForegroundApp[] = [];
    const sub = cache.subscribe("UDID", (app) => seen.push(app));
    const child = children[0]!;

    child.stdout.emit("data", logChunk("dev.expo.A", 11));
    child.stdout.emit("data", logChunk("dev.expo.A", 11)); // exact repeat -> ignored
    child.stdout.emit("data", logChunk("com.apple.WidgetRenderer", 99)); // non-UI -> ignored
    child.stdout.emit("data", logChunk("dev.expo.A", 12)); // same bundle, new pid (relaunch) -> tracked
    child.stdout.emit("data", logChunk("dev.expo.B", 22));

    expect(seen).toEqual([
      { bundleId: "dev.expo.A", pid: 11 },
      { bundleId: "dev.expo.A", pid: 12 },
      { bundleId: "dev.expo.B", pid: 22 },
    ]);
    sub.unsubscribe();
  });

  test("clears the app when it goes to the background or its visibility becomes unknown", () => {
    for (const visibility of ["Background", "Unknown"]) {
      const { cache, children } = trackerWithFakeStream();
      const seen: ForegroundApp[] = [];
      const sub = cache.subscribe("UDID", (app) => seen.push(app));

      children[0]!.stdout.emit("data", logChunk("dev.expo.A", 11));
      children[0]!.stdout.emit("data", logChunk("dev.expo.A", 11, visibility));

      expect(cache.peek("UDID")).toBeNull();
      expect(seen).toEqual([{ bundleId: "dev.expo.A", pid: 11 }]);
      sub.unsubscribe();
    }
  });

  test("keeps the new app when the old app or an old process of the same app backgrounds after it", () => {
    const { cache, children } = trackerWithFakeStream();
    const sub = cache.subscribe("UDID");
    const child = children[0]!;

    child.stdout.emit("data", logChunk("dev.expo.A", 11));
    child.stdout.emit("data", logChunk("dev.expo.B", 22));
    child.stdout.emit("data", logChunk("dev.expo.A", 11, "Background"));
    child.stdout.emit("data", logChunk("com.apple.iMessageAppsViewService", 33));
    expect(cache.peek("UDID")).toEqual({ bundleId: "dev.expo.B", pid: 22 });

    child.stdout.emit("data", logChunk("dev.expo.B", 44));
    child.stdout.emit("data", logChunk("dev.expo.B", 22, "Background"));
    expect(cache.peek("UDID")).toEqual({ bundleId: "dev.expo.B", pid: 44 });
    sub.unsubscribe();
  });

  test("tells listeners again when a backgrounded app comes back", () => {
    const { cache, children } = trackerWithFakeStream();
    const seen: ForegroundApp[] = [];
    const sub = cache.subscribe("UDID", (app) => seen.push(app));
    const child = children[0]!;

    child.stdout.emit("data", logChunk("dev.expo.A", 11));
    child.stdout.emit("data", logChunk("dev.expo.A", 11, "Background"));
    child.stdout.emit("data", logChunk("dev.expo.A", 11));

    expect(cache.peek("UDID")).toEqual({ bundleId: "dev.expo.A", pid: 11 });
    expect(seen).toEqual([{ bundleId: "dev.expo.A", pid: 11 }, { bundleId: "dev.expo.A", pid: 11 }]);
    sub.unsubscribe();
  });

  test("a slow AX seed does not bring back an app the log already cleared", async () => {
    let seed!: (app: ForegroundApp | null) => void;
    const children: ReturnType<typeof fakeChild>[] = [];
    const cache = createForegroundTrackerCache({
      spawnLogStream: () => {
        const child = fakeChild();
        children.push(child);
        return child as unknown as ChildProcess;
      },
      frontmostApp: () => new Promise((resolve) => { seed = resolve; }),
    });
    const sub = cache.subscribe("UDID");

    children[0]!.stdout.emit("data", logChunk("dev.expo.A", 11));
    children[0]!.stdout.emit("data", logChunk("dev.expo.A", 11, "Background"));
    seed({ bundleId: "dev.expo.A", pid: 11 });
    await tick();

    expect(cache.peek("UDID")).toBeNull();
    sub.unsubscribe();
  });

  test("respawns the log stream when it exits while subscribers remain", async () => {
    const { cache, children } = trackerWithFakeStream(0);
    const sub = cache.subscribe("UDID");
    expect(children).toHaveLength(1);

    children[0]!.emit("exit"); // the stream died unexpectedly
    await tick();
    expect(children).toHaveLength(2); // respawned so tracking recovers
    sub.unsubscribe();
  });

  test("does not respawn after an intentional stop", async () => {
    const { cache, children } = trackerWithFakeStream(0);
    const sub = cache.subscribe("UDID");
    sub.unsubscribe(); // last listener -> stop()

    children[0]!.emit("exit");
    await tick();
    expect(children).toHaveLength(1); // no respawn once stopped
  });

  test("ref-counts duplicate callbacks independently", () => {
    const { cache, children } = trackerWithFakeStream();
    const callback = () => {};
    const a = cache.subscribe("UDID", callback);
    const b = cache.subscribe("UDID", callback); // same reference
    expect(children).toHaveLength(1);

    a.unsubscribe();
    expect(children[0]!.killed).toBe(false); // b still active despite the shared callback
    b.unsubscribe();
    expect(children[0]!.killed).toBe(true);
  });

  test("shares one log stream per udid and stops it on last unsubscribe", () => {
    const { cache, children } = trackerWithFakeStream();
    const a = cache.subscribe("UDID");
    const b = cache.subscribe("UDID");
    expect(children).toHaveLength(1); // one shared tail

    a.unsubscribe();
    expect(children[0]!.killed).toBe(false); // still alive for b
    b.unsubscribe();
    expect(children[0]!.killed).toBe(true); // stopped with the last subscriber
    expect(cache.peek("UDID")).toBeNull(); // evicted
  });
});
