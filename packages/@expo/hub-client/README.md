# @expo/hub-client

Render live iOS simulators and Android emulators in a React app. Connect through
[Expo Device Hub](https://github.com/expo/expo-device-hub), show the device with
`DeviceScreen`, and send touch, keyboard, and device controls.

## Requirements

- A running Expo Device Hub server. Either start an Expo app that has the
  `expo-device-hub` DevTools plugin installed, or run `npx expo-device-hub` standalone.
  The hooks talk to the Hub's `/vendor/serve-sim` and `/vendor/serve-emu` routes.
- React 18 or newer.
- A browser to show the video and send input.

## Install

```sh
npm install @expo/hub-client
```

## Render a live device screen

Use `useActiveDeviceClient` when the screen and controls live in one component.
`DeviceScreen` fills its parent, so give the parent a size and `position: relative`.
`displayScreen` gives you the screen size after accounting for rotation.

```tsx
import { DeviceScreen, displayScreen, useActiveDeviceClient } from '@expo/hub-client';

export function LiveDevice({ udid }: { udid: string }) {
  // The second argument is where the Hub server is mounted on the current origin:
  // '' for the origin root (`npx expo-device-hub`), or
  // '/_expo/plugins/expo-device-hub' inside `expo start`. A full origin such as
  // 'http://localhost:3400' also works.
  const client = useActiveDeviceClient(
    { platform: 'ios', device: udid, streamMode: 'mjpeg' },
    '',
  );

  const screen = displayScreen(client.screen);
  const aspectRatio = screen ? `${screen.width} / ${screen.height}` : '9 / 19.5';

  return (
    <div style={{ position: 'relative', width: 360, aspectRatio }}>
      <DeviceScreen client={client} borderRadius={24} />
    </div>
  );
}
```

- `platform` is `'ios'` or `'android'`. `device` is the simulator UDID or the adb serial. Pass
  `null` instead of the target object to render an idle screen without connecting.
- `streamMode` is required and has no default: `'mjpeg'`, `'h264'`, or `'webrtc'`. iOS
  supports all three. Android maps a mode it cannot serve to one it can.
- `client.status` moves through `'idle'`, `'connecting'`, `'streaming'`, and `'error'`
  (Android also reports `'reconnecting'`). `client.error` holds the last failure message.

## Share a connection between components

Use `DeviceClientProvider` when your screen, controls, and metrics live in separate
components. They share one connection, and each component updates only for the client
properties it reads.

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

### Show the screen

Use `useDeviceScreenClient` with `DeviceScreen`. It follows screen and input changes
without updating for metrics or logs.

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

## Connect to a backend directly

To connect directly to a backend, use `useIosDeviceClient` or `useAndroidDeviceClient`
with that server's URL. For example, this component shows an Android connection's status:

```tsx
import { useAndroidDeviceClient } from '@expo/hub-client';

function AndroidStatus() {
  const { status } = useAndroidDeviceClient({
    baseUrl: 'http://localhost:3400/vendor/serve-emu',
    device: 'emulator-5554',
    streamMode: 'h264',
  });

  return <span>{status}</span>;
}
```

## Remote connections

If the whole Device Hub is remote, pass its public mount to `useActiveDeviceClient`, for
example `https://hub.example.test/device-hub`.

### iOS embedding

When embedding the iOS screen on another site, pass the public serve-sim mount that serves
`/api` and `/helper` as `baseUrl`, for example `https://sim.example.test/preview/session`.
The stream and input URLs then use that server. Start serve-sim with
`--cors-origin <origin>` for the origin of the embedding page, for example
`--cors-origin http://localhost:8081`. Without it, the exec-ws socket closes, and logs,
events, metrics and UI requests stop, even when both servers run on `localhost`.

hub-client does not send a serve-sim access token yet. A serve-sim server started with
`--require-token` answers these requests with 401. EAS Simulator Preview sessions always
use a token, so embedding them needs the client token support which is planned.

## License

MIT
