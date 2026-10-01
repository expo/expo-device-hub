---
"@expo/hub-client": minor
---

Send the `token` option from `useAndroidDeviceClient` too, and add it to `useActiveDeviceClient`, for a page that connects to a Hub started with `--require-token` from another origin. The Android client sends the token as a bearer header, as a `serve-emu.token.` WebSocket subprotocol, and as `?token=` only where a browser cannot set a header: the logcat and metrics `EventSource` streams, the camera image URLs, and the WebRTC close URL. The Hub does not allow other origins through CORS yet. So from another origin, this covers the Android H.264 stream and input socket, and the iOS client only from a loopback origin, without the features that use serve-sim's control socket.
