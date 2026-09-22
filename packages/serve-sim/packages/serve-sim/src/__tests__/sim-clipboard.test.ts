import { describe, expect, test } from "bun:test";
import { HID_USAGE_BY_CODE } from "../client/utils/hid";
import {
  copyTextToSim,
  readSimClipboard,
  readTextFromBrowserClipboard,
  simCopyHidEvents,
  simPasteHidEvents,
  simSelectAllHidEvents,
} from "../client/utils/sim-clipboard";

describe("sim paste HID", () => {
  const usage = (code: string): number => {
    const value = HID_USAGE_BY_CODE[code];
    if (value === undefined) throw new Error(`no HID usage for ${code}`);
    return value;
  };
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

  test("sends Cmd+C for the copy shortcut", () => {
    const KeyC = usage("KeyC");
    expect(simCopyHidEvents(held())).toEqual([
      { type: "down", usage: MetaLeft },
      { type: "down", usage: KeyC },
      { type: "up", usage: KeyC },
      { type: "up", usage: MetaLeft },
    ]);
  });

  test("sends Cmd+A for select all", () => {
    const KeyA = usage("KeyA");
    expect(simSelectAllHidEvents(held())).toEqual([
      { type: "down", usage: MetaLeft },
      { type: "down", usage: KeyA },
      { type: "up", usage: KeyA },
      { type: "up", usage: MetaLeft },
    ]);
  });

  test("releases Control before injecting Cmd+V", () => {
    expect(simPasteHidEvents(held(ControlLeft))).toEqual([
      { type: "up", usage: ControlLeft },
      { type: "down", usage: MetaLeft },
      { type: "down", usage: KeyV },
      { type: "up", usage: KeyV },
      { type: "up", usage: MetaLeft },
    ]);
    expect(simPasteHidEvents(held(ControlLeft, ControlRight, MetaLeft))).toEqual([
      { type: "up", usage: ControlLeft },
      { type: "up", usage: ControlRight },
      { type: "down", usage: KeyV },
      { type: "up", usage: KeyV },
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

describe("readSimClipboard", () => {
  function withStubs(
    response: Response,
    run: (requests: Array<{ input: string; init?: RequestInit }>) => Promise<void>,
  ): Promise<void> {
    const realFetch = globalThis.fetch;
    const realWindow = Reflect.get(globalThis, "window");
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    Object.defineProperty(globalThis, "window", {
      value: {
        __SIM_PREVIEW__: { basePath: "/", execToken: "test-token" },
        location: { pathname: "/" },
      },
      configurable: true,
      writable: true,
    });
    const stub: typeof fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ input: String(input), init });
        return response;
      },
      { preconnect: realFetch.preconnect },
    );
    globalThis.fetch = stub;
    return run(requests).finally(() => {
      globalThis.fetch = realFetch;
      if (realWindow === undefined) Reflect.deleteProperty(globalThis, "window");
      else Object.defineProperty(globalThis, "window", { value: realWindow, configurable: true, writable: true });
    });
  }

  test("PUTs text to the selected device", async () => {
    await withStubs(Response.json({ ok: true }), async (requests) => {
      expect(await copyTextToSim("UDID-1", "café 🎉")).toBe(true);
      expect(requests).toEqual([
        {
          input: "/api/pasteboard?device=UDID-1",
          init: {
            method: "PUT",
            headers: {
              Authorization: "Bearer test-token",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ text: "café 🎉" }),
          },
        },
      ]);
    });
  });

  test("POSTs the selected device and returns the endpoint result", async () => {
    await withStubs(
      Response.json({ ok: true, text: "café 🎉", relaunchedApp: "dev.example.app" }),
      async (requests) => {
      expect(await readSimClipboard("UDID-1")).toEqual({
        text: "café 🎉",
        relaunchedApp: "dev.example.app",
      });
      expect(requests).toEqual([
        {
          input: "/api/pasteboard?device=UDID-1",
          init: {
            method: "POST",
            headers: { Authorization: "Bearer test-token" },
          },
        },
      ]);
      },
    );
  });

  test("surfaces the endpoint's own error message", async () => {
    await withStubs(
      Response.json({ ok: false, error: "Timed out reading the simulator pasteboard" }, { status: 500 }),
      async () => {
        await expect(readSimClipboard("UDID-1")).rejects.toThrow(/Timed out/);
      },
    );
  });

  test("falls back to a status message when the body carries no error", async () => {
    await withStubs(Response.json({}, { status: 502 }), async () => {
      await expect(readSimClipboard("UDID-1")).rejects.toThrow(/502/);
    });
  });

});
