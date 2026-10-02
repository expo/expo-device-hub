import { createControlSocket } from './control-socket.js';
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

import { AVCC_FRAME_TIMEOUT_MS, avccFallbackReducer, initialAvccFallback } from './avcc-fallback.js';
import {
  appendActivitySample,
  parseActivityHostCores,
  parseActivitySample,
} from './activity.js';
import { type AccessibilityLoader, loadIosAccessibility } from './accessibility.js';
import { isAvccSupported } from './avcc.js';
import {
  HID_EDGE_BOTTOM,
  homeIndicatorEdge,
  rawDeltaForDisplayDelta,
  rawEdgeForDisplayEdge,
  rawPointForDisplayPoint,
  streamGeometry,
} from './orientation.js';
import { startIosHelper } from './connections.js';
import {
  clearIosEventLogState,
  createIosEventLogState,
  mergeIosEventLogPayload,
} from './ios-events.js';
import { hostUiRequest, runHostAction } from './exec-ws.js';
import { getIosAppDetails } from './ios-app-details.js';
import {
  isAttachedPreviewApi,
  type PreviewApi,
  type ResolvedIosConnection,
  resolveIosConnection,
} from './ios-connection.js';
import { clearIosLocation, setIosLocation } from './ios-location.js';
import { fetchScreenshot } from './screenshot.js';
import { iosMessageForKeyboardInput } from './keyboard.js';
import {
  type ConnectionStatus,
  type DeviceActivity,
  type DeviceAppearance,
  type DeviceClient,
  type DeviceConnectionOptions,
  type DeviceLog,
  type DeviceSettingKey,
  type DeviceSettings,
  type DeviceStreamCapabilities,
  type DeviceStreamEncoderSettings,
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
} from './types.js';
import { NO_PENDING_CAMERA_WRITES } from './device-camera.js';
import { mergeAuthoritativeDeviceSetting } from './device-setting-writes.js';
import { KeyedWriteTracker } from './keyed-write-tracker.js';
import { listenForInputCancellation } from './input-cancellation.js';
import { createPacedKeySender } from './paced-key-sender.js';
import { sessionTokenFetch, sessionTokenProtocols, withSessionTokenQuery } from './session-token.js';
import { publicServeSimMount, publicUrlForRoute } from './serve-sim-urls.js';
import { type ParsedSseBlock, drainSseChunk } from './sse.js';
import { normalizeDeviceStreamSettings } from './stream-settings.js';
import { useAccessibility } from './useAccessibility.js';
import { useAppPermissions } from './useAppPermissions.js';
import { useAvccStream } from './useAvccStream.js';
import { type DeviceLocationBackend, useDeviceLocation } from './useDeviceLocation.js';
import { useStreamSettingsResource } from './useStreamSettingsResource.js';
import { useWebRtcStream } from './useWebRtcStream.js';
import { presentedVideoFrameDelta } from './video-frame-metadata.js';
import { IOS_INPUT_UNAVAILABLE_MESSAGE } from './ios-input-error.js';
import {
  type WebRtcCodec,
  webRtcFallbackDecision,
} from './webrtc-fallback.js';
import { createInputSocket } from './input-socket.js';
import { WS_MSG_CONFIG, WS_REASON_INPUT_UNAVAILABLE } from './input-protocol.js';

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

export function useIosDeviceClient(options: DeviceConnectionOptions): DeviceClient {
  const { baseUrl, enabled = true, device: targetDevice = null, streamMode, token = null } = options;
  const active = enabled && !!baseUrl;
  const sessionFetch = useMemo(() => sessionTokenFetch(token), [token]);
  const socketProtocols = useMemo(() => sessionTokenProtocols('ios', token), [token]);
  const connectionIdentity = useMemo(
    () => ({ active, baseUrl, targetDevice, token }),
    [active, baseUrl, targetDevice, token],
  );

  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  // A refusal stays visible until server admission confirms recovery.
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
  const [resolvedConnection, setResolvedConnection] = useState<{
    identity: typeof connectionIdentity;
    config: ResolvedIosConnection;
  } | null>(null);
  // A discovery result owns its endpoint and credential together. Hide the old
  // result during the render that changes identity, before child hooks can use
  // the new credential with URLs discovered for the previous session.
  const config =
    active && resolvedConnection?.identity === connectionIdentity
      ? resolvedConnection.config
      : null;
  const controlSocket = useMemo(() => config?.execWsUrl && config.execToken
    ? createControlSocket(config.execWsUrl, config.execToken, {
        openSocket: address => new WebSocket(address, socketProtocols),
      }) : null, [config, socketProtocols]);
  useEffect(() => { controlSocket?.activate(); return () => controlSocket?.dispose(); }, [controlSocket]);
  const requestHostUi = useCallback((url: string, execToken: string, payload: Parameters<typeof hostUiRequest>[2]) =>
    hostUiRequest(url, execToken, payload, socketProtocols, controlSocket ?? undefined), [controlSocket, socketProtocols]);
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

  const inputSocketRef = useRef<ReturnType<typeof createInputSocket> | null>(null);
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
    if (!config || config !== deviceSettingConfigRef.current) return;
    inputSocketRef.current?.send(tag, payload);
  }, [config]);

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
      const message = iosMessageForKeyboardInput(input);
      if (!message) return false;
      sendWs(WS_MSG_KEY, message);
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
  useEffect(() => {
    const cancel = () => {
      const releases = keySender.cancel();
      if (!config || config !== deviceSettingConfigRef.current) return;
      const socket = inputSocketRef.current;
      socket?.discardQueued(WS_MSG_KEY);
      for (const event of releases) socket?.trySend(WS_MSG_KEY, event);
    };
    const stopListening = listenForInputCancellation(cancel);
    return () => { stopListening(); keySender.dispose(); };
  }, [config, keySender]);
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
      void requestHostUi(c.execWsUrl, c.execToken, {
        device: c.device,
        option: UI_OPTION_HARDWARE_KEYBOARD,
        value: connected ? 'on' : 'off',
      }).catch(() => setHardwareKeyboardConnectedState(previous));
    },
    [config, hardwareKeyboardConnected, requestHostUi],
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
    return fetchScreenshot(publicServeSimMount(baseUrl).toString(), udid, sessionFetch);
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
      setDeviceSettingsPending(tracker.pending);
      setDeviceSettings((current) => ({ ...(current ?? {}), [key]: value }));
      if (key === 'appearance' && (value === 'light' || value === 'dark')) {
        setAppearanceState(value);
      }
      void requestHostUi(execWsUrl, execToken, {
        device,
        option: key,
        value,
      })
        .catch(async () => {
          if (!tracker.isCurrent(request) || deviceSettingConfigRef.current !== c) return;
          try {
            const result = await requestHostUi(execWsUrl, execToken, { device });
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
    [config, requestHostUi],
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
      setResolvedConnection(null);
      setStatus('idle');
      return;
    }
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    setStatus('connecting');
    setError(null);

    const mount = publicServeSimMount(baseUrl);
    const apiUrl = publicUrlForRoute(mount, 'api', { device: targetDevice });

    // Ask the grid to attach a helper for this device at most once per effect
    // run (i.e. per device). Resets whenever `targetDevice`/`baseUrl` change.
    let startRequested = false;

    const resolve = async () => {
      if (cancelled) return;
      try {
        const res = await sessionFetch(apiUrl, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) {
          if (!cancelled) pollTimer = setTimeout(resolve, RECONNECT_MS);
          return;
        }
        const c = (await res.json()) as PreviewApi | null;
        if (isAttachedPreviewApi(c)) {
          if (!cancelled) {
            const resolved = resolveIosConnection(c, mount);
            resolved.streamUrl = withSessionTokenQuery(resolved.streamUrl, token);
            if (resolved.appStateUrl) {
              resolved.appStateUrl = withSessionTokenQuery(resolved.appStateUrl, token);
            }
            setWebRtcCodec(resolved.webRtcCodec);
            setResolvedConnection({ identity: connectionIdentity, config: resolved });
          }
          return;
        }
        // Middleware reachable but no helper for this device yet. Ask the grid to
        // start one (once): a booted sim just gets a stream daemon; a shut-down
        // sim is booted. The middleware never does this on its own — only here,
        // because the user selected this device. Then poll until it attaches.
        if (targetDevice && !startRequested) {
          startRequested = true;
          void startIosHelper(targetDevice, baseUrl, sessionFetch).catch(() => {});
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
  }, [active, baseUrl, targetDevice, setWebRtcCodec, sessionFetch, token, connectionIdentity]);

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
    closeBeaconUrl: config ? withSessionTokenQuery(`${config.url}/webrtc/close`, token) : '',
    statsUrl: config ? `${config.url}/webrtc/stats` : '',
    enabled: active && useWebRtc && !!config,
    codec: activeWebRtcCodec,
    iceServers: config?.webRtcIceServers,
    fetchImpl: sessionFetch,
  });
  const handledWebRtcFailureRef = useRef<string | null>(null);

  useEffect(() => {
    if (!useWebRtc || !webRtcFailure) return;
    if (handledWebRtcFailureRef.current === webRtcFailure.sessionId) return;
    handledWebRtcFailureRef.current = webRtcFailure.sessionId;
    const decision = webRtcFallbackDecision(webRtcCodec, activeWebRtcCodec, webRtcFailure);
    if (!decision) return;
    if (decision.type === 'switch-to-http') setWebRtcHttpFallback(true);
    else setActiveWebRtcCodec(decision.codec);
  }, [useWebRtc, webRtcFailure, webRtcCodec, activeWebRtcCodec]);

  useEffect(() => {
    if (!useWebRtc) return;
    if (webRtcError) {
      setStatus('error');
      setError(webRtcError);
    } else if (!webRtcStream) {
      setStatus('connecting');
      setError(null);
    }
  }, [useWebRtc, webRtcError, webRtcStream]);

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
    if (!useAvcc || !config?.url) return;
    const timer = setTimeout(() => dispatchAvccFallback('timeout'), AVCC_FRAME_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [useAvcc, config?.url]);

  useAvccStream({
    url: config?.url ?? '',
    enabled: active && useAvcc && !!config,
    canvasRef,
    fetchImpl: sessionFetch,
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
      setScreen(null);
      setFps(0);
    };
  }, [streamUrl, applyStreamSrc]);

  // ── Helper control WebSocket (touch/buttons out, screen config in) ──
  const wsUrl = config?.wsUrl ?? null;
  const requireInputAdmission = config?.inputAdmission ?? false;
  useEffect(() => {
    setHardwareKeyboardConnectedState(null);
    setInputSocketError(null);
    setInputUnavailable(false);
    if (!wsUrl) return;
    hasWsConfigRef.current = false;
    let noticeTimer: ReturnType<typeof setTimeout> | undefined;
    const input = createInputSocket(wsUrl, {
      onAdmitted() {
        // The helper restores its host keyboard connection after the last owner leaves.
        input.send(WS_MSG_HARDWARE_KEYBOARD, { enabled: false });
        setHardwareKeyboardConnectedState(false);
      },
      onMessage(data) {
        if (!(data instanceof ArrayBuffer)) return false;
        const bytes = new Uint8Array(data);
        if (bytes[0] !== WS_MSG_CONFIG) return false;
        try {
          const c = JSON.parse(decoder.decode(bytes.subarray(1))) as ScreenSize & { inputUnavailable?: boolean };
          if (typeof c.width !== 'number' || typeof c.height !== 'number' || !Number.isFinite(c.width) || !Number.isFinite(c.height) || c.width <= 0 || c.height <= 0 || (c.inputUnavailable !== undefined && typeof c.inputUnavailable !== 'boolean')) return false;
          setInputUnavailable(c.inputUnavailable === true);
          hasWsConfigRef.current = true;
          setScreen(prev => prev?.width === c.width && prev.height === c.height && prev.orientation === c.orientation ? prev : c);
          return true;
        } catch { return false; }
      },
      onDisconnect() { setHardwareKeyboardConnectedState(null); },
      onRefused(reason) {
        clearTimeout(noticeTimer);
        setInputSocketError(reason);
        // Admission cannot undo commands already lost to a queue overflow.
        if (reason !== WS_REASON_INPUT_UNAVAILABLE) {
          noticeTimer = setTimeout(() => {
            setInputSocketError(current => current === reason ? null : current);
          }, 5_000);
        }
      },
      onRecovered() { setInputSocketError(null); },
    }, { requireAdmission: requireInputAdmission, reconnectDelayMs: RECONNECT_MS, openSocket: (address) => new WebSocket(address, socketProtocols) });
    inputSocketRef.current = input;
    input.start();
    return () => {
      clearTimeout(noticeTimer);
      input.dispose();
      if (inputSocketRef.current === input) inputSocketRef.current = null;
      setHardwareKeyboardConnectedState(null);
    };
  }, [wsUrl, requireInputAdmission, socketProtocols]);

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
    () => (axUrl ? (signal) => loadIosAccessibility(axUrl, signal, sessionFetch) : null),
    [axUrl, sessionFetch],
  );
  const accessibilityState = useAccessibility(accessibilityLoader);

  // One-shot typed host actions (`location.*`, `app.*`) over the exec channel.
  const runAction = useMemo(
    () =>
      execWsUrl && execToken
        ? (action: string, params?: Parameters<typeof runHostAction>[3]) =>
            runHostAction(execWsUrl, execToken, action, params, socketProtocols, controlSocket ?? undefined)
        : null,
    [execWsUrl, execToken, socketProtocols, controlSocket],
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

  const emitControlEvent = useCallback((kind: 'logs' | 'events' | 'metrics', block: ParsedSseBlock) => {
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
  }, [deviceUdid]);

  const subscribeControl = useCallback((kind: 'logs' | 'events' | 'metrics', path: string) => {
    if (!controlSocket) return;
    let buffer = '';
    return controlSocket.subscribe(path, chunk => {
      buffer = drainSseChunk(buffer, chunk, block => emitControlEvent(kind, block));
    }, () => {
      buffer = '';
      if (kind === 'metrics') setActivity(current => current ? {...current, errored: true} : current);
    });
  }, [controlSocket, emitControlEvent]);
  useEffect(() => {
    if (logsEnabled && logsPath) return subscribeControl('logs', logsPath);
  }, [logsEnabled, logsPath, subscribeControl]);
  useEffect(() => {
    if (eventsEnabled && eventsPath && deviceUdid) return subscribeControl('events', eventsPath);
  }, [eventsEnabled, eventsPath, deviceUdid, subscribeControl]);
  useEffect(() => {
    if (metricsPath) return subscribeControl('metrics', metricsPath);
  }, [metricsPath, subscribeControl]);

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
    requestHostUi(execWsUrl, execToken, { device: deviceUdid })
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
  }, [execWsUrl, execToken, deviceUdid, requestHostUi]);

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
    streamCapabilities: config ? iosStreamCapabilities(config.initialStreamSettings) : null,
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
