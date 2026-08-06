import { homedir } from "node:os";
import { assertName, runAvdmanagerDeleteAvd } from "./avdmanager";
import { type AndroidUtilsResult, reportError, result } from "./errors";
import { resolveAvdmanagerPath } from "./sdk-paths";
import type { RemoveDeviceOptions } from "./types";

/**
 * Delete an AVD via `avdmanager delete avd`.
 *
 * Removes the emulator permanently (shut it down first with `shutdownDevice` if
 * it is running). Resolves `avdmanager` from `ANDROID_HOME` / `ANDROID_SDK_ROOT`
 * (falling back to the default macOS SDK location). Throws if `name` is empty;
 * otherwise the result's `value` is `true` on success and `false` on failure,
 * with the invocation-specific failure in `error`.
 */
export async function removeDevice(
  options: RemoveDeviceOptions,
): Promise<AndroidUtilsResult<boolean>> {
  // Validate before the try so an empty name surfaces to the caller instead of
  // being swallowed as a `false` operational failure.
  assertName(options.name);

  try {
    const avdmanager = resolveAvdmanagerPath(process.env, homedir());
    const removed = await runAvdmanagerDeleteAvd(avdmanager, options.name);
    return result(removed.value !== null, removed.error);
  } catch (error) {
    return result(false, reportError("[android-utils] Failed to remove device:", error));
  }
}
