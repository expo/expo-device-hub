import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import WebSocket from "ws";

import { simMiddleware } from "../middleware";
import { servePreview, type PreviewServer } from "../runtime";

const PORT = 3471;
const TOKEN = "gated-wiring-token";
const DEVICE = "404F2659-7202-4450-8465-912BD2AB744B";
const BASE = `http://127.0.0.1:${PORT}`;

let server: PreviewServer;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  const middleware = simMiddleware({
    basePath: "/",
    execToken: TOKEN,
    device: DEVICE,
    requirePreviewToken: true,
  });
  server = await servePreview({ port: PORT, middleware, host: "127.0.0.1" });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

afterAll(() => {
  server?.stop(true);
});

function connect(): Promise<{
  send: (body: Record<string, unknown>) => void;
  next: () => Promise<Record<string, unknown>>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace("http", "ws")}/exec-ws`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const queue: Array<Record<string, unknown>> = [];
    const waiters: Array<(r: Record<string, unknown>) => void> = [];
    const timer = setTimeout(() => reject(new Error("connect timeout")), 5000);
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as Record<string, unknown>;
      const waiter = waiters.shift();
      if (waiter) waiter(msg);
      else queue.push(msg);
    });
    ws.on("open", () => {
      clearTimeout(timer);
      ws.send(JSON.stringify({ token: TOKEN }));
      resolve({
        send: (body) => ws.send(JSON.stringify(body)),
        next: () =>
          new Promise((r) => {
            const queued = queue.shift();
            if (queued) return r(queued);
            waiters.push(r);
          }),
        close: () => ws.close(),
      });
    });
    ws.on("error", reject);
  });
}

describe("the socket's own wiring into the middleware", () => {
  // The event log is what an operator reads to see what a shared link did, so an action has to
  // reach it through the socket, not only through the recorder called directly.
  it("files an action from the socket into the device event log", async () => {
    const socket = await connect();
    expect(await socket.next()).toMatchObject({ ready: true });

    socket.send({ id: 1, action: "button", params: { value: "home", udid: DEVICE } });
    await socket.next();
    socket.close();

    const res = await fetch(`${BASE}/api/event-log?device=${DEVICE}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events?: Array<Record<string, unknown>> };
    expect(JSON.stringify(body.events ?? [])).toContain("home");
  });

  // A child's failure carries the host's absolute paths and argv, so only validation messages,
  // which are the caller's own input, may come back.
  it("replaces a simulator failure with a message carrying no host detail", async () => {
    const socket = await connect();
    expect(await socket.next()).toMatchObject({ ready: true });

    // The set path spawns simctl; the status path answers "unsupported" without failing.
    socket.send({ id: 2, ui: { device: "NO-SUCH-DEVICE-0000", option: "appearance", value: "dark" } });
    const reply = (await socket.next()) as { error?: string };
    socket.close();

    expect(reply.error).toBe("the simulator rejected this UI request");
    expect(reply.error).not.toContain("/Users/");
    expect(reply.error).not.toContain("xcrun");
  });

  it("keeps a validation message, which describes only what the caller sent", async () => {
    const socket = await connect();
    expect(await socket.next()).toMatchObject({ ready: true });

    socket.send({ id: 3, ui: { device: DEVICE, option: "not-an-option" } });
    const reply = (await socket.next()) as { error?: string };
    socket.close();

    expect(reply.error).toContain("unknown option");
  });
});

describe("devtools proxy", () => {
  it("forwards the rest of the query but never the session token", async () => {
    let upstream = "";
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const target = String(input);
      if (!target.includes("chrome-devtools-frontend")) return realFetch(input, init);
      upstream = target;
      return new Response("//", { headers: { "Content-Type": "application/javascript" } });
    }) as typeof fetch;

    const res = await fetch(
      `${BASE}/devtools-frontend/panel.js?token=${TOKEN}&rev=1`,
      { headers: { Authorization: `Bearer ${TOKEN}` } },
    );

    expect(res.status).toBe(200);
    expect(upstream).toContain("rev=1");
    expect(upstream).not.toContain(TOKEN);
    expect(upstream).not.toContain("token=");
  });
});
