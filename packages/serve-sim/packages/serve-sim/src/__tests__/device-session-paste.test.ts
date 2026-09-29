import { describe, expect, test } from "bun:test";
import { DeviceSession } from "../device-session";
import { NativeHid } from "../native";
import { HID_USAGE_BY_CODE } from "../client/utils/hid";

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
    async keyChecked(type: "down" | "up", usage: number) {
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
    activeHidKeyUsages: new WeakMap<object, Set<number>>(),
    activeHidKeyUsageCounts: new Map<number, number>(),
    failedInputSockets: new WeakSet(),
    hid,
  });
  const internals = s as unknown as {
    hidSockets: Set<object>;
    activeHidKeyUsages: WeakMap<object, Set<number>>;
    activeHidKeyUsageCounts: Map<number, number>;
    updateHidKey(ws: object, type: "down" | "up", usage: number): Promise<void>;
    sendPasteShortcut(ws: object): Promise<string | null>;
    sendCommandShortcut(code: "KeyV" | "KeyC", ws: object | null): Promise<string | null>;
    queueInputOperation(ws: object, run: () => Promise<void>): Promise<void> | null;
  };
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

  test("retries a failed Command release after Paste", async () => {
    let releases = 0;
    const { internals, viewer } = session(([type, usage]) =>
      type === "up" && usage === MetaLeft && ++releases === 1);
    const b = viewer();
    expect(await internals.sendPasteShortcut(b)).toBeNull();
    expect(releases).toBe(2);
    expect(internals.activeHidKeyUsageCounts.has(MetaLeft)).toBe(false);
  });

  test("warns separately when Command release still fails after retry", async () => {
    let releases = 0;
    const { internals, viewer } = session(([type, usage]) => {
      if (type === "up" && usage === MetaLeft) { releases++; return true; }
      return false;
    });
    const b = viewer();
    expect(await internals.sendPasteShortcut(b)).toContain("key may still be held");
    expect(releases).toBe(2);
    expect(internals.activeHidKeyUsageCounts.get(MetaLeft)).toBe(1);
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

test("shortcut-only paste returns success with a separate cleanup warning", async () => {
  const { internals, viewer } = session();
  const ws = viewer() as { send(message: Buffer): void };
  const replies: Buffer[] = [];
  ws.send = (message) => replies.push(message);
  const handler = internals as typeof internals & {
    handleHidMessage(data: Buffer, ws: object): Promise<void>;
    sendPasteShortcut(ws: object): Promise<string | null>;
  };
  handler.queueInputOperation = (_ws, run) => run();
  handler.sendPasteShortcut = async () => "A simulator key may still be held";
  await handler.handleHidMessage(Buffer.concat([
    Buffer.from([0x12]), Buffer.from(JSON.stringify({ requestId: 3 })),
  ]), ws);
  expect(replies[0]?.[0]).toBe(0x92);
  expect(JSON.parse(replies[0]!.subarray(1).toString())).toEqual({
    requestId: 3, ok: true, cleanupWarning: "A simulator key may still be held",
  });
});
