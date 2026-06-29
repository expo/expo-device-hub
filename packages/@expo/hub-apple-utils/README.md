# @expo/hub-apple-utils

List connected Apple devices via `devicectl`.

```ts
import { listDevices } from "@expo/hub-apple-utils";

const devices = await listDevices();
```

`listDevices()` runs `devicectl list devices` (writing to a throwaway temp file
that is always cleaned up) and returns its `result.devices` array. It never
throws — on any failure it logs the error and returns an empty array.

## Creating and booting simulators

Three helpers cover the create-a-new-simulator flow: list the runtimes (each
carries the device types it supports), create the simulator, then boot it. All
wrap `xcrun simctl`.

```ts
import { listRuntimes, createDevice, bootDevice } from "@expo/hub-apple-utils";

// 1. Pick a runtime, then one of the device types it supports. Pairing a device
//    type with the runtime that lists it guarantees a valid combination.
const runtimes = await listRuntimes();
// [{ identifier: "com.apple.CoreSimulator.SimRuntime.iOS-17-0", name, version,
//    buildVersion, platform, isAvailable, supportedDeviceTypes: [...] }, ...]

const runtime = runtimes.find((r) => r.platform === "iOS" && r.isAvailable)!;
const deviceType = runtime.supportedDeviceTypes.find((d) => d.name === "iPhone 15")!;
// supportedDeviceTypes: [{ identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-15", name, productFamily }, ...]

// 2. Create the simulator.
const udid = await createDevice({
  name: "expo-sim-host-0",
  deviceType: deviceType.identifier,
  runtime: runtime.identifier,
});

// 3. Boot it.
if (udid) {
  const booted = await bootDevice({ udid });
  // true once simctl accepts the boot (the simulator may still be starting up).
}
```

- `listRuntimes()` wraps `simctl list runtimes --json`. Each `identifier` is
  `createDevice`'s optional `runtime`, and `supportedDeviceTypes` are the device
  types valid for that runtime (each `identifier` is a `createDevice`
  `deviceType`; `productFamily` distinguishes iPhone / iPad / Apple TV / Apple
  Watch). All platforms are returned — filter by `platform` and `isAvailable` as
  needed. Sourcing the device type from its runtime avoids invalid runtime +
  device-type combinations.
- `createDevice(options)` wraps `simctl create`. A non-empty `name` and
  `deviceType` are required (an empty value throws); `runtime` is optional (simctl
  picks a compatible runtime when omitted). Returns the new device's UDID, or
  `null` on operational failure.
- `bootDevice(options)` wraps `simctl boot`. It returns once simctl accepts the
  boot — the simulator may still be finishing startup. An already-booted device
  counts as success. Returns `true` on success, `false` on failure.

All three resolve `xcrun` from `PATH` and never throw: `listRuntimes` returns
`[]`, `createDevice` returns `null`, and `bootDevice` returns `false` on failure.

> Requires Xcode's `devicectl` and `simctl` on `PATH`. macOS only.
