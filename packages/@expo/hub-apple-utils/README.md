# @expo/hub-apple-utils

List connected Apple devices via `devicectl`.

```ts
import { listDevices } from "@expo/hub-apple-utils";

const devices = await listDevices();
```

`listDevices()` runs `devicectl list devices` (writing to a throwaway temp file
that is always cleaned up) and returns its `result.devices` array. It never
throws — on any failure it logs the error and returns an empty array.

> Requires Xcode's `devicectl` on `PATH`. macOS only.
