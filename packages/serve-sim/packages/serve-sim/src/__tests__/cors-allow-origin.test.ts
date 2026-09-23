import { describe, expect, test } from "bun:test";

import { corsAllowOriginHeaders, frameAncestorsPolicy } from "../middleware-utils";

describe("corsAllowOriginHeaders", () => {
  test("echoes an allowlisted origin", () => {
    expect(corsAllowOriginHeaders("https://expo.dev", ["https://expo.dev"])).toEqual({
      "Access-Control-Allow-Origin": "https://expo.dev",
    });
  });

  test("canonicalizes configured origins (case, default port, trailing slash) before matching", () => {
    for (const configured of ["HTTPS://Expo.Dev", "https://expo.dev:443", "https://expo.dev/"]) {
      expect(corsAllowOriginHeaders("https://expo.dev", [configured])).toEqual({
        "Access-Control-Allow-Origin": "https://expo.dev",
      });
    }
  });

  test("skips a malformed configured origin instead of throwing", () => {
    expect(corsAllowOriginHeaders("https://expo.dev", ["not a url", "https://expo.dev"])).toEqual({
      "Access-Control-Allow-Origin": "https://expo.dev",
    });
    expect(corsAllowOriginHeaders("https://expo.dev", ["not a url"])).toEqual({});
  });

  test("allows any loopback origin without config", () => {
    for (const origin of ["http://localhost:3000", "http://127.0.0.1:8081", "http://[::1]:9000"]) {
      expect(corsAllowOriginHeaders(origin, [])).toEqual({
        "Access-Control-Allow-Origin": origin,
      });
    }
  });

  test("matches a subdomain through a wildcard, so deploy previews work", () => {
    for (const origin of ["https://pr-31018.expo.dev", "https://staging.expo.dev", "https://a.b.expo.dev"]) {
      expect(corsAllowOriginHeaders(origin, ["https://*.expo.dev"])).toEqual({
        "Access-Control-Allow-Origin": origin,
      });
    }
  });

  test("a wildcard covers subdomains only, never the bare host or a lookalike", () => {
    const lookalikes = [
      "https://expo.dev",
      "https://evil-expo.dev",
      "https://expo.dev.evil.example",
      // The suffix appears, just not at the end.
      "https://a.expo.dev.evil.com",
      // A leading dot makes the host exactly as long as the suffix.
      "https://.expo.dev",
    ];
    for (const origin of lookalikes) {
      expect(corsAllowOriginHeaders(origin, ["https://*.expo.dev"])).toEqual({});
    }
  });

  test("a wildcard still pins the scheme and the port", () => {
    expect(corsAllowOriginHeaders("http://pr-1.expo.dev", ["https://*.expo.dev"])).toEqual({});
    expect(corsAllowOriginHeaders("https://pr-1.expo.dev:8081", ["https://*.expo.dev"])).toEqual({});
  });

  test("refuses a scheme the frame policy would drop, even on an exact match", () => {
    expect(corsAllowOriginHeaders("ftp://pr-1.expo.dev", ["ftp://*.expo.dev"])).toEqual({});
    expect(corsAllowOriginHeaders("ws://expo.dev", ["ws://expo.dev"])).toEqual({});
  });

  test("refuses an opaque origin, which every such scheme canonicalizes to the same 'null'", () => {
    expect(corsAllowOriginHeaders("foo://evil", ["chrome-extension://abcdefghijklmnop"])).toEqual({});
    // A loopback host on a scheme no browser sends must not reach the loopback grant either.
    expect(corsAllowOriginHeaders("foo://localhost", [])).toEqual({});
  });

  test("refuses a wildcard too broad to name a site", () => {
    // Each probe shares the configured value's suffix, so only the shape rule can refuse it.
    expect(corsAllowOriginHeaders("https://evil.com", ["https://*.com"])).toEqual({});
    for (const configured of ["https://*", "https://**.expo.dev", "https://a.*.expo.dev"]) {
      expect(corsAllowOriginHeaders("https://pr-1.expo.dev", [configured])).toEqual({});
    }
  });

  test("echoes the canonical origin rather than whatever the caller wrote", () => {
    expect(corsAllowOriginHeaders("HTTPS://PR-1.Expo.Dev", ["https://*.expo.dev"])).toEqual({
      "Access-Control-Allow-Origin": "https://pr-1.expo.dev",
    });
  });

  test("emits no header for an unlisted origin", () => {
    expect(corsAllowOriginHeaders("https://evil.example", ["https://expo.dev"])).toEqual({});
  });

  test("emits no header when the origin is absent or malformed", () => {
    expect(corsAllowOriginHeaders(null, ["https://expo.dev"])).toEqual({});
    expect(corsAllowOriginHeaders("not a url", ["https://expo.dev"])).toEqual({});
  });
});

describe("frameAncestorsPolicy", () => {
  test("names the origin allowed to embed the preview", () => {
    expect(frameAncestorsPolicy(["https://expo.dev"])).toBe("frame-ancestors 'self' https://expo.dev");
  });

  test("allows nobody else when no origin is configured", () => {
    expect(frameAncestorsPolicy([])).toBe("frame-ancestors 'self'");
  });

  test("drops a wildcard and an injected directive, which would otherwise widen the header", () => {
    expect(frameAncestorsPolicy(["*", "https://a; sandbox", "not a url", "https://expo.dev"])).toBe(
      "frame-ancestors 'self' https://expo.dev",
    );
  });

  test("keeps one wildcard label, so a caller can name its deploy previews", () => {
    expect(frameAncestorsPolicy(["https://*.expo.dev"])).toBe(
      "frame-ancestors 'self' https://*.expo.dev",
    );
  });

  test("drops a bare wildcard, which would hand framing to every https site", () => {
    expect(frameAncestorsPolicy(["https://*"])).toBe("frame-ancestors 'self'");
  });

  test("drops a wildcard over a single-label host", () => {
    expect(frameAncestorsPolicy(["https://*.com"])).toBe("frame-ancestors 'self'");
  });

  test("keeps a bracketed ipv6 origin", () => {
    expect(frameAncestorsPolicy(["http://[::1]:19000"])).toBe(
      "frame-ancestors 'self' http://[::1]:19000",
    );
  });

  test("drops a wildcard that is not a whole leading label", () => {
    expect(frameAncestorsPolicy(["https://**.expo.dev", "https://a.*.expo.dev"])).toBe(
      "frame-ancestors 'self'",
    );
  });

  test("drops a directive smuggled into the host", () => {
    expect(frameAncestorsPolicy(["https://expo.dev;img-src"])).toBe("frame-ancestors 'self'");
  });

  test("drops an opaque origin, which serializes to null", () => {
    expect(frameAncestorsPolicy(["data:text/html,x"])).toBe("frame-ancestors 'self'");
  });

  test("keeps a port, which a local website needs", () => {
    expect(frameAncestorsPolicy(["http://localhost:3001"])).toBe(
      "frame-ancestors 'self' http://localhost:3001",
    );
  });

  test("canonicalizes, so a configured path or default port still matches", () => {
    expect(frameAncestorsPolicy(["https://expo.dev:443/dashboard"])).toBe(
      "frame-ancestors 'self' https://expo.dev",
    );
  });
});
