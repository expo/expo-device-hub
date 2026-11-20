import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";
import { type AppleUtilsResult, reportError, result } from "./errors";

const execFileAsync = promisify(execFile);

const PLUTIL_TIMEOUT_MS = 5_000;

export const CORE_DEVICE_INFO_PLIST =
  "/Library/Developer/PrivateFrameworks/CoreDevice.framework/Versions/A/Resources/Info.plist";

/**
 * The CoreDevice version installed on this Mac, such as `"651.32"`, or null when Xcode has not
 * installed CoreDevice. The Info.plist is binary, so `plutil` reads its
 * `CFBundleShortVersionString`. Never throws.
 */
export async function readCoreDeviceVersion(
  path = CORE_DEVICE_INFO_PLIST,
): Promise<AppleUtilsResult<string | null>> {
  try {
    await access(path);
  } catch {
    return result(null);
  }
  try {
    const { stdout } = await execFileAsync(
      "plutil",
      ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", path],
      { timeout: PLUTIL_TIMEOUT_MS },
    );
    return result(stdout.trim() || null);
  } catch (error) {
    return result(null, reportError("[apple-utils] Failed to read the CoreDevice version:", error));
  }
}
