# LLP 0015: Device screen loading

**Type:** Explainer
**Status:** Draft
**Systems:** HubClient, HubComponents, Hub
**Author:** Claude Code (Claude Opus 5.5), directed by Krystof Woldrich
**Date:** 2026-10-21
**Revised:** 2026-10-21 (round-1 review: MJPEG frame keeping, helper restarts, the iOS drop limit, the model timeout; Claude Code, directed by Krystof Woldrich)
**Related:** LLP 0000, LLP 0004, LLP 0012, LLP 0013

## Summary

A device screen shows one spinner until its first frame. After that frame, a lost stream keeps the last frame on screen and shows no spinner. Errors replace the spinner. This applies to iOS and Android, to every transport, and to the flat screen and the iPhone Duo's 3D preview.

`@expo/hub-client` decides the state. `@expo/hub-components` draws the spinner and the error notice.

> **Provenance.** An agent wrote this document from the code it changed. `[observed]` claims give their source. File paths are relative to `packages/@expo/hub-client/src` or `packages/@expo/hub-components/src`. The direction came from Krystof Woldrich in the agent brief. The orchestrating agent made the decisions in [Decisions for review](#decisions-for-review); a human has not reviewed them yet, so this document stays `Draft`.

## Direction

Krystof Woldrich asked for this behavior on 2026-10-21, through the agent brief for this change:

- No black screen while a device screen loads.
- One loading presentation, not different texts such as "Connecting…", "Not connected", or "Starting".
- One spinner until the 2D screen or the 3D preview has loaded for the first time.
- No spinner when the stream drops temporarily after it loaded. The last frame stays.
- Errors stay errors. A spinner must not hide a failure forever.

## Screen sessions

A screen session is one connection with one surface and one media element kind [observed: `screenSessionKey` in `useIosDevice.ts` and `useAndroidDevice.ts`]:

- the connection: server URL, device, and session token;
- the surface: the flat screen, or separate displays (iOS only; the 3D preview attaches them);
- the media element: `img` (MJPEG), `canvas` (H.264), or `video` (WebRTC).

A change of any part starts a new session, which loads again with the spinner. These count as a first load:

- a device switch, or a server or token change;
- a reconnect of the Hub's own device list, which makes the client idle first;
- a switch between the 2D screen and the 3D preview;
- a transport switch, also the automatic fallback from H.264 to MJPEG, because the new element has no frame to keep;
- a helper that restarts for a different device.

Each adapter resets its own status to `connecting` in the render that changes the session. That render still holds the previous session's `streaming`, and it must never count as the new session's first frame [observed: the in-render resets in both adapters; `useScreenPresentation` in `screen-presentation.ts`].

## States

`useScreenPresentation` maps each adapter's own status onto what a consumer sees [observed: `presentScreen` in `screen-presentation.ts`]:

| Returned `status` | `framePresented` | The screen shows                                       | Status pill  |
| ----------------- | ---------------- | ------------------------------------------------------ | ------------ |
| `idle`            | false            | the idle surface                                       | Offline      |
| `connecting`      | false            | the spinner on the empty device surface                | Loading      |
| `streaming`       | true             | live frames                                            | Live         |
| `reconnecting`    | true             | the last frame, with nothing over it                   | Reconnecting |
| `error`           | false or true    | the error notice, over the empty surface or last frame | Error        |

- Before the first frame, an adapter's `connecting` or `reconnecting` is `connecting`.
- After the first frame, an adapter's `connecting` or `reconnecting` is `reconnecting`. A session that showed a frame never returns to `connecting`.
- `framePresented` stays true while the session reconnects or fails.
- Until `framePresented` is true, `DeviceScreen` keeps its media element transparent, because the element can still hold a previous session's frame [observed: `deviceScreenMediaStyle` in `DeviceScreen.tsx`]. Opacity, not `visibility` or `display`, keeps the element laid out, so the browser keeps decoding into it [inferred]. Its `<img>` has an empty `alt`, so a failed request never shows a broken-image text; the input surface names the screen [observed: `DeviceScreen.tsx`].

The 3D preview loads until Xcode's model is loaded into the scene **and** the active display has a frame. Until then it is transparent, so it never shows a model with black displays, and the status pill says Loading even while the client already streams [observed: `hidden` in `foldable/FoldableDeviceScreen.tsx`, `modelReadyDevice` in `dashboard/PhoneFrame.tsx`, `screenLoading` in `dashboard/StreamPanel.tsx`].

## Temporary drops

After the first frame, these keep the last frame and show no spinner:

- a WebRTC reconnect, a codec retry, or a stall recovery (LLP 0012);
- an H.264 or MJPEG request that ends or fails and retries;
- a helper restart for the same device, a new helper pid, and a config refresh, also while `/api` has no config;
- a capture reboot, and a stream-settings change;
- an Android capture-source switch;
- an iPhone Duo panel handoff, and a presented panel that is silent for a few seconds.

How each element keeps its frame:

- WebRTC: before the peer closes, both adapters copy the current frame into the video's `poster`. The poster stays until fresh video paints, and it never copies another session's frame. This was Android's rule; iOS now uses the same helper [observed: `preserveVideoFrame` in `video-frame-poster.ts`, `preserveWebRtcFrame` in both adapters].
- H.264: the canvas keeps its pixels until the next frame [observed: `useAvccStream.ts`, `useAndroidDevice.ts`].
- MJPEG: after the first frame, iOS loads a retry in a detached `Image` and gives the request to the visible `<img>` only after that image has a frame, so a failed retry never replaces the last frame. A browser clears an `<img>` while its new request loads, so at the hand-over the retry's frame stays behind the visible `<img>` as its background until the `<img>` paints its own frame (in headless Chromium, the `<img>` reported a width of 0 in one 100 ms sample at a hand-over, observed 2026-10-21) [observed: `bridgeMjpegFrame` in `useIosDevice.ts`]. Within the same screen session, the visible `<img>` keeps its `src` while the config is missing; only another session or an unmount removes it [observed: `load`, `handOver`, and `keepFrame` in the MJPEG effect of `useIosDevice.ts`].
- 3D preview: the scene keeps the last texture while a display has no frame [observed: `currentSource` and `uploadScreen` in `foldable/duo-scene.ts`].

While a helper restarts, iOS keeps what the last config of the same connection said, so the session, its element, and its surface stay [observed: `knownConfig` and `viewScreen` in `useIosDevice.ts`]:

- the stream mode: a missing config does not fall back to the requested mode, which can need another element;
- the Duo's identity and its 3D model URL, so the 3D preview stays mounted;
- the screen config for the view: the frame keeps its shape, and the fold keeps its angle and its active display. Command handling still reads only the helper's own config. Another device never inherits it;
- the H.264 to MJPEG fallback, which a new pid no longer resets.

On iOS, a temporary drop stays `reconnecting` until the stream returns, the adapter reports a real error, or the drop lasts 30 s (see [Errors](#errors)). Android keeps its own reconnect grace: after 5 s without the stream, it reports `error` ("Disconnected — retrying…" or the WebRTC error), and a source switch can hold `reconnecting` longer [observed: `STREAM_RECONNECT_GRACE_MS` in `stream-reconnect.ts`, the WebRTC status effect in `useAndroidDevice.ts`].

## Errors

- **First-load timeout.** A session without a frame after 30 s reports `error` with "The device screen did not load. Retrying…". The adapter keeps retrying, and a later frame turns the session to `streaming`. The timer stops while the tab is hidden and starts again when it is visible, like the WebRTC first-frame timeout [observed: `SCREEN_LOAD_TIMEOUT_MS` and `useScreenPresentation` in `screen-presentation.ts`].
- **iOS drop limit.** A loaded iOS screen that stays `reconnecting` for 30 s reports `error` with "Disconnected — retrying…", the same text as Android. The notice covers the last frame, and the client keeps retrying; a new frame returns to `streaming`. The timer pauses in a hidden tab like the load timer. Android keeps its own 5 s grace and takes no extra limit [observed: `dropTimeoutMs` in `screen-presentation.ts` and its caller in `useIosDevice.ts`].
- **Retries are not errors.** A WebRTC transport retry sets an error text without a failure; the hook reconnects by itself. Both adapters and the Duo panels treat it as a gap, not as an error [observed: `retrying` in `useWebRtcStream.ts`]. The iOS MJPEG `<img>` retry and an iOS H.264 re-read are gaps too [observed: `onError` and `onConnecting` in `useIosDevice.ts`].
- **Real errors stay.** A refused offer, an unsupported browser, an exhausted codec ladder, and an Android outage past its grace report `error` at once, before or after the first frame.
- **3D model.** A model that is missing, broken, or not loaded in 30 s makes the 3D preview unavailable, and the Hub shows the flat screen, as for a model failure before. The 30 s count only while the tab is visible. A slow host therefore falls back to 2D until the user selects 3D again or switches the device [observed: `useVisibleTimeout` in `foldable/DuoModelView.tsx`; `setDuoModelUnavailableFor` in `packages/expo-device-hub/src/Dashboard.tsx`].

## Where each part lives

LLP 0004 [3D preview in the Hub](0004-serve-sim-hinge-controls.explainer.md#3d-preview-in-the-hub) and LLP 0013 [Input feedback](0013-hub-client-input-and-control.explainer.md#input-feedback) give the rule: hub-client supplies controls, streams, and state; product notices belong to consumers.

- **hub-client** decides the state: `status`, `error`, and `framePresented` on `DeviceClient` and `DeviceScreenClient` [observed: `types.ts`, `useDeviceScreenClient.ts`]. `DeviceScreen` draws no background, spinner, or error; it only hides media without a session frame [observed: `DeviceScreen.tsx`]. A consumer that uses `DeviceScreen` without `PhoneFrame`, such as the Expo website, draws loading and errors itself.
- **hub-components** draws them. `ActivityIndicator` is the spinner; its status region holds the label "Loading" as visually hidden text, and the status pill uses the same label [observed: `components/ActivityIndicator.tsx`, `dashboard/DeviceTitle.tsx`]. `DeviceScreenStatus` draws the spinner and one error notice, over the flat screen and over the 3D stage, with the input notice's tokens [observed: `dashboard/DeviceScreenStatus.tsx`, `dashboard/PhoneFrame.tsx`]. `PhoneFrame` puts `bg.element` under the live screen, so an empty screen is never black.
- **The Hub** renders `StreamPanel` and needs no code of its own for this.

## Decisions for review

The orchestrating agent decided these on 2026-10-21. A human has not reviewed them yet.

1. One loading label, "Loading", for the status pill and as the spinner's accessible name.
2. The first load reports an error after 30 s without a frame, and the client keeps retrying. On iOS, a drop does not take Android's 5 s limit. Android's drop timing stays as it was.
3. On iOS, a drop that lasts 30 s, the first load's limit, shows "Disconnected — retrying…" over the last frame, and the client keeps retrying (round-1 review, 2026-10-21).
4. Xcode's model gets the same 30 s, counted in a visible tab, before the 3D preview falls back to 2D (round-1 review, 2026-10-21).
5. A transport switch counts as a first load.
6. `DeviceScreen` loses its overlay; a consumer that uses it without `PhoneFrame` must draw loading and errors.
7. The spinner's look is not compared with the website's `ActivityIndicator`, whose source is not in this repository.
8. The status pill does not say Live while the 3D preview loads.

One consequence of 2 and the rule in [States](#states): on Android, after its grace and a source-switch timeout without an error, the adapter's `connecting` used to reach the screen as `connecting`. It is now `reconnecting`, because `connecting` means a first load.

## Open questions

- A multipart MJPEG stream that ends without an error keeps its last frame and reports nothing, so a frozen MJPEG screen stays `streaming` until a new config or request arrives. This change does not detect it; WebRTC has the stall watchdog of LLP 0012 [observed: by the round-1 reviewer in headless Chromium; the MJPEG effect in `useIosDevice.ts` has no stall check].
