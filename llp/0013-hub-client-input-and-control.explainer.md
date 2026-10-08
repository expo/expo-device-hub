# LLP 0013: HubClient input and control sockets

**Type:** Explainer
**Status:** Draft
**Systems:** HubClient, HubComponents, Hub
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

- After admission, a touch client (coarse pointer) turns off the Simulator's hardware keyboard, so that iOS shows its software keyboard. A desktop client keeps it, as serve-sim's own client does, because iOS ignores Command+V and Command+C without a hardware keyboard [observed: `onAdmitted` in `useIosDevice.ts`; serve-sim `client/client.tsx`] [confirmed: Gabe Debes, 2026-10-08].
- A refusal notice clears when a socket is admitted. A config update for the same helper does not clear it. A replaced helper (new `pid` or exec token) gets a new input socket, which clears the notice and starts a new refusal grace.
- A lost-input notice expires 5 s after the refusal, also when a socket is admitted sooner, because admission cannot bring back lost commands.
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
- The channel retries after 1.5 s. When the config subscription ends, HTTP discovery runs at that time to recover rotated credentials.

## Keyboard input

When the shift key makes a printable character, the client sends the character with `shifted: true`, in addition to the HID usage. serve-sim then types it through the software keyboard [observed: `iosMessageForKeyboardInput` in `keyboard.ts`; serve-sim `client/client.tsx`].

## Input ownership

When a browser interaction loses focus, or the client changes device, queued input that it owns is cancelled [observed: `cancelInput` in `types.ts`, `useIosDevice.ts`, `useAndroidDevice.ts`]:

- A gesture that has both `begin` and `end` stays in the queue, in its order and with its expiry. A gesture without its `end` is removed, so that the device does not keep a held touch.
- Paced key input stops [observed: `paced-key-sender.ts`].
- If a send fails, the commands that were not sent stay in the queue for the next admission [observed: `ws-send-queue.ts`].

## Input feedback

`DeviceScreen` shows `inputError` as a status line over the video. The video stays visible, because video and input use different connections [observed: `DeviceScreen.tsx`].

## Clipboard

The iOS client pastes text into the device and copies text from it with the serve-sim clipboard protocol (LLP 0010, on the clipboard stack). HubClient moves only text. It does not read or write the browser clipboard; the page that calls `pasteText` and `copyText` does that [observed: `ordered-keyboard-input.ts`, `ios-clipboard.ts`].

- The client uses Paste only when the helper sets `inputPaste: true` in `/api`, and Copy only when it sets `inputCopy: true`. An older helper does not answer the `0x12` paste request, or a `0x11` barrier with a request ID [observed: `capabilities.clipboard` in `useIosDevice.ts`; serve-sim `src/state.ts`]. An action that the helper does not offer fails as not available before the client looks at the input socket, so it never reports a disconnect [observed: `pasteText`, `copyText` in `useIosDevice.ts`].
- Paste sends `0x12` with a request ID and the text on the input socket. Keys typed after it wait for the `0x92` reply with the same request ID, so the text lands between the keys typed before and after it. Touches do not wait. serve-sim's client does the same [observed: `createOrderedKeyboardInput`; serve-sim `client/utils/ordered-keyboard-input.ts`].
- Copy waits in the same queue. It sends a `0x11` barrier with a request ID, and after the `0x91` reply it calls `POST /api/pasteboard?copy=1`. Keys typed during Copy wait for it, so they cannot change the selection before the server presses Command+C [observed: `readAfterInput`, `copySimulatorText`].
- The Copy route accepts only a bearer token and a browser Origin, not the session cookie. So the client sends the exec token from `/api` as a bearer [observed: serve-sim `src/middleware.ts` on the clipboard stack].
- The client sends `0x12` and `0x11` only on an admitted socket, and never sends them again on a new socket. A disconnect, a device change or a replaced helper fails every request that has no reply, and drops the keys that wait behind it. A request without a reply also fails after 150 s, as in serve-sim.
- serve-sim closes an input socket that sends a frame larger than 4 MiB, so the client refuses a larger Paste before it sends it.
- When focus loss cancels input, key presses that wait behind a Paste or Copy are dropped. Key releases stay, because their keys can already be down on the device.
- `clipboardPending`, `clipboardError` and `clipboardWarning` show the latest action only. An older action that ends later does not change them, but its own call still resolves or rejects. `clipboardActionId` changes each time an action starts, so the page sees a new Paste also while an older Paste keeps `clipboardPending` at `paste`.
- HubClient shows no clipboard result. `DeviceScreen` ignores the rejection of its Command+V paste. The host page must show `clipboardError` and `clipboardWarning`, or pass `DeviceScreen` a `pasteText` that reports its own result [observed: `DeviceScreen.tsx`; `DeviceClient` in `types.ts`].
- A disconnect or a replaced helper for the same device ends an action that has no reply with `clipboardError`, so a Paste that the device maybe did not get never looks like a success. serve-sim's client also rejects such a request as disconnected [observed: `clipboardIdentity` in `useIosDevice.ts`; serve-sim `client/utils/ordered-keyboard-input.ts`]. A change of device, server or token clears the three fields instead, because the result belongs to the previous device.
- A key that serve-sim could not release after a good Paste or Copy is a warning in `clipboardWarning`, not an error, because the text already moved. This copies serve-sim's rule in LLP 0010. A failed Copy can also carry the warning (`cleanupWarning` in serve-sim's 413, 503, 504 or 500 reply), and the client then sets both `clipboardError` and `clipboardWarning`. serve-sim's failed Paste reply has no warning today; the client keeps one if it comes [observed: `ClipboardActionError` in `device-clipboard.ts`, `ios-clipboard.ts`, `ordered-keyboard-input.ts`].
- A failed Copy shows serve-sim's `error` text. The client has fixed texts only for a reply without one [observed: `COPY_FAILURES` in `ios-clipboard.ts`].
- `DeviceScreen` handles Command+V and Control+V when `capabilities.clipboard.paste` is set. It does not send the V key, so the browser fires a `paste` event. Its text needs no clipboard permission, and `DeviceScreen` pastes it. When the event has no text, or no `paste` event comes before the V key goes up, `DeviceScreen` sends a Paste without text, and the device pastes its own clipboard. serve-sim's client does the same [observed: `DeviceScreen.tsx`; serve-sim `client/client.tsx`, `client/utils/keyboard-paste-gate.ts`]. Command+C stays keys.
- Paste and Copy need the hardware keyboard, because serve-sim presses Command+V and Command+C. A touch client turns it off (see the iOS input adapter), so on a touch client the chords do not reach the app, as in serve-sim's own touch client.

### Dashboard

The Hub dashboard reads and writes the browser clipboard for HubClient. Paths in this part are relative to `packages/@expo/hub-components/src/dashboard`.

- The toolbar under the device has Copy from Simulator and Paste from Device, in that order, after Save, Theme, Home and Reload and before Rotate. serve-sim's preview has the same two actions, with the same labels and order, in a Clipboard menu after Home and Screenshot and before Rotate. The dashboard toolbar has no menus, so they are two buttons. Each one shows only when `capabilities.clipboard` has it, so a device with Copy and no Paste shows Copy from Simulator alone. serve-sim shows its Clipboard menu only when the helper supports Paste [observed: `StreamControls.tsx`; serve-sim `client/client.tsx`].
- Paste from Device reads the browser clipboard with `navigator.clipboard.readText()` and calls `pasteText(text)`. The latest Paste wins: each newer Paste cancels an older toolbar Paste. An older Paste that still reads the browser clipboard never pastes late, and an older Paste in flight shows no result. A newer Paste of another caller, such as the Clipboard section, also removes the older Paste's toast. The hook sees each new Paste from `clipboardActionId`, also while `clipboardPending` stays `paste`. serve-sim's preview has the same rule [observed: `useClipboardToast` in `ClipboardToast.tsx`; serve-sim `client/hooks/use-clipboard-toast.tsx`].
- Copy from Simulator calls `copyText()` and writes the text with `navigator.clipboard.writeText()`. Empty text clears the browser clipboard.
- When the browser does not read or write its clipboard (no API, permission denied, or page not focused), the dashboard opens the inspector's Clipboard section. There the user pastes into a text field, or copies the text from a read-only field. The section's Copy button first tries `navigator.clipboard.writeText()`, then selects the field and runs `document.execCommand('copy')`, as serve-sim's copy fallback (`copyTextViaSelection`). Only when both fail does it say "Copy failed. Press Command+C or Ctrl+C to copy the selected text", with the text still selected. The section needs no clipboard permission [observed: `copyFieldSelection` in `browserClipboard.ts`; serve-sim `client/utils/share-link.ts`]. It takes the place of serve-sim's paste field and Copy button in a toast, and uses their labels: Send for the paste field, and Copy for the copied text [observed: `ClipboardSection.tsx`; `onClipboardFallback` in `packages/expo-device-hub/src/Dashboard.tsx`; serve-sim `client/components/app-toasts.tsx`].
- The toasts use serve-sim's texts and statuses [observed: `CLIPBOARD_TEXT` in `ClipboardToast.tsx`; serve-sim `client/hooks/use-clipboard-toast.tsx`]:

  | Step | Status | Text |
  | --- | --- | --- |
  | Paste in flight, after the browser clipboard is read, or a Command+V paste with text | pending | Pasting into the simulator… |
  | Paste done | success | Pasted into simulator |
  | Browser clipboard empty | success | Device clipboard is empty |
  | Browser clipboard not readable | info | Paste in the Clipboard section to send it to the simulator |
  | Copy in flight | pending | Reading simulator clipboard… |
  | Copy done | success | Copied from simulator, or Simulator clipboard is empty |
  | Empty Copy, browser clipboard not writable | error | Simulator clipboard is empty. The browser clipboard still has older text |
  | Copy, browser clipboard not writable | manual | Ready — one click to copy in the Clipboard section |
  | Paste or Copy failed | error | The client's error |
  | Key that serve-sim could not release | error | The client's `clipboardWarning`, in a toast of its own |

  The toast icon has the color of serve-sim's status dot: info for pending and info, success, warning for manual, and danger for error. A result shows for 3 s, as in serve-sim. Manual shows for 12 s, as serve-sim's manual toast does. The info toast that points to the Clipboard section also shows for 12 s. It takes the place of serve-sim's paste-field toast, which stays until the user acts. Only the two texts that point to the Clipboard section are not serve-sim's own.
- A toolbar action reports its result from its own call, because only the call knows the browser step and keeps its result after a newer action replaces the fields. `StreamPanel` gives `DeviceScreen` the hook's `pasteText`, so a Command+V paste also reports from its own call. As serve-sim's `pasteText`, a Command+V paste with text shows Pasting into the simulator… and then Pasted into simulator. A Command+V without text, where the device pastes its own clipboard, shows only its error, as serve-sim's fallback does [observed: `useClipboardToast`, `StreamPanel.tsx`; serve-sim `client/client.tsx`].
- A Paste that a replaced helper interrupts fails (see Clipboard above), so a Command+V paste shows an error toast, not a success [observed: `useClipboardToast`; `clipboardIdentity` in `useIosDevice.ts`].
- The Clipboard section shows the result of its own Paste and Copy in its notes, and no toast shows it, so each error shows once. From the client fields, the toasts show only `clipboardWarning`, for every action [observed: `useClipboardToast`, `ClipboardSection.tsx`].
- The Clipboard section keeps the state of its Paste and its Copy apart: a Copy during a Paste keeps Send disabled and Pasting into the simulator… shown. The section shows the same texts as the toasts for its own Paste and Copy. When `hardwareKeyboardConnected` is false, it also says that Paste and Copy need the hardware keyboard. serve-sim has no such note, so the toasts do not show it [observed: `HARDWARE_KEYBOARD_NOTE` in `ClipboardToast.tsx`, `ClipboardSection.tsx`].

### Hub shutdown

- On `SIGINT` and `SIGTERM`, the `expo-device-hub` CLI stops Android recording and calls serve-sim's `dispose()` at the same time. It exits after both, within its 60 s shutdown deadline [observed: `shutdownServeSim` in `packages/expo-device-hub/src/server/serve-sim.ts`, `packages/expo-device-hub/src/server/cli.ts`].
- `dispose()` first waits for a clipboard setup that is still running, then releases what the preview set up. So a device does not keep the capability loader after the CLI stops. A failed release is logged and does not change the exit code: serve-sim's own `exit` listener tries again (LLP 0010, on the clipboard stack), and a deleted simulator also fails here with nothing left to release. Only a failed Android stop exits 1. A vendored serve-sim without `dispose()` sets nothing up, and the call does nothing.
- Under `expo start`, the host owns the signals and exits at once, so nothing calls `dispose()`. Only serve-sim's `exit` listener runs, and a setup that is still running at that moment is not released.

## Open questions

- `DeviceScreen` shows the input notice with fixed colors (`rgba(0, 0, 0, 0.75)`, `#fca5a5`). LLP 0000 [constraint 3](0000-expo-device-hub.explainer.md#constraints-you-must-not-simplify-away) forbids fixed colors in the Hub UI. Does that rule apply to `DeviceScreen`, which the Hub and the Expo website both render?
