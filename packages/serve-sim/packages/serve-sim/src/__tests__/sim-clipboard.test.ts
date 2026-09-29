import { describe, expect, test } from "bun:test";
import { HID_USAGE_BY_CODE } from "../client/utils/hid";
import {
  readTextFromBrowserClipboard,
  pasteRequestFits,
  simPasteHidEvents,
} from "../client/utils/sim-clipboard";

const usage = (code: string): number => {
  const value = HID_USAGE_BY_CODE[code];
  if (value === undefined) throw new Error(`no HID usage for ${code}`);
  return value;
};

describe("sim paste HID", () => {
  const ControlLeft = usage("ControlLeft");
  const ControlRight = usage("ControlRight");
  const MetaLeft = usage("MetaLeft");
  const MetaRight = usage("MetaRight");
  const KeyV = usage("KeyV");
  const held = (...usages: number[]): Set<number> => new Set(usages);

  test("taps Cmd+V when no modifiers are held", () => {
    expect(simPasteHidEvents(new Set())).toEqual([
      { type: "down", usage: MetaLeft },
      { type: "down", usage: KeyV },
      { type: "up", usage: KeyV },
      { type: "up", usage: MetaLeft },
    ]);
  });

  test("only taps V when Command is already down", () => {
    expect(simPasteHidEvents(held(MetaLeft))).toEqual([
      { type: "down", usage: KeyV },
      { type: "up", usage: KeyV },
    ]);
    expect(simPasteHidEvents(held(MetaRight))).toEqual([
      { type: "down", usage: KeyV },
      { type: "up", usage: KeyV },
    ]);
  });

  test("lifts a held Control for Cmd+V and presses it again after", () => {
    expect(simPasteHidEvents(held(ControlLeft))).toEqual([
      { type: "up", usage: ControlLeft },
      { type: "down", usage: MetaLeft },
      { type: "down", usage: KeyV },
      { type: "up", usage: KeyV },
      { type: "up", usage: MetaLeft },
      { type: "down", usage: ControlLeft },
    ]);
    expect(simPasteHidEvents(held(ControlLeft, ControlRight, MetaLeft))).toEqual([
      { type: "up", usage: ControlLeft },
      { type: "up", usage: ControlRight },
      { type: "down", usage: KeyV },
      { type: "up", usage: KeyV },
      { type: "down", usage: ControlLeft },
      { type: "down", usage: ControlRight },
    ]);
  });

  test("lifts a held Option for Cmd+V", () => {
    const AltRight = usage("AltRight");
    expect(simPasteHidEvents(held(AltRight, MetaLeft))).toEqual([
      { type: "up", usage: AltRight },
      { type: "down", usage: KeyV },
      { type: "up", usage: KeyV },
      { type: "down", usage: AltRight },
    ]);
  });
});

describe("readTextFromBrowserClipboard", () => {
  function withNavigator(value: unknown, run: () => Promise<void>): Promise<void> {
    const had = Object.prototype.hasOwnProperty.call(globalThis, "navigator");
    const previous = Reflect.get(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { value, configurable: true, writable: true });
    return run().finally(() => {
      if (had) {
        Object.defineProperty(globalThis, "navigator", {
          value: previous,
          configurable: true,
          writable: true,
        });
      } else {
        Reflect.deleteProperty(globalThis, "navigator");
      }
    });
  }

  // serve-sim over a LAN address is not a secure context, so the async
  // clipboard API is absent there. The caller has to fall back, not retry.
  test("refuses an origin with no async clipboard", async () => {
    await withNavigator({}, async () => {
      await expect(readTextFromBrowserClipboard()).rejects.toThrow(/Clipboard unavailable/);
    });
  });

  test("refuses an origin whose clipboard cannot read", async () => {
    await withNavigator({ clipboard: { writeText: async () => {} } }, async () => {
      await expect(readTextFromBrowserClipboard()).rejects.toThrow(/Clipboard unavailable/);
    });
  });

  test("returns what the device clipboard holds", async () => {
    await withNavigator({ clipboard: { readText: async () => "café 🎉" } }, async () => {
      expect(await readTextFromBrowserClipboard()).toBe("café 🎉");
    });
  });
});

describe("pasteRequestFits", () => {
  test("accepts ordinary text", () => {
    expect(pasteRequestFits(1, "hello\nworld")).toBe(true);
  });

  test("rejects text at the byte limit, since the request adds a tag and JSON", () => {
    expect(pasteRequestFits(1, "a".repeat(4 * 1024 * 1024))).toBe(false);
  });

  test("measures the escaped request, not the text", () => {
    // 2.5 MB of quotes escapes to about 5 MB of JSON.
    expect(pasteRequestFits(1, "\"".repeat(2_500_000))).toBe(false);
    expect(pasteRequestFits(1, "a".repeat(2_500_000))).toBe(true);
  });
});
