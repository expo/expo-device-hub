import { expect, test } from "bun:test";
import { ClientTouchState } from "../src/client-touch-state.ts";
import { ControlInputQueue, ControlInputRejectedError } from "../src/control-input-queue.ts";
import type { Gesture } from "../src/input.ts";

type Key = Extract<Gesture, { type: "key" }>;
const screen = { width: 576, height: 1280 };
const key = (keycode: number, action?: Key["action"]): Key =>
  action ? { type: "key", keycode, action } : { type: "key", keycode };

function harness(maxDepth = 16) {
  const sent: Key[] = [];
  let rejectNext = false;
  let gate: Promise<void> | null = null;
  const queue = new ControlInputQueue({
    maxDepth,
    dispatcher: {
      async dispatchGesture(gesture) {
        if (gesture.type !== "key") return;
        if (gate) await gate;
        if (rejectNext) {
          rejectNext = false;
          throw new ControlInputRejectedError("rejected key");
        }
        sent.push(gesture);
      },
      async resetVideo() {},
    },
  });
  const target = {
    identity: queue,
    pointerNamespace: queue,
    enqueue: (gesture: Gesture) => queue.enqueue(gesture, screen),
  };
  return {
    queue,
    sent,
    owner: () => new ClientTouchState(() => target),
    rejectNext() {
      rejectNext = true;
    },
    /** Hold the dispatcher until the returned function runs. */
    hold() {
      let open!: () => void;
      gate = new Promise<void>((resolve) => {
        open = () => {
          gate = null;
          resolve();
        };
      });
      return open;
    },
  };
}

test("close releases a key that the socket still holds", async () => {
  const h = harness();
  const owner = h.owner();
  try {
    await owner.enqueue(key(26, "down")).completion;
    await owner.close();
    expect(h.sent).toEqual([key(26, "down"), key(26, "up")]);
  } finally {
    h.queue.close();
  }
});

test("close sends nothing for a key that was released or pressed", async () => {
  const h = harness();
  const owner = h.owner();
  try {
    await owner.enqueue(key(24, "down")).completion;
    await owner.enqueue(key(24, "up")).completion;
    await owner.enqueue(key(25)).completion;
    await owner.close();
    expect(h.sent).toEqual([key(24, "down"), key(24, "up"), key(25)]);
  } finally {
    h.queue.close();
  }
});

test("close sends no UP for a key whose DOWN was rejected", async () => {
  const h = harness();
  const owner = h.owner();
  try {
    h.rejectNext();
    await expect(owner.enqueue(key(26, "down")).completion).rejects.toBeInstanceOf(
      ControlInputRejectedError,
    );
    await owner.close();
    expect(h.sent).toEqual([]);
  } finally {
    h.queue.close();
  }
});

test("close during a DOWN that is then rejected does not fail", async () => {
  const h = harness();
  const owner = h.owner();
  try {
    h.rejectNext();
    const down = owner.enqueue(key(26, "down")).completion.catch(() => {});
    await expect(owner.close()).resolves.toBeUndefined();
    await down;
    expect(h.sent).toEqual([]);
  } finally {
    h.queue.close();
  }
});

test("a held key keeps queue capacity for its release", async () => {
  const h = harness(2);
  const owner = h.owner();
  try {
    const open = h.hold();
    const down = owner.enqueue(key(26, "down")).completion;
    // One slot is pending, the other is reserved for the key's UP.
    expect(() => owner.enqueue(key(25))).toThrow();
    const closed = owner.close();
    open();
    await down;
    await expect(closed).resolves.toBeUndefined();
    expect(h.sent).toEqual([key(26, "down"), key(26, "up")]);
  } finally {
    h.queue.close();
  }
});

test("close retries a key UP that was rejected", async () => {
  const h = harness();
  const owner = h.owner();
  try {
    await owner.enqueue(key(26, "down")).completion;
    h.rejectNext();
    await expect(owner.enqueue(key(26, "up")).completion).rejects.toBeInstanceOf(
      ControlInputRejectedError,
    );
    await owner.close();
    expect(h.sent).toEqual([key(26, "down"), key(26, "up")]);
  } finally {
    h.queue.close();
  }
});

test("a repeated DOWN keeps the key held when the first DOWN is rejected", async () => {
  const h = harness();
  const owner = h.owner();
  try {
    const open = h.hold();
    h.rejectNext();
    const first = owner.enqueue(key(26, "down")).completion.catch(() => {});
    const repeat = owner.enqueue(key(26, "down")).completion;
    open();
    await first;
    await repeat;
    await owner.close();
    expect(h.sent).toEqual([key(26, "down"), key(26, "up")]);
  } finally {
    h.queue.close();
  }
});

test("a rejected repeat DOWN does not hide a held key from a failed release", async () => {
  const h = harness();
  const owner = h.owner();
  try {
    await owner.enqueue(key(26, "down")).completion;
    h.rejectNext();
    await expect(owner.enqueue(key(26, "down")).completion).rejects.toBeInstanceOf(
      ControlInputRejectedError,
    );
    h.rejectNext();
    // The first DOWN reached the device, so a failed release must be reported.
    await expect(owner.close()).rejects.toBeInstanceOf(ControlInputRejectedError);
  } finally {
    h.queue.close();
  }
});
