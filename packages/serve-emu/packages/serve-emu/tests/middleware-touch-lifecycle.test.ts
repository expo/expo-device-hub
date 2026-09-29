import { describe, expect, test } from "bun:test";
import { ControlInputQueue } from "../src/control-input-queue.ts";
import { createApp } from "../src/middleware.ts";
import type { Gesture } from "../src/input.ts";
import type { StreamSocket } from "../src/stream-socket.ts";
import type { EmuSession } from "../src/stream-session.ts";
import type { SessionSnapshot } from "../src/session-recorder.ts";

class Viewer implements StreamSocket {
  readonly bufferedAmount = 0;
  readonly messages: unknown[] = [];
  #message: (text: string) => void = () => {};
  #close: () => void = () => {};

  send(data: string | Uint8Array): void {
    if (typeof data === "string") this.messages.push(JSON.parse(data));
  }
  onMessage(handler: (text: string) => void): void { this.#message = handler; }
  onClose(handler: () => void): void { this.#close = handler; }
  close(): void { this.#close(); }
  touch(action: "down" | "move" | "up", pointerId = 0, record = true): void {
    this.#message(JSON.stringify({ type: "touch", action, pointerId, x: 0.4, y: 0.6, record }));
  }
}

type Touch = Extract<Gesture, { type: "touch" }>;

async function harness(semantic: boolean, video: boolean, maxDepth = 128) {
  const touches: Touch[] = [];
  let block = false;
  let unblock: (() => void) | null = null;
  const write = async (gesture: Touch) => {
    touches.push(gesture);
    if (block) {
      block = false;
      await new Promise<void>((resolve) => { unblock = resolve; });
    }
  };
  const queue = new ControlInputQueue({
    maxDepth,
    ...(semantic ? {
      dispatcher: {
        async dispatchGesture(gesture: Gesture) {
          if (gesture.type === "touch") await write(gesture);
        },
        async resetVideo() {},
      },
    } : {
      writer: {
        async write(packet: Buffer) {
          if (packet[0] !== 2) return;
          await write({
            type: "touch", action: ["down", "up", "move"][packet[1]!] as Touch["action"],
            pointerId: Number(packet.readBigUInt64BE(2)), x: 0.4, y: 0.6,
          });
        },
      },
    }),
  });
  let end!: (value: null) => void;
  const frames = new Promise<null>((resolve) => { end = resolve; });
  const session: EmuSession = {
    serial: "emulator-5554", mode: semantic ? "grpc-screenshot" : "scrcpy",
    inputSource: semantic ? "grpc" : "scrcpy",
    meta: { deviceName: "touch-test", codecId: "h264", width: 576, height: 1280 },
    controls: queue,
    readFrame: () => frames,
    onFatal: () => () => {},
    async close() { queue.close(); end(null); },
  };
  const app = await createApp({ serial: session.serial, streamMode: session.mode, inputSource: session.inputSource }, {
    startSession: async () => session,
    clock: { now: () => 0, setInterval: () => 0, clearInterval: () => {} },
  });
  const settle = async () => {
    for (let i = 0; i < 100; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (queue.snapshot().depth === 0) return;
    }
    throw new Error("input queue did not drain");
  };
  return {
    app, queue, touches, settle,
    viewer() { const viewer = new Viewer(); app.attachWebSocket(viewer, { video, frameMeta: false }); return viewer; },
    blockNext() { block = true; },
    release() { unblock?.(); unblock = null; },
    async recorded(): Promise<SessionSnapshot> {
      return (await app.handleRequest(new Request("http://hub.test/api/session"))).json();
    },
    async stop() { unblock?.(); await app.stop(); },
  };
}

for (const semantic of [false, true]) {
  for (const video of [true, false]) {
    describe(`Hub touch lifecycle (${semantic ? "gRPC" : "scrcpy"}, video=${video})`, () => {
      test("releases a held touch when its viewer disconnects", async () => {
        const h = await harness(semantic, video);
        try {
          const viewer = h.viewer();
          viewer.touch("down");
          viewer.touch("move");
          await h.settle();
          viewer.close();
          await h.settle();
          expect(h.touches.map((touch) => touch.action)).toEqual(["down", "move", "up"]);
          expect(h.queue.snapshot().reservedReleases).toBe(0);
          const recorded = await h.recorded();
          expect(recorded.events.at(-1)).toMatchObject({ source: "ws:disconnect", gesture: { action: "up" } });
        } finally { await h.stop(); }
      });

      test("disconnect releases only that viewer's pointer even when both use zero", async () => {
        const h = await harness(semantic, video);
        try {
          const a = h.viewer(); const b = h.viewer();
          a.touch("down"); b.touch("down", 0, false);
          await h.settle();
          expect(h.touches[0]!.pointerId).not.toBe(h.touches[1]!.pointerId);
          a.close(); a.close();
          await h.settle();
          expect(h.touches.filter((touch) => touch.action === "up")).toEqual([
            { ...h.touches[0]!, action: "up" },
          ]);
          b.touch("move", 0, false); b.close();
          await h.settle();
          expect(h.touches.at(-1)).toEqual({ ...h.touches[1]!, action: "up" });
          expect(h.queue.snapshot().reservedReleases).toBe(0);
          expect((await h.recorded()).events.filter((event) => event.source === "ws:disconnect")).toHaveLength(1);
        } finally { await h.stop(); }
      });

      test("queues disconnect release after an admitted down before it completes", async () => {
        const h = await harness(semantic, video, 2);
        try {
          const viewer = h.viewer();
          await h.settle();
          h.blockNext(); viewer.touch("down");
          // Allow DOWN to enter the writer, but leave its completion blocked.
          for (let i = 0; i < 20 && h.touches.length === 0; i++) await Promise.resolve();
          expect(h.touches).toHaveLength(1);
          expect(h.queue.snapshot()).toMatchObject({ depth: 1, reservedReleases: 1 });
          viewer.close();
          expect(h.queue.snapshot()).toMatchObject({ depth: 2, reservedReleases: 0 });
          h.release(); await h.settle();
          expect(h.touches.map((touch) => touch.action)).toEqual(["down", "up"]);
        } finally { await h.stop(); }
      });
    });
  }
}
