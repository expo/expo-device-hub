import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DeviceSession } from "../device-session";
import { HID_USAGE_BY_CODE } from "../client/utils/hid";
import { withShimsAsync } from "./helpers";

const ControlLeft = HID_USAGE_BY_CODE.ControlLeft!;
const MetaLeft = HID_USAGE_BY_CODE.MetaLeft!;
const KeyV = HID_USAGE_BY_CODE.KeyV!;
const KeyC = HID_USAGE_BY_CODE.KeyC!;

type KeyCall = [type: "down" | "up", usage: number];

// Only the fields the paste chord touches; the rest of the session needs a real simulator.
function session(failOn?: (call: KeyCall) => boolean, udid = "SESSION-TEST") {
  const calls: KeyCall[] = [];
  const s = Object.create(DeviceSession.prototype) as DeviceSession;
  const hid = {
    inputUnavailable: false,
    async key(type: "down" | "up", usage: number) {
      if (failOn?.([type, usage])) throw new Error("HID failed");
      calls.push([type, usage]);
    },
  };
  Object.assign(s, {
    udid,
    phase: "running",
    hidSockets: new Set<object>(),
    admittedHidSockets: new Set<object>(),
    detachedHidSockets: new WeakSet<object>(),
    overloadedHidSockets: new WeakSet<object>(),
    inputOperationQueues: new Map(),
    scheduledInputSockets: new Set<object>(),
    inputSocketOrder: [],
    inputStateWaiters: new Set(),
    inputQueueDraining: false,
    restoreHardwareKeyboardWhenIdle: false,
    serverInput: { send() {}, on() {}, close() {} },
    activeHidKeyUsages: new WeakMap<object, Set<number>>(),
    activeHidKeyUsageCounts: new Map<number, number>(),
    hid,
  });
  const internals = s as unknown as {
    hidSockets: Set<object>;
    activeHidKeyUsages: WeakMap<object, Set<number>>;
    activeHidKeyUsageCounts: Map<number, number>;
    updateHidKey(ws: object, type: "down" | "up", usage: number): Promise<void>;
    sendPasteShortcut(ws: object): Promise<void>;
    sendCommandShortcut(code: "KeyV" | "KeyC", ws: object | null): Promise<void>;
    queueInputOperation(ws: object, run: () => Promise<void>): Promise<void> | null;
    copyPasteboard(): Promise<{ text: string }>;
  };
  const viewer = () => {
    const ws = {};
    internals.hidSockets.add(ws);
    internals.activeHidKeyUsages.set(ws, new Set());
    return ws;
  };
  return { calls, hid, internals, viewer };
}

describe("sendPasteShortcut", () => {
  test("lifts a modifier another viewer holds and keeps its owner", async () => {
    const { calls, internals, viewer } = session();
    const a = viewer();
    const b = viewer();
    await internals.updateHidKey(a, "down", ControlLeft);
    calls.length = 0;

    await internals.sendPasteShortcut(b);

    expect(calls).toEqual([
      ["up", ControlLeft],
      ["down", MetaLeft],
      ["down", KeyV],
      ["up", KeyV],
      ["up", MetaLeft],
      ["down", ControlLeft],
    ]);
    expect(internals.activeHidKeyUsageCounts.get(ControlLeft)).toBe(1);
    expect(internals.activeHidKeyUsages.get(a)?.has(ControlLeft)).toBe(true);
    expect(internals.activeHidKeyUsages.get(b)?.size).toBe(0);

    // A's later release still reaches the simulator.
    calls.length = 0;
    await internals.updateHidKey(a, "up", ControlLeft);
    expect(calls).toEqual([["up", ControlLeft]]);
  });

  test("lifts a modifier two viewers share", async () => {
    const { calls, internals, viewer } = session();
    const a = viewer();
    const b = viewer();
    await internals.updateHidKey(a, "down", ControlLeft);
    await internals.updateHidKey(b, "down", ControlLeft);
    calls.length = 0;

    await internals.sendPasteShortcut(b);

    expect(calls[0]).toEqual(["up", ControlLeft]);
    expect(calls.at(-1)).toEqual(["down", ControlLeft]);
    expect(internals.activeHidKeyUsageCounts.get(ControlLeft)).toBe(2);
  });

  test("uses another viewer's Command instead of pressing it again", async () => {
    const { calls, internals, viewer } = session();
    const a = viewer();
    const b = viewer();
    await internals.updateHidKey(a, "down", MetaLeft);
    calls.length = 0;

    await internals.sendPasteShortcut(b);

    expect(calls).toEqual([
      ["down", KeyV],
      ["up", KeyV],
    ]);
  });

  test("taps V again when another viewer holds it, without typing another v", async () => {
    const { calls, internals, viewer } = session();
    const a = viewer();
    const b = viewer();
    await internals.updateHidKey(a, "down", KeyV);
    calls.length = 0;

    await internals.sendPasteShortcut(b);

    expect(calls).toEqual([
      ["up", KeyV],
      ["down", MetaLeft],
      ["down", KeyV],
      ["up", KeyV],
      ["up", MetaLeft],
    ]);
    expect(internals.activeHidKeyUsageCounts.get(KeyV)).toBe(1);
    expect(internals.activeHidKeyUsages.get(a)?.has(KeyV)).toBe(true);
    expect(internals.activeHidKeyUsages.get(b)?.has(KeyV)).toBe(false);

    // A's next press reaches the simulator, and so does its release.
    calls.length = 0;
    await internals.updateHidKey(a, "down", KeyV);
    await internals.updateHidKey(a, "up", KeyV);
    expect(calls).toEqual([["down", KeyV], ["up", KeyV]]);
  });

  test("puts a lifted modifier back when the chord fails", async () => {
    const { calls, internals, viewer } = session(([type, usage]) => type === "down" && usage === KeyV);
    const a = viewer();
    const b = viewer();
    await internals.updateHidKey(a, "down", ControlLeft);
    calls.length = 0;

    await expect(internals.sendPasteShortcut(b)).rejects.toThrow("HID failed");

    expect(calls.at(-1)).toEqual(["down", ControlLeft]);
    expect(internals.activeHidKeyUsageCounts.get(ControlLeft)).toBe(1);
  });
});

describe("copy shortcut", () => {
  test("lifts another viewer's modifier and leaves no key owned", async () => {
    const { calls, internals, viewer } = session();
    const a = viewer();
    await internals.updateHidKey(a, "down", ControlLeft);
    calls.length = 0;

    await internals.sendCommandShortcut("KeyC", null);

    expect(calls).toEqual([
      ["up", ControlLeft],
      ["down", MetaLeft],
      ["down", KeyC],
      ["up", KeyC],
      ["up", MetaLeft],
      ["down", ControlLeft],
    ]);
    expect([...internals.activeHidKeyUsageCounts]).toEqual([[ControlLeft, 1]]);
  });

  test("releases its own Command when the chord fails", async () => {
    const { calls, internals, viewer } = session(([type, usage]) => type === "down" && usage === KeyC);
    const a = viewer();
    await internals.updateHidKey(a, "down", ControlLeft);
    calls.length = 0;

    await expect(internals.sendCommandShortcut("KeyC", null)).rejects.toThrow("HID failed");

    expect(calls).toEqual([
      ["up", ControlLeft],
      ["down", MetaLeft],
      ["up", MetaLeft],
      ["down", ControlLeft],
    ]);
  });

});

describe("copyPasteboard", () => {
  // A one-slot simulator pasteboard behind a fake xcrun; pbpaste can be slowed down.
  async function withPasteboard(text: string, pbpasteDelay: string, run: (udid: string) => Promise<void>) {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-copy-turn-test-"));
    const board = join(dir, "pasteboard");
    writeFileSync(board, text);
    const xcrun = `#!/bin/sh\nif [ "$2" = pbpaste ]; then sleep ${pbpasteDelay}; cat '${board}'; fi\n`;
    try {
      await withShimsAsync({ xcrun }, () => run(`COPY-TURN-TEST-${process.pid}-${Math.random()}`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("waits for input a viewer already queued", async () => {
    await withPasteboard("copied", "0", async (udid) => {
      const { calls, internals, viewer } = session(undefined, udid);
      const order: string[] = [];
      const a = viewer();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const earlier = internals.queueInputOperation(a, async () => {
        order.push("viewer input");
        await gate;
      });
      const copy = internals.copyPasteboard();
      await Bun.sleep(50);
      expect(calls).toEqual([]);
      release();
      await earlier;
      expect((await copy).text).toBe("copied");
      expect(order).toEqual(["viewer input"]);
      expect(calls[0]).toEqual(["down", MetaLeft]);
    });
  });

  test("lets other input run while it reads", async () => {
    await withPasteboard("copied", "0.8", async (udid) => {
      const { internals, viewer } = session(undefined, udid);
      const b = viewer();
      let copyDone = false;
      const copy = internals.copyPasteboard().then((result) => {
        copyDone = true;
        return result;
      });
      await Bun.sleep(300); // shortcut and settle are done; pbpaste runs for 0.8 s more
      const queuedAt = performance.now();
      await internals.queueInputOperation(b, async () => {});
      expect(performance.now() - queuedAt).toBeLessThan(200);
      expect(copyDone).toBe(false);
      expect((await copy).text).toBe("copied");
    });
  });

  test("refuses when simulator input is unavailable", async () => {
    const { calls, hid, internals } = session();
    hid.inputUnavailable = true;
    await expect(internals.copyPasteboard()).rejects.toThrow("Simulator input is unavailable");
    expect(calls).toEqual([]);
  });

  test("sends nothing if the session stops while the copy waits", async () => {
    const { calls, internals, viewer } = session();
    const a = viewer();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const earlier = internals.queueInputOperation(a, () => gate);
    const copy = internals.copyPasteboard();
    (internals as unknown as { phase: string }).phase = "stopped";
    release();
    await earlier;
    await expect(copy).rejects.toThrow("Simulator input is unavailable");
    expect(calls).toEqual([]);
  });
});
