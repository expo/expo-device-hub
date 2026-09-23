import { crashRuntime } from "../crash/runtime";
import { logBufferCache } from "../log-buffer";
import { describe, expect, test } from "bun:test";
import type { IncomingMessage } from "http";
import type { Socket } from "net";

import { accessCookieName } from "../session-auth";
import { simMiddleware } from "../middleware";
import type { UpgradeHandlerWebSocket } from "../middleware-utils";

const TOKEN = "preview-token-xyz";
const ORIGIN = "http://192.168.1.20:34567";

function gated(requirePreviewToken: boolean, frameAncestors: string[] = []) {
  const handler = simMiddleware({ basePath: "/", execToken: TOKEN, requirePreviewToken, frameAncestors });
  return async (path: string, init?: RequestInit) => {
    const response = await handler(new Request(`${ORIGIN}${path}`, { redirect: "manual", ...init }));
    if (!response) throw new Error(`Unhandled request: ${path}`);
    return response;
  };
}

describe("preview access with --require-token", () => {
  test("refuses /api, so the token cannot be fetched by whoever asks first", async () => {
    const response = await gated(true)("/api");

    expect(response.status).toBe(401);
  });

  test("refuses the preview page that carries the token in its config", async () => {
    expect((await gated(true)("/")).status).toBe(401);
  });

  test("serves the HTML 401 page to a browser page load", async () => {
    const response = await gated(true, ["https://expo.dev"])("/", {
      headers: { "sec-fetch-dest": "document" },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("content-security-policy")).toBe(
      "frame-ancestors 'self' https://expo.dev",
    );
    const body = await response.text();
    expect(body).toContain("only opens with a token");
    expect(body).not.toContain(TOKEN);
  });

  test("serves /api to a caller that already holds the token", async () => {
    const response = await gated(true)("/api", { headers: { Authorization: `Bearer ${TOKEN}` } });

    expect(response.status).toBe(200);
  });

  test("trades a link token for a cookie and redirects it out of the URL", async () => {
    const response = await gated(true)(`/?token=${TOKEN}`, {
      headers: { "sec-fetch-dest": "document" },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
    expect(response.headers.get("set-cookie")).toContain(accessCookieName(TOKEN));
  });

  test("accepts the cookie it handed out", async () => {
    const response = await gated(true)("/api", {
      headers: { cookie: `${accessCookieName(TOKEN)}=${encodeURIComponent(TOKEN)}` },
    });

    expect(response.status).toBe(200);
  });

  test("keeps the plain-text 401 and no frame policy for an api caller", async () => {
    const response = await gated(true)("/api", { headers: { accept: "application/json" } });

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(response.headers.get("content-security-policy")).toBeNull();
    expect(await response.text()).toContain("Unauthorized.");
  });

  test("leaves everything open when the flag is off", async () => {
    expect((await gated(false)("/api")).status).toBe(200);
  });
});

describe("the rest of the surface with --require-token", () => {
  test("refuses to boot or shut down a simulator without the token", async () => {
    const request = gated(true);

    expect((await request("/grid/api/start", { method: "POST" })).status).toBe(401);
    expect((await request("/grid/api/shutdown", { method: "POST" })).status).toBe(401);
  });

  test("refuses to stream device metrics without the token", async () => {
    expect((await gated(true)("/metrics")).status).toBe(401);
  });

  test("accepts the cookie the browser already carries, so the UI keeps working", async () => {
    const cookie = { cookie: `${accessCookieName(TOKEN)}=${encodeURIComponent(TOKEN)}` };

    expect((await gated(true)("/grid/api", { headers: cookie })).status).toBe(200);
  });

  test("leaves all of it open when the flag is off", async () => {
    expect((await gated(false)("/grid/api")).status).toBe(200);
  });
});

describe("the protected surface", () => {
  // Opting in per route left /api/screenshot, /logs, /ax and /devtools open.
  const GATED = [
    "/api",
    "/api/events",
    "/api/screenshot",
    "/api/event-log",
    "/grid/api",
    "/grid/api/start",
    "/grid/api/shutdown",
    "/metrics",
    "/logs",
    "/crashes",
    "/crashes/INC-1",
    "/ax",
    "/appstate",
    "/devtools",
  ];

  test("refuses every route that is not a liveness probe", async () => {
    const request = gated(true);
    const allowed: string[] = [];

    for (const path of GATED) {
      if ((await request(path)).status !== 401) allowed.push(path);
    }

    expect(allowed).toEqual([]);
  });

  test("leaves the liveness probes open even with the flag on, since a probe cannot hold a token", async () => {
    const request = gated(true);

    for (const path of ["/healthz", "/readyz"]) {
      expect((await request(path)).status).not.toBe(401);
    }
  });
});

describe("websocket upgrades with --require-token", () => {
  // Upgrades never reach the HTTP gate, so they are gated at the two upgrade entry points instead.

  function fakeSocket() {
    const calls = { destroyed: false, ended: false };
    const socket = {
      destroy: () => {
        calls.destroyed = true;
      },
      end: () => {
        calls.ended = true;
      },
    };
    return { calls, socket: socket as unknown as Socket };
  }

  function upgradeRequest(url: string) {
    return { url, method: "GET", headers: {} } as unknown as IncomingMessage;
  }

  function fakeWebSocket() {
    const calls = { closed: false, listeners: 0 };
    const ws: UpgradeHandlerWebSocket = {
      OPEN: 1,
      readyState: 1,
      on: () => {
        calls.listeners += 1;
      },
      send: () => {},
      close: () => {
        calls.closed = true;
      },
    };
    return { calls, ws };
  }

  // The devtools branch is async, so a synchronous teardown can only be the gate.
  test("destroys a tokenless devtools socket (handleUpgrade)", () => {
    const handler = simMiddleware({ basePath: "/", execToken: TOKEN, requirePreviewToken: true });
    const { calls, socket } = fakeSocket();

    handler.handleUpgrade?.(upgradeRequest("/devtools/page/1"), socket, Buffer.alloc(0));

    expect(calls.destroyed).toBe(true);
  });

  // exec-ws would otherwise wire the socket and wait for its token frame.
  test("closes a tokenless exec-ws socket before wiring it (handleWebSocket)", () => {
    const handler = simMiddleware({ basePath: "/", execToken: TOKEN, requirePreviewToken: true });
    const { calls, ws } = fakeWebSocket();

    const claimed = handler.handleWebSocket?.(new Request(`${ORIGIN}/exec-ws`), ws);

    expect(claimed).toBe(true);
    expect(calls.closed).toBe(true);
    expect(calls.listeners).toBe(0);
  });

  test("wires the exec-ws socket when it carries the cookie", () => {
    const handler = simMiddleware({ basePath: "/", execToken: TOKEN, requirePreviewToken: true });
    const { calls, ws } = fakeWebSocket();

    handler.handleWebSocket?.(
      new Request(`${ORIGIN}/exec-ws`, {
        headers: { cookie: `${accessCookieName(TOKEN)}=${encodeURIComponent(TOKEN)}` },
      }),
      ws,
    );

    expect(calls.closed).toBe(false);
    expect(calls.listeners).toBeGreaterThan(0);
  });

  test("leaves upgrades open when the flag is off", () => {
    const handler = simMiddleware({ basePath: "/", execToken: TOKEN, requirePreviewToken: false });
    const { calls, ws } = fakeWebSocket();

    handler.handleWebSocket?.(new Request(`${ORIGIN}/exec-ws`), ws);

    expect(calls.closed).toBe(false);
    expect(calls.listeners).toBeGreaterThan(0);
  });
});


test("rejected log and crash requests start neither the watcher nor the log child", async () => {
  const start = crashRuntime.start;
  const ensure = logBufferCache.ensure;
  let watcherStarts = 0;
  let logStarts = 0;
  crashRuntime.start = async () => { watcherStarts += 1; };
  logBufferCache.ensure = () => { logStarts += 1; throw new Error("Unexpected log startup"); };
  try {
    const request = gated(true);
    for (const path of ["/logs?follow=1&snapshot=1", "/logs", "/crashes?tail=1", "/crashes/INC-1"]) {
      for (const accept of ["application/json", "text/event-stream"]) {
        expect((await request(path, { headers: { accept } })).status).toBe(401);
      }
    }
    expect(watcherStarts).toBe(0);
    expect(logStarts).toBe(0);
  } finally {
    crashRuntime.start = start;
    logBufferCache.ensure = ensure;
  }
});
