import { flushWsMessageQueue, sendOrQueueWsMessage, trySendWsMessage, type QueuedWsMessage } from "./ws-send-queue";
import { WS_MSG_INPUT_ADMITTED, WS_REASON_INPUT_UNAVAILABLE } from "./input-protocol";

type InputSocketHandlers = {
  onAdmitted(): void;
  /** Return true for a config frame from an older server that lacks an admission frame. */
  onMessage(data: unknown): boolean;
  onDisconnect(): void;
  onRefused(reason: string): void;
  /** Clear a previously reported refusal once input is admitted. */
  onRecovered(): void;
};

// @ref LLP 0013#input-admission — opening is not admission; an unavailable refusal waits out its grace
/** Own input sends, reconnects, and the temporary 1013 refusal window. */
export function createInputSocket(
  url: string,
  handlers: InputSocketHandlers,
  {
    requireAdmission = true,
    legacyOpenGraceMs = 1000,
    reconnectDelayMs = 1000,
    // Longer than the server's HID_HEARTBEAT pong timeout plus one reconnect, so a slot held
    // by a stranded socket frees up before the notice shows.
    refusalDelayMs = 13_000,
    openSocket = (address: string) => new WebSocket(address),
  } = {},
) {
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let refusalTimer: ReturnType<typeof setTimeout> | null = null;
  let legacyTimer: ReturnType<typeof setTimeout> | null = null;
  let admitted = false;
  let reported = false;
  let stopped = false;
  let pendingMessages: QueuedWsMessage[] = [];

  const connect = () => {
    if (stopped || socket) return;
    admitted = false;
    let ws: WebSocket;
    try { ws = openSocket(url); } catch {
      reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, reconnectDelayMs);
      return;
    }
    ws.binaryType = "arraybuffer";
    socket = ws;
    const confirmAdmission = () => {
      if (refusalTimer) clearTimeout(refusalTimer);
      refusalTimer = null;
      const wasReported = reported;
      reported = false;
      if (wasReported) handlers.onRecovered();
    };
    const admit = (confirmed: boolean) => {
      const firstAdmission = !admitted;
      admitted = true;
      pendingMessages = flushWsMessageQueue(ws, pendingMessages);
      if (firstAdmission) handlers.onAdmitted();
      if (confirmed) confirmAdmission();
    };
    ws.onopen = () => {
      if (stopped || socket !== ws || requireAdmission) return;
      // Older helpers have no admission frame and may have no dimensions yet.
      admit(false);
      // Give an immediate 1013 refusal time to arrive before clearing its notice.
      legacyTimer = setTimeout(() => {
        legacyTimer = null;
        if (!stopped && socket === ws && ws.readyState === 1) confirmAdmission();
      }, legacyOpenGraceMs);
    };
    ws.onmessage = (event) => {
      if (stopped || socket !== ws) return;
      const admissionFrame = event.data instanceof ArrayBuffer &&
        event.data.byteLength === 1 && new Uint8Array(event.data)[0] === WS_MSG_INPUT_ADMITTED;
      const legacyAdmission = handlers.onMessage(event.data);
      if (admissionFrame || (!requireAdmission && legacyAdmission)) {
        admit(true);
      }
    };
    ws.onclose = (event) => {
      if (stopped || socket !== ws) return;
      if (legacyTimer) clearTimeout(legacyTimer);
      legacyTimer = null;
      socket = null;
      admitted = false;
      if (event.code === 1013 && event.reason !== WS_REASON_INPUT_UNAVAILABLE) {
        // An admitted socket can lose queued input before a retry succeeds.
        // Keep that warning visible for its normal toast duration after recovery.
        if (refusalTimer) clearTimeout(refusalTimer);
        refusalTimer = null;
        reported = false;
        handlers.onRefused(event.reason || "The server is busy. Try again shortly.");
      } else if (event.code === 1013 && !refusalTimer && !reported) {
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
    ws.onerror = () => { if (!stopped && socket === ws) ws.close(); };
  };

  return {
    send(tag: number, payload: object) {
      // New helpers require admission; legacy helpers keep their prior open behavior.
      pendingMessages = sendOrQueueWsMessage(admitted ? socket : null, pendingMessages, tag, payload);
    },
    // @ref LLP 0013#input-ownership — complete gestures stay queued; a held touch is released
    discardUnfinishedGestures(tag: number) {
      // Keep complete begin/end pairs in their original order and with their original TTL.
      const completed = new Set<QueuedWsMessage>();
      let gesture: QueuedWsMessage[] = [];
      for (const message of pendingMessages) {
        if (message.tag !== tag) continue;
        const phase = (message.payload as { type?: string }).type;
        if (phase === "begin") gesture = [message];
        else if (gesture.length) {
          gesture.push(message);
          if (phase === "end") {
            for (const entry of gesture) completed.add(entry);
            gesture = [];
          }
        }
      }
      pendingMessages = pendingMessages.filter(message => message.tag !== tag || completed.has(message));
    },
    discardQueued(tag: number) {
      pendingMessages = pendingMessages.filter(message => message.tag !== tag);
    },
    trySend(tag: number, payload: object) {
      return admitted && trySendWsMessage(socket, tag, payload);
    },
    start: connect,
    dispose() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (refusalTimer) clearTimeout(refusalTimer);
      if (legacyTimer) clearTimeout(legacyTimer);
      socket?.close();
      socket = null;
      pendingMessages = [];
    },
  };
}
