import { type AppleUtilsResult, result } from "./errors";
import { errorText, execSimctl } from "./simctl";

/** Build the `simctl boot <udid>` args. */
export function buildBootArgs(udid: string): string[] {
  return ["boot", udid];
}

/**
 * Whether a `simctl boot` failure is the benign "device is already booted" case.
 *
 * `simctl boot` exits non-zero with "Unable to boot device in current state:
 * Booted" when the device is already running — which, for a boot request, is
 * success.
 */
export function isAlreadyBootedError(message: string): boolean {
  return /current state:\s*Booted/i.test(message);
}

/**
 * Run `xcrun simctl boot <udid>` and return whether the device ends up booted.
 *
 * Treats an already-booted device as success. Returns `false` on any other
 * failure. Never throws.
 */
export async function runSimctlBoot(udid: string): Promise<AppleUtilsResult<boolean>> {
  const executed = await execSimctl(buildBootArgs(udid), {
    errorMessage: "[apple-utils] Failed to run `xcrun simctl boot`:",
    ignoreError: (error) => isAlreadyBootedError(errorText(error)),
  });
  return result(executed.error === null, executed.error);
}
