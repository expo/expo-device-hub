import { describe, expect, test } from "bun:test";
import { ControlInputQueue, ControlInputRejectedError } from "../src/control-input-queue.ts";
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
  onMessage(handler: (text: string) => void): void {
    this.#message = handler;
  }
  onClose(handler: () => void): void {
    this.#close = handler;
  }
  close(): void {
    this.#close();
  }
  touch(action: "down" | "move" | "up", pointerId = 0, record = true): void {
    this.#message(JSON.stringify({ type: "touch", action, pointerId, x: 0.4, y: 0.6, record }));
  }
}

type Touch = Extract<Gesture, { type: "touch" }>;

async function harness(semantic: boolean, video: boolean, maxDepth = 128) {
  const captures: Touch[][] = [];
  let touches: Touch[];
  let queue: ControlInputQueue;
  let block = false;
  let rejectAction: Touch["action"] | null = null;
  let unblock: (() => void) | null = null;
  const write = async (gesture: Touch) => {
    touches.push(gesture);
    if (rejectAction === gesture.action) {
      rejectAction = null;
      throw new ControlInputRejectedError(`rejected ${gesture.action}`);
    }
    if (block) {
      block = false;
      await new Promise<void>((resolve) => {
        unblock = resolve;
      });
    }
  };
  const startSession = async (): Promise<EmuSession> => {
    touches = [];
    captures.push(touches);
    queue = new ControlInputQueue({
      maxDepth,
      ...(semantic
        ? {
            dispatcher: {
              async dispatchGesture(gesture: Gesture) {
                if (gesture.type === "touch") await write(gesture);
              },
              async resetVideo() {},
            },
          }
        : {
            writer: {
              async write(packet: Buffer) {
                if (packet[0] !== 2) return;
                await write({
                  type: "touch",
                  action: ["down", "up", "move"][packet[1]!] as Touch["action"],
                  pointerId: Number(packet.readBigUInt64BE(2)),
                  x: 0.4,
                  y: 0.6,
                });
              },
            },
          }),
    });
    const controls = queue;
    let end!: (value: null) => void;
    const frames = new Promise<null>((resolve) => {
      end = resolve;
    });
    const session: EmuSession = {
      serial: "emulator-5554",
      mode: semantic ? "grpc-screenshot" : "scrcpy",
      inputSource: semantic ? "grpc" : "scrcpy",
      meta: { deviceName: "touch-test", codecId: "h264", width: 576, height: 1280 },
      controls,
      readFrame: () => frames,
      onFatal: () => () => {},
      async close() {
        controls.close();
        end(null);
      },
    };
    return session;
  };
  const app = await createApp(
    {
      serial: "emulator-5554",
      streamMode: semantic ? "grpc-screenshot" : "scrcpy",
      inputSource: semantic ? "grpc" : "scrcpy",
    },
    {
      startSession,
      clock: { now: () => 0, setInterval: () => 0, clearInterval: () => {} },
    },
  );
  const settle = async () => {
    for (let i = 0; i < 100; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (queue.snapshot().depth === 0) return;
    }
    throw new Error("input queue did not drain");
  };
  return {
    app,
    captures,
    settle,
    get queue() {
      return queue;
    },
    get touches() {
      return touches;
    },
    post(path: string, body: unknown = {}) {
      return app.handleRequest(
        new Request(`http://hub.test${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    },
    replace() {
      return app.handleRequest(
        new Request("http://hub.test/api/stream-settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ h264Fps: 31 }),
        }),
      );
    },
    viewer() {
      const viewer = new Viewer();
      app.attachWebSocket(viewer, { video, frameMeta: false });
      return viewer;
    },
    rejectNext(action: Touch["action"]) {
      rejectAction = action;
    },
    blockNext() {
      block = true;
    },
    release() {
      unblock?.();
      unblock = null;
    },
    async recorded(): Promise<SessionSnapshot> {
      return (await app.handleRequest(new Request("http://hub.test/api/session"))).json();
    },
    async stop() {
      unblock?.();
      await app.stop();
    },
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
          expect(recorded.events.at(-1)).toMatchObject({
            source: "ws:disconnect",
            gesture: { action: "up" },
          });
        } finally {
          await h.stop();
        }
      });

      test("disconnect releases only that viewer's pointer even when both use zero", async () => {
        const h = await harness(semantic, video);
        try {
          const a = h.viewer();
          const b = h.viewer();
          a.touch("down");
          b.touch("down", 0, false);
          await h.settle();
          expect(h.touches[0]!.pointerId).not.toBe(h.touches[1]!.pointerId);
          a.close();
          a.close();
          await h.settle();
          expect(h.touches.filter((touch) => touch.action === "up")).toEqual([
            { ...h.touches[0]!, action: "up" },
          ]);
          b.touch("move", 0, false);
          b.close();
          await h.settle();
          expect(h.touches.at(-1)).toEqual({ ...h.touches[1]!, action: "up" });
          expect(h.queue.snapshot().reservedReleases).toBe(0);
          expect(
            (await h.recorded()).events.filter((event) => event.source === "ws:disconnect"),
          ).toHaveLength(1);
        } finally {
          await h.stop();
        }
      });

      test("keeps both fingers of a pinch owned by one viewer", async () => {
        const h = await harness(semantic, video);
        try {
          const viewer = h.viewer();
          viewer.touch("down", 0);
          viewer.touch("down", 1);
          await h.settle();
          expect(new Set(h.touches.map((touch) => touch.pointerId)).size).toBe(2);
          expect(
            h.touches.every((touch) => touch.pointerId! > 0 && touch.pointerId! <= 0x7fffffff),
          ).toBe(true);
          viewer.close();
          await h.settle();
          expect(h.touches.slice(2)).toEqual(
            h.touches.slice(0, 2).map((touch) => ({ ...touch, action: "up" })),
          );
        } finally {
          await h.stop();
        }
      });

      test("does not release a rejected down or accept input after close", async () => {
        const h = await harness(semantic, video, 1);
        try {
          const viewer = h.viewer();
          await h.settle();
          viewer.touch("down");
          expect(viewer.messages.at(-1)).toMatchObject({ ok: false });
          viewer.close();
          viewer.touch("down");
          await h.settle();
          expect(h.touches).toEqual([]);
          expect(h.queue.snapshot().reservedReleases).toBe(0);
          expect((await h.recorded()).events).toEqual([]);
        } finally {
          await h.stop();
        }
      });

      test("rejects duplicate downs and orphan moves without losing the accepted touch", async () => {
        const h = await harness(semantic, video);
        try {
          const viewer = h.viewer();
          viewer.touch("move", 9);
          viewer.touch("down");
          viewer.touch("down");
          await h.settle();
          expect(
            viewer.messages.filter((message) => (message as { ok?: boolean }).ok === false),
          ).toHaveLength(2);
          viewer.close();
          await h.settle();
          expect(h.touches.map((touch) => touch.action)).toEqual(["down", "up"]);
        } finally {
          await h.stop();
        }
      });

      test("does not release an old capture's touch into a replacement input queue", async () => {
        const h = await harness(semantic, video);
        try {
          const oldViewer = h.viewer();
          oldViewer.touch("down");
          await h.settle();
          expect((await h.replace()).status).toBe(200);
          const newViewer = h.viewer();
          newViewer.touch("down");
          await h.settle();
          oldViewer.close();
          await h.settle();
          expect(h.touches.map((touch) => touch.action)).toEqual(["down"]);
          newViewer.close();
          await h.settle();
          expect(h.touches.map((touch) => touch.action)).toEqual(["down", "up"]);
        } finally {
          await h.stop();
        }
      });

      test("a surviving viewer starts a fresh gesture after capture replacement", async () => {
        const h = await harness(semantic, video);
        try {
          const viewer = h.viewer();
          viewer.touch("down");
          await h.settle();
          expect((await h.replace()).status).toBe(200);
          viewer.touch("up");
          viewer.touch("move");
          await h.settle();
          expect(h.touches).toEqual([]);
          viewer.touch("down");
          viewer.touch("move");
          viewer.close();
          await h.settle();
          expect(h.touches.map((touch) => touch.action)).toEqual(["down", "move", "up"]);
        } finally {
          await h.stop();
        }
      });

      test("replay remaps recorded touch IDs independently of live viewers", async () => {
        const h = await harness(semantic, video);
        try {
          const viewer = h.viewer();
          viewer.touch("down");
          viewer.touch("up");
          await h.settle();
          viewer.touch("down", 0, false);
          await h.settle();
          expect((await h.post("/api/session/replay", { multiplier: 100 })).status).toBe(200);
          for (let i = 0; i < 100 && (await h.recorded()).replaying; i++)
            await new Promise((resolve) => setTimeout(resolve, 1));
          await h.settle();
          const replay = await h.recorded();
          expect(replay.replayStatus).toBe("completed");
          const downs = h.touches.filter((touch) => touch.action === "down");
          expect(downs).toHaveLength(3);
          expect(new Set(downs.map((touch) => touch.pointerId)).size).toBe(3);
          viewer.close();
          await h.settle();
          expect(h.touches.at(-1)?.pointerId).toBe(downs[1]!.pointerId);
          expect((await h.recorded()).events).toHaveLength(2);
        } finally {
          await h.stop();
        }
      });

      test("recorded pointer IDs remain distinct across capture generations", async () => {
        const h = await harness(semantic, video);
        try {
          const viewer = h.viewer();
          viewer.touch("down");
          await h.settle();
          expect((await h.replace()).status).toBe(200);
          viewer.touch("down");
          viewer.touch("up");
          await h.settle();
          const recorded = await h.recorded();
          const ids = recorded.events.flatMap((event) =>
            event.kind === "gesture" &&
            event.gesture.type === "touch" &&
            event.gesture.action === "down"
              ? [event.gesture.pointerId]
              : [],
          );
          expect(ids).toHaveLength(2);
          expect(ids[0]).not.toBe(ids[1]);
          expect((await h.post("/api/session/replay", { multiplier: 100 })).status).toBe(200);
          for (let i = 0; i < 100 && (await h.recorded()).replaying; i++) {
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
          await h.settle();
          expect((await h.recorded()).replayStatus).toBe("completed");
          expect(h.queue.snapshot().reservedReleases).toBe(0);
        } finally {
          await h.stop();
        }
      });

      test("replay tolerates a trimmed touch prefix without releasing a viewer", async () => {
        const h = await harness(semantic, video);
        try {
          const viewer = h.viewer();
          viewer.touch("down", 0, false);
          await h.settle();
          h.app.deviceState.recorder.recordGesture(
            { type: "touch", action: "move", pointerId: 0, x: 0.4, y: 0.6 },
            "ws",
          );
          h.app.deviceState.recorder.recordGesture(
            { type: "touch", action: "up", pointerId: 0, x: 0.4, y: 0.6 },
            "ws",
          );
          expect((await h.post("/api/session/replay", { multiplier: 100 })).status).toBe(200);
          for (let i = 0; i < 100 && (await h.recorded()).replaying; i++)
            await new Promise((resolve) => setTimeout(resolve, 1));
          await h.settle();
          expect((await h.recorded()).replayStatus).toBe("completed");
          expect(h.touches.map((touch) => touch.action)).toEqual(["down"]);
          viewer.close();
          await h.settle();
          expect(h.queue.snapshot().reservedReleases).toBe(0);
        } finally {
          await h.stop();
        }
      });

      test("finishing a replay of a held touch does not leave a second pointer down", async () => {
        const h = await harness(semantic, video);
        try {
          const viewer = h.viewer();
          viewer.touch("down");
          await h.settle();
          expect((await h.post("/api/session/replay")).status).toBe(200);
          for (let i = 0; i < 100 && (await h.recorded()).replaying; i++)
            await new Promise((resolve) => setTimeout(resolve, 1));
          await h.settle();
          expect((await h.recorded()).replayStatus).toBe("completed");
          expect(h.queue.snapshot().reservedReleases).toBe(1);
          viewer.close();
          await h.settle();
          expect(h.queue.snapshot().reservedReleases).toBe(0);
        } finally {
          await h.stop();
        }
      });

      test("cancelling replay releases only the replay pointer", async () => {
        const h = await harness(semantic, video);
        try {
          const viewer = h.viewer();
          viewer.touch("down");
          viewer.touch("up");
          await h.settle();
          viewer.touch("down", 0, false);
          await h.settle();
          h.blockNext();
          expect((await h.post("/api/session/replay", { multiplier: 100 })).status).toBe(200);
          for (let i = 0; i < 100 && h.touches.length < 4; i++)
            await new Promise((resolve) => setTimeout(resolve, 1));
          expect(h.touches).toHaveLength(4);
          const cancelled = h.post("/api/session/replay/stop");
          await Promise.resolve();
          h.release();
          expect((await cancelled).status).toBe(200);
          await h.settle();
          expect((await h.recorded()).replayStatus).toBe("cancelled");
          expect(h.touches.at(-1)).toEqual({ ...h.touches[3]!, action: "up" });
          expect(h.queue.snapshot().reservedReleases).toBe(1);
          viewer.close();
          await h.settle();
          expect(h.queue.snapshot().reservedReleases).toBe(0);
        } finally {
          await h.stop();
        }
      });

      if (semantic) {
        test("a nonfatal semantic DOWN rejection leaves the viewer usable", async () => {
          const h = await harness(semantic, video);
          try {
            const viewer = h.viewer();
            h.rejectNext("down");
            viewer.touch("down");
            await h.settle();
            expect(viewer.messages.at(-1)).toMatchObject({ ok: false });
            expect(h.queue.snapshot().reservedReleases).toBe(0);
            viewer.touch("down");
            viewer.touch("up");
            await h.settle();
            expect((await h.recorded()).events).toHaveLength(2);
            expect(h.queue.snapshot()).toMatchObject({ closed: false, reservedReleases: 0 });
          } finally {
            await h.stop();
          }
        });

        test("a rejected semantic UP is retried by viewer disconnect cleanup", async () => {
          const h = await harness(semantic, video);
          try {
            const viewer = h.viewer();
            viewer.touch("down");
            await h.settle();
            h.rejectNext("up");
            viewer.touch("up");
            await h.settle();
            expect(viewer.messages.at(-1)).toMatchObject({ ok: false });
            viewer.close();
            await h.settle();
            expect(h.touches.map((t) => t.action)).toEqual(["down", "up", "up"]);
            expect((await h.recorded()).events.at(-1)).toMatchObject({
              source: "ws:disconnect",
              gesture: { action: "up" },
            });
            expect(h.queue.snapshot()).toMatchObject({ closed: false, reservedReleases: 0 });
          } finally {
            await h.stop();
          }
        });
      }

      test("queues disconnect release after an admitted down before it completes", async () => {
        const h = await harness(semantic, video, 2);
        try {
          const viewer = h.viewer();
          await h.settle();
          h.blockNext();
          viewer.touch("down");
          // Allow DOWN to enter the writer, but leave its completion blocked.
          for (let i = 0; i < 20 && h.touches.length === 0; i++) await Promise.resolve();
          expect(h.touches).toHaveLength(1);
          expect(h.queue.snapshot()).toMatchObject({ depth: 1, reservedReleases: 1 });
          viewer.close();
          expect(h.queue.snapshot()).toMatchObject({ depth: 2, reservedReleases: 0 });
          h.release();
          await h.settle();
          expect(h.touches.map((touch) => touch.action)).toEqual(["down", "up"]);
        } finally {
          await h.stop();
        }
      });
    });
  }
}
