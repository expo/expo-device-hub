# LLP 0013: HubClient input and control sockets

**Type:** Explainer
**Status:** Draft
**Systems:** HubClient
**Author:** Gabe Debes
**Date:** 2026-10-06
**Related:** LLP 0000, LLP 0003

## Summary

`@expo/hub-client` has its own copies of serve-sim's browser input socket and exec-ws control client. It does not import serve-sim's client code, so a fix there does not reach the Hub or the Expo website by itself [observed: `input-socket.ts`, `control-socket.ts` import only `@expo/hub-client` modules; LLP 0000 [constraint 2](0000-expo-device-hub.explainer.md#constraints-you-must-not-simplify-away)].

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

serve-sim's client uses the same rules and numbers [observed: `socket/client-input.ts`].

## iOS input adapter

The iOS adapter uses the admission socket [observed: `createInputSocket` call in `useIosDevice.ts`]:

- After admission, it turns off the Simulator's hardware keyboard, so that iOS shows its software keyboard.
- A refusal notice clears when a socket is admitted. A config update for the same helper does not clear it. A replaced helper (new `pid` or exec token) gets a new input socket, which clears the notice and starts a new refusal grace.
- A lost-input notice expires 5 s after the refusal, also when a socket is admitted sooner, because admission cannot bring back lost commands.
- When the helper is replaced at the same URL (new `pid` or exec token), queued input is dropped. Input belongs to the helper that was running when the user acted [confirmed] (Gabe Debes, 2026-10-07).
- After a disconnect, the adapter waits for the reconnect (1.5 s). If exec-ws has not delivered a config by then, it runs HTTP discovery to recover rotated credentials.

## Open questions

None at this time.
