# LLP 0014: Hub Network panel

**Type:** Explainer
**Status:** Draft
**Systems:** Hub, HubComponents, AndroidUtils
**Author:** Claude Code (Claude Opus 5.5), directed by Kenny Krosky
**Date:** 2026-10-20
**Related:** LLP 0000, LLP 0005

## Summary

The dashboard's right sidebar has a Network section. It lists the HTTP requests the app on the selected device makes: method, status, path, host, time, and size, and for a selected request its headers, request body, and response body.

The Hub reads this traffic from the app's React Native inspector, through the Metro server the Hub runs in. It does not proxy the device. The section works the same way on iOS simulators and Android emulators, because both connect to Metro the same way ([constraint 10](0000-expo-device-hub.explainer.md#same-behavior)).

Choosing the inspector over a device proxy was a product decision: it needs no proxy, certificate, or device setting, and it sees request bodies, at the cost of seeing only the app's own JavaScript traffic [confirmed] (Kenny Krosky, 2026-10-20). serve-sim's iOS network capture ([LLP 0005](0005-serve-sim-network-capture.explainer.md)) is separate and unchanged.

## How it works

The server half is `src/server/network-inspector.ts` and `src/server/network-targets.ts` in `packages/expo-device-hub`. The dashboard half is `src/dashboard/useNetworkInspector.ts` and `NetworkSection` in `@expo/hub-components`. They talk over the gated socket `/api/network/ws`, with the messages in `src/network-protocol.ts`.

1. The dashboard opens the socket only while the Network section is open, with the selected device's platform, id, name, and version in the query.
2. The server finds the Metro server ([Metro](#metro)), reads its inspector targets from `/json/list`, and picks the one that runs on the device ([Matching a device](#matching-a-device)).
3. It connects to the target's `/inspector/debug` socket as a second debugger ([Origin](#origin)) and sends `Network.enable`.
4. It folds `Network.requestWillBeSent`, `requestWillBeSentExtraInfo`, `responseReceived`, `loadingFinished`, and `loadingFailed` into one record per request, redacts header values ([Redaction](#redaction)), and streams each change to every dashboard watching that device. CDP does not order `requestWillBeSentExtraInfo` relative to `requestWillBeSent`, so extra headers that arrive first are held until their request does [observed: `#bufferExtraHeaders`].
5. A response body is fetched only for the selected request, once its response is complete and while its Response body block is open, with `Network.getResponseBody`, and only the asking dashboard receives it. A JSON body shows as a tree whose objects and arrays fold [observed: `RequestDetails` and `JsonBody` in `NetworkSection.tsx`]. The dashboard gives up after 10 seconds, or at once when its socket is reconnecting, and offers to try again [observed: `useNetworkInspector`].

One server session per device is shared by all its dashboards. It polls `/json/list` every 2 seconds while anyone watches, follows the app to a new page after it reconnects, and is disposed 30 seconds after its last dashboard leaves [observed: `NetworkSession` in `network-inspector.ts`].

It keeps at most 500 requests. When it drops the oldest, the `request` message that caused it names the dropped ids in `evicted`, and dashboards drop them too, so a panel left open stays as bounded as a new one.

The inspector numbers requests per connection, and a reconnected app starts again from the same ids. So the session numbers its inspector connections and gives each request the id `<connection>.<inspector id>`. A redirect reuses the inspector id and carries the previous hop's response: the session finishes that hop with the redirect status and lists the next hop as `<connection>.<inspector id>~<hop>`. A body can be fetched only for a request from the current connection; the inspector of an earlier one no longer has it [observed: `#onRequestWillBeSent` and `#sendResponseBody`].

### Metro

As an Expo CLI plugin, the Hub server runs inside the Metro server, and Expo builds the request it hands the plugin from the `Host` header, so the request names Metro's port [observed: `DevToolsPluginServerHelpers.js` in `@expo/cli` 58]. The standalone CLI serves the Hub on its own port, so it needs `EXPO_DEVICE_HUB_METRO_URL`; without it the section reports that no Metro server answers [observed: `metroOriginFor`].

`EXPO_DEVICE_HUB_METRO_URL` must name a host on this machine: `127.0.0.1`, `localhost`, or `[::1]`. Any other host, or a value that is not a URL, is reported in the section as unavailable, with the reason, and the socket stays open so the dashboard does not reconnect in a loop. The inspector session carries the app's traffic and response bodies, so it never leaves the machine, and Expo CLI would refuse a remote debugger anyway (below).

The server always reaches Metro on loopback: Expo CLI serves the inspector middleware only to loopback sockets and closes any debugger socket that is not local [observed: `createDebugMiddleware.js` and `isLocalSocket` in `@expo/cli` 58].

### Origin

Two checks gate a debugger socket, and both read the `Origin` header:

- React Native's inspector proxy accepts its own base URL or a loopback host name (`localhost`, `127.0.0.1`, `0.0.0.0`, `[::]`), and answers anything else with 401 [observed: `#createDebuggerConnectionWSServer` in `@react-native/dev-middleware` `InspectorProxy.js`].
- Expo CLI then terminates the socket, right after the handshake, if the origin's host is not exactly its base URL's host [observed: `isMatchingOrigin` in `@expo/cli` `utils/net.js`]. That base URL is `127.0.0.1:<port>` by default [observed: `instantiateMetro.js`, "typically configured as 127.0.0.1:8081"].

So `http://localhost:8081` passes the first check and is then closed by the second. The server offers `127.0.0.1` first and `localhost` second, and treats a connection that closes before `Network.enable` answers as refused [observed: `inspectorOrigins` and `#tryAttach`].

Sending `Origin` needs a WebSocket client that takes headers. Under Node the server uses `ws`. Under Bun, the `ws` the bundle inlines never gets a working connection, so the server uses Bun's global `WebSocket`, which accepts `{ headers }`, behind the same listener interface [observed: `connectInspector`; both attached and answered `Network.enable` against an Expo SDK 58 app, 2026-10-20].

### A second debugger

The Hub's connection does not disconnect React Native DevTools when the app's page reports the `supportsMultipleDebuggers` capability; otherwise the proxy closes the previous debugger of that page [observed: `handleDebuggerConnection` in `@react-native/dev-middleware` `Device.js`]. A development build on React Native 0.88 reported it on iOS and Android [observed: `/json/list`, 2026-10-20].

### Matching a device

Each target names its device, and the names differ by platform:

| Platform | React Native's `deviceName`                                                                                                          | The Hub compares it with                                        |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| iOS      | The simulator's own name [observed: a simulator named `iPhone Duo (iOS 27.1)` listed as exactly that]                                | The Hub device's name, then `<name> (<version>)`                |
| Android  | `<model> - <release> - API <sdk>` [observed: `sdk_gphone16k_arm64 - 17 - API 37` for an emulator with those props], not the AVD name | The same string, built from `getprop` through `readDeviceProps` |

When a device runs several connected apps, the one Metro listed last wins [observed: `matchTarget`].

A name is all the Hub can match on, and two simulators or emulators of one model can share it. Each target also reports React Native's `logicalDeviceId`, which differs between devices. When apps on more than one device answer to a name, the section attaches to neither and asks the user to rename one device, rather than show another device's traffic [observed: `matchTarget`].

## Redaction

Header values whose names look like credentials are replaced with `[REDACTED]`, with the same rules as serve-sim's capture ([LLP 0005](0005-serve-sim-network-capture.explainer.md#redaction-and-its-limits)). The Hub cannot import serve-sim's `redact.ts`, because it ships serve-sim vendored ([LLP 0000](0000-expo-device-hub.explainer.md#the-device-servers-are-mounted-in-the-hub-server)), so `network-redact.ts` keeps a copy and `network-redact.test.ts` checks it against serve-sim's rules.

URLs, query strings, and bodies are not redacted. The panel is as open as React Native DevTools' own Network tab, and the Hub's session token gates the socket like every other route.

## Limits

- Only the app's own JavaScript `fetch` and `XMLHttpRequest` traffic is seen, and only while the app is a development build connected to this Metro server. Native SDK traffic and other apps are not.
- React Native can report a large response body shorter than its `Content-Length`; the panel shows what it received and says the body is cut short [observed: a 116,603-byte JSON response returned as 116,559 characters ending mid-value, 2026-10-20].
- Only apps on uniquely named devices can be watched ([Matching a device](#matching-a-device)).
