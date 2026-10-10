import { describe, expect, test } from "bun:test";
import {
  copySimClipboardAfterInput,
  encodePasteRequest,
  SimClipboardCopyError,
  readTextFromBrowserClipboard,
} from "../client/utils/sim-clipboard";

test.each([
  ["missing API", undefined],
  ["write-only API", { writeText: async () => {} }],
])("clipboard read rejects a %s", async (_label, clipboard) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { clipboard }, configurable: true });
  try {
    await expect(readTextFromBrowserClipboard()).rejects.toThrow("Clipboard unavailable");
  } finally {
    if (previous) Object.defineProperty(globalThis, "navigator", previous);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});

test("paste limits include JSON escaping and frame overhead", () => {
  const text = "café 🎉\n日本語";
  const request = encodePasteRequest(1, text)!;
  expect(request[0]).toBe(0x12);
  expect(JSON.parse(new TextDecoder().decode(request.subarray(1)))).toEqual({ requestId: 1, text });
  expect(encodePasteRequest(1, "a".repeat(4 * 1024 * 1024))).toBeNull();
  expect(encodePasteRequest(1, '"'.repeat(2_500_000))).toBeNull();
  expect(encodePasteRequest(1, "a".repeat(2_500_000))).not.toBeNull();
});

describe("copySimClipboardAfterInput", () => {
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

  test("POSTs the selected device and returns the endpoint result", async () => {
    await withStubs(
      Response.json({ ok: true, text: "café 🎉" }),
      async (requests) => {
        expect(await copySimClipboardAfterInput("UDID-1", async () => {}, () => true)).toEqual({
          text: "café 🎉",
        });
        expect(requests).toEqual([
          {
            input: "/api/pasteboard?device=UDID-1&copy=1",
            init: {
              method: "POST",
              headers: { Authorization: "Bearer test-token" },
            },
          },
        ]);
      },
    );
  });

  test("holds the browser Copy request behind prior input and cancels it after a device switch", async () => {
    await withStubs(Response.json({ ok: true, text: "selected" }), async (requests) => {
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => { release = resolve; });
      const copy = copySimClipboardAfterInput("UDID-1", () => barrier, () => true);
      await Promise.resolve();
      expect(requests).toEqual([]);
      release();
      expect(await copy).toEqual({ text: "selected" });
      expect(requests.map((request) => request.input)).toEqual(["/api/pasteboard?device=UDID-1&copy=1"]);
    });
    await withStubs(Response.json({ ok: true, text: "old" }), async (requests) => {
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => { release = resolve; });
      let current = true;
      const copy = copySimClipboardAfterInput("UDID-1", () => barrier, () => current);
      current = false;
      release();
      expect(await copy).toBeNull();
      expect(requests).toEqual([]);
    });
  });

  test("surfaces the endpoint's own error message", async () => {
    await withStubs(
      Response.json({ ok: false, error: "Timed out reading the simulator pasteboard" }, { status: 500 }),
      async () => {
        await expect(copySimClipboardAfterInput("UDID-1", async () => {}, () => true)).rejects.toThrow(/Timed out/);
      },
    );
  });

  test("falls back to a status message when the body carries no error", async () => {
    await withStubs(Response.json({}, { status: 502 }), async () => {
      await expect(copySimClipboardAfterInput("UDID-1", async () => {}, () => true)).rejects.toThrow(/502/);
    });
  });

  test("falls back to a status message when the error body is not JSON", async () => {
    await withStubs(new Response("Bad Gateway", { status: 502, headers: { "Content-Type": "text/plain" } }), async () => {
      await expect(copySimClipboardAfterInput("UDID-1", async () => {}, () => true)).rejects.toThrow(/502/);
    });
  });

  test("carries a key cleanup warning on a failed Copy", async () => {
    await withStubs(
      Response.json({ ok: false, error: "No change", cleanupWarning: "A key may still be held" }, { status: 504 }),
      async () => {
        const error = await copySimClipboardAfterInput("UDID-1", async () => {}, () => true).then(() => null, (reason: unknown) => reason);
        expect(error).toBeInstanceOf(SimClipboardCopyError);
        expect(error).toMatchObject({ message: "No change", cleanupWarning: "A key may still be held" });
      },
    );
  });
});
