import { type AppleUtilsResult, reportError, result } from "./errors";
import { runSimctlBoot } from "./simctl-boot";
import type { BootDeviceOptions } from "./types";

/**
 * Boot a simulator via `xcrun simctl boot`.
 *
 * Returns once `simctl` accepts the boot — the simulator may still be finishing
 * its startup. An already-booted device counts as success. The result's `value`
 * is `false` on failure, with the invocation-specific failure in `error`.
 */
export async function bootDevice(options: BootDeviceOptions): Promise<AppleUtilsResult<boolean>> {
  try {
    return await runSimctlBoot(options.udid);
  } catch (error) {
    return result(false, reportError("[apple-utils] Failed to boot device:", error));
  }
}
