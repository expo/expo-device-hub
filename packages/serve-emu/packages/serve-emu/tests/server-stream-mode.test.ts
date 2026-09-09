import { describe, expect, test } from "bun:test";
import { ControlInputQueue } from "../src/control-input-queue.ts";
import { SCRCPY_DEFAULTS } from "../src/scrcpy.ts";
import { GrpcCaptureDiagnosticsTracker } from "../src/grpc-session.ts";
import { startServer } from "../src/server.ts";
import type {
  GrpcImageMode,
  InputSource,
  StreamMode,
} from "../src/shared/api-contracts.ts";
import type {
  EmuSession,
  StartEmuSessionOptions,
} from "../src/stream-session.ts";

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fakeSession(
  serial: string,
  mode: StreamMode,
  grpcImageMode?: GrpcImageMode,
  inputSource: InputSource = "scrcpy",
) {
  const end = deferred<null>();
  let closeCalls = 0;
  const fatalListeners = new Set<
    Parameters<EmuSession["onFatal"]>[0]
  >();
  const controls = new ControlInputQueue({
    writer: { async write() {} },
  });
  const session: EmuSession = {
    mode,
    inputSource,
    serial,
    meta: {
      deviceName: `${mode}:${serial}`,
      codecId: "h264",
      width: 720,
      height: 1280,
    },
    controls,
    ...(grpcImageMode === undefined
      ? {}
      : {
          diagnostics: () => ({
            grpcCapture: new GrpcCaptureDiagnosticsTracker(
              grpcImageMode,
            ).snapshot(),
          }),
        }),
    readFrame: () => end.promise,
    onFatal(listener) {
      fatalListeners.add(listener);
      return () => fatalListeners.delete(listener);
    },
    async close() {
      closeCalls += 1;
      controls.close();
      end.resolve(null);
    },
  };
  return {
    session,
    closeCalls: () => closeCalls,
    fail(message: string) {
      for (const listener of fatalListeners) listener({ message });
    },
  };
}

type CapturedServer = {
  options: Record<string, unknown> | null;
};

function capturingServe(captured: CapturedServer): typeof Bun.serve {
  return ((options: Record<string, unknown>) => {
    captured.options = options;
    return { port: 3300, stop() {} };
  }) as unknown as typeof Bun.serve;
}

function request(
  captured: CapturedServer,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const fetch = captured.options?.fetch as
    | ((request: Request, server: unknown) => Promise<Response>)
    | undefined;
  if (!fetch) throw new Error("server fetch handler was not captured");
  return fetch(
    new Request(`http://127.0.0.1:3300${path}`, init),
    { upgrade: () => false },
  );
}

const putMode = (
  captured: CapturedServer,
  mode: StreamMode,
  grpcImageMode?: GrpcImageMode,
  inputSource?: InputSource,
): Promise<Response> =>
  request(captured, "/api/stream-mode", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode,
      ...(grpcImageMode === undefined ? {} : { grpcImageMode }),
      ...(inputSource === undefined ? {} : { inputSource }),
    }),
  });

const postJson = (
  captured: CapturedServer,
  path: string,
  body: Record<string, unknown>,
): Promise<Response> =>
  request(captured, path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const patchStreamSettings = (
  captured: CapturedServer,
  body: Record<string, unknown>,
): Promise<Response> =>
  request(captured, "/api/stream-settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("standalone server stream settings", () => {
  test("GET and PATCH report and apply the active encoder settings", async () => {
    const opens: StartEmuSessionOptions[] = [];
    const captured: CapturedServer = { options: null };
    const started = await startServer(
      { serial: "emulator-5554", port: 3300 },
      {
        openSession: async (options) => {
          opens.push(options);
          return fakeSession(options.serial, options.mode).session;
        },
        serve: capturingServe(captured),
      },
    );

    try {
      expect(
        await (await request(captured, "/api/stream-settings")).json(),
      ).toEqual({
        ok: true,
        maxDimension: SCRCPY_DEFAULTS.maxSize,
        h264Bitrate: SCRCPY_DEFAULTS.bitRate,
        h264Fps: SCRCPY_DEFAULTS.maxFps,
      });

      const response = await patchStreamSettings(captured, {
        maxDimension: 720,
        h264Bitrate: 3_000_000,
        h264Fps: 24,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: true,
        maxDimension: 720,
        h264Bitrate: 3_000_000,
        h264Fps: 24,
      });
      expect(opens[1]).toMatchObject({
        serial: "emulator-5554",
        mode: "scrcpy",
        maxSize: 720,
        bitRate: 3_000_000,
        maxFps: 24,
      });
      expect(await (await request(captured, "/health")).json()).toMatchObject({
        sessionGeneration: 1,
        encoderSettings: {
          maxDimension: 720,
          h264Bitrate: 3_000_000,
          h264Fps: 24,
        },
      });
    } finally {
      await started.stop();
    }
  });

  test("returns structured validation, method, and replacement errors", async () => {
    const captured: CapturedServer = { options: null };
    const started = await startServer(
      { serial: "emulator-5554", port: 3300 },
      {
        openSession: async (options) => {
          if (options.maxSize === 720) {
            throw new Error("encoder rejected requested size");
          }
          return fakeSession(options.serial, options.mode).session;
        },
        serve: capturingServe(captured),
      },
    );

    try {
      const method = await request(captured, "/api/stream-settings", {
        method: "POST",
      });
      expect(method.status).toBe(405);
      expect(method.headers.get("allow")).toBe("GET, PATCH");
      expect(await method.json()).toEqual({
        ok: false,
        error: "method_not_allowed",
      });

      const mediaType = await request(captured, "/api/stream-settings", {
        method: "PATCH",
        body: JSON.stringify({ maxDimension: 720 }),
      });
      expect(mediaType.status).toBe(415);
      expect(await mediaType.json()).toEqual({
        ok: false,
        error: "unsupported_media_type",
      });

      const validation = await patchStreamSettings(captured, {
        h264Fps: 0,
      });
      expect(validation.status).toBe(400);
      expect(await validation.json()).toMatchObject({
        ok: false,
        error: "invalid_stream_settings",
      });

      const failed = await patchStreamSettings(captured, {
        maxDimension: 720,
      });
      expect(failed.status).toBe(500);
      expect(await failed.json()).toMatchObject({
        ok: false,
        error: "stream_settings_failed",
        message: "encoder rejected requested size",
      });
      expect(
        await (await request(captured, "/api/stream-settings")).json(),
      ).toMatchObject({
        ok: true,
        maxDimension: SCRCPY_DEFAULTS.maxSize,
      });
    } finally {
      await started.stop();
    }
  });

  test("maps shutdown during replacement to service unavailable", async () => {
    const replacement = deferred<EmuSession>();
    const replacementStarted = deferred<void>();
    let opens = 0;
    const captured: CapturedServer = { options: null };
    const started = await startServer(
      { serial: "emulator-5554", port: 3300 },
      {
        openSession: async (options) => {
          opens += 1;
          if (opens === 1) {
            return fakeSession(options.serial, options.mode).session;
          }
          replacementStarted.resolve();
          return replacement.promise;
        },
        serve: capturingServe(captured),
      },
    );

    const patch = patchStreamSettings(captured, { maxDimension: 720 });
    await replacementStarted.promise;
    const stopping = started.stop();
    replacement.resolve(fakeSession("emulator-5554", "scrcpy").session);

    const response = await patch;
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: "stream_settings_unavailable",
    });
    await stopping;
  });
});

describe("server stream source switching", () => {
  test("uses the shared stream mode request validation", async () => {
    const initial = fakeSession("emulator-5554", "scrcpy");
    const captured: CapturedServer = { options: null };
    const started = await startServer(
      { serial: "emulator-5554", port: 3300 },
      {
        openSession: async () => initial.session,
        serve: capturingServe(captured),
      },
    );

    const response = await request(captured, "/api/stream-mode", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "screen-copy" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: {
        code: "invalid_request",
        message: "stream mode request.mode is invalid",
      },
    });

    await started.stop();
  });

  test("rejects an explicit initial gRPC source for a physical device", async () => {
    let openCalls = 0;
    await expect(
      startServer(
        {
          serial: "usb-device",
          port: 3300,
          streamMode: "grpc-screenshot",
        },
        {
          openSession: async () => {
            openCalls += 1;
            return fakeSession("usb-device", "scrcpy").session;
          },
          serve: capturingServe({ options: null }),
        },
      ),
    ).rejects.toThrow(
      "grpc-screenshot is available only for Android Emulator devices",
    );
    expect(openCalls).toBe(0);
  });

  test("passes the configured initial gRPC image mode to capture", async () => {
    const opened: Array<{
      mode: StreamMode;
      grpcImageMode: GrpcImageMode;
    }> = [];
    const capture = fakeSession(
      "emulator-5554",
      "grpc-screenshot",
      "mmap",
    );
    const captured: CapturedServer = { options: null };
    const started = await startServer(
      {
        serial: "emulator-5554",
        port: 3300,
        streamMode: "grpc-screenshot",
        grpcImageMode: "mmap",
      },
      {
        openSession: async ({ mode, grpcImageMode }) => {
          opened.push({ mode, grpcImageMode });
          return capture.session;
        },
        serve: capturingServe(captured),
      },
    );

    expect(opened).toEqual([
      { mode: "grpc-screenshot", grpcImageMode: "mmap" },
    ]);
    expect(
      await (await request(captured, "/api/stream-mode")).json(),
    ).toMatchObject({
      mode: "grpc-screenshot",
      grpcImageMode: "mmap",
    });
    expect(await (await request(captured, "/health")).json()).toMatchObject({
      streamMode: "grpc-screenshot",
      grpcImageMode: "mmap",
      grpcCapture: { imageMode: "mmap", usableImages: 0 },
    });
    await started.stop();
  });

  test("switches gRPC input atomically and preserves it through an encoder restart", async () => {
    const opened: Array<{
      mode: StreamMode;
      inputSource: InputSource;
      maxSize: number | undefined;
    }> = [];
    const captured: CapturedServer = { options: null };
    const started = await startServer(
      {
        serial: "emulator-5554",
        port: 3300,
        streamMode: "grpc-screenshot",
      },
      {
        openSession: async (options) => {
          opened.push({
            mode: options.mode,
            inputSource: options.inputSource,
            maxSize: options.maxSize,
          });
          return fakeSession(
            options.serial,
            options.mode,
            options.grpcImageMode,
            options.inputSource,
          ).session;
        },
        serve: capturingServe(captured),
      },
    );

    try {
      expect(
        await (await request(captured, "/api/stream-mode")).json(),
      ).toMatchObject({
        mode: "grpc-screenshot",
        inputSource: "scrcpy",
        sessionGeneration: 0,
      });

      const switched = await putMode(
        captured,
        "grpc-screenshot",
        undefined,
        "grpc",
      );
      expect(switched.status).toBe(200);
      expect(await switched.json()).toMatchObject({
        mode: "grpc-screenshot",
        inputSource: "grpc",
        sessionGeneration: 1,
      });

      const resized = await patchStreamSettings(captured, {
        maxDimension: 720,
      });
      expect(resized.status).toBe(200);
      expect(
        await (await request(captured, "/api/stream-mode")).json(),
      ).toMatchObject({
        mode: "grpc-screenshot",
        inputSource: "grpc",
        sessionGeneration: 2,
      });
      expect(opened).toEqual([
        {
          mode: "grpc-screenshot",
          inputSource: "scrcpy",
          maxSize: SCRCPY_DEFAULTS.maxSize,
        },
        {
          mode: "grpc-screenshot",
          inputSource: "grpc",
          maxSize: SCRCPY_DEFAULTS.maxSize,
        },
        {
          mode: "grpc-screenshot",
          inputSource: "grpc",
          maxSize: 720,
        },
      ]);
    } finally {
      await started.stop();
    }
  });

  test("stages, publishes, rolls back, and idempotently reports a source", async () => {
    const initial = fakeSession("emulator-5554", "scrcpy");
    const grpc = fakeSession("emulator-5554", "grpc-screenshot");
    const grpcGate = deferred<EmuSession>();
    const grpcStarted = deferred<void>();
    const modes: StreamMode[] = [];
    let failScrcpy = false;
    const captured: CapturedServer = { options: null };
    const started = await startServer(
      { serial: "emulator-5554", port: 3300 },
      {
        openSession: async ({ mode }) => {
          modes.push(mode);
          if (modes.length === 1) return initial.session;
          if (mode === "grpc-screenshot") {
            grpcStarted.resolve();
            return grpcGate.promise;
          }
          if (failScrcpy) throw new Error("replacement failed");
          return fakeSession("emulator-5554", mode).session;
        },
        serve: capturingServe(captured),
      },
    );

    expect(await (await request(captured, "/api/stream-mode")).json()).toEqual({
      ok: true,
      serial: "emulator-5554",
      mode: "scrcpy",
      grpcImageMode: "png",
      inputSource: "scrcpy",
      availableInputSources: ["scrcpy"],
      availableModes: ["scrcpy", "grpc-screenshot"],
      sessionGeneration: 0,
    });
    const methodNotAllowed = await request(captured, "/api/stream-mode", {
      method: "POST",
    });
    expect(methodNotAllowed.status).toBe(405);
    expect(methodNotAllowed.headers.get("allow")).toBe("GET, PUT");
    expect(await methodNotAllowed.json()).toEqual({
      ok: false,
      error: {
        code: "method_not_allowed",
        message: "Method must be GET or PUT",
      },
    });

    const switching = putMode(captured, "grpc-screenshot");
    await grpcStarted.promise;
    expect(initial.closeCalls()).toBe(0);
    expect(
      (await (await request(captured, "/api/stream-mode")).json()).mode,
    ).toBe("scrcpy");

    grpcGate.resolve(grpc.session);
    expect(await (await switching).json()).toMatchObject({
      mode: "grpc-screenshot",
      sessionGeneration: 1,
    });
    expect(initial.closeCalls()).toBe(1);

    const idempotent = await putMode(captured, "grpc-screenshot");
    expect(await idempotent.json()).toMatchObject({
      mode: "grpc-screenshot",
      sessionGeneration: 1,
    });
    expect(modes).toEqual(["scrcpy", "grpc-screenshot"]);

    failScrcpy = true;
    const failed = await putMode(captured, "scrcpy");
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({
      ok: false,
      error: {
        code: "service_unavailable",
        message: "replacement failed",
      },
    });
    expect(
      (await (await request(captured, "/api/stream-mode")).json()).mode,
    ).toBe("grpc-screenshot");
    expect(grpc.closeCalls()).toBe(0);

    await started.stop();
    expect(grpc.closeCalls()).toBe(1);
  });

  test("atomically applies an explicit gRPC image mode without fallback", async () => {
    const opened: Array<{
      mode: StreamMode;
      grpcImageMode: GrpcImageMode;
    }> = [];
    const captures = [
      fakeSession("emulator-5554", "scrcpy"),
      fakeSession("emulator-5554", "grpc-screenshot"),
      fakeSession("emulator-5554", "grpc-screenshot"),
    ];
    const captured: CapturedServer = { options: null };
    const started = await startServer(
      { serial: "emulator-5554", port: 3300 },
      {
        openSession: async ({ mode, grpcImageMode }) => {
          opened.push({ mode, grpcImageMode });
          const capture = captures[opened.length - 1];
          if (!capture) throw new Error("unexpected capture start");
          return capture.session;
        },
        serve: capturingServe(captured),
      },
    );

    const mmap = await putMode(
      captured,
      "grpc-screenshot",
      "mmap",
    );
    expect(mmap.status).toBe(200);
    expect(await mmap.json()).toMatchObject({
      mode: "grpc-screenshot",
      grpcImageMode: "mmap",
      sessionGeneration: 1,
    });

    const png = await putMode(captured, "grpc-screenshot", "png");
    expect(png.status).toBe(200);
    expect(await png.json()).toMatchObject({
      mode: "grpc-screenshot",
      grpcImageMode: "png",
      sessionGeneration: 2,
    });
    expect(opened).toEqual([
      { mode: "scrcpy", grpcImageMode: "png" },
      { mode: "grpc-screenshot", grpcImageMode: "mmap" },
      { mode: "grpc-screenshot", grpcImageMode: "png" },
    ]);
    expect(captures[0]?.closeCalls()).toBe(1);
    expect(captures[1]?.closeCalls()).toBe(1);

    const invalid = await request(captured, "/api/stream-mode", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "grpc-screenshot",
        grpcImageMode: "auto",
      }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      ok: false,
      error: {
        code: "invalid_request",
        message: "stream mode request.grpcImageMode is invalid",
      },
    });
    expect(opened).toHaveLength(3);

    await started.stop();
    expect(captures[2]?.closeCalls()).toBe(1);
  });

  test("reports the image mode paired with a newly published context while the old context drains", async () => {
    const initial = fakeSession("emulator-5554", "grpc-screenshot");
    const replacement = fakeSession("emulator-5554", "grpc-screenshot");
    const closeStarted = deferred<void>();
    const releaseClose = deferred<void>();
    const closeInitial = initial.session.close;
    initial.session.close = async () => {
      closeStarted.resolve();
      await releaseClose.promise;
      await closeInitial();
    };
    let openCount = 0;
    const captured: CapturedServer = { options: null };
    const started = await startServer(
      {
        serial: "emulator-5554",
        port: 3300,
        streamMode: "grpc-screenshot",
        grpcImageMode: "png",
      },
      {
        openSession: async () => {
          openCount += 1;
          return openCount === 1 ? initial.session : replacement.session;
        },
        serve: capturingServe(captured),
      },
    );

    const switching = putMode(captured, "grpc-screenshot", "mmap");
    await closeStarted.promise;
    try {
      expect(
        await (await request(captured, "/api/stream-mode")).json(),
      ).toMatchObject({
        mode: "grpc-screenshot",
        grpcImageMode: "mmap",
        sessionGeneration: 1,
      });
    } finally {
      releaseClose.resolve();
    }

    expect(await (await switching).json()).toMatchObject({
      grpcImageMode: "mmap",
      sessionGeneration: 1,
    });
    await started.stop();
  });

  test("preserves same-device recording, location, and active route state across a source switch", async () => {
    const initial = fakeSession("emulator-5554", "scrcpy");
    const grpc = fakeSession("emulator-5554", "grpc-screenshot");
    let openCount = 0;
    const captured: CapturedServer = { options: null };
    const started = await startServer(
      { serial: "emulator-5554", port: 3300 },
      {
        openSession: async () => {
          openCount += 1;
          return openCount === 1 ? initial.session : grpc.session;
        },
        setLocation: async () => {},
        serve: capturingServe(captured),
      },
    );

    expect(
      (
        await postJson(captured, "/api/tap", {
          x: 0.25,
          y: 0.75,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await postJson(captured, "/api/location", {
          latitude: 52.3676,
          longitude: 4.9041,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await postJson(captured, "/api/route", {
          waypoints: [
            { latitude: 52.3676, longitude: 4.9041 },
            { latitude: 52.52, longitude: 13.405 },
          ],
          speedKph: 1,
          intervalMs: 60_000,
          loop: true,
        })
      ).status,
    ).toBe(200);

    const before = (await (
      await request(captured, "/health")
    ).json()) as {
      location: unknown;
      route: { status: string };
      session: { eventCount: number };
    };
    expect(before.session.eventCount).toBe(2);
    expect(before.route.status).toBe("running");

    expect((await putMode(captured, "grpc-screenshot")).status).toBe(200);

    const after = (await (
      await request(captured, "/health")
    ).json()) as typeof before;
    expect(after.session.eventCount).toBe(2);
    expect(after.location).toEqual(before.location);
    expect(after.route.status).toBe("running");

    await started.stop();
  });

  test("creates fresh device state when switching after a terminal failure", async () => {
    const failed = fakeSession("emulator-5554", "scrcpy");
    const replacement = fakeSession("emulator-5554", "grpc-screenshot");
    let openCount = 0;
    const captured: CapturedServer = { options: null };
    const started = await startServer(
      { serial: "emulator-5554", port: 3300 },
      {
        openSession: async () =>
          openCount++ === 0 ? failed.session : replacement.session,
        serve: capturingServe(captured),
      },
    );

    failed.fail("capture process exited");
    expect((await (await request(captured, "/health")).json()).status).toBe(
      "error",
    );

    const response = await putMode(captured, "grpc-screenshot");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      mode: "grpc-screenshot",
      sessionGeneration: 1,
    });

    await started.stop();
  });

  test("retains device state when the old source fails during replacement startup", async () => {
    const initial = fakeSession("emulator-5554", "scrcpy");
    const replacement = fakeSession("emulator-5554", "grpc-screenshot");
    const replacementStart = deferred<EmuSession>();
    const replacementRequested = deferred<void>();
    let openCount = 0;
    const captured: CapturedServer = { options: null };
    const started = await startServer(
      { serial: "emulator-5554", port: 3300 },
      {
        openSession: async () => {
          openCount += 1;
          if (openCount === 1) return initial.session;
          replacementRequested.resolve(undefined);
          return replacementStart.promise;
        },
        serve: capturingServe(captured),
      },
    );

    const switching = putMode(captured, "grpc-screenshot");
    await replacementRequested.promise;
    initial.fail("capture process exited during replacement startup");
    replacementStart.resolve(replacement.session);

    const response = await switching;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      mode: "grpc-screenshot",
      sessionGeneration: 1,
    });

    await started.stop();
  });

  test("does not offer or start gRPC capture for a physical device", async () => {
    const physical = fakeSession("usb-device", "scrcpy");
    const captured: CapturedServer = { options: null };
    const started = await startServer(
      { serial: "usb-device", port: 3300 },
      {
        openSession: async () => physical.session,
        serve: capturingServe(captured),
      },
    );

    expect(await (await request(captured, "/api/stream-mode")).json()).toMatchObject({
      mode: "scrcpy",
      availableModes: ["scrcpy"],
    });
    const response = await putMode(captured, "grpc-screenshot");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: {
        code: "invalid_request",
        message:
          "grpc-screenshot is available only for Android Emulator devices",
      },
    });
    await started.stop();
  });
});
