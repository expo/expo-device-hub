import { describe, expect, test } from "bun:test";
import { EventEmitter } from "events";
import type { Socket } from "net";
import { rawHidSocket } from "../middleware";
import { claimHelperHidSocket, startHidHeartbeat, type UpgradeHandlerWebSocket } from "../middleware-utils";

// serve-sim admits at most eight input sockets per device and frees a slot
// only when the socket reports close or error. A peer that leaves any other
// way must still end up there, or it locks every client out with 1013.

const FAST = { intervalMs: 10, missedLimit: 2 };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeSocket extends EventEmitter {
  destroyed = false;
  writable = true;
  readonly writes: Buffer[] = [];
  write(data: Buffer) {
    this.writes.push(data);
    return true;
  }
  end(data?: Buffer) {
    if (data) this.writes.push(data);
    this.writable = false;
  }
  destroySoon() {
    this.destroy();
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.writable = false;
    queueMicrotask(() => this.emit("close"));
  }
}

/** A masked client frame, as browsers send them. */
function clientFrame(opcode: number, payload = Buffer.alloc(0)): Buffer {
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]!));
  return Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | payload.length]), mask, masked]);
}

function rawHid(heartbeat = FAST) {
  const socket = new FakeSocket();
  const hid = rawHidSocket(socket as unknown as Socket, Buffer.alloc(0), heartbeat);
  let closes = 0;
  hid.on("close", () => closes++);
  return { socket, hid, closes: () => closes };
}

describe("raw HID socket liveness", () => {
  test("a TCP FIN without a close frame closes the socket", () => {
    const { socket, closes } = rawHid({ intervalMs: 60_000, missedLimit: 2 });
    socket.emit("end");
    expect(closes()).toBe(1);
  });

  test("a peer that stops answering pings is closed", async () => {
    const { socket, closes } = rawHid();
    await wait(60);
    expect(socket.writes.some((frame) => frame[0] === 0x89)).toBe(true);
    expect(closes()).toBe(1);
    expect(socket.destroyed).toBe(true);
  });

  test("pongs keep the socket open", async () => {
    const { socket, closes } = rawHid();
    for (let i = 0; i < 8; i++) {
      await wait(8);
      socket.emit("data", clientFrame(0xa));
    }
    expect(closes()).toBe(0);
    socket.destroy();
  });

  test("closing the socket stops the pings", async () => {
    const { socket, hid } = rawHid();
    hid.close(1000, "");
    const writes = socket.writes.length;
    await wait(40);
    expect(socket.writes.length).toBe(writes);
  });
});

describe("host-accepted HID socket liveness", () => {
  function wsLike() {
    const emitter = new EventEmitter();
    const socket = {
      OPEN: 1,
      readyState: 1,
      pings: 0,
      terminated: false,
      send() {},
      close() {},
      ping() { socket.pings++; },
      terminate() {
        socket.terminated = true;
        emitter.emit("close");
      },
      on(event: string, listener: (...args: any[]) => void) {
        emitter.on(event, listener);
      },
      emit: (event: string) => emitter.emit(event),
    };
    return socket;
  }

  function claim(ws: UpgradeHandlerWebSocket) {
    return claimHelperHidSocket(new Request("http://localhost/helper/ws?device=SIM"), ws, {
      helperProxyTarget: () => ({ device: "SIM", upstreamPath: "/ws" }),
      fallbackDevice: null,
      resolveSession: () => ({ attachHidSocket() {} }),
      heartbeat: FAST,
    });
  }

  test("a ws socket that stops answering pings is terminated", async () => {
    const ws = wsLike();
    expect(claim(ws)).toBe(true);
    await wait(60);
    expect(ws.pings).toBeGreaterThan(0);
    expect(ws.terminated).toBe(true);
  });

  test("pongs keep a ws socket open", async () => {
    const ws = wsLike();
    claim(ws);
    for (let i = 0; i < 8; i++) {
      await wait(8);
      ws.emit("pong");
    }
    expect(ws.terminated).toBe(false);
    ws.emit("close");
  });
});

test("startHidHeartbeat calls dead only after the missed-ping limit", async () => {
  let pings = 0;
  let dead = 0;
  startHidHeartbeat(() => pings++, () => dead++, FAST);
  await wait(15);
  expect(dead).toBe(0);
  await wait(50);
  expect(pings).toBe(2);
  expect(dead).toBe(1);
});
