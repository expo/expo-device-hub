import { expect, test } from "bun:test";
import { encodePasteRequest, readTextFromBrowserClipboard } from "../client/utils/sim-clipboard";

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
