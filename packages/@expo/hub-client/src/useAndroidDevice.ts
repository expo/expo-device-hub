import {
  checkResponse,
  HubRequestError,
  hubError,
  httpError,
  invalidResponse,
  useFeatureRevisions,
  useFeatureSession,
  withFeatureDeadline,
} from './feature-state';
import { useFeatureClient } from './useFeatureClient';
import type { BackendDeviceClient } from './backend-client';
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

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { type AccessibilityLoader, loadAndroidAccessibility } from './accessibility';
import { appendActivitySample } from './activity';
import {
  ANDROID_ACTIVITY_STALE_MS,
  EMPTY_ANDROID_ACTIVITY,
  nextAndroidActivityAfterSilence,
  parseAndroidActivityFrame,
} from './android-activity';
import { apiUrl, deviceApiUrl } from './android-api-url';
import { readAndroidLocation, writeAndroidLocation } from './android-location';
import { androidPermissionsBackend } from './android-permissions';
import { carryForwardAppIcon, fetchAndroidAppIcon } from './android-app-icon';
import {
  type AndroidSessionEvent,
  clearAndroidEventCursor,
  createAndroidEventCursor,
  mergeAndroidEventSnapshotCursor,
  reconcileAndroidSessionEvents,
} from './android-events';
import {
  ANDROID_DEVICE_SETTING_KEYS,
  ANDROID_POLLED_DEVICE_SETTING_KEYS,
  type AndroidDeviceSettingKey,
  androidDeviceSettingPathFor,
  androidDeviceSettingRequest,
  androidDisplayWidthDpFromPayload,
  createAndroidDeviceSettingVersions,
  parseAndroidDeviceSetting,
} from './android-device-settings';
import { androidStreamSettingsPatch, parseAndroidStreamSettings } from './android-stream-settings';
import { androidStreamSourceErrorMessage, parseAndroidStreamSource } from './android-stream-source';
import { androidTouchMessage } from './android-touch';
import { mergeAuthoritativeDeviceSetting, sameDeviceSettings } from './device-setting-writes';
import { buildCodecString, isWebCodecsSupported, parseFramePacket, scanAU } from './h264';
import { KeyedWriteTracker } from './keyed-write-tracker';
import { androidMessageForKeyboardInput } from './keyboard';
import { MsePlayer } from './mse-player';
import {
  isDeliberateServerClose,
  RECONNECT_BASE_DELAY_MS,
  STREAM_RECONNECT_GRACE_MS,
  scheduleReconnect,
} from './stream-reconnect';
import {
  IDLE_STREAM_SWITCH,
  isStreamSwitchPending,
  reduceStreamSwitch,
  type StreamSwitchEvent,
  type StreamSwitchState,
  streamSwitchTimeoutMs,
} from './stream-switch';
import { useAccessibility } from './useAccessibility';
import { useAndroidCamera } from './useAndroidCamera';
import { type DeviceLocationBackend, useDeviceLocation } from './useDeviceLocation';
import { useAppPermissions } from './useAppPermissions';
import { useStreamSettingsResource } from './useStreamSettingsResource';
import { parseScreenRecordingStatus } from './screen-recording';
import { fetchScreenshot } from './screenshot';
import { sessionTokenFetch, sessionTokenProtocols, withSessionTokenQuery } from './session-token';
import { type WebRtcIceServer, useWebRtcStream } from './useWebRtcStream';
import { presentedVideoFrameDelta } from './video-frame-metadata';
import {
  type ConnectionStatus,
  type DeviceClient,
  type DeviceCapabilities,
  type ScreenshotCapture,
  type DeviceScreenRecordingStatus,
  type DeviceConnectionOptions,
  type DeviceEvent,
  type DeviceGrpcImageMode,
  type DeviceActivity,
  type DeviceGrpcEncoder,
  type DeviceInputSource,
  type DeviceLog,
  type DeviceSettingKey,
  type DeviceSettings,
  type DeviceStreamCapabilities,
  type DeviceStreamEncoderSettings,
  type DeviceStreamSettingCapabilities,
  type DeviceStreamSource,
  type DeviceStreamSourceStatus,
  type ForegroundApp,
  type HardwareButton,
  type KeyboardInput,
  type MultiTouchSample,
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
const STREAM_OPTIONS_POLL_MS = 3000;
const DEVICE_SETTINGS_POLL_MS = 3000;
const RESTARTABLE_FEATURES = ['logs', 'events', 'activity', 'foregroundApp'] as const;

const noop = () => {};
const ANDROID_STREAM_CODECS = ['h264'] as const;
const ANDROID_STREAM_SETTING_CAPABILITIES = {
  maxDimension: true,
  h264Fps: true,
  h264Bitrate: true,
} as const satisfies DeviceStreamSettingCapabilities;

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

const PLACEHOLDER_DEVICES: RunningDevice[] = [
  { id: 'android', name: 'Emulator Android', platform: 'android', current: true },
];

const BUTTON_MESSAGE: Record<HardwareButton, Record<string, unknown> | null> = {
  home: { type: 'home' },
  back: { type: 'back' },
  recents: { type: 'recents' },
  appSwitcher: { type: 'recents' },
  power: { type: 'power' },
  // KEYCODE_ESCAPE dismisses the IME without the navigation a Back press would trigger.
  hideKeyboard: { type: 'key', keycode: 111 },
};

export function androidWsUrlFor(baseUrl: string, device: string | null, video: boolean): string {
  const u = new URL(apiUrl(baseUrl, '/ws'));
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  if (video) u.searchParams.set('frame-meta', '1');
  else u.searchParams.set('video', '0');
  // serve-emu routes the stream to this device; omitted → first available.
  if (device) u.searchParams.set('device', device);
  return u.toString();
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
  screenRecording?: unknown;
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

/** @deprecated Use DeviceClientProvider with useDeviceClient or useDeviceScreenClient instead. */
export function useAndroidDeviceClient(options: DeviceConnectionOptions): DeviceClient {
  const { baseUrl, enabled = true, device: targetDevice = null, streamMode, token = null } = options;
  const active = enabled && !!baseUrl;
  const tokenFetch = useMemo(() => sessionTokenFetch(token), [token]);
  // Feature reads and writes get a deadline; video streams and long actions do not.
  const sessionFetch = useMemo(() => withFeatureDeadline(tokenFetch), [tokenFetch]);
  const socketProtocols = useMemo(() => sessionTokenProtocols('android', token), [token]);
  const featureSession = useFeatureSession(`${active}\0${baseUrl}\0${targetDevice}`);
  const [activityEnabled, setActivityEnabled] = useState(false);
  const revisions = useFeatureRevisions(featureSession, RESTARTABLE_FEATURES);
  // `stream` binds below: WebRTC renegotiates, WebSocket mode bumps this.
  const [streamRevision, setStreamRevision] = useState(0);

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
  const [deviceSettings, setDeviceSettings] = useState<DeviceSettings | null>(null);
  const [displayWidthDp, setDisplayWidthDp] = useState<number | null>(null);
  const [hardwareKeyboardConnected, setHardwareKeyboardConnected] = useState<boolean | null>(null);
  const [deviceSettingsPending, setDeviceSettingsPending] = useState<ReadonlySet<DeviceSettingKey>>(
    () => new Set(),
  );
  const [streamSource, setStreamSourceState] = useState<DeviceStreamSourceStatus | null>(null);
  // True until the first authoritative read of the capture source completes.
  const [streamSourceLoading, setStreamSourceLoading] = useState(false);
  const [streamSourceError, setStreamSourceError] = useState<string | null>(null);
  // A capture-source switch stays pending until the replacement stream renders.
  const [streamSwitch, setStreamSwitch] = useState<StreamSwitchState>(IDLE_STREAM_SWITCH);
  // The foreground app, polled from `/api/foreground`. null until the first read.
  const [foregroundApp, setForegroundApp] = useState<ForegroundApp | null>(null);
  const [activity, setActivity] = useState<DeviceActivity | null>(null);
  const activityLastSampleAtRef = useRef(0);
  const [serverStreamSettings, setServerStreamSettings] = useState<ServeEmuStreamSettings | null>(
    null,
  );
  const [webRtcVideoElement, setWebRtcVideoElement] = useState<HTMLVideoElement | null>(null);
  const [webRtcVideoReady, setWebRtcVideoReady] = useState(false);
  const [webRtcInputReady, setWebRtcInputReady] = useState(false);
  const [webRtcInputError, setWebRtcInputError] = useState<string | null>(null);
  // The last input command serve-emu refused (`{ ok: false, error }`). Input is
  // sent without acks, so the next input clears it; a repeat failure sets it again.
  const [inputCommandError, setInputCommandError] = useState<string | null>(null);
  const inputCommandErrorRef = useRef<string | null>(null);
  const reportInputCommandError = useCallback((message: string | null) => {
    if (inputCommandErrorRef.current === message) return;
    inputCommandErrorRef.current = message;
    setInputCommandError(message);
  }, []);
  // Whether this device's WebRTC stream has been live, so a later gap counts as
  // a reconnect (last frame kept) rather than the initial connect.
  const [webRtcWasLive, setWebRtcWasLive] = useState(false);
  const [webRtcGraceExpired, setWebRtcGraceExpired] = useState(false);
  const deviceKey = `${baseUrl ?? ''}\0${targetDevice ?? ''}`;
  const [webRtcDeviceKey, setWebRtcDeviceKey] = useState(deviceKey);
  if (webRtcDeviceKey !== deviceKey) {
    // Reset per-device readiness during render: the previous device's flags
    // are still true in this render and must never read as "reconnecting".
    setWebRtcDeviceKey(deviceKey);
    setWebRtcVideoReady(false);
    setWebRtcInputReady(false);
    setWebRtcInputError(null);
    inputCommandErrorRef.current = null;
    setInputCommandError(null);
    setWebRtcWasLive(false);
    setWebRtcGraceExpired(false);
  }

  const wsRef = useRef<WebSocket | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Monotonic log id source, persisted across logcat reconnects so ids stay
  // unique even though lines are kept (the stream effect may re-run).
  const logSeqRef = useRef(0);
  // Clear is viewer-local so it does not erase serve-emu's replayable session.
  const eventCursorRef = useRef(createAndroidEventCursor());
  const deviceSettingWriteTrackerRef = useRef(new KeyedWriteTracker<DeviceSettingKey>());
  const deviceSettingVersionsRef = useRef(createAndroidDeviceSettingVersions());
  const deviceScope = `${active ? 'active' : 'inactive'}\0${baseUrl ?? ''}\0${targetDevice ?? ''}`;
  const [recordingSnapshot, setRecordingSnapshot] = useState<{
    scope: string;
    status: DeviceScreenRecordingStatus | null;
  }>({ scope: deviceScope, status: active ? 'unknown' : null });
  if (recordingSnapshot.scope !== deviceScope) {
    setRecordingSnapshot({ scope: deviceScope, status: active ? 'unknown' : null });
  }
  const deviceScopeRef = useRef(deviceScope);
  useLayoutEffect(() => {
    deviceScopeRef.current = deviceScope;
  }, [deviceScope]);
  const streamSourceRequestRef = useRef(0);
  const streamSourceRef = useRef<DeviceStreamSourceStatus | null>(null);
  const streamSourceLoadingRef = useRef(false);
  const streamSwitchRef = useRef<StreamSwitchState>(IDLE_STREAM_SWITCH);
  // The server's answer to a switch, held back until the new stream is on screen.
  const sourceCompletionRef = useRef<{ resolve(): void; reject(cause: unknown): void } | null>(
    null,
  );
  const pendingStreamSourceRef = useRef<DeviceStreamSourceStatus | null>(null);
  const streamLiveRef = useRef(false);
  const streamSourceControllerRef = useRef<AbortController | null>(null);
  const streamSourceRefreshControllerRef = useRef<AbortController | null>(null);
  const abortStreamSourceRefresh = useCallback(() => {
    ++streamSourceRequestRef.current;
    streamSourceRefreshControllerRef.current?.abort();
    streamSourceRefreshControllerRef.current = null;
  }, []);

  const commitPendingStreamSource = useCallback(() => {
    const next = pendingStreamSourceRef.current;
    if (!next) return;
    pendingStreamSourceRef.current = null;
    streamSourceRef.current = next;
    setStreamSourceState(next);
  }, []);

  /**
   * Advance the switch tracker synchronously (callers may read the result) and
   * publish the held-back source once the replacement stream is on screen.
   */
  const dispatchStreamSwitch = useCallback(
    (event: StreamSwitchEvent): StreamSwitchState => {
      const next = reduceStreamSwitch(streamSwitchRef.current, event);
      if (next !== streamSwitchRef.current) {
        streamSwitchRef.current = next;
        setStreamSwitch(next);
      }
      if (!isStreamSwitchPending(next)) {
        commitPendingStreamSource();
        if (event.type === 'timeout')
          sourceCompletionRef.current?.reject(new Error('Replacement stream timed out'));
        else sourceCompletionRef.current?.resolve();
        sourceCompletionRef.current = null;
      }
      return next;
    },
    [commitPendingStreamSource],
  );

  const resetStreamSwitch = useCallback(() => {
    sourceCompletionRef.current?.reject({
      code: 'cancelled',
      message: 'The target changed',
      retryable: false,
    });
    sourceCompletionRef.current = null;
    pendingStreamSourceRef.current = null;
    streamSwitchRef.current = IDLE_STREAM_SWITCH;
    setStreamSwitch(IDLE_STREAM_SWITCH);
  }, []);
  useEffect(
    () => () => {
      streamSourceControllerRef.current?.abort();
      streamSourceRefreshControllerRef.current?.abort();
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
    // Keyframe requests are not input, so they leave a refused-input report alone.
    if (message.type !== 'reset-video') reportInputCommandError(null);
    ws.send(JSON.stringify({ ack: false, ...message }));
    return true;
  }, [reportInputCommandError]);

  const sendTouch = useCallback(
    (sample: TouchSample) => {
      send(androidTouchMessage(sample.phase, sample, 0));
    },
    [send],
  );

  // scrcpy derives ACTION_POINTER_DOWN from the second pointer, so 0 goes first.
  const sendMultiTouch = useCallback(
    (sample: MultiTouchSample) => {
      send(androidTouchMessage(sample.phase, sample.a, 0));
      send(androidTouchMessage(sample.phase, sample.b, 1));
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
    void sessionFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orientation: next }),
    }).catch(() => {});
  }, [baseUrl, targetDevice, screen, sessionFetch]);

  // serve-emu captures the frame buffer server-side (`adb exec-out screencap
  // -p`) and returns the PNG bytes; `?device=` selects the serial (omitted →
  // first available, matching the stream).
  const screenshot = useCallback(async (): Promise<ScreenshotCapture | null> => {
    if (!baseUrl) return null;
    return fetchScreenshot(baseUrl, targetDevice, tokenFetch);
  }, [baseUrl, targetDevice, tokenFetch]);

  // Device-wide options use the same GET/POST contracts as serve-emu's own UI.
  // Writes are optimistic and independently serialized by key; a failed write
  // refreshes only that key so concurrent changes cannot roll each other back.
  const setDeviceSetting = useCallback(
    (key: DeviceSettingKey, value: string) => {
      if (!baseUrl) return;
      const requestOptions = androidDeviceSettingRequest(key, value);
      if (!requestOptions)
        throw { code: 'rejected', message: 'Invalid or unsupported setting', retryable: false };
      const settingKey = key as AndroidDeviceSettingKey;
      const tracker = deviceSettingWriteTrackerRef.current;
      const request = tracker.start(key);
      if (!request) return;
      deviceSettingVersionsRef.current[settingKey]++;
      const scope = deviceScope;
      const previous = deviceSettings?.[key];
      const url = deviceApiUrl(baseUrl, requestOptions.path, targetDevice);

      setDeviceSettingsPending(tracker.pending);
      setDeviceSettings((current) => ({ ...(current ?? {}), [key]: value }));

      return sessionFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestOptions.body),
      })
        .then(async (response) => {
          checkResponse(response, 'Device option update failed');
          const payload: unknown = await response.json();
          const authoritative = parseAndroidDeviceSetting(settingKey, payload);
          if (authoritative === null) throw invalidResponse('Device option update was rejected');
          if (!tracker.isCurrent(request) || deviceScopeRef.current !== scope) return;
          setDeviceSettings((current) => ({ ...(current ?? {}), [key]: authoritative }));
        })
        .catch(async (cause) => {
          if (!tracker.isCurrent(request) || deviceScopeRef.current !== scope) return;
          let authoritative: string | null = null;
          try {
            const response = await sessionFetch(url, { cache: 'no-store' });
            checkResponse(response, 'Device option refresh failed');
            authoritative = parseAndroidDeviceSetting(settingKey, await response.json());
          } catch {
            // Restore the last rendered value if both write and refresh fail.
            authoritative = previous ?? null;
          }
          if (!tracker.isCurrent(request) || deviceScopeRef.current !== scope) return;
          setDeviceSettings((current) =>
            mergeAuthoritativeDeviceSetting(
              current,
              key,
              authoritative === null ? {} : { [key]: authoritative },
            ),
          );
          throw cause;
        })
        .finally(() => {
          if (tracker.finish(request)) setDeviceSettingsPending(tracker.pending);
        });
    },
    [baseUrl, deviceScope, deviceSettings, targetDevice, sessionFetch],
  );

  const { camera, cameraSupported, cameraPending, cameraError, setCameraImage, clearCameraImage } =
    useAndroidCamera({
      active,
      baseUrl: baseUrl ?? null,
      device: targetDevice,
      scope: deviceScope,
      scopeRef: deviceScopeRef,
      token,
      readState: featureSession.read('camera'),
    });

  const accessibilityLoader = useMemo<AccessibilityLoader | null>(
    () =>
      active && baseUrl
        ? (signal) =>
            loadAndroidAccessibility(
              deviceApiUrl(baseUrl, '/api/accessibility', targetDevice),
              signal,
              sessionFetch,
            )
        : null,
    [active, baseUrl, targetDevice, sessionFetch],
  );
  const accessibilityState = useAccessibility(
    accessibilityLoader,
    undefined,
    featureSession.read('accessibility'),
  );

  const locationUrl =
    active && baseUrl ? deviceApiUrl(baseUrl, '/api/location', targetDevice) : null;
  const locationBackend = useMemo<DeviceLocationBackend | null>(
    () =>
      locationUrl === null
        ? null
        : {
            read: (signal) => readAndroidLocation(sessionFetch, locationUrl, signal, true),
            set: (fix) => writeAndroidLocation(sessionFetch, locationUrl, fix),
          },
    [locationUrl, sessionFetch],
  );
  const {
    location,
    locationPending,
    locationError,
    setLocation,
    clearLocation,
    locationCapabilities,
  } = useDeviceLocation(locationBackend, featureSession.read('location'));

  const permissionsBackend = useMemo(
    () =>
      active && baseUrl ? androidPermissionsBackend(baseUrl, targetDevice, sessionFetch) : null,
    [active, baseUrl, targetDevice, sessionFetch],
  );
  const resetPermissionWrites = useCallback(
    () => featureSession.resetWrites('permissions'),
    [featureSession],
  );
  const appPermissions = useAppPermissions({
    active,
    appId: foregroundApp?.id ?? null,
    backend: permissionsBackend,
    readState: featureSession.read('permissions'),
    resetWrites: resetPermissionWrites,
  });

  const streamSettingsUrl =
    active && baseUrl ? deviceApiUrl(baseUrl, '/api/stream-settings', targetDevice) : null;
  const streamSourceUrl =
    active && baseUrl ? deviceApiUrl(baseUrl, '/api/stream-mode', targetDevice) : null;
  const {
    streamSettings,
    streamSettingsPending,
    updateStreamSettings: writeStreamSettings,
    refreshStreamSettings,
  } = useStreamSettingsResource({
    url: streamSettingsUrl,
    initialSettings: null,
    readState: featureSession.read('streamSettings'),
    parse: parseAndroidStreamSettings,
    toPatch: androidStreamSettingsPatch,
    fetchImpl: sessionFetch,
  });

  const refreshStreamSource = useCallback(
    async (clearPendingWhenDone = false) => {
      // A pending switch owns the source state until its stream is on screen.
      if (
        !streamSourceUrl ||
        featureSession.read('streamSource').isStopped() ||
        streamSourceControllerRef.current ||
        streamSourceRefreshControllerRef.current ||
        isStreamSwitchPending(streamSwitchRef.current)
      ) {
        return;
      }
      const request = ++streamSourceRequestRef.current;
      const controller = new AbortController();
      streamSourceRefreshControllerRef.current = controller;
      try {
        const response = await sessionFetch(streamSourceUrl, {
          cache: 'no-store',
          signal: controller.signal,
        });
        checkResponse(response, 'Stream source request failed');
        const next = parseAndroidStreamSource(await response.json());
        if (!next) throw invalidResponse('Stream source request returned an invalid response');
        if (!controller.signal.aborted && streamSourceRequestRef.current === request) {
          featureSession.read('streamSource').ready();
          streamSourceRef.current = next;
          setStreamSourceState((current) =>
            current?.mode === next.mode &&
            current.grpcImageMode === next.grpcImageMode &&
            current.encoder === next.encoder &&
            current.encoderName === next.encoderName &&
            current.availableEncoders.join() === next.availableEncoders.join() &&
            current.hardwareEncoderError === next.hardwareEncoderError &&
            current.inputSource === next.inputSource &&
            current.sessionGeneration === next.sessionGeneration &&
            current.availableModes.join() === next.availableModes.join() &&
            current.availableInputSources.join() === next.availableInputSources.join()
              ? current
              : next,
          );
        }
      } catch (cause) {
        if (!controller.signal.aborted) featureSession.read('streamSource').fail(cause, true);
      } finally {
        if (streamSourceRefreshControllerRef.current === controller) {
          streamSourceRefreshControllerRef.current = null;
        }
        if (
          clearPendingWhenDone &&
          !controller.signal.aborted &&
          streamSourceRequestRef.current === request
        ) {
          streamSourceLoadingRef.current = false;
          setStreamSourceLoading(false);
        }
      }
    },
    [streamSourceUrl, sessionFetch, featureSession],
  );

  const putStreamMode = useCallback(
    (body: {
      mode: DeviceStreamSource;
      grpcImageMode?: DeviceGrpcImageMode;
      encoder?: DeviceGrpcEncoder;
      inputSource?: DeviceInputSource;
    }) => {
      if (
        !streamSourceUrl ||
        streamSourceLoadingRef.current ||
        isStreamSwitchPending(streamSwitchRef.current)
      ) {
        return;
      }
      const previousGeneration = streamSourceRef.current?.sessionGeneration ?? null;
      const request = ++streamSourceRequestRef.current;
      const controller = new AbortController();
      streamSourceControllerRef.current = controller;
      pendingStreamSourceRef.current = null;
      dispatchStreamSwitch({ type: 'request-start', live: streamLiveRef.current });
      setStreamSourceError(null);
      let failed = false;
      return sessionFetch(streamSourceUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) {
            let payload: unknown = null;
            try {
              payload = await response.json();
            } catch {}
            throw httpError(
              response.status,
              androidStreamSourceErrorMessage(response.status, payload),
            );
          }
          const next = parseAndroidStreamSource(await response.json());
          if (!next) throw invalidResponse('Stream mode update returned an invalid response');
          if (streamSourceRequestRef.current === request) {
            setStreamSourceError(null);
            // serve-emu answers after it has published the replacement session
            // and closed this viewer's sockets. Hold the new source back until
            // the replacement stream is on screen so the sidebar and the device
            // frame change together (a same-generation answer changed nothing).
            pendingStreamSourceRef.current = next;
            dispatchStreamSwitch({
              type: 'request-success',
              replaced: next.sessionGeneration !== previousGeneration,
            });
            if (isStreamSwitchPending(streamSwitchRef.current)) {
              await new Promise<void>((resolve, reject) => {
                sourceCompletionRef.current = { resolve, reject };
              });
            }
          }
        })
        .catch((cause: unknown) => {
          // The server stages source changes atomically, so the previous source
          // remains authoritative when a replacement fails.
          if (!controller.signal.aborted && streamSourceRequestRef.current === request) {
            setStreamSourceError(
              cause instanceof Error ? cause.message : 'Unable to change stream source.',
            );
            failed = true;
            dispatchStreamSwitch({ type: 'request-failure' });
          }
          throw cause;
        })
        .finally(() => {
          if (streamSourceControllerRef.current === controller) {
            streamSourceControllerRef.current = null;
            // A failed hardware probe changes host availability, even though the
            // server keeps the current capture and its generation running.
            if (failed) void refreshStreamSource();
          }
        });
    },
    [dispatchStreamSwitch, refreshStreamSource, streamSourceUrl, sessionFetch],
  );

  const setStreamSource = useCallback(
    (source: DeviceStreamSource) => {
      const previous = streamSourceRef.current;
      if (!previous || previous.mode === source || !previous.availableModes.includes(source)) {
        return;
      }
      putStreamMode({ mode: source });
    },
    [putStreamMode],
  );

  const setGrpcImageMode = useCallback(
    (grpcImageMode: DeviceGrpcImageMode) => {
      const previous = streamSourceRef.current;
      if (
        !previous ||
        previous.mode !== 'grpc-screenshot' ||
        previous.grpcImageMode === grpcImageMode
      ) {
        return;
      }
      putStreamMode({
        mode: previous.mode,
        grpcImageMode,
        inputSource: previous.inputSource,
      });
    },
    [putStreamMode],
  );

  const setGrpcEncoder = useCallback(
    (encoder: DeviceGrpcEncoder) => {
      const previous = streamSourceRef.current;
      if (
        !previous ||
        previous.mode !== 'grpc-screenshot' ||
        previous.encoder === encoder ||
        !previous.availableEncoders.includes(encoder)
      ) {
        return;
      }
      putStreamMode({
        mode: previous.mode,
        grpcImageMode: previous.grpcImageMode,
        inputSource: previous.inputSource,
        encoder,
      });
    },
    [putStreamMode],
  );

  const setGrpcInputSource = useCallback(
    (inputSource: DeviceInputSource) => {
      const previous = streamSourceRef.current;
      if (
        !previous ||
        previous.mode !== 'grpc-screenshot' ||
        previous.inputSource === inputSource ||
        !previous.availableInputSources.includes(inputSource)
      ) {
        return;
      }
      putStreamMode({
        mode: previous.mode,
        grpcImageMode: previous.grpcImageMode,
        inputSource,
      });
    },
    [putStreamMode],
  );

  // ── Android capture source (serve-emu device-scoped GET/PUT endpoint) ──
  useEffect(() => {
    streamSourceControllerRef.current?.abort();
    streamSourceControllerRef.current = null;
    abortStreamSourceRefresh();
    streamSourceRef.current = null;
    setStreamSourceState(null);
    setStreamSourceError(null);
    resetStreamSwitch();
    if (!streamSourceUrl) {
      streamSourceLoadingRef.current = false;
      setStreamSourceLoading(false);
      return;
    }

    streamSourceLoadingRef.current = true;
    setStreamSourceLoading(true);
    const unbind = featureSession.read('streamSource').bind(() => {
      void refreshStreamSource(true);
    });
    void refreshStreamSource(true);
    return () => {
      unbind();
      abortStreamSourceRefresh();
    };
  }, [
    abortStreamSourceRefresh,
    refreshStreamSource,
    resetStreamSwitch,
    streamSourceUrl,
    featureSession,
  ]);

  // Safety net: never leave the controls disabled if the stream never drops or
  // the replacement never paints (the server state is still authoritative).
  useEffect(() => {
    const timeoutMs = streamSwitchTimeoutMs(streamSwitch.phase);
    if (timeoutMs === null) return;
    const timer = setTimeout(() => dispatchStreamSwitch({ type: 'timeout' }), timeoutMs);
    return () => clearTimeout(timer);
  }, [dispatchStreamSwitch, streamSwitch]);

  // Feed the switch tracker from the connection status: a live stream that
  // drops is the old session closing; the next live frame is the replacement.
  useEffect(() => {
    const live = status === 'streaming';
    const wasLive = streamLiveRef.current;
    streamLiveRef.current = live;
    if (wasLive && !live) dispatchStreamSwitch({ type: 'stream-interrupted' });
    else if (!wasLive && live) dispatchStreamSwitch({ type: 'stream-live' });
  }, [dispatchStreamSwitch, status]);

  // Stream options share one timer and pause while the page is hidden.
  useEffect(() => {
    if (!streamSettingsUrl && !streamSourceUrl) return;
    const refresh = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      refreshStreamSettings();
      void refreshStreamSource();
    };
    const timer = setInterval(refresh, STREAM_OPTIONS_POLL_MS);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(timer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', refresh);
      }
    };
  }, [refreshStreamSettings, refreshStreamSource, streamSettingsUrl, streamSourceUrl]);

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
        const response = await sessionFetch(url, { cache: 'no-store', signal: controller.signal });
        checkResponse(response);
        const info = (await response.json()) as ServeEmuApiInfo;
        if (cancelled) return;
        featureSession.resolve();
        const next = parseServeEmuStreamSettings(info.stream) ?? { transport: 'websocket' };
        const recordingStatus = parseScreenRecordingStatus(info.screenRecording);
        if (recordingStatus === null) featureSession.read('screenRecording').unsupported();
        else featureSession.read('screenRecording').ready();
        setRecordingSnapshot((current) =>
          current.scope === deviceScope && current.status === recordingStatus
            ? current
            : { scope: deviceScope, status: recordingStatus },
        );
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
      } catch (cause) {
        // The interval keeps polling: discovery, screen size, and transport
        // metadata have no other refresh path, so this read never stops.
        if (!cancelled) {
          featureSession.read('config').fail(cause, 'always');
          featureSession.read('screenRecording').fail(cause, 'always');
        }
      } finally {
        polling = false;
        controller = null;
      }
    };

    const unbind = featureSession.read('config').bind(() => {
      void refresh();
    });
    const unbindRecording = featureSession.read('screenRecording').bind(() => {
      featureSession.read('config').begin();
      void refresh();
    });
    void refresh();
    const timer = setInterval(refresh, STREAM_METADATA_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      unbind();
      unbindRecording();
      controller?.abort();
    };
  }, [active, baseUrl, deviceScope, targetDevice, sessionFetch, featureSession]);

  const webRtcRequested = streamMode === 'webrtc';
  const waitingForWebRtcMetadata = webRtcRequested && serverStreamSettings === null;
  const useWebRtc = webRtcRequested && serverStreamSettings?.transport === 'webrtc';
  const requestWebRtcKeyframe = useCallback(() => {
    send({ type: 'reset-video' });
  }, [send]);
  const {
    stream: webRtcStream,
    error: webRtcError,
    markFrameDecoded: markWebRtcFrameDecoded,
    restart: restartWebRtcStream,
    streamStats,
    setStreamStatsEnabled,
  } = useWebRtcStream({
    statsReadState: featureSession.read('streamStats'),
    // An inactive hook (the other platform under DeviceClientProvider) may hold
    // a relative serve-sim baseUrl, which deviceApiUrl cannot parse.
    offerUrl: active && baseUrl ? deviceApiUrl(baseUrl, '/webrtc/offer', targetDevice) : '',
    closeUrl: active && baseUrl ? deviceApiUrl(baseUrl, '/webrtc/close', targetDevice) : '',
    closeBeaconUrl:
      active && baseUrl
        ? withSessionTokenQuery(deviceApiUrl(baseUrl, '/webrtc/close', targetDevice), token)
        : '',
    statsUrl: active && baseUrl ? deviceApiUrl(baseUrl, '/webrtc/stats', targetDevice) : '',
    enabled: active && useWebRtc,
    codec: 'h264',
    iceServers:
      serverStreamSettings?.transport === 'webrtc' ? serverStreamSettings.iceServers : undefined,
    iceTransportPolicy:
      serverStreamSettings?.transport === 'webrtc'
        ? serverStreamSettings.iceTransportPolicy
        : 'all',
    sendIceServersInOffer: false,
    allowCodecFallback: false,
    onKeyframeNeeded: requestWebRtcKeyframe,
    fetchImpl: tokenFetch,
  });

  const restartWebRtc = useCallback(() => {
    const video = webRtcVideoElement;
    // Closing the peer or replacing srcObject can clear the decoded frame.
    // Capture it before either happens and show it until fresh video arrives.
    if (video && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
      const snapshot = document.createElement('canvas');
      snapshot.width = video.videoWidth;
      snapshot.height = video.videoHeight;
      const context = snapshot.getContext('2d');
      if (context) {
        context.drawImage(video, 0, 0);
        video.poster = snapshot.toDataURL('image/png');
      }
      video.srcObject = null;
    }
    restartWebRtcStream();
  }, [restartWebRtcStream, webRtcVideoElement]);

  useEffect(
    () =>
      featureSession.read('stream').bind(() => {
        if (useWebRtc) restartWebRtc();
        else setStreamRevision((value) => value + 1);
      }),
    [featureSession, useWebRtc, restartWebRtc],
  );

  // Media remounts update the restart target without replacing the input socket.
  const restartWebRtcRef = useRef(restartWebRtc);
  useLayoutEffect(() => {
    restartWebRtcRef.current = restartWebRtc;
  }, [restartWebRtc]);

  const updateStreamSettings = useCallback(
    (patch: Partial<DeviceStreamEncoderSettings>) => {
      if (streamSourceLoadingRef.current || isStreamSwitchPending(streamSwitchRef.current))
        throw new HubRequestError('A stream update is already in progress', undefined, 'busy');
      const write = writeStreamSettings(patch);
      if (!useWebRtc) return write;
      const request = ++streamSourceRequestRef.current;
      dispatchStreamSwitch({ type: 'request-start', live: streamLiveRef.current });
      return write
        .then(async (updated) => {
          if (streamSourceRequestRef.current !== request)
            throw new HubRequestError(
              'A newer stream update replaced this one',
              undefined,
              'cancelled',
            );
          if (!updated) {
            dispatchStreamSwitch({ type: 'request-failure' });
            return false;
          }
          // Resolution changes replace the encoder without closing the input
          // socket. A new peer avoids waiting on the old decoder's video state.
          restartWebRtcRef.current();
          dispatchStreamSwitch({ type: 'request-success', replaced: true });
          if (isStreamSwitchPending(streamSwitchRef.current))
            await new Promise<void>((resolve, reject) => {
              sourceCompletionRef.current = { resolve, reject };
            });
          return true;
        })
        .catch((cause) => {
          // A superseded write (another request or another device) must not
          // clear the switch state that the newer request owns.
          if (streamSourceRequestRef.current === request)
            dispatchStreamSwitch({ type: 'request-failure' });
          throw cause;
        });
    },
    [dispatchStreamSwitch, useWebRtc, writeStreamSettings],
  );

  const webRtcLive =
    useWebRtc &&
    !webRtcError &&
    !webRtcInputError &&
    !!webRtcStream &&
    webRtcVideoReady &&
    webRtcInputReady;

  useEffect(() => {
    if (!useWebRtc) {
      setWebRtcWasLive(false);
      setWebRtcGraceExpired(false);
      return;
    }
    if (webRtcLive) {
      setWebRtcWasLive(true);
      setWebRtcGraceExpired(false);
      return;
    }
    if (!webRtcWasLive) return;
    const timer = setTimeout(() => setWebRtcGraceExpired(true), STREAM_RECONNECT_GRACE_MS);
    return () => clearTimeout(timer);
  }, [useWebRtc, webRtcLive, webRtcWasLive]);

  useEffect(() => {
    if (!useWebRtc) {
      setWebRtcVideoReady(false);
      setWebRtcInputReady(false);
      setWebRtcInputError(null);
      return;
    }
    if (webRtcLive) {
      setStatus('streaming');
      setError(null);
    } else if (webRtcWasLive && (!webRtcGraceExpired || streamSwitch.phase === 'awaiting-frame')) {
      // A source switch replaces both the control socket and the video peer.
      // Its bounded frame wait can outlast the ordinary reconnect grace period.
      setStatus('reconnecting');
      setError(null);
    } else if (webRtcError) {
      setStatus('error');
      setError(webRtcError);
    } else if (webRtcInputError) {
      setStatus('error');
      setError(webRtcInputError);
    } else {
      setStatus('connecting');
      setError(null);
    }
  }, [
    useWebRtc,
    webRtcError,
    webRtcGraceExpired,
    webRtcInputError,
    webRtcLive,
    webRtcWasLive,
    streamSwitch.phase,
  ]);

  // Attach the negotiated MediaStream to DeviceScreen's current <video> node.
  // The node is stateful (rather than only a ref) so a remount reattaches the
  // stream and frame observer even when the MediaStream itself is unchanged.
  useEffect(() => {
    if (!useWebRtc) return;
    const video = webRtcVideoElement;
    // A pending negotiation leaves the existing media or saved poster in place.
    if (!video || !webRtcStream) return;

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
        video.removeAttribute('poster');
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
      if (Number.isSafeInteger(metadata.presentedFrames) && metadata.presentedFrames >= 0) {
        previousPresentedFrames = metadata.presentedFrames;
      }
      markFrame(presentedFrameDelta);
      frameCallback = video.requestVideoFrameCallback(onVideoFrame);
    };
    const onTimeUpdate = () => markFrame();
    const onLoadedData = () => markFrame(0);

    video.srcObject = webRtcStream;
    setWebRtcVideoReady(false);
    if (typeof video.requestVideoFrameCallback === 'function') {
      frameCallback = video.requestVideoFrameCallback(onVideoFrame);
    } else {
      video.addEventListener('timeupdate', onTimeUpdate);
    }
    video.addEventListener('loadeddata', onLoadedData, { once: true });
    void video.play().catch(() => {});

    return () => {
      stopped = true;
      video.removeEventListener('loadeddata', onLoadedData);
      video.removeEventListener('timeupdate', onTimeUpdate);
      if (frameCallback && typeof video.cancelVideoFrameCallback === 'function') {
        video.cancelVideoFrameCallback(frameCallback);
      }
      setWebRtcVideoReady(false);
      setFps(0);
    };
  }, [useWebRtc, webRtcStream, webRtcVideoElement, markWebRtcFrameDecoded]);

  // Detach the media only when this surface stops showing WebRTC or moves to
  // another device; a lost stream alone keeps its last frame (see above).
  useEffect(() => {
    if (!useWebRtc) return;
    const video = webRtcVideoElement;
    if (!video) return;
    return () => {
      video.removeAttribute('poster');
      video.srcObject = null;
    };
  }, [useWebRtc, webRtcVideoElement, baseUrl, targetDevice]);

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
    let reconnectDelay = RECONNECT_BASE_DELAY_MS;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    // Runs from a drop of the live stream until the frame is back; when it
    // fires first, the reconnect is reported as a disconnect.
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
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

    const clearGraceTimer = () => {
      if (graceTimer) clearTimeout(graceTimer);
      graceTimer = null;
    };

    const markPainted = () => {
      if (cancelled || painted) return;
      painted = true;
      clearGraceTimer();
      setStatus('streaming');
      setError(null);
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

      markPainted();
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
            onFirstFrame: markPainted,
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
        ws = new WebSocket(androidWsUrlFor(baseUrl, targetDevice, true), socketProtocols);
      } catch (err) {
        setStatus('error');
        setError(err instanceof Error ? err.message : 'Invalid server URL');
        return;
      }
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelled) return;
        reconnectDelay = RECONNECT_BASE_DELAY_MS;
        // Status stays as-is: a socket opening proves nothing user-visible yet
        // (the server accepts even while the emulator is still booting). Only the
        // first painted frame flips to 'streaming'.
        // MSE playback must begin on a keyframe; nudge the server to emit one now.
        if (useMse) requestKeyframe();
      };
      ws.onerror = () => {
        // A failed socket always fires onclose next — status is decided there.
      };
      ws.onclose = (event) => {
        if (cancelled) return;
        closeDecoder();
        msePlayer?.destroy();
        msePlayer = null;
        sawKeyframe = false;
        frameIdx = 0;
        // A drop before the first frame is normal while the emulator is still
        // booting/attaching — keep "Connecting…" and retry quietly (matching
        // iOS). A stream that was live keeps its last frame on the canvas and
        // reports a reconnect: serve-emu closes viewer sockets on purpose when
        // it swaps the capture source, and the replacement session is usually
        // a few hundred milliseconds away. Only an outage that outlives the
        // grace period becomes a disconnect.
        const wasHealthy = painted;
        if (painted) {
          painted = false;
          setStatus('reconnecting');
          setError(null);
          if (!graceTimer) {
            graceTimer = setTimeout(() => {
              graceTimer = null;
              if (cancelled || painted) return;
              setStatus('error');
              setError((prev) => prev ?? 'Disconnected — retrying…');
            }, STREAM_RECONNECT_GRACE_MS);
          }
        }
        const schedule = scheduleReconnect({
          code: event.code,
          wasHealthy,
          currentDelay: reconnectDelay,
        });
        reconnectDelay = schedule.nextDelay;
        retryTimer = setTimeout(connect, schedule.retryIn);
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
              ok?: boolean;
              error?: string;
            };
            // Input shares this socket in WebSocket mode.
            if (msg.ok === false && msg.error) reportInputCommandError(msg.error);
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
      clearGraceTimer();
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
  }, [
    active,
    baseUrl,
    targetDevice,
    waitingForWebRtcMetadata,
    useWebRtc,
    socketProtocols,
    streamRevision,
  ]);

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
    let reconnectDelay = RECONNECT_BASE_DELAY_MS;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    // Whether the current socket opened; a deliberate server close of an open
    // control channel (capture-source switch) is retried almost immediately.
    let opened = false;
    const inputUrl = androidWsUrlFor(baseUrl, targetDevice, false);
    setWebRtcInputReady(false);
    setWebRtcInputError(null);

    const retryInput = (message: string, code: number, wasHealthy: boolean) => {
      if (cancelled) return;
      setWebRtcInputReady(false);
      setWebRtcInputError(message);
      const schedule = scheduleReconnect({ code, wasHealthy, currentDelay: reconnectDelay });
      reconnectDelay = schedule.nextDelay;
      retryTimer = setTimeout(connect, schedule.retryIn);
    };

    function connect() {
      if (cancelled) return;
      let ws: WebSocket;
      try {
        ws = new WebSocket(inputUrl, socketProtocols);
      } catch {
        retryInput('WebRTC input connection failed. Retrying...', 1006, false);
        return;
      }
      wsRef.current = ws;
      ws.onopen = () => {
        if (cancelled) return;
        opened = true;
        reconnectDelay = RECONNECT_BASE_DELAY_MS;
        setWebRtcInputReady(true);
        setWebRtcInputError(null);
        ws.send(JSON.stringify({ type: 'reset-video', ack: false }));
      };
      ws.onerror = () => {
        // onclose owns retry scheduling.
      };
      ws.onclose = (event) => {
        if (cancelled) return;
        if (wsRef.current === ws) wsRef.current = null;
        const wasHealthy = opened;
        opened = false;
        if (wasHealthy && isDeliberateServerClose(event.code)) {
          // serve-emu stops the old video peer along with this control socket.
          // Renegotiate now instead of waiting for ICE loss and its grace period;
          // the new input socket alone must not make the old video read as live.
          restartWebRtcRef.current();
        }
        retryInput('WebRTC input disconnected. Retrying...', event.code, wasHealthy);
      };
      ws.onmessage = (event) => {
        if (cancelled || typeof event.data !== 'string') return;
        try {
          const message = JSON.parse(event.data) as { ok?: boolean; error?: string };
          if (message.ok === false && message.error) reportInputCommandError(message.error);
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
  }, [active, baseUrl, targetDevice, useWebRtc, socketProtocols, reportInputCommandError]);

  // ── Logcat (SSE, best-effort) — off by default; opt-in via attach ──
  useEffect(() => {
    if (!logsEnabled || !active || !baseUrl) return;
    let cancelled = false;
    let source: EventSource | null = null;
    try {
      source = new EventSource(
        withSessionTokenQuery(
          apiUrl(baseUrl, `/api/logcat${targetDevice ? `?device=${encodeURIComponent(targetDevice)}` : ''}`),
          token,
        ),
      );
    } catch (cause) {
      featureSession.read('logs').fail(cause);
      return;
    }
    source.onopen = () => featureSession.read('logs').ready();
    source.onerror = () => {
      if (!featureSession.read('logs').fail(new Error('Log subscription interrupted'), true))
        source?.close();
    };
    source.addEventListener('log', (event) => {
      if (cancelled) return;
      try {
        const data = JSON.parse((event as MessageEvent).data) as { line: string };
        setLogs((prev) =>
          [...prev, { id: `a${++logSeqRef.current}`, source: 'logcat', message: data.line }].slice(
            -MAX_LOGS,
          ),
        );
      } catch {}
    });
    return () => {
      cancelled = true;
      source?.close();
    };
  }, [logsEnabled, active, baseUrl, targetDevice, token, revisions.logs, featureSession]);

  // ── Activity metrics (SSE) ──
  useEffect(() => {
    activityLastSampleAtRef.current = 0;
    if (!active || !baseUrl || !activityEnabled) return;
    setActivity((current) => current ?? EMPTY_ANDROID_ACTIVITY);
    let cancelled = false;
    let source: EventSource;
    try {
      source = new EventSource(
        withSessionTokenQuery(deviceApiUrl(baseUrl, '/api/metrics', targetDevice), token),
      );
    } catch (cause) {
      featureSession.read('activity').fail(cause);
      setActivity({ ...EMPTY_ANDROID_ACTIVITY, errored: true });
      return;
    }
    const onFrame = (event: Event) => {
      if (cancelled) return;
      const frame = parseAndroidActivityFrame(event.type, String((event as MessageEvent).data));
      if (!frame) return;
      featureSession.read('activity').ready();
      if (frame.kind === 'meta') {
        setActivity((current) =>
          current ? { ...current, hostCores: frame.hostCores, errored: false } : current,
        );
        return;
      }
      activityLastSampleAtRef.current = Date.now();
      setActivity((current) =>
        appendActivitySample(current ?? EMPTY_ANDROID_ACTIVITY, frame.sample),
      );
    };
    source.addEventListener('meta', onFrame);
    source.addEventListener('message', onFrame);
    source.onopen = () => featureSession.read('activity').ready();
    source.onerror = () => {
      if (
        !featureSession.read('activity').fail(new Error('Metrics subscription interrupted'), true)
      )
        source.close();
    };
    const openedAt = Date.now();
    const watchdog = setInterval(() => {
      if (
        activityLastSampleAtRef.current === 0 &&
        Date.now() - openedAt > ANDROID_ACTIVITY_STALE_MS &&
        !featureSession.read('activity').isStopped()
      ) {
        featureSession.read('activity').fail(new Error('Metrics sampling timed out'));
        source.close();
      }
      setActivity((current) => {
        if (!current) return current;
        const clock = {
          openedAt,
          lastSampleAt: activityLastSampleAtRef.current,
          now: Date.now(),
        };
        return nextAndroidActivityAfterSilence(current, clock) ?? current;
      });
    }, 1000);
    return () => {
      cancelled = true;
      clearInterval(watchdog);
      source.close();
    };
  }, [
    active,
    baseUrl,
    targetDevice,
    token,
    activityEnabled,
    revisions.activity,
    featureSession,
  ]);

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
      if (cancelled || polling || featureSession.read('events').isStopped()) return;
      polling = true;
      controller = new AbortController();
      try {
        const response = await sessionFetch(url, { cache: 'no-store', signal: controller.signal });
        checkResponse(response);
        const snapshot = (await response.json()) as { events?: AndroidSessionEvent[] };
        if (cancelled) return;
        if (!Array.isArray(snapshot.events)) throw invalidResponse('Invalid events response');
        featureSession.read('events').ready();
        const snapshotEvents = snapshot.events;
        eventCursorRef.current = mergeAndroidEventSnapshotCursor(
          eventCursorRef.current,
          snapshotEvents,
        );
        setEvents((previous) =>
          reconcileAndroidSessionEvents(
            previous,
            snapshotEvents.filter((event) => event.id > eventCursorRef.current.clearedThroughId),
            serial,
          ),
        );
      } catch (cause) {
        if (!cancelled) featureSession.read('events').fail(cause, true);
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
  }, [
    eventsEnabled,
    active,
    baseUrl,
    targetDevice,
    sessionFetch,
    revisions.events,
    featureSession,
  ]);

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
    const read = () => {
      void sessionFetch(apiUrl(baseUrl, '/api/devices'))
        .then((r) => checkResponse(r).json())
        .then((data: { devices?: Array<Record<string, unknown>>; defaultSerial?: string }) => {
          if (cancelled) return;
          if (!Array.isArray(data.devices)) throw invalidResponse('Invalid device list');
          featureSession.read('devices').ready();
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
        .catch((cause) => {
          if (!cancelled) featureSession.read('devices').fail(cause);
        });
    };
    const unbind = featureSession.read('devices').bind(read);
    read();
    return () => {
      cancelled = true;
      unbind();
    };
  }, [active, baseUrl, targetDevice, sessionFetch, featureSession]);

  // ── Foreground app (best-effort) — serve-emu has no push channel for app
  //    switches, so poll `/api/foreground` (dumpsys window) on an interval. ──
  useEffect(() => {
    if (!active || !baseUrl) return;
    let cancelled = false;
    const url = `${apiUrl(baseUrl, '/api/foreground')}${
      targetDevice ? `?device=${encodeURIComponent(targetDevice)}` : ''
    }`;
    let polling = false;
    const poll = async () => {
      if (polling || cancelled || featureSession.read('foregroundApp').isStopped()) return;
      polling = true;
      try {
        const res = await sessionFetch(url, { cache: 'no-store' });
        checkResponse(res);
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
        if (cancelled) return;
        if (!data.ok) throw invalidResponse('Invalid foreground app response');
        featureSession.read('foregroundApp').ready();
        if (!data.app?.packageName) {
          setForegroundApp(null);
          return;
        }
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
        setForegroundApp((prev) =>
          prev && sameForegroundApp(prev, next) ? prev : carryForwardAppIcon(prev, next),
        );
      } catch (cause) {
        if (!cancelled) featureSession.read('foregroundApp').fail(cause, true);
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = setInterval(poll, FOREGROUND_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [active, baseUrl, targetDevice, sessionFetch, revisions.foregroundApp, featureSession]);

  const foregroundAppId = foregroundApp?.id ?? null;
  useEffect(() => {
    if (!active || !baseUrl || !foregroundAppId) return;
    let cancelled = false;
    fetchAndroidAppIcon(baseUrl, targetDevice, foregroundAppId, sessionFetch)
      .then((iconDataUrl) => {
        if (cancelled || !iconDataUrl) return;
        setForegroundApp((prev) =>
          prev && prev.id === foregroundAppId ? { ...prev, iconDataUrl } : prev,
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [active, baseUrl, targetDevice, foregroundAppId, sessionFetch]);

  // ── Device options (best-effort) ──
  // Keep Hub in sync with changes made on-device or through serve-emu's own UI.
  // Polling also makes network's aggregate wifi/data state authoritative.
  useEffect(() => {
    const tracker = deviceSettingWriteTrackerRef.current;
    tracker.reset();
    for (const key of ANDROID_DEVICE_SETTING_KEYS) deviceSettingVersionsRef.current[key]++;
    setDeviceSettingsPending(new Set());
    setDeviceSettings(null);
    setDisplayWidthDp(null);
    setHardwareKeyboardConnected(null);
    if (!active || !baseUrl) {
      return;
    }

    let cancelled = false;
    let polling = false;
    let controllers: AbortController[] = [];
    const scope = deviceScope;

    const poll = async (keys: readonly AndroidDeviceSettingKey[]) => {
      if (cancelled || polling || featureSession.read('deviceSettings').isStopped()) return;
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
            const response = await sessionFetch(
              deviceApiUrl(baseUrl, androidDeviceSettingPathFor(key), targetDevice),
              { cache: 'no-store', signal: controller.signal },
            );
            checkResponse(response);
            const payload: unknown = await response.json();
            return {
              key,
              version,
              pendingAtStart,
              handled: true as const,
              value: parseAndroidDeviceSetting(key, payload),
              payload,
            };
          } catch (cause) {
            return { key, version, pendingAtStart, handled: false as const, cause };
          }
        }),
      );
      polling = false;
      if (cancelled || deviceScopeRef.current !== scope) return;
      if (!results.some((result) => result.handled)) {
        featureSession
          .read('deviceSettings')
          .fail(
            results.find((result) => !result.handled)?.cause ??
              new Error('Device settings read failed'),
            true,
          );
        return;
      }
      // Each key has its own route. One failing key keeps its last value (or
      // hides, when the route is missing) instead of disabling every option.
      featureSession.read('deviceSettings').ready();
      setDeviceSettings((current) => {
        const next = { ...(current ?? {}) };
        for (const result of results) {
          // A write that started or finished during this read owns the value.
          if (result.pendingAtStart) continue;
          if (deviceSettingVersionsRef.current[result.key] !== result.version) continue;
          if (tracker.pending.has(result.key)) continue;
          if (!result.handled) {
            if (hubError(result.cause).code === 'unsupported') delete next[result.key];
            continue;
          }
          if (result.value === null) delete next[result.key];
          else next[result.key] = result.value;
        }
        // An unchanged poll keeps the same object, so the client does not re-render.
        return sameDeviceSettings(current, next) ? current : next;
      });
      const displaySizeResult = results.find((result) => result.key === 'display-size');
      if (
        displaySizeResult &&
        !displaySizeResult.pendingAtStart &&
        deviceSettingVersionsRef.current['display-size'] === displaySizeResult.version &&
        !tracker.pending.has('display-size')
      ) {
        setDisplayWidthDp(
          displaySizeResult.handled
            ? androidDisplayWidthDpFromPayload(displaySizeResult.payload)
            : null,
        );
      }
    };

    // Appearance keeps its historical one-shot read because the pinned
    // serve-emu branch still implements `/api/uimode` synchronously. Network
    // and font scale use Hub's async compatibility routes and stay live-polled.
    const unbind = featureSession.read('deviceSettings').bind(() => {
      void poll(ANDROID_DEVICE_SETTING_KEYS);
    });
    void poll(ANDROID_DEVICE_SETTING_KEYS);
    // Read once: an emulator's hardware keyboard does not come and go, and the
    // settings poll already spawns one adb read per key every few seconds.
    const readKeyboard = () => {
      void sessionFetch(deviceApiUrl(baseUrl, '/api/software-keyboard', targetDevice), {
        cache: 'no-store',
      })
        .then((response) => checkResponse(response).json())
        .then((payload: unknown) => {
          if (cancelled || deviceScopeRef.current !== deviceScope) return;
          const status = (payload as { softwareKeyboard?: { hardwareKeyboard?: unknown } } | null)
            ?.softwareKeyboard;
          if (typeof status?.hardwareKeyboard === 'boolean') {
            setHardwareKeyboardConnected(status.hardwareKeyboard);
            featureSession.read('keyboard').ready();
          } else featureSession.read('keyboard').unsupported();
        })
        .catch((cause) => {
          if (!cancelled) featureSession.read('keyboard').fail(cause);
        });
    };
    const unbindKeyboard = featureSession.read('keyboard').bind(readKeyboard);
    readKeyboard();
    const timer = setInterval(
      () => void poll(ANDROID_POLLED_DEVICE_SETTING_KEYS),
      DEVICE_SETTINGS_POLL_MS,
    );
    return () => {
      cancelled = true;
      clearInterval(timer);
      for (const controller of controllers) controller.abort();
      unbind();
      unbindKeyboard();
      tracker.reset();
    };
  }, [active, baseUrl, deviceScope, targetDevice, sessionFetch, featureSession]);

  const webRtcAvailable = serverStreamSettings?.transport === 'webrtc';
  const streamCapabilities = useMemo<DeviceStreamCapabilities>(
    () => ({
      modeAvailability: { mjpeg: false, h264: true, webrtc: webRtcAvailable },
      httpCodecs: ANDROID_STREAM_CODECS,
      webRtcCodecs: ANDROID_STREAM_CODECS,
    }),
    [webRtcAvailable],
  );
  const accessibilityAvailable = accessibilityLoader !== null;
  const permissionsAvailable = permissionsBackend !== null;
  const capabilities = useMemo<DeviceCapabilities>(
    () => ({
      deviceSettings: true,
      activity: true,
      events: true,
      camera: cameraSupported,
      accessibility: accessibilityAvailable,
      location: locationCapabilities,
      permissions: permissionsAvailable,
      streamSettings: ANDROID_STREAM_SETTING_CAPABILITIES,
    }),
    [cameraSupported, accessibilityAvailable, locationCapabilities, permissionsAvailable],
  );

  useLayoutEffect(() => {
    setLogs([]);
    setActivity(null);
    setForegroundApp(null);
    setScreen(null);
  }, [featureSession]);

  const backend: BackendDeviceClient = {
    platform: 'android',
    // The transport can stay live while the server stages new stream settings.
    // Show the pending change immediately without feeding it back into the
    // switch tracker, which must observe the actual interruption and recovery.
    status:
      status === 'streaming' && (isStreamSwitchPending(streamSwitch) || streamSettingsPending)
        ? 'reconnecting'
        : status,
    error,
    // A down WebRTC input socket outranks one refused command.
    inputError: webRtcInputError ?? inputCommandError,
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
    displayWidthDp,
    camera,
    cameraPending,
    cameraError,
    setCameraImage,
    clearCameraImage,
    ...accessibilityState,
    location,
    locationPending,
    locationError,
    setLocation,
    clearLocation,
    ...appPermissions,
    streamSettings,
    streamSettingsPending:
      streamSettingsPending || streamSourceLoading || isStreamSwitchPending(streamSwitch),
    updateStreamSettings,
    streamSource,
    screenRecording:
      recordingSnapshot.scope === deviceScope
        ? recordingSnapshot.status
        : active
          ? 'unknown'
          : null,
    streamSourcePending: streamSourceLoading || isStreamSwitchPending(streamSwitch),
    streamSourceError,
    setStreamSource,
    setGrpcImageMode,
    setGrpcEncoder,
    setGrpcInputSource,
    streamStats,
    setStreamStatsEnabled,
    webRtcCodec: 'h264',
    setWebRtcCodec: noop,
    streamCapabilities,
    capabilities,
    foregroundApp,
    videoKind: useWebRtc ? 'video' : 'canvas',
    attachVideo,
    sendTouch,
    sendMultiTouch,
    sendKey,
    pressButton,
    reload,
    rotate,
    screenshot,
    hardwareKeyboardConnected,
    setHardwareKeyboardConnected: noop,
    toggleSoftwareKeyboard: noop,
  };
  return useFeatureClient(backend, {
    active,
    session: featureSession,
    activityEnabled,
    setActivityEnabled,
    updateSource: async (patch) => {
      const previous = streamSourceRef.current;
      if (!previous)
        throw new HubRequestError('Capture source is not loaded', undefined, 'busy');
      await putStreamMode({ mode: patch.mode ?? previous.mode, ...patch });
    },
    permissionsAppId: appPermissions.permissionsAppId,
    permissionsCurrent: appPermissions.permissionsCurrent,
  });
}
