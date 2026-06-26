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

## Creating new devices

Two helpers expose the inputs needed to create a new AVD with
`avdmanager create avd -n <name> -k <package> -d <id>`:

```ts
import { listDeviceProfiles, listSystemImages } from "@expo-hub/android-utils";

const profiles = await listDeviceProfiles();
// [{ id: "pixel_6", index, name, oem, tag }, ...]  → the `-d` argument

const images = await listSystemImages();
// [{ package: "system-images;android-34;google_apis;arm64-v8a", apiLevel, tag, abi, version, description, location }, ...]
//   → the `-k` argument
```

- `listDeviceProfiles()` wraps `avdmanager list device`. Each profile's `id` is
  the stable hardware identifier passed to `avdmanager create avd -d <id>`.
- `listSystemImages()` wraps `sdkmanager --list_installed`, keeping only the
  installed `system-images;…` packages. Each `package` is passed to
  `avdmanager create avd -k <package>`; `apiLevel`, `tag` and `abi` are derived
  from the package path for filtering.

Both resolve their binaries the same way as `listDevices()` and, like it, never
throw — returning an empty array on any failure.
