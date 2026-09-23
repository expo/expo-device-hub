import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import WebSocket from "ws";

import { gridDeviceState, simMiddleware } from "../middleware";
import { servePreview, type PreviewServer } from "../runtime";

const PORT = 3467;
const TOKEN = "exec-ws-restricted-token";
const MAX_ACTIONS_IN_FLIGHT_PER_SOCKET = 8;

let server: PreviewServer;

beforeAll(async () => {
  const middleware = simMiddleware({
    basePath: "/",
    execToken: TOKEN,
    device: "DEVICE-A",
    requirePreviewToken: true,
  });
  server = await servePreview({ port: PORT, middleware, host: "127.0.0.1" });
});

afterAll(() => {
  server?.stop(true);
});

interface Reply {
  ready?: boolean;
  sub?: number;
  end?: boolean;
  data?: string;
  id?: number;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  error?: string;
}

function connect(): Promise<{
  next: () => Promise<Reply>;
  send: (body: Record<string, unknown>) => void;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/exec-ws`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const queue: Reply[] = [];
    const waiters: Array<(r: Reply) => void> = [];
    const timer = setTimeout(() => reject(new Error("connect timeout")), 5000);
    ws.onopen = () => {
      clearTimeout(timer);
      ws.send(JSON.stringify({ token: TOKEN }));
      resolve({
        next: () =>
          new Promise<Reply>((r, rej) => {
            const queued = queue.shift();
            if (queued) return r(queued);
            const bail = setTimeout(() => rej(new Error("reply timeout")), 5000);
            waiters.push((reply) => {
              clearTimeout(bail);
              r(reply);
            });
          }),
        send: (body) => ws.send(JSON.stringify(body)),
        close: () => ws.close(),
      });
    };
    ws.onmessage = (event) => {
      const reply = JSON.parse(String(event.data)) as Reply;
      const waiter = waiters.shift();
      if (waiter) waiter(reply);
      else queue.push(reply);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("socket error"));
    };
  });
}

describe("gated POST refusals keep their status", () => {
  // Bun's node:http drops the status when a reply is written with the body unread.
  test("an unauthenticated POST is refused with 401, not an empty 200", async () => {
    const response = await fetch(`http://127.0.0.1:${PORT}/api`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(401);
    expect(await response.text()).toContain("token");
  });
});

describe("per-connection limits", () => {
  // A subscription holds a log stream child and an action spawns a process.
  test("refuses more subscriptions than the cap allows", async () => {
    const channel = await connect();
    await channel.next(); // ready
    for (let sub = 1; sub <= 17; sub++) channel.send({ sub, path: "/api/events" });

    // The subscribed route streams, so the refusal arrives among data frames rather than first.
    let refusal: Reply | undefined;
    while (!refusal) {
      let reply: Reply;
      try {
        reply = await channel.next();
      } catch {
        break;
      }
      if (reply.error?.includes("too many subscriptions")) refusal = reply;
    }

    expect(refusal).toBeDefined();
    // The cap has to bite at the 17th, not earlier: a cap of 1 would break the page.
    expect(refusal?.sub).toBe(17);
    channel.close();
  });

  test("refuses more actions in flight than the cap allows", async () => {
    const channel = await connect();
    await channel.next(); // ready
    for (let id = 1; id <= 20; id++) {
      channel.send({ id, action: "appearance.get", params: { udid: "DEVICE-A" } });
    }

    let refusal: Reply | undefined;
    for (let i = 0; i < 20 && !refusal; i++) {
      const reply = await channel.next();
      if (reply.error?.includes("too many actions")) refusal = reply;
    }

    expect(refusal).toBeDefined();
    expect(refusal?.id).toBeGreaterThan(MAX_ACTIONS_IN_FLIGHT_PER_SOCKET);
    channel.close();
  });
});

describe("grid-booted devices", () => {
  // The subcommands and metrics recorder authenticate from this file.
  test("carry the session token in their state file when gated", () => {
    const gated = gridDeviceState("DEVICE-B", 4100, "", undefined, TOKEN);
    const ungated = gridDeviceState("DEVICE-B", 4100, "", undefined, undefined);

    expect(gated.token).toBe(TOKEN);
    expect(ungated.token).toBeUndefined();
  });
});

describe("gated SSE fan-out", () => {
  // The subscription loops back through the gated server, so it must carry the token.
  test("streams a middleware route the gate would otherwise refuse", async () => {
    const channel = await connect();
    await channel.next(); // ready
    channel.send({ sub: 1, path: "/api/events" });
    const reply = await channel.next();

    expect(reply.sub).toBe(1);
    expect(reply.end).toBeUndefined();
    // Without the internal bearer the gate answers 401 and its body arrives here as stream data.
    expect(reply.data ?? "").not.toContain("Unauthorized");
    channel.close();
  });
});

describe("request body limit", () => {
  // Past the cap the body used to be truncated and handed downstream as if it were complete.
  test("answers 413 rather than acting on a partial body", async () => {
    const response = await fetch(`http://127.0.0.1:${PORT}/api`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: "x".repeat(9 * 1024 * 1024),
    });

    expect(response.status).toBe(413);
  });
});

describe("gated exec-ws accepts typed actions only", () => {
  test("refuses an action outside the allowed set", async () => {
    const channel = await connect();
    await channel.next();

    channel.send({ id: 2, action: "shell.run", params: { command: "echo owned" } });
    const reply = await channel.next();

    expect(reply.id).toBe(2);
    expect(reply.error).toMatch(/unknown action/i);
    channel.close();
  });

  test("runs an allowed action", async () => {
    const channel = await connect();
    await channel.next();

    channel.send({ id: 3, action: "appearance.get", params: { udid: "DEVICE-A" } });
    const reply = await channel.next();

    expect(reply.id).toBe(3);
    expect(reply.exitCode).toEqual(expect.any(Number));
    expect(reply.error).toBeUndefined();
    channel.close();
  });

  test("answers a duplicate subscription id instead of going silent", async () => {
    const socket = await connect();
    expect(await socket.next()).toMatchObject({ ready: true });

    socket.send({ sub: 500, path: "/api/events" });
    socket.send({ sub: 500, path: "/api/events" });

    const replies: Reply[] = [];
    for (let i = 0; i < 40; i += 1) {
      const reply = await socket.next();
      replies.push(reply);
      if (reply.error !== undefined) break;
    }
    socket.close();

    expect(replies.at(-1)?.error).toContain("already in use");
  }, 20_000);
});
