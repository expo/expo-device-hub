import { type AppleUtilsResult, reportError, result } from "./errors";
import { runSimctlShutdown } from "./simctl-shutdown";
import type { ShutdownDeviceOptions } from "./types";

/**
 * Shut down a simulator via `xcrun simctl shutdown`.
 *
 * An already-shut-down device counts as success. The result's `value` is
 * `false` on failure, with the invocation-specific failure in `error`.
 */
export async function shutdownDevice(
  options: ShutdownDeviceOptions,
): Promise<AppleUtilsResult<boolean>> {
  try {
    return await runSimctlShutdown(options.udid);
  } catch (error) {
    return result(false, reportError("[apple-utils] Failed to shut down device:", error));
  }
}
