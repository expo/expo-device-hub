# LLP 0013: HubClient input and control sockets

**Type:** Explainer
**Status:** Draft
**Systems:** HubClient, HubComponents, Hub
**Author:** Gabe Debes
**Date:** 2026-10-06
**Revised:** 2026-10-23 (Codex: iOS permission readback)
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

- After admission, every Hub client disconnects the Simulator's hardware keyboard so that iOS shows its software keyboard and browser-layout printable characters use the software-character path. This preserves the current Hub default; serve-sim's standalone browser client leaves the selected mode alone [observed: `onAdmitted` in `useIosDevice.ts`; serve-sim `client/client.tsx`].
- The setting is shared across viewers. An admission or a manual setting changes it for everyone. Settings polls reconcile `hardwareKeyboardConnected` with the backend every 5 s. A read that overlaps admission, disconnect, or manual toggle cannot undo that newer intent. A read started before initialization finishes can briefly report the prior mode; the next poll corrects it [observed: `hardwareKeyboardIntentRef` and the settings refresh in `useIosDevice.ts`].
- Admission sends its hardware-keyboard-off setup frame directly before flushing queued controls. The helper serializes the setting change with subsequent input and gives the guest keyboard a three-second visibility window before a software-character attempt. The helper uses a bounded read-only keyboard probe rather than a full UI snapshot, and a setup revision prevents a new transition from accepting an older probe result. A stalled visibility read cannot hold the shared input queue past that window or schedule late typing; while its single read remains pending, input retains HID fallback. Failed setup sends close the connection and retain fresh pending input for retry [observed: `admit` in `input-socket.ts`; `onAdmitted` in `useIosDevice.ts`; tag `0x0e` in serve-sim `device-session.ts`].
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

## Input ownership

Input callbacks belong to a committed connection scope and its known helper, rather than the complete config object. Stream settings and ICE metadata do not retire them. Initial discovery binds the early queue without replacing that owner; temporary null discovery retains the known helper and original queue age. A requested device, server, enabled state, token, or known helper identity change retires the callbacks, even when the same values later return [observed: `inputOwner` and `ownsInput` in `useIosDevice.ts`; `inputIdentity` in `useAndroidDevice.ts`].

Local surface blur releases physical keys only while all active pointers are captured. It keeps captured gestures and paced phone-keyboard input, so `KeyboardCapture` can restore focus to its hidden input without ending a swipe. If capture failed, local blur or leaving the surface cancels the unfinished gesture because outside releases cannot reach the surface. Unexpected capture loss and pointer cancellation also abandon unfinished input [observed: `onBlur` in `DeviceScreen.tsx`; `onFocusOut` in `KeyboardCapture.tsx`].

Window blur, a hidden tab, page hide, unmount, or a real input-owner change cancels abandoned input [observed: `listenForInputCancellation`, `cancelBrowserInput`, and the adapters' `cancelInput`]:

- Buffered wheel frames and paced key batches stop before adapter queues are cleared. Held keys/touches are released only through their original owner.
- Unsent keys and scrolls are discarded from both the socket queue and any pre-discovery queue; they must not type or scroll later after the browser has left the interaction.
- Converting a single touch to a two-finger gesture releases the admitted single touch without retaining its unsent prefix as a completed tap (`TouchSample.cancelled`). It also cancels pending single-touch movement and releases at the last forwarded single-touch point, while starting the pinch at the current two-finger positions.
- Completed gesture `begin`/`end` pairs remain queued as completed actions, in their original order and with the original 1.5 s expiry. Incomplete gestures are removed before a synthetic release can turn them into completed taps.

This differs from serve-sim's window-blur handler, which cancels paced keyboard work and releases held physical keys while retaining unsent socket messages. HubClient's full queue cancellation applies to the global abandonment events above, not to focus transfers within the page [observed: `client/client.tsx`'s `blur` handler and `utils/ws-send-queue.ts` in ServeSim; `cancelInput` in HubClient].

## Input feedback

HubClient exposes `error` and `inputError`; product notices and their styling belong to consumers, not hub-client components. `DeviceScreenClient` includes `inputError`, and the Hub renders its non-interactive input notice in `hub-components`' `PhoneFrame` with design tokens, without hiding live media [observed: `useDeviceScreenClient.ts`, `PhoneFrame.tsx`]. Other consumers choose their own presentation.

An Android input-only outage does not demote healthy WebRTC playback to an error. A failed peer still recovers and can reach an error after its reconnect grace [observed: `useAndroidDevice.ts` and its mounted restart tests].

## Clipboard

The iOS client pastes text into the device and copies text from it with the serve-sim clipboard protocol (LLP 0010). HubClient moves only text. It does not read or write the browser clipboard; the page that calls `pasteText` and `copyText` does that [observed: `ordered-keyboard-input.ts`, `ios-clipboard.ts`].

- The client uses Paste only when the helper sets `inputPaste: true` in `/api`, and Copy only when it sets `inputCopy: true`. An older helper does not answer the `0x12` paste request, or a `0x11` barrier with a request ID [observed: `capabilities.clipboard` in `useIosDevice.ts`; serve-sim `src/state.ts`]. An action that the helper does not offer fails as not available before the client looks at the input socket, so it never reports a disconnect [observed: `pasteText`, `copyText` in `useIosDevice.ts`].
- Paste sends `0x12` with a request ID and the text on the input socket. Keys typed after it wait for the `0x92` reply with the same request ID, so the text lands between the keys typed before and after it. Touches do not wait. serve-sim's client does the same [observed: `createOrderedKeyboardInput`; serve-sim `client/utils/ordered-keyboard-input.ts`].
- Copy waits in the same queue. It sends a `0x11` barrier with a request ID, and after the `0x91` reply it calls `POST /api/pasteboard?copy=1`. Keys typed during Copy wait for it, so they cannot change the selection before the server presses Command+C [observed: `readAfterInput`, `copySimulatorText`].
- The Copy route accepts only a bearer token and a browser Origin, not the session cookie. So the client sends the exec token from `/api` as a bearer, preserving it even when an optional session token differs [observed: serve-sim `src/middleware.ts`].
- The client sends `0x12` and `0x11` only on an admitted socket, and never sends them again on a new socket. A disconnect, a device change or a replaced helper fails every request that has no reply, and drops the keys that wait behind it. Each dispatched clipboard request has a 150 s client deadline, as in serve-sim, including the Copy read after its barrier. This leaves room for first-use helper installation and native command deadlines; a shorter client deadline can report failure before a server action still completes. Expiry releases queued input and aborts a Copy read; late replies and results are ignored, and nothing is replayed. This bounds the client wait, not the server operation, which may still finish.
- The ordered queue belongs to the current input owner across discovery gaps. Transport cleanup cancels uncertain clipboard work and keys waiting behind it; when no clipboard request is pending, ordinary paced typing keeps main's existing discovery/reconnect queue [observed: `keyboard` in `useIosDevice.ts`, `cancelRequests` in `ordered-keyboard-input.ts`].
- serve-sim closes an input socket that sends a frame larger than 4 MiB, so the client refuses a larger Paste before it sends it.
- When focus loss cancels input, key presses that wait behind a Paste or Copy are dropped. Key releases stay, because their keys can already be down on the device.
- `clipboardPending`, `clipboardError` and `clipboardWarning` show the latest action only. An older action that ends later does not change them, but its own call still resolves or rejects. `clipboardAction` retains the latest action kind after completion so a batched action still labels its warning correctly. `clipboardActionId` changes each time an action starts, so the page sees a new Paste also while an older Paste keeps `clipboardPending` at `paste`.
- HubClient shows no clipboard result. `DeviceScreen` ignores the rejection of its Command+V paste. The host page must show `clipboardError` and `clipboardWarning`, or pass `DeviceScreen` a `pasteText` that reports its own result [observed: `DeviceScreen.tsx`; `DeviceClient` in `types.ts`].
- A disconnect or a replaced helper for the same device ends an action that has no reply with `clipboardError`, so a Paste that the device maybe did not get never looks like a success. serve-sim's client also rejects such a request as disconnected [observed: `clipboardIdentity` in `useIosDevice.ts`; serve-sim `client/utils/ordered-keyboard-input.ts`]. A change of device, server or token clears the clipboard fields instead, because the result belongs to the previous device.
- A key that serve-sim could not release after a good Paste or Copy is a warning in `clipboardWarning`, not an error, because the text already moved. This copies serve-sim's rule in LLP 0010. A failed Copy can also carry the warning (`cleanupWarning` in serve-sim's 413, 503, 504 or 500 reply), and the client then sets both `clipboardError` and `clipboardWarning`. serve-sim's failed Paste reply has no warning today; the client keeps one if it comes [observed: `ClipboardActionError` in `device-clipboard.ts`, `ios-clipboard.ts`, `ordered-keyboard-input.ts`].
- A failed Copy shows serve-sim's `error` text. The client has fixed texts only for a reply without one [observed: `COPY_FAILURES` in `ios-clipboard.ts`].
- `DeviceScreen` handles Command+V and Control+V when `capabilities.clipboard.paste` is set. It does not send the V key, so the browser fires a `paste` event. Its text needs no clipboard permission, and `DeviceScreen` pastes it. When the event has no text, or no `paste` event comes before the V key goes up, `DeviceScreen` sends a Paste without text, and the device pastes its own clipboard. serve-sim's client does the same [observed: `DeviceScreen.tsx`; serve-sim `client/client.tsx`, `client/utils/keyboard-paste-gate.ts`]. Held shortcut repeats are suppressed until V keyup or focus loss, including after the first paste event. Command+C stays keys unless the host supplies `DeviceScreen.onCopy` and the device supports Copy. That callback owns the browser clipboard write; the C key is not sent again. Held repeats are suppressed until keyup or focus loss.
- Clipboard actions use serve-sim's shared Command+V and Command+C path, which prepares the foreground app's editing shortcuts while preserving a saved OFF setting (LLP 0010). The client adds no clipboard-specific keyboard policy [observed: `pasteText` and `copyText` in `useIosDevice.ts`].

### Dashboard

The Hub dashboard reads and writes the browser clipboard for HubClient. Paths in this part are relative to `packages/@expo/hub-components/src/dashboard`.

- The toolbar under the device has one Clipboard menu before Rotate, with Copy from Simulator and Paste from Device in that order, as in serve-sim. Each item appears only when the device offers its capability. The menu is disabled while either clipboard action is pending; keyboard Copy also ignores new requests until the pending action settles. serve-sim leaves its menu items enabled. Clipboard notifications are centered over the bottom of the device frame, including when sidebars resize, and let device taps pass through. Screenshot notifications keep their separate toaster at the bottom-right of the viewport [observed: `StreamControls.tsx`, `ClipboardToaster`, `StreamPanel.tsx`].
- Paste from Device reads the browser clipboard with `navigator.clipboard.readText()` and calls `pasteText(text)`. The latest Paste wins: each newer Paste cancels an older toolbar Paste. An older Paste that still reads the browser clipboard never pastes late, and an older Paste in flight shows no result. A newer Paste of another caller, such as the Clipboard section, also removes the older Paste's toast. The hook sees each new Paste from `clipboardActionId`, also while `clipboardPending` stays `paste`. serve-sim's preview has the same rule [observed: `useClipboardToast` in `ClipboardToast.tsx`; serve-sim `client/hooks/use-clipboard-toast.tsx`].
- Copy from Simulator calls `copyText()` and writes the text with `navigator.clipboard.writeText()`. Empty text clears the browser clipboard.
- When the browser does not read or write its clipboard (no API, permission denied, or page not focused), the dashboard opens the inspector's Clipboard section. There the user pastes into a text field, or copies the text from a read-only field. The section's Copy button first tries `navigator.clipboard.writeText()`, then selects the field and runs `document.execCommand('copy')`, as serve-sim's copy fallback (`copyTextViaSelection`). Only when both fail does it say "Copy failed. Press Command+C or Ctrl+C to copy the selected text", with the text still selected. The section needs no clipboard permission [observed: `copyFieldSelection` in `browserClipboard.ts`; serve-sim `client/utils/share-link.ts`]. It takes the place of serve-sim's paste field and Copy button in a toast, and uses their labels: Send for the paste field, and Copy for the copied text [observed: `ClipboardSection.tsx`; `onClipboardFallback` in `packages/expo-device-hub/src/Dashboard.tsx`; serve-sim `client/components/app-toasts.tsx`].
- The toasts use serve-sim's texts and statuses [observed: `CLIPBOARD_TEXT` in `ClipboardToast.tsx`; serve-sim `client/hooks/use-clipboard-toast.tsx`]:

  | Step                                                                                 | Status  | Text                                                                     |
  | ------------------------------------------------------------------------------------ | ------- | ------------------------------------------------------------------------ |
  | Paste in flight, after the browser clipboard is read, or a Command+V paste with text | pending | Pasting into the simulator…                                              |
  | Paste done                                                                           | success | Pasted into simulator                                                    |
  | Browser clipboard empty                                                              | success | Device clipboard is empty                                                |
  | Browser clipboard not readable                                                       | info    | Paste in the Clipboard section to send it to the simulator               |
  | Copy in flight                                                                       | pending | Reading simulator clipboard…                                             |
  | Copy done                                                                            | success | Copied from simulator, or Simulator clipboard is empty                   |
  | Empty Copy, browser clipboard not writable                                           | error   | Simulator clipboard is empty. The browser clipboard still has older text |
  | Copy, browser clipboard not writable                                                 | manual  | Ready — one click to copy in the Clipboard section                       |
  | Paste or Copy failed                                                                 | error   | The client's error                                                       |
  | Key that serve-sim could not release                                                 | error   | The client's `clipboardWarning`, in a toast of its own                   |

  The toast icon has the color of serve-sim's status dot: info for pending and info, success, warning for manual, and danger for error. Hub success shows for 1.5 s, rather than serve-sim's 3 s; errors show for 3 s. Manual shows for 12 s, as serve-sim's manual toast does. The info toast that points to the Clipboard section also shows for 12 s. It takes the place of serve-sim's paste-field toast, which stays until the user acts. Only the two texts that point to the Clipboard section are not serve-sim's own.

- A toolbar action reports its result from its own call, because only the call knows the browser step and keeps its result after a newer action replaces the fields. `StreamPanel` gives `DeviceScreen` the hook's `pasteText` and `onCopy`, so Command+V and Command+C use the same browser clipboard and feedback paths as the menu. As serve-sim's `pasteText`, a Command+V paste with text shows Pasting into the simulator… and then Pasted into simulator. A Command+V without text, where the device pastes its own clipboard, shows only its error, as serve-sim's fallback does [observed: `useClipboardToast`, `StreamPanel.tsx`; serve-sim `client/client.tsx`].
- A Paste that a replaced helper interrupts fails (see Clipboard above), so a Command+V paste shows an error toast, not a success [observed: `useClipboardToast`; `clipboardIdentity` in `useIosDevice.ts`].
- The Clipboard section shows the result of its own Paste and Copy in its notes, and no toast shows it, so each error shows once. From the client fields, the toasts show only `clipboardWarning`, for every action [observed: `useClipboardToast`, `ClipboardSection.tsx`].
- The Clipboard section keeps the state of its Paste and its Copy apart: a Copy during a Paste keeps Send disabled and Pasting into the simulator… shown. The section shows the same texts as the toasts for its own Paste and Copy. When `hardwareKeyboardConnected` is false, it offers turning it on as a troubleshooting step. Its keyboard note uses the client's last-known state, which the settings poll refreshes after another viewer changes it. serve-sim has no such note, so the toasts do not show it [observed: `HARDWARE_KEYBOARD_NOTE` in `ClipboardToast.tsx`, `ClipboardSection.tsx`].

### Browser clipboard writes

Browser clipboard writes from toolbar Copy are serialized. An older write that has already started cannot be cancelled; a newer result waits for it and writes last. A queued write whose action has been superseded is skipped [observed: `copyWrites` in `ClipboardToast.tsx`].

Clipboard fallbacks belong to the selected device and are discarded on a selection change. A new fallback clears an earlier inspector error. A new inspector Copy clears its previous result before reading, including on failure. Key warnings are shown even when React batches an action's start and completion. The toolbar wraps at narrow widths; its measured height reserves space below the stream [observed: `Dashboard.tsx`, `ClipboardSection.tsx`, `ClipboardToast.tsx`, `StreamPanel.tsx`].

## Hub shutdown

- On `SIGINT` and `SIGTERM`, the `expo-device-hub` CLI stops Android recording and calls serve-sim's `dispose()` at the same time. It exits after both, within its 60 s shutdown deadline [observed: `shutdownServeSim` in `packages/expo-device-hub/src/server/serve-sim.ts`, `packages/expo-device-hub/src/server/cli.ts`].
- `dispose()` first waits for a clipboard setup that is still running, then releases what the preview set up. So a device does not keep the capability loader after the CLI stops. A failed release is logged and does not change the exit code: serve-sim's own `exit` listener tries again (LLP 0010), and a deleted simulator also fails here with nothing left to release. Only a failed Android stop exits 1.
- Under `expo start`, the host owns the signals and exits at once, so nothing calls `dispose()`. Only serve-sim's `exit` listener runs, and a setup that is still running at that moment is not released.

## Open questions

None at this time.

## App permissions

Both iOS UIs read `permissions.list` when opened or mounted, after a write,
and every five seconds while active. The Hub also reads when its shared control
channel reconnects; the standalone preview retries through its existing control
socket. Writes never set an optimistic granted/denied state. A page reload or
helper replacement reads the services again. Request generations reject reads
for an old target and reads that overlap newer writes. Pending writes stay owned by
the device/app across target changes and control-channel reconnection until their
readback finishes. Backend replacement invalidates cached rows and reads while
retaining pending writes. iOS ownership includes the middleware URL as well as
the Simulator and app, so equal UDIDs on different hosts remain independent. [observed:
`ios-permissions.ts`, `useIosDevice.ts`, `useAppPermissions.ts`; serve-sim
`client/components/app-permissions-tool.tsx`]

The backend services, persistence boundaries and notification startup limitation
are described in [LLP 0003.000](0003.000-simulator-permissions.explainer.md). The Hub exposes iOS
permission controls only when an active client has the typed host-action channel.
An older serve-sim without normalized permission readback reports an update error.
[observed: `useIosDevice.ts`, `ios-permissions.ts`]

A poll keeps the pending-write IDs it saw when it began, even after those writes
finish, so a stale snapshot cannot revert their confirmed state. Only one Hub
permission poll runs at a time. Read errors clear after a successful read; write
errors survive background refreshes until a new mutation or target change.
[observed: `useAppPermissions.ts`; serve-sim `app-permissions-tool.tsx`; regression
coverage in `__tests__/use-app-permissions.test.tsx` and serve-sim's
`__tests__/fixtures/permissions-ui.child.ts`]
