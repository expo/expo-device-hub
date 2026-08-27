# @expo/hub-android-utils

List Android emulators (AVDs) and connected physical devices, with each AVD's
parsed `config.ini`, latest successful boot time, and a `booted` flag.

```ts
import { listDevices } from "@expo/hub-android-utils";

const { value: devices, error } = await listDevices();
// [{ name, type, booted, serial, path, lastBootedAt, properties, config }, ...]
```

`listDevices()` resolves `avdmanager` and `adb` from `ANDROID_HOME` /
`ANDROID_SDK_ROOT` (falling back to the default macOS SDK location) and returns
one entry per device:

- **Emulators** come from `avdmanager list avd`, enriched with the parsed
  `<Path>/config.ini` and `lastBootedAt`, the modification time of the
  emulator's `bootcompleted.ini` marker. It is `null` when no completed-boot
  marker exists.
- **Physical devices** come from `adb devices -l`, described from `getprop`
  (`type: "device"`).

A device is `booted` when it is visible to `adb devices -l`. Running emulators
are matched back to their AVD via `adb -s <serial> emu avd name`, and emulator
vs. physical hardware is told apart with `getprop ro.kernel.qemu` (`1` on
emulators). Booted devices carry their adb `serial`.

It never throws — its result `value` contains every device it could read (and
is empty when discovery cannot continue), while `error` contains the first
failure from that invocation. Set
`DEBUG=expo-device-hub:android-utils` to also print the full diagnostics in the
terminal.

## Creating and booting devices

Four helpers cover the create-a-new-emulator flow: list the available inputs,
create the AVD, then boot it.

```ts
import {
  listDeviceProfiles,
  listSystemImages,
  createDevice,
  bootDevice,
} from "@expo/hub-android-utils";

// 1. Pick the inputs.
const { value: profiles } = await listDeviceProfiles();
// [{ id: "pixel_6", index, name, oem, tag }, ...]  → the `--device` argument

const { value: images } = await listSystemImages();
// [{ package: "system-images;android-34;google_apis;arm64-v8a", apiLevel, tag, abi, version, description, location }, ...]
//   → the `--package` argument

// 2. Create the AVD.
const { value: created } = await createDevice({
  name: "expo-emu-host-0",
  package: images[0].package,
  device: profiles.find((p) => p.id === "pixel_6")!.id,
  force: true,
});

// 3. Boot it headlessly.
if (created) {
  const { value: booted } = await bootDevice({ name: "expo-emu-host-0", port: 5554 });
  // { serial: "emulator-5554", pid } — track readiness via adb on `serial`.
}
```

- `listDeviceProfiles()` wraps `avdmanager list device`. Each profile's `id` is
  the stable hardware identifier for `createDevice`'s `device`. The profile
  array is the result's `value`.
- `listSystemImages()` wraps `sdkmanager --list_installed`, keeping only the
  installed `system-images;…` packages. Each `package` is `createDevice`'s
  `package`; `apiLevel`, `tag` and `abi` are derived from the package path for
  filtering. The image array is the result's `value`.
- `createDevice(options)` wraps `avdmanager create avd`. A non-empty `device`
  profile id is required (it keeps `avdmanager` non-interactive) — an empty
  `device` throws. Its result `value` is `true` on success and `false` on
  operational failure.
- `bootDevice(options)` launches the AVD headlessly via the `emulator` binary
  (`-no-window -no-audio -gpu auto -no-boot-anim`). The emulator is
  detached so it keeps running after the parent exits. Returns as soon as the
  process is spawned — not once Android has finished booting — so wait for boot
  with adb using the returned `value.serial` (`emulator-<port>`).

All four resolve their binaries the same way as `listDevices()` and return
`{ value, error }`: the listers use `[]`, `createDevice` uses `false`, and
`bootDevice` uses `null` as the failure value.
