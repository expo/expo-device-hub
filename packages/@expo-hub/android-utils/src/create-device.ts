import { homedir } from "node:os";
import { assertDevice, runAvdmanagerCreateAvd } from "./avdmanager";
import { resolveAvdmanagerPath } from "./sdk-paths";
import type { CreateDeviceOptions } from "./types";

/**
 * Create a new AVD via `avdmanager create avd`.
 *
 * Pass a system image `package` (see `listSystemImages`) and a device profile
 * `id` (see `listDeviceProfiles`). Resolves `avdmanager` from `ANDROID_HOME` /
 * `ANDROID_SDK_ROOT` (falling back to the default macOS SDK location). Throws if
 * `device` is empty; otherwise returns `true` on success and `false` on any
 * operational failure.
 */
export async function createDevice(options: CreateDeviceOptions): Promise<boolean> {
  // Validate before the try so an empty device surfaces to the caller instead of
  // being swallowed as a `false` operational failure.
  assertDevice(options.device);

  try {
    const avdmanager = resolveAvdmanagerPath(process.env, homedir());
    const stdout = await runAvdmanagerCreateAvd(avdmanager, options);
    return stdout !== null;
  } catch (error) {
    console.error("[android-utils] Failed to create device:", error);
    return false;
  }
}
