import { runSimctlBoot } from "./simctl-boot";
import type { BootDeviceOptions } from "./types";

/**
 * Boot a simulator via `xcrun simctl boot`.
 *
 * Returns once `simctl` accepts the boot — the simulator may still be finishing
 * its startup. An already-booted device counts as success. Returns `false` on
 * any failure. Never throws.
 */
export async function bootDevice(options: BootDeviceOptions): Promise<boolean> {
  try {
    return await runSimctlBoot(options.udid);
  } catch (error) {
    console.error("[apple-utils] Failed to boot device:", error);
    return false;
  }
}
