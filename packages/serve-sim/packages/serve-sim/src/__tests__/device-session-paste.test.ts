import { describe, expect, test } from "bun:test";
import { DeviceSession } from "../device-session";
import { HID_USAGE_BY_CODE } from "../client/utils/hid";

const ControlLeft = HID_USAGE_BY_CODE.ControlLeft!;
const MetaLeft = HID_USAGE_BY_CODE.MetaLeft!;
const KeyV = HID_USAGE_BY_CODE.KeyV!;

type KeyCall = [type: "down" | "up", usage: number];

// Only the fields the paste chord touches; the rest of the session needs a real simulator.
function session(failOn?: (call: KeyCall) => boolean) {
  const calls: KeyCall[] = [];
  const s = Object.create(DeviceSession.prototype) as DeviceSession;
  Object.assign(s, {
    hidSockets: new Set<object>(),
    activeHidKeyUsages: new WeakMap<object, Set<number>>(),
    activeHidKeyUsageCounts: new Map<number, number>(),
    hid: {
      inputUnavailable: false,
      async key(type: "down" | "up", usage: number) {
        if (failOn?.([type, usage])) throw new Error("HID failed");
        calls.push([type, usage]);
      },
    },
  });
  const internals = s as unknown as {
    hidSockets: Set<object>;
    activeHidKeyUsages: WeakMap<object, Set<number>>;
    activeHidKeyUsageCounts: Map<number, number>;
    updateHidKey(ws: object, type: "down" | "up", usage: number): Promise<void>;
    sendPasteShortcut(ws: object): Promise<void>;
  };
  const viewer = () => {
    const ws = {};
    internals.hidSockets.add(ws);
    internals.activeHidKeyUsages.set(ws, new Set());
    return ws;
  };
  return { calls, internals, viewer };
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
