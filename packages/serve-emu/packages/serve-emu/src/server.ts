import { getHardwareEncoderError } from "./h264-encoder.ts";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import type { ServerWebSocket } from "bun";
import {
  CameraInputError,
  cameraLaunchIsWired,
  handleCameraRequest,
  readCameraWiring,
} from "./camera.ts";
import { getExecSnapshot } from "./exec.ts";
import {
  getFontWeight,
  getDisplayDensity,
  getFontScale,
  getHighTextContrast,
  getNetworkStatus,
  getNightMode,
  getReduceMotion,
  getUserRotation,
  listAllDevices,
  screencapPng,
  setFontWeight,
  setDisplayDensity,
  setFontScale,
  setHighTextContrast,
  setNetworkEnabled,
  setNightMode,
  setReduceMotion,
  setUserRotation,
  type NightMode,
  type OrientationMode,
} from "./adb.ts";
import {
  findAccessibilityNode,
  getAccessibilitySnapshot,
  parseAccessibilitySelector,
  type AccessibilitySnapshot,
} from "./accessibility.ts";
import {
  AppManagementError,
  clearAppData,
  forceStopApp,
  grantPermission,
  importMediaFile,
  installApk,
  launchApp,
} from "./app-management.ts";
import { getForegroundApp } from "./app-info.ts";
import {
  terminalTransitionAllowed,
  type SessionStatus,
} from "./session-status.ts";
import {
  FRAME_META_HEADER_BYTES,
  epochNowMs,
  writeFrameMetaHeader,
} from "./shared/frame-meta.ts";
import {
  SCRCPY_DEFAULTS,
  type StartOpts as ScrcpyStartOpts,
  type ScrcpySession,
  ScrcpyStreamError,
} from "./scrcpy.ts";
import {
  adaptScrcpySession,
  startEmuSession,
  type EmuSession,
  type StartEmuSessionOptions,
} from "./stream-session.ts";
import {
  streamModeConflictResponse,
  streamModeMethodNotAllowedResponse,
  streamModeRequestErrorResponse,
  streamModeUnavailableResponse,
} from "./stream-mode-api.ts";
import {
  listAvds,
  listRunningAvds,
  startEmulator,
  stopEmulator,
} from "./emulator.ts";
import {
  parseGesture,
  type Gesture,
} from "./input.ts";
import {
  ControlInputError,
  ControlInputQueue,
} from "./control-input-queue.ts";
import {
  availableStreamModesForSerial,
  isEmulatorSerial,
} from "./device-capabilities.ts";
import {
  parseGeoFix,
  setEmulatorLocationAsync,
  type GeoFix,
} from "./location.ts";
import { parseRoutePlaybackRequest } from "./route-playback.ts";
import {
  parseSessionReplayMultiplier,
  SessionReplayConflictError,
} from "./session-recorder.ts";
import {
  clearSessionReplayResponse,
  sessionReplayErrorResponse,
  startSessionReplayResponse,
  stopSessionReplayResponse,
} from "./session-replay-api.ts";
import {
  ActiveDeviceSession,
  DeviceSessionManager,
  SessionChangedError,
} from "./device-session-context.ts";
import type { DeviceSessionState } from "./device-session-state.ts";
import { routePlaybackErrorResponse } from "./route-playback-api.ts";
import { JsonResponseTracker } from "./json-response.ts";
import { parseSessionPageQuery } from "./session-api.ts";
import {
  SessionRecoveryWatchdog,
  SYSTEM_RECOVERY_WATCHDOG_CLOCK,
  type RecoveryClientState,
  type RecoveryWatchdogClock,
} from "./session-recovery-watchdog.ts";
import {
  MultipartUploadError,
  stageMultipartUpload,
} from "./multipart-upload.ts";
import { HttpBodyError, readJsonLimited } from "./request-body.ts";
import {
  MAX_UPLOAD_QUEUE_TIMEOUT_MS,
  UploadManager,
  UploadManagerError,
  type UploadContext,
  type UploadManagerOptions,
} from "./upload-manager.ts";
import {
  DEFAULT_WEBRTC_STREAM_SETTINGS,
  DEFAULT_STREAM_SETTINGS,
  isJsonRequest,
  parseStreamEncoderSettingsPatch,
  redactedStreamSettings,
  streamEncoderSettingsEqual,
  StreamSettingsUnavailableError,
  viewerTransportsFor,
  type StreamEncoderSettings,
  type StreamEncoderSettingsPatch,
  type StreamSettings,
  type WebRtcStreamSettings,
} from "./stream-settings.ts";
import {
  MAX_WEBRTC_SIGNALING_BODY_BYTES,
  WebRtcSignalingError,
  parseWebRtcCloseRequest,
  parseWebRtcOffer,
} from "./webrtc-signaling.ts";
import {
  createWebRtcPublisher,
  type WebRtcPublisher,
  type WebRtcPublisherOptions,
} from "./webrtc-publisher.ts";
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
  isStreamMode,
  parseDisplayDensityScale,
  parseFontScale,
  parseStreamModeRequest,
  STREAM_MODES,
  type GrpcImageMode,
  type GrpcEncoder,
  type InputSource,
  type StreamMode,
} from "./shared/api-contracts.ts";
import {
  handleWebRtcStatsRequest,
  WebRtcStatsCollector,
} from "./webrtc-stats.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(__dirname, "..", "dist", "ui");

export type ServerOpts = {
  serial: string;
  port: number;
  signal?: AbortSignal;
  /** Address to bind. Defaults to loopback (127.0.0.1). */
  host?: string;
  /**
   * Shared secret required on every request. When empty/undefined, auth is
   * disabled (intended only for loopback binds). Presented via bearer token,
   * the `semu_session` cookie, or a `token` query param.
   */
  token?: string;
  maxFps?: number;
  bitRate?: number;
  maxSize?: number;
  keyFrameInterval?: number;
  repeatFrameMs?: number;
  /** Screen capture source. Defaults to scrcpy. */
  streamMode?: StreamMode;
  /** Emulator gRPC image delivery mode. Defaults to PNG. */
  grpcImageMode?: GrpcImageMode;
  /** Host H.264 encoder for gRPC capture. Defaults to software. */
  encoder?: GrpcEncoder;
  /** Input transport. gRPC streaming defaults to scrcpy input. */
  inputSource?: InputSource;
  maxApkUploadBytes?: number;
  maxMediaUploadBytes?: number;
  maxActiveUploads?: number;
  maxQueuedUploads?: number;
  uploadQueueTimeoutMs?: number;
  /** Default viewer transport. Each browser viewer may select either available path. */
  streamSettings?: StreamSettings;
};

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_MAX_APK_UPLOAD_BYTES = 512 * 1024 * 1024;
export const DEFAULT_MAX_MEDIA_UPLOAD_BYTES = 1024 * 1024 * 1024;
export const DEFAULT_MAX_ACTIVE_UPLOADS = 2;
export const DEFAULT_MAX_QUEUED_UPLOADS = 4;
export const DEFAULT_UPLOAD_QUEUE_TIMEOUT_MS = 5_000;
const MULTIPART_BODY_OVERHEAD_BYTES = 1024 * 1024;
const SESSION_COOKIE = "semu_session";

/** Constant-time string compare that never throws on length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    out[key] = part.slice(idx + 1).trim();
  }
  return out;
}

type GridDeviceKind = "physical" | "emulator" | "avd";

type GridDevice = {
  id: string;
  kind: GridDeviceKind;
  serial: string | null;
  avd: string | null;
  name: string;
  state: string;
  current: boolean;
  canSelect: boolean;
  canStart: boolean;
  canStop: boolean;
};

type DeviceGridResponse = {
  ok: true;
  currentSerial: string;
  sessionStatus: SessionStatus;
  devices: GridDevice[];
};

type WsData = {
  id: number;
  frameMeta: boolean;
  video: boolean;
  context: DeviceContext;
  handle?: Client;
};

type Client = {
  id: number;
  ws: ServerWebSocket<WsData>;
  context: DeviceContext;
  frameMeta: boolean;
  video: boolean;
  sentFrames: number;
  droppedFrames: number;
  backpressureEvents: number;
  awaitingKeyFrame: boolean;
  awaitingKeyFrameSinceMs: number | null;
  lastKeyFrameRequestMs: number | null;
};

type DeviceContext = ActiveDeviceSession<Client>;

type WebRtcPublisherLike = Pick<
  WebRtcPublisher,
  | "activePeerCount"
  | "handleOffer"
  | "closeSession"
  | "sendFrame"
  | "resetVideoSource"
  | "statsForSession"
  | "snapshot"
  | "close"
>;

const MAX_WS_MESSAGE_BYTES = 16 * 1024;
const DROP_FRAME_BUFFERED_BYTES = 512 * 1024;
const CLOSE_CLIENT_BUFFERED_BYTES = 16 * 1024 * 1024;
const VIDEO_RESET_COOLDOWN_MS = 500;
const FIRST_FRAME_RESET_MS = 5000;
const SOURCE_STALL_RESET_MS = 2500;
const AWAITING_KEYFRAME_RESET_MS = 2500;
const MAX_JSON_BODY_BYTES = 8 * 1024;
const MAX_ROUTE_BODY_BYTES = 2 * 1024 * 1024;
const MAX_LOGCAT_QUERY_BYTES = 200;
const MAX_WEBRTC_CLOSE_BODY_BYTES = 4 * 1024;

export type ServerDependencies = {
  openSession?: (options: StartEmuSessionOptions) => Promise<EmuSession>;
  openScrcpy?: (
    serial: string,
    signal?: AbortSignal,
    options?: ScrcpyStartOpts,
  ) => Promise<ScrcpySession>;
  /** @deprecated Prefer openScrcpy. Kept for lifecycle-test compatibility. */
  startScrcpy?: (opts: ScrcpyStartOpts) => Promise<ScrcpySession>;
  serve?: typeof Bun.serve;
  listDevices?: typeof listAllDevices;
  /** @deprecated Prefer listDevices. */
  listAllDevices?: typeof listAllDevices;
  startEmulator?: typeof startEmulator;
  stopEmulator?: typeof stopEmulator;
  listRunningAvds?: typeof listRunningAvds;
  listAvds?: typeof listAvds;
  readCameraWiring?: typeof readCameraWiring;
  loadAccessibility?: (
    serial: string,
    signal: AbortSignal,
  ) => Promise<AccessibilitySnapshot>;
  setLocation?: (
    serial: string,
    fix: GeoFix,
    signal: AbortSignal,
  ) => Promise<void>;
  createInputQueue?: (session: ScrcpySession) => ControlInputQueue;
  recoveryClock?: RecoveryWatchdogClock;
  createUploadManager?: (options: UploadManagerOptions) => UploadManager;
  stageMultipartUpload?: typeof stageMultipartUpload;
  installApk?: typeof installApk;
  importMediaFile?: typeof importMediaFile;
  createWebRtcPublisher?: (
    options: WebRtcPublisherOptions,
  ) => Promise<WebRtcPublisherLike>;
};

function serverLimit(
  value: number | undefined,
  fallback: number,
  name: string,
  allowZero = false,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < (allowZero ? 0 : 1)) {
    throw new Error(
      `${name} must be ${allowZero ? "a non-negative" : "a positive"} safe integer`,
    );
  }
  return resolved;
}

export async function startServer(
  opts: ServerOpts,
  dependencies: ServerDependencies = {},
) {
  const requestedDefaultStreamMode: unknown = opts.streamMode ?? "scrcpy";
  if (!isStreamMode(requestedDefaultStreamMode)) {
    throw new Error(
      `streamMode must be one of: ${STREAM_MODES.join(", ")}`,
    );
  }
  if (
    requestedDefaultStreamMode === "grpc-screenshot" &&
    !isEmulatorSerial(opts.serial)
  ) {
    throw new Error(
      "grpc-screenshot is available only for Android Emulator devices",
    );
  }
  const defaultStreamMode = requestedDefaultStreamMode;
  const requestedDefaultGrpcImageMode: unknown =
    opts.grpcImageMode ?? DEFAULT_GRPC_IMAGE_MODE;
  if (!isGrpcImageMode(requestedDefaultGrpcImageMode)) {
    throw new Error(
      `grpcImageMode must be one of: ${GRPC_IMAGE_MODES.join(", ")}`,
    );
  }
  const defaultGrpcImageMode = requestedDefaultGrpcImageMode;
  const requestedDefaultEncoder: unknown = opts.encoder ?? DEFAULT_GRPC_ENCODER;
  if (!isGrpcEncoder(requestedDefaultEncoder)) {
    throw new Error(`encoder must be one of: ${GRPC_ENCODERS.join(", ")}`);
  }
  const defaultEncoder = requestedDefaultEncoder;
  const requestedDefaultInputSource: unknown =
    opts.inputSource ?? DEFAULT_GRPC_INPUT_SOURCE;
  if (!isInputSource(requestedDefaultInputSource)) {
    throw new Error(`inputSource must be one of: ${INPUT_SOURCES.join(", ")}`);
  }
  const defaultInputSource = requestedDefaultInputSource;
  const serve = dependencies.serve ?? Bun.serve;
  const listDevices =
    dependencies.listDevices ?? dependencies.listAllDevices ?? listAllDevices;
  const launchEmulator = dependencies.startEmulator ?? startEmulator;
  const killEmulator = dependencies.stopEmulator ?? stopEmulator;
  const listActiveAvds = dependencies.listRunningAvds ?? listRunningAvds;
  const availableAvds = dependencies.listAvds ?? listAvds;
  const readWiring = dependencies.readCameraWiring ?? readCameraWiring;
  const loadAccessibility =
    dependencies.loadAccessibility ??
    ((serial: string, signal: AbortSignal) =>
      getAccessibilitySnapshot(serial, signal));
  const setLocation =
    dependencies.setLocation ??
    ((serial: string, fix: GeoFix, signal: AbortSignal) =>
      setEmulatorLocationAsync(serial, fix, signal));
  const createInputQueue =
    dependencies.createInputQueue ??
    ((session: ScrcpySession) =>
      new ControlInputQueue({ socket: session.controlSocket }));
  const openSession =
    dependencies.openSession ??
    (async (options: StartEmuSessionOptions) => {
      if (
        options.mode === "scrcpy" &&
        (dependencies.openScrcpy || dependencies.startScrcpy)
      ) {
        const raw = dependencies.openScrcpy
          ? await dependencies.openScrcpy(
              options.serial,
              options.signal,
              options,
            )
          : await dependencies.startScrcpy!(options);
        try {
          return adaptScrcpySession(raw, createInputQueue(raw));
        } catch (error) {
          await Promise.resolve(raw.close()).catch(() => {});
          throw error;
        }
      }
      return startEmuSession(options);
    });
  const recoveryClock =
    dependencies.recoveryClock ?? SYSTEM_RECOVERY_WATCHDOG_CLOCK;
  const stageUpload =
    dependencies.stageMultipartUpload ?? stageMultipartUpload;
  const installStagedApk = dependencies.installApk ?? installApk;
  const importStagedMedia = dependencies.importMediaFile ?? importMediaFile;
  const openWebRtcPublisher =
    dependencies.createWebRtcPublisher ?? createWebRtcPublisher;
  const maxApkUploadBytes = serverLimit(
    opts.maxApkUploadBytes,
    DEFAULT_MAX_APK_UPLOAD_BYTES,
    "maxApkUploadBytes",
  );
  const maxMediaUploadBytes = serverLimit(
    opts.maxMediaUploadBytes,
    DEFAULT_MAX_MEDIA_UPLOAD_BYTES,
    "maxMediaUploadBytes",
  );
  const maxActiveUploads = serverLimit(
    opts.maxActiveUploads,
    DEFAULT_MAX_ACTIVE_UPLOADS,
    "maxActiveUploads",
  );
  const maxQueuedUploads = serverLimit(
    opts.maxQueuedUploads,
    DEFAULT_MAX_QUEUED_UPLOADS,
    "maxQueuedUploads",
    true,
  );
  const uploadQueueTimeoutMs = serverLimit(
    opts.uploadQueueTimeoutMs,
    DEFAULT_UPLOAD_QUEUE_TIMEOUT_MS,
    "uploadQueueTimeoutMs",
    true,
  );
  if (uploadQueueTimeoutMs > MAX_UPLOAD_QUEUE_TIMEOUT_MS) {
    throw new Error(
      `uploadQueueTimeoutMs must be at most ${MAX_UPLOAD_QUEUE_TIMEOUT_MS}`,
    );
  }
  const maxUploadFileBytes = Math.max(
    maxApkUploadBytes,
    maxMediaUploadBytes,
  );
  if (
    maxUploadFileBytes >
    Number.MAX_SAFE_INTEGER - MULTIPART_BODY_OVERHEAD_BYTES * 2
  ) {
    throw new Error("upload byte limit is too large");
  }
  const maxRequestBodySize = Math.max(
    maxUploadFileBytes + MULTIPART_BODY_OVERHEAD_BYTES * 2,
    MAX_ROUTE_BODY_BYTES,
  );
  const uploads = (
    dependencies.createUploadManager ??
    ((options: UploadManagerOptions) => new UploadManager(options))
  )({
    maxActive: maxActiveUploads,
    maxQueued: maxQueuedUploads,
    queueTimeoutMs: uploadQueueTimeoutMs,
  });

  const host = opts.host ?? DEFAULT_HOST;
  const authToken = opts.token && opts.token.length > 0 ? opts.token : null;
  const streamSettings = opts.streamSettings ?? DEFAULT_STREAM_SETTINGS;
  const webRtcStreamSettings: WebRtcStreamSettings =
    streamSettings.transport === "webrtc"
      ? streamSettings
      : DEFAULT_WEBRTC_STREAM_SETTINGS;
  const streamModes = new Map<string, StreamMode>();
  const grpcImageModes = new Map<string, GrpcImageMode>();
  const encoders = new Map<string, GrpcEncoder>();
  const contextEncoders = new WeakMap<DeviceContext, GrpcEncoder>();
  const inputSources = new Map<string, InputSource>();
  const contextGrpcImageModes = new WeakMap<DeviceContext, GrpcImageMode>();
  const defaultStreamEncoderSettings: StreamEncoderSettings = {
    maxDimension: opts.maxSize ?? SCRCPY_DEFAULTS.maxSize,
    h264Bitrate: opts.bitRate ?? SCRCPY_DEFAULTS.bitRate,
    h264Fps: opts.maxFps ?? SCRCPY_DEFAULTS.maxFps,
  };
  const streamEncoderSettings = new Map<string, StreamEncoderSettings>();

  const encoderSettingsForSerial = (serial: string): StreamEncoderSettings =>
    streamEncoderSettings.get(serial) ?? defaultStreamEncoderSettings;

  const modeForSerial = (serial: string): StreamMode =>
    streamModes.get(serial) ??
    (isEmulatorSerial(serial) ? defaultStreamMode : "scrcpy");
  const grpcImageModeForSerial = (serial: string): GrpcImageMode =>
    grpcImageModes.get(serial) ?? defaultGrpcImageMode;
  const encoderForSerial = (serial: string): GrpcEncoder =>
    encoders.get(serial) ?? defaultEncoder;
  const inputSourceForSerial = (
    serial: string,
    mode: StreamMode,
  ): InputSource =>
    mode === "grpc-screenshot"
      ? inputSources.get(serial) ?? defaultInputSource
      : "scrcpy";

  const openStream = (
    serial: string,
    mode: StreamMode,
    signal?: AbortSignal,
    encoderSettings = encoderSettingsForSerial(serial),
    grpcImageMode = grpcImageModeForSerial(serial),
    inputSource = inputSourceForSerial(serial, mode),
    encoder = encoderForSerial(serial),
  ) =>
    openSession({
      serial,
      mode,
      grpcImageMode,
      encoder,
      inputSource,
      signal,
      maxFps: encoderSettings.h264Fps,
      bitRate: encoderSettings.h264Bitrate,
      maxSize: encoderSettings.maxDimension,
      keyFrameInterval: opts.keyFrameInterval,
      repeatFrameMs: opts.repeatFrameMs,
    });

  /** Token presented by the request, from bearer header, cookie, or query. */
  const presentedToken = (req: Request, url: URL): string | null => {
    const authorization = req.headers.get("authorization");
    if (authorization && authorization.startsWith("Bearer ")) {
      return authorization.slice("Bearer ".length).trim();
    }
    const cookie = parseCookies(req.headers.get("cookie"))[SESSION_COOKIE];
    if (cookie) return cookie;
    return url.searchParams.get("token");
  };

  const tokenValid = (req: Request, url: URL): boolean => {
    if (!authToken) return true;
    const presented = presentedToken(req, url);
    return presented !== null && safeEqual(presented, authToken);
  };

  /**
   * Same-origin guard for state-changing requests and the WebSocket upgrade.
   * A missing Origin means a non-browser client (CLI/agent), which is gated by
   * the token check instead. A present Origin must match the request Host.
   */
  const originAllowed = (req: Request): boolean => {
    const origin = req.headers.get("origin");
    if (!origin) return true;
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return false;
    }
    return originHost === req.headers.get("host");
  };

  const createContext = (
    serial: string,
    generation: number,
    stream: EmuSession,
    deviceState?: DeviceSessionState,
    grpcImageMode = grpcImageModeForSerial(serial),
    encoder = encoderForSerial(serial),
  ): DeviceContext => {
    const context = new ActiveDeviceSession<Client>({
      serial,
      generation,
      stream,
      applyLocation: setLocation,
      deviceState,
    });
    context.registerCleanup(() =>
      uploads.cancelGeneration(
        generation,
        new UploadManagerError(
          "device-session-changed",
          `device session ${generation} is no longer active`,
          { serial, generation },
        ),
      ),
    );
    contextGrpcImageModes.set(context, grpcImageMode);
    contextEncoders.set(context, encoder);
    return context;
  };

  const initialMode = modeForSerial(opts.serial);
  const initialStream = await openStream(opts.serial, initialMode, opts.signal);
  let initialContext: DeviceContext;
  try {
    initialContext = createContext(opts.serial, 0, initialStream);
  } catch (err) {
    await initialStream.close().catch(() => {});
    throw err;
  }
  streamModes.set(opts.serial, initialMode);
  grpcImageModes.set(opts.serial, defaultGrpcImageMode);
  encoders.set(opts.serial, defaultEncoder);
  inputSources.set(opts.serial, defaultInputSource);
  const sessions = new DeviceSessionManager(initialContext);
  const recoveries = new WeakMap<
    DeviceContext,
    SessionRecoveryWatchdog<RecoveryClientState>
  >();
  const publishers = new WeakMap<DeviceContext, WebRtcPublisherLike>();
  const webRtcStatsCollectors = new WeakMap<
    DeviceContext,
    WebRtcStatsCollector
  >();
  const webRtcStatsCollectorFor = (context: DeviceContext) => {
    const existing = webRtcStatsCollectors.get(context);
    if (existing) return existing;
    const created = new WebRtcStatsCollector(() => recoveryClock.now());
    webRtcStatsCollectors.set(context, created);
    return created;
  };
  const publisherTasks = new WeakMap<
    DeviceContext,
    Promise<WebRtcPublisherLike>
  >();
  const webRtcRecoveryStates = new WeakMap<
    DeviceContext,
    RecoveryClientState
  >();
  const responseMetrics = new JsonResponseTracker(
    ["health", "sessionPage", "sessionExport"] as const,
  );
  let stopRequested = false;
  console.log(
    `${initialMode} ready: ${initialStream.meta.deviceName} • ${initialStream.meta.codecId} • ${initialStream.meta.width}×${initialStream.meta.height}`,
  );

  const health = (context = sessions.current) => {
    const now = recoveryClock.now();
    const recovery = recoveries.get(context);
    const recoverySnapshot = recovery?.snapshot(now) ?? {
      sourceFps: 0,
      lastFrameMs: null,
      sourceFrameAgeMs: Math.max(0, now - context.startedMs),
      awaitingClients: 0,
      oldestAwaitingAgeMs: null,
      lastResetAttemptMs: null,
    };
    return {
    ok: context.status === "streaming",
    status: context.status,
    generation: context.generation,
    sessionGeneration: context.generation,
    serial: context.serial,
    device: context.stream.meta.deviceName,
    codec: context.stream.meta.codecId,
    streamMode: context.stream.mode,
    grpcImageMode: grpcImageModeForContext(context),
    encoder: encoderForContext(context),
    encoderName: context.stream.diagnostics?.().grpcCapture?.encoderName ?? null,
    inputSource: context.stream.inputSource,
    grpcCapture: context.stream.diagnostics?.().grpcCapture ?? null,
    size: { width: context.screen.width, height: context.screen.height },
    clients: context.clients.size,
    videoClients: Array.from(context.clients).filter((client) => client.video)
      .length,
    stream: redactedStreamSettings(streamSettings),
    encoderSettings: { ...encoderSettingsForSerial(context.serial) },
    webrtc: publishers.get(context)?.snapshot() ?? null,
    frames: context.frameCount,
    sourceFps: recoverySnapshot.sourceFps,
    sourceFrameAgeMs: recoverySnapshot.sourceFrameAgeMs,
    keyFrameRecovery: {
      awaitingClients: recoverySnapshot.awaitingClients,
      oldestAwaitingAgeMs: recoverySnapshot.oldestAwaitingAgeMs,
      lastResetAttemptAt:
        recoverySnapshot.lastResetAttemptMs === null
          ? null
          : new Date(recoverySnapshot.lastResetAttemptMs).toISOString(),
    },
    frameStats: context.frameStats.summary(),
    configPackets: context.configPacketCount,
    droppedFrames: context.totalDroppedFrames,
    backpressureEvents: context.totalBackpressureEvents,
    videoResetRequests: context.videoResetRequests,
    lastVideoResetAt: context.lastVideoResetAt,
    lastVideoResetReason: context.lastVideoResetReason,
    location: context.lastLocation,
    route: context.route.snapshot(),
    session: context.recorder.summary(),
    responseMetrics: responseMetrics.snapshot(),
    logcat: context.logcat.snapshot(),
    uploads: uploads.snapshot(),
    executor: getExecSnapshot(),
    clientsDetail: Array.from(context.clients, (client) => ({
      id: client.id,
      frameMeta: client.frameMeta,
      video: client.video,
      sentFrames: client.sentFrames,
      droppedFrames: client.droppedFrames,
      backpressureEvents: client.backpressureEvents,
      bufferedBytes: client.ws.getBufferedAmount(),
      awaitingKeyFrame: client.awaitingKeyFrame,
      awaitingKeyFrameSinceAt:
        client.awaitingKeyFrameSinceMs === null
          ? null
          : new Date(client.awaitingKeyFrameSinceMs).toISOString(),
      awaitingKeyFrameAgeMs:
        client.awaitingKeyFrameSinceMs === null
          ? null
          : Math.max(0, now - client.awaitingKeyFrameSinceMs),
      lastKeyFrameRequestAt:
        client.lastKeyFrameRequestMs === null
          ? null
          : new Date(client.lastKeyFrameRequestMs).toISOString(),
    })),
    startedAt: context.startedAt,
    stoppedAt: context.stoppedAt,
    lastFrameAt:
      recoverySnapshot.lastFrameMs === null
        ? null
        : new Date(recoverySnapshot.lastFrameMs).toISOString(),
    lastError: context.lastError,
    lastErrorCode: context.lastErrorCode,
    lastErrorMeta: context.lastErrorMeta,
  };
  };

  const webRtcStats = (context: DeviceContext, sessionId: string) => {
    const publisher = publishers.get(context);
    if (context.status !== "streaming" || !publisher) {
      return null;
    }
    const sourceFps = recoveries.get(context)?.snapshot(recoveryClock.now()).sourceFps ?? 0;
    const encoderSettings = encoderSettingsForSerial(context.serial);
    return webRtcStatsCollectorFor(context).report(
      {
        streamMode: context.stream.mode,
        codec: context.stream.meta.codecId,
        width: context.screen.width,
        height: context.screen.height,
        frames: context.frameCount,
        fps: sourceFps,
        configuredFps: encoderSettings.h264Fps,
        configuredBitrateBps: encoderSettings.h264Bitrate,
        frameStats: context.frameStats.summary(),
      },
      publisher,
      sessionId,
      context.stream.diagnostics?.().grpcCapture ?? null,
    );
  };

  const deviceGrid = async (
    context: DeviceContext,
  ): Promise<DeviceGridResponse> => {
    const [adbDevices, runningAvds, avds] = await Promise.all([
      listDevices(),
      listActiveAvds(),
      availableAvds(),
    ]);
    sessions.assertPublished(context);
    const runningBySerial = new Map(
      runningAvds.map((running) => [running.serial, running]),
    );
    const runningByAvd = new Map(
      runningAvds.map((running) => [running.avd, running]),
    );
    const rows: GridDevice[] = adbDevices.map((device) => {
      const running = runningBySerial.get(device.serial);
      const isEmulator = isEmulatorSerial(device.serial);
      return {
        id: device.serial,
        kind: isEmulator ? "emulator" : "physical",
        serial: device.serial,
        avd: running?.avd ?? null,
        name: running?.avd ?? device.serial,
        state: device.state,
        current: device.serial === context.serial,
        canSelect: device.state === "device",
        canStart: false,
        canStop: isEmulator,
      };
    });

    const knownAvdSerials = new Set(
      runningAvds.map((running) => running.serial),
    );
    for (const avd of avds) {
      const running = runningByAvd.get(avd);
      if (running && knownAvdSerials.has(running.serial)) continue;
      rows.push({
        id: `avd:${avd}`,
        kind: "avd",
        serial: running?.serial ?? null,
        avd,
        name: avd,
        state: running?.state ?? "stopped",
        current: running?.serial === context.serial,
        canSelect: running?.state === "device",
        canStart: !running,
        canStop: Boolean(running),
      });
    }

    return {
      ok: true,
      currentSerial: context.serial,
      sessionStatus: context.status,
      devices: rows,
    };
  };

  const markTerminal = (
    context: DeviceContext,
    nextStatus: Exclude<SessionStatus, "streaming">,
    reason: string,
    detail?: { code?: string; meta?: Record<string, string | number> | null },
  ) => {
    if (sessions.current !== context) return;
    if (!terminalTransitionAllowed(context.status, nextStatus)) return;
    context.terminalTransitionStarted = true;
    context.status = nextStatus;
    context.lastError = reason;
    context.lastErrorCode = detail?.code ?? null;
    context.lastErrorMeta = detail?.meta ?? null;
    void context.dispose(reason, {
      status: nextStatus,
      clientCode: nextStatus === "error" ? 1011 : 1000,
    });
  };

  const sendJson = (ws: ServerWebSocket<WsData>, value: unknown) => {
    try {
      ws.send(JSON.stringify(value));
    } catch {}
  };

  const withFrameMeta = (
    frameData: Buffer,
    frame: { pts: bigint; isKey: boolean },
    config: Buffer | null,
  ): Buffer => {
    const configBytes = config?.length ?? 0;
    const out = Buffer.allocUnsafe(
      FRAME_META_HEADER_BYTES + configBytes + frameData.length,
    );
    writeFrameMetaHeader(out, {
      isKey: frame.isKey,
      pts: frame.pts,
      serverTsMs: epochNowMs(),
    });
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
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return true;
    return (value as Record<string, unknown>).ack !== false;
  };

  const isResetVideoRequest = (value: unknown) =>
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).type === "reset-video";

  const readJsonBody = async (
    req: Request,
    maxBytes = MAX_JSON_BODY_BYTES,
    context?: DeviceContext,
    requireUsableContext = true,
  ): Promise<unknown> => {
    const value = await readJsonLimited(req, maxBytes);
    if (context) {
      if (requireUsableContext) sessions.assertCurrent(context);
      else sessions.assertPublished(context);
    }
    return value;
  };

  const errorResponse = (err: unknown, fallbackStatus = 400) => {
    const error = err instanceof Error ? err.message : String(err);
    if (err instanceof SessionChangedError) {
      return Response.json(
        { ok: false, code: err.code, error },
        { status: 409 },
      );
    }
    let status = fallbackStatus;
    let code: string | undefined;
    if (err instanceof HttpBodyError) {
      status = err.status;
      code = err.code;
    } else if (err instanceof CameraInputError) {
      status = err.status;
    } else if (err instanceof WebRtcSignalingError) {
      status = err.status;
      code = err.code;
    } else if (err instanceof MultipartUploadError) {
      status = err.status;
      code = err.code;
    } else if (err instanceof UploadManagerError) {
      const mapped = {
        "queue-full": { status: 429, code: "upload-queue-full" },
        "queue-timeout": { status: 503, code: "upload-queue-timeout" },
        "upload-cancelled": { status: 499, code: "upload-cancelled" },
        "device-session-changed": {
          status: 409,
          code: "device-session-changed",
        },
        closed: { status: 503, code: "upload-service-closed" },
      } as const;
      status = mapped[err.code].status;
      code = mapped[err.code].code;
    } else if (err instanceof AppManagementError) {
      status = err.code === "adb-timeout" ? 504 : 502;
      code = err.code;
    }
    return Response.json(
      { ok: false, ...(code ? { code } : {}), error },
      { status },
    );
  };

  const inputErrorPayload = (
    err: unknown,
    status: "rejected" | "failed",
  ) => ({
    ok: false as const,
    status,
    ...(err instanceof ControlInputError ? { code: err.code } : {}),
    error: err instanceof Error ? err.message : String(err),
  });

  const inputErrorResponse = (
    err: unknown,
    status: "rejected" | "failed",
  ) => {
    if (err instanceof HttpBodyError) return errorResponse(err);
    return Response.json(inputErrorPayload(err, status), {
      status:
        err instanceof ControlInputError &&
        err.code === "control-queue-overloaded"
          ? 429
          : err instanceof ControlInputError
            ? 503
            : 400,
    });
  };

  const runForContext = async <T>(
    context: DeviceContext,
    operation: (captured: DeviceContext) => Promise<T>,
  ): Promise<T> => {
    sessions.assertCurrent(context);
    const result = await operation(context);
    sessions.assertCurrent(context);
    return result;
  };

  const runForPublishedContext = async <T>(
    context: DeviceContext,
    operation: (captured: DeviceContext) => Promise<T>,
  ): Promise<T> => {
    sessions.assertPublished(context);
    const result = await operation(context);
    sessions.assertPublished(context);
    return result;
  };

  const shouldRecord = (value: unknown) =>
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).record !== false;

  const readAccessibilitySnapshot = async (
    context: DeviceContext,
    cacheMs = 2_500,
  ) => {
    const snapshot = await context.readAccessibilitySnapshot(
      loadAccessibility,
      cacheMs,
    );
    sessions.assertCurrent(context);
    return snapshot;
  };

  const enqueueGesture = (
    context: DeviceContext,
    gesture: Gesture,
    source: string,
    record = true,
  ) => {
    sessions.assertCurrent(context);
    if (context.status !== "streaming") {
      throw new Error(`session is ${context.status}`);
    }
    const accepted = context.inputQueue.enqueue(gesture, { ...context.screen });
    if (record) context.recorder.recordGesture(accepted.gesture, source);
    return accepted;
  };

  const dispatchGesture = (
    context: DeviceContext,
    gesture: Gesture,
    source: string,
    record = true,
  ) => enqueueGesture(context, gesture, source, record).completion;

  const applyLocation = async (
    context: DeviceContext,
    fix: GeoFix,
    source: string,
    record = true,
  ) => {
    sessions.assertCurrent(context);
    context.route.stop();
    await setLocation(context.serial, fix, context.signal);
    sessions.assertCurrent(context);
    context.lastLocation = { ...fix, appliedAt: new Date().toISOString() };
    if (record) context.recorder.recordLocation(fix, source);
    return context.lastLocation;
  };

  const logcatStream = (context: DeviceContext, req: Request, url: URL) => {
    const packageName = (url.searchParams.get("package") ?? "")
      .trim()
      .slice(0, MAX_LOGCAT_QUERY_BYTES);
    const search = (url.searchParams.get("search") ?? "")
      .trim()
      .slice(0, MAX_LOGCAT_QUERY_BYTES)
      .toLowerCase();
    return context.logcat.subscribe({ packageName, search }, req.signal);
  };

  const gestureEndpoint = async (
    context: DeviceContext,
    req: Request,
    type: Gesture["type"],
    source: string,
  ) => {
    try {
      const payload = await readJsonBody(req, MAX_JSON_BODY_BYTES, context);
      const gesture = parseGesture(
        typeof payload === "object" &&
          payload !== null &&
          !Array.isArray(payload)
          ? { ...payload, type }
          : payload,
      );
      const accepted = enqueueGesture(
        context,
        gesture,
        source,
        shouldRecord(payload),
      );
      try {
        const result = await accepted.completion;
        return Response.json({ ok: true, status: result.status });
      } catch (err) {
        return inputErrorResponse(err, "failed");
      }
    } catch (err) {
      return inputErrorResponse(err, "rejected");
    }
  };

  const keyEndpoint = async (context: DeviceContext, req: Request) => {
    try {
      const payload = await readJsonBody(req, MAX_JSON_BODY_BYTES, context);
      if (
        typeof payload !== "object" ||
        payload === null ||
        Array.isArray(payload)
      ) {
        throw new Error("key payload must be an object");
      }
      const key = (payload as Record<string, unknown>).key;
      const gesture =
        key === "back" || key === "home" || key === "recents" || key === "power"
          ? parseGesture({ type: key })
          : parseGesture({ ...payload, type: "key" });
      const accepted = enqueueGesture(
        context,
        gesture,
        "rest:key",
        shouldRecord(payload),
      );
      try {
        const result = await accepted.completion;
        return Response.json({ ok: true, status: result.status });
      } catch (err) {
        return inputErrorResponse(err, "failed");
      }
    } catch (err) {
      return inputErrorResponse(err, "rejected");
    }
  };

  const accessibilityTapEndpoint = async (
    context: DeviceContext,
    req: Request,
  ) => {
    try {
      const payload = await readJsonBody(req, MAX_JSON_BODY_BYTES, context);
      if (
        typeof payload !== "object" ||
        payload === null ||
        Array.isArray(payload)
      ) {
        throw new Error("accessibility tap payload must be an object");
      }
      const body = payload as Record<string, unknown>;
      const selector = parseAccessibilitySelector(body.selector ?? body);
      const snapshot = await readAccessibilitySnapshot(context, 1_000);
      const node = findAccessibilityNode(snapshot.nodes, selector);
      const centerX = (node.bounds.left + node.bounds.right) / 2;
      const centerY = (node.bounds.top + node.bounds.bottom) / 2;
      const accessibilityWidth = Math.max(
        ...snapshot.nodes.map((n) => n.bounds.right),
        context.screen.width,
      );
      const accessibilityHeight = Math.max(
        ...snapshot.nodes.map((n) => n.bounds.bottom),
        context.screen.height,
      );
      const x = centerX / accessibilityWidth;
      const y = centerY / accessibilityHeight;
      if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        x < 0 ||
        x > 1 ||
        y < 0 ||
        y > 1
      ) {
        throw new Error(
          "matched accessibility node is outside the current stream bounds",
        );
      }
      const accepted = enqueueGesture(
        context,
        {
          type: "tap",
          x,
          y,
        },
        "accessibility:tap",
        shouldRecord(payload),
      );
      try {
        const result = await accepted.completion;
        return Response.json({
          ok: true,
          status: result.status,
          node,
          capturedAt: snapshot.capturedAt,
        });
      } catch (err) {
        return inputErrorResponse(err, "failed");
      }
    } catch (err) {
      return inputErrorResponse(err, "rejected");
    }
  };

  const appJsonEndpoint = async (
    context: DeviceContext,
    req: Request,
    action: (payload: Record<string, unknown>) => unknown | Promise<unknown>,
  ) => {
    try {
      const payload = await readJsonBody(req, MAX_JSON_BODY_BYTES, context);
      if (
        typeof payload !== "object" ||
        payload === null ||
        Array.isArray(payload)
      ) {
        throw new Error("payload must be an object");
      }
      const result = await action(payload as Record<string, unknown>);
      sessions.assertCurrent(context);
      return Response.json(result);
    } catch (err) {
      return errorResponse(err);
    }
  };

  const uploadEndpoint = async (
    context: DeviceContext,
    req: Request,
    options: {
      fieldName: "apk" | "file";
      maxFileBytes: number;
      action: (
        serial: string,
        file: Awaited<ReturnType<typeof stageUpload>>,
        signal: AbortSignal,
      ) => Promise<unknown>;
    },
  ) => {
    try {
      const uploadContext: UploadContext = {
        serial: context.serial,
        generation: context.generation,
      };
      const result = await uploads.run(
        {
          context: uploadContext,
          requestSignal: req.signal,
          sessionSignal: context.signal,
        },
        async ({ context: acceptedContext, signal }) => {
          const staged = await stageUpload(req, {
            fieldName: options.fieldName,
            maxFileBytes: options.maxFileBytes,
            maxBodyBytes:
              options.maxFileBytes + MULTIPART_BODY_OVERHEAD_BYTES,
            signal,
          });
          try {
            sessions.assertCurrent(context);
            if (
              acceptedContext.serial !== context.serial ||
              acceptedContext.generation !== context.generation
            ) {
              throw new UploadManagerError(
                "device-session-changed",
                "device session changed during upload",
                acceptedContext,
              );
            }
            return await options.action(context.serial, staged, signal);
          } finally {
            try {
              await staged.cleanup();
            } catch (error) {
              throw new MultipartUploadError(
                "upload-cleanup-failed",
                "failed to clean up multipart upload",
                { cause: error },
              );
            }
          }
        },
      );
      return Response.json(result);
    } catch (error) {
      if (req.body && !req.body.locked) {
        await req.body.cancel(error).catch(() => {});
      }
      return errorResponse(error);
    }
  };

  const installEndpoint = (context: DeviceContext, req: Request) =>
    uploadEndpoint(context, req, {
      fieldName: "apk",
      maxFileBytes: maxApkUploadBytes,
      action: (serial, file, signal) =>
        installStagedApk(serial, file, signal),
    });

  const fileImportEndpoint = (context: DeviceContext, req: Request) =>
    uploadEndpoint(context, req, {
      fieldName: "file",
      maxFileBytes: maxMediaUploadBytes,
      action: (serial, file, signal) =>
        importStagedMedia(serial, file, signal),
    });

  const enqueueVideoReset = (context: DeviceContext, reason: string) => {
    sessions.assertCurrent(context);
    context.inputQueue.assertOpen();
    const now = Date.now();
    if (now - context.lastVideoResetMs < VIDEO_RESET_COOLDOWN_MS) {
      return { completion: Promise.resolve({ status: "coalesced" as const }) };
    }
    const accepted = context.inputQueue.enqueueVideoReset();
    context.lastVideoResetMs = now;
    context.videoResetRequests++;
    context.lastVideoResetAt = new Date(now).toISOString();
    context.lastVideoResetReason = reason;
    return accepted;
  };

  const requestVideoReset = (context: DeviceContext, reason: string) => {
    try {
      return enqueueVideoReset(context, reason).completion;
    } catch (err) {
      return Promise.reject(err);
    }
  };

  const publisherFor = (
    context: DeviceContext,
  ): Promise<WebRtcPublisherLike> => {
    if (context.stream.meta.codecId !== webRtcStreamSettings.codec) {
      return Promise.reject(
        new WebRtcSignalingError(
          `WebRTC requires ${webRtcStreamSettings.codec.toUpperCase()} video, but ${context.stream.mode} negotiated ${context.stream.meta.codecId}`,
          409,
          "webrtc_codec_unavailable",
        ),
      );
    }
    const publisher = publishers.get(context);
    if (publisher) return Promise.resolve(publisher);
    const pending = publisherTasks.get(context);
    if (pending) return pending;

    const task = openWebRtcPublisher({
      settings: webRtcStreamSettings,
      onKeyframeRequest: (reason) => {
        const recovery = recoveries.get(context);
        const webRtcState = webRtcRecoveryStates.get(context);
        if (recovery && webRtcState) {
          recovery.markAwaiting(webRtcState);
          recovery.requestVideoReset(reason);
          return;
        }
        void requestVideoReset(context, reason).catch(() => {});
      },
    })
      .then((created) => {
        try {
          sessions.assertCurrent(context);
        } catch (error) {
          created.close();
          throw error;
        }
        publishers.set(context, created);
        context.registerCleanup(() => created.close());
        return created;
      })
      .finally(() => {
        publisherTasks.delete(context);
      });
    publisherTasks.set(context, task);
    return task;
  };

  const createRecovery = (context: DeviceContext) => {
    const webRtcState: RecoveryClientState = {
      awaitingKeyFrame: false,
      awaitingKeyFrameSinceMs: null,
      lastKeyFrameRequestMs: null,
    };
    webRtcRecoveryStates.set(context, webRtcState);
    return new SessionRecoveryWatchdog<RecoveryClientState>({
      clock: recoveryClock,
      clients: function* () {
        for (const client of context.clients) {
          if (client.video) yield client;
        }
        if ((publishers.get(context)?.activePeerCount ?? 0) > 0) {
          yield webRtcState;
        }
      },
      startedMs: recoveryClock.now(),
      intervalMs: 1_000,
      sessionResetCooldownMs: VIDEO_RESET_COOLDOWN_MS,
      firstFrameResetMs: FIRST_FRAME_RESET_MS,
      sourceStallResetMs: SOURCE_STALL_RESET_MS,
      awaitingKeyFrameResetMs: AWAITING_KEYFRAME_RESET_MS,
      requestReset: (reason, now) => {
        if (!sessions.isCurrent(context) || context.status !== "streaming") {
          return false;
        }
        try {
          const accepted = context.inputQueue.enqueueVideoReset();
          void accepted.completion.catch(() => {});
          context.lastVideoResetMs = now;
          context.videoResetRequests++;
          context.lastVideoResetAt = new Date(now).toISOString();
          context.lastVideoResetReason = reason;
          return true;
        } catch {
          return false;
        }
      },
    });
  };

  const dropUntilKeyFrame = (client: Client) => {
    client.droppedFrames++;
    client.context.totalDroppedFrames++;
    const recovery = recoveries.get(client.context);
    recovery?.markAwaiting(client);
    recovery?.requestVideoReset("client backpressure");
  };

  const sendFrame = (client: Client, data: Buffer, isKeyFrame: boolean) => {
    if (client.awaitingKeyFrame) {
      if (!isKeyFrame) {
        client.droppedFrames++;
        client.context.totalDroppedFrames++;
        return;
      }
    }

    const buffered = client.ws.getBufferedAmount();
    if (buffered > CLOSE_CLIENT_BUFFERED_BYTES) {
      client.context.clients.delete(client);
      try {
        client.ws.close(1013, "client too slow");
      } catch {}
      return;
    }
    if (buffered > DROP_FRAME_BUFFERED_BYTES) {
      dropUntilKeyFrame(client);
      return;
    }
    let sent: number;
    try {
      sent = client.ws.send(data);
    } catch {
      client.context.clients.delete(client);
      try {
        client.ws.close(1011, "frame send failed");
      } catch {}
      return;
    }
    if (sent === -1) {
      client.backpressureEvents++;
      client.context.totalBackpressureEvents++;
      dropUntilKeyFrame(client);
      return;
    }
    if (sent === 0) {
      client.context.clients.delete(client);
      return;
    }
    client.sentFrames++;
    if (isKeyFrame) recoveries.get(client.context)?.keyFrameAccepted(client);
  };
  const startFramePump = (context: DeviceContext) => {
    context.cachedConfig = null;
    const pump = (async () => {
      try {
        while (!stopRequested && sessions.isCurrent(context)) {
          const f = await context.stream.readFrame();
          if (!sessions.isCurrent(context)) break;
          if (!f) {
            if (!stopRequested)
              markTerminal(
                context,
                "stopped",
                `${context.stream.mode} video stream ended`,
              );
            break;
          }
          if (f.type === "session") {
            if (f.width > 0 && f.height > 0) {
              context.screen.width = f.width;
              context.screen.height = f.height;
              context.cachedConfig = null;
              publishers.get(context)?.resetVideoSource();
              const webRtcState = webRtcRecoveryStates.get(context);
              if (webRtcState) recoveries.get(context)?.markAwaiting(webRtcState);
              for (const c of context.clients) {
                if (!c.video) continue;
                recoveries.get(context)?.markAwaiting(c);
                sendJson(c.ws, {
                  type: "video-session",
                  size: { width: f.width, height: f.height },
                });
              }
              recoveries.get(context)?.requestVideoReset(
                `video session resized to ${f.width}×${f.height}`,
              );
            }
            continue;
          }
          if (f.isConfig) {
            context.cachedConfig = f.data;
            context.configPacketCount++;
            continue;
          }
          context.frameCount++;
          recoveries.get(context)?.recordFrame();
          context.frameStats.record(f.data.length, f.isKey);
          const config = f.isKey ? context.cachedConfig : null;
          const publisher = publishers.get(context);
          const webRtcDelivery = publisher?.sendFrame(f, config);
          webRtcStatsCollectorFor(context).recordDelivery(webRtcDelivery);
          if (
            f.isKey &&
            webRtcDelivery?.accepted &&
            !webRtcDelivery.awaitingKeyFrame
          ) {
            const webRtcState = webRtcRecoveryStates.get(context);
            if (webRtcState) {
              recoveries.get(context)?.keyFrameAccepted(webRtcState);
            }
          }
          let rawOut: Buffer | null = null;
          let framedOut: Buffer | null = null;
          for (const c of context.clients) {
            if (!c.video) continue;
            if (c.awaitingKeyFrame && !f.isKey) {
              c.droppedFrames++;
              context.totalDroppedFrames++;
              continue;
            }
            const out = c.frameMeta
              ? (framedOut ??= withFrameMeta(f.data, f, config))
              : (rawOut ??= withConfig(f.data, config));
            sendFrame(c, out, f.isKey);
          }
        }
      } catch (err) {
        if (
          stopRequested ||
          (context.signal.aborted && !context.terminalTransitionStarted)
        ) {
          return;
        }
        if (err instanceof ScrcpyStreamError) {
          markTerminal(context, "error", err.message, {
            code: err.code,
            meta: err.meta ?? null,
          });
        } else {
          markTerminal(context, "error", String(err));
        }
      }
    })();
    void context.trackDrain(pump).catch(() => {});
  };

  const attachSessionHandlers = (context: DeviceContext) => {
    const unsubscribe = context.stream.onFatal((failure) => {
      if (
        !stopRequested &&
        sessions.current === context &&
        (!context.signal.aborted || context.terminalTransitionStarted)
      ) {
        markTerminal(
          context,
          "error",
          failure.message,
          {
            code: failure.code,
            meta: failure.meta ?? null,
          },
        );
      }
    });
    context.registerCleanup(unsubscribe);
  };

  const activateContext = (context: DeviceContext) => {
    context.deviceState.activate(context, {
      dispatchGesture: (gesture, signal) => {
        if (signal.aborted) {
          throw signal.reason instanceof Error
            ? signal.reason
            : new DOMException("session replay cancelled", "AbortError");
        }
        return enqueueGesture(
          context,
          gesture,
          "session:replay",
          false,
        ).completion.then(() => {});
      },
    });
    const recovery = createRecovery(context);
    recoveries.set(context, recovery);
    context.registerCleanup(() => recovery.stop());
    startFramePump(context);
    attachSessionHandlers(context);
    recovery.start();
  };

  const prepareContext = async (
    serial: string,
    generation: number,
    mode: StreamMode,
    signal: AbortSignal,
    deviceState?: DeviceSessionState,
    encoderSettings = encoderSettingsForSerial(serial),
    grpcImageMode = grpcImageModeForSerial(serial),
    inputSource = inputSourceForSerial(serial, mode),
    encoder = encoderForSerial(serial),
  ): Promise<DeviceContext> => {
    const stagingOwner = {};
    let retainedDeviceState =
      deviceState && !deviceState.disposed && !deviceState.signal.aborted
        ? deviceState
        : undefined;
    if (retainedDeviceState) {
      try {
        retainedDeviceState.acquire(stagingOwner);
      } catch {
        retainedDeviceState = undefined;
      }
    }
    try {
      const stream = await openStream(
        serial,
        mode,
        signal,
        encoderSettings,
        grpcImageMode,
        inputSource,
        encoder,
      );
      try {
        return createContext(
          serial,
          generation,
          stream,
          retainedDeviceState,
          grpcImageMode,
          encoder,
        );
      } catch (error) {
        await stream.close().catch(() => {});
        throw error;
      }
    } finally {
      await retainedDeviceState?.release(
        stagingOwner,
        "stream source staging finished",
      );
    }
  };

  const grpcImageModeForContext = (context: DeviceContext): GrpcImageMode =>
    contextGrpcImageModes.get(context) ??
    grpcImageModeForSerial(context.serial);

  const encoderForContext = (context: DeviceContext): GrpcEncoder =>
    contextEncoders.get(context) ?? encoderForSerial(context.serial);

  const streamModeResponse = (context: DeviceContext) => ({
    ok: true as const,
    serial: context.serial,
    mode: context.stream.mode,
    grpcImageMode: grpcImageModeForContext(context),
    encoder: encoderForContext(context),
    encoderName: context.stream.diagnostics?.().grpcCapture?.encoderName ?? null,
    availableEncoders: getHardwareEncoderError() ? ["software"] : [...GRPC_ENCODERS],
    ...(getHardwareEncoderError() ? { hardwareEncoderError: getHardwareEncoderError() } : {}),
    inputSource: context.stream.inputSource,
    availableInputSources:
      context.stream.mode === "grpc-screenshot"
        ? [...INPUT_SOURCES]
        : (["scrcpy"] satisfies InputSource[]),
    availableModes: availableStreamModesForSerial(context.serial),
    sessionGeneration: context.generation,
  });

  const switchSession = async (serial: string) => {
    const previous = sessions.current;
    if (serial !== previous.serial) {
      await uploads.cancelGeneration(
        previous.generation,
        new UploadManagerError(
          "device-session-changed",
          "device switched",
          { serial: previous.serial, generation: previous.generation },
        ),
      );
    }
    const context = await sessions.switch(
      serial,
      async (targetSerial, generation, signal) => {
        const device = (await listDevices()).find(
          (candidate) => candidate.serial === targetSerial,
        );
        if (signal.aborted) {
          throw signal.reason instanceof Error
            ? signal.reason
            : new Error("device switch aborted");
        }
        if (!device) throw new Error(`Unknown adb device "${targetSerial}".`);
        if (device.state !== "device") {
          throw new Error(`${targetSerial} is ${device.state}, not ready.`);
        }
        return prepareContext(
          targetSerial,
          generation,
          modeForSerial(targetSerial),
          signal,
        );
      },
      activateContext,
    );
    console.log(
      `${context.stream.mode} ready: ${context.stream.meta.deviceName} • ${context.stream.meta.codecId} • ${context.stream.meta.width}×${context.stream.meta.height}`,
    );
    streamModes.set(context.serial, context.stream.mode);
    grpcImageModes.set(context.serial, grpcImageModeForContext(context));
    encoders.set(context.serial, encoderForContext(context));
    return {
      ok: true,
      serial: context.serial,
      device: context.stream.meta.deviceName,
    };
  };

  const switchStreamMode = async (
    mode: StreamMode,
    requestedGrpcImageMode: GrpcImageMode | undefined,
    requestedInputSource: InputSource | undefined,
    requestedEncoder: GrpcEncoder | undefined,
    expected?: DeviceContext,
  ) => {
    const active = sessions.current;
    if (expected && active.serial !== expected.serial) {
      throw new SessionChangedError(expected.generation, active.generation);
    }
    const requestedSerial = active.serial;
    if (!availableStreamModesForSerial(active.serial).includes(mode)) {
      throw new Error(
        "grpc-screenshot is available only for Android Emulator devices",
      );
    }
    let grpcImageMode: GrpcImageMode | undefined;
    let inputSource: InputSource | undefined;
    let encoder: GrpcEncoder | undefined;
    const context = await sessions.replace(
      (current, generation, signal) => {
        const selectedGrpcImageMode =
          grpcImageMode ??
          requestedGrpcImageMode ??
          grpcImageModeForContext(current);
        grpcImageMode = selectedGrpcImageMode;
        encoder = encoder ?? requestedEncoder ?? encoderForContext(current);
        const selectedInputSource =
          mode === "grpc-screenshot"
            ? inputSource ??
              requestedInputSource ??
              (current.stream.mode === "grpc-screenshot"
                ? current.stream.inputSource
                : inputSourceForSerial(current.serial, mode))
            : "scrcpy";
        inputSource = selectedInputSource;
        return prepareContext(
          current.serial,
          generation,
          mode,
          signal,
          current.signal.aborted ? undefined : current.deviceState,
          encoderSettingsForSerial(current.serial),
          selectedGrpcImageMode,
          selectedInputSource,
          encoder,
        );
      },
      activateContext,
      "stream source switched",
      (current) => {
        if (current.serial !== requestedSerial) {
          throw new SessionChangedError(
            active.generation,
            current.generation,
          );
        }
        encoder = requestedEncoder ?? encoderForContext(current);
        grpcImageMode =
          requestedGrpcImageMode ?? grpcImageModeForContext(current);
        inputSource =
          mode === "grpc-screenshot"
            ? requestedInputSource ??
              (current.stream.mode === "grpc-screenshot"
                ? current.stream.inputSource
                : inputSourceForSerial(current.serial, mode))
            : "scrcpy";
        return (
          current.stream.mode !== mode ||
          grpcImageModeForContext(current) !== grpcImageMode ||
          encoderForContext(current) !== encoder ||
          current.stream.inputSource !== inputSource
        );
      },
    );
    const appliedGrpcImageMode =
      grpcImageMode ?? grpcImageModeForContext(context);
    streamModes.set(context.serial, mode);
    grpcImageModes.set(context.serial, appliedGrpcImageMode);
    encoders.set(context.serial, encoder ?? encoderForContext(context));
    if (mode === "grpc-screenshot") {
      inputSources.set(
        context.serial,
        inputSource ?? context.stream.inputSource,
      );
    }
    if (context.generation !== active.generation) {
      console.log(
        `${context.stream.mode} ready: ${context.stream.meta.deviceName} • ${context.stream.meta.codecId} • ${context.stream.meta.width}×${context.stream.meta.height}`,
      );
    }
    return streamModeResponse(context);
  };

  const updateStreamEncoderSettings = async (
    patch: StreamEncoderSettingsPatch,
    expected: DeviceContext,
  ): Promise<StreamEncoderSettings> => {
    let nextSettings: StreamEncoderSettings | null = null;
    let previousSettings: StreamEncoderSettings | null = null;
    let hadPreviousSettings = false;
    const context = await sessions.replace(
      (current, generation, signal) =>
        prepareContext(
          current.serial,
          generation,
          current.stream.mode,
          signal,
          current.deviceState,
          nextSettings ?? encoderSettingsForSerial(current.serial),
        ),
      (next) => {
        const settings = nextSettings;
        if (!settings) {
          activateContext(next);
          return;
        }
        streamEncoderSettings.set(next.serial, settings);
        try {
          activateContext(next);
        } catch (error) {
          if (hadPreviousSettings && previousSettings) {
            streamEncoderSettings.set(next.serial, previousSettings);
          } else {
            streamEncoderSettings.delete(next.serial);
          }
          throw error;
        }
      },
      "stream settings changed",
      (current) => {
        if (current !== expected) {
          throw new SessionChangedError(
            expected.generation,
            current.generation,
          );
        }
        if (current.status !== "streaming" || current.signal.aborted) {
          throw new StreamSettingsUnavailableError(
            `session is ${current.status}`,
          );
        }
        previousSettings = encoderSettingsForSerial(current.serial);
        hadPreviousSettings = streamEncoderSettings.has(current.serial);
        const requestedSettings = { ...previousSettings, ...patch };
        if (
          streamEncoderSettingsEqual(previousSettings, requestedSettings)
        ) {
          return false;
        }
        if (current.recorder.isReplaying) {
          throw new SessionReplayConflictError(
            "cannot update stream settings while session replay is running",
          );
        }
        nextSettings = requestedSettings;
        return true;
      },
    );
    return { ...encoderSettingsForSerial(context.serial) };
  };

  const stopCurrentSession = (context: DeviceContext, reason: string) =>
    sessions.stop(context, reason);

  try {
    activateContext(sessions.current);
  } catch (err) {
    stopRequested = true;
    await sessions.close("server startup failed");
    throw err;
  }

  let nextId = 1;
  const serverOptions: Parameters<typeof Bun.serve<WsData>>[0] = {
    port: opts.port,
    hostname: host,
    maxRequestBodySize,
    async fetch(req, srv) {
      const requestContext = sessions.current;
      const url = new URL(req.url);
      const handleStatsRequest = () =>
        handleWebRtcStatsRequest(
          req,
          {},
          (sessionId, device) =>
            device === null || device === requestContext.serial
              ? webRtcStats(requestContext, sessionId)
              : null,
        );

      // Bootstrap: exchange a valid one-time URL token for an HttpOnly cookie,
      // then redirect to a clean URL so the secret never lingers in the address
      // bar, browser history, or referer logs. Same-origin fetch/EventSource/WS
      // calls carry the cookie automatically afterward. Scoped to browser
      // navigations (Accept: text/html) so agents hitting `/api?token=` still
      // get their JSON response instead of a redirect.
      if (
        authToken &&
        req.method === "GET" &&
        (req.headers.get("accept") ?? "").includes("text/html")
      ) {
        const queryToken = url.searchParams.get("token");
        if (queryToken && safeEqual(queryToken, authToken)) {
          const clean = new URL(url);
          clean.searchParams.delete("token");
          return new Response(null, {
            status: 303,
            headers: {
              Location: `${clean.pathname}${clean.search}`,
              "Set-Cookie": `${SESSION_COOKIE}=${authToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
            },
          });
        }
      }

      if (url.pathname === "/webrtc/stats" && req.method === "OPTIONS") {
        return handleStatsRequest();
      }

      if (!tokenValid(req, url)) {
        return new Response(
          JSON.stringify({ ok: false, error: "unauthorized" }),
          {
            status: 401,
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "WWW-Authenticate": "Bearer",
            },
          },
        );
      }

      // CSRF / cross-origin guard: reject upgrades and state-changing requests
      // whose Origin does not match the host. Applied even without auth so the
      // control channel is never open to arbitrary cross-origin pages.
      if (
        url.pathname === "/ws" ||
        (req.method !== "GET" && req.method !== "HEAD")
      ) {
        if (!originAllowed(req)) {
          return new Response(
            JSON.stringify({ ok: false, error: "forbidden origin" }),
            {
              status: 403,
              headers: { "Content-Type": "application/json; charset=utf-8" },
            },
          );
        }
      }

      if (url.pathname === "/webrtc/stats") {
        return handleStatsRequest();
      }

      if (url.pathname === "/api") {
        return Response.json(
          {
            generation: requestContext.generation,
            serial: requestContext.serial,
            device: requestContext.stream.meta.deviceName,
            codec: requestContext.stream.meta.codecId,
            streamMode: requestContext.stream.mode,
            grpcImageMode: grpcImageModeForContext(requestContext),
            encoder: encoderForContext(requestContext),
            encoderName: requestContext.stream.diagnostics?.().grpcCapture?.encoderName ?? null,
            inputSource: requestContext.stream.inputSource,
            size: {
              width: requestContext.screen.width,
              height: requestContext.screen.height,
            },
            status: requestContext.status,
            clients: requestContext.clients.size,
            stream: streamSettings,
            viewerTransports: viewerTransportsFor(
              streamSettings,
              requestContext.stream.meta.codecId,
            ),
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      }

      if (url.pathname === "/api/stream-mode") {
        if (req.method === "GET") {
          return Response.json(streamModeResponse(requestContext), {
            headers: { "Cache-Control": "no-store" },
          });
        }
        if (req.method !== "PUT") {
          return streamModeMethodNotAllowedResponse();
        }
        let mode: StreamMode;
        let grpcImageMode: GrpcImageMode | undefined;
        let inputSource: InputSource | undefined;
        let encoder: GrpcEncoder | undefined;
        try {
          const payload = await readJsonBody(req, MAX_JSON_BODY_BYTES);
          const streamModeRequest = parseStreamModeRequest(payload);
          const { mode: requestedMode } = streamModeRequest;
          if (
            requestedMode === "grpc-screenshot" &&
            !isEmulatorSerial(requestContext.serial)
          ) {
            throw new Error(
              "grpc-screenshot is available only for Android Emulator devices",
            );
          }
          mode = requestedMode;
          encoder = streamModeRequest.mode === "grpc-screenshot" ? streamModeRequest.encoder : undefined;
          grpcImageMode =
            streamModeRequest.mode === "grpc-screenshot"
              ? streamModeRequest.grpcImageMode
              : undefined;
          inputSource =
            streamModeRequest.mode === "grpc-screenshot"
              ? streamModeRequest.inputSource
              : undefined;
        } catch (error) {
          return streamModeRequestErrorResponse(error);
        }
        try {
          return Response.json(
            await switchStreamMode(
              mode,
              grpcImageMode,
              inputSource,
              encoder,
              requestContext,
            ),
          );
        } catch (error) {
          return error instanceof SessionChangedError
            ? streamModeConflictResponse(error)
            : streamModeUnavailableResponse(error);
        }
      }

      if (url.pathname === "/api/stream-settings") {
        const requestedSerial = url.searchParams.get("device")?.trim();
        if (requestedSerial && requestedSerial !== requestContext.serial) {
          return Response.json(
            {
              ok: false,
              error: "stream_settings_conflict",
              message: `active device is ${requestContext.serial}, not ${requestedSerial}`,
            },
            { status: 409 },
          );
        }
        if (req.method === "GET") {
          return Response.json(
            {
              ok: true,
              ...encoderSettingsForSerial(requestContext.serial),
            },
            { headers: { "Cache-Control": "no-store" } },
          );
        }
        if (req.method !== "PATCH") {
          return Response.json(
            { ok: false, error: "method_not_allowed" },
            { status: 405, headers: { Allow: "GET, PATCH" } },
          );
        }
        if (!isJsonRequest(req)) {
          return Response.json(
            { ok: false, error: "unsupported_media_type" },
            { status: 415 },
          );
        }
        let patch: StreamEncoderSettingsPatch;
        try {
          patch = parseStreamEncoderSettingsPatch(
            await readJsonBody(req, MAX_JSON_BODY_BYTES),
          );
        } catch (error) {
          const bodyTooLarge =
            error instanceof HttpBodyError && error.status === 413;
          return Response.json(
            {
              ok: false,
              error: bodyTooLarge
                ? "body_too_large"
                : "invalid_stream_settings",
              message: error instanceof Error ? error.message : String(error),
            },
            { status: bodyTooLarge ? 413 : 400 },
          );
        }
        try {
          const settings = await updateStreamEncoderSettings(
            patch,
            requestContext,
          );
          return Response.json(
            { ok: true, ...settings },
            { headers: { "Cache-Control": "no-store" } },
          );
        } catch (error) {
          const unavailable =
            stopRequested || error instanceof StreamSettingsUnavailableError;
          const conflict =
            error instanceof SessionReplayConflictError ||
            error instanceof SessionChangedError;
          return Response.json(
            {
              ok: false,
              error: unavailable
                ? "stream_settings_unavailable"
                : conflict
                  ? "stream_settings_conflict"
                  : "stream_settings_failed",
              message: error instanceof Error ? error.message : String(error),
            },
            { status: unavailable ? 503 : conflict ? 409 : 500 },
          );
        }
      }

      if (url.pathname === "/webrtc/offer") {
        if (req.method !== "POST") {
          return new Response("method not allowed", { status: 405 });
        }
        try {
          const offer = parseWebRtcOffer(
            await readJsonLimited(
              req,
              MAX_WEBRTC_SIGNALING_BODY_BYTES,
              requestContext.signal,
            ),
          );
          sessions.assertCurrent(requestContext);
          const publisher = await publisherFor(requestContext);
          sessions.assertCurrent(requestContext);
          const recovery = recoveries.get(requestContext);
          const webRtcState = webRtcRecoveryStates.get(requestContext);
          if (webRtcState) recovery?.markAwaiting(webRtcState);
          const answer = await publisher.handleOffer(offer);
          if (req.signal.aborted) {
            publisher.closeSession(offer.sessionId);
            return Response.json(
              {
                ok: false,
                code: "request_aborted",
                error: "WebRTC offer request was aborted",
              },
              { status: 499 },
            );
          }
          sessions.assertCurrent(requestContext);
          return Response.json(answer);
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (url.pathname === "/webrtc/close") {
        if (req.method !== "POST") {
          return new Response("method not allowed", { status: 405 });
        }
        try {
          const payload = parseWebRtcCloseRequest(
            await readJsonLimited(
              req,
              MAX_WEBRTC_CLOSE_BODY_BYTES,
              requestContext.signal,
            ),
          );
          sessions.assertCurrent(requestContext);
          const publisher =
            publishers.get(requestContext) ??
            (await publisherTasks.get(requestContext)?.catch(() => null));
          sessions.assertCurrent(requestContext);
          publisher?.closeSession(payload.sessionId);
          return Response.json({ ok: true });
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (url.pathname === "/api/devices") {
        if (req.method !== "GET")
          return new Response("method not allowed", { status: 405 });
        try {
          const devices = await runForPublishedContext(requestContext, () =>
            listDevices(),
          );
          return Response.json({
            ok: true,
            currentSerial: requestContext.serial,
            devices: devices.map((device) => ({
              ...device,
              current: device.serial === requestContext.serial,
            })),
          });
        } catch (err) {
          return errorResponse(err);
        }
      }

      if (url.pathname === "/api/device-grid") {
        if (req.method !== "GET")
          return new Response("method not allowed", { status: 405 });
        try {
          return Response.json(await deviceGrid(requestContext));
        } catch (err) {
          return errorResponse(err);
        }
      }

      if (url.pathname === "/api/devices/select") {
        if (req.method !== "POST")
          return new Response("method not allowed", { status: 405 });
        try {
          const payload = await readJsonBody(
            req,
            MAX_JSON_BODY_BYTES,
            requestContext,
            false,
          );
          if (
            typeof payload !== "object" ||
            payload === null ||
            Array.isArray(payload)
          ) {
            throw new Error("select payload must be an object");
          }
          const serial = (payload as Record<string, unknown>).serial;
          if (typeof serial !== "string" || !serial.trim()) {
            throw new Error("serial is required");
          }
          return Response.json(await switchSession(serial.trim()));
        } catch (err) {
          return errorResponse(err);
        }
      }

      if (url.pathname === "/api/avds/start") {
        if (req.method !== "POST")
          return new Response("method not allowed", { status: 405 });
        try {
          const payload = await readJsonBody(
            req,
            MAX_JSON_BODY_BYTES,
            requestContext,
            false,
          );
          if (
            typeof payload !== "object" ||
            payload === null ||
            Array.isArray(payload)
          ) {
            throw new Error("start payload must be an object");
          }
          const avd = (payload as Record<string, unknown>).avd;
          if (typeof avd !== "string" || !avd.trim())
            throw new Error("avd is required");
          const requestedCamera = (payload as Record<string, unknown>).camera;
          if (requestedCamera !== undefined && typeof requestedCamera !== "boolean") {
            throw new Error("camera must be a boolean");
          }
          const camera = requestedCamera === true;
          const launch = await launchEmulator({ avd: avd.trim(), camera });
          if (camera && !(await cameraLaunchIsWired(launch, readWiring))) {
            throw new Error(
              `AVD "${avd.trim()}" is already running, so its camera source cannot be changed; ` +
                "the emulator only reads that flag at startup. Stop it with POST /api/avds/stop first.",
            );
          }
          try {
            sessions.assertPublished(requestContext);
          } catch (err) {
            launch.stop();
            throw err;
          }
          const select = (payload as Record<string, unknown>).select !== false;
          if (select) {
            try {
              const switched = await switchSession(launch.serial);
              return Response.json({ ...switched, avd: avd.trim() });
            } catch (err) {
              launch.stop();
              throw err;
            }
          }
          return Response.json({
            ok: true,
            serial: launch.serial,
            avd: avd.trim(),
          });
        } catch (err) {
          return errorResponse(err);
        }
      }

      if (url.pathname === "/api/avds/stop") {
        if (req.method !== "POST")
          return new Response("method not allowed", { status: 405 });
        try {
          const payload = await readJsonBody(
            req,
            MAX_JSON_BODY_BYTES,
            requestContext,
            false,
          );
          if (
            typeof payload !== "object" ||
            payload === null ||
            Array.isArray(payload)
          ) {
            throw new Error("stop payload must be an object");
          }
          const body = payload as Record<string, unknown>;
          let serial =
            typeof body.serial === "string" ? body.serial.trim() : "";
          if (!serial && typeof body.avd === "string" && body.avd.trim()) {
            const running = await listActiveAvds();
            sessions.assertPublished(requestContext);
            serial =
              running.find(
                (running) => running.avd === body.avd,
              )?.serial ?? "";
          }
          if (!serial) throw new Error("serial or running avd is required");
          if (!isEmulatorSerial(serial))
            throw new Error(`${serial} is not an emulator`);
          if (serial === requestContext.serial) {
            await stopCurrentSession(requestContext, "current emulator stopped");
          }
          await killEmulator(serial);
          sessions.assertPublished(requestContext);
          return Response.json({ ok: true, serial });
        } catch (err) {
          return errorResponse(err);
        }
      }

      if (url.pathname === "/api/orientation") {
        if (req.method === "GET") {
          try {
            return Response.json({
              ok: true,
              orientation: await runForContext(requestContext, (context) =>
                getUserRotation(context.serial),
              ),
            });
          } catch (err) {
            return errorResponse(err);
          }
        }
        if (req.method === "POST") {
          try {
            const payload = await readJsonBody(
              req,
              MAX_JSON_BODY_BYTES,
              requestContext,
            );
            if (
              typeof payload !== "object" ||
              payload === null ||
              Array.isArray(payload)
            ) {
              throw new Error("orientation payload must be an object");
            }
            const orientation = (payload as Record<string, unknown>)
              .orientation;
            if (
              orientation !== "auto" &&
              orientation !== "portrait" &&
              orientation !== "landscape"
            ) {
              throw new Error(
                "orientation must be auto, portrait, or landscape",
              );
            }
            return Response.json({
              ok: true,
              orientation: await runForContext(requestContext, (context) =>
                setUserRotation(
                  context.serial,
                  orientation as OrientationMode,
                ),
              ),
            });
          } catch (err) {
            return errorResponse(err);
          }
        }
        return new Response("method not allowed", { status: 405 });
      }

      if (url.pathname === "/api/night-mode") {
        if (req.method === "GET") {
          try {
            return Response.json({
              ok: true,
              nightMode: await runForContext(requestContext, (context) =>
                getNightMode(context.serial),
              ),
            });
          } catch (err) {
            return errorResponse(err);
          }
        }
        if (req.method === "POST") {
          try {
            const payload = await readJsonBody(
              req,
              MAX_JSON_BODY_BYTES,
              requestContext,
            );
            if (
              typeof payload !== "object" ||
              payload === null ||
              Array.isArray(payload)
            ) {
              throw new Error("night mode payload must be an object");
            }
            const mode = (payload as Record<string, unknown>).mode;
            if (mode !== "dark" && mode !== "light" && mode !== "auto") {
              throw new Error("mode must be dark, light, or auto");
            }
            return Response.json({
              ok: true,
              nightMode: await runForContext(requestContext, (context) =>
                setNightMode(context.serial, mode as NightMode),
              ),
            });
          } catch (err) {
            return errorResponse(err);
          }
        }
        return new Response("method not allowed", { status: 405 });
      }

      if (url.pathname === "/api/font-scale") {
        if (req.method === "GET") {
          try {
            return Response.json({
              ok: true,
              fontScale: await runForContext(requestContext, (context) =>
                getFontScale(context.serial),
              ),
            });
          } catch (err) {
            return errorResponse(err);
          }
        }
        if (req.method === "POST") {
          try {
            const payload = await readJsonBody(
              req,
              MAX_JSON_BODY_BYTES,
              requestContext,
            );
            if (
              typeof payload !== "object" ||
              payload === null ||
              Array.isArray(payload)
            ) {
              throw new Error("font scale payload must be an object");
            }
            const scale = parseFontScale(
              (payload as Record<string, unknown>).scale,
            );
            return Response.json({
              ok: true,
              fontScale: await runForContext(requestContext, (context) =>
                setFontScale(context.serial, scale),
              ),
            });
          } catch (err) {
            return errorResponse(err);
          }
        }
        return new Response("method not allowed", { status: 405 });
      }

      if (url.pathname === "/api/network") {
        if (req.method === "GET") {
          try {
            return Response.json({
              ok: true,
              network: await runForContext(requestContext, (context) =>
                getNetworkStatus(context.serial),
              ),
            });
          } catch (err) {
            return errorResponse(err);
          }
        }
        if (req.method === "POST") {
          try {
            const payload = await readJsonBody(
              req,
              MAX_JSON_BODY_BYTES,
              requestContext,
            );
            if (
              typeof payload !== "object" ||
              payload === null ||
              Array.isArray(payload)
            ) {
              throw new Error("network payload must be an object");
            }
            const enabled = (payload as Record<string, unknown>).enabled;
            if (typeof enabled !== "boolean") {
              throw new Error("enabled must be a boolean");
            }
            return Response.json({
              ok: true,
              network: await runForContext(requestContext, (context) =>
                setNetworkEnabled(context.serial, enabled),
              ),
            });
          } catch (err) {
            return errorResponse(err);
          }
        }
        return new Response("method not allowed", { status: 405 });
      }

      if (url.pathname === "/api/reduce-motion") {
        if (req.method === "GET") {
          try {
            return Response.json({
              ok: true,
              reduceMotion: await runForContext(requestContext, (context) =>
                getReduceMotion(context.serial),
              ),
            });
          } catch (err) {
            return errorResponse(err);
          }
        }
        if (req.method === "POST") {
          try {
            const payload = await readJsonBody(
              req,
              MAX_JSON_BODY_BYTES,
              requestContext,
            );
            if (
              typeof payload !== "object" ||
              payload === null ||
              Array.isArray(payload)
            ) {
              throw new Error("reduce motion payload must be an object");
            }
            const enabled = (payload as Record<string, unknown>).enabled;
            if (typeof enabled !== "boolean") {
              throw new Error("enabled must be a boolean");
            }
            return Response.json({
              ok: true,
              reduceMotion: await runForContext(requestContext, (context) =>
                setReduceMotion(context.serial, enabled),
              ),
            });
          } catch (err) {
            return errorResponse(err);
          }
        }
        return new Response("method not allowed", { status: 405 });
      }

      if (url.pathname === "/api/high-text-contrast") {
        if (req.method === "GET") {
          try {
            return Response.json({
              ok: true,
              highTextContrast: await runForContext(requestContext, (context) =>
                getHighTextContrast(context.serial),
              ),
            });
          } catch (err) {
            return errorResponse(err);
          }
        }
        if (req.method === "POST") {
          try {
            const payload = await readJsonBody(
              req,
              MAX_JSON_BODY_BYTES,
              requestContext,
            );
            if (
              typeof payload !== "object" ||
              payload === null ||
              Array.isArray(payload)
            ) {
              throw new Error("high text contrast payload must be an object");
            }
            const enabled = (payload as Record<string, unknown>).enabled;
            if (typeof enabled !== "boolean") {
              throw new Error("enabled must be a boolean");
            }
            return Response.json({
              ok: true,
              highTextContrast: await runForContext(requestContext, (context) =>
                setHighTextContrast(context.serial, enabled),
              ),
            });
          } catch (err) {
            return errorResponse(err);
          }
        }
        return new Response("method not allowed", { status: 405 });
      }

      if (url.pathname === "/api/font-weight") {
        if (req.method === "GET") {
          try {
            return Response.json({
              ok: true,
              fontWeight: await runForContext(requestContext, (context) =>
                getFontWeight(context.serial),
              ),
            });
          } catch (err) {
            return errorResponse(err);
          }
        }
        if (req.method === "POST") {
          try {
            const payload = await readJsonBody(
              req,
              MAX_JSON_BODY_BYTES,
              requestContext,
            );
            if (
              typeof payload !== "object" ||
              payload === null ||
              Array.isArray(payload)
            ) {
              throw new Error("font weight payload must be an object");
            }
            const enabled = (payload as Record<string, unknown>).enabled;
            if (typeof enabled !== "boolean") {
              throw new Error("enabled must be a boolean");
            }
            return Response.json({
              ok: true,
              fontWeight: await runForContext(requestContext, (context) =>
                setFontWeight(context.serial, enabled),
              ),
            });
          } catch (err) {
            return errorResponse(err);
          }
        }
        return new Response("method not allowed", { status: 405 });
      }

      if (url.pathname === "/api/display-density") {
        if (req.method === "GET") {
          try {
            return Response.json({
              ok: true,
              displayDensity: await runForContext(requestContext, (context) =>
                getDisplayDensity(context.serial),
              ),
            });
          } catch (err) {
            return errorResponse(err);
          }
        }
        if (req.method === "POST") {
          try {
            const payload = await readJsonBody(
              req,
              MAX_JSON_BODY_BYTES,
              requestContext,
            );
            if (
              typeof payload !== "object" ||
              payload === null ||
              Array.isArray(payload)
            ) {
              throw new Error("display density payload must be an object");
            }
            const scale = parseDisplayDensityScale(
              (payload as Record<string, unknown>).scale,
            );
            return Response.json({
              ok: true,
              displayDensity: await runForContext(requestContext, (context) =>
                setDisplayDensity(context.serial, scale),
              ),
            });
          } catch (err) {
            return errorResponse(err);
          }
        }
        return new Response("method not allowed", { status: 405 });
      }

      if (url.pathname === "/health") {
        return responseMetrics.response("health", health(requestContext), {
          status: requestContext.status === "streaming" ? 200 : 503,
        });
      }

      if (url.pathname === "/api/logcat") {
        if (req.method !== "GET")
          return new Response("method not allowed", { status: 405 });
        try {
          sessions.assertCurrent(requestContext);
          srv.timeout(req, 0);
          return logcatStream(requestContext, req, url);
        } catch (err) {
          return errorResponse(err);
        }
      }

      if (url.pathname === "/api/screenshot") {
        if (req.method !== "GET" && req.method !== "POST") {
          return new Response("method not allowed", { status: 405 });
        }
        try {
          const png = await runForContext(requestContext, (context) =>
            screencapPng(context.serial),
          );
          if (url.searchParams.get("format") === "base64") {
            return Response.json({
              ok: true,
              mimeType: "image/png",
              data: png.toString("base64"),
            });
          }
          return new Response(new Uint8Array(png), {
            headers: { "Content-Type": "image/png" },
          });
        } catch (err) {
          return errorResponse(err);
        }
      }

      if (url.pathname === "/api/foreground") {
        if (req.method !== "GET")
          return new Response("method not allowed", { status: 405 });
        try {
          return Response.json({
            ok: true,
            app: await runForContext(requestContext, (context) =>
              getForegroundApp(context.serial),
            ),
          });
        } catch (err) {
          return errorResponse(err);
        }
      }

      if (url.pathname === "/api/accessibility") {
        if (req.method !== "GET")
          return new Response("method not allowed", { status: 405 });
        try {
          return Response.json(
            await readAccessibilitySnapshot(requestContext),
          );
        } catch (err) {
          return errorResponse(err);
        }
      }

      if (url.pathname === "/api/accessibility/tap") {
        if (req.method !== "POST")
          return new Response("method not allowed", { status: 405 });
        return accessibilityTapEndpoint(requestContext, req);
      }

      if (url.pathname === "/api/tap") {
        if (req.method !== "POST")
          return new Response("method not allowed", { status: 405 });
        return gestureEndpoint(requestContext, req, "tap", "rest:tap");
      }

      if (url.pathname === "/api/swipe") {
        if (req.method !== "POST")
          return new Response("method not allowed", { status: 405 });
        return gestureEndpoint(requestContext, req, "swipe", "rest:swipe");
      }

      if (url.pathname === "/api/text") {
        if (req.method !== "POST")
          return new Response("method not allowed", { status: 405 });
        return gestureEndpoint(requestContext, req, "text", "rest:text");
      }

      if (url.pathname === "/api/key") {
        if (req.method !== "POST")
          return new Response("method not allowed", { status: 405 });
        return keyEndpoint(requestContext, req);
      }

      if (url.pathname === "/api/session") {
        if (req.method === "GET") {
          try {
            return responseMetrics.response(
              "sessionPage",
              requestContext.recorder.page(
                parseSessionPageQuery(url.searchParams),
              ),
            );
          } catch (err) {
            return errorResponse(err);
          }
        }
        if (req.method === "DELETE") {
          try {
            sessions.assertCurrent(requestContext);
            return clearSessionReplayResponse(requestContext.recorder);
          } catch (err) {
            return errorResponse(err);
          }
        }
        return new Response("method not allowed", { status: 405 });
      }

      if (url.pathname === "/api/session/export") {
        if (req.method !== "GET") {
          return new Response("method not allowed", { status: 405 });
        }
        return responseMetrics.response(
          "sessionExport",
          requestContext.recorder.export(),
        );
      }

      if (url.pathname === "/api/session/replay") {
        if (req.method !== "POST")
          return new Response("method not allowed", { status: 405 });
        const replayRecorder = requestContext.recorder;
        const replayAdmissionEpoch = replayRecorder.replayAdmissionEpoch;
        let multiplier: number;
        try {
          const payload = await readJsonBody(
            req,
            MAX_JSON_BODY_BYTES,
            requestContext,
          );
          multiplier = parseSessionReplayMultiplier(payload);
        } catch (err) {
          return err instanceof SessionChangedError
            ? errorResponse(err)
            : sessionReplayErrorResponse(err, 400);
        }
        const replayDeviceState = requestContext.deviceState;
        const isCurrentReplaySession = () =>
          replayAdmissionEpoch === replayRecorder.replayAdmissionEpoch &&
          replayRecorder === replayDeviceState.recorder &&
          sessions.current.deviceState === replayDeviceState &&
          !replayDeviceState.disposed;
        return startSessionReplayResponse(
          replayRecorder,
          replayDeviceState.replayHandlers,
          multiplier,
          isCurrentReplaySession,
        );
      }

      if (url.pathname === "/api/session/replay/stop") {
        if (req.method !== "POST")
          return new Response("method not allowed", { status: 405 });
        const stoppedRecorder = requestContext.recorder;
        const stoppedDeviceState = requestContext.deviceState;
        const response = await stopSessionReplayResponse(stoppedRecorder);
        if (sessions.current.deviceState !== stoppedDeviceState) {
          return sessionReplayErrorResponse(
            new SessionReplayConflictError(
              "device session changed while stopping session replay",
            ),
          );
        }
        return response;
      }

      if (url.pathname === "/api/apps/install") {
        if (req.method !== "POST")
          return new Response("method not allowed", { status: 405 });
        return installEndpoint(requestContext, req);
      }

      if (url.pathname === "/api/files/import") {
        if (req.method !== "POST")
          return new Response("method not allowed", { status: 405 });
        return fileImportEndpoint(requestContext, req);
      }

      if (url.pathname === "/api/apps/launch") {
        if (req.method !== "POST")
          return new Response("method not allowed", { status: 405 });
        return appJsonEndpoint(requestContext, req, (payload) =>
          launchApp(
            requestContext.serial,
            String(payload.packageName ?? ""),
            typeof payload.activity === "string" && payload.activity.trim()
              ? payload.activity
              : undefined,
          ),
        );
      }

      if (url.pathname === "/api/apps/clear") {
        if (req.method !== "POST")
          return new Response("method not allowed", { status: 405 });
        return appJsonEndpoint(requestContext, req, (payload) =>
          clearAppData(
            requestContext.serial,
            String(payload.packageName ?? ""),
          ),
        );
      }

      if (url.pathname === "/api/apps/force-stop") {
        if (req.method !== "POST")
          return new Response("method not allowed", { status: 405 });
        return appJsonEndpoint(requestContext, req, (payload) =>
          forceStopApp(
            requestContext.serial,
            String(payload.packageName ?? ""),
          ),
        );
      }

      if (url.pathname === "/api/apps/grant") {
        if (req.method !== "POST")
          return new Response("method not allowed", { status: 405 });
        return appJsonEndpoint(requestContext, req, (payload) =>
          grantPermission(
            requestContext.serial,
            String(payload.packageName ?? ""),
            String(payload.permission ?? ""),
          ),
        );
      }

      if (url.pathname === "/api/location") {
        if (req.method === "GET") {
          return Response.json({
            generation: requestContext.generation,
            serial: requestContext.serial,
            emulator: isEmulatorSerial(requestContext.serial),
            location: requestContext.lastLocation,
          });
        }
        if (req.method === "POST") {
          try {
            const fix = parseGeoFix(
              await readJsonBody(
                req,
                MAX_JSON_BODY_BYTES,
                requestContext,
              ),
            );
            const location = await applyLocation(
              requestContext,
              fix,
              "rest:location",
            );
            return Response.json({ ok: true, location });
          } catch (err) {
            return errorResponse(err);
          }
        }
        return new Response("method not allowed", { status: 405 });
      }

      if (url.pathname === "/api/route") {
        if (req.method === "GET") {
          return Response.json(requestContext.route.snapshot());
        }
        if (req.method === "POST") {
          let route: ReturnType<typeof parseRoutePlaybackRequest>;
          try {
            route = parseRoutePlaybackRequest(
              await readJsonBody(req, MAX_ROUTE_BODY_BYTES, requestContext),
            );
          } catch (err) {
            return errorResponse(err, 400);
          }
          try {
            const start = requestContext.route.start(route);
            const snapshot = await requestContext.trackDrain(start);
            sessions.assertCurrent(requestContext);
            return Response.json({
              ok: true,
              route: snapshot,
            });
          } catch (err) {
            return err instanceof SessionChangedError
              ? errorResponse(err)
              : routePlaybackErrorResponse(err);
          }
        }
        if (req.method === "DELETE") {
          sessions.assertCurrent(requestContext);
          return Response.json({
            ok: true,
            route: requestContext.route.stop(),
          });
        }
        return new Response("method not allowed", { status: 405 });
      }

      if (url.pathname === "/api/route/control") {
        if (req.method !== "POST")
          return new Response("method not allowed", { status: 405 });
        try {
          const payload = await readJsonBody(
            req,
            MAX_JSON_BODY_BYTES,
            requestContext,
          );
          if (
            typeof payload !== "object" ||
            payload === null ||
            Array.isArray(payload)
          ) {
            throw new Error("control payload must be an object");
          }
          const action = (payload as Record<string, unknown>).action;
          if (action === "pause")
            return Response.json({
              ok: true,
              route: requestContext.route.pause(),
            });
          if (action === "resume")
            return Response.json({
              ok: true,
              route: requestContext.route.resume(),
            });
          if (action === "stop")
            return Response.json({
              ok: true,
              route: requestContext.route.stop(),
            });
          throw new Error("action must be pause, resume, or stop");
        } catch (err) {
          return errorResponse(err);
        }
      }

      const cameraResponse = await handleCameraRequest(req, url, {
        serial: requestContext.serial,
        readWiring,
        beforeMutation: () => sessions.assertCurrent(requestContext),
        // A camera failure this router cannot classify is a host failure, not
        // the 400 the other routes fall back to.
        errorResponse: (err) => errorResponse(err, 500),
      });
      if (cameraResponse) return cameraResponse;

      if (url.pathname === "/ws") {
        if (requestContext.status !== "streaming") {
          return new Response(JSON.stringify(health(requestContext)), {
            status: 503,
            headers: { "Content-Type": "application/json; charset=utf-8" },
          });
        }
        const frameMeta = url.searchParams.get("frame-meta") === "1";
        const video = url.searchParams.get("video") !== "0";
        const ok = srv.upgrade(req, {
          data: {
            id: nextId++,
            frameMeta,
            video,
            context: requestContext,
          },
        });
        if (ok) return undefined as unknown as Response;
        return new Response("upgrade failed", { status: 400 });
      }

      const reqPath = url.pathname === "/" ? "/index.html" : url.pathname;
      if (reqPath.includes(".."))
        return new Response("not found", { status: 404 });
      const file = Bun.file(join(UI_DIR, reqPath));
      if (await file.exists()) return new Response(file);
      return new Response("not found", { status: 404 });
    },
    websocket: {
      maxPayloadLength: MAX_WS_MESSAGE_BYTES,
      open(ws) {
        const context = ws.data.context;
        if (!sessions.isCurrent(context)) {
          sendJson(ws, {
            ok: false,
            code: "session_changed",
            error: "device session changed",
          });
          ws.close(1012, "device session changed");
          return;
        }
        const handle: Client = {
          id: ws.data.id,
          ws,
          context,
          frameMeta: ws.data.frameMeta,
          video: ws.data.video,
          sentFrames: 0,
          droppedFrames: 0,
          backpressureEvents: 0,
          awaitingKeyFrame: false,
          awaitingKeyFrameSinceMs: null,
          lastKeyFrameRequestMs: null,
        };
        context.clients.add(handle);
        ws.data.handle = handle;
        if (handle.video) {
          const recovery = recoveries.get(context);
          recovery?.markAwaiting(handle);
          recovery?.requestVideoReset("client opened");
        }
      },
      message(ws, raw) {
        const context = ws.data.context;
        if (!sessions.isCurrent(context)) {
          ws.close(1012, "device session changed");
          return;
        }
        if (typeof raw !== "string") return;
        if (raw.length > MAX_WS_MESSAGE_BYTES) {
          ws.close(1009, "message too large");
          return;
        }
        let acknowledge = true;
        try {
          if (context.status !== "streaming") {
            throw new Error(`session is ${context.status}`);
          }
          const payload = JSON.parse(raw);
          acknowledge = wantsAck(payload);
          if (isResetVideoRequest(payload)) {
            const accepted = enqueueVideoReset(
              context,
              "client requested keyframe",
            );
            void accepted.completion
              .then((result) => {
                if (acknowledge) {
                  sendJson(ws, { ok: true, status: result.status });
                }
              })
              .catch((err) => {
                if (acknowledge) {
                  sendJson(ws, inputErrorPayload(err, "failed"));
                }
              });
            return;
          }
          const msg = parseGesture(payload);
          const accepted = enqueueGesture(
            context,
            msg,
            "ws",
            shouldRecord(payload),
          );
          void accepted.completion
            .then((result) => {
              if (acknowledge) {
                sendJson(ws, { ok: true, status: result.status });
              }
            })
            .catch((err) => {
              if (acknowledge) {
                sendJson(ws, inputErrorPayload(err, "failed"));
              }
            });
        } catch (err) {
          if (acknowledge) {
            sendJson(ws, inputErrorPayload(err, "rejected"));
          }
        }
      },
      close(ws) {
        if (ws.data.handle) ws.data.context.clients.delete(ws.data.handle);
      },
    },
  };

  let server: ReturnType<typeof Bun.serve<WsData>>;
  try {
    server = serve<WsData>(serverOptions);
  } catch (err) {
    stopRequested = true;
    await sessions.close("server startup failed");
    await uploads.close(
      new UploadManagerError("closed", "server startup failed", {
        serial: sessions.current.serial,
        generation: sessions.current.generation,
      }),
    );
    throw err;
  }

  let stopTask: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    if (stopTask) return stopTask;
    stopRequested = true;
    server.stop(true);
    const context = sessions.current;
    const error = new UploadManagerError("closed", "server is stopping", {
      serial: context.serial,
      generation: context.generation,
    });
    stopTask = Promise.all([
      sessions.close("server stopping"),
      uploads.close(error),
    ]).then(() => {});
    return stopTask;
  };

  return {
    server,
    get session(): ScrcpySession | EmuSession | null {
      const context = sessions.current;
      return context.signal.aborted
        ? null
        : (context.stream.rawScrcpy ?? context.stream);
    },
    getSession(): ScrcpySession | EmuSession | null {
      const context = sessions.current;
      return context.signal.aborted
        ? null
        : (context.stream.rawScrcpy ?? context.stream);
    },
    stop,
  };
}
