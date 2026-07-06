import { runSimctlShutdown } from "./simctl-shutdown";
import type { ShutdownDeviceOptions } from "./types";

/**
 * Shut down a simulator via `xcrun simctl shutdown`.
 *
 * An already-shut-down device counts as success. Returns `false` on any other
 * failure. Never throws.
 */
export async function shutdownDevice(options: ShutdownDeviceOptions): Promise<boolean> {
  try {
    return await runSimctlShutdown(options.udid);
  } catch (error) {
    console.error("[apple-utils] Failed to shut down device:", error);
    return false;
  }
}
