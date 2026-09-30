import { expect, test } from "bun:test";
import { ClientTouchState } from "../src/client-touch-state.ts";
import { ControlInputQueue, ControlInputRejectedError } from "../src/control-input-queue.ts";
import type { Gesture } from "../src/input.ts";

type Touch = Extract<Gesture, { type: "touch" }>;
const screen = { width: 576, height: 1280 };
const touch = (action: Touch["action"], pointerId = 0): Touch => ({
  type: "touch",
  action,
  pointerId,
  x: 0.4,
  y: 0.6,
});

function harness(maxDepth = 16) {
  const held = new Set<number>();
  const attempts: Touch[] = [];
  let rejectAction: Touch["action"] | null = null;
  let gate: {
    action: Touch["action"];
    wait: Promise<void>;
    enter(): void;
    resolve(): void;
    reject(error: Error): void;
  } | null = null;
  const queue = new ControlInputQueue({
    maxDepth,
    dispatcher: {
      async dispatchGesture(gesture) {
        if (gesture.type !== "touch") return;
        attempts.push(gesture);
        if (gate?.action === gesture.action) {
          const blocked = gate;
          gate = null;
          blocked.enter();
          await blocked.wait;
        }
        if (rejectAction === gesture.action) {
          rejectAction = null;
          throw new ControlInputRejectedError(`rejected ${gesture.action}`);
        }
        if (gesture.action === "down") held.add(gesture.pointerId ?? 0);
        if (gesture.action === "up") held.delete(gesture.pointerId ?? 0);
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
    target,
    held,
    attempts,
    owner: () => new ClientTouchState(() => target),
    rejectNext(action: Touch["action"]) {
      rejectAction = action;
    },
    block(action: Touch["action"]) {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      let enter!: () => void;
      const entered = new Promise<void>((accept) => {
        enter = accept;
      });
      const wait = new Promise<void>((accept, fail) => {
        resolve = accept;
        reject = fail;
      });
      gate = { action, wait, enter, resolve, reject };
      return {
        entered,
        resolve,
        reject: () => reject(new ControlInputRejectedError(`rejected ${action}`)),
      };
    },
  };
}

// Observe rejections immediately, including operations deliberately queued before
// the dispatcher reports failure. Tests still inspect each original outcome.
function observed<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  return promise.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
}
async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("a rejected DOWN can be retried without leaking release reservations", async () => {
  const h = harness(2);
  const owner = h.owner();
  try {
    for (let i = 0; i < 8; i++) {
      h.rejectNext("down");
      await expect(owner.enqueue(touch("down")).completion).rejects.toBeInstanceOf(
        ControlInputRejectedError,
      );
      expect(h.queue.snapshot()).toMatchObject({ closed: false, reservedReleases: 0 });
    }
    await owner.enqueue(touch("down")).completion;
    await owner.enqueue(touch("up")).completion;
    expect(h.held.size).toBe(0);
  } finally {
    await owner.close().catch(() => {});
    h.queue.close();
  }
});

test("a rejected UP keeps ownership and capacity for disconnect cleanup", async () => {
  const h = harness(2);
  const owner = h.owner();
  try {
    await owner.enqueue(touch("down")).completion;
    h.rejectNext("up");
    await expect(owner.enqueue(touch("up")).completion).rejects.toBeInstanceOf(
      ControlInputRejectedError,
    );
    expect(h.queue.snapshot().reservedReleases).toBe(1);
    await owner.close();
    expect(h.held.size).toBe(0);
    expect(h.attempts.map((t) => t.action)).toEqual(["down", "up", "up"]);
    expect(h.queue.snapshot().reservedReleases).toBe(0);
  } finally {
    await owner.close().catch(() => {});
    h.queue.close();
  }
});

test("rejected DOWN cancels only its queued moves and UP, not later gestures", async () => {
  const h = harness();
  const a = h.owner();
  const b = h.owner();
  const gate = h.block("down");
  try {
    const first = observed(a.enqueue(touch("down")).completion);
    await gate.entered;
    const move = observed(a.enqueue(touch("move")).completion);
    const coalescedMove = observed(a.enqueue(touch("move")).completion);
    const up = observed(a.enqueue(touch("up")).completion);
    const next = observed(a.enqueue(touch("down")).completion);
    const other = observed(b.enqueue(touch("down")).completion);
    gate.reject();
    const results = await Promise.all([first, move, coalescedMove, up, next, other]);
    expect(results.map((r) => r.status)).toEqual([
      "rejected",
      "rejected",
      "rejected",
      "rejected",
      "fulfilled",
      "fulfilled",
    ]);
    expect(h.attempts.map((t) => t.action)).toEqual(["down", "down", "down"]);
    await a.enqueue(touch("move")).completion;
    await Promise.all([a.close(), b.close()]);
    expect(h.held.size).toBe(0);
    expect(h.queue.snapshot().reservedReleases).toBe(0);
  } finally {
    gate.resolve();
    await Promise.allSettled([a.close(), b.close()]);
    h.queue.close();
  }
});

test("a rejected earlier UP does not lose either pointer after a new DOWN", async () => {
  const h = harness();
  const owner = h.owner();
  const gate = h.block("up");
  try {
    await owner.enqueue(touch("down")).completion;
    const up = observed(owner.enqueue(touch("up")).completion);
    await gate.entered;
    const next = observed(owner.enqueue(touch("down")).completion);
    gate.reject();
    expect((await up).status).toBe("rejected");
    expect((await next).status).toBe("fulfilled");
    await owner.enqueue(touch("move")).completion;
    expect(h.held.size).toBe(2);
    const closing = owner.close();
    expect(owner.close()).toBe(closing);
    await closing;
    expect(h.held.size).toBe(0);
    expect(h.queue.snapshot().reservedReleases).toBe(0);
  } finally {
    gate.resolve();
    await owner.close().catch(() => {});
    h.queue.close();
  }
});

test("disconnect during a rejected DOWN does not send a phantom UP", async () => {
  const h = harness(2);
  const owner = h.owner();
  const gate = h.block("down");
  try {
    const down = observed(owner.enqueue(touch("down")).completion);
    await gate.entered;
    const close = observed(owner.close());
    gate.reject();
    expect((await down).status).toBe("rejected");
    expect((await close).status).toBe("fulfilled");
    expect(h.attempts.map((t) => t.action)).toEqual(["down"]);
    expect(h.queue.snapshot().reservedReleases).toBe(0);
  } finally {
    gate.resolve();
    await owner.close().catch(() => {});
    h.queue.close();
  }
});

test("disconnect waits for a pending user UP and cleans up if it is rejected", async () => {
  const h = harness(2);
  const owner = h.owner();
  const gate = h.block("up");
  try {
    await owner.enqueue(touch("down")).completion;
    const up = observed(owner.enqueue(touch("up")).completion);
    await gate.entered;
    let closed = false;
    const closing = owner.close().then(() => {
      closed = true;
    });
    await tick();
    expect(closed).toBe(false);
    gate.reject();
    expect((await up).status).toBe("rejected");
    await closing;
    expect(h.held.size).toBe(0);
    expect(h.attempts.map((t) => t.action)).toEqual(["down", "up", "up"]);
  } finally {
    gate.resolve();
    await owner.close().catch(() => {});
    h.queue.close();
  }
});

test("an old session's rejection cannot remove a new session's pointer", async () => {
  const old = harness();
  const next = harness();
  let target = old.target;
  const owner = new ClientTouchState(() => target);
  const gate = old.block("down");
  try {
    const rejected = observed(owner.enqueue(touch("down")).completion);
    await gate.entered;
    target = next.target;
    await owner.enqueue(touch("down")).completion;
    gate.reject();
    await rejected;
    await owner.enqueue(touch("move")).completion;
    await owner.close();
    expect(next.held.size).toBe(0);
    expect(old.queue.snapshot().reservedReleases).toBe(0);
  } finally {
    gate.resolve();
    await owner.close().catch(() => {});
    old.queue.close();
    next.queue.close();
  }
});

test("queue rejection stops invalidating dependencies at the next DOWN of the same ID", async () => {
  const h = harness();
  const gate = h.block("down");
  try {
    const first = observed(h.queue.enqueue(touch("down", 7), screen).completion);
    await gate.entered;
    const up = observed(h.queue.enqueue(touch("up", 7), screen).completion);
    const next = observed(h.queue.enqueue(touch("down", 7), screen).completion);
    const nextUp = observed(h.queue.enqueue(touch("up", 7), screen).completion);
    gate.reject();
    expect((await Promise.all([first, up, next, nextUp])).map((r) => r.status)).toEqual([
      "rejected",
      "rejected",
      "fulfilled",
      "fulfilled",
    ]);
    expect(h.held.size).toBe(0);
    expect(h.queue.snapshot().reservedReleases).toBe(0);
  } finally {
    gate.resolve();
    h.queue.close();
  }
});

test("failed UP restores its reserved slot even while other input fills the queue", async () => {
  const h = harness(4);
  const a = h.owner();
  const b = h.owner();
  const upGate = h.block("up");
  let moveGate: ReturnType<typeof h.block> | undefined;
  try {
    await a.enqueue(touch("down")).completion;
    await b.enqueue(touch("down")).completion;
    const up = observed(a.enqueue(touch("up")).completion);
    await upGate.entered;
    moveGate = h.block("move");
    const moves = [
      observed(b.enqueue(touch("move")).completion),
      observed(b.enqueue(touch("move")).completion),
    ];
    expect(h.queue.snapshot()).toMatchObject({ depth: 3, reservedReleases: 1 });
    upGate.reject();
    await up;
    await moveGate.entered;
    expect(h.queue.snapshot()).toMatchObject({ depth: 2, reservedReleases: 2 });
    const close = a.close();
    expect(h.queue.snapshot()).toMatchObject({ depth: 3, reservedReleases: 1 });
    moveGate.resolve();
    await Promise.all(moves);
    await close;
    expect(h.held.size).toBe(1);
    await b.close();
    expect(h.held.size).toBe(0);
  } finally {
    upGate.resolve();
    moveGate?.resolve();
    await Promise.allSettled([a.close(), b.close()]);
    h.queue.close();
  }
});

test("a rejected disconnect retry is reported without retrying indefinitely", async () => {
  const h = harness(2);
  const owner = h.owner();
  const gate = h.block("up");
  try {
    await owner.enqueue(touch("down")).completion;
    const up = observed(owner.enqueue(touch("up")).completion);
    await gate.entered;
    const close = owner.close();
    const result = observed(close);
    h.rejectNext("up");
    gate.reject();
    expect((await up).status).toBe("rejected");
    expect((await result).status).toBe("rejected");
    expect(owner.close()).toBe(close);
    expect(h.attempts.map((t) => t.action)).toEqual(["down", "up", "up"]);
    expect(h.held.size).toBe(1);
  } finally {
    gate.resolve();
    await owner.close().catch(() => {});
    h.queue.close();
  }
});
