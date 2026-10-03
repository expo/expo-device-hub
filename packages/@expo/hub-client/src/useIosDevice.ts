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
 *      multi-touch, `0x06` key, `0x0b` scroll, `0x0e` hardware keyboard, and
 *      `0x10` iPhone Duo hinge commands out; `0x82` screen config and `0x90`
 *      hinge acknowledgements in). Coordinates are mapped to the device's raw
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

import {
  type AcknowledgedControlReply,
  createAcknowledgedControlQueue,
} from './acknowledged-control-queue';
import { AVCC_FRAME_TIMEOUT_MS, avccFallbackReducer, initialAvccFallback } from './avcc-fallback';
import {
  type DuoHingeCommands,
  INITIAL_DUO_HINGE_COMMANDS,
  recordDuoHingeCommand,
} from './duo/duo-hinge-commands';
import { duoIntendedScreen, duoPhysicalPoseChanged } from './duo/duo-pose';
import {
  DUO_FACE_DOWN_HELD,
  type DuoFaceDownFraming,
  type DuoView,
  duoFaceDownFraming,
  duoInitialView,
  duoPresetView,
  duoRotateView,
} from './duo/duo-view';
import {
  type HingeControlCommand,
  type HingeControlState,
  type HingePose,
  hingeControlState,
} from './hinge-control';
import {
  appendActivitySample,
  parseActivityHostCores,
  parseActivitySample,
} from './activity';
import { type AccessibilityLoader, loadIosAccessibility } from './accessibility';
import { isAvccSupported } from './avcc';
import {
  HID_EDGE_BOTTOM,
  ROTATE_LEFT_CYCLE,
  ROTATE_RIGHT_CYCLE,
  homeIndicatorEdge,
  rawDeltaForDisplayDelta,
  rawEdgeForDisplayEdge,
  rawPointForDisplayPoint,
  streamGeometry,
} from './orientation';
import { screenConfigsEqual } from './screen-config';
import { startIosHelper } from './connections';
import {
  clearIosEventLogState,
  createIosEventLogState,
  mergeIosEventLogPayload,
} from './ios-events';
import { hostUiRequest, runHostAction } from './exec-ws';
import { getIosAppDetails } from './ios-app-details';
import { clearIosLocation, setIosLocation } from './ios-location';
import { fetchScreenshot } from './screenshot';
import { hidUsageForCode } from './keyboard';
import {
  type ConnectionStatus,
  type DeviceActivity,
  type DeviceAppearance,
  type DeviceClient,
  type DeviceConnectionOptions,
  type DeviceHinge,
  type DeviceLog,
  type DeviceSettingKey,
  type DeviceSettings,
  type DeviceStreamCapabilities,
  type DeviceStreamEncoderSettings,
  type DeviceWebRtcCodec,
  type DuoModelMultiTouch,
  type DuoModelScroll,
  type DuoModelTouch,
  type DuoPanelFeeds,
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
import { KeyedWriteTracker } from './keyed-write-tracker';
import { createPacedKeySender } from './paced-key-sender';
import { middlewareEndpointForBrowser, proxyPreviewConfigForBrowser } from './proxy-preview-config';
import { type ParsedSseBlock, drainSseChunk } from './sse';
import { normalizeDeviceStreamSettings } from './stream-settings';
import { useAccessibility } from './useAccessibility';
import { useAppPermissions } from './useAppPermissions';
import { useAvccStream } from './useAvccStream';
import { type DeviceLocationBackend, useDeviceLocation } from './useDeviceLocation';
import { useStreamSettingsResource } from './useStreamSettingsResource';
import { useWebRtcStream, type WebRtcIceServer } from './useWebRtcStream';
import { presentedVideoFrameDelta } from './video-frame-metadata';
import {
  type WebRtcCodec,
  type WebRtcStreamFailure,
  webRtcFallbackDecision,
} from './webrtc-fallback';
import {
  WS_OPEN_READY_STATE,
  encodeWsMessage,
  flushWsMessageQueue,
  type QueuedWsMessage,
  sendOrQueueWsMessage,
} from './ws-send-queue';

const MAX_LOGS = 200;
const RECONNECT_MS = 1500;
const ACTIVITY_STALE_MS = 8000;

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
const WS_TAG_SCREEN_CONFIG = 0x82;
// iPhone Duo hinge commands carry a requestId that the helper acknowledges with 0x90.
const WS_MSG_HINGE_CONTROL = 0x10;
const WS_TAG_HINGE_REPLY = 0x90;

// HID keyboard usage codes (USB HID Usage Page 0x07) for the R reload chord.
const HID_USAGE_R = 0x15; // 'r'

// The simulator-settings option behind `hardwareKeyboardConnected`.
const UI_OPTION_HARDWARE_KEYBOARD = 'hardware-keyboard';

const PLACEHOLDER_DEVICES: RunningDevice[] = [
  { id: 'ios', name: 'iPhone Simulator', platform: 'ios', current: true },
];

const IOS_STREAM_CAPABILITIES = {
  modeAvailability: { mjpeg: true, h264: true, webrtc: true },
  httpCodecs: ['auto', 'h264', 'mjpeg'],
  webRtcCodecs: ['h264', 'vp9', 'vp8'],
} as const satisfies DeviceStreamCapabilities;

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
  device: string | null;
  /** Middleware exec-ws URL used for logs, events, metrics, and UI requests. */
  execWsUrl: string | null;
  execToken: string | null;
  /** Relative SSE path to subscribe for logs, e.g. `/logs?device=<udid>`. */
  logsPath: string | null;
  /** Absolute URL of the foreground-app SSE stream. */
  appStateUrl: string | null;
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
  /** Middleware route serving Xcode's iPhone Duo model (`grid/api/devicekit-model`). */
  deviceKitModelUrl: string | null;
  /** DeviceKit chrome identifier advertised for the device, e.g. `phone15` for the Duo's cover. */
  chromeIdentifier: string | null;
  webRtcCodec: WebRtcCodec;
  webRtcIceServers?: WebRtcIceServer[];
}

/** Shape of the serve-sim middleware `/api` (and grid) responses we read. */
interface PreviewApi {
  url?: string;
  streamUrl?: string;
  wsUrl?: string;
  device?: string;
  basePath?: string;
  execToken?: string;
  logsEndpoint?: string;
  appStateEndpoint?: string;
  eventLogEventsEndpoint?: string;
  metricsEndpoint?: string;
  axEndpoint?: string;
  streamSettingsEndpoint?: string;
  gridApiEndpoint?: string;
  /** Bezel geometry for `device`; its identifier names the DeviceKit chrome profile. */
  chrome?: { identifier?: string } | null;
  proxyHelpers?: boolean;
  streamSettings?:
    | ({ transport: 'http'; codec?: 'auto' | 'h264' | 'mjpeg' } &
        Partial<DeviceStreamEncoderSettings>)
    | ({ transport: 'webrtc'; codec: WebRtcCodec; iceServers?: WebRtcIceServer[] } &
        Partial<DeviceStreamEncoderSettings>);
}

export function useIosDeviceClient(options: DeviceConnectionOptions): DeviceClient {
  const {
    baseUrl,
    enabled = true,
    device: targetDevice = null,
    streamMode,
    duoPreview = '2d',
  } = options;
  const active = enabled && !!baseUrl;

  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [error, setError] = useState<string | null>(null);
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
  const [config, setConfig] = useState<ResolvedConfig | null>(null);
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
  const [webRtcHttpFallback, setWebRtcHttpFallback] = useState(false);
  const deviceSettingWriteTrackerRef = useRef(new KeyedWriteTracker<DeviceSettingKey>());
  // Async option writes capture their config. Track only committed config so
  // an interrupted concurrent render cannot invalidate a legitimate rollback.
  const deviceSettingConfigRef = useRef(config);
  useLayoutEffect(() => {
    deviceSettingConfigRef.current = config;
  }, [config]);
  const activityLastSampleAtRef = useRef(0);
  const useWebRtc = streamMode === 'webrtc' && !webRtcHttpFallback;
  const wantsAvcc = streamMode === 'h264' || webRtcHttpFallback;
  const useAvcc = wantsAvcc && isAvccSupported() && !avccFallback.fellBack;

  // ── iPhone Duo: hinge state, mirroring serve-sim's client ──
  // Before native capability metadata arrives, recognize the Duo by Xcode's
  // DeviceKit chrome identifiers (phone15 is the cover profile and phone14 the
  // inner display variant) or by its name.
  const currentDeviceId = config?.device ?? targetDevice;
  const deviceName = devices.find((device) => device.id === currentDeviceId)?.name;
  const isDuo =
    screen?.supportsHingeAngle === true ||
    config?.chromeIdentifier === 'phone14' ||
    config?.chromeIdentifier === 'phone15' ||
    /\biphone\s+duo\b/i.test(deviceName ?? '');
  // The 3D model feeds both panels itself, so the flat stream parks meanwhile.
  const modelActive = isDuo && duoPreview === '3d';
  const [hingePending, setHingePending] = useState(false);
  const [hingeError, setHingeError] = useState<string | null>(null);
  // The requested state, shown until its acknowledgement and matching config arrive.
  const [hingePreview, setHingePreview] = useState<HingeControlState | null>(null);
  const [physicalPose, setPhysicalPose] = useState<HingePose | null | undefined>(undefined);
  const [duoView, setDuoView] = useState<DuoView | null>(null);
  const faceDownFramingRef = useRef<DuoFaceDownFraming>({ saved: null, held: false });
  // A local rotation cleared the native preset; ignore older preset acknowledgements.
  const [orientationOverride, setOrientationOverride] = useState(false);
  const hingePendingRef = useRef(false);
  const [hingeCommands, setHingeCommands] = useState<DuoHingeCommands>(INITIAL_DUO_HINGE_COMMANDS);
  const sentHingePoseRef = useRef<HingePose | null | undefined>(undefined);
  // The view a pending preset replaced. A rejected, timed-out, or interrupted
  // preset restores it, unless a later Rotate superseded it.
  const duoViewRef = useRef<DuoView | null>(null);
  duoViewRef.current = duoView;
  const viewGenerationRef = useRef(0);
  const presetRestoreRef = useRef<{ view: DuoView | null; generation: number } | null>(null);
  const hingeQueueRef = useRef<ReturnType<
    typeof createAcknowledgedControlQueue<HingeControlCommand>
  > | null>(null);
  const [panelStreaming, setPanelStreaming] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);
  const previewHingeAngle = hingePreview?.hingeAngle ?? screen?.hingeAngle;
  const previewHingePose = hingePreview ? hingePreview.hingePose : screen?.hingePose;
  // A pending angle or preset releases Table Mode, so the preview wins over a
  // face-down orientation that another client confirmed.
  const previewFaceDown =
    (hingePreview?.tableMode ?? screen?.tableMode) === true &&
    screen?.physicalOrientation === 'facedown';
  const initialDuoView = useMemo(
    () => duoInitialView(screen?.hingeAngle, screen?.hingePose, screen),
    [screen],
  );
  // Control callbacks read the latest native state without re-registering
  // listeners on every config broadcast.
  const duoRef = useRef({ isDuo, initialView: initialDuoView, screen });
  duoRef.current = { isDuo, initialView: initialDuoView, screen };
  useEffect(() => {
    if (streamMode === 'webrtc') return;
    setWebRtcHttpFallback(false);
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
      void hostUiRequest(c.execWsUrl, c.execToken, {
        device: c.device,
        option: UI_OPTION_HARDWARE_KEYBOARD,
        value: connected ? 'on' : 'off',
      }).catch(() => setHardwareKeyboardConnectedState(previous));
    },
    [config, hardwareKeyboardConnected],
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

  // Rotate one step from the last known orientation, over the helper's
  // orientation channel (tag 0x07 → HID orientation event). The helper confirms
  // by pushing an updated screen config, which keeps the cycle in sync. Other
  // devices follow Simulator's counterclockwise "Rotate Left"; the iPhone Duo
  // turns clockwise like Xcode's Device Hub and serve-sim, and its 3D view turns
  // at once while the native preset, which a rotation clears, is forgotten.
  const rotate = useCallback(() => {
    const current = screenRef.current?.orientation ?? 'portrait';
    const duo = duoRef.current;
    const next = (duo.isDuo ? ROTATE_RIGHT_CYCLE : ROTATE_LEFT_CYCLE)[current];
    if (duo.isDuo) {
      viewGenerationRef.current += 1;
      setDuoView((previous) => duoRotateView(previous ?? duo.initialView, 1));
      faceDownFramingRef.current = DUO_FACE_DOWN_HELD;
      setHingePreview(null);
      setPhysicalPose(null);
      sentHingePoseRef.current = null;
      setOrientationOverride(true);
    }
    sendWs(WS_MSG_ORIENTATION, { orientation: next });
  }, [sendWs]);

  function restorePresetView() {
    const restore = presetRestoreRef.current;
    if (restore && restore.generation === viewGenerationRef.current) setDuoView(restore.view);
  }

  // One command at a time: a live slider coalesces into the newest value and a
  // preset replaces queued edits. Replies arrive as 0x90 on the helper socket.
  if (!hingeQueueRef.current) {
    hingeQueueRef.current = createAcknowledgedControlQueue<HingeControlCommand>({
      send: (request) => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WS_OPEN_READY_STATE) return false;
        ws.send(encodeWsMessage(WS_MSG_HINGE_CONTROL, request).buffer);
        if (request.command.control === 'pose') sentHingePoseRef.current = request.command.value;
        const pose = sentHingePoseRef.current;
        setHingeCommands((previous) => recordDuoHingeCommand(previous, request.command, pose));
        return true;
      },
      onPendingChange: (pending) => {
        hingePendingRef.current = pending;
        setHingePending(pending);
        setHingeCommands((previous) => ({ ...previous, pending }));
      },
      onResult: (command, reply) => {
        // An acknowledged preset owns the view from here; a later failure
        // must not undo it.
        if (reply.ok && command.control === 'pose') presetRestoreRef.current = null;
      },
      onError: (message) => {
        // A failure discards the whole queue, including any preset whose view
        // is already showing but was never sent or confirmed.
        restorePresetView();
        presetRestoreRef.current = null;
        setHingeError(message);
        setHingePreview(null);
        setPhysicalPose(undefined);
        sentHingePoseRef.current = undefined;
        setOrientationOverride(false);
      },
    });
  }

  const setHingeControl = useCallback((command: HingeControlCommand) => {
    const { screen, initialView } = duoRef.current;
    setHingeError(null);
    faceDownFramingRef.current = DUO_FACE_DOWN_HELD;
    // Editing the hinge or Table Mode clears the named preset, but preserves
    // the simulator's physical orientation (for example Laptop on a table).
    if (command.control === 'pose') {
      // Remember the view before the first preset of a burst; it is dropped
      // once the helper acknowledges a preset.
      presetRestoreRef.current ??= {
        view: duoViewRef.current,
        generation: viewGenerationRef.current,
      };
      setPhysicalPose(command.value);
      setOrientationOverride(false);
      setDuoView(duoPresetView(command.value));
    } else {
      // Lock even an early edit before the first complete native config.
      setDuoView((previous) => previous ?? initialView);
    }
    setHingePreview((previous) => ({
      hingeAngle: previous?.hingeAngle ?? screen?.hingeAngle,
      hingePose: previous ? previous.hingePose : screen?.hingePose,
      tableMode: previous?.tableMode ?? screen?.tableMode,
      ...hingeControlState(command),
    }));
    hingeQueueRef.current?.enqueue(command, {
      key: command.control,
      replaceQueued: command.control === 'pose',
    });
  }, []);
  // The 3D scene already mapped these to the raw framebuffer of the panel it hit.
  const sendModelTouch = useCallback(
    (sample: DuoModelTouch) => sendWs(WS_MSG_TOUCH, sample),
    [sendWs],
  );
  const sendModelMultiTouch = useCallback(
    (sample: DuoModelMultiTouch) => sendWs(WS_MSG_MULTI_TOUCH, sample),
    [sendWs],
  );
  const sendModelScroll = useCallback(
    (sample: DuoModelScroll) => sendWs(WS_MSG_SCROLL, sample),
    [sendWs],
  );

  // serve-sim's middleware captures the sim via `simctl io <udid> screenshot`
  // and returns the PNG bytes. Use the resolved udid from `/api` (falling back
  // to the requested device); the middleware defaults to the booted sim if none.
  const screenshot = useCallback(async (): Promise<ScreenshotCapture | null> => {
    if (!baseUrl) return null;
    const udid = config?.device ?? targetDevice;
    return fetchScreenshot(baseUrl, udid);
  }, [baseUrl, targetDevice, config]);

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
      setDeviceSettingsPending(tracker.pending);
      setDeviceSettings((current) => ({ ...(current ?? {}), [key]: value }));
      if (key === 'appearance' && (value === 'light' || value === 'dark')) {
        setAppearanceState(value);
      }
      void hostUiRequest(execWsUrl, execToken, {
        device,
        option: key,
        value,
      })
        .catch(async () => {
          if (!tracker.isCurrent(request) || deviceSettingConfigRef.current !== c) return;
          try {
            const result = await hostUiRequest(execWsUrl, execToken, { device });
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
    [config],
  );

  const setAppearance = useCallback(
    (mode: DeviceAppearance) => setDeviceSetting('appearance', mode),
    [setDeviceSetting],
  );

  const setWebRtcCodec = useCallback((codec: DeviceWebRtcCodec) => {
    setWebRtcCodecState(codec);
    setActiveWebRtcCodec(codec);
    setWebRtcHttpFallback(false);
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
      setConfig(null);
      setStatus('idle');
      return;
    }
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    // A newly selected device must not keep streaming the previous helper
    // under its name while its own config resolves.
    setConfig(null);
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
      return {
        url: c.url!,
        streamUrl: c.streamUrl ?? `${c.url}/stream.mjpeg`,
        wsUrl: toQueryStyleHelperWsUrl(c.wsUrl ?? `${toWs(c.url!)}/ws`),
        device: c.device ?? null,
        execWsUrl: toWs(absoluteMiddlewareUrl(`${basePath}/exec-ws`)!),
        execToken: c.execToken ?? null,
        // These are subscription paths inside exec-ws, not browser URLs. The
        // server validates them against its internal middleware mount.
        logsPath: c.logsEndpoint ?? null,
        appStateUrl: absoluteMiddlewareUrl(c.appStateEndpoint),
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
        deviceKitModelUrl: absoluteMiddlewareUrl(`${basePath}/grid/api/devicekit-model`),
        chromeIdentifier: c.chrome?.identifier ?? null,
        webRtcCodec: c.streamSettings?.transport === 'webrtc' ? c.streamSettings.codec : 'h264',
        ...(c.streamSettings?.transport === 'webrtc' && c.streamSettings.iceServers
          ? { webRtcIceServers: c.streamSettings.iceServers }
          : {}),
      };
    };

    // Ask the grid to attach a helper for this device at most once per effect
    // run (i.e. per device). Resets whenever `targetDevice`/`baseUrl` change.
    let startRequested = false;

    const resolve = async () => {
      if (cancelled) return;
      try {
        const res = await fetch(apiUrl, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) {
          if (!cancelled) pollTimer = setTimeout(resolve, RECONNECT_MS);
          return;
        }
        const c = (await res.json()) as PreviewApi | null;
        if (c && c.url && c.device) {
          if (!cancelled) {
            const resolved = toMiddleware(c);
            setWebRtcCodec(resolved.webRtcCodec);
            setConfig(resolved);
          }
          return;
        }
        // Middleware reachable but no helper for this device yet. Ask the grid to
        // start one (once): a booted sim just gets a stream daemon; a shut-down
        // sim is booted. The middleware never does this on its own — only here,
        // because the user selected this device. Then poll until it attaches.
        if (targetDevice && !startRequested) {
          startRequested = true;
          void startIosHelper(targetDevice, baseUrl).catch(() => {});
        }
        if (!cancelled) pollTimer = setTimeout(resolve, RECONNECT_MS);
      } catch {
        if (!cancelled) pollTimer = setTimeout(resolve, RECONNECT_MS);
      }
    };
    void resolve();

    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [active, baseUrl, targetDevice, setWebRtcCodec]);

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

  // ── WebRTC with serve-sim's codec and HTTP fallback policy. ──
  const {
    stream: webRtcStream,
    failure: webRtcFailure,
    error: webRtcError,
    markFrameDecoded: markWebRtcFrameDecoded,
    streamStats,
    setStreamStatsEnabled,
  } = useWebRtcStream({
    offerUrl: config ? `${config.url}/webrtc/offer` : '',
    closeUrl: config ? `${config.url}/webrtc/close` : '',
    statsUrl: config ? `${config.url}/webrtc/stats` : '',
    enabled: active && useWebRtc && !!config && !modelActive,
    codec: activeWebRtcCodec,
    iceServers: config?.webRtcIceServers,
  });
  const handledWebRtcFailureRef = useRef<string | null>(null);
  // The flat stream and the Duo's panel feeds share one codec ladder and HTTP fallback.
  const applyWebRtcFailure = useCallback(
    (failure: WebRtcStreamFailure) => {
      if (handledWebRtcFailureRef.current === failure.sessionId) return;
      handledWebRtcFailureRef.current = failure.sessionId;
      const decision = webRtcFallbackDecision(webRtcCodec, activeWebRtcCodec, failure);
      if (!decision) return;
      if (decision.type === 'switch-to-http') setWebRtcHttpFallback(true);
      else setActiveWebRtcCodec(decision.codec);
    },
    [webRtcCodec, activeWebRtcCodec],
  );

  useEffect(() => {
    if (useWebRtc && webRtcFailure) applyWebRtcFailure(webRtcFailure);
  }, [useWebRtc, webRtcFailure, applyWebRtcFailure]);

  useEffect(() => {
    if (!useWebRtc || modelActive) return;
    if (webRtcError) {
      setStatus('error');
      setError(webRtcError);
    } else if (!webRtcStream) {
      setStatus('connecting');
      setError(null);
    }
  }, [useWebRtc, modelActive, webRtcError, webRtcStream]);

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
      if (video.videoWidth > 0 && video.videoHeight > 0 && !hasWsConfigRef.current) {
        setScreen({ width: video.videoWidth, height: video.videoHeight });
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
    setWebRtcHttpFallback(false);
    setFps(0);
  }, [streamMode, config?.url, config?.webRtcCodec]);

  useEffect(() => {
    if (!useAvcc || !config?.url || modelActive) return;
    const timer = setTimeout(() => dispatchAvccFallback('timeout'), AVCC_FRAME_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [useAvcc, config?.url, modelActive]);

  useAvccStream({
    url: config?.url ?? '',
    enabled: active && useAvcc && !!config && !modelActive,
    canvasRef,
    onFirstFrame: () => {
      setStatus('streaming');
      setError(null);
    },
    onFrame: onAvccFrame,
    onDecodedFrame: () => dispatchAvccFallback('decoded-frame'),
    onResize: (width, height) => {
      if (!hasWsConfigRef.current) setScreen({ width, height });
    },
    onError: (message) => {
      setStatus('error');
      setError(message);
    },
    onDecoderError: () => dispatchAvccFallback('error'),
  });

  // ── MJPEG video (<img>) ──
  const streamUrl = useAvcc || useWebRtc || modelActive ? null : (config?.streamUrl ?? null);
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
          prev && prev.width === el.naturalWidth && prev.height === el.naturalHeight
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
      // The helper's pushed config outlives a transport switch.
      if (!hasWsConfigRef.current) setScreen(null);
      setFps(0);
    };
  }, [streamUrl, applyStreamSrc]);

  // ── Helper control WebSocket (touch/buttons out, screen config in) ──
  const wsUrl = config?.wsUrl ?? null;
  useEffect(() => {
    setHardwareKeyboardConnectedState(null);
    // A new helper, or none, owns the screen config from here. The media
    // paths fill the size back in until its first push arrives, so a previous
    // simulator's hinge state never classifies the next one.
    hasWsConfigRef.current = false;
    setScreen(null);
    if (!wsUrl) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (cancelled) return;
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl);
      } catch {
        return;
      }
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;
      ws.onopen = () => {
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
        if (bytes.length < 1) return;
        if (bytes[0] === WS_TAG_HINGE_REPLY) {
          try {
            const reply = JSON.parse(decoder.decode(bytes.subarray(1))) as AcknowledgedControlReply;
            if (reply && typeof reply.requestId === 'number' && typeof reply.ok === 'boolean') {
              hingeQueueRef.current?.receive(reply);
            }
          } catch {}
          return;
        }
        if (bytes[0] !== WS_TAG_SCREEN_CONFIG) return;
        try {
          const c = JSON.parse(decoder.decode(bytes.subarray(1))) as ScreenSize;
          if (c.width > 0 && c.height > 0) {
            hasWsConfigRef.current = true;
            // A rotation clears the native named pose. Observe the received
            // config even when its values equal the previous React state.
            if (c.hingePose === null && !hingePendingRef.current) setOrientationOverride(false);
            setScreen((prev) => (screenConfigsEqual(prev, c) ? prev : c));
          }
        } catch {}
      };
      ws.onclose = () => {
        if (cancelled) return;
        wsRef.current = null;
        setPhysicalPose(undefined);
        sentHingePoseRef.current = undefined;
        setOrientationOverride(false);
        if (hingePendingRef.current) {
          hingeQueueRef.current?.clear();
          restorePresetView();
          setHingePreview(null);
          setHingeError('Connection lost while changing the device pose.');
        }
        presetRestoreRef.current = null;
        retryTimer = setTimeout(connect, RECONNECT_MS);
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
      try {
        wsRef.current?.close();
      } catch {}
      wsRef.current = null;
      // Queued input was for this device; don't replay it on the next one.
      pendingWsRef.current = [];
      hingeQueueRef.current?.clear();
      setHardwareKeyboardConnectedState(null);
    };
  }, [wsUrl, sendWs]);

  // ── iPhone Duo: pose bookkeeping and the 3D model's panel feeds ──
  useEffect(() => {
    setHingePending(false);
    setHingeError(null);
    setHingePreview(null);
    setPhysicalPose(undefined);
    setDuoView(null);
    setHingeCommands(INITIAL_DUO_HINGE_COMMANDS);
    faceDownFramingRef.current = { saved: null, held: false };
    presetRestoreRef.current = null;
    sentHingePoseRef.current = undefined;
    setOrientationOverride(false);
    hingeQueueRef.current?.clear();
  }, [config?.url]);

  useEffect(() => {
    // Use native orientation once when connecting, never as a live view control.
    if (!duoView && screen?.screenId !== undefined) {
      setDuoView((previous) => previous ?? initialDuoView);
    }
  }, [duoView, screen?.screenId, initialDuoView]);

  useEffect(() => {
    if (!hingePreview || hingePending || !screen) return;
    // Configs from earlier commands can arrive while the latest request is
    // queued. Hold the requested pose until both its acknowledgement and its
    // matching config arrive, so rapid preset changes never animate backwards.
    if (
      (hingePreview.hingeAngle === undefined || hingePreview.hingeAngle === screen.hingeAngle) &&
      (hingePreview.hingePose === undefined || hingePreview.hingePose === screen.hingePose) &&
      (hingePreview.tableMode === undefined || hingePreview.tableMode === screen.tableMode)
    ) {
      presetRestoreRef.current = null;
      setHingePreview(null);
    }
  }, [hingePreview, hingePending, screen]);

  useEffect(() => {
    // Also learn poses applied outside this browser. An older queued reply
    // must not replace the orientation chosen by the latest local request.
    // Rotate clears the known native physical pose. Ignore an older
    // preset acknowledgement until native reports that its pose was cleared.
    if (orientationOverride || hingePreview || hingePending) return;
    if (screen?.hingePose) {
      setPhysicalPose(screen.hingePose);
      sentHingePoseRef.current = screen.hingePose;
    } else if (duoPhysicalPoseChanged(physicalPose, screen?.physicalOrientation)) {
      // Another client turned the device over without a preset. Frame it as
      // on connect; face-down framing below still turns it to the cover.
      setPhysicalPose(null);
      sentHingePoseRef.current = null;
      setDuoView(null);
    }
  }, [
    orientationOverride,
    hingePreview,
    hingePending,
    screen?.hingePose,
    screen?.physicalOrientation,
    physicalPose,
  ]);

  useEffect(() => {
    // Another client can turn a half-open device face down without a preset.
    // Frame the elected cover as Tent does, and restore the previous view when
    // the device turns back. Local hinge and rotation controls own the view.
    if (hingePreview || hingePending || screen?.hingePose === 'tent') return;
    const faceDown = screen?.tableMode === true && screen.physicalOrientation === 'facedown';
    const { state, view } = duoFaceDownFraming(
      faceDownFramingRef.current,
      faceDown,
      duoView ?? initialDuoView,
    );
    faceDownFramingRef.current = state;
    if (view) setDuoView(view);
  }, [
    hingePreview,
    hingePending,
    screen?.hingePose,
    screen?.tableMode,
    screen?.physicalOrientation,
    duoView,
    initialDuoView,
  ]);

  const onPanelAvccError = useCallback(() => dispatchAvccFallback('error'), []);
  const panels = useMemo<DuoPanelFeeds | null>(() => {
    if (!modelActive || !config) return null;
    return {
      url: config.url,
      mode: useWebRtc ? 'webrtc' : useAvcc ? 'avcc' : 'mjpeg',
      codec: activeWebRtcCodec,
      iceServers: config.webRtcIceServers,
      onFrame: onAvccFrame,
      onStreamingChange: setPanelStreaming,
      onStreamError: setPanelError,
      onAvccError: onPanelAvccError,
      onWebRtcFailure: applyWebRtcFailure,
    };
  }, [
    modelActive,
    config,
    useWebRtc,
    useAvcc,
    activeWebRtcCodec,
    onAvccFrame,
    onPanelAvccError,
    applyWebRtcFailure,
  ]);
  // While the model is shown, the presented panel's health is the connection status.
  useEffect(() => {
    if (!modelActive) {
      setPanelStreaming(false);
      setPanelError(null);
      return;
    }
    if (panelError) {
      setStatus('error');
      setError(panelError);
    } else {
      setStatus(panelStreaming ? 'streaming' : 'connecting');
      setError(null);
    }
  }, [modelActive, panelError, panelStreaming]);
  useEffect(() => {
    if (!modelActive) return;
    return () => {
      setStatus('connecting');
      setError(null);
      setFps(0);
    };
  }, [modelActive]);

  const hinge = useMemo<DeviceHinge | null>(() => {
    if (!isDuo) return null;
    const electedPose = physicalPose === undefined ? previewHingePose : physicalPose;
    return {
      angle: previewHingeAngle,
      pose: previewHingePose,
      physicalPose,
      tableMode: hingePreview?.tableMode ?? screen?.tableMode,
      tableModeAvailable: screen?.tableModeAvailable,
      faceDown: previewFaceDown,
      activeScreenId: duoIntendedScreen(
        previewHingeAngle,
        electedPose,
        screen?.screenId,
        previewFaceDown,
      ),
      pending: hingePending,
      error: hingeError,
      commands: hingeCommands,
      view: duoView ?? initialDuoView,
      modelActive,
      modelUrl: config?.deviceKitModelUrl ?? null,
      panels,
      setControl: setHingeControl,
      sendModelTouch,
      sendModelMultiTouch,
      sendModelScroll,
    };
  }, [
    isDuo,
    physicalPose,
    previewHingePose,
    previewHingeAngle,
    hingePreview?.tableMode,
    screen?.tableMode,
    screen?.tableModeAvailable,
    screen?.screenId,
    previewFaceDown,
    hingePending,
    hingeError,
    hingeCommands,
    duoView,
    initialDuoView,
    modelActive,
    config?.deviceKitModelUrl,
    panels,
    setHingeControl,
    sendModelTouch,
    sendModelMultiTouch,
    sendModelScroll,
  ]);

  // ── Long-lived middleware SSE routes multiplexed over one authenticated
  //    exec-ws, matching serve-sim's browser client. Keeping logs, events, and
  //    metrics off separate HTTP streams avoids the per-origin connection cap. ──
  const execWsUrl = config?.execWsUrl ?? null;
  const execToken = config?.execToken ?? null;
  const logsPath = config?.logsPath ?? null;
  const eventsPath = config?.eventsPath ?? null;
  const metricsPath = config?.metricsPath ?? null;
  const deviceUdid = config?.device ?? null;
  const axUrl = config?.axUrl ?? null;

  const accessibilityLoader = useMemo<AccessibilityLoader | null>(
    () => (axUrl ? (signal) => loadIosAccessibility(axUrl, signal) : null),
    [axUrl],
  );
  const accessibilityState = useAccessibility(accessibilityLoader);

  // One-shot typed host actions (`location.*`, `app.*`) over the exec channel.
  const runAction = useMemo(
    () =>
      execWsUrl && execToken
        ? (action: string, params?: Parameters<typeof runHostAction>[3]) =>
            runHostAction(execWsUrl, execToken, action, params)
        : null,
    [execWsUrl, execToken],
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
        setActivity((current) => (current ? { ...current, stale: true } : current));
      }
    }, 1000);
    return () => clearInterval(watchdog);
  }, [metricsPath]);

  useEffect(() => {
    if (!execWsUrl || !execToken) return;
    const subscriptions = new Map<number, 'logs' | 'events' | 'metrics'>();
    const paths = new Map<number, string>();
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
      if (metricsPath) {
        setActivity((current) => (current ? { ...current, errored: true } : current));
      }
    };

    const emit = (kind: 'logs' | 'events' | 'metrics', block: ParsedSseBlock) => {
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
        ws = new WebSocket(execWsUrl);
      } catch {
        markInterrupted();
        retryTimer = setTimeout(connect, RECONNECT_MS);
        return;
      }
      ws.onopen = () => ws?.send(JSON.stringify({ token: execToken }));
      ws.onmessage = (event) => {
        let msg: { ready?: boolean; sub?: number; data?: string; end?: boolean };
        try {
          msg = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (msg.ready) {
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
          markInterrupted();
          retryTimer = setTimeout(connect, RECONNECT_MS);
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
    logsPath,
    eventsPath,
    metricsPath,
    deviceUdid,
  ]);

  // ── Simulator settings (best-effort) — one status request hydrates every
  //    device-options control, including the appearance used by the toolbar. ──
  useEffect(() => {
    deviceSettingWriteTrackerRef.current.reset();
    setDeviceSettingsPending(new Set());
    if (!execWsUrl || !execToken || !deviceUdid) {
      setAppearanceState(null);
      setDeviceSettings(null);
      return;
    }
    let cancelled = false;
    hostUiRequest(execWsUrl, execToken, { device: deviceUdid })
      .then((res) => {
        if (cancelled) return;
        const next: DeviceSettings = {};
        for (const [key, value] of Object.entries(res.status ?? {})) {
          if (typeof value === 'string') next[key as DeviceSettingKey] = value;
        }
        setDeviceSettings(next);
        if (next.appearance === 'light' || next.appearance === 'dark') {
          setAppearanceState(next.appearance);
        }
        // The helper socket's open handler usually settles this first (it
        // disconnects the hardware keyboard); only fill in an unknown.
        const keyboardValue = res.status?.[UI_OPTION_HARDWARE_KEYBOARD];
        if (keyboardValue === 'on' || keyboardValue === 'off') {
          setHardwareKeyboardConnectedState((prev) => prev ?? keyboardValue === 'on');
        }
      })
      .catch(() => {
        /* unreachable / unsupported — leave unknown */
      });
    return () => {
      cancelled = true;
    };
  }, [execWsUrl, execToken, deviceUdid]);

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
  //    changes. Cached per udid:bundleId, so revisits apply instantly. ──
  const foregroundAppId = foregroundApp?.id ?? null;
  useEffect(() => {
    if (!foregroundAppId || !runAction || !deviceUdid) return;
    let cancelled = false;
    getIosAppDetails(runAction, deviceUdid, foregroundAppId)
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
  }, [foregroundAppId, runAction, deviceUdid]);

  // ── Running simulators (middleware /grid/api) ──
  const gridApiUrl = config?.gridApiUrl ?? null;
  useEffect(() => {
    if (!gridApiUrl) {
      setDevices(PLACEHOLDER_DEVICES);
      return;
    }
    let cancelled = false;
    fetch(gridApiUrl, { signal: AbortSignal.timeout(3000) })
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
  }, [gridApiUrl]);

  return {
    platform: 'ios',
    status,
    error,
    screen,
    hinge,
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
    deviceSettingsPending,
    setDeviceSetting,
    displayWidthDp: null,
    camera: null,
    cameraPending: NO_PENDING_CAMERA_WRITES,
    cameraError: null,
    setCameraImage: () => {},
    clearCameraImage: () => {},
    ...accessibilityState,
    location,
    locationPending,
    locationError,
    setLocation,
    clearLocation,
    ...appPermissions,
    streamCapabilities: IOS_STREAM_CAPABILITIES,
    screenRecording: null,
    streamSettings,
    streamSettingsPending,
    updateStreamSettings,
    streamSource: null,
    streamSourcePending: false,
    streamSourceError: null,
    setStreamSource: () => {},
    setGrpcImageMode: () => {},
    setGrpcEncoder: () => {},
    setGrpcInputSource: () => {},
    streamStats,
    setStreamStatsEnabled,
    webRtcCodec,
    setWebRtcCodec,
    capabilities: {
      deviceSettings: !!execWsUrl && !!execToken && !!deviceUdid,
      activity: !!metricsPath,
      events: !!eventsPath,
      camera: false,
      accessibility: accessibilityLoader !== null,
      streamSettings: streamSettingsUrl
        ? {
            mjpegFps: true,
            mjpegQuality: true,
            maxDimension: true,
            h264Bitrate: true,
            h264Fps: true,
          }
        : false,
      location: locationCapabilities,
      permissions: false,
    },
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
