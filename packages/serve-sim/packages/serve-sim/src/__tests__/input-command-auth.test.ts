import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import type { ServerWebSocket } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { textToKeyEvents, sendKeyEventsToWs } from "../text-to-keys";

describe("sendKeyEventsToWs authorization", () => {
  let server: ReturnType<typeof Bun.serve>;
  let wsUrl: string;
  let authHeaders: Array<string | null>;

  beforeAll(() => {
    authHeaders = [];
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, srv) {
        authHeaders.push(req.headers.get("authorization"));
        if (srv.upgrade(req, { data: undefined })) return;
        return new Response("not a ws", { status: 400 });
      },
      websocket: {
        message(_ws: ServerWebSocket<unknown>) {},
      },
    });
    wsUrl = `ws://127.0.0.1:${server.port}/ws`;
  });

  afterAll(() => {
    server.stop(true);
  });

  it("sends the session token as a bearer header", async () => {
    authHeaders.length = 0;
    await sendKeyEventsToWs(wsUrl, textToKeyEvents("a"), {
      token: "tok-1",
      perEventDelayMs: 0,
    });

    expect(authHeaders[0]).toBe("Bearer tok-1");
  });

  it("sends no authorization when the server runs ungated", async () => {
    authHeaders.length = 0;
    await sendKeyEventsToWs(wsUrl, textToKeyEvents("a"), { perEventDelayMs: 0 });

    expect(authHeaders[0]).toBeNull();
  });
});

// index.ts has no exports to drive, so the invariant is guarded at the source instead: the
// token-carrying helpers are the only way to the socket.
describe("CLI input commands cannot bypass the gate", () => {
  const source = readFileSync(join(import.meta.dir, "..", "index.ts"), "utf-8");

  it("opens every helper socket through openHelperSocket", () => {
    const constructions = source.match(/new WebSocket\(/g) ?? [];

    expect(constructions).toHaveLength(1);
    expect(source).toContain("function openHelperSocket(state: ServerState): WebSocket {");
  });

  it("passes the session token on every sendKeyEventsToWs call", () => {
    const calls = source.match(/sendKeyEventsToWs\([^)]*\)/g) ?? [];

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).toContain("token: state.token");
    }
  });
});
