import { parseRuntimes } from "./parse-runtimes";
import { runSimctl } from "./simctl";
import type { AppleSimulatorRuntime } from "./types";

/**
 * List the simulator runtimes (OS versions) known to `simctl`.
 *
 * Wraps `xcrun simctl list runtimes --json`. Each `identifier` is the value to
 * pass as {@link CreateDeviceOptions.runtime}. Returns an empty array on any
 * failure. Never throws.
 */
export async function listRuntimes(): Promise<AppleSimulatorRuntime[]> {
  try {
    const json = await runSimctl(["list", "runtimes", "--json"]);
    return json ? parseRuntimes(json) : [];
  } catch (error) {
    console.error("[apple-utils] Failed to list runtimes:", error);
    return [];
  }
}
