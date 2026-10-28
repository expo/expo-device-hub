# App permissions reference

`npx @expo/serve-sim permissions` manages an installed app's privacy permissions on
the booted simulator. Notifications and TCC writes use separate native services;
location uses `xcrun simctl privacy`. Read back state after a change instead of
assuming a successful command means the app has refreshed its authorization.

## CLI surface

```sh
npx @expo/serve-sim permissions grant  <permission> <bundle-id> [--value <v>] [-d <udid|name>]
npx @expo/serve-sim permissions revoke <permission> <bundle-id> [-d <udid|name>]
npx @expo/serve-sim permissions reset  <permission|all> <bundle-id> [-d <udid|name>]
npx @expo/serve-sim permissions list   [bundle-id] [-d <udid|name>]
```

- `grant` — allow the permission.
- `revoke` (alias: `deny`) — deny the permission.
- `reset` — clear it so the app is prompted again next time. `reset all` clears
  every permission for the bundle id. Reset differs from denial.
- `list` — print current state as JSON: a `tcc` map (keyed by the same
  permission names `grant`/`revoke`/`reset` accept), plus `location` and
  `notifications`. With a bundle id it also returns normalized `permissions` rows
  with `granted`, `denied`, `limited`, or `undetermined` state. Pass `-q` for
  single-line JSON; this command does not take `--json`.

`<bundle-id>` is required for every verb except `list`. The app must be
installed for general use. Notification and TCC pre-grants are supported, but
location reports an error if it cannot confirm an installed-app entry.

## Supported permissions

| Permission      | `--value` options                    | Notes                                                                                           |
| --------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `notifications` | `critical`                           | Notification authorization; delivery is separate. `simctl privacy` has no notification service. |
| `location`      | `always`, `inuse` (default), `never` | `revoke` ⇒ never.                                                                               |
| `camera`        | —                                    |                                                                                                 |
| `microphone`    | —                                    |                                                                                                 |
| `photos`        | `limited`                            | `limited` ⇒ the iOS 14+ limited-library mode.                                                   |
| `photos-add`    | —                                    | Add-to-photos only.                                                                             |
| `contacts`      | —                                    |                                                                                                 |
| `calendar`      | —                                    |                                                                                                 |
| `reminders`     | —                                    |                                                                                                 |
| `motion`        | —                                    |                                                                                                 |
| `media-library` | —                                    |                                                                                                 |
| `siri`          | —                                    |                                                                                                 |
| `speech`        | —                                    |                                                                                                 |
| `faceid`        | —                                    |                                                                                                 |
| `user-tracking` | —                                    |                                                                                                 |
| `homekit`       | —                                    |                                                                                                 |

Aliases accepted for parity with AppleSimulatorUtils / agent-device:
`push` → `notifications`, `photo-library`/`photo` → `photos`, `mic` →
`microphone`, `location-always` → `location --value always`,
`location-inuse` → `location --value inuse`.

A trailing positional is also accepted as the value, e.g.
`permissions grant photos com.foo.bar limited`.

## How it works (and why)

- **TCC permissions** (camera, photos, contacts, …) use the native TCC service
  with its no-kill option. Reads query `TCC.db` without modifying it, preserving
  the distinction between full and limited Photos authorization.
- **Notifications** use the running BulletinBoard settings service for both
  reads and writes. They do not rely on a backing plist. Grant, denial and reset
  set authorized, denied and not-determined state respectively.
- **Location** uses `xcrun simctl privacy`, then confirms locationd's persisted
  app authorization. It uses neither the BulletinBoard API nor TCC's no-kill option.

The native helper checks private API availability at runtime and reports errors
when required APIs or confirmation are unavailable. Do not assume every Simulator
runtime supports them.

This command manages the _permission_ only — it does not deliver a
notification. To push a test notification, use `xcrun simctl push`.

## Examples

```sh
# Grant notification authorization (critical flag is optional)
npx @expo/serve-sim permissions grant notifications com.example.app
npx @expo/serve-sim permissions grant notifications com.example.app --value critical

# Location, always-on
npx @expo/serve-sim permissions grant location com.example.app --value always

# Limited photo library
npx @expo/serve-sim permissions grant photos com.example.app --value limited

# Deny the camera, then inspect everything
npx @expo/serve-sim permissions revoke camera com.example.app
npx @expo/serve-sim permissions list com.example.app -q

# Reset every permission so the app can request again
npx @expo/serve-sim permissions reset all com.example.app
```

## Notes

- The helper does not restart the app or SpringBoard. Camera, microphone and
  registered-app notification changes reflected live in the tested apps, but
  Contacts, Photos and retained EventKit stores can cache authorization until
  relaunch. Service readback and the app's cached state are separate.
- On iOS 27.1, a never-requested app could report notification authorization
  after a grant while local scheduling still failed. Its normal
  `UNUserNotificationCenter.requestAuthorization` call initialized delivery
  without prompting or restarting. Waiting or relaunching alone did not fix it.
  Keep the app's normal request flow even if a status read already says granted.
- A grant confirms authorization, not alert presentation or remote APNs delivery.
  A reset lets the app request again; it does not itself show a prompt.
- Use a real installed bundle id. Find one with
  `xcrun simctl listapps booted`.
