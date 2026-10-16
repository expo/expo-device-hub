# LLP 0013: HubClient input and control sockets

**Type:** Explainer
**Status:** Draft
**Systems:** HubClient
**Author:** Gabe Debes
**Date:** 2026-10-06
**Related:** LLP 0000, LLP 0003

## Summary

`@expo/hub-client` has its own copies of serve-sim's browser input socket and exec-ws control client. It does not import serve-sim's client code, so a fix there does not reach the Hub or the Expo website by itself [observed: `input-socket.ts` and `control-socket.ts` import nothing outside `@expo/hub-client`; LLP 0000 [constraint 2](0000-expo-device-hub.explainer.md#constraints-you-must-not-simplify-away)].

This document explains how the iOS client sends input and shares its control channel, and which serve-sim client rule each part copies. The routes and their authentication are in [LLP 0003](0003-serve-sim-http-api.spec.md#websockets).

> **Provenance.** This draft was written from the code. `[observed]` claims give their source. `[confirmed]` claims name a human and a date. File paths are relative to `packages/@expo/hub-client/src`. serve-sim paths are relative to `packages/serve-sim/packages/serve-sim/src`.

## Direction

HubClient must handle input and control sockets the same way as the serve-sim browser client [confirmed] (Gabe Debes, 2026-10-01). When serve-sim's client changes a rule here, change HubClient the same way, or record here why HubClient is different.

## Input admission

An open input socket is not yet admitted. A helper that advertises `inputAdmission: true` in `/api` sends the `0x83` frame after it admits the socket. The client sends input, and flushes queued input, only after that frame [observed: `createInputSocket` in `input-socket.ts`; `WS_MSG_INPUT_ADMITTED` in `input-protocol.ts`].

- An older helper has no admission frame, so the client treats an open socket as admitted. It waits 1 s before it clears a refusal notice, so that an immediate `1013` refusal can arrive first.
- Queued input has a size limit and drops expired messages [observed: `ws-send-queue.ts`]. Rotation intent resolves only when the admitted socket sends it; the cursor advances after successful delivery, so refused or expired rotations do not change the next requested pose [observed: `input-socket.ts`, `ws-send-queue.ts`, and `rotation-cursor.ts`].
- A `1013` close with `WS_REASON_INPUT_UNAVAILABLE` means that all input slots are in use. The client reconnects, and reports the refusal only after 13 s. That is longer than the server's heartbeat timeout plus one reconnect, so a slot that a lost socket holds becomes free first.
- A `1013` close with another reason means that input was lost (for example, a full input queue). The client reports it at once.

serve-sim's client uses the same rules and numbers, with one difference [observed: `socket/client-input.ts`]. It also counts a screen config frame as admission on a helper that sends `0x83`. HubClient does not, so a config frame cannot admit input before the helper does. serve-sim's helper sends `0x83` before its first config frame, so with that helper both clients admit at the same frame [observed: `attachHidSocket` in `device-session.ts`].

## iOS input adapter

The iOS adapter uses the admission socket [observed: `createInputSocket` call in `useIosDevice.ts`]:

- After admission, it sends the hardware-keyboard-off setup frame directly before flushing queued controls. The helper serializes the setting change with subsequent input and gives the guest keyboard a three-second visibility window before a software-character attempt. The helper uses a bounded read-only keyboard probe rather than a full UI snapshot, and a setup revision prevents a new transition from accepting an older probe result. A stalled visibility read cannot hold the shared input queue past that window or schedule late typing; while its single read remains pending, input retains HID fallback. Failed setup sends close the connection and retain fresh pending input for retry [observed: `admit` in `input-socket.ts`; `onAdmitted` in `useIosDevice.ts`; tag `0x0e` in serve-sim `device-session.ts`].
- A refusal notice clears when a socket is admitted. A config update for the same helper does not clear it. A replaced helper (new `pid` or exec token) gets a new input socket, which clears a client-limit notice and starts a new refusal grace.
- A lost-input notice expires 5 s after the refusal, also when a socket is admitted sooner or the helper is replaced, because neither brings back lost commands. Selecting another device clears it at once, before that device's config arrives, and so does a new input URL. A restarting helper that briefly reports no config does not [observed: `lostInputTimerRef` in `useIosDevice.ts`]. serve-sim shows it as a toast with the default duration, and dismisses it early only when its input URL changes [observed: `client/client.tsx`, `client/components/app-toasts.tsx`].
- Fresh input waits through initial discovery and temporary null configs for the same helper. The hook transfers unsent messages without resetting their 1.5 s age or 32-message bound; a requested device, server, token, or known helper identity change discards them [observed: `pendingInputRef` in `useIosDevice.ts`; `takePending` in `input-socket.ts`].
- When the helper is replaced at the same URL (new `pid` or exec token), queued input is dropped. Input belongs to the helper that was running when the user acted [confirmed] (Gabe Debes, 2026-10-07).
- After a disconnect, the adapter waits for the reconnect (1.5 s). If exec-ws has not delivered a config by then, it runs HTTP discovery to recover rotated credentials.

## Control channel pool

`createControlSocket` owns one exec-ws connection for one client identity (URL and token), never for the whole module [observed: `control-socket.ts`].

- HubClient queues requests at a client-side limit of 8 in flight, matching serve-sim's server limit (`MAX_ACTIONS_IN_FLIGHT_PER_SOCKET` in `socket/server-control.ts`). The serve-sim browser client does not impose this queue [observed: `control-socket.ts`; `socket/client-control.ts`].
- A sent request keeps its server slot after caller timeout or abort, until the server replies or the connection fails. If all 8 slots belong to abandoned requests, queued and new requests fail immediately with "too many actions in flight on this connection". Health probes still run, subscriptions stay connected, and a late server reply makes its slot usable again. Writes are never replayed [observed: `sendRequests` and `inFlight` in `control-socket.ts`].
- HubClient adds a health probe every 5 s; a probe without a reply in 5 s closes the connection. serve-sim's browser client has no health probe. Both clients stop a connection attempt after 5 s [observed: `control-socket.ts`; `socket/client-control.ts`].
- Each subscription retries by itself after the server ends it. One ended subscription does not close the others.

serve-sim's client uses the same 5 s connect timeout and 2 s stream retry [observed: `socket/client-control.ts`].

## Shared iOS control channel

Settings, host actions, logs, events, activity metrics and config updates share one control channel [observed: `useIosDevice.ts`].

- The channel is keyed on the middleware's exec-ws URL and token, not on the device config. A helper can report a `null` config while it restarts, and the config subscription must stay open for its replacement.
- The channel retries after 1.5 s. When the config subscription ends, HTTP discovery also runs 1.5 s later, to recover rotated credentials [observed: config subscription effect in `useIosDevice.ts`].
- Settings polls pause while the channel is down and read again once it authenticates [observed: `onConnectionChange` in `control-socket.ts`]. A read in flight when the channel drops is rejected, never replayed. An ended stream or a subscription change does not interrupt settings.
- The metrics subscription drives `activityStatus`: `loading` on subscribe, `ready` on stream metadata or a sample, and `error` when the stream ends or the channel drops.

## Keyboard input

HubClient sends `key` for every single-character printable keydown without Control, Meta, or Alt, in addition to its physical HID usage. Shifted non-space characters retain `shifted: true`; releases, shortcuts, navigation keys, and dead keys keep physical HID semantics [observed: `iosMessageForKeyboardInput` in `keyboard.ts`; `DeviceScreen.tsx`].

The updated serve-sim helper uses the software-keyboard character path for shifted characters or when the character does not match that physical US key, while matching unshifted US characters stay on the fast HID path. This requires the Simulator hardware keyboard to be off and the device to have no hinge-angle support. Hardware-keyboard-on, hinge-capable devices, older helpers, and rejected software-keyboard characters retain HID fallback; characters absent from the Simulator keyboard remain a limitation [observed: tag `0x06` in `device-session.ts`; `US_KEYBOARD_MAP` in `text-to-keys.ts`].

This extends serve-sim's browser client, which supplies character metadata only for shifted characters. HubClient also supplies unshifted metadata so a German-layout `KeyY` can type `z` instead of the physical US `y` [observed: `keyboard.ts`; serve-sim `client/client.tsx`].

## Open questions

None at this time.
