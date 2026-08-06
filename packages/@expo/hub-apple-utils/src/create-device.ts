import { type AppleUtilsResult, reportError, result } from "./errors";
import { assertCreateOptions, buildCreateArgs, parseCreatedUdid } from "./simctl-create";
import { runSimctl } from "./simctl";
import type { CreateDeviceOptions } from "./types";

/**
 * Create a new simulator via `xcrun simctl create`.
 *
 * Pass a runtime identifier and one of its `supportedDeviceTypes` (both from
 * `listRuntimes`) to guarantee a valid pairing. Throws if `name` or `deviceType`
 * is empty; otherwise the result's `value` is the new device's UDID, or `null`
 * on operational failure, with the invocation-specific failure in `error`.
 */
export async function createDevice(
  options: CreateDeviceOptions,
): Promise<AppleUtilsResult<string | null>> {
  // Validate before the try so an empty field surfaces to the caller instead of
  // being swallowed as a `null` operational failure.
  assertCreateOptions(options);

  try {
    const created = await runSimctl(buildCreateArgs(options));
    if (created.error) return result(null, created.error);
    return result(created.value ? parseCreatedUdid(created.value) : null);
  } catch (error) {
    return result(null, reportError("[apple-utils] Failed to create device:", error));
  }
}
