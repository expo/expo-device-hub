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
 * If `/api` isn't reachable (pointed straight at a bare helper), it falls back
 * to treating `baseUrl` as the helper: video + input only, no logs/devices.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  HID_EDGE_BOTTOM,
  homeIndicatorEdge,
  rawEdgeForDisplayEdge,
  rawPointForDisplayPoint,
  streamGeometry,
} from './orientation';
import { startIosHelper } from './connections';
import {
  type ConnectionStatus,
  type DeviceAppearance,
  type DeviceClient,
  type DeviceConnectionOptions,
  type DeviceLog,
  type DeviceOrientation,
  type HardwareButton,
  type MultiTouchSample,
  type RunningDevice,
  type ScreenSize,
  type TouchSample,
} from './types';

const MAX_LOGS = 200;
const RECONNECT_MS = 1500;

// serve-sim binary WS message tags (serve-sim-client `SimulatorView`).
const WS_MSG_TOUCH = 0x03;
const WS_MSG_BUTTON = 0x04;
const WS_MSG_MULTI_TOUCH = 0x05;
const WS_MSG_KEY = 0x06;
const WS_MSG_ORIENTATION = 0x07;
const WS_TAG_SCREEN_CONFIG = 0x82;

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

/** Resolved connection: where to stream video/input, and how to reach logs/devices. */
interface ResolvedConfig {
  mode: 'middleware' | 'helper';
  streamUrl: string;
  wsUrl: string;
  device: string | null;
  /** Middleware exec-ws URL (logs transport); null in bare-helper mode. */
  execWsUrl: string | null;
  execToken: string | null;
  /** Relative SSE path to subscribe for logs, e.g. `/logs?device=<udid>`. */
  logsPath: string | null;
  gridApiUrl: string | null;
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
  gridApiEndpoint?: string;
}

export function useIosDeviceClient(options: DeviceConnectionOptions): DeviceClient {
  const { baseUrl, enabled = true, device: targetDevice = null } = options;
  const active = enabled && !!baseUrl;

  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [screen, setScreen] = useState<ScreenSize | null>(null);
  const [logs, setLogs] = useState<DeviceLog[]>([]);
  // Logs are opt-in: nothing streams until the user attaches.
  const [logsEnabled, setLogsEnabled] = useState(false);
  const [devices, setDevices] = useState<RunningDevice[]>(PLACEHOLDER_DEVICES);
  const [config, setConfig] = useState<ResolvedConfig | null>(null);
  // The simulator's system dark/light setting. null until read (or in bare-helper
  // mode, where there's no middleware exec-ws to drive `simctl ui appearance`).
  const [appearance, setAppearanceState] = useState<DeviceAppearance | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  // Monotonic log id source, persisted across log-stream reconnects so ids stay
  // unique even though lines are kept (the stream effect may re-run).
  const logSeqRef = useRef(0);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const streamUrlRef = useRef<string | null>(null);
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
    (el: HTMLCanvasElement | HTMLImageElement | null) => {
      imgRef.current = (el as HTMLImageElement) ?? null;
      if (el) applyStreamSrc();
    },
    [applyStreamSrc],
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
  // (bare-helper mode). Optimistic: reflect the choice immediately.
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

  // ── Resolve the connection: discover the helper + log/device routes via /api,
  //    falling back to treating baseUrl as a bare helper. ──
  //
  // The Hub starts helpers explicitly (see `startIosHelper`) — it never boots a
  // sim just by connecting. So when the middleware is reachable but no helper is
  // attached yet (`/api` → null), we keep polling until the just-started helper
  // comes up, then resolve its streaming config. Only an unreachable/absent
  // route falls back to bare-helper mode.
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

    const helperFallback = (): ResolvedConfig => ({
      mode: 'helper',
      streamUrl: new URL('/stream.mjpeg', baseUrl).toString(),
      wsUrl: toWs(new URL('/ws', baseUrl).toString()),
      device: null,
      execWsUrl: null,
      execToken: null,
      logsPath: null,
      gridApiUrl: null,
    });

    const toMiddleware = (c: PreviewApi): ResolvedConfig => {
      const basePath = c.basePath ?? '';
      return {
        mode: 'middleware',
        streamUrl: c.streamUrl ?? `${c.url}/stream.mjpeg`,
        wsUrl: toQueryStyleHelperWsUrl(c.wsUrl ?? `${toWs(c.url!)}/ws`),
        device: c.device ?? null,
        execWsUrl: toWs(new URL(`${basePath}/exec-ws`, baseUrl).toString()),
        execToken: c.execToken ?? null,
        logsPath: c.logsEndpoint ?? null,
        gridApiUrl: new URL(c.gridApiEndpoint ?? '/grid/api', baseUrl).toString(),
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
          // No middleware at this origin — treat baseUrl as a bare helper.
          if (!cancelled) setConfig(helperFallback());
          return;
        }
        const c = (await res.json()) as PreviewApi | null;
        if (c && c.url && c.device) {
          if (!cancelled) setConfig(toMiddleware(c));
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
        // /api unreachable — fall back to bare-helper mode.
        if (!cancelled) setConfig(helperFallback());
      }
    };
    void resolve();

    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [active, baseUrl, targetDevice]);

  // ── MJPEG video (<img>) ──
  const streamUrl = config?.streamUrl ?? null;
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
    };
  }, [streamUrl, applyStreamSrc]);

  // ── Helper control WebSocket (touch/buttons out, screen config in) ──
  const wsUrl = config?.wsUrl ?? null;
  useEffect(() => {
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
      ws.onmessage = (event) => {
        if (!(event.data instanceof ArrayBuffer)) return;
        const bytes = new Uint8Array(event.data);
        if (bytes.length < 1 || bytes[0] !== WS_TAG_SCREEN_CONFIG) return;
        try {
          const c = JSON.parse(decoder.decode(bytes.subarray(1))) as ScreenSize;
          if (c.width > 0 && c.height > 0) {
            hasWsConfigRef.current = true;
            setScreen((prev) =>
              prev && prev.width === c.width && prev.height === c.height && prev.orientation === c.orientation
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
    fps: 0,
    devices,
    logs,
    logsEnabled,
    attachLogs,
    detachLogs,
    clearLogs,
    videoKind: 'img',
    attachVideo,
    sendTouch,
    sendMultiTouch,
    pressButton,
    reload,
    rotate,
    screenshot,
    appearance,
    setAppearance,
  };
}
