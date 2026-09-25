import { describe, expect, test } from "bun:test";

import { MAX_CONTROL_BODY_BYTES_ENV, startMitmControl } from "../mitm-control";
import { CaptureStore } from "../store";

async function withControl(
  run: (post: (path: string, body: unknown) => Promise<Response>, store: CaptureStore) => Promise<void>,
  onOversizedBody?: (info: { bytesSeen: number; limit: number; path: string }) => void,
): Promise<void> {
  const store = new CaptureStore(() => 10);
  const control = await startMitmControl({ store, token: "secret", fields: [], onOversizedBody });
  const post = (path: string, body: unknown) =>
    fetch(`http://127.0.0.1:${control.port}${path}?t=secret`, { method: "POST", body: JSON.stringify(body) });
  try {
    await run(post, store);
  } finally {
    await new Promise<void>((resolve) => control.server.close(() => resolve()));
  }
}

describe("mitm control server", () => {
  test("authenticates the addon and records a completed exchange", async () => {
    const store = new CaptureStore(() => 10);
    const control = await startMitmControl({
      store,
      token: "secret",
      fields: ["header", "response-body"],
    });
    const post = (path: string, body: unknown, token = "secret") =>
      fetch(`http://127.0.0.1:${control.port}${path}?t=${token}`, {
        method: "POST",
        body: JSON.stringify(body),
      });

    try {
      expect((await post("/ready", {}, "wrong")).status).toBe(403);
      expect((await post("/ready", {})).status).toBe(200);
      await control.ready;
      expect((await post("/request", { id: "flow-1", method: "GET", url: "https://example.com", startedAt: 1_700_000_000_000 })).status).toBe(200);
      expect((await post("/response", {
        id: "flow-1",
        status: 200,
        durationMs: 12,
        req: { size: 4 },
        res: {
          size: 2,
          mime: "text/plain",
          headers: { authorization: "secret", "content-type": "text/plain" },
          body: "ok",
        },
      })).status).toBe(200);

      expect(store.list()[0]).toMatchObject({ status: 200, responseBytes: 2, durationMs: 12, startedAt: 1_700_000_000_000 });
      expect(store.body("r1")).toMatchObject({
        responseHeaders: { authorization: "[REDACTED]", "content-type": "text/plain" },
        responseBody: "ok",
      });

      await post("/request", { id: "flow-2", method: "GET", url: "https://example.com/image" });
      await post("/response", {
        id: "flow-2",
        status: 200,
        req: { size: 0 },
        res: { size: 4, mime: "image/png", base64: "//4AAQ==" },
      });
      expect(store.body("r2")).toMatchObject({
        responseBody: "//4AAQ==",
        responseBinary: true,
      });
    } finally {
      await new Promise<void>((resolve) => control.server.close(() => resolve()));
    }
  });

  test("answers 413 for a post over the body cap and reports it", async () => {
    const previous = process.env[MAX_CONTROL_BODY_BYTES_ENV];
    process.env[MAX_CONTROL_BODY_BYTES_ENV] = "1024";
    const oversized: { limit: number; path: string }[] = [];
    try {
      await withControl(async (post, store) => {
        await post("/request", { id: "flow-1", method: "GET", url: "https://example.com" });
        const response = await post("/response", { id: "flow-1", status: 200, res: { body: "x".repeat(4096) } });
        expect(response.status).toBe(413);
        expect(store.list()[0]!.status).toBeNull();
      }, (info) => oversized.push({ limit: info.limit, path: info.path }));
      expect(oversized).toEqual([{ limit: 1024, path: "/response" }]);
    } finally {
      if (previous === undefined) delete process.env[MAX_CONTROL_BODY_BYTES_ENV];
      else process.env[MAX_CONTROL_BODY_BYTES_ENV] = previous;
    }
  });

  test("forgets the oldest unanswered request past the pending limit", async () => {
    await withControl(async (post) => {
      for (let i = 0; i <= 1000; i++) {
        await post("/request", { id: `flow-${i}`, method: "GET", url: `https://example.com/${i}` });
      }
      const oldest = await post("/response", { id: "flow-0", status: 200 });
      const nextOldest = await post("/response", { id: "flow-1", status: 200 });
      const newest = await post("/response", { id: "flow-1000", status: 200 });
      expect(await oldest.json()).toEqual({ ok: false });
      expect(await nextOldest.json()).toEqual({ ok: true });
      expect(await newest.json()).toEqual({ ok: true });
    });
  });
});
