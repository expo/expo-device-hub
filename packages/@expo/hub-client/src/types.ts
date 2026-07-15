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

/** The app currently in the foreground on the device. */
export interface ForegroundApp {
  /** Bundle identifier (iOS) / package name (Android). */
  id: string;
  /** Human-readable app label, when the backend reports one (serve-emu). */
  label?: string;
  /** Foreground process id, when known. */
  pid?: number;
  /** True when the backend detected a React Native app (serve-sim). */
  isReactNative?: boolean;
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
}

/** Which element the implementation paints into. */
export type VideoSurfaceKind = 'canvas' | 'img';

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
   * Ref callback for the paint target. The hook owns the element: for `canvas`
   * it decodes frames into it; for `img` it points its `src` at the stream.
   */
  attachVideo: (el: HTMLCanvasElement | HTMLImageElement | null) => void;

  /** Forward a normalized touch/drag to the device. */
  sendTouch: (sample: TouchSample) => void;
  /** Forward a two-finger pinch/pan. Present only on backends that support it (serve-sim). */
  sendMultiTouch?: (sample: MultiTouchSample) => void;
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
}

/** A platform implementation of the connection half of the interface. */
export type DeviceClientHook = (options: DeviceConnectionOptions) => DeviceClient;

/** Props for the shared {@link DeviceScreen} component rendered inside PhoneFrame. */
export interface DeviceScreenProps {
  client: DeviceClient;
  /** Corner radius for the video surface (matches the PhoneFrame placeholder). */
  borderRadius?: CSSProperties['borderRadius'];
  /** Apply the iOS `corner-shape: squircle`. */
  squircle?: boolean;
}
