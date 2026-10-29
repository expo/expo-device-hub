import { homedir } from "node:os";
import { runAdbDumpsysDisplay, runAdbGetprop } from "./adb";
import { type AndroidUtilsResult, reportError, result } from "./errors";
import { parseCornerRadii } from "./parse-corner-radii";
import { resolveAdbPath } from "./sdk-paths";
import { type ScreenCornerRadii } from "./types";

/**
 * Read a booted device's physical screen corner radii from `dumpsys display`.
 * Never throws; `value` is `null` when the device does not report them.
 */
export async function readCornerRadii(
  serial: string,
): Promise<AndroidUtilsResult<ScreenCornerRadii | null>> {
  try {
    const adb = resolveAdbPath(process.env, homedir());
    const dumpsys = await runAdbDumpsysDisplay(adb, serial);
    if (dumpsys.error || !dumpsys.value) return result(null, dumpsys.error);

    const radii = parseCornerRadii(dumpsys.value);
    if (radii) return result(radii);

    // A square-cornered screen prints no corners on Android 12 and newer, so a
    // missing list only means "unknown" on older versions. Ask for the API level.
    const getprop = await runAdbGetprop(adb, serial);
    return result(parseCornerRadii(dumpsys.value, sdkLevel(getprop.value)), getprop.error);
  } catch (error) {
    return result(
      null,
      reportError(`[android-utils] Failed to read corner radii for ${serial}:`, error),
    );
  }
}

function sdkLevel(getprop: string | null): number | undefined {
  const match = /\[ro\.build\.version\.sdk\]: \[(\d+)\]/.exec(getprop ?? "");
  return match?.[1] === undefined ? undefined : Number(match[1]);
}
