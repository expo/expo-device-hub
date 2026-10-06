/**
 * The common device-client interface.
 *
 * Expo Hub mirrors live simulators (serve-sim) and emulators (serve-emu) inside
 * the {@link PhoneFrame}, in place of the static `<img>` placeholder. Both
 * backends speak very different wire protocols — serve-sim streams MJPEG/H.264
 * and takes binary touch packets over its own WebSocket; serve-emu streams
 * H.264 (WebCodecs) and takes JSON gestures over a single WebSocket — so this
 * file defines one shared shape both can implement:
 *
 *   - {@link DeviceClientProvider} to own the connection, with {@link useDeviceClient}
 *     and {@link useDeviceClientSelector} to read its state and controls, and
 *   - a **component** ({@link DeviceScreen}, see `./DeviceScreen.tsx`) that paints
 *     the stream and forwards pointer/gesture input.
 *
 * Pass the result of {@link useDeviceScreenClient} to `DeviceScreen` to follow
 * screen and input changes without subscribing to metrics, FPS or logs.
 */

import { type CSSProperties } from 'react';

export type DevicePlatform = 'ios' | 'android';

/** Viewer-selected transport for the active device stream. */
export type DeviceStreamMode = 'mjpeg' | 'h264' | 'webrtc';


/** Device orientation, as reported by serve-sim's stream config. */
export type DeviceOrientation =
  | 'portrait'
  | 'portrait_upside_down'
  | 'landscape_left'
  | 'landscape_right';

/** Native pixel size of the streamed screen — drives the PhoneFrame aspect ratio. */
export interface ScreenSize {
  width: number;
  height: number;
  /** Last known orientation, when the backend reports it (serve-sim). */
  orientation?: DeviceOrientation;
}

/** A simulator/emulator the server reports as running. */
export interface RunningDevice {
  /** udid (iOS) / adb serial (Android). */
  id: string;
  name: string;
  /** e.g. "iOS 27.0" / "Android 16". */
  system?: string;
  platform: DevicePlatform;
  /** True for the device this connection is currently streaming. */
  current?: boolean;
}

/** A single line of device output (syslog / logcat). */
export interface DeviceLog {
  id: string;
  /** Short monospace source tag, e.g. `logcat` / `syslog`. */
  source: string;
  message: string;
}

/** A normalized device interaction or command reported by a device backend. */
export interface DeviceEvent {
  /** Stable within a device session and namespaced by the backend/device. */
  id: string;
  /** ISO timestamp reported by the backend. */
  timestamp: string;
  /** Backend event source, e.g. `hid`, `ui`, `ws`, or `rest:tap`. */
  source: string;
  /** Broad event category used for display and filtering. */
  kind: string;
  /** More specific operation within {@link kind}, when available. */
  action?: string;
  /** Whether the backend reported the operation as successful or failed. */
  status?: 'ok' | 'error';
  /** Human-readable, privacy-safe event summary. */
  message: string;
  /** Structured event data retained for future richer presentation. */
  details?: Record<string, unknown>;
}

/** Simulator/device-wide settings exposed by serve-sim and serve-emu. */
export type DeviceSettingKey =
  | 'appearance'
  | 'network'
  | 'liquid-glass'
  | 'color-filter'
  | 'text-size'
  | 'display-size'
  | 'reduce-motion'
  | 'bold-text'
  | 'increase-contrast'
  | 'onscreen-keyboard'
  | 'show-borders'
  | 'reduce-transparency'
  | 'voiceover';

/** Current backend-reported values. Missing keys are unavailable; `unsupported` keys are hidden. */
export type DeviceSettings = Partial<Record<DeviceSettingKey, string>>;

/** Which emulator camera a feed drives. */
export type DeviceCameraFacing = 'back' | 'front';

/** One emulator camera fed from a PNG on the host. */
export interface DeviceCameraFeed {
  facing: DeviceCameraFacing;
  /** True while the feed still holds the backend's "no image set" test card. */
  placeholder: boolean;
  width: number | null;
  height: number | null;
  bytes: number | null;
  /** Same-origin URL of the current PNG, or null when no file exists yet. Embeds the digest so a changed image refetches. */
  imageUrl: string | null;
}

/** Host-side still-image camera feeds for an Android emulator. */
export interface DeviceCameraStatus {
  /** True when the emulator was launched with the feed files attached. False means images are stored but never shown. */
  wiredAtLaunch: boolean;
  feeds: readonly DeviceCameraFeed[];
}

/** One live CPU, memory, and network sample for the foreground iOS app. */
export interface DeviceActivitySample {
  /** Milliseconds since the backend sampler started. */
  t: number;
  bundleId: string | null;
  /** Per-core CPU utilization. It can exceed 100 on multicore workloads. */
  cpuPct: number;
  memBytes: number;
  netInBytesPerSec: number;
  netOutBytesPerSec: number;
}

/** Rolling activity history and health for the selected device. */
export interface DeviceActivity {
  hostCores: number | null;
  samples: readonly DeviceActivitySample[];
  errored: boolean;
  stale: boolean;
}

/** Viewer-local HTTP stream codec selection. */
export type DeviceHttpCodec = 'auto' | 'mjpeg' | 'h264';

/** Viewer-local WebRTC codec selection. */
export type DeviceWebRtcCodec = 'h264' | 'vp9' | 'vp8';

/** Stream transports and codecs supported by the active backend. */
export interface DeviceStreamCapabilities {
  modeAvailability: Record<DeviceStreamMode, boolean>;
  httpCodecs: readonly DeviceHttpCodec[];
  webRtcCodecs: readonly DeviceWebRtcCodec[];
}

/** Runtime encoder settings exposed by a backend's stream-settings endpoint. */
export interface DeviceStreamEncoderSettings {
  mjpegFps: number;
  mjpegQuality: number;
  maxDimension: number;
  h264Bitrate: number;
  h264Fps: number;
}

/** Android capture implementations exposed by serve-emu. */
export type DeviceStreamSource = 'scrcpy' | 'grpc-screenshot';

/** Pixel delivery selected for the emulator gRPC screenshot source. */
export type DeviceGrpcImageMode = 'png' | 'mmap' | 'rgb888';

/** Host H.264 encoder used for emulator gRPC screenshots. */
export type DeviceGrpcEncoder = 'software' | 'hardware';

/** Input transport used while gRPC provides emulator video. */
export type DeviceInputSource = 'scrcpy' | 'grpc';

/** Authoritative source state for the selected Android device session. */
export interface DeviceStreamSourceStatus {
  mode: DeviceStreamSource;
  grpcImageMode: DeviceGrpcImageMode;
  encoder: DeviceGrpcEncoder;
  /** Active ffmpeg encoder; null before capture starts or when using scrcpy. */
  encoderName: string | null;
  availableEncoders: readonly DeviceGrpcEncoder[];
  hardwareEncoderError?: string;
  inputSource: DeviceInputSource;
  availableInputSources: readonly DeviceInputSource[];
  availableModes: readonly DeviceStreamSource[];
  sessionGeneration: number;
}

/** A WGS84 coordinate the Hub asks a device to report. */
export interface DeviceGeoFix {
  latitude: number;
  longitude: number;
}

/** One WebRTC telemetry sample, normally collected once per second. */
export interface DeviceStreamStatsSample {
  atMs: number;
  /** Frames produced by the active backend WebRTC source/encoder. */
  serverFps: number | null;
  /** Video frames actually presented by the browser. */
  clientFps: number | null;
  /** Actual inbound video media bitrate, derived from `bytesReceived`. */
  clientBitrateBps: number | null;
  /** Packet loss over this sample window, expressed as a ratio from 0 to 1. */
  clientPacketLossRatio: number | null;
  /** Current inbound RTP jitter reported by the browser. */
  clientJitterMs: number | null;
  /** Mean jitter-buffer delay per emitted frame over this sample window. */
  clientJitterBufferMs: number | null;
  /** Browser-decoded frames dropped during this sample window. */
  clientDroppedFrames: number | null;
  /** Playback freezes reported during this sample window. */
  clientFreezeCount: number | null;
  /** Total time spent frozen during this sample window. */
  clientFreezeDurationMs: number | null;
  /** Current round-trip time for the browser's selected ICE candidate pair. */
  clientRoundTripMs: number | null;
  /** Whether the browser's selected ICE path is direct, relayed, or unknown. */
  clientIcePath: 'direct' | 'relay' | 'unknown';
}

/** Latest server-side WebRTC encoder statistics for this viewer. */
export interface DeviceStreamEncoderStats {
  codec: string | null;
  encodeFps: number | null;
  targetBitrateBps: number | null;
  encodeMsPerFrame: number | null;
  framesEncoded: number | null;
  framesSent: number | null;
  framesDropped: number | null;
  packetLossRatio: number | null;
  qualityLimitationReason: string | null;
  /** Android publisher submissions per second, derived from consecutive server snapshots. */
  publisherFps: number | null;
  /** H.264 frames accepted by serve-emu's native media track. */
  publisherSubmittedFrames: number | null;
  /** Frames rejected by serve-emu's keyframe gate or native backpressure. */
  publisherDroppedFrames: number | null;
  /** Submitted H.264 payload bitrate, excluding RTP/SRTP/transport overhead and retransmits. */
  payloadBitrateBps: number | null;
}

/** Median and 95th-percentile timings in milliseconds. */
export interface DeviceStreamTimingQuantiles {
  p50: number | null;
  p95: number | null;
}

/** Latest gRPC screenshot producer, transport, and host-copy diagnostics. */
export interface DeviceGrpcCaptureStats {
  /** Selected emulator screenshot delivery strategy. */
  imageMode: DeviceGrpcImageMode | null;
  /** Emulator frame-production cadence inferred from source timestamps. */
  producerFps: number | null;
  /** Raw screenshot messages reaching serve-emu. */
  receiveFps: number | null;
  /** Valid images available to the host encoder. */
  usableImageFps: number | null;
  /** Fresh images submitted to FFmpeg, excluding deliberate idle repeats. */
  encoderInputFps: number | null;
  /** Raw screenshot notifications received from the emulator. */
  messagesReceived: number | null;
  /** Notifications selected for decoding/copying after capture pacing. */
  messagesEmitted: number | null;
  /** Pending notifications replaced by a newer frame before capture. */
  messagesCoalesced: number | null;
  sequenceGaps: number | null;
  imagePayloadBytes: number | null;
  transportBytes: number | null;
  messageBytesReceived: number | null;
  mmapFileBytesRead: number | null;
  mmapReadRetries: number | null;
  mmapTornFramesDropped: number | null;
  productionToReceiveLatencyMs: DeviceStreamTimingQuantiles;
  productionToUsableLatencyMs: DeviceStreamTimingQuantiles;
  protobufDecodeTimeMs: DeviceStreamTimingQuantiles;
  mmapReadCopyTimeMs: DeviceStreamTimingQuantiles;
}

/** Latest cumulative server-side capture and pacing counters. */
export interface DeviceStreamCaptureStats {
  screenFrames: number | null;
  idleFrames: number | null;
  offeredFrames: number | null;
  forwardedFrames: number | null;
  pumpRestarts: number | null;
  /** Null when the active capture source does not expose gRPC diagnostics. */
  grpc: DeviceGrpcCaptureStats | null;
}

/** Bounded WebRTC telemetry history owned by the device connection. */
export interface DeviceStreamStats {
  samples: readonly DeviceStreamStatsSample[];
  encoder: DeviceStreamEncoderStats | null;
  capture: DeviceStreamCaptureStats | null;
  /** True when the peer has not produced a successful sample for four seconds. */
  stale: boolean;
  /** True when the server-side statistics poll has not succeeded for four seconds. */
  serverStale: boolean;
}

/** A rectangle in 0..1 screen fractions, so every platform taps through `sendTouch` unchanged. */
export interface AccessibilityFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One accessible element of the current screen, normalized across backends. */
export interface AccessibilityNode {
  id: string;
  /** Never empty — the parsers drop elements that carry no name. */
  label: string;
  /** iOS role or element type; Android the class-name tail, e.g. `TextView`. */
  role: string;
  enabled: boolean;
  clickable: boolean;
  frame: AccessibilityFrame;
}

export interface AccessibilitySnapshot {
  /** Epoch milliseconds. */
  capturedAt: number;
  nodes: readonly AccessibilityNode[];
}

/** How the device answers one permission of the foreground app. */
export type AppPermissionState = 'granted' | 'denied' | 'limited' | 'undetermined';

/** One permission row. `id` is the backend name (`android.permission.CAMERA`, `camera`). */
export interface AppPermission {
  id: string;
  label: string;
  state: AppPermissionState;
}

export type AppPermissionAction = 'grant' | 'revoke';

/** The app currently in the foreground on the device. */
export interface ForegroundApp {
  /** Bundle identifier (iOS) / package name (Android). */
  id: string;
  /** Human-readable app label (Android `dumpsys`, iOS `CFBundleDisplayName`). */
  label?: string;
  /** Foreground process id, when known. */
  pid?: number;
  /** True when the backend detected a React Native app (serve-sim). */
  isReactNative?: boolean;
  /** Marketing version — iOS `CFBundleShortVersionString` / Android `versionName`. */
  version?: string;
  /** Build identifier — iOS `CFBundleVersion` / Android `versionCode`. */
  build?: string;
  /** App icon as a `data:` URL, when the backend can extract one. */
  iconDataUrl?: string;
  /** Fully-qualified foreground activity (Android). */
  activity?: string;
  /** Whether the app is debuggable (Android). */
  debuggable?: boolean;
  /** Minimum supported Android API level, e.g. 24 (Android). */
  minSdk?: number;
  /** `MinimumOSVersion` from Info.plist (iOS). */
  minOS?: string;
  /** `CFBundleExecutable` from Info.plist (iOS). */
  executable?: string;
  /** Path of the installed `.app` bundle on the host (iOS). */
  appPath?: string;
}

/** Hardware buttons. Implementations ignore the ones their platform lacks. */
export type HardwareButton =
  | 'home'
  | 'back'
  | 'recents'
  | 'power'
  | 'appSwitcher'
  /** Dismisses the on-screen keyboard. Not a physical button; grouped here because it presses one key. */
  | 'hideKeyboard';

/** One normalized (0..1) touch sample. The hook maps it to the wire protocol. */
export interface TouchSample {
  phase: 'begin' | 'move' | 'end';
  /** 0..1 across the screen width. */
  x: number;
  /** 0..1 down the screen height. */
  y: number;
  /** Whether a `begin` at a screen edge may start a system edge gesture (the iOS swipe-to-home band). Defaults to true. */
  edgeGestures?: boolean;
}

/** A two-finger gesture sample (pinch/pan). Both points are normalized 0..1. */
export interface MultiTouchSample {
  phase: 'begin' | 'move' | 'end';
  a: { x: number; y: number };
  b: { x: number; y: number };
}

/** A physical browser-keyboard event forwarded by {@link DeviceScreen}. */
export interface KeyboardInput {
  phase: 'down' | 'up';
  /** Physical browser key, e.g. `KeyA`, `ShiftLeft`, or `Enter`. */
  code: string;
  /** Layout-resolved value, e.g. `a`, `A`, `é`, or `Enter`. */
  key: string;
  /** Whether this is an auto-repeated keydown. */
  repeat: boolean;
}

/**
 * One HID key transition (USB HID Usage Page 0x07), e.g. produced by
 * {@link KeyboardCapture} from phone-keyboard text. Forwarded as-is over
 * serve-sim's `0x06` key channel.
 */
export type HidKeyEvent = { type: 'down' | 'up'; usage: number };

/**
 * A scroll-wheel / trackpad pan over the screen, in *display* space. Deltas are
 * a fraction of the rendered display (positive `dy` scrolls content down, as a
 * physical wheel would); `x`/`y` (0..1) anchor the pan under the pointer so the
 * device pans the view beneath it (e.g. a sheet rather than the map behind it).
 */
export interface ScrollSample {
  dx: number;
  dy: number;
  x: number;
  y: number;
}

/** A normalized point rendered over the device's display-aligned stream. */
export interface AgentInteractionPoint {
  x: number;
  y: number;
}

/** A frame within one continuous Argent touch gesture. */
export interface AgentInteractionFrame {
  /** Milliseconds since this segment began. */
  atMs: number;
  /** One point for touch gestures, two for pinch/rotate gestures. */
  points: AgentInteractionPoint[];
}

/** A continuous gesture within a possibly batched Argent interaction. */
export interface AgentInteractionSegment {
  /** Milliseconds since the outer Argent tool call. */
  startMs: number;
  frames: AgentInteractionFrame[];
  easing?: 'linear' | 'ease-out';
}

/** Parsed, visualization-safe geometry from an Argent MCP tool call. */
export interface AgentInteraction {
  id: string;
  deviceId: string;
  timestamp: string;
  segments: AgentInteractionSegment[];
}

export interface DeviceConnectionOptions {
  /**
   * Origin (and optional base path) of a running serve-sim / serve-emu server,
   * e.g. `http://localhost:3100`. When empty/null the hook stays `idle`.
   */
  baseUrl?: string | null;
  /** Tear the connection down when false. Defaults to true. */
  enabled?: boolean;
  /**
   * Which running device (udid/serial) to stream. serve-sim selects the matching
   * helper via `/api?device=<udid>`; when omitted the first available is used.
   */
  device?: string | null;
  /**
   * Stream transport selected by the consumer. There is intentionally no
   * client-level default; products embedding Hub own their default choice.
   * Each backend adapter maps unavailable choices to one of its supported modes.
   */
  streamMode: DeviceStreamMode;
  /**
   * Session token of a Hub or serve-sim started with `--require-token`, such as an
   * EAS Simulator Preview session, for a page on another origin. The
   * client sends it as a bearer header, a WebSocket subprotocol, and `?token=`
   * where a browser cannot set a header. A page the server served itself can omit
   * it: its cookie covers every request.
   */
  token?: string | null;
}

/** Which element the implementation paints into. */
export type VideoSurfaceKind = 'canvas' | 'img' | 'video';

export type DeviceScreenRecordingStatus =
  | 'unknown'
  | 'waiting'
  | 'recording'
  | 'finalizing'
  | 'complete'
  | 'failed';

/**
 * Whether a screenshot also reached the session artifacts, read from the
 * backend's `X-Expo-Screenshot-Artifact` response headers. `disabled` means the
 * backend runs outside an EAS session.
 */
export type ScreenshotArtifact =
  | { status: 'saved' | 'disabled' }
  | {
      status: 'failed';
      /** Why the save failed, when the backend says. */
      error?: string;
    };

/**
 * A still PNG of the device and its session artifact outcome. `artifact` is
 * `null` when the backend sent no header, as older serve-sim and serve-emu
 * builds do, or a value this client does not know.
 */
export type ScreenshotCapture = {
  blob: Blob;
  artifact: ScreenshotArtifact | null;
};

/** A request failure with a stable code and a UI-ready message. */
export interface HubError {
  code:
    | 'unsupported'
    | 'busy'
    | 'network'
    | 'timeout'
    | 'auth'
    | 'rejected'
    | 'invalid-response'
    | 'cancelled';
  message: string;
  retryable: boolean;
}

/** Expected request failures are values, never rejected promises. */
export type HubResult<T = void> = { ok: true; value: T } | { ok: false; error: HubError };

export type FeatureState<D> =
  | { status: 'resolving'; data: undefined; error: null }
  | { status: 'unsupported'; data: undefined; error: null }
  | { status: 'idle'; data: D | undefined; error: null }
  | { status: 'loading'; data: D | undefined; error: null }
  | { status: 'ready'; data: D; error: null }
  | { status: 'reconnecting'; data: D | undefined; error: HubError }
  | { status: 'error'; data: D | undefined; error: HubError };

/** Data survives refresh/failure of the same target, never a device/app change. */
export type Feature<D> = FeatureState<D> & { refresh(): void };
export interface Writes<K extends string> {
  pending: ReadonlySet<K>;
  errors: ReadonlyMap<K, HubError>;
}
/**
 * One shared subscription per client. Attach/detach are idempotent, not
 * reference-counted: one detach stops the data for every consumer.
 */
export interface Attachable {
  enabled: boolean;
  attach(): void;
  detach(): void;
}
export interface StreamData {
  screen: ScreenSize | null;
  fps: number;
}
export interface DeviceSettingsData {
  values: DeviceSettings;
  displayWidthDp: number | null;
}
export interface AppPermissionsData {
  appId: string | null;
  items: readonly AppPermission[];
}
export type StreamSourcePatch = Partial<
  Pick<DeviceStreamSourceStatus, 'mode' | 'grpcImageMode' | 'encoder' | 'inputSource'>
>;
export type ScreenRecordingPhase = Exclude<DeviceScreenRecordingStatus, 'unknown'>;
export interface InputData {
  /** The last input command the backend refused, or null. The next input clears it. */
  rejected: HubError | null;
}
export type DeviceSettingsFeature = Feature<DeviceSettingsData> & {
  writes: Writes<DeviceSettingKey>;
  set(key: DeviceSettingKey, value: string): Promise<HubResult>;
};
export type PermissionsFeature = Feature<AppPermissionsData> & {
  writes: Writes<string>;
  set(id: string, action: AppPermissionAction): Promise<HubResult>;
  reset(): Promise<HubResult>;
};

/** Public device API. Each backend-backed value owns its state and actions. */
export interface DeviceClient {
  platform: DevicePlatform;
  stream: Feature<StreamData> & {
    videoKind: VideoSurfaceKind;
    attachVideo(el: HTMLCanvasElement | HTMLImageElement | HTMLVideoElement | null): void;
    transports: DeviceStreamCapabilities;
    webRtcCodec: DeviceWebRtcCodec;
    setWebRtcCodec(codec: DeviceWebRtcCodec): void;
  };
  streamSettings: Feature<DeviceStreamEncoderSettings> & {
    editable: ReadonlySet<keyof DeviceStreamEncoderSettings>;
    writes: Writes<keyof DeviceStreamEncoderSettings>;
    update(patch: Partial<DeviceStreamEncoderSettings>): Promise<HubResult>;
  };
  streamSource: Feature<DeviceStreamSourceStatus> & {
    writes: Writes<keyof StreamSourcePatch>;
    update(patch: StreamSourcePatch): Promise<HubResult>;
  };
  streamStats: Feature<DeviceStreamStats> & Attachable;
  screenRecording: Feature<ScreenRecordingPhase>;
  devices: Feature<readonly RunningDevice[]>;
  foregroundApp: Feature<ForegroundApp | null>;
  logs: Feature<readonly DeviceLog[]> & Attachable & { clear(): void };
  events: Feature<readonly DeviceEvent[]> & Attachable & { clear(): void };
  activity: Feature<Omit<DeviceActivity, 'errored'>> & Attachable;
  deviceSettings: DeviceSettingsFeature;
  keyboard: Feature<{ hardwareConnected: boolean }> & {
    writes: Writes<'hardwareConnected'>;
    setHardwareConnected(connected: boolean): Promise<HubResult>;
    toggleSoftware(): void;
  };
  camera: Feature<DeviceCameraStatus> & {
    writes: Writes<DeviceCameraFacing>;
    setImage(facing: DeviceCameraFacing, png: Blob): Promise<HubResult>;
    clearImage(facing: DeviceCameraFacing): Promise<HubResult>;
  };
  accessibility: Feature<AccessibilitySnapshot>;
  location: Feature<DeviceGeoFix | null> & {
    canClear: boolean;
    writes: Writes<'fix'>;
    set(fix: DeviceGeoFix): Promise<HubResult>;
    clear(): Promise<HubResult>;
  };
  permissions: PermissionsFeature;
  /**
   * Whether touch and keyboard input reach the device. The commands below stay
   * on the client because they are fire-and-forget and frequent.
   *
   * - `ready`: no input failure is known. Input also needs a live stream.
   * - `reconnecting`: the input channel is down or busy and retries. iOS:
   *   serve-sim refused the input socket (too many clients, or a full input
   *   queue), code `busy`. Android: the WebRTC input socket is down, code `network`.
   * - `error`: serve-sim's native HID setup failed; input stays unavailable
   *   until serve-sim restarts.
   *
   * `data.rejected` is the last input command the backend refused (Android);
   * the next input clears it. `refresh()` reconnects the input channel.
   */
  input: Feature<InputData>;
  sendTouch(sample: TouchSample): void;
  sendMultiTouch(sample: MultiTouchSample): void;
  sendKey(input: KeyboardInput): boolean;
  sendKeyEvents?: (events: ReadonlyArray<HidKeyEvent>) => void;
  sendScroll?: (sample: ScrollSample) => void;
  pressButton(button: HardwareButton): void;
  reload(): void;
  rotate(): void;
  screenshot(): Promise<HubResult<ScreenshotCapture>>;
}

/** A platform implementation of the connection half of the interface. */
export type DeviceClientHook = (options: DeviceConnectionOptions) => DeviceClient;

/**
 * The stream and input values read by DeviceScreen, flattened from
 * `DeviceClient.stream` so a screen does not re-render on FPS changes.
 * Full DeviceClient values remain valid DeviceScreen inputs.
 */
export type DeviceScreenClient = Pick<DeviceClient['stream'], 'videoKind' | 'attachVideo' | 'status'> &
  Pick<DeviceClient, 'sendTouch' | 'sendMultiTouch' | 'sendScroll' | 'sendKey'> & {
    /** Screen size once known; null while connecting. */
    screen: ScreenSize | null;
    /** The stream error message, or null. */
    error: string | null;
  };

/** Props for the shared {@link DeviceScreen} component rendered inside PhoneFrame. */
export interface DeviceScreenProps {
  client: DeviceClient;
  /** Last active Argent gesture for the streamed device; removed after its idle timeout. */
  agentInteraction?: AgentInteraction | null;
  /** Corner radius for the video surface (matches the PhoneFrame placeholder). */
  borderRadius?: CSSProperties['borderRadius'];
  /** Apply the iOS `corner-shape: squircle`. */
  squircle?: boolean;
}

/** The built-in screen also accepts the inputs returned by useDeviceScreenClient. */
export interface DeviceScreenInputProps extends Omit<DeviceScreenProps, 'client'> {
  client: DeviceClient | DeviceScreenClient;
}
