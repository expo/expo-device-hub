/**
 * serve-emu (Android) implementation of the {@link DeviceClient} interface.
 *
 * Wire protocol (see serve-emu `src/middleware.ts` / `src/input.ts`):
 *   - Video + input share one WebSocket at `<base>/ws?frame-meta=1`. serve-emu is
 *     multi-device: a `&device=<serial>` query selects which device to stream
 *     (omitted → first available). `/api/logcat` takes the same `?device=`.
 *   - Binary inbound messages are H.264 access units, each prefixed with a
 *     16-byte "SEMU" header (keyframe flag + PTS); decoded with WebCodecs into a
 *     `<canvas>`.
 *   - Outbound input is JSON on the same socket: `{type:'touch',action,x,y}`,
 *     `{type:'home'|'back'|'recents'|'power'}`, `{type:'reset-video'}`.
 *   - Screen size comes from the decoded frames; logcat is an SSE feed at
 *     `<base>/api/logcat`; the device fleet comes from `<base>/api/devices`
 *     (device-agnostic — never carries `?device=`).
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { buildCodecString, isWebCodecsSupported, parseFramePacket, scanAU } from './h264';
import { MsePlayer } from './mse-player';
import {
  type ConnectionStatus,
  type DeviceAppearance,
  type DeviceClient,
  type DeviceConnectionOptions,
  type DeviceLog,
  type HardwareButton,
  type RunningDevice,
  type ScreenSize,
  type TouchSample,
} from './types';

const MAX_LOGS = 200;
const SOFT_DECODE_QUEUE_SIZE = 4;
const KEYFRAME_REQUEST_COOLDOWN_MS = 1500;

const KEYCODE_R = 46

const PLACEHOLDER_DEVICES: RunningDevice[] = [
  { id: 'android', name: 'Emulator Android', platform: 'android', current: true },
];

const BUTTON_MESSAGE: Record<HardwareButton, Record<string, unknown> | null> = {
  home: { type: 'home' },
  back: { type: 'back' },
  recents: { type: 'recents' },
  appSwitcher: { type: 'recents' },
  power: { type: 'power' },
};

const TOUCH_ACTION = { begin: 'down', move: 'move', end: 'up' } as const;

/**
 * Join an API path onto the base URL, **preserving any path prefix** the base
 * carries. `baseUrl` is the `expo-serve-emu` plugin mount
 * (`…/_expo/plugins/serve-emu`), so `new URL('/ws', baseUrl)` would drop
 * that prefix and miss the plugin; a plain string join keeps it (and still works
 * for a bare `http://localhost:3300` standalone serve-emu).
 */
function apiUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

function wsUrlFor(baseUrl: string, device: string | null): string {
  const u = new URL(apiUrl(baseUrl, '/ws'));
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.searchParams.set('frame-meta', '1');
  // serve-emu routes the stream to this device; omitted → first available.
  if (device) u.searchParams.set('device', device);
  return u.toString();
}

export function useAndroidDeviceClient(options: DeviceConnectionOptions): DeviceClient {
  const { baseUrl, enabled = true, device: targetDevice = null } = options;
  const active = enabled && !!baseUrl;

  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [screen, setScreen] = useState<ScreenSize | null>(null);
  const [fps, setFps] = useState(0);
  const [logs, setLogs] = useState<DeviceLog[]>([]);
  // Logs are opt-in: nothing streams until the user attaches.
  const [logsEnabled, setLogsEnabled] = useState(false);
  const [devices, setDevices] = useState<RunningDevice[]>(PLACEHOLDER_DEVICES);
  // The device's system dark/light setting. null until `/api/uimode` reports it.
  const [appearance, setAppearanceState] = useState<DeviceAppearance | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Monotonic log id source, persisted across logcat reconnects so ids stay
  // unique even though lines are kept (the stream effect may re-run).
  const logSeqRef = useRef(0);

  const attachVideo = useCallback((el: HTMLCanvasElement | HTMLImageElement | null) => {
    canvasRef.current = (el as HTMLCanvasElement) ?? null;
  }, []);

  const attachLogs = useCallback(() => setLogsEnabled(true), []);
  const detachLogs = useCallback(() => setLogsEnabled(false), []);
  const clearLogs = useCallback(() => setLogs([]), []);

  const send = useCallback((message: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ ack: false, ...message }));
  }, []);

  const sendTouch = useCallback(
    (sample: TouchSample) => {
      send({ type: 'touch', action: TOUCH_ACTION[sample.phase], x: sample.x, y: sample.y, pointerId: 0 });
    },
    [send],
  );

  const pressButton = useCallback(
    (button: HardwareButton) => {
      const message = BUTTON_MESSAGE[button];
      if (message) send(message);
    },
    [send],
  );

  // Reload the RN/Expo bundle by injecting a hardware "R" keypress, which React
  // Native listens for as its reload shortcut; serve-emu turns this into an
  // INJECT_KEYCODE on the scrcpy control socket. Not recorded
  // into the session; harmless if the foreground app isn't RN.
  const reload = useCallback(() => {
    send({ type: 'key', keycode: KEYCODE_R, record: false });
  }, [send]);

  // serve-emu captures the frame buffer server-side (`adb exec-out screencap
  // -p`) and returns the PNG bytes; `?device=` selects the serial (omitted →
  // first available, matching the stream).
  const screenshot = useCallback(async (): Promise<Blob | null> => {
    if (!baseUrl) return null;
    const url = `${apiUrl(baseUrl, '/api/screenshot')}${
      targetDevice ? `?device=${encodeURIComponent(targetDevice)}` : ''
    }`;
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) return null;
      return await res.blob();
    } catch {
      return null;
    }
  }, [baseUrl, targetDevice]);

  // Toggle the emulator's system dark theme via `/api/uimode` (POST
  // `adb shell cmd uimode night yes|no` — Hub only ever sets the binary modes,
  // never `auto`). Optimistic: reflect the choice immediately, fire-and-forget.
  const setAppearance = useCallback(
    (mode: DeviceAppearance) => {
      if (!baseUrl) return;
      setAppearanceState(mode);
      const url = `${apiUrl(baseUrl, '/api/uimode')}${
        targetDevice ? `?device=${encodeURIComponent(targetDevice)}` : ''
      }`;
      void fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ night: mode === 'dark' ? 'yes' : 'no' }),
      }).catch(() => {});
    },
    [baseUrl, targetDevice],
  );

  // ── Video + input WebSocket (with reconnect) ──
  useEffect(() => {
    if (!active || !baseUrl) {
      setStatus('idle');
      return;
    }
    // WebCodecs (`VideoDecoder`) is a secure-context-only API, so it's absent
    // over a plain-HTTP LAN origin (`http://192.168.x.x:8081`). Fall back to
    // Media Source Extensions — not secure-context gated — which decodes the same
    // H.264 through a <video> element blitted onto the canvas (see MsePlayer).
    const useMse = !isWebCodecsSupported();
    if (useMse && !MsePlayer.isSupported()) {
      setStatus('error');
      setError('This browser cannot decode H.264 (WebCodecs unavailable).');
      return;
    }

    setStatus('connecting');
    setError(null);

    let cancelled = false;
    let msePlayer: MsePlayer | null = null;
    // Effect-local "first frame painted" flag. Drives the → streaming transition
    // without reading the `status` state from this closure: on a device switch
    // the effect re-runs while `status` is still the previous device's
    // 'streaming', so a `status !== 'streaming'` guard would never fire again and
    // the new device would stay stuck on "Connecting…".
    let painted = false;
    let reconnectDelay = 500;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let decoder: VideoDecoder | null = null;
    let sawKeyframe = false;
    let droppingUntilKeyframe = false;
    let lastKeyframeRequestAt = 0;
    let frameIdx = 0;
    let fpsCount = 0;
    let fpsTimer = performance.now();

    const closeDecoder = () => {
      if (decoder && decoder.state !== 'closed') {
        try {
          decoder.close();
        } catch {}
      }
      decoder = null;
    };

    const requestKeyframe = () => {
      const ws = wsRef.current;
      const now = performance.now();
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (now - lastKeyframeRequestAt < KEYFRAME_REQUEST_COOLDOWN_MS) return;
      lastKeyframeRequestAt = now;
      ws.send(JSON.stringify({ type: 'reset-video', ack: false }));
    };

    const paint = (frame: VideoFrame) => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d', { alpha: false, desynchronized: true });
      if (!canvas || !ctx) {
        frame.close();
        return;
      }
      if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
        canvas.width = frame.displayWidth;
        canvas.height = frame.displayHeight;
        setScreen({ width: frame.displayWidth, height: frame.displayHeight });
      }
      ctx.drawImage(frame, 0, 0);
      frame.close();

      if (!cancelled && !painted) {
        painted = true;
        setStatus('streaming');
        setError(null);
      }
      fpsCount++;
      const now = performance.now();
      if (now - fpsTimer >= 1000) {
        const next = Math.round((fpsCount * 1000) / (now - fpsTimer));
        fpsCount = 0;
        fpsTimer = now;
        setFps((prev) => (prev === next ? prev : next));
      }
    };

    const ensureDecoder = (spsBytes: Uint8Array): boolean => {
      if (decoder?.state === 'configured') return true;
      closeDecoder();
      const created = new VideoDecoder({
        output: (frame) => {
          if (cancelled || decoder !== created) {
            frame.close();
            return;
          }
          paint(frame);
        },
        error: () => {
          if (decoder === created) {
            closeDecoder();
            sawKeyframe = false;
            droppingUntilKeyframe = true;
            requestKeyframe();
          }
        },
      });
      try {
        created.configure({ codec: buildCodecString(spsBytes), optimizeForLatency: true });
        decoder = created;
        return true;
      } catch {
        try {
          created.close();
        } catch {}
        requestKeyframe();
        return false;
      }
    };

    const feedFrame = (raw: ArrayBuffer) => {
      const packet = parseFramePacket(raw);

      if (useMse) {
        const isKey = packet.isKey ?? scanAU(packet.data).isKey;
        if (!msePlayer) {
          const canvas = canvasRef.current;
          if (!canvas) {
            requestKeyframe();
            return;
          }
          msePlayer = new MsePlayer(canvas, {
            onFirstFrame: () => {
              if (!cancelled && !painted) {
                painted = true;
                setStatus('streaming');
                setError(null);
              }
            },
            onResize: (width, height) => {
              if (!cancelled) setScreen({ width, height });
            },
            onFps: (next) => {
              if (!cancelled) setFps((prev) => (prev === next ? prev : next));
            },
            onError: (message) => {
              if (!cancelled) {
                setStatus('error');
                setError(message);
              }
            },
            requestKeyframe,
          });
        }
        msePlayer.feed(packet.data, isKey, packet.timestamp);
        return;
      }

      const needsScan =
        packet.isKey === null ||
        (packet.isKey && (!decoder || decoder.state !== 'configured' || droppingUntilKeyframe));
      const scanned = needsScan ? scanAU(packet.data) : null;
      const isKey = packet.isKey ?? scanned?.isKey ?? false;
      const spsBytes = scanned?.spsBytes ?? null;
      if (spsBytes && !ensureDecoder(spsBytes)) return;

      if (droppingUntilKeyframe) {
        if (!isKey) return;
        if (!decoder || decoder.state !== 'configured') {
          requestKeyframe();
          return;
        }
        droppingUntilKeyframe = false;
      }

      if (!decoder || decoder.state !== 'configured') {
        if (!isKey) requestKeyframe();
        return;
      }

      if (decoder.decodeQueueSize > SOFT_DECODE_QUEUE_SIZE) {
        closeDecoder();
        sawKeyframe = false;
        droppingUntilKeyframe = true;
        requestKeyframe();
        return;
      }

      if (!sawKeyframe) {
        if (!isKey) {
          requestKeyframe();
          return;
        }
        sawKeyframe = true;
      }

      try {
        decoder.decode(
          new EncodedVideoChunk({
            type: isKey ? 'key' : 'delta',
            timestamp: packet.timestamp ?? Math.round((frameIdx * 1_000_000) / 60),
            data: packet.data,
          }),
        );
        frameIdx++;
      } catch {
        closeDecoder();
        sawKeyframe = false;
        droppingUntilKeyframe = true;
        requestKeyframe();
      }
    };

    const connect = () => {
      if (cancelled) return;
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrlFor(baseUrl, targetDevice));
      } catch (err) {
        setStatus('error');
        setError(err instanceof Error ? err.message : 'Invalid server URL');
        return;
      }
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelled) return;
        reconnectDelay = 500;
        // Status stays as-is: a socket opening proves nothing user-visible yet
        // (the server accepts even while the emulator is still booting). Only the
        // first painted frame flips to 'streaming'.
        // MSE playback must begin on a keyframe; nudge the server to emit one now.
        if (useMse) requestKeyframe();
      };
      ws.onerror = () => {
        // A failed socket always fires onclose next — status is decided there.
      };
      ws.onclose = () => {
        if (cancelled) return;
        closeDecoder();
        msePlayer?.destroy();
        msePlayer = null;
        sawKeyframe = false;
        frameIdx = 0;
        // A drop before the first frame is normal while the emulator is still
        // booting/attaching — keep "Connecting…" and retry quietly (matching
        // iOS). Only a stream that was actually live reports a disconnect.
        if (painted) {
          painted = false;
          setStatus('error');
          setError((prev) => prev ?? 'Disconnected — retrying…');
        }
        retryTimer = setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(Math.round(reconnectDelay * 1.6), 5000);
      };
      ws.onmessage = (event) => {
        if (cancelled || typeof event.data === 'string') return;
        feedFrame(event.data as ArrayBuffer);
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      closeDecoder();
      msePlayer?.destroy();
      msePlayer = null;
      try {
        wsRef.current?.close();
      } catch {}
      wsRef.current = null;
      setStatus('idle');
      setScreen(null);
      setFps(0);
    };
    // Reconnect only when the target device or server changes — not on every
    // status/fps/screen state update this effect writes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, baseUrl, targetDevice]);

  // ── Logcat (SSE, best-effort) — off by default; opt-in via attach ──
  useEffect(() => {
    if (!logsEnabled || !active || !baseUrl) return;
    let source: EventSource | null = null;
    try {
      source = new EventSource(
        apiUrl(baseUrl, `/api/logcat${targetDevice ? `?device=${encodeURIComponent(targetDevice)}` : ''}`),
      );
    } catch {
      return;
    }
    source.addEventListener('log', (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as { line: string };
        setLogs((prev) =>
          [...prev, { id: `a${++logSeqRef.current}`, source: 'logcat', message: data.line }].slice(-MAX_LOGS),
        );
      } catch {}
    });
    return () => source?.close();
  }, [logsEnabled, active, baseUrl, targetDevice]);

  // ── Running devices (best-effort) ──
  useEffect(() => {
    if (!active || !baseUrl) {
      setDevices(PLACEHOLDER_DEVICES);
      return;
    }
    let cancelled = false;
    // `/api/devices` is serve-emu's fleet listing — it must stay device-agnostic
    // (no `?device=`). The streamed device is the selected serial, or serve-emu's
    // first-available default when none is selected.
    fetch(apiUrl(baseUrl, '/api/devices'))
      .then((r) => r.json())
      .then((data: { devices?: Array<Record<string, unknown>>; defaultSerial?: string }) => {
        if (cancelled || !Array.isArray(data.devices) || data.devices.length === 0) return;
        const streamed = targetDevice ?? data.defaultSerial ?? null;
        setDevices(
          data.devices.map((d) => {
            const id = String(d.serial ?? d.id ?? 'android');
            return {
              id,
              name: String(d.model ?? d.name ?? d.product ?? id),
              platform: 'android' as const,
              current: id === streamed,
            };
          }),
        );
      })
      .catch(() => {
        /* cross-origin or offline — keep the placeholder */
      });
    return () => {
      cancelled = true;
    };
  }, [active, baseUrl, targetDevice]);

  // ── Current appearance (best-effort) — reflect the device's dark/light mode ──
  useEffect(() => {
    if (!active || !baseUrl) {
      setAppearanceState(null);
      return;
    }
    let cancelled = false;
    const url = `${apiUrl(baseUrl, '/api/uimode')}${
      targetDevice ? `?device=${encodeURIComponent(targetDevice)}` : ''
    }`;
    fetch(url, { cache: 'no-store' })
      .then((r) => r.json())
      .then((data: { ok?: boolean; night?: string }) => {
        // `night` is yes|no|auto; map anything but an explicit `yes` to light so
        // the binary toggle has a definite position.
        if (cancelled || !data.ok) return;
        setAppearanceState(data.night === 'yes' ? 'dark' : 'light');
      })
      .catch(() => {
        /* offline / unsupported — leave unknown */
      });
    return () => {
      cancelled = true;
    };
  }, [active, baseUrl, targetDevice]);

  return {
    platform: 'android',
    status,
    error,
    screen,
    fps,
    devices,
    logs,
    logsEnabled,
    attachLogs,
    detachLogs,
    clearLogs,
    videoKind: 'canvas',
    attachVideo,
    sendTouch,
    pressButton,
    reload,
    screenshot,
    appearance,
    setAppearance,
  };
}
