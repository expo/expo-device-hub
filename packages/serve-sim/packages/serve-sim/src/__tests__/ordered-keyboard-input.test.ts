import { expect, test } from "bun:test";
import { createOrderedKeyboardInput, type KeyboardInputEvent } from "../client/utils/ordered-keyboard-input";

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

test("physical keys, paced text, and consecutive pastes keep their invocation order", async () => {
  const state = input();
  state.keyboard.send(down(6));
  state.keyboard.send(up(6));
  expect(state.sent).toEqual([down(6), up(6)]);
  state.keyboard.enqueue([down(4), up(4)]);
  const first = state.keyboard.paste("b");
  const second = state.keyboard.paste("c");
  state.keyboard.enqueue([down(27), up(27)]);
  state.keyboard.send(down(28));
  await Bun.sleep(25);
  expect(state.sent).toEqual([down(6), up(6), down(4), up(4), { requestId: 1, text: "b" }]);
  state.reply(1);
  await first;
  expect(state.sent).toEqual([
    down(6), up(6), down(4), up(4), { requestId: 1, text: "b" }, { requestId: 2, text: "c" },
  ]);
  state.reply(2);
  await second;
  const deadline = Date.now() + 1000;
  while (state.sent.length < 9 && Date.now() < deadline) await Bun.sleep(1);
  expect(state.sent).toEqual([
    down(6), up(6), down(4), up(4), { requestId: 1, text: "b" }, { requestId: 2, text: "c" },
    down(27), up(27), down(28),
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

test("disconnect drops pending input, ignores old replies, and permits new input", async () => {
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
  state.keyboard.enqueue([down(4), up(4), down(5), up(5)]);
  const pacedPaste = state.keyboard.paste("old-paced").catch((error: Error) => error);
  state.keyboard.cancel();
  expect((await pacedPaste as Error).message).toContain("disconnected");
  state.keyboard.send(down(28));
  await Bun.sleep(25);
  expect(state.sent).toEqual([
    { requestId: 1, text: "old-a" }, { requestId: 3, text: "new" }, down(4), down(28),
  ]);
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

test("failed sends, server rejections, and oversized text do not block later input", async () => {
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
  await expect(state.keyboard.paste("a".repeat(4 * 1024 * 1024))).rejects.toThrow("too large");
  state.keyboard.send(down(4));
  expect(state.sent).toEqual([{ requestId: 2 }, { requestId: 3, text: "new" }, down(4)]);
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
