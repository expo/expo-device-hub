# LLP 0013: HubClient input and control sockets

**Type:** Explainer
**Status:** Draft
**Systems:** HubClient
**Author:** Gabe Debes
**Date:** 2026-10-06
**Related:** LLP 0000, LLP 0003

## Summary

`@expo/hub-client` has its own copies of serve-sim's browser input socket and exec-ws control client. It does not import serve-sim's client code, so a fix there does not reach the Hub or the Expo website by itself [observed: `input-socket.ts` and `exec-ws.ts` import nothing outside `@expo/hub-client`; LLP 0000 [constraint 2](0000-expo-device-hub.explainer.md#constraints-you-must-not-simplify-away)].

This document explains how the iOS client sends input and shares its control channel, and which serve-sim client rule each part copies. The routes and their authentication are in [LLP 0003](0003-serve-sim-http-api.spec.md#websockets).

> **Provenance.** This draft was written from the code. `[observed]` claims give their source. `[confirmed]` claims name a human and a date. File paths are relative to `packages/@expo/hub-client/src`. serve-sim paths are relative to `packages/serve-sim/packages/serve-sim/src`.

## Direction

HubClient must handle input and control sockets the same way as the serve-sim browser client [confirmed] (Gabe Debes, 2026-10-01). When serve-sim's client changes a rule here, change HubClient the same way, or record here why HubClient is different.

## Input admission

An open input socket is not yet admitted. A helper that advertises `inputAdmission: true` in `/api` sends the `0x83` frame after it admits the socket. The client sends input, and flushes queued input, only after that frame [observed: `createInputSocket` in `input-socket.ts`; `WS_MSG_INPUT_ADMITTED` in `input-protocol.ts`].

- An older helper has no admission frame, so the client treats an open socket as admitted. It waits 1 s before it clears a refusal notice, so that an immediate `1013` refusal can arrive first.
- Queued input has a size limit and drops expired messages [observed: `ws-send-queue.ts`].
- A `1013` close with `WS_REASON_INPUT_UNAVAILABLE` means that all input slots are in use. The client reconnects, and reports the refusal only after 13 s. That is longer than the server's heartbeat timeout plus one reconnect, so a slot that a lost socket holds becomes free first.
- A `1013` close with another reason means that input was lost (for example, a full input queue). The client reports it at once.

serve-sim's client uses the same rules and numbers, with one difference [observed: `socket/client-input.ts`]. It also counts a screen config frame as admission on a helper that sends `0x83`. HubClient does not, so a config frame cannot admit input before the helper does. serve-sim's helper sends `0x83` before its first config frame, so with that helper both clients admit at the same frame [observed: `attachHidSocket` in `device-session.ts`].

## Open questions

None at this time.
