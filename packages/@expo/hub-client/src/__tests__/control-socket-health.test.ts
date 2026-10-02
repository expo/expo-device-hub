import { afterEach, expect, test } from "bun:test";
import { createControlSocket } from "../control-socket.js";

type Message = Record<string, unknown>;
const cleanup: (() => void)[] = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((stop) => stop()),
);

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await Bun.sleep(2);
  }
}

function setup({ dropFirst = false, actionDelayMs = 0 } = {}) {
  let connections = 0;
  let muteFirst = false;
  const messages: { connection: number; body: Message }[] = [];
  const server = Bun.serve<{ connection: number }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request, { data: { connection: ++connections } })) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      message(ws, data) {
        const body = JSON.parse(String(data)) as Message;
        messages.push({ connection: ws.data.connection, body });
        const reply = (body: Message) => ws.send(JSON.stringify(body));
        if ("token" in body) {
          reply({ ready: true });
          if (dropFirst && ws.data.connection === 1) muteFirst = true;
          return;
        }
        if (muteFirst && ws.data.connection === 1) return;
        if (typeof body.sub === "number") reply({ sub: body.sub, data: "current" });
        else if (typeof body.id === "number") {
          if (typeof body.action !== "string") reply({ id: body.id, error: "unsupported request" });
          else setTimeout(() => reply({ id: body.id, stdout: "done" }), actionDelayMs);
        }
      },
    },
  });
  cleanup.push(() => server.stop(true));
  const channel = createControlSocket(`ws://127.0.0.1:${server.port}`, "token", {
    healthIntervalMs: 10,
    healthTimeoutMs: 20,
    retryMs: 5,
    connectTimeoutMs: 200,
  });
  cleanup.push(() => channel.dispose());
  return { channel, messages, connections: () => connections };
}

test("an authenticated silent OPEN channel reconnects subscriptions without replaying writes", async () => {
  const { channel, messages, connections } = setup({ dropFirst: true });
  const chunks: string[] = [];
  let ends = 0;
  channel.subscribe(
    "/logs",
    (chunk) => chunks.push(chunk),
    () => ends++,
  );
  const result = channel.request({ action: "write" }, 500).catch((error) => error);
  expect((await result).message).toBe("exec-ws timeout");
  await waitFor(() => chunks.length === 1);
  expect(connections()).toBe(2);
  expect(ends).toBe(1);
  expect(messages.filter(({ body }) => body.action === "write")).toHaveLength(1);
  expect(messages.some(({ connection, body }) => connection === 2 && body.sub !== undefined)).toBe(
    true,
  );
});

test("a slow host action does not retire a healthy channel", async () => {
  const { channel, messages, connections } = setup({ actionDelayMs: 100 });
  expect((await channel.request({ action: "slow" }, 500)).stdout).toBe("done");
  expect(connections()).toBe(1);
  expect(
    messages.filter(({ body }) => typeof body.id === "number" && !("action" in body)).length,
  ).toBeGreaterThan(2);
});

test("after a request-only channel loses health, a manual retry opens a fresh channel", async () => {
  const { channel, messages, connections } = setup({ dropFirst: true });
  await expect(channel.request({ action: "write" }, 500)).rejects.toThrow("exec-ws timeout");
  await Bun.sleep(30);
  expect(connections()).toBe(1);
  expect((await channel.request({ action: "retry" }, 500)).stdout).toBe("done");
  expect(connections()).toBe(2);
  expect(messages.filter(({ body }) => body.action === "write")).toHaveLength(1);
});

test("disposal removes the health timer and prevents a subscription reconnect", async () => {
  const { channel, connections } = setup({ dropFirst: true });
  channel.subscribe(
    "/logs",
    () => {},
    () => {},
  );
  await waitFor(() => connections() === 1);
  channel.dispose();
  await Bun.sleep(80);
  expect(connections()).toBe(1);
});
