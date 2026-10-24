import { expect, spyOn, test } from "bun:test";
import { DeviceSession } from "../device-session";
import { withSimPasteboardLock } from "../sim-pasteboard";

function queuedSession() {
  const order: string[] = [];
  const s = Object.create(DeviceSession.prototype);
  Object.assign(s, {
    udid: `CLIPBOARD-ORDER-${process.pid}-${Math.random()}`,
    phase: "running",
    hid: { inputUnavailable: false },
    hidSockets: new Set(),
    admittedHidSockets: new Set(),
    detachedHidSockets: new WeakSet(),
    overloadedHidSockets: new WeakSet(),
    inputOperationQueues: new Map(),
    scheduledInputSockets: new Set(),
    inputSocketOrder: [],
    inputOperationSequence: 0,
    clipboardInputBarriers: new Set(),
    inputStateWaiters: new Set(),
    inFlightOrderedMessages: new WeakMap(),
    sendPasteShortcut: async () => {
      order.push("paste");
      return null;
    },
  });
  const replies: Array<{ ok: boolean; error?: string }> = [];
  const viewer = () => {
    const ws = { send: (reply: Buffer) => replies.push(JSON.parse(reply.subarray(1).toString())) };
    s.hidSockets.add(ws);
    return ws;
  };
  const paste = (ws: object) =>
    s.handleHidMessage(
      Buffer.concat([Buffer.from([0x12]), Buffer.from(JSON.stringify({ requestId: 1 }))]),
      ws,
    ) as Promise<void>;
  return { s, order, replies, viewer, paste };
}

async function waitForQueuedPaste(s: ReturnType<typeof queuedSession>["s"], ws: object) {
  const deadline = Date.now() + 1_000;
  while (!s.inputOperationQueues.get(ws)?.length && Date.now() < deadline) await Bun.sleep(5);
  expect(s.inputOperationQueues.get(ws)?.length).toBeGreaterThan(0);
}

test("a Paste behind its viewer's active input cannot be overtaken by another viewer", async () => {
  const { s, order, viewer, paste } = queuedSession();
  const a = viewer(),
    b = viewer();
  let release!: () => void;
  const first = s.queueInputOperation(a, async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    order.push("first");
  });
  const copying = paste(a);
  await waitForQueuedPaste(s, a);
  const later = s.queueInputOperation(b, async () => {
    order.push("later");
  });
  release();
  await Promise.all([first, copying, later]);
  expect(order).toEqual(["first", "paste", "later"]);
});

test("a clipboard barrier waits for older input on another viewer", async () => {
  const { s, order, viewer, paste } = queuedSession();
  const a = viewer(),
    b = viewer();
  let release!: () => void;
  const first = s.queueInputOperation(a, async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    order.push("first");
  });
  const older = s.queueInputOperation(b, async () => {
    order.push("older");
  });
  const copying = paste(a);
  await waitForQueuedPaste(s, a);
  const later = s.queueInputOperation(b, async () => {
    order.push("later");
  });
  release();
  await Promise.all([first, older, copying, later]);
  expect(order).toEqual(["first", "older", "paste", "later"]);
});

test("ordinary input retains round-robin scheduling across viewers", async () => {
  const { s, order, viewer } = queuedSession();
  const a = viewer(),
    b = viewer();
  let release!: () => void;
  const first = s.queueInputOperation(a, async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    order.push("first");
  });
  const second = s.queueInputOperation(a, async () => {
    order.push("second");
  });
  const third = s.queueInputOperation(a, async () => {
    order.push("third");
  });
  const other = s.queueInputOperation(b, async () => {
    order.push("other");
  });
  release();
  await Promise.all([first, second, third, other]);
  expect(order).toEqual(["first", "other", "second", "third"]);
});

test("discarding a queued Paste removes its barrier and does not strand other viewers", async () => {
  const { s, order, viewer, paste } = queuedSession();
  const a = viewer(),
    b = viewer();
  let release!: () => void;
  const first = s.queueInputOperation(
    a,
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const copying = paste(a);
  await waitForQueuedPaste(s, a);
  s.discardQueuedInput(a);
  const later = s.queueInputOperation(b, async () => {
    order.push("later");
  });
  release();
  await Promise.all([first, copying, later]);
  expect(order).toEqual(["later"]);
  expect(s.clipboardInputBarriers.size).toBe(0);
});

test("a contended Paste fails promptly and releases other viewers without sending its chord", async () => {
  const { s, order, replies, viewer, paste } = queuedSession();
  let release!: () => void, acquired!: () => void;
  const locked = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const holder = withSimPasteboardLock(s.udid, async () => {
    acquired();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  await locked;
  const log = spyOn(console, "error").mockImplementation(() => {});
  const copying = paste(viewer());
  await Bun.sleep(20);
  const later = s.queueInputOperation(viewer(), async () => {
    order.push("later");
  });
  let progressed: boolean;
  try {
    progressed = await Promise.race([later.then(() => true), Bun.sleep(1_500).then(() => false)]);
  } finally {
    release();
    await holder;
    await Promise.all([copying, later]);
    log.mockRestore();
  }
  expect(progressed!).toBe(true);
  expect(order).toEqual(["later"]);
  expect(replies).toMatchObject([{ ok: false, error: "Simulator clipboard is busy. Try again." }]);
}, 5_000);
