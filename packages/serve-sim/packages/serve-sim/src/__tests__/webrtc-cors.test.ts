import { describe, expect, test } from "bun:test";
import { CORS } from "../device-session";
import { simMiddleware } from "../middleware";

describe("WebRTC CORS preflight", () => {
  test("allows offer and close preflight requests", () => {
    expect(CORS["Access-Control-Allow-Origin"]).toBe("*");
    expect(CORS["Access-Control-Allow-Methods"]).toContain("OPTIONS");
    expect(CORS["Access-Control-Allow-Headers"]).toContain("Content-Type");
  });

  test("returns a bodyless 204 through the Connect-to-Fetch adapter", async () => {
    const middleware = simMiddleware({ basePath: "/.sim", proxyHelpers: true });
    const response = await middleware(new Request(
      "http://localhost/.sim/helper/00000000-0000-4000-8000-000000000000/webrtc/offer",
      { method: "OPTIONS" },
    ));

    expect(response?.status).toBe(204);
    expect(await response?.text()).toBe("");
    expect(response?.headers.get("access-control-allow-methods")).toContain("OPTIONS");
  });
});
