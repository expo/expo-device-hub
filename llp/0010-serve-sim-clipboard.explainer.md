# LLP 0010: serve-sim clipboard

**Type:** Explainer
**Status:** Draft
**Systems:** ServeSim
**Author:** Gabe Debes
**Date:** 2026-10-06
**Related:** LLP 0003, LLP 0007

> File paths such as `src/…` are relative to `packages/serve-sim/packages/serve-sim`, unless the text gives a path from the repository root.

## Summary

serve-sim moves text between the browser clipboard and the simulator pasteboard. This document explains how serve-sim reads and writes the simulator pasteboard, including on headless workers, how the preview's Paste and Copy use it, and why it works that way.

A first implementation was rolled back because it did not work as planned on the VM. This design is the second attempt, and it is kept as simple as possible [confirmed: Gabe Debes, 2026-09-30].

## Reading and writing the simulator pasteboard

`POST /api/pasteboard` reads the simulator pasteboard as text. `PUT /api/pasteboard` with `{"text": "…"}` writes it. [LLP 0003](0003-serve-sim-http-api.spec.md#pasteboard) lists the route.

- **Reads use `simctl pbpaste`.** This needs no code inside the simulator [observed: `src/sim-pasteboard.ts`].
- **Writes use a small tool that runs inside the simulator,** `Sources/SimPasteboard`, started with `simctl spawn`. Unlike `simctl pbcopy`, it works without a GUI login session, which headless workers such as EAS do not have [observed: `Sources/SimPasteboard/sim-pasteboard.m`]. The same tool can also report the pasteboard change count and read text. Its `--snapshot` mode prints an item snapshot for the E2E tests only [observed: `src/__tests__/pasteboard-tool.e2e.test.ts`, `src/__tests__/pasteboard-copy.e2e.test.ts`].
- **One lock per simulator** serializes writes, so two writes cannot interleave. A plain read does not take the lock [observed: `withSimPasteboardLock` and `readPasteboardViaSimctl` in `src/sim-pasteboard.ts`].
- **Text is limited to 4 MiB** in both directions. Larger text returns a JSON 413 [observed: `src/middleware.ts`, and the read limit in `readPasteboardText` in `src/sim-pasteboard.ts`]. A `PUT` body can be up to 8 MiB, because JSON escaping can double the text. The route answers a larger body with the same JSON 413 [observed: `src/middleware.ts`]. The standalone server refuses a body over 8 MiB before the route runs, with the plain-text 413 that it sends for every route [observed: `servePreview` in `src/runtime.ts`].

## Who may use the pasteboard API

The pasteboard holds user data, so the route needs the preview token and a browser Origin. The Origin must be the preview's own origin (the request's `Host`) or an origin that the CORS policy allows: loopback or a `--cors-origin`. A request without an Origin is refused, because browsers send one on every `POST` and `PUT` [observed: `isAllowedOrigin` in `src/middleware-utils.ts`].

The same-Host rule lets a hosted preview use its own clipboard without an extra flag [confirmed: Gabe Debes, 2026-09-27]. A client that is not a browser can set any `Host` and `Origin`, so for that client the token is the real boundary.

Responses carry `Cache-Control: no-store`, so a proxy does not keep clipboard text [observed: `src/middleware.ts`].

## Reading when `simctl pbpaste` fails

When `simctl pbpaste` fails, the read asks the foreground app instead [observed: `readPasteboardOnce` in `src/sim-pasteboard-reader.ts`]. This path is meant for headless workers, which have no GUI login session:

1. **Find the app.** Ask the live foreground tracker, then the accessibility bridge, then SpringBoard's visibility history for the current boot. Every step skips helper processes such as a ViewService [observed: `frontmostAppOf` in `src/foreground-tracker.ts`]. The tracker and the history both forget an app when SpringBoard moves it to the background [observed: `visibilityAfterLogLine` in `src/foreground-tracker.ts`]. On the Home screen, the read uses the app that serve-sim launched [observed: `pasteboardTarget` in `src/sim-pasteboard-reader.ts`]. Apps opened outside serve-sim are supported too [confirmed: Gabe Debes, 2026-09-27].
2. **Grant pasteboard access** with `simctl privacy`, because a denied read and an empty pasteboard both return an empty string [observed: `src/sim-pasteboard-reader.ts`].
3. **Ask the reader.** serve-sim writes a request with a fresh nonce into the app's `tmp` directory. The reader dylib, `Sources/SimPasteboardReader`, polls for it every 50 ms, reads `UIPasteboard` on the app's main queue, and publishes the nonce and the text with one atomic rename. A request that timed out can still be answered late; the nonce keeps that stale answer from being taken for the new one [observed: `src/sim-pasteboard-reader.ts`, `Sources/SimPasteboardReader/sim-pasteboard-reader.m`].
4. **Wait up to 1.2 s** for the answer, then fail with HTTP 503 and a message that says what to do next [observed: `PasteboardUnavailableError` in `src/middleware.ts`].

Apps load the reader through the capability loader ([LLP 0007](0007-serve-sim-capability-loader.explainer.md)) as the `clipboard` capability. It is on by default and loads in every app [observed: `clipboardCapability` in `src/sim-pasteboard-reader.ts`].

### Set up at session start, re-checked every 30 s

serve-sim enables the `clipboard` capability when a session starts and when the preview opens or starts a device, including a device that the grid boots later. A reboot clears the launchd environment, so a device that was just booted is set up again, after any setup that was still running [observed: `src/clipboard-session.ts`, `src/middleware.ts`].

The preview starts the setup but does not wait for it before it answers a page or state request. After a setup succeeds, page, state, and config requests check again that it is still in place, at most once every 30 s per device. This check is the repair for a reboot that the middleware did not see, because a reboot clears the launchd environment. The check runs two `simctl spawn` processes, so it is not repeated on every state poll [observed: `RECHECK_MS` in `src/clipboard-session.ts`]. After a failed setup, the next try waits 5 s, and the wait doubles after each failure, up to 5 minutes. A reboot tries again at once [observed: `src/clipboard-session.ts`, `src/middleware.ts`].

Which process sets up the reader depends on how serve-sim runs. Stream helpers never do, because they can outlive the session that owns the capability loader ([LLP 0007](0007-serve-sim-capability-loader.explainer.md#lifecycle)) [observed: `src/index.ts`, `src/middleware.ts`]:

- **`serve-sim`:** the session process, at start and from its preview.
- **`serve-sim --no-preview`:** the session process, at start. Its stream helpers neither set up nor remove the reader, so a device that a helper's grid starts or reboots has no reader.
- **`serve-sim --detach`:** no process. The detached helper only streams, so it has no app-reader fallback. Reads through `simctl pbpaste` still work.
- **`simMiddleware` in another server:** the process that mounts it, when it opens or starts a device. That process releases the setup with `dispose()`, or when it exits. The first setup registers a process `exit` listener, which releases every device that this process still owns. The middleware does not listen for signals, because the host owns them [observed: `releaseOnExit` in `src/clipboard-session.ts`]. The Hub mounts the middleware in its own process and has no clipboard code: its `SIGINT` and `SIGTERM` handlers end with `process.exit`, which runs the listener [observed: `packages/expo-device-hub/src/server/cli.ts`]. The listener waits at most 5 s for a device lock that another process holds [observed: `EXIT_LOCK_TIMEOUT_MS` in `src/clipboard-session.ts`]. Not released: a host killed by a signal that it does not handle, such as the Hub on `SIGHUP`, or by `SIGKILL`. Also not released: a device whose setup is still running at exit. Its loader can stay until the simulator reboots or serve-sim sets it up again.

`--disable clipboard`, or `clipboard: false` for `simMiddleware`, skips the setup for every device that the session selects [confirmed: Gabe Debes, 2026-09-29]. With this setting, the preview also removes a reader that is already on a device that it opens, and republishes the capability loader config without it [observed: `createClipboardSession` in `src/clipboard-session.ts`]. `clipboard: "unmanaged"` neither sets up nor removes the reader; the stream helpers use it [observed: `src/index.ts`, `src/middleware.ts`]. serve-sim supports one serve-sim process per simulator, so the setup keeps no multi-owner state [confirmed: Gabe Debes, 2026-10-04].

### Reads never restart apps

A read only asks a reader that is already loaded. It never arms the loader and never restarts an app, so it cannot change the app or the screen that the user is on [confirmed: Gabe Debes, 2026-10-04].

The cost: an app that started before the capability loader was armed has no reader until it restarts. An app that already has the loader picks up the reader when its config changes ([LLP 0007](0007-serve-sim-capability-loader.explainer.md#arriving-late) explains both). Its read fails with "Could not read this app's clipboard. Restart the app and retry." On the Home screen with no app to ask, the message is "Open the app you copied from and retry." [observed: `src/sim-pasteboard-reader.ts`]

An earlier version armed the reader during a read and could restart the app. It was removed for this rule [confirmed: Gabe Debes, 2026-10-04].

## Paste

Cmd+V or Ctrl+V over the preview, and Paste from Device in the toolbar's Clipboard menu, send the browser's text to the simulator [observed: `src/client/client.tsx`, `src/client/hooks/use-clipboard-toast.tsx`].

- The browser sends the text on the device's input socket, in order with key events. Keys typed after a Paste wait for its reply, so the Paste lands between the keys typed before and after it [observed: `src/client/utils/ordered-keyboard-input.ts`].
- Paste takes its turn in the input queue that all viewers share when it arrives. In that turn, the server takes the pasteboard lock, writes the text, and sends the Command+V chord, so Paste stays in order with earlier and later input, from every viewer [observed: `src/sim-pasteboard-paste.ts`, `src/device-session.ts`]. Other input waits during the write, usually a fraction of a second. A Paste without text takes the same lock, so it cannot paste text that another viewer is writing [confirmed: Gabe Debes, 2026-10-09].
- Before the chord, the server lifts every held Control, Shift, and Option key, also one that the pasting viewer holds, and presses it again afterwards. A held Command key stays down and serves the chord. A held V is lifted and stays up after a good paste, so no second "v" is typed [observed: `src/sim-command-shortcut.ts`, `sendPasteShortcut` and `sendCommandShortcut` in `src/device-session.ts`].
- When the browser blocks clipboard reads, a multiline field lets the user paste the text by hand. The field takes focus when it opens. Its hint names ⌘V or Ctrl+V for a mouse or trackpad, and long-press for touch [observed: `PasteField` in `src/client/components/app-toasts.tsx`].
- An older helper does not set `inputPaste` in its state. The preview then sends Cmd+V to it as plain keys, which paste the simulator clipboard, and hides Paste from Device [observed: `src/state.ts`, `src/client/client.tsx`].

Decisions [confirmed: Gabe Debes]:

- **The latest Paste action wins.** A newer Paste cancels an older one that is still waiting for the browser clipboard (2026-09-27).
- **Cmd+V without browser text pastes the simulator clipboard.** When the browser clipboard has no plain text, for example an image, the Command+V goes to the simulator (2026-09-29).
- **A failed Paste keeps the new text** on the simulator pasteboard. Restoring the old content would cost another read and write (2026-09-29).
- **A stuck Command key is a separate warning.** If Command cannot be released after V was, the text may already be pasted, so Paste reports success and shows a key warning (2026-09-29).

## Copy

Toolbar Copy reads the text that the simulator app copies and puts it on the browser clipboard.

1. The browser waits until the server has acknowledged all of its earlier input, then calls `POST /api/pasteboard?copy=1` [observed: `src/client/utils/sim-clipboard.ts`, `src/socket/client-input-barriers.ts`].
2. The server waits for capture start, as for all simulator input, because capture start sets up the HID target [observed: `copyPasteboard` in `src/device-session.ts`].
3. Copy runs as one operation in the device's input queue. In that turn, the server takes the pasteboard lock, notes the change count, presses Command+C, and waits up to 5 s for the count to change. Then it reads the text [observed: `copyPasteboard` in `src/device-session.ts`, `src/sim-pasteboard-copy.ts`]. Paste uses the same order, input turn first and lock second, so a Copy and a Paste cannot wait on each other, and neither runs ahead of input that came before it [confirmed: Gabe Debes, 2026-10-09].
4. The browser writes the text to its own clipboard. An empty result clears it. If the browser refuses the write, a manual Copy button offers the text and copies it through a text selection [observed: `src/client/hooks/use-clipboard-toast.tsx`, `copyTextViaSelection` in `src/client/utils/share-link.ts`].

A 504 is a normal result: the app did not change the pasteboard, for example because nothing was selected. The server does not log it as an error [observed: `src/middleware.ts`].

If the server cannot release a key that the Command+C chord pressed, the response carries a `cleanupWarning`, also with a 504 or other error. The browser shows it beside the result [observed: `copyPasteboard` in `src/device-session.ts`, `src/middleware.ts`, `src/client/hooks/use-clipboard-toast.tsx`].

A helper that does not set `inputCopy` in its state acknowledges the input barrier without a request ID, so Copy would wait until it times out. The preview hides Copy for that helper [observed: `src/state.ts`, `src/client/client.tsx`].

Copy reads the text through `ServeSimPasteboard.app`, the pasteboard tool installed as an app, because a read needs an installed app identity that `simctl privacy` can grant [observed: `Sources/SimPasteboard/build.sh`]. serve-sim checks for the app before each Copy, because erasing the simulator removes it [observed: `src/sim-pasteboard-copy.ts`].

Decisions [confirmed: Gabe Debes]:

- **Wait for a change, fail on timeout.** A fixed delay can return old text from an app that handles Command+C slowly (2026-09-27).
- **Hold the input queue through the read,** so that input from another viewer cannot change the pasteboard before the read. A slow read can delay other input (2026-09-27).
- **The first change wins.** If another simulator process writes the pasteboard during the wait, Copy returns that text. A quiet period after the first change was rejected (2026-09-27).
- **Copy never writes the pasteboard to detect a change.** A marker write made same-text Copy work, but it could overwrite a newer value from an app. So copying text that equals the current clipboard can time out when the app does not write again (2026-09-29).
