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

Destructure everything you need from one `useDeviceClient()` call:

```tsx
import { useDeviceClient } from '@expo/hub-client';

function Controls() {
  const { status, pressButton, rotate, reload } = useDeviceClient();
  const connected = status === 'streaming';

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

Status and control changes update this component. FPS, metrics, and log changes do not.
Status can be `'idle'`, `'connecting'`, `'streaming'` or `'error'`. Android also reports
`'reconnecting'` while restoring a stream. Read `error` for the last failure message.

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
import { useDeviceClientSelector } from '@expo/hub-client';

function Cpu() {
  const cpuPct = useDeviceClientSelector((client) => client.activity?.samples.at(-1)?.cpuPct);

  return <span>{cpuPct == null ? 'Waiting for metrics' : `CPU ${cpuPct.toFixed(1)}%`}</span>;
}
```

Reading `activity` with `useDeviceClient` would update the component whenever any part
of `activity` changes.

### Keep updates focused

- Read state in your component body so it updates with the device. Data read only in an
  event handler can be out of date. Controls such as `client.rotate()` use the latest callback.
- Pick named properties when destructuring. Spreading the client or using `{ status, ...rest }`
  subscribes to every property. Reading `activity.samples` subscribes to the whole `activity` object.
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

Every control lives on the `DeviceClient`. Controls are no-ops while nothing is connected,
and each backend ignores the buttons its platform does not have.

```ts
// Hardware buttons: 'home' | 'back' | 'recents' | 'power' | 'appSwitcher' | 'hideKeyboard'
client.pressButton('home');

client.rotate();
client.reload(); // reload the running React Native bundle
client.setAppearance('dark'); // 'light' | 'dark'; read it back from client.appearance

// { blob, artifact }, or null when capture fails. `artifact` is the session artifact outcome:
// { status: 'saved' } | { status: 'disabled' } | { status: 'failed', error?: string } | null
// (null for a backend that does not report one).
const capture = await client.screenshot();
if (capture?.artifact?.status === 'failed') console.warn('not saved to session artifacts', capture.artifact.error);

// Input is normalized to 0..1 of the screen, so it works for every device size.
client.sendTouch({ phase: 'begin', x: 0.5, y: 0.5 });
client.sendTouch({ phase: 'end', x: 0.5, y: 0.5 });
client.sendKey({ phase: 'down', code: 'KeyA', key: 'a', repeat: false });
client.sendKey({ phase: 'up', code: 'KeyA', key: 'a', repeat: false });

// Logs are off until you attach them.
client.attachLogs();
client.logs; // DeviceLog[]
client.detachLogs();
```

Optional features such as device settings, camera feeds, the accessibility tree, location,
and app permissions are only available on some backends. Check `client.capabilities` before
you show their controls. The full `DeviceClient` contract, with a comment on every field, is
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

## License

MIT
