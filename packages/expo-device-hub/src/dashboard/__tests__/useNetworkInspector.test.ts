import { describe, expect, test } from "bun:test";

import { NETWORK_MAX_REQUESTS, type NetworkRequest } from "../../network-protocol";
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

  test("drops what the server evicted, with its body", () => {
    let state = applyNetworkMessage(INITIAL_NETWORK_STATE, {
      type: "snapshot",
      requests: [request("a"), request("b")],
    });
    state = applyNetworkMessage(state, {
      type: "response-body",
      id: "a",
      body: { body: "{}", base64Encoded: false },
    });
    state = applyNetworkMessage(state, { type: "request", request: request("c"), evicted: ["a"] });
    expect(state.requests.map((r) => r.id)).toEqual(["b", "c"]);
    expect(state.responseBodies).toEqual({});
  });

  test(`never holds more than ${NETWORK_MAX_REQUESTS} requests`, () => {
    let state = INITIAL_NETWORK_STATE;
    for (let i = 0; i <= NETWORK_MAX_REQUESTS; i++) {
      state = applyNetworkMessage(state, { type: "request", request: request(`r${i}`) });
    }
    expect(state.requests).toHaveLength(NETWORK_MAX_REQUESTS);
    expect(state.requests[0]!.id).toBe("r1");
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
          readyState: 1,
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
    expect(subscription.send({ type: "clear" })).toBe(true);
    sockets[0].readyState = 0;
    expect(subscription.send({ type: "clear" })).toBe(false);
    subscription.close();
    expect(subscription.send({ type: "clear" })).toBe(false);

    expect(received).toEqual([{ type: "cleared" }]);
    expect(sockets[0].sent).toEqual([JSON.stringify({ type: "clear" })]);
    expect(sockets).toHaveLength(1);
  });
});
