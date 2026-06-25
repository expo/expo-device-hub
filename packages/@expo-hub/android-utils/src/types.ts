/** Whether an {@link AndroidDevice} is an emulator (AVD) or physical hardware. */
export type AndroidDeviceType = "emulator" | "device";

/**
 * A single Android device: an emulator known to `avdmanager list avd`, or a
 * physical device connected via `adb`.
 */
export interface AndroidDevice {
  /** AVD name (emulators) or the product model (physical devices). */
  name: string;
  /** `"emulator"` for AVDs, `"device"` for physical hardware. */
  type: AndroidDeviceType;
  /** Whether the device is currently booted / connected (visible to `adb`). */
  booted: boolean;
  /** adb serial (e.g. `"emulator-5554"`) when booted; `null` otherwise. */
  serial: string | null;
  /** Absolute path to the `.avd` directory (emulators only), if present. */
  path: string | null;
  /**
   * `avdmanager` block fields (emulators) or the curated `getprop` values
   * (physical devices).
   */
  properties: Record<string, string>;
  /** Parsed `<path>/config.ini` (emulators); empty for physical devices. */
  config: Record<string, string>;
}
