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
 *   - a **hook** ({@link DeviceClientHook}) that owns the connection and returns
 *     the live {@link DeviceClient} state + controls, and
 *   - a **component** ({@link DeviceScreen}, see `./DeviceScreen.tsx`) that paints
 *     the stream and forwards pointer/gesture input.
 *
 * `useIosDeviceClient` (serve-sim) and `useAndroidDeviceClient` (serve-emu) are
 * the two implementations; `DeviceScreen` renders whichever one is active.
 */

import { type CSSProperties } from 'react';

export type DevicePlatform = 'ios' | 'android';

/** Viewer-selected transport for the active device stream. */
export type DeviceStreamMode = 'mjpeg' | 'h264' | 'webrtc';

/**
 * Lifecycle of a single connection:
 *   idle       — nothing to connect to (no base URL / disabled)
 *   connecting — socket opening, no frames yet
 *   streaming  — frames are flowing
 *   error      — connection failed or dropped
 */
export type ConnectionStatus = 'idle' | 'connecting' | 'streaming' | 'error';

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
  | 'reduce-motion'
  | 'increase-contrast'
  | 'show-borders'
  | 'reduce-transparency'
  | 'voiceover';

/** Current backend-reported values. Missing keys are unavailable; `unsupported` keys are hidden. */
export type DeviceSettings = Partial<Record<DeviceSettingKey, string>>;

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
  samples: DeviceActivitySample[];
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
export type DeviceGrpcImageMode = 'png' | 'mmap';

/** Input transport used while gRPC provides emulator video. */
export type DeviceInputSource = 'scrcpy' | 'grpc';

/** Authoritative source state for the selected Android device session. */
export interface DeviceStreamSourceStatus {
  mode: DeviceStreamSource;
  grpcImageMode: DeviceGrpcImageMode;
  inputSource: DeviceInputSource;
  availableInputSources: readonly DeviceInputSource[];
  availableModes: readonly DeviceStreamSource[];
  sessionGeneration: number;
}

/** Runtime encoder values the active backend can change without restarting the Hub. */
export type DeviceStreamSettingCapabilities =
  | false
  | Readonly<Partial<Record<keyof DeviceStreamEncoderSettings, true>>>;

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

/** Explicit backend feature flags used to omit unsupported inspector sections and controls. */
export interface DeviceCapabilities {
  deviceSettings: boolean;
  activity: boolean;
  events: boolean;
  /** Runtime encoder settings that can be read and patched. */
  streamSettings: DeviceStreamSettingCapabilities;
}

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
  /** App icon as a `data:` URL, when the backend can extract one (iOS only today). */
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
export type HardwareButton = 'home' | 'back' | 'recents' | 'power' | 'appSwitcher';

/**
 * Device system appearance. Binary on purpose — the Hub exposes a plain
 * light/dark toggle with no "auto", even where the backend supports one
 * (serve-emu's `uimode night auto`).
 */
export type DeviceAppearance = 'light' | 'dark';

/** One normalized (0..1) touch sample. The hook maps it to the wire protocol. */
export interface TouchSample {
  phase: 'begin' | 'move' | 'end';
  /** 0..1 across the screen width. */
  x: number;
  /** 0..1 down the screen height. */
  y: number;
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
}

/** Which element the implementation paints into. */
export type VideoSurfaceKind = 'canvas' | 'img' | 'video';

/**
 * The live state + controls for one device connection. Returned by the hook and
 * consumed by {@link DeviceScreen} (for video + input) and by the surrounding
 * Hub UI (logs panel, Home control, device lists).
 */
export interface DeviceClient {
  platform: DevicePlatform;
  status: ConnectionStatus;
  error: string | null;
  /** Screen size once known; null while connecting. */
  screen: ScreenSize | null;
  /** Best-effort frames-per-second (0 when unavailable). */
  fps: number;
  /** Running devices the server exposes (may be a placeholder list). */
  devices: RunningDevice[];
  /** Rolling buffer of recent log lines (best-effort; may be empty). */
  logs: DeviceLog[];
  /**
   * Whether the log stream is currently attached. Logs are **off by default** —
   * nothing is collected until {@link attachLogs} is called.
   */
  logsEnabled: boolean;
  /** Start streaming device logs (syslog / logcat). */
  attachLogs: () => void;
  /** Stop streaming device logs; keeps the lines already collected. */
  detachLogs: () => void;
  /** Drop all collected log lines. */
  clearLogs: () => void;

  /** Rolling buffer of normalized touch, command, and UI-setting events. */
  events: DeviceEvent[];
  /** Whether the client is currently subscribed to/polling backend events. */
  eventsEnabled: boolean;
  /** Start observing backend events. */
  attachEvents: () => void;
  /** Stop observing events while retaining the current rows. */
  detachEvents: () => void;
  /** Clear the event rows visible in this client. */
  clearEvents: () => void;

  /** Live iOS app activity, or null before the first endpoint/config resolution. */
  activity: DeviceActivity | null;

  /** Backend-supported simulator/device options and their current values. */
  deviceSettings: DeviceSettings | null;
  /** Options currently being changed. Writes to other options remain available. */
  deviceSettingsPending: ReadonlySet<DeviceSettingKey>;
  /** Change one simulator/device option. Unsupported keys are ignored by each backend. */
  setDeviceSetting: (key: DeviceSettingKey, value: string) => void;

  /** Backend-supported viewer transport and codec choices; null hides stream controls. */
  streamCapabilities: DeviceStreamCapabilities | null;
  /** Runtime encoder settings, available when `capabilities.streamSettings` lists any keys. */
  streamSettings: DeviceStreamEncoderSettings | null;
  streamSettingsPending: boolean;
  /** Patch one or more runtime encoder values. */
  updateStreamSettings: (patch: Partial<DeviceStreamEncoderSettings>) => void;
  /** Active Android capture source; null when the backend does not expose source switching. */
  streamSource: DeviceStreamSourceStatus | null;
  streamSourcePending: boolean;
  /** Last capture-source write failure; cleared when another write begins. */
  streamSourceError: string | null;
  /** Stage and atomically activate another Android capture source. */
  setStreamSource: (source: DeviceStreamSource) => void;
  /** Restart the gRPC source with compressed PNG or shared-memory RGB delivery. */
  setGrpcImageMode: (mode: DeviceGrpcImageMode) => void;
  /** Restart gRPC streaming with scrcpy or emulator-gRPC input delivery. */
  setGrpcInputSource: (source: DeviceInputSource) => void;
  /** Live WebRTC stream telemetry; null for HTTP/WebSocket transports. */
  streamStats: DeviceStreamStats | null;
  /** Enable telemetry polling while a consumer is displaying WebRTC statistics. */
  setStreamStatsEnabled: (enabled: boolean) => void;
  /** Requested WebRTC codec for this viewer. */
  webRtcCodec: DeviceWebRtcCodec;
  setWebRtcCodec: (codec: DeviceWebRtcCodec) => void;

  /** Backend feature availability. Presentation uses this to omit unsupported UI. */
  capabilities: DeviceCapabilities;
  /**
   * The app currently in the foreground, or `null` while unknown. serve-sim
   * pushes changes over its `{base}/appstate` SSE (SpringBoard log driven,
   * bootstrapped with the current frontmost app); serve-emu polls
   * `GET /api/foreground` (dumpsys). Best-effort — stays `null` on a backend
   * that can't report it (e.g. a bare serve-sim helper with no middleware).
   */
  foregroundApp: ForegroundApp | null;

  /** Element kind {@link DeviceScreen} should render for this client. */
  videoKind: VideoSurfaceKind;
  /**
   * Ref callback for the paint target. The hook owns the element: `canvas`
   * receives decoded H.264 frames, `img` points at MJPEG, and `video` receives
   * a WebRTC MediaStream.
   */
  attachVideo: (el: HTMLCanvasElement | HTMLImageElement | HTMLVideoElement | null) => void;

  /** Forward a normalized touch/drag to the device. */
  sendTouch: (sample: TouchSample) => void;
  /** Forward a two-finger pinch/pan. Present only on backends that support it (serve-sim). */
  sendMultiTouch?: (sample: MultiTouchSample) => void;
  /**
   * Forward a physical browser-keyboard event to the device. Returns true when
   * the event was accepted, allowing {@link DeviceScreen} to suppress the
   * corresponding browser action while the streamed device has focus.
   */
  sendKey: (input: KeyboardInput) => boolean;
  /** Press a hardware button. */
  pressButton: (button: HardwareButton) => void;
  /**
   * Reload the running React Native/Expo bundle. serve-sim injects ⌘R over the
   * helper's key channel; serve-emu injects a hardware "R" keypress over scrcpy.
   * A no-op if nothing is connected; harmless if the foreground app isn't RN.
   */
  reload: () => void;
  /**
   * Rotate the device. serve-sim sets the next orientation in the
   * counterclockwise cycle over the helper's orientation channel; serve-emu
   * locks the opposite portrait/landscape orientation via `POST
   * /api/orientation`. A no-op if nothing is connected.
   */
  rotate: () => void;
  /**
   * Capture a still PNG of the device via the backend's screenshot API
   * (serve-emu `adb screencap` / serve-sim `simctl io … screenshot`), resolving
   * to a `Blob`, or `null` if capture fails or nothing is connected. The caller
   * decides what to do with it (e.g. trigger a file download).
   */
  screenshot: () => Promise<Blob | null>;

  /**
   * Current device system appearance (dark/light), or `null` while unknown or on
   * a backend that can't report it (e.g. a bare serve-sim helper with no
   * middleware). Read once the connection resolves; updated by {@link setAppearance}.
   */
  appearance: DeviceAppearance | null;
  /**
   * Set the device's system appearance. serve-sim runs `simctl ui <udid>
   * appearance <mode>` (over the middleware exec-ws); serve-emu posts `uimode
   * night yes|no`. No-op on a backend that can't set it.
   */
  setAppearance: (mode: DeviceAppearance) => void;

  /**
   * Whether Simulator currently treats the Mac keyboard as connected to the
   * guest. iOS only; null while the helper is unavailable or on Android.
   */
  hardwareKeyboardConnected: boolean | null;
  /** Connect or disconnect the Mac keyboard from the iOS guest. */
  setHardwareKeyboardConnected: (connected: boolean) => void;
  /** Toggle the iOS on-screen software keyboard without changing the hardware connection. */
  toggleSoftwareKeyboard: () => void;
}

/** A platform implementation of the connection half of the interface. */
export type DeviceClientHook = (options: DeviceConnectionOptions) => DeviceClient;

/** Props for the shared {@link DeviceScreen} component rendered inside PhoneFrame. */
export interface DeviceScreenProps {
  client: DeviceClient;
  /** Last active Argent gesture for the streamed device; removed after its idle timeout. */
  agentInteraction?: AgentInteraction | null;
  /** Optional unclipped host for the agent cursor, aligned to the rendered stream. */
  agentInteractionPortalTarget?: HTMLElement | null;
  /** Corner radius for the video surface (matches the PhoneFrame placeholder). */
  borderRadius?: CSSProperties['borderRadius'];
  /** Apply the iOS `corner-shape: squircle`. */
  squircle?: boolean;
}
