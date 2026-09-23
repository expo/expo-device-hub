import { describe, expect, it } from "bun:test";

import { createExecWebSocketHandler } from "../exec-ws";
import type { UpgradeHandlerWebSocket } from "../middleware-utils";

const TOKEN = "teardown-token";

function fakeSocket() {
  const listeners: Record<string, Array<(arg?: unknown) => void>> = {};
  const on = ((event: string, listener: (arg?: unknown) => void) => {
    (listeners[event] ??= []).push(listener);
  }) as UpgradeHandlerWebSocket["on"];
  const ws: UpgradeHandlerWebSocket = {
    OPEN: 1,
    readyState: 1,
    send: () => {},
    close: () => (listeners.close ?? []).forEach((fn) => fn()),
    on,
  };
  return {
    ws,
    deliver: (frame: Record<string, unknown>) =>
      (listeners.message ?? []).forEach((fn) => fn(Buffer.from(JSON.stringify(frame)))),
  };
}

/**
 * A subscription torn down while its request is still in flight used to return without touching the
 * response body. Cancelling it is the only signal the upstream route gets: a subrequest from this
 * channel has no socket whose close it could notice, so its watcher, heartbeat or `log stream`
 * child would run for the life of the process.
 */
describe("subscription teardown during an in-flight request", () => {
  async function run(tearDown: (h: ReturnType<typeof fakeSocket>) => void): Promise<true> {
    const { promise: inFlight, resolve: release } = Promise.withResolvers<void>();
    const { promise: cancelled, resolve: onCancel } = Promise.withResolvers<true>();

    const handler = createExecWebSocketHandler({
      path: "/exec-ws",
      execToken: TOKEN,
      ssePrefixes: ["/api/events"],
      onSseRequest: async () => {
        await inFlight;
        return new Response(
          new ReadableStream({
            start() {},
            cancel() {
              onCancel(true);
            },
          }),
        );
      },
    });

    const h = fakeSocket();
    handler(new Request("http://127.0.0.1/exec-ws"), h.ws);
    h.deliver({ token: TOKEN });
    h.deliver({ sub: 1, path: "/api/events" });

    tearDown(h);
    release();
    return cancelled;
  }

  it("cancels the upstream body when the client unsubscribes first", async () => {
    expect(await run((h) => h.deliver({ unsub: 1 }))).toBe(true);
  });

  it("cancels the upstream body when the socket closes first", async () => {
    expect(await run((h) => h.ws.close())).toBe(true);
  });
});
