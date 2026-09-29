import { flushWsMessageQueue, sendOrQueueWsMessage, trySendWsMessage, type QueuedWsMessage } from "./send-queue";

type InputSocketHandlers = {
  onOpen(): void;
  /** Return true when the server's config frame confirms input was admitted. */
  onMessage(data: unknown): boolean;
  onDisconnect(): void;
  onRefused(reason: string): void;
  /** Clear a previously reported refusal once input is admitted. */
  onRecovered(): void;
};

/** Own input sends, reconnects, and the temporary 1013 refusal window. */
export function createInputSocket(
  url: string,
  handlers: InputSocketHandlers,
  {
    reconnectDelayMs = 1000,
    refusalDelayMs = 13_000,
    openSocket = (address: string) => new WebSocket(address),
  } = {},
) {
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let refusalTimer: ReturnType<typeof setTimeout> | null = null;
  let admitted = false;
  let reported = false;
  let stopped = false;
  let pendingMessages: QueuedWsMessage[] = [];

  const connect = () => {
    if (stopped || socket) return;
    admitted = false;
    const ws = openSocket(url);
    ws.binaryType = "arraybuffer";
    socket = ws;
    ws.onopen = () => {
      if (stopped || socket !== ws) return;
      handlers.onOpen();
    };
    ws.onmessage = (event) => {
      if (stopped || socket !== ws) return;
      if (handlers.onMessage(event.data)) {
        admitted = true;
        pendingMessages = flushWsMessageQueue(ws, pendingMessages);
        if (refusalTimer) clearTimeout(refusalTimer);
        refusalTimer = null;
        const wasReported = reported;
        reported = false;
        if (wasReported) handlers.onRecovered();
      }
    };
    ws.onclose = (event) => {
      if (stopped || socket !== ws) return;
      socket = null;
      admitted = false;
      if (event.code === 1013 && !refusalTimer && !reported) {
        const reason = event.reason || "The server is busy. Try again shortly.";
        refusalTimer = setTimeout(() => {
          refusalTimer = null;
          if (!stopped && !admitted) {
            reported = true;
            handlers.onRefused(reason);
          }
        }, refusalDelayMs);
      }
      handlers.onDisconnect();
      if (!stopped) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, reconnectDelayMs);
      }
    };
    ws.onerror = () => ws.close();
  };

  return {
    send(tag: number, payload: object) {
      // Opening the WebSocket does not mean DeviceSession accepted input.
      pendingMessages = sendOrQueueWsMessage(admitted ? socket : null, pendingMessages, tag, payload);
    },
    trySend(tag: number, payload: object) {
      return admitted && trySendWsMessage(socket, tag, payload);
    },
    start: connect,
    dispose() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (refusalTimer) clearTimeout(refusalTimer);
      socket?.close();
      socket = null;
      pendingMessages = [];
    },
  };
}
