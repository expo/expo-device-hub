import { homedir } from "node:os";
import { runAdbGetprop } from "./adb";
import { type AndroidUtilsResult, reportError, result } from "./errors";
import { parseGetprop } from "./parse-getprop";
import { resolveAdbPath } from "./sdk-paths";

/**
 * Read every `getprop` value of one connected device, by its adb serial.
 *
 * The result's `value` is `null` when adb cannot reach the device, with the
 * failure in `error`. Never throws.
 */
export async function readDeviceProps(
  serial: string,
): Promise<AndroidUtilsResult<Record<string, string> | null>> {
  try {
    const adb = resolveAdbPath(process.env, homedir());
    const stdout = await runAdbGetprop(adb, serial);
    if (stdout.value === null) return result(null, stdout.error);
    return result(parseGetprop(stdout.value));
  } catch (error) {
    return result(null, reportError(`[android-utils] Failed to read props for ${serial}:`, error));
  }
}
