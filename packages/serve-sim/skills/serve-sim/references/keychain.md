# Keychain reference

`npx @expo/serve-sim keychain` writes, deletes, and lists values in an installed app's keychain on
the simulator. The write runs inside the app, so it uses the app's own keychain access group. Use it
to start an app signed in without adding code that imports tokens.

## CLI surface

```sh
npx @expo/serve-sim keychain set    <bundle-id> [key=value...] [--from-file <path|->] [--relaunch]
npx @expo/serve-sim keychain delete <bundle-id> <key...> [--relaunch]
npx @expo/serve-sim keychain list   <bundle-id>
```

Shared options: `--format <format>` (default `expo-secure-store`; see [Formats](#formats)),
`--service <name>`, `--access-group <group>`, `-d <udid|name>`, `-j/--json`.
`set` also takes `--accessible <when>` and, for `react-native-keychain`, `--username <name>`.

- `--from-file` reads a JSON object of string keys and values; `-` reads stdin. Prefer it to
  `key=value` arguments, which other processes can see.
- `list` prints keys only. Values never leave the app.
- With `--json`, `set` and `delete` print `{udid, bundleId, applied, keys: [{key, status, ok, message}]}`,
  or `{udid, bundleId, applied: false}` when the app did not answer and the change waits for its
  next start.

## When the app reads the value

- **Running app:** the change applies at once. The next `SecureStore.getItemAsync` returns it. An
  app that cached its sign-in state does not notice; pass `--relaunch`.
- **Closed app:** the request waits and applies when the app next starts. It expires after an hour;
  the app then drops it unread.
- **`--relaunch`:** restarts the app and waits until it applied the change. Use this for "open the
  app signed in". If the restarted app does not apply it, the command fails and nothing changes.
- An app that was already open when the serve-sim session started does not answer until it restarts.

## Formats

| Format                  | Maps a key to                                                                                  | Options                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `expo-secure-store`     | Generic password, service `<keychainService>:no-auth`, account and generic = key bytes as data | `--service` = SecureStore `keychainService` (default `app`) |
| `generic-password`      | Generic password, given service, account = key as a string                                     | `--service` required                                        |
| `react-native-keychain` | Generic password, service = key, account = username as a string, data = password               | `--username` (default empty); no `--service`                |

`delete` with `expo-secure-store` removes all three places SecureStore reads (`:no-auth`, `:auth`,
and the legacy service). `set` writes `:no-auth` and then removes the other two, as SecureStore's own
`setItemAsync` does.

`react-native-keychain` keeps one credential per service, as `setGenericPassword({ service })` does:
`set` deletes every item in the service before it writes, and `delete` removes them all. Its default
service is the app's bundle ID, so pass that as the key for an app that calls
`getGenericPassword()` without a service. `list` prints every generic-password service the app can
read, as `getAllGenericPasswordServices` does. Internet credentials (`setInternetCredentials`) are
not supported.

## Errors

- `the app has no keychain entitlement…` (-34018): the app has no `application-identifier`
  entitlement, or the access group is not one of its own. Xcode and EAS simulator builds have the
  entitlement.
- `Keychain access is unavailable…`: no serve-sim session runs for this simulator, it was started
  with `--disable keychain`, the `capabilities.set` host action turned keychain off, or this
  serve-sim install has no built keychain library (`dist/simkc/libSimKeychain.dylib`).

Not supported: biometric-protected items, Android.
