/**
 * Paces HID key events so iOS does not coalesce a burst (paste, autocorrect
 * replacement) into a few lost keystrokes. Ported from serve-sim's
 * `utils/paced-key-sender.ts`.
 */

import { type HidKeyEvent } from './types';

export const KEY_EVENT_PACE_MS = 4;

export type PacedKeySender = {
  enqueue(events: ReadonlyArray<HidKeyEvent>): void;
  cancel(): HidKeyEvent[];
  dispose(): void;
};

export function createPacedKeySender(
  send: (event: HidKeyEvent) => void,
  perEventDelayMs = KEY_EVENT_PACE_MS,
  schedule: (callback: () => void, ms: number) => unknown = setTimeout,
  cancelTimer: (handle: unknown) => void = clearTimeout as (handle: unknown) => void,
): PacedKeySender {
  const queue: HidKeyEvent[] = [];
  let timer: unknown = null;
  const pressed = new Set<number>();

  const cancel = () => {
    queue.length = 0;
    if (timer != null) cancelTimer(timer);
    timer = null;
    const releases = [...pressed].map((usage) => ({ type: "up" as const, usage }));
    pressed.clear();
    return releases;
  };

  const pump = () => {
    timer = null;
    const next = queue.shift();
    if (next === undefined) return;
    send(next);
    if (next.type === "down") pressed.add(next.usage);
    else pressed.delete(next.usage);
    if (queue.length > 0) timer = schedule(pump, perEventDelayMs);
  };

  return {
    enqueue(events) {
      if (events.length === 0) return;
      for (const event of events) queue.push(event);
      if (timer == null) pump();
    },
    cancel,
    dispose() {
      cancel();
    },
  };
}
