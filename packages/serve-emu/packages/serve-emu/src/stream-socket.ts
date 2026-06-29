/**
 * A minimal, transport-agnostic WebSocket surface.
 *
 * The streaming core in `middleware.ts` drives clients through this interface so
 * it works against both Bun's native `ServerWebSocket` (the standalone
 * `serve-emu` server) and the Node `ws` sockets that `@expo/cli` hands to a
 * DevTools plugin's `webSocketHandlers` — without depending on either's types.
 *
 * Only what the core needs: send (binary frames + JSON acks), backpressure
 * introspection, close, and inbound text messages (binary inbound is ignored).
 */
export interface StreamSocket {
  /** Bytes queued but not yet flushed to the peer; the core's backpressure signal. */
  readonly bufferedAmount: number;
  /** Send a binary frame (typed array) or a text message (JSON string). */
  send(data: string | Uint8Array): void;
  /** Close the connection with an optional WebSocket close code + reason. */
  close(code?: number, reason?: string): void;
  /** Register a handler for inbound text messages. */
  onMessage(handler: (text: string) => void): void;
  /** Register a handler invoked once when the socket closes. */
  onClose(handler: () => void): void;
}

/**
 * Callbacks the core registers via {@link StreamSocket.onMessage}/`onClose`.
 *
 * Bun delivers message/close through the server-level `websocket` handlers
 * rather than per-socket listeners, so the Bun adapter stashes these on
 * `ws.data` and `server.ts` forwards the events into them.
 */
export interface BunSocketHandlers {
  message?: (text: string) => void;
  close?: () => void;
}

/** The slice of Bun's `ServerWebSocket` the adapter relies on. */
export interface BunServerWebSocketLike {
  send(data: string | Uint8Array): number;
  close(code?: number, reason?: string): void;
  getBufferedAmount(): number;
  data: { handlers?: BunSocketHandlers };
}

/** Adapt a Bun `ServerWebSocket` (whose `data.handlers` `server.ts` dispatches to). */
export function fromBunSocket(ws: BunServerWebSocketLike): StreamSocket {
  const handlers: BunSocketHandlers = (ws.data.handlers ??= {});
  return {
    get bufferedAmount() {
      return ws.getBufferedAmount();
    },
    send(data) {
      ws.send(data);
    },
    close(code, reason) {
      ws.close(code, reason);
    },
    onMessage(handler) {
      handlers.message = handler;
    },
    onClose(handler) {
      handlers.close = handler;
    },
  };
}

/**
 * The slice of a `ws`-package socket the adapter relies on — typed structurally
 * so `serve-emu` needn't depend on `ws`. This is what `@expo/cli` passes to a
 * plugin's `webSocketHandlers`.
 */
export interface WsWebSocketLike {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  readonly bufferedAmount: number;
  on(event: "message", listener: (data: unknown, isBinary: boolean) => void): unknown;
  on(event: "close", listener: () => void): unknown;
}

/** Adapt a `ws`-package WebSocket (used by the Expo DevTools plugin bridge). */
export function fromWsSocket(ws: WsWebSocketLike): StreamSocket {
  return {
    get bufferedAmount() {
      return ws.bufferedAmount;
    },
    send(data) {
      ws.send(data);
    },
    close(code, reason) {
      ws.close(code, reason);
    },
    onMessage(handler) {
      ws.on("message", (data, isBinary) => {
        if (isBinary) return;
        handler(typeof data === "string" ? data : String(data));
      });
    },
    onClose(handler) {
      ws.on("close", () => handler());
    },
  };
}
