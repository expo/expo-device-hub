# Simulator slimming

A booted simulator runs about 400 launchd services. Most serve the phone's
owner, not an app under test or a stream. In an isolated VM or CI worker
they also cost CPU: the push daemon cannot reach Apple and retries its TLS
handshake without end, and it keeps an idle simulator at about half a core
while writing over 100,000 log lines a minute. With the default profile
below, the same simulator idles at a few percent.

Slimming is opt-in. It changes the simulator until it is undone.

## Use

```
serve-sim --slim-simulator <profile> [device...]
serve-sim slim-simulator [-d <udid|name>] [--profile <profile>] [--undo | --status]
```

`--slim-simulator` switches the profile off on each device serve-sim starts.
It runs next to the stream's startup, one `simctl` call at a time at utility
QoS, so it delays neither the stream nor the app launch, and prints one
`[slim]` line per device when it is done. It is not available with
`--detach`. The `slim-simulator` command does the same for one simulator, at
full speed, switches a profile back on with `--undo`, and `--status` shows
each category's state on the device. Without `-d` it works only when exactly
one simulator is booted.

A profile is `default`, `all`, or a comma-separated list of categories such
as `default,photos`. The value is required, so `serve-sim --slim-simulator
default <udid>` never mistakes a device for a profile.

Services are switched off with `launchctl disable` and unloaded with
`launchctl bootout`, through `simctl spawn`, without a reboot. Every loaded
service in the profile is unloaded, running or not: a disabled service that
stays loaded can still start on demand. The disable
entries persist across reboots on iOS 18.5 and later, so the simulator stays
slim after serve-sim exits. `--undo` switches them back on; reboot the
simulator to start them again. `xcrun simctl erase` also restores the stock
state.

Only the needed change is made each time. CoreSimulator runs one `simctl
spawn` at a time, so the first application of the default profile takes
about 12 seconds with the `slim-simulator` command. With `--slim-simulator`
on an EAS macOS worker it took 56 to 58 seconds, during which a stream
delivered a few percent fewer frames; startup took as long as without it.
A later application, on a simulator that is already slim, takes two reads
and unloads the two or three services that launchd loaded again, about a
second. After a change, serve-sim reads the disabled list again
and reports each service whose `disable` did not take as failed.

For CI or VM workers that start from an image, run `serve-sim
slim-simulator` once when the image is built; every worker then starts
slim.

## Categories

Each service belongs to one category. The default profile is the first eight.

| Category | Default | What an app under test loses |
| --- | :---: | --- |
| `telemetry` | yes | DeviceCheck and App Attest, SKAdNetwork and AdAttributionKit postbacks, diagnostics and feedback uploads. |
| `widgets` | yes | WidgetKit timelines, Live Activities, and lock screen posters stop updating. |
| `siri` | yes | Siri and App Intents invocation, Speech recognition, Apple Intelligence and Writing Tools, Siri suggestions. |
| `family` | yes | FamilyControls, ManagedSettings, DeviceActivity, and Screen Time. |
| `messaging` | yes | iMessage and FaceTime identity, sending from the message composer, and CallKit call services. |
| `connectivity` | yes | WatchConnectivity, CarPlay, AirDrop and Continuity, SharePlay, Find My, and Memoji stickers. |
| `home` | yes | HomeKit. Switch it off with `connectivity`: without `rapportd`, `homed` retries in a loop. |
| `push` | yes | Remote push notifications (APNs). `simctl push` still delivers. |
| `photos` | | PhotoKit, the photo library picker, `simctl addmedia`, Live Text, and the media library. |
| `search` | | CoreSpotlight indexing; Spotlight and Settings search return nothing. |
| `icloud` | | CloudKit, iCloud Drive, iCloud Keychain, Apple Account sign-in, and backup. |
| `store` | | StoreKit and in-app purchase, the App Store, Apple Music, Wallet, and Apple Pay. |
| `pim` | | Contacts and contact pickers, EventKit calendars and reminders, and Mail. |
| `web` | | Universal links and associated domains, web push, and Safari sync. |
| `health` | | HealthKit, fitness, and workouts. |
| `apps` | | Maps (it retries without `navd` and uses a full core), WeatherKit, MapKit snapshots, Game Center, game controllers, News, and Tips. |
| `other` | | On-demand assets (dictionaries, fonts, speech and vision models), ID verification, and managed configuration. |

In a VM, nearly all of the CPU and log volume belongs to `push`. The other
categories reduce the number of processes and the memory each simulator
uses, which matters when many simulators share one host.

No category contains a service serve-sim depends on: `logd` and
`diagnosticd` for logs, `backboardd`, `SpringBoard`, `runningboardd`, the
pasteboard, the keyboard, and `sharingd` for share sheets. Nor does any
contain a service that simslim found to wedge or stop the boot of a
simulator, such as `nanoregistryd` and `sleepd`. `NEVER_SLIM` in
`src/sim-slim/catalog.ts` lists them, and a test enforces it.

The category list is derived from
[simslim](https://github.com/MobAI-App/simslim) v0.11.0 (MIT License,
Copyright (c) 2026 Interlap). The license text is in `NOTICE`. When Apple
ships a new runtime or simslim tags a release, run `bun
scripts/sim-slim-sync.ts --tag <tag>` to compare the labels; it needs the
network, so CI does not run it.
