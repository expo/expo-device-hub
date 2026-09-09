import { describe, expect, test } from "bun:test";
import { simMiddleware } from "../middleware";

async function request(path: string): Promise<Response> {
  const middleware = simMiddleware({ basePath: "/", proxyHelpers: true });
  const response = await middleware(new Request(`http://127.0.0.1:3200${path}`));
  if (!response) throw new Error(`Unhandled request: ${path}`);
  return response;
}

describe("readiness endpoints", () => {
  test("reports process health without a simulator session", async () => {
    const response = await request("/healthz");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "ok" });
  });

  test("does not report ready before a simulator session exists", async () => {
    const response = await request("/readyz");
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "starting" });
  });
});
