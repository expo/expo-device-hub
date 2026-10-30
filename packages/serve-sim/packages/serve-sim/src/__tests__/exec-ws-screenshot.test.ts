import { expect, test } from "bun:test";
import { createExecWebSocketHandler } from "../socket/server-control";
import type { UpgradeHandlerWebSocket } from "../socket/types";

function channel(handler: (payload: unknown) => Promise<Response>, authenticated = true) {
  let receive!: (data: Buffer) => void;
  const sent: Array<string | Buffer> = [];
  const pending = new Set<Promise<unknown>>();
  const ws = {
    OPEN: 1,
    readyState: 1,
    send: (data: string | Buffer) => sent.push(data),
    close() {},
    on(event: string, listener: typeof receive) {
      if (event === "message") receive = listener;
    },
  } as UpgradeHandlerWebSocket;
  createExecWebSocketHandler({
    path: "/exec-ws",
    execToken: "test",
    pendingActions: pending,
    onScreenshotRequest: handler,
  })(
    new Request("http://localhost/exec-ws", {
      headers: authenticated ? { "sec-websocket-protocol": "serve-sim.token.test" } : {},
    }),
    ws,
  );
  return { sent, pending, ws, send: (body: unknown) => receive(Buffer.from(JSON.stringify(body))) };
}

test("binary capture enforces authentication, bounded admission and safe request IDs", async () => {
  let calls = 0;
  const h = channel(async () => {
    calls++;
    return new Response("PNG");
  }, false);
  h.send({ id: 1, screenshot: {} });
  expect(calls).toBe(0);
  h.send({ token: "test" });
  for (const id of [-1, 1.5, 2 ** 32]) h.send({ id, screenshot: {} });
  expect(calls).toBe(0);
  const { promise, resolve } = Promise.withResolvers<Response>();
  const busy = channel(() => promise.then((response) => response.clone()));
  for (let id = 0; id < 9; id++) busy.send({ id, screenshot: {} });
  expect(busy.pending.size).toBe(8);
  expect(busy.sent.at(-1)).toContain("too many actions");
  resolve(new Response("PNG"));
  await Promise.all(busy.pending);
});

test("capture errors remain correlated JSON and disconnected sockets receive no PNG", async () => {
  const h = channel(async () =>
    Response.json({ error: "Invalid simulator display ID" }, { status: 400 }),
  );
  h.send({ id: 7, screenshot: {} });
  await Promise.all(h.pending);
  expect(JSON.parse(String(h.sent.at(-1)))).toEqual({
    id: 7,
    error: "Invalid simulator display ID",
  });
  const { promise, resolve } = Promise.withResolvers<Response>();
  const closed = channel(() => promise);
  closed.send({ id: 8, screenshot: {} });
  Object.defineProperty(closed.ws, "readyState", { value: 3 });
  resolve(new Response("PNG"));
  await Promise.all(closed.pending);
  expect(closed.sent.filter(Buffer.isBuffer)).toHaveLength(0);
});

test("a screenshot returns one correlated binary PNG, including concurrent out-of-order replies", async () => {
  let release!: (response: Response) => void;
  const slow = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const h = channel(async (payload) => (payload === "slow" ? slow : new Response("PNG2")));
  h.send({ id: 1, screenshot: "slow" });
  h.send({ id: 2, screenshot: {} });
  await new Promise((resolve) => setImmediate(resolve));
  release(new Response("PNG1"));
  await Promise.all(h.pending);
  const frames = h.sent.filter((frame): frame is Buffer => Buffer.isBuffer(frame));
  expect(frames.map((frame) => frame.readUInt32BE())).toEqual([2, 1]);
  expect(frames.map((frame) => frame.subarray(4).toString())).toEqual(["PNG2", "PNG1"]);
  expect(h.pending.size).toBe(0);
});
