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
- Queued input has a size limit and drops expired messages [observed: `ws-send-queue.ts`].
- A `1013` close with `WS_REASON_INPUT_UNAVAILABLE` means that all input slots are in use. The client reconnects, and reports the refusal only after 13 s. That is longer than the server's heartbeat timeout plus one reconnect, so a slot that a lost socket holds becomes free first.
- A `1013` close with another reason means that input was lost (for example, a full input queue). The client reports it at once.

serve-sim's client uses the same rules and numbers, with one difference [observed: `socket/client-input.ts`]. It also counts a screen config frame as admission on a helper that sends `0x83`. HubClient does not, so a config frame cannot admit input before the helper does. serve-sim's helper sends `0x83` before its first config frame, so with that helper both clients admit at the same frame [observed: `attachHidSocket` in `device-session.ts`].

## iOS input adapter

The iOS adapter uses the admission socket [observed: `createInputSocket` call in `useIosDevice.ts`]:

- After admission, it turns off the Simulator's hardware keyboard, so that iOS shows its software keyboard.
- A refusal notice clears when a socket is admitted. A config update for the same helper does not clear it. A replaced helper (new `pid` or exec token) gets a new input socket, which clears a client-limit notice and starts a new refusal grace.
- A lost-input notice expires 5 s after the refusal, also when a socket is admitted sooner or the helper is replaced, because neither brings back lost commands. Selecting another device clears it at once, before that device's config arrives, and so does a new input URL. A restarting helper that briefly reports no config does not [observed: `lostInputTimerRef` in `useIosDevice.ts`]. serve-sim shows it as a toast with the default duration, and dismisses it early only when its input URL changes [observed: `client/client.tsx`, `client/components/app-toasts.tsx`].
- When the helper is replaced at the same URL (new `pid` or exec token), queued input is dropped. Input belongs to the helper that was running when the user acted [confirmed] (Gabe Debes, 2026-10-07).
- After a disconnect, the adapter waits for the reconnect (1.5 s). If exec-ws has not delivered a config by then, it runs HTTP discovery to recover rotated credentials.

## Control channel pool

`createControlSocket` owns one exec-ws connection for one client identity (URL and token), never for the whole module [observed: `control-socket.ts`].

- At most 8 requests are in flight. serve-sim serves 8 action requests per control connection [observed: `MAX_ACTIONS_IN_FLIGHT_PER_SOCKET` in `socket/server-control.ts`].
- A health probe runs every 5 s, and a probe without a reply in 5 s closes the connection. A connection attempt also stops after 5 s.
- Each subscription retries by itself after the server ends it. One ended subscription does not close the others.

serve-sim's client uses the same 5 s connect timeout and 2 s stream retry [observed: `socket/client-control.ts`].

## Shared iOS control channel

Settings, host actions, logs, events, activity metrics and config updates share one control channel [observed: `useIosDevice.ts`].

- The channel is keyed on the middleware's exec-ws URL and token, not on the device config. A helper can report a `null` config while it restarts, and the config subscription must stay open for its replacement.
- The channel retries after 1.5 s. When the config subscription ends, HTTP discovery also runs 1.5 s later, to recover rotated credentials [observed: config subscription effect in `useIosDevice.ts`].
- Settings polls pause while the channel is down and read again once it authenticates [observed: `onConnectionChange` in `control-socket.ts`]. A read in flight when the channel drops is rejected, never replayed. An ended stream or a subscription change does not interrupt settings.
- The metrics subscription drives `activityStatus`: `loading` on subscribe, `ready` on stream metadata or a sample, and `error` when the stream ends or the channel drops.

## Keyboard input

When the shift key makes a printable character, the client sends the character with `shifted: true`, in addition to the HID usage. serve-sim types it through the software keyboard when the Simulator's hardware keyboard is off and the device has no hinge-angle support. Otherwise, or when software typing fails, it sends the HID usage [observed: `iosMessageForKeyboardInput` in `keyboard.ts`; serve-sim `client/client.tsx`, tag `0x06` in `device-session.ts`].

## Input ownership

When a browser interaction loses focus, or the client changes device, queued input that it owns is cancelled [observed: `cancelInput` in `types.ts`, `useIosDevice.ts`, `useAndroidDevice.ts`]:

- A gesture that has both `begin` and `end` stays in the queue, in its order and with its expiry. A gesture without its `end` is removed, so that the device does not keep a held touch.
- Paced key input stops [observed: `paced-key-sender.ts`].
- If a send fails, the commands that were not sent stay in the queue for the next admission [observed: `ws-send-queue.ts`].

## Open questions

None at this time.
