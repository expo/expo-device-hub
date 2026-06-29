import { assertCreateOptions, buildCreateArgs, parseCreatedUdid } from "./simctl-create";
import { runSimctl } from "./simctl";
import type { CreateDeviceOptions } from "./types";

/**
 * Create a new simulator via `xcrun simctl create`.
 *
 * Pass a runtime identifier and one of its `supportedDeviceTypes` (both from
 * `listRuntimes`) to guarantee a valid pairing. Throws if `name` or `deviceType`
 * is empty; otherwise returns the new device's UDID, or `null` on any
 * operational failure.
 */
export async function createDevice(options: CreateDeviceOptions): Promise<string | null> {
  // Validate before the try so an empty field surfaces to the caller instead of
  // being swallowed as a `null` operational failure.
  assertCreateOptions(options);

  try {
    const stdout = await runSimctl(buildCreateArgs(options));
    return stdout ? parseCreatedUdid(stdout) : null;
  } catch (error) {
    console.error("[apple-utils] Failed to create device:", error);
    return null;
  }
}
