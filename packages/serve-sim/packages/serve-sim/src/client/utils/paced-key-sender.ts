import type { KeyEvent } from "../../text-to-keys";

export const KEY_EVENT_PACE_MS = 4;

export type PacedKeySender = {
  enqueue(events: ReadonlyArray<KeyEvent>): void;
  /** Resolves once every queued event has been handed to `send`, or the sender is disposed. */
  idle(): Promise<void>;
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
  let idleWaiters: Array<() => void> = [];

  const settleIdle = () => {
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  };

  const pump = () => {
    timer = null;
    const next = queue.shift();
    if (next === undefined) return settleIdle();
    send(next);
    if (queue.length > 0) timer = schedule(pump, perEventDelayMs);
    else settleIdle();
  };

  return {
    enqueue(events) {
      if (events.length === 0) return;
      for (const event of events) queue.push(event);
      if (timer == null) pump();
    },
    idle() {
      if (queue.length === 0) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
    dispose() {
      queue.length = 0;
      if (timer != null) cancel(timer);
      timer = null;
      settleIdle();
    },
  };
}
