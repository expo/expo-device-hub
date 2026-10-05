/** Internal transport adapter state. Not part of the public API. */
import type {
  AccessibilitySnapshot,
  AppPermission,
  AppPermissionAction,
  ConnectionStatus,
  DeviceActivity,
  DeviceAppearance,
  DeviceCameraFacing,
  DeviceCameraStatus,
  DeviceCapabilities,
  DeviceEvent,
  DeviceGeoFix,
  DeviceGrpcEncoder,
  DeviceGrpcImageMode,
  DeviceInputSource,
  DeviceLog,
  DevicePlatform,
  DeviceScreenRecordingStatus,
  DeviceSettingKey,
  DeviceSettings,
  DeviceStreamCapabilities,
  DeviceStreamEncoderSettings,
  DeviceStreamSource,
  DeviceStreamSourceStatus,
  DeviceStreamStats,
  DeviceWebRtcCodec,
  ForegroundApp,
  HardwareButton,
  HidKeyEvent,
  KeyboardInput,
  MultiTouchSample,
  RunningDevice,
  ScreenSize,
  ScreenshotCapture,
  ScrollSample,
  TouchSample,
  VideoSurfaceKind,
} from './types';

export interface BackendDeviceClient {
  platform: DevicePlatform;
  status: ConnectionStatus;
  error: string | null;
  /** Host recording status; unknown until metadata loads, null when no recording was requested. */
  screenRecording: DeviceScreenRecordingStatus | null;
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
  /**
   * The device's smallest-width dp that the Display size control surfaces, or
   * null when it is unknown.
   */
  displayWidthDp: number | null;

  /** Emulator camera feeds, or null before the first read or when the backend has none. */
  camera: DeviceCameraStatus | null;
  /** Facings with an image write or reset in flight. */
  cameraPending: ReadonlySet<DeviceCameraFacing>;
  /** Last failed camera write, cleared when the next write starts. */
  cameraError: string | null;
  /** Replace one facing's picture with a PNG. The backend refuses other formats. */
  setCameraImage: (facing: DeviceCameraFacing, png: Blob) => void;
  /** Restore the backend's "no image set" card for one facing. */
  clearCameraImage: (facing: DeviceCameraFacing) => void;

  /** Last accessibility snapshot, or null before the first successful read. */
  accessibility: AccessibilitySnapshot | null;
  accessibilityPending: boolean;
  /** Last failed read, cleared when the next read starts. */
  accessibilityError: string | null;
  /** Read the accessibility tree of the current screen once. Backends do not stream it. */
  refreshAccessibility: () => void;

  /**
   * The last fix a backend confirmed applying, or null when none is known. serve-emu
   * remembers it for the life of its session (`GET /api/location`); serve-sim has no
   * read, so this client remembers what it applied and forgets on reload.
   */
  location: DeviceGeoFix | null;
  /** True while a set or clear is in flight. Another write is ignored until it settles. */
  locationPending: boolean;
  /** Last failed location write, cleared when the next write starts. */
  locationError: string | null;
  /** Point the device at one coordinate. */
  setLocation: (fix: DeviceGeoFix) => void;
  /** Remove the simulated fix. A no-op unless `capabilities.location` carries `clear`. */
  clearLocation: () => void;

  /** Permissions of the foreground app, or null while unknown or without a foreground app. */
  permissions: readonly AppPermission[] | null;
  /** Permission ids with a write in flight. A reset holds every id. */
  permissionsPending: ReadonlySet<string>;
  /** Last failed permission request, cleared when the next write starts or a read succeeds. */
  permissionsError: string | null;
  /** Grant or revoke one permission of the foreground app. */
  setPermission: (id: string, action: AppPermissionAction) => void;
  /** Return every permission of the foreground app to its default. */
  resetPermissions: () => void;
  /** Read the list again, for example when the section opens. */
  refreshPermissions: () => void;

  /** Backend-supported viewer transport and codec choices; null hides stream controls. */
  streamCapabilities: DeviceStreamCapabilities | null;
  /** Runtime encoder settings, available when `capabilities.streamSettings` lists any keys. */
  streamSettings: DeviceStreamEncoderSettings | null;
  streamSettingsPending: boolean;
  /** Patch one or more runtime encoder values. */
  updateStreamSettings: (patch: Partial<DeviceStreamEncoderSettings>) => void;
  /** Active Android capture source; null when the backend does not expose source switching. */
  streamSource: DeviceStreamSourceStatus | null;
  /**
   * True from a capture-source request until the replacement stream is on
   * screen (or the request fails), so controls and frame change together.
   */
  streamSourcePending: boolean;
  /** Last capture-source write failure; cleared when another write begins. */
  streamSourceError: string | null;
  /** Stage and atomically activate another Android capture source. */
  setStreamSource: (source: DeviceStreamSource) => void;
  /** Restart the gRPC source with compressed PNG or shared-memory RGB delivery. */
  setGrpcImageMode: (mode: DeviceGrpcImageMode) => void;
  /** Restart gRPC capture with software or strictly hardware H.264 encoding. */
  setGrpcEncoder: (encoder: DeviceGrpcEncoder) => void;
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
  /** See `DeviceClient.inputError`. */
  inputError: string | null;
  sendTouch: (sample: TouchSample) => void;
  /** Forward a two-finger pinch/pan. Absent only on the no-op client. */
  sendMultiTouch?: (sample: MultiTouchSample) => void;
  /**
   * Forward a physical browser-keyboard event to the device. Returns true when
   * the event was accepted, allowing {@link DeviceScreen} to suppress the
   * corresponding browser action while the streamed device has focus.
   */
  sendKey: (input: KeyboardInput) => boolean;
  /**
   * Type pre-mapped HID key events — e.g. what {@link KeyboardCapture} derives
   * from phone-keyboard text — paced so iOS doesn't coalesce a burst into lost
   * keystrokes. Present only on backends with a HID key channel (serve-sim).
   */
  sendKeyEvents?: (events: ReadonlyArray<HidKeyEvent>) => void;
  /**
   * Forward a scroll-wheel / trackpad pan as a native scroll, so the device
   * pans content exactly as it would for a physical wheel (no synthesized
   * drag). Present only on backends that support it (serve-sim).
   */
  sendScroll?: (sample: ScrollSample) => void;
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
   * Capture a still PNG of the device via the backend's `POST /api/screenshot`
   * (serve-emu `adb screencap` / serve-sim `simctl io screenshot`), resolving
   * to the PNG and its session artifact outcome, or `null` if capture fails or
   * nothing is connected. The caller decides what to do with it (e.g. trigger
   * a file download).
   */
  screenshot: () => Promise<ScreenshotCapture | null>;

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
   * guest. iOS only; null while the helper is unavailable or on Android. The
   * Hub disconnects it while its input socket is attached so the on-screen
   * keyboard shows; serve-sim reconnects it once the last client leaves.
   */
  hardwareKeyboardConnected: boolean | null;
  /**
   * Connect or disconnect the Mac keyboard from the iOS guest (serve-sim's
   * `hardware-keyboard` simulator setting, over the middleware exec channel).
   */
  setHardwareKeyboardConnected: (connected: boolean) => void;
  /** Toggle the iOS on-screen software keyboard without changing the hardware connection. */
  toggleSoftwareKeyboard: () => void;
}
