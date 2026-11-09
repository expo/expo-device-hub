# LLP 0017: serve-sim keychain

**Type:** Explainer
**Status:** Active
**Systems:** ServeSim
**Author:** Gabe Debes
**Date:** 2026-10-27
**Revised:** 2026-11-08
**Related:** LLP 0007, LLP 0010

> File paths such as `src/…` are relative to `packages/serve-sim/packages/serve-sim`, unless the text gives a path from the repository root.

## Summary

serve-sim writes keychain items into a simulator app, so a preview can start signed in without app code that imports tokens. A user who seeds a token file must otherwise add code that copies it into SecureStore before the app's auth starts [observed: user feedback, 2026-10-27].

## Why the write runs inside the app

A keychain item belongs to an access group. An app reads only items in the groups its entitlements name, and items it writes go to its default group. `simctl keychain` adds certificates and resets the keychain; it does not add password items [observed: `xcrun simctl keychain` help, Xcode 26]. A process outside the app has none of the app's entitlements.

So the `keychain` capability loads `libSimKeychain.dylib` into each user app through the capability loader ([LLP 0007](0007-serve-sim-capability-loader.explainer.md)). Its `SecItem*` calls run with the app's own entitlements and default access group.

An app needs an `application-identifier` entitlement for any keychain access. Xcode embeds one in simulator builds. An app signed without it gets `errSecMissingEntitlement` (-34018) from its own calls too [observed: spike, iOS 26.5, 2026-10-27]. The launch fixture embeds one for this reason (`Sources/ServeSimLaunchFixture/Entitlements.plist`).

## The mailbox

The host and the app share the app's `tmp` folder, as the clipboard reader does ([LLP 0010](0010-serve-sim-clipboard.explainer.md)):

```
tmp/serve-sim-keychain/requests/<order>-<nonce>.json        host writes, one rename
tmp/serve-sim-keychain/responses/<nonce>.json               app writes, one rename
```

- The dylib polls `requests/` every 100 ms, as the clipboard reader polls its request file, and handles requests in name order on one serial queue. It claims a request by renaming it, and deletes it before it runs any operation, because a request can carry secrets.
- Each poll first creates the mailbox folders. An app that empties its tmp folder deletes the mailbox, and the next poll makes it again. An earlier version watched the folder; a watch that reopened on the delete event raced the deletion and was lost [observed: replay, 2026-10-27].
- A request the dylib cannot read, but whose nonce it can read, gets an answer with no results, so the host reports a version mismatch and not an app that quit.
- The host writes requests with mode `0600` in folders with mode `0700`, and serializes its requests per app with a lock file. Under that lock it picks an order after every pending request, so equal or backward clocks and separate host processes cannot reorder queued writes [observed: `requestKeychainUnlocked` in `src/sim-keychain.ts`].
- At its deadline the host withdraws an unanswered request. If the file is gone, the app claimed it and is running it, so the host waits a few more seconds for the answer instead of reporting the change as not applied. Answers that nobody read are removed after an hour; they hold attribute names, not values. Each new request also removes requests that expired, and the app action `app.file.*` refuses paths in the mailbox, so other exec-ws clients cannot read queued values or add requests [observed: `removeOlderThan` in `src/sim-keychain.ts`, `AppRelativePath` in `src/app-files.ts`].
- Operations are `set` (update, else add), `delete`, and `list`. Service, account, and access group identify an item. `generic` is written as an attribute and never matched, so an item stored with another `generic` value is updated rather than duplicated. A `set` may list items it `replaces`; the dylib refuses a replacement that could match the target before writing, comparing decoded account bytes and treating an omitted service or access group as a wildcard. It deletes replacements only after the set succeeds, and one it cannot delete fails the set [observed: `setItem` in `Sources/SimKeychain/sim-keychain.m`]. All clear and replacement queries are validated before deleting anything, and a failed clear prevents the target write [observed: `itemQueries` and `deleteQueries` in `Sources/SimKeychain/sim-keychain.m`]. `list` returns service, account, and access group; values never leave the app through this channel.
- Attribute bytes travel as base64 with `attributesAsData`, because libraries differ. expo-secure-store stores account and generic as data, and the keychain matches the type it stored.

## Running and closed apps

A request to a running app that loaded the dylib gets an answer at once. An app that is closed, or that started before the session armed the loader, does not answer. With `keepQueued`, the request stays in the mailbox, and the dylib applies it when the app next starts. Each request expires an hour after it was made. The dylib drops an expired request unread, so a value seeded for a closed app cannot overwrite what the app stored itself much later.

The dylib loads on the app's main queue after launch. A read in `application(_:didFinishLaunchingWithOptions:)` can run before a queued write [observed: spike, iOS 26.5, 2026-10-27]. An Expo app read the queued value on its first JS mount, and a value written while it ran on its next `getItemAsync` [observed: SDK 58 Release build, iOS 26.5, 2026-10-27]. An app that caches its login state after the first read needs a relaunch to see a new value.

## Who sets it up

A standalone `serve-sim` session enables the capability with its other defaults. A host that mounts `simMiddleware`, such as the Hub, gets the same setup as the clipboard reader: the middleware enables `keychain` on each device it opens or starts, checks it again at most every 30 s, and releases it on `dispose()` or at exit. Both use one capability session, `createCapabilitySession` in `src/capability-session.ts` ([LLP 0010](0010-serve-sim-clipboard.explainer.md)). `keychain: false` (`--disable keychain`) removes it, and `"unmanaged"`, which stream helpers pass, leaves it alone. The Hub passes its own `--disable keychain` on as `keychain: false`.

A managed middleware awaits its target device's keychain setup before each host action, so the first `/exec-ws` action needs no earlier preview or `/api` request. Setup failure refuses the action, including during the retry delay: actions keep the last setup error until a retry succeeds, while background preview polling keeps its existing backoff. `keychain: false` refuses all three host actions before calling the keychain service, even if shared device state says the capability is enabled; `"unmanaged"` leaves setup to its owning process [observed: `prepareKeychain` in `src/middleware.ts`, `runKeychainAction` in `src/host-actions.ts`].

While the server runs, the `capabilities.set` host action turns `keychain` off or on again for one device that the middleware opened ([LLP 0003](0003-serve-sim-http-api.spec.md#capability-actions)). The session keeps that choice through its 30 s checks until the server stops. Turning it off closes admission immediately: new keychain calls fail, `capabilities.list` reports the choice as off, and the preview config leaves out `keychain: true`, so the Hub hides the Keychain section. The change waits for admitted keychain calls to settle and setup removal to finish before it acknowledges completion or sends its config-change notification. Another device can proceed while it waits [observed: `runOperation`, `setEnabled`, and `createCapabilityController` in `src/capability-session.ts`; `runKeychainAction` in `src/host-actions.ts`].

Disabling does not revoke requests already published in the mailbox, including a call that returned `{applied: false}`. An app that already loaded the dylib keeps it until it exits and may consume those requests while this server rejects new calls; they retain their original expiry. A server started with `keychain: false` does not turn it on [observed: `requestKeychainUnlocked` in `src/sim-keychain.ts`, `drain` in `Sources/SimKeychain/sim-keychain.m`].

Off does not remove a setup that another running serve-sim process owns, such as a terminal session on the same simulator. That process would set it up again at its next check, and the two would undo each other's changes. Its own clients can still use keychain there [observed: `ownedElsewhere` in `src/capability-session.ts`].

The capability is on by default for user apps. Without a built dylib it declines, so a session still starts, and keychain commands report the capability as unavailable. A `com.apple.` bundle ID is refused at once, because the loader never reaches a system app [observed: `runKeychainOperations` in `src/sim-keychain.ts`].

## Formats, the CLI, and host actions

`serve-sim keychain set|delete|list` (`src/keychain-cli.ts`) maps string keys and values to attributes in `src/keychain.ts`. JSON file input validates own entries without rebuilding an object, so credential names such as `__proto__` survive and every non-string value is refused before publication [observed: `parseKeychainEntries` in `src/keychain-cli.ts`]:

- `expo-secure-store` (default) writes service `<keychainService>:no-auth`, with account and generic as the key's bytes, and `whenUnlocked`, as SecureStore does. Like SecureStore's `setItemAsync`, a successful `set` then removes the `:auth` and legacy items, so `getItemAsync` cannot return an older copy. `delete` removes all three services SecureStore reads.
- `generic-password` writes the key as a string account in a given service, for other libraries.
- `keychain-access` follows KeychainAccess's `Keychain.swift` (v4.2.2): the key as a string account in the given service, or in the bundle ID's service as `Keychain()` uses, with `afterFirstUnlock`. Its set updates or adds, as serve-sim's does. Its reads match any `synchronizable` value, but serve-sim's update matches only items that do not sync, so a key the app saved with `.synchronizable(true)` gets a second item instead of a new value.
- `keychain-swift` follows KeychainSwift's `KeychainSwift.swift` (24.0.0): the key, after `keyPrefix`, as a string account with no service, and `whenUnlocked`. Its reads match the account alone, and its set and delete first delete the account in every service, so serve-sim's `set` and `delete` clear the same items; the native query then has no service. A set clears existing items before adding the new value; a failed add does not restore them [observed: `setItem` in `Sources/SimKeychain/sim-keychain.m`]. `list` returns the keys of items without a service that start with the prefix. The app refuses a query with neither a service nor an account, which would match every item.
- `react-native-keychain` follows `RNKeychainManager.m` (v10): one credential per service, with the key as the service, the username as a string account, the password as data, and `afterFirstUnlock`. Like `setGenericPassword`, `set` first deletes every item in the service; a native `clears` list does this before the write. `delete` removes the whole service, and `list` returns every generic-password service, as `getAllGenericPasswordServices` does. Internet credentials are not written.

A closed app gets the request queued at once instead of after a wait. `--relaunch` stops the app, publishes the request, starts the app, and waits for the helper's answer. If publishing fails after the app stops, serve-sim attempts to restart it and reports the publication failure; if restarting also fails, it reports both errors. It does not order the write before an early native launch callback; an app that cached an earlier read needs another restart after acknowledgement. An unanswered request that the app has not claimed is withdrawn and the command fails; a lost answer after the app claimed it leaves the result uncertain [observed: `runKeychainOperations` and `requestKeychainUnlocked` in `src/sim-keychain.ts`]. Deleting a key that does not exist succeeds.

The `keychain.set`, `keychain.delete`, and `keychain.list` host actions run the same functions in the server process, so values never reach a child process's arguments ([LLP 0003](0003-serve-sim-http-api.spec.md#keychain-actions)).

## Hub client

`@expo/hub-client` sets `capabilities.keychain` when serve-sim's preview config has `keychain: true` and the exec channel is up. `listKeychainKeys`, `setKeychainValues`, and `deleteKeychainValues` take an explicit app ID and return promises, so a write keeps its result while a relaunch moves the foreground to SpringBoard and back. They use the expo-secure-store layout unless the `format` option names another of serve-sim's formats, with the format's options (`service`, `username`, `keyPrefix`). A request waits up to 120 s, or 300 s with a relaunch, which covers serve-sim's lock waits; a write whose reply is lost, by a timeout or a dropped connection, says the change may still apply [observed: `ios-keychain.ts`, `useIosDevice.ts`]. Android clients report the capability as off.

## Hub UI

The inspector's Keychain section, `KeychainSection` in `@expo/hub-components`, appears when `capabilities.keychain` is set. A Format select picks the layout, Expo SecureStore by default. The field beside it is the format's option: SecureStore's `keychainService`, the item service, KeychainAccess's service (the bundle ID when empty), the react-native-keychain username, or the KeychainSwift key prefix. The section preserves spaces in services, usernames, and key prefixes. Where a write reaches items beyond the listed key, as react-native-keychain's and KeychainSwift's own writes do, a note says so. The home screen counts as no app. The section lists the foreground app's keys in that format, each with Delete, and sets one key, or every key of a pasted JSON object, with Set or Set and relaunch. The keys are listed with the format and field given by the Format select, Enter in the field, or the last Set, and Delete uses them. A format that needs a service lists and sets nothing until one is given. When the app does not answer, the section says the change applies if the app starts within the hour; after a Set it also suggests Set and relaunch, because serve-sim cannot tell a closed app from one opened before the session. The section keeps the result of a write while a relaunch moves the foreground away, and reads the keys again after it [observed: `KeychainSection.tsx`, `keychainInput.ts`].

## Not there yet

- No Android support: serve-emu has no equivalent of the in-app write.
- Items protected by biometrics (`kSecAttrAccessControl`) are not written.
- A queued request stays in the app's `tmp` folder until the app next starts in a serve-sim session or the host sends the app another keychain request, even after it expired.
