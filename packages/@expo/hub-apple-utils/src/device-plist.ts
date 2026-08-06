import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse } from "plist";
import { type AppleUtilsResult, reportError, result } from "./errors";
import { isRecord } from "./json";

export interface DevicePlistTimestamps {
  lastUsedAt: number | null;
  lastBootedAt: number | null;
}

/** Parse CoreSimulator usage timestamps from a device.plist payload. */
export function parseDevicePlist(
  contents: string | Uint8Array,
): AppleUtilsResult<DevicePlistTimestamps> {
  try {
    const payload = parse(contents);
    if (!isRecord(payload)) return result(emptyTimestamps());

    return result({
      lastUsedAt: dateTimestamp(payload.lastUsedAt),
      lastBootedAt: dateTimestamp(payload.lastBootedAt),
    });
  } catch (error) {
    return result(
      emptyTimestamps(),
      reportError("[apple-utils] Failed to parse CoreSimulator device.plist:", error),
    );
  }
}

/** Read the device.plist adjacent to a simctl device's data directory. */
export async function readDevicePlist(
  dataPath: string | null,
): Promise<AppleUtilsResult<DevicePlistTimestamps>> {
  if (!dataPath) return result(emptyTimestamps());

  const plistPath = join(dirname(dataPath), "device.plist");
  try {
    return parseDevicePlist(await readFile(plistPath, "utf8"));
  } catch (error) {
    return result(
      emptyTimestamps(),
      reportError(`[apple-utils] Failed to read CoreSimulator plist at ${plistPath}:`, error),
    );
  }
}

function dateTimestamp(value: unknown): number | null {
  if (!(value instanceof Date)) return null;

  const timestamp = value.getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function emptyTimestamps(): DevicePlistTimestamps {
  return { lastUsedAt: null, lastBootedAt: null };
}
