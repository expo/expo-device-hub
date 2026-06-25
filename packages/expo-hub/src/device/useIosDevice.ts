/**
 * serve-sim (iOS) implementation of the {@link DeviceClient} interface.
 *
 * Wire protocol (see serve-sim `serve-sim-client` + the Swift helper):
 *   - Video: MJPEG at `<base>/stream.mjpeg`, painted by an `<img>` (works
 *     cross-origin, unlike the `fetch`-based AVCC path).
 *   - Input + screen config: a binary WebSocket at `<base>/ws`. Outbound frames
 *     are `[tag][JSON]`: `0x03` touch `{type,x,y}`, `0x04` button `{button}`.
 *     Inbound `0x82` carries the screen {@link ScreenSize}/orientation.
 *   - Logs: best-effort SSE at `<base>/logs` (only when pointed at a serve-sim
 *     dev-server middleware, not the bare helper). Devices: `<base>/grid/api`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  type ConnectionStatus,
  type DeviceClient,
  type DeviceConnectionOptions,
  type DeviceLog,
  type HardwareButton,
  type RunningDevice,
  type ScreenSize,
  type TouchSample,
} from './types';

const MAX_LOGS = 200;
const RECONNECT_MS = 1500;

// serve-sim binary WS message tags (serve-sim-client `SimulatorView`).
const WS_MSG_TOUCH = 0x03;
const WS_MSG_BUTTON = 0x04;
const WS_TAG_SCREEN_CONFIG = 0x82;

// A drag that *starts* in the bottom home-indicator band is tagged with this
// edge so iOS routes it to the interactive swipe-to-home / app-switcher
// recognizer (without it, a bottom-up drag is just a content scroll). Mirrors
// serve-sim's HID_EDGE_BOTTOM + HOME_INDICATOR_BAND_NORM (bottom 7%).
const HID_EDGE_BOTTOM = 3;
const HOME_INDICATOR_BAND_NORM = 0.93;

const PLACEHOLDER_DEVICES: RunningDevice[] = [
  { id: 'ios', name: 'iPhone Simulator', platform: 'ios', current: true },
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

function taggedJson(tag: number, payload: unknown): Uint8Array {
  const json = encoder.encode(JSON.stringify(payload));
  const out = new Uint8Array(1 + json.length);
  out[0] = tag;
  out.set(json, 1);
  return out;
}

function wsUrlFor(baseUrl: string): string {
  const u = new URL('/ws', baseUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.toString();
}

export function useIosDeviceClient(options: DeviceConnectionOptions): DeviceClient {
  const { baseUrl, enabled = true } = options;
  const active = enabled && !!baseUrl;

  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [screen, setScreen] = useState<ScreenSize | null>(null);
  const [logs, setLogs] = useState<DeviceLog[]>([]);
  const [devices, setDevices] = useState<RunningDevice[]>(PLACEHOLDER_DEVICES);

  const wsRef = useRef<WebSocket | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const streamUrlRef = useRef<string | null>(null);
  // True while the in-flight drag began in the home-indicator band.
  const edgeGestureRef = useRef(false);

  // Point the <img> at the MJPEG stream (with a cache-buster so reconnects
  // restart the multipart response rather than reusing the dead one).
  const applyStreamSrc = useCallback(() => {
    const img = imgRef.current;
    const url = streamUrlRef.current;
    if (!img || !url) return;
    img.src = `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`;
  }, []);

  const attachVideo = useCallback(
    (el: HTMLCanvasElement | HTMLImageElement | null) => {
      imgRef.current = (el as HTMLImageElement) ?? null;
      // Point the freshly-mounted <img> at the stream right away — the connection
      // effect runs before this element exists (status flips idle→connecting to
      // mount it), so the effect's own applyStreamSrc() would no-op otherwise.
      if (el) applyStreamSrc();
    },
    [applyStreamSrc],
  );

  const sendTouch = useCallback((sample: TouchSample) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    // Tag the whole gesture with edge=BOTTOM when it began in the home-indicator
    // band, so the swipe-up-from-bottom home/app-switcher gesture is recognized.
    let edge: number | undefined;
    if (sample.phase === 'begin') {
      edgeGestureRef.current = sample.y >= HOME_INDICATOR_BAND_NORM;
      if (edgeGestureRef.current) edge = HID_EDGE_BOTTOM;
    } else if (edgeGestureRef.current) {
      edge = HID_EDGE_BOTTOM;
      if (sample.phase === 'end') edgeGestureRef.current = false;
    }

    const payload =
      edge === undefined
        ? { type: sample.phase, x: sample.x, y: sample.y }
        : { type: sample.phase, x: sample.x, y: sample.y, edge };
    ws.send(taggedJson(WS_MSG_TOUCH, payload));
  }, []);

  const pressButton = useCallback((button: HardwareButton) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const name = BUTTON_NAME[button];
    if (name) ws.send(taggedJson(WS_MSG_BUTTON, { button: name }));
  }, []);

  // ── MJPEG video (<img>) ──
  useEffect(() => {
    if (!active || !baseUrl) {
      streamUrlRef.current = null;
      setStatus('idle');
      return;
    }
    streamUrlRef.current = new URL('/stream.mjpeg', baseUrl).toString();
    setStatus('connecting');
    setError(null);

    let cancelled = false;
    let settled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const img = imgRef.current;

    // A multipart MJPEG `<img>` only fires `load` once (and can fire it before
    // this effect attaches the listener), so confirm streaming by polling the
    // decoded frame's natural size too.
    const markStreaming = () => {
      if (cancelled || settled) return;
      const el = imgRef.current;
      if (!el || el.naturalWidth === 0 || el.naturalHeight === 0) return;
      settled = true;
      setStatus('streaming');
      setError(null);
      setScreen((prev) =>
        prev && prev.width === el.naturalWidth && prev.height === el.naturalHeight
          ? prev
          : { width: el.naturalWidth, height: el.naturalHeight },
      );
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
      setStatus('idle');
      setScreen(null);
    };
  }, [active, baseUrl, applyStreamSrc]);

  // ── Control WebSocket (touch/buttons out, screen config in) ──
  useEffect(() => {
    if (!active || !baseUrl) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (cancelled) return;
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrlFor(baseUrl));
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
          const config = JSON.parse(new TextDecoder().decode(bytes.subarray(1))) as ScreenSize;
          if (config.width > 0 && config.height > 0) {
            setScreen((prev) =>
              prev && prev.width === config.width && prev.height === config.height ? prev : config,
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
  }, [active, baseUrl]);

  // ── syslog (SSE, best-effort; only when pointed at a dev-server middleware) ──
  useEffect(() => {
    if (!active || !baseUrl) {
      setLogs([]);
      return;
    }
    let source: EventSource | null = null;
    let nextId = 1;
    try {
      source = new EventSource(new URL('/logs', baseUrl).toString());
    } catch {
      return;
    }
    source.onmessage = (event) => {
      let message = event.data;
      try {
        const parsed = JSON.parse(event.data) as { eventMessage?: string };
        if (typeof parsed.eventMessage === 'string') message = parsed.eventMessage;
      } catch {}
      if (!message) return;
      setLogs((prev) => [...prev, { id: `i${nextId++}`, source: 'syslog', message }].slice(-MAX_LOGS));
    };
    source.onerror = () => {
      /* helper has no /logs route, or cross-origin — drop quietly */
    };
    return () => source?.close();
  }, [active, baseUrl]);

  // ── Running simulators (best-effort) ──
  useEffect(() => {
    if (!active || !baseUrl) {
      setDevices(PLACEHOLDER_DEVICES);
      return;
    }
    let cancelled = false;
    fetch(new URL('/grid/api', baseUrl).toString())
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
        /* bare helper / cross-origin — keep the placeholder */
      });
    return () => {
      cancelled = true;
    };
  }, [active, baseUrl]);

  return {
    platform: 'ios',
    status,
    error,
    screen,
    fps: 0,
    devices,
    logs,
    videoKind: 'img',
    attachVideo,
    sendTouch,
    pressButton,
  };
}
