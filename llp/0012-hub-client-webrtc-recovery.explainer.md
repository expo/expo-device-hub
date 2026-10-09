# LLP 0012: HubClient WebRTC recovery

**Type:** Explainer
**Status:** Draft
**Systems:** HubClient
**Author:** Gabe Debes
**Date:** 2026-10-06
**Related:** LLP 0000, LLP 0002

## Summary

`@expo/hub-client` has its own browser WebRTC client. It does not import the serve-sim preview client, so a recovery rule that serve-sim's client learns does not reach the Hub or the Expo website by itself [observed: `useWebRtcStream.ts` imports only `@expo/hub-client` modules; LLP 0000 [constraint 2](0000-expo-device-hub.explainer.md#constraints-you-must-not-simplify-away)].

This document explains how the HubClient iOS client recovers a WebRTC stream, and which serve-sim client rule each part copies. Read [LLP 0002](0002-serve-sim-webrtc-architecture.explainer.md) first for the server side and the codec ladder.

> **Provenance.** This draft was written from the code. `[observed]` claims give their source. `[confirmed]` claims name a human and a date. File paths are relative to `packages/@expo/hub-client/src`, unless a path starts with `packages/`. serve-sim client paths are relative to `packages/serve-sim/packages/serve-sim/src/client`.

## Direction

HubClient must recover from WebRTC failures the same way as the serve-sim browser client [confirmed] (Gabe Debes, 2026-10-01). When serve-sim's client changes a recovery rule, change HubClient the same way, or record here why HubClient is different.

## Scope

- In scope: the iOS adapter (`useIosDevice.ts`) and the shared stream hook (`useWebRtcStream.ts`), which the Android adapter also uses.
- Out of scope: the server (LLP 0002), and input and control sockets.

## Signaling deadlines

- A close request (`POST /webrtc/close`) stops waiting after 2 s. A close that never answers must not block the next codec attempt. Page-unload closes use `sendBeacon` or `keepalive` and have no deadline [observed: `closeWebRtcSession` in `webrtc-negotiation.ts`].
- A `409` from `/webrtc/offer` is retried only when it means that offer setup is busy: `webrtc_session_busy` in `code` or `error`, or a `409` with no named error from an older server. Every other named `409` goes back to the caller at once, because retrying cannot clear it [observed: `isSignalingBusy` in `webrtc-negotiation.ts`].
- serve-sim names the busy state in `error`, and serve-emu names it in `code`. Both are accepted [observed: `device-session.ts` in serve-sim, `server.ts` in serve-emu, `webrtc-negotiation.test.ts`].
- Reading the `409` body stays inside the offer deadline, because a body can stall after its headers arrive [observed: `postWebRtcOffer`].

serve-sim's client uses the same 2 s close deadline and the same busy rule [observed: `webrtc-negotiation.ts`].

## Locked transport

serve-sim locks a WebRTC server to WebRTC and refuses its HTTP streams with `409 stream_transport_locked` (LLP 0002). The iOS client treats a session whose `/api` advertises `streamSettings.transport: "webrtc"` as locked [observed: `transportLocked` in `useIosDevice.ts`].

- A locked session never uses an HTTP stream [observed: `iosStreamCapabilities` in `useIosDevice.ts`].
- When the codec ladder is exhausted, the client shows the error "No supported WebRTC codec…" and also starts the ladder again from the requested codec. The wait starts at 2 s, doubles up to 30 s, and resets after 90 s without a codec failure. Every codec failure counts, not only an exhausted ladder [observed: `createLadderBackoff` in `webrtc-fallback.ts`, the failure effect in `useIosDevice.ts`].
- A `404` from `/webrtc/offer` is retried as temporary on a locked session, because the session has no other transport [observed: `isRetryableWebRtcOfferStatus` in `useWebRtcStream.ts`].
- Choosing a codec again resets the backoff [observed: `setWebRtcCodec` in `useIosDevice.ts`].

serve-sim's client restarts the ladder with the same backoff, and it also counts every codec failure [observed: `hooks/use-ladder-restart.ts`, `client.tsx`].

## Bounded stats reads

`getStats()` can fail to return, and the browser cannot cancel it. The client shares one read per peer and stops waiting after 2 s; a timed-out read counts as "no data" [observed: `readStatsBeforeDeadline` in `bounded-webrtc-stats.ts`]. Without this, one stuck read blocked the first-frame check, and each new poll added another stuck read.

serve-sim's client bounds its reads the same way [observed: `readStatsBeforeDeadline` in `hooks/playback-stall-watchdog.ts`].

## Stall policy

After the first frame, a stall is 8 polls of 1 s with no new decoded frame [observed: `webrtc-playback-stall.ts`]. The client then decides what failed:

- Frames arrive but do not decode: the codec failed.
- Nothing arrives: the transport failed.

The first codec stall reconnects with the same codec. A second stall within 30 s demotes the codec. A transport stall always reconnects [observed: `playbackStallAction` in `webrtc-fallback.ts`]. One stall must not demote a codec that works.

Stall detection follows the active video report, so an old report with a high frame total cannot reset it [observed: `selectInboundReport` in `webrtc-playback-stall.ts`].

These rules and numbers are the same as in serve-sim's client, with one difference in report selection. When no report advances, HubClient keeps the pinned report once it has an earlier poll to compare with. serve-sim then switches to the report with the highest lifetime frame total, which can be an old, idle report, and that switch resets the stall count [observed: `selectInboundReport` in both `webrtc-playback-stall.ts` files; `webrtc-failure-policy.ts`].

## Playback watchdog

One poll per peer reads stats once a second. The watchdog and the stats panel share that read, and a slow read skips a tick instead of queueing behind it [observed: `startPlaybackStallWatchdog` in `playback-stall-watchdog.ts`, `exclusive-poll.ts`].

- The watchdog judges only a connected peer that has shown a frame, in a visible tab.
- It resets on `visibilitychange`, and after a poll gap longer than 8 s, because sleep does not always send `visibilitychange`.
- An idle Android stream may send no frames. serve-emu's scrcpy source repeats no frames by default, while its gRPC screenshot source repeats the last frame every 500 ms. The Android adapter sets `expectContinuousFrames: false`, so an idle stream is not a stall with either source [observed: `useAndroidDevice.ts`; `SCRCPY_DEFAULTS.repeatFrameMs` in serve-emu `scrcpy.ts`, `DEFAULT_IDLE_REPEAT_MS` in `grpc-session.ts`].
- During automatic recovery, Android keeps the last frame as a poster, but only on the video element that the adapter attached [observed: `preserveWebRtcFrame` in `useAndroidDevice.ts`].

serve-sim's client has the same watchdog [observed: `hooks/playback-stall-watchdog.ts`].

## Hidden tabs and startup diagnosis

Hidden tabs slow timers and pause video, so the client does not judge a stream while the tab is hidden:

- The first-frame timeout stops while the tab is hidden, and starts again when the tab is visible. A grace period that was already used stays used [observed: `useWebRtcStream.ts`].
- When no video RTP arrives before the first frame, the client asks serve-sim's per-session stats (2 s limit, cancelled on teardown) whether the encoder produced frames. If it did, the client retries the transport and keeps the codec [observed: `requestWebRtcServerStats` in `useWebRtcStream.ts`; `webRtcFailureDisposition` in `webrtc-fallback.ts`].
- On iOS, paused video plays again when the tab returns [observed: `useIosDevice.ts`].

serve-sim's client pauses diagnosis, keeps a used grace, and checks the sender in the same way. HubClient also sends the session token with the sender request and reads only its own session [observed: `hooks/use-webrtc-stream.ts`; `requestWebRtcServerStats` in `stream-stats.ts`].

## H.264 offer level

Chrome offers H.264 level 3.1 by default, which is too low for large simulator screens. iOS offers raise the asymmetric `profile-level-id` to level 5.2 when it is lower. Android offers are unchanged [observed: `webrtc-sdp-level.ts`, `raiseH264Level` in `useIosDevice.ts`]. The level policy is in [LLP 0002](0002-serve-sim-webrtc-architecture.explainer.md#signaling-lifecycle), and serve-sim's client sends the same level [observed: `webrtc-sdp-level.ts`].

## Open questions

None at this time.
