import { type AppleUtilsResult, reportError, result } from "./errors";
import { runSimctlDelete } from "./simctl-remove";
import type { RemoveDeviceOptions } from "./types";

/**
 * Delete a simulator via `xcrun simctl delete`.
 *
 * Removes the device permanently (shut it down first with `shutdownDevice`).
 * The result's `value` is `true` on success and `false` on failure, with
 * the invocation-specific failure in `error`.
 */
export async function removeDevice(
  options: RemoveDeviceOptions,
): Promise<AppleUtilsResult<boolean>> {
  try {
    return await runSimctlDelete(options.udid);
  } catch (error) {
    return result(false, reportError("[apple-utils] Failed to remove device:", error));
  }
}
