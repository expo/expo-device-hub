import { parseGesture, type Gesture } from "./control-contracts.ts";
import {
  MAX_H264_BITRATE,
  MAX_H264_FPS,
  MAX_STREAM_DIMENSION,
  MIN_H264_BITRATE,
  STREAM_TRANSPORTS,
  type StreamEncoderSettings,
  type StreamEncoderSettingsPatch,
  type StreamSettings,
  type WebRtcIceServer,
  type WebRtcStreamSettings,
  type ViewerTransports,
} from "../stream-settings.ts";

/** Stable error codes sent by every JSON API failure. */
export const API_ERROR_CODES = [
  "invalid_request",
  "invalid_json",
  "unauthorized",
  "forbidden",
  "not_found",
  "method_not_allowed",
  "conflict",
  "payload_too_large",
  "rate_limited",
  "downstream_failure",
  "service_unavailable",
  "internal_error",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export type ApiErrorDetail = {
  code: ApiErrorCode;
  message: string;
};

export type ApiFailure = {
  ok: false;
  error: ApiErrorDetail;
};

export type ApiSuccess<T extends object = Record<never, never>> = { ok: true } & T;
export type ApiResult<T extends object = Record<never, never>> = ApiSuccess<T> | ApiFailure;

export type SessionStatus = "streaming" | "stopped" | "error";
export type DeviceSize = { width: number; height: number };
export type Device = { serial: string; state: string };

export type GridDeviceKind = "physical" | "emulator" | "avd";
export type GridDevice = {
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

export type DeviceGridResponse = ApiSuccess<{
  currentSerial: string;
  sessionStatus: SessionStatus;
  devices: GridDevice[];
}>;

export type DeviceListResponse = ApiSuccess<{
  currentSerial: string;
  devices: Array<Device & { current: boolean }>;
}>;

export type DeviceSelectionResponse = ApiSuccess<{
  serial: string;
  device: string;
}>;

export const STREAM_MODES = ["scrcpy", "grpc-screenshot"] as const;
export type StreamMode = (typeof STREAM_MODES)[number];
export function isStreamMode(value: unknown): value is StreamMode {
  return (
    typeof value === "string" &&
    STREAM_MODES.some((mode) => mode === value)
  );
}

/** Input transport used while the Android Emulator gRPC source provides video. */
export const INPUT_SOURCES = ["scrcpy", "grpc"] as const;
export type InputSource = (typeof INPUT_SOURCES)[number];
export const DEFAULT_GRPC_INPUT_SOURCE: InputSource = "scrcpy";
export function isInputSource(value: unknown): value is InputSource {
  return (
    typeof value === "string" &&
    INPUT_SOURCES.some((source) => source === value)
  );
}

/** Exact image delivery mode used by the emulator gRPC screenshot source. */
export const GRPC_IMAGE_MODES = ["png", "mmap", "rgb888"] as const;
export type GrpcImageMode = (typeof GRPC_IMAGE_MODES)[number];
export const DEFAULT_GRPC_IMAGE_MODE: GrpcImageMode = "png";
export function isGrpcImageMode(value: unknown): value is GrpcImageMode {
  return (
    typeof value === "string" &&
    GRPC_IMAGE_MODES.some((mode) => mode === value)
  );
}

/** Host H.264 implementation used by the emulator gRPC screenshot source. */
export const GRPC_ENCODERS = ["software", "hardware"] as const;
export type GrpcEncoder = (typeof GRPC_ENCODERS)[number];
export const DEFAULT_GRPC_ENCODER: GrpcEncoder = "software";
export function isGrpcEncoder(value: unknown): value is GrpcEncoder {
  return (
    typeof value === "string" &&
    GRPC_ENCODERS.some((encoder) => encoder === value)
  );
}

export type RollingTimingSummary = {
  /** Number of samples retained in the rolling window. */
  windowSamples: number;
  latest: number;
  p50: number;
  p95: number;
  max: number;
};

/** Cumulative and rolling diagnostics for emulator gRPC screenshot capture. */
export type GrpcCaptureDiagnostics = {
  /** Exact screenshot image/delivery strategy selected by the caller. */
  imageMode: GrpcImageMode;
  /** Resolved ffmpeg backend; null when an older server omits it. */
  encoderName: string | null;
  /** Raw framed protobuf messages received before either pacing stage. */
  rawGrpcMessagesReceived: number;
  /**
   * In-band messages passed to decoding, or MMAP notifications selected for a
   * snapshot; not encoder submissions.
   */
  rawGrpcMessagesEmitted: number;
  /**
   * Messages coalesced before decoding, or MMAP notifications skipped by pacing.
   * Excludes usable images replaced before encoding. RGB888 leaves this at zero.
   */
  rawGrpcMessagesCoalesced: number;
  /** Complete PNG or RGB images made available to the encoder. */
  usableImages: number;
  /** Emulator production cadence derived from source timestamps. */
  sourceTimestampFps: number | null;
  /** Raw framed message cadence before pacing/coalescing. */
  rawMessageReceiveFps: number | null;
  /** Complete source images made available to the encoder. */
  usableImageFps: number | null;
  /** Accepted fresh ffmpeg writes, excluding intentional repeats. */
  freshEncoderWriteFps: number | null;
  /** Missing emulator-produced sequence numbers observed between usable images. */
  sequenceGaps: number;
  /** Latest PNG or RGB source payload presented to ffmpeg. */
  imagePayloadBytes: number;
  /** Cumulative logical PNG or RGB bytes accepted from the selected transport. */
  transportBytes: number;
  /** Cumulative protobuf body bytes received, excluding gRPC frame prefixes. */
  grpcMessageBytesReceived: number;
  /** Cumulative positional file-read bytes, including verification and retries. */
  mmapFileBytesRead: number;
  /** Additional MMAP read pairs needed after a changing region was observed. */
  mmapReadRetries: number;
  /** MMAP notifications dropped after every bounded read attempt differed. */
  mmapTornFramesDropped: number;
  /** Rolling sequence-weighted per-produced-frame intervals. */
  sourceTimestampIntervalMs: RollingTimingSummary | null;
  /** Rolling raw framed-message arrival intervals. */
  rawMessageReceiveIntervalMs: RollingTimingSummary | null;
  /** Rolling emulator-production-to-host-receive latency. */
  productionToReceiveLatencyMs: RollingTimingSummary | null;
  /** Rolling notification-timestamp-to-complete-source-image latency estimate. */
  productionToUsableLatencyMs: RollingTimingSummary | null;
  /** Time to decode each Image protobuf processed by the selected transport. */
  protobufDecodeTimeMs: RollingTimingSummary | null;
  /** Time to obtain and compare a best-effort coherent MMAP snapshot. */
  sharedReadCopyTimeMs: RollingTimingSummary | null;
  freshEncoderWriteAttempts: number;
  repeatEncoderWriteAttempts: number;
  acceptedEncoderWrites: number;
  /** Encoder writes rejected while ffmpeg input was backpressured. */
  encoderBackpressureRejections: number;
};

export type StreamModeRequest =
  | { mode: "scrcpy" }
  | {
      mode: "grpc-screenshot";
      /** Optional for backwards compatibility; omitted means keep the configured mode. */
      grpcImageMode?: GrpcImageMode;
      /** Omitted means keep the configured encoder. Hardware selection is strict. */
      encoder?: GrpcEncoder;
      /** Optional for backwards compatibility; omitted means keep the configured source. */
      inputSource?: InputSource;
    };
export type StreamModeResponse = ApiSuccess<{
  serial: string;
  mode: StreamMode;
  grpcImageMode: GrpcImageMode;
  encoder: GrpcEncoder;
  encoderName: string | null;
  availableEncoders: GrpcEncoder[];
  hardwareEncoderError?: string;
  inputSource: InputSource;
  availableInputSources: InputSource[];
  availableModes: StreamMode[];
  sessionGeneration: number;
}>;

export type StreamEncoderSettingsResponse = ApiSuccess<StreamEncoderSettings>;

export type AvdStartResponse = ApiSuccess<{
  serial: string;
  avd: string;
  device?: string;
}>;

export type AvdStopResponse = ApiSuccess<{ serial: string }>;

export type OrientationMode = "auto" | "portrait" | "landscape";
export type OrientationStatus = {
  mode: "free" | "lock" | "unknown";
  rotation: number | null;
  orientation: OrientationMode | "unknown";
  raw: string;
};
export type OrientationResponse = ApiSuccess<{ orientation: OrientationStatus }>;

export type NightMode = "auto" | "dark" | "light";
export type NightModeStatus = { mode: NightMode | "unknown"; raw: string };
export type NightModeResponse = ApiSuccess<{ nightMode: NightModeStatus }>;

export type FontScaleStatus = { scale: number; raw: string };
export type FontScaleResponse = ApiSuccess<{ fontScale: FontScaleStatus }>;

export function parseFontScale(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0.7 ||
    value > 2
  ) {
    throw new Error("scale must be a number between 0.7 and 2.0");
  }
  return value;
}

export type ReduceMotionStatus = {
  enabled: boolean;
  raw: { transition: string; window: string; animator: string };
};
export type ReduceMotionResponse = ApiSuccess<{ reduceMotion: ReduceMotionStatus }>;

export type HighTextContrastStatus = { enabled: boolean; raw: string };
export type HighTextContrastResponse = ApiSuccess<
  { highTextContrast: HighTextContrastStatus }
>;

export type FontWeightStatus = { enabled: boolean; raw: string };
export type FontWeightResponse = ApiSuccess<{ fontWeight: FontWeightStatus }>;

export type SoftwareKeyboardStatus = { enabled: boolean; raw: string; hardwareKeyboard: boolean };
export type SoftwareKeyboardResponse = ApiSuccess<
  { softwareKeyboard: SoftwareKeyboardStatus }
>;

export type DisplayDensityStatus = { scale: number; widthDp: number; raw: string };
export type DisplayDensityResponse = ApiSuccess<
  { displayDensity: DisplayDensityStatus }
>;

export function parseDisplayDensityScale(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0.5 ||
    value > 2
  ) {
    throw new Error("scale must be a number between 0.5 and 2.0");
  }
  return value;
}

export type NetworkRadioStatus = "enabled" | "disabled" | "unknown";
export type NetworkStatus = {
  enabled: boolean | null;
  wifi: NetworkRadioStatus;
  mobileData: NetworkRadioStatus;
  raw: { wifi: string; mobileData: string };
};
export type NetworkResponse = ApiSuccess<{ network: NetworkStatus }>;

export type ForegroundApp = {
  packageName: string | null;
  activity: string | null;
  pid: number | null;
  label: string | null;
  versionName: string | null;
  versionCode: string | null;
  minSdk: number | null;
  debuggable: boolean | null;
};
export type ForegroundResponse = ApiSuccess<{ app: ForegroundApp }>;

export type AccessibilityBounds = { left: number; top: number; right: number; bottom: number };
export type AccessibilityNode = {
  id: string;
  text: string;
  contentDescription: string;
  resourceId: string;
  className: string;
  packageName: string;
  clickable: boolean;
  enabled: boolean;
  bounds: AccessibilityBounds;
};
export type AccessibilitySelector = {
  id?: string;
  text?: string;
  textContains?: string;
  contentDescription?: string;
  contentDescriptionContains?: string;
  resourceId?: string;
  resourceIdContains?: string;
  className?: string;
  packageName?: string;
  clickable?: boolean;
  enabled?: boolean;
  index?: number;
};
export type AccessibilitySnapshot = ApiSuccess<{
  capturedAt: string;
  /** Display size in the same pixel space and rotation as `nodes[].bounds`. */
  screen: { width: number; height: number };
  nodes: AccessibilityNode[];
}>;
export type AccessibilityTapResponse = ApiSuccess<{
  node: AccessibilityNode;
  capturedAt: string;
}>;

export type GeoFix = {
  latitude: number;
  longitude: number;
  altitude?: number;
  satellites?: number;
  velocity?: number;
};
export type LocationPoint = GeoFix;
export type AppliedGeoFix = GeoFix & { appliedAt: string };
export type LocationResponse = {
  serial: string;
  emulator: boolean;
  location: AppliedGeoFix | null;
};
export type LocationUpdateResponse = ApiSuccess<{ location: AppliedGeoFix }>;

export type RouteWaypoint = GeoFix;
export type RoutePlaybackRequest = {
  waypoints: RouteWaypoint[];
  speedKph?: number;
  multiplier?: number;
  intervalMs?: number;
  loop?: boolean;
};
export type RoutePlaybackStatus = "idle" | "running" | "paused" | "completed" | "error";
export type RoutePlaybackSnapshot = {
  status: RoutePlaybackStatus;
  waypointCount: number;
  totalMeters: number;
  progressMeters: number;
  speedKph: number;
  multiplier: number;
  intervalMs: number;
  loop: boolean;
  startedAt: string | null;
  updatedAt: string | null;
  pausedAt: string | null;
  completedAt: string | null;
  lastError: string | null;
  currentLocation: AppliedGeoFix | null;
};
export type RouteMutationResponse = ApiSuccess<{ route: RoutePlaybackSnapshot }>;

export const CAMERA_FACINGS = ["back", "front"] as const;
export type CameraFacing = (typeof CAMERA_FACINGS)[number];
/**
 * One emulator camera fed from a PNG on the host. The emulator re-reads `path`
 * whenever the guest opens the camera device, so rewriting the file changes the
 * picture without restarting the emulator.
 */
export type CameraFeedStatus = {
  facing: CameraFacing;
  path: string;
  present: boolean;
  /** True while the feed still holds serve-emu's "no image set" test card. */
  placeholder: boolean;
  width: number | null;
  height: number | null;
  bytes: number | null;
  digest: string | null;
  updatedAt: string | null;
};
export type CameraStatus = {
  serial: string;
  supported: boolean;
  /** True when serve-emu started this emulator with the feed paths attached. */
  wiredAtLaunch: boolean;
  /** Emulator flags that attach these feeds, for a launch serve-emu did not own. */
  launchArgs: string[];
  feeds: CameraFeedStatus[];
};
export type CameraStatusResponse = ApiSuccess<{ camera: CameraStatus }>;

export type GestureSessionEvent = {
  id: number;
  at: string;
  delayMs: number;
  source: string;
  kind: "gesture";
  gesture: Gesture;
};
export type LocationSessionEvent = {
  id: number;
  at: string;
  delayMs: number;
  source: string;
  kind: "location";
  location: GeoFix;
};
export type SessionEvent = GestureSessionEvent | LocationSessionEvent;
export type RecordedEvent = SessionEvent;
export type SessionSnapshot = {
  events: SessionEvent[];
  recording: boolean;
  replaying: boolean;
  replayStartedAt: string | null;
  replayCompletedAt: string | null;
  lastError: string | null;
};
export type SessionMutationResponse = ApiSuccess<{ session: SessionSnapshot }>;

export type AppActionResponse = ApiSuccess<{ output: string }>;
export type RuntimePermission = { name: string; granted: boolean; flags: string[] };
export type AppPermissionsResponse = ApiSuccess<{
  packageName: string;
  permissions: RuntimePermission[];
}>;

const APP_ICON_MIME_TYPES = [
  "image/png",
  "image/webp",
  "image/jpeg",
  "image/gif",
] as const;
export type AppIconMimeType = (typeof APP_ICON_MIME_TYPES)[number];
/** `data` is base64, with no `data:` URL prefix. */
export type AppIcon = { mimeType: AppIconMimeType; data: string };
export type AppIconResponse = ApiSuccess<{
  packageName: string;
  icon: AppIcon | null;
}>;

export type FileImportResponse = ApiSuccess<{
  output: string;
  path: string;
  kind: "image" | "video" | "file";
}>;

export type ScreenshotBase64Response = ApiSuccess<{
  mimeType: "image/png";
  data: string;
}>;

export type LogcatEventMap = {
  ready: {
    serial: string;
    package: string | null;
    pids: string[];
    search: string | null;
  };
  log: { line: string; at: string };
  error: { line: string; at: string };
  close: { code: number | null; signal: string | null };
};

export type MetricsMeta = {
  schemaVersion: 1;
  udid: string;
  hostCores: number;
  sampleIntervalMs: number;
};

export type MetricSample = {
  t: number;
  bundleId: string | null;
  cpuPct: number;
  memBytes: number;
  netInBytesPerSec: number;
  netOutBytesPerSec: number;
};

export type FrameStatsSummary = {
  windowFrames: number;
  intervalMs: { p50: number; p95: number; max: number } | null;
  avgKeyFrameBytes: number | null;
  avgDeltaFrameBytes: number | null;
  keyFramesInWindow: number;
};

export type HealthClient = {
  id: number;
  frameMeta: boolean;
  sentFrames: number;
  droppedFrames: number;
  backpressureEvents: number;
  bufferedBytes: number;
  awaitingKeyFrame: boolean;
};

export type HealthResponse = {
  ok: boolean;
  status: SessionStatus;
  serial: string;
  device: string;
  streamMode?: StreamMode;
  encoderName?: string | null;
  grpcImageMode?: GrpcImageMode;
  inputSource?: InputSource;
  grpcCapture?: GrpcCaptureDiagnostics | null;
  codec: string;
  size: DeviceSize;
  clients: number;
  frames: number;
  sourceFps: number;
  frameStats: FrameStatsSummary | null;
  configPackets: number;
  droppedFrames: number;
  backpressureEvents: number;
  videoResetRequests: number;
  lastVideoResetAt: string | null;
  lastVideoResetReason: string | null;
  location: AppliedGeoFix | null;
  route: RoutePlaybackSnapshot;
  session: SessionSnapshot;
  clientsDetail: HealthClient[];
  startedAt: string;
  stoppedAt: string | null;
  lastFrameAt: string | null;
  lastError: string | null;
  lastErrorCode: string | null;
  lastErrorMeta: Record<string, string | number> | null;
  /** Changes whenever the active device session or stream source changes. */
  sessionGeneration?: number;
  encoderSettings?: StreamEncoderSettings;
};

export type ApiInfoResponse = {
  generation: number;
  serial: string;
  device: string;
  streamMode?: StreamMode;
  encoderName?: string | null;
  codec: string;
  size: DeviceSize;
  status: SessionStatus;
  clients: number;
  stream: StreamSettings;
  /** Viewer-local transport choices. Optional while older servers remain supported. */
  viewerTransports?: ViewerTransports;
};

export type EmptyResponse = ApiSuccess;
export type BinaryPngResponse = Uint8Array;

export type TapRequest = { x: number; y: number; record?: boolean };
export type SwipeRequest = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  durationMs?: number;
  record?: boolean;
};
export type TextRequest = { text: string; record?: boolean };
export type KeyRequest =
  | { key: "back" | "home" | "recents" | "power"; record?: boolean }
  | { keycode: number; action?: "down" | "up"; metaState?: number; record?: boolean };

export type EndpointContract<Request, Response> = {
  request: Request;
  response: Response;
};

/**
 * Compile-time source of truth for JSON API request and response bodies.
 * Errors are added by ApiResponse so endpoint success shapes stay readable.
 */
export type ApiContractMap = {
  "/api": { GET: EndpointContract<undefined, ApiInfoResponse> };
  "/api/devices": { GET: EndpointContract<undefined, DeviceListResponse> };
  "/api/device-grid": { GET: EndpointContract<undefined, DeviceGridResponse> };
  "/api/devices/select": {
    POST: EndpointContract<{ serial: string }, DeviceSelectionResponse>;
  };
  "/api/stream-mode": {
    GET: EndpointContract<undefined, StreamModeResponse>;
    PUT: EndpointContract<StreamModeRequest, StreamModeResponse>;
  };
  "/api/stream-settings": {
    GET: EndpointContract<undefined, StreamEncoderSettingsResponse>;
    PATCH: EndpointContract<StreamEncoderSettingsPatch, StreamEncoderSettingsResponse>;
  };
  "/api/avds/start": {
    POST: EndpointContract<
      /** `camera` is honoured by the standalone server and by the middleware. */
      { avd: string; select?: boolean; camera?: boolean },
      AvdStartResponse
    >;
  };
  "/api/avds/stop": {
    POST: EndpointContract<{ serial?: string; avd?: string }, AvdStopResponse>;
  };
  "/api/orientation": {
    GET: EndpointContract<undefined, OrientationResponse>;
    POST: EndpointContract<{ orientation: OrientationMode }, OrientationResponse>;
  };
  "/api/night-mode": {
    GET: EndpointContract<undefined, NightModeResponse>;
    POST: EndpointContract<{ mode: NightMode }, NightModeResponse>;
  };
  "/api/font-scale": {
    GET: EndpointContract<undefined, FontScaleResponse>;
    POST: EndpointContract<{ scale: number }, FontScaleResponse>;
  };
  "/api/network": {
    GET: EndpointContract<undefined, NetworkResponse>;
    POST: EndpointContract<{ enabled: boolean }, NetworkResponse>;
  };
  "/api/reduce-motion": {
    GET: EndpointContract<undefined, ReduceMotionResponse>;
    POST: EndpointContract<{ enabled: boolean }, ReduceMotionResponse>;
  };
  "/api/high-text-contrast": {
    GET: EndpointContract<undefined, HighTextContrastResponse>;
    POST: EndpointContract<{ enabled: boolean }, HighTextContrastResponse>;
  };
  "/api/font-weight": {
    GET: EndpointContract<undefined, FontWeightResponse>;
    POST: EndpointContract<{ enabled: boolean }, FontWeightResponse>;
  };
  "/api/software-keyboard": {
    GET: EndpointContract<undefined, SoftwareKeyboardResponse>;
    POST: EndpointContract<{ enabled: boolean }, SoftwareKeyboardResponse>;
  };
  "/api/display-density": {
    GET: EndpointContract<undefined, DisplayDensityResponse>;
    POST: EndpointContract<{ scale: number }, DisplayDensityResponse>;
  };
  "/api/logcat": { GET: EndpointContract<undefined, never> };
  "/api/metrics": { GET: EndpointContract<undefined, never> };
  "/api/screenshot": {
    GET: EndpointContract<undefined, ScreenshotBase64Response | BinaryPngResponse>;
    POST: EndpointContract<undefined, ScreenshotBase64Response | BinaryPngResponse>;
  };
  "/api/foreground": { GET: EndpointContract<undefined, ForegroundResponse> };
  "/api/accessibility": { GET: EndpointContract<undefined, AccessibilitySnapshot> };
  "/api/accessibility/tap": {
    POST: EndpointContract<
      { selector: AccessibilitySelector; record?: boolean },
      AccessibilityTapResponse
    >;
  };
  "/api/tap": { POST: EndpointContract<TapRequest, EmptyResponse> };
  "/api/swipe": { POST: EndpointContract<SwipeRequest, EmptyResponse> };
  "/api/text": { POST: EndpointContract<TextRequest, EmptyResponse> };
  "/api/key": { POST: EndpointContract<KeyRequest, EmptyResponse> };
  "/api/session": {
    GET: EndpointContract<undefined, SessionSnapshot>;
    DELETE: EndpointContract<undefined, SessionMutationResponse>;
  };
  "/api/session/replay": {
    POST: EndpointContract<{ multiplier?: number }, SessionMutationResponse>;
  };
  "/api/session/replay/stop": {
    POST: EndpointContract<undefined, SessionMutationResponse>;
  };
  "/api/apps/install": { POST: EndpointContract<FormData, AppActionResponse> };
  "/api/files/import": { POST: EndpointContract<FormData, FileImportResponse> };
  "/api/apps/launch": {
    POST: EndpointContract<{ packageName: string; activity?: string }, AppActionResponse>;
  };
  "/api/apps/clear": {
    POST: EndpointContract<{ packageName: string }, AppActionResponse>;
  };
  "/api/apps/force-stop": {
    POST: EndpointContract<{ packageName: string }, AppActionResponse>;
  };
  "/api/apps/grant": {
    POST: EndpointContract<{ packageName: string; permission: string }, AppActionResponse>;
  };
  "/api/apps/permissions": { GET: EndpointContract<undefined, AppPermissionsResponse> };
  "/api/apps/revoke": {
    POST: EndpointContract<{ packageName: string; permission: string }, AppActionResponse>;
  };
  "/api/apps/reset-permissions": {
    POST: EndpointContract<{ packageName: string }, AppActionResponse>;
  };
  "/api/apps/icon": { GET: EndpointContract<undefined, AppIconResponse> };
  "/api/location": {
    GET: EndpointContract<undefined, LocationResponse>;
    POST: EndpointContract<GeoFix, LocationUpdateResponse>;
  };
  "/api/route": {
    GET: EndpointContract<undefined, RoutePlaybackSnapshot>;
    POST: EndpointContract<RoutePlaybackRequest, RouteMutationResponse>;
    DELETE: EndpointContract<undefined, RouteMutationResponse>;
  };
  "/api/route/control": {
    POST: EndpointContract<{ action: "pause" | "resume" | "stop" }, RouteMutationResponse>;
  };
  "/api/camera": { GET: EndpointContract<undefined, CameraStatusResponse> };
  "/api/camera/image": {
    GET: EndpointContract<undefined, BinaryPngResponse>;
    POST: EndpointContract<BinaryPngResponse, CameraStatusResponse>;
    DELETE: EndpointContract<undefined, CameraStatusResponse>;
  };
};

export type ApiPath = keyof ApiContractMap;
export type ApiMethod<Path extends ApiPath> = Extract<keyof ApiContractMap[Path], string>;
type ContractAt<
  Path extends ApiPath,
  Method extends ApiMethod<Path>,
> = ApiContractMap[Path][Method] extends EndpointContract<infer Request, infer Response>
  ? EndpointContract<Request, Response>
  : never;
export type ApiRequest<
  Path extends ApiPath,
  Method extends ApiMethod<Path>,
> = ContractAt<Path, Method>["request"];
export type ApiResponse<
  Path extends ApiPath,
  Method extends ApiMethod<Path>,
> = ContractAt<Path, Method>["response"] | ApiFailure;
export type ApiSuccessResponse<
  Path extends ApiPath,
  Method extends ApiMethod<Path>,
> = Exclude<ApiResponse<Path, Method>, ApiFailure>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new TypeError(message);
}

function record(value: unknown, name: string): Record<string, unknown> {
  return isRecord(value) ? value : fail(`${name} must be an object`);
}

function string(value: unknown, name: string): string {
  return typeof value === "string" ? value : fail(`${name} must be a string`);
}

function nullableString(value: unknown, name: string): string | null {
  return value === null ? null : string(value, name);
}

function number(value: unknown, name: string): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : fail(`${name} must be a finite number`);
}

function nullableNumber(value: unknown, name: string): number | null {
  return value === null ? null : number(value, name);
}

function boolean(value: unknown, name: string): boolean {
  return typeof value === "boolean" ? value : fail(`${name} must be a boolean`);
}

function nullableBoolean(value: unknown, name: string): boolean | null {
  return value === null ? null : boolean(value, name);
}

function oneOf<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  name: string,
): Values[number] {
  return typeof value === "string" && values.includes(value)
    ? (value as Values[number])
    : fail(`${name} is invalid`);
}

/** Parse the stable failure envelope; throws when a server violates the contract. */
export function parseApiFailure(value: unknown): ApiFailure {
  try {
    const root = record(value, "API failure");
    if (root.ok !== false) fail("invalid API failure");
    const error = record(root.error, "API failure error");
    const code = oneOf(error.code, API_ERROR_CODES, "API failure code");
    const message = string(error.message, "API failure message");
    if (!message) fail("API failure message must not be empty");
    return { ok: false, error: { code, message } };
  } catch {
    throw new TypeError("invalid API failure");
  }
}

export function isApiFailure(value: unknown): value is ApiFailure {
  try {
    parseApiFailure(value);
    return true;
  } catch {
    return false;
  }
}

export function parseApiResult<T extends object>(
  value: unknown,
  parseSuccess: (value: unknown) => ApiSuccess<T>,
): ApiResult<T> {
  return isRecord(value) && value.ok === false
    ? parseApiFailure(value)
    : parseSuccess(value);
}

function parseDeviceSize(value: unknown, name = "size"): DeviceSize {
  const item = record(value, name);
  const width = number(item.width, `${name}.width`);
  const height = number(item.height, `${name}.height`);
  if (width <= 0 || height <= 0) fail(`${name} dimensions must be positive`);
  return { width, height };
}

function parseIceServer(
  value: unknown,
  index: number,
  settingsName = "API info response.stream",
): WebRtcIceServer {
  const name = `${settingsName}.iceServers[${index}]`;
  const item = record(value, name);
  if (!Array.isArray(item.urls) || item.urls.length === 0) {
    fail(`${name}.urls must be a non-empty array`);
  }
  const username = item.username;
  const credential = item.credential;
  return {
    urls: item.urls.map((url, urlIndex) =>
      string(url, `${name}.urls[${urlIndex}]`),
    ),
    ...(username === undefined
      ? {}
      : { username: string(username, `${name}.username`) }),
    ...(credential === undefined
      ? {}
      : { credential: string(credential, `${name}.credential`) }),
  };
}

function parseWebRtcStreamSettings(
  value: unknown,
  name: string,
): WebRtcStreamSettings {
  const item = record(value, name);
  const transport = oneOf(
    item.transport,
    STREAM_TRANSPORTS,
    `${name}.transport`,
  );
  if (transport !== "webrtc") {
    fail(`${name}.transport must be webrtc`);
  }
  if (!Array.isArray(item.iceServers)) {
    fail(`${name}.iceServers must be an array`);
  }
  return {
    transport,
    codec: oneOf(
      item.codec,
      ["h264"] as const,
      `${name}.codec`,
    ),
    iceServers: item.iceServers.map((server, index) =>
      parseIceServer(server, index, name),
    ),
    iceTransportPolicy: oneOf(
      item.iceTransportPolicy,
      ["all", "relay"] as const,
      `${name}.iceTransportPolicy`,
    ),
  };
}

export function parseStreamSettings(value: unknown): StreamSettings {
  const item = record(value, "API info response.stream");
  const transport = oneOf(
    item.transport,
    STREAM_TRANSPORTS,
    "API info response.stream.transport",
  );
  return transport === "websocket"
    ? { transport }
    : parseWebRtcStreamSettings(value, "API info response.stream");
}

function parseViewerTransports(value: unknown): ViewerTransports {
  const name = "API info response.viewerTransports";
  const item = record(value, name);
  const defaultTransport = oneOf(
    item.default,
    STREAM_TRANSPORTS,
    `${name}.default`,
  );
  if (!Array.isArray(item.available) || item.available.length === 0) {
    fail(`${name}.available must be a non-empty array`);
  }
  const available = item.available.map((transport, index) =>
    oneOf(transport, STREAM_TRANSPORTS, `${name}.available[${index}]`),
  );
  if (new Set(available).size !== available.length) {
    fail(`${name}.available must not contain duplicates`);
  }
  if (!available.includes(defaultTransport)) {
    fail(`${name}.default must be available`);
  }
  const webRtcAvailable = available.includes("webrtc");
  if (webRtcAvailable !== (item.webrtc !== null)) {
    fail(
      `${name}.webrtc must be present exactly when webrtc is available`,
    );
  }
  return {
    default: defaultTransport,
    available,
    webrtc:
      item.webrtc === null
        ? null
        : parseWebRtcStreamSettings(item.webrtc, `${name}.webrtc`),
  };
}

export function parseApiInfoResponse(value: unknown): ApiInfoResponse {
  const root = record(value, "API info response");
  const generation = number(root.generation, "API info response.generation");
  if (!Number.isSafeInteger(generation) || generation < 0) {
    fail("API info response.generation must be a non-negative safe integer");
  }
  return {
    generation,
    serial: string(root.serial, "API info response.serial"),
    device: string(root.device, "API info response.device"),
    ...(root.streamMode === undefined
      ? {}
      : {
          streamMode: oneOf(
            root.streamMode,
            STREAM_MODES,
            "API info response.streamMode",
          ),
        }),
    ...(root.encoderName === undefined
      ? {}
      : {
          encoderName: root.encoderName === null
            ? null
            : string(root.encoderName, "API info response.encoderName"),
        }),
    codec: string(root.codec, "API info response.codec"),
    size: parseDeviceSize(root.size, "API info response.size"),
    status: oneOf(
      root.status,
      ["streaming", "stopped", "error"] as const,
      "API info response.status",
    ),
    clients: number(root.clients, "API info response.clients"),
    stream: parseStreamSettings(root.stream),
    ...(root.viewerTransports === undefined
      ? {}
      : { viewerTransports: parseViewerTransports(root.viewerTransports) }),
  };
}

export function parseDeviceListResponse(value: unknown): DeviceListResponse {
  const root = record(value, "device list response");
  if (root.ok !== true) fail("device list response.ok must be true");
  if (!Array.isArray(root.devices)) fail("device list response.devices must be an array");
  return {
    ok: true,
    currentSerial: string(root.currentSerial, "device list response.currentSerial"),
    devices: root.devices.map((value, index) => {
      const item = record(value, `devices[${index}]`);
      return {
        serial: string(item.serial, `devices[${index}].serial`),
        state: string(item.state, `devices[${index}].state`),
        current: boolean(item.current, `devices[${index}].current`),
      };
    }),
  };
}

function parseOkDeviceResponse(value: unknown, kind: "selection" | "avd-start"): DeviceSelectionResponse | AvdStartResponse {
  const root = record(value, `${kind} response`);
  if (root.ok !== true) fail(`${kind} response.ok must be true`);
  const serial = string(root.serial, `${kind} response.serial`);
  if (kind === "selection") {
    return { ok: true, serial, device: string(root.device, "selection response.device") };
  }
  const result: AvdStartResponse = {
    ok: true,
    serial,
    avd: string(root.avd, "avd-start response.avd"),
  };
  if (root.device !== undefined) result.device = string(root.device, "avd-start response.device");
  return result;
}

export function parseDeviceSelectionResponse(value: unknown): DeviceSelectionResponse {
  return parseOkDeviceResponse(value, "selection") as DeviceSelectionResponse;
}

export function parseStreamModeRequest(value: unknown): StreamModeRequest {
  const root = record(value, "stream mode request");
  const mode = oneOf(root.mode, STREAM_MODES, "stream mode request.mode");
  if (mode === "scrcpy") {
    if (root.grpcImageMode !== undefined) {
      fail(
        "stream mode request.grpcImageMode is available only with mode grpc-screenshot",
      );
    }
    if (root.inputSource !== undefined) {
      fail(
        "stream mode request.inputSource is available only with mode grpc-screenshot",
      );
    }
    if (root.encoder !== undefined) {
      fail("stream mode request.encoder is available only with mode grpc-screenshot");
    }
    return { mode };
  }
  return {
    mode,
    ...(root.encoder === undefined
      ? {}
      : {
          encoder: oneOf(root.encoder, GRPC_ENCODERS, "stream mode request.encoder"),
        }),
    ...(root.grpcImageMode === undefined
      ? {}
      : {
          grpcImageMode: oneOf(
            root.grpcImageMode,
            GRPC_IMAGE_MODES,
            "stream mode request.grpcImageMode",
          ),
        }),
    ...(root.inputSource === undefined
      ? {}
      : {
          inputSource: oneOf(
            root.inputSource,
            INPUT_SOURCES,
            "stream mode request.inputSource",
          ),
        }),
  };
}

export function parseStreamModeResponse(value: unknown): StreamModeResponse {
  const root = record(value, "stream mode response");
  if (root.ok !== true) fail("stream mode response.ok must be true");
  const serial = string(root.serial, "stream mode response.serial");
  if (!serial) fail("stream mode response.serial must not be empty");
  const mode = oneOf(root.mode, STREAM_MODES, "stream mode response.mode");
  const grpcImageMode = oneOf(
    root.grpcImageMode,
    GRPC_IMAGE_MODES,
    "stream mode response.grpcImageMode",
  );
  const encoder = root.encoder === undefined
    ? DEFAULT_GRPC_ENCODER
    : oneOf(root.encoder, GRPC_ENCODERS, "stream mode response.encoder");
  const encoderName = root.encoderName === undefined || root.encoderName === null
    ? null
    : string(root.encoderName, "stream mode response.encoderName");
  const rawEncoders = root.availableEncoders === undefined
    ? [DEFAULT_GRPC_ENCODER]
    : root.availableEncoders;
  if (!Array.isArray(rawEncoders)) {
    fail("stream mode response.availableEncoders must be an array");
  }
  const availableEncoders = rawEncoders.map((value, index) =>
    oneOf(value, GRPC_ENCODERS, `stream mode response.availableEncoders[${index}]`),
  );
  if (!availableEncoders.includes("software")) {
    fail("stream mode response.availableEncoders must include software");
  }
  if (new Set(availableEncoders).size !== availableEncoders.length) {
    fail("stream mode response.availableEncoders must not contain duplicates");
  }
  const inputSource = oneOf(
    root.inputSource,
    INPUT_SOURCES,
    "stream mode response.inputSource",
  );
  if (!Array.isArray(root.availableInputSources)) {
    fail("stream mode response.availableInputSources must be an array");
  }
  const availableInputSources = root.availableInputSources.map((value, index) =>
    oneOf(
      value,
      INPUT_SOURCES,
      `stream mode response.availableInputSources[${index}]`,
    ),
  );
  if (availableInputSources.length === 0) {
    fail("stream mode response.availableInputSources must not be empty");
  }
  if (new Set(availableInputSources).size !== availableInputSources.length) {
    fail("stream mode response.availableInputSources must not contain duplicates");
  }
  if (!availableInputSources.includes(inputSource)) {
    fail("stream mode response.inputSource must be available");
  }
  if (!Array.isArray(root.availableModes)) {
    fail("stream mode response.availableModes must be an array");
  }
  const availableModes = root.availableModes.map((value, index) =>
    oneOf(
      value,
      STREAM_MODES,
      `stream mode response.availableModes[${index}]`,
    ),
  );
  if (availableModes.length === 0) {
    fail("stream mode response.availableModes must not be empty");
  }
  if (new Set(availableModes).size !== availableModes.length) {
    fail("stream mode response.availableModes must not contain duplicates");
  }
  if (!availableModes.includes(mode)) {
    fail("stream mode response.mode must be available");
  }
  const sessionGeneration = number(
    root.sessionGeneration,
    "stream mode response.sessionGeneration",
  );
  if (!Number.isSafeInteger(sessionGeneration) || sessionGeneration < 0) {
    fail(
      "stream mode response.sessionGeneration must be a non-negative safe integer",
    );
  }
  return {
    ok: true,
    serial,
    mode,
    grpcImageMode,
    encoder,
    encoderName,
    availableEncoders,
    ...(root.hardwareEncoderError === undefined
      ? {}
      : {
          hardwareEncoderError: string(
            root.hardwareEncoderError,
            "stream mode response.hardwareEncoderError",
          ),
        }),
    inputSource,
    availableInputSources,
    availableModes,
    sessionGeneration,
  };
}

export function parseStreamEncoderSettingsResponse(
  value: unknown,
): StreamEncoderSettingsResponse {
  const root = record(value, "stream encoder settings response");
  if (root.ok !== true) {
    fail("stream encoder settings response.ok must be true");
  }
  const maxDimension = number(
    root.maxDimension,
    "stream encoder settings response.maxDimension",
  );
  const h264Bitrate = number(
    root.h264Bitrate,
    "stream encoder settings response.h264Bitrate",
  );
  const h264Fps = number(
    root.h264Fps,
    "stream encoder settings response.h264Fps",
  );
  if (
    !Number.isSafeInteger(maxDimension) ||
    maxDimension < 0 ||
    maxDimension > MAX_STREAM_DIMENSION
  ) {
    fail(
      `stream encoder settings response.maxDimension must be an integer between 0 and ${MAX_STREAM_DIMENSION}`,
    );
  }
  if (
    !Number.isSafeInteger(h264Bitrate) ||
    h264Bitrate < MIN_H264_BITRATE ||
    h264Bitrate > MAX_H264_BITRATE
  ) {
    fail(
      `stream encoder settings response.h264Bitrate must be an integer between ${MIN_H264_BITRATE} and ${MAX_H264_BITRATE}`,
    );
  }
  if (
    !Number.isSafeInteger(h264Fps) ||
    h264Fps < 1 ||
    h264Fps > MAX_H264_FPS
  ) {
    fail(
      `stream encoder settings response.h264Fps must be an integer between 1 and ${MAX_H264_FPS}`,
    );
  }
  return { ok: true, maxDimension, h264Bitrate, h264Fps };
}

export function parseAvdStartResponse(value: unknown): AvdStartResponse {
  return parseOkDeviceResponse(value, "avd-start") as AvdStartResponse;
}

export function parseAvdStopResponse(value: unknown): AvdStopResponse {
  const root = record(value, "AVD stop response");
  if (root.ok !== true) fail("AVD stop response.ok must be true");
  return { ok: true, serial: string(root.serial, "AVD stop response.serial") };
}

export function parseDeviceGridResponse(value: unknown): DeviceGridResponse {
  const root = record(value, "device grid response");
  if (root.ok !== true) fail("device grid response.ok must be true");
  const devices = Array.isArray(root.devices)
    ? root.devices.map((value, index): GridDevice => {
        const item = record(value, `devices[${index}]`);
        return {
          id: string(item.id, `devices[${index}].id`),
          kind: oneOf(item.kind, ["physical", "emulator", "avd"] as const, `devices[${index}].kind`),
          serial: nullableString(item.serial, `devices[${index}].serial`),
          avd: nullableString(item.avd, `devices[${index}].avd`),
          name: string(item.name, `devices[${index}].name`),
          state: string(item.state, `devices[${index}].state`),
          current: boolean(item.current, `devices[${index}].current`),
          canSelect: boolean(item.canSelect, `devices[${index}].canSelect`),
          canStart: boolean(item.canStart, `devices[${index}].canStart`),
          canStop: boolean(item.canStop, `devices[${index}].canStop`),
        };
      })
    : fail("device grid response.devices must be an array");
  return {
    ok: true,
    currentSerial: string(root.currentSerial, "device grid response.currentSerial"),
    sessionStatus: oneOf(
      root.sessionStatus,
      ["streaming", "stopped", "error"] as const,
      "device grid response.sessionStatus",
    ),
    devices,
  };
}

function parseOrientationStatus(value: unknown): OrientationStatus {
  const item = record(value, "orientation");
  const rotation = item.rotation === null ? null : number(item.rotation, "orientation.rotation");
  return {
    mode: oneOf(item.mode, ["free", "lock", "unknown"] as const, "orientation.mode"),
    rotation,
    orientation: oneOf(
      item.orientation,
      ["auto", "portrait", "landscape", "unknown"] as const,
      "orientation.orientation",
    ),
    raw: string(item.raw, "orientation.raw"),
  };
}

export function parseOrientationResponse(value: unknown): OrientationResponse {
  const root = record(value, "orientation response");
  if (root.ok !== true) fail("orientation response.ok must be true");
  return { ok: true, orientation: parseOrientationStatus(root.orientation) };
}

export function parseNightModeResponse(value: unknown): NightModeResponse {
  const root = record(value, "night mode response");
  if (root.ok !== true) fail("night mode response.ok must be true");
  const status = record(root.nightMode, "nightMode");
  return {
    ok: true,
    nightMode: {
      mode: oneOf(status.mode, ["auto", "dark", "light", "unknown"] as const, "nightMode.mode"),
      raw: string(status.raw, "nightMode.raw"),
    },
  };
}

export function parseFontScaleResponse(value: unknown): FontScaleResponse {
  const root = record(value, "font scale response");
  if (root.ok !== true) fail("font scale response.ok must be true");
  const status = record(root.fontScale, "fontScale");
  return {
    ok: true,
    fontScale: {
      scale: number(status.scale, "fontScale.scale"),
      raw: string(status.raw, "fontScale.raw"),
    },
  };
}

export function parseNetworkResponse(value: unknown): NetworkResponse {
  const root = record(value, "network response");
  if (root.ok !== true) fail("network response.ok must be true");
  const status = record(root.network, "network");
  const raw = record(status.raw, "network.raw");
  return {
    ok: true,
    network: {
      enabled: nullableBoolean(status.enabled, "network.enabled"),
      wifi: oneOf(status.wifi, ["enabled", "disabled", "unknown"] as const, "network.wifi"),
      mobileData: oneOf(
        status.mobileData,
        ["enabled", "disabled", "unknown"] as const,
        "network.mobileData",
      ),
      raw: {
        wifi: string(raw.wifi, "network.raw.wifi"),
        mobileData: string(raw.mobileData, "network.raw.mobileData"),
      },
    },
  };
}

export function parseReduceMotionResponse(value: unknown): ReduceMotionResponse {
  const root = record(value, "reduce motion response");
  if (root.ok !== true) fail("reduce motion response.ok must be true");
  const status = record(root.reduceMotion, "reduceMotion");
  const raw = record(status.raw, "reduceMotion.raw");
  return {
    ok: true,
    reduceMotion: {
      enabled: boolean(status.enabled, "reduceMotion.enabled"),
      raw: {
        transition: string(raw.transition, "reduceMotion.raw.transition"),
        window: string(raw.window, "reduceMotion.raw.window"),
        animator: string(raw.animator, "reduceMotion.raw.animator"),
      },
    },
  };
}

export function parseHighTextContrastResponse(
  value: unknown,
): HighTextContrastResponse {
  const root = record(value, "high text contrast response");
  if (root.ok !== true) fail("high text contrast response.ok must be true");
  const status = record(root.highTextContrast, "highTextContrast");
  return {
    ok: true,
    highTextContrast: {
      enabled: boolean(status.enabled, "highTextContrast.enabled"),
      raw: string(status.raw, "highTextContrast.raw"),
    },
  };
}

export function parseFontWeightResponse(value: unknown): FontWeightResponse {
  const root = record(value, "font weight response");
  if (root.ok !== true) fail("font weight response.ok must be true");
  const status = record(root.fontWeight, "fontWeight");
  return {
    ok: true,
    fontWeight: {
      enabled: boolean(status.enabled, "fontWeight.enabled"),
      raw: string(status.raw, "fontWeight.raw"),
    },
  };
}

export function parseSoftwareKeyboardResponse(
  value: unknown,
): SoftwareKeyboardResponse {
  const root = record(value, "software keyboard response");
  if (root.ok !== true) fail("software keyboard response.ok must be true");
  const status = record(root.softwareKeyboard, "softwareKeyboard");
  return {
    ok: true,
    softwareKeyboard: {
      enabled: boolean(status.enabled, "softwareKeyboard.enabled"),
      raw: string(status.raw, "softwareKeyboard.raw"),
      hardwareKeyboard: boolean(status.hardwareKeyboard, "softwareKeyboard.hardwareKeyboard"),
    },
  };
}

export function parseDisplayDensityResponse(
  value: unknown,
): DisplayDensityResponse {
  const root = record(value, "display density response");
  if (root.ok !== true) fail("display density response.ok must be true");
  const status = record(root.displayDensity, "displayDensity");
  return {
    ok: true,
    displayDensity: {
      scale: number(status.scale, "displayDensity.scale"),
      widthDp: number(status.widthDp, "displayDensity.widthDp"),
      raw: string(status.raw, "displayDensity.raw"),
    },
  };
}

function parseForegroundApp(value: unknown): ForegroundApp {
  const item = record(value, "foreground app");
  return {
    packageName: nullableString(item.packageName, "foreground app.packageName"),
    activity: nullableString(item.activity, "foreground app.activity"),
    pid: item.pid === null ? null : number(item.pid, "foreground app.pid"),
    label: nullableString(item.label, "foreground app.label"),
    versionName: nullableString(item.versionName, "foreground app.versionName"),
    versionCode: nullableString(item.versionCode, "foreground app.versionCode"),
    minSdk: item.minSdk === null ? null : number(item.minSdk, "foreground app.minSdk"),
    debuggable: nullableBoolean(item.debuggable, "foreground app.debuggable"),
  };
}

export function parseForegroundResponse(value: unknown): ForegroundResponse {
  const root = record(value, "foreground response");
  if (root.ok !== true) fail("foreground response.ok must be true");
  return { ok: true, app: parseForegroundApp(root.app) };
}

function parseAccessibilityNode(value: unknown, name = "accessibility node"): AccessibilityNode {
  const item = record(value, name);
  const bounds = record(item.bounds, `${name}.bounds`);
  return {
    id: string(item.id, `${name}.id`),
    text: string(item.text, `${name}.text`),
    contentDescription: string(item.contentDescription, `${name}.contentDescription`),
    resourceId: string(item.resourceId, `${name}.resourceId`),
    className: string(item.className, `${name}.className`),
    packageName: string(item.packageName, `${name}.packageName`),
    clickable: boolean(item.clickable, `${name}.clickable`),
    enabled: boolean(item.enabled, `${name}.enabled`),
    bounds: {
      left: number(bounds.left, `${name}.bounds.left`),
      top: number(bounds.top, `${name}.bounds.top`),
      right: number(bounds.right, `${name}.bounds.right`),
      bottom: number(bounds.bottom, `${name}.bounds.bottom`),
    },
  };
}

export function parseAccessibilitySnapshot(value: unknown): AccessibilitySnapshot {
  const root = record(value, "accessibility snapshot");
  if (root.ok !== true) fail("accessibility snapshot.ok must be true");
  if (!Array.isArray(root.nodes)) fail("accessibility snapshot.nodes must be an array");
  const screen = record(root.screen, "accessibility snapshot.screen");
  return {
    ok: true,
    capturedAt: string(root.capturedAt, "accessibility snapshot.capturedAt"),
    screen: {
      width: number(screen.width, "accessibility snapshot.screen.width"),
      height: number(screen.height, "accessibility snapshot.screen.height"),
    },
    nodes: root.nodes.map((node, index) => parseAccessibilityNode(node, `nodes[${index}]`)),
  };
}

export function parseAccessibilityTapResponse(value: unknown): AccessibilityTapResponse {
  const root = record(value, "accessibility tap response");
  if (root.ok !== true) fail("accessibility tap response.ok must be true");
  return {
    ok: true,
    node: parseAccessibilityNode(root.node),
    capturedAt: string(root.capturedAt, "accessibility tap response.capturedAt"),
  };
}

function parseGeoFix(value: unknown, name = "location"): GeoFix {
  const item = record(value, name);
  const result: GeoFix = {
    latitude: number(item.latitude, `${name}.latitude`),
    longitude: number(item.longitude, `${name}.longitude`),
  };
  if (item.altitude !== undefined) result.altitude = number(item.altitude, `${name}.altitude`);
  if (item.satellites !== undefined) result.satellites = number(item.satellites, `${name}.satellites`);
  if (item.velocity !== undefined) result.velocity = number(item.velocity, `${name}.velocity`);
  return result;
}

function parseAppliedGeoFix(value: unknown, name = "location"): AppliedGeoFix {
  const item = record(value, name);
  return { ...parseGeoFix(item, name), appliedAt: string(item.appliedAt, `${name}.appliedAt`) };
}

export function parseLocationResponse(value: unknown): LocationResponse {
  const root = record(value, "location response");
  return {
    serial: string(root.serial, "location response.serial"),
    emulator: boolean(root.emulator, "location response.emulator"),
    location: root.location === null ? null : parseAppliedGeoFix(root.location),
  };
}

export function parseLocationUpdateResponse(value: unknown): LocationUpdateResponse {
  const root = record(value, "location update response");
  if (root.ok !== true) fail("location update response.ok must be true");
  return { ok: true, location: parseAppliedGeoFix(root.location) };
}

export function parseRoutePlaybackSnapshot(value: unknown): RoutePlaybackSnapshot {
  const root = record(value, "route snapshot");
  return {
    status: oneOf(
      root.status,
      ["idle", "running", "paused", "completed", "error"] as const,
      "route snapshot.status",
    ),
    waypointCount: number(root.waypointCount, "route snapshot.waypointCount"),
    totalMeters: number(root.totalMeters, "route snapshot.totalMeters"),
    progressMeters: number(root.progressMeters, "route snapshot.progressMeters"),
    speedKph: number(root.speedKph, "route snapshot.speedKph"),
    multiplier: number(root.multiplier, "route snapshot.multiplier"),
    intervalMs: number(root.intervalMs, "route snapshot.intervalMs"),
    loop: boolean(root.loop, "route snapshot.loop"),
    startedAt: nullableString(root.startedAt, "route snapshot.startedAt"),
    updatedAt: nullableString(root.updatedAt, "route snapshot.updatedAt"),
    pausedAt: nullableString(root.pausedAt, "route snapshot.pausedAt"),
    completedAt: nullableString(root.completedAt, "route snapshot.completedAt"),
    lastError: nullableString(root.lastError, "route snapshot.lastError"),
    currentLocation:
      root.currentLocation === null
        ? null
        : parseAppliedGeoFix(root.currentLocation, "route snapshot.currentLocation"),
  };
}

export function parseRouteMutationResponse(value: unknown): RouteMutationResponse {
  const root = record(value, "route mutation response");
  if (root.ok !== true) fail("route mutation response.ok must be true");
  return { ok: true, route: parseRoutePlaybackSnapshot(root.route) };
}

function parseCameraFeedStatus(value: unknown, index: number): CameraFeedStatus {
  const name = `camera.feeds[${index}]`;
  const item = record(value, name);
  return {
    facing: oneOf(item.facing, CAMERA_FACINGS, `${name}.facing`),
    path: string(item.path, `${name}.path`),
    present: boolean(item.present, `${name}.present`),
    placeholder: boolean(item.placeholder, `${name}.placeholder`),
    width: nullableNumber(item.width, `${name}.width`),
    height: nullableNumber(item.height, `${name}.height`),
    bytes: nullableNumber(item.bytes, `${name}.bytes`),
    digest: nullableString(item.digest, `${name}.digest`),
    updatedAt: nullableString(item.updatedAt, `${name}.updatedAt`),
  };
}

function parseCameraStatus(value: unknown): CameraStatus {
  const root = record(value, "camera");
  if (!Array.isArray(root.feeds)) fail("camera.feeds must be an array");
  if (!Array.isArray(root.launchArgs)) fail("camera.launchArgs must be an array");
  return {
    serial: string(root.serial, "camera.serial"),
    supported: boolean(root.supported, "camera.supported"),
    wiredAtLaunch: boolean(root.wiredAtLaunch, "camera.wiredAtLaunch"),
    launchArgs: root.launchArgs.map((arg, index) =>
      string(arg, `camera.launchArgs[${index}]`),
    ),
    feeds: root.feeds.map(parseCameraFeedStatus),
  };
}

export function parseCameraStatusResponse(value: unknown): CameraStatusResponse {
  const root = record(value, "camera response");
  if (root.ok !== true) fail("camera response.ok must be true");
  return { ok: true, camera: parseCameraStatus(root.camera) };
}

function parseSessionEvent(value: unknown, index: number): SessionEvent {
  const item = record(value, `session.events[${index}]`);
  const base = {
    id: number(item.id, `session.events[${index}].id`),
    at: string(item.at, `session.events[${index}].at`),
    delayMs: number(item.delayMs, `session.events[${index}].delayMs`),
    source: string(item.source, `session.events[${index}].source`),
  };
  if (item.kind === "gesture") {
    const gesture = parseGesture(item.gesture);
    return { ...base, kind: "gesture", gesture };
  }
  if (item.kind === "location") {
    return {
      ...base,
      kind: "location",
      location: parseGeoFix(item.location, `session.events[${index}].location`),
    };
  }
  return fail(`session.events[${index}].kind is invalid`);
}

export function parseSessionSnapshot(value: unknown): SessionSnapshot {
  const root = record(value, "session snapshot");
  if (!Array.isArray(root.events)) fail("session snapshot.events must be an array");
  return {
    events: root.events.map(parseSessionEvent),
    recording: boolean(root.recording, "session snapshot.recording"),
    replaying: boolean(root.replaying, "session snapshot.replaying"),
    replayStartedAt: nullableString(root.replayStartedAt, "session snapshot.replayStartedAt"),
    replayCompletedAt: nullableString(root.replayCompletedAt, "session snapshot.replayCompletedAt"),
    lastError: nullableString(root.lastError, "session snapshot.lastError"),
  };
}

export function parseSessionMutationResponse(value: unknown): SessionMutationResponse {
  const root = record(value, "session mutation response");
  if (root.ok !== true) fail("session mutation response.ok must be true");
  return { ok: true, session: parseSessionSnapshot(root.session) };
}

export function parseEmptyResponse(value: unknown): EmptyResponse {
  const root = record(value, "empty response");
  if (root.ok !== true) fail("empty response.ok must be true");
  return { ok: true };
}

export function parseAppActionResponse(value: unknown): AppActionResponse {
  const root = record(value, "app action response");
  if (root.ok !== true) fail("app action response.ok must be true");
  return { ok: true, output: string(root.output, "app action response.output") };
}

export function parseAppPermissionsResponse(value: unknown): AppPermissionsResponse {
  const root = record(value, "app permissions response");
  if (root.ok !== true) fail("app permissions response.ok must be true");
  if (!Array.isArray(root.permissions)) fail("app permissions response.permissions must be an array");
  return {
    ok: true,
    packageName: string(root.packageName, "app permissions response.packageName"),
    permissions: root.permissions.map((entry, index) => {
      const name = `permissions[${index}]`;
      const item = record(entry, name);
      if (!Array.isArray(item.flags)) fail(`${name}.flags must be an array`);
      return {
        name: string(item.name, `${name}.name`),
        granted: boolean(item.granted, `${name}.granted`),
        flags: item.flags.map((flag, flagIndex) => string(flag, `${name}.flags[${flagIndex}]`)),
      };
    }),
  };
}

function parseAppIcon(value: unknown): AppIcon {
  const item = record(value, "app icon");
  return {
    mimeType: oneOf(item.mimeType, APP_ICON_MIME_TYPES, "app icon.mimeType"),
    data: string(item.data, "app icon.data"),
  };
}

export function parseAppIconResponse(value: unknown): AppIconResponse {
  const root = record(value, "app icon response");
  if (root.ok !== true) fail("app icon response.ok must be true");
  return {
    ok: true,
    packageName: string(root.packageName, "app icon response.packageName"),
    icon: root.icon === null ? null : parseAppIcon(root.icon),
  };
}

export function parseFileImportResponse(value: unknown): FileImportResponse {
  const root = record(value, "file import response");
  if (root.ok !== true) fail("file import response.ok must be true");
  return {
    ok: true,
    output: string(root.output, "file import response.output"),
    path: string(root.path, "file import response.path"),
    kind: oneOf(root.kind, ["image", "video", "file"] as const, "file import response.kind"),
  };
}

export function parseScreenshotBase64Response(value: unknown): ScreenshotBase64Response {
  const root = record(value, "screenshot response");
  if (root.ok !== true) fail("screenshot response.ok must be true");
  if (root.mimeType !== "image/png") fail("screenshot response.mimeType must be image/png");
  return {
    ok: true,
    mimeType: "image/png",
    data: string(root.data, "screenshot response.data"),
  };
}

export function parseLogcatEvent<Event extends keyof LogcatEventMap>(
  event: Event,
  value: unknown,
): LogcatEventMap[Event] {
  const item = record(value, `logcat ${event} event`);
  if (event === "ready") {
    if (!Array.isArray(item.pids)) fail("logcat ready event.pids must be an array");
    return {
      serial: string(item.serial, "logcat ready event.serial"),
      package: nullableString(item.package, "logcat ready event.package"),
      pids: item.pids.map((pid, index) =>
        string(pid, `logcat ready event.pids[${index}]`)
      ),
      search: nullableString(item.search, "logcat ready event.search"),
    } as LogcatEventMap[Event];
  }
  if (event === "log" || event === "error") {
    return {
      line: string(item.line, `logcat ${event} event.line`),
      at: string(item.at, `logcat ${event} event.at`),
    } as LogcatEventMap[Event];
  }
  return {
    code: item.code === null ? null : number(item.code, "logcat close event.code"),
    signal: nullableString(item.signal, "logcat close event.signal"),
  } as LogcatEventMap[Event];
}

export function parseLogcatEventJson<Event extends keyof LogcatEventMap>(
  event: Event,
  raw: string,
): LogcatEventMap[Event] {
  try {
    return parseLogcatEvent(event, JSON.parse(raw) as unknown);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new TypeError(`logcat ${event} event must be valid JSON`);
    }
    throw error;
  }
}

function parseScreenshotResponse(value: unknown): ScreenshotBase64Response | BinaryPngResponse {
  return value instanceof Uint8Array ? value : parseScreenshotBase64Response(value);
}

function parseCameraImageResponse(value: unknown): BinaryPngResponse {
  if (value instanceof Uint8Array) return value;
  return fail("camera image response must be PNG bytes");
}

function parseFrameStatsSummary(value: unknown): FrameStatsSummary | null {
  if (value === null) return null;
  const item = record(value, "health response.frameStats");
  const interval = item.intervalMs === null
    ? null
    : record(item.intervalMs, "health response.frameStats.intervalMs");
  return {
    windowFrames: number(item.windowFrames, "health response.frameStats.windowFrames"),
    intervalMs: interval === null
      ? null
      : {
          p50: number(interval.p50, "health response.frameStats.intervalMs.p50"),
          p95: number(interval.p95, "health response.frameStats.intervalMs.p95"),
          max: number(interval.max, "health response.frameStats.intervalMs.max"),
        },
    avgKeyFrameBytes: item.avgKeyFrameBytes === null
      ? null
      : number(item.avgKeyFrameBytes, "health response.frameStats.avgKeyFrameBytes"),
    avgDeltaFrameBytes: item.avgDeltaFrameBytes === null
      ? null
      : number(item.avgDeltaFrameBytes, "health response.frameStats.avgDeltaFrameBytes"),
    keyFramesInWindow: number(
      item.keyFramesInWindow,
      "health response.frameStats.keyFramesInWindow",
    ),
  };
}

function parseRollingTimingSummary(
  value: unknown,
  name: string,
): RollingTimingSummary | null {
  if (value === null) return null;
  const item = record(value, name);
  return {
    windowSamples: number(item.windowSamples, `${name}.windowSamples`),
    latest: number(item.latest, `${name}.latest`),
    p50: number(item.p50, `${name}.p50`),
    p95: number(item.p95, `${name}.p95`),
    max: number(item.max, `${name}.max`),
  };
}

function parseGrpcCaptureDiagnostics(value: unknown): GrpcCaptureDiagnostics {
  const item = record(value, "health response.grpcCapture");
  const timing = (field: keyof GrpcCaptureDiagnostics) =>
    parseRollingTimingSummary(
      item[field],
      `health response.grpcCapture.${field}`,
    );
  const numeric = (field: keyof GrpcCaptureDiagnostics) =>
    number(item[field], `health response.grpcCapture.${field}`);
  const nullableNumeric = (field: keyof GrpcCaptureDiagnostics) =>
    item[field] === null ? null : numeric(field);
  return {
    imageMode: oneOf(
      item.imageMode,
      GRPC_IMAGE_MODES,
      "health response.grpcCapture.imageMode",
    ),
    encoderName: item.encoderName === undefined || item.encoderName === null
      ? null
      : string(item.encoderName, "health response.grpcCapture.encoderName"),
    rawGrpcMessagesReceived: numeric("rawGrpcMessagesReceived"),
    rawGrpcMessagesEmitted: numeric("rawGrpcMessagesEmitted"),
    rawGrpcMessagesCoalesced: numeric("rawGrpcMessagesCoalesced"),
    usableImages: numeric("usableImages"),
    sourceTimestampFps: nullableNumeric("sourceTimestampFps"),
    rawMessageReceiveFps: nullableNumeric("rawMessageReceiveFps"),
    usableImageFps: nullableNumeric("usableImageFps"),
    freshEncoderWriteFps: nullableNumeric("freshEncoderWriteFps"),
    sequenceGaps: numeric("sequenceGaps"),
    imagePayloadBytes: numeric("imagePayloadBytes"),
    transportBytes: numeric("transportBytes"),
    grpcMessageBytesReceived: numeric("grpcMessageBytesReceived"),
    mmapFileBytesRead: numeric("mmapFileBytesRead"),
    mmapReadRetries: numeric("mmapReadRetries"),
    mmapTornFramesDropped: numeric("mmapTornFramesDropped"),
    sourceTimestampIntervalMs: timing("sourceTimestampIntervalMs"),
    rawMessageReceiveIntervalMs: timing("rawMessageReceiveIntervalMs"),
    productionToReceiveLatencyMs: timing("productionToReceiveLatencyMs"),
    productionToUsableLatencyMs: timing("productionToUsableLatencyMs"),
    protobufDecodeTimeMs: timing("protobufDecodeTimeMs"),
    sharedReadCopyTimeMs: timing("sharedReadCopyTimeMs"),
    freshEncoderWriteAttempts: numeric("freshEncoderWriteAttempts"),
    repeatEncoderWriteAttempts: numeric("repeatEncoderWriteAttempts"),
    acceptedEncoderWrites: numeric("acceptedEncoderWrites"),
    encoderBackpressureRejections: numeric("encoderBackpressureRejections"),
  };
}

function parseHealthClient(value: unknown, index: number): HealthClient {
  const item = record(value, `health response.clientsDetail[${index}]`);
  return {
    id: number(item.id, `health response.clientsDetail[${index}].id`),
    frameMeta: boolean(
      item.frameMeta,
      `health response.clientsDetail[${index}].frameMeta`,
    ),
    sentFrames: number(
      item.sentFrames,
      `health response.clientsDetail[${index}].sentFrames`,
    ),
    droppedFrames: number(
      item.droppedFrames,
      `health response.clientsDetail[${index}].droppedFrames`,
    ),
    backpressureEvents: number(
      item.backpressureEvents,
      `health response.clientsDetail[${index}].backpressureEvents`,
    ),
    bufferedBytes: number(
      item.bufferedBytes,
      `health response.clientsDetail[${index}].bufferedBytes`,
    ),
    awaitingKeyFrame: boolean(
      item.awaitingKeyFrame,
      `health response.clientsDetail[${index}].awaitingKeyFrame`,
    ),
  };
}

function parseErrorMeta(value: unknown): Record<string, string | number> | null {
  if (value === null) return null;
  const item = record(value, "health response.lastErrorMeta");
  const result: Record<string, string | number> = {};
  for (const [key, entry] of Object.entries(item)) {
    if (typeof entry === "string") result[key] = entry;
    else result[key] = number(entry, `health response.lastErrorMeta.${key}`);
  }
  return result;
}

export function parseHealthResponse(value: unknown): HealthResponse {
  const root = record(value, "health response");
  // Validate the fields consumed by clients plus the nested state contracts.
  const health: HealthResponse = {
    ok: boolean(root.ok, "health response.ok"),
    status: oneOf(root.status, ["streaming", "stopped", "error"] as const, "health response.status"),
    serial: string(root.serial, "health response.serial"),
    device: string(root.device, "health response.device"),
    ...(root.streamMode === undefined
      ? {}
      : {
          streamMode: oneOf(
            root.streamMode,
            STREAM_MODES,
            "health response.streamMode",
          ),
        }),
    ...(root.grpcImageMode === undefined
      ? {}
      : {
          grpcImageMode: oneOf(
            root.grpcImageMode,
            GRPC_IMAGE_MODES,
            "health response.grpcImageMode",
          ),
        }),
    ...(root.inputSource === undefined
      ? {}
      : {
          inputSource: oneOf(
            root.inputSource,
            INPUT_SOURCES,
            "health response.inputSource",
          ),
        }),
    ...(root.encoderName === undefined
      ? {}
      : {
          encoderName: root.encoderName === null
            ? null
            : string(root.encoderName, "health response.encoderName"),
        }),
    ...(root.grpcCapture === undefined
      ? {}
      : {
          grpcCapture: root.grpcCapture === null
            ? null
            : parseGrpcCaptureDiagnostics(root.grpcCapture),
        }),
    codec: string(root.codec, "health response.codec"),
    size: parseDeviceSize(root.size, "health response.size"),
    clients: number(root.clients, "health response.clients"),
    frames: number(root.frames, "health response.frames"),
    sourceFps: number(root.sourceFps, "health response.sourceFps"),
    frameStats: parseFrameStatsSummary(root.frameStats),
    configPackets: number(root.configPackets, "health response.configPackets"),
    droppedFrames: number(root.droppedFrames, "health response.droppedFrames"),
    backpressureEvents: number(root.backpressureEvents, "health response.backpressureEvents"),
    videoResetRequests: number(root.videoResetRequests, "health response.videoResetRequests"),
    lastVideoResetAt: nullableString(root.lastVideoResetAt, "health response.lastVideoResetAt"),
    lastVideoResetReason: nullableString(root.lastVideoResetReason, "health response.lastVideoResetReason"),
    location: root.location === null ? null : parseAppliedGeoFix(root.location, "health response.location"),
    route: parseRoutePlaybackSnapshot(root.route),
    session: parseSessionSnapshot(root.session),
    clientsDetail: Array.isArray(root.clientsDetail)
      ? root.clientsDetail.map(parseHealthClient)
      : fail("health response.clientsDetail must be an array"),
    startedAt: string(root.startedAt, "health response.startedAt"),
    stoppedAt: nullableString(root.stoppedAt, "health response.stoppedAt"),
    lastFrameAt: nullableString(root.lastFrameAt, "health response.lastFrameAt"),
    lastError: nullableString(root.lastError, "health response.lastError"),
    lastErrorCode: nullableString(root.lastErrorCode, "health response.lastErrorCode"),
    lastErrorMeta: parseErrorMeta(root.lastErrorMeta),
  };
  if (root.sessionGeneration !== undefined) {
    const generation = number(
      root.sessionGeneration,
      "health response.sessionGeneration",
    );
    if (!Number.isSafeInteger(generation) || generation < 0) {
      fail("health response.sessionGeneration must be a non-negative safe integer");
    }
    health.sessionGeneration = generation;
  }
  if (root.encoderSettings !== undefined) {
    const encoderSettings = parseStreamEncoderSettingsResponse({
      ok: true,
      ...record(root.encoderSettings, "health response.encoderSettings"),
    });
    health.encoderSettings = {
      maxDimension: encoderSettings.maxDimension,
      h264Bitrate: encoderSettings.h264Bitrate,
      h264Fps: encoderSettings.h264Fps,
    };
  }
  return health;
}

type AnySuccessParser = (value: unknown) => unknown;
type ApiSuccessParserMap = {
  [Path in ApiPath]: {
    [Method in ApiMethod<Path>]: (
      value: unknown,
    ) => ApiSuccessResponse<Path, Method>;
  };
};

const unsupportedStreamingResponse = (): never => fail("streaming responses are not JSON API payloads");

/** Runtime parser table used by both server tests and the typed UI client. */
export const API_SUCCESS_PARSERS = {
  "/api": { GET: parseApiInfoResponse },
  "/api/devices": { GET: parseDeviceListResponse },
  "/api/device-grid": { GET: parseDeviceGridResponse },
  "/api/devices/select": { POST: parseDeviceSelectionResponse },
  "/api/stream-mode": {
    GET: parseStreamModeResponse,
    PUT: parseStreamModeResponse,
  },
  "/api/stream-settings": {
    GET: parseStreamEncoderSettingsResponse,
    PATCH: parseStreamEncoderSettingsResponse,
  },
  "/api/avds/start": { POST: parseAvdStartResponse },
  "/api/avds/stop": { POST: parseAvdStopResponse },
  "/api/orientation": { GET: parseOrientationResponse, POST: parseOrientationResponse },
  "/api/night-mode": { GET: parseNightModeResponse, POST: parseNightModeResponse },
  "/api/font-scale": { GET: parseFontScaleResponse, POST: parseFontScaleResponse },
  "/api/network": { GET: parseNetworkResponse, POST: parseNetworkResponse },
  "/api/reduce-motion": { GET: parseReduceMotionResponse, POST: parseReduceMotionResponse },
  "/api/high-text-contrast": {
    GET: parseHighTextContrastResponse,
    POST: parseHighTextContrastResponse,
  },
  "/api/font-weight": { GET: parseFontWeightResponse, POST: parseFontWeightResponse },
  "/api/software-keyboard": {
    GET: parseSoftwareKeyboardResponse,
    POST: parseSoftwareKeyboardResponse,
  },
  "/api/display-density": {
    GET: parseDisplayDensityResponse,
    POST: parseDisplayDensityResponse,
  },
  "/api/logcat": { GET: unsupportedStreamingResponse },
  "/api/metrics": { GET: unsupportedStreamingResponse },
  "/api/screenshot": { GET: parseScreenshotResponse, POST: parseScreenshotResponse },
  "/api/foreground": { GET: parseForegroundResponse },
  "/api/accessibility": { GET: parseAccessibilitySnapshot },
  "/api/accessibility/tap": { POST: parseAccessibilityTapResponse },
  "/api/tap": { POST: parseEmptyResponse },
  "/api/swipe": { POST: parseEmptyResponse },
  "/api/text": { POST: parseEmptyResponse },
  "/api/key": { POST: parseEmptyResponse },
  "/api/session": { GET: parseSessionSnapshot, DELETE: parseSessionMutationResponse },
  "/api/session/replay": { POST: parseSessionMutationResponse },
  "/api/session/replay/stop": { POST: parseSessionMutationResponse },
  "/api/apps/install": { POST: parseAppActionResponse },
  "/api/files/import": { POST: parseFileImportResponse },
  "/api/apps/launch": { POST: parseAppActionResponse },
  "/api/apps/clear": { POST: parseAppActionResponse },
  "/api/apps/force-stop": { POST: parseAppActionResponse },
  "/api/apps/grant": { POST: parseAppActionResponse },
  "/api/apps/permissions": { GET: parseAppPermissionsResponse },
  "/api/apps/revoke": { POST: parseAppActionResponse },
  "/api/apps/reset-permissions": { POST: parseAppActionResponse },
  "/api/apps/icon": { GET: parseAppIconResponse },
  "/api/location": { GET: parseLocationResponse, POST: parseLocationUpdateResponse },
  "/api/route": {
    GET: parseRoutePlaybackSnapshot,
    POST: parseRouteMutationResponse,
    DELETE: parseRouteMutationResponse,
  },
  "/api/route/control": { POST: parseRouteMutationResponse },
  "/api/camera": { GET: parseCameraStatusResponse },
  "/api/camera/image": {
    GET: parseCameraImageResponse,
    POST: parseCameraStatusResponse,
    DELETE: parseCameraStatusResponse,
  },
} satisfies ApiSuccessParserMap;

export function parseApiSuccess<
  Path extends ApiPath,
  Method extends ApiMethod<Path>,
>(path: Path, method: Method, value: unknown): ApiSuccessResponse<Path, Method> {
  const methods = API_SUCCESS_PARSERS[path] as Partial<Record<ApiMethod<Path>, AnySuccessParser>>;
  const parser = methods[method];
  if (!parser) fail(`no API parser registered for ${method} ${path}`);
  return parser(value) as ApiSuccessResponse<Path, Method>;
}

export function parseApiResponse<
  Path extends ApiPath,
  Method extends ApiMethod<Path>,
>(path: Path, method: Method, value: unknown): ApiResponse<Path, Method> {
  return isRecord(value) && value.ok === false
    ? parseApiFailure(value)
    : parseApiSuccess(path, method, value);
}
