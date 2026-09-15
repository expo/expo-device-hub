import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import {
  getFontWeight,
  getDisplayDensity,
  getFontScale,
  getHighTextContrast,
  getNetworkStatus,
  getReduceMotion,
  getSoftwareKeyboard,
  getUserRotation,
  listAllDevices,
  listDevices,
  screencapPng,
  setFontWeight,
  setDisplayDensity,
  setFontScale,
  setHighTextContrast,
  setNetworkEnabled,
  setReduceMotion,
  setSoftwareKeyboard,
  setUserRotation,
  type OrientationMode,
} from "./adb.ts";
import { getAccessibilitySnapshot } from "./accessibility.ts";
import {
  cameraLaunchIsWired,
  handleCameraRequest,
  isCameraPath,
  readCameraWiring,
} from "./camera.ts";
import {
  clearAppData,
  forceStopApp,
  grantPermission,
  launchApp,
  revokePermission,
  packageName,
} from "./app-management.ts";
import { listPermissions, resetPermissions } from "./app-permissions.ts";
import { getForegroundApp } from "./app-info.ts";
import { readAppIcon } from "./apk-icon.ts";
import {
  availableStreamModesForSerial,
  isEmulatorSerial,
} from "./device-capabilities.ts";
import { loadDeviceGrid } from "./device-grid.ts";
import { getHardwareEncoderError } from "./h264-encoder.ts";
import { FrameStatWindow } from "./frame-stat-window.ts";
import {
  listAvds,
  listRunningAvds,
  resolveRunningAvds,
  startEmulator,
  stopEmulator,
} from "./emulator.ts";
import { getNightMode, isNightMode, setNightMode } from "./ui-mode.ts";
import { DeviceSessionState } from "./device-session-state.ts";
import { parseGesture, type Gesture, type Screen } from "./input.ts";
import { parseGeoFix, setEmulatorLocationAsync, type GeoFix } from "./location.ts";
import { parseRoutePlaybackRequest } from "./route-playback.ts";
import type { StreamSocket } from "./stream-socket.ts";
import {
  DEFAULT_WEBRTC_STREAM_SETTINGS,
  DEFAULT_STREAM_SETTINGS,
  isJsonRequest,
  parseStreamEncoderSettingsPatch,
  redactedStreamSettings,
  StreamSettingsUnavailableError,
  streamEncoderSettingsEqual,
  viewerTransportsFor,
  type StreamEncoderSettings,
  type StreamEncoderSettingsPatch,
  type StreamSettings,
  type WebRtcStreamSettings,
} from "./stream-settings.ts";
import {
  corsHeadersForRequest,
  isAllowedBrowserOrigin,
  isAllowedMutationOrigin,
  type BrowserOriginPolicy,
} from "./origin-policy.ts";
import {
  MAX_WEBRTC_SIGNALING_BODY_BYTES,
  WebRtcSignalingError,
  parseWebRtcCloseRequest,
  parseWebRtcOffer,
} from "./webrtc-signaling.ts";
import { createWebRtcPublisher, type WebRtcPublisher } from "./webrtc-publisher.ts";
import { HttpBodyError, readBodyLimited, readJsonLimited } from "./request-body.ts";
import { createMiddlewareUploader } from "./middleware-upload.ts";
import {
  SessionReplayConflictError,
  sessionReplayErrorStatus,
} from "./session-recorder.ts";
import {
  adaptScrcpySession,
  startEmuSession,
  type EmuSession,
} from "./stream-session.ts";
import {
  streamModeMethodNotAllowedResponse,
  streamModeRequestErrorResponse,
  streamModeUnavailableResponse,
} from "./stream-mode-api.ts";
import {
  SCRCPY_DEFAULTS,
  ScrcpyStreamError,
  startScrcpy,
  type ScrcpySession,
} from "./scrcpy.ts";
import {
  DEFAULT_GRPC_INPUT_SOURCE,
  DEFAULT_GRPC_IMAGE_MODE,
  DEFAULT_GRPC_ENCODER,
  GRPC_ENCODERS,
  isGrpcEncoder,
  GRPC_IMAGE_MODES,
  INPUT_SOURCES,
  isGrpcImageMode,
  isInputSource,
  parseDisplayDensityScale,
  parseFontScale,
  parseStreamModeRequest,
  type GrpcImageMode,
  type GrpcEncoder,
  type InputSource,
  type StreamMode,
  type StreamModeResponse,
} from "./shared/api-contracts.ts";
import {
  handleWebRtcStatsRequest,
  WebRtcStatsCollector,
  WebRtcStatsRequestError,
} from "./webrtc-stats.ts";

export { fromBunSocket, fromWsSocket } from "./stream-socket.ts";
export type { StreamSocket, WsWebSocketLike } from "./stream-socket.ts";
export { pickDevice } from "./adb.ts";
export type { ScrcpySession } from "./scrcpy.ts";
export type {
  EmuSession,
  EmuSessionDiagnostics,
  GrpcCaptureDiagnostics,
  RollingTimingSummary,
} from "./stream-session.ts";
export {
  DEFAULT_GRPC_INPUT_SOURCE,
  DEFAULT_GRPC_IMAGE_MODE,
  DEFAULT_GRPC_ENCODER,
  GRPC_ENCODERS,
  isGrpcEncoder,
  GRPC_IMAGE_MODES,
  INPUT_SOURCES,
  isGrpcImageMode,
  isInputSource,
} from "./shared/api-contracts.ts";
export type { GrpcEncoder, GrpcImageMode, InputSource } from "./shared/api-contracts.ts";
export type {
  StreamEncoderSettings,
  StreamSettings,
  WebRtcIceServer,
  WebRtcIceTransportPolicy,
  WebRtcStreamSettings,
  ViewerTransports,
} from "./stream-settings.ts";
export { STREAM_TRANSPORTS } from "./stream-settings.ts";
export type { StreamTransport } from "./stream-settings.ts";
export { cameraLaunchArgs, handleCameraRequest, seedCameraFeeds } from "./camera.ts";
export { CAMERA_FACINGS } from "./shared/api-contracts.ts";
export type { CameraFacing, CameraFeedStatus, CameraStatus } from "./shared/api-contracts.ts";

const here = dirname(fileURLToPath(import.meta.url));
// `src/middleware.ts` and `dist/middleware.mjs` both resolve to `<pkg>/dist/ui`.
const UI_DIR = join(here, "..", "dist", "ui");

export type AppOptions = {
  serial: string;
  /** Cancels stream-source startup and closes it if cancellation races readiness. */
  signal?: AbortSignal;
  maxFps?: number;
  bitRate?: number;
  maxSize?: number;
  keyFrameInterval?: number;
  maxApkUploadBytes?: number;
  maxMediaUploadBytes?: number;
  maxActiveUploads?: number;
  maxQueuedUploads?: number;
  uploadQueueTimeoutMs?: number;
  /** Default viewer transport. Each browser viewer may select either available path. */
  streamSettings?: StreamSettings;
  /** Screen capture source. Defaults to scrcpy. */
  streamMode?: StreamMode;
  /** Emulator gRPC image delivery mode. Defaults to PNG. */
  grpcImageMode?: GrpcImageMode;
  /** Host H.264 encoder for gRPC capture. Defaults to software. */
  encoder?: GrpcEncoder;
  /** Input transport. gRPC streaming defaults to scrcpy input. */
  inputSource?: InputSource;
  /** @internal Shared by router-managed source generations for one device. */
  deviceState?: DeviceSessionState;
} & BrowserOriginPolicy;

export type AppClock = {
  now(): number;
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(timer: unknown): void;
};

type SessionStatus = "streaming" | "stopped" | "error";

type Client = {
  id: number;
  socket: StreamSocket;
  video: boolean;
  frameMeta: boolean;
  sentFrames: number;
  droppedFrames: number;
  backpressureEvents: number;
  awaitingKeyFrame: boolean;
};

const MAX_WS_MESSAGE_BYTES = 16 * 1024;
const DROP_FRAME_BUFFERED_BYTES = 512 * 1024;
const CLOSE_CLIENT_BUFFERED_BYTES = 16 * 1024 * 1024;
const FRAME_META_MAGIC = 0x53454d55; // "SEMU"
const FRAME_META_VERSION = 1;
const FRAME_META_HEADER_BYTES = 16;
const FRAME_FLAG_KEY = 1 << 0;
const VIDEO_RESET_COOLDOWN_MS = 1500;
const MAX_JSON_BODY_BYTES = 8 * 1024;
const MAX_ROUTE_BODY_BYTES = 2 * 1024 * 1024;
const MAX_WEBRTC_CLOSE_BODY_BYTES = 4 * 1024;
const MAX_LOGCAT_QUERY_BYTES = 200;
const FRAME_STAT_WINDOW = 240;
// After a device's scrcpy start fails, wait this long before retrying so a
// flapping device doesn't get hammered on every request.
const SPAWN_RETRY_COOLDOWN_MS = 5_000;

const SYSTEM_APP_CLOCK: AppClock = {
  now: Date.now,
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: (timer) =>
    clearInterval(timer as ReturnType<typeof setInterval>),
};

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));
function abortError(signal: AbortSignal, fallback: string): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException(fallback, "AbortError");
}

function throwIfAborted(signal: AbortSignal | undefined, fallback: string): void {
  if (signal?.aborted) throw abortError(signal, fallback);
}

function combineAbortSignals(
  first: AbortSignal | undefined,
  second: AbortSignal | undefined,
): AbortSignal | undefined {
  if (!first) return second;
  if (!second || first === second) return first;
  return AbortSignal.any([first, second]);
}

const middlewareFailure = (error: string, status: number): Response =>
  Response.json({ ok: false, error }, { status });

const middlewareRequestFailure = (error: unknown): Response =>
  error instanceof HttpBodyError
    ? middlewareFailure(error.code, error.status)
    : middlewareFailure(errMsg(error), 400);

const STATIC_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  const ext = dot === -1 ? "" : path.slice(dot).toLowerCase();
  return STATIC_CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/**
 * Serve a file from the built UI directory. Returns `null` when the path does
 * not map to a real file so callers can fall back to a 404. The UI shell is
 * device-independent, so the router serves it without a device attached.
 */
function serveStaticFile(pathname: string): Response | null {
  const reqPath = pathname === "/" ? "/index.html" : pathname;
  if (reqPath.includes("..")) return null;
  const filePath = join(UI_DIR, reqPath);
  if (existsSync(filePath) && statSync(filePath).isFile()) {
    return new Response(new Uint8Array(readFileSync(filePath)), {
      headers: { "Content-Type": contentTypeFor(filePath) },
    });
  }
  return null;
}

/**
 * Build a transport-agnostic serve-emu app for one device: starts its selected
 * stream source, owns
 * the client set + video fan-out, and exposes a fetch-style `handleRequest` plus
 * an `attachWebSocket` for the H.264/gesture channel. `server.ts` (Bun) and the
 * Expo DevTools plugin both mount these onto their own transport.
 */
export type CreateAppDependencies = {
  startSession?: typeof startEmuSession;
  /** @internal Legacy test seam retained while callers migrate to startSession. */
  startScrcpy?: typeof startScrcpy;
  createWebRtcPublisher?: typeof createWebRtcPublisher;
  clock?: AppClock;
  setLocation?: (
    serial: string,
    fix: GeoFix,
    signal: AbortSignal,
  ) => Promise<void>;
};

async function createAppInternal(
  opts: AppOptions,
  dependencies: CreateAppDependencies = {},
) {
  throwIfAborted(opts.signal, "serve-emu app startup aborted");
  const requestedGrpcImageMode: unknown =
    opts.grpcImageMode ?? DEFAULT_GRPC_IMAGE_MODE;
  if (!isGrpcImageMode(requestedGrpcImageMode)) {
    throw new Error(
      `grpcImageMode must be one of: ${GRPC_IMAGE_MODES.join(", ")}`,
    );
  }
  const grpcImageMode = requestedGrpcImageMode;
  const encoder: unknown = opts.encoder ?? DEFAULT_GRPC_ENCODER;
  if (!isGrpcEncoder(encoder)) {
    throw new Error(`encoder must be one of: ${GRPC_ENCODERS.join(", ")}`);
  }
  const streamMode = opts.streamMode ?? "scrcpy";
  const requestedInputSource: unknown =
    opts.inputSource ??
    (streamMode === "grpc-screenshot" ? DEFAULT_GRPC_INPUT_SOURCE : "scrcpy");
  if (!isInputSource(requestedInputSource)) {
    throw new Error(`inputSource must be one of: ${INPUT_SOURCES.join(", ")}`);
  }
  const inputSource = requestedInputSource;
  if (streamMode === "scrcpy" && inputSource !== "scrcpy") {
    throw new Error("scrcpy streaming requires scrcpy input");
  }
  const openWebRtcPublisher =
    dependencies.createWebRtcPublisher ?? createWebRtcPublisher;
  const clock = dependencies.clock ?? SYSTEM_APP_CLOCK;
  const uploader = createMiddlewareUploader({
    serial: opts.serial,
    maxApkUploadBytes: opts.maxApkUploadBytes,
    maxMediaUploadBytes: opts.maxMediaUploadBytes,
    maxActiveUploads: opts.maxActiveUploads,
    maxQueuedUploads: opts.maxQueuedUploads,
    uploadQueueTimeoutMs: opts.uploadQueueTimeoutMs,
  });
  let streamEncoderSettings: StreamEncoderSettings = {
    maxDimension: opts.maxSize ?? SCRCPY_DEFAULTS.maxSize,
    h264Bitrate: opts.bitRate ?? SCRCPY_DEFAULTS.bitRate,
    h264Fps: opts.maxFps ?? 30,
  };
  const openSession: typeof startEmuSession =
    dependencies.startSession ??
    (dependencies.startScrcpy
      ? async (options) =>
          adaptScrcpySession(await dependencies.startScrcpy!(options))
      : startEmuSession);
  let openedSession: EmuSession | null = null;
  try {
    openedSession = await openSession({
      serial: opts.serial,
      signal: opts.signal,
      maxFps: streamEncoderSettings.h264Fps,
      bitRate: streamEncoderSettings.h264Bitrate,
      maxSize: streamEncoderSettings.maxDimension,
      keyFrameInterval: opts.keyFrameInterval,
      mode: streamMode,
      grpcImageMode,
      encoder,
      inputSource,
    });
    throwIfAborted(opts.signal, "serve-emu app startup aborted");
  } catch (error) {
    if (openedSession) {
      try {
        await openedSession.close();
      } catch {}
    }
    await uploader.close(error);
    throw error;
  }
  if (!openedSession) throw new Error("stream source did not start");
  let session: EmuSession = openedSession;

  const clients = new Set<Client>();
  const screen: Screen = { width: session.meta.width, height: session.meta.height };
  const streamSettings = opts.streamSettings ?? DEFAULT_STREAM_SETTINGS;
  const webRtcStreamSettings: WebRtcStreamSettings =
    streamSettings.transport === "webrtc"
      ? streamSettings
      : DEFAULT_WEBRTC_STREAM_SETTINGS;
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  let status: SessionStatus = "streaming";
  let lastError: string | null = null;
  let lastErrorCode: string | null = null;
  let lastErrorMeta: Record<string, string | number> | null = null;
  let stoppedAt: string | null = null;
  let stopRequested = false;
  let captureRestarting = false;
  let captureRestartController: AbortController | null = null;
  let sessionGeneration = 1;
  let frameCount = 0;
  const frameStats = new FrameStatWindow(FRAME_STAT_WINDOW);
  let configPacketCount = 0;
  let lastFrameMs = 0;
  let totalDroppedFrames = 0;
  let totalBackpressureEvents = 0;
  let sourceFps = 0;
  let lastFpsFrameCount = 0;
  let videoResetRequests = 0;
  let lastVideoResetAt: string | null = null;
  let lastVideoResetReason: string | null = null;
  let lastVideoResetMs = 0;
  let pendingVideoResetTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingVideoResetReason: string | null = null;
  let watchdog: unknown | null = null;
  let nextClientId = 1;
  let webRtcPublisher: WebRtcPublisher | null = null;
  let webRtcPublisherTask: Promise<WebRtcPublisher> | null = null;
  const webRtcStatsCollector = new WebRtcStatsCollector(() => clock.now());
  let removeFatalListener: (() => void) | null = null;
  const deviceStateOwner = {};
  const deviceState =
    opts.deviceState ??
    new DeviceSessionState({
      serial: opts.serial,
      applyLocation:
        dependencies.setLocation ??
        ((serial, fix, signal) =>
          setEmulatorLocationAsync(serial, fix, signal)),
    });
  try {
    deviceState.acquire(deviceStateOwner);
  } catch (error) {
    await Promise.allSettled([
      session.close(),
      uploader.close(error),
    ]);
    throw error;
  }
  const sessionRecorder = deviceState.recorder;
  const routePlayback = deviceState.route;

  const health = () => ({
    ok: status === "streaming",
    status,
    captureRestarting,
    serial: opts.serial,
    device: session.meta.deviceName,
    streamMode: session.mode,
    grpcImageMode,
    encoder,
    encoderName: session.diagnostics?.().grpcCapture?.encoderName ?? null,
    inputSource: session.inputSource,
    grpcCapture: session.diagnostics?.().grpcCapture ?? null,
    codec: session.meta.codecId,
    size: { width: screen.width, height: screen.height },
    clients: clients.size,
    videoClients: Array.from(clients).filter((client) => client.video).length,
    frames: frameCount,
    sourceFps,
    frameStats: frameStats.summary(),
    configPackets: configPacketCount,
    droppedFrames: totalDroppedFrames,
    backpressureEvents: totalBackpressureEvents,
    videoResetRequests,
    lastVideoResetAt,
    lastVideoResetReason,
    location: deviceState.lastLocation,
    route: routePlayback.snapshot(),
    session: sessionRecorder.snapshot(),
    logcat: deviceState.logcat.snapshot(),
    uploads: uploader.snapshot(),
    stream: redactedStreamSettings(streamSettings),
    encoderSettings: { ...streamEncoderSettings },
    webrtc: webRtcPublisher?.snapshot() ?? null,
    clientsDetail: Array.from(clients, (client) => ({
      id: client.id,
      video: client.video,
      frameMeta: client.frameMeta,
      sentFrames: client.sentFrames,
      droppedFrames: client.droppedFrames,
      backpressureEvents: client.backpressureEvents,
      bufferedBytes: client.socket.bufferedAmount,
      awaitingKeyFrame: client.awaitingKeyFrame,
    })),
    startedAt,
    stoppedAt,
    lastFrameAt: lastFrameMs > 0 ? new Date(lastFrameMs).toISOString() : null,
    lastError,
    lastErrorCode,
    lastErrorMeta,
  });

  const webRtcStats = (sessionId: string) => {
    if (!webRtcPublisher) return null;
    return webRtcStatsCollector.report(
      {
        streamMode: session.mode,
        codec: session.meta.codecId,
        width: screen.width,
        height: screen.height,
        frames: frameCount,
        fps: sourceFps,
        configuredFps: streamEncoderSettings.h264Fps,
        configuredBitrateBps: streamEncoderSettings.h264Bitrate,
        frameStats: frameStats.summary(),
      },
      webRtcPublisher,
      sessionId,
      session.diagnostics?.().grpcCapture ?? null,
    );
  };

  const closeClients = (code: number, reason: string) => {
    for (const c of clients) {
      try {
        c.socket.close(code, reason);
      } catch {}
    }
    clients.clear();
  };

  const markTerminal = (
    nextStatus: Exclude<SessionStatus, "streaming">,
    reason: string,
    detail?: {
      code?: string;
      meta?: Record<string, string | number> | null;
    },
  ) => {
    if (status !== "streaming") return;
    status = nextStatus;
    captureRestarting = false;
    lastError = reason;
    lastErrorCode = detail?.code ?? null;
    lastErrorMeta = detail?.meta ?? null;
    stoppedAt = new Date().toISOString();
    if (watchdog !== null) clock.clearInterval(watchdog);
    if (pendingVideoResetTimer) clearTimeout(pendingVideoResetTimer);
    pendingVideoResetTimer = null;
    pendingVideoResetReason = null;
    void deviceState.release(deviceStateOwner, reason);
    webRtcPublisher?.close();
    void uploader.close(new Error(reason));
    removeFatalListener?.();
    removeFatalListener = null;
    void session.close();
    closeClients(nextStatus === "error" ? 1011 : 1000, reason);
  };

  const sendJson = (socket: StreamSocket, value: unknown) => {
    try {
      socket.send(JSON.stringify(value));
    } catch {}
  };

  const withFrameMeta = (
    frameData: Buffer,
    frame: { pts: bigint; isKey: boolean },
    config: Buffer | null,
  ): Buffer => {
    const configBytes = config?.length ?? 0;
    const out = Buffer.allocUnsafe(FRAME_META_HEADER_BYTES + configBytes + frameData.length);
    out.writeUInt32BE(FRAME_META_MAGIC, 0);
    out.writeUInt8(FRAME_META_VERSION, 4);
    out.writeUInt8(frame.isKey ? FRAME_FLAG_KEY : 0, 5);
    out.writeUInt16BE(0, 6);
    out.writeBigUInt64BE(frame.pts, 8);
    if (config) config.copy(out, FRAME_META_HEADER_BYTES);
    frameData.copy(out, FRAME_META_HEADER_BYTES + configBytes);
    return out;
  };

  const withConfig = (frameData: Buffer, config: Buffer | null): Buffer => {
    if (!config) return frameData;
    const out = Buffer.allocUnsafe(config.length + frameData.length);
    config.copy(out, 0);
    frameData.copy(out, config.length);
    return out;
  };

  const wantsAck = (value: unknown) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return true;
    return (value as Record<string, unknown>).ack !== false;
  };

  const isResetVideoRequest = (value: unknown) =>
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).type === "reset-video";

  const readJsonBody = async (req: Request, maxBytes = MAX_JSON_BODY_BYTES): Promise<unknown> => {
    return readJsonLimited(req, maxBytes);
  };

  const readBodyText = async (req: Request, maxBytes: number): Promise<string> => {
    try {
      const body = await readBodyLimited(req, maxBytes);
      return new TextDecoder("utf-8", { fatal: true }).decode(body);
    } catch (err) {
      if (
        err instanceof HttpBodyError &&
        (err.code === "payload-too-large" || err.code === "too-many-body-chunks")
      ) {
        throw new WebRtcSignalingError("WebRTC signaling body is too large", 413, "request_too_large");
      }
      throw err;
    }
  };

  const parseJsonBody = (body: string, code: string): unknown => {
    try {
      return JSON.parse(body);
    } catch {
      throw new WebRtcSignalingError("Invalid JSON body", 400, code);
    }
  };

  const shouldRecord = (value: unknown) =>
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).record !== false;

  const dispatchGesture = async (gesture: Gesture, source: string, record = true) => {
    if (status !== "streaming") throw new Error(`session is ${status}`);
    if (captureRestarting) throw new Error("video capture is restarting");
    const generation = sessionGeneration;
    const handle = session.controls.enqueue(gesture, screen);
    try {
      await handle.completion;
    } catch (error) {
      if (generation !== sessionGeneration || captureRestarting) {
        throw new Error("video capture restarted during input");
      }
      throw error;
    }
    if (generation !== sessionGeneration || captureRestarting) {
      throw new Error("video capture restarted during input");
    }
    if (record) sessionRecorder.recordGesture(handle.gesture, source);
  };

  const applyLocation = async (fix: GeoFix, source: string, record = true) => {
    routePlayback.stop();
    const location = await deviceState.applyLocation(fix);
    if (record) sessionRecorder.recordLocation(fix, source);
    return location;
  };

  const activateDeviceState = (): void => {
    deviceState.activate(deviceStateOwner, {
      dispatchGesture: async (gesture, signal) => {
        if (signal.aborted) {
          throw signal.reason instanceof Error
            ? signal.reason
            : new DOMException("session replay cancelled", "AbortError");
        }
        await dispatchGesture(gesture, "session:replay", false);
      },
    });
  };
  if (!deviceState.hasActiveInput) activateDeviceState();

  const logcatStream = (req: Request, url: URL) => {
    const packageName = (url.searchParams.get("package") ?? "").trim().slice(0, MAX_LOGCAT_QUERY_BYTES);
    const search = (url.searchParams.get("search") ?? "").trim().slice(0, MAX_LOGCAT_QUERY_BYTES).toLowerCase();
    const response = deviceState.logcat.subscribe(
      { packageName, search },
      req.signal,
    );
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(
      corsHeadersForRequest(req, opts, "GET"),
    )) {
      headers.set(name, value);
    }
    return new Response(response.body, {
      status: response.status,
      headers,
    });
  };

  const gestureEndpoint = async (req: Request, type: Gesture["type"], source: string) => {
    try {
      const payload = await readJsonBody(req);
      const gesture = parseGesture(
        typeof payload === "object" && payload !== null && !Array.isArray(payload)
          ? { ...payload, type }
          : payload,
      );
      await dispatchGesture(gesture, source, shouldRecord(payload));
      return Response.json({ ok: true });
    } catch (err) {
      return Response.json(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        { status: 400 },
      );
    }
  };

  const keyEndpoint = async (req: Request) => {
    try {
      const payload = await readJsonBody(req);
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        throw new Error("key payload must be an object");
      }
      const key = (payload as Record<string, unknown>).key;
      const gesture =
        key === "back" || key === "home" || key === "recents" || key === "power"
          ? parseGesture({ type: key })
          : parseGesture({ ...payload, type: "key" });
      await dispatchGesture(gesture, "rest:key", shouldRecord(payload));
      return Response.json({ ok: true });
    } catch (err) {
      return Response.json(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        { status: 400 },
      );
    }
  };

  const appJsonEndpoint = async (
    req: Request,
    action: (payload: Record<string, unknown>) => unknown,
  ) => {
    try {
      const payload = await readJsonBody(req);
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        throw new Error("payload must be an object");
      }
      const result = await action(payload as Record<string, unknown>);
      return Response.json(result);
    } catch (err) {
      return Response.json(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        { status: 400 },
      );
    }
  };

  const installEndpoint = (req: Request) => uploader.install(req);

  const fileImportEndpoint = (req: Request) => uploader.importFile(req);

  const performVideoReset = (reason: string) => {
    if (status !== "streaming" || captureRestarting) return;
    const now = Date.now();
    lastVideoResetMs = now;
    videoResetRequests++;
    lastVideoResetAt = new Date(now).toISOString();
    lastVideoResetReason = reason;
    try {
      void session.controls.enqueueVideoReset().completion.catch(() => {});
    } catch {}
  };

  const requestVideoReset = (reason: string) => {
    if (status !== "streaming" || captureRestarting) return;
    const now = Date.now();
    const remainingCooldownMs = VIDEO_RESET_COOLDOWN_MS - (now - lastVideoResetMs);
    if (remainingCooldownMs <= 0) {
      if (pendingVideoResetTimer) {
        clearTimeout(pendingVideoResetTimer);
        pendingVideoResetTimer = null;
        pendingVideoResetReason = null;
      }
      performVideoReset(reason);
      return;
    }

    pendingVideoResetReason = reason;
    if (pendingVideoResetTimer) return;
    pendingVideoResetTimer = setTimeout(() => {
      pendingVideoResetTimer = null;
      const pendingReason = pendingVideoResetReason;
      pendingVideoResetReason = null;
      if (pendingReason) performVideoReset(pendingReason);
    }, remainingCooldownMs);
  };

  const publisherFor = (): Promise<WebRtcPublisher> => {
    if (session.meta.codecId !== webRtcStreamSettings.codec) {
      return Promise.reject(
        new WebRtcSignalingError(
          `WebRTC requires ${webRtcStreamSettings.codec.toUpperCase()} video, but ${session.mode} negotiated ${session.meta.codecId}.`,
          409,
          "webrtc_codec_unavailable",
        ),
      );
    }
    if (stopRequested || status !== "streaming") {
      return Promise.reject(
        new WebRtcSignalingError(
          `WebRTC is unavailable while the stream is ${status}.`,
          503,
          "webrtc_unavailable",
        ),
      );
    }
    if (webRtcPublisher) return Promise.resolve(webRtcPublisher);
    if (webRtcPublisherTask) return webRtcPublisherTask;

    const generation = sessionGeneration;
    const task = openWebRtcPublisher({
      settings: webRtcStreamSettings,
      onKeyframeRequest: requestVideoReset,
    })
      .then((publisher) => {
        if (
          stopRequested ||
          status !== "streaming" ||
          generation !== sessionGeneration ||
          session.meta.codecId !== webRtcStreamSettings.codec
        ) {
          publisher.close();
          throw new WebRtcSignalingError(
            "The stream changed while WebRTC was starting.",
            409,
            "webrtc_stream_changed",
          );
        }
        webRtcPublisher = publisher;
        return publisher;
      })
      .finally(() => {
        if (webRtcPublisherTask === task) webRtcPublisherTask = null;
      });
    webRtcPublisherTask = task;
    return task;
  };

  const dropUntilKeyFrame = (client: Client) => {
    client.droppedFrames++;
    totalDroppedFrames++;
    client.awaitingKeyFrame = true;
    requestVideoReset("client backpressure");
  };

  const sendFrame = (client: Client, data: Buffer, isKeyFrame: boolean) => {
    if (client.awaitingKeyFrame) {
      if (!isKeyFrame) {
        client.droppedFrames++;
        totalDroppedFrames++;
        return;
      }
      client.awaitingKeyFrame = false;
    }

    const buffered = client.socket.bufferedAmount;
    if (buffered > CLOSE_CLIENT_BUFFERED_BYTES) {
      console.warn(
        `client ${client.id} too slow: closing (buffered ${buffered} B > ${CLOSE_CLIENT_BUFFERED_BYTES} B, ${client.droppedFrames} dropped)`,
      );
      clients.delete(client);
      try {
        client.socket.close(1013, "client too slow");
      } catch {}
      return;
    }
    if (buffered > DROP_FRAME_BUFFERED_BYTES) {
      client.backpressureEvents++;
      totalBackpressureEvents++;
      dropUntilKeyFrame(client);
      return;
    }
    client.socket.send(data);
    client.sentFrames++;
  };
  // Cache the SPS+PPS bytes that scrcpy emits as a standalone "config" packet
  // and inline them in front of every keyframe so each WS message is a
  // self-contained Access Unit the browser can hand straight to WebCodecs.
  let cachedConfig: Buffer | null = null;
  let lastFpsSampleMs = clock.now();

  const startCaptureReader = (activeSession: EmuSession, generation: number) => {
    void (async () => {
      try {
        while (!stopRequested && generation === sessionGeneration) {
          const f = await activeSession.readFrame();
          if (stopRequested || generation !== sessionGeneration) break;
          if (!f) {
            markTerminal("error", "video stream ended");
            break;
          }
          if (f.type === "session") {
            // The encoder restarted with a new size (device rotation). Adopt it so
            // touch packets keep matching the video size (scrcpy drops touches
            // whose embedded screen size disagrees), and resync every client onto
            // the new stream from a fresh keyframe.
            if (f.width > 0 && f.height > 0) {
              screen.width = f.width;
              screen.height = f.height;
              cachedConfig = null;
              for (const c of clients) {
                if (!c.video) continue;
                c.awaitingKeyFrame = true;
                sendJson(c.socket, {
                  type: "video-session",
                  size: { width: f.width, height: f.height },
                });
              }
              webRtcPublisher?.resetVideoSource();
            }
            continue;
          }
          if (f.isConfig) {
            cachedConfig = f.data;
            configPacketCount++;
            continue;
          }
          frameCount++;
          frameStats.record(f.data.length, f.isKey, clock.now());
          lastFrameMs = Date.now();
          const config = f.isKey ? cachedConfig : null;
          webRtcStatsCollector.recordDelivery(
            activeSession.meta.codecId === webRtcStreamSettings.codec
              ? webRtcPublisher?.sendFrame(f, config)
              : undefined,
          );
          let rawOut: Buffer | null = null;
          let framedOut: Buffer | null = null;
          for (const c of clients) {
            if (!c.video) continue;
            if (c.awaitingKeyFrame && !f.isKey) {
              c.droppedFrames++;
              totalDroppedFrames++;
              continue;
            }
            const out = c.frameMeta
              ? (framedOut ??= withFrameMeta(f.data, f, config))
              : (rawOut ??= withConfig(f.data, config));
            sendFrame(c, out, f.isKey);
          }
        }
      } catch (err) {
        if (!stopRequested && generation === sessionGeneration) {
          if (err instanceof ScrcpyStreamError) {
            markTerminal("error", err.message, {
              code: err.code,
              meta: err.meta ?? null,
            });
          } else {
            markTerminal("error", String(err));
          }
        }
      }
    })();

    removeFatalListener?.();
    removeFatalListener = activeSession.onFatal((failure) => {
      if (!stopRequested && generation === sessionGeneration && status === "streaming") {
        markTerminal("error", failure.message, {
          code: failure.code,
          meta: failure.meta ?? null,
        });
      }
    });
  };

  const activateCapture = async (
    nextSession: EmuSession,
    settings: StreamEncoderSettings,
  ): Promise<void> => {
    try {
      if (stopRequested || status !== "streaming") {
        throw new StreamSettingsUnavailableError(`session is ${status}`);
      }
    } catch (err) {
      await nextSession.close();
      throw err;
    }

    session = nextSession;
    streamEncoderSettings = settings;
    captureRestarting = false;
    const generation = ++sessionGeneration;
    screen.width = nextSession.meta.width;
    screen.height = nextSession.meta.height;
    frameStats.reset();
    cachedConfig = null;
    if (pendingVideoResetTimer) clearTimeout(pendingVideoResetTimer);
    pendingVideoResetTimer = null;
    pendingVideoResetReason = null;
    lastVideoResetMs = 0;
    for (const client of clients) {
      if (!client.video) continue;
      client.awaitingKeyFrame = true;
      sendJson(client.socket, {
        type: "video-session",
        size: { width: screen.width, height: screen.height },
      });
    }
    if (nextSession.meta.codecId === webRtcStreamSettings.codec) {
      webRtcPublisher?.resetVideoSource();
    } else {
      webRtcPublisher?.close();
      webRtcPublisher = null;
    }
    startCaptureReader(nextSession, generation);
    requestVideoReset("stream settings changed");
  };

  const startCapture = (
    settings: StreamEncoderSettings,
    mode: StreamMode,
    nextInputSource: InputSource,
    signal: AbortSignal,
  ) =>
    openSession({
      serial: opts.serial,
      signal: combineAbortSignals(opts.signal, signal),
      maxFps: settings.h264Fps,
      bitRate: settings.h264Bitrate,
      maxSize: settings.maxDimension,
      keyFrameInterval: opts.keyFrameInterval,
      mode,
      grpcImageMode,
      encoder,
      inputSource: nextInputSource,
    });

  const replaceCapture = async (
    settings: StreamEncoderSettings,
    mode: StreamMode,
    nextInputSource: InputSource,
    signal: AbortSignal,
  ): Promise<void> => {
    const candidate = await startCapture(
      settings,
      mode,
      nextInputSource,
      signal,
    );
    await activateCapture(candidate, settings);
  };

  let streamSettingsUpdate: Promise<void> = Promise.resolve();
  const updateStreamEncoderSettings = (
    patch: StreamEncoderSettingsPatch,
  ): Promise<StreamEncoderSettings> => {
    const update = streamSettingsUpdate.then(async () => {
      if (stopRequested || status !== "streaming") {
        throw new StreamSettingsUnavailableError(`session is ${status}`);
      }
      const previousSettings = streamEncoderSettings;
      const nextSettings = { ...previousSettings, ...patch };
      if (streamEncoderSettingsEqual(previousSettings, nextSettings)) {
        return { ...previousSettings };
      }
      if (sessionRecorder.isReplaying) {
        throw new SessionReplayConflictError(
          "cannot update stream settings while session replay is running",
        );
      }

      const previousSession = session;
      const previousMode = previousSession.mode;
      const previousInputSource = previousSession.inputSource;
      const restartController = new AbortController();
      captureRestartController = restartController;
      captureRestarting = true;
      if (pendingVideoResetTimer) clearTimeout(pendingVideoResetTimer);
      pendingVideoResetTimer = null;
      pendingVideoResetReason = null;
      ++sessionGeneration;
      removeFatalListener?.();
      removeFatalListener = null;
      try {
        await previousSession.close();
        await replaceCapture(
          nextSettings,
          previousMode,
          previousInputSource,
          restartController.signal,
        );
        return { ...streamEncoderSettings };
      } catch (updateError) {
        if (stopRequested || status !== "streaming") {
          throw new StreamSettingsUnavailableError(`session is ${status}`);
        }

        try {
          await replaceCapture(
            previousSettings,
            previousMode,
            previousInputSource,
            restartController.signal,
          );
        } catch (rollbackError) {
          if (stopRequested || status !== "streaming") {
            throw new StreamSettingsUnavailableError(`session is ${status}`);
          }
          captureRestarting = false;
          markTerminal(
            "error",
            `scrcpy stream settings update failed (${errMsg(updateError)}); rollback failed (${errMsg(rollbackError)})`,
          );
          throw new Error(lastError ?? errMsg(updateError));
        }
        throw updateError;
      } finally {
        if (captureRestartController === restartController) {
          captureRestartController = null;
        }
      }
    });
    streamSettingsUpdate = update.then(
      () => {},
      () => {},
    );
    return update;
  };

  startCaptureReader(session, sessionGeneration);

  watchdog = clock.setInterval(() => {
    const now = clock.now();
    const elapsedMs = now - lastFpsSampleMs;
    if (elapsedMs <= 0) return;
    const elapsedFrames = frameCount - lastFpsFrameCount;
    sourceFps = (elapsedFrames * 1_000) / elapsedMs;
    lastFpsFrameCount = frameCount;
    lastFpsSampleMs = now;
  }, 1000);

  const webRtcCorsHeaders = (req: Request) => corsHeadersForRequest(req, opts);
  const webRtcJsonHeaders = (req: Request) => ({
    ...webRtcCorsHeaders(req),
    "Content-Type": "application/json; charset=utf-8",
  });
  const webRtcForbiddenOrigin = (req: Request) =>
    Response.json(
      { error: "forbidden_origin", message: "Request origin is not allowed for WebRTC signaling." },
      { status: 403, headers: webRtcJsonHeaders(req) },
    );

  const handleRequest = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    if (url.pathname === "/webrtc/stats") {
      return handleWebRtcStatsRequest(req, opts, (sessionId, device) =>
        device === null || device === opts.serial
          ? webRtcStats(sessionId)
          : null,
      );
    }

    if (url.pathname === "/api/stream-settings") {
      if (req.method === "GET") {
        await streamSettingsUpdate;
        return Response.json({ ok: true, ...streamEncoderSettings }, {
          headers: { "Cache-Control": "no-store" },
        });
      }
      if (req.method !== "PATCH") {
        return Response.json(
          { ok: false, error: "method_not_allowed" },
          { status: 405, headers: { Allow: "GET, PATCH" } },
        );
      }
      if (!isAllowedMutationOrigin(req, opts)) {
        return middlewareFailure("forbidden_origin", 403);
      }
      if (!isJsonRequest(req)) {
        return Response.json(
          { ok: false, error: "unsupported_media_type" },
          { status: 415 },
        );
      }
      let patch: StreamEncoderSettingsPatch;
      try {
        patch = parseStreamEncoderSettingsPatch(await readJsonBody(req));
      } catch (err) {
        const bodyTooLarge = err instanceof HttpBodyError && err.status === 413;
        return Response.json(
          {
            ok: false,
            error: bodyTooLarge ? "body_too_large" : "invalid_stream_settings",
            message: errMsg(err),
          },
          { status: bodyTooLarge ? 413 : 400 },
        );
      }
      try {
        const settings = await updateStreamEncoderSettings(patch);
        return Response.json({ ok: true, ...settings }, {
          headers: { "Cache-Control": "no-store" },
        });
      } catch (err) {
        const conflict = err instanceof SessionReplayConflictError;
        const unavailable = err instanceof StreamSettingsUnavailableError;
        return Response.json(
          {
            ok: false,
            error: unavailable
              ? "stream_settings_unavailable"
              : conflict
                ? "stream_settings_conflict"
                : "stream_settings_failed",
            message: errMsg(err),
          },
          { status: unavailable ? 503 : conflict ? 409 : 500 },
        );
      }
    }

    if (url.pathname === "/api") {
      return Response.json(
        {
          generation: 0,
          serial: opts.serial,
          device: session.meta.deviceName,
          streamMode: session.mode,
          grpcImageMode,
          encoder,
          encoderName: session.diagnostics?.().grpcCapture?.encoderName ?? null,
          inputSource: session.inputSource,
          codec: session.meta.codecId,
          size: { width: screen.width, height: screen.height },
          status,
          lastFrameAt: lastFrameMs > 0 ? new Date(lastFrameMs).toISOString() : null,
          lastError,
          clients: clients.size,
          stream: streamSettings,
          viewerTransports: viewerTransportsFor(
            streamSettings,
            session.meta.codecId,
          ),
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    if (url.pathname === "/api/devices") {
      if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
      try {
        return Response.json({
          ok: true,
          currentSerial: opts.serial,
          devices: (await listAllDevices()).map((device) => ({
            ...device,
            current: device.serial === opts.serial,
          })),
        });
      } catch (err) {
        return Response.json(
          { ok: false, error: err instanceof Error ? err.message : String(err) },
          { status: 400 },
        );
      }
    }

    if (url.pathname === "/api/network") {
      if (req.method === "GET") {
        try {
          return Response.json({ ok: true, network: await getNetworkStatus(opts.serial) });
        } catch (err) {
          return middlewareRequestFailure(err);
        }
      }
      if (req.method === "POST") {
        if (!isAllowedBrowserOrigin(req, opts)) {
          return middlewareFailure("forbidden_origin", 403);
        }
        try {
          const payload = await readJsonBody(req);
          if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
            throw new Error("network payload must be an object");
          }
          const enabled = (payload as Record<string, unknown>).enabled;
          if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
          return Response.json({
            ok: true,
            network: await setNetworkEnabled(opts.serial, enabled),
          });
        } catch (err) {
          return middlewareRequestFailure(err);
        }
      }
      return middlewareFailure("method_not_allowed", 405);
    }

    if (url.pathname === "/api/font-scale") {
      if (req.method === "GET") {
        try {
          return Response.json({ ok: true, fontScale: await getFontScale(opts.serial) });
        } catch (err) {
          return middlewareRequestFailure(err);
        }
      }
      if (req.method === "POST") {
        if (!isAllowedBrowserOrigin(req, opts)) {
          return middlewareFailure("forbidden_origin", 403);
        }
        try {
          const payload = await readJsonBody(req);
          if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
            throw new Error("font scale payload must be an object");
          }
          const scale = parseFontScale(
            (payload as Record<string, unknown>).scale,
          );
          return Response.json({
            ok: true,
            fontScale: await setFontScale(opts.serial, scale),
          });
        } catch (err) {
          return middlewareRequestFailure(err);
        }
      }
      return middlewareFailure("method_not_allowed", 405);
    }

    if (url.pathname === "/api/reduce-motion") {
      if (req.method === "GET") {
        try {
          return Response.json({ ok: true, reduceMotion: await getReduceMotion(opts.serial) });
        } catch (err) {
          return middlewareRequestFailure(err);
        }
      }
      if (req.method === "POST") {
        if (!isAllowedBrowserOrigin(req, opts)) {
          return middlewareFailure("forbidden_origin", 403);
        }
        try {
          const payload = await readJsonBody(req);
          if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
            throw new Error("reduce motion payload must be an object");
          }
          const enabled = (payload as Record<string, unknown>).enabled;
          if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
          return Response.json({
            ok: true,
            reduceMotion: await setReduceMotion(opts.serial, enabled),
          });
        } catch (err) {
          return middlewareRequestFailure(err);
        }
      }
      return middlewareFailure("method_not_allowed", 405);
    }

    if (url.pathname === "/api/high-text-contrast") {
      if (req.method === "GET") {
        try {
          return Response.json({ ok: true, highTextContrast: await getHighTextContrast(opts.serial) });
        } catch (err) {
          return middlewareRequestFailure(err);
        }
      }
      if (req.method === "POST") {
        if (!isAllowedBrowserOrigin(req, opts)) {
          return middlewareFailure("forbidden_origin", 403);
        }
        try {
          const payload = await readJsonBody(req);
          if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
            throw new Error("high text contrast payload must be an object");
          }
          const enabled = (payload as Record<string, unknown>).enabled;
          if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
          return Response.json({
            ok: true,
            highTextContrast: await setHighTextContrast(opts.serial, enabled),
          });
        } catch (err) {
          return middlewareRequestFailure(err);
        }
      }
      return middlewareFailure("method_not_allowed", 405);
    }

    if (url.pathname === "/api/font-weight") {
      if (req.method === "GET") {
        try {
          return Response.json({ ok: true, fontWeight: await getFontWeight(opts.serial) });
        } catch (err) {
          return middlewareRequestFailure(err);
        }
      }
      if (req.method === "POST") {
        if (!isAllowedBrowserOrigin(req, opts)) {
          return middlewareFailure("forbidden_origin", 403);
        }
        try {
          const payload = await readJsonBody(req);
          if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
            throw new Error("font weight payload must be an object");
          }
          const enabled = (payload as Record<string, unknown>).enabled;
          if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
          return Response.json({
            ok: true,
            fontWeight: await setFontWeight(opts.serial, enabled),
          });
        } catch (err) {
          return middlewareRequestFailure(err);
        }
      }
      return middlewareFailure("method_not_allowed", 405);
    }

    if (url.pathname === "/api/software-keyboard") {
      if (req.method === "GET") {
        try {
          return Response.json({ ok: true, softwareKeyboard: await getSoftwareKeyboard(opts.serial) });
        } catch (err) {
          return middlewareRequestFailure(err);
        }
      }
      if (req.method === "POST") {
        if (!isAllowedBrowserOrigin(req, opts)) {
          return middlewareFailure("forbidden_origin", 403);
        }
        try {
          const payload = await readJsonBody(req);
          if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
            throw new Error("software keyboard payload must be an object");
          }
          const enabled = (payload as Record<string, unknown>).enabled;
          if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
          return Response.json({
            ok: true,
            softwareKeyboard: await setSoftwareKeyboard(opts.serial, enabled),
          });
        } catch (err) {
          return middlewareRequestFailure(err);
        }
      }
      return middlewareFailure("method_not_allowed", 405);
    }

    if (url.pathname === "/api/display-density") {
      if (req.method === "GET") {
        try {
          return Response.json({ ok: true, displayDensity: await getDisplayDensity(opts.serial) });
        } catch (err) {
          return middlewareRequestFailure(err);
        }
      }
      if (req.method === "POST") {
        if (!isAllowedBrowserOrigin(req, opts)) {
          return middlewareFailure("forbidden_origin", 403);
        }
        try {
          const payload = await readJsonBody(req);
          if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
            throw new Error("display density payload must be an object");
          }
          const scale = parseDisplayDensityScale(
            (payload as Record<string, unknown>).scale,
          );
          return Response.json({
            ok: true,
            displayDensity: await setDisplayDensity(opts.serial, scale),
          });
        } catch (err) {
          return middlewareRequestFailure(err);
        }
      }
      return middlewareFailure("method_not_allowed", 405);
    }

    if (url.pathname === "/health") {
      return Response.json(health(), { status: status === "streaming" ? 200 : 503 });
    }

    if (url.pathname === "/webrtc/offer") {
      if (!isAllowedBrowserOrigin(req, opts)) return webRtcForbiddenOrigin(req);
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: webRtcCorsHeaders(req) });
      if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: webRtcCorsHeaders(req) });
      try {
        if (!isJsonRequest(req)) {
          throw new WebRtcSignalingError(
            "WebRTC offers require application/json",
            415,
            "unsupported_media_type",
          );
        }
        const offer = parseWebRtcOffer(
          parseJsonBody(await readBodyText(req, MAX_WEBRTC_SIGNALING_BODY_BYTES), "invalid_offer"),
        );
        const publisher = await publisherFor();
        const answer = await publisher.handleOffer(offer);
        if (req.signal.aborted) {
          publisher.closeSession(offer.sessionId);
          return new Response(null, { status: 499, headers: webRtcCorsHeaders(req) });
        }
        return Response.json(answer, { headers: webRtcJsonHeaders(req) });
      } catch (err) {
        const status = err instanceof WebRtcSignalingError ? err.status : 500;
        const code = err instanceof WebRtcSignalingError ? err.code : "webrtc_offer_failed";
        return Response.json(
          { error: code, message: errMsg(err) },
          { status, headers: webRtcJsonHeaders(req) },
        );
      }
    }

    if (url.pathname === "/webrtc/close") {
      if (!isAllowedBrowserOrigin(req, opts)) return webRtcForbiddenOrigin(req);
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: webRtcCorsHeaders(req) });
      if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: webRtcCorsHeaders(req) });
      try {
        const request = parseWebRtcCloseRequest(
          parseJsonBody(await readBodyText(req, MAX_WEBRTC_CLOSE_BODY_BYTES), "invalid_close_request"),
        );
        const publisher =
          webRtcPublisher ??
          (await webRtcPublisherTask?.catch(() => null));
        publisher?.closeSession(request.sessionId);
        return new Response(null, { status: 204, headers: webRtcCorsHeaders(req) });
      } catch (err) {
        const status = err instanceof WebRtcSignalingError ? err.status : 400;
        const code = err instanceof WebRtcSignalingError ? err.code : "invalid_close_request";
        return Response.json(
          { error: code, message: errMsg(err) },
          { status, headers: webRtcJsonHeaders(req) },
        );
      }
    }

    if (url.pathname === "/api/logcat") {
      if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
      if (!isAllowedBrowserOrigin(req, opts)) {
        return Response.json({ error: "forbidden_origin" }, { status: 403 });
      }
      return logcatStream(req, url);
    }

    if (url.pathname === "/api/metrics") {
      if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
      if (!isAllowedBrowserOrigin(req, opts)) {
        return Response.json({ error: "forbidden_origin" }, { status: 403 });
      }
      const response = deviceState.metrics.subscribe(req.signal);
      const headers = new Headers(response.headers);
      for (const [name, value] of Object.entries(
        corsHeadersForRequest(req, opts, "GET"),
      )) {
        headers.set(name, value);
      }
      return new Response(response.body, { status: response.status, headers });
    }

    if (url.pathname === "/api/screenshot") {
      if (req.method !== "GET" && req.method !== "POST") {
        return new Response("method not allowed", { status: 405 });
      }
      try {
        const png = await screencapPng(opts.serial);
        if (url.searchParams.get("format") === "base64") {
          return Response.json({
            ok: true,
            mimeType: "image/png",
            data: png.toString("base64"),
          });
        }
        return new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png" } });
      } catch (err) {
        return Response.json(
          { ok: false, error: err instanceof Error ? err.message : String(err) },
          { status: 400 },
        );
      }
    }

    if (url.pathname === "/api/foreground") {
      if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
      try {
        return Response.json({
          ok: true,
          app: await getForegroundApp(opts.serial),
        });
      } catch (err) {
        return Response.json(
          { ok: false, error: err instanceof Error ? err.message : String(err) },
          { status: 400 },
        );
      }
    }

    if (url.pathname === "/api/accessibility") {
      if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
      try {
        return Response.json(await getAccessibilitySnapshot(opts.serial));
      } catch (err) {
        return Response.json(
          { ok: false, error: err instanceof Error ? err.message : String(err) },
          { status: 400 },
        );
      }
    }

    if (url.pathname === "/api/uimode") {
      if (req.method === "GET") {
        try {
          return Response.json({ ok: true, night: getNightMode(opts.serial) });
        } catch (err) {
          return Response.json(
            { ok: false, error: err instanceof Error ? err.message : String(err) },
            { status: 400 },
          );
        }
      }
      if (req.method === "POST") {
        try {
          const payload = await readJsonBody(req);
          const night =
            typeof payload === "object" && payload !== null && !Array.isArray(payload)
              ? (payload as Record<string, unknown>).night
              : undefined;
          if (!isNightMode(night)) {
            throw new Error('night must be one of "yes", "no", or "auto"');
          }
          return Response.json({ ok: true, night: setNightMode(opts.serial, night) });
        } catch (err) {
          return Response.json(
            { ok: false, error: err instanceof Error ? err.message : String(err) },
            { status: 400 },
          );
        }
      }
      return new Response("method not allowed", { status: 405 });
    }

    if (url.pathname === "/api/tap") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      return gestureEndpoint(req, "tap", "rest:tap");
    }

    if (url.pathname === "/api/swipe") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      return gestureEndpoint(req, "swipe", "rest:swipe");
    }

    if (url.pathname === "/api/text") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      return gestureEndpoint(req, "text", "rest:text");
    }

    if (url.pathname === "/api/key") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      return keyEndpoint(req);
    }

    if (url.pathname === "/api/orientation") {
      if (req.method === "GET") {
        try {
          return Response.json({
            ok: true,
            orientation: await getUserRotation(opts.serial),
          });
        } catch (err) {
          return Response.json(
            { ok: false, error: err instanceof Error ? err.message : String(err) },
            { status: 400 },
          );
        }
      }
      if (req.method === "POST") {
        try {
          const payload = await readJsonBody(req);
          if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
            throw new Error("orientation payload must be an object");
          }
          const orientation = (payload as Record<string, unknown>).orientation;
          if (orientation !== "auto" && orientation !== "portrait" && orientation !== "landscape") {
            throw new Error("orientation must be auto, portrait, or landscape");
          }
          return Response.json({
            ok: true,
            orientation: await setUserRotation(
              opts.serial,
              orientation as OrientationMode,
            ),
          });
        } catch (err) {
          return Response.json(
            { ok: false, error: err instanceof Error ? err.message : String(err) },
            { status: 400 },
          );
        }
      }
      return new Response("method not allowed", { status: 405 });
    }

    if (url.pathname === "/api/session") {
      if (req.method === "GET") return Response.json(sessionRecorder.snapshot());
      if (req.method === "DELETE") return Response.json({ ok: true, session: sessionRecorder.clear() });
      return new Response("method not allowed", { status: 405 });
    }

    if (url.pathname === "/api/session/replay") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      try {
        const payload = await readJsonBody(req);
        const multiplier =
          typeof payload === "object" && payload !== null && !Array.isArray(payload)
            ? Number((payload as Record<string, unknown>).multiplier ?? 1)
            : 1;
        if (captureRestarting) {
          throw new SessionReplayConflictError(
            "cannot start session replay while video capture is restarting",
          );
        }
        const replay = sessionRecorder.startReplay(
          deviceState.replayHandlers,
          multiplier,
        );
        void replay.completion.catch(() => {});
        return Response.json({ ok: true, session: replay.snapshot });
      } catch (err) {
        return Response.json(
          { ok: false, error: err instanceof Error ? err.message : String(err) },
          {
            status:
              err instanceof HttpBodyError
                ? err.status
                : sessionReplayErrorStatus(err),
          },
        );
      }
    }

    if (url.pathname === "/api/session/replay/stop") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      return Response.json({
        ok: true,
        session: await sessionRecorder.cancelAndWait(),
      });
    }

    if (url.pathname === "/api/apps/install") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      return installEndpoint(req);
    }

    if (url.pathname === "/api/files/import") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      return fileImportEndpoint(req);
    }

    if (url.pathname === "/api/apps/launch") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      return appJsonEndpoint(req, (payload) =>
        launchApp(
          opts.serial,
          String(payload.packageName ?? ""),
          typeof payload.activity === "string" && payload.activity.trim()
            ? payload.activity
            : undefined,
        ),
      );
    }

    if (url.pathname === "/api/apps/clear") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      return appJsonEndpoint(req, (payload) =>
        clearAppData(opts.serial, String(payload.packageName ?? "")),
      );
    }

    if (url.pathname === "/api/apps/force-stop") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      return appJsonEndpoint(req, (payload) =>
        forceStopApp(opts.serial, String(payload.packageName ?? "")),
      );
    }

    if (url.pathname === "/api/apps/grant") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      return appJsonEndpoint(req, (payload) =>
        grantPermission(
          opts.serial,
          String(payload.packageName ?? ""),
          String(payload.permission ?? ""),
        ),
      );
    }

    if (url.pathname === "/api/apps/permissions") {
      if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
      try {
        return Response.json(
          await listPermissions(opts.serial, url.searchParams.get("packageName") ?? ""),
        );
      } catch (err) {
        return middlewareRequestFailure(err);
      }
    }

    if (url.pathname === "/api/apps/revoke") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      return appJsonEndpoint(req, (payload) =>
        revokePermission(
          opts.serial,
          String(payload.packageName ?? ""),
          String(payload.permission ?? ""),
        ),
      );
    }

    if (url.pathname === "/api/apps/reset-permissions") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      return appJsonEndpoint(req, (payload) =>
        resetPermissions(opts.serial, String(payload.packageName ?? "")),
      );
    }

    if (url.pathname === "/api/apps/icon") {
      if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
      try {
        const pkg = packageName(url.searchParams.get("packageName"));
        return Response.json({
          ok: true,
          packageName: pkg,
          icon: await readAppIcon(opts.serial, pkg),
        });
      } catch (err) {
        return middlewareRequestFailure(err);
      }
    }

    if (url.pathname === "/api/location") {
      if (req.method === "GET") {
        return Response.json({
          serial: opts.serial,
          emulator: isEmulatorSerial(opts.serial),
          location: deviceState.lastLocation,
        });
      }
      if (req.method === "POST") {
        try {
          const fix = parseGeoFix(await readJsonBody(req));
          const location = await applyLocation(fix, "rest:location");
          return Response.json({ ok: true, location });
        } catch (err) {
          return Response.json(
            { ok: false, error: err instanceof Error ? err.message : String(err) },
            { status: 400 },
          );
        }
      }
      return new Response("method not allowed", { status: 405 });
    }

    if (url.pathname === "/api/route") {
      if (req.method === "GET") {
        return Response.json(routePlayback.snapshot());
      }
      if (req.method === "POST") {
        try {
          const route = parseRoutePlaybackRequest(await readJsonBody(req, MAX_ROUTE_BODY_BYTES));
          return Response.json({ ok: true, route: await routePlayback.start(route) });
        } catch (err) {
          return Response.json(
            { ok: false, error: err instanceof Error ? err.message : String(err) },
            { status: 400 },
          );
        }
      }
      if (req.method === "DELETE") {
        return Response.json({ ok: true, route: routePlayback.stop() });
      }
      return new Response("method not allowed", { status: 405 });
    }

    if (url.pathname === "/api/route/control") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      try {
        const payload = await readJsonBody(req);
        if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
          throw new Error("control payload must be an object");
        }
        const action = (payload as Record<string, unknown>).action;
        if (action === "pause") return Response.json({ ok: true, route: routePlayback.pause() });
        if (action === "resume") return Response.json({ ok: true, route: routePlayback.resume() });
        if (action === "stop") return Response.json({ ok: true, route: routePlayback.stop() });
        throw new Error("action must be pause, resume, or stop");
      } catch (err) {
        return Response.json(
          { ok: false, error: err instanceof Error ? err.message : String(err) },
          { status: 400 },
        );
      }
    }

    return serveStaticFile(url.pathname) ?? new Response("not found", { status: 404 });
  };

  /**
   * Register a freshly-connected video/gesture client. The caller owns the
   * transport upgrade and passes a {@link StreamSocket} plus the `frame-meta`
   * flag (whether to prefix each frame with the SEMU metadata header). WebRTC
   * viewers can attach a `video=false` socket for low-latency input only.
   */
  const attachWebSocket = (socket: StreamSocket, meta: { frameMeta: boolean; video?: boolean }): void => {
    if (status !== "streaming") {
      socket.close(1013, `session is ${status}`);
      return;
    }
    const client: Client = {
      id: nextClientId++,
      socket,
      video: meta.video ?? true,
      frameMeta: meta.frameMeta,
      sentFrames: 0,
      droppedFrames: 0,
      backpressureEvents: 0,
      awaitingKeyFrame: true,
    };
    clients.add(client);
    if (client.video) requestVideoReset("client opened");

    socket.onMessage((raw) => {
      if (raw.length > MAX_WS_MESSAGE_BYTES) {
        socket.close(1009, "message too large");
        return;
      }
      try {
        if (status !== "streaming") throw new Error(`session is ${status}`);
        const payload = JSON.parse(raw);
        const acknowledge = wantsAck(payload);
        if (isResetVideoRequest(payload)) {
          requestVideoReset("client requested keyframe");
          if (acknowledge) sendJson(socket, { ok: true });
          return;
        }
        const msg = parseGesture(payload);
        void dispatchGesture(msg, "ws", shouldRecord(payload))
          .then(() => {
            if (acknowledge) sendJson(socket, { ok: true });
          })
          .catch((err) => sendJson(socket, { ok: false, error: String(err) }));
      } catch (err) {
        sendJson(socket, { ok: false, error: String(err) });
      }
    });

    socket.onClose(() => {
      clients.delete(client);
    });
  };

  let stopTask: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    if (stopTask) return stopTask;
    stopRequested = true;
    captureRestarting = false;
    captureRestartController?.abort(new Error("server stopping"));
    captureRestartController = null;
    if (status === "streaming") {
      status = "stopped";
      stoppedAt = new Date().toISOString();
    }
    closeClients(1001, "server stopping");
    webRtcPublisher?.close();
    if (watchdog !== null) clock.clearInterval(watchdog);
    if (pendingVideoResetTimer) clearTimeout(pendingVideoResetTimer);
    pendingVideoResetTimer = null;
    pendingVideoResetReason = null;
    removeFatalListener?.();
    removeFatalListener = null;
    stopTask = Promise.allSettled([
      streamSettingsUpdate,
      uploader.close(new Error("server stopping")),
      session.close(),
      deviceState.release(deviceStateOwner, "server stopping"),
    ]).then((results) => {
      const failure = results.slice(1).find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (failure) throw failure.reason;
    });
    return stopTask;
  };

  return {
    get session() {
      return session.rawScrcpy ?? session;
    },
    // Router and new integrations use the source-neutral interface explicitly.
    get streamSession() {
      return session;
    },
    deviceState,
    activateDeviceState,
    isStreaming: () => status === "streaming",
    /** Authoritative settings for the currently active capture generation. */
    getStreamEncoderSettings: (): StreamEncoderSettings => ({
      ...streamEncoderSettings,
    }),
    /** Exact gRPC image mode configured for this app generation. */
    getGrpcImageMode: (): GrpcImageMode => grpcImageMode,
    getEncoder: (): GrpcEncoder => encoder,
    getEncoderName: (): string | null =>
      session.diagnostics?.().grpcCapture?.encoderName ?? null,
    /** Exact input source configured for this app generation. */
    getInputSource: (): InputSource => session.inputSource,
    health,
    webRtcStats,
    handleRequest,
    attachWebSocket,
    stop,
  };
}

/**
 * A live app handle. `session` and `streamSession` always resolve to the active
 * capture generation; integrations must not retain a value read before a
 * successful `/api/stream-settings` update.
 */
export type EmuApp = Awaited<ReturnType<typeof createAppInternal>>;
export type ScrcpyEmuApp = Omit<EmuApp, "session"> & {
  session: ScrcpySession;
};

type RouterStreamSession = Pick<EmuSession, "mode" | "inputSource" | "meta">;

/**
 * Read the backend-neutral session exposed by current apps while continuing to
 * accept older/custom router fakes that only provide the historical `session`.
 */
function streamSessionForApp(app: EmuApp): RouterStreamSession {
  const streamSession = (app as EmuApp & { streamSession?: EmuSession })
    .streamSession;
  if (streamSession) return streamSession;
  const session = app.session as ScrcpySession | EmuSession;
  return "mode" in session
    ? {
        mode: session.mode,
        inputSource:
          "inputSource" in session ? session.inputSource : "scrcpy",
        meta: session.meta,
      }
    : { mode: "scrcpy", inputSource: "scrcpy", meta: session.meta };
}

function deviceStateForApp(app: EmuApp): DeviceSessionState | undefined {
  return (app as EmuApp & { deviceState?: DeviceSessionState }).deviceState;
}

function activateDeviceStateForApp(app: EmuApp): void {
  (
    app as EmuApp & { activateDeviceState?: () => void }
  ).activateDeviceState?.();
}

function streamEncoderSettingsForApp(
  app: EmuApp,
): StreamEncoderSettings | undefined {
  const readSettings = (
    app as EmuApp & {
      getStreamEncoderSettings?: () => StreamEncoderSettings;
    }
  ).getStreamEncoderSettings;
  return readSettings?.();
}

function grpcImageModeForApp(
  app: EmuApp,
  fallback = DEFAULT_GRPC_IMAGE_MODE,
): GrpcImageMode {
  const readMode = (
    app as EmuApp & {
      getGrpcImageMode?: () => GrpcImageMode;
    }
  ).getGrpcImageMode;
  return readMode?.() ?? fallback;
}

function encoderForApp(app: EmuApp, fallback = DEFAULT_GRPC_ENCODER): GrpcEncoder {
  return (app as EmuApp & { getEncoder?: () => GrpcEncoder }).getEncoder?.() ?? fallback;
}

function encoderNameForApp(app: EmuApp): string | null {
  return (app as EmuApp & { getEncoderName?: () => string | null }).getEncoderName?.() ?? null;
}

function inputSourceForApp(app: EmuApp): InputSource {
  const readSource = (
    app as EmuApp & {
      getInputSource?: () => InputSource;
    }
  ).getInputSource;
  return readSource?.() ?? streamSessionForApp(app).inputSource;
}

export function createApp(
  opts: AppOptions & { streamMode?: "scrcpy" },
  dependencies?: CreateAppDependencies,
): Promise<ScrcpyEmuApp>;
export function createApp(
  opts: AppOptions,
  dependencies?: CreateAppDependencies,
): Promise<EmuApp>;
export function createApp(
  opts: AppOptions,
  dependencies: CreateAppDependencies = {},
): Promise<EmuApp> {
  return createAppInternal(opts, dependencies);
}

export type RouterDefaults = Partial<AppOptions>;

export type RouterDependencies = {
  listDevices?: typeof listDevices;
  listAllDevices?: typeof listAllDevices;
  listAvds?: typeof listAvds;
  listRunningAvds?: typeof listRunningAvds;
  resolveRunningAvds?: typeof resolveRunningAvds;
  startEmulator?: typeof startEmulator;
  stopEmulator?: typeof stopEmulator;
  readCameraWiring?: typeof readCameraWiring;
  createApp?: (opts: AppOptions) => Promise<EmuApp>;
  getHardwareEncoderError?: typeof getHardwareEncoderError;
};

/**
 * Multi-device router. Owns a lazily-populated `Map<serial, EmuApp>` and routes
 * each request to the app for its `?device=<serial>` query (falling back to the
 * first available device when absent). The UI shell and the `/api/devices`
 * fleet listing are served without requiring any device. Both `server.ts` (Bun)
 * and the Expo DevTools plugin mount this onto their own transport, so the
 * device-routing logic lives here once rather than in each transport.
 */
export function createRouter(
  defaults: RouterDefaults = {},
  dependencies: RouterDependencies = {},
) {
  const readOnlineDevices = dependencies.listDevices ?? listDevices;
  const readAllDevices = dependencies.listAllDevices ?? listAllDevices;
  const readAvds = dependencies.listAvds ?? listAvds;
  const readRunningAvds = dependencies.listRunningAvds ?? listRunningAvds;
  const resolveAvds = dependencies.resolveRunningAvds ?? resolveRunningAvds;
  const launchEmulator = dependencies.startEmulator ?? startEmulator;
  const killEmulator = dependencies.stopEmulator ?? stopEmulator;
  const readWiring = dependencies.readCameraWiring ?? readCameraWiring;
  const createDeviceApp = dependencies.createApp ?? createApp;
  const hardwareEncoderError = dependencies.getHardwareEncoderError ?? getHardwareEncoderError;
  const apps = new Map<string, EmuApp>();
  const pending = new Map<string, Promise<EmuApp>>();
  const failureAt = new Map<string, number>();
  const streamModeOverrides = new Map<string, StreamMode>();
  const grpcImageModeOverrides = new Map<string, GrpcImageMode>();
  const encoderOverrides = new Map<string, GrpcEncoder>();
  const inputSourceOverrides = new Map<string, InputSource>();
  const streamModeQueues = new Map<string, Promise<void>>();
  const sessionGenerations = new Map<string, number>();
  const operationControllers = new Map<string, Set<AbortController>>();
  const stoppingSerials = new Set<string>();
  let selectedSerial = defaults.serial ?? null;
  let selectionRevision = 0;
  let stopped = false;
  let stopAllTask: Promise<void> | null = null;

  const beginOperation = (
    serial: string,
    parentSignal?: AbortSignal,
  ): {
    signal: AbortSignal;
    finish(): void;
  } => {
    const controller = new AbortController();
    const abortFromParent = () =>
      controller.abort(
        abortError(parentSignal!, `operation for ${serial} was aborted`),
      );
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
    if (parentSignal?.aborted) abortFromParent();
    let controllers = operationControllers.get(serial);
    if (!controllers) {
      controllers = new Set();
      operationControllers.set(serial, controllers);
    }
    controllers.add(controller);
    let finished = false;
    return {
      signal: controller.signal,
      finish() {
        if (finished) return;
        finished = true;
        parentSignal?.removeEventListener("abort", abortFromParent);
        controllers!.delete(controller);
        if (controllers!.size === 0) operationControllers.delete(serial);
      },
    };
  };

  const abortOperations = (serial: string, reason: Error): void => {
    for (const controller of operationControllers.get(serial) ?? []) {
      controller.abort(reason);
    }
  };

  const abortAllOperations = (reason: Error): void => {
    for (const controllers of operationControllers.values()) {
      for (const controller of controllers) controller.abort(reason);
    }
  };

  const initiateAppStop = (app: EmuApp): Promise<void> => {
    try {
      return Promise.resolve(app.stop()).then(
        () => {},
        () => {},
      );
    } catch {
      return Promise.resolve();
    }
  };

  const assertReadyForPublication = (app: EmuApp): void => {
    if (!app.isStreaming()) {
      throw new Error(
        `${streamSessionForApp(app).mode} stopped before publication`,
      );
    }
  };

  // Resolve the serial a request targets: an explicit (connected) `?device=`,
  // else the configured default if still attached, else the first online
  // device. Throws only when *no* device is attached — multiple devices is
  // never an error (we just take the first), so the UI always opens cleanly.
  const resolveSerial = async (
    requested?: string | null,
  ): Promise<string> => {
    const discovered = await readOnlineDevices();
    for (const serial of stoppingSerials) {
      if (!discovered.some((device) => device.serial === serial)) {
        stoppingSerials.delete(serial);
      }
    }
    const online = discovered.filter(
      (device) => !stoppingSerials.has(device.serial),
    );
    if (requested) {
      if (!online.some((d) => d.serial === requested)) {
        throw new Error(`device ${requested} is not connected`);
      }
      return requested;
    }
    if (
      selectedSerial &&
      online.some((device) => device.serial === selectedSerial)
    ) {
      return selectedSerial;
    }
    const first = online[0];
    if (!first) {
      throw new Error("No booted Android device found. Start an emulator or attach a device.");
    }
    selectedSerial = first.serial;
    return first.serial;
  };

  const createConfiguredApp = async (
    serial: string,
    streamMode =
      streamModeOverrides.get(serial) ?? defaults.streamMode ?? "scrcpy",
    parentSignal?: AbortSignal,
    deviceState?: DeviceSessionState,
    encoderSettings?: StreamEncoderSettings,
    grpcImageMode =
      grpcImageModeOverrides.get(serial) ??
      defaults.grpcImageMode ??
      DEFAULT_GRPC_IMAGE_MODE,
    inputSource =
      streamMode === "grpc-screenshot"
        ? inputSourceOverrides.get(serial) ??
          defaults.inputSource ??
          DEFAULT_GRPC_INPUT_SOURCE
        : "scrcpy",
    encoder = encoderOverrides.get(serial) ?? defaults.encoder ?? DEFAULT_GRPC_ENCODER,
  ): Promise<EmuApp> => {
    const operation = beginOperation(serial, parentSignal);
    let created: EmuApp | null = null;
    try {
      throwIfAborted(operation.signal, `app startup for ${serial} was aborted`);
      created = await createDeviceApp({
        ...defaults,
        ...(encoderSettings
          ? {
              maxSize: encoderSettings.maxDimension,
              bitRate: encoderSettings.h264Bitrate,
              maxFps: encoderSettings.h264Fps,
            }
          : {}),
        serial,
        streamMode,
        grpcImageMode,
        encoder,
        inputSource,
        deviceState,
        signal: combineAbortSignals(defaults.signal, operation.signal),
      });
      throwIfAborted(operation.signal, `app startup for ${serial} was aborted`);
      return created;
    } catch (error) {
      if (created) await initiateAppStop(created);
      throw error;
    } finally {
      operation.finish();
    }
  };

  // Get (or lazily start) the app for a serial without joining the stream-mode
  // queue. Queue operations use this helper internally to avoid self-deadlock.
  const getAppUnqueued = (
    serial: string,
    parentSignal?: AbortSignal,
  ): Promise<EmuApp> => {
    if (stopped) return Promise.reject(new Error("serve-emu router is stopped"));
    if (stoppingSerials.has(serial)) {
      return Promise.reject(new Error(`device ${serial} is stopping`));
    }
    const existing = apps.get(serial);
    if (existing?.isStreaming()) return Promise.resolve(existing);
    const inFlight = pending.get(serial);
    if (inFlight) return inFlight;
    if (Date.now() - (failureAt.get(serial) ?? 0) < SPAWN_RETRY_COOLDOWN_MS) {
      return Promise.reject(
        new Error(`serve-emu start for ${serial} is cooling down after a failure`),
      );
    }

    const promise = (async () => {
      if (existing) {
        try {
          await existing.stop();
        } catch {}
        if (apps.get(serial) === existing) apps.delete(serial);
      }
      const created = await createConfiguredApp(
        serial,
        undefined,
        parentSignal,
      );
      if (stopped || stoppingSerials.has(serial)) {
        try {
          await created.stop();
        } catch {}
        throw new Error(
          stopped
            ? "serve-emu router stopped while the device session was starting"
            : `device ${serial} stopped while its session was starting`,
        );
      }
      try {
        assertReadyForPublication(created);
        activateDeviceStateForApp(created);
        assertReadyForPublication(created);
      } catch (error) {
        await initiateAppStop(created);
        throw error;
      }
      sessionGenerations.set(
        serial,
        sessionGenerations.has(serial)
          ? (sessionGenerations.get(serial) ?? 0) + 1
          : 0,
      );
      apps.set(serial, created);
      return created;
    })();
    pending.set(serial, promise);
    promise.then(
      () => {
        if (pending.get(serial) === promise) pending.delete(serial);
      },
      () => {
        if (pending.get(serial) === promise) pending.delete(serial);
        if (!stopped && !stoppingSerials.has(serial)) {
          failureAt.set(serial, Date.now());
        }
      },
    );
    return promise;
  };

  const enqueueStreamModeOperation = <T>(
    serial: string,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    if (stopped) return Promise.reject(new Error("serve-emu router is stopped"));
    const operationLifetime = beginOperation(serial);
    const previous = streamModeQueues.get(serial) ?? Promise.resolve();
    const result = previous.then(() => {
      throwIfAborted(
        operationLifetime.signal,
        `stream operation for ${serial} was aborted`,
      );
      return operation(operationLifetime.signal);
    });
    const tail = result.then(
      () => {},
      () => {},
    );
    streamModeQueues.set(serial, tail);
    void tail.then(() => {
      operationLifetime.finish();
      if (streamModeQueues.get(serial) === tail) {
        streamModeQueues.delete(serial);
      }
    });
    return result;
  };

  // Regular requests wait for an already-queued source transition, ensuring
  // they capture one complete app generation rather than racing publication.
  const getApp = (serial: string): Promise<EmuApp> => {
    const queue = streamModeQueues.get(serial);
    return queue ? queue.then(() => getAppUnqueued(serial)) : getAppUnqueued(serial);
  };

  const performStreamModeSwitch = async (
    serial: string,
    streamMode: StreamMode,
    requestedGrpcImageMode: GrpcImageMode | undefined,
    requestedInputSource: InputSource | undefined,
    requestedEncoder: GrpcEncoder | undefined,
    signal: AbortSignal,
  ): Promise<EmuApp> => {
    if (stopped) throw new Error("serve-emu router is stopped");
    if (stoppingSerials.has(serial)) {
      throw new Error(`device ${serial} is stopping`);
    }
    const inFlight = pending.get(serial);
    if (inFlight) await inFlight.catch(() => {});
    if (stopped) throw new Error("serve-emu router is stopped");
    if (stoppingSerials.has(serial)) {
      throw new Error(`device ${serial} is stopping`);
    }

    const current = apps.get(serial);
    const configuredEncoder = encoderOverrides.get(serial) ?? defaults.encoder ?? DEFAULT_GRPC_ENCODER;
    const currentEncoder = current ? encoderForApp(current, configuredEncoder) : configuredEncoder;
    const encoder = requestedEncoder ?? currentEncoder;
    const configuredGrpcImageMode =
      grpcImageModeOverrides.get(serial) ??
      defaults.grpcImageMode ??
      DEFAULT_GRPC_IMAGE_MODE;
    const currentGrpcImageMode = current
      ? grpcImageModeForApp(current, configuredGrpcImageMode)
      : configuredGrpcImageMode;
    const grpcImageMode =
      requestedGrpcImageMode ?? currentGrpcImageMode;
    const currentMode = current
      ? streamSessionForApp(current).mode
      : streamModeOverrides.get(serial) ?? defaults.streamMode ?? "scrcpy";
    const configuredInputSource =
      inputSourceOverrides.get(serial) ??
      defaults.inputSource ??
      DEFAULT_GRPC_INPUT_SOURCE;
    const currentInputSource = current
      ? inputSourceForApp(current)
      : currentMode === "grpc-screenshot"
        ? configuredInputSource
        : "scrcpy";
    const inputSource =
      streamMode === "scrcpy"
        ? "scrcpy"
        : requestedInputSource ??
          (currentMode === "grpc-screenshot"
            ? currentInputSource
            : configuredInputSource);
    if (
      current?.isStreaming() &&
      currentMode === streamMode &&
      currentGrpcImageMode === grpcImageMode &&
      currentEncoder === encoder &&
      currentInputSource === inputSource
    ) {
      streamModeOverrides.set(serial, streamMode);
      grpcImageModeOverrides.set(serial, grpcImageMode);
      encoderOverrides.set(serial, encoder);
      if (streamMode === "grpc-screenshot") {
        inputSourceOverrides.set(serial, inputSource);
      }
      return current;
    }

    // Hold the shared device state across asynchronous source startup. A fatal
    // from the old source may otherwise release its final owner before the
    // candidate has a chance to acquire it.
    const stagingOwner = {};
    let retainedDeviceState =
      current?.isStreaming() ? deviceStateForApp(current) : undefined;
    if (retainedDeviceState) {
      try {
        retainedDeviceState.acquire(stagingOwner);
      } catch {
        retainedDeviceState = undefined;
      }
    }

    // Stage the requested source while the previous app remains published and
    // its existing sockets continue streaming. Only a ready replacement is
    // made visible; startup failure leaves the working app untouched.
    let replacement: EmuApp;
    try {
      replacement = await createConfiguredApp(
        serial,
        streamMode,
        signal,
        retainedDeviceState,
        current ? streamEncoderSettingsForApp(current) : undefined,
        grpcImageMode,
        inputSource,
        encoder,
      );
    } finally {
      await retainedDeviceState?.release(
        stagingOwner,
        "stream source staging finished",
      );
    }
    if (stopped || stoppingSerials.has(serial)) {
      try {
        await replacement.stop();
      } catch {}
      throw new Error(
        stopped
          ? "serve-emu router stopped while the stream mode was switching"
          : `device ${serial} stopped while its stream mode was switching`,
      );
    }

    const previous = apps.get(serial);
    try {
      assertReadyForPublication(replacement);
      activateDeviceStateForApp(replacement);
      assertReadyForPublication(replacement);
    } catch (error) {
      if (previous?.isStreaming()) activateDeviceStateForApp(previous);
      await initiateAppStop(replacement);
      throw error;
    }
    streamModeOverrides.set(serial, streamMode);
    grpcImageModeOverrides.set(serial, grpcImageMode);
    encoderOverrides.set(serial, encoder);
    if (streamMode === "grpc-screenshot") {
      inputSourceOverrides.set(serial, inputSource);
    }
    failureAt.delete(serial);
    sessionGenerations.set(
      serial,
      sessionGenerations.has(serial)
        ? (sessionGenerations.get(serial) ?? 0) + 1
        : 0,
    );
    apps.set(serial, replacement);
    if (previous && previous !== replacement) {
      try {
        await previous.stop();
      } catch {}
    }
    return replacement;
  };

  const switchStreamMode = (
    serial: string,
    streamMode: StreamMode,
    grpcImageMode?: GrpcImageMode,
    inputSource?: InputSource,
    encoder?: GrpcEncoder,
  ): Promise<EmuApp> =>
    enqueueStreamModeOperation(serial, (signal) =>
      performStreamModeSwitch(
        serial,
        streamMode,
        grpcImageMode,
        inputSource,
        encoder,
        signal,
      ),
    );

  // Resolve + start in one step.
  const ensure = async (requested?: string | null): Promise<{ serial: string; app: EmuApp }> => {
    const serial = await resolveSerial(requested);
    return { serial, app: await getApp(serial) };
  };

  const devicesResponse = async (): Promise<Response> => {
    let defaultSerial: string | null = null;
    try {
      defaultSerial = await resolveSerial(null);
    } catch {
      defaultSerial = null;
    }
    return Response.json({
      ok: true,
      defaultSerial,
      devices: (await readAllDevices()).map((device) => ({
        ...device,
        streaming: apps.get(device.serial)?.isStreaming() ?? false,
      })),
    });
  };

  const streamModeResponse = (
    serial: string,
    app: EmuApp,
  ): StreamModeResponse => ({
    ok: true,
    serial,
    mode: streamSessionForApp(app).mode,
    grpcImageMode: grpcImageModeForApp(
      app,
      grpcImageModeOverrides.get(serial) ??
        defaults.grpcImageMode ??
        DEFAULT_GRPC_IMAGE_MODE,
    ),
    encoder: encoderForApp(app, encoderOverrides.get(serial) ?? defaults.encoder ?? DEFAULT_GRPC_ENCODER),
    encoderName: encoderNameForApp(app),
    availableEncoders: [...GRPC_ENCODERS],
    ...(hardwareEncoderError() ? { hardwareEncoderError: hardwareEncoderError() } : {}),
    inputSource: inputSourceForApp(app),
    availableInputSources:
      streamSessionForApp(app).mode === "grpc-screenshot"
        ? [...INPUT_SOURCES]
        : ["scrcpy"],
    availableModes: availableStreamModesForSerial(serial),
    sessionGeneration: sessionGenerations.get(serial) ?? 0,
  });

  const readRouterPayload = async (req: Request): Promise<Record<string, unknown>> => {
    const payload = await readJsonLimited(req, MAX_JSON_BODY_BYTES);
    if (
      typeof payload !== "object" ||
      payload === null ||
      Array.isArray(payload)
    ) {
      throw new Error("payload must be an object");
    }
    return payload as Record<string, unknown>;
  };

  const selectSerial = async (serial: string): Promise<EmuApp> => {
    const revision = ++selectionRevision;
    const resolved = await resolveSerial(serial);
    const app = await getApp(resolved);
    if (revision !== selectionRevision) {
      throw new Error("device selection was superseded");
    }
    selectedSerial = resolved;
    return app;
  };

  const stopApp = async (serial: string): Promise<void> => {
    stoppingSerials.add(serial);
    abortOperations(
      serial,
      new Error(`device ${serial} is stopping`),
    );

    // Start closing the published app before joining startup/switch promises.
    // Those promises may be waiting for ADB discovery or the first video frame.
    const app = apps.get(serial);
    apps.delete(serial);
    const liveStop = app ? initiateAppStop(app) : Promise.resolve();
    const inFlight = pending.get(serial);
    const sourceQueue = streamModeQueues.get(serial);
    await Promise.allSettled([
      liveStop,
      ...(inFlight ? [inFlight] : []),
      ...(sourceQueue ? [sourceQueue] : []),
    ]);

    // A dependency that ignored cancellation may have completed late. The
    // guarded publication paths normally prevent this, but close defensively.
    const lateApp = apps.get(serial);
    if (lateApp && lateApp !== app) await initiateAppStop(lateApp);
    apps.delete(serial);
    pending.delete(serial);
    failureAt.delete(serial);
    streamModeOverrides.delete(serial);
    grpcImageModeOverrides.delete(serial);
    encoderOverrides.delete(serial);
    inputSourceOverrides.delete(serial);
    streamModeQueues.delete(serial);
    sessionGenerations.delete(serial);
  };

  const activeAppForStats = (requested: string | null): EmuApp | null => {
    if (requested !== null) {
      const app = apps.get(requested);
      return app?.isStreaming() ? app : null;
    }
    if (selectedSerial !== null) {
      const selected = apps.get(selectedSerial);
      if (selected?.isStreaming()) return selected;
    }
    const streamingApps = Array.from(apps.values()).filter((app) =>
      app.isStreaming(),
    );
    if (streamingApps.length > 1) {
      throw new WebRtcStatsRequestError(
        "Multiple devices are streaming. Specify exactly one with ?device=<serial>.",
        "ambiguous_device",
      );
    }
    return streamingApps[0] ?? null;
  };

  const handleRequest = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (
      req.method !== "GET" &&
      req.method !== "HEAD" &&
      req.method !== "OPTIONS" &&
      !isAllowedMutationOrigin(req, defaults)
    ) {
      return Response.json(
        {
          ok: false,
          error: {
            code: "forbidden",
            message: "Browser origin is not allowed to mutate serve-emu state",
          },
        },
        { status: 403 },
      );
    }

    // Statistics are observational: polling must never start or restart scrcpy.
    if (url.pathname === "/webrtc/stats") {
      return handleWebRtcStatsRequest(req, defaults, (sessionId, device) => {
        return activeAppForStats(device)?.webRtcStats(sessionId) ?? null;
      });
    }

    // Fleet endpoint — lists every adb device, so it is not device-scoped.
    if (url.pathname === "/api/devices") {
      if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
      try {
        return await devicesResponse();
      } catch (err) {
        return Response.json({ ok: false, error: errMsg(err) }, { status: 400 });
      }
    }

    // Source changes replace the stream app while retaining its device state,
    // so this endpoint is owned by the router rather than one app generation.
    if (url.pathname === "/api/stream-mode") {
      if (req.method !== "GET" && req.method !== "PUT") {
        return streamModeMethodNotAllowedResponse();
      }
      let serial: string;
      try {
        serial = await resolveSerial(url.searchParams.get("device"));
      } catch (err) {
        return streamModeUnavailableResponse(err);
      }

      if (req.method === "GET") {
        try {
          const app = await enqueueStreamModeOperation(serial, (signal) =>
            getAppUnqueued(serial, signal),
          );
          return Response.json(streamModeResponse(serial, app));
        } catch (err) {
          return streamModeUnavailableResponse(err);
        }
      }

      let streamMode: StreamMode;
      let grpcImageMode: GrpcImageMode | undefined;
      let inputSource: InputSource | undefined;
      let encoder: GrpcEncoder | undefined;
      try {
        const payload = await readRouterPayload(req);
        const streamModeRequest = parseStreamModeRequest(payload);
        const { mode } = streamModeRequest;
        if (mode === "grpc-screenshot" && !isEmulatorSerial(serial)) {
          throw new Error(
            "grpc-screenshot is only available for Android Emulator devices",
          );
        }
        streamMode = mode;
        encoder = streamModeRequest.mode === "grpc-screenshot" ? streamModeRequest.encoder : undefined;
        grpcImageMode =
          streamModeRequest.mode === "grpc-screenshot"
            ? streamModeRequest.grpcImageMode
            : undefined;
        inputSource =
          streamModeRequest.mode === "grpc-screenshot"
            ? streamModeRequest.inputSource
            : undefined;
      } catch (err) {
        return streamModeRequestErrorResponse(err);
      }

      try {
        const app = await switchStreamMode(
          serial,
          streamMode,
          grpcImageMode,
          inputSource,
          encoder,
        );
        return Response.json(streamModeResponse(serial, app));
      } catch (err) {
        return streamModeUnavailableResponse(err);
      }
    }

    // Settings updates restart the active capture just like source changes do.
    // Put both mutations on the same per-device queue so a source replacement
    // cannot snapshot stale settings while a PATCH is still in flight.
    if (
      url.pathname === "/api/stream-settings" &&
      req.method === "PATCH"
    ) {
      try {
        const serial = await resolveSerial(url.searchParams.get("device"));
        return await enqueueStreamModeOperation(serial, async (signal) => {
          const app = await getAppUnqueued(serial, signal);
          return app.handleRequest(req);
        });
      } catch (err) {
        return Response.json(
          { ok: false, error: errMsg(err) },
          { status: 503 },
        );
      }
    }

    if (url.pathname === "/api/device-grid") {
      if (req.method !== "GET") {
        return new Response("method not allowed", { status: 405 });
      }
      let currentSerial = "";
      try {
        currentSerial = await resolveSerial(null);
      } catch {}
      const currentStatus = currentSerial
        ? (apps.get(currentSerial)?.health().status ?? "streaming")
        : "stopped";
      try {
        return Response.json(
          await loadDeviceGrid(currentSerial, currentStatus, {
            listAllDevices: () => readAllDevices(),
            listAvds: () => readAvds(),
            resolveRunningAvds: (devices) => resolveAvds(devices),
          }),
        );
      } catch (err) {
        return Response.json(
          { ok: false, error: errMsg(err) },
          { status: 400 },
        );
      }
    }

    if (url.pathname === "/api/devices/select") {
      if (req.method !== "POST") {
        return new Response("method not allowed", { status: 405 });
      }
      try {
        const payload = await readRouterPayload(req);
        const serial =
          typeof payload.serial === "string" ? payload.serial.trim() : "";
        if (!serial) throw new Error("serial is required");
        const app = await selectSerial(serial);
        return Response.json({
          ok: true,
          serial,
          device: streamSessionForApp(app).meta.deviceName,
        });
      } catch (err) {
        return Response.json(
          { ok: false, error: errMsg(err) },
          { status: 400 },
        );
      }
    }

    if (url.pathname === "/api/avds/start") {
      if (req.method !== "POST") {
        return new Response("method not allowed", { status: 405 });
      }
      try {
        const payload = await readRouterPayload(req);
        const avd = typeof payload.avd === "string" ? payload.avd.trim() : "";
        if (!avd) throw new Error("avd is required");
        const requestedCamera = payload.camera;
        if (requestedCamera !== undefined && typeof requestedCamera !== "boolean") {
          throw new Error("camera must be a boolean");
        }
        const camera = requestedCamera === true;
        const launch = await launchEmulator({ avd, camera });
        stoppingSerials.delete(launch.serial);
        if (camera && !(await cameraLaunchIsWired(launch, readWiring))) {
          throw new Error(
            `AVD "${avd}" is already running, so its camera source cannot be changed; ` +
              "the emulator only reads that flag at startup. Stop it with POST /api/avds/stop first.",
          );
        }
        const select = payload.select !== false;
        if (!select) {
          return Response.json({ ok: true, serial: launch.serial, avd });
        }
        try {
          const app = await selectSerial(launch.serial);
          return Response.json({
            ok: true,
            serial: launch.serial,
            avd,
            device: streamSessionForApp(app).meta.deviceName,
          });
        } catch (err) {
          launch.stop();
          throw err;
        }
      } catch (err) {
        return Response.json(
          { ok: false, error: errMsg(err) },
          { status: 400 },
        );
      }
    }

    if (url.pathname === "/api/avds/stop") {
      if (req.method !== "POST") {
        return new Response("method not allowed", { status: 405 });
      }
      try {
        const payload = await readRouterPayload(req);
        let serial =
          typeof payload.serial === "string" ? payload.serial.trim() : "";
        const avd =
          typeof payload.avd === "string" ? payload.avd.trim() : "";
        if (!serial && avd) {
          const running = await readRunningAvds();
          serial =
            running.find((candidate) => candidate.avd === avd)?.serial ?? "";
        }
        if (!serial) throw new Error("serial or running avd is required");
        if (!isEmulatorSerial(serial)) {
          throw new Error(`${serial} is not an emulator`);
        }
        stoppingSerials.add(serial);
        await stopApp(serial);
        try {
          await killEmulator(serial);
        } catch (err) {
          stoppingSerials.delete(serial);
          throw err;
        }
        if (selectedSerial === serial) {
          selectionRevision++;
          selectedSerial = null;
        }
        return Response.json({ ok: true, serial });
      } catch (err) {
        return Response.json(
          { ok: false, error: errMsg(err) },
          { status: 400 },
        );
      }
    }

    // Camera feeds are files on the host, not device state, so these routes
    // must never start a stream session the way `ensure` would.
    if (isCameraPath(url.pathname)) {
      let serial: string;
      try {
        serial = await resolveSerial(url.searchParams.get("device"));
      } catch (err) {
        return Response.json({ ok: false, error: errMsg(err) }, { status: 503 });
      }
      const response = await handleCameraRequest(req, url, { serial, readWiring });
      if (response) return response;
    }

    // Device-scoped endpoints are `/api`, `/api/*` (other than the fleet listing
    // handled above), and `/health`. Everything else is the device-independent
    // UI shell — serve it (and its 404s) without starting a device, so the page
    // loads before one is selected or attached.
    const deviceScoped =
      url.pathname === "/api" ||
      url.pathname.startsWith("/api/") ||
      url.pathname === "/health" ||
      url.pathname === "/webrtc/offer" ||
      url.pathname === "/webrtc/close";
    if (!deviceScoped) {
      return serveStaticFile(url.pathname) ?? new Response("not found", { status: 404 });
    }

    // Everything else operates on a single device.
    let app: EmuApp;
    try {
      app = (await ensure(url.searchParams.get("device"))).app;
    } catch (err) {
      return Response.json({ ok: false, error: errMsg(err) }, { status: 503 });
    }
    return app.handleRequest(req);
  };

  // Attach a video/gesture socket to an already-resolved, already-started
  // device. The transport ensures the serial before upgrading and passes it
  // here, so the app should exist; close defensively if it raced away.
  const attachWebSocket = (
    socket: StreamSocket,
    opts: { serial: string; frameMeta: boolean; video?: boolean },
  ): void => {
    const app = apps.get(opts.serial);
    if (!app) {
      socket.close(1011, "device not ready");
      return;
    }
    app.attachWebSocket(socket, { frameMeta: opts.frameMeta, video: opts.video });
  };

  const stopAll = (): Promise<void> => {
    if (stopAllTask) return stopAllTask;
    stopped = true;
    abortAllOperations(new Error("serve-emu router is stopping"));

    // Invoke every live stop synchronously before waiting for startup/source
    // transitions to observe cancellation and settle.
    const liveApps = Array.from(new Set(apps.values()));
    apps.clear();
    const liveStops = liveApps.map(initiateAppStop);
    const startupTasks = [...pending.values()];
    const sourceTasks = [...streamModeQueues.values()];
    stopAllTask = (async () => {
      await Promise.allSettled([
        ...liveStops,
        ...startupTasks,
        ...sourceTasks,
      ]);
      // Publication paths reject once `stopped` is true. Close anything a
      // custom dependency nevertheless inserted before clearing bookkeeping.
      await Promise.allSettled(
        Array.from(new Set(apps.values()), initiateAppStop),
      );
      apps.clear();
      pending.clear();
      failureAt.clear();
      streamModeOverrides.clear();
      grpcImageModeOverrides.clear();
      encoderOverrides.clear();
      inputSourceOverrides.clear();
      streamModeQueues.clear();
      sessionGenerations.clear();
      operationControllers.clear();
    })();
    return stopAllTask;
  };

  return {
    resolveSerial,
    getApp,
    ensure,
    handleRequest,
    attachWebSocket,
    stopAll,
  };
}

export type EmuRouter = ReturnType<typeof createRouter>;
