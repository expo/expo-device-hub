import { describe, expect, spyOn, test } from "bun:test";
import { DeviceSession } from "../device-session";
import { NativeHid } from "../native";
import { HID_USAGE_BY_CODE } from "../client/utils/hid";

const ControlLeft = HID_USAGE_BY_CODE.ControlLeft!;
const MetaLeft = HID_USAGE_BY_CODE.MetaLeft!;
const KeyV = HID_USAGE_BY_CODE.KeyV!;
const KeyA = HID_USAGE_BY_CODE.KeyA!;

type KeyCall = [type: "down" | "up", usage: number];

function session(failOn?: (call: KeyCall) => boolean) {
  const calls: KeyCall[] = [];
  const s = Object.create(DeviceSession.prototype) as DeviceSession;
  const key = async (type: "down" | "up", usage: number) => {
    if (failOn?.([type, usage])) throw new Error("HID failed");
    calls.push([type, usage]);
  };
  Object.assign(s, {
    hidSockets: new Set<object>(),
    activeHidKeyUsages: new WeakMap<object, Set<number>>(),
    activeHidKeyUsageCounts: new Map<number, number>(),
    hid: { inputUnavailable: false, key, keyChecked: key },
  });
  const internals = s as unknown as {
    hidSockets: Set<object>;
    activeHidKeyUsages: WeakMap<object, Set<number>>;
    activeHidKeyUsageCounts: Map<number, number>;
    updateHidKey(ws: object, type: "down" | "up", usage: number): Promise<void>;
    sendPasteShortcut(ws: object): Promise<string | null>;
  };
  const viewer = () => {
    const ws = {};
    internals.hidSockets.add(ws);
    internals.activeHidKeyUsages.set(ws, new Set());
    return ws;
  };
  return { calls, internals, viewer };
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
