/**
 * serve-emu (Android) implementation of the {@link DeviceClient} interface.
 *
 * Wire protocol (see serve-emu `src/middleware.ts` / `src/input.ts`):
 *   - H.264 video + input share one WebSocket at `<base>/ws?frame-meta=1`.
 *     With WebRTC video, input stays on `<base>/ws?video=0`; signaling uses
 *     `<base>/webrtc/{offer,close}`. serve-emu is multi-device: `?device=<serial>`
 *     selects the target (omitted → first available).
 *   - Binary inbound messages are H.264 access units, each prefixed with a
 *     16-byte "SEMU" header (keyframe flag + PTS); decoded with WebCodecs into a
 *     `<canvas>`.
 *   - Outbound input is JSON on the same socket: `{type:'touch',action,x,y}`,
 *     `{type:'home'|'back'|'recents'|'power'}`, `{type:'reset-video'}`.
 *   - Screen size comes from the decoded frames; logcat is an SSE feed at
 *     `<base>/api/logcat`; the device fleet comes from `<base>/api/devices`
 *     (device-agnostic — never carries `?device=`).
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import {
  type AndroidSessionEvent,
  clearAndroidEventCursor,
  createAndroidEventCursor,
  mergeAndroidEventSnapshotCursor,
  reconcileAndroidSessionEvents,
} from './android-events';
import {
  type AndroidDeviceSettingKey,
  androidDeviceSettingPath,
  androidDeviceSettingRequest,
  parseAndroidDeviceSetting,
} from './android-device-settings';
import {
  androidStreamSettingsPatch,
  parseAndroidStreamSettings,
} from './android-stream-settings';
import { parseAndroidStreamSource } from './android-stream-source';
import {
  DeviceSettingWriteTracker,
  mergeAuthoritativeDeviceSetting,
} from './device-setting-writes';
import { buildCodecString, isWebCodecsSupported, parseFramePacket, scanAU } from './h264';
import { androidMessageForKeyboardInput } from './keyboard';
import { MsePlayer } from './mse-player';
import {
  DEFAULT_DEVICE_STREAM_SETTINGS,
  normalizeDeviceStreamSettings,
} from './stream-settings';
import { type WebRtcIceServer, useWebRtcStream } from './useWebRtcStream';
import {
  type ConnectionStatus,
  type DeviceAppearance,
  type DeviceClient,
  type DeviceConnectionOptions,
  type DeviceEvent,
  type DeviceLog,
  type DeviceSettingKey,
  type DeviceSettings,
  type DeviceStreamEncoderSettings,
  type DeviceStreamSource,
  type DeviceStreamSourceStatus,
  type ForegroundApp,
  type HardwareButton,
  type KeyboardInput,
  type RunningDevice,
  type ScreenSize,
  type TouchSample,
} from './types';

const MAX_LOGS = 200;
const SOFT_DECODE_QUEUE_SIZE = 4;
const KEYFRAME_REQUEST_COOLDOWN_MS = 1500;
const FOREGROUND_POLL_MS = 5000;
const EVENTS_POLL_MS = 1000;
const STREAM_METADATA_POLL_MS = 1500;
const STREAM_SETTINGS_POLL_MS = 3000;
const STREAM_SOURCE_POLL_MS = 3000;
const DEVICE_SETTINGS_POLL_MS = 3000;

const ANDROID_DEVICE_SETTING_KEYS: readonly AndroidDeviceSettingKey[] = [
  'appearance',
  'network',
  'text-size',
];
const ANDROID_POLLED_DEVICE_SETTING_KEYS: readonly AndroidDeviceSettingKey[] = [
  'network',
  'text-size',
];

const KEYCODE_R = 46;

/** Field-wise equality so the poll only publishes state when something changed. */
function sameForegroundApp(a: ForegroundApp, b: ForegroundApp): boolean {
  return (
    a.id === b.id &&
    a.label === b.label &&
    a.pid === b.pid &&
    a.activity === b.activity &&
    a.version === b.version &&
    a.build === b.build &&
    a.minSdk === b.minSdk &&
    a.debuggable === b.debuggable
  );
}

function sameStreamSettings(
  a: DeviceStreamEncoderSettings | null,
  b: DeviceStreamEncoderSettings,
): boolean {
  return (
    a?.mjpegFps === b.mjpegFps &&
    a.mjpegQuality === b.mjpegQuality &&
    a.maxDimension === b.maxDimension &&
    a.h264Bitrate === b.h264Bitrate &&
    a.h264Fps === b.h264Fps
  );
}

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

function deviceApiUrl(baseUrl: string, path: string, device: string | null): string {
  const url = new URL(apiUrl(baseUrl, path));
  if (device) url.searchParams.set('device', device);
  return url.toString();
}

export function androidWsUrlFor(
  baseUrl: string,
  device: string | null,
  video: boolean,
): string {
  const u = new URL(apiUrl(baseUrl, '/ws'));
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  if (video) u.searchParams.set('frame-meta', '1');
  else u.searchParams.set('video', '0');
  // serve-emu routes the stream to this device; omitted → first available.
  if (device) u.searchParams.set('device', device);
  return u.toString();
}

/** Count frames presented between browser callbacks, including skipped callbacks. */
export function presentedVideoFrameDelta(
  previousPresentedFrames: number | null,
  presentedFrames: number,
): number {
  if (!Number.isSafeInteger(presentedFrames) || presentedFrames < 0) return 1;
  if (
    previousPresentedFrames === null ||
    !Number.isSafeInteger(previousPresentedFrames) ||
    presentedFrames <= previousPresentedFrames
  ) {
    return 1;
  }
  return presentedFrames - previousPresentedFrames;
}

type ServeEmuStreamSettings =
  | { transport: 'websocket' }
  | {
      transport: 'webrtc';
      codec: 'h264';
      iceServers: WebRtcIceServer[];
      iceTransportPolicy: RTCIceTransportPolicy;
    };

type ServeEmuApiInfo = {
  size?: { width?: unknown; height?: unknown };
  stream?: unknown;
};

function isIceServer(value: unknown): value is WebRtcIceServer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Array.isArray(candidate.urls) &&
    candidate.urls.length > 0 &&
    candidate.urls.every((url) => typeof url === 'string') &&
    (candidate.username === undefined || typeof candidate.username === 'string') &&
    (candidate.credential === undefined || typeof candidate.credential === 'string')
  );
}

/** Validate the stream contract returned by serve-emu's device-scoped `/api`. */
export function parseServeEmuStreamSettings(value: unknown): ServeEmuStreamSettings | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.transport === 'websocket') return { transport: 'websocket' };
  if (
    candidate.transport !== 'webrtc' ||
    candidate.codec !== 'h264' ||
    !Array.isArray(candidate.iceServers) ||
    !candidate.iceServers.every(isIceServer) ||
    (candidate.iceTransportPolicy !== 'all' && candidate.iceTransportPolicy !== 'relay')
  ) {
    return null;
  }
  return {
    transport: 'webrtc',
    codec: 'h264',
    iceServers: candidate.iceServers,
    iceTransportPolicy: candidate.iceTransportPolicy,
  };
}

export function useAndroidDeviceClient(options: DeviceConnectionOptions): DeviceClient {
  const { baseUrl, enabled = true, device: targetDevice = null, streamMode } = options;
  const active = enabled && !!baseUrl;

  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [screen, setScreen] = useState<ScreenSize | null>(null);
  const [fps, setFps] = useState(0);
  const [logs, setLogs] = useState<DeviceLog[]>([]);
  // Logs are opt-in: nothing streams until the user attaches.
  const [logsEnabled, setLogsEnabled] = useState(false);
  const [events, setEvents] = useState<DeviceEvent[]>([]);
  const [eventsEnabled, setEventsEnabled] = useState(false);
  const [devices, setDevices] = useState<RunningDevice[]>(PLACEHOLDER_DEVICES);
  // The device's system dark/light setting. null until `/api/uimode` reports it.
  const [appearance, setAppearanceState] = useState<DeviceAppearance | null>(null);
  const [deviceSettings, setDeviceSettings] = useState<DeviceSettings | null>(null);
  const [deviceSettingsPending, setDeviceSettingsPending] = useState<
    ReadonlySet<DeviceSettingKey>
  >(() => new Set());
  const [streamSettings, setStreamSettings] = useState<DeviceStreamEncoderSettings | null>(null);
  const [streamSettingsPending, setStreamSettingsPending] = useState(false);
  const [streamSource, setStreamSourceState] = useState<DeviceStreamSourceStatus | null>(null);
  const [streamSourcePending, setStreamSourcePending] = useState(false);
  // The foreground app, polled from `/api/foreground`. null until the first read.
  const [foregroundApp, setForegroundApp] = useState<ForegroundApp | null>(null);
  const [serverStreamSettings, setServerStreamSettings] =
    useState<ServeEmuStreamSettings | null>(null);
  const [webRtcVideoElement, setWebRtcVideoElement] = useState<HTMLVideoElement | null>(null);
  const [webRtcVideoReady, setWebRtcVideoReady] = useState(false);
  const [webRtcInputReady, setWebRtcInputReady] = useState(false);
  const [webRtcInputError, setWebRtcInputError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Monotonic log id source, persisted across logcat reconnects so ids stay
  // unique even though lines are kept (the stream effect may re-run).
  const logSeqRef = useRef(0);
  // Clear is viewer-local so it does not erase serve-emu's replayable session.
  const eventCursorRef = useRef(createAndroidEventCursor());
  const deviceSettingWriteTrackerRef = useRef(new DeviceSettingWriteTracker());
  const deviceSettingVersionsRef = useRef<Record<AndroidDeviceSettingKey, number>>({
    appearance: 0,
    network: 0,
    'text-size': 0,
  });
  const deviceSettingScope = `${active ? 'active' : 'inactive'}\0${baseUrl ?? ''}\0${targetDevice ?? ''}`;
  const deviceSettingScopeRef = useRef(deviceSettingScope);
  useLayoutEffect(() => {
    deviceSettingScopeRef.current = deviceSettingScope;
  }, [deviceSettingScope]);
  const streamSettingsRequestRef = useRef(0);
  const streamSettingsRef = useRef<DeviceStreamEncoderSettings | null>(null);
  const streamSettingsPendingRef = useRef(false);
  const streamSettingsControllerRef = useRef<AbortController | null>(null);
  const streamSourceRequestRef = useRef(0);
  const streamSourceRef = useRef<DeviceStreamSourceStatus | null>(null);
  const streamSourcePendingRef = useRef(false);
  const streamSourceControllerRef = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      streamSettingsControllerRef.current?.abort();
      streamSourceControllerRef.current?.abort();
    },
    [],
  );

  const attachVideo = useCallback(
    (el: HTMLCanvasElement | HTMLImageElement | HTMLVideoElement | null) => {
      canvasRef.current = el?.tagName === 'CANVAS' ? (el as HTMLCanvasElement) : null;
      const video = el?.tagName === 'VIDEO' ? (el as HTMLVideoElement) : null;
      setWebRtcVideoElement((current) => (current === video ? current : video));
    },
    [],
  );

  const attachLogs = useCallback(() => setLogsEnabled(true), []);
  const detachLogs = useCallback(() => setLogsEnabled(false), []);
  const clearLogs = useCallback(() => setLogs([]), []);
  const attachEvents = useCallback(() => setEventsEnabled(true), []);
  const detachEvents = useCallback(() => setEventsEnabled(false), []);
  const clearEvents = useCallback(() => {
    eventCursorRef.current = clearAndroidEventCursor(eventCursorRef.current);
    setEvents([]);
  }, []);

  const send = useCallback((message: Record<string, unknown>): boolean => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify({ ack: false, ...message }));
    return true;
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

  const sendKey = useCallback(
    (input: KeyboardInput): boolean => {
      const message = androidMessageForKeyboardInput(input);
      return message ? send(message) : false;
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

  // Rotate the emulator by locking user rotation to the opposite of the current
  // aspect via `/api/orientation` (POST `adb shell cmd window user-rotation
  // lock 0|1`). The streamed frame size tells which way the display currently
  // faces; locking (rather than `auto`) turns it even when auto-rotate is off.
  const rotate = useCallback(() => {
    if (!baseUrl) return;
    const next = screen && screen.width > screen.height ? 'portrait' : 'landscape';
    const url = `${apiUrl(baseUrl, '/api/orientation')}${
      targetDevice ? `?device=${encodeURIComponent(targetDevice)}` : ''
    }`;
    void fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orientation: next }),
    }).catch(() => {});
  }, [baseUrl, targetDevice, screen]);

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

  // Device-wide options use the same GET/POST contracts as serve-emu's own UI.
  // Writes are optimistic and independently serialized by key; a failed write
  // refreshes only that key so concurrent changes cannot roll each other back.
  const setDeviceSetting = useCallback(
    (key: DeviceSettingKey, value: string) => {
      if (!baseUrl) return;
      const requestOptions = androidDeviceSettingRequest(key, value);
      if (!requestOptions) return;
      const settingKey = key as AndroidDeviceSettingKey;
      const tracker = deviceSettingWriteTrackerRef.current;
      const request = tracker.start(key);
      if (!request) return;
      deviceSettingVersionsRef.current[settingKey]++;
      const scope = deviceSettingScope;
      const previous = deviceSettings?.[key];
      const url = deviceApiUrl(baseUrl, requestOptions.path, targetDevice);

      setDeviceSettingsPending(tracker.pending);
      setDeviceSettings((current) => ({ ...(current ?? {}), [key]: value }));
      if (key === 'appearance') setAppearanceState(value as DeviceAppearance);

      void fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestOptions.body),
      })
        .then(async (response) => {
          if (!response.ok) throw new Error(`Device option update failed (${response.status})`);
          const payload: unknown = await response.json();
          const authoritative = parseAndroidDeviceSetting(settingKey, payload);
          if (authoritative === null) throw new Error('Device option update was rejected');
          if (!tracker.isCurrent(request) || deviceSettingScopeRef.current !== scope) return;
          setDeviceSettings((current) => ({ ...(current ?? {}), [key]: authoritative }));
          if (key === 'appearance') setAppearanceState(authoritative as DeviceAppearance);
        })
        .catch(async () => {
          if (!tracker.isCurrent(request) || deviceSettingScopeRef.current !== scope) return;
          let authoritative: string | null = null;
          try {
            const response = await fetch(url, { cache: 'no-store' });
            if (!response.ok) throw new Error('Device option refresh failed');
            authoritative = parseAndroidDeviceSetting(
              settingKey,
              await response.json(),
            );
          } catch {
            // Restore the last rendered value if both write and refresh fail.
            authoritative = previous ?? null;
          }
          if (!tracker.isCurrent(request) || deviceSettingScopeRef.current !== scope) return;
          setDeviceSettings((current) =>
            mergeAuthoritativeDeviceSetting(
              current,
              key,
              authoritative === null ? {} : { [key]: authoritative },
            ),
          );
          if (key === 'appearance') {
            setAppearanceState(
              authoritative === 'light' || authoritative === 'dark' ? authoritative : null,
            );
          }
        })
        .finally(() => {
          if (tracker.finish(request)) setDeviceSettingsPending(tracker.pending);
        });
    },
    [baseUrl, deviceSettingScope, deviceSettings, targetDevice],
  );

  const setAppearance = useCallback(
    (mode: DeviceAppearance) => setDeviceSetting('appearance', mode),
    [setDeviceSetting],
  );

  const streamSettingsUrl =
    active && baseUrl ? deviceApiUrl(baseUrl, '/api/stream-settings', targetDevice) : null;
  const streamSourceUrl =
    active && baseUrl ? deviceApiUrl(baseUrl, '/api/stream-mode', targetDevice) : null;

  const setStreamSource = useCallback(
    (source: DeviceStreamSource) => {
      const previous = streamSourceRef.current;
      if (
        !streamSourceUrl ||
        !previous ||
        previous.mode === source ||
        !previous.availableModes.includes(source) ||
        streamSourcePendingRef.current
      ) {
        return;
      }
      const request = ++streamSourceRequestRef.current;
      const controller = new AbortController();
      streamSourceControllerRef.current = controller;
      streamSourcePendingRef.current = true;
      setStreamSourcePending(true);
      void fetch(streamSourceUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: source }),
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) throw new Error(`Stream source update failed (${response.status})`);
          const next = parseAndroidStreamSource(await response.json());
          if (!next) throw new Error('Stream source update returned an invalid response');
          if (streamSourceRequestRef.current === request) {
            streamSourceRef.current = next;
            setStreamSourceState(next);
          }
        })
        .catch(() => {
          // The server stages source changes atomically, so the previous source
          // remains authoritative when a replacement fails.
        })
        .finally(() => {
          if (streamSourceControllerRef.current === controller) {
            streamSourceControllerRef.current = null;
          }
          if (!controller.signal.aborted && streamSourceRequestRef.current === request) {
            streamSourcePendingRef.current = false;
            setStreamSourcePending(false);
          }
        });
    },
    [streamSourceUrl],
  );

  // ── Android capture source (serve-emu device-scoped GET/PUT endpoint) ──
  useEffect(() => {
    streamSourceControllerRef.current?.abort();
    streamSourceControllerRef.current = null;
    ++streamSourceRequestRef.current;
    streamSourceRef.current = null;
    setStreamSourceState(null);
    if (!streamSourceUrl) {
      streamSourcePendingRef.current = false;
      setStreamSourcePending(false);
      return;
    }

    streamSourcePendingRef.current = true;
    setStreamSourcePending(true);
    let cancelled = false;
    let polling = false;
    let initial = true;
    let controller: AbortController | null = null;

    const refresh = async () => {
      if (cancelled || polling || streamSourceControllerRef.current) return;
      polling = true;
      const request = ++streamSourceRequestRef.current;
      controller = new AbortController();
      try {
        const response = await fetch(streamSourceUrl, {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Stream source request failed (${response.status})`);
        const next = parseAndroidStreamSource(await response.json());
        if (!next) throw new Error('Stream source request returned an invalid response');
        if (!cancelled && streamSourceRequestRef.current === request) {
          streamSourceRef.current = next;
          setStreamSourceState((current) =>
            current?.mode === next.mode &&
            current.sessionGeneration === next.sessionGeneration &&
            current.availableModes.join() === next.availableModes.join()
              ? current
              : next,
          );
        }
      } catch {
        // Device startup and source replacement are transient; keep polling.
      } finally {
        controller = null;
        polling = false;
        if (!cancelled && initial && streamSourceRequestRef.current === request) {
          initial = false;
          streamSourcePendingRef.current = false;
          setStreamSourcePending(false);
        }
      }
    };

    void refresh();
    const timer = setInterval(refresh, STREAM_SOURCE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      controller?.abort();
    };
  }, [streamSourceUrl]);

  const updateStreamSettings = useCallback(
    (patch: Partial<DeviceStreamEncoderSettings>) => {
      const requestPatch = androidStreamSettingsPatch(patch);
      if (!streamSettingsUrl || !requestPatch || streamSettingsPendingRef.current) return;
      const previous = streamSettingsRef.current ?? DEFAULT_DEVICE_STREAM_SETTINGS;
      const optimistic = normalizeDeviceStreamSettings({ ...previous, ...requestPatch }, previous);
      const request = ++streamSettingsRequestRef.current;
      const controller = new AbortController();
      streamSettingsControllerRef.current = controller;
      streamSettingsPendingRef.current = true;
      streamSettingsRef.current = optimistic;
      setStreamSettings(optimistic);
      setStreamSettingsPending(true);
      void fetch(streamSettingsUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestPatch),
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) throw new Error(`Stream settings update failed (${response.status})`);
          const next = parseAndroidStreamSettings(await response.json(), optimistic);
          if (!next) throw new Error('Stream settings update returned an invalid response');
          if (streamSettingsRequestRef.current === request) {
            streamSettingsRef.current = next;
            setStreamSettings(next);
          }
        })
        .catch(() => {
          if (!controller.signal.aborted && streamSettingsRequestRef.current === request) {
            streamSettingsRef.current = previous;
            setStreamSettings(previous);
          }
        })
        .finally(() => {
          if (streamSettingsControllerRef.current === controller) {
            streamSettingsControllerRef.current = null;
          }
          if (!controller.signal.aborted && streamSettingsRequestRef.current === request) {
            streamSettingsPendingRef.current = false;
            setStreamSettingsPending(false);
          }
        });
    },
    [streamSettingsUrl],
  );

  // ── Runtime encoder settings (serve-emu device-scoped GET/PATCH endpoint) ──
  useEffect(() => {
    streamSettingsControllerRef.current?.abort();
    streamSettingsControllerRef.current = null;
    ++streamSettingsRequestRef.current;
    streamSettingsRef.current = null;
    setStreamSettings(null);
    if (!streamSettingsUrl) {
      streamSettingsPendingRef.current = false;
      setStreamSettingsPending(false);
      return;
    }

    streamSettingsPendingRef.current = true;
    setStreamSettingsPending(true);
    let cancelled = false;
    let polling = false;
    let initial = true;
    let controller: AbortController | null = null;

    const refresh = async () => {
      if (cancelled || polling || streamSettingsControllerRef.current) return;
      polling = true;
      const request = ++streamSettingsRequestRef.current;
      controller = new AbortController();
      try {
        const response = await fetch(streamSettingsUrl, {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Stream settings request failed (${response.status})`);
        const next = parseAndroidStreamSettings(
          await response.json(),
          streamSettingsRef.current ?? DEFAULT_DEVICE_STREAM_SETTINGS,
        );
        if (!next) throw new Error('Stream settings request returned an invalid response');
        if (!cancelled && streamSettingsRequestRef.current === request) {
          streamSettingsRef.current = next;
          setStreamSettings((current) => (sameStreamSettings(current, next) ? current : next));
        }
      } catch {
        // Keep the last authoritative value and retry. On initial failure the
        // control remains disabled because no resolution has been invented.
      } finally {
        controller = null;
        polling = false;
        if (!cancelled && initial) {
          initial = false;
          streamSettingsPendingRef.current = false;
          setStreamSettingsPending(false);
        }
      }
    };

    void refresh();
    const timer = setInterval(refresh, STREAM_SETTINGS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      controller?.abort();
    };
  }, [streamSettingsUrl]);

  // ── Stream metadata ──
  // serve-emu locks its host transport at launch. Poll the device-scoped API so
  // the viewer only offers WebRTC when that transport is actually configured,
  // and so the peer uses the host's ICE servers/policy rather than client input.
  useEffect(() => {
    setServerStreamSettings(null);
    if (!active || !baseUrl) return;

    let cancelled = false;
    let polling = false;
    let controller: AbortController | null = null;
    const url = deviceApiUrl(baseUrl, '/api', targetDevice);

    const refresh = async () => {
      if (cancelled || polling) return;
      polling = true;
      controller = new AbortController();
      try {
        const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) return;
        const info = (await response.json()) as ServeEmuApiInfo;
        if (cancelled) return;
        const next = parseServeEmuStreamSettings(info.stream) ?? { transport: 'websocket' };
        setServerStreamSettings((current) =>
          JSON.stringify(current) === JSON.stringify(next) ? current : next,
        );
        const width = Number(info.size?.width);
        const height = Number(info.size?.height);
        if (width > 0 && height > 0) {
          setScreen((current) =>
            current?.width === width && current.height === height ? current : { width, height },
          );
        }
      } catch {
        // Device startup and temporary disconnects are expected; keep polling.
      } finally {
        polling = false;
        controller = null;
      }
    };

    void refresh();
    const timer = setInterval(refresh, STREAM_METADATA_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      controller?.abort();
    };
  }, [active, baseUrl, targetDevice]);

  const webRtcRequested = streamMode === 'webrtc';
  const waitingForWebRtcMetadata = webRtcRequested && serverStreamSettings === null;
  const useWebRtc =
    webRtcRequested && serverStreamSettings?.transport === 'webrtc';
  const requestWebRtcKeyframe = useCallback(() => {
    send({ type: 'reset-video' });
  }, [send]);
  const {
    stream: webRtcStream,
    error: webRtcError,
    markFrameDecoded: markWebRtcFrameDecoded,
    streamStats,
  } = useWebRtcStream({
    offerUrl: baseUrl ? deviceApiUrl(baseUrl, '/webrtc/offer', targetDevice) : '',
    closeUrl: baseUrl ? deviceApiUrl(baseUrl, '/webrtc/close', targetDevice) : '',
    statsUrl: baseUrl ? deviceApiUrl(baseUrl, '/webrtc/stats', targetDevice) : '',
    enabled: active && useWebRtc,
    codec: 'h264',
    iceServers:
      serverStreamSettings?.transport === 'webrtc'
        ? serverStreamSettings.iceServers
        : undefined,
    iceTransportPolicy:
      serverStreamSettings?.transport === 'webrtc'
        ? serverStreamSettings.iceTransportPolicy
        : 'all',
    sendIceServersInOffer: false,
    allowCodecFallback: false,
    onKeyframeNeeded: requestWebRtcKeyframe,
  });

  useEffect(() => {
    if (!useWebRtc) {
      setWebRtcVideoReady(false);
      setWebRtcInputReady(false);
      setWebRtcInputError(null);
      return;
    }
    if (webRtcError) {
      setStatus('error');
      setError(webRtcError);
    } else if (webRtcInputError) {
      setStatus('error');
      setError(webRtcInputError);
    } else if (!webRtcStream || !webRtcVideoReady || !webRtcInputReady) {
      setStatus('connecting');
      setError(null);
    } else {
      setStatus('streaming');
      setError(null);
    }
  }, [useWebRtc, webRtcError, webRtcInputError, webRtcInputReady, webRtcStream, webRtcVideoReady]);

  // Attach the negotiated MediaStream to DeviceScreen's current <video> node.
  // The node is stateful (rather than only a ref) so a remount reattaches the
  // stream and frame observer even when the MediaStream itself is unchanged.
  useEffect(() => {
    if (!useWebRtc) return;
    const video = webRtcVideoElement;
    if (!video) return;

    let stopped = false;
    let firstFrame = true;
    let frameCallback = 0;
    let fpsCount = 0;
    let fpsStartedAt = performance.now();
    let previousPresentedFrames: number | null = null;

    const markFrame = (presentedFrameDelta = 1) => {
      if (stopped) return;
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        const width = video.videoWidth;
        const height = video.videoHeight;
        setScreen((current) =>
          current?.width === width && current.height === height ? current : { width, height },
        );
      }
      if (firstFrame) {
        firstFrame = false;
        setWebRtcVideoReady(true);
      }
      markWebRtcFrameDecoded(presentedFrameDelta);
      fpsCount += presentedFrameDelta;
      const now = performance.now();
      if (now - fpsStartedAt >= 1000) {
        const next = Math.round((fpsCount * 1000) / (now - fpsStartedAt));
        fpsCount = 0;
        fpsStartedAt = now;
        setFps((current) => (current === next ? current : next));
      }
    };
    const onVideoFrame: VideoFrameRequestCallback = (_now, metadata) => {
      const presentedFrameDelta = presentedVideoFrameDelta(
        previousPresentedFrames,
        metadata.presentedFrames,
      );
      if (
        Number.isSafeInteger(metadata.presentedFrames) &&
        metadata.presentedFrames >= 0
      ) {
        previousPresentedFrames = metadata.presentedFrames;
      }
      markFrame(presentedFrameDelta);
      frameCallback = video.requestVideoFrameCallback(onVideoFrame);
    };
    const onTimeUpdate = () => markFrame();
    const onLoadedData = () => markFrame(0);

    video.srcObject = webRtcStream;
    setWebRtcVideoReady(false);
    if (webRtcStream) {
      if (typeof video.requestVideoFrameCallback === 'function') {
        frameCallback = video.requestVideoFrameCallback(onVideoFrame);
      } else {
        video.addEventListener('timeupdate', onTimeUpdate);
      }
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
      setWebRtcVideoReady(false);
      setFps(0);
    };
  }, [useWebRtc, webRtcStream, webRtcVideoElement, markWebRtcFrameDecoded]);

  // ── H.264 video + input WebSocket (with reconnect) ──
  useEffect(() => {
    if (!active || !baseUrl) {
      setStatus('idle');
      return;
    }
    if (waitingForWebRtcMetadata) {
      setStatus('connecting');
      setError(null);
      return;
    }
    if (useWebRtc) return;
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
        ws = new WebSocket(androidWsUrlFor(baseUrl, targetDevice, true));
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
        if (cancelled) return;
        if (typeof event.data === 'string') {
          // serve-emu announces an encoder restart with a new size (device
          // rotation) as a JSON "video-session" message. Drop the old decoder
          // and resync onto the new stream from a fresh keyframe.
          try {
            const msg = JSON.parse(event.data) as {
              type?: string;
              size?: { width: number; height: number };
            };
            if (
              msg.type === 'video-session' &&
              msg.size &&
              Number.isFinite(msg.size.width) &&
              Number.isFinite(msg.size.height)
            ) {
              closeDecoder();
              msePlayer?.destroy();
              msePlayer = null;
              frameIdx = 0;
              sawKeyframe = false;
              droppingUntilKeyframe = true;
              setScreen({ width: msg.size.width, height: msg.size.height });
              requestKeyframe();
            }
          } catch {}
          return;
        }
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
  }, [active, baseUrl, targetDevice, waitingForWebRtcMetadata, useWebRtc]);

  // ── WebRTC input WebSocket ──
  // Video travels over the peer connection, but low-latency JSON input and
  // keyframe requests retain serve-emu's scrcpy control WebSocket.
  useEffect(() => {
    if (!active || !baseUrl || !useWebRtc) {
      setWebRtcInputReady(false);
      setWebRtcInputError(null);
      return;
    }

    let cancelled = false;
    let reconnectDelay = 500;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const inputUrl = androidWsUrlFor(baseUrl, targetDevice, false);
    setWebRtcInputReady(false);
    setWebRtcInputError(null);

    const scheduleReconnect = (message: string) => {
      if (cancelled) return;
      setWebRtcInputReady(false);
      setWebRtcInputError(message);
      const retryIn = reconnectDelay;
      reconnectDelay = Math.min(Math.round(reconnectDelay * 1.6), 5000);
      retryTimer = setTimeout(connect, retryIn);
    };

    function connect() {
      if (cancelled) return;
      let ws: WebSocket;
      try {
        ws = new WebSocket(inputUrl);
      } catch {
        scheduleReconnect('WebRTC input connection failed. Retrying...');
        return;
      }
      wsRef.current = ws;
      ws.onopen = () => {
        if (cancelled) return;
        reconnectDelay = 500;
        setWebRtcInputReady(true);
        setWebRtcInputError(null);
        ws.send(JSON.stringify({ type: 'reset-video', ack: false }));
      };
      ws.onerror = () => {
        // onclose owns retry scheduling.
      };
      ws.onclose = () => {
        if (wsRef.current === ws) wsRef.current = null;
        scheduleReconnect('WebRTC input disconnected. Retrying...');
      };
      ws.onmessage = (event) => {
        if (cancelled || typeof event.data !== 'string') return;
        try {
          const message = JSON.parse(event.data) as { ok?: boolean; error?: string };
          if (message.ok === false && message.error) setError(message.error);
        } catch {}
      };
    }

    connect();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      const ws = wsRef.current;
      try {
        ws?.close();
      } catch {}
      if (wsRef.current === ws) wsRef.current = null;
      setWebRtcInputReady(false);
    };
  }, [active, baseUrl, targetDevice, useWebRtc]);

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

  // ── Recorded input/session events (polling, best-effort) ──
  // serve-emu records Hub-originated touches, keyboard input, hardware buttons,
  // and location changes. Its session endpoint is a snapshot rather than SSE.
  useEffect(() => {
    setEvents([]);
    eventCursorRef.current = createAndroidEventCursor();
  }, [baseUrl, targetDevice]);

  useEffect(() => {
    if (!eventsEnabled || !active || !baseUrl) return;
    let cancelled = false;
    let polling = false;
    let controller: AbortController | null = null;
    const url = `${apiUrl(baseUrl, '/api/session')}${
      targetDevice ? `?device=${encodeURIComponent(targetDevice)}` : ''
    }`;
    const serial = targetDevice ?? 'default';

    const poll = async () => {
      if (cancelled || polling) return;
      polling = true;
      controller = new AbortController();
      try {
        const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) return;
        const snapshot = (await response.json()) as { events?: AndroidSessionEvent[] };
        if (cancelled || !Array.isArray(snapshot.events)) return;
        const snapshotEvents = snapshot.events;
        eventCursorRef.current = mergeAndroidEventSnapshotCursor(
          eventCursorRef.current,
          snapshotEvents,
        );
        setEvents((previous) =>
          reconcileAndroidSessionEvents(
            previous,
            snapshotEvents.filter(
              (event) => event.id > eventCursorRef.current.clearedThroughId,
            ),
            serial,
          ),
        );
      } catch {
        // Keep the latest successful snapshot while temporarily disconnected.
      } finally {
        polling = false;
        controller = null;
      }
    };

    void poll();
    const timer = setInterval(poll, EVENTS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      controller?.abort();
    };
  }, [eventsEnabled, active, baseUrl, targetDevice]);

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

  // ── Foreground app (best-effort) — serve-emu has no push channel for app
  //    switches, so poll `/api/foreground` (dumpsys window) on an interval. ──
  useEffect(() => {
    setForegroundApp(null);
    if (!active || !baseUrl) return;
    let cancelled = false;
    const url = `${apiUrl(baseUrl, '/api/foreground')}${
      targetDevice ? `?device=${encodeURIComponent(targetDevice)}` : ''
    }`;
    const poll = async () => {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        const data = (await res.json()) as {
          ok?: boolean;
          app?: {
            packageName?: string | null;
            activity?: string | null;
            pid?: number | null;
            label?: string | null;
            versionName?: string | null;
            versionCode?: string | null;
            minSdk?: number | null;
            debuggable?: boolean | null;
          };
        };
        if (cancelled || !data.ok || !data.app?.packageName) return;
        const next: ForegroundApp = {
          id: data.app.packageName,
          label: data.app.label ?? undefined,
          pid: data.app.pid ?? undefined,
          activity: data.app.activity ?? undefined,
          version: data.app.versionName ?? undefined,
          build: data.app.versionCode ?? undefined,
          minSdk: data.app.minSdk ?? undefined,
          debuggable: data.app.debuggable ?? undefined,
        };
        setForegroundApp((prev) => (prev && sameForegroundApp(prev, next) ? prev : next));
      } catch {
        /* offline / unsupported — keep the last known app */
      }
    };
    void poll();
    const timer = setInterval(poll, FOREGROUND_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [active, baseUrl, targetDevice]);

  // ── Device options (best-effort) ──
  // Keep Hub in sync with changes made on-device or through serve-emu's own UI.
  // Polling also makes network's aggregate wifi/data state authoritative.
  useEffect(() => {
    const tracker = deviceSettingWriteTrackerRef.current;
    tracker.reset();
    for (const key of ANDROID_DEVICE_SETTING_KEYS) deviceSettingVersionsRef.current[key]++;
    setDeviceSettingsPending(new Set());
    setDeviceSettings(null);
    setAppearanceState(null);
    if (!active || !baseUrl) {
      return;
    }

    let cancelled = false;
    let polling = false;
    let controllers: AbortController[] = [];
    const scope = deviceSettingScope;

    const poll = async (keys: readonly AndroidDeviceSettingKey[]) => {
      if (cancelled || polling) return;
      polling = true;
      const nextControllers: AbortController[] = [];
      controllers = nextControllers;
      const results = await Promise.all(
        keys.map(async (key) => {
          const version = deviceSettingVersionsRef.current[key];
          const pendingAtStart = tracker.pending.has(key);
          const controller = new AbortController();
          nextControllers.push(controller);
          try {
            const response = await fetch(
              deviceApiUrl(baseUrl, androidDeviceSettingPath(key), targetDevice),
              { cache: 'no-store', signal: controller.signal },
            );
            if (!response.ok) return { key, version, pendingAtStart, handled: false as const };
            return {
              key,
              version,
              pendingAtStart,
              handled: true as const,
              value: parseAndroidDeviceSetting(key, await response.json()),
            };
          } catch {
            return { key, version, pendingAtStart, handled: false as const };
          }
        }),
      );
      polling = false;
      if (cancelled || deviceSettingScopeRef.current !== scope) return;
      if (!results.some((result) => result.handled)) return;
      setDeviceSettings((current) => {
        const next = { ...(current ?? {}) };
        for (const result of results) {
          if (!result.handled) continue;
          if (result.pendingAtStart) continue;
          if (deviceSettingVersionsRef.current[result.key] !== result.version) continue;
          if (tracker.pending.has(result.key)) continue;
          if (result.value === null) delete next[result.key];
          else next[result.key] = result.value;
        }
        return next;
      });
      const appearanceResult = results.find((result) => result.key === 'appearance');
      if (
        appearanceResult?.handled &&
        !appearanceResult.pendingAtStart &&
        deviceSettingVersionsRef.current.appearance === appearanceResult.version &&
        !tracker.pending.has('appearance') &&
        (appearanceResult.value === 'light' || appearanceResult.value === 'dark')
      ) {
        setAppearanceState(appearanceResult.value);
      }
    };

    // Appearance keeps its historical one-shot read because the pinned
    // serve-emu branch still implements `/api/uimode` synchronously. Network
    // and font scale use Hub's async compatibility routes and stay live-polled.
    void poll(ANDROID_DEVICE_SETTING_KEYS);
    const timer = setInterval(
      () => void poll(ANDROID_POLLED_DEVICE_SETTING_KEYS),
      DEVICE_SETTINGS_POLL_MS,
    );
    return () => {
      cancelled = true;
      clearInterval(timer);
      for (const controller of controllers) controller.abort();
      tracker.reset();
    };
  }, [active, baseUrl, deviceSettingScope, targetDevice]);

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
    events,
    eventsEnabled,
    attachEvents,
    detachEvents,
    clearEvents,
    activity: null,
    deviceSettings,
    deviceSettingsPending,
    setDeviceSetting,
    streamSettings,
    streamSettingsPending,
    updateStreamSettings,
    streamSource,
    streamSourcePending,
    setStreamSource,
    streamStats,
    webRtcCodec: 'h264',
    setWebRtcCodec: () => {},
    streamCapabilities: {
      modeAvailability: {
        mjpeg: false,
        h264: true,
        webrtc: serverStreamSettings?.transport === 'webrtc',
      },
      httpCodecs: ['h264'],
      webRtcCodecs: ['h264'],
    },
    capabilities: {
      deviceSettings: true,
      activity: false,
      events: true,
      streamSettings: { maxDimension: true },
    },
    foregroundApp,
    videoKind: useWebRtc ? 'video' : 'canvas',
    attachVideo,
    sendTouch,
    sendKey,
    pressButton,
    reload,
    rotate,
    screenshot,
    appearance,
    setAppearance,
    hardwareKeyboardConnected: null,
    setHardwareKeyboardConnected: () => {},
    toggleSoftwareKeyboard: () => {},
  };
}
