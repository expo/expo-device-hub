import { describe, expect, test } from "bun:test";
import { simMiddleware } from "../middleware";

const OFFER = "http://localhost/.sim/helper/00000000-0000-4000-8000-000000000000/webrtc/offer";

function preflight(origin?: string): Request {
  return new Request(OFFER, {
    method: "OPTIONS",
    headers: {
      "access-control-request-method": "POST",
      ...(origin ? { origin } : {}),
    },
  });
}

describe("CORS preflight", () => {
  test("returns a bodyless 204 through the Connect-to-Fetch adapter", async () => {
    const middleware = simMiddleware({ basePath: "/.sim", proxyHelpers: true });
    const response = await middleware(preflight());

    expect(response?.status).toBe(204);
    expect(await response?.text()).toBe("");
    expect(response?.headers.get("access-control-allow-methods")).toContain("OPTIONS");
  });

  test("names the configured origin rather than allowing every site", async () => {
    const middleware = simMiddleware({ basePath: "/.sim", corsOrigins: ["https://expo.dev"] });
    const response = await middleware(preflight("https://expo.dev"));

    expect(response?.headers.get("access-control-allow-origin")).toBe("https://expo.dev");
    expect(response?.headers.get("vary")).toBe("Origin");
  });

  test("tells an unconfigured origin nothing, but still varies on Origin", async () => {
    const middleware = simMiddleware({ basePath: "/.sim", corsOrigins: ["https://expo.dev"] });
    const response = await middleware(preflight("https://evil.test"));

    expect(response?.headers.get("access-control-allow-origin")).toBeNull();
    // Without this a shared cache could replay the refusal to an origin that is allowed.
    expect(response?.headers.get("vary")).toBe("Origin");
  });

  test("names a deploy preview matched by a wildcard", async () => {
    const middleware = simMiddleware({ basePath: "/.sim", corsOrigins: ["https://*.expo.dev"] });
    const response = await middleware(preflight("https://pr-31018.expo.dev"));

    expect(response?.headers.get("access-control-allow-origin")).toBe("https://pr-31018.expo.dev");
    expect(response?.headers.get("vary")).toBe("Origin");
  });

  test("answers a preflight before the token gate, which it cannot satisfy", async () => {
    const middleware = simMiddleware({
      basePath: "/.sim",
      requirePreviewToken: true,
      corsOrigins: ["https://expo.dev"],
    });
    const response = await middleware(preflight("https://expo.dev"));

    expect(response?.status).toBe(204);
    expect(response?.headers.get("access-control-allow-origin")).toBe("https://expo.dev");
  });
});

describe("CORS policy", () => {
  test("keeps the headers on a gated 401, so the browser can read the status", async () => {
    const middleware = simMiddleware({
      basePath: "/.sim",
      requirePreviewToken: true,
      corsOrigins: ["https://expo.dev"],
    });
    const response = await middleware(
      new Request("http://localhost/.sim/api", { headers: { origin: "https://expo.dev" } }),
    );

    expect(response?.status).toBe(401);
    expect(response?.headers.get("access-control-allow-origin")).toBe("https://expo.dev");
  });

  test("leaves a mounted host app's own preflight alone", async () => {
    const middleware = simMiddleware({ basePath: "/.sim", corsOrigins: ["https://expo.dev"] });
    const response = await middleware(
      new Request("http://localhost/api/orders", {
        method: "OPTIONS",
        headers: { origin: "https://expo.dev" },
      }),
    );

    expect(response).toBeUndefined();
  });

  test("reads the deprecated option alongside the current one", async () => {
    const middleware = simMiddleware({
      basePath: "/.sim",
      corsOrigins: ["https://expo.dev"],
      metricsCorsOrigins: ["https://staging.expo.dev"],
    });
    const response = await middleware(preflight("https://staging.expo.dev"));

    expect(response?.headers.get("access-control-allow-origin")).toBe("https://staging.expo.dev");
  });
});
