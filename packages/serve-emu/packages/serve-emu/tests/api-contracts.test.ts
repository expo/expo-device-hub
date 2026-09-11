import { describe, expect, test } from "bun:test";
import {
  API_ERROR_CODES,
  API_SUCCESS_PARSERS,
  isGrpcEncoder,
  isGrpcImageMode,
  isInputSource,
  isApiFailure,
  isStreamMode,
  parseApiFailure,
  parseApiResponse,
  parseDeviceGridResponse,
  parseHealthResponse,
  parseLogcatEventJson,
  parseStreamModeRequest,
  parseStreamModeResponse,
  type ApiPath,
  type ApiRequest,
  type ApiResponse,
} from "../src/shared/api-contracts.ts";

const routeSnapshot = {
  status: "running",
  waypointCount: 2,
  totalMeters: 100,
  progressMeters: 50,
  speedKph: 30,
  multiplier: 1,
  intervalMs: 1000,
  loop: false,
  startedAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:01.000Z",
  pausedAt: null,
  completedAt: null,
  lastError: null,
  currentLocation: null,
};

describe("API contracts", () => {
  test("recognizes only supported stream modes", () => {
    expect(isStreamMode("scrcpy")).toBe(true);
    expect(isStreamMode("grpc-screenshot")).toBe(true);
    expect(isStreamMode("screen-copy")).toBe(false);
    expect(isStreamMode(null)).toBe(false);
  });

  test("validates the shared stream mode request", () => {
    expect(parseStreamModeRequest({ mode: "grpc-screenshot" })).toEqual({
      mode: "grpc-screenshot",
    });
    expect(
      parseStreamModeRequest({
        mode: "grpc-screenshot",
        grpcImageMode: "mmap",
        inputSource: "scrcpy",
      }),
    ).toEqual({
      mode: "grpc-screenshot",
      grpcImageMode: "mmap",
      inputSource: "scrcpy",
    });
    expect(() => parseStreamModeRequest(null)).toThrow(
      "stream mode request must be an object",
    );
    expect(() => parseStreamModeRequest({ mode: "screen-copy" })).toThrow(
      "stream mode request.mode is invalid",
    );
    expect(() =>
      parseStreamModeRequest({ mode: "grpc-screenshot", grpcImageMode: "auto" })
    ).toThrow("stream mode request.grpcImageMode is invalid");
    expect(() =>
      parseStreamModeRequest({ mode: "scrcpy", grpcImageMode: "png" })
    ).toThrow("available only with mode grpc-screenshot");
    expect(() =>
      parseStreamModeRequest({ mode: "scrcpy", inputSource: "grpc" })
    ).toThrow("available only with mode grpc-screenshot");
  });

  test("validates strict gRPC encoder selection without changing omitted requests", () => {
    expect(isGrpcEncoder("software")).toBe(true);
    expect(isGrpcEncoder("hardware")).toBe(true);
    expect(isGrpcEncoder("auto")).toBe(false);
    expect(isGrpcEncoder(null)).toBe(false);
    expect(parseStreamModeRequest({ mode: "grpc-screenshot", encoder: "hardware" })).toEqual({
      mode: "grpc-screenshot", encoder: "hardware",
    });
    expect(() => parseStreamModeRequest({ mode: "grpc-screenshot", encoder: "auto" })).toThrow("encoder is invalid");
    expect(() => parseStreamModeRequest({ mode: "scrcpy", encoder: "software" })).toThrow("available only with mode grpc-screenshot");
  });

  test("parses hardware status and validates encoder availability and errors", () => {
    const status = {
      ok: true,
      serial: "emulator-5554",
      mode: "grpc-screenshot",
      grpcImageMode: "rgb888",
      inputSource: "grpc",
      availableInputSources: ["grpc", "scrcpy"],
      availableModes: ["grpc-screenshot", "scrcpy"],
      sessionGeneration: 1,
      encoder: "hardware",
      encoderName: "h264_videotoolbox",
      availableEncoders: ["software", "hardware"],
    };
    expect(parseStreamModeResponse(status)).toEqual(status);
    const failed = { ...status, encoderName: null, availableEncoders: ["software"], hardwareEncoderError: "GPU unavailable" };
    expect(parseStreamModeResponse(failed)).toEqual(failed);
    for (const patch of [
      { encoder: "auto" },
      { encoderName: 42 },
      { availableEncoders: "hardware" },
      { availableEncoders: [] },
      { availableEncoders: ["hardware"] },
      { availableEncoders: ["software", "software"] },
      { availableEncoders: ["software", "auto"] },
      { hardwareEncoderError: null },
    ]) {
      expect(() => parseStreamModeResponse({ ...status, ...patch })).toThrow();
    }
  });

  test("recognizes only explicit gRPC image modes", () => {
    expect(isGrpcImageMode("png")).toBe(true);
    expect(isGrpcImageMode("mmap")).toBe(true);
    expect(isGrpcImageMode("rgb888")).toBe(true);
    expect(parseStreamModeRequest({ mode: "grpc-screenshot", grpcImageMode: "rgb888" })).toEqual({
      mode: "grpc-screenshot", grpcImageMode: "rgb888",
    });
    expect(isGrpcImageMode("auto")).toBe(false);
    expect(isGrpcImageMode(null)).toBe(false);
  });

  test("recognizes only explicit input sources", () => {
    expect(isInputSource("scrcpy")).toBe(true);
    expect(isInputSource("grpc")).toBe(true);
    expect(isInputSource("adb")).toBe(false);
    expect(isInputSource(null)).toBe(false);
  });

  test("accepts every stable failure code and rejects drift", () => {
    for (const code of API_ERROR_CODES) {
      expect(parseApiFailure({ ok: false, error: { code, message: "safe" } })).toEqual({
        ok: false,
        error: { code, message: "safe" },
      });
    }
    expect(isApiFailure({ ok: false, error: { code: "bad_request", message: "old" } })).toBe(false);
    expect(() => parseApiFailure({ ok: false, error: "legacy" })).toThrow("invalid API failure");
  });

  test("validates required device-grid fields", () => {
    const response = parseDeviceGridResponse({
      ok: true,
      currentSerial: "emulator-5554",
      sessionStatus: "streaming",
      devices: [
        {
          id: "device:emulator-5554",
          kind: "emulator",
          serial: "emulator-5554",
          avd: "Pixel_8",
          name: "Pixel_8",
          state: "device",
          current: true,
          canSelect: true,
          canStart: false,
          canStop: true,
        },
      ],
    });
    expect(response.devices[0]?.current).toBe(true);
    expect(() => parseDeviceGridResponse({ ok: true, devices: [] })).toThrow("currentSerial");
  });

  test("validates stream mode availability and session identity", () => {
    const response = parseStreamModeResponse({
      ok: true,
      serial: "emulator-5554",
      mode: "grpc-screenshot",
      grpcImageMode: "mmap",
      inputSource: "scrcpy",
      availableInputSources: ["scrcpy", "grpc"],
      availableModes: ["scrcpy", "grpc-screenshot"],
      sessionGeneration: 7,
    });
    expect(response).toEqual({
      ok: true,
      serial: "emulator-5554",
      mode: "grpc-screenshot",
      encoder: "software",
      encoderName: null,
      availableEncoders: ["software"],
      grpcImageMode: "mmap",
      inputSource: "scrcpy",
      availableInputSources: ["scrcpy", "grpc"],
      availableModes: ["scrcpy", "grpc-screenshot"],
      sessionGeneration: 7,
    });
    expect(() =>
      parseStreamModeResponse({
        ...response,
        mode: "screen-copy",
      }),
    ).toThrow("mode");
    expect(() =>
      parseStreamModeResponse({
        ...response,
        grpcImageMode: "auto",
      }),
    ).toThrow("grpcImageMode");
    expect(() =>
      parseStreamModeResponse({
        ...response,
        availableModes: ["scrcpy"],
      }),
    ).toThrow("must be available");
    expect(() =>
      parseStreamModeResponse({
        ...response,
        sessionGeneration: -1,
      }),
    ).toThrow("non-negative safe integer");
  });

  test("the endpoint parser registry validates mutations and failures", () => {
    expect(parseApiResponse("/api/apps/launch", "POST", { ok: true, output: "started" })).toEqual({
      ok: true,
      output: "started",
    });
    expect(parseApiResponse("/api/route", "POST", { ok: true, route: routeSnapshot })).toEqual({
      ok: true,
      route: routeSnapshot,
    });
    expect(
      parseApiResponse("/api/network", "GET", {
        ok: false,
        error: { code: "downstream_failure", message: "adb unavailable" },
      }),
    ).toEqual({
      ok: false,
      error: { code: "downstream_failure", message: "adb unavailable" },
    });
    expect(() => parseApiResponse("/api/apps/launch", "POST", { ok: true })).toThrow("output");
  });

  test("request/response lookup types stay endpoint-specific", () => {
    const request: ApiRequest<"/api/location", "POST"> = {
      latitude: 51.5072,
      longitude: -0.1276,
    };
    const response: ApiResponse<"/api/tap", "POST"> = { ok: true };
    const paths: Record<ApiPath, true> = Object.fromEntries(
      Object.keys(API_SUCCESS_PARSERS).map((path) => [path, true]),
    ) as Record<ApiPath, true>;
    expect(request.latitude).toBe(51.5072);
    expect(response.ok).toBe(true);
    expect(Object.keys(paths).length).toBe(45);
  });

  test("validates health and logcat network boundaries without casts", () => {
    const session = {
      events: [],
      recording: true,
      replaying: false,
      replayStartedAt: null,
      replayCompletedAt: null,
      lastError: null,
    };
    const health = {
      ok: true,
      status: "streaming",
      serial: "emulator-5554",
      device: "Pixel",
      streamMode: "grpc-screenshot",
      codec: "h264",
      size: { width: 1080, height: 1920 },
      clients: 0,
      frames: 1,
      sourceFps: 1,
      frameStats: null,
      configPackets: 1,
      droppedFrames: 0,
      backpressureEvents: 0,
      videoResetRequests: 0,
      lastVideoResetAt: null,
      lastVideoResetReason: null,
      location: null,
      route: { ...routeSnapshot, status: "idle" },
      session,
      clientsDetail: [],
      startedAt: "2026-01-01T00:00:00.000Z",
      stoppedAt: null,
      lastFrameAt: "2026-01-01T00:00:01.000Z",
      lastError: null,
      lastErrorCode: null,
      lastErrorMeta: null,
      sessionGeneration: 4,
    };

    expect(parseHealthResponse(health)).toMatchObject({
      streamMode: "grpc-screenshot",
      sessionGeneration: 4,
    });
    expect(() => parseHealthResponse({ ...health, clientsDetail: [{}] })).toThrow(
      "clientsDetail[0].id",
    );
    expect(() => parseHealthResponse({ ...health, sessionGeneration: -1 })).toThrow(
      "non-negative safe integer",
    );
    expect(
      parseLogcatEventJson(
        "log",
        JSON.stringify({ line: "Activity started", at: health.startedAt }),
      ),
    ).toEqual({ line: "Activity started", at: health.startedAt });
    expect(() => parseLogcatEventJson("ready", '{"pids":[1]}')).toThrow(
      "serial",
    );
  });
});
