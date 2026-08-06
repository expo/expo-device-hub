# @expo/hub-apple-utils

List connected Apple devices via `devicectl`.

```ts
import { listDevices } from "@expo/hub-apple-utils";

const { value: devices, error } = await listDevices();
```

`listDevices()` runs `devicectl list devices` (writing to a throwaway temp file
that is always cleaned up) and returns its `result.devices` array. It never
throws — on any failure its `value` is an empty array and `error` contains the
first failure from that invocation. Set `DEBUG=expo-device-hub:apple-utils` to
also print the full diagnostics in the terminal.

## Creating and booting simulators

Three helpers cover the create-a-new-simulator flow: list the runtimes (each
carries the device types it supports), create the simulator, then boot it. All
wrap `xcrun simctl`.

```ts
import { listRuntimes, createDevice, bootDevice } from "@expo/hub-apple-utils";

// 1. Pick a runtime, then one of the device types it supports. Pairing a device
//    type with the runtime that lists it guarantees a valid combination.
const { value: runtimes } = await listRuntimes();
// [{ identifier: "com.apple.CoreSimulator.SimRuntime.iOS-17-0", name, version,
//    buildVersion, platform, isAvailable, supportedDeviceTypes: [...] }, ...]

const runtime = runtimes.find((r) => r.platform === "iOS" && r.isAvailable)!;
const deviceType = runtime.supportedDeviceTypes.find((d) => d.name === "iPhone 15")!;
// supportedDeviceTypes: [{ identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-15", name, productFamily }, ...]

// 2. Create the simulator.
const { value: udid } = await createDevice({
  name: "expo-sim-host-0",
  deviceType: deviceType.identifier,
  runtime: runtime.identifier,
});

// 3. Boot it.
if (udid) {
  const { value: booted } = await bootDevice({ udid });
  // true once simctl accepts the boot (the simulator may still be starting up).
}
```

- `listRuntimes()` wraps `simctl list runtimes --json`. Each `identifier` is
  `createDevice`'s optional `runtime`, and `supportedDeviceTypes` are the device
  types valid for that runtime (each `identifier` is a `createDevice`
  `deviceType`; `productFamily` distinguishes iPhone / iPad / Apple TV / Apple
  Watch). All platforms are returned — filter by `platform` and `isAvailable` as
  needed. Sourcing the device type from its runtime avoids invalid runtime +
  device-type combinations. The runtime array is returned as `value`, alongside
  the invocation-specific `error`.
- `createDevice(options)` wraps `simctl create`. A non-empty `name` and
  `deviceType` are required (an empty value throws); `runtime` is optional (simctl
  picks a compatible runtime when omitted). Returns the new device's UDID, or
  `null` on operational failure, as the result's `value`.
- `bootDevice(options)` wraps `simctl boot`. It returns once simctl accepts the
  boot — the simulator may still be finishing startup. An already-booted device
  counts as success. Its result `value` is `true` on success and `false` on
  failure.

All three resolve `xcrun` from `PATH` and return `{ value, error }`:
`listRuntimes` uses `[]`, `createDevice` uses `null`, and `bootDevice` uses
`false` as the failure value.

> Requires Xcode's `devicectl` and `simctl` on `PATH`. macOS only.
