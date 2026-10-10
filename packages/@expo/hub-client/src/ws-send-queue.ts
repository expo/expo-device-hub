/**
 * Tagged-JSON send queue for the helper's binary input WebSocket, ported from
 * serve-sim's `utils/ws-send-queue.ts`. Input that arrives while the socket is
 * (re)connecting is held briefly and flushed on open, so a tap during a
 * reconnect is not silently dropped — while stale gestures are discarded
 * instead of replayed late.
 */

export const WS_OPEN_READY_STATE = 1;

export type WsMessagePayload = object | (() => object);
export type WsMessageSent = (payload: object) => void;

export type QueuedWsMessage = {
  tag: number;
  payload: WsMessagePayload;
  createdAt: number;
  onSent?: WsMessageSent;
  // A later send can throw before the caller replaces its queue. Keep successful
  // entries consumed so retrying that original array cannot replay lazy intent.
  sent?: true;
};

export type WsSendTarget = {
  readyState: number;
  send(data: ArrayBuffer): void;
};

const DEFAULT_MAX_QUEUE_SIZE = 32;
const DEFAULT_MAX_QUEUE_AGE_MS = 1_500;

function sendMessage(
  ws: WsSendTarget,
  message: Pick<QueuedWsMessage, 'tag' | 'payload' | 'onSent' | 'sent'>,
) {
  // Resolve intent only at delivery, so dropped rotations never advance a cursor.
  const payload = typeof message.payload === 'function' ? message.payload() : message.payload;
  ws.send(encodeWsMessage(message.tag, payload).buffer);
  message.sent = true;
  message.onSent?.(payload);
}

/** `[tag][JSON]` — the helper's binary frame layout. */
export function encodeWsMessage(tag: number, payload: object): Uint8Array<ArrayBuffer> {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  const msg = new Uint8Array(1 + json.length);
  msg[0] = tag;
  msg.set(json, 1);
  return msg;
}

export function enqueueWsMessage(
  queue: QueuedWsMessage[],
  message: QueuedWsMessage,
  maxQueueSize = DEFAULT_MAX_QUEUE_SIZE,
): QueuedWsMessage[] {
  const next = [...queue, message];
  return next.length > maxQueueSize ? next.slice(next.length - maxQueueSize) : next;
}

/** Send every fresh queued message when the socket is open; returns what is still pending. */
export function flushWsMessageQueue(
  ws: WsSendTarget | null | undefined,
  queue: QueuedWsMessage[],
  now = Date.now(),
  maxQueueAgeMs = DEFAULT_MAX_QUEUE_AGE_MS,
): QueuedWsMessage[] {
  const fresh = queue.filter((message) => !message.sent && now - message.createdAt <= maxQueueAgeMs);
  if (!ws || ws.readyState !== WS_OPEN_READY_STATE) return fresh;
  for (const message of fresh) {
    sendMessage(ws, message);
  }
  return [];
}

/** Flush the queue, then send `payload` — or queue it when the socket is not open. */
export function sendOrQueueWsMessage(
  ws: WsSendTarget | null | undefined,
  queue: QueuedWsMessage[],
  tag: number,
  payload: WsMessagePayload,
  now = Date.now(),
  onSent?: WsMessageSent,
): QueuedWsMessage[] {
  const fresh = flushWsMessageQueue(ws, queue, now);
  if (ws?.readyState === WS_OPEN_READY_STATE) {
    sendMessage(ws, { tag, payload, onSent });
    return fresh;
  }
  return enqueueWsMessage(fresh, { tag, payload, createdAt: now, ...(onSent ? { onSent } : {}) });
}
