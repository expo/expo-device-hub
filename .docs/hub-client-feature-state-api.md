# Hub client: one async state model for every feature

Status: draft for review. No code is changed yet.

Package: `@expo/hub-client`. Based on `1.2.0` (`src/types.ts`, `src/useIosDevice.ts`, `src/useAndroidDevice.ts`).

This draft extends the proposal "Hub client: explicit state for metrics and device settings". That proposal covers `activity` and `deviceSettings` only. This draft applies one model to every feature that the client reads from the backend.

## Problem

The UI cannot tell loading, unsupported, and failed states apart. Each feature reports its state in a different way:

- `null` means "config not loaded", "not supported", "read in progress", or "read failed".
- Some features have `*Pending`, some have `*Error`, some have `*Enabled`, and some have no signal.
- `capabilities.*` is `false` before the config loads and also when the backend does not have the feature.
- `client.status` shows the video state only. The UI waits for the first video frame, also for data that does not need video.

### Example: device settings

Before, the UI could not tell "loading" from "failed to load".

- iOS: the first `hostUiRequest` status read ignores its error (`.catch(() => {})`). While the read runs, and after it fails, `deviceSettings === null` and `capabilities.deviceSettings === true`. The client does not try again.
- Android: `capabilities.deviceSettings` is always `true`. A poll where every key fails returns with no change (`if (!results.some((result) => result.handled)) return;`). `deviceSettings` stays `null`, and the client keeps polling.

```ts
// Before: the best a UI can do
const { deviceSettings, capabilities } = client;
if (!capabilities.deviceSettings) return <Unavailable />; // also true before the config loads
if (deviceSettings === null) return <Spinner />;          // loading or failed: not known
return <SettingsRows values={deviceSettings} />;
```

## Review of the original proposal

The proposal uses a discriminated union with one `status` per feature. That idea is correct. These items must change before the idea works for all features:

1. **Two sets of status names.** Settings use `loading` / `ready`. Metrics use `connecting` / `connected` / `interrupted`. Use one set for all features.
2. **`pending` has two meanings.** `status: 'pending'` means "support not known". `pending: ReadonlySet` means "writes in progress", as do all current `*Pending` fields. Rename the status to `resolving`.
3. **Data is in different places.** Settings use `values`. Metrics use `hostCores` / `samples`. Metrics keep their data in `error`, but settings lose it. Put data at `data` in every status, and keep the last data when a read or connection fails.
4. **Actions are in different places.** `refresh` and `retry` are inside union members. `setDeviceSetting` stays on the client. Keep only `refresh`, and put all methods on the feature object in every status.
5. **Rejected promises.** `setDeviceSetting` rejects on failure. A click handler without `catch` then gives an unhandled rejection. Return `HubResult` instead. Define a result for a write that the client ignores today (same key already in progress).
6. **`error: string` is not sufficient.** The retry limit must tell auth failures from network failures. Add `code` and `retryable`.
7. **No automatic-retry state for settings.** Android polls settings and tries again after a failure. That is `reconnecting`, not `error`.
8. **`hostCores: number` is too strict.** Android adds a sample without an earlier `meta` event (`appendActivitySample(current ?? EMPTY_ANDROID_ACTIVITY, …)`). Keep `number | null`.
9. **`unsupported` can come after a read.** Android camera (`cameraSupported`) and Android location (`read.supported`) know support only after the first read.

## Rules for every feature

1. Every value that the client reads from the backend is a `Feature`. All features use the same 7 statuses.
2. `data` and `error` are on every status. The UI can read them without a status check. Data stays when the feature reloads, reconnects, or fails.
3. Every feature has `refresh()`. Each method keeps the same identity for the life of the client. You can call each method in every status.
4. Every write returns `Promise<HubResult>`. The promise never rejects. The UI shows the new value at once. If the write fails, the value from the backend comes back, and the error goes into `writes.errors`.
5. Every writable feature has `writes: { pending, errors }`, with one key for each value that can change.
6. A feature object gets a new identity only when that feature changes, so `React.memo` can skip sections that did not change.
7. Live streams (logs, events, activity, stream stats) are opt-in. They stay `idle` until `attach()`.
8. Background polls do not change the status while they succeed. Only `refresh()` sets `loading`.
9. Local viewer choices (`webRtcCodec`, stream transports) are plain values, not features.

### Statuses

| `status` | Meaning | `data` | `error` |
|---|---|---|---|
| `resolving` | The config is not loaded. Support is not known. | `undefined` | `null` |
| `unsupported` | The backend confirmed that it does not have this feature. This can follow `loading`. | `undefined` | `null` |
| `idle` | Supported, but not requested: a live stream that is not attached, or a read on request that did not run. | last data or `undefined` | `null` |
| `loading` | The first read, a `refresh()`, or the first subscribe is in progress. | last data or `undefined` | `null` |
| `ready` | Data is available. | data | `null` |
| `reconnecting` | A connection or poll failed. The client tries again automatically. | last data or `undefined` | `HubError` |
| `error` | The client stopped trying (retry limit, or `retryable: false`). Call `refresh()`. | last data or `undefined` | `HubError` |

The no-op client (no device selected) returns every feature as `unsupported`. Today it returns all capabilities as `false`, which has the same effect.

## Before (current `1.2.0`)

Doc comments are shortened. All members are the same as in `src/types.ts`.

```ts
export type ConnectionStatus = 'idle' | 'connecting' | 'reconnecting' | 'streaming' | 'error';
export type DeviceScreenRecordingStatus = 'unknown' | 'waiting' | 'recording' | 'finalizing' | 'complete' | 'failed';

export interface DeviceActivity {
  hostCores: number | null;
  samples: DeviceActivitySample[];
  errored: boolean;
  stale: boolean;
}

export type DeviceStreamSettingCapabilities =
  | false
  | Readonly<Partial<Record<keyof DeviceStreamEncoderSettings, true>>>;
export type DeviceLocationCapabilities = false | Readonly<{ clear?: true }>;

export interface DeviceCapabilities {
  deviceSettings: boolean;
  activity: boolean;
  events: boolean;
  camera: boolean;
  accessibility: boolean;
  streamSettings: DeviceStreamSettingCapabilities;
  location: DeviceLocationCapabilities;
  permissions: boolean;
}

export interface DeviceClient {
  platform: DevicePlatform;
  status: ConnectionStatus;
  error: string | null;
  screenRecording: DeviceScreenRecordingStatus | null;
  screen: ScreenSize | null;
  fps: number;
  devices: RunningDevice[];

  logs: DeviceLog[];
  logsEnabled: boolean;
  attachLogs: () => void;
  detachLogs: () => void;
  clearLogs: () => void;

  events: DeviceEvent[];
  eventsEnabled: boolean;
  attachEvents: () => void;
  detachEvents: () => void;
  clearEvents: () => void;

  activity: DeviceActivity | null;

  deviceSettings: DeviceSettings | null;
  deviceSettingsPending: ReadonlySet<DeviceSettingKey>;
  setDeviceSetting: (key: DeviceSettingKey, value: string) => void;
  displayWidthDp: number | null;

  camera: DeviceCameraStatus | null;
  cameraPending: ReadonlySet<DeviceCameraFacing>;
  cameraError: string | null;
  setCameraImage: (facing: DeviceCameraFacing, png: Blob) => void;
  clearCameraImage: (facing: DeviceCameraFacing) => void;

  accessibility: AccessibilitySnapshot | null;
  accessibilityPending: boolean;
  accessibilityError: string | null;
  refreshAccessibility: () => void;

  location: DeviceGeoFix | null;
  locationPending: boolean;
  locationError: string | null;
  setLocation: (fix: DeviceGeoFix) => void;
  clearLocation: () => void;

  permissions: readonly AppPermission[] | null;
  permissionsPending: ReadonlySet<string>;
  permissionsError: string | null;
  setPermission: (id: string, action: AppPermissionAction) => void;
  resetPermissions: () => void;
  refreshPermissions: () => void;

  streamCapabilities: DeviceStreamCapabilities | null;
  streamSettings: DeviceStreamEncoderSettings | null;
  streamSettingsPending: boolean;
  updateStreamSettings: (patch: Partial<DeviceStreamEncoderSettings>) => void;
  streamSource: DeviceStreamSourceStatus | null;
  streamSourcePending: boolean;
  streamSourceError: string | null;
  setStreamSource: (source: DeviceStreamSource) => void;
  setGrpcImageMode: (mode: DeviceGrpcImageMode) => void;
  setGrpcEncoder: (encoder: DeviceGrpcEncoder) => void;
  setGrpcInputSource: (source: DeviceInputSource) => void;
  streamStats: DeviceStreamStats | null;
  setStreamStatsEnabled: (enabled: boolean) => void;
  webRtcCodec: DeviceWebRtcCodec;
  setWebRtcCodec: (codec: DeviceWebRtcCodec) => void;

  capabilities: DeviceCapabilities;
  foregroundApp: ForegroundApp | null;

  videoKind: VideoSurfaceKind;
  attachVideo: (el: HTMLCanvasElement | HTMLImageElement | HTMLVideoElement | null) => void;
  sendTouch: (sample: TouchSample) => void;
  sendMultiTouch?: (sample: MultiTouchSample) => void;
  sendKey: (input: KeyboardInput) => boolean;
  sendKeyEvents?: (events: ReadonlyArray<HidKeyEvent>) => void;
  sendScroll?: (sample: ScrollSample) => void;
  pressButton: (button: HardwareButton) => void;
  reload: () => void;
  rotate: () => void;
  screenshot: () => Promise<ScreenshotCapture | null>;

  appearance: DeviceAppearance | null;
  setAppearance: (mode: DeviceAppearance) => void;
  hardwareKeyboardConnected: boolean | null;
  setHardwareKeyboardConnected: (connected: boolean) => void;
  toggleSoftwareKeyboard: () => void;
}
```

The client has 75 top-level members. Loading and error state uses 7 different patterns: `null`, `*Pending`, `*Enabled`, `*Error`, `capabilities.*`, `errored`, and no signal at all.

## After (draft)

```ts
// ── Shared building blocks ────────────────────────────────────────────

export interface HubError {
  code: 'unsupported' | 'busy' | 'network' | 'timeout' | 'auth' | 'rejected' | 'invalid-response';
  message: string;
  /** False when a retry cannot fix the cause. */
  retryable: boolean;
}

/** Writes and one-shot requests never reject. */
export type HubResult<T = void> = { ok: true; value: T } | { ok: false; error: HubError };

export type FeatureState<D> =
  | { status: 'resolving';    data: undefined;     error: null }     // config not loaded
  | { status: 'unsupported';  data: undefined;     error: null }     // backend confirmed: not available
  | { status: 'idle';         data: D | undefined; error: null }     // supported, not attached / not requested
  | { status: 'loading';      data: D | undefined; error: null }     // first read, refresh, or subscribe
  | { status: 'ready';        data: D;             error: null }
  | { status: 'reconnecting'; data: D | undefined; error: HubError } // automatic retry
  | { status: 'error';        data: D | undefined; error: HubError };// needs refresh()

export type Feature<D, Extra = {}> = FeatureState<D> & {
  /** Read again or reconnect now. No-op while `resolving`, `unsupported`, or detached. */
  refresh: () => void;
} & Extra;

export interface Writes<K extends string> {
  pending: ReadonlySet<K>;
  /** Last failed write per key. Cleared when the next write of that key starts. */
  errors: ReadonlyMap<K, HubError>;
}

/** Live streams stay `idle` until `attach()`. `detach()` keeps the data. */
export interface Attachable {
  attach: () => void;
  detach: () => void;
}

// ── Feature data ──────────────────────────────────────────────────────

export interface StreamData {
  /** Null until the backend reports the size. */
  screen: ScreenSize | null;
  fps: number;
}

/** Changed: `errored` moves to `status`. */
export interface DeviceActivity {
  hostCores: number | null;
  /** Empty while only system apps are in front. */
  samples: readonly DeviceActivitySample[];
  /** No new sample for ACTIVITY_STALE_MS after at least one sample. */
  stale: boolean;
}

export interface DeviceSettingsData {
  /** `values.appearance` replaces `client.appearance`. */
  values: DeviceSettings;
  displayWidthDp: number | null;
}

export interface AppPermissionsData {
  /** Null when no app is in front. A new id sets the status to `loading`. */
  appId: string | null;
  items: readonly AppPermission[];
}

export type StreamSourcePatch = Partial<
  Pick<DeviceStreamSourceStatus, 'mode' | 'grpcImageMode' | 'encoder' | 'inputSource'>
>;

/** Today's `'unknown'` becomes `loading`; `null` becomes `unsupported`. */
export type ScreenRecordingPhase = 'waiting' | 'recording' | 'finalizing' | 'complete' | 'failed';

// ── Client ────────────────────────────────────────────────────────────

export interface DeviceClient {
  platform: DevicePlatform;

  // Video
  stream: Feature<StreamData, {
    videoKind: VideoSurfaceKind;
    attachVideo: (el: HTMLCanvasElement | HTMLImageElement | HTMLVideoElement | null) => void;
    /** Viewer-local choices. Not backend state, so not features. */
    transports: DeviceStreamCapabilities;
    webRtcCodec: DeviceWebRtcCodec;
    setWebRtcCodec: (codec: DeviceWebRtcCodec) => void;
  }>;
  streamSettings: Feature<DeviceStreamEncoderSettings, {
    /** Keys this backend can change. Replaces `capabilities.streamSettings`. */
    editable: ReadonlySet<keyof DeviceStreamEncoderSettings>;
    writes: Writes<keyof DeviceStreamEncoderSettings>;
    update: (patch: Partial<DeviceStreamEncoderSettings>) => Promise<HubResult>;
  }>;
  /** Android capture source. `unsupported` on iOS. */
  streamSource: Feature<DeviceStreamSourceStatus, {
    writes: Writes<keyof StreamSourcePatch>;
    /** Resolves when the new stream is on screen. */
    update: (patch: StreamSourcePatch) => Promise<HubResult>;
  }>;
  /** WebRTC telemetry. `unsupported` for HTTP transports. */
  streamStats: Feature<DeviceStreamStats, Attachable>;
  screenRecording: Feature<ScreenRecordingPhase>;

  // Device
  devices: Feature<readonly RunningDevice[]>;
  /** Null data: no app in front. */
  foregroundApp: Feature<ForegroundApp | null>;

  // Live streams (all opt-in)
  logs: Feature<readonly DeviceLog[], Attachable & { clear: () => void }>;
  events: Feature<readonly DeviceEvent[], Attachable & { clear: () => void }>;
  activity: Feature<DeviceActivity, Attachable>;

  // Readable and writable state
  deviceSettings: Feature<DeviceSettingsData, {
    writes: Writes<DeviceSettingKey>;
    set: (key: DeviceSettingKey, value: string) => Promise<HubResult>;
  }>;
  keyboard: Feature<{ hardwareConnected: boolean }, {
    writes: Writes<'hardwareConnected'>;
    setHardwareConnected: (connected: boolean) => Promise<HubResult>;
    /** Command. No state. */
    toggleSoftware: () => void;
  }>;
  camera: Feature<DeviceCameraStatus, {
    writes: Writes<DeviceCameraFacing>;
    setImage: (facing: DeviceCameraFacing, png: Blob) => Promise<HubResult>;
    clearImage: (facing: DeviceCameraFacing) => Promise<HubResult>;
  }>;
  /** On demand: `idle` until the first `refresh()`. */
  accessibility: Feature<AccessibilitySnapshot>;
  location: Feature<{ fix: DeviceGeoFix | null }, {
    /** Replaces `capabilities.location.clear`. */
    canClear: boolean;
    writes: Writes<'fix'>;
    set: (fix: DeviceGeoFix) => Promise<HubResult>;
    clear: () => Promise<HubResult>;
  }>;
  permissions: Feature<AppPermissionsData, {
    writes: Writes<string>;
    set: (id: string, action: AppPermissionAction) => Promise<HubResult>;
    /** Marks every id as pending. */
    reset: () => Promise<HubResult>;
  }>;

  // Commands (no state)
  sendTouch: (sample: TouchSample) => void;
  sendMultiTouch: (sample: MultiTouchSample) => void;
  sendKey: (input: KeyboardInput) => boolean;
  /** iOS only. Its presence shows support. */
  sendKeyEvents?: (events: ReadonlyArray<HidKeyEvent>) => void;
  /** iOS only. Its presence shows support. */
  sendScroll?: (sample: ScrollSample) => void;
  pressButton: (button: HardwareButton) => void;
  reload: () => void;
  rotate: () => void;
  screenshot: () => Promise<HubResult<ScreenshotCapture>>;
}
```

The client has 26 top-level members: 17 features and 9 commands. All loading and error state uses one pattern: `status`, `data`, `error`, `writes`.

## How each member moves

| Before | After |
|---|---|
| `status`, `error` | `stream.status`, `stream.error` |
| `screen`, `fps` | `stream.data.screen`, `stream.data.fps` |
| `videoKind`, `attachVideo` | `stream.videoKind`, `stream.attachVideo` |
| `streamCapabilities` | `stream.transports` |
| `webRtcCodec`, `setWebRtcCodec` | `stream.webRtcCodec`, `stream.setWebRtcCodec` |
| `streamSettings` | `streamSettings.data` |
| `streamSettingsPending` | `streamSettings.status === 'loading'` (read) or `streamSettings.writes.pending` (write) |
| `updateStreamSettings` | `streamSettings.update` |
| `capabilities.streamSettings` | `streamSettings.editable` |
| `streamSource` | `streamSource.data` |
| `streamSourcePending`, `streamSourceError` | `streamSource.writes.pending`, `streamSource.writes.errors` |
| `setStreamSource`, `setGrpcImageMode`, `setGrpcEncoder`, `setGrpcInputSource` | `streamSource.update({ mode \| grpcImageMode \| encoder \| inputSource })` |
| `streamStats` | `streamStats.data` |
| `setStreamStatsEnabled(true/false)` | `streamStats.attach()` / `streamStats.detach()` |
| `screenRecording` | `screenRecording` (`null` → `unsupported`, `'unknown'` → `loading`) |
| `devices` (placeholder list) | `devices.data` |
| `foregroundApp` | `foregroundApp.data` |
| `logs`, `logsEnabled` | `logs.data`, `logs.status !== 'idle'` |
| `attachLogs`, `detachLogs`, `clearLogs` | `logs.attach`, `logs.detach`, `logs.clear` |
| `events`, `eventsEnabled` | `events.data`, `events.status !== 'idle'` |
| `attachEvents`, `detachEvents`, `clearEvents` | `events.attach`, `events.detach`, `events.clear` |
| `activity` (always on) | `activity.data` + `activity.attach` / `activity.detach` |
| `activity.errored` | `activity.status === 'reconnecting' \| 'error'` |
| `deviceSettings` | `deviceSettings.data.values` |
| `deviceSettingsPending` | `deviceSettings.writes.pending` |
| `setDeviceSetting` | `deviceSettings.set` |
| `displayWidthDp` | `deviceSettings.data.displayWidthDp` |
| `appearance` | `deviceSettings.data.values.appearance` |
| `setAppearance(mode)` | `deviceSettings.set('appearance', mode)` |
| `hardwareKeyboardConnected` | `keyboard.data.hardwareConnected` |
| `setHardwareKeyboardConnected` | `keyboard.setHardwareConnected` |
| `toggleSoftwareKeyboard` | `keyboard.toggleSoftware` |
| `camera` | `camera.data` |
| `cameraPending` | `camera.writes.pending` |
| `cameraError` (one for all facings) | `camera.writes.errors.get(facing)` |
| `setCameraImage`, `clearCameraImage` | `camera.setImage`, `camera.clearImage` |
| `accessibility` | `accessibility.data` |
| `accessibilityPending`, `accessibilityError` | `accessibility.status === 'loading'`, `accessibility.error` |
| `refreshAccessibility` | `accessibility.refresh` |
| `location` | `location.data.fix` |
| `locationPending`, `locationError` | `location.writes.pending.has('fix')`, `location.writes.errors.get('fix')` |
| `setLocation`, `clearLocation` | `location.set`, `location.clear` |
| `capabilities.location.clear` | `location.canClear` |
| `permissions` | `permissions.data.items` |
| `permissionsPending` | `permissions.writes.pending` |
| `permissionsError` (read and write) | `permissions.error` (read), `permissions.writes.errors` (write) |
| `setPermission`, `resetPermissions`, `refreshPermissions` | `permissions.set`, `permissions.reset`, `permissions.refresh` |
| `capabilities.<feature>` | `<feature>.status !== 'unsupported'` |
| `sendMultiTouch?` | `sendMultiTouch` (required; the no-op client gets a no-op function) |
| `screenshot(): Promise<ScreenshotCapture \| null>` | `screenshot(): Promise<HubResult<ScreenshotCapture>>` |
| `platform`, `sendTouch`, `sendKey`, `sendKeyEvents?`, `sendScroll?`, `pressButton`, `reload`, `rotate` | no change |

### Type changes

- **Removed:** `ConnectionStatus`, `DeviceCapabilities`, `DeviceStreamSettingCapabilities`, `DeviceLocationCapabilities`, `DeviceScreenRecordingStatus`.
- **Changed:** `DeviceActivity` loses `errored`, and `samples` becomes `readonly`.
- **New:** `HubError`, `HubResult`, `FeatureState`, `Feature`, `Writes`, `Attachable`, `StreamData`, `DeviceSettingsData`, `AppPermissionsData`, `StreamSourcePatch`, `ScreenRecordingPhase`.
- **No change:** all data types, for example `DeviceSettings`, `DeviceCameraStatus`, `AccessibilitySnapshot`, `DeviceStreamSourceStatus`, `DeviceStreamStats`, `ForegroundApp`, `RunningDevice`, `DeviceLog`, `DeviceEvent`, and the input sample types.

## How each feature fits

| Feature | Type | Today | In the new model |
|---|---|---|---|
| Video stream | subscription | `status`, `error`, `screen`, `fps` | `stream`. It leaves `resolving` when the config loads, not on the first video frame. |
| Logs, events | opt-in subscription | `*Enabled` + attach/detach | `idle` until `attach()`; data stays after `detach()` |
| Activity | subscription, always on | `null` / `errored` / `stale` | opt-in, like logs and events |
| Stream stats | opt-in poll | `setStreamStatsEnabled(bool)`; `null` for HTTP transports | `attach`/`detach`; `unsupported` for HTTP transports |
| Foreground app | SSE (iOS) / poll (Android) | `null` means "unknown" | `ready` with `null` data means "no app in front" |
| Devices | one read | placeholder list | the status replaces the placeholder list |
| Device settings, camera, permissions | keyed writes | one `Set` + one error string, or no error | `Writes<K>` |
| Location, stream settings, stream source, hardware keyboard | one write at a time | `boolean` pending; an error string, or the old value comes back with no error | the same `Writes<K>`, with field names as keys |
| Accessibility | read on request | pending + error + last snapshot | `idle` until `refresh()`; `loading` keeps the last snapshot |
| `appearance`, `displayWidthDp` | come from device settings | separate fields | in `deviceSettings.data` |
| `webRtcCodec`, `streamCapabilities` | local to the viewer | plain values | plain values, not features |
| Touch, keys, buttons, reload, rotate | commands | `void` | no change; `screenshot` returns `HubResult` |

## Example: device settings, loading compared with failed

```ts
const { deviceSettings } = client;

switch (deviceSettings.status) {
  case 'resolving':        // the config is not loaded yet
  case 'loading':          // the first read is in progress
    return <Spinner />;
  case 'unsupported':
    return null;
  case 'reconnecting':     // a read failed; the client tries again automatically
    return <Spinner label="Device not answering, retrying…" />;
  case 'error':            // the client stopped trying
    return (
      <ErrorRow
        message={deviceSettings.error.message}
        onRetry={deviceSettings.error.retryable ? deviceSettings.refresh : undefined}
      />
    );
  case 'ready':
    return <SettingsRows values={deviceSettings.data.values} />;
}
```

## Example: every method in use

```tsx
import { useEffect, type ReactNode } from 'react';
import {
  DeviceScreen,
  KeyboardCapture,
  useActiveDeviceClient,
  type ActiveDeviceTarget,
  type Feature,
  type HubResult,
} from '@expo/hub-client';

/** One generic wrapper works for every feature, because all features share one lifecycle. */
function FeatureSection<D>(props: {
  title: string;
  feature: Feature<D>;
  children: (data: D) => ReactNode;
}) {
  const { feature } = props;
  if (feature.status === 'unsupported') return null;
  return (
    <section>
      <h3>{props.title}</h3>
      {feature.data === undefined &&
        (feature.status === 'resolving' || feature.status === 'loading') && <Spinner />}
      {feature.status === 'reconnecting' && <Badge tone="warning">Reconnecting…</Badge>}
      {feature.status === 'error' && (
        <ErrorRow
          message={feature.error.message}
          onRetry={feature.error.retryable ? feature.refresh : undefined}
        />
      )}
      {feature.data !== undefined && props.children(feature.data)}
    </section>
  );
}

/** Writes never reject, so a click handler needs no try/catch. */
const toastOnFailure = (result: HubResult) => {
  if (!result.ok && result.error.code !== 'busy') toast(result.error.message);
};

/** Attach an opt-in stream while the component is mounted. */
function useAttached(feature: { attach: () => void; detach: () => void }) {
  useEffect(() => {
    feature.attach();
    return feature.detach;
  }, [feature.attach, feature.detach]);
}

export function DeviceInspector({ target, hubBase }: { target: ActiveDeviceTarget | null; hubBase: string }) {
  const client = useActiveDeviceClient(target, hubBase);
  const {
    stream, streamSettings, streamSource, streamStats, screenRecording,
    devices, foregroundApp, logs, events, activity,
    deviceSettings, keyboard, camera, accessibility, location, permissions,
  } = client;

  useAttached(streamStats);
  useAttached(activity);

  return (
    <>
      {/* DeviceScreen calls stream.attachVideo, sendTouch, sendMultiTouch, sendKey, sendScroll. */}
      <DeviceScreen client={client} />
      {/* KeyboardCapture calls sendKeyEvents. */}
      {client.sendKeyEvents && <KeyboardCapture client={client} />}

      <Toolbar>
        <button onClick={() => client.pressButton('home')}>Home</button>
        <button onClick={client.reload}>Reload</button>
        <button onClick={client.rotate}>Rotate</button>
        <button
          onClick={async () => {
            const shot = await client.screenshot();
            if (shot.ok) download(shot.value.blob);
            else toast(shot.error.message);
          }}
        >
          Screenshot
        </button>
        <AppearanceToggle
          value={deviceSettings.data?.values.appearance}
          disabled={deviceSettings.status !== 'ready' || deviceSettings.writes.pending.has('appearance')}
          onChange={(mode) => deviceSettings.set('appearance', mode).then(toastOnFailure)}
        />
        <button onClick={keyboard.toggleSoftware}>Keyboard</button>
      </Toolbar>

      <FeatureSection title="Stream" feature={stream}>
        {({ screen, fps }) => (
          <>
            <span>{fps} fps {screen && `· ${screen.width}×${screen.height}`}</span>
            <Select
              value={stream.webRtcCodec}
              options={stream.transports.webRtcCodecs}
              onChange={stream.setWebRtcCodec}
            />
          </>
        )}
      </FeatureSection>

      <FeatureSection title="Encoder" feature={streamSettings}>
        {(settings) =>
          [...streamSettings.editable].map((key) => (
            <NumberField
              key={key}
              label={key}
              value={settings[key]}
              busy={streamSettings.writes.pending.has(key)}
              error={streamSettings.writes.errors.get(key)?.message}
              onCommit={(value) => streamSettings.update({ [key]: value }).then(toastOnFailure)}
            />
          ))
        }
      </FeatureSection>

      <FeatureSection title="Capture source" feature={streamSource}>
        {(source) => (
          <>
            <Select value={source.mode} options={source.availableModes}
              busy={streamSource.writes.pending.has('mode')}
              onChange={(mode) => streamSource.update({ mode }).then(toastOnFailure)} />
            <Select value={source.grpcImageMode} options={['png', 'mmap', 'rgb888']}
              onChange={(grpcImageMode) => streamSource.update({ grpcImageMode }).then(toastOnFailure)} />
            <Select value={source.encoder} options={source.availableEncoders}
              error={streamSource.writes.errors.get('encoder')?.message ?? source.hardwareEncoderError}
              onChange={(encoder) => streamSource.update({ encoder }).then(toastOnFailure)} />
            <Select value={source.inputSource} options={source.availableInputSources}
              onChange={(inputSource) => streamSource.update({ inputSource }).then(toastOnFailure)} />
          </>
        )}
      </FeatureSection>

      <FeatureSection title="Stream stats" feature={streamStats}>
        {(stats) => <StatsChart samples={stats.samples} dimmed={stats.stale || stats.serverStale} />}
      </FeatureSection>

      <FeatureSection title="Recording" feature={screenRecording}>
        {(phase) => <RecordingBadge phase={phase} />}
      </FeatureSection>

      <FeatureSection title="Devices" feature={devices}>
        {(list) => <DeviceList devices={list} />}
      </FeatureSection>

      <FeatureSection title="App" feature={foregroundApp}>
        {(app) => (app ? <AppCard app={app} /> : <Muted>No app in front</Muted>)}
      </FeatureSection>

      <FeatureSection title="Performance" feature={activity}>
        {({ samples, stale, hostCores }) =>
          samples.length === 0
            ? <Muted>Only in app</Muted>
            : <ActivityChart samples={samples} cores={hostCores} dimmed={stale} />
        }
      </FeatureSection>

      <FeatureSection title="Device options" feature={deviceSettings}>
        {({ values, displayWidthDp }) =>
          SETTING_KEYS.filter((key) => key in values).map((key) => (
            <SettingRow
              key={key}
              settingKey={key}
              value={values[key]!}
              hint={key === 'display-size' ? displayWidthDp : undefined}
              busy={deviceSettings.writes.pending.has(key)}
              error={deviceSettings.writes.errors.get(key)?.message}
              onChange={(value) => deviceSettings.set(key, value).then(toastOnFailure)}
            />
          ))
        }
      </FeatureSection>

      <FeatureSection title="Keyboard" feature={keyboard}>
        {({ hardwareConnected }) => (
          <Switch
            label="Mac keyboard connected"
            checked={hardwareConnected}
            busy={keyboard.writes.pending.has('hardwareConnected')}
            onChange={(on) => keyboard.setHardwareConnected(on).then(toastOnFailure)}
          />
        )}
      </FeatureSection>

      <FeatureSection title="Camera" feature={camera}>
        {(status) =>
          status.feeds.map((feed) => (
            <CameraRow
              key={feed.facing}
              feed={feed}
              busy={camera.writes.pending.has(feed.facing)}
              error={camera.writes.errors.get(feed.facing)?.message}
              onPick={(png) => camera.setImage(feed.facing, png).then(toastOnFailure)}
              onReset={() => camera.clearImage(feed.facing).then(toastOnFailure)}
            />
          ))
        }
      </FeatureSection>

      <FeatureSection title="Accessibility" feature={accessibility}>
        {(snapshot) => <AxTree nodes={snapshot.nodes} onTap={(frame) => client.sendTouch(center(frame))} />}
      </FeatureSection>
      {accessibility.status !== 'unsupported' && (
        <button onClick={accessibility.refresh} disabled={accessibility.status === 'loading'}>
          Read screen
        </button>
      )}

      <FeatureSection title="Location" feature={location}>
        {({ fix }) => (
          <LocationForm
            fix={fix}
            busy={location.writes.pending.has('fix')}
            error={location.writes.errors.get('fix')?.message}
            onSubmit={(next) => location.set(next).then(toastOnFailure)}
            onClear={location.canClear ? () => location.clear().then(toastOnFailure) : undefined}
          />
        )}
      </FeatureSection>

      <FeatureSection title="Permissions" feature={permissions}>
        {({ appId, items }) =>
          appId === null ? <Muted>No app in front</Muted> : (
            <>
              {items.map((p) => (
                <PermissionRow
                  key={p.id}
                  permission={p}
                  busy={permissions.writes.pending.has(p.id)}
                  error={permissions.writes.errors.get(p.id)?.message}
                  onGrant={() => permissions.set(p.id, 'grant').then(toastOnFailure)}
                  onRevoke={() => permissions.set(p.id, 'revoke').then(toastOnFailure)}
                />
              ))}
              <button onClick={() => permissions.reset().then(toastOnFailure)}>Reset all</button>
            </>
          )
        }
      </FeatureSection>

      <LogPanel
        lines={logs.data ?? []}
        attached={logs.status !== 'idle'}
        onToggle={(on) => (on ? logs.attach() : logs.detach())}
        onClear={logs.clear}
      />
      <EventPanel
        rows={events.data ?? []}
        attached={events.status !== 'idle'}
        onToggle={(on) => (on ? events.attach() : events.detach())}
        onClear={events.clear}
      />
    </>
  );
}
```

## Behavior that changes in the implementation

The new statuses are correct only if each backend reports its failures.

| Area | Today | After |
|---|---|---|
| iOS device settings | The first read ignores its error. No retry. | The first read sets `error` with a `HubError.code`. An auth failure gives `retryable: false`. `refresh()` reads again. |
| Android device settings | A poll where every key fails returns with no change. | A failed poll sets `reconnecting` and keeps the last data. After a retry limit, or after an error that a retry cannot fix, it sets `error`. A successful poll sets `ready`. |
| Android device settings | `capabilities.deviceSettings` is always `true`. | `unsupported` only after the backend confirms that it does not have the feature. |
| Metrics (both platforms) | The client always connects again. | `reconnecting` until a retry limit or a non-retryable error, then `error`. |
| Metrics (both platforms) | Always connected while the config has a metrics endpoint. | Opt-in with `attach()`. The charts start empty when the section opens. |
| Writes | Failures are silent, or they set one shared error string. | Every write resolves a `HubResult`, and the error goes into `writes.errors` for its key. |
| Stream settings | A failed read keeps the last value with no signal. A failed write reverts with no signal. | A failed read sets `reconnecting` or `error`. A failed write sets `writes.errors`. |

## Open decisions

1. **Breaking change.** The new feature names are the same as many current fields (`activity`, `deviceSettings`, `camera`, `location`, `permissions`, `logs`, `events`, …). The new types cannot be added next to the old fields under the same names. Options:
   - Release a major version (`2.0.0`).
   - Return the new shape from a new hook name, and keep the old hook deprecated.
2. **`reconnecting` or `interrupted`.** This draft uses `reconnecting` because `ConnectionStatus` already uses that word. `interrupted` is more neutral for polls.
3. **Activity as opt-in.** This draft makes activity opt-in, like logs, events and stream stats. The cost: the charts lose the history that fills in the background today. The repository does not record why activity is always on.
