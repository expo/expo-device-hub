import { describe, expect, test } from "bun:test";
import { simMiddleware } from "../middleware";
import { servePreview } from "../runtime";

async function withMiddleware<T>(
  fn: (origin: string, request: (path: string, init?: RequestInit) => Promise<Response>) => Promise<T>,
): Promise<T> {
  const TOKEN = "test-token-abc123";
  const handler = simMiddleware({ basePath: "/", execToken: TOKEN });
  const origin = "http://127.0.0.1:34567";
  const request = async (path: string, init?: RequestInit) => {
    const response = await handler(new Request(`${origin}${path}`, init));
    if (!response) throw new Error(`Unhandled request: ${path}`);
    return response;
  };
  return fn(origin, request);
}

const TOKEN = "test-token-abc123";

describe("/exec auth", () => {
  test("rejects unauthenticated POST", async () => {
    await withMiddleware(async (_origin, request) => {
      const r = await request("/exec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "echo hi" }),
      });
      expect(r.status).toBe(401);
    });
  });

  test("rejects non-JSON Content-Type (CSRF-simple-POST path)", async () => {
    await withMiddleware(async (_origin, request) => {
      const r = await request("/exec", {
        method: "POST",
        headers: { "Content-Type": "text/plain", Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ command: "echo hi" }),
      });
      expect(r.status).toBe(415);
    });
  });

  test("rejects cross-origin POST", async () => {
    await withMiddleware(async (_origin, request) => {
      const r = await request("/exec", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
          Origin: "http://evil.example",
        },
        body: JSON.stringify({ command: "echo hi" }),
      });
      expect(r.status).toBe(403);
    });
  });

  test("rejects wrong bearer token", async () => {
    await withMiddleware(async (_origin, request) => {
      const r = await request("/exec", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer not-the-token" },
        body: JSON.stringify({ command: "echo hi" }),
      });
      expect(r.status).toBe(401);
    });
  });

  test("accepts same-origin POST with bearer token", async () => {
    await withMiddleware(async (origin, request) => {
      const r = await request("/exec", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
          Origin: origin,
        },
        body: JSON.stringify({ command: "echo serve-sim-test" }),
      });
      expect(r.status).toBe(200);
      const body = await r.json() as { stdout: string; exitCode: number };
      expect(body.stdout.trim()).toBe("serve-sim-test");
      expect(body.exitCode).toBe(0);
    });
  });

  test("runtime adapter accepts same-origin POST with bearer token", async () => {
    const port = 3462;
    const origin = `http://127.0.0.1:${port}`;
    const middleware = simMiddleware({ basePath: "/", execToken: TOKEN });
    const server = await servePreview({ port, middleware, host: "127.0.0.1" });
    try {
      const r = await fetch(`${origin}/exec`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
          Origin: origin,
        },
        body: JSON.stringify({ command: "echo runtime-adapter-works" }),
      });
      expect(r.status).toBe(200);
      const body = await r.json() as { stdout: string; exitCode: number };
      expect(body.stdout.trim()).toBe("runtime-adapter-works");
      expect(body.exitCode).toBe(0);
    } finally {
      server.stop(true);
    }
  });
});
