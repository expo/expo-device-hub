import { errorText, execSimctl } from "./simctl";

/** Build the `simctl shutdown <udid>` args. */
export function buildShutdownArgs(udid: string): string[] {
  return ["shutdown", udid];
}

/**
 * Whether a `simctl shutdown` failure is the benign "already shut down" case.
 *
 * `simctl shutdown` exits non-zero with "Unable to shutdown device in current
 * state: Shutdown" when the device is already off — which, for a shutdown
 * request, is success.
 */
export function isAlreadyShutdownError(message: string): boolean {
  return /current state:\s*Shutdown/i.test(message);
}

/**
 * Run `xcrun simctl shutdown <udid>` and return whether the device ends up shut
 * down.
 *
 * Treats an already-shut-down device as success. Returns `false` on any other
 * failure. Never throws.
 */
export async function runSimctlShutdown(udid: string): Promise<boolean> {
  try {
    await execSimctl(buildShutdownArgs(udid));
    return true;
  } catch (error) {
    if (isAlreadyShutdownError(errorText(error))) return true;

    console.error("[apple-utils] Failed to run `xcrun simctl shutdown`:", error);
    return false;
  }
}
