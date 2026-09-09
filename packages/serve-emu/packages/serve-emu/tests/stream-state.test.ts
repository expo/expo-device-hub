import { describe, expect, test } from "bun:test";
import {
  INITIAL_STREAM_STATE,
  applyStreamHealth,
  applyWorkerEvent,
  parseStreamHealth,
  parseStreamWorkerEvent,
} from "../src/ui/lib/stream-state.ts";

describe("browser stream state", () => {
  test("worker events transition connection, session, and stats state", () => {
    const connecting = applyWorkerEvent(INITIAL_STREAM_STATE, {
      type: "status",
      status: "connecting",
    });
    const streaming = applyWorkerEvent(connecting, {
      type: "status",
      status: "streaming",
    });
    const sized = applyWorkerEvent(streaming, {
      type: "session",
      size: { width: 1080, height: 2400 },
    });
    const stats = {
      fps: 60,
      decodeQueue: 2,
      transitMs: 3.5,
      e2eMs: 8,
      codec: "avc1.640028",
      rendered: true,
    };
    expect(
      applyWorkerEvent(sized, { type: "stats", stats }),
    ).toEqual({
      status: "streaming",
      fps: 60,
      deviceSize: { width: 1080, height: 2400 },
      stats,
    });
  });

  test("health transitions waiting, recovery, and terminal states", () => {
    const size = { width: 720, height: 1280 };
    const waiting = applyStreamHealth(
      { ...INITIAL_STREAM_STATE, status: "connecting" },
      { size, status: "streaming", lastFrameAt: null },
      { nowMs: 10_000, hasRenderedFrame: false },
    );
    expect(waiting.status).toBe("waiting for video");
    const recovered = applyStreamHealth(
      waiting,
      { size, status: "streaming", lastFrameAt: new Date(9_900).toISOString() },
      { nowMs: 10_000, hasRenderedFrame: true },
    );
    expect(recovered.status).toBe("streaming");
    const terminal = applyStreamHealth(
      recovered,
      { size, status: "error", lastError: "scrcpy exited" },
      { nowMs: 10_000, hasRenderedFrame: true },
    );
    expect(terminal.status).toBe("scrcpy exited");
  });

  test("health parsing rejects malformed network data", () => {
    expect(parseStreamHealth({ size: { width: 1, height: 2 }, status: "streaming" }))
      .toEqual({ size: { width: 1, height: 2 }, status: "streaming" });
    expect(() => parseStreamHealth({ size: { width: "1", height: 2 } }))
      .toThrow("finite dimensions");
    expect(() => parseStreamHealth({ size: { width: 1, height: 2 }, status: "paused" }))
      .toThrow("health status is invalid");
  });

  test("worker parsing ignores unknown or malformed messages", () => {
    expect(parseStreamWorkerEvent({ type: "unknown" })).toBeNull();
    expect(
      parseStreamWorkerEvent({ type: "session", size: { width: "bad" } }),
    ).toBeNull();
    expect(
      parseStreamWorkerEvent({
        type: "stats",
        stats: {
          fps: 60,
          decodeQueue: 1,
          transitMs: null,
          e2eMs: 4,
          codec: "avc1.640028",
          rendered: true,
        },
      }),
    ).toMatchObject({ type: "stats", stats: { fps: 60 } });
  });
});
