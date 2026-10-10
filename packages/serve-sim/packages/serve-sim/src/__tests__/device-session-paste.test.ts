import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DeviceSession } from "../device-session";
import { NativeHid } from "../native";
import { HID_USAGE_BY_CODE } from "../client/utils/hid";
import { PasteboardCopyTimeoutError, copyFromSim } from "../sim-pasteboard-copy";
import { withSimPasteboardLock } from "../sim-pasteboard";
import { pasteTextIntoSim } from "../sim-pasteboard-paste";
import { withShimsAsync } from "./helpers";

const ControlLeft = HID_USAGE_BY_CODE.ControlLeft!;
const MetaLeft = HID_USAGE_BY_CODE.MetaLeft!;
const KeyV = HID_USAGE_BY_CODE.KeyV!;
const KeyA = HID_USAGE_BY_CODE.KeyA!;
const KeyC = HID_USAGE_BY_CODE.KeyC!;

type KeyCall = [type: "down" | "up", usage: number];

function session(failOn?: (call: KeyCall) => boolean, udid = "SESSION-TEST", onKey?: (call: KeyCall) => void) {
  const calls: KeyCall[] = [];
  const s = Object.create(DeviceSession.prototype) as DeviceSession;
  const key = async (type: "down" | "up", usage: number) => {
    if (failOn?.([type, usage])) throw new Error("HID failed");
    calls.push([type, usage]);
  };
  const hid = {
    inputUnavailable: false,
    key,
    async keyChecked(type: "down" | "up", usage: number) {
      await key(type, usage);
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
    sendCommandShortcut(key: number, ws: object | null): Promise<string | null>;
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

test("checked shortcut keys surface native rejection while ordinary input remains guarded", async () => {
  const hid = Object.create(NativeHid.prototype) as NativeHid;
  Object.assign(hid, {
    handle: { key: () => Promise.reject(new Error("native key rejected")) },
    setupFailed: false,
  });
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    await expect(hid.key("down", KeyV)).resolves.toBeUndefined();
    await expect(hid.keyChecked("down", KeyV)).rejects.toThrow("native key rejected");
  } finally {
    log.mockRestore();
  }
});

describe("sendPasteShortcut", () => {
  test.each(["MetaLeft", "MetaRight"])("preserves shared modifiers and reuses held %s", async (code) => {
    const { calls, internals, viewer } = session();
    const a = viewer();
    const b = viewer();
    const command = HID_USAGE_BY_CODE[code]!;
    const modifiers = ["ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight", "AltLeft", "AltRight"]
      .map((modifier) => HID_USAGE_BY_CODE[modifier]!);
    for (const usage of modifiers) {
      await internals.updateHidKey(a, "down", usage);
      await internals.updateHidKey(b, "down", usage);
    }
    await internals.updateHidKey(a, "down", command);
    calls.length = 0;

    expect(await internals.sendPasteShortcut(b)).toBeNull();
    expect(calls).toEqual([
      ...modifiers.map<KeyCall>((usage) => ["up", usage]),
      ["down", KeyV], ["up", KeyV],
      ...modifiers.map<KeyCall>((usage) => ["down", usage]),
    ]);
    expect(internals.activeHidKeyUsageCounts.get(command)).toBe(1);
    calls.length = 0;
    for (const usage of modifiers) {
      expect(internals.activeHidKeyUsageCounts.get(usage)).toBe(2);
      await internals.updateHidKey(a, "up", usage);
      expect(calls).toEqual([]);
    }
    for (const usage of modifiers) await internals.updateHidKey(b, "up", usage);
    expect(calls).toEqual(modifiers.map<KeyCall>((usage) => ["up", usage]));
    expect(internals.activeHidKeyUsages.get(b)?.size).toBe(0);
  });

  test("taps a held V without typing it again or changing its owner", async () => {
    const { calls, internals, viewer } = session();
    const a = viewer();
    const b = viewer();
    await internals.updateHidKey(a, "down", KeyV);
    calls.length = 0;

    await internals.sendPasteShortcut(b);
    expect(calls).toEqual([
      ["up", KeyV], ["down", MetaLeft], ["down", KeyV], ["up", KeyV], ["up", MetaLeft],
    ]);
    expect(internals.activeHidKeyUsageCounts.get(KeyV)).toBe(1);
    expect(internals.activeHidKeyUsages.get(a)?.has(KeyV)).toBe(true);
    expect(internals.activeHidKeyUsages.get(b)?.has(KeyV)).toBe(false);
    calls.length = 0;
    await internals.updateHidKey(a, "down", KeyV);
    await internals.updateHidKey(a, "up", KeyV);
    expect(calls).toEqual([["down", KeyV], ["up", KeyV]]);
  });

  test("restores another viewer's held V if Command fails before the tap", async () => {
    const { calls, internals, viewer } = session(([type, usage]) => type === "down" && usage === MetaLeft);
    const a = viewer();
    const b = viewer();
    await internals.updateHidKey(a, "down", KeyV);
    calls.length = 0;

    await expect(internals.sendPasteShortcut(b)).rejects.toThrow("HID failed");
    expect(calls).toEqual([["up", KeyV], ["down", KeyV]]);
    expect(internals.activeHidKeyUsageCounts.get(KeyV)).toBe(1);
  });

  test.each(["fresh", "held"])("rejects a failed V-up without repeating %s V", async (state) => {
    let presses = 0;
    const { calls, internals, viewer } = session(([type, usage]) => {
      if (type === "down" && usage === KeyV) presses++;
      return type === "up" && usage === KeyV && presses > 0;
    });
    const a = viewer();
    const b = viewer();
    if (state === "held") await internals.updateHidKey(a, "down", KeyV);
    calls.length = 0;
    presses = 0;

    await expect(internals.sendPasteShortcut(b)).rejects.toThrow("HID failed");
    expect(presses).toBe(1);
    expect(calls).toContainEqual(["up", MetaLeft]);
  });

  test("releases its Command and restores another viewer's modifier when V-down fails", async () => {
    const { calls, internals, viewer } = session(([type, usage]) => type === "down" && usage === KeyV);
    const a = viewer();
    const b = viewer();
    await internals.updateHidKey(a, "down", ControlLeft);
    calls.length = 0;

    await expect(internals.sendPasteShortcut(b)).rejects.toThrow("HID failed");
    expect(calls).toEqual([
      ["up", ControlLeft], ["down", MetaLeft], ["up", MetaLeft], ["down", ControlLeft],
    ]);
    expect(internals.activeHidKeyUsageCounts.get(ControlLeft)).toBe(1);
    expect(internals.activeHidKeyUsages.get(b)?.size).toBe(0);
    calls.length = 0;
    await internals.updateHidKey(b, "down", KeyA);
    expect(calls).toEqual([["down", KeyA]]);
    expect(internals.activeHidKeyUsageCounts.has(MetaLeft)).toBe(false);
  });

  test.each(["transient", "permanent"])("retries %s Command cleanup and warns only if it stays held", async (failure) => {
    const permanent = failure === "permanent";
    let releases = 0;
    const { internals, viewer } = session(([type, usage]) =>
      type === "up" && usage === MetaLeft && (++releases === 1 || permanent));

    const warning = await internals.sendPasteShortcut(viewer());
    if (permanent) expect(warning).toContain("key may still be held");
    else expect(warning).toBeNull();
    expect(releases).toBe(2);
    expect(internals.activeHidKeyUsageCounts.get(MetaLeft)).toBe(permanent ? 1 : undefined);
  });
});

test("input barrier waits for earlier keys but ignores later ones", async () => {
  const { calls, hid, internals } = session();
  let finishEarlier!: () => void;
  const earlier = new Promise<void>((resolve) => { finishEarlier = resolve; });
  let finishLater!: () => void;
  const later = new Promise<void>((resolve) => { finishLater = resolve; });
  const key = hid.key;
  hid.key = async (type, usage) => {
    if (type === "down") await (usage === KeyA ? earlier : later);
    await key(type, usage);
  };
  // Send through the socket's message handler so the barrier uses the production snapshot.
  const handlers = new Map<string, (data?: Buffer) => void>();
  const replies: Buffer[] = [];
  const ws = {
    send: (message: Buffer) => { replies.push(message); },
    on: (event: string, handler: (data?: Buffer) => void) => { handlers.set(event, handler); },
    close() {},
  };
  Object.assign(internals, { inFlightHidMessages: new WeakMap(), supportsHingeAngle: true, configFrame: () => null });
  (internals as unknown as { attachHidSocket(ws: object): void }).attachHidSocket(ws);
  const send = (tag: number, body?: object) =>
    handlers.get("message")!(Buffer.concat([Buffer.from([tag]), Buffer.from(body ? JSON.stringify(body) : "")]));
  const barrierReplies = () => replies.filter((reply) => reply[0] === 0x91);

  send(0x06, { type: "down", usage: KeyA });
  send(0x11);
  send(0x06, { type: "down", usage: KeyV });
  await Bun.sleep(20);
  expect(barrierReplies()).toEqual([]);

  finishEarlier();
  const deadline = Date.now() + 1000;
  while (barrierReplies().length === 0 && Date.now() < deadline) await Bun.sleep(5);
  expect(barrierReplies()).toEqual([Buffer.from([0x91, 1])]);
  expect(calls).toEqual([["down", KeyA]]);

  finishLater();
  while (calls.length < 2 && Date.now() < deadline) await Bun.sleep(5);
  expect(calls).toEqual([["down", KeyA], ["down", KeyV]]);
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

    await internals.sendCommandShortcut(KeyC, null);

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

    await expect(internals.sendCommandShortcut(KeyC, null)).rejects.toThrow("HID failed");

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

    expect(await internals.sendCommandShortcut(KeyC, null)).toContain("key may still be held");
  });

  test("retains a failed Copy Command release so reconnect cleanup can retry it", async () => {
    let rejectReleases = true;
    const { calls, internals, viewer } = session(([type, usage]) =>
      rejectReleases && type === "up" && usage === MetaLeft);
    const a = viewer();

    expect(await internals.sendCommandShortcut(KeyC, null)).toContain("key may still be held");
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

    expect(await internals.sendCommandShortcut(KeyC, null)).toContain("key may still be held");
    calls.length = 0;
    expect(await internals.sendCommandShortcut(KeyC, null)).toBeNull();

    expect(calls[0]).toEqual(["up", MetaLeft]);
    expect(releases).toBe(4);
    expect(internals.activeHidKeyUsageCounts.has(MetaLeft)).toBe(false);
  });

});

describe("copyPasteboard", () => {
  async function withPasteboard(text: string, readDelay: string, run: (udid: string, board: string, markCopy: (call: KeyCall) => void, shortcutDone: Promise<void>) => Promise<void>) {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-copy-turn-test-"));
    const board = join(dir, "pasteboard");
    const changeCount = join(dir, "change-count");
    writeFileSync(board, text);
    writeFileSync(changeCount, "0");
    const xcrun = `#!/bin/sh
if [ "$2" = get_app_container ]; then exit 1
elif [ "$2" = install ] || [ "$2" = privacy ]; then exit 0
elif [ "$5" = --read-text ]; then sleep ${readDelay}; cat '${board}'
elif [ "$5" = --change-count ]; then cat '${changeCount}'
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

  test("returns a key cleanup warning with copied text", async () => {
    await withPasteboard("copied", "0", async (udid, _board, markCopy) => {
      let commandReleases = 0;
      const { internals } = session(([type, usage]) => {
        if (type !== "up" || usage !== MetaLeft) return false;
        commandReleases++;
        return true; // Every Command release fails.
      }, udid, markCopy);

      const result = await internals.copyPasteboard();
      expect(result.text).toBe("copied");
      expect((result as { cleanupWarning?: string }).cleanupWarning).toContain("key may still be held");
      expect(commandReleases).toBe(2);
    });
  });

  test("keeps the key cleanup warning when Copy then times out", async () => {
    await withPasteboard("previous text", "0", async (udid) => {
      // No markCopy: the pasteboard never changes, so the wait times out after the chord.
      const { internals } = session(([type, usage]) => type === "up" && usage === MetaLeft, udid);

      const error = await internals.copyPasteboard().then(() => null, (reason: unknown) => reason);
      expect(error).toBeInstanceOf(PasteboardCopyTimeoutError);
      expect((error as { cleanupWarning?: string }).cleanupWarning).toContain("key may still be held");
    });
  }, 10_000);

  test("waits for earlier input and blocks later input through the pasteboard read", async () => {
    await withPasteboard("copied", "0.8", async (udid, board, markCopy, shortcutDone) => {
      const { calls, internals, viewer } = session(undefined, udid, markCopy);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const earlier = internals.queueInputOperation(viewer(), () => gate);
      const b = viewer();
      let copyDone = false;
      let viewerCopyDone = false;
      const copy = internals.copyPasteboard().then((result) => {
        copyDone = true;
        return result;
      });
      await Bun.sleep(50);
      expect(calls).toEqual([]);
      release();
      await earlier;
      await shortcutDone;
      expect(calls[0]).toEqual(["down", MetaLeft]);
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

  test("sends nothing if the session stops while the copy waits for its turn", async () => {
    await withPasteboard("previous text", "0", async (udid) => {
      const { calls, internals, viewer } = session(undefined, udid);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const earlier = internals.queueInputOperation(viewer(), () => gate);
      const copy = internals.copyPasteboard();
      const queues = (internals as unknown as { inputOperationQueues: Map<object, unknown[]> }).inputOperationQueues;
      while (!queues.get(internals.serverInput)?.length) await Bun.sleep(5);
      (internals as unknown as { phase: string }).phase = "stopped";
      release();
      await earlier;
      await expect(copy).rejects.toThrow("Simulator input is unavailable");
      expect(calls).toEqual([]);
    });
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
      await Bun.sleep(20); // past the capture wait, polling for the lock
      (internals as unknown as { phase: string }).phase = "stopped";
      release();
      await holder;

      await expect(copy).rejects.toThrow("Simulator input is unavailable");
      expect(calls).toEqual([]);
      expect(readFileSync(board, "utf8")).toBe("previous text");
    });
  });

  test("waits for capture start before it presses Command+C", async () => {
    await withPasteboard("copied", "0", async (udid, _board, markCopy) => {
      const { calls, internals } = session(undefined, udid, markCopy);
      let started!: () => void;
      Object.assign(internals, { captureStart: new Promise<void>((resolve) => { started = resolve; }) });
      const copy = internals.copyPasteboard();
      await Bun.sleep(300);
      expect(calls).toEqual([]);
      started();
      expect((await copy).text).toBe("copied");
      expect(calls).toContainEqual(["down", KeyC]);
    });
  });

  test("sends nothing if the session stops during capture start", async () => {
    const { calls, internals } = session();
    let started!: () => void;
    Object.assign(internals, { captureStart: new Promise<void>((resolve) => { started = resolve; }) });
    const copy = internals.copyPasteboard();
    (internals as unknown as { phase: string }).phase = "stopped";
    started();
    await expect(copy).rejects.toThrow("Capture session is stopped");
    expect(calls).toEqual([]);
  });

  test("takes its input turn before the pasteboard lock, as Paste does", async () => {
    await withPasteboard("copied", "0", async (udid, _board, markCopy) => {
      const { internals, viewer } = session(undefined, udid, markCopy);
      const a = viewer();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const earlier = internals.queueInputOperation(viewer(), () => gate);
      const copy = internals.copyPasteboard();
      await Bun.sleep(100);
      // Paste waits for its turn, then takes the lock, as the 0x12 handler does.
      const paste = internals.queueInputOperation(a, () => pasteTextIntoSim(udid, "pasted", async () => {}))!;
      await Bun.sleep(100);
      release();
      await earlier;
      const finished = await Promise.race([
        Promise.all([copy, paste]).then(() => true),
        Bun.sleep(3_000).then(() => false),
      ]);
      expect(finished).toBe(true);
      expect((await copy).text).toBe("copied");
    });
  }, 10_000);

  test("Paste writes after earlier input, so an earlier Command+C cannot replace its text", async () => {
    await withPasteboard("old", "0", async (udid, board) => {
      const { internals, viewer } = session(undefined, udid);
      const ws = viewer() as { send(message: Buffer): void };
      ws.send = () => {};
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      // An earlier key operation that copies text in the app once it runs.
      const earlier = internals.queueInputOperation(ws, async () => {
        await gate;
        writeFileSync(board, "copied by the app");
      });
      const handler = internals as typeof internals & { handleHidMessage(data: Buffer, ws: object): Promise<void> };
      const paste = handler.handleHidMessage(Buffer.concat([
        Buffer.from([0x12]), Buffer.from(JSON.stringify({ requestId: 1, text: "browser text" })),
      ]), ws);
      // Long enough for a write that does not wait for its turn to land.
      await Bun.sleep(1000);
      expect(readFileSync(board, "utf8")).toBe("old");
      release();
      await earlier;
      await paste;
      expect(readFileSync(board, "utf8")).toBe("browser text");
    });
  }, 10_000);
});
