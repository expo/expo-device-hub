import { expect, test } from "bun:test";
import { createRetryingInputSocket } from "../client/utils/retrying-input-socket";

class FakeSocket {
  binaryType = "blob";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  open() { this.onopen?.(); }
  message(data: unknown) { this.onmessage?.({ data }); }
  close(code = 1000, reason = "") {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.({ code, reason });
  }
}

function setup() {
  const sockets: FakeSocket[] = [];
  const errors: string[] = [];
  let opens = 0;
  let disconnects = 0;
  const input = createRetryingInputSocket("ws://localhost/ws", {
    onOpen: () => { opens++; },
    onMessage: (data) => data === "admitted",
    onDisconnect: () => { disconnects++; },
    onRefused: (reason) => { errors.push(reason); },
  }, {
    reconnectDelayMs: 10,
    refusalDelayMs: 40,
    openSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
  return { input, sockets, errors, get opens() { return opens; }, get disconnects() { return disconnects; } };
}

test("a retry admitted by a config frame clears a temporary refusal", async () => {
  const state = setup();
  try {
    state.input.start();
    state.sockets[0]!.open();
    state.sockets[0]!.close(1013, "busy");
    await Bun.sleep(20);
    state.sockets[1]!.open();
    state.sockets[1]!.message("other frame");
    state.sockets[1]!.message("admitted");
    await Bun.sleep(45);
    expect(state.errors).toEqual([]);
    expect(state.opens).toBe(2);
    expect(state.disconnects).toBe(1);
    expect(state.input.socket).toBe(state.sockets[1] as unknown as WebSocket);
    expect(state.sockets[1]!.binaryType).toBe("arraybuffer");
  } finally {
    state.input.dispose();
  }
});

test("persistent 1013 refusals report once while reconnecting", async () => {
  const state = setup();
  try {
    state.input.start();
    state.sockets[0]!.close(1013, "busy");
    await Bun.sleep(20);
    state.sockets[1]!.close(1013, "busy");
    await Bun.sleep(50);
    expect(state.errors).toEqual(["busy"]);
    state.sockets.at(-1)!.close(1013, "busy");
    await Bun.sleep(50);
    expect(state.errors).toEqual(["busy"]);
  } finally {
    state.input.dispose();
  }
});

test("disposing stops reconnects and pending refusal reports", async () => {
  const state = setup();
  state.input.start();
  state.sockets[0]!.close(1013, "busy");
  state.input.dispose();
  await Bun.sleep(55);
  expect(state.sockets).toHaveLength(1);
  expect(state.errors).toEqual([]);
});
