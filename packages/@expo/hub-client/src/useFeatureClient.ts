import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { BackendDeviceClient } from './backend-client';
import { failure, hubError, type FeatureSession } from './feature-state';
import type {
  DeviceClient,
  Feature,
  FeatureState,
  HubResult,
  StreamSourcePatch,
  Writes,
} from './types';

const NO_TRANSPORTS = {
  modeAvailability: { mjpeg: false, h264: false, webrtc: false },
  httpCodecs: [],
  webRtcCodecs: [],
} as const;
const noop = () => {};
const EMPTY_WRITES: Writes<string> = { pending: new Set(), errors: new Map() };

/** Shallow memoization keeps unrelated sections stable while video frames update. */
function useFeature<D, E extends object>(state: FeatureState<D>, extra: E): Feature<D> & E {
  const value = { ...state, ...extra } as Feature<D> & E;
  const ref = useRef(value);
  const previous = ref.current;
  if (
    Object.keys(value).some(
      (key) => !Object.is(value[key as keyof typeof value], previous[key as keyof typeof value]),
    )
  )
    ref.current = value;
  return ref.current;
}

export interface FeatureClientOptions {
  active: boolean;
  session: FeatureSession;
  activityEnabled: boolean;
  setActivityEnabled(enabled: boolean): void;
  updateSource?: (patch: StreamSourcePatch) => Promise<unknown>;
  permissionsAppId?: string | null;
  permissionsCurrent?: boolean;
}

export function useFeatureClient(
  raw: BackendDeviceClient,
  options: FeatureClientOptions,
): DeviceClient {
  const { session, active } = options;
  const [statsEnabled, setStatsEnabled] = useState(false);
  const latest = useRef({ raw, options, statsEnabled });
  useLayoutEffect(() => {
    latest.current = { raw, options, statsEnabled };
  });
  const actions = useMemo(() => {
    const refresh = (name: string) => () => {
      const { options: o } = latest.current;
      if (!o.active) return;
      if (o.session.getWrites(name).pending.size > 0) return;
      const current = latest.current;
      if (
        (name === 'logs' && !current.raw.logsEnabled) ||
        (name === 'events' && !current.raw.eventsEnabled) ||
        (name === 'activity' && !o.activityEnabled) ||
        (name === 'streamStats' && !current.statsEnabled)
      )
        return;
      o.session.read(o.session.resolved ? name : 'config').refresh();
    };
    const write = (
      name: string,
      keys: string[],
      run: (r: BackendDeviceClient, o: FeatureClientOptions) => unknown,
    ): Promise<HubResult> => {
      const { raw: r, options: o } = latest.current;
      if (!o.active) return Promise.resolve(failure('unsupported', 'No device selected'));
      if (!o.session.resolved)
        return Promise.resolve(failure('busy', 'Device configuration is still loading', true));
      // Camera and location match the support rules their feature state uses.
      const support =
        name === 'keyboard'
          ? r.platform === 'ios'
          : name === 'streamSource'
            ? !!o.updateSource
            : name === 'camera'
              ? r.platform === 'android'
              : name === 'location'
                ? r.platform === 'android' || !!r.capabilities.location
                : name in r.capabilities
                  ? r.capabilities[name as keyof typeof r.capabilities]
                  : true;
      if (!support)
        return Promise.resolve(failure('unsupported', 'This feature is unavailable'));
      if (
        (name === 'streamSettings' || name === 'streamSource') &&
        (o.session.getWrites('streamSource').pending.size ||
          o.session.getWrites('streamSettings').pending.size ||
          r.streamSourcePending)
      )
        return Promise.resolve(failure('busy', 'A stream update is already in progress', true));
      if (name === 'permissions' && (!o.permissionsCurrent || !o.permissionsAppId))
        return Promise.resolve(failure('busy', 'The foreground app is changing', true));
      const read = o.session.read(name);
      if (read.status === 'unsupported')
        return Promise.resolve(failure('unsupported', 'This feature is unavailable'));
      if (!read.loaded)
        return Promise.resolve(failure('busy', 'Feature data is still loading', true));
      return o.session.write(name, keys, () => run(r, o));
    };
    return {
      refresh: Object.fromEntries(
        [
          'stream',
          'streamSettings',
          'streamSource',
          'streamStats',
          'screenRecording',
          'devices',
          'foregroundApp',
          'logs',
          'events',
          'activity',
          'deviceSettings',
          'keyboard',
          'camera',
          'accessibility',
          'location',
          'permissions',
          'input',
        ].map((name) => [name, refresh(name)]),
      ),
      setSetting: ((key, value) =>
        write('deviceSettings', [key], (r) =>
          r.setDeviceSetting(key, value),
        )) as DeviceClient['deviceSettings']['set'],
      updateSettings: ((patch) =>
        write('streamSettings', Object.keys(patch), (r) =>
          r.updateStreamSettings(patch),
        )) as DeviceClient['streamSettings']['update'],
      updateSource: ((patch) =>
        write(
          'streamSource',
          Object.keys(patch),
          (_, o) =>
            o.updateSource?.(patch) ??
            Promise.reject({
              code: 'unsupported',
              message: 'Capture switching is unavailable',
              retryable: false,
            }),
        )) as DeviceClient['streamSource']['update'],
      setKeyboard: ((connected) =>
        write('keyboard', ['hardwareConnected'], (r) =>
          r.setHardwareKeyboardConnected(connected),
        )) as DeviceClient['keyboard']['setHardwareConnected'],
      setImage: ((facing, png) =>
        write('camera', [facing], (r) =>
          r.setCameraImage(facing, png),
        )) as DeviceClient['camera']['setImage'],
      clearImage: ((facing) =>
        write('camera', [facing], (r) =>
          r.clearCameraImage(facing),
        )) as DeviceClient['camera']['clearImage'],
      setLocation: ((fix) =>
        write('location', ['fix'], (r) => r.setLocation(fix))) as DeviceClient['location']['set'],
      clearLocation: () =>
        write('location', ['fix'], (r) => {
          if (!r.capabilities.location || !r.capabilities.location.clear)
            throw {
              code: 'unsupported',
              message: 'Clearing location is unavailable',
              retryable: false,
            };
          return r.clearLocation();
        }),
      setPermission: ((id, action) =>
        write('permissions', [id], (r) =>
          r.setPermission(id, action),
        )) as DeviceClient['permissions']['set'],
      resetPermissions: () =>
        write(
          'permissions',
          (latest.current.raw.permissions ?? []).map((p) => p.id),
          (r) => r.resetPermissions(),
        ),
      attachLogs: () => latest.current.raw.attachLogs(),
      detachLogs: () => latest.current.raw.detachLogs(),
      clearLogs: () => latest.current.raw.clearLogs(),
      attachEvents: () => latest.current.raw.attachEvents(),
      detachEvents: () => latest.current.raw.detachEvents(),
      clearEvents: () => latest.current.raw.clearEvents(),
      attachActivity: () => latest.current.options.setActivityEnabled(true),
      detachActivity: () => latest.current.options.setActivityEnabled(false),
      attachStats: () => {
        setStatsEnabled(true);
        latest.current.raw.setStreamStatsEnabled(true);
      },
      detachStats: () => {
        setStatsEnabled(false);
        latest.current.raw.setStreamStatsEnabled(false);
      },
      attachVideo: ((el) =>
        latest.current.raw.attachVideo(el)) as DeviceClient['stream']['attachVideo'],
      setWebRtcCodec: ((codec) =>
        latest.current.raw.setWebRtcCodec(codec)) as DeviceClient['stream']['setWebRtcCodec'],
      toggleSoftware: () => latest.current.raw.toggleSoftwareKeyboard(),
      screenshot: async () => {
        if (!latest.current.options.active) return failure('unsupported', 'No device selected');
        try {
          const shot = await latest.current.raw.screenshot();
          return shot
            ? { ok: true as const, value: shot }
            : failure('network', 'Screenshot capture failed', true);
        } catch (cause) {
          return { ok: false as const, error: hubError(cause) };
        }
      },
    };
  }, []);

  const state = <D>(
    name: string,
    supported: boolean,
    data: D | undefined,
    enabled = true,
  ): FeatureState<D> => {
    if (!active) return { status: 'unsupported', data: undefined, error: null };
    const config = session.read('config');
    if (!session.resolved) {
      if (config.error)
        return {
          status: config.status === 'reconnecting' ? 'reconnecting' : 'error',
          data: undefined,
          error: config.error,
        };
      return { status: 'resolving', data: undefined, error: null };
    }
    const read = session.read(name);
    if (!supported || read.status === 'unsupported')
      return { status: 'unsupported', data: undefined, error: null };
    const retained = read.loaded ? data : undefined;
    if (!enabled || read.status === 'idle') return { status: 'idle', data: retained, error: null };
    if (read.error)
      return {
        status: read.status === 'reconnecting' ? 'reconnecting' : 'error',
        data: retained,
        error: read.error,
      };
    if (read.status === 'ready' && data !== undefined)
      return { status: 'ready', data, error: null };
    return { status: 'loading', data: retained, error: null };
  };
  const writes = <K extends string>(name: string) => session.getWrites(name) as Writes<K>;
  const streamData = useMemo(() => ({ screen: raw.screen, fps: raw.fps }), [raw.screen, raw.fps]);
  const streamError = useMemo(() => hubError(raw.error ?? 'Stream interrupted'), [raw.error]);
  let streamState = state('stream', true, streamData);
  // Painted video is ready on its own. Android's WebSocket video does not need
  // `/api`, so a discovery failure must not hide a stream that is playing.
  if (active && raw.status === 'streaming')
    streamState = { status: 'ready', data: streamData, error: null };
  else if (active && session.resolved) {
    streamState =
      raw.status === 'error' || raw.status === 'reconnecting'
          ? {
              status: raw.status,
              data: raw.screen ? streamData : undefined,
              error: streamError,
            }
          : { status: 'loading', data: undefined, error: null };
  }
  const stream = useFeature(streamState, {
    refresh: actions.refresh.stream,
    videoKind: raw.videoKind,
    attachVideo: actions.attachVideo,
    transports: raw.streamCapabilities ?? NO_TRANSPORTS,
    webRtcCodec: raw.webRtcCodec,
    setWebRtcCodec: actions.setWebRtcCodec,
  });
  const editableKeys = Object.keys(raw.capabilities.streamSettings || {}).join(',');
  const editable = useMemo(
    () =>
      new Set(
        editableKeys
          ? (editableKeys.split(',') as (keyof NonNullable<
              BackendDeviceClient['streamSettings']
            >)[])
          : [],
      ),
    [editableKeys],
  );
  const streamSettings = useFeature(
    state('streamSettings', !!raw.capabilities.streamSettings, raw.streamSettings ?? undefined),
    {
      refresh: actions.refresh.streamSettings,
      editable,
      writes: writes<keyof NonNullable<BackendDeviceClient['streamSettings']>>('streamSettings'),
      update: actions.updateSettings,
    },
  );
  const streamSource = useFeature(
    state('streamSource', raw.platform === 'android', raw.streamSource ?? undefined),
    {
      refresh: actions.refresh.streamSource,
      writes: writes<keyof StreamSourcePatch>('streamSource'),
      update: actions.updateSource,
    },
  );
  const streamStats = useFeature(
    state('streamStats', raw.videoKind === 'video', raw.streamStats ?? undefined, statsEnabled),
    {
      refresh: actions.refresh.streamStats,
      enabled: statsEnabled,
      attach: actions.attachStats,
      detach: actions.detachStats,
    },
  );
  const screenRecording = useFeature(
    state(
      'screenRecording',
      raw.platform === 'android' && raw.screenRecording !== null,
      raw.screenRecording === 'unknown' ? undefined : (raw.screenRecording ?? undefined),
    ),
    { refresh: actions.refresh.screenRecording },
  );
  const devices = useFeature(state('devices', true, raw.devices), {
    refresh: actions.refresh.devices,
  });
  const foregroundApp = useFeature(state('foregroundApp', true, raw.foregroundApp), {
    refresh: actions.refresh.foregroundApp,
  });
  const logs = useFeature(state('logs', true, raw.logs, raw.logsEnabled), {
    refresh: actions.refresh.logs,
    enabled: raw.logsEnabled,
    attach: actions.attachLogs,
    detach: actions.detachLogs,
    clear: actions.clearLogs,
  });
  const events = useFeature(
    state('events', raw.capabilities.events, raw.events, raw.eventsEnabled),
    {
      refresh: actions.refresh.events,
      enabled: raw.eventsEnabled,
      attach: actions.attachEvents,
      detach: actions.detachEvents,
      clear: actions.clearEvents,
    },
  );
  const activityData = useMemo(
    () =>
      raw.activity
        ? {
            hostCores: raw.activity.hostCores,
            samples: raw.activity.samples,
            stale: raw.activity.stale,
          }
        : undefined,
    [raw.activity],
  );
  const activity = useFeature(
    state('activity', raw.capabilities.activity, activityData, options.activityEnabled),
    {
      refresh: actions.refresh.activity,
      enabled: options.activityEnabled,
      attach: actions.attachActivity,
      detach: actions.detachActivity,
    },
  );
  const settingsData = useMemo(
    () =>
      raw.deviceSettings
        ? { values: raw.deviceSettings, displayWidthDp: raw.displayWidthDp }
        : undefined,
    [raw.deviceSettings, raw.displayWidthDp],
  );
  const deviceSettings = useFeature(
    state('deviceSettings', raw.capabilities.deviceSettings, settingsData),
    {
      refresh: actions.refresh.deviceSettings,
      writes: writes<Parameters<DeviceClient['deviceSettings']['set']>[0]>('deviceSettings'),
      set: actions.setSetting,
    },
  );
  const keyboardData = useMemo(
    () =>
      raw.hardwareKeyboardConnected === null
        ? undefined
        : { hardwareConnected: raw.hardwareKeyboardConnected },
    [raw.hardwareKeyboardConnected],
  );
  const keyboard = useFeature(state('keyboard', true, keyboardData), {
    refresh: actions.refresh.keyboard,
    writes: writes<'hardwareConnected'>('keyboard'),
    setHardwareConnected: actions.setKeyboard,
    toggleSoftware: actions.toggleSoftware,
  });
  const camera = useFeature(state('camera', raw.platform === 'android', raw.camera ?? undefined), {
    refresh: actions.refresh.camera,
    writes: writes<Parameters<DeviceClient['camera']['setImage']>[0]>('camera'),
    setImage: actions.setImage,
    clearImage: actions.clearImage,
  });
  const accessibility = useFeature(
    state('accessibility', raw.capabilities.accessibility, raw.accessibility ?? undefined),
    { refresh: actions.refresh.accessibility },
  );
  const location = useFeature(
    state('location', raw.platform === 'android' || !!raw.capabilities.location, raw.location),
    {
      refresh: actions.refresh.location,
      canClear: !!raw.capabilities.location && !!raw.capabilities.location.clear,
      writes: writes<'fix'>('location'),
      set: actions.setLocation,
      clear: actions.clearLocation,
    },
  );
  const inputData = useMemo(() => ({ rejected: raw.inputRejected }), [raw.inputRejected]);
  let inputState = state('input', true, inputData);
  if (active && session.resolved)
    inputState =
      raw.input.status === 'ready'
        ? { status: 'ready', data: inputData, error: null }
        : ({ status: raw.input.status, data: inputData, error: raw.input.error } as FeatureState<
            typeof inputData
          >);
  const input = useFeature(inputState, { refresh: actions.refresh.input });
  const permissionsData = useMemo(
    () => ({
      appId: options.permissionsAppId ?? raw.foregroundApp?.id ?? null,
      items: raw.permissions ?? [],
    }),
    [options.permissionsAppId, raw.foregroundApp?.id, raw.permissions],
  );
  const permissionsState = state('permissions', raw.capabilities.permissions, permissionsData);
  const permissions = useFeature(
    options.permissionsCurrent === false &&
      active &&
      session.resolved &&
      raw.capabilities.permissions
      ? { status: 'loading', data: undefined, error: null }
      : permissionsState,
    {
      refresh: actions.refresh.permissions,
      writes: options.permissionsCurrent === false ? EMPTY_WRITES : writes<string>('permissions'),
      set: actions.setPermission,
      reset: actions.resetPermissions,
    },
  );
  return useMemo(
    (): DeviceClient => ({
      platform: raw.platform,
      stream,
      streamSettings,
      streamSource,
      streamStats,
      screenRecording,
      devices,
      foregroundApp,
      logs,
      events,
      activity,
      deviceSettings,
      keyboard,
      camera,
      accessibility,
      location,
      permissions,
      input,
      sendTouch: raw.sendTouch,
      sendMultiTouch: raw.sendMultiTouch ?? noop,
      sendKey: raw.sendKey,
      sendKeyEvents: raw.sendKeyEvents,
      sendScroll: raw.sendScroll,
      pressButton: raw.pressButton,
      reload: raw.reload,
      rotate: raw.rotate,
      screenshot: actions.screenshot,
    }),
    [
      raw.platform,
      stream,
      streamSettings,
      streamSource,
      streamStats,
      screenRecording,
      devices,
      foregroundApp,
      logs,
      events,
      activity,
      deviceSettings,
      keyboard,
      camera,
      accessibility,
      location,
      permissions,
      input,
      raw.sendTouch,
      raw.sendMultiTouch,
      raw.sendKey,
      raw.sendKeyEvents,
      raw.sendScroll,
      raw.pressButton,
      raw.reload,
      raw.rotate,
      actions.screenshot,
    ],
  );
}
