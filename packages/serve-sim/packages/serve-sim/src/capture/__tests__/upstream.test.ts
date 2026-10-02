import { describe, expect, test } from "bun:test";

import { assertNotOwnProxy, parseCaptureProxy } from "../upstream";

describe("parseCaptureProxy", () => {
  test("defaults to direct and allows an explicit direct setting", () => {
    for (const value of [undefined, "", "  ", "none"]) expect(parseCaptureProxy(value)).toBeNull();
  });

  test("normalizes the address that mitmproxy connects to", () => {
    expect(parseCaptureProxy("http://１２７。０。０。１:8899")).toEqual({ url: "http://127.0.0.1:8899/" });
    expect(parseCaptureProxy("http://[::1]:8899")).toEqual({ url: "http://[::1]:8899/" });
  });

  test("separates decoded Basic credentials from the address", () => {
    expect(parseCaptureProxy("http://user:p%40ss%3Aword@proxy.example:8899")).toEqual({
      url: "http://proxy.example:8899/", auth: "user:p@ss:word",
    });
    expect(parseCaptureProxy("http://user@proxy.example")).toEqual({ url: "http://proxy.example/", auth: "user:" });
  });

  test("rejects unsupported or malformed values without repeating them", () => {
    for (const value of [
      "proxy:8899", "socks://proxy:8899", "https://proxy:8899", "http://proxy:0",
      "http://proxy/path-secret", "http://proxy/?query-secret", "http://proxy/#hash-secret",
      "http://:password-secret@proxy", "http://user%3Aname:password-secret@proxy",
      "http://user:bad%ZZ-secret@proxy", "http://proxy\u0000secret",
    ]) {
      try { parseCaptureProxy(value); throw new Error("accepted invalid value"); }
      catch (error) {
        expect(String(error)).toContain("HTTP proxy URL");
        expect(String(error)).not.toContain("secret");
      }
    }
  });
});

test("rejects normalized addresses on its own port without resolving other hosts", () => {
  for (const host of ["127.0.0.1", "0x7f.1", "１２７。０。０。１", "localhost.", "ℓocalhost", "[::1]", "[::ffff:127.0.0.1]", "10.0.0.5"]) {
    const upstream = parseCaptureProxy(`http://${host}:54321`);
    expect(() => assertNotOwnProxy(upstream, 54321)).toThrow("own port");
    expect(() => assertNotOwnProxy(upstream, 54322)).not.toThrow();
  }
  expect(() => assertNotOwnProxy(parseCaptureProxy("http://proxy.invalid:54321"), 54321)).not.toThrow();
});
