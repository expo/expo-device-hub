import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ControlInputQueue } from "../src/control-input-queue.ts";
import type { Gesture } from "../src/input.ts";
import { createApp, type EmuApp } from "../src/middleware.ts";
import { readNoOrientation } from "./fixtures/orientation.ts";

type Json = Record<string, unknown>;

/** The state eas-cli's idle check reads: the newest event and the replay state. */
function activityState(body: Json) {
  const events = body.events as { id: number; at: string }[];
  const replay = (body.session ?? body) as { replaying?: unknown; replayStartedAt?: unknown };
  return {
    latestEventKey: events.length ? `${events.at(-1)!.id}@${events.at(-1)!.at}` : undefined,
    replaying: replay.replaying === true,
    replayStartedAt: typeof replay.replayStartedAt === "string" ? replay.replayStartedAt : null,
  };
}

describe("middleware GET /api/session", () => {
  let app: EmuApp;
  let releaseDispatch: (() => void) | null;
  let holdDispatch: boolean;

  beforeEach(async () => {
    releaseDispatch = null;
    holdDispatch = false;
    const controls = new ControlInputQueue({
      dispatcher: {
        async dispatchGesture(_gesture: Gesture) {
          if (!holdDispatch) return;
          await new Promise<void>((resolve) => {
            releaseDispatch = resolve;
          });
        },
        async resetVideo() {},
      },
    });
    let end!: (value: null) => void;
    const frames = new Promise<null>((resolve) => {
      end = resolve;
    });
    app = await createApp(
      { serial: "emulator-5554", streamMode: "grpc-screenshot", inputSource: "grpc" },
      {
        startSession: async () => ({
          serial: "emulator-5554",
          mode: "grpc-screenshot",
          inputSource: "grpc",
          meta: { deviceName: "test", codecId: "h264", width: 576, height: 1280 },
          controls,
          readFrame: () => frames,
          onFatal: () => () => {},
          async close() {
            controls.close();
            end(null);
          },
        }),
        clock: { now: () => 0, setInterval: () => 0, clearInterval: () => {} },
        readOrientation: readNoOrientation,
        applyRotation: async () => ({
          mode: "lock",
          rotation: 1,
          orientation: "landscape",
          pose: "landscape_left",
          raw: "",
        }),
      },
    );
  });

  afterEach(async () => {
    releaseDispatch?.();
    await app?.stop();
  });

  const post = (path: string, body: unknown) =>
    app.handleRequest(
      new Request(`http://hub.test${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const get = async (query = ""): Promise<{ status: number; body: Json }> => {
    const response = await app.handleRequest(new Request(`http://hub.test/api/session${query}`));
    return { status: response.status, body: (await response.json()) as Json };
  };

  async function recordFour() {
    for (const x of [0.1, 0.2, 0.3]) {
      expect((await post("/api/tap", { x, y: 0.5 })).status).toBe(200);
    }
    expect((await post("/api/orientation", { orientation: "landscape" })).status).toBe(200);
  }

  test("without paging parameters, returns the whole snapshot as before", async () => {
    await recordFour();
    for (const query of ["", "?device=emulator-5554"]) {
      const { status, body } = await get(query);
      expect(status).toBe(200);
      expect(Object.keys(body).sort()).toEqual([
        "events",
        "lastError",
        "recording",
        "replayCancelledAt",
        "replayCompletedAt",
        "replayStartedAt",
        "replayStatus",
        "replaying",
      ]);
      expect((body.events as { id: number }[]).map((event) => event.id)).toEqual([1, 2, 3, 4]);
    }
  });

  test("?limit=1 returns only the newest event, with the replay state at both levels", async () => {
    await recordFour();
    const { status, body } = await get("?limit=1");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      events: [{ id: 4, kind: "action", action: { type: "orientation" } }],
      recording: true,
      replaying: false,
      replayStatus: "idle",
      replayStartedAt: null,
      session: {
        eventCount: 4,
        newestEventId: 4,
        replaying: false,
        replayStartedAt: null,
      },
      nextBefore: 4,
      hasMore: true,
    });
  });

  test("before pages back to the oldest event", async () => {
    await recordFour();
    const page = await get("?limit=2&before=4&device=emulator-5554");
    expect(page.body).toMatchObject({ nextBefore: 2, hasMore: true });
    expect((page.body.events as { id: number }[]).map((event) => event.id)).toEqual([2, 3]);
    const oldest = await get("?before=2");
    expect(oldest.body).toMatchObject({ nextBefore: null, hasMore: false });
    expect((oldest.body.events as { id: number }[]).map((event) => event.id)).toEqual([1]);
  });

  test("rejects an invalid page query", async () => {
    for (const query of ["?limit=0", "?limit=abc", "?limit=201", "?before=0", "?limit="]) {
      const { status, body } = await get(query);
      expect(status).toBe(400);
      expect(body).toMatchObject({ ok: false });
    }
  });

  test("an idle reader sees new events and replays through ?limit=1", async () => {
    expect(activityState((await get("?limit=1")).body)).toEqual({
      latestEventKey: undefined,
      replaying: false,
      replayStartedAt: null,
    });
    await recordFour();
    const recorded = activityState((await get("?limit=1")).body);
    expect(recorded.latestEventKey).toMatch(/^4@/);

    holdDispatch = true;
    expect((await post("/api/session/replay", { multiplier: 100 })).status).toBe(200);
    for (let i = 0; i < 100 && !releaseDispatch; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const replaying = activityState((await get("?limit=1")).body);
    expect(replaying.replaying).toBe(true);
    expect(replaying.replayStartedAt).not.toBeNull();
    // The full snapshot, which the Hub client polls, agrees.
    expect(activityState((await get()).body)).toEqual(replaying);

    holdDispatch = false;
    releaseDispatch!();
    for (let i = 0; i < 100 && (await get("?limit=1")).body.replaying; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(activityState((await get("?limit=1")).body)).toEqual({
      ...replaying,
      replaying: false,
    });
  });
});
