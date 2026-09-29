import { expect, test } from "bun:test";
import { createInputSocket } from "../socket/client-input";

class FakeSocket {
  binaryType = "blob";
  readyState = 0;
  sent: ArrayBuffer[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  open() { this.readyState = 1; this.onopen?.(); }
  message(data: unknown) { this.onmessage?.({ data }); }
  send(data: ArrayBuffer) { this.sent.push(data); }
  close(code = 1000, reason = "") {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

function setup() {
  const sockets: FakeSocket[] = [];
  const errors: string[] = [];
  let recoveries = 0;
  let admissions = 0;
  let disconnects = 0;
  const input = createInputSocket("ws://localhost/ws", {
    onAdmitted: () => { admissions++; },
    onMessage: (data) => data === "admitted",
    onDisconnect: () => { disconnects++; },
    onRefused: (reason) => { errors.push(reason); },
    onRecovered: () => { recoveries++; },
  }, {
    reconnectDelayMs: 10,
    refusalDelayMs: 40,
    openSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
  return {
    input,
    sockets,
    errors,
    get admissions() { return admissions; },
    get disconnects() { return disconnects; },
    get recoveries() { return recoveries; },
  };
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
    expect(state.admissions).toBe(1);
    expect(state.disconnects).toBe(1);
    expect(state.sockets[1]!.binaryType).toBe("arraybuffer");
  } finally {
    state.input.dispose();
  }
});

test("admission callback waits for a valid config frame and runs once per socket", async () => {
  const state = setup();
  try {
    state.input.start();
    state.sockets[0]!.open();
    state.sockets[0]!.message("other frame");
    expect(state.admissions).toBe(0);
    state.sockets[0]!.message("admitted");
    state.sockets[0]!.message("admitted");
    expect(state.admissions).toBe(1);
    state.sockets[0]!.close();
    await Bun.sleep(20);
    state.sockets[1]!.open();
    expect(state.admissions).toBe(1);
    state.sockets[1]!.message("admitted");
    expect(state.admissions).toBe(2);
  } finally {
    state.input.dispose();
  }
});

test("server admission flushes input before screen dimensions are available", () => {
  const state = setup();
  try {
    state.input.start();
    state.input.send(0x04, { button: "home" });
    state.sockets[0]!.open();
    expect(state.sockets[0]!.sent).toHaveLength(0);
    state.sockets[0]!.message(Uint8Array.of(0x83).buffer);
    expect(state.admissions).toBe(1);
    expect(state.sockets[0]!.sent).toHaveLength(1);
    expect(new Uint8Array(state.sockets[0]!.sent[0]!)[0]).toBe(0x04);
    state.sockets[0]!.message("admitted");
    expect(state.admissions).toBe(1);
  } finally {
    state.input.dispose();
  }
});

test("queued input waits for admission and acknowledged commands never queue", async () => {
  const state = setup();
  try {
    state.input.start();
    state.input.send(0x03, { type: "begin" });
    expect(state.input.trySend(0x10, { requestId: 1 })).toBe(false);
    state.sockets[0]!.open();
    expect(state.sockets[0]!.sent).toHaveLength(0);
    expect(state.input.trySend(0x10, { requestId: 1 })).toBe(false);
    state.sockets[0]!.message("admitted");
    expect(new Uint8Array(state.sockets[0]!.sent[0]!)[0]).toBe(0x03);
    expect(state.input.trySend(0x10, { requestId: 1 })).toBe(true);
    state.sockets[0]!.close();
    state.input.send(0x04, { button: "home" });
    await Bun.sleep(20);
    state.sockets[1]!.open();
    expect(state.sockets[1]!.sent).toHaveLength(0);
    state.sockets[1]!.message("admitted");
    expect(new Uint8Array(state.sockets[1]!.sent[0]!)[0]).toBe(0x04);
    expect(state.sockets[1]!.sent).toHaveLength(1);
  } finally {
    state.input.dispose();
  }
});

test("a refused open preserves fresh queued input for the next admitted socket", async () => {
  const state = setup();
  try {
    state.input.start();
    state.input.send(0x04, { button: "home" });
    state.sockets[0]!.open();
    expect(state.sockets[0]!.sent).toHaveLength(0);
    state.sockets[0]!.close(1013, "busy");
    await Bun.sleep(20);
    state.sockets[1]!.open();
    state.sockets[1]!.message("admitted");
    expect(state.sockets[1]!.sent).toHaveLength(1);
    expect(new Uint8Array(state.sockets[1]!.sent[0]!)[0]).toBe(0x04);
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

test("admission after a reported refusal clears the failure notice", async () => {
  const state = setup();
  try {
    state.input.start();
    state.sockets[0]!.close(1013, "busy");
    await Bun.sleep(50);
    expect(state.errors).toEqual(["busy"]);
    state.sockets[1]!.open();
    state.sockets[1]!.message("admitted");
    expect(state.recoveries).toBe(1);
    state.sockets[1]!.message("admitted");
    expect(state.recoveries).toBe(1);
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
