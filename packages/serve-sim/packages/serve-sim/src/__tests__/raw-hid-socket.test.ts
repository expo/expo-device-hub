import { describe, expect, test } from "bun:test";
import { EventEmitter } from "events";
import type { Socket } from "net";
import { rawHidSocket } from "../socket/server-input";

class FakeSocket extends EventEmitter {
  destroyed = false;
  writable = true;
  pingCount = 0;
  replyToPings = false;

  write(frame: Buffer): boolean {
    if ((frame[0]! & 0x0f) === 0x9) {
      this.pingCount++;
      if (this.replyToPings) queueMicrotask(() => this.emit("data", Buffer.from([0x8a, 0x00])));
    }
    return true;
  }

  end(_frame?: Buffer): void { this.destroy(); }
  destroySoon(): void { this.destroy(); }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.writable = false;
    this.emit("close");
  }
}

describe("raw HID socket heartbeat", () => {
  test("rejects an oversized input frame before buffering its body", () => {
    const socket = new FakeSocket();
    const header = Buffer.alloc(10);
    header[0] = 0x82;
    header[1] = 127;
    header.writeBigUInt64BE(4n * 1024n * 1024n + 1n, 2);
    const ws = rawHidSocket(socket as unknown as Socket, header);
    let closes = 0;
    ws.on("close", () => { closes++; });
    expect(closes).toBe(1);
    expect(socket.destroyed).toBe(true);
  });

  test("reports a close that arrived in the upgrade head before the session subscribed", () => {
    const socket = new FakeSocket();
    const ws = rawHidSocket(socket as unknown as Socket, Buffer.from([0x88, 0x00]));
    let closes = 0;
    ws.on("close", () => { closes++; });
    expect(closes).toBe(1);
    expect(socket.destroyed).toBe(true);
  });

  test("releases a socket whose browser disappeared without closing the upstream TCP connection", async () => {
    const socket = new FakeSocket();
    try {
      const ws = rawHidSocket(socket as unknown as Socket, Buffer.alloc(0), {
        pingIntervalMs: 10,
        pongTimeoutMs: 40,
      });
      let closes = 0;
      const closed = new Promise<void>((resolve) => ws.on("close", () => { closes++; resolve(); }));
      await Promise.race([
        closed,
        Bun.sleep(500).then(() => { throw new Error("Stale HID socket was not closed"); }),
      ]);
      expect(socket.pingCount).toBeGreaterThan(0);
      expect(closes).toBe(1);
    } finally {
      socket.destroy();
    }
  });

  test("keeps a responsive browser socket admitted", async () => {
    const socket = new FakeSocket();
    socket.replyToPings = true;
    try {
      const ws = rawHidSocket(socket as unknown as Socket, Buffer.alloc(0), {
        pingIntervalMs: 10,
        pongTimeoutMs: 40,
      });
      let closes = 0;
      ws.on("close", () => { closes++; });
      await Bun.sleep(100);
      expect(socket.pingCount).toBeGreaterThan(1);
      expect(socket.destroyed).toBe(false);
      expect(closes).toBe(0);
      socket.destroy();
      expect(closes).toBe(1);
    } finally {
      socket.destroy();
    }
  });
});
