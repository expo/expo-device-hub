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

/**
 * A device profile (hardware definition) known to `avdmanager list device`.
 *
 * These are the templates an AVD is created from via
 * `avdmanager create avd -d <id>`.
 */
export interface AndroidDeviceProfile {
  /**
   * Stable string id passed to `avdmanager create avd -d <id>`
   * (e.g. `"pixel_6"`, `"Galaxy Nexus"`).
   */
  id: string;
  /**
   * Numeric index from the `avdmanager` listing (e.g. `0`). Reflects position
   * only and is unstable across SDK versions — prefer {@link id}. `null` when it
   * cannot be parsed.
   */
  index: number | null;
  /** Human-readable name (e.g. `"Pixel 6"`). */
  name: string;
  /** Manufacturer (e.g. `"Google"`, `"Generic"`); `null` when absent. */
  oem: string | null;
  /** Form-factor tag (e.g. `"android-tv"`, `"android-wear"`); `null` when absent. */
  tag: string | null;
}

/**
 * An installed system image known to `sdkmanager --list_installed`.
 *
 * The {@link package} is the value passed to `avdmanager create avd -k <package>`.
 */
export interface AndroidSystemImage {
  /**
   * Full SDK package path passed to `avdmanager create avd -k <package>`
   * (e.g. `"system-images;android-34;google_apis;arm64-v8a"`).
   */
  package: string;
  /** API level segment of the package (e.g. `"android-34"`); `null` if unparsable. */
  apiLevel: string | null;
  /** Image type segment (e.g. `"google_apis"`, `"android-tv"`); `null` if unparsable. */
  tag: string | null;
  /** ABI segment (e.g. `"arm64-v8a"`, `"x86_64"`); `null` if unparsable. */
  abi: string | null;
  /** Installed package version (e.g. `"16"`). */
  version: string;
  /** Human-readable description (e.g. `"Google Play ARM 64 v8a System Image"`). */
  description: string;
  /** Install location relative to the SDK root (e.g. `"system-images/android-34/..."`). */
  location: string;
}

/** Options for {@link createDevice} → `avdmanager create avd`. */
export interface CreateDeviceOptions {
  /** AVD name → `--name` (e.g. `"expo-emu-<host>-<index>"`). */
  name: string;
  /**
   * System image package → `--package`
   * (e.g. an {@link AndroidSystemImage.package}).
   */
  package: string;
  /**
   * Device profile id → `--device`
   * (e.g. an {@link AndroidDeviceProfile.id} such as `"pixel_6"`). Required and
   * must be non-empty: without it `avdmanager` falls back to an interactive
   * prompt, so {@link createDevice} throws on an empty value.
   */
  device: string;
  /** Overwrite an existing AVD of the same name (`--force`). Defaults to `false`. */
  force?: boolean;
}

/** Options for {@link bootDevice} → `emulator -avd <name> -port <port>`. */
export interface BootDeviceOptions {
  /** AVD name to boot → `emulator -avd <name>`. */
  name: string;
  /** Console port → `emulator -port <port>`; the serial becomes `emulator-<port>`. */
  port: number;
}

/** How a spawned emulator process ended (see {@link BootedDevice.exited}). */
export interface EmulatorExit {
  /** Process exit code; `null` when killed by a signal or never spawned. */
  code: number | null;
  /** Terminating signal (e.g. `"SIGKILL"`); `null` on a normal exit. */
  signal: string | null;
}

/** A freshly launched emulator returned by {@link bootDevice}. */
export interface BootedDevice {
  /** adb serial for the emulator, `emulator-<port>`. */
  serial: string;
  /** OS process id of the spawned emulator; `null` when unavailable. */
  pid: number | null;
  /**
   * The exact boot invocation as a runnable shell command. The emulator's
   * output is discarded (the detached child outlives us), so this is what a
   * failure report offers the user to reproduce the boot with the full
   * emulator output visible.
   */
  command: string;
  /**
   * Resolves when the emulator process exits — which, before the device is
   * adb-online, means the boot failed. Only fires while the parent process is
   * alive (the child is detached); never rejects.
   */
  exited: Promise<EmulatorExit>;
}

/** Options for {@link shutdownDevice} → `adb -s <serial> emu kill`. */
export interface ShutdownDeviceOptions {
  /** adb serial of the running emulator to stop (e.g. `"emulator-5554"`). */
  serial: string;
}

/** Options for {@link removeDevice} → `avdmanager delete avd`. */
export interface RemoveDeviceOptions {
  /** AVD name to delete → `--name` (e.g. `"expo-emu-host-0"`). */
  name: string;
}
