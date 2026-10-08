/**
 * Clipboard requests and keyboard input in the order the user made them. Ported from serve-sim's
 * `client/utils/ordered-keyboard-input.ts` and `socket/client-input-barriers.ts`. Touches do not
 * wait for clipboard requests, as in serve-sim.
 */

import {
  MAX_INPUT_FRAME_BYTES,
  WS_MSG_INPUT_BARRIER,
  WS_MSG_INPUT_BARRIER_DONE,
  WS_MSG_PASTE,
  WS_MSG_PASTE_DONE,
} from './input-protocol';
import { ClipboardActionError } from './device-clipboard';
import { createPacedKeySender } from './paced-key-sender';
import { type HidKeyEvent } from './types';
import { encodeWsMessage } from './ws-send-queue';

export type KeyMessage = { type: 'down' | 'up'; usage: number; key?: string; shifted?: boolean };
export type ClipboardReply = { cleanupWarning?: string };

export const INPUT_DISCONNECTED_MESSAGE = 'Device input disconnected. Try again.';

type Request = {
  requestId: number;
  timer?: ReturnType<typeof setTimeout>;
  reject(error: Error): void;
};
type PasteRequest = Request & {
  kind: 'paste';
  frame: Uint8Array<ArrayBuffer>;
  resolve(reply: ClipboardReply): void;
};
type ReadRequest = Request & {
  kind: 'read';
  read(signal: AbortSignal): Promise<unknown>;
  resolve(value: unknown): void;
  /** Set once the barrier is acknowledged and the read has started. */
  controller?: AbortController;
};
type Input =
  | { kind: 'key'; message: KeyMessage }
  | { kind: 'keys'; events: HidKeyEvent[] }
  | PasteRequest
  | ReadRequest;

const decoder = new TextDecoder();

// @ref LLP 0013#clipboard — keys wait for an earlier Paste's reply; Copy reads only after a barrier
/** One per input socket. Requests are sent only on an admitted socket and never replayed. */
export function createOrderedKeyboardInput({
  sendKey,
  trySendFrame,
  replyTimeoutMs = 150_000,
  keyPaceMs,
}: {
  sendKey(message: KeyMessage): void;
  trySendFrame(frame: Uint8Array<ArrayBuffer>): boolean;
  replyTimeoutMs?: number;
  keyPaceMs?: number;
}) {
  const queue: Input[] = [];
  let active: Input | null = null;
  let nextRequestId = 0;
  let disposed = false;
  const pacedKeys = createPacedKeySender((event) => sendKey({ type: event.type, usage: event.usage }), keyPaceMs);
  const disconnected = () => new Error(INPUT_DISCONNECTED_MESSAGE);

  const finish = (request: PasteRequest | ReadRequest, settle: () => void) => {
    if (active !== request) return;
    clearTimeout(request.timer);
    active = null;
    settle();
    drain();
  };

  const drain = () => {
    while (!active && queue.length > 0 && !disposed) {
      const input = queue.shift()!;
      if (input.kind === 'key') {
        sendKey(input.message);
        continue;
      }
      active = input;
      if (input.kind === 'keys') {
        pacedKeys.enqueue(input.events);
        void pacedKeys.idle().then(() => {
          if (active !== input) return;
          active = null;
          drain();
        });
        continue;
      }
      const frame = input.kind === 'paste'
        ? input.frame
        : encodeWsMessage(WS_MSG_INPUT_BARRIER, { requestId: input.requestId });
      if (!trySendFrame(frame)) {
        active = null;
        input.reject(disconnected());
        continue;
      }
      input.timer = setTimeout(() => finish(input, () => {
        if (input.kind === 'read') input.controller?.abort();
        input.reject(new Error(input.kind === 'paste' ? 'Paste timed out.' : 'Copy timed out.'));
      }), replyTimeoutMs);
    }
  };

  const enqueue = (input: Input) => {
    queue.push(input);
    drain();
  };

  const rejectRequests = (inputs: Input[]) => {
    for (const input of inputs) {
      if (input.kind !== 'paste' && input.kind !== 'read') continue;
      clearTimeout(input.timer);
      if (input.kind === 'read') input.controller?.abort();
      input.reject(disconnected());
    }
  };

  const cancel = () => {
    const inputs = active ? [active, ...queue] : [...queue];
    active = null;
    queue.length = 0;
    pacedKeys.cancel();
    rejectRequests(inputs);
  };

  return {
    send(message: KeyMessage): void {
      if (!disposed) enqueue({ kind: 'key', message });
    },
    enqueue(events: ReadonlyArray<HidKeyEvent>): void {
      if (!disposed && events.length > 0) enqueue({ kind: 'keys', events: [...events] });
    },
    /** Without text, the device pastes its own clipboard. */
    paste(text?: string): Promise<ClipboardReply> {
      if (disposed) return Promise.reject(disconnected());
      const requestId = ++nextRequestId;
      const frame = encodeWsMessage(WS_MSG_PASTE, { requestId, text });
      if (frame.byteLength > MAX_INPUT_FRAME_BYTES) {
        return Promise.reject(new Error('This text is too large to paste. The limit is 4 MiB.'));
      }
      return new Promise((resolve, reject) =>
        enqueue({ kind: 'paste', requestId, frame, resolve, reject }));
    },
    /** Run `read` once the server has handled all earlier input. Keys typed meanwhile wait for it. */
    readAfterInput<T>(read: (signal: AbortSignal) => Promise<T>): Promise<T> {
      if (disposed) return Promise.reject(disconnected());
      return new Promise<T>((resolve, reject) => enqueue({
        kind: 'read', requestId: ++nextRequestId, read,
        resolve: (value) => resolve(value as T), reject,
      }));
    },
    /** Handle a `0x91` or `0x92` reply. Returns false for any other frame. */
    receive(data: ArrayBuffer): boolean {
      const bytes = new Uint8Array(data);
      const kind = bytes[0] === WS_MSG_PASTE_DONE ? 'paste' : bytes[0] === WS_MSG_INPUT_BARRIER_DONE ? 'read' : null;
      if (!kind) return false;
      let reply: { requestId?: unknown; ok?: unknown; error?: unknown; cleanupWarning?: unknown };
      try { reply = JSON.parse(decoder.decode(bytes.subarray(1))) ?? {}; } catch { return true; }
      const request = active;
      if (request?.kind !== kind) return true;
      if (reply.requestId !== request.requestId || typeof reply.ok !== 'boolean') return true;
      if (request.kind === 'read' && request.controller) return true;
      const cleanupWarning = typeof reply.cleanupWarning === 'string' ? reply.cleanupWarning : undefined;
      if (!reply.ok) {
        const error = typeof reply.error === 'string'
          ? reply.error
          : request.kind === 'paste' ? 'Could not paste into the simulator.' : 'Simulator input failed. Reconnect and try again.';
        // serve-sim does not send a warning with a failed Paste today. Keep one if it comes.
        finish(request, () => request.reject(new ClipboardActionError(error, cleanupWarning)));
      } else if (request.kind === 'paste') {
        finish(request, () => request.resolve(cleanupWarning ? { cleanupWarning } : {}));
      } else {
        const controller = new AbortController();
        request.controller = controller;
        new Promise<unknown>((resolve) => resolve(request.read(controller.signal))).then(
          (value) => finish(request, () => request.resolve(value)),
          (error) => finish(request, () => request.reject(error instanceof Error ? error : new Error(String(error)))),
        );
      }
      return true;
    },
    /**
     * Drop key presses and paced bursts that have not been sent, and release the keys a burst holds.
     * Releases that wait behind a Paste or Copy stay, because their keys can already be down.
     */
    cancelKeys(release: (event: HidKeyEvent) => void): void {
      for (const event of pacedKeys.cancel()) release(event);
      if (active?.kind === 'keys') active = null;
      for (let index = queue.length - 1; index >= 0; index--) {
        const input = queue[index]!;
        if (input.kind === 'keys' || (input.kind === 'key' && input.message.type === 'down')) queue.splice(index, 1);
      }
      drain();
    },
    /** The socket disconnected: requests without a reply fail, and keys behind them are dropped. */
    cancel,
    dispose(): void {
      disposed = true;
      cancel();
    },
  };
}

export type OrderedKeyboardInput = ReturnType<typeof createOrderedKeyboardInput>;
