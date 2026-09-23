# @expo/hub-client

React hooks and a `DeviceScreen` component that mirror a live iOS simulator or Android
emulator in the browser. This is the device-client layer of
[Expo Device Hub](https://github.com/expo/expo-device-hub): it connects to the Hub's streaming
backends (serve-sim for iOS, serve-emu for Android), paints the video, and forwards touch,
gesture, and keyboard input back to the device.

## Requirements

- A running Expo Device Hub server. Either start an Expo app that has the
  `expo-device-hub` DevTools plugin installed, or run `npx expo-device-hub` standalone.
  The hooks talk to the Hub's `/vendor/serve-sim` and `/vendor/serve-emu` routes.
- React 18 or newer.
- A browser. The package uses `WebSocket`, `EventSource`, WebCodecs, Media Source
  Extensions, and WebRTC, so it is not meant to run in Node.

## Install

```sh
npm install @expo/hub-client
```

## Render a live device screen

`useActiveDeviceClient` opens one connection to the selected device and returns a
`DeviceClient`: the live connection state plus the controls. `DeviceScreen` paints that
client's video and forwards pointer, gesture, and keyboard input. It is absolutely positioned
and fills its parent, so give the parent a size and `position: relative`. `displayScreen`
gives you the orientation-corrected screen size once the stream reports it.

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
- A Hub started with `--require-token` gates its iOS routes behind a session token. Pass it
  as the third argument, `{ accessToken }`. The client sends it as a bearer on fetches, as
  the `serve-sim.token.<token>` subprotocol on WebSockets, and as `?token=` where the browser
  can set neither. A cross-origin page needs its origin allowed on the Hub for the exec
  socket. iOS only for now: the Android client ignores the token.

```tsx
const client = useActiveDeviceClient(
  { platform: 'ios', device: udid, streamMode: 'mjpeg' },
  '',
  { accessToken: token },
);
```

To talk to one backend directly, use the platform hooks with the backend's base URL:

```tsx
import { useAndroidDeviceClient, useIosDeviceClient } from '@expo/hub-client';

const ios = useIosDeviceClient({
  baseUrl: 'http://localhost:3400/vendor/serve-sim',
  device: udid,
  streamMode: 'h264',
  // Only for a serve-sim started with --require-token.
  accessToken: token,
});

const android = useAndroidDeviceClient({
  baseUrl: 'http://localhost:3400/vendor/serve-emu',
  device: 'emulator-5554',
  streamMode: 'h264',
});
```

## Call device controls

Every control lives on the `DeviceClient`. Controls are no-ops while nothing is connected,
and each backend ignores the buttons its platform does not have.

```ts
// Hardware buttons: 'home' | 'back' | 'recents' | 'power' | 'appSwitcher' | 'hideKeyboard'
client.pressButton('home');

client.rotate();
client.reload(); // reload the running React Native bundle
client.setAppearance('dark'); // 'light' | 'dark'; read it back from client.appearance

const png = await client.screenshot(); // Blob, or null when capture fails

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

## License

MIT
