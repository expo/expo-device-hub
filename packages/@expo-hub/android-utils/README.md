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
