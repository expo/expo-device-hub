import { describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { EventEmitter } from "events";
import { mkdtempSync, rmSync } from "fs";
import type { Socket } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { rawHidSocket } from "../socket/server-input";
import { websocketFrame } from "../socket/frames";

class FakeSocket extends EventEmitter {
  destroyed = false;
  writable = true;
  pingCount = 0;
  replyToPings = false;
  closeOnEnd = true;
  endCalls = 0;
  destroyCalls = 0;

  write(frame: Buffer): boolean {
    if ((frame[0]! & 0x0f) === 0x9) {
      this.pingCount++;
      if (this.replyToPings) queueMicrotask(() => this.emit("data", Buffer.from([0x8a, 0x00])));
    }
    return true;
  }

  end(_frame?: Buffer): void {
    this.endCalls++;
    this.writable = false;
    if (this.closeOnEnd) this.destroy();
  }
  destroySoon(): void { this.destroy(); }
  destroy(): void {
    this.destroyCalls++;
    if (this.destroyed) return;
    this.destroyed = true;
    this.writable = false;
    this.emit("close");
  }
}

describe("raw HID socket heartbeat", () => {
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

describe("raw HID socket close delivery", () => {
  test("releases capacity immediately, waits for TCP close, and bounds an unresponsive peer", async () => {
    const stalled = new FakeSocket();
    const responsive = new FakeSocket();
    stalled.closeOnEnd = responsive.closeOnEnd = false;
    try {
      const ws = rawHidSocket(stalled as unknown as Socket, Buffer.alloc(0));
      const other = rawHidSocket(responsive as unknown as Socket, Buffer.alloc(0));
      let closes = 0;
      ws.on("close", () => { closes++; });
      ws.close(1013, "retry later");
      expect(closes).toBe(1);
      expect(stalled.destroyed).toBe(false);
      ws.close(1013, "retry later");
      expect(stalled.endCalls).toBe(1);

      other.close();
      responsive.destroy(); // Actual TCP close cancels its forced-cleanup timer.
      await Bun.sleep(1_150);
      expect(stalled.destroyed).toBe(true);
      expect(stalled.destroyCalls).toBe(1);
      expect(responsive.destroyCalls).toBe(1);
      expect(closes).toBe(1);
    } finally {
      stalled.destroy();
      responsive.destroy();
    }
  }, 3_000);

  test("stops processing the current input batch when a message closes the socket", () => {
    const socket = new FakeSocket();
    socket.closeOnEnd = false;
    try {
      const ws = rawHidSocket(socket as unknown as Socket, Buffer.alloc(0));
      let messages = 0;
      ws.on("message", () => { messages++; ws.close(1013, "retry later"); });
      const input = websocketFrame(0x2, Buffer.from([0x03]));
      socket.emit("data", Buffer.concat([input, input]));
      socket.emit("data", input);
      expect(messages).toBe(1);
      expect(socket.endCalls).toBe(1);
    } finally {
      socket.destroy();
    }
  });

  test("delivers the rejection code and reason over a real Node socket with concurrent input", async () => {
    const directory = mkdtempSync(join(tmpdir(), "serve-sim-hid-close-"));
    try {
      const result = await Bun.build({
        entrypoints: [join(import.meta.dir, "fixtures/raw-hid-close.child.ts")],
        outdir: directory,
        naming: "fixture.cjs",
        target: "node",
        format: "cjs",
        external: ["bufferutil", "utf-8-validate"],
      });
      expect(result.success).toBe(true);
      const output = execFileSync("node", [join(directory, "fixture.cjs")], {
        env: { ...process.env },
        encoding: "utf8",
        timeout: 8_000,
      });
      expect(JSON.parse(output)).toEqual({ code: 1013, reason: "Simulator input unavailable; retry after other clients disconnect", messages: 1, closes: 1 });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 10_000);
});
