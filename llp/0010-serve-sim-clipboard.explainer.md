# LLP 0010: serve-sim clipboard

**Type:** Explainer
**Status:** Draft
**Systems:** ServeSim
**Author:** Gabe Debes
**Date:** 2026-10-06
**Related:** LLP 0003, LLP 0007

> File paths such as `src/…` are relative to `packages/serve-sim/packages/serve-sim`, unless the text gives a path from the repository root.

## Summary

serve-sim moves text between the browser clipboard and the simulator pasteboard. This document explains how serve-sim reads and writes the simulator pasteboard, including on headless workers, and why it works that way.

A first implementation was rolled back because it did not work as planned on the VM. This design is the second attempt, and it is kept as simple as possible [confirmed: Gabe Debes, 2026-09-30].

## Reading and writing the simulator pasteboard

`POST /api/pasteboard` reads the simulator pasteboard as text. `PUT /api/pasteboard` with `{"text": "…"}` writes it. [LLP 0003](0003-serve-sim-http-api.spec.md#pasteboard) lists the route.

- **Reads use `simctl pbpaste`.** This needs no code inside the simulator [observed: `src/sim-pasteboard.ts`].
- **Writes use a small tool that runs inside the simulator,** `Sources/SimPasteboard`, started with `simctl spawn`. Unlike `simctl pbcopy`, it works without a GUI login session, which headless workers such as EAS do not have [observed: `Sources/SimPasteboard/sim-pasteboard.m`].
- **One lock per simulator** serializes writes, so two writes cannot interleave. A plain read does not take the lock [observed: `withSimPasteboardLock` and `readPasteboardViaSimctl` in `src/sim-pasteboard.ts`].
- **Text is limited to 4 MiB** in both directions. Larger text returns a JSON 413 [observed: `src/middleware.ts`, and the read limit in `readPasteboardText` in `src/sim-pasteboard.ts`]. A `PUT` body can be up to 8 MiB, because JSON escaping can double the text. The route answers a larger body with the same JSON 413 [observed: `src/middleware.ts`]. The standalone server refuses a body over 8 MiB before the route runs, with the plain-text 413 that it sends for every route [observed: `servePreview` in `src/runtime.ts`].

## Who may use the pasteboard API

The pasteboard holds user data, so the route needs the preview token and a browser Origin. The Origin must be the preview's own origin (the request's `Host`) or an origin that the CORS policy allows: loopback or a `--cors-origin`. A request without an Origin is refused, because browsers send one on every `POST` and `PUT` [observed: `isAllowedOrigin` in `src/middleware-utils.ts`].

The same-Host rule lets a hosted preview use its own clipboard without an extra flag [confirmed: Gabe Debes, 2026-09-27]. A client that is not a browser can set any `Host` and `Origin`, so for that client the token is the real boundary.

Responses carry `Cache-Control: no-store`, so a proxy does not keep clipboard text [observed: `src/middleware.ts`].

## Reading when `simctl pbpaste` fails

When `simctl pbpaste` fails, the read asks the foreground app instead [observed: `readPasteboardOnce` in `src/sim-pasteboard-reader.ts`]. This path is meant for headless workers, which have no GUI login session:

1. **Find the app.** Ask the live foreground tracker, then the accessibility bridge, then SpringBoard's visibility history for the current boot. Every step skips helper processes such as a ViewService [observed: `frontmostAppOf` in `src/foreground-tracker.ts`]. The tracker and the history both forget an app when SpringBoard moves it to the background [observed: `visibilityAfterLogLine` in `src/foreground-tracker.ts`]. On the Home screen, the read uses the app that serve-sim launched [observed: `pasteboardTarget` in `src/sim-pasteboard-reader.ts`]. Apps opened outside serve-sim are supported too [confirmed: Gabe Debes, 2026-09-27].
2. **Grant pasteboard access** with `simctl privacy`, because a denied read and an empty pasteboard both return an empty string [observed: `src/sim-pasteboard-reader.ts`]. The grant runs after the `clipboard` capability check and before the request to the reader. A read that fails after the grant also leaves it. serve-sim never undoes the grant [observed: `readViaInjectedReader` in `src/sim-pasteboard-reader.ts`]. [The pasteboard grant stays](#the-pasteboard-grant-stays) explains what it changes.
3. **Ask the reader.** serve-sim writes a request with a fresh nonce into the app's `tmp` directory. The reader dylib, `Sources/SimPasteboardReader`, polls for it every 50 ms, reads `UIPasteboard` on the app's main queue, and publishes the nonce and the text with one atomic rename. A request that timed out can still be answered late; the nonce keeps that stale answer from being taken for the new one [observed: `src/sim-pasteboard-reader.ts`, `Sources/SimPasteboardReader/sim-pasteboard-reader.m`].
4. **Wait up to 1.2 s** for the answer, then fail with HTTP 503 and a message that says what to do next [observed: `PasteboardUnavailableError` in `src/middleware.ts`].

Apps load the reader through the capability loader ([LLP 0007](0007-serve-sim-capability-loader.explainer.md)) as the `clipboard` capability. It is on by default and loads in every app [observed: `clipboardCapability` in `src/sim-pasteboard-reader.ts`].

### The pasteboard grant stays

The grant in step 2 runs only on this fallback path. It is stored in the simulator's privacy (TCC) database. It stays after the read, and after a shutdown and a boot. It replaces a Deny that `simctl privacy revoke` stored. A Deny that a user set in Settings or in the paste prompt was not tested. While the grant stays, the app reads the pasteboard without the "Allow Paste" prompt [observed: TCC database and screenshots, iOS 26.4 simulator, Xcode 26.4, 2026-10-12 and 2026-10-13]. The help for `simctl privacy` warns: "Normally applications must have valid Info.plist usage description keys and follow the API guidelines to request access to services. Using this command to bypass those requirements can mask bugs." [observed: `xcrun simctl help privacy`, Xcode 26.4]

To return the app to the prompt, run `xcrun simctl privacy <udid> reset pasteboard <bundle-id>`. The reset deleted the app's row in the privacy database [observed: TCC database, iOS 26.4 simulator, 2026-10-12]. The help for `simctl privacy` does not list `pasteboard`, but `grant`, `revoke`, and `reset` accepted it [observed: Xcode 26.4]. Do not use `revoke`. It stores a Deny, and pasteboard reads in the app then get empty text with no prompt [observed: a request to the reader in Safari with no grant before it, iOS 26.4 simulator, 2026-10-12]. The next serve-sim read that asks the reader grants access again. So a reset, or a revoke, lasts only until that read [observed: `readViaInjectedReader` in `src/sim-pasteboard-reader.ts`].

`--disable clipboard`, or `clipboard: false` for `simMiddleware`, prevents the grant. With this setting, serve-sim does not add the `clipboard` capability record, and the preview removes it from a device that it opens. The read then stops at the capability check, before the grant [observed: `readViaInjectedReader` in `src/sim-pasteboard-reader.ts`, `isCapabilityEnabled` in `src/launch-manager.ts`, `capabilitiesToApply` in `src/capabilities.ts`, `createClipboardSession` in `src/clipboard-session.ts`].

### Set up at session start, re-checked every 30 s

serve-sim enables the `clipboard` capability when a session starts and when the preview opens or starts a device, including a device that the grid boots later. A reboot clears the launchd environment, so a device that was just booted is set up again, after any setup that was still running [observed: `src/clipboard-session.ts`, `src/middleware.ts`].

The preview starts the setup but does not wait for it before it answers a page or state request. After a setup succeeds, page, state, and config requests check again that it is still in place, at most once every 30 s per device. This check is the repair for a reboot that the middleware did not see, because a reboot clears the launchd environment. The check runs two `simctl spawn` processes, so it is not repeated on every state poll [observed: `RECHECK_MS` in `src/clipboard-session.ts`]. After a failed setup, the next try waits 5 s, and the wait doubles after each failure, up to 5 minutes. A reboot tries again at once [observed: `src/clipboard-session.ts`, `src/middleware.ts`].

Which process sets up the reader depends on how serve-sim runs. Stream helpers never do, because they can outlive the session that owns the capability loader ([LLP 0007](0007-serve-sim-capability-loader.explainer.md#lifecycle)) [observed: `src/index.ts`, `src/middleware.ts`]:

- **`serve-sim`:** the session process, at start and from its preview.
- **`serve-sim --no-preview`:** the session process, at start. Its stream helpers neither set up nor remove the reader, so a device that a helper's grid starts or reboots has no reader.
- **`serve-sim --detach`:** no process. The detached helper only streams, so it has no app-reader fallback. Reads through `simctl pbpaste` still work.
- **`simMiddleware` in another server:** the process that mounts it, when it opens or starts a device. That process releases the setup with `dispose()`, or when it exits. The first setup registers a process `exit` listener, which releases every device that this process still owns. The middleware does not listen for signals, because the host owns them [observed: `releaseOnExit` in `src/clipboard-session.ts`]. The Hub mounts the middleware in its own process and has no clipboard code: its `SIGINT` and `SIGTERM` handlers end with `process.exit`, which runs the listener [observed: `packages/expo-device-hub/src/server/cli.ts`]. The listener waits at most 5 s for a device lock that another process holds [observed: `EXIT_LOCK_TIMEOUT_MS` in `src/clipboard-session.ts`]. Not released: a host killed by a signal that it does not handle, such as the Hub on `SIGHUP`, or by `SIGKILL`. Also not released: a device whose lock an update in this process still holds at exit. Examples are a setup that is still running, and an `/exec-ws` action such as `app.launch`, `app.file.upload` or `capture.reboot` [observed: `withLaunchStateLock` in `src/launch-manager.ts` and `src/app-files.ts`, `withStateLockSync` in `src/state-lock.ts`]. Its loader can stay until the simulator reboots or serve-sim sets it up again. After an exit during a first setup, at most the loader stays inserted, and its config does not list the reader yet. The next setup on that device takes the loader over [observed: `publishLaunchState` and `armInsert` in `src/launch-manager.ts`]. A standalone `serve-sim` clears it when it starts [observed: `disarmStaleCapabilityLoader` in `src/launch-manager.ts`, `ensureBooted` in `src/index.ts`].

`--disable clipboard`, or `clipboard: false` for `simMiddleware`, skips the setup for every device that the session selects [confirmed: Gabe Debes, 2026-09-29]. With this setting, the preview also removes a reader that is already on a device that it opens, and republishes the capability loader config without it [observed: `createClipboardSession` in `src/clipboard-session.ts`]. `clipboard: "unmanaged"` neither sets up nor removes the reader; the stream helpers use it [observed: `src/index.ts`, `src/middleware.ts`]. serve-sim supports one serve-sim process per simulator, so the setup keeps no multi-owner state [confirmed: Gabe Debes, 2026-10-04].

### Reads never restart apps

A read only asks a reader that is already loaded. It never arms the loader and never restarts an app [confirmed: Gabe Debes, 2026-10-04].

The cost: an app that started before the capability loader was armed has no reader until it restarts. An app that already has the loader picks up the reader when its config changes ([LLP 0007](0007-serve-sim-capability-loader.explainer.md#arriving-late) explains both). Its read fails with "Could not read this app's clipboard. Restart the app and retry." On the Home screen with no app to ask, the message is "Open the app you copied from and retry." [observed: `src/sim-pasteboard-reader.ts`]

An earlier version armed the reader during a read and could restart the app. It was removed for this rule [confirmed: Gabe Debes, 2026-10-04].

A read can still change the app's privacy state and the screen. The grant in step 2 changes the privacy state, and that change stays ([The pasteboard grant stays](#the-pasteboard-grant-stays)). iOS can also show a banner when the reader reads. After serve-sim's write tool, `serve-sim-pasteboard`, wrote the text, a request to the reader in Safari showed "Safari pasted from serve-sim-pasteboard" [observed: screenshot, iOS 26.4 simulator, 2026-10-12]. The help for `simctl privacy` says that some permission changes terminate a running app [observed: `xcrun simctl help privacy`, Xcode 26.4]. On iOS 26.4, the grant did not restart a running Safari [observed: Safari PID before and after `simctl privacy`, iOS 26.4 simulator, 2026-10-12]. Other runtimes were not tested.
