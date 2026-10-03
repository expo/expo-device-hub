import { expect, test } from "bun:test";
import { createOrderedKeyboardInput, type KeyboardInputEvent } from "../client/utils/ordered-keyboard-input";
import { copySimClipboardAfterInput } from "../client/utils/sim-clipboard";

function input(pasteTimeoutMs = 1000) {
  let device = "device-a";
  let connection: object | null = {};
  let sendSucceeds = true;
  let keyError: Error | null = null;
  const sent: Array<KeyboardInputEvent | { requestId: number; text?: string }> = [];
  const keyboard = createOrderedKeyboardInput({
    getDevice: () => device,
    getConnection: () => connection,
    sendKey: (event) => {
      if (keyError) throw keyError;
      sent.push(event);
    },
    sendPaste: (_connection, message) => {
      if (!sendSucceeds) return false;
      expect(message[0]).toBe(0x12);
      sent.push(JSON.parse(new TextDecoder().decode(message.subarray(1))));
      return true;
    },
    pasteTimeoutMs,
  });
  return {
    keyboard, sent,
    get connection() { return connection; },
    set connection(value: object | null) { connection = value; },
    set device(value: string) { device = value; },
    set sendSucceeds(value: boolean) { sendSucceeds = value; },
    set keyError(value: Error | null) { keyError = value; },
    reply(requestId: number, reply: object = { ok: true }) {
      return keyboard.receive(connection, { requestId, ...reply });
    },
  };
}

const down = (usage: number): KeyboardInputEvent => ({ type: "down", usage });
const up = (usage: number): KeyboardInputEvent => ({ type: "up", usage });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

test("Copy reserves its barrier and read ahead of later paste and typing", async () => {
  const state = input();
  const barrier = deferred<void>();
  const read = deferred<string>();
  const stages: string[] = [];
  const first = state.keyboard.paste("a");
  const copy = state.keyboard.run(async () => {
    stages.push("barrier");
    await barrier.promise;
    stages.push("read");
    return read.promise;
  });
  const later = state.keyboard.paste("b");
  state.keyboard.send(down(27));
  state.reply(1);
  await first;
  expect(stages).toEqual(["barrier"]);
  expect(state.sent).toEqual([{ requestId: 1, text: "a" }]);
  barrier.resolve();
  await Promise.resolve();
  expect(stages).toEqual(["barrier", "read"]);
  expect(state.sent).toEqual([{ requestId: 1, text: "a" }]);
  read.resolve("selection before later input");
  expect(await copy).toBe("selection before later input");
  expect(state.sent).toEqual([{ requestId: 1, text: "a" }, { requestId: 2, text: "b" }]);
  state.reply(2);
  await later;
  expect(state.sent.at(-1)).toEqual(down(27));
  state.keyboard.dispose();
});

test("retired Copy actions cannot run on another connection or complete a newer action", async () => {
  const state = input();
  const read = deferred<string>();
  const copy = state.keyboard.run(() => read.promise).catch((error: Error) => error);
  state.keyboard.cancel();
  expect((await copy as Error).message).toContain("disconnected");
  state.connection = {};
  const first = state.keyboard.paste("new");
  const previousConnection = state.connection;
  let ran = false;
  const retired = state.keyboard.run(async () => { ran = true; }).catch((error: Error) => error);
  state.connection = {};
  state.keyboard.receive(previousConnection, { requestId: 1, ok: true });
  await first;
  expect((await retired as Error).message).toContain("disconnected");
  expect(ran).toBe(false);
  const next = state.keyboard.paste("next");
  read.resolve("old selection");
  await Promise.resolve();
  expect(state.reply(2)).toBe(true);
  await next;
  state.keyboard.dispose();
});

test("Copy failures and timeouts release the ordered input slot", async () => {
  const state = input(10);
  await expect(state.keyboard.run(() => { throw new Error("Copy refused"); })).rejects.toThrow("Copy refused");
  const read = deferred<string>();
  const timedOut = state.keyboard.run(() => read.promise).catch((error: Error) => error);
  const paste = state.keyboard.paste("next");
  expect((await timedOut as Error).message).toContain("timed out");
  read.resolve("late selection");
  await Promise.resolve();
  expect(state.reply(1)).toBe(true);
  await paste;
  state.keyboard.dispose();
});

test("a retired Copy cannot read after its input barrier finishes late", async () => {
  const state = input(10);
  const barrier = deferred<void>();
  const currentness: boolean[] = [];
  const copy = state.keyboard.run((isCurrent) => copySimClipboardAfterInput(
    "device-a",
    () => barrier.promise,
    () => { const current = isCurrent(); currentness.push(current); return current; },
  )).catch((error: Error) => error);
  state.keyboard.send(down(27));
  expect((await copy as Error).message).toContain("timed out");
  barrier.resolve();
  await Promise.resolve();
  expect(currentness).toEqual([false]);
  expect(state.sent).toEqual([down(27)]);
  state.keyboard.dispose();
});

test("ordinary physical keys send immediately without an acknowledgment", () => {
  const { keyboard, sent } = input();
  keyboard.send(down(4));
  keyboard.send(up(4));
  expect(sent).toEqual([down(4), up(4)]);
  keyboard.dispose();
});

test("two pastes followed by typing keep their invocation order", async () => {
  const state = input();
  const first = state.keyboard.paste("a");
  const second = state.keyboard.paste("b");
  state.keyboard.send(down(27));
  state.keyboard.send(up(27));
  expect(state.sent).toEqual([{ requestId: 1, text: "a" }]);
  state.reply(1);
  await first;
  expect(state.sent).toEqual([{ requestId: 1, text: "a" }, { requestId: 2, text: "b" }]);
  state.reply(2);
  await second;
  expect(state.sent).toEqual([
    { requestId: 1, text: "a" }, { requestId: 2, text: "b" }, down(27), up(27),
  ]);
  state.keyboard.dispose();
});

test("a paste follows prior paced text and precedes later paced text and physical keys", async () => {
  const state = input();
  state.keyboard.enqueue([down(4), up(4)]);
  const paste = state.keyboard.paste("b");
  state.keyboard.enqueue([down(27), up(27)]);
  state.keyboard.send(down(28));
  await Bun.sleep(25);
  expect(state.sent).toEqual([down(4), up(4), { requestId: 1, text: "b" }]);
  state.reply(1);
  await paste;
  await state.keyboard.run(async () => {});
  expect(state.sent).toEqual([
    down(4), up(4), { requestId: 1, text: "b" }, down(27), up(27), down(28),
  ]);
  state.keyboard.dispose();
});

test("a timed-out paste cannot consume the next reply and queued input recovers", async () => {
  const state = input(10);
  const failed = state.keyboard.paste("a").catch((error: Error) => error);
  const second = state.keyboard.paste("b");
  state.keyboard.send(down(27));
  expect(await failed).toBeInstanceOf(Error);
  expect((await failed as Error).message).toContain("timed out");
  expect(state.reply(1)).toBe(false);
  expect(state.keyboard.receive(state.connection, { requestId: 2, ok: 1 })).toBe(false);
  expect(state.reply(2, { ok: true, cleanupWarning: "Release a held key" })).toBe(true);
  expect(await second).toEqual({ cleanupWarning: "Release a held key" });
  expect(state.sent).toEqual([{ requestId: 1, text: "a" }, { requestId: 2, text: "b" }, down(27)]);
  state.keyboard.dispose();
});

test("disconnect drops unsent pastes and keys, ignores old replies, and permits new input", async () => {
  const state = input();
  const oldConnection = state.connection;
  const first = state.keyboard.paste("old-a").catch((error: Error) => error);
  const second = state.keyboard.paste("old-b").catch((error: Error) => error);
  state.keyboard.send(down(27));
  state.connection = null;
  state.keyboard.cancel();
  const errors = await Promise.all([first, second]);
  for (const error of errors) expect((error as Error).message).toContain("disconnected");
  state.connection = {};
  const next = state.keyboard.paste("new");
  expect(state.keyboard.receive(oldConnection, { requestId: 3, ok: true })).toBe(false);
  expect(state.reply(1)).toBe(false);
  state.reply(3);
  await next;
  state.keyboard.send(down(28));
  expect(state.sent).toEqual([{ requestId: 1, text: "old-a" }, { requestId: 3, text: "new" }, down(28)]);
  state.keyboard.dispose();
});

test("queued pastes and keys cannot move to a different device or connection", async () => {
  const state = input();
  const first = state.keyboard.paste("old-a");
  const second = state.keyboard.paste("old-b").catch((error: Error) => error);
  state.keyboard.send(down(27));
  state.device = "device-b";
  state.reply(1);
  await first;
  expect((await second as Error).message).toContain("disconnected");
  expect(state.sent).toEqual([{ requestId: 1, text: "old-a" }]);
  state.keyboard.send(down(28));
  expect(state.sent.at(-1)).toEqual(down(28));
  state.keyboard.dispose();
});

test("cancel stops a paced batch and a snapshot waiter without replaying old keys", async () => {
  const state = input();
  state.keyboard.enqueue([down(4), up(4), down(5), up(5)]);
  const idle = state.keyboard.run(async () => {}).catch((error: Error) => error);
  const paste = state.keyboard.paste("old").catch((error: Error) => error);
  state.keyboard.cancel();
  expect((await idle as Error).message).toContain("disconnected");
  expect((await paste as Error).message).toContain("disconnected");
  state.connection = {};
  state.keyboard.send(down(27));
  await Bun.sleep(25);
  expect(state.sent).toEqual([down(4), down(27)]);
  state.keyboard.dispose();
});

test("a failed send or server rejection lets the next clipboard action proceed", async () => {
  const state = input();
  state.sendSucceeds = false;
  await expect(state.keyboard.paste("not sent")).rejects.toThrow("disconnected");
  state.sendSucceeds = true;
  const refused = state.keyboard.paste().catch((error: Error) => error);
  const next = state.keyboard.paste("new");
  state.reply(2, { ok: false, error: "Try selecting text" });
  expect((await refused as Error).message).toContain("Try selecting text");
  state.reply(3);
  await next;
  expect(state.sent).toEqual([{ requestId: 2 }, { requestId: 3, text: "new" }]);
  state.keyboard.dispose();
});

test("an oversized paste fails without blocking later keys", async () => {
  const state = input();
  await expect(state.keyboard.paste("a".repeat(4 * 1024 * 1024))).rejects.toThrow("too large");
  state.keyboard.send(down(4));
  expect(state.sent).toEqual([down(4)]);
  state.keyboard.dispose();
});

test("a throwing key send cancels unsent actions and allows fresh input", async () => {
  const state = input();
  const first = state.keyboard.paste("a");
  state.keyboard.send(down(4));
  const unsent = state.keyboard.paste("b").catch((error: Error) => error);
  state.keyError = new Error("Socket closed while sending");
  expect(() => state.reply(1)).toThrow("Socket closed while sending");
  await first;
  expect((await unsent as Error).message).toContain("disconnected");
  state.keyError = null;
  const next = state.keyboard.paste("new");
  state.reply(3);
  await next;
  expect(state.sent).toEqual([{ requestId: 1, text: "a" }, { requestId: 3, text: "new" }]);
  state.keyboard.dispose();
});

test("disposing cancels pending and paced input permanently", async () => {
  const state = input();
  const first = state.keyboard.paste("old").catch((error: Error) => error);
  state.keyboard.enqueue([down(4), up(4)]);
  state.keyboard.dispose();
  expect((await first as Error).message).toContain("disconnected");
  expect(state.reply(1)).toBe(false);
  state.keyboard.send(down(27));
  state.keyboard.enqueue([up(27)]);
  await expect(state.keyboard.paste("new")).rejects.toThrow("disconnected");
  await Bun.sleep(25);
  expect(state.sent).toEqual([{ requestId: 1, text: "old" }]);
});
