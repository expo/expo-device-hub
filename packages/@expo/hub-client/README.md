# @expo/hub-client

Render live iOS simulators and Android emulators in a React app. Connect through
[Expo Device Hub](https://github.com/expo/expo-device-hub), show the device with
`DeviceScreen`, and send touch, keyboard, and device controls.

## Requirements

- A running Expo Device Hub server. Either start an Expo app that has the
  `expo-device-hub` DevTools plugin installed, or run `npx expo-device-hub` standalone.
  The provider connects to the Hub's `/vendor/serve-sim` and `/vendor/serve-emu` routes.
- React 18 or newer.
- A browser to show the video and send input.

## Install

```sh
npm install @expo/hub-client
```

## Connect to a device

Wrap your screen, controls and metrics in `DeviceClientProvider`. They share one
connection, and each component reads the client properties it needs.

### Add the provider

Wrap the components that need the device connection. The components below all use this
provider:

```tsx
import { DeviceClientProvider } from '@expo/hub-client';

export function LiveSession({ udid }: { udid: string }) {
  return (
    <DeviceClientProvider
      key={udid}
      platform="ios"
      options={{
        baseUrl: 'http://localhost:3400/vendor/serve-sim',
        device: udid,
        streamMode: 'webrtc',
      }}
    >
      <Screen />
      <Controls />
      <Cpu />
    </DeviceClientProvider>
  );
}
```

For Android, use `platform="android"`, your serve-emu URL, and an adb serial such as
`'emulator-5554'` for `device`.

When using the Expo DevTools plugin, the server URL includes
`/_expo/plugins/expo-device-hub` before `/vendor/serve-sim` or `/vendor/serve-emu`.

`streamMode` is required: `'mjpeg'`, `'h264'`, or `'webrtc'`. iOS supports all three.
Android maps a mode it cannot serve to one it can.

Use one provider per session. When switching sessions, set its `key` to the session ID
so the old connection closes. Set `options.enabled` to `false` to disconnect, or use
`platform={null}` while no device is selected.

### Read state and controls

Destructure the controls you need from one `useDeviceClient()` call, and select single
values with `useDeviceClientSelector`:

```tsx
import { useDeviceClient, useDeviceClientSelector } from '@expo/hub-client';

function Controls() {
  const { pressButton, rotate, reload } = useDeviceClient();
  const status = useDeviceClientSelector((client) => client.stream.status);
  const connected = status === 'ready';

  return (
    <div>
      <span>{status}</span>
      <button disabled={!connected} onClick={() => pressButton('home')}>Home</button>
      <button disabled={!connected} onClick={rotate}>Rotate</button>
      <button disabled={!connected} onClick={reload}>Reload</button>
    </div>
  );
}
```

Stream status and control changes update this component. FPS, metrics, and log changes
do not. Each feature, such as `stream`, `deviceSettings`, or `logs`, exposes `status`,
`data`, `error`, and `refresh()`; see [Feature states](#feature-states). Video state is at
`client.stream`; settings and other features work independently of the first video frame.

### Show the screen

Use `useDeviceScreenClient` with `DeviceScreen`. It follows screen and input changes
without updating for metrics or logs.
`DeviceScreen` fills its parent, so give the parent a size and `position: relative`.
`displayScreen` gives you the screen size after accounting for rotation.

```tsx
import { DeviceScreen, displayScreen, useDeviceScreenClient } from '@expo/hub-client';

function Screen() {
  const client = useDeviceScreenClient();
  const screen = displayScreen(client.screen);
  const aspectRatio = screen ? `${screen.width} / ${screen.height}` : '9 / 19.5';

  return (
    <div style={{ position: 'relative', width: 360, aspectRatio }}>
      <DeviceScreen client={client} />
    </div>
  );
}
```

### Show CPU usage

Use `useDeviceClientSelector` when you need one value from a larger object. This component
updates when the latest CPU percentage changes, even if memory or network readings change.

```tsx
import { useEffect } from 'react';
import { useDeviceClientSelector } from '@expo/hub-client';

function Cpu() {
  const attach = useDeviceClientSelector((client) => client.activity.attach);
  const detach = useDeviceClientSelector((client) => client.activity.detach);
  const cpuPct = useDeviceClientSelector(
    (client) => client.activity.data?.samples.at(-1)?.cpuPct,
  );
  // Activity is opt-in: collect it while this component is mounted.
  useEffect(() => {
    attach();
    return detach;
  }, [attach, detach]);

  return <span>{cpuPct == null ? 'Waiting for metrics' : `CPU ${cpuPct.toFixed(1)}%`}</span>;
}
```

Reading `activity` with `useDeviceClient` would update the component whenever any part
of `activity` changes.

### Keep updates focused

- Read state in your component body so it updates with the device. Data read only in an
  event handler can be out of date. Controls such as `client.rotate()` use the latest callback.
- Pick named properties when destructuring. Spreading the client or using `{ stream, ...rest }`
  subscribes to every property. Reading `activity.data?.samples` subscribes to the whole
  `activity` feature, so its status and data changes re-render the component. Each feature,
  such as `stream`, is one property: reading `stream.status` also re-renders on FPS changes,
  so use `useDeviceClientSelector` for a single field.
- Keep selectors simple. Return a number, string, boolean, or an existing object. If you
  build a new object, pass a comparison function as the second argument.
- Treat the client and its data as read-only.

## Connect to a token-gated Hub

A Hub started with `npx expo-device-hub --require-token` needs its session token on every
request. The Hub dashboard itself needs nothing extra: opening the link with the token gives
the browser a cookie that covers every request. A page on another origin has no such cookie,
so pass the token to the provider:

```tsx
<DeviceClientProvider
  key={udid}
  platform="ios"
  options={{
    baseUrl: 'http://127.0.0.1:3400/vendor/serve-sim',
    device: udid,
    streamMode: 'mjpeg',
    token,
  }}
>
  <Screen />
</DeviceClientProvider>
```

For Android, use `platform="android"` and the `/vendor/serve-emu` URL.
The client sends the token as `Authorization: Bearer <token>`, as a `serve-sim.token.<token>` or
`serve-emu.token.<token>`
WebSocket subprotocol, and as `?token=` only where a browser cannot set a header (the MJPEG
`<img>`, `EventSource`).

The token does not replace CORS, and the Hub has no option to allow other origins yet. So from
another origin, only part of the client works today:

- **Android:** the H.264 stream and the input socket work from any origin. The Hub sets no
  allowed origins for serve-emu, so the other requests fail, WebRTC included.
- **iOS:** the client reads serve-sim's `/api` first, and serve-sim lets only loopback origins
  read its responses. So the client works only from a loopback page, such as one on
  `localhost`. There, logs, events, metrics, device settings, location, and app actions still
  fail: they use serve-sim's control socket, which refuses every other origin.

## Call device controls

Feature actions live beside their data. Writes return `Promise<HubResult>`: check `ok` for
one-shot feedback, or render the feature’s `writes.errors` next to its controls. Writes to
an unavailable feature return an error. Input commands such as `pressButton` remain
fire-and-forget; unavailable platform buttons are ignored.

```ts
// Hardware buttons: 'home' | 'back' | 'recents' | 'power' | 'appSwitcher' | 'hideKeyboard'
client.pressButton('home');

client.rotate();
client.reload(); // reload the running React Native bundle
await client.deviceSettings.set('appearance', 'dark');
// Read it back from client.deviceSettings.data?.values.appearance.

// A result containing { blob, artifact }, or a typed error. `artifact` is the session artifact outcome:
// { status: 'saved' } | { status: 'disabled' } | { status: 'failed', error?: string } | null
// (null for a backend that does not report one).
const capture = await client.screenshot();
if (!capture.ok) console.warn(capture.error.message);
else if (capture.value.artifact?.status === 'failed') {
  console.warn('not saved to session artifacts', capture.value.artifact.error);
}

// Input is normalized to 0..1 of the screen, so it works for every device size.
client.sendTouch({ phase: 'begin', x: 0.5, y: 0.5 });
client.sendTouch({ phase: 'end', x: 0.5, y: 0.5 });
client.sendKey({ phase: 'down', code: 'KeyA', key: 'a', repeat: false });
client.sendKey({ phase: 'up', code: 'KeyA', key: 'a', repeat: false });

// Logs are off until you attach them.
client.logs.attach();
client.logs.data; // readonly DeviceLog[] | undefined
client.logs.detach(); // Retains collected lines.
```

Optional features such as device settings, camera feeds, the accessibility tree, location,
and app permissions are only available on some backends. Hide a feature when its `status` is `unsupported`; show a loader for `resolving` or
initial `loading`. A network failure is an error, never evidence of missing support. The full `DeviceClient` contract is
in [`src/types.ts`](./src/types.ts).

## Remote connections

Set `options.baseUrl` on `DeviceClientProvider` to the remote streaming server:

- iOS: `https://hub.example.test/device-hub/vendor/serve-sim`
- Android: `https://hub.example.test/device-hub/vendor/serve-emu`

### iOS embedding

When embedding the iOS screen on another site, pass the public serve-sim mount that serves
`/api` and `/helper` as `baseUrl`, for example `https://sim.example.test/preview/session`.
The stream and input URLs then use that server. Start serve-sim with
`--cors-origin <origin>` for the origin of the embedding page, for example
`--cors-origin http://localhost:8081`. Without it, the exec-ws socket closes, and logs,
events, metrics and UI requests stop, even when both servers run on `localhost`.

The foreground app icon does not need exec-ws. hub-client reads it from serve-sim's
`/api/apps/icon` route, a plain GET, when `/api` advertises the route. Older servers send the
icon over exec-ws.

A serve-sim started with `--require-token`, such as an EAS Simulator Preview session, needs
its session token on every request. Pass it as `options.token`:

```tsx
<DeviceClientProvider
  key={udid}
  platform="ios"
  options={{
    baseUrl: 'https://sim.example.test/preview/session',
    device: udid,
    streamMode: 'mjpeg',
    token,
  }}
>
  <Screen />
</DeviceClientProvider>
```

The token does not replace `--cors-origin`.

## Feature states

| State | Meaning | Typical UI |
| --- | --- | --- |
| `resolving` | Discovering configuration and availability | Checking availability… |
| `unsupported` | Feature is unavailable | Hide the section |
| `idle` | Available, but not requested or attached | Read/start action |
| `loading` | First read, explicit refresh, or subscription startup | Loader; retain existing content on refresh |
| `ready` | The read or subscription succeeded | Content, including a valid empty result |
| `reconnecting` | Automatic recovery is in progress | Retain content and show “Retrying…” |
| `error` | Recovery stopped or needs intervention | Error and, when retryable, a Retry action |

Automatic reads usually follow `resolving → loading → ready`. On-demand accessibility
uses `resolving → idle → loading → ready`. An opt-in stream stays `idle` until `attach()`.
A first read can also discover that a feature is `unsupported`.

`data === undefined` means no successful read for this target. `foregroundApp.data === null`
and `location.data === null` are successful empty values. An open log subscription is
`ready` with `[]` even before the first message.

Refresh retains the previous data. A device or foreground-app change clears data and
write state for the affected resource; late responses from the old target are ignored.
Configuration failures propagate to unresolved features, and `refresh()` retries discovery.

```tsx
function Appearance() {
  const settings = useDeviceClient().deviceSettings;
  if (settings.status === 'unsupported') return null;

  return (
    <section>
      {(settings.status === 'resolving' || settings.status === 'loading') &&
        <p>{settings.data ? 'Refreshing…' : 'Loading…'}</p>}
      {settings.error && <p role="alert">{settings.error.message}</p>}
      {settings.status === 'reconnecting' && <p>Retrying…</p>}
      {settings.status === 'error' && settings.error.retryable &&
        <button onClick={settings.refresh}>Retry</button>}
      {settings.data && (
        <button
          disabled={settings.status !== 'ready' || settings.writes.pending.has('appearance')}
          onClick={() => { void settings.set('appearance', 'dark'); }}>
          Use dark appearance
        </button>
      )}
      {settings.writes.errors.get('appearance') &&
        <p role="alert">{settings.writes.errors.get('appearance')!.message}</p>}
    </section>
  );
}
```

### Live streams

Logs, events, activity, and WebRTC statistics are opt-in. `enabled` represents consumer
intent independently of connection health. Attaching before discovery remembers that intent.
Attach/detach are idempotent controls for one shared subscription; use one owner per feature.

```tsx
const { activity } = useDeviceClient();
useEffect(() => {
  activity.attach();
  return activity.detach;
}, [activity.attach, activity.detach]);
```

Detaching retains data and stops collection. Activity history now starts when attached.
Telemetry is unsupported on HTTP/WebSocket video transports; its enabled intent is retained
when switching transports. `refresh()` on a detached stream does not enable collection.

### Writes

- `writes.pending` tracks changed keys; `writes.errors` holds the last failed write per key.
- Starting a new write clears that key’s error. Read errors remain separate in `error`.
- An overlapping write returns `{ ok: false, error: { code: 'busy', … } }`.
- Independent setting keys and camera facings can update concurrently. Encoder and capture
  changes are serialized because they can replace the same stream.
- Simple settings update optimistically and restore an authoritative or previous value on
  failure. Capture-source updates wait for replacement video, with a bounded timeout.
- Actions and refresh functions keep stable identities across feature updates.

## Migrating from 1.x

This is a breaking change to the existing hooks and `DeviceClient`.

| Before | Now |
| --- | --- |
| `client.status`, `error`, `screen`, `fps` | `client.stream.status`, `.error`, `.data?.screen`, `.data?.fps` |
| `useDeviceScreenClient().status` `'streaming'` | Same flat `status`, `screen`, `error`; `status` uses feature states, so `'ready'` replaces `'streaming'` |
| `ConnectionStatus`, `DeviceCapabilities`, `DeviceStreamSettingCapabilities`, `DeviceLocationCapabilities`, `DeviceAppearance` types | Removed; use feature `status` values and `status !== 'unsupported'` |
| `client.capabilities.camera` | `client.camera.status !== 'unsupported'` for visibility; check `ready` before editing |
| `client.deviceSettings` | `client.deviceSettings.data?.values` |
| `setDeviceSetting(key, value)` | `deviceSettings.set(key, value)` |
| `deviceSettingsPending` | `deviceSettings.writes.pending` |
| `appearance`, `setAppearance(mode)` | `deviceSettings.data?.values.appearance`, `deviceSettings.set('appearance', mode)` |
| `camera`, `setCameraImage`, `clearCameraImage` | `camera.data`, `camera.setImage`, `camera.clearImage` |
| `location`, `setLocation`, `clearLocation` | `location.data`, `location.set`, `location.clear`; check `location.canClear` |
| `permissions`, `setPermission`, `resetPermissions` | `permissions.data?.items`, `permissions.set`, `permissions.reset` |
| `accessibility`, `refreshAccessibility` | `accessibility.data`, `accessibility.refresh` |
| `logsEnabled`, `attachLogs`, `detachLogs` | `logs.enabled`, `logs.attach`, `logs.detach` |
| `eventsEnabled`, `attachEvents`, `detachEvents` | `events.enabled`, `events.attach`, `events.detach` |
| Always-on `activity` | `activity.attach()` / `.detach()`, then `activity.data` |
| `streamCapabilities`, `webRtcCodec` | `stream.transports`, `stream.webRtcCodec` |
| `updateStreamSettings(patch)` | `streamSettings.update(patch)`; supported keys are in `.editable` |
| `setStreamSource(mode)`, `setGrpcEncoder(encoder)`, etc. | `streamSource.update({ mode, encoder, … })` |
| `setStreamStatsEnabled(boolean)` | `streamStats.attach()` / `.detach()` |
| `hardwareKeyboardConnected` | `keyboard.data?.hardwareConnected` |
| `screenRecording` | `screenRecording.data`; use feature status for discovery/failure |
| `areRecordingControlsLocked(status)` with `'unknown'` | `areRecordingControlsLocked(client.screenRecording)`; a feature without a phase stays locked. `DeviceScreenRecordingStatus` is now `ScreenRecordingPhase`, without `'unknown'` |
| `DeviceClientHook` type | Removed; use `DeviceClientProvider` |
| `foregroundApp`, `devices` | `foregroundApp.data`, `devices.data` |
| `screenshot(): ScreenshotCapture | null` | `screenshot(): HubResult<ScreenshotCapture>` |

Touch, keyboard input, hardware buttons, reload, and rotation remain commands on the client.
`client.input` is the feature that reports whether those commands reach the device: its
`status` and `error` describe the input channel, `data.rejected` holds the last command the
backend refused, and `refresh()` reconnects the input channel.
The complete interface is in [`src/types.ts`](./src/types.ts).

## License

MIT
