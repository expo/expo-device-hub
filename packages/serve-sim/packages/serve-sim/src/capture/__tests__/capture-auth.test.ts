import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { simMiddleware } from "../../middleware";
import { useTempStateDir } from "../../__tests__/helpers";

const TOKEN = "capture-token-xyz";

async function withMiddleware(
  fn: (origin: string, request: (path: string, init?: RequestInit) => Promise<Response>) => Promise<void>,
): Promise<void> {
  const handler = simMiddleware({ basePath: "/", execToken: TOKEN });
  const origin = "http://127.0.0.1:34567";
  const request = async (path: string, init?: RequestInit) => {
    const response = await handler(new Request(`${origin}${path}`, init));
    if (!response) throw new Error(`Unhandled request: ${path}`);
    return response;
  };
  await fn(origin, request);
}

describe("network-capture auth", () => {
  let stateDir: ReturnType<typeof useTempStateDir>;
  beforeAll(() => {
    stateDir = useTempStateDir();
  });
  afterAll(() => {
    stateDir.restore();
  });

  test("rejects unauthenticated SSE", async () => {
    await withMiddleware(async (_origin, request) => {
      const r = await request("/network-capture");
      expect(r.status).toBe(401);
    });
  });

  test("rejects a capture URL token even when it matches the session", async () => {
    await withMiddleware(async (_origin, request) => {
      expect((await request(`/network-capture?token=${TOKEN}`)).status).toBe(401);
      expect((await request(`/network-capture/some-id?token=${TOKEN}`)).status).toBe(401);
    });
  });

  test("rejects cross-origin SSE even with bearer", async () => {
    await withMiddleware(async (_origin, request) => {
      const r = await request("/network-capture", {
        headers: { Authorization: `Bearer ${TOKEN}`, Origin: "http://evil.example" },
      });
      expect(r.status).toBe(403);
    });
  });

  test("accepts same-origin SSE with bearer", async () => {
    await withMiddleware(async (origin, request) => {
      const r = await request("/network-capture", {
        headers: { Authorization: `Bearer ${TOKEN}`, Origin: origin },
      });
      // No booted device in unit middleware → 404 after auth.
      expect(r.status).toBe(404);
      expect(r.headers.get("cache-control")).toBe("no-store, private");
    });
  });

  test("rejects a CSRF-simple POST", async () => {
    await withMiddleware(async (_origin, request) => {
      const r = await request("/network-capture", {
        method: "POST",
        headers: { "Content-Type": "text/plain", Authorization: `Bearer ${TOKEN}` },
        body: "{}",
      });
      expect(r.status).toBe(415);
    });
  });

  test("answers a JSON POST to a read-only capture route with 405", async () => {
    await withMiddleware(async (origin, request) => {
      const r = await request("/network-capture", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}`, Origin: origin },
        body: "{}",
      });
      expect(r.status).toBe(405);
      expect(r.headers.get("allow")).toBe("GET, HEAD");
    });
  });

  test("answers a malformed capture id with 400 instead of failing the route", async () => {
    await withMiddleware(async (origin, request) => {
      const r = await request("/network-capture/%ZZ", {
        headers: { Authorization: `Bearer ${TOKEN}`, Origin: origin },
      });
      expect(r.status).toBe(400);
      expect(r.headers.get("cache-control")).toBe("no-store, private");
    });
  });

  test("rejects unauthenticated body GET", async () => {
    await withMiddleware(async (_origin, request) => {
      const r = await request("/network-capture/some-id");
      expect(r.status).toBe(401);
    });
  });

  test("rejects unauthenticated HAR GET", async () => {
    await withMiddleware(async (_origin, request) => {
      const r = await request("/network-capture.har");
      expect(r.status).toBe(401);
    });
  });

  test("serves the HAR route to an authenticated same-origin caller", async () => {
    // Unrouted, this fell through unhandled, so only the gate above ever answered it.
    await withMiddleware(async (origin, request) => {
      const r = await request("/network-capture.har", {
        headers: { Origin: origin, Authorization: `Bearer ${TOKEN}` },
      });
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ error: "No capture session" });
    });
  });
});
