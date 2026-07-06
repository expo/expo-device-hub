import { runSimctlDelete } from "./simctl-remove";
import type { RemoveDeviceOptions } from "./types";

/**
 * Delete a simulator via `xcrun simctl delete`.
 *
 * Removes the device permanently (shut it down first with `shutdownDevice`).
 * Returns `true` on success, `false` on any failure. Never throws.
 */
export async function removeDevice(options: RemoveDeviceOptions): Promise<boolean> {
  try {
    return await runSimctlDelete(options.udid);
  } catch (error) {
    console.error("[apple-utils] Failed to remove device:", error);
    return false;
  }
}
