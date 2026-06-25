# @expo-hub/android-utils

List Android Virtual Devices via `avdmanager`, including each AVD's parsed
`config.ini`.

```ts
import { listDevices } from "@expo-hub/android-utils";

const devices = await listDevices();
// [{ name, path, properties, config }, ...]
```

`listDevices()` resolves `avdmanager` from `ANDROID_HOME` / `ANDROID_SDK_ROOT`
(falling back to the default macOS SDK location), runs `avdmanager list avd`,
and reads `<Path>/config.ini` for each AVD. It never throws — on any failure it
logs the error and returns an empty array.
