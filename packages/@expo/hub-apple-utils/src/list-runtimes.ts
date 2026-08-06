import { type AppleUtilsResult, reportError, result } from "./errors";
import { parseRuntimes } from "./parse-runtimes";
import { runSimctl } from "./simctl";
import type { AppleSimulatorRuntime } from "./types";

/**
 * List the simulator runtimes (OS versions) known to `simctl`.
 *
 * Wraps `xcrun simctl list runtimes --json`. Each `identifier` is the value to
 * pass as {@link CreateDeviceOptions.runtime}. The result's `value` is empty on
 * failure, with the invocation-specific failure in `error`.
 */
export async function listRuntimes(): Promise<AppleUtilsResult<AppleSimulatorRuntime[]>> {
  try {
    const listed = await runSimctl(["list", "runtimes", "--json"]);
    if (listed.error) return result([], listed.error);
    return listed.value ? parseRuntimes(listed.value) : result([]);
  } catch (error) {
    return result([], reportError("[apple-utils] Failed to list runtimes:", error));
  }
}
