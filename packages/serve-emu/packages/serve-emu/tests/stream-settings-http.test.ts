import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import { createApp } from "../src/middleware.ts";
import {
  SCRCPY_DEFAULTS,
  type ScrcpySession,
  type StartOpts,
} from "../src/scrcpy.ts";
import type { StreamSocket } from "../src/stream-socket.ts";

type CapturedStartOpts = StartOpts & {
  mode?: "scrcpy";
  grpcImageMode?: "png" | "mmap";
  inputSource?: "scrcpy" | "grpc";
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function streamSettingsPatch(
  body: unknown,
  contentType: string | null = "application/json",
): Request {
  const headers = new Headers();
  if (contentType) headers.set("Content-Type", contentType);
  return new Request("http://localhost/api/stream-settings", {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
  });
}

class TestStreamSocket implements StreamSocket {
  readonly sent: (string | Uint8Array)[] = [];
  readonly closes: { code?: number; reason?: string }[] = [];
  bufferedAmount = 0;
  private messageHandler: ((text: string) => void) | null = null;
  private closeHandler: (() => void) | null = null;

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
    this.closeHandler?.();
  }

  onMessage(handler: (text: string) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  receive(message: string): void {
    this.messageHandler?.(message);
  }
}

function fakeSession(
  size: { width: number; height: number } = { width: 1080, height: 1920 },
  onControlWrite?: (data: string | Uint8Array) => void,
): ScrcpySession {
  const proc = new EventEmitter();
  const controlSocket = Object.assign(new EventEmitter(), {
    writable: true,
    write: (data: string | Uint8Array) => {
      onControlWrite?.(data);
      return true;
    },
  });

  return {
    transport: "scrcpy",
    meta: {
      deviceName: "Pixel Test",
      codecId: "h264",
      width: size.width,
      height: size.height,
    },
    protocol: 4,
    videoReader: {} as ScrcpySession["videoReader"],
    controlSocket: controlSocket as unknown as ScrcpySession["controlSocket"],
    proc: proc as ScrcpySession["proc"],
    scid: "00000001",
    localPort: 27_200,
    serial: "emulator-test",
    readFrame: () => new Promise(() => {}),
    close: async () => {},
  };
}

describe("stream settings HTTP API", () => {
  test("uses the middleware encoder defaults when options are omitted", async () => {
    const starts: CapturedStartOpts[] = [];
    const app = await createApp(
      { serial: "emulator-test" },
      {
        startScrcpy: async (options: StartOpts) => {
          starts.push(options);
          return fakeSession();
        },
      },
    );

    try {
      const response = await app.handleRequest(
        new Request("http://localhost/api/stream-settings"),
      );

      expect(await response.json()).toEqual({
        ok: true,
        maxDimension: SCRCPY_DEFAULTS.maxSize,
        h264Bitrate: SCRCPY_DEFAULTS.bitRate,
        h264Fps: 30,
      });
      expect(starts[0]).toMatchObject({
        maxSize: SCRCPY_DEFAULTS.maxSize,
        bitRate: SCRCPY_DEFAULTS.bitRate,
        maxFps: 30,
      });
    } finally {
      await app.stop();
    }
  });

  test("GET /api/stream-settings reports the active scrcpy encoder settings", async () => {
    const starts: CapturedStartOpts[] = [];
    const app = await createApp(
      {
        serial: "emulator-test",
        maxSize: 960,
        bitRate: 4_000_000,
        maxFps: 24,
      },
      {
        startScrcpy: async (options: StartOpts) => {
          starts.push(options);
          return fakeSession();
        },
      },
    );

    try {
      const response = await app.handleRequest(
        new Request("http://localhost/api/stream-settings"),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: true,
        maxDimension: 960,
        h264Bitrate: 4_000_000,
        h264Fps: 24,
      });
      expect(starts).toHaveLength(1);
      expect(starts[0]).toEqual({
        serial: "emulator-test",
        signal: undefined,
        maxSize: 960,
        bitRate: 4_000_000,
        maxFps: 24,
        keyFrameInterval: undefined,
        mode: "scrcpy",
        grpcImageMode: "png",
        inputSource: "scrcpy",
      });
      expect(app.health().encoderSettings).toEqual({
        maxDimension: 960,
        h264Bitrate: 4_000_000,
        h264Fps: 24,
      });
    } finally {
      await app.stop();
    }
  });

  test("PATCH /api/stream-settings replaces capture and reports its authoritative settings", async () => {
    const starts: CapturedStartOpts[] = [];
    const app = await createApp(
      { serial: "emulator-test" },
      {
        startScrcpy: async (options: StartOpts) => {
          starts.push(options);
          return fakeSession(
            options.maxSize === 720
              ? { width: 405, height: 720 }
              : { width: 1080, height: 1920 },
          );
        },
      },
    );
    const initialSession = app.session;

    try {
      const response = await app.handleRequest(
        streamSettingsPatch({
          maxDimension: 720,
          h264Bitrate: 3_000_000,
          h264Fps: 20,
        }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: true,
        maxDimension: 720,
        h264Bitrate: 3_000_000,
        h264Fps: 20,
      });

      const status = await app.handleRequest(new Request("http://localhost/api"));
      expect((await status.json()).size).toEqual({ width: 405, height: 720 });
      expect(app.session).not.toBe(initialSession);
      expect(app.session.meta).toMatchObject({ width: 405, height: 720 });
      expect(app.health().encoderSettings).toEqual({
        maxDimension: 720,
        h264Bitrate: 3_000_000,
        h264Fps: 20,
      });
      expect(starts[1]).toEqual({
        serial: "emulator-test",
        signal: expect.any(AbortSignal),
        maxSize: 720,
        bitRate: 3_000_000,
        maxFps: 20,
        keyFrameInterval: undefined,
        mode: "scrcpy",
        grpcImageMode: "png",
        inputSource: "scrcpy",
      });
    } finally {
      app.stop();
    }
  });

  test("an attached WebSocket client survives capture replacement and receives the new video session", async () => {
    const replacementControlWrites: Buffer[] = [];
    const app = await createApp(
      { serial: "emulator-test" },
      {
        startScrcpy: async (options: StartOpts) =>
          fakeSession(
            options.maxSize === 720
              ? { width: 405, height: 720 }
              : { width: 1080, height: 1920 },
            options.maxSize === 720
              ? (data) => replacementControlWrites.push(Buffer.from(data))
              : undefined,
          ),
      },
    );
    const socket = new TestStreamSocket();
    app.attachWebSocket(socket, { frameMeta: false });

    try {
      const response = await app.handleRequest(
        streamSettingsPatch({ maxDimension: 720 }),
      );

      expect(response.status).toBe(200);
      expect(socket.closes).toEqual([]);
      expect(
        socket.sent
          .filter((message): message is string => typeof message === "string")
          .map((message) => JSON.parse(message)),
      ).toContainEqual({
        type: "video-session",
        size: { width: 405, height: 720 },
      });
      expect(replacementControlWrites).toContainEqual(Buffer.from([17]));
    } finally {
      app.stop();
    }
  });

  test("PATCH rejects unknown, non-integer, and out-of-range settings without changing capture", async () => {
    let starts = 0;
    const app = await createApp(
      { serial: "emulator-test" },
      {
        startScrcpy: async () => {
          starts++;
          return fakeSession();
        },
      },
    );

    try {
      for (const patch of [
        { maxDimension: 4_097 },
        { h264Bitrate: 99_999 },
        { h264Fps: 24.5 },
        { resolution: 720 },
        { "": 1 },
      ]) {
        const response = await app.handleRequest(
          streamSettingsPatch(patch),
        );

        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          ok: false,
          error: "invalid_stream_settings",
        });
      }

      const settings = await app.handleRequest(
        new Request("http://localhost/api/stream-settings"),
      );
      expect(await settings.json()).toEqual({
        ok: true,
        maxDimension: 1280,
        h264Bitrate: 8_000_000,
        h264Fps: 30,
      });
      expect(starts).toBe(1);
    } finally {
      app.stop();
    }
  });

  test("PATCH requires an application/json body", async () => {
    const app = await createApp(
      { serial: "emulator-test" },
      { startScrcpy: async () => fakeSession() },
    );

    try {
      const response = await app.handleRequest(
        streamSettingsPatch({ maxDimension: 720 }, null),
      );

      expect(response.status).toBe(415);
      expect(await response.json()).toEqual({
        ok: false,
        error: "unsupported_media_type",
      });
    } finally {
      app.stop();
    }
  });

  test("a failed replacement rolls capture back to the previous authoritative settings", async () => {
    let starts = 0;
    const app = await createApp(
      { serial: "emulator-test", maxSize: 960 },
      {
        startScrcpy: async (options: StartOpts) => {
          starts++;
          if (options.maxSize === 720) throw new Error("encoder rejected requested size");
          return fakeSession({ width: 540, height: 960 });
        },
      },
    );

    try {
      const response = await app.handleRequest(
        streamSettingsPatch({ maxDimension: 720 }),
      );

      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: "stream_settings_failed",
      });

      const settings = await app.handleRequest(
        new Request("http://localhost/api/stream-settings"),
      );
      expect(await settings.json()).toEqual({
        ok: true,
        maxDimension: 960,
        h264Bitrate: 8_000_000,
        h264Fps: 30,
      });
      const health = await app.handleRequest(new Request("http://localhost/health"));
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({
        size: { width: 540, height: 960 },
        encoderSettings: {
          maxDimension: 960,
          h264Bitrate: SCRCPY_DEFAULTS.bitRate,
          h264Fps: 30,
        },
      });
      expect(starts).toBe(3);
    } finally {
      app.stop();
    }
  });

  test("a failed replacement and rollback remains an internal failure", async () => {
    let starts = 0;
    const app = await createApp(
      { serial: "emulator-test" },
      {
        startScrcpy: async () => {
          starts++;
          if (starts > 1) throw new Error(`capture start ${starts} failed`);
          return fakeSession();
        },
      },
    );

    try {
      const response = await app.handleRequest(
        streamSettingsPatch({ maxDimension: 720 }),
      );

      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: "stream_settings_failed",
      });
      expect(app.health().status).toBe("error");
    } finally {
      await app.stop();
    }
  });

  test("exit and socket errors from the replaced generation cannot terminate the new capture", async () => {
    let starts = 0;
    const app = await createApp(
      { serial: "emulator-test" },
      {
        startScrcpy: async (options: StartOpts) => {
          starts++;
          const capture = fakeSession(
            options.maxSize === 720
              ? { width: 405, height: 720 }
              : { width: 1080, height: 1920 },
          );
          if (starts === 1) {
            capture.close = async () => {
              capture.proc.emit("exit", 0, null);
              capture.controlSocket.emit("error", new Error("stale control error"));
            };
          }
          return capture;
        },
      },
    );

    try {
      const response = await app.handleRequest(
        streamSettingsPatch({ maxDimension: 720 }),
      );

      expect(response.status).toBe(200);
      const health = await app.handleRequest(new Request("http://localhost/health"));
      expect(health.status).toBe(200);
      expect((await health.json()).size).toEqual({ width: 405, height: 720 });
    } finally {
      app.stop();
    }
  });

  test("concurrent PATCH requests serialize capture restarts", async () => {
    const firstReplacement = deferred<ScrcpySession>();
    const firstReplacementStarted = deferred<void>();
    let starts = 0;
    const app = await createApp(
      { serial: "emulator-test" },
      {
        startScrcpy: async (options: StartOpts) => {
          starts++;
          if (starts === 1) return fakeSession();
          if (starts === 2) {
            firstReplacementStarted.resolve();
            return firstReplacement.promise;
          }
          return fakeSession(
            options.maxSize === 960
              ? { width: 540, height: 960 }
              : { width: 405, height: 720 },
          );
        },
      },
    );

    try {
      const firstPatch = app.handleRequest(
        streamSettingsPatch({ maxDimension: 720 }),
      );
      await firstReplacementStarted.promise;
      const secondPatch = app.handleRequest(
        streamSettingsPatch({ maxDimension: 960 }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(starts).toBe(2);
      firstReplacement.resolve(fakeSession({ width: 405, height: 720 }));

      expect(await (await firstPatch).json()).toEqual({
        ok: true,
        maxDimension: 720,
        h264Bitrate: 8_000_000,
        h264Fps: 30,
      });
      expect(await (await secondPatch).json()).toEqual({
        ok: true,
        maxDimension: 960,
        h264Bitrate: 8_000_000,
        h264Fps: 30,
      });
      expect(starts).toBe(3);
    } finally {
      app.stop();
    }
  });

  test("PATCH returns a conflict while session replay is active", async () => {
    let starts = 0;
    const app = await createApp(
      { serial: "emulator-test" },
      {
        startScrcpy: async () => {
          starts++;
          return fakeSession();
        },
      },
    );
    const replayGate = deferred<void>();
    app.deviceState.recorder.recordGesture(
      { type: "tap", x: 0.5, y: 0.5 },
      "test",
    );
    const replay = app.deviceState.recorder.startReplay({
      dispatchGesture: () => replayGate.promise,
      setLocation: () => {},
    });

    try {
      await Promise.resolve();
      expect(app.deviceState.recorder.isReplaying).toBe(true);

      const response = await app.handleRequest(
        streamSettingsPatch({ maxDimension: 720 }),
      );

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        ok: false,
        error: "stream_settings_conflict",
        message: "cannot update stream settings while session replay is running",
      });
      expect(starts).toBe(1);
    } finally {
      replayGate.resolve();
      await replay.completion;
      await app.stop();
    }
  });

  test("session replay returns a conflict while capture replacement is active", async () => {
    const replacement = deferred<ScrcpySession>();
    const replacementStarted = deferred<void>();
    let starts = 0;
    const app = await createApp(
      { serial: "emulator-test" },
      {
        startScrcpy: async () => {
          starts++;
          if (starts === 1) return fakeSession();
          replacementStarted.resolve();
          return replacement.promise;
        },
      },
    );
    app.deviceState.recorder.recordGesture(
      { type: "tap", x: 0.5, y: 0.5 },
      "test",
    );

    const patch = app.handleRequest(
      streamSettingsPatch({ maxDimension: 720 }),
    );
    await replacementStarted.promise;

    try {
      const response = await app.handleRequest(
        new Request("http://localhost/api/session/replay", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ multiplier: 1 }),
        }),
      );

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        ok: false,
        error: "cannot start session replay while video capture is restarting",
      });
      expect(app.deviceState.recorder.isReplaying).toBe(false);

      replacement.resolve(fakeSession({ width: 405, height: 720 }));
      expect((await patch).status).toBe(200);
    } finally {
      replacement.resolve(fakeSession({ width: 405, height: 720 }));
      await patch;
      await app.stop();
    }
  });

  test("input is rejected while the old control socket is closed for replacement", async () => {
    const replacement = deferred<ScrcpySession>();
    const replacementStarted = deferred<void>();
    let starts = 0;
    let oldControlWrites = 0;
    const app = await createApp(
      { serial: "emulator-test" },
      {
        startScrcpy: async () => {
          starts++;
          if (starts === 1) {
            const initial = fakeSession();
            initial.controlSocket.write = () => {
              oldControlWrites++;
              return true;
            };
            return initial;
          }
          replacementStarted.resolve();
          return replacement.promise;
        },
      },
    );
    const socket = new TestStreamSocket();
    app.attachWebSocket(socket, { frameMeta: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const writesBeforeRestart = oldControlWrites;

    const patch = app.handleRequest(
      streamSettingsPatch({ maxDimension: 720 }),
    );
    await replacementStarted.promise;
    socket.receive(JSON.stringify({ type: "tap", x: 0.5, y: 0.5 }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(oldControlWrites).toBe(writesBeforeRestart);
    expect(
      socket.sent
        .filter((message): message is string => typeof message === "string")
        .map((message) => JSON.parse(message)),
    ).toContainEqual({ ok: false, error: "Error: video capture is restarting" });

    replacement.resolve(fakeSession({ width: 405, height: 720 }));
    expect((await patch).status).toBe(200);
    await app.stop();
  });

  test("input already in flight is not acknowledged or recorded after capture changes", async () => {
    const app = await createApp(
      { serial: "emulator-test" },
      {
        startScrcpy: async (options: StartOpts) =>
          fakeSession(
            options.maxSize === 720
              ? { width: 405, height: 720 }
              : { width: 1080, height: 1920 },
          ),
      },
    );
    const socket = new TestStreamSocket();
    app.attachWebSocket(socket, { frameMeta: false });

    try {
      socket.receive(JSON.stringify({ type: "tap", x: 0.5, y: 0.5 }));
      const response = await app.handleRequest(
        streamSettingsPatch({ maxDimension: 720 }),
      );
      expect(response.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 30));

      const messages = socket.sent
        .filter((message): message is string => typeof message === "string")
        .map((message) => JSON.parse(message));
      expect(messages).toContainEqual({
        ok: false,
        error: "Error: video capture restarted during input",
      });
      expect(messages).not.toContainEqual({ ok: true });
      const session = await app.handleRequest(new Request("http://localhost/api/session"));
      expect((await session.json()).events).toEqual([]);
    } finally {
      app.stop();
    }
  });

  test("stopping during replacement closes a late capture instead of activating it", async () => {
    const replacement = deferred<ScrcpySession>();
    const replacementStarted = deferred<void>();
    let starts = 0;
    const app = await createApp(
      { serial: "emulator-test" },
      {
        startScrcpy: async () => {
          starts++;
          if (starts === 1) return fakeSession();
          replacementStarted.resolve();
          return replacement.promise;
        },
      },
    );

    const patch = app.handleRequest(
      streamSettingsPatch({ maxDimension: 720 }),
    );
    await replacementStarted.promise;
    let stopSettled = false;
    const stopping = app.stop().then(() => {
      stopSettled = true;
    });
    await Promise.resolve();
    expect(stopSettled).toBe(false);
    let closed = 0;
    const lateCapture = fakeSession({ width: 405, height: 720 });
    lateCapture.close = async () => {
      closed++;
    };
    replacement.resolve(lateCapture);

    const response = await patch;
    await stopping;
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: "stream_settings_unavailable",
    });
    expect(closed).toBe(1);
    expect(app.isStreaming()).toBe(false);
    expect(app.health().captureRestarting).toBe(false);
  });

  test("PATCH returns service unavailable after the app has stopped", async () => {
    const app = await createApp(
      { serial: "emulator-test" },
      { startScrcpy: async () => fakeSession() },
    );
    await app.stop();

    const response = await app.handleRequest(
      streamSettingsPatch({ maxDimension: 720 }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      error: "stream_settings_unavailable",
      message: "session is stopped",
    });
  });

  test("PATCH rejects a foreign browser origin without restarting capture", async () => {
    let starts = 0;
    const app = await createApp(
      { serial: "emulator-test" },
      {
        startScrcpy: async () => {
          starts++;
          return fakeSession();
        },
      },
    );

    try {
      const response = await app.handleRequest(
        new Request("http://localhost/api/stream-settings", {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://evil.example",
          },
          body: JSON.stringify({ maxDimension: 720 }),
        }),
      );

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        ok: false,
        error: "forbidden_origin",
      });
      expect(starts).toBe(1);
    } finally {
      await app.stop();
    }
  });

  test("device control handlers preserve request body transport errors", async () => {
    const app = await createApp(
      { serial: "emulator-test" },
      { startScrcpy: async () => fakeSession() },
    );

    try {
      const oversized = await app.handleRequest(
        new Request("http://localhost/api/font-scale", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scale: "x".repeat(9_000) }),
        }),
      );
      expect(oversized.status).toBe(413);
      expect(await oversized.json()).toEqual({
        ok: false,
        error: "payload-too-large",
      });

      const controller = new AbortController();
      controller.abort(new Error("test abort"));
      const aborted = await app.handleRequest(
        new Request("http://localhost/api/network", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: true }),
          signal: controller.signal,
        }),
      );
      expect(aborted.status).toBe(499);
      expect(await aborted.json()).toEqual({
        ok: false,
        error: "request-aborted",
      });
    } finally {
      await app.stop();
    }
  });

  test("font scale rejects values that require numeric coercion", async () => {
    const app = await createApp(
      { serial: "emulator-test" },
      { startScrcpy: async () => fakeSession() },
    );

    try {
      for (const scale of [true, "1.5", [1.2]]) {
        const response = await app.handleRequest(
          new Request("http://localhost/api/font-scale", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ scale }),
          }),
        );
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          ok: false,
          error: "scale must be a number between 0.7 and 2.0",
        });
      }
    } finally {
      await app.stop();
    }
  });

  test("stopping during rollback closes a late rollback capture", async () => {
    const rollback = deferred<ScrcpySession>();
    const rollbackStarted = deferred<void>();
    let starts = 0;
    const app = await createApp(
      { serial: "emulator-test" },
      {
        startScrcpy: async () => {
          starts++;
          if (starts === 1) return fakeSession();
          if (starts === 2) throw new Error("replacement failed");
          rollbackStarted.resolve();
          return rollback.promise;
        },
      },
    );

    const patch = app.handleRequest(
      streamSettingsPatch({ maxDimension: 720 }),
    );
    await rollbackStarted.promise;
    app.stop();
    let closed = 0;
    const lateRollback = fakeSession();
    lateRollback.close = async () => {
      closed++;
    };
    rollback.resolve(lateRollback);

    const response = await patch;
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: "stream_settings_unavailable",
    });
    expect(closed).toBe(1);
    expect(app.isStreaming()).toBe(false);
    expect(app.health().captureRestarting).toBe(false);
  });
});
