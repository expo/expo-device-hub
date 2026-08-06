import { homedir } from "node:os";
import { assertDevice, runAvdmanagerCreateAvd } from "./avdmanager";
import { type AndroidUtilsResult, reportError, result } from "./errors";
import { resolveAvdmanagerPath } from "./sdk-paths";
import type { CreateDeviceOptions } from "./types";

/**
 * Create a new AVD via `avdmanager create avd`.
 *
 * Pass a system image `package` (see `listSystemImages`) and a device profile
 * `id` (see `listDeviceProfiles`). Resolves `avdmanager` from `ANDROID_HOME` /
 * `ANDROID_SDK_ROOT` (falling back to the default macOS SDK location). Throws if
 * `device` is empty; otherwise the result's `value` is `true` on success and
 * `false` on failure, with the invocation-specific failure in `error`.
 */
export async function createDevice(
  options: CreateDeviceOptions,
): Promise<AndroidUtilsResult<boolean>> {
  // Validate before the try so an empty device surfaces to the caller instead of
  // being swallowed as a `false` operational failure.
  assertDevice(options.device);

  try {
    const avdmanager = resolveAvdmanagerPath(process.env, homedir());
    const created = await runAvdmanagerCreateAvd(avdmanager, options);
    return result(created.value !== null, created.error);
  } catch (error) {
    return result(false, reportError("[android-utils] Failed to create device:", error));
  }
}
