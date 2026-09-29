import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DeviceSession } from "../device-session";
import { NativeHid } from "../native";
import { HID_USAGE_BY_CODE } from "../client/utils/hid";
import { PasteboardCopyTimeoutError, copyFromSim } from "../sim-pasteboard-copy";
import { withSimPasteboardLock } from "../sim-pasteboard";
import { withShimsAsync } from "./helpers";

const ControlLeft = HID_USAGE_BY_CODE.ControlLeft!;
const MetaLeft = HID_USAGE_BY_CODE.MetaLeft!;
const KeyV = HID_USAGE_BY_CODE.KeyV!;
const KeyC = HID_USAGE_BY_CODE.KeyC!;

type KeyCall = [type: "down" | "up", usage: number];

// Only the fields the paste chord touches; the rest of the session needs a real simulator.
function session(failOn?: (call: KeyCall) => boolean, udid = "SESSION-TEST", onKey?: (call: KeyCall) => void) {
  const calls: KeyCall[] = [];
  const s = Object.create(DeviceSession.prototype) as DeviceSession;
  const hid = {
    inputUnavailable: false,
    async key(type: "down" | "up", usage: number) {
      if (failOn?.([type, usage])) throw new Error("HID failed");
      calls.push([type, usage]);
    },
    async keyChecked(type: "down" | "up", usage: number) {
      if (failOn?.([type, usage])) throw new Error("HID failed");
      calls.push([type, usage]);
      onKey?.([type, usage]);
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
    pendingOrderedMessages: new WeakMap(),
    inFlightOrderedMessages: new WeakMap(),
    failedInputSockets: new WeakSet(),
    cleanedUpHidSockets: new WeakSet(),
    activeTouches: new WeakMap(),
    activeMultiTouches: new WeakMap(),
    axHandledKeyUsages: new WeakMap(),
    inputQueueDraining: false,
    softwareKeyboardSync: Promise.resolve(),
    restoreHardwareKeyboardWhenIdle: false,
    serverInput: { send() {}, on() {}, close() {} },
    activeHidKeyUsages: new WeakMap<object, Set<number>>(),
    activeHidKeyUsageCounts: new Map<number, number>(),
    hid,
  });
  const internals = s as unknown as {
    hidSockets: Set<object>;
    serverInput: object;
    activeHidKeyUsages: WeakMap<object, Set<number>>;
    activeHidKeyUsageCounts: Map<number, number>;
    updateHidKey(ws: object, type: "down" | "up", usage: number): Promise<void>;
    sendPasteShortcut(ws: object): Promise<string | null>;
    sendCommandShortcut(code: "KeyV" | "KeyC", ws: object | null): Promise<string | null>;
    queueInputOperation(ws: object, run: () => Promise<void>): Promise<void> | null;
    detachHidSocket(ws: object): void;
    copyPasteboard(): Promise<{ text: string }>;
  };
  internals.activeHidKeyUsages.set(internals.serverInput, new Set());
  const viewer = () => {
    const ws = {};
    internals.hidSockets.add(ws);
    internals.activeHidKeyUsages.set(ws, new Set());
    return ws;
  };
  return { calls, hid, internals, viewer };
}

test("checked shortcut keys surface a native rejection while ordinary input remains guarded", async () => {
  const hid = Object.create(NativeHid.prototype) as NativeHid;
  Object.assign(hid, {
    handle: { key: () => Promise.reject(new Error("native key rejected")) },
    setupFailed: false,
  });
  const previousError = console.error;
  console.error = () => {};
  try {
    await expect(hid.key("down", KeyV)).resolves.toBeUndefined();
    await expect(hid.keyChecked("down", KeyV)).rejects.toThrow("native key rejected");
  } finally {
    console.error = previousError;
  }
});

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

  test("restores another viewer's held V when the chord fails before the tap", async () => {
    const { calls, internals, viewer } = session(([type, usage]) => type === "down" && usage === MetaLeft);
    const a = viewer();
    const b = viewer();
    await internals.updateHidKey(a, "down", KeyV);
    calls.length = 0;

    await expect(internals.sendPasteShortcut(b)).rejects.toThrow("HID failed");

    expect(calls).toEqual([["up", KeyV], ["down", KeyV]]);
    expect(internals.activeHidKeyUsageCounts.get(KeyV)).toBe(1);
  });

  test("does not confirm a paste when V-up fails", async () => {
    const { calls, internals, viewer } = session(([type, usage]) => type === "up" && usage === KeyV);
    const b = viewer();

    await expect(internals.sendPasteShortcut(b)).rejects.toThrow("HID failed");

    expect(calls).toContainEqual(["down", KeyV]);
    expect(calls).toContainEqual(["up", MetaLeft]);
  });

  test("does not press held V twice when V-up fails", async () => {
    const { calls, internals, viewer } = session(([type, usage]) => type === "up" && usage === KeyV && calls.length > 1);
    const a = viewer();
    const b = viewer();
    await internals.updateHidKey(a, "down", KeyV);
    calls.length = 0;

    await expect(internals.sendPasteShortcut(b)).rejects.toThrow("HID failed");

    expect(calls.filter(([type, usage]) => type === "down" && usage === KeyV)).toHaveLength(1);
  });

  test("releases the viewer's Command when the chord fails", async () => {
    const { calls, internals, viewer } = session(([type, usage]) => type === "down" && usage === KeyV);
    const b = viewer();

    await expect(internals.sendPasteShortcut(b)).rejects.toThrow("HID failed");

    expect(calls).toEqual([
      ["down", MetaLeft],
      ["up", MetaLeft],
    ]);
    expect(internals.activeHidKeyUsages.get(b)?.size).toBe(0);
    expect(internals.activeHidKeyUsageCounts.has(MetaLeft)).toBe(false);

    // The viewer's next key is a plain key, not a Command shortcut.
    calls.length = 0;
    await internals.updateHidKey(b, "down", KeyC);
    expect(calls).toEqual([["down", KeyC]]);
    expect(internals.activeHidKeyUsageCounts.has(MetaLeft)).toBe(false);
  });

  test("retries a failed Command release without failing an already completed paste", async () => {
    let releases = 0;
    const { calls, internals, viewer } = session(([type, usage]) =>
      type === "up" && usage === MetaLeft && ++releases === 1);
    const b = viewer();

    expect(await internals.sendPasteShortcut(b)).toBeNull();
    expect(releases).toBe(2);
    expect(calls.slice(-2)).toEqual([["up", KeyV], ["up", MetaLeft]]);
    expect(internals.activeHidKeyUsageCounts.has(MetaLeft)).toBe(false);
  });

  test("reports a separate warning if Command remains held after retry", async () => {
    let releases = 0;
    const { calls, internals, viewer } = session(([type, usage]) => {
      if (type === "up" && usage === MetaLeft) {
        releases++;
        return true;
      }
      return false;
    });
    const b = viewer();

    expect(await internals.sendPasteShortcut(b)).toContain("key may still be held");
    expect(releases).toBe(2);
    expect(calls).toContainEqual(["up", KeyV]);
    expect(calls).not.toContainEqual(["up", MetaLeft]);
    expect(internals.activeHidKeyUsageCounts.get(MetaLeft)).toBe(1);
    expect(internals.activeHidKeyUsages.get(b)?.has(MetaLeft)).toBe(true);
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

test("shortcut-only paste uses the session's HID chord and returns its cleanup warning", async () => {
  const { internals, viewer } = session();
  const ws = viewer() as { send(message: Buffer): void };
  const replies: Buffer[] = [];
  ws.send = (message) => replies.push(message);
  let shortcuts = 0;
  const handler = internals as typeof internals & {
    handleHidMessage(data: Buffer, ws: object): Promise<void>;
    sendPasteShortcut(ws: object): Promise<string | null>;
  };
  handler.queueInputOperation = (_ws, run) => run();
  handler.sendPasteShortcut = async () => {
    shortcuts++;
    return "A simulator key may still be held";
  };

  await handler.handleHidMessage(Buffer.concat([
    Buffer.from([0x12]), Buffer.from(JSON.stringify({ requestId: 3 })),
  ]), ws);

  expect(shortcuts).toBe(1);
  expect(replies[0]?.[0]).toBe(0x92);
  expect(JSON.parse(replies[0]!.subarray(1).toString())).toEqual({
    requestId: 3, ok: true, cleanupWarning: "A simulator key may still be held",
  });
});

test("input barrier waits for earlier keys but ignores later ones", async () => {
  const { internals, viewer } = session();
  const ws = viewer() as { send(message: Buffer): void };
  const replies: Buffer[] = [];
  ws.send = (message) => replies.push(message);
  const handler = internals as typeof internals & {
    pendingOrderedMessages: WeakMap<object, Set<Promise<void>>>;
    handleHidMessage(data: Buffer, ws: object, priorOrderedMessages?: Promise<void>[]): Promise<void>;
  };
  let finishEarlier!: () => void;
  const earlier = new Promise<void>((resolve) => { finishEarlier = resolve; });
  let finishLater!: () => void;
  const later = new Promise<void>((resolve) => { finishLater = resolve; });
  const pending = new Set([earlier]);
  handler.pendingOrderedMessages.set(ws, pending);

  const barrier = handler.handleHidMessage(Buffer.from([0x11]), ws, [...pending]);
  pending.add(later);
  finishEarlier();
  await barrier;
  expect(replies).toEqual([Buffer.from([0x91, 1])]);
  finishLater();
});

test.each([true, false])("correlates an input barrier acknowledgement (available: %s)", async (available) => {
  const { hid, internals, viewer } = session();
  hid.inputUnavailable = !available;
  const ws = viewer() as { send(message: Buffer): void };
  const replies: Buffer[] = [];
  ws.send = (message) => replies.push(message);
  const handler = internals as typeof internals & {
    handleHidMessage(data: Buffer, ws: object): Promise<void>;
  };

  await handler.handleHidMessage(Buffer.concat([
    Buffer.from([0x11]), Buffer.from(JSON.stringify({ requestId: 23 })),
  ]), ws);

  expect(replies[0]?.[0]).toBe(0x91);
  expect(JSON.parse(replies[0]!.subarray(1).toString())).toEqual({ requestId: 23, ok: available });
});

test.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("ignores an invalid input barrier ID %s", async (requestId) => {
  const { internals, viewer } = session();
  const ws = viewer() as { send(message: Buffer): void };
  const replies: Buffer[] = [];
  ws.send = (message) => replies.push(message);
  const handler = internals as typeof internals & {
    handleHidMessage(data: Buffer, ws: object): Promise<void>;
  };

  await handler.handleHidMessage(Buffer.concat([
    Buffer.from([0x11]), Buffer.from(JSON.stringify({ requestId })),
  ]), ws);

  expect(replies).toEqual([]);
});

test("a full server input queue rejects only the excess turn and recovers", async () => {
  const { internals } = session();
  let release!: () => void;
  const first = internals.queueInputOperation(internals.serverInput, () => new Promise<void>((resolve) => { release = resolve; }));
  let completed = 0;
  const queued = Array.from({ length: 1024 }, () => internals.queueInputOperation(internals.serverInput, async () => { completed++; }));
  try {
    expect(internals.queueInputOperation(internals.serverInput, async () => {})).toBeNull();
  } finally {
    release();
    await Promise.all([first, ...queued]);
  }
  expect(completed).toBe(1024);
  const next = internals.queueInputOperation(internals.serverInput, async () => { completed++; });
  expect(next).not.toBeNull();
  await next;
  expect(completed).toBe(1025);
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

  test("reports a warning when restoring another viewer's modifier fails", async () => {
    let restores = 0;
    const { internals, viewer } = session(([type, usage]) =>
      type === "down" && usage === ControlLeft && ++restores > 1);
    const a = viewer();
    await internals.updateHidKey(a, "down", ControlLeft);

    expect(await internals.sendCommandShortcut("KeyC", null)).toContain("key may still be held");
  });

  test("retains a failed Copy Command release so reconnect cleanup can retry it", async () => {
    let rejectReleases = true;
    const { calls, internals, viewer } = session(([type, usage]) =>
      rejectReleases && type === "up" && usage === MetaLeft);
    const a = viewer();

    expect(await internals.sendCommandShortcut("KeyC", null)).toContain("key may still be held");
    expect(internals.activeHidKeyUsages.get(internals.serverInput)?.has(MetaLeft)).toBe(true);
    expect(internals.activeHidKeyUsageCounts.get(MetaLeft)).toBe(1);

    rejectReleases = false;
    internals.detachHidSocket(a);
    await internals.queueInputOperation(internals.serverInput, async () => {});

    expect(calls.at(-1)).toEqual(["up", MetaLeft]);
    expect(internals.activeHidKeyUsages.get(internals.serverInput)?.size).toBe(0);
    expect(internals.activeHidKeyUsageCounts.has(MetaLeft)).toBe(false);
  });

  test("retries a server-owned Command before the next clipboard chord", async () => {
    let releases = 0;
    const { calls, internals } = session(([type, usage]) =>
      type === "up" && usage === MetaLeft && ++releases <= 2);

    expect(await internals.sendCommandShortcut("KeyC", null)).toContain("key may still be held");
    calls.length = 0;
    expect(await internals.sendCommandShortcut("KeyC", null)).toBeNull();

    expect(calls[0]).toEqual(["up", MetaLeft]);
    expect(releases).toBe(4);
    expect(internals.activeHidKeyUsageCounts.has(MetaLeft)).toBe(false);
  });

});

describe("copyPasteboard", () => {
  // A one-slot simulator pasteboard behind a fake xcrun; pbpaste can be slowed down.
  async function withPasteboard(text: string, pbpasteDelay: string, run: (udid: string, board: string, markCopy: (call: KeyCall) => void, shortcutDone: Promise<void>) => Promise<void>) {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-copy-turn-test-"));
    const board = join(dir, "pasteboard");
    const changeCount = join(dir, "change-count");
    writeFileSync(board, text);
    writeFileSync(changeCount, "0");
    const xcrun = `#!/bin/sh
if [ "$2" = get_app_container ]; then exit 1
elif [ "$2" = install ] || [ "$2" = privacy ]; then exit 0
elif [ "$5" = --snapshot ]; then printf '1\\n'; base64 < '${board}'
elif [ "$5" = --read-text ]; then sleep ${pbpasteDelay}; cat '${board}'
elif [ "$5" = --restore ]; then base64 -D > '${board}'; count=$(cat '${changeCount}'); printf '%s' "$((count + 1))" > '${changeCount}'
elif [ "$5" = --change-count ]; then cat '${changeCount}'
elif [ "$2" = pbpaste ]; then sleep ${pbpasteDelay}; cat '${board}'
else cat > '${board}'; count=$(cat '${changeCount}'); printf '%s' "$((count + 1))" > '${changeCount}'
fi
`;
    let resolveShortcut!: () => void;
    const shortcutDone = new Promise<void>((resolve) => { resolveShortcut = resolve; });
    const markCopy = ([type, usage]: KeyCall) => {
      if (type === "up" && usage === KeyC) {
        writeFileSync(board, text);
        writeFileSync(changeCount, String(Number(readFileSync(changeCount, "utf8")) + 1));
        resolveShortcut();
      }
    };
    try {
      await withShimsAsync({ xcrun }, () => run(`COPY-TURN-TEST-${process.pid}-${Math.random()}`, board, markCopy, shortcutDone));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("waits for input a viewer already queued", async () => {
    await withPasteboard("copied", "0", async (udid, _board, markCopy) => {
      const { calls, internals, viewer } = session(undefined, udid, markCopy);
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

  test("returns a key cleanup warning with copied text", async () => {
    await withPasteboard("copied", "0", async (udid, _board, markCopy) => {
      let commandReleases = 0;
      const { internals } = session(([type, usage]) =>
        type === "up" && usage === MetaLeft && ++commandReleases > 0, udid, markCopy);

      const result = await internals.copyPasteboard();
      expect(result.text).toBe("copied");
      expect((result as { cleanupWarning?: string }).cleanupWarning).toContain("key may still be held");
      expect(commandReleases).toBe(2);
    });
  });

  test("keeps another viewer's copy behind the pasteboard read", async () => {
    await withPasteboard("copied", "0.8", async (udid, board, markCopy, shortcutDone) => {
      const { internals, viewer } = session(undefined, udid, markCopy);
      const b = viewer();
      let copyDone = false;
      let viewerCopyDone = false;
      const copy = internals.copyPasteboard().then((result) => {
        copyDone = true;
        return result;
      });
      await shortcutDone;
      await Bun.sleep(100); // the 0.8 s text read is still in progress
      const viewerCopy = internals.queueInputOperation(b, async () => {
        writeFileSync(board, "newer copy");
        viewerCopyDone = true;
      });
      await Bun.sleep(50);
      expect(copyDone).toBe(false);
      expect(viewerCopyDone).toBe(false);
      expect((await copy).text).toBe("copied");
      await viewerCopy;
      expect(viewerCopyDone).toBe(true);
    });
  });

  test("refuses when simulator input is unavailable", async () => {
    const { calls, hid, internals } = session();
    hid.inputUnavailable = true;
    await expect(internals.copyPasteboard()).rejects.toThrow("Simulator input is unavailable");
    expect(calls).toEqual([]);
  });

  test("leaves the prior text untouched when Copy never updates the pasteboard", async () => {
    await withPasteboard("previous text", "0", async (udid, board) => {
      await expect(copyFromSim(udid, async () => {})).rejects.toBeInstanceOf(PasteboardCopyTimeoutError);
      expect(readFileSync(board, "utf8")).toBe("previous text");
    });
  }, 10_000);

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

  test("sends nothing if the session stops while Copy waits for the pasteboard lock", async () => {
    await withPasteboard("previous text", "0", async (udid, board) => {
      const { calls, internals } = session(undefined, udid);
      let release!: () => void;
      let acquired!: () => void;
      const locked = new Promise<void>((resolve) => { acquired = resolve; });
      const holder = withSimPasteboardLock(udid, async () => {
        acquired();
        await new Promise<void>((resolve) => { release = resolve; });
      });
      await locked;
      const copy = internals.copyPasteboard();
      (internals as unknown as { phase: string }).phase = "stopped";
      release();
      await holder;

      await expect(copy).rejects.toThrow("Simulator input is unavailable");
      expect(calls).toEqual([]);
      expect(readFileSync(board, "utf8")).toBe("previous text");
    });
  });
});
