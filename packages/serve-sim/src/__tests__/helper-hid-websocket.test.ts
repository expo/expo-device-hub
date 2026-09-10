import { describe, expect, test } from "bun:test";
import { simMiddleware } from "../middleware";
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

describe("handleWebSocket helper HID dispatch", () => {
  const middleware = simMiddleware({ basePath: "/preview" });
  const handleWebSocket = middleware.handleWebSocket!;

  test("does not claim unrelated paths", () => {
    const ws = fakeSocket();
    const handled = handleWebSocket(
      new Request("http://localhost:3200/other/ws"),
      ws,
    );
    expect(handled).toBe(false);
    expect(ws.closed).toBe(false);
  });

  test("still claims the exec-ws channel", () => {
    const ws = fakeSocket();
    const handled = handleWebSocket(
      new Request("http://localhost:3200/preview/exec-ws"),
      ws,
    );
    expect(handled).toBe(true);
  });

  test("claims the query-form helper HID socket", () => {
    const ws = fakeSocket();
    const handled = handleWebSocket(
      new Request("http://localhost:3200/preview/helper/ws?device=NOT-A-REAL-UDID"),
      ws,
    );
    // Claimed either way; with no booted device the socket is closed instead
    // of left dangling for the host to guess about.
    expect(handled).toBe(true);
  });

  test("claims the path-form helper HID socket", () => {
    const ws = fakeSocket();
    const handled = handleWebSocket(
      new Request("http://localhost:3200/preview/helper/NOT-A-REAL-UDID/ws"),
      ws,
    );
    expect(handled).toBe(true);
  });

  test("closes a helper HID socket with no resolvable device", () => {
    const ws = fakeSocket();
    const handled = handleWebSocket(
      new Request("http://localhost:3200/preview/helper/ws"),
      ws,
    );
    expect(handled).toBe(true);
    expect(ws.closed).toBe(true);
  });

  test("does not claim non-ws helper endpoints", () => {
    const ws = fakeSocket();
    const handled = handleWebSocket(
      new Request("http://localhost:3200/preview/helper/NOT-A-REAL-UDID/stream.mjpeg"),
      ws,
    );
    expect(handled).toBe(false);
  });
});
