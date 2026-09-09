import { describe, expect, test } from "bun:test";
import {
  corsHeadersForRequest,
  isAllowedBrowserOrigin,
  isAllowedMutationOrigin,
  parseAllowedOrigins,
} from "../src/origin-policy.ts";

describe("browser origin policy", () => {
  test("allows same-origin and loopback browser requests", () => {
    expect(
      isAllowedBrowserOrigin(
        new Request("http://127.0.0.1:3300/webrtc/offer", {
          headers: { Origin: "http://127.0.0.1:3300" },
        }),
      ),
    ).toBe(true);

    expect(
      isAllowedBrowserOrigin(
        new Request("http://127.0.0.1:3300/webrtc/offer", {
          headers: { Origin: "http://localhost:5173" },
        }),
      ),
    ).toBe(true);
  });

  test("rejects unrelated browser origins unless explicitly allowed", () => {
    const req = new Request("http://127.0.0.1:3300/webrtc/offer", {
      headers: { Origin: "https://example.test" },
    });

    expect(isAllowedBrowserOrigin(req)).toBe(false);
    expect(isAllowedBrowserOrigin(req, { allowedOrigins: ["https://example.test"] })).toBe(true);
  });

  test("requires an exact or explicitly configured origin for mutations", () => {
    const loopbackDevOrigin = new Request("http://127.0.0.1:3300/api/action", {
      method: "POST",
      headers: { Origin: "http://localhost:5173" },
    });
    expect(isAllowedMutationOrigin(loopbackDevOrigin)).toBe(false);
    expect(
      isAllowedMutationOrigin(loopbackDevOrigin, {
        allowedOrigins: ["http://localhost:5173"],
      }),
    ).toBe(true);
    expect(
      isAllowedMutationOrigin(
        new Request("http://127.0.0.1:3300/api/action", {
          method: "POST",
          headers: { Origin: "http://127.0.0.1:3300" },
        }),
      ),
    ).toBe(true);
    expect(
      isAllowedMutationOrigin(
        new Request("http://127.0.0.1:3300/api/action", { method: "POST" }),
      ),
    ).toBe(true);
  });

  test("echoes CORS only for allowed origins", () => {
    const req = new Request("http://127.0.0.1:3300/webrtc/offer", {
      headers: { Origin: "https://example.test" },
    });

    expect(corsHeadersForRequest(req)["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(
      corsHeadersForRequest(req, { allowedOrigins: ["https://example.test"] })[
        "Access-Control-Allow-Origin"
      ],
    ).toBe("https://example.test");
  });

  test("normalizes configured origin lists", () => {
    expect(parseAllowedOrigins("https://example.test/path, http://localhost:5173")).toEqual([
      "https://example.test",
      "http://localhost:5173",
    ]);
    expect(parseAllowedOrigins("*")).toEqual(["*"]);
    expect(() => parseAllowedOrigins("file:///tmp/ui.html")).toThrow("--allow-origin");
  });
});
