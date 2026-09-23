import type { KeyEvent } from "../../text-to-keys";

export const KEY_EVENT_PACE_MS = 4;

export type PacedKeySender = {
  enqueue(events: ReadonlyArray<KeyEvent>): void;
  dispose(): void;
};

export function createPacedKeySender(
  send: (event: KeyEvent) => void,
  perEventDelayMs = KEY_EVENT_PACE_MS,
  schedule: (callback: () => void, ms: number) => unknown = setTimeout,
  cancel: (handle: unknown) => void = clearTimeout as (handle: unknown) => void,
): PacedKeySender {
  const queue: KeyEvent[] = [];
  let timer: unknown = null;

  const pump = () => {
    timer = null;
    const next = queue.shift();
    if (next === undefined) return;
    send(next);
    if (queue.length > 0) timer = schedule(pump, perEventDelayMs);
  };

  return {
    enqueue(events) {
      if (events.length === 0) return;
      for (const event of events) queue.push(event);
      if (timer == null) pump();
    },
    dispose() {
      queue.length = 0;
      if (timer != null) cancel(timer);
      timer = null;
    },
  };
}
