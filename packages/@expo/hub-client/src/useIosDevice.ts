/**
 * serve-sim (iOS) implementation of the {@link DeviceClient} interface.
 *
 * Mirrors the serve-sim web client's architecture: the entry point is the
 * serve-sim **middleware** (default `:3200`), not the bare streaming helper.
 *
 *   1. `GET <base>/api` → the live config: the helper `url`/`streamUrl`/`wsUrl`,
 *      the `device` udid, the per-session `execToken`, and the `logsEndpoint` /
 *      `gridApiEndpoint` route paths.
 *   2. Video: MJPEG `<img>` from the helper's `streamUrl`. Input + screen config:
 *      the helper's binary WebSocket (`0x03` touch, `0x04` button, `0x05`
 *      multi-touch, `0x06` key, `0x0b` scroll, `0x0e` hardware keyboard out;
 *      `0x82` screen config in). Coordinates are mapped to the device's raw
 *      frame per orientation (see `./orientation`). Input sent while the socket
 *      is reconnecting is queued briefly (see `./ws-send-queue`).
 *   3. Logs: streamed over the middleware's **exec-ws** WebSocket exactly like
 *      the serve-sim client — `{token}` → `{sub, path: logsEndpoint}` → `{sub,
 *      data}` (raw SSE) — rather than a direct route on the helper (the helper
 *      has none). One-shot host actions (`{id, action, params}`) and
 *      simulator-settings requests (`{id, ui}`) share that channel (`./exec-ws`).
 *   4. Devices: `GET <base>/grid/api`.
 *
 * `baseUrl` is always the mounted serve-sim middleware. Connection failures
 * keep retrying middleware discovery; they must not be reinterpreted as a bare
 * helper because doing so drops the middleware/helper path from stream URLs.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';

import { AVCC_FRAME_TIMEOUT_MS, avccFallbackReducer, initialAvccFallback } from './avcc-fallback';
import {
  appendActivitySample,
  parseActivityHostCores,
  parseActivitySample,
} from './activity';
import { type AccessibilityLoader, loadIosAccessibility } from './accessibility';
import { isAvccSupported } from './avcc';
import {
  HID_EDGE_BOTTOM,
  homeIndicatorEdge,
  rawDeltaForDisplayDelta,
  rawEdgeForDisplayEdge,
  rawPointForDisplayPoint,
  streamGeometry,
} from './orientation';
import { startIosHelper } from './connections';
import {
  clearIosEventLogState,
  createIosEventLogState,
  mergeIosEventLogPayload,
} from './ios-events';
import { hostUiRequest, runHostAction } from './exec-ws';
import { fetchIosAppIcon, getIosAppDetails } from './ios-app-details';
import { clearIosLocation, setIosLocation } from './ios-location';
import { fetchScreenshot } from './screenshot';
import { hidUsageForCode } from './keyboard';
import {
  type ConnectionStatus,
  type DeviceActivity,
  type DeviceAppearance,
  type DeviceClient,
  type DeviceCapabilities,
  type DeviceConnectionOptions,
  type DeviceLog,
  type DeviceSettingKey,
  type DeviceSettings,
  type DeviceStreamCapabilities,
  type DeviceStreamEncoderSettings,
  type DeviceStreamSettingCapabilities,
  type DeviceWebRtcCodec,
  type DeviceOrientation,
  type ForegroundApp,
  type HardwareButton,
  type HidKeyEvent,
  type KeyboardInput,
  type MultiTouchSample,
  type RunningDevice,
  type ScreenSize,
  type ScreenshotCapture,
  type ScrollSample,
  type TouchSample,
} from './types';
import { NO_PENDING_CAMERA_WRITES } from './device-camera';
import { mergeAuthoritativeDeviceSetting } from './device-setting-writes';
import { IOS_INPUT_UNAVAILABLE_MESSAGE, iosInputCloseError } from './ios-input-error';
import { KeyedWriteTracker } from './keyed-write-tracker';
import { createPacedKeySender } from './paced-key-sender';
import { middlewareEndpointForBrowser, proxyPreviewConfigForBrowser } from './proxy-preview-config';
import { sessionTokenFetch, sessionTokenProtocols, withSessionTokenQuery } from './session-token';
import { type ParsedSseBlock, drainSseChunk } from './sse';
import { normalizeDeviceStreamSettings } from './stream-settings';
import { resolveDeviceStreamMode } from './stream-mode';
import { useAccessibility } from './useAccessibility';
import { useAppPermissions } from './useAppPermissions';
import { useAvccStream } from './useAvccStream';
import { type DeviceLocationBackend, useDeviceLocation } from './useDeviceLocation';
import { useStreamSettingsResource } from './useStreamSettingsResource';
import { useDeviceSettingsReadStatus } from './useDeviceSettingsReadStatus';
import { useWebRtcStream, type WebRtcIceServer } from './useWebRtcStream';
import { presentedVideoFrameDelta } from './video-frame-metadata';
import {
  type WebRtcCodec,
  webRtcFallbackDecision,
} from './webrtc-fallback';
import {
  flushWsMessageQueue,
  type QueuedWsMessage,
  sendOrQueueWsMessage,
} from './ws-send-queue';

const MAX_LOGS = 200;
const RECONNECT_MS = 1500;
const DEVICE_SETTINGS_POLL_MS = 8000;
const DEVICE_SETTINGS_RETRY_MAX_MS = 30_000;
// serve-sim accepts the upgrade before it admits an input socket, then closes
// a refused socket at once. On a server without an admission frame, an open
// socket that outlives this was admitted.
const INPUT_ADMISSION_MS = 1000;
const ACTIVITY_STALE_MS = 8000;
const noop = () => {};

// serve-sim binary WS message tags (serve-sim-client `SimulatorView`).
const WS_MSG_TOUCH = 0x03;
const WS_MSG_BUTTON = 0x04;
const WS_MSG_MULTI_TOUCH = 0x05;
const WS_MSG_KEY = 0x06;
const WS_MSG_ORIENTATION = 0x07;
// Native scroll (wheel/trackpad) in raw device fractions, anchored under the pointer.
const WS_MSG_SCROLL = 0x0b;
const WS_MSG_SOFTWARE_KEYBOARD = 0x0c;
// Connect/disconnect the guest's hardware keyboard; serve-sim's own touch
// client sends this too so the on-screen keyboard shows.
const WS_MSG_HARDWARE_KEYBOARD = 0x0e;
export const WS_TAG_SCREEN_CONFIG = 0x82;
// Sent once to an admitted input socket by servers that advertise `inputAdmission`.
const WS_MSG_INPUT_ADMITTED = 0x83;

// HID keyboard usage codes (USB HID Usage Page 0x07) for the R reload chord.
const HID_USAGE_R = 0x15; // 'r'

// The simulator-settings option behind `hardwareKeyboardConnected`.
const UI_OPTION_HARDWARE_KEYBOARD = 'hardware-keyboard';

const PLACEHOLDER_DEVICES: RunningDevice[] = [
  { id: 'ios', name: 'iPhone Simulator', platform: 'ios', current: true },
];

const IOS_HTTP_STREAM_CAPABILITIES = {
  modeAvailability: { mjpeg: true, h264: true, webrtc: false },
  httpCodecs: ['auto', 'h264', 'mjpeg'],
  webRtcCodecs: [],
} as const satisfies DeviceStreamCapabilities;

const IOS_WEBRTC_STREAM_CAPABILITIES = {
  modeAvailability: { mjpeg: false, h264: false, webrtc: true },
  httpCodecs: [],
  webRtcCodecs: ['h264', 'vp9', 'vp8'],
} as const satisfies DeviceStreamCapabilities;

const IOS_STREAM_SETTING_CAPABILITIES = {
  mjpegFps: true,
  mjpegQuality: true,
  maxDimension: true,
  h264Bitrate: true,
  h264Fps: true,
} as const satisfies DeviceStreamSettingCapabilities;

/**
 * Stream modes for the transport serve-sim advertises in `/api`. serve-sim
 * locks a WebRTC server to WebRTC and refuses its HTTP streams; a missing or
 * unknown value is its HTTP default.
 */
export function iosStreamCapabilities(streamSettings: unknown): DeviceStreamCapabilities {
  const transport =
    streamSettings && typeof streamSettings === 'object'
      ? (streamSettings as { transport?: unknown }).transport
      : undefined;
  return transport === 'webrtc' ? IOS_WEBRTC_STREAM_CAPABILITIES : IOS_HTTP_STREAM_CAPABILITIES;
}

// The counterclockwise rotation order (matches Simulator's "Rotate Left"): each
// press advances one step, so four presses come back around to portrait.
const ORIENTATION_CYCLE: DeviceOrientation[] = [
  'portrait',
  'landscape_left',
  'portrait_upside_down',
  'landscape_right',
];

// iOS only has a Home button + app switcher; the rest are no-ops.
const BUTTON_NAME: Record<HardwareButton, string | null> = {
  home: 'home',
  appSwitcher: 'app_switcher',
  power: 'lock',
  back: null,
  recents: null,
  hideKeyboard: null,
};

const decoder = new TextDecoder();

function parseIosStreamSettings(
  value: unknown,
  fallback: DeviceStreamEncoderSettings,
): DeviceStreamEncoderSettings {
  return normalizeDeviceStreamSettings(value, fallback);
}

function iosStreamSettingsPatch(
  patch: Partial<DeviceStreamEncoderSettings>,
): Partial<DeviceStreamEncoderSettings> | null {
  return Object.keys(patch).length > 0 ? patch : null;
}

function toWs(url: string): string {
  return url.replace(/^http/, 'ws');
}

/**
 * `…/helper/<udid>/ws` -> `…/helper/ws?device=<udid>`
 * serve-sim
 */
export function toQueryStyleHelperWsUrl(wsUrl: string): string {
  const url = new URL(wsUrl);
  const match = url.pathname.match(/^(.*\/helper)\/([^/]+)\/ws$/);
  if (!match) throw new Error(`Invalid helper ws url, no deviceId matched: ${wsUrl}`);
  url.pathname = `${match[1]}/ws`;
  if (!url.searchParams.has('device')) {
    url.searchParams.set('device', decodeURIComponent(match[2]));
  }
  return url.toString();
}

/** Resolved connection: where to stream video/input, and how to reach logs/devices. */
interface ResolvedConfig {
  /** Base serve-sim helper URL used by `/stream.avcc`. */
  url: string;
  streamUrl: string;
  wsUrl: string;
  /** The helper sends `WS_MSG_INPUT_ADMITTED` to an admitted input socket. */
  inputAdmission: boolean;
  device: string | null;
  pid: number | null;
  /** Middleware exec-ws URL used for logs, events, metrics, and UI requests. */
  execWsUrl: string | null;
  execToken: string | null;
  configEventsPath: string;
  /** Relative SSE path to subscribe for logs, e.g. `/logs?device=<udid>`. */
  logsPath: string | null;
  /** Absolute URL of the foreground-app SSE stream. */
  appStateUrl: string | null;
  /** Absolute URL of the app icon route, when the server has one. */
  appIconUrl: string | null;
  /** Relative SSE path for normalized serve-sim events. */
  eventsPath: string | null;
  /** Relative SSE path for foreground app activity. */
  metricsPath: string | null;
  axUrl: string | null;
  /** Runtime encoder settings endpoint on the selected helper. */
  streamSettingsUrl: string | null;
  /** Initial server-provided stream settings, if present. */
  initialStreamSettings: unknown;
  gridApiUrl: string | null;
  webRtcCodec: WebRtcCodec;
  webRtcIceServers?: WebRtcIceServer[];
}

/** Shape of the serve-sim middleware `/api` (and grid) responses we read. */
interface PreviewApi {
  url?: string;
  streamUrl?: string;
  wsUrl?: string;
  inputAdmission?: boolean;
  device?: string;
  pid?: number;
  basePath?: string;
  execToken?: string;
  logsEndpoint?: string;
  appStateEndpoint?: string;
  appIconEndpoint?: string;
  eventLogEventsEndpoint?: string;
  metricsEndpoint?: string;
  axEndpoint?: string;
  streamSettingsEndpoint?: string;
  gridApiEndpoint?: string;
  proxyHelpers?: boolean;
  streamSettings?:
    | ({ transport: 'http'; codec?: 'auto' | 'h264' | 'mjpeg' } &
        Partial<DeviceStreamEncoderSettings>)
    | ({ transport: 'webrtc'; codec: WebRtcCodec; iceServers?: WebRtcIceServer[] } &
        Partial<DeviceStreamEncoderSettings>);
}

// The requested server, device, and credentials that one resolved config belongs to.
function connectionKey(baseUrl: string, device: string | null, token: string | null): string {
  return JSON.stringify([baseUrl, device, token]);
}

function configKey(config: ResolvedConfig): string {
  const settings = config.initialStreamSettings as PreviewApi['streamSettings'];
  return JSON.stringify({
    ...config,
    initialStreamSettings: {
      ...normalizeDeviceStreamSettings(settings),
      transport: settings?.transport ?? 'http',
      codec: settings?.codec ?? 'h264',
    },
  });
}

/** @deprecated Use DeviceClientProvider with useDeviceClient or useDeviceScreenClient instead. */
export function useIosDeviceClient(options: DeviceConnectionOptions): DeviceClient {
  const {
    baseUrl,
    enabled = true,
    device: targetDevice = null,
    streamMode: requestedStreamMode,
    token = null,
  } = options;
  const active = enabled && !!baseUrl;
  const sessionFetch = useMemo(() => sessionTokenFetch(token), [token]);
  const socketProtocols = useMemo(() => sessionTokenProtocols('ios', token), [token]);
  const deviceSettingsScope = active ? JSON.stringify([baseUrl, targetDevice, token]) : null;
  const { deviceSettingsStatus, resetRead, settleRead } =
    useDeviceSettingsReadStatus(deviceSettingsScope);
  const deviceSettingsReadRef = useRef<{
    invalidate: () => void;
    resume: () => void;
  } | null>(null);
  const deviceSettingVersionsRef = useRef(new Map<DeviceSettingKey, number>());

  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  // serve-sim's rejection of the input socket (close 1013), kept until a socket is admitted.
  const [inputSocketError, setInputSocketError] = useState<string | null>(null);
  // serve-sim's native HID setup failed; lasts until serve-sim restarts.
  const [inputUnavailable, setInputUnavailable] = useState(false);
  const [screen, setScreen] = useState<ScreenSize | null>(null);
  const [fps, setFps] = useState(0);
  const [logs, setLogs] = useState<DeviceLog[]>([]);
  // Logs are opt-in: nothing streams until the user attaches.
  const [logsEnabled, setLogsEnabled] = useState(false);
  const [eventLogState, setEventLogState] = useState(createIosEventLogState);
  const events = eventLogState.events;
  const [eventsEnabled, setEventsEnabled] = useState(false);
  const [activity, setActivity] = useState<DeviceActivity | null>(null);
  const [devices, setDevices] = useState<RunningDevice[]>(PLACEHOLDER_DEVICES);
  // The credentials above follow the options at once, but a new config waits for `/api`. Until
  // it arrives, the old config is not used, so its URLs never get another connection's token.
  // Effect cleanups still close the old connections with the credentials they opened them with.
  const [resolvedConfig, setResolvedConfig] = useState<{
    key: string;
    config: ResolvedConfig | null;
    middleware: Pick<ResolvedConfig, 'execWsUrl' | 'execToken' | 'configEventsPath'>;
  } | null>(null);
  const connection =
    active && baseUrl && resolvedConfig?.key === connectionKey(baseUrl, targetDevice, token)
      ? resolvedConfig
      : null;
  const config = connection?.config ?? null;
  const refreshConfigRef = useRef<(() => void) | null>(null);
  const applyPreviewConfigRef = useRef<((value: PreviewApi | null) => void) | null>(null);
  const configUpdatesReadyRef = useRef(false);
  const streamCapabilities = config ? iosStreamCapabilities(config.initialStreamSettings) : null;
  // Preserve supported viewer choices; map unavailable ones to the server's transport.
  const streamMode = streamCapabilities
    ? resolveDeviceStreamMode(requestedStreamMode, streamCapabilities.modeAvailability)
    : requestedStreamMode;
  // The simulator's system dark/light setting. null until read.
  const [appearance, setAppearanceState] = useState<DeviceAppearance | null>(null);
  const [deviceSettings, setDeviceSettings] = useState<DeviceSettings | null>(null);
  const [deviceSettingsPending, setDeviceSettingsPending] = useState<
    ReadonlySet<DeviceSettingKey>
  >(() => new Set());
  // Browser HID injection remains active when this is false. Disabling the
  // Simulator-owned host connection lets iOS keep its software keyboard open.
  const [hardwareKeyboardConnected, setHardwareKeyboardConnectedState] = useState<boolean | null>(
    null,
  );
  // The frontmost app, pushed by the middleware's /appstate SSE. null until the
  // first event.
  const [foregroundApp, setForegroundApp] = useState<ForegroundApp | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  // Input that arrived while the helper socket was down; flushed on reconnect
  // (bounded, and stale entries are dropped — see `./ws-send-queue`).
  const pendingWsRef = useRef<QueuedWsMessage[]>([]);
  const pendingWsDestinationRef = useRef<{ wsUrl: string; device: string | null } | null>(null);
  // Monotonic log id source, persisted across log-stream reconnects so ids stay
  // unique even though lines are kept (the stream effect may re-run).
  const logSeqRef = useRef(0);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamUrlRef = useRef<string | null>(null);
  const [avccFallback, dispatchAvccFallback] = useReducer(avccFallbackReducer, initialAvccFallback);
  const [webRtcCodec, setWebRtcCodecState] = useState<DeviceWebRtcCodec>('h264');
  const [activeWebRtcCodec, setActiveWebRtcCodec] = useState<WebRtcCodec>('h264');
  const deviceSettingWriteTrackerRef = useRef(new KeyedWriteTracker<DeviceSettingKey>());
  // Async option writes capture their config. Track only committed config so
  // an interrupted concurrent render cannot invalidate a legitimate rollback.
  const deviceSettingConfigRef = useRef(config);
  useLayoutEffect(() => {
    deviceSettingConfigRef.current = config;
  }, [config]);
  const activityLastSampleAtRef = useRef(0);
  const useWebRtc = streamMode === 'webrtc';
  const wantsAvcc = streamMode === 'h264';
  const useAvcc = wantsAvcc && isAvccSupported() && !avccFallback.fellBack;
  useEffect(() => {
    if (streamMode === 'webrtc') return;
    setActiveWebRtcCodec(webRtcCodec);
  }, [streamMode, webRtcCodec]);
  // True while the in-flight single-finger drag began in the home-indicator band.
  const edgeGestureRef = useRef(false);
  // Latest screen config, read by the (stable) input callbacks for orientation.
  const screenRef = useRef<ScreenSize | null>(null);
  useEffect(() => {
    screenRef.current = screen;
  }, [screen]);
  // Once the helper WS pushes a config, it owns dimensions+orientation.
  const hasWsConfigRef = useRef(false);

  const applyStreamSrc = useCallback(() => {
    const img = imgRef.current;
    const url = streamUrlRef.current;
    if (!img || !url) return;
    img.src = `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`;
  }, []);

  const attachVideo = useCallback(
    (el: HTMLCanvasElement | HTMLImageElement | HTMLVideoElement | null) => {
      if (useWebRtc) {
        videoRef.current = (el as HTMLVideoElement) ?? null;
        canvasRef.current = null;
        imgRef.current = null;
      } else if (useAvcc) {
        canvasRef.current = (el as HTMLCanvasElement) ?? null;
        videoRef.current = null;
        imgRef.current = null;
      } else {
        imgRef.current = (el as HTMLImageElement) ?? null;
        canvasRef.current = null;
        videoRef.current = null;
        if (el) applyStreamSrc();
      }
    },
    [applyStreamSrc, useAvcc, useWebRtc],
  );

  // Every helper-socket message goes through here so a brief reconnect queues
  // input instead of dropping it (matching serve-sim's client).
  const sendWs = useCallback((tag: number, payload: object) => {
    pendingWsRef.current = sendOrQueueWsMessage(wsRef.current, pendingWsRef.current, tag, payload);
  }, []);

  const sendTouch = useCallback((sample: TouchSample) => {
    const orientation = streamGeometry(screenRef.current).inputOrientation;

    let displayEdge: number | undefined;
    if (sample.phase === 'begin') {
      edgeGestureRef.current = homeIndicatorEdge(sample) !== undefined;
      if (edgeGestureRef.current) displayEdge = HID_EDGE_BOTTOM;
    } else if (edgeGestureRef.current) {
      displayEdge = HID_EDGE_BOTTOM;
      if (sample.phase === 'end') edgeGestureRef.current = false;
    }

    const p = rawPointForDisplayPoint(orientation, sample.x, sample.y);
    const edge = displayEdge === undefined ? undefined : rawEdgeForDisplayEdge(orientation, displayEdge);
    const payload =
      edge === undefined ? { type: sample.phase, ...p } : { type: sample.phase, ...p, edge };
    sendWs(WS_MSG_TOUCH, payload);
  }, [sendWs]);

  const sendMultiTouch = useCallback(
    (sample: MultiTouchSample) => {
      const orientation = streamGeometry(screenRef.current).inputOrientation;
      const a = rawPointForDisplayPoint(orientation, sample.a.x, sample.a.y);
      const b = rawPointForDisplayPoint(orientation, sample.b.x, sample.b.y);
      sendWs(WS_MSG_MULTI_TOUCH, { type: sample.phase, x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    },
    [sendWs],
  );

  // Scroll-to-pan: forwarded as a native scroll event so iOS pans content
  // exactly as it would for a physical wheel — no synthesized finger drag.
  // Both the delta and the cursor anchor are rotated into raw device
  // orientation so scrolling tracks the visible content on rotated devices.
  const sendScroll = useCallback(
    (sample: ScrollSample) => {
      if (!Number.isFinite(sample.dx) || !Number.isFinite(sample.dy)) return;
      if (sample.dx === 0 && sample.dy === 0) return;
      const orientation = streamGeometry(screenRef.current).inputOrientation;
      const delta = rawDeltaForDisplayDelta(orientation, sample.dx, sample.dy);
      const anchor = rawPointForDisplayPoint(orientation, sample.x, sample.y);
      sendWs(WS_MSG_SCROLL, { dx: delta.dx, dy: delta.dy, x: anchor.x, y: anchor.y });
    },
    [sendWs],
  );

  const sendKey = useCallback(
    (input: KeyboardInput): boolean => {
      const usage = hidUsageForCode(input.code);
      if (usage === null) return false;
      sendWs(WS_MSG_KEY, { type: input.phase, usage });
      return true;
    },
    [sendWs],
  );

  // Pre-mapped key events (phone-keyboard capture) are paced a few ms apart so
  // iOS doesn't coalesce a pasted string into a couple of lost keystrokes.
  const keySender = useMemo(
    () =>
      createPacedKeySender((event) => sendWs(WS_MSG_KEY, { type: event.type, usage: event.usage })),
    [sendWs],
  );
  useEffect(() => () => keySender.dispose(), [keySender]);
  const sendKeyEvents = useCallback(
    (events: ReadonlyArray<HidKeyEvent>) => keySender.enqueue(events),
    [keySender],
  );

  // Connect/disconnect the Mac keyboard from the guest through serve-sim's
  // `hardware-keyboard` simulator setting (the same request its settings panel
  // makes). Optimistic; reverted if the middleware rejects it.
  const setHardwareKeyboardConnected = useCallback(
    (connected: boolean) => {
      const c = config;
      if (!c || !c.execWsUrl || !c.execToken || !c.device) return;
      const previous = hardwareKeyboardConnected;
      setHardwareKeyboardConnectedState(connected);
      void hostUiRequest(
        c.execWsUrl,
        c.execToken,
        {
          device: c.device,
          option: UI_OPTION_HARDWARE_KEYBOARD,
          value: connected ? 'on' : 'off',
        },
        socketProtocols,
      ).catch(() => setHardwareKeyboardConnectedState(previous));
    },
    [config, hardwareKeyboardConnected, socketProtocols],
  );

  const toggleSoftwareKeyboard = useCallback(() => {
    sendWs(WS_MSG_SOFTWARE_KEYBOARD, {});
  }, [sendWs]);

  const pressButton = useCallback(
    (button: HardwareButton) => {
      const name = BUTTON_NAME[button];
      if (name) sendWs(WS_MSG_BUTTON, { button: name });
    },
    [sendWs],
  );

  // Reload the RN/Expo bundle by injecting ⌘R over the helper's key channel
  // (tag 0x06 → HID keystroke) — RN registers ⌘R as its reload shortcut. Mirrors
  // the serve-sim web client's sequence exactly: ⌘ down, R down, R up, ⌘ up, with
  // a sequential 30ms await between each event (so the gaps can't compress under
  // timer jitter). Harmless if the foreground app isn't RN.
  const reload = useCallback(async () => {
    const key = (type: 'down' | 'up', usage: number) => sendWs(WS_MSG_KEY, { type, usage });
    key('down', HID_USAGE_R);
    await new Promise((r) => setTimeout(r, 30));
    key('up', HID_USAGE_R);
  }, [sendWs]);

  // Rotate one step counterclockwise from the last known orientation, over the
  // helper's orientation channel (tag 0x07 → HID orientation event). The helper
  // confirms by pushing an updated screen config, which keeps the cycle in sync.
  const rotate = useCallback(() => {
    const current = screenRef.current?.orientation ?? 'portrait';
    const next =
      ORIENTATION_CYCLE[(ORIENTATION_CYCLE.indexOf(current) + 1) % ORIENTATION_CYCLE.length];
    sendWs(WS_MSG_ORIENTATION, { orientation: next });
  }, [sendWs]);

  // serve-sim's middleware captures the sim via `simctl io <udid> screenshot`
  // and returns the PNG bytes. Use the resolved udid from `/api` (falling back
  // to the requested device); the middleware defaults to the booted sim if none.
  const screenshot = useCallback(async (): Promise<ScreenshotCapture | null> => {
    if (!baseUrl) return null;
    const udid = config?.device ?? targetDevice;
    return fetchScreenshot(baseUrl, udid, sessionFetch);
  }, [baseUrl, targetDevice, config, sessionFetch]);

  // Apply any serve-sim UI option over its authenticated exec-ws request
  // channel. The state is optimistic so the selected pill/switch responds at
  // once. Writes are serialized per option, while unrelated options can update
  // concurrently. A failed request re-reads only that option's authoritative
  // value so it cannot roll back another optimistic write.
  const setDeviceSetting = useCallback(
    (key: DeviceSettingKey, value: string) => {
      const c = config;
      if (!c?.execWsUrl || !c.execToken || !c.device) return;
      const { device, execToken, execWsUrl } = c;
      const tracker = deviceSettingWriteTrackerRef.current;
      const request = tracker.start(key);
      if (!request) return;
      deviceSettingVersionsRef.current.set(key, (deviceSettingVersionsRef.current.get(key) ?? 0) + 1);
      setDeviceSettingsPending(tracker.pending);
      setDeviceSettings((current) => ({ ...(current ?? {}), [key]: value }));
      if (key === 'appearance' && (value === 'light' || value === 'dark')) {
        setAppearanceState(value);
      }
      void hostUiRequest(execWsUrl, execToken, { device, option: key, value }, socketProtocols)
        .catch(async () => {
          if (!tracker.isCurrent(request) || deviceSettingConfigRef.current !== c) return;
          try {
            const result = await hostUiRequest(execWsUrl, execToken, { device }, socketProtocols);
            if (!tracker.isCurrent(request) || deviceSettingConfigRef.current !== c) return;
            const authoritative: DeviceSettings = {};
            for (const [nextKey, nextValue] of Object.entries(result.status ?? {})) {
              if (typeof nextValue === 'string') {
                authoritative[nextKey as DeviceSettingKey] = nextValue;
              }
            }
            setDeviceSettings((current) =>
              mergeAuthoritativeDeviceSetting(current, key, authoritative),
            );
            if (key === 'appearance') {
              const nextAppearance = authoritative.appearance;
              if (nextAppearance === 'light' || nextAppearance === 'dark') {
                setAppearanceState(nextAppearance);
              }
            }
          } catch {
            // Keep the optimistic value if both the write and authoritative
            // refresh channels are temporarily unavailable.
          }
        })
        .finally(() => {
          if (tracker.finish(request)) setDeviceSettingsPending(tracker.pending);
        });
    },
    [config, socketProtocols],
  );

  const setAppearance = useCallback(
    (mode: DeviceAppearance) => setDeviceSetting('appearance', mode),
    [setDeviceSetting],
  );

  const setInitialWebRtcCodec = useCallback((codec: DeviceWebRtcCodec) => {
    setWebRtcCodecState(codec);
    setActiveWebRtcCodec(codec);
  }, []);

  const attachLogs = useCallback(() => setLogsEnabled(true), []);
  const detachLogs = useCallback(() => setLogsEnabled(false), []);
  const clearLogs = useCallback(() => setLogs([]), []);
  const attachEvents = useCallback(() => setEventsEnabled(true), []);
  const detachEvents = useCallback(() => setEventsEnabled(false), []);
  const clearEvents = useCallback(() => {
    const device = config?.device;
    if (!device) return;
    setEventLogState((current) => clearIosEventLogState(current, device));
  }, [config?.device]);

  // ── Resolve the connection: discover the helper + log/device routes via /api. ──
  //
  // The Hub starts helpers explicitly (see `startIosHelper`) — it never boots a
  // sim just by connecting. So when the middleware is reachable but no helper is
  // attached yet (`/api` → null), we keep polling until the just-started helper
  // comes up, then resolve its streaming config. An unreachable middleware is
  // retried: `baseUrl` is never interpreted as a bare helper.
  useEffect(() => {
    if (!active || !baseUrl) {
      setResolvedConfig(null);
      setStatus('idle');
      return;
    }
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;
    let revision = 0;
    let current: ResolvedConfig | null = null;
    let lastConfig: ResolvedConfig | null = null;
    setStatus('connecting');
    setError(null);

    // `baseUrl` may carry a path prefix (the plugin mount), so join onto it
    // rather than `new URL('/api', baseUrl)`, which would drop that prefix.
    const apiUrl = `${baseUrl.replace(/\/$/, '')}/api${
      targetDevice ? `?device=${encodeURIComponent(targetDevice)}` : ''
    }`;

    const toMiddleware = (rawConfig: PreviewApi): ResolvedConfig => {
      const middlewareUrl = new URL(baseUrl, window.location.href);
      const c = proxyPreviewConfigForBrowser(rawConfig, middlewareUrl);
      const basePath = c.basePath === '/' ? '' : (c.basePath ?? '');
      const absoluteMiddlewareUrl = (path?: string): string | null =>
        path
          ? c.proxyHelpers
            ? middlewareEndpointForBrowser(path, middlewareUrl, basePath)
            : new URL(path, middlewareUrl).toString()
          : null;
      const appStateUrl = absoluteMiddlewareUrl(c.appStateEndpoint);
      return {
        url: c.url!,
        // An <img> and an EventSource cannot set a header.
        streamUrl: withSessionTokenQuery(c.streamUrl ?? `${c.url}/stream.mjpeg`, token),
        wsUrl: toQueryStyleHelperWsUrl(c.wsUrl ?? `${toWs(c.url!)}/ws`),
        inputAdmission: c.inputAdmission === true,
        device: c.device ?? null,
        pid: c.pid ?? null,
        configEventsPath: `${basePath}/api/events${targetDevice ? `?device=${encodeURIComponent(targetDevice)}` : ''}`,
        execWsUrl: toWs(absoluteMiddlewareUrl(`${basePath}/exec-ws`)!),
        execToken: c.execToken ?? null,
        // These are subscription paths inside exec-ws, not browser URLs. The
        // server validates them against its internal middleware mount.
        logsPath: c.logsEndpoint ?? null,
        appStateUrl: appStateUrl && withSessionTokenQuery(appStateUrl, token),
        appIconUrl: absoluteMiddlewareUrl(c.appIconEndpoint),
        eventsPath: c.eventLogEventsEndpoint ?? null,
        metricsPath: c.metricsEndpoint ?? null,
        axUrl: absoluteMiddlewareUrl(c.axEndpoint),
        // A proxied helper URL uses the public middleware mount above rather
        // than an advertised internal host port that may be 0.
        streamSettingsUrl: c.streamSettingsEndpoint
          ? c.proxyHelpers
            ? `${c.url}/stream-settings`
            : absoluteMiddlewareUrl(c.streamSettingsEndpoint)
          : null,
        initialStreamSettings: c.streamSettings,
        gridApiUrl: absoluteMiddlewareUrl(c.gridApiEndpoint ?? `${basePath}/grid/api`),
        webRtcCodec: c.streamSettings?.transport === 'webrtc' ? c.streamSettings.codec : 'h264',
        ...(c.streamSettings?.transport === 'webrtc' && c.streamSettings.iceServers
          ? { webRtcIceServers: c.streamSettings.iceServers }
          : {}),
      };
    };

    // Ask the grid to attach a helper for this device at most once per effect
    // run (i.e. per device). Resets whenever `targetDevice`/`baseUrl` change.
    let startRequested = false;

    const applyConfig = (value: PreviewApi | null) => {
      if (cancelled) return;
      const next = value?.url && value.device ? toMiddleware(value) : null;
      revision++;
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
      if (!next) {
        current = null;
        // Keep the middleware subscription alive while its helper is absent.
        setResolvedConfig((previous) =>
          previous?.key === connectionKey(baseUrl, targetDevice, token)
            ? { ...previous, config: null }
            : previous,
        );
        setStatus('connecting');
        setError(null);
        pollTimer = setTimeout(resolve, RECONNECT_MS);
        return;
      }
      if (current && configKey(current) === configKey(next)) return;
      if (
        current &&
        JSON.stringify(current.webRtcIceServers) === JSON.stringify(next.webRtcIceServers)
      ) {
        next.webRtcIceServers = current.webRtcIceServers;
      }
      const previousTransport =
        lastConfig && iosStreamCapabilities(lastConfig.initialStreamSettings);
      const nextTransport = iosStreamCapabilities(next.initialStreamSettings);
      if (
        !lastConfig ||
        lastConfig.device !== next.device ||
        previousTransport?.modeAvailability.webrtc !== nextTransport.modeAvailability.webrtc ||
        lastConfig.webRtcCodec !== next.webRtcCodec
      ) {
        setInitialWebRtcCodec(next.webRtcCodec);
      }
      current = next;
      lastConfig = next;
      setResolvedConfig({
        key: connectionKey(baseUrl, targetDevice, token),
        config: next,
        middleware: {
          execWsUrl: next.execWsUrl,
          execToken: next.execToken,
          configEventsPath: next.configEventsPath,
        },
      });
    };

    const resolve = async () => {
      if (cancelled || inFlight) return;
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
      inFlight = true;
      const requestRevision = revision;
      try {
        const res = await sessionFetch(apiUrl, {
          signal: AbortSignal.timeout(3000),
          cache: 'no-store',
        });
        if (!res.ok) throw new Error(`Discovery failed: ${res.status}`);
        const value = (await res.json()) as PreviewApi | null;
        // A pushed update is newer than an HTTP request that was already in flight.
        if (cancelled || requestRevision !== revision) return;
        applyConfig(value);
        if (!(value?.url && value.device) && targetDevice && !startRequested) {
          startRequested = true;
          void startIosHelper(targetDevice, baseUrl, sessionFetch).catch(() => {});
        }
      } catch {
        // A failed background refresh must not tear down a working video stream.
        if (!cancelled && requestRevision === revision) {
          if (!current) settleRead('error');
          pollTimer = setTimeout(resolve, RECONNECT_MS);
        }
      } finally {
        inFlight = false;
      }
    };
    const refresh = () => {
      void resolve();
    };
    refreshConfigRef.current = refresh;
    applyPreviewConfigRef.current = applyConfig;
    refresh();

    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
      if (refreshConfigRef.current === refresh) refreshConfigRef.current = null;
      if (applyPreviewConfigRef.current === applyConfig) applyPreviewConfigRef.current = null;
    };
  }, [active, baseUrl, targetDevice, setInitialWebRtcCodec, sessionFetch, token, settleRead]);

  // A replacement helper/session at the same URL still needs new video readers.
  const videoSessionKey = config
    ? JSON.stringify([config.url, config.device, config.pid, config.execToken])
    : null;
  const videoFetch = useMemo(
    () =>
      videoSessionKey
        ? (...args: Parameters<typeof sessionFetch>) => sessionFetch(...args)
        : sessionFetch,
    [sessionFetch, videoSessionKey],
  );

  const fpsCounterRef = useRef({ frames: 0, startedAt: 0 });
  const onAvccFrame = useCallback((frameDelta = 1) => {
    const now = performance.now();
    const counter = fpsCounterRef.current;
    if (counter.startedAt === 0) counter.startedAt = now;
    counter.frames += frameDelta;
    if (now - counter.startedAt < 1_000) return;
    const next = Math.round((counter.frames * 1_000) / (now - counter.startedAt));
    counter.frames = 0;
    counter.startedAt = now;
    setFps((previous) => (previous === next ? previous : next));
  }, []);

  // ── WebRTC with codec retries, confined to the advertised transport. ──
  const {
    stream: webRtcStream,
    failure: webRtcFailure,
    error: webRtcError,
    markFrameDecoded: markWebRtcFrameDecoded,
    restart: restartWebRtc,
    streamStats,
    setStreamStatsEnabled,
  } = useWebRtcStream({
    offerUrl: config ? `${config.url}/webrtc/offer` : '',
    closeUrl: config ? `${config.url}/webrtc/close` : '',
    closeBeaconUrl: config ? withSessionTokenQuery(`${config.url}/webrtc/close`, token) : '',
    statsUrl: config ? `${config.url}/webrtc/stats` : '',
    enabled: active && useWebRtc && !!config,
    codec: activeWebRtcCodec,
    iceServers: config?.webRtcIceServers,
    fetchImpl: videoFetch,
  });
  const handledWebRtcFailureRef = useRef<string | null>(null);
  const webRtcCodecsExhausted =
    webRtcFailure?.kind === 'codec' &&
    webRtcFallbackDecision(webRtcCodec, activeWebRtcCodec, webRtcFailure)?.type === 'switch-to-http';

  const setWebRtcCodec = useCallback(
    (codec: DeviceWebRtcCodec) => {
      setInitialWebRtcCodec(codec);
      // Selecting an already-active failed codec does not change the stream
      // hook's inputs, so retry its session explicitly.
      if (codec === activeWebRtcCodec && webRtcFailure) restartWebRtc();
    },
    [activeWebRtcCodec, webRtcFailure, restartWebRtc, setInitialWebRtcCodec],
  );

  useEffect(() => {
    if (!useWebRtc || !webRtcFailure) return;
    if (handledWebRtcFailureRef.current === webRtcFailure.sessionId) return;
    handledWebRtcFailureRef.current = webRtcFailure.sessionId;
    const decision = webRtcFallbackDecision(webRtcCodec, activeWebRtcCodec, webRtcFailure);
    if (decision?.type === 'retry-codec') setActiveWebRtcCodec(decision.codec);
  }, [useWebRtc, webRtcFailure, webRtcCodec, activeWebRtcCodec]);

  useEffect(() => {
    if (!useWebRtc) return;
    if (webRtcError || webRtcCodecsExhausted) {
      setStatus('error');
      setError(webRtcError ?? 'No supported WebRTC codec could establish a video stream.');
    } else if (!webRtcStream) {
      setStatus('connecting');
      setError(null);
    }
  }, [useWebRtc, webRtcError, webRtcStream, webRtcCodecsExhausted]);

  useEffect(() => {
    if (!useWebRtc) return;
    const video = videoRef.current;
    if (!video) return;
    let stopped = false;
    let firstFrame = true;
    let frameCallback = 0;
    let previousPresentedFrames: number | null = null;

    const markFrame = (presentedFrameDelta = 1) => {
      if (stopped) return;
      const { videoWidth: width, videoHeight: height } = video;
      if (width > 0 && height > 0 && !hasWsConfigRef.current) {
        setScreen((prev) =>
          prev &&
          prev.orientation === undefined &&
          prev.width === width &&
          prev.height === height
            ? prev
            : { width, height },
        );
      }
      onAvccFrame(presentedFrameDelta);
      markWebRtcFrameDecoded(presentedFrameDelta);
      if (firstFrame) {
        firstFrame = false;
        setStatus('streaming');
        setError(null);
      }
    };
    const onVideoFrame: VideoFrameRequestCallback = (_now, metadata) => {
      const presentedFrameDelta = presentedVideoFrameDelta(
        previousPresentedFrames,
        metadata.presentedFrames,
      );
      if (Number.isSafeInteger(metadata.presentedFrames) && metadata.presentedFrames >= 0) {
        previousPresentedFrames = metadata.presentedFrames;
      }
      markFrame(presentedFrameDelta);
      frameCallback = video.requestVideoFrameCallback(onVideoFrame);
    };
    const onTimeUpdate = () => markFrame();
    const onLoadedData = () => markFrame(0);

    video.srcObject = webRtcStream;
    if (webRtcStream) {
      const supportsVideoFrameCallback = typeof video.requestVideoFrameCallback === 'function';
      if (supportsVideoFrameCallback) frameCallback = video.requestVideoFrameCallback(onVideoFrame);
      else video.addEventListener('timeupdate', onTimeUpdate);
      video.addEventListener('loadeddata', onLoadedData, { once: true });
      void video.play().catch(() => {});
    }

    return () => {
      stopped = true;
      video.removeEventListener('loadeddata', onLoadedData);
      video.removeEventListener('timeupdate', onTimeUpdate);
      if (frameCallback && typeof video.cancelVideoFrameCallback === 'function') {
        video.cancelVideoFrameCallback(frameCallback);
      }
      video.srcObject = null;
    };
  }, [useWebRtc, webRtcStream, markWebRtcFrameDecoded, onAvccFrame]);

  // ── H.264 AVCC (WebCodecs) with serve-sim's MJPEG fallback policy. ──
  useEffect(() => {
    dispatchAvccFallback('reset');
    setFps(0);
  }, [streamMode, videoSessionKey, config?.webRtcCodec]);

  useEffect(() => {
    if (!useAvcc || !config?.url) return;
    const timer = setTimeout(() => dispatchAvccFallback('timeout'), AVCC_FRAME_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [useAvcc, config?.url, videoSessionKey]);

  useAvccStream({
    url: config?.url ?? '',
    enabled: active && useAvcc && !!config,
    canvasRef,
    fetchImpl: videoFetch,
    onFirstFrame: () => {
      setStatus('streaming');
      setError(null);
    },
    onFrame: onAvccFrame,
    onDecodedFrame: () => dispatchAvccFallback('decoded-frame'),
    onResize: (width, height) => {
      if (!hasWsConfigRef.current) {
        setScreen((prev) =>
          prev &&
          prev.orientation === undefined &&
          prev.width === width &&
          prev.height === height
            ? prev
            : { width, height },
        );
      }
    },
    onError: (message) => {
      setStatus('error');
      setError(message);
    },
    onDecoderError: () => dispatchAvccFallback('error'),
  });

  // ── MJPEG video (<img>) ──
  const streamUrl = useAvcc || useWebRtc ? null : (config?.streamUrl ?? null);
  useEffect(() => {
    if (!streamUrl) {
      streamUrlRef.current = null;
      return;
    }
    streamUrlRef.current = streamUrl;
    setStatus('connecting');
    setError(null);

    let cancelled = false;
    let settled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const img = imgRef.current;

    const markStreaming = () => {
      if (cancelled || settled) return;
      const el = imgRef.current;
      if (!el || el.naturalWidth === 0 || el.naturalHeight === 0) return;
      settled = true;
      setStatus('streaming');
      setError(null);
      if (!hasWsConfigRef.current) {
        setScreen((prev) =>
          prev &&
          prev.orientation === undefined &&
          prev.width === el.naturalWidth &&
          prev.height === el.naturalHeight
            ? prev
            : { width: el.naturalWidth, height: el.naturalHeight },
        );
      }
    };
    const onError = () => {
      if (cancelled) return;
      settled = false;
      setStatus('error');
      setError('Stream unavailable — retrying…');
      retryTimer = setTimeout(() => {
        if (!cancelled) applyStreamSrc();
      }, RECONNECT_MS);
    };
    img?.addEventListener('load', markStreaming);
    img?.addEventListener('error', onError);
    applyStreamSrc();
    const poll = setInterval(markStreaming, 400);

    return () => {
      cancelled = true;
      clearInterval(poll);
      if (retryTimer) clearTimeout(retryTimer);
      img?.removeEventListener('load', markStreaming);
      img?.removeEventListener('error', onError);
      const el = imgRef.current;
      if (el) el.removeAttribute('src');
      setScreen(null);
      setFps(0);
    };
  }, [streamUrl, videoSessionKey, applyStreamSrc]);

  // ── Helper control WebSocket (touch/buttons out, screen config in) ──
  const wsUrl = config?.wsUrl ?? null;
  const inputAdmission = config?.inputAdmission === true;
  const controlDevice = config?.device ?? null;
  useEffect(() => {
    pendingWsDestinationRef.current = null;
    pendingWsRef.current = [];
    return () => {
      pendingWsRef.current = [];
    };
  }, [active, baseUrl, targetDevice, token]);

  useEffect(() => {
    setHardwareKeyboardConnectedState(null);
    setInputSocketError(null);
    setInputUnavailable(false);
    if (!wsUrl) return;
    const previousDestination = pendingWsDestinationRef.current;
    if (
      previousDestination &&
      (previousDestination.wsUrl !== wsUrl || previousDestination.device !== controlDevice)
    ) {
      pendingWsRef.current = [];
    }
    pendingWsDestinationRef.current = { wsUrl, device: controlDevice };
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let admissionTimer: ReturnType<typeof setTimeout> | null = null;
    hasWsConfigRef.current = false;
    // Opening is not admission: a refused socket opens, then closes with 1013.
    // A refused socket gets no messages, so the admission frame or a screen
    // config confirms admission.
    const admitInput = () => {
      if (admissionTimer) clearTimeout(admissionTimer);
      admissionTimer = null;
      if (!cancelled) setInputSocketError(null);
    };

    const connect = () => {
      if (cancelled) return;
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl, socketProtocols);
      } catch {
        return;
      }
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;
      ws.onopen = () => {
        if (cancelled) return;
        // Older servers have no admission frame and may have no screen config yet.
        if (!inputAdmission) {
          admissionTimer = setTimeout(admitInput, INPUT_ADMISSION_MS);
        }
        // Deliver whatever the user did while the socket was down.
        pendingWsRef.current = flushWsMessageQueue(ws, pendingWsRef.current);
        // The Hub owns keyboard forwarding while this socket is active. Keep the
        // Simulator's separate host-keyboard connection off so iOS shows its
        // software keyboard while browser HID keys continue to type. serve-sim
        // reconnects it once the last input socket detaches.
        sendWs(WS_MSG_HARDWARE_KEYBOARD, { enabled: false });
        if (!cancelled) setHardwareKeyboardConnectedState(false);
      };
      ws.onmessage = (event) => {
        if (!(event.data instanceof ArrayBuffer)) return;
        const bytes = new Uint8Array(event.data);
        if (bytes.length === 1 && bytes[0] === WS_MSG_INPUT_ADMITTED) {
          admitInput();
          return;
        }
        if (bytes.length < 1 || bytes[0] !== WS_TAG_SCREEN_CONFIG) return;
        try {
          const c = JSON.parse(decoder.decode(bytes.subarray(1))) as ScreenSize & {
            inputUnavailable?: boolean;
          };
          if (!cancelled) setInputUnavailable(c.inputUnavailable === true);
          if (c.width > 0 && c.height > 0) {
            admitInput();
            hasWsConfigRef.current = true;
            setScreen((prev) =>
              prev &&
              prev.width === c.width &&
              prev.height === c.height &&
              prev.orientation === c.orientation
                ? prev
                : c,
            );
          }
        } catch {}
      };
      ws.onclose = (event) => {
        if (cancelled) return;
        wsRef.current = null;
        if (admissionTimer) clearTimeout(admissionTimer);
        admissionTimer = null;
        const rejection = iosInputCloseError(event.code, event.reason);
        if (rejection) setInputSocketError(rejection);
        retryTimer = setTimeout(() => {
          if (cancelled) return;
          connect();
          // Normally exec-ws pushes replacement config. HTTP discovery recovers
          // rotated credentials or a proxy that cannot upgrade WebSockets.
          if (!configUpdatesReadyRef.current) refreshConfigRef.current?.();
        }, RECONNECT_MS);
      };
      ws.onerror = () => {
        try {
          ws.close();
        } catch {}
      };
    };
    connect();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (admissionTimer) clearTimeout(admissionTimer);
      try {
        wsRef.current?.close();
      } catch {}
      wsRef.current = null;
      // Keep fresh input across rediscovery; connection/device changes clear
      // it above, and the queue drops expired messages before delivery.
      setHardwareKeyboardConnectedState(null);
    };
  }, [wsUrl, inputAdmission, controlDevice, sendWs, socketProtocols, videoSessionKey]);

  // ── Long-lived middleware SSE routes multiplexed over one authenticated
  //    exec-ws, matching serve-sim's browser client. Keeping logs, events, and
  //    metrics off separate HTTP streams avoids the per-origin connection cap. ──
  const execWsUrl = connection?.middleware.execWsUrl ?? null;
  const execToken = connection?.middleware.execToken ?? null;
  const configEventsPath = connection?.middleware.configEventsPath ?? null;
  const logsPath = config?.logsPath ?? null;
  const eventsPath = config?.eventsPath ?? null;
  const metricsPath = config?.metricsPath ?? null;
  const deviceUdid = config?.device ?? null;
  const axUrl = config?.axUrl ?? null;

  const accessibilityLoader = useMemo<AccessibilityLoader | null>(
    () => (axUrl ? (signal) => loadIosAccessibility(axUrl, signal, sessionFetch) : null),
    [axUrl, sessionFetch],
  );
  const accessibilityState = useAccessibility(accessibilityLoader);

  // One-shot typed host actions (`location.*`, `app.*`) over the exec channel.
  const runAction = useMemo(
    () =>
      execWsUrl && execToken
        ? (action: string, params?: Parameters<typeof runHostAction>[3]) =>
            runHostAction(execWsUrl, execToken, action, params, socketProtocols)
        : null,
    [execWsUrl, execToken, socketProtocols],
  );

  const locationBackend = useMemo<DeviceLocationBackend | null>(() => {
    if (!runAction || !deviceUdid) return null;
    return {
      set: (fix) => setIosLocation(runAction, deviceUdid, fix),
      clear: () => clearIosLocation(runAction, deviceUdid),
    };
  }, [runAction, deviceUdid]);
  const {
    location,
    locationPending,
    locationError,
    setLocation,
    clearLocation,
    locationCapabilities,
  } = useDeviceLocation(locationBackend);

  // serve-sim exposes permissions over its CLI channel only, so the Hub has no
  // route to read them. The section stays hidden until serve-sim serves them.
  const appPermissions = useAppPermissions({ active, appId: null, backend: null });

  useEffect(() => {
    setEventLogState(createIosEventLogState());
  }, [eventsPath, deviceUdid]);

  useEffect(() => {
    activityLastSampleAtRef.current = 0;
    if (!metricsPath) {
      setActivity(null);
      return;
    }
    setActivity({ hostCores: null, samples: [], errored: false, stale: false });
    const watchdog = setInterval(() => {
      const lastSampleAt = activityLastSampleAtRef.current;
      if (lastSampleAt > 0 && Date.now() - lastSampleAt > ACTIVITY_STALE_MS) {
        setActivity((current) => (current && !current.stale ? { ...current, stale: true } : current));
      }
    }, 1000);
    return () => clearInterval(watchdog);
  }, [metricsPath]);

  useEffect(() => {
    if (!execWsUrl || !execToken) return;
    const subscriptions = new Map<number, 'logs' | 'events' | 'metrics' | 'config'>();
    const paths = new Map<number, string>();
    if (configEventsPath) {
      subscriptions.set(4, 'config');
      paths.set(4, configEventsPath);
    }
    if (logsEnabled && logsPath) {
      subscriptions.set(1, 'logs');
      paths.set(1, logsPath);
    }
    if (eventsEnabled && eventsPath && deviceUdid) {
      subscriptions.set(2, 'events');
      paths.set(2, eventsPath);
    }
    if (metricsPath) {
      subscriptions.set(3, 'metrics');
      paths.set(3, metricsPath);
    }
    if (subscriptions.size === 0) return;

    let cancelled = false;
    let ws: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const buffers = new Map<number, string>();
    const markInterrupted = () => {
      deviceSettingsReadRef.current?.invalidate();
      settleRead('error');
      if (metricsPath) {
        setActivity((current) => (current ? { ...current, errored: true } : current));
      }
    };

    const emit = (kind: 'logs' | 'events' | 'metrics' | 'config', block: ParsedSseBlock) => {
      if (kind === 'config') {
        try {
          const value = JSON.parse(block.data) as PreviewApi | null;
          applyPreviewConfigRef.current?.(value);
          configUpdatesReadyRef.current = true;
        } catch {}
        return;
      }
      if (kind === 'logs') {
        let message = block.data;
        try {
          const parsed = JSON.parse(block.data) as { eventMessage?: string };
          if (typeof parsed.eventMessage === 'string') message = parsed.eventMessage;
        } catch {}
        if (message) {
          setLogs((previous) =>
            [
              ...previous,
              { id: `i${++logSeqRef.current}`, source: 'syslog', message },
            ].slice(-MAX_LOGS),
          );
        }
        return;
      }
      if (kind === 'events' && deviceUdid) {
        setEventLogState((current) =>
          mergeIosEventLogPayload(current, block.data, deviceUdid),
        );
        return;
      }
      if (kind !== 'metrics') return;
      try {
        const payload = JSON.parse(block.data) as unknown;
        if (block.event === 'meta') {
          const hostCores = parseActivityHostCores(payload);
          setActivity((current) =>
            current ? { ...current, hostCores, errored: false } : current,
          );
          return;
        }
        const sample = parseActivitySample(payload);
        if (!sample) return;
        activityLastSampleAtRef.current = Date.now();
        setActivity((current) =>
          appendActivitySample(
            current ?? { hostCores: null, samples: [], errored: false, stale: false },
            sample,
          ),
        );
      } catch {}
    };

    const connect = () => {
      if (cancelled) return;
      buffers.clear();
      try {
        ws = new WebSocket(execWsUrl, socketProtocols);
      } catch {
        configUpdatesReadyRef.current = false;
        markInterrupted();
        retryTimer = setTimeout(() => {
          if (cancelled) return;
          connect();
          refreshConfigRef.current?.();
        }, RECONNECT_MS);
        return;
      }
      ws.onopen = () => ws?.send(JSON.stringify({ token: execToken }));
      ws.onmessage = (event) => {
        if (cancelled) return;
        let msg: { ready?: boolean; sub?: number; data?: string; end?: boolean };
        try {
          msg = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (msg.ready) {
          deviceSettingsReadRef.current?.resume();
          for (const [sub, path] of paths) {
            ws?.send(JSON.stringify({ sub, path }));
          }
          return;
        }
        if (typeof msg.sub !== 'number' || !subscriptions.has(msg.sub)) return;
        if (msg.end) {
          markInterrupted();
          ws?.close();
          return;
        }
        if (typeof msg.data === 'string') {
          const sub = msg.sub;
          const kind = subscriptions.get(sub)!;
          buffers.set(
            sub,
            drainSseChunk(buffers.get(sub) ?? '', msg.data, (block) => emit(kind, block)),
          );
        }
      };
      ws.onclose = () => {
        if (!cancelled) {
          configUpdatesReadyRef.current = false;
          markInterrupted();
          retryTimer = setTimeout(() => {
            if (cancelled) return;
            connect();
            refreshConfigRef.current?.();
          }, RECONNECT_MS);
        }
      };
      ws.onerror = () => {
        try {
          ws?.close();
        } catch {}
      };
    };
    connect();

    return () => {
      cancelled = true;
      configUpdatesReadyRef.current = false;
      if (retryTimer) clearTimeout(retryTimer);
      try {
        ws?.close();
      } catch {}
    };
  }, [
    logsEnabled,
    eventsEnabled,
    execWsUrl,
    execToken,
    configEventsPath,
    logsPath,
    eventsPath,
    metricsPath,
    deviceUdid,
    socketProtocols,
    settleRead,
  ]);

  // Bulk reads hydrate the controls and track changes made inside the simulator.
  // Wait between completed reads; hidden tabs and interrupted control sockets pause polling.
  useEffect(() => {
    const tracker = deviceSettingWriteTrackerRef.current;
    tracker.reset();
    deviceSettingVersionsRef.current.clear();
    setDeviceSettingsPending(new Set());
    resetRead();
    setAppearanceState(null);
    setDeviceSettings(null);
    if (!execWsUrl || !execToken || !deviceUdid) {
      if (deviceUdid) settleRead('error');
      return;
    }
    let cancelled = false;
    let interrupted = false;
    let reading = false;
    let revision = 0;
    let refreshQueued = false;
    let retryDelay = RECONNECT_MS;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const pageDocument = typeof document === 'undefined' ? null : document;
    const isHidden = () => pageDocument?.hidden === true;
    const clearTimer = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = null;
    };
    const scheduleRefresh = (delay: number) => {
      clearTimer();
      if (cancelled || interrupted || isHidden()) return;
      refreshTimer = setTimeout(() => void refresh(), delay);
    };
    const invalidate = () => {
      interrupted = true;
      revision++;
      refreshQueued = false;
      clearTimer();
    };
    const refresh = async () => {
      if (cancelled || interrupted || isHidden()) return;
      const readRevision = ++revision;
      if (reading) {
        refreshQueued = true;
        return;
      }
      refreshQueued = false;
      clearTimer();
      reading = true;
      const versions = new Map(deviceSettingVersionsRef.current);
      const pendingAtStart = tracker.pending;
      try {
        const res = await hostUiRequest(execWsUrl, execToken, { device: deviceUdid }, socketProtocols);
        // A response from before an interruption cannot restore availability.
        if (cancelled || readRevision !== revision) return;
        if (!res.status || typeof res.status !== 'object' || Array.isArray(res.status)) {
          throw new Error('Simulator settings request returned an invalid status');
        }
        const next: DeviceSettings = {};
        for (const [key, value] of Object.entries(res.status)) {
          if (typeof value === 'string') next[key as DeviceSettingKey] = value;
        }
        const pending = tracker.pending;
        const canApply = (key: DeviceSettingKey) =>
          !pendingAtStart.has(key) &&
          !pending.has(key) &&
          deviceSettingVersionsRef.current.get(key) === versions.get(key);
        setDeviceSettings((current) => {
          let merged = current ?? {};
          for (const key of new Set([...Object.keys(merged), ...Object.keys(next)])) {
            const setting = key as DeviceSettingKey;
            if (!canApply(setting) || merged[setting] === next[setting]) continue;
            if (merged === current) merged = { ...merged };
            if (next[setting] === undefined) delete merged[setting];
            else merged[setting] = next[setting];
          }
          return merged;
        });
        settleRead('ready');
        if (canApply('appearance') && (next.appearance === 'light' || next.appearance === 'dark')) {
          setAppearanceState(next.appearance);
        }
        // The helper socket's open handler usually settles this first (it
        // disconnects the hardware keyboard); only fill in an unknown.
        const keyboardValue = res.status?.[UI_OPTION_HARDWARE_KEYBOARD];
        if (keyboardValue === 'on' || keyboardValue === 'off') {
          setHardwareKeyboardConnectedState((prev) => prev ?? keyboardValue === 'on');
        }
        retryDelay = RECONNECT_MS;
        scheduleRefresh(DEVICE_SETTINGS_POLL_MS);
      } catch {
        if (!cancelled && readRevision === revision) {
          settleRead('error');
          scheduleRefresh(retryDelay);
          retryDelay = Math.min(retryDelay * 2, DEVICE_SETTINGS_RETRY_MAX_MS);
        }
      } finally {
        reading = false;
        // Coalesce reconnects during a read into one fresh follow-up request.
        if (!cancelled && refreshQueued) void refresh();
      }
    };
    const onVisibilityChange = () => {
      if (isHidden()) {
        refreshQueued = false;
        clearTimer();
      } else {
        retryDelay = RECONNECT_MS;
        void refresh();
      }
    };
    deviceSettingsReadRef.current = {
      invalidate,
      resume: () => {
        if (!interrupted) return;
        interrupted = false;
        retryDelay = RECONNECT_MS;
        void refresh();
      },
    };
    pageDocument?.addEventListener('visibilitychange', onVisibilityChange);
    void refresh();
    return () => {
      cancelled = true;
      clearTimer();
      pageDocument?.removeEventListener('visibilitychange', onVisibilityChange);
      deviceSettingsReadRef.current = null;
    };
  }, [execWsUrl, execToken, deviceUdid, socketProtocols, resetRead, settleRead]);

  // ── Runtime encoder settings (serve-sim helper GET/PATCH endpoint) ──
  const streamSettingsUrl = config?.streamSettingsUrl ?? null;
  const initialStreamSettings = config?.initialStreamSettings;
  const normalizedInitialStreamSettings = useMemo(
    () => (streamSettingsUrl ? normalizeDeviceStreamSettings(initialStreamSettings) : null),
    [initialStreamSettings, streamSettingsUrl],
  );
  const { streamSettings, streamSettingsPending, updateStreamSettings } = useStreamSettingsResource(
    {
      url: streamSettingsUrl,
      initialSettings: normalizedInitialStreamSettings,
      parse: parseIosStreamSettings,
      toPatch: iosStreamSettingsPatch,
      fetchImpl: sessionFetch,
    },
  );

  // ── Foreground app (middleware /appstate SSE) — the middleware bootstraps a
  //    fresh subscriber with the current frontmost app, then pushes changes as
  //    SpringBoard foregrounds apps. EventSource reconnects on its own. ──
  const appStateUrl = config?.appStateUrl ?? null;
  useEffect(() => {
    setForegroundApp(null);
    if (!appStateUrl) return;
    let source: EventSource | null = null;
    try {
      source = new EventSource(appStateUrl);
    } catch {
      return;
    }
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(String(event.data)) as {
          bundleId?: string;
          pid?: number;
          isReactNative?: boolean;
        };
        if (data.bundleId) {
          // Merge repeat events for the same app so a relaunch (new pid)
          // doesn't wipe the bundle details filled in below.
          setForegroundApp((prev) =>
            prev && prev.id === data.bundleId
              ? prev.pid === data.pid && prev.isReactNative === data.isReactNative
                ? prev
                : { ...prev, pid: data.pid, isReactNative: data.isReactNative }
              : { id: data.bundleId!, pid: data.pid, isReactNative: data.isReactNative },
          );
        }
      } catch {}
    };
    return () => source?.close();
  }, [appStateUrl]);

  // ── Foreground app details (name, versions, icon) — introspected from the
  //    app bundle on the host over exec-ws whenever the foreground bundle id
  //    changes. Cached per udid:bundleId, so revisits apply instantly. A server
  //    with the icon route serves the icon over plain HTTP instead, fetched
  //    again on every foreground change. ──
  const foregroundAppId = foregroundApp?.id ?? null;
  const appIconUrl = config?.appIconUrl ?? null;
  useEffect(() => {
    if (!foregroundAppId || !runAction || !deviceUdid) return;
    let cancelled = false;
    getIosAppDetails(runAction, deviceUdid, foregroundAppId, { includeIcon: !appIconUrl })
      .then((details) => {
        if (cancelled || !details) return;
        setForegroundApp((prev) =>
          prev && prev.id === foregroundAppId ? { ...prev, ...details } : prev,
        );
      })
      .catch(() => {
        /* exec channel unavailable — the id/pid line still renders */
      });
    return () => {
      cancelled = true;
    };
  }, [foregroundAppId, runAction, deviceUdid, appIconUrl]);

  useEffect(() => {
    if (!foregroundAppId || !appIconUrl) return;
    const controller = new AbortController();
    fetchIosAppIcon(appIconUrl, foregroundAppId, {
      fetchImpl: sessionFetch,
      signal: controller.signal,
    })
      .then((iconDataUrl) => {
        if (controller.signal.aborted || !iconDataUrl) return;
        setForegroundApp((prev) =>
          prev && prev.id === foregroundAppId ? { ...prev, iconDataUrl } : prev,
        );
      })
      .catch(() => {
        /* route unavailable or app not installed — the placeholder still renders */
      });
    return () => controller.abort();
  }, [foregroundAppId, appIconUrl, sessionFetch]);

  // ── Running simulators (middleware /grid/api) ──
  const gridApiUrl = config?.gridApiUrl ?? null;
  useEffect(() => {
    if (!gridApiUrl) {
      setDevices(PLACEHOLDER_DEVICES);
      return;
    }
    let cancelled = false;
    sessionFetch(gridApiUrl, { signal: AbortSignal.timeout(3000) })
      .then((r) => r.json())
      .then((data: { devices?: Array<Record<string, unknown>> }) => {
        if (cancelled || !Array.isArray(data.devices) || data.devices.length === 0) return;
        setDevices(
          data.devices.map((d) => ({
            id: String(d.device ?? d.id ?? 'ios'),
            name: String(d.name ?? d.device ?? 'Simulator'),
            system: typeof d.runtime === 'string' ? d.runtime : undefined,
            platform: 'ios' as const,
            current: d.helper != null,
          })),
        );
      })
      .catch(() => {
        /* unreachable — keep the placeholder */
      });
    return () => {
      cancelled = true;
    };
  }, [gridApiUrl, sessionFetch]);

  const deviceSettingsAvailable = !!execWsUrl && !!execToken && !!deviceUdid;
  const activityAvailable = !!metricsPath;
  const eventsAvailable = !!eventsPath;
  const accessibilityAvailable = accessibilityLoader !== null;
  const streamSettingsAvailable = !!streamSettingsUrl;
  const capabilities = useMemo<DeviceCapabilities>(
    () => ({
      deviceSettings: deviceSettingsAvailable,
      activity: activityAvailable,
      events: eventsAvailable,
      camera: false,
      accessibility: accessibilityAvailable,
      streamSettings: streamSettingsAvailable ? IOS_STREAM_SETTING_CAPABILITIES : false,
      location: locationCapabilities,
      permissions: false,
    }),
    [
      deviceSettingsAvailable,
      activityAvailable,
      eventsAvailable,
      accessibilityAvailable,
      streamSettingsAvailable,
      locationCapabilities,
    ],
  );

  return {
    platform: 'ios',
    status,
    error,
    inputError: inputUnavailable ? IOS_INPUT_UNAVAILABLE_MESSAGE : inputSocketError,
    screen,
    fps,
    devices,
    logs,
    logsEnabled,
    attachLogs,
    detachLogs,
    clearLogs,
    events,
    eventsEnabled,
    attachEvents,
    detachEvents,
    clearEvents,
    activity,
    deviceSettings,
    deviceSettingsStatus,
    deviceSettingsPending,
    setDeviceSetting,
    displayWidthDp: null,
    camera: null,
    cameraPending: NO_PENDING_CAMERA_WRITES,
    cameraError: null,
    setCameraImage: noop,
    clearCameraImage: noop,
    ...accessibilityState,
    location,
    locationPending,
    locationError,
    setLocation,
    clearLocation,
    ...appPermissions,
    streamCapabilities,
    screenRecording: null,
    streamSettings,
    streamSettingsPending,
    updateStreamSettings,
    streamSource: null,
    streamSourcePending: false,
    streamSourceError: null,
    setStreamSource: noop,
    setGrpcImageMode: noop,
    setGrpcEncoder: noop,
    setGrpcInputSource: noop,
    streamStats,
    setStreamStatsEnabled,
    webRtcCodec,
    setWebRtcCodec,
    capabilities,
    foregroundApp,
    videoKind: useWebRtc ? 'video' : useAvcc ? 'canvas' : 'img',
    attachVideo,
    sendTouch,
    sendMultiTouch,
    sendKey,
    sendKeyEvents,
    sendScroll,
    pressButton,
    reload,
    rotate,
    screenshot,
    appearance,
    setAppearance,
    hardwareKeyboardConnected,
    setHardwareKeyboardConnected,
    toggleSoftwareKeyboard,
  };
}
