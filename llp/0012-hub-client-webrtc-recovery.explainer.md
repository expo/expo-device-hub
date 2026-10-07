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

## Open questions

None at this time.
