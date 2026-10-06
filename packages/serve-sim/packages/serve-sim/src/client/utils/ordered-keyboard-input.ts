import type { KeyEvent } from "../../text-to-keys";
import { createPacedKeySender } from "./paced-key-sender";
import { encodePasteRequest } from "./sim-clipboard";

export type KeyboardInputEvent = KeyEvent & { key?: string; shifted?: boolean };
export type PasteResult = { cleanupWarning?: string };

type PasteInput = {
  kind: "paste";
  requestId: number;
  device: string;
  connection: object | null;
  text?: string;
  timeout?: ReturnType<typeof setTimeout>;
  resolve(result: PasteResult): void;
  reject(error: Error): void;
};
type Input =
  | { kind: "key"; event: KeyboardInputEvent; device: string; connection: object | null }
  | { kind: "keys"; events: readonly KeyEvent[]; device: string; connection: object | null }
  | PasteInput;

/** Keep clipboard commands and keyboard input in their invocation order. */
export function createOrderedKeyboardInput({
  getDevice,
  getConnection,
  getKeyConnection = getConnection,
  sendKey,
  sendPaste,
  pasteTimeoutMs = 150_000,
}: {
  getDevice(): string;
  getConnection(): object | null;
  getKeyConnection?(): object | null;
  sendKey(event: KeyboardInputEvent): void;
  sendPaste(connection: object, message: Uint8Array<ArrayBuffer>): boolean;
  pasteTimeoutMs?: number;
}) {
  const queue: Input[] = [];
  let active: Input | null = null;
  let nextRequestId = 0;
  let disposed = false;
  const disconnected = () => new Error("Simulator input disconnected");
  const isCurrent = (input: { device: string; connection: object | null }) =>
    input.device === getDevice() && input.connection === getConnection();
  const isCurrentKey = (input: { device: string; connection: object | null }) =>
    input.device === getDevice() && input.connection === getKeyConnection();
  const sendEvent = (event: KeyboardInputEvent) => {
    try { sendKey(event); }
    catch (error) { cancel(); throw error; }
  };
  const pacedKeys = createPacedKeySender((event) => {
    if (active?.kind === "keys" && isCurrentKey(active)) sendEvent(event);
  });

  const finishInput = (input: PasteInput, settle: () => void) => {
    if (active !== input) return;
    clearTimeout(input.timeout);
    active = null;
    settle();
    drain();
  };

  const drain = () => {
    if (active || disposed) return;
    while (queue.length > 0) {
      const input = queue.shift()!;
      active = input;
      if (input.kind === "key") {
        if (isCurrentKey(input)) sendEvent(input.event);
      } else if (input.kind === "keys") {
        pacedKeys.enqueue(input.events);
        void pacedKeys.idle().then(() => {
          if (active !== input) return;
          active = null;
          drain();
        });
        return;
      } else {
        const connection = getConnection();
        if (!connection || !isCurrent(input)) {
          input.reject(disconnected());
        } else {
          const message = encodePasteRequest(input.requestId, input.text);
          if (!message) {
            input.reject(new Error("This text is too large to paste into the simulator"));
          } else {
            input.timeout = setTimeout(() => finishInput(input, () => {
              input.reject(new Error("Simulator paste timed out"));
            }), pasteTimeoutMs);
            if (sendPaste(connection, message)) return;
            clearTimeout(input.timeout);
            input.reject(disconnected());
          }
        }
      }
      active = null;
    }
  };

  const enqueue = (input: Input) => {
    queue.push(input);
    drain();
  };

  const cancel = () => {
    const inputs = active ? [active, ...queue] : [...queue];
    active = null;
    queue.length = 0;
    pacedKeys.dispose();
    for (const input of inputs) {
      if (input.kind === "paste") {
        clearTimeout(input.timeout);
        input.reject(disconnected());
      }
    }
  };

  return {
    send(event: KeyboardInputEvent): void {
      if (!disposed) enqueue({ kind: "key", event, device: getDevice(), connection: getKeyConnection() });
    },
    enqueue(events: readonly KeyEvent[]): void {
      if (!disposed && events.length > 0) enqueue({
        kind: "keys", events: [...events], device: getDevice(), connection: getKeyConnection(),
      });
    },
    paste(text?: string): Promise<PasteResult> {
      if (disposed) return Promise.reject(disconnected());
      return new Promise((resolve, reject) => enqueue({
        kind: "paste", requestId: ++nextRequestId,
        device: getDevice(), connection: getConnection(), text, resolve, reject,
      }));
    },
    receive(connection: object | null, value: unknown): boolean {
      if (active?.kind !== "paste" || active.connection !== connection || !value || typeof value !== "object") return false;
      const reply = value as { requestId?: unknown; ok?: unknown; error?: unknown; cleanupWarning?: unknown };
      if (reply.requestId !== active.requestId || typeof reply.ok !== "boolean") return false;
      const input = active;
      finishInput(input, () => {
        if (reply.ok) input.resolve({
          cleanupWarning: typeof reply.cleanupWarning === "string" ? reply.cleanupWarning : undefined,
        });
        else input.reject(new Error(typeof reply.error === "string" ? reply.error : "Could not paste into the simulator"));
      });
      return true;
    },
    cancel,
    dispose(): void {
      disposed = true;
      cancel();
    },
  };
}
