import { describe, expect, test } from "bun:test";
import {
  corsHeadersForRequest,
  isAllowedBrowserOrigin,
  isAllowedMutationOrigin,
  parseAllowedOrigins,
  withCorsPolicy,
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

  // The same shapes serve-sim's --cors-origin takes, so the Hub can pass one list to both.
  test("matches a subdomain wildcard as serve-sim does", () => {
    const policy = { allowedOrigins: ["https://*.expo.dev"] };
    const fromOrigin = (origin: string, method = "GET") =>
      new Request("https://hub.example.test/api/devices", { method, headers: { Origin: origin } });

    expect(isAllowedBrowserOrigin(fromOrigin("https://pr-12.expo.dev"), policy)).toBe(true);
    expect(isAllowedBrowserOrigin(fromOrigin("https://a.b.expo.dev"), policy)).toBe(true);
    expect(isAllowedMutationOrigin(fromOrigin("https://pr-12.expo.dev", "POST"), policy)).toBe(true);
    expect(
      corsHeadersForRequest(fromOrigin("https://pr-12.expo.dev"), policy)["Access-Control-Allow-Origin"],
    ).toBe("https://pr-12.expo.dev");
    // Subdomains only, with the same scheme and port.
    expect(isAllowedBrowserOrigin(fromOrigin("https://expo.dev"), policy)).toBe(false);
    expect(isAllowedBrowserOrigin(fromOrigin("http://pr-12.expo.dev"), policy)).toBe(false);
    expect(isAllowedBrowserOrigin(fromOrigin("https://pr-12.expo.dev:8443"), policy)).toBe(false);
    expect(isAllowedBrowserOrigin(fromOrigin("https://evilexpo.dev"), policy)).toBe(false);
    // Two labels after the star, as in serve-sim.
    expect(isAllowedBrowserOrigin(fromOrigin("https://example.com"), { allowedOrigins: ["https://*.com"] })).toBe(
      false,
    );
  });

  test("adds the policy to a response whose headers are immutable", () => {
    const req = new Request("http://127.0.0.1:3300/api/devices", {
      headers: { Origin: "https://example.test" },
    });
    const redirect = Response.redirect("http://127.0.0.1:3300/", 302);

    const response = withCorsPolicy(req, redirect, { allowedOrigins: ["https://example.test"] });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("http://127.0.0.1:3300/");
    expect(response.headers.get("access-control-allow-origin")).toBe("https://example.test");
    expect(response.headers.get("vary")).toBe("Origin");
  });

  test("keeps a response's own Vary and names Origin in it once", () => {
    const req = new Request("http://127.0.0.1:3300/api/metrics", {
      headers: { Origin: "http://localhost:5173" },
    });

    const varied = withCorsPolicy(req, new Response("ok", { headers: { Vary: "Accept-Encoding" } }));
    const alreadyOrigin = withCorsPolicy(req, new Response("ok", { headers: { Vary: "Origin" } }));

    expect(varied.headers.get("vary")).toBe("Accept-Encoding, Origin");
    expect(alreadyOrigin.headers.get("vary")).toBe("Origin");
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
