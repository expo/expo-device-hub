import { describe, expect, test } from "bun:test";
import { createPacedKeySender } from "../client/utils/paced-key-sender";
import { keyEventsForInputType } from "../client/utils/mobile-keyboard";
import type { KeyEvent } from "../text-to-keys";

function fakeScheduler() {
  const pending: Array<() => void> = [];
  const schedule = (cb: () => void) => {
    pending.push(cb);
    return pending.length;
  };
  const drain = () => {
    for (let i = 0; i < pending.length; i++) pending[i]!();
  };
  return { schedule, cancel: () => {}, drain, get pendingCount() { return pending.length; } };
}

describe("createPacedKeySender", () => {
  test("sends a multi-character paste one event at a time, in order", () => {
    const clock = fakeScheduler();
    const sent: KeyEvent[] = [];
    const sender = createPacedKeySender((e) => sent.push(e), 4, clock.schedule, clock.cancel);

    const events = keyEventsForInputType("insertFromPaste", "Hi!");
    expect(events.length).toBeGreaterThan(2);

    sender.enqueue(events);
    // The first event fires immediately; the rest are paced behind scheduler ticks.
    expect(sent).toEqual(events.slice(0, 1));

    clock.drain();
    expect(sent).toEqual(events);
  });

  test("keeps events queued when more arrive mid-drain", () => {
    const clock = fakeScheduler();
    const sent: KeyEvent[] = [];
    const sender = createPacedKeySender((e) => sent.push(e), 4, clock.schedule, clock.cancel);

    const first = keyEventsForInputType("insertText", "a");
    const second = keyEventsForInputType("insertText", "b");
    sender.enqueue(first);
    sender.enqueue(second);

    clock.drain();
    expect(sent).toEqual([...first, ...second]);
  });

  test("dispose drops queued events and stops the pump", () => {
    const clock = fakeScheduler();
    const sent: KeyEvent[] = [];
    const sender = createPacedKeySender((e) => sent.push(e), 4, clock.schedule, clock.cancel);

    sender.enqueue(keyEventsForInputType("insertFromPaste", "abc"));
    sender.dispose();
    clock.drain();

    expect(sent).toEqual([{ type: "down", usage: 0x04 }]);
  });

  test("idle waits until every queued event is sent", async () => {
    const clock = fakeScheduler();
    const sent: KeyEvent[] = [];
    const sender = createPacedKeySender((e) => sent.push(e), 4, clock.schedule, clock.cancel);
    const events = keyEventsForInputType("insertFromPaste", "Hi!");

    await sender.idle(); // nothing queued yet
    sender.enqueue(events);
    let idle = false;
    const waiting = sender.idle().then(() => { idle = true; });
    await Promise.resolve();
    expect(idle).toBe(false);
    expect(sent.length).toBeLessThan(events.length);

    clock.drain();
    await waiting;
    expect(sent).toEqual(events);
  });

  test("idle resolves when the sender is disposed", async () => {
    const clock = fakeScheduler();
    const sender = createPacedKeySender(() => {}, 4, clock.schedule, clock.cancel);
    sender.enqueue(keyEventsForInputType("insertFromPaste", "Hi!"));
    const waiting = sender.idle();
    sender.dispose();
    await waiting;
  });
});
