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
 *      multi-touch out; `0x82` screen config in). Coordinates are mapped to the
 *      device's raw frame per orientation (see `./orientation`).
 *   3. Logs: streamed over the middleware's **exec-ws** WebSocket exactly like
 *      the serve-sim client — `{token}` → `{sub, path: logsEndpoint}` → `{sub,
 *      data}` (raw SSE) — rather than a direct route on the helper (the helper
 *      has none).
 *   4. Devices: `GET <base>/grid/api`.
 *
 * `baseUrl` is always the mounted serve-sim middleware. Connection failures
 * keep retrying middleware discovery; they must not be reinterpreted as a bare
 * helper because doing so drops the middleware/helper path from stream URLs.
 */

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import { AVCC_FRAME_TIMEOUT_MS, avccFallbackReducer, initialAvccFallback } from './avcc-fallback';
import { isAvccSupported } from './avcc';
import {
  HID_EDGE_BOTTOM,
  homeIndicatorEdge,
  rawEdgeForDisplayEdge,
  rawPointForDisplayPoint,
  streamGeometry,
} from './orientation';
import { startIosHelper } from './connections';
import { type ExecResult, getIosAppDetails } from './ios-app-details';
import { hidUsageForCode } from './keyboard';
import {
  type ConnectionStatus,
  type DeviceAppearance,
  type DeviceClient,
  type DeviceConnectionOptions,
  type DeviceLog,
  type DeviceOrientation,
  type DeviceWebRtcCodec,
  type ForegroundApp,
  type HardwareButton,
  type KeyboardInput,
  type MultiTouchSample,
  type RunningDevice,
  type ScreenSize,
  type TouchSample,
} from './types';
import { proxyPreviewConfigForBrowser } from './proxy-preview-config';
import { useAvccStream } from './useAvccStream';
import { type WebRtcIceServer, useWebRtcStream } from './useWebRtcStream';
import {
  type WebRtcCodec,
  webRtcFallbackDecision,
} from './webrtc-fallback';

const MAX_LOGS = 200;
const RECONNECT_MS = 1500;

// serve-sim binary WS message tags (serve-sim-client `SimulatorView`).
const WS_MSG_TOUCH = 0x03;
const WS_MSG_BUTTON = 0x04;
const WS_MSG_MULTI_TOUCH = 0x05;
const WS_MSG_KEY = 0x06;
const WS_MSG_ORIENTATION = 0x07;
const WS_MSG_SOFTWARE_KEYBOARD = 0x0c;
const WS_MSG_HARDWARE_KEYBOARD = 0x0d;
const WS_TAG_SCREEN_CONFIG = 0x82;
const WS_TAG_HARDWARE_KEYBOARD = 0x83;

// HID keyboard usage codes (USB HID Usage Page 0x07) for the R reload chord.
const HID_USAGE_R = 0x15; // 'r'

const PLACEHOLDER_DEVICES: RunningDevice[] = [
  { id: 'ios', name: 'iPhone Simulator', platform: 'ios', current: true },
];

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
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Returns an `ArrayBuffer`-backed view (not the default `Uint8Array<ArrayBufferLike>`)
// so it satisfies `WebSocket.send`'s `BufferSource` under strict lib.dom typings.
function taggedJson(tag: number, payload: unknown): Uint8Array<ArrayBuffer> {
  const json = encoder.encode(JSON.stringify(payload));
  const out = new Uint8Array(1 + json.length);
  out[0] = tag;
  out.set(json, 1);
  return out;
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

/** Response shape of a serve-sim UI (`simulator-settings`) request over exec-ws. */
interface UiRequestResult {
  /** Present on a read (no `option`): every UI option's current value. */
  status?: Record<string, string>;
  /** Present on a write. */
  ok?: boolean;
}

/**
 * Run a single serve-sim **simulator-settings** request over a one-shot
 * middleware exec-ws connection and resolve its reply. The protocol mirrors the
 * serve-sim client: connect → `{token}` → wait for `{ready}` → `{id, ui}` →
 * `{id, ...result}`. A read omits `option` and returns `{status}`; a write sends
 * `{device, option, value}` and returns `{ok}`. Used for the appearance get/set
 * (logs use their own long-lived exec-ws below).
 */
function execWsUiRequest(
  execWsUrl: string,
  execToken: string,
  ui: Record<string, unknown>,
): Promise<UiRequestResult> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(execWsUrl);
    } catch (err) {
      reject(err);
      return;
    }
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (run: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      run();
    };
    timer = setTimeout(() => finish(() => reject(new Error('exec-ws timeout'))), 5000);
    ws.onopen = () => ws.send(JSON.stringify({ token: execToken }));
    ws.onmessage = (event) => {
      let msg: { ready?: boolean; id?: number; error?: string } & UiRequestResult;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (msg.ready) {
        ws.send(JSON.stringify({ id: 1, ui }));
        return;
      }
      if (msg.id === 1) {
        if (msg.error) finish(() => reject(new Error(msg.error)));
        else finish(() => resolve(msg));
      }
    };
    ws.onerror = () => finish(() => reject(new Error('exec-ws error')));
    ws.onclose = () => finish(() => reject(new Error('exec-ws closed')));
  });
}

/**
 * Run a single host shell command over a one-shot middleware exec-ws
 * connection: connect → `{token}` → wait for `{ready}` → `{id, command}` →
 * `{id, stdout, stderr, exitCode}`. Same channel as {@link execWsUiRequest},
 * different request shape. Used to introspect the foreground app's bundle
 * (Info.plist, icon) — see `ios-app-details.ts`.
 */
function execWsCommand(
  execWsUrl: string,
  execToken: string,
  command: string,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(execWsUrl);
    } catch (err) {
      reject(err);
      return;
    }
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (run: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      run();
    };
    timer = setTimeout(() => finish(() => reject(new Error('exec-ws timeout'))), 10_000);
    ws.onopen = () => ws.send(JSON.stringify({ token: execToken }));
    ws.onmessage = (event) => {
      let msg: { ready?: boolean; id?: number; error?: string } & Partial<ExecResult>;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (msg.ready) {
        ws.send(JSON.stringify({ id: 1, command }));
        return;
      }
      if (msg.id === 1) {
        if (msg.error) finish(() => reject(new Error(msg.error)));
        else
          finish(() =>
            resolve({ stdout: msg.stdout ?? '', stderr: msg.stderr ?? '', exitCode: msg.exitCode ?? 1 }),
          );
      }
    };
    ws.onerror = () => finish(() => reject(new Error('exec-ws error')));
    ws.onclose = () => finish(() => reject(new Error('exec-ws closed')));
  });
}

/** Resolved connection: where to stream video/input, and how to reach logs/devices. */
interface ResolvedConfig {
  /** Base serve-sim helper URL used by `/stream.avcc`. */
  url: string;
  streamUrl: string;
  wsUrl: string;
  device: string | null;
  /** Middleware exec-ws URL used as the logs transport. */
  execWsUrl: string | null;
  execToken: string | null;
  /** Relative SSE path to subscribe for logs, e.g. `/logs?device=<udid>`. */
  logsPath: string | null;
  /** Absolute URL of the foreground-app SSE stream. */
  appStateUrl: string | null;
  gridApiUrl: string | null;
  webRtcCodec: WebRtcCodec;
  iceServers?: WebRtcIceServer[];
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
  gridApiEndpoint?: string;
  proxyHelpers?: boolean;
  streamSettings?: {
    transport?: unknown;
    codec?: unknown;
    iceServers?: unknown;
  };
}

type BrowserLocation = Pick<Location, 'host' | 'protocol'>;

function previewIceServers(value: unknown): WebRtcIceServer[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) return undefined;
  const servers: WebRtcIceServer[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return undefined;
    const { urls, username, credential } = entry as {
      urls?: unknown;
      username?: unknown;
      credential?: unknown;
    };
    if (
      !Array.isArray(urls) ||
      urls.length === 0 ||
      urls.length > 16 ||
      !urls.every(
        (url) =>
          typeof url === 'string' &&
          url.length <= 2_048 &&
          /^(stun|stuns|turn|turns):/i.test(url),
      ) ||
      (username !== undefined && typeof username !== 'string') ||
      (credential !== undefined && typeof credential !== 'string')
    ) {
      return undefined;
    }
    servers.push({
      urls,
      ...(typeof username === 'string' ? { username } : {}),
      ...(typeof credential === 'string' ? { credential } : {}),
    });
  }
  return servers;
}

function previewWebRtcSettings(settings: PreviewApi['streamSettings']): {
  webRtcCodec: WebRtcCodec;
  iceServers?: WebRtcIceServer[];
} {
  if (settings?.transport !== 'webrtc') return { webRtcCodec: 'h264' };
  const webRtcCodec =
    settings.codec === 'vp8' || settings.codec === 'vp9' || settings.codec === 'h264'
      ? settings.codec
      : 'h264';
  const iceServers = previewIceServers(settings.iceServers);
  return { webRtcCodec, ...(iceServers ? { iceServers } : {}) };
}

/** Convert serve-sim's middleware response into the URLs consumed by the iOS client. */
export function resolveIosPreviewConfig(
  rawConfig: PreviewApi,
  browserLocation: BrowserLocation,
  baseUrl: string,
): ResolvedConfig {
  const c = proxyPreviewConfigForBrowser(rawConfig, browserLocation);
  const basePath = c.basePath ?? '';
  const webRtcSettings = previewWebRtcSettings(c.streamSettings);
  return {
    url: c.url!,
    streamUrl: c.streamUrl ?? `${c.url}/stream.mjpeg`,
    wsUrl: toQueryStyleHelperWsUrl(c.wsUrl ?? `${toWs(c.url!)}/ws`),
    device: c.device ?? null,
    execWsUrl: toWs(new URL(`${basePath}/exec-ws`, baseUrl).toString()),
    execToken: c.execToken ?? null,
    logsPath: c.logsEndpoint ?? null,
    appStateUrl: c.appStateEndpoint ? new URL(c.appStateEndpoint, baseUrl).toString() : null,
    gridApiUrl: new URL(c.gridApiEndpoint ?? '/grid/api', baseUrl).toString(),
    ...webRtcSettings,
  };
}

export function useIosDeviceClient(options: DeviceConnectionOptions): DeviceClient {
  const { baseUrl, enabled = true, device: targetDevice = null, streamMode } = options;
  const active = enabled && !!baseUrl;

  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [screen, setScreen] = useState<ScreenSize | null>(null);
  const [fps, setFps] = useState(0);
  const [logs, setLogs] = useState<DeviceLog[]>([]);
  // Logs are opt-in: nothing streams until the user attaches.
  const [logsEnabled, setLogsEnabled] = useState(false);
  const [devices, setDevices] = useState<RunningDevice[]>(PLACEHOLDER_DEVICES);
  const [config, setConfig] = useState<ResolvedConfig | null>(null);
  // The simulator's system dark/light setting. null until read.
  const [appearance, setAppearanceState] = useState<DeviceAppearance | null>(null);
  // Browser HID injection remains active when this is false. Disabling the
  // Simulator-owned host connection lets iOS keep its software keyboard open.
  const [hardwareKeyboardConnected, setHardwareKeyboardConnectedState] = useState<boolean | null>(
    null,
  );
  // The frontmost app, pushed by the middleware's /appstate SSE. null until the
  // first event.
  const [foregroundApp, setForegroundApp] = useState<ForegroundApp | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  // Monotonic log id source, persisted across log-stream reconnects so ids stay
  // unique even though lines are kept (the stream effect may re-run).
  const logSeqRef = useRef(0);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamUrlRef = useRef<string | null>(null);
  const [avccFallback, dispatchAvccFallback] = useReducer(avccFallbackReducer, initialAvccFallback);
  const [requestedWebRtcCodec, setRequestedWebRtcCodec] = useState<WebRtcCodec>('h264');
  const [webRtcCodec, setWebRtcCodec] = useState<WebRtcCodec>('h264');
  const [webRtcHttpFallback, setWebRtcHttpFallback] = useState(false);
  const handledWebRtcFailureRef = useRef<string | null>(null);
  const useWebRtc = streamMode === 'webrtc' && !webRtcHttpFallback;
  const wantsAvcc = streamMode === 'h264' || webRtcHttpFallback;
  const useAvcc = wantsAvcc && isAvccSupported() && !avccFallback.fellBack;
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

  const sendTouch = useCallback((sample: TouchSample) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const orientation = streamGeometry(screenRef.current).inputOrientation;

    let displayEdge: number | undefined;
    if (sample.phase === 'begin') {
      edgeGestureRef.current = homeIndicatorEdge(sample.y) !== undefined;
      if (edgeGestureRef.current) displayEdge = HID_EDGE_BOTTOM;
    } else if (edgeGestureRef.current) {
      displayEdge = HID_EDGE_BOTTOM;
      if (sample.phase === 'end') edgeGestureRef.current = false;
    }

    const p = rawPointForDisplayPoint(orientation, sample.x, sample.y);
    const edge = displayEdge === undefined ? undefined : rawEdgeForDisplayEdge(orientation, displayEdge);
    const payload =
      edge === undefined ? { type: sample.phase, ...p } : { type: sample.phase, ...p, edge };
    ws.send(taggedJson(WS_MSG_TOUCH, payload));
  }, []);

  const sendMultiTouch = useCallback((sample: MultiTouchSample) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const orientation = streamGeometry(screenRef.current).inputOrientation;
    const a = rawPointForDisplayPoint(orientation, sample.a.x, sample.a.y);
    const b = rawPointForDisplayPoint(orientation, sample.b.x, sample.b.y);
    ws.send(taggedJson(WS_MSG_MULTI_TOUCH, { type: sample.phase, x1: a.x, y1: a.y, x2: b.x, y2: b.y }));
  }, []);

  const sendKey = useCallback((input: KeyboardInput): boolean => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    const usage = hidUsageForCode(input.code);
    if (usage === null) return false;
    ws.send(taggedJson(WS_MSG_KEY, { type: input.phase, usage }));
    return true;
  }, []);

  const setHardwareKeyboardConnected = useCallback((connected: boolean) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(taggedJson(WS_MSG_HARDWARE_KEYBOARD, { enabled: connected }));
  }, []);

  const toggleSoftwareKeyboard = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(taggedJson(WS_MSG_SOFTWARE_KEYBOARD, {}));
  }, []);

  const pressButton = useCallback((button: HardwareButton) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const name = BUTTON_NAME[button];
    if (name) ws.send(taggedJson(WS_MSG_BUTTON, { button: name }));
  }, []);

  // Reload the RN/Expo bundle by injecting ⌘R over the helper's key channel
  // (tag 0x06 → HID keystroke) — RN registers ⌘R as its reload shortcut. Mirrors
  // the serve-sim web client's sequence exactly: ⌘ down, R down, R up, ⌘ up, with
  // a sequential 30ms await between each event (so the gaps can't compress under
  // timer jitter). Harmless if the foreground app isn't RN.
  const reload = useCallback(async () => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const key = (type: 'down' | 'up', usage: number) =>
      ws.send(taggedJson(WS_MSG_KEY, { type, usage }));
    key('down', HID_USAGE_R);
    await new Promise((r) => setTimeout(r, 30));
    key('up', HID_USAGE_R);
  }, []);

  // Rotate one step counterclockwise from the last known orientation, over the
  // helper's orientation channel (tag 0x07 → HID orientation event). The helper
  // confirms by pushing an updated screen config, which keeps the cycle in sync.
  const rotate = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const current = screenRef.current?.orientation ?? 'portrait';
    const next =
      ORIENTATION_CYCLE[(ORIENTATION_CYCLE.indexOf(current) + 1) % ORIENTATION_CYCLE.length];
    ws.send(taggedJson(WS_MSG_ORIENTATION, { orientation: next }));
  }, []);

  // serve-sim's middleware captures the sim via `simctl io <udid> screenshot`
  // and returns the PNG bytes. Use the resolved udid from `/api` (falling back
  // to the requested device); the middleware defaults to the booted sim if none.
  const screenshot = useCallback(async (): Promise<Blob | null> => {
    if (!baseUrl) return null;
    const udid = config?.device ?? targetDevice;
    const base = baseUrl.replace(/\/$/, '');
    const url = `${base}/api/screenshot${udid ? `?device=${encodeURIComponent(udid)}` : ''}`;
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) return null;
      return await res.blob();
    } catch {
      return null;
    }
  }, [baseUrl, targetDevice, config]);

  // Set the simulator appearance via `simctl ui <udid> appearance <mode>`,
  // issued over the middleware exec-ws (the same UI-request channel the serve-sim
  // client uses). Needs a resolved middleware config + udid — a no-op otherwise
  // until middleware discovery resolves. Optimistic: reflect the choice
  // immediately.
  const setAppearance = useCallback(
    (mode: DeviceAppearance) => {
      const c = config;
      if (!c || !c.execWsUrl || !c.execToken || !c.device) return;
      setAppearanceState(mode);
      void execWsUiRequest(c.execWsUrl, c.execToken, {
        device: c.device,
        option: 'appearance',
        value: mode,
      }).catch(() => {});
    },
    [config],
  );

  const attachLogs = useCallback(() => setLogsEnabled(true), []);
  const detachLogs = useCallback(() => setLogsEnabled(false), []);
  const clearLogs = useCallback(() => setLogs([]), []);

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
    setStatus('connecting');
    setError(null);

    // `baseUrl` may carry a path prefix (the plugin mount), so join onto it
    // rather than `new URL('/api', baseUrl)`, which would drop that prefix.
    const apiUrl = `${baseUrl.replace(/\/$/, '')}/api${
      targetDevice ? `?device=${encodeURIComponent(targetDevice)}` : ''
    }`;

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
            const resolved = resolveIosPreviewConfig(c, window.location, baseUrl);
            setRequestedWebRtcCodec(resolved.webRtcCodec);
            setWebRtcCodec(resolved.webRtcCodec);
            setWebRtcHttpFallback(false);
            handledWebRtcFailureRef.current = null;
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
  }, [active, baseUrl, targetDevice]);

  const fpsCounterRef = useRef({ frames: 0, startedAt: 0 });
  const onAvccFrame = useCallback(() => {
    const now = performance.now();
    const counter = fpsCounterRef.current;
    if (counter.startedAt === 0) counter.startedAt = now;
    counter.frames++;
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
  } = useWebRtcStream({
    offerUrl: config ? `${config.url}/webrtc/offer` : '',
    closeUrl: config ? `${config.url}/webrtc/close` : '',
    enabled: active && useWebRtc && !!config,
    codec: webRtcCodec,
    iceServers: config?.iceServers,
  });

  const selectWebRtcCodec = useCallback((codec: DeviceWebRtcCodec) => {
    handledWebRtcFailureRef.current = null;
    setRequestedWebRtcCodec(codec);
    setWebRtcCodec(codec);
    setWebRtcHttpFallback(false);
  }, []);

  useEffect(() => {
    if (!useWebRtc || !webRtcFailure) return;
    if (handledWebRtcFailureRef.current === webRtcFailure.sessionId) return;
    handledWebRtcFailureRef.current = webRtcFailure.sessionId;
    const decision = webRtcFallbackDecision(requestedWebRtcCodec, webRtcCodec, webRtcFailure);
    if (!decision) return;
    if (decision.type === 'switch-to-http') setWebRtcHttpFallback(true);
    else setWebRtcCodec(decision.codec);
  }, [useWebRtc, webRtcFailure, requestedWebRtcCodec, webRtcCodec]);

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

    const markFrame = () => {
      if (stopped) return;
      if (video.videoWidth > 0 && video.videoHeight > 0 && !hasWsConfigRef.current) {
        setScreen({ width: video.videoWidth, height: video.videoHeight });
      }
      onAvccFrame();
      if (firstFrame) {
        firstFrame = false;
        markWebRtcFrameDecoded();
        setStatus('streaming');
        setError(null);
      }
    };
    const onVideoFrame = () => {
      markFrame();
      frameCallback = video.requestVideoFrameCallback(onVideoFrame);
    };
    const onTimeUpdate = () => markFrame();

    video.srcObject = webRtcStream;
    if (webRtcStream) {
      const supportsVideoFrameCallback = typeof video.requestVideoFrameCallback === 'function';
      if (supportsVideoFrameCallback) frameCallback = video.requestVideoFrameCallback(onVideoFrame);
      else video.addEventListener('timeupdate', onTimeUpdate);
      video.addEventListener('loadeddata', markFrame, { once: true });
      void video.play().catch(() => {});
    }

    return () => {
      stopped = true;
      video.removeEventListener('loadeddata', markFrame);
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
    handledWebRtcFailureRef.current = null;
    setWebRtcCodec(requestedWebRtcCodec);
    setWebRtcHttpFallback(false);
    fpsCounterRef.current = { frames: 0, startedAt: 0 };
    setFps(0);
  }, [streamMode, config?.url, requestedWebRtcCodec]);

  useEffect(() => {
    if (!useAvcc || !config?.url) return;
    const timer = setTimeout(() => dispatchAvccFallback('timeout'), AVCC_FRAME_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [useAvcc, config?.url]);

  useAvccStream({
    url: config?.url ?? '',
    enabled: active && useAvcc && !!config,
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
  useEffect(() => {
    setHardwareKeyboardConnectedState(null);
    if (!wsUrl) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    hasWsConfigRef.current = false;

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
      // The Hub owns keyboard forwarding while this socket is active. Keep the
      // Simulator's separate host-keyboard connection off by default so iOS can
      // show the software keyboard while browser HID keys continue to type.
      ws.onopen = () => {
        ws.send(taggedJson(WS_MSG_HARDWARE_KEYBOARD, { enabled: false }));
      };
      ws.onmessage = (event) => {
        if (!(event.data instanceof ArrayBuffer)) return;
        const bytes = new Uint8Array(event.data);
        if (bytes.length < 1) return;
        if (bytes[0] === WS_TAG_HARDWARE_KEYBOARD) {
          try {
            const result = JSON.parse(decoder.decode(bytes.subarray(1))) as {
              enabled?: boolean;
              ok?: boolean;
            };
            if (!cancelled && result.ok && typeof result.enabled === 'boolean') {
              setHardwareKeyboardConnectedState(result.enabled);
            }
          } catch {}
          return;
        }
        if (bytes[0] !== WS_TAG_SCREEN_CONFIG) return;
        try {
          const c = JSON.parse(decoder.decode(bytes.subarray(1))) as ScreenSize;
          if (c.width > 0 && c.height > 0) {
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
      ws.onclose = () => {
        if (cancelled) return;
        wsRef.current = null;
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
      setHardwareKeyboardConnectedState(null);
    };
  }, [wsUrl]);

  // ── Logs over the middleware exec-ws (same transport as the serve-sim client) ──
  const execWsUrl = config?.execWsUrl ?? null;
  const execToken = config?.execToken ?? null;
  const logsPath = config?.logsPath ?? null;
  useEffect(() => {
    // Off by default — only subscribe once the user has attached.
    if (!logsEnabled || !execWsUrl || !execToken || !logsPath) return;
    let cancelled = false;
    let ws: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let sseBuffer = '';

    const emit = (block: string) => {
      const dataLines = block
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''));
      const raw = dataLines.join('\n');
      if (!raw) return;
      let message = raw;
      try {
        const parsed = JSON.parse(raw) as { eventMessage?: string };
        if (typeof parsed.eventMessage === 'string') message = parsed.eventMessage;
      } catch {}
      if (message) {
        setLogs((prev) =>
          [...prev, { id: `i${++logSeqRef.current}`, source: 'syslog', message }].slice(-MAX_LOGS),
        );
      }
    };

    const connect = () => {
      if (cancelled) return;
      sseBuffer = '';
      try {
        ws = new WebSocket(execWsUrl);
      } catch {
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
          ws?.send(JSON.stringify({ sub: 1, path: logsPath }));
          return;
        }
        if (msg.sub === 1 && typeof msg.data === 'string') {
          sseBuffer += msg.data.replace(/\r\n/g, '\n');
          let i: number;
          while ((i = sseBuffer.indexOf('\n\n')) !== -1) {
            emit(sseBuffer.slice(0, i));
            sseBuffer = sseBuffer.slice(i + 2);
          }
        }
      };
      ws.onclose = () => {
        if (!cancelled) retryTimer = setTimeout(connect, RECONNECT_MS);
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
  }, [logsEnabled, execWsUrl, execToken, logsPath]);

  // ── Current appearance (best-effort) — reads `simctl ui appearance` via a
  //    one-shot exec-ws UI request once the middleware config resolves. ──
  const deviceUdid = config?.device ?? null;
  useEffect(() => {
    if (!execWsUrl || !execToken || !deviceUdid) {
      setAppearanceState(null);
      return;
    }
    let cancelled = false;
    execWsUiRequest(execWsUrl, execToken, { device: deviceUdid })
      .then((res) => {
        const value = res.status?.appearance;
        if (!cancelled && (value === 'light' || value === 'dark')) setAppearanceState(value);
      })
      .catch(() => {
        /* unreachable / unsupported — leave unknown */
      });
    return () => {
      cancelled = true;
    };
  }, [execWsUrl, execToken, deviceUdid]);

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
    if (!foregroundAppId || !execWsUrl || !execToken || !deviceUdid) return;
    let cancelled = false;
    getIosAppDetails(
      (command) => execWsCommand(execWsUrl, execToken, command),
      deviceUdid,
      foregroundAppId,
    )
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
  }, [foregroundAppId, execWsUrl, execToken, deviceUdid]);

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
    fps,
    webRtcCodec: requestedWebRtcCodec,
    setWebRtcCodec: selectWebRtcCodec,
    devices,
    logs,
    logsEnabled,
    attachLogs,
    detachLogs,
    clearLogs,
    foregroundApp,
    videoKind: useWebRtc ? 'video' : useAvcc ? 'canvas' : 'img',
    attachVideo,
    sendTouch,
    sendMultiTouch,
    sendKey,
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
