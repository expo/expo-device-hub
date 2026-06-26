# @expo-hub/android-utils

List Android emulators (AVDs) and connected physical devices, with each AVD's
parsed `config.ini` and a `booted` flag.

```ts
import { listDevices } from "@expo-hub/android-utils";

const devices = await listDevices();
// [{ name, type, booted, serial, path, properties, config }, ...]
```

`listDevices()` resolves `avdmanager` and `adb` from `ANDROID_HOME` /
`ANDROID_SDK_ROOT` (falling back to the default macOS SDK location) and returns
one entry per device:

- **Emulators** come from `avdmanager list avd`, enriched with the parsed
  `<Path>/config.ini`.
- **Physical devices** come from `adb devices -l`, described from `getprop`
  (`type: "device"`).

A device is `booted` when it is visible to `adb devices -l`. Running emulators
are matched back to their AVD via `adb -s <serial> emu avd name`, and emulator
vs. physical hardware is told apart with `getprop ro.kernel.qemu` (`1` on
emulators). Booted devices carry their adb `serial`.

It never throws — on any failure it logs the error and returns an empty array
(or omits the unavailable source).

## Creating and booting devices

Four helpers cover the create-a-new-emulator flow: list the available inputs,
create the AVD, then boot it.

```ts
import {
  listDeviceProfiles,
  listSystemImages,
  createDevice,
  bootDevice,
} from "@expo-hub/android-utils";

// 1. Pick the inputs.
const profiles = await listDeviceProfiles();
// [{ id: "pixel_6", index, name, oem, tag }, ...]  → the `--device` argument

const images = await listSystemImages();
// [{ package: "system-images;android-34;google_apis;arm64-v8a", apiLevel, tag, abi, version, description, location }, ...]
//   → the `--package` argument

// 2. Create the AVD.
const created = await createDevice({
  name: "expo-emu-host-0",
  package: images[0].package,
  device: profiles.find((p) => p.id === "pixel_6")!.id,
  force: true,
});

// 3. Boot it headlessly.
if (created) {
  const booted = bootDevice({ name: "expo-emu-host-0", port: 5554 });
  // { serial: "emulator-5554", pid } — track readiness via adb on `serial`.
}
```

- `listDeviceProfiles()` wraps `avdmanager list device`. Each profile's `id` is
  the stable hardware identifier for `createDevice`'s `device`.
- `listSystemImages()` wraps `sdkmanager --list_installed`, keeping only the
  installed `system-images;…` packages. Each `package` is `createDevice`'s
  `package`; `apiLevel`, `tag` and `abi` are derived from the package path for
  filtering.
- `createDevice(options)` wraps `avdmanager create avd`. A non-empty `device`
  profile id is required (it keeps `avdmanager` non-interactive) — an empty
  `device` throws. Returns `true` on success, `false` on operational failure.
- `bootDevice(options)` launches the AVD headlessly via the `emulator` binary
  (`-no-window -no-audio -gpu auto-no-window -no-boot-anim`). The emulator is
  detached so it keeps running after the parent exits. Returns as soon as the
  process is spawned — not once Android has finished booting — so wait for boot
  with adb using the returned `serial` (`emulator-<port>`).

All four resolve their binaries the same way as `listDevices()` and never throw:
the listers return `[]`, `createDevice` returns `false`, and `bootDevice`
returns `null` on failure.
