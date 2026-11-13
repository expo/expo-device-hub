import { describe, expect, test } from "bun:test";
import { ControlInputQueue } from "../src/control-input-queue.ts";
import type { Gesture } from "../src/input.ts";
import { startServer } from "../src/server.ts";
import type { EmuSession } from "../src/stream-session.ts";
import { readNoOrientation } from "./fixtures/orientation.ts";

type Fetch = (request: Request, server: unknown) => Promise<Response>;

async function standaloneServer() {
  const sent: Gesture[] = [];
  const controls = new ControlInputQueue({
    dispatcher: {
      async dispatchGesture(gesture: Gesture) {
        sent.push(gesture);
      },
      async resetVideo() {},
    },
  });
  let end!: (value: null) => void;
  const frames = new Promise<null>((resolve) => {
    end = resolve;
  });
  const session: EmuSession = {
    serial: "emulator-5554",
    mode: "grpc-screenshot",
    inputSource: "grpc",
    meta: { deviceName: "test", codecId: "h264", width: 720, height: 1280 },
    controls,
    readFrame: () => frames,
    onFatal: () => () => {},
    async close() {
      controls.close();
      end(null);
    },
  };
  let fetch: Fetch | null = null;
  const started = await startServer(
    { serial: "emulator-5554", port: 3300 },
    {
      readOrientation: readNoOrientation,
      openSession: async () => session,
      applyRotation: async () => ({
        mode: "lock",
        rotation: 0,
        orientation: "portrait",
        pose: "portrait",
        raw: "",
      }),
      serve: ((options: { fetch: Fetch }) => {
        fetch = options.fetch;
        return { port: 3300, stop() {} };
      }) as unknown as typeof Bun.serve,
    },
  );
  const request = (path: string, init?: RequestInit) => {
    if (!fetch) throw new Error("server fetch handler was not captured");
    return fetch(new Request(`http://127.0.0.1:3300${path}`, init), { upgrade: () => false });
  };
  const post = (path: string, body: unknown) =>
    request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  return { sent, request, post, stop: () => started.stop() };
}

describe("standalone server session events", () => {
  test("records actions and `record: false` input, and replay sends only the input", async () => {
    const server = await standaloneServer();
    try {
      expect((await server.post("/api/key", { key: "home" })).status).toBe(200);
      expect((await server.post("/api/key", { keycode: 46, record: false })).status).toBe(200);
      expect((await server.post("/api/orientation", { orientation: "sideways" })).status).toBe(400);
      expect((await server.post("/api/orientation", { orientation: "portrait" })).status).toBe(200);

      const page = (await (await server.request("/api/session?limit=2")).json()) as {
        session: { eventCount: number; newestEventId: number };
        events: unknown[];
      };
      expect(page.session).toMatchObject({ eventCount: 3, newestEventId: 3 });
      expect(page.events).toMatchObject([
        { id: 2, source: "rest:key", kind: "gesture", replay: false },
        {
          id: 3,
          source: "rest:orientation",
          kind: "action",
          replay: false,
          action: { type: "orientation", orientation: "portrait" },
        },
      ]);

      server.sent.length = 0;
      expect((await server.post("/api/session/replay", { multiplier: 100 })).status).toBe(200);
      const replayDone = async () => {
        const { session } = (await (await server.request("/api/session")).json()) as {
          session: { replaying: boolean; replayCompletedAt: string | null };
        };
        return !session.replaying && session.replayCompletedAt !== null;
      };
      for (let i = 0; i < 100 && !(await replayDone()); i++) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(await replayDone()).toBe(true);
      expect(server.sent.map((gesture) => gesture.type)).toEqual(["home"]);
    } finally {
      await server.stop();
    }
  });
});
