/** A simulator device from `xcrun simctl list devices --json`. */
export interface AppleDevice {
  udid: string;
  name: string;
  state: string;
  isAvailable: boolean;
  deviceTypeIdentifier: string | null;
  /** The key of the runtime group that contained this device. */
  runtimeIdentifier: string;
  /** Platform derived from the runtime identifier, such as `"iOS"`. */
  platform: string | null;
  /** Dot-separated OS version derived from the runtime identifier. */
  osVersion: string | null;
  /** Any other fields emitted by simctl are preserved as-is. */
  [key: string]: unknown;
}

/** Options for {@link shutdownDevice} → `xcrun simctl shutdown`. */
export interface ShutdownDeviceOptions {
  /** UDID of the simulator to shut down. */
  udid: string;
}

/** Options for {@link removeDevice} → `xcrun simctl delete`. */
export interface RemoveDeviceOptions {
  /** UDID of the simulator to delete. */
  udid: string;
}

/**
 * A simulator device type (hardware model) a runtime supports, from the
 * `supportedDeviceTypes` of `xcrun simctl list runtimes`.
 *
 * Pairing a device type with the runtime that lists it guarantees a valid
 * `simctl create <name> <deviceType> <runtime>` combination.
 */
export interface AppleSimulatorDeviceType {
  /**
   * Identifier passed as {@link CreateDeviceOptions.deviceType}
   * (e.g. `"com.apple.CoreSimulator.SimDeviceType.iPhone-15"`).
   */
  identifier: string;
  /** Human-readable model name (e.g. `"iPhone 15"`). */
  name: string;
  /** Product family (e.g. `"iPhone"`, `"iPad"`, `"Apple TV"`); `null` when absent. */
  productFamily: string | null;
}

/**
 * A simulator runtime (OS version) from `xcrun simctl list runtimes`.
 *
 * The {@link identifier} is the optional `<runtime>` argument of
 * `simctl create`, and {@link supportedDeviceTypes} are the device types that
 * can be paired with it.
 */
export interface AppleSimulatorRuntime {
  /**
   * Identifier passed as {@link CreateDeviceOptions.runtime}
   * (e.g. `"com.apple.CoreSimulator.SimRuntime.iOS-17-0"`).
   */
  identifier: string;
  /** Human-readable runtime name (e.g. `"iOS 17.0"`). */
  name: string;
  /** OS version string (e.g. `"17.0"`). */
  version: string;
  /** OS build version (e.g. `"21A328"`); `null` when absent. */
  buildVersion: string | null;
  /** Platform (e.g. `"iOS"`, `"tvOS"`, `"watchOS"`); `null` when absent. */
  platform: string | null;
  /** Whether the runtime is usable for creating simulators. */
  isAvailable: boolean;
  /**
   * Device types this runtime can create, each a valid
   * {@link CreateDeviceOptions.deviceType} for this runtime.
   */
  supportedDeviceTypes: AppleSimulatorDeviceType[];
}

/** Options for {@link createDevice} → `xcrun simctl create`. */
export interface CreateDeviceOptions {
  /** Name for the new simulator (e.g. `"expo-sim-<host>-<index>"`). */
  name: string;
  /**
   * Device type → see {@link AppleSimulatorDeviceType.identifier}. Required and
   * must be non-empty; a model name like `"iPhone 15"` also works.
   */
  deviceType: string;
  /**
   * Runtime → see {@link AppleSimulatorRuntime.identifier}. Optional; when
   * omitted `simctl` picks a runtime compatible with the device type. A name
   * like `"iOS17.0"` also works.
   */
  runtime?: string;
}

/** Options for {@link bootDevice} → `xcrun simctl boot`. */
export interface BootDeviceOptions {
  /** UDID of the simulator to boot (e.g. the value returned by {@link createDevice}). */
  udid: string;
}
