import { describe, expect, test } from "bun:test";

import { type NetworkRequest } from "../../network-protocol";
import {
  applyNetworkMessage,
  INITIAL_NETWORK_STATE,
  subscribeToNetwork,
} from "../useNetworkInspector";

const request = (id: string, extra: Partial<NetworkRequest> = {}): NetworkRequest => ({
  id,
  method: "GET",
  url: `https://example.com/${id}`,
  startedAt: 1,
  ...extra,
});

describe("applyNetworkMessage", () => {
  test("adds new requests in order and updates known ones in place", () => {
    let state = applyNetworkMessage(INITIAL_NETWORK_STATE, {
      type: "snapshot",
      requests: [request("a")],
    });
    state = applyNetworkMessage(state, { type: "request", request: request("b") });
    state = applyNetworkMessage(state, { type: "request", request: request("a", { status: 200 }) });
    expect(state.requests.map((r) => [r.id, r.status])).toEqual([
      ["a", 200],
      ["b", undefined],
    ]);
  });

  test("clear drops requests and their bodies", () => {
    let state = applyNetworkMessage(INITIAL_NETWORK_STATE, {
      type: "request",
      request: request("a"),
    });
    state = applyNetworkMessage(state, {
      type: "response-body",
      id: "a",
      body: { body: "{}", base64Encoded: false },
    });
    state = applyNetworkMessage(state, { type: "cleared" });
    expect(state.requests).toEqual([]);
    expect(state.responseBodies).toEqual({});
  });

  test("records a body or why it is missing", () => {
    let state = applyNetworkMessage(INITIAL_NETWORK_STATE, {
      type: "response-body",
      id: "a",
      body: { body: "aGk=", base64Encoded: true },
    });
    state = applyNetworkMessage(state, {
      type: "response-body",
      id: "b",
      body: null,
      error: "gone",
    });
    expect(state.responseBodies).toEqual({
      a: { state: "loaded", body: "aGk=", base64Encoded: true },
      b: { state: "error", message: "gone" },
    });
  });

  test("takes the server's status", () => {
    const status = {
      state: "attached" as const,
      app: { id: "com.app", deviceName: "iPhone (iOS 27.1)" },
    };
    expect(applyNetworkMessage(INITIAL_NETWORK_STATE, { type: "status", status }).status).toEqual(
      status,
    );
  });
});

describe("subscribeToNetwork", () => {
  test("delivers messages, sends commands, and stops on close", () => {
    const sockets: any[] = [];
    const received: unknown[] = [];
    const subscription = subscribeToNetwork({
      url: "ws://hub/api/network/ws",
      createSocket: () => {
        const socket = {
          sent: [] as string[],
          send(d: string) {
            this.sent.push(d);
          },
          close() {
            this.onclose?.();
          },
          onmessage: null as any,
          onclose: null as any,
          onerror: null as any,
        };
        sockets.push(socket);
        return socket;
      },
      onMessage: (message) => received.push(message),
      onDisconnected: () => received.push("disconnected"),
    });

    sockets[0].onmessage({ data: JSON.stringify({ type: "cleared" }) });
    subscription.send({ type: "clear" });
    subscription.close();

    expect(received).toEqual([{ type: "cleared" }]);
    expect(sockets[0].sent).toEqual([JSON.stringify({ type: "clear" })]);
    expect(sockets).toHaveLength(1);
  });
});
