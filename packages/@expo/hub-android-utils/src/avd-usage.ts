import { stat } from "node:fs/promises";
import { join } from "node:path";
import { type AndroidUtilsResult, reportError, result } from "./errors";

/**
 * Read the completion time of an AVD's most recent successful boot.
 *
 * Android Emulator removes `bootcompleted.ini` at launch and recreates it once
 * the guest finishes booting. The marker is absent when the most recent launch
 * has not completed a boot.
 */
export async function readAvdLastBootedAt(
  avdPath: string | null,
): Promise<AndroidUtilsResult<number | null>> {
  if (!avdPath) return result(null);

  const markerPath = join(avdPath, "bootcompleted.ini");
  try {
    const marker = await stat(markerPath);
    const timestamp = marker.mtimeMs;
    return result(marker.isFile() && Number.isFinite(timestamp) ? Math.trunc(timestamp) : null);
  } catch (error) {
    if (isMissingFile(error)) return result(null);

    return result(
      null,
      reportError(`[android-utils] Failed to read AVD boot marker at ${markerPath}:`, error),
    );
  }
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
