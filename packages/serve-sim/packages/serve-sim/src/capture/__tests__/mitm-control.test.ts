import { describe, expect, test } from "bun:test";

import { CONTROL_TOKEN_HEADER, MAX_CONTROL_BODY_BYTES_ENV, startMitmControl } from "../mitm-control";
import { CaptureStore } from "../store";

async function withControl(
  run: (post: (path: string, body: unknown) => Promise<Response>, store: CaptureStore) => Promise<void>,
  onOversizedBody?: (info: { bytesSeen: number; limit: number; path: string }) => void,
): Promise<void> {
  const store = new CaptureStore(() => 10);
  const control = await startMitmControl({ store, token: "secret", fields: [], onOversizedBody });
  const post = (path: string, body: unknown) =>
    fetch(`http://127.0.0.1:${control.port}${path}`, {
      method: "POST",
      headers: { [CONTROL_TOKEN_HEADER]: "secret" },
      body: JSON.stringify(body),
    });
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
      fetch(`http://127.0.0.1:${control.port}${path}`, {
        method: "POST",
        headers: { [CONTROL_TOKEN_HEADER]: token },
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

  test("counts a response whose request already left the store's list, instead of dropping it silently", async () => {
    const store = new CaptureStore(() => 10);
    const control = await startMitmControl({ store, token: "secret", fields: [] });
    const post = (path: string, body: unknown) =>
      fetch(`http://127.0.0.1:${control.port}${path}`, {
      method: "POST",
      headers: { [CONTROL_TOKEN_HEADER]: "secret" },
      body: JSON.stringify(body),
    });
    try {
      // 501 requests in flight: the store keeps the newest 500, so the first row is evicted.
      for (let i = 0; i <= 500; i++) {
        await post("/request", { id: `flow-${i}`, method: "GET", url: `https://example.com/${i}` });
      }
      expect(await (await post("/response", { id: "flow-0", status: 200 })).json()).toEqual({ ok: true, evicted: true });
      expect(control.lateResponses()).toBe(1);
      expect(await (await post("/response", { id: "flow-500", status: 200 })).json()).toEqual({ ok: true });
      // A flow the server never saw is still refused, and the addon counts it lost.
      expect(await (await post("/response", { id: "never-started", status: 200 })).json()).toEqual({ ok: false });
    } finally {
      await new Promise<void>((resolve) => control.server.close(() => resolve()));
    }
  });

  test("takes the token from its header only, never from the URL", async () => {
    await withControl(async (post) => {
      expect((await post("/ready", {})).status).toBe(200);
    });
    const store = new CaptureStore(() => 10);
    const control = await startMitmControl({ store, token: "secret", fields: [] });
    try {
      const inUrl = await fetch(`http://127.0.0.1:${control.port}/ready?t=secret`, { method: "POST", body: "{}" });
      expect(inUrl.status).toBe(403);
    } finally {
      await new Promise<void>((resolve) => control.server.close(() => resolve()));
    }
  });

  test("lets a response go when its request was cleared in flight, without reporting a loss", async () => {
    await withControl(async (post, store) => {
      await post("/request", { id: "flow-1", method: "GET", url: "https://example.com/1" });
      store.clear();
      expect(await (await post("/response", { id: "flow-1", status: 200 })).json()).toEqual({ ok: true, cleared: true });
      expect(store.list()).toHaveLength(0);
    });
  });

  test("drops a post that stalls before its body finishes", async () => {
    const { connect } = await import("node:net");
    const store = new CaptureStore(() => 10);
    const control = await startMitmControl({ store, token: "secret", fields: [], bodyTimeoutMs: 200 });
    try {
      const closed = await new Promise<boolean>((resolve) => {
        const socket = connect(control.port, "127.0.0.1", () => {
          // Promise 1000 bytes, send 10, then go quiet.
          socket.write(`POST /request HTTP/1.1\r\nHost: x\r\n${CONTROL_TOKEN_HEADER}: secret\r\nContent-Length: 1000\r\n\r\n0123456789`);
        });
        socket.on("close", () => resolve(true));
        socket.on("error", () => {});
        setTimeout(() => resolve(false), 3_000);
      });
      expect(closed).toBe(true);
      expect(store.list()).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve) => control.server.close(() => resolve()));
    }
  });
});
