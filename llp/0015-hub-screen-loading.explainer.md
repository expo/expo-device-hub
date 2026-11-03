# LLP 0015: Device screen loading

**Type:** Explainer
**Status:** Draft
**Systems:** HubClient, HubComponents, Hub
**Author:** Claude Code (Claude Opus 5.5), directed by Krystof Woldrich
**Date:** 2026-10-21
**Revised:** 2026-11-18 (the flat screen's first load is the website's glow on a black screen, with the stages in [Stages](#stages); Claude Code (Claude Fable 5.2), directed by Krystof Woldrich); 2026-11-03 (the 3D preview loads Expo's device models, not Xcode's; Claude Code, directed by Krystof Woldrich); 2026-11-03 (deep review: the MJPEG effect, not `attachVideo`, stops a detached `<img>`; Claude Code, approved by Krystof Woldrich); 2026-11-03 (round-3 review: the MJPEG effect follows the attached `<img>`; Claude Code, directed by Krystof Woldrich); 2026-11-03 (round-2 review: one hook owns the session status, and a 3D scene that fails after it loads falls back; Claude Code, directed by Krystof Woldrich); 2026-11-02 (decision 6 confirmed by Krystof Woldrich, with a minor version bump; Claude Code, directed by Krystof Woldrich); 2026-11-02 (an unavailable 3D model ends the first-load wait; Claude Code, directed by Krystof Woldrich); 2026-10-29 (the iOS screen session is keyed on the device that `/api` resolved; Claude Code, directed by Krystof Woldrich); 2026-10-21 (round-1 review: MJPEG frame keeping, helper restarts, the iOS drop limit, the model timeout; Claude Code, directed by Krystof Woldrich)
**Related:** LLP 0000, LLP 0004, LLP 0012, LLP 0013

## Summary

A device screen has one loading state until its first frame. The flat screen shows it as a glow that moves around a black screen, as on the expo.dev website; the iPhone Duo's 3D preview shows it as one spinner. After the first frame, a lost stream keeps the last frame on screen and shows no loading state. Errors replace the loading state. This applies to iOS and Android and to every transport.

`@expo/hub-client` decides the state. `@expo/hub-components` draws the stages of the screen and the error notice.

> **Provenance.** An agent wrote this document from the code it changed. `[observed]` claims give their source. File paths are relative to `packages/@expo/hub-client/src` or `packages/@expo/hub-components/src`. The direction came from Krystof Woldrich in the agent brief. The orchestrating agent made the decisions in [Decisions for review](#decisions-for-review); a human has not reviewed them yet, so this document stays `Draft`.

## Direction

Krystof Woldrich asked for this behavior on 2026-10-21, through the agent brief for this change:

- No black screen while a device screen loads.
- One loading presentation, not different texts such as "Connecting…", "Not connected", or "Starting".
- One spinner until the 2D screen or the 3D preview has loaded for the first time.
- No spinner when the stream drops temporarily after it loaded. The last frame stays.
- Errors stay errors. A spinner must not hide a failure forever.

On 2026-11-17, through the agent brief for the dashboard design stack, he asked for the website's loading presentation in the dashboard:

- The device shape shows at once when a device is selected, as on the website.
- Before the stream connects, the black device shape shows the website's colorful animation.
- The website's other animations and states of the screen come over too.

This replaces two points of 2026-10-21 for the flat screen: the screen is black while it loads, and the loading presentation is the glow, not a spinner. The other points stay: one loading presentation, no loading state over a loaded screen that reconnects, and errors stay errors. [Stages](#stages) says how the dashboard draws this, and where it differs from the website.

## Screen sessions

A screen session is one connection with one surface and one media element kind [observed: `screenSessionKey` in `useIosDevice.ts` and `useAndroidDevice.ts`]:

- the connection: server URL, device, and session token. On iOS the device is the one `/api` resolved, or the requested one until `/api` answers, so a different simulator that `/api` picks when no device is requested is a new session [observed: `knownConfig?.device ?? targetDevice` in `useIosDevice.ts`];
- the surface: the flat screen, or separate displays (iOS only; the 3D preview attaches them);
- the media element: `img` (MJPEG), `canvas` (H.264), or `video` (WebRTC).

A change of any part starts a new session, which loads again with the spinner. These count as a first load:

- a device switch, or a server or token change;
- a reconnect of the Hub's own device list, which makes the client idle first;
- a switch between the 2D screen and the 3D preview;
- a transport switch, also the automatic fallback from H.264 to MJPEG, because the new element has no frame to keep;
- a helper that restarts for a different device.

Each adapter keeps its own status in `useSessionStatus`, which resets it to `connecting` in the render that changes the session. Without that reset, the render would still hold the previous session's `streaming`, which must never count as the new session's first frame [observed: `useSessionStatus` and `useScreenPresentation` in `screen-presentation.ts`].

## States

`useScreenPresentation` maps each adapter's own status onto what a consumer sees [observed: `presentScreen` in `screen-presentation.ts`]:

| Returned `status` | `framePresented` | The screen shows                                          | Status pill  |
| ----------------- | ---------------- | --------------------------------------------------------- | ------------ |
| `idle`            | false            | a black screen                                            | Offline      |
| `connecting`      | false            | the glow on the black screen (3D preview: the spinner)    | Loading      |
| `streaming`       | true             | live frames                                               | Live         |
| `reconnecting`    | true             | the last frame, with nothing over it                      | Reconnecting |
| `error`           | false or true    | the reason on the screen, or a notice over the last frame | Error        |

- Before the first frame, an adapter's `connecting` or `reconnecting` is `connecting`.
- After the first frame, an adapter's `connecting` or `reconnecting` is `reconnecting`. A session that showed a frame never returns to `connecting`.
- `framePresented` stays true while the session reconnects or fails. Outside `idle` and `error`, it is false exactly while the status is `connecting`, so the first-load state follows `connecting` [observed: `deviceScreenLoading` in `dashboard/DeviceScreenStatus.tsx`, `deviceScreenStage` in `dashboard/DeviceScreenStage.tsx`].
- Until `framePresented` is true, `DeviceScreen` keeps its media element transparent, because the element can still hold a previous session's frame [observed: `deviceScreenMediaStyle` in `DeviceScreen.tsx`]. Opacity, not `visibility` or `display`, keeps the element laid out, so the browser keeps decoding into it [inferred]. Its `<img>` has an empty `alt`, so a failed request never shows a broken-image text; the input surface names the screen [observed: `DeviceScreen.tsx`].

The 3D preview loads until the device's model is loaded into the scene **and** the active display has a frame. Until then it is transparent, so it never shows a model with black displays; it also takes no focus, is not announced, and gives up the focus when it hides again, for example after a transport switch [observed: `tabIndex`, `aria-hidden`, and `useReleaseFocusWhenHidden` in `foldable/DeviceModelScreen.tsx`]; and the status pill says Loading even while the client already streams [observed: `hidden` in `foldable/DeviceModelScreen.tsx`, `modelSettledDevice` in `dashboard/PhoneFrame.tsx`, `screenLoading` in `dashboard/StreamPanel.tsx`]. A model that is unavailable ends this wait as well, because the preview then shows the flat display, which has its own frame; the spinner then follows only the first frame, also when the consumer gives no `onUnavailable`. That flat fallback also stays transparent, unfocusable, and inert until the session's first frame, because its element can still hold a previous session's pixels [observed: `modelSettled` and `hidden` in `foldable/DeviceModelScreen.tsx`].

## Stages

The flat screen draws one opaque layer per stage under its stream, in the look of the website's simulator preview (`SimulatorPreviewScreen.tsx` and `simulator-preview-screen.module.css` in expo/universe, at `d24ccaa940`) [observed: `DeviceScreenStageLayers` in `dashboard/DeviceScreenStage.tsx`, the `hub-screen-*` rules in `theme/theme.css`]:

| Stage         | When                                  | The screen shows                                                                      |
| ------------- | ------------------------------------- | ------------------------------------------------------------------------------------- |
| `off`         | no client, or the client is `idle`    | black, like a device that is off                                                      |
| `connecting`  | the session has no frame and no error | the glow: a light along the edge of the black screen, with colors that move around it |
| `live`        | the session presented a frame         | the stream, or its last frame; no layer under it                                      |
| `unavailable` | the session has an error and no frame | a phone icon, "Device screen unavailable", and the error text                         |

- **The shape shows at once.** The frame takes the proportions of the device's screen shape before the stream reports its size, so it does not change its size when the stream starts. The Hub looks the shape up from the model that the server sends [observed: `useDeviceScreenShape` in `expo-device-hub/src/dashboard/useDeviceScreenShape.ts`, `screenShape` and `ratio` in `dashboard/PhoneFrame.tsx`]. A device without a known shape keeps the placeholder proportions and shows the glow in the whole rectangle.
- **The glow follows the screen.** Its lengths are a share of the screen's short side, the share that the website's lengths have of its 18rem device, so a large frame glows like a small one. Its corners take the circle that is closest to each superellipse corner of the shape; the clip of `DeviceShape` still gives the exact outline [observed: `screenShapeBorderRadius` in `dashboard/DeviceScreenStage.tsx`, `--hub-screen-unit` in `theme/theme.css`].
- **The first frame fades in.** The live picture fades in above the glow in 550 ms. The glow stays opaque for that time, so the page never shows through, then it fades out in 650 ms and its layer goes [observed: `useLingering` in `dashboard/useLingering.ts`]. After that no solid layer is under the stream (LLP 0017, [Hub dashboard](0017-hub-client-screen-shapes.spec.md#hub-dashboard)). The layer of each stage does the same: a session that recovers from the `unavailable` stage keeps its notice under the picture for the fade. A stage that follows another stage shows at once, without a fade, because a layer that fades in would let the page show through [observed: `last` and `leaving` in `DeviceScreenStageLayers`].
- **A loaded screen never returns to the glow.** The stage follows `framePresented`, so a reconnect or an error after the first frame keeps the `live` stage, and the error notice covers the last frame as before.
- **The status pill** has the website's indicator: the dot of a status that is in progress (Loading, Reconnecting, Live) sends out a ring that grows and fades; Offline and Error are still. A new status label enters with a short fade [observed: `STATUS_APPEARANCE` in `dashboard/DeviceTitle.tsx`, `pulse` in `components/StatusDot.tsx`].
- **Reduced motion.** The glow does not move, the picture and the stage layers do not fade, and the dot does not pulse.
- **Announcements.** The glow is a status region with the hidden text "Loading", as the spinner was. The reason of the `unavailable` stage is an alert.

The dashboard differs from the website in these points:

- The website shows the glow again while a loaded stream reconnects. The dashboard keeps the last frame, by the direction of 2026-10-21.
- The website's `boot` stage (the Expo mark with three rings, while a cloud simulator starts) and its `ending` stage ("Session ended") have no state in the dashboard: a device that boots shows its progress in the add-device menu, and a device that shuts down leaves the list.
- The glow's colors fade in over 400 ms on the black screen. On the website they show at once with the page; in the dashboard a device switch would cut from a live picture to the full glow.
- The iPhone Duo's 3D stage keeps the spinner. The stage is a square that holds the model, so it has no screen edge for the glow.
- The animations are CSS. The website uses `framer-motion` for them; the dashboard needs no layout animation and no per-frame values for these stages, so it takes no new dependency.

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
- MJPEG: after the first frame, iOS loads a retry in a detached `Image` and gives the request to the visible `<img>` only after that image has a frame, so a failed retry never replaces the last frame. A browser clears an `<img>` while its new request loads, so at the hand-over the retry's frame stays behind the visible `<img>` as its background until the `<img>` paints its own frame (in headless Chromium, the `<img>` reported a width of 0 in one 100 ms sample at a hand-over, observed 2026-10-21) [observed: `bridgeMjpegFrame` in `useIosDevice.ts`]. The MJPEG effect follows the attached `<img>`, which the client keeps in state as it keeps the WebRTC `<video>`. A new `<img>` starts the effect again with its own request, listeners, and recovery: a pending retry for the old element stops, the new element's first frame ends the gap, and its own failure retries. A new `<img>` for the same stream keeps the status until it paints or fails [observed: `mjpegImageElement` and `mjpegStreamRef` in `useIosDevice.ts`]. Within the same screen session, the visible `<img>` keeps its `src` while the config is missing; only a detached or replaced `<img>`, another session, or an unmount removes it. The MJPEG effect, not `attachVideo`, removes it, so the same `<img>` detached and attached again in one commit keeps its request [observed: `load`, `handOver`, and the cleanup of the MJPEG effect in `useIosDevice.ts`].
- 3D preview: the scene keeps the last texture while a display has no frame [observed: `currentSource` and `uploadScreen` in `foldable/duo-scene.ts`].

While a helper restarts, iOS keeps what the last config of the same connection said, so the session, its element, and its surface stay [observed: `knownConfig` and `viewScreen` in `useIosDevice.ts`]:

- the stream mode: a missing config does not fall back to the requested mode, which can need another element;
- the Duo's identity and its 3D model URL, so the 3D preview stays mounted;
- the screen config for the view: the frame keeps its shape, and the fold keeps its angle and its active display. Pointer input maps back with the same config, so a tap lands where the user sees it, also while the new helper has not sent its config yet [observed: `viewScreenRef` in the input callbacks of `useIosDevice.ts`]. Command handling and the display check for 3D input still read only the helper's own config. Another device never inherits it;
- the H.264 to MJPEG fallback, which a new pid no longer resets. This holds while the helper keeps its URL, as with the Hub's proxied helpers; a helper without the proxy that restarts on another port has a new URL, which resets the fallback [observed: `avccFallbackScope` in `useIosDevice.ts`].

On iOS, a temporary drop stays `reconnecting` until the stream returns, the adapter reports a real error, or the drop lasts 30 s (see [Errors](#errors)). Android keeps its own reconnect grace: after 5 s without the stream, it reports `error` ("Disconnected — retrying…" or the WebRTC error), and a source switch can hold `reconnecting` longer [observed: `STREAM_RECONNECT_GRACE_MS` in `stream-reconnect.ts`, the WebRTC status effect in `useAndroidDevice.ts`].

## Errors

- **First-load timeout.** A session without a frame after 30 s reports `error` with "The device screen did not load. Retrying…". The adapter keeps retrying, and a later frame turns the session to `streaming`. The timer stops while the tab is hidden and starts again when it is visible, like the WebRTC first-frame timeout [observed: `SCREEN_LOAD_TIMEOUT_MS` and `useScreenPresentation` in `screen-presentation.ts`].
- **iOS drop limit.** A loaded iOS screen that stays `reconnecting` for 30 s reports `error` with "Disconnected — retrying…", the same text as Android. The notice covers the last frame, and the client keeps retrying; a new frame returns to `streaming`. The timer pauses in a hidden tab like the load timer. Android keeps its own 5 s grace and takes no extra limit [observed: `dropTimeoutMs` in `screen-presentation.ts` and its caller in `useIosDevice.ts`].
- **Retries are not errors.** A WebRTC transport retry sets an error text without a failure; the hook reconnects by itself. Both adapters and the Duo panels treat it as a gap, not as an error [observed: `retrying` in `useWebRtcStream.ts`]. The iOS MJPEG `<img>` retry and an iOS H.264 re-read are gaps too [observed: `onError` and `onConnecting` in `useIosDevice.ts`].
- **Real errors stay.** A refused offer, an unsupported browser, an exhausted codec ladder, and an Android outage past its grace report `error` at once, before or after the first frame.
- **3D model.** A model that is missing, broken, or not loaded in 30 s makes the 3D preview unavailable, and so does a scene that fails after it loaded, such as a lost WebGL context, and the Hub shows the flat screen, as for a model failure before. The 30 s count only while the tab is visible. A slow host therefore falls back to 2D until the user selects 3D again or switches the device [observed: `useVisibleTimeout` and `unavailable` in `foldable/DuoModelView.tsx`; `setDuoModelUnavailableFor` in `packages/expo-device-hub/src/Dashboard.tsx`].

## Where each part lives

LLP 0004 [3D preview in the Hub](0004-serve-sim-hinge-controls.explainer.md#3d-preview-in-the-hub) and LLP 0013 [Input feedback](0013-hub-client-input-and-control.explainer.md#input-feedback) give the rule: hub-client supplies controls, streams, and state; product notices belong to consumers.

- **hub-client** decides the state: `status`, `error`, and `framePresented` on `DeviceClient` and `DeviceScreenClient` [observed: `types.ts`, `useDeviceScreenClient.ts`]. `DeviceScreen` draws no background, spinner, or error; it only hides media without a session frame [observed: `DeviceScreen.tsx`]. A consumer that uses `DeviceScreen` without `PhoneFrame`, such as the Expo website, draws loading and errors itself.
- **hub-components** draws them. `DeviceScreenStageLayers` draws the stages of the flat screen (see [Stages](#stages)). `ActivityIndicator` is the spinner of the 3D stage; its status region holds the label "Loading" as visually hidden text, and the glow and the status pill use the same label [observed: `components/ActivityIndicator.tsx`, `dashboard/DeviceScreenStage.tsx`, `dashboard/DeviceTitle.tsx`]. `DeviceScreenStatus` draws that spinner and one error notice, over the 3D stage and over a flat screen that has a frame, with the input notice's tokens [observed: `dashboard/DeviceScreenStatus.tsx`, `dashboard/PhoneFrame.tsx`].
- **The Hub** renders `StreamPanel` and needs no code of its own for this.

## Decisions for review

The orchestrating agent decided these on 2026-10-21. A human has not reviewed them yet, except decision 6.

1. One loading label, "Loading", for the status pill and as the spinner's accessible name.
2. The first load reports an error after 30 s without a frame, and the client keeps retrying. On iOS, a drop does not take Android's 5 s limit. Android's drop timing stays as it was.
3. On iOS, a drop that lasts 30 s, the first load's limit, shows "Disconnected — retrying…" over the last frame, and the client keeps retrying (round-1 review, 2026-10-21).
4. The device's model gets the same 30 s, counted in a visible tab, before the 3D preview falls back to 2D (round-1 review, 2026-10-21). This was Xcode's iPhone Duo model until Expo's models replaced it on 2026-11-03.
5. A transport switch counts as a first load.
6. `DeviceScreen` loses its overlay; a consumer that uses it without `PhoneFrame` must draw loading and errors. Krystof Woldrich confirmed this and kept it a minor version bump, because the packages are in an early phase and the Expo website draws its own connecting, reconnecting, and failure states [confirmed] (Krystof Woldrich, 2026-11-02). The rule is in LLP 0013 [Input feedback](0013-hub-client-input-and-control.explainer.md#input-feedback).
7. The spinner's look is not compared with the website's `ActivityIndicator`, whose source is not in this repository. Since 2026-11-18 only the 3D stage shows the spinner.
8. The status pill does not say Live while the 3D preview loads.

Claude Code (Claude Fable 5.2) decided these on 2026-11-18, for the direction of 2026-11-17. A human has not reviewed them yet.

9. An error before the first frame takes the layout of the website's "Live preview unavailable" state, with the client's error as its text, on `bg.element`. The notice at the bottom of the screen stays for an error after the first frame and for an input error.
10. A reconnect of a loaded screen keeps the last frame and does not show the glow, which the website shows. The direction of 2026-10-21 stays in force for it.
11. An idle screen is black, not `bg.element`, so a screen that starts to connect does not change its color.
12. The website's `boot` and `ending` stages are not ported, because the dashboard has no state for them.
13. The 3D stage keeps the spinner.
14. The stages are CSS, without `framer-motion`.

One consequence of 2 and the rule in [States](#states): on Android, after its grace and a source-switch timeout without an error, the adapter's `connecting` used to reach the screen as `connecting`. It is now `reconnecting`, because `connecting` means a first load.

## Open questions

- A multipart MJPEG stream that ends without an error keeps its last frame and reports nothing, so a frozen MJPEG screen stays `streaming` until a new config or request arrives. This change does not detect it; WebRTC has the stall watchdog of LLP 0012 [observed: by the round-1 reviewer in headless Chromium; the MJPEG effect in `useIosDevice.ts` has no stall check].
