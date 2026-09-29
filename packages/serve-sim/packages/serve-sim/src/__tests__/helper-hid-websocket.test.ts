import { describe, expect, test } from "bun:test";
import { simMiddleware } from "../middleware";
import { claimHelperHidSocket } from "../middleware-utils";
import type { UpgradeHandlerWebSocket } from "../middleware-utils";

// handleWebSocket receives host-accepted sockets (Expo CLI plugin WS routes,
// the standalone hub CLI own the HTTP upgrade), so the helper HID channel must
// be claimable there — the raw-socket handleUpgrade path never runs for them.

function fakeSocket(): UpgradeHandlerWebSocket & { closed: boolean } {
  const listeners: Record<string, Array<(...args: never[]) => void>> = {};
  return {
    OPEN: 1,
    readyState: 1,
    closed: false,
    send() {},
    close() {
      this.closed = true;
    },
    on(event: string, listener: (...args: never[]) => void) {
      (listeners[event] ??= []).push(listener);
    },
  };
}

function upgradeRequest(url: string): Request {
  return new Request(url, { headers: { host: "localhost:3200" } });
}

describe("handleWebSocket helper HID dispatch", () => {
  const middleware = simMiddleware({ basePath: "/preview" });
  const handleWebSocket = middleware.handleWebSocket!;

  test("does not claim unrelated paths", () => {
    const ws = fakeSocket();
    const handled = handleWebSocket(
      upgradeRequest("http://localhost:3200/other/ws"),
      ws,
    );
    expect(handled).toBe(false);
    expect(ws.closed).toBe(false);
  });

  test("still claims the exec-ws channel", () => {
    const ws = fakeSocket();
    const handled = handleWebSocket(
      upgradeRequest("http://localhost:3200/preview/exec-ws"),
      ws,
    );
    expect(handled).toBe(true);
  });

  test("claims the query-form helper HID socket", () => {
    const ws = fakeSocket();
    const handled = handleWebSocket(
      upgradeRequest("http://localhost:3200/preview/helper/ws?device=NOT-A-REAL-UDID"),
      ws,
    );
    // Claimed either way; with no booted device the socket is closed instead
    // of left dangling for the host to guess about.
    expect(handled).toBe(true);
  });

  test("claims the path-form helper HID socket", () => {
    const ws = fakeSocket();
    const handled = handleWebSocket(
      upgradeRequest("http://localhost:3200/preview/helper/NOT-A-REAL-UDID/ws"),
      ws,
    );
    expect(handled).toBe(true);
  });

  test("closes a helper HID socket with no resolvable device", () => {
    const ws = fakeSocket();
    const handled = handleWebSocket(
      upgradeRequest("http://localhost:3200/preview/helper/ws"),
      ws,
    );
    expect(handled).toBe(true);
    expect(ws.closed).toBe(true);
  });

  test("does not claim non-ws helper endpoints", () => {
    const ws = fakeSocket();
    const handled = handleWebSocket(
      upgradeRequest("http://localhost:3200/preview/helper/NOT-A-REAL-UDID/stream.mjpeg"),
      ws,
    );
    expect(handled).toBe(false);
  });
});

test("host-accepted HID socket closes after its peer stops answering pings", async () => {
  const listeners: Record<string, Array<(...args: never[]) => void>> = {};
  let pings = 0;
  let terminated = false;
  const socket = {
    OPEN: 1,
    readyState: 1,
    send() {},
    close() {},
    ping() { pings++; },
    terminate() { terminated = true; },
    on(event: string, listener: (...args: never[]) => void) { (listeners[event] ??= []).push(listener); },
  } as UpgradeHandlerWebSocket;
  // Claim through the same host-accepted route used by embedded previews.
  let closes = 0;
  const handled = claimHelperHidSocket(
    new Request("http://localhost/preview/helper/DEVICE/ws"),
    socket,
    {
      helperProxyTarget: () => ({ device: "DEVICE", upstreamPath: "/ws" }),
      fallbackDevice: null,
      resolveSession: () => ({ attachHidSocket(ws) { ws.on("close", () => { closes++; }); } }),
    },
    { pingIntervalMs: 10, pongTimeoutMs: 40 },
  );
  expect(handled).toBe(true);
  await Promise.race([
    (async () => { while (!terminated) await Bun.sleep(10); })(),
    Bun.sleep(500).then(() => { throw new Error("Host HID socket did not time out"); }),
  ]);
  expect(pings).toBeGreaterThan(0);
  expect(closes).toBe(1);
});

test("host-accepted HID rejection preserves the retry code and reason", () => {
  let closedWith: [number | undefined, string | undefined] | undefined;
  const socket = {
    OPEN: 1,
    readyState: 1,
    send() {},
    close(code?: number, reason?: string) { closedWith = [code, reason]; },
    ping() {},
    on() {},
  } as UpgradeHandlerWebSocket;
  const handled = claimHelperHidSocket(
    new Request("http://localhost/preview/helper/DEVICE/ws"),
    socket,
    {
      helperProxyTarget: () => ({ device: "DEVICE", upstreamPath: "/ws" }),
      fallbackDevice: null,
      resolveSession: () => ({
        attachHidSocket(ws) { ws.close(1013, "Simulator input unavailable; retry after other clients disconnect"); },
      }),
    },
  );
  expect(handled).toBe(true);
  expect(closedWith).toEqual([1013, "Simulator input unavailable; retry after other clients disconnect"]);
});
