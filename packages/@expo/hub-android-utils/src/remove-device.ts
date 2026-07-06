import { homedir } from "node:os";
import { assertName, runAvdmanagerDeleteAvd } from "./avdmanager";
import { resolveAvdmanagerPath } from "./sdk-paths";
import type { RemoveDeviceOptions } from "./types";

/**
 * Delete an AVD via `avdmanager delete avd`.
 *
 * Removes the emulator permanently (shut it down first with `shutdownDevice` if
 * it is running). Resolves `avdmanager` from `ANDROID_HOME` / `ANDROID_SDK_ROOT`
 * (falling back to the default macOS SDK location). Throws if `name` is empty;
 * otherwise returns `true` on success and `false` on any operational failure.
 */
export async function removeDevice(options: RemoveDeviceOptions): Promise<boolean> {
  // Validate before the try so an empty name surfaces to the caller instead of
  // being swallowed as a `false` operational failure.
  assertName(options.name);

  try {
    const avdmanager = resolveAvdmanagerPath(process.env, homedir());
    const stdout = await runAvdmanagerDeleteAvd(avdmanager, options.name);
    return stdout !== null;
  } catch (error) {
    console.error("[android-utils] Failed to remove device:", error);
    return false;
  }
}
