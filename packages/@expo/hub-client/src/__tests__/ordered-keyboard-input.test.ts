import { afterEach, expect, jest, test } from "bun:test";

import { createOrderedKeyboardInput, INPUT_DISCONNECTED_MESSAGE } from "../ordered-keyboard-input";

afterEach(() => jest.useRealTimers());

const decoder = new TextDecoder();

function frame(tag: number, payload: object): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  const bytes = new Uint8Array(1 + json.length);
  bytes[0] = tag;
  bytes.set(json, 1);
  return bytes.buffer;
}

function setup({
  admitted = true,
  replyTimeoutMs,
}: { admitted?: boolean; replyTimeoutMs?: number } = {}) {
  const wire: Array<{ tag: number; payload: Record<string, unknown> }> = [];
  const state = { admitted };
  const input = createOrderedKeyboardInput({
    sendKey: (message) => wire.push({ tag: 0x06, payload: message }),
    trySendFrame: (bytes) => {
      if (!state.admitted) return false;
      wire.push({ tag: bytes[0]!, payload: JSON.parse(decoder.decode(bytes.subarray(1))) });
      return true;
    },
    replyTimeoutMs,
    keyPaceMs: 0,
  });
  return { input, wire, state };
}

const key = (type: "down" | "up", usage: number) => ({ type, usage });
const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

test("a paste sends its text with a request ID, and a paste without text sends none", () => {
  const { input, wire } = setup();
  void input.paste("héllo");
  expect(wire).toEqual([{ tag: 0x12, payload: { requestId: 1, text: "héllo" } }]);
  input.receive(frame(0x92, { requestId: 1, ok: true }));
  void input.paste();
  expect(wire[1]).toEqual({ tag: 0x12, payload: { requestId: 2 } });
});

test("keys typed after a paste wait for the reply with its request ID", async () => {
  const { input, wire } = setup();
  input.send(key("down", 4));
  const pasted = input.paste("text");
  input.send(key("up", 4));
  input.send(key("down", 5));
  expect(wire.map((entry) => entry.tag)).toEqual([0x06, 0x12]);

  expect(input.receive(frame(0x92, { requestId: 99, ok: true }))).toBe(true);
  expect(input.receive(frame(0x91, { requestId: 1, ok: true }))).toBe(true);
  expect(wire).toHaveLength(2);

  input.receive(
    frame(0x92, { requestId: 1, ok: true, cleanupWarning: "A simulator key may still be held." }),
  );
  expect(await pasted).toEqual({ cleanupWarning: "A simulator key may still be held." });
  expect(wire.slice(2)).toEqual([
    { tag: 0x06, payload: key("up", 4) },
    { tag: 0x06, payload: key("down", 5) },
  ]);
});

test("other frames are left to the socket", () => {
  const { input } = setup();
  expect(input.receive(Uint8Array.of(0x83).buffer)).toBe(false);
  expect(input.receive(frame(0x82, { width: 1, height: 1 }))).toBe(false);
});

test("a failed paste rejects with the server error and releases the keys behind it", async () => {
  const { input, wire } = setup();
  const pasted = input.paste("text");
  input.send(key("down", 4));
  input.receive(
    frame(0x92, { requestId: 1, ok: false, error: "Could not paste into the simulator" }),
  );
  await expect(pasted).rejects.toThrow("Could not paste into the simulator");
  expect(wire.at(-1)).toEqual({ tag: 0x06, payload: key("down", 4) });
});

test("a failed paste keeps a key warning that its reply carries", async () => {
  const { input } = setup();
  const pasted = input.paste("text");
  input.receive(
    frame(0x92, {
      requestId: 1,
      ok: false,
      error: "Paste failed",
      cleanupWarning: "A simulator key may still be held.",
    }),
  );
  const failure = await pasted.then(
    () => null,
    (error: unknown) => error,
  );
  expect(failure).toMatchObject({
    message: "Paste failed",
    cleanupWarning: "A simulator key may still be held.",
  });
});

test("requests are sent only on an admitted socket", async () => {
  const { input, wire } = setup({ admitted: false });
  await expect(input.paste("text")).rejects.toThrow(INPUT_DISCONNECTED_MESSAGE);
  await expect(input.readAfterInput(async () => "never")).rejects.toThrow(
    INPUT_DISCONNECTED_MESSAGE,
  );
  input.send(key("down", 4));
  expect(wire).toEqual([{ tag: 0x06, payload: key("down", 4) }]);
});

test("text over the input frame limit is refused before it is sent", async () => {
  const { input, wire } = setup();
  await expect(input.paste("x".repeat(4 * 1024 * 1024))).rejects.toThrow("too large");
  expect(wire).toEqual([]);
});

test("a disconnect fails every request without a reply and drops the keys behind them", async () => {
  const { input, wire } = setup();
  const pasted = input.paste("text");
  input.send(key("down", 4));
  let read = false;
  const copied = input.readAfterInput(async () => {
    read = true;
    return "copied";
  });
  input.cancel();
  await expect(pasted).rejects.toThrow(INPUT_DISCONNECTED_MESSAGE);
  await expect(copied).rejects.toThrow(INPUT_DISCONNECTED_MESSAGE);
  input.receive(frame(0x92, { requestId: 1, ok: true }));
  expect(read).toBe(false);
  expect(wire.map((entry) => entry.tag)).toEqual([0x12]);

  // The next connection starts with an empty queue.
  input.send(key("down", 5));
  expect(wire.at(-1)).toEqual({ tag: 0x06, payload: key("down", 5) });
});

test("copy reads only after its barrier, and keys typed meanwhile wait for the read", async () => {
  const { input, wire } = setup();
  const pasted = input.paste("text");
  let finishRead!: (text: string) => void;
  let readStarted = false;
  const copied = input.readAfterInput(() => {
    readStarted = true;
    return new Promise<string>((resolve) => {
      finishRead = resolve;
    });
  });
  input.send(key("down", 4));
  expect(wire.map((entry) => entry.tag)).toEqual([0x12]);

  input.receive(frame(0x92, { requestId: 1, ok: true }));
  await pasted;
  expect(wire.at(-1)).toEqual({ tag: 0x11, payload: { requestId: 2 } });
  expect(readStarted).toBe(false);

  input.receive(frame(0x91, { requestId: 2, ok: true }));
  input.receive(frame(0x91, { requestId: 2, ok: true }));
  await flush();
  expect(readStarted).toBe(true);
  expect(wire.at(-1)!.tag).toBe(0x11);

  finishRead("copied");
  expect(await copied).toBe("copied");
  expect(wire.at(-1)).toEqual({ tag: 0x06, payload: key("down", 4) });
});

test("a failed barrier rejects the copy without reading", async () => {
  const { input } = setup();
  let read = false;
  const copied = input.readAfterInput(async () => {
    read = true;
    return "";
  });
  input.receive(frame(0x91, { requestId: 1, ok: false }));
  await expect(copied).rejects.toThrow("Simulator input failed");
  expect(read).toBe(false);
});

test("focus loss drops presses behind a paste but keeps their releases", async () => {
  const { input, wire } = setup();
  const pasted = input.paste("text");
  input.send(key("up", 0xe3));
  input.send(key("down", 4));
  input.enqueue([key("down", 5), key("up", 5)]);
  const released: unknown[] = [];
  input.cancelKeys((event) => released.push(event));
  expect(released).toEqual([]);

  input.receive(frame(0x92, { requestId: 1, ok: true }));
  await pasted;
  await flush();
  expect(wire.slice(1)).toEqual([{ tag: 0x06, payload: key("up", 0xe3) }]);
});

test("focus loss releases the keys that a paced burst holds, then sends the next request", async () => {
  const wire: Array<{ tag: number; payload: unknown }> = [];
  const input = createOrderedKeyboardInput({
    sendKey: (message) => wire.push({ tag: 0x06, payload: message }),
    trySendFrame: (bytes) => {
      wire.push({ tag: bytes[0]!, payload: null });
      return true;
    },
    keyPaceMs: 1_000,
  });
  input.enqueue([key("down", 0xe1), key("down", 4), key("up", 4), key("up", 0xe1)]);
  void input.paste("text").catch(() => {});
  expect(wire).toEqual([{ tag: 0x06, payload: key("down", 0xe1) }]);
  const released: unknown[] = [];
  input.cancelKeys((event) => released.push(event));
  expect(released).toEqual([key("up", 0xe1)]);
  expect(wire.at(-1)!.tag).toBe(0x12);
  input.dispose();
});

test("a paste waits for an earlier paced burst to finish", async () => {
  const wire: number[] = [];
  let sent!: () => void;
  const pasteSent = new Promise<void>((resolve) => {
    sent = resolve;
  });
  const input = createOrderedKeyboardInput({
    sendKey: () => {
      wire.push(0x06);
    },
    trySendFrame: (bytes) => {
      wire.push(bytes[0]!);
      sent();
      return true;
    },
    keyPaceMs: 0,
  });
  try {
    input.enqueue([key("down", 4), key("up", 4), key("down", 5), key("up", 5)]);
    const pasted = input.paste("text");
    void pasted.catch(() => {});
    expect(wire).toEqual([0x06]);
    await pasteSent;
    expect(wire).toEqual([0x06, 0x06, 0x06, 0x06, 0x12]);
    input.receive(frame(0x92, { requestId: 1, ok: true }));
    await pasted;
  } finally {
    input.dispose();
  }
});

test("a request without a reply times out and lets later keys through", async () => {
  const { input, wire } = setup({ replyTimeoutMs: 5 });
  const pasted = input.paste("text");
  input.send(key("down", 4));
  await expect(pasted).rejects.toThrow("Paste timed out.");
  expect(wire.at(-1)).toEqual({ tag: 0x06, payload: key("down", 4) });
});

test.each(["paste", "copy"] as const)(
  "%s timeout releases later input without replaying the request",
  async (action) => {
    jest.useFakeTimers();
    const { input, wire } = setup();
    let reads = 0;
    const first =
      action === "paste"
        ? input.paste("first")
        : input.readAfterInput(async () => {
            reads++;
            return "first";
          });
    const failure = first.catch((error: Error) => error.message);
    input.send(key("down", 4));
    const second = input.paste("second");
    input.send(key("down", 5));
    expect(wire).toHaveLength(1);
    jest.advanceTimersByTime(149_999);
    expect(wire).toHaveLength(1);
    jest.advanceTimersByTime(1);
    expect(await failure).toBe(action === "paste" ? "Paste timed out." : "Copy timed out.");
    expect(wire.slice(1)).toEqual([
      { tag: 0x06, payload: key("down", 4) },
      { tag: 0x12, payload: { requestId: 2, text: "second" } },
    ]);
    input.receive(frame(action === "paste" ? 0x92 : 0x91, { requestId: 1, ok: true }));
    expect(reads).toBe(0);
    expect(wire).toHaveLength(3);
    input.receive(frame(0x92, { requestId: 2, ok: true }));
    expect(await second).toEqual({});
    expect(wire.at(-1)).toEqual({ tag: 0x06, payload: key("down", 5) });
    input.dispose();
  },
);

test("Copy timeout aborts an acknowledged read and ignores its late result", async () => {
  jest.useFakeTimers();
  const { input, wire } = setup();
  let signal!: AbortSignal;
  let finishRead!: (text: string) => void;
  const copied = input.readAfterInput((value) => {
    signal = value;
    return new Promise<string>((resolve) => {
      finishRead = resolve;
    });
  });
  const failure = copied.catch((error: Error) => error.message);
  input.receive(frame(0x91, { requestId: 1, ok: true }));
  input.send(key("down", 4));
  const pasted = input.paste("next");
  input.send(key("down", 5));
  jest.advanceTimersByTime(150_000);
  expect(await failure).toBe("Copy timed out.");
  expect(signal.aborted).toBe(true);
  finishRead("late");
  await Promise.resolve();
  await Promise.resolve();
  expect(wire.map((entry) => entry.tag)).toEqual([0x11, 0x06, 0x12]);
  input.receive(frame(0x92, { requestId: 2, ok: true }));
  expect(await pasted).toEqual({});
  expect(wire.at(-1)).toEqual({ tag: 0x06, payload: key("down", 5) });
  input.dispose();
});

test("transport cleanup preserves ordinary paced typing when no clipboard request is pending", async () => {
  const { input, wire } = setup();
  input.enqueue([key("down", 4), key("up", 4)]);
  input.cancelRequests();
  await flush();
  expect(wire.map((entry) => entry.payload)).toEqual([key("down", 4), key("up", 4)]);
  input.dispose();
});

test("transport cleanup rejects clipboard work and drops keys that waited behind it", async () => {
  const { input, wire } = setup();
  const paste = input.paste("text");
  input.send(key("down", 4));
  input.cancelRequests();
  await expect(paste).rejects.toThrow(INPUT_DISCONNECTED_MESSAGE);
  input.receive(frame(0x92, { requestId: 1, ok: true }));
  expect(wire.map((entry) => entry.tag)).toEqual([0x12]);
  input.dispose();
});

test("transport cleanup preserves typing before the first clipboard request", async () => {
  const { input, wire } = setup();
  input.enqueue([key("down", 4), key("up", 4)]);
  input.send(key("down", 5));
  input.send(key("up", 5));
  const paste = input.paste("never replay");
  const read = input.readAfterInput(async () => "never read");
  input.enqueue([key("down", 6), key("up", 6)]);
  input.cancelRequests();
  await expect(paste).rejects.toThrow(INPUT_DISCONNECTED_MESSAGE);
  await expect(read).rejects.toThrow(INPUT_DISCONNECTED_MESSAGE);
  await flush();
  expect(wire.map((entry) => entry.payload)).toEqual([
    key("down", 4),
    key("up", 4),
    key("down", 5),
    key("up", 5),
  ]);
  input.dispose();
});
